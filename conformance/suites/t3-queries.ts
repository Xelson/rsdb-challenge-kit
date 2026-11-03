/**
 * T3 Query semantics (SPEC §13.5, §13.4): a deterministic dataset of 2,000 adversarial rows, then random queries through `fetch` and
 * initial snapshots, each judged against the SQLite voter. Every failing query is shrunk to a signature; T3 scores
 * 6 × max(0, 1 − signatures / 10). Answers are saved per query so that `crosscheck.ts` can apply the A/B/voter triage rule.
 */
import { createHash } from 'node:crypto';
import type { ExprIR, QueryIR } from '@rsdb/client';
import { Voter, VoterError, canonical, type VoterResult } from '../voter/voter.ts';
import { must, open, withTimeout, type AnyClient } from '../lib/client.ts';
import { FUZZ_SCHEMA, build, columnsOf, ids, invalidLeaf, itemRow, plainDsl, query, type GenQuery } from '../lib/gen.ts';
import type { CaseCtx, CaseResult, Suite } from '../lib/suite.ts';

const ROWS = 2000;
const QUERIES = { public: 1000, full: 5000 } as const;
const CONCURRENCY = 8;
const INVALID_RATE = 0.03;

/** An answer: `E:<code>` for an error, else a short hash of the canonical result. */
type Answer = string;
const short = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);
const answerOf = (r: { rows?: unknown[]; count?: number }) => short(r.rows ? `rows:${canonical(r.rows)}` : `count:${r.count}`);

export interface T3Data {
  seed: number;
  vData: number;
  /** Per query index: the submission's answer and the voter's. */
  answers: Answer[];
  voter: Answer[];
  /** Signature of every failing query, by query index. */
  failing: Record<number, string>;
  /** Details of the first 200 failing queries. */
  failures: { i: number; signature: string; ir: QueryIR; shrunk: QueryIR; got: string; expected: string }[];
  signatures: string[];
}

function voterAnswer(v: Voter, ir: QueryIR): { answer: Answer; result?: VoterResult; code?: string } {
  try {
    const r = v.query(ir);
    return { answer: answerOf(r.kind === 'rows' ? { rows: r.rows } : { count: r.count }), result: r };
  } catch (e) {
    if (e instanceof VoterError) return { answer: `E:${e.code}`, code: e.code };
    throw e;
  }
}

async function sdkAnswer(c: AnyClient, q: GenQuery, mode: 'fetch' | 'subscribe', vData: number): Promise<{ answer: Answer; text: string }> {
  try {
    let r: any;
    if (mode === 'fetch') r = await withTimeout(build(c, q).fetch(), 30_000, 'fetch');
    else {
      const sub = build(c, q).subscribe(() => {});
      try {
        r = await withTimeout(sub.ready, 30_000, 'subscribe');
      } finally {
        sub.unsubscribe();
      }
    }
    const body = q.ir.kind === 'count' ? { count: r.count } : { rows: [...r.rows] };
    if (r.version !== vData) return { answer: `V:${r.version}`, text: `version ${r.version}, expected ${vData}` };
    return { answer: answerOf(body), text: canonical(body.rows ?? body.count) };
  } catch (e: any) {
    if (e?.name === 'RsdbError') return { answer: `E:${e.code}`, text: `${e.code}: ${e.message}` };
    return { answer: `X:${e?.message ?? e}`, text: String(e?.stack ?? e) };
  }
}

// ─────────────────────────────── shrinking and signatures ───────────────────────────────

function plain(ir: QueryIR): GenQuery {
  return { ir, wheres: ir.where === null ? [] : [plainDsl(ir.where)] };
}

/** Candidate simplifications of a query, smallest first. */
function* simpler(ir: QueryIR): Generator<QueryIR> {
  if (ir.where) yield { ...ir, where: null };
  if (ir.kind === 'rows') {
    if (ir.select) yield { ...ir, select: null };
    if (ir.limit !== null) yield { ...ir, limit: null };
    if (ir.orderBy.length) yield { ...ir, orderBy: [] };
    for (let k = 0; k < ir.orderBy.length && ir.orderBy.length > 1; k++) yield { ...ir, orderBy: ir.orderBy.filter((_, i) => i !== k) };
  }
  if (ir.where) for (const w of simplerExpr(ir.where)) yield { ...ir, where: w };
}
function* simplerExpr(e: ExprIR): Generator<ExprIR> {
  if (e.op === 'and' || e.op === 'or') {
    for (const a of e.args) yield a;
    for (let k = 0; k < e.args.length; k++) yield { ...e, args: e.args.filter((_, i) => i !== k) };
    for (let k = 0; k < e.args.length; k++) for (const s of simplerExpr(e.args[k]!)) yield { ...e, args: e.args.map((a, i) => (i === k ? s : a)) };
  } else if (e.op === 'in' || e.op === 'nin') {
    for (let k = 0; k < e.values.length; k++) yield { ...e, values: e.values.filter((_, i) => i !== k) };
  }
}

const COL = new Map(columnsOf(FUZZ_SCHEMA, 'items').map((c) => [c.name, c]));
const colClass = (field: string) => {
  if (field === 'id') return 'id';
  const c = COL.get(field);
  return c ? `${c.type}${c.nullable ? '?' : ''}` : 'unknown';
};

export function valueClass(v: unknown): string {
  if (v === null) return 'null';
  if (typeof v === 'boolean') return 'bool';
  if (typeof v === 'string') {
    if (v === '') return 'empty';
    if (!v.isWellFormed()) return 'lone-surrogate';
    if ([...v].some((ch) => ch.codePointAt(0)! > 0xffff)) return 'astral';
    if (/[-￿]/.test(v)) return 'bmp-high';
    if (/[^\x00-\x7f]/.test(v)) return 'non-ascii';
    if (/[%_]/.test(v)) return 'wildcard-chars';
    return 'ascii';
  }
  if (typeof v === 'number') {
    if (Object.is(v, -0)) return 'neg-zero';
    if (v === 0) return 'zero';
    if (!Number.isInteger(v)) return Math.abs(v) < 2.2250738585072014e-308 ? 'subnormal' : 'fraction';
    if (Math.abs(v) > 2 ** 53) return 'unsafe';
    if (Math.abs(v) >= 1e15) return Math.abs(v) >= 1e300 ? 'huge' : 'large';
    if (Math.abs(v) > 2 ** 31) return 'large';
    return v < 0 ? 'negative' : 'small';
  }
  return typeof v;
}

/** Signature of a shrunk failing query (§13.5): operator, column type, nullability, value class. */
export function signature(ir: QueryIR, kind: string): string {
  const w = ir.where;
  let core: string;
  if (w && 'field' in w) {
    const lit = 'value' in w ? valueClass(w.value) : 'values' in w ? (w.values.length ? `n${Math.min(w.values.length, 2)}:${valueClass(w.values[0])}` : 'empty-list') : '-';
    core = `${w.op}:${colClass(w.field)}:${lit}`;
  } else if (w) core = `${w.op}[${w.args.length}]`;
  else if (ir.kind === 'rows' && ir.orderBy.length) core = `orderBy:${colClass(ir.orderBy[0]!.field)}:${ir.orderBy[0]!.dir}${ir.orderBy.length > 1 ? '+' : ''}`;
  else if (ir.kind === 'rows' && ir.limit !== null) core = 'limit';
  else if (ir.kind === 'rows' && ir.select) core = 'select';
  else core = ir.kind === 'count' ? 'count' : 'all';
  return `${kind}:${core}`;
}

// ─────────────────────────────── the seed ───────────────────────────────

async function runSeed(t: CaseCtx, seed: number): Promise<void> {
  const rng = t.rng;
  const data: T3Data = { seed, vData: 0, answers: [], voter: [], failing: {}, failures: [], signatures: [] };
  t.data = data;
  const { c } = await open(t, FUZZ_SCHEMA, 't3');
  const voter = new Voter(FUZZ_SCHEMA);
  t.defer(() => voter.close());

  // Dataset: adversarial values from the generator pools; ids and unique values are deterministic per seed.
  const cols = columnsOf(FUZZ_SCHEMA, 'items');
  const rowIds = ids(rng, ROWS);
  const rows = rowIds.map((id, i) => ({ ...itemRow(rng, cols), id, u: rng.chance(0.15) ? `u${i}` : null }));
  for (let k = 0; k < rows.length; k += 250) {
    const chunk = rows.slice(k, k + 250);
    const r = await must(t, c.batch((tx: any) => chunk.forEach((row) => tx.insert('items', row))), `dataset batch ${k / 250}`);
    voter.applyBatch(chunk.map((row) => ({ op: 'insert', table: 'items', row })));
    data.vData = r.version;
  }
  t.eq(voter.dump('items').length, ROWS, 'voter dataset size');

  // All queries are generated before any runs, so that both submissions get exactly the same sequence.
  const n = QUERIES[t.opts.scale];
  const plan = Array.from({ length: n }, () => {
    const q = query(rng, FUZZ_SCHEMA, { limitRate: 0.6, maxLimit: 50 });
    if (rng.chance(INVALID_RATE)) {
      const bad = invalidLeaf(rng, FUZZ_SCHEMA);
      q.ir = { ...q.ir, where: q.ir.where ? { op: 'and', args: [q.ir.where, bad] } : bad };
      q.wheres = [...q.wheres, plainDsl(bad)];
    }
    return { q, mode: rng.chance(0.8) ? ('fetch' as const) : ('subscribe' as const) };
  });

  const sigs = new Set<string>();
  let next = 0;
  const worker = async () => {
    while (next < plan.length) {
      const i = next++;
      const { q, mode } = plan[i]!;
      const exp = voterAnswer(voter, q.ir);
      const got = await sdkAnswer(c, q, mode, data.vData);
      data.voter[i] = exp.answer;
      data.answers[i] = got.answer;
      if (got.answer === exp.answer) continue;
      const shrunk = await shrink(c, voter, q.ir, data.vData);
      const kind = exp.code ? `err-${exp.code}` : got.answer.startsWith('E:') ? `rejects-${got.answer.slice(2)}` : got.answer.startsWith('V:') ? 'version' : 'result';
      const sig = signature(shrunk, kind);
      sigs.add(sig);
      data.failing[i] = sig;
      if (data.failures.length < 200) {
        const e = exp.result ? (exp.result.kind === 'rows' ? canonical(exp.result.rows) : String(exp.result.count)) : exp.answer;
        data.failures.push({ i, signature: sig, ir: q.ir, shrunk, ...firstDifference(got.text, e) });
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  data.signatures = [...sigs].sort();
  for (const s of data.signatures) {
    const f = data.failures.find((x) => x.signature === s)!;
    t.fail(`${s}: ${JSON.stringify(f.shrunk)} — got ${f.got.slice(0, 200)}, voter ${f.expected.slice(0, 200)}`);
  }
  t.log(`${n} queries, ${data.failures.length} failing, ${sigs.size} signature(s)`);
}

/** Greedy shrinking through fetch: keep a simplification while the submission still disagrees with the voter. */
async function shrink(c: AnyClient, voter: Voter, ir: QueryIR, vData: number): Promise<QueryIR> {
  let cur = ir;
  for (let budget = 120; budget > 0;) {
    let improved = false;
    for (const cand of simpler(cur)) {
      if (--budget <= 0) break;
      const exp = voterAnswer(voter, cand);
      const got = await sdkAnswer(c, plain(cand), 'fetch', vData);
      if (got.answer !== exp.answer) {
        cur = cand;
        improved = true;
        break;
      }
    }
    if (!improved) break;
  }
  return cur;
}

/** Where two answers differ: the first differing row of two row lists, else both texts. */
function firstDifference(got: string, expected: string): { got: string; expected: string } {
  try {
    const g = JSON.parse(got);
    const e = JSON.parse(expected);
    if (Array.isArray(g) && Array.isArray(e)) {
      const n = Math.max(g.length, e.length);
      for (let k = 0; k < n; k++) {
        if (canonical(g[k] ?? null) !== canonical(e[k] ?? null)) {
          return { got: clip(`${g.length} rows; row ${k}: ${canonical(g[k] ?? null)}`), expected: clip(`${e.length} rows; row ${k}: ${canonical(e[k] ?? null)}`) };
        }
      }
    }
  } catch {}
  return { got: clip(got), expected: clip(expected) };
}

const clip = (s: string, n = 2000) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** Distinct signatures over all seeds; a seed that failed without signatures (crash, setup) counts as one of its own. */
export function t3Signatures(results: CaseResult[]): string[] {
  const all = new Set<string>();
  for (const r of results) {
    const sigs = (r.data as T3Data | undefined)?.signatures ?? [];
    for (const s of sigs) all.add(s);
    if (!r.pass && sigs.length === 0) all.add(`case:${r.name}`);
  }
  return [...all].sort();
}

const suite: Suite = {
  id: 'T3',
  level: 'L1',
  weight: 6,
  needsSdk: true,
  publicSeeds: [1, 2, 3],
  cases: (seeds) => seeds.map((seed) => ({ name: `seed ${seed}`, seed, run: (t: CaseCtx) => runSeed(t, seed) })),
  // No seed ran its queries (SDK missing, setup failure everywhere): nothing was shown to work.
  score: (results) => (results.every((r) => !(r.data as T3Data | undefined)?.answers?.length) ? 0 : 6 * Math.max(0, 1 - t3Signatures(results).length / 10)),
};
export default suite;
