/**
 * The T4 workload (SPEC §13.5), reused by T6 and the D/F suites: writer clients send random batches and bank transfers, reader
 * clients hold subscriptions with churn, writers pause at quiescence points, and every observation goes to the History for voter
 * replay. Checks: §13.2 on every callback (Observer), R4/R7 and drift at quiescence, R6 probes, R9 bank totals, version
 * accounting and R1 replay at the end, acknowledged inserts and counters (§7.3), R11 stats after unsubscribe.
 * Cluster runs mirror each subscription on readers of every node and compare their deliveries version by version (R8); fault runs
 * read the full state back at every quiescence point, compare it across nodes (R8) and use it as a replay checkpoint.
 */
import type { MutationIR, OpResult } from '@rsdb/client';
import { canonical } from '../voter/voter.ts';
import type { VoterRow } from '../voter/voter.ts';
import { dbInfo, stats } from './admin.ts';
import { client, withTimeout, type AnyClient } from './client.ts';
import { sleep } from './env.ts';
import { FUZZ_SCHEMA, WriterState, addOps, batch, build, columnsOf, itemRow, learn, query, transfer, type GenQuery } from './gen.ts';
import { History } from './history.ts';
import { Observer, countHash, rowsHash, type Delivery } from './observe.ts';
import type { Rng } from './rng.ts';
import type { CaseCtx } from './suite.ts';

export interface WorkloadOptions {
  db: string;
  /** Version of the push that created FUZZ_SCHEMA (the first entry of the log). */
  pushVersion: number;
  /** Admin URL for /v1/databases and /v1/stats. */
  adminUrl: string;
  /** Cluster: every node's admin URL; the final version is the highest any node reports, stats are summed. */
  adminUrls?: string[];
  /** URL list of each client. */
  url: (role: 'writer' | 'reader', i: number) => string | string[];
  writers: number;
  batches: number;
  quiesceEvery: number;
  readers: number;
  subs: number;
  /** Subscriptions whose every delivery is checked against the voter (§13.3). */
  recorded: number;
  /** Bound on the number of rows each writer keeps (the table stays ≤ writers × maxRows + initialRows). */
  maxRowsPerWriter: number;
  initialRows: number;
  /** No faults: unknown outcomes and transport errors fail the seed; versions must be exactly 1..N. */
  faultFree: boolean;
  /** Every batch also increments a per-writer counter (§13.2 faults row). */
  counters?: boolean;
  bankRate?: number;
  timeoutMs?: number;
  /** R4 bound at quiescence points. */
  convergeMs?: number;
  /** Delivery checks of recorded subscriptions above this are sampled, to bound voter time. */
  maxDeliveryChecks?: number;
  /** Keep running further phases after `batches` until this holds (fault suites: until the faults happened), up to `maxBatches`. */
  until?: () => boolean;
  /** Default 4 × batches. */
  maxBatches?: number;
  /** Awaited before every quiescence point (fault suites: let a restart finish). */
  beforeQuiesce?: () => Promise<unknown>;
  /** Each subscription is opened on this many readers, one from each group `reader % mirrors` (one group per node), R8. */
  mirrors?: number;
  /** Fault runs: URLs read back through pinned clients at every quiescence point; the states must be equal (R8). */
  checkpointUrls?: string[];
}

export interface WriteRecord {
  /** Request sent and settled (ms since epoch). */
  t0: number;
  t1: number;
  r: 'ack' | 'rejected' | 'unknown' | 'failed';
  /** Error code of a write that was not acknowledged. */
  code?: string;
}

const GROUPS = 4;
const PER_GROUP = 6;
const BALANCE = 1000;
/** Data errors the generator provokes on purpose; the batch is simply not applied. */
const EXPECTED = new Set(['NOT_FOUND', 'DUPLICATE_ID', 'CONSTRAINT_VIOLATION', 'TYPE_ERROR']);
const TRANSPORT = new Set(['UNAVAILABLE', 'TIMEOUT', 'CLOSED']);

interface Member {
  reader: number;
  obs: Observer;
}
interface Live {
  n: number;
  q: GenQuery;
  members: Member[];
}

export class Workload {
  readonly h: History;
  readonly o: Required<WorkloadOptions>;
  readonly stats = { acked: 0, rejected: 0, unknown: 0, notApplied: 0, callbacks: 0, probes: 0, quiescence: 0, churned: 0 };
  lastAcked = 0;
  /** Batches attempted so far (acknowledged or not). */
  attempted = 0;
  /** Every batch request with its timing and outcome (liveness bounds of §11.2). */
  readonly writes: WriteRecord[] = [];
  #batchWaiters: { n: number; resolve: () => void }[] = [];
  #t: CaseCtx;
  #rng: Rng;
  #writers: AnyClient[] = [];
  #readers: AnyClient[] = [];
  #pinned: AnyClient[] = [];
  #wst: WriterState[] = [];
  #wrng: Rng[] = [];
  #live = new Map<number, Live>();
  #retired: Observer[] = [];
  #subSeq = 0;
  #recordLeft = 0;
  #baseSubs = 0;
  #ackedPer: number[] = [];
  #unknownPer: number[] = [];
  #ackedIds = new Set<string>();
  #maybeDeleted = new Set<string>();
  #deletedPrefixes: string[] = [];
  #sampler: NodeJS.Timeout | null = null;
  /** Version of the last seed batch: the bank accounts exist from here on. */
  #seeded = 0;
  #quiescing = false;
  #stopped: string | null = null;
  /** True while writers are paused at a quiescence point (fault injectors hold off then). */
  get quiescing(): boolean {
    return this.#quiescing;
  }

  constructor(t: CaseCtx, o: WorkloadOptions) {
    this.#t = t;
    this.#rng = t.rng.fork('workload');
    this.o = {
      counters: false, bankRate: 0.1, timeoutMs: 10_000, convergeMs: 5000, maxDeliveryChecks: 150_000, until: () => true,
      beforeQuiesce: async () => {}, adminUrls: [o.adminUrl], mirrors: 1, checkpointUrls: [], maxBatches: 4 * o.batches, ...o,
    };
    if (this.o.readers % this.o.mirrors !== 0) throw new Error('readers must be a multiple of mirrors');
    this.h = new History(t, o.db);
  }

  /** Seed data, clients and the initial subscriptions. */
  async setup(): Promise<void> {
    const { o } = this;
    const t = this.#t;
    this.h.push(o.pushVersion, FUZZ_SCHEMA);
    this.#baseSubs = await this.#subscriptions();
    for (let w = 0; w < o.writers; w++) {
      this.#writers.push(client(t, o.url('writer', w), o.db, { timeoutMs: o.timeoutMs }));
      this.#wst.push(new WriterState(`w${w}_`, o.maxRowsPerWriter));
      this.#wrng.push(this.#rng.fork(`writer${w}`));
      this.#ackedPer.push(0);
      this.#unknownPer.push(0);
    }
    for (let r = 0; r < o.readers; r++) this.#readers.push(client(t, o.url('reader', r), o.db, { timeoutMs: o.timeoutMs }));
    for (const u of o.checkpointUrls) this.#pinned.push(client(t, u, o.db, { timeoutMs: o.timeoutMs }));

    const accounts = Array.from({ length: GROUPS * PER_GROUP }, (_, k) => ({ id: `acct${k}`, grp: k % GROUPS }));
    for (const st of this.#wst) st.accounts.push(...accounts);
    const cols = columnsOf(FUZZ_SCHEMA, 'items');
    const seedOps: MutationIR[] = [
      ...accounts.map((a): MutationIR => ({ op: 'insert', table: 'accounts', row: { id: a.id, grp: a.grp, bal: BALANCE } })),
      ...this.#wst.map((_, w): MutationIR => ({ op: 'insert', table: 'counters', row: { id: `c${w}` } })),
    ];
    for (let k = 0; k < o.initialRows; k++) {
      const id = `seed${k}`;
      seedOps.push({ op: 'insert', table: 'items', row: { ...itemRow(this.#rng, cols), id, u: null } });
      this.#wst[k % o.writers]!.ids.add(id);
    }
    for (let k = 0; k < seedOps.length; k += 500) {
      const ops = seedOps.slice(k, k + 500);
      const r = await this.#writers[0].batch((tx: any) => addOps(tx, ops)).catch((e: any) => t.abort(`seed batch rejected: ${e?.code} ${e?.message}`));
      this.h.ack(r.version, ops, r.results);
      this.lastAcked = Math.max(this.lastAcked, r.version);
      for (const [i, op] of ops.entries()) if (op.table === 'items') this.#ackedIds.add((r.results[i] as { id: string }).id);
    }
    this.#seeded = this.lastAcked;

    // Bank subscriptions (R9) first, then random queries; `recorded` of them keep every delivery for voter replay.
    this.#recordLeft = o.recorded;
    for (let g = 0; g < GROUPS; g++) this.#subscribe(this.#bankQuery(g));
    while (this.#live.size < o.subs) this.#subscribe();
    await Promise.all(this.#members().map((m) => withTimeout(m.obs.sub.ready, o.timeoutMs + 5000, 'ready').catch((e: any) => t.fail(`${m.obs.label}: ready rejected: ${e?.code ?? ''} ${e?.message ?? e}`))));
    this.#sampler = setInterval(() => {
      for (const m of this.#members()) m.obs.sample();
    }, 50);
    t.defer(() => this.#stopSampler());
  }

  #members(): Member[] {
    return [...this.#live.values()].flatMap((l) => l.members);
  }

  async #subscriptions(): Promise<number> {
    let n = 0;
    for (const u of this.o.adminUrls) n += await stats(u).then((s) => s.subscriptions, () => 0);
    return n;
  }

  #stopSampler() {
    if (this.#sampler) clearInterval(this.#sampler);
    this.#sampler = null;
  }

  #bankQuery(g: number): GenQuery {
    return {
      ir: { format: 'rsdb-query/1', kind: 'rows', table: 'accounts', where: { op: 'eq', field: 'grp', value: g }, orderBy: [], limit: null, select: null },
      wheres: [{ grp: g }],
    };
  }

  #subscribe(q?: GenQuery): void {
    const t = this.#t;
    const { o } = this;
    const bank = q?.ir.table === 'accounts';
    q ??= query(this.#rng, FUZZ_SCHEMA, { limitRate: 0.85, maxLimit: 50, countRate: 0.2 });
    const n = ++this.#subSeq;
    const record = this.#recordLeft > 0 && (bank || this.#rng.chance(0.5));
    if (record) this.#recordLeft--;
    // R8: mirrored subscriptions must deliver the same result whenever they deliver at the same version.
    const seen = o.mirrors > 1 ? new Map<number, { hash: string; reader: number; sample?: string }>() : null;
    const members: Member[] = [];
    for (let g = 0; g < o.mirrors; g++) {
      const reader = g + o.mirrors * this.#rng.int(o.readers / o.mirrors);
      const obs = new Observer(t, {
        label: `s${n}@r${reader}`,
        query: q.ir,
        record,
        // A replica may serve the first snapshot before the seed data (R6 binds only the reader's own writes).
        invariant: bank ? (rows, v) => (v >= this.#seeded ? bankInvariant(rows) : null) : undefined,
        onCall: () => void this.stats.callbacks++,
        onDelivery: seen ? (d) => {
          const other = seen.get(d.version);
          if (!other) seen.set(d.version, { hash: d.hash, reader, sample: d.sample });
          else if (other.hash !== d.hash) t.fail(`R8 s${n}: at v${d.version} reader ${reader} got ${clip(d.sample ?? '(large)')}, reader ${other.reader} got ${clip(other.sample ?? '(large)')}`);
        } : undefined,
      });
      obs.attach(build(this.#readers[reader], q).subscribe(obs.listener));
      members.push({ reader, obs });
    }
    this.#live.set(n, { n, q, members });
  }

  #churn(count: number): void {
    if (this.#quiescing) return;
    const candidates = [...this.#live.values()].filter((l) => l.q.ir.table !== 'accounts');
    for (const l of this.#rng.sample(candidates, count)) {
      for (const m of l.members) {
        m.obs.unsubscribe();
        if (m.obs.deliveries.length) this.#retired.push(m.obs);
      }
      this.#live.delete(l.n);
      this.#subscribe();
      this.stats.churned++;
    }
  }

  /** Ends the load early (a fault made the rest meaningless): writers stop after their current batch, no more quiescence points. */
  stop(reason: string): void {
    this.#stopped ??= reason;
    for (const x of this.#batchWaiters.splice(0)) x.resolve();
  }
  get stopped(): string | null {
    return this.#stopped;
  }

  /**
   * A batch through a client outside the writer pool (F2 probes of an isolated node), accounted like the writers' batches.
   * Only for inserts with fresh explicit ids, which no writer touches.
   */
  async writeVia(c: AnyClient, ops: MutationIR[]): Promise<WriteRecord & { version?: number; code?: string }> {
    const rec: WriteRecord = { t0: Date.now(), t1: 0, r: 'failed' };
    try {
      const r = await c.batch((tx: any) => addOps(tx, ops));
      rec.t1 = Date.now();
      rec.r = 'ack';
      this.h.ack(r.version, ops, r.results);
      this.lastAcked = Math.max(this.lastAcked, r.version);
      ops.forEach((op, i) => op.op === 'insert' && op.table === 'items' && this.#ackedIds.add((r.results[i] as { id: string }).id));
      return { ...rec, version: r.version };
    } catch (e: any) {
      if (e?.name !== 'RsdbError') throw e;
      rec.t1 = Date.now();
      if (e.outcome === 'unknown') {
        rec.r = 'unknown';
        this.h.unknownOutcome();
        this.stats.unknown++;
      } else if (!TRANSPORT.has(e.code)) this.#t.fail(`probe write: unexpected ${e.code} (${e.message}), outcome ${e.outcome}`);
      return { ...rec, code: e.code };
    }
  }

  /** Resolves once `n` batches have been attempted (fault schedules count batches, not time, so fast servers see them too). */
  afterBatches(n: number): Promise<void> {
    if (this.attempted >= n) return Promise.resolve();
    return new Promise((resolve) => this.#batchWaiters.push({ n, resolve }));
  }

  /** Writers run in phases of `quiesceEvery` batches; every phase ends with a quiescence point. */
  async run(): Promise<void> {
    const { o } = this;
    const churn = setInterval(() => this.#churn(1), 300);
    const cap = Math.max(o.batches, o.maxBatches);
    try {
      for (let done = 0, p = 1; !this.#stopped && (done < o.batches || (!o.until() && done < cap)); p++) {
        const n = Math.min(o.quiesceEvery, (done < o.batches ? o.batches : cap) - done);
        let next = 0;
        await Promise.all(this.#writers.map(async (_, w) => {
          while (next < n && !this.#stopped) {
            next++;
            await this.#writeOne(w);
          }
        }));
        done += n;
        if (this.#stopped) break;
        await this.quiesce(`q${p}`);
        this.#churn(Math.ceil(this.#live.size / 10));
      }
    } finally {
      clearInterval(churn);
    }
  }

  async #writeOne(w: number): Promise<void> {
    const t = this.#t;
    const { o } = this;
    const st = this.#wst[w]!;
    const rng = this.#wrng[w]!;
    let ops = rng.chance(o.bankRate) ? transfer(rng, st) : batch(rng, st, columnsOf(FUZZ_SCHEMA, 'items'), 20);
    if (o.counters) ops = [...ops, { op: 'update', table: 'counters', id: `c${w}`, set: { n: { $inc: 1 } } }];
    let r: { version: number; results: OpResult[] };
    this.attempted++;
    const rec: WriteRecord = { t0: Date.now(), t1: 0, r: 'failed' };
    this.writes.push(rec);
    for (const x of this.#batchWaiters.filter((x) => this.attempted >= x.n)) x.resolve();
    this.#batchWaiters = this.#batchWaiters.filter((x) => this.attempted < x.n);
    try {
      r = await this.#writers[w].batch((tx: any) => addOps(tx, ops));
      rec.r = 'ack';
    } catch (e: any) {
      if (e?.name !== 'RsdbError') throw e;
      rec.t1 = Date.now();
      rec.r = e.outcome === 'unknown' ? 'unknown' : EXPECTED.has(e.code) ? 'rejected' : 'failed';
      rec.code = e.code;
      if (e.outcome === 'unknown') {
        this.h.unknownOutcome();
        this.stats.unknown++;
        this.#unknownPer[w]!++;
        for (const op of ops) {
          if (op.op === 'delete') this.#maybeDeleted.add(op.id);
          else if (op.op === 'deleteWhere' && op.where?.op === 'startsWith') this.#deletedPrefixes.push(op.where.value);
        }
        if (o.faultFree) t.fail(`writer ${w}: outcome unknown (${e.code}: ${e.message}) in a fault-free run`);
      } else if (EXPECTED.has(e.code)) this.stats.rejected++;
      else if (!o.faultFree && TRANSPORT.has(e.code)) this.stats.notApplied++;
      else t.fail(`writer ${w}: unexpected ${e.code} (${e.message}), outcome ${e.outcome}`);
      return;
    } finally {
      rec.t1 ||= Date.now();
    }
    const shapeOk = Array.isArray(r.results) && r.results.length === ops.length
      && ops.every((op, i) => (op.op !== 'insert' && op.op !== 'upsert') || typeof (r.results[i] as { id?: unknown } | undefined)?.id === 'string');
    this.h.ack(r.version, ops, shapeOk ? r.results : []);
    if (!shapeOk) {
      t.fail(`writer ${w}: batch acknowledged at v${r.version} with results ${clip(canonical(r.results ?? null))} that do not match its ${ops.length} operations`);
      this.lastAcked = Math.max(this.lastAcked, r.version);
      return;
    }
    learn(st, ops, r.results);
    this.stats.acked++;
    this.#ackedPer[w]!++;
    this.lastAcked = Math.max(this.lastAcked, r.version);
    ops.forEach((op, i) => {
      if ((op.op === 'insert' || op.op === 'upsert') && op.table === 'items') this.#ackedIds.add((r.results[i] as { id: string }).id);
      else if (op.op === 'delete') this.#maybeDeleted.add(op.id);
      else if (op.op === 'deleteWhere' && op.where?.op === 'startsWith') this.#deletedPrefixes.push(op.where.value);
    });
    if (rng.chance(0.02)) await this.#probe(w, r.version, rng);
  }

  /** R6: right after an acknowledged write, a fetch and a new subscription on the same client start at its version or later. */
  async #probe(w: number, v: number, rng: Rng): Promise<void> {
    const t = this.#t;
    const c = this.#writers[w];
    const q = query(rng, FUZZ_SCHEMA, { limitRate: 1, maxLimit: 10 });
    this.stats.probes++;
    try {
      const f = await build(c, q).fetch();
      if (f.version < v) t.fail(`R6 writer ${w}: fetch at version ${f.version} after its write at ${v}`);
      this.h.expect(`R6 fetch w${w}`, q.ir, deliveryOf(q, f));
      const sub = build(c, q).subscribe(() => {});
      try {
        const s = await sub.ready;
        if (s.version < v) t.fail(`R6 writer ${w}: first snapshot at version ${s.version} after its write at ${v}`);
      } finally {
        sub.unsubscribe();
      }
    } catch (e: any) {
      if (e?.name === 'RsdbError' && !this.o.faultFree && TRANSPORT.has(e.code)) return;
      t.fail(`R6 writer ${w}: probe rejected with ${e?.code ?? ''} ${e?.message ?? e}`);
    }
  }

  /** Quiescence point (§13.2): convergence within the R4 bound, then each subscription against fetch and, at v, the voter. */
  async quiesce(label: string): Promise<void> {
    const t = this.#t;
    const { o } = this;
    this.#quiescing = true;
    await o.beforeQuiesce();
    const v = this.lastAcked;
    this.stats.quiescence++;
    try {
      await this.#quiesce(label, v);
    } finally {
      this.#quiescing = false;
    }
  }

  async #quiesce(label: string, v: number): Promise<void> {
    const t = this.#t;
    const { o } = this;
    await Promise.all(this.#readers.map(async (c, i) => {
      const t0 = Date.now();
      try {
        await withTimeout(c.waitForVersion(v, { timeoutMs: o.convergeMs + 2000 }), o.convergeMs + 4000, 'waitForVersion');
        if (Date.now() - t0 > o.convergeMs) t.failTime(`R4 ${label}: reader ${i} reached v${v} after ${Date.now() - t0} ms (bound ${o.convergeMs} ms)`);
      } catch (e: any) {
        t.failTime(`R4 ${label}: reader ${i} waitForVersion(${v}) failed after ${Date.now() - t0} ms: ${e?.code ?? ''} ${e?.message ?? e}`);
      }
    }));
    const work = [...this.#live.values()].flatMap((l) => l.members.map((m) => ({ l, m })));
    let next = 0;
    await Promise.all(Array.from({ length: 16 }, async () => {
      while (next < work.length) {
        const { l, m } = work[next++]!;
        await this.#checkAtQuiescence(l, m, v, label);
      }
    }));
    if (!o.faultFree || o.checkpointUrls.length) await this.#checkpoint(label, v);
  }

  async #checkAtQuiescence(l: Live, m: Member, v: number, label: string): Promise<void> {
    const t = this.#t;
    const { q } = l;
    const { obs } = m;
    const sub = obs.sub;
    obs.sample();
    if (obs.terminated) {
      t.fail(`${obs.label}: terminated by the server with ${obs.terminated.code} (${obs.terminated.message})`);
      for (const x of l.members) if (x !== m) x.obs.unsubscribe();
      this.#live.delete(l.n);
      return;
    }
    if (!sub.current || sub.syncedVersion < v) {
      t.failTime(`R4 ${label} ${obs.label}: syncedVersion ${sub.syncedVersion} below v${v} after waitForVersion`);
      return;
    }
    const cur = obs.current()!;
    this.h.expect(`${label} current ${obs.label}`, q.ir, { ...cur, version: Math.max(v, cur.version) });
    for (let attempt = 0; attempt < 3; attempt++) {
      let f: any;
      try {
        f = await build(this.#readers[m.reader], q).fetch({ minVersion: v });
      } catch (e: any) {
        if (e?.name === 'RsdbError' && !this.o.faultFree && TRANSPORT.has(e.code)) return;
        t.fail(`${label} ${obs.label}: fetch rejected with ${e?.code ?? ''} ${e?.message ?? e}`);
        return;
      }
      if (f.version < v) t.fail(`${label} ${obs.label}: fetch({minVersion: ${v}}) answered at version ${f.version}`);
      const fd = deliveryOf(q, f);
      this.h.expect(`${label} fetch ${obs.label}`, q.ir, fd);
      const now = obs.current();
      if (now && now.version <= f.version && f.version <= sub.syncedVersion) {
        if (now.hash !== fd.hash) t.fail(`R7 ${label} ${obs.label}: current.rows at v${now.version} (synced ${sub.syncedVersion}) differ from fetch at v${f.version}: ${clip(now.sample ?? '(large)')} vs ${clip(fd.sample ?? '(large)')}`);
        return;
      }
      await sleep(50);
    }
  }

  /**
   * Fault runs: every table read back at one version through each pinned client (or reader 0); the states must be equal (R8)
   * and become a replay checkpoint. Sources that cannot answer (a node still isolated) are skipped.
   */
  async #checkpoint(label: string, v: number): Promise<void> {
    const t = this.#t;
    const sources = this.#pinned.length ? this.#pinned.map((c, i) => ({ c, name: this.o.checkpointUrls[i]! })) : [{ c: this.#readers[0], name: 'reader 0' }];
    let min = v;
    for (let attempt = 0; attempt < 3; attempt++) {
      const states = (await Promise.all(sources.map(async ({ c, name }) => ({ name, state: await this.#readState(c, min) })))).filter((x) => x.state);
      if (!states.length) return t.log(`${label}: no node answered the checkpoint read`);
      const versions = new Set(states.map((x) => x.state!.version));
      if (versions.size > 1 || states.some((x) => x.state!.version < 0)) {
        min = Math.max(min, ...states.map((x) => x.state!.version));
        await sleep(200);
        continue;
      }
      const [first, ...rest] = states;
      const canon = canonical(first!.state!.tables);
      for (const x of rest) {
        const other = canonical(x.state!.tables);
        if (other !== canon) {
          t.fail(`R8 ${label}: ${x.name} and ${first!.name} hold different states at v${first!.state!.version}: ${firstDifference(first!.state!.tables, x.state!.tables)}`);
          return;
        }
      }
      this.h.checkpoint(first!.state!.version, FUZZ_SCHEMA, first!.state!.tables);
      return;
    }
    t.log(`${label}: checkpoint skipped, the nodes kept answering at different versions`);
  }

  /** Every table at one version (-1 if the tables came back at different versions), or null on a transport error. */
  async #readState(c: AnyClient, min: number): Promise<{ version: number; tables: Record<string, VoterRow[]> } | null> {
    const tables: Record<string, VoterRow[]> = {};
    const versions = new Set<number>();
    try {
      for (const table of Object.keys(FUZZ_SCHEMA.tables)) {
        const r = await c.from(table).fetch({ minVersion: min });
        versions.add(r.version);
        tables[table] = r.rows;
      }
    } catch (e: any) {
      if (e?.name === 'RsdbError' && TRANSPORT.has(e.code)) return null;
      this.#t.fail(`checkpoint read rejected with ${e?.code ?? ''} ${e?.message ?? e}`);
      return null;
    }
    return { version: versions.size === 1 ? [...versions][0]! : -1, tables };
  }

  /** Final quiescence, accounting and voter replay, acknowledged data present, counters, R11. */
  async finish(): Promise<{ vFinal: number; replayedTo: number; checked: number }> {
    const t = this.#t;
    const { o } = this;
    await this.quiesce('final');
    const infos = await Promise.all(o.adminUrls.map((u) => dbInfo(u, o.db).catch(() => undefined)));
    const known = infos.filter((x) => x !== undefined);
    if (!known.length) t.abort(`${o.db} missing from /v1/databases`);
    const vFinal = Math.max(...known.map((x) => x.version));

    // Acknowledged inserts present unless an acknowledged or unknown-outcome batch may have deleted them (§7.3).
    const reader = this.#readers[0];
    const all = await reader.from('items').select('i').fetch({ minVersion: this.lastAcked }).catch((e: any) => t.abort(`final fetch: ${e?.code} ${e?.message}`));
    const present = new Set(all.rows.map((r: { id: string }) => r.id));
    let missing = 0;
    for (const id of this.#ackedIds) {
      if (present.has(id) || this.#maybeDeleted.has(id) || this.#deletedPrefixes.some((p) => id.startsWith(p))) continue;
      if (missing++ < 5) t.fail(`acknowledged insert ${JSON.stringify(id)} is missing`);
    }
    if (missing > 5) t.fail(`${missing} acknowledged inserts missing in all`);
    if (o.counters) {
      const counters = await reader.from('counters').fetch({ minVersion: this.lastAcked });
      const byId = new Map(counters.rows.map((r: { id: string; n: number }) => [r.id, r.n]));
      this.#wst.forEach((_, w) => {
        const n = byId.get(`c${w}`) as number | undefined;
        const lo = this.#ackedPer[w]!;
        const hi = lo + this.#unknownPer[w]!;
        if (n === undefined || n < lo || n > hi) t.fail(`counter c${w} is ${n}, expected within [${lo}, ${hi}] (acknowledged, + unknown)`);
      });
    }

    // Every delivery of the recorded subscriptions (sampled above maxDeliveryChecks) goes to voter replay.
    const recorded = [...this.#members().map((m) => m.obs), ...this.#retired].filter((x) => x.deliveries.length);
    const total = recorded.reduce((n, x) => n + x.deliveries.length, 0);
    const stride = Math.max(1, Math.ceil(total / o.maxDeliveryChecks));
    let k = 0;
    for (const obs of recorded) for (const d of obs.deliveries) if (k++ % stride === 0) this.h.expect(`delivery ${obs.label}`, obs.query, d);
    if (stride > 1) t.log(`${total} recorded deliveries, every ${stride}th checked`);
    const { replayedTo, checked, restored, unchecked } = this.h.verify(vFinal, o.faultFree);

    // R11: unsubscribe everything; /v1/stats.subscriptions returns to the baseline within 1 s.
    for (const m of this.#members()) m.obs.unsubscribe();
    this.#live.clear();
    this.#stopSampler();
    const t0 = Date.now();
    let subs = -1;
    while (Date.now() - t0 < 1000) {
      subs = await this.#subscriptions();
      if (subs <= this.#baseSubs) break;
      await sleep(50);
    }
    if (subs > this.#baseSubs) t.failTime(`R11: /v1/stats.subscriptions is ${subs} 1 s after unsubscribing everything (baseline ${this.#baseSubs})`);
    t.log(`v${vFinal}: ${this.stats.acked} acked, ${this.stats.rejected} rejected, ${this.stats.unknown} unknown, ${this.stats.callbacks} callbacks, ${this.stats.churned} churned, replayed to v${replayedTo}${restored ? ` (${restored} checkpoint(s), ${unchecked} version(s) unchecked)` : ''}, ${checked} checks`);
    return { vFinal, replayedTo, checked };
  }
}

/** R9: each bank group keeps its accounts and its total. */
function bankInvariant(rows: readonly Record<string, unknown>[]): string | null {
  const total = rows.reduce((s, r) => s + (r.bal as number), 0);
  if (rows.length !== PER_GROUP || total !== PER_GROUP * BALANCE) return `bank group has ${rows.length} accounts totalling ${total}, expected ${PER_GROUP} totalling ${PER_GROUP * BALANCE}`;
  return null;
}

export function deliveryOf(q: GenQuery, r: { version: number; rows?: unknown[]; count?: number }): Delivery {
  if (q.ir.kind === 'count') return { version: r.version, hash: countHash(r.count!) };
  const canon = `[${r.rows!.map((x) => canonical(x)).join(',')}]`;
  return { version: r.version, hash: rowsHash(canon), ...(canon.length <= 2000 ? { sample: canon } : {}) };
}

const clip = (s: string, n = 300) => (s.length > n ? `${s.slice(0, n)}…` : s);

function firstDifference(a: Record<string, VoterRow[]>, b: Record<string, VoterRow[]>): string {
  for (const table of Object.keys(a)) {
    const x = new Map((a[table] ?? []).map((r) => [r.id as string, canonical(r)]));
    const y = new Map((b[table] ?? []).map((r) => [r.id as string, canonical(r)]));
    for (const [id, row] of x) if (y.get(id) !== row) return `${table}/${id}: ${clip(row)} vs ${clip(y.get(id) ?? 'absent')}`;
    for (const [id, row] of y) if (!x.has(id)) return `${table}/${id}: absent vs ${clip(row)}`;
  }
  return 'row order differs';
}
