/**
 * Voter replay of a benchmark run (SPEC §14.2): applies the write log in version order and finds the affected pairs, the
 * versions at which each subscribed query's result changed, looking only at the queries whose filter matches a written row before
 * or after the write. It also answers Q(D_v) for audit deliveries and the final checks.
 *
 * Two ways to decide that a result changed:
 * - `hash`: limited row queries are re-evaluated by the voter and compared by result hash (exact, and it knows when a later write
 *   restores an earlier result, which §14.2 excludes from `lat`);
 * - `rule`: unlimited row queries and counts use membership before and after the write: a count changes when the number of rows
 *   entering and leaving differs; a row result changes when a row enters, leaves, or changes a returned value. Bench queries
 *   always return their sort columns, so a change of order is a change of returned values; a query that breaks this is refused.
 */
import type { ExprIR, MutationIR, QueryIR, SchemaIR } from '@rsdb/client';
import { canonical, resultHash, Voter, type VoterRow } from '../../conformance/voter/voter.ts';
import type { Row } from './workload.ts';

type Mode = 'hash' | 'rule';

export interface QState {
  readonly key: string;
  readonly ir: QueryIR;
  readonly mode: Mode;
  /** Current result hash (hash mode). */
  hash: string | null;
  /** Hash before the first recorded change (hash mode). */
  readonly initialHash: string | null;
  /** Versions at which the result changed, ascending. */
  readonly changes: number[];
  /** Result hash after each change (hash mode). */
  readonly hashes: (string | null)[];
}

interface Touch {
  table: string;
  before: VoterRow | null;
  after: VoterRow | null;
}

const HASH_LIMIT = 100;

export class Replay {
  readonly voter: Voter;
  readonly schema: SchemaIR;
  version: number;
  readonly queries = new Map<string, QState>();
  /** table → field → canonical value → queries whose filter requires that value. */
  #index = new Map<string, Map<string, Map<string, QState[]>>>();
  /** table → queries without an index key. */
  #scan = new Map<string, QState[]>();

  /** A voter at `version` holding `preload` (rows by physical table). */
  constructor(schema: SchemaIR, preload: Record<string, Iterable<Row>>, version: number) {
    this.schema = schema;
    this.voter = new Voter(schema);
    for (const [table, rows] of Object.entries(preload)) {
      let chunk: MutationIR[] = [];
      for (const row of rows) {
        chunk.push({ op: 'insert', table, row });
        if (chunk.length === 1000) this.voter.applyBatch(chunk), (chunk = []);
      }
      if (chunk.length) this.voter.applyBatch(chunk);
    }
    this.version = version;
  }

  /** Registers a query (deduplicated) before the first write is applied. */
  track(ir: QueryIR): QState {
    const key = canonical(ir);
    const known = this.queries.get(key);
    if (known) return known;
    const mode: Mode = ir.kind === 'rows' && ir.limit !== null && ir.limit <= HASH_LIMIT ? 'hash' : 'rule';
    if (ir.kind === 'rows' && mode === 'rule' && ir.select) {
      const missing = ir.orderBy.map((o) => o.field).filter((f) => f !== 'id' && !ir.select!.includes(f));
      if (missing.length) throw new Error(`bench query ${key}: unlimited projection without its sort column ${missing.join(',')}`);
    }
    const hash = mode === 'hash' ? this.hash(ir) : null;
    const q: QState = { key, ir, mode, hash, initialHash: hash, changes: [], hashes: [] };
    this.queries.set(key, q);
    const keys = ir.where ? indexKeys(ir.where) : null;
    if (keys) {
      let byField = this.#index.get(ir.table);
      if (!byField) this.#index.set(ir.table, (byField = new Map()));
      for (const [field, value] of keys) {
        let byValue = byField.get(field);
        if (!byValue) byField.set(field, (byValue = new Map()));
        const k = valueKey(value);
        const list = byValue.get(k);
        if (list) list.includes(q) || list.push(q);
        else byValue.set(k, [q]);
      }
    } else {
      const list = this.#scan.get(ir.table);
      if (list) list.push(q);
      else this.#scan.set(ir.table, [q]);
    }
    return q;
  }

  hash(ir: QueryIR): string {
    return resultHash(this.voter.query(ir));
  }

  /**
   * Applies the write acknowledged with `version` (the next one). Throws if the voter rejects it: the server acknowledged a
   * write that §7 rejects.
   */
  apply(version: number, ops: readonly MutationIR[]): void {
    if (version !== this.version + 1) throw new Error(`replay: version ${version} after ${this.version}`);
    const touched = new Map<string, Map<string, Touch>>();
    const touch = (table: string) => {
      let m = touched.get(table);
      if (!m) touched.set(table, (m = new Map()));
      return m;
    };
    for (const op of ops) {
      const m = touch(op.table);
      if (op.op === 'updateWhere' || op.op === 'deleteWhere') {
        // rows an earlier op of the same batch touched keep their state before the batch (looked up below)
        const r = this.voter.query({ format: 'rsdb-query/1', kind: 'rows', table: op.table, where: op.where, orderBy: [], limit: null, select: null });
        for (const row of (r as { rows: VoterRow[] }).rows) if (!m.has(row.id as string)) m.set(row.id as string, { table: op.table, before: null, after: null });
      } else {
        const id = op.op === 'insert' || op.op === 'upsert' ? (op.row as Row).id as string : op.id;
        if (typeof id !== 'string') throw new Error('replay: bench writes always carry ids');
        if (!m.has(id)) m.set(id, { table: op.table, before: null, after: null });
      }
    }
    for (const [table, m] of touched) for (const r of this.#byIds(table, [...m.keys()])) m.get(r.id as string)!.before = r;
    this.voter.applyBatch(ops);
    this.version = version;
    for (const [table, m] of touched) for (const r of this.#byIds(table, [...m.keys()])) m.get(r.id as string)!.after = r;

    const candidates = new Map<QState, Touch[]>();
    for (const [table, m] of touched) {
      const byField = this.#index.get(table);
      const scan = this.#scan.get(table) ?? [];
      for (const t of m.values()) {
        const seen = new Set<QState>();
        for (const row of [t.before, t.after]) {
          if (!row) continue;
          if (byField) {
            for (const [field, byValue] of byField) {
              for (const q of byValue.get(valueKey(row[field] ?? null)) ?? []) if (matches(q.ir.where, row)) seen.add(q);
            }
          }
          for (const q of scan) if (matches(q.ir.where, row)) seen.add(q);
        }
        for (const q of seen) {
          const list = candidates.get(q);
          if (list) list.push(t);
          else candidates.set(q, [t]);
        }
      }
    }
    for (const [q, ts] of candidates) {
      if (q.mode === 'hash') {
        const h = this.hash(q.ir);
        if (h !== q.hash) {
          q.changes.push(version);
          q.hashes.push(h);
          q.hash = h;
        }
      } else if (ruleChanged(q.ir, ts)) {
        q.changes.push(version);
        q.hashes.push(null);
      }
    }
  }

  #byIds(table: string, ids: string[]): VoterRow[] {
    const out: VoterRow[] = [];
    for (let k = 0; k < ids.length; k += 1000) {
      const r = this.voter.query({ format: 'rsdb-query/1', kind: 'rows', table, where: { op: 'in', field: 'id', values: ids.slice(k, k + 1000) }, orderBy: [], limit: null, select: null });
      if (r.kind === 'rows') out.push(...r.rows);
    }
    return out;
  }
}

/** Index keys of a filter: (field, value) pairs one of which every matching row must have; null when there are none. */
export function indexKeys(e: ExprIR): [string, unknown][] | null {
  switch (e.op) {
    case 'eq':
      return e.value === null ? null : [[e.field, e.value]];
    case 'in':
      return e.values.length ? e.values.map((v) => [e.field, v] as [string, unknown]) : null;
    case 'and':
      for (const a of e.args) {
        const k = indexKeys(a);
        if (k) return k;
      }
      return null;
    case 'or': {
      if (!e.args.length) return null;
      const all: [string, unknown][] = [];
      for (const a of e.args) {
        const k = indexKeys(a);
        if (!k) return null;
        all.push(...k);
      }
      return all;
    }
    default:
      return null;
  }
}

const valueKey = (v: unknown) => (typeof v === 'boolean' ? (v ? '1' : '0') : JSON.stringify(v));

function cmp(a: unknown, b: unknown): number {
  const x = typeof a === 'boolean' ? Number(a) : a;
  const y = typeof b === 'boolean' ? Number(b) : b;
  if (typeof x === 'number' && typeof y === 'number') return x < y ? -1 : x > y ? 1 : 0;
  if (typeof x === 'string' && typeof y === 'string') return x < y ? -1 : x > y ? 1 : 0;
  throw new Error(`replay: comparison of ${typeof x} and ${typeof y} is outside the bench workload`);
}

/** §6.2 filter semantics on one row, for the value types the bench writes (ASCII strings, numbers, booleans; no NULL operands). */
export function matches(e: ExprIR | null, row: Row): boolean {
  if (e === null) return true;
  switch (e.op) {
    case 'and':
      return e.args.every((a) => matches(a, row));
    case 'or':
      return e.args.some((a) => matches(a, row));
    case 'isNull':
      return (row[e.field] ?? null) === null;
    case 'notNull':
      return (row[e.field] ?? null) !== null;
    case 'in':
    case 'nin': {
      const v = row[e.field] ?? null;
      if (v === null) return false;
      const hit = e.values.some((x) => x !== null && cmp(v, x) === 0);
      return e.op === 'in' ? hit : !hit;
    }
    case 'startsWith': {
      const v = row[e.field] ?? null;
      return typeof v === 'string' && v.startsWith(e.value);
    }
    default: {
      const v = row[e.field] ?? null;
      if (v === null || e.value === null) return false;
      const c = cmp(v, e.value);
      switch (e.op) {
        case 'eq': return c === 0;
        case 'ne': return c !== 0;
        case 'lt': return c < 0;
        case 'lte': return c <= 0;
        case 'gt': return c > 0;
        case 'gte': return c >= 0;
      }
    }
  }
  throw new Error(`replay: unknown filter op ${(e as ExprIR).op}`);
}

function ruleChanged(ir: QueryIR, touches: Touch[]): boolean {
  if (ir.kind === 'count') {
    let delta = 0;
    for (const t of touches) delta += Number(!!t.after && matches(ir.where, t.after)) - Number(!!t.before && matches(ir.where, t.before));
    return delta !== 0;
  }
  const cols = ir.select ?? null;
  for (const t of touches) {
    const mb = !!t.before && matches(ir.where, t.before);
    const ma = !!t.after && matches(ir.where, t.after);
    if (mb !== ma) return true;
    if (!mb) continue;
    const keys = cols ?? Object.keys(t.after!);
    if (keys.some((k) => canonical(t.before![k] ?? null) !== canonical(t.after![k] ?? null))) return true;
  }
  return false;
}
