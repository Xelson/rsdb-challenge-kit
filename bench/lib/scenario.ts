/**
 * One benchmark run (SPEC §14.1 procedure): fresh server → preload → generators → 10 s warm-up → 60 s measurement → quiesce →
 * validation, plus the analysis of §14.2 (affected pairs, `lat`, `ack`, server and client cost) and its validity checks.
 * Scenarios script their setup and phases with `Run`; most use `standard()` for the window itself.
 */
import fs from 'node:fs';
import type { QueryIR, SchemaIR } from '@rsdb/client';
import { freshDb } from '../../conformance/lib/admin.ts';
import type { NodeHandle } from '../../conformance/lib/env.ts';
import type { Env } from '../../conformance/lib/env.ts';
import { Rng } from '../../conformance/lib/rng.ts';
import type { Sdk } from '../../conformance/lib/sdk.ts';
import type { Control } from './control.ts';
import { Hist, type HistJson } from './hist.ts';
import { anonOf, cgroupOf, cpuSeconds, type Gen, Host, MemSampler, netSum, nowMs, sleep } from './host.ts';
import { resultHash, Voter, type VoterRow } from '../../conformance/voter/voter.ts';
import { type QState, Replay } from './replay.ts';
import { physicalQuery, type OpGenSpec, type QSpec, type Row, Variant } from './workload.ts';

export interface RunConfig {
  scale: number;
  variant: Variant;
  warmupMs: number;
  windowMs: number;
  seed: string;
  /** `control`: same writes, no subscriptions (§14.2 cpu); `stub`: readers on the no-op SDK (cli_*). */
  mode: 'main' | 'control' | 'stub';
  log: (line: string) => void;
}

export interface Db {
  name: string;
  /** Version after schema push and preload: replay starts here. */
  version0: number;
  preload: { table: string; count: number; row: (i: number) => Row }[];
}

export interface SubInfo {
  id: number;
  db: number;
  spec: QSpec;
  audit: boolean;
  gen: string;
}

export interface ReaderGroup {
  normal: Gen[];
  audit: Gen[];
  subs: SubInfo[];
  /** B9's slow process (also in `normal`). */
  slow?: Gen;
}

export interface WriterGroup {
  gens: Gen[];
  rate: number;
  /** Process index → rate share. */
  perProc: number;
}

/** Raw measurements of the window; scenarios turn them into §14.4 metrics. */
export interface Measured {
  lat: Hist;
  /** `lat` samples of writes scheduled in `latRange` only (B9: while the slow client is stopped). */
  latIn: Hist;
  ack: Hist;
  ttfs: Hist;
  pairs: number;
  /** Writes scheduled in the window and acknowledged. */
  writes: number;
  cpu: number;
  net: number;
  peer: number;
  memSteady: number;
  memPeak: number;
  cliCpu: number;
  cliAnon: number;
  cliSubs: number;
  cliPairs: number;
  missed: number;
  extra: Record<string, number>;
}

export const emptyMeasured = (): Measured => ({
  lat: new Hist(), latIn: new Hist(), ack: new Hist(), ttfs: new Hist(), pairs: 0, writes: 0, cpu: 0, net: 0, peer: 0, memSteady: NaN, memPeak: NaN,
  cliCpu: 0, cliAnon: 0, cliSubs: 0, cliPairs: 0, missed: 0, extra: {},
});

export interface WriteEntry {
  db: number;
  sched: number;
  sent: number;
  settled: number;
  version: number | null;
  r: 'a' | 'r' | 'u';
  ops: any[];
}

const CONNS_PER_CONTAINER = 5000;

export class Run {
  readonly host: Host;
  readonly ctl: Control;
  readonly cfg: RunConfig;
  readonly V: Variant;
  readonly sdk: Sdk;
  readonly schema: SchemaIR;
  readonly rng: Rng;
  env!: Env;
  nodes: NodeHandle[] = [];
  readonly dbs: Db[] = [];
  readonly gens: Gen[] = [];
  readonly writerGens: Gen[] = [];
  /** Validity failures (§14.2): any makes the scenario score 0. */
  readonly invalid: string[] = [];
  /** A writer process fell behind its schedule (§14.1): the run is retried. */
  behind = false;
  /** Highest acknowledged version per database after the last window. */
  lastAcked: number[] = [];
  /** Readers' answers to the last `final`. */
  finals: Map<string, any> = new Map();
  /** Server memory samples of the last window. */
  sampler: MemSampler | null = null;
  readonly notes: string[] = [];
  readonly faultFree: boolean;
  #genSeq = 0;
  #writerGroups = 0;
  #tampered = new Set<string>();

  constructor(host: Host, ctl: Control, sdk: Sdk, cfg: RunConfig, o: { faultFree?: boolean } = {}) {
    this.host = host;
    this.ctl = ctl;
    this.sdk = sdk;
    this.cfg = cfg;
    this.V = cfg.variant;
    this.schema = cfg.variant.schema();
    this.rng = new Rng(cfg.seed);
    this.faultFree = o.faultFree ?? true;
  }

  // ─────────────────────────────── scale ───────────────────────────────

  /** Data sizes: scaled by the run scale and the variant factor. */
  n(x: number): number {
    return Math.max(1, Math.round(x * this.cfg.scale * this.V.factor));
  }
  /** Rates per second. */
  rate(x: number): number {
    return x * this.cfg.scale * this.V.factor;
  }
  /** Connection counts never grow above their base value (§14.1). */
  conns(x: number): number {
    return Math.max(1, Math.round(x * this.cfg.scale * Math.min(1, this.V.factor)));
  }
  note(line: string): void {
    this.notes.push(line);
    this.cfg.log(`    ${line}`);
  }
  fail(line: string): void {
    if (!this.invalid.includes(line)) this.invalid.push(line);
  }

  // ─────────────────────────────── server and data ───────────────────────────────

  async server(kind: 'single' | 'cluster'): Promise<NodeHandle[]> {
    const { env, nodes } = await this.host.server(kind);
    this.env = env;
    this.nodes = nodes;
    return nodes;
  }

  get urls(): string[] {
    return this.nodes.map((n) => n.url);
  }

  /** Creates a database with the (variant) bench schema. */
  async database(label: string, url = this.urls[0]!): Promise<Db> {
    const name = `${label}_${this.cfg.mode}_${Date.now().toString(36)}_${this.dbs.length}`;
    const version0 = await freshDb(url, name, this.schema);
    const db: Db = { name, version0, preload: [] };
    this.dbs.push(db);
    return db;
  }

  /** Untimed preload through the SDK: batches of 1,000 inserts, 4 in flight. Rows are logical; the variant maps them. */
  async preload(db: Db, table: string, count: number, row: (i: number) => Row, urls = this.urls): Promise<void> {
    const physical = this.V.table(table);
    const make = (i: number) => this.V.row(table, row(i));
    db.preload.push({ table: physical, count, row: make });
    const c: any = this.sdk.createClient({ url: urls, database: db.name, timeoutMs: 60_000 });
    try {
      let next = 0;
      const worker = async () => {
        for (;;) {
          const from = next;
          if (from >= count) return;
          next = Math.min(count, from + 1000);
          const r = await c.batch((tx: any) => {
            for (let i = from; i < next; i++) tx.insert(physical, make(i));
          });
          if (r.version > db.version0) db.version0 = r.version;
        }
      };
      await Promise.all([worker(), worker(), worker(), worker()]);
    } finally {
      await c.close().catch(() => {});
    }
  }

  // ─────────────────────────────── generators ───────────────────────────────

  async gen(role: string, net: 'writer' | 'reader', params: unknown, o: { sdk?: 'real' | 'stub'; sysctls?: Record<string, string> } = {}): Promise<Gen> {
    const g = await this.host.gen({ id: `${role[0]}${++this.#genSeq}`, role, net, params, sdk: o.sdk ?? (this.cfg.mode === 'stub' ? 'stub' : 'real'), sysctls: o.sysctls });
    this.gens.push(g);
    return g;
  }

  /** Open-loop writers: ⌈rate / 1000⌉ processes (§14.1), interleaved; `conns` clients per process and database. */
  async writers(dbs: Db[], rate: number, gen: OpGenSpec, o: { conns?: number; urls?: string[][]; maxPerProc?: number } = {}): Promise<WriterGroup> {
    const procs = Math.max(1, Math.ceil(rate / (o.maxPerProc ?? 1000)));
    const urls = o.urls ?? this.urls.map((_, i) => [...this.urls.slice(i), ...this.urls.slice(0, i)]);
    const gens: Gen[] = [];
    // seeded by group and process only, so the control run repeats the main run's write schedule (§14.1)
    const group = this.#writerGroups++;
    for (let p = 0; p < procs; p++) {
      gens.push(await this.gen('writer', 'writer', {
        dbs: dbs.map((d) => d.name), urls, conns: Math.max(1, Math.round((o.conns ?? 4 * procs) / procs)), gen,
        seed: `${this.cfg.seed}:w${group}:${p}`, variant: this.V.seed, proc: p, procs, prefix: `w${group}p${p}`,
      }));
    }
    this.writerGens.push(...gens);
    return { gens, rate, perProc: rate / procs };
  }

  /**
   * Readers for `conns` connections (each a list of subscription specs). Whole connections are chosen at random for audit (2 % of
   * the subscriptions, at least 50, at most a quarter at reduced scales) and opened by separate audit processes, left out of cli_*.
   */
  async readers(conns: { db: Db; urls?: string[]; specs: QSpec[]; slow?: boolean }[], o: { procs?: number; trackSynced?: boolean; audit?: boolean; slowSysctls?: Record<string, string> } = {}): Promise<ReaderGroup> {
    const slowConns = conns.filter((c) => c.slow);
    conns = conns.filter((c) => !c.slow);
    const total = conns.reduce((a, c) => a + c.specs.length, 0);
    const want = o.audit === false ? 0 : Math.min(Math.max(Math.ceil(total * 0.02), 50), Math.floor(total / 4));
    const order = this.rng.fork('audit').shuffle(conns.map((_, i) => i));
    const auditConns = new Set<number>();
    let auditSubs = 0;
    for (const i of order) {
      if (auditSubs >= want) break;
      auditConns.add(i);
      auditSubs += conns[i]!.specs.length;
    }
    const dbIndex = (d: Db) => this.dbs.indexOf(d);
    const subs: SubInfo[] = [];
    let id = 0;
    const plan = conns.map((c, i) => ({ db: dbIndex(c.db), urls: c.urls ?? this.urls, subs: c.specs.map((s) => [id++, s] as [number, QSpec]), audit: auditConns.has(i) }));
    const normal = plan.filter((c) => !c.audit);
    const audited = plan.filter((c) => c.audit);
    const procs = Math.max(o.procs ?? 1, Math.ceil(normal.length / CONNS_PER_CONTAINER));
    const group: ReaderGroup = { normal: [], audit: [], subs };
    const spawn = async (list: typeof plan, audit: boolean) => {
      const g = await this.gen('reader', 'reader', { dbs: this.dbs.map((d) => d.name), conns: list.map(({ db, urls, subs }) => ({ db, urls, subs })), variant: this.V.seed, audit, trackSynced: o.trackSynced });
      for (const c of list) for (const [sid, spec] of c.subs) subs[sid] = { id: sid, db: c.db, spec, audit, gen: g.id };
      (audit ? group.audit : group.normal).push(g);
    };
    for (let p = 0; p < procs; p++) {
      const part = normal.filter((_, i) => i % procs === p);
      if (part.length) await spawn(part, false);
    }
    if (audited.length) await spawn(audited, true);
    if (slowConns.length) {
      const list = slowConns.map((c) => ({ db: dbIndex(c.db), urls: c.urls ?? this.urls, subs: c.specs.map((s) => [id++, s] as [number, QSpec]) }));
      const g = await this.gen('reader', 'reader', { dbs: this.dbs.map((d) => d.name), conns: list, variant: this.V.seed, audit: false, trackSynced: true }, { sysctls: o.slowSysctls });
      for (const c of list) for (const [sid, spec] of c.subs) subs[sid] = { id: sid, db: c.db, spec, audit: false, gen: g.id };
      group.normal.push(g);
      group.slow = g;
    }
    return group;
  }

  // ─────────────────────────────── commands ───────────────────────────────

  /** Waits for each generator's next result (its answer to the last command). */
  async collect(gens: readonly Gen[], timeoutMs = 600_000): Promise<Map<string, any>> {
    const out = new Map<string, any>();
    await Promise.all(gens.map(async (g) => {
      const got = await this.ctl.gather<{ result: any; tampered: string[] }>(`cmd:${g.id}`, [g.id], { timeoutMs, check: () => this.host.dead([g]) });
      const d = got.get(g.id)!;
      for (const t of d.tampered ?? []) this.#tampered.add(t);
      out.set(g.id, d.result);
    }));
    if (this.#tampered.size) this.fail(`guard: the SDK replaced runtime globals the runner measures with (${[...this.#tampered].join(', ')}) — disqualified (§14.1)`);
    return out;
  }
  send(gens: readonly Gen[], cmd: Record<string, unknown> | ((g: Gen) => Record<string, unknown>)): void {
    for (const g of gens) this.ctl.release(`cmd:${g.id}`, typeof cmd === 'function' ? cmd(g) : cmd);
  }
  async call(gens: readonly Gen[], cmd: Record<string, unknown> | ((g: Gen) => Record<string, unknown>), timeoutMs?: number): Promise<Map<string, any>> {
    this.send(gens, cmd);
    return this.collect(gens, timeoutMs);
  }
  /**
   * Ends every generator. After a failed run some may still be busy with an earlier command (a writer in its window): their next
   * answer is that command's result, not `exited`, so they get `exit` again.
   */
  async exit(): Promise<void> {
    let live = this.gens.slice();
    for (let k = 0; k < 3 && live.length; k++) {
      const got = await this.call(live, { op: 'exit' }, 120_000).catch((e) => {
        this.note(`exit: ${e.message}`);
        return null;
      });
      if (!got) break;
      this.send(live.filter((g) => got.get(g.id)?.exited), { op: 'done' });
      live = live.filter((g) => !got.get(g.id)?.exited);
    }
    await this.host.waitGens(this.gens, 30_000).catch((e) => this.note(String(e.message)));
  }

  /** Ends this phase's generators and server; the next `server()` starts on a fresh data dir (B8's two parts). */
  async fresh(): Promise<void> {
    await this.exit();
    await this.host.reset();
    this.gens.length = 0;
    this.writerGens.length = 0;
    this.dbs.length = 0;
    this.nodes = [];
  }

  /** Server memory now: median of 50 ms samples over `ms`. */
  async memNow(ms = 1000): Promise<number> {
    const s = new MemSampler(await this.serverCgroups()).start();
    await sleep(ms);
    s.stop();
    return s.median(0, Infinity);
  }

  /** The node /v1/databases names as the database's leader (L2/L3). */
  async leader(db: Db): Promise<NodeHandle> {
    for (const n of this.nodes) {
      const list = await fetch(`${n.url}/v1/databases`, { signal: AbortSignal.timeout(2000) }).then((r) => r.json(), () => null) as { name: string; leader: string }[] | null;
      const id = list?.find((d) => d.name === db.name)?.leader;
      const node = this.nodes.find((x) => x.nodeId === id);
      if (node) return node;
    }
    throw new Error(`no node names a leader for ${db.name}`);
  }

  /** Every row of every table of `db` read through the SDK at `minVersion` (final state after faults, B11). */
  async readback(db: Db, minVersion: number, url: string): Promise<{ version: number; tables: Record<string, Row[]> }> {
    const c: any = this.sdk.createClient({ url, database: db.name, timeoutMs: 60_000 });
    try {
      const tables: Record<string, Row[]> = {};
      let version = -1;
      for (const t of Object.keys(this.schema.tables)) {
        const r = await c.from(t).fetch({ minVersion });
        if (version !== -1 && r.version !== version) throw new Error(`readback of ${db.name} spans versions ${version} and ${r.version}`);
        version = r.version;
        tables[t] = r.rows.map((x: Row) => ({ ...x }));
      }
      return { version, tables };
    } finally {
      await c.close().catch(() => {});
    }
  }

  /** Every logged write of this run (all databases). */
  writes(): WriteEntry[] {
    return this.#readWrites();
  }

  /**
   * Check 3 when unknown outcomes leave gaps in the write log (B11, B12): the readers' final results against a voter restored from a
   * readback of the whole database at the last acknowledged version, plus checks 1 and 2 as reported by the readers. Returns
   * the readback.
   */
  async finalByReadback(readers: ReaderGroup, db: Db, url = this.urls[0]!): Promise<{ version: number; tables: Record<string, Row[]> }> {
    const di = this.dbs.indexOf(db);
    for (const [id, f] of this.finals) {
      if (f.violations) this.fail(`check 1: ${f.violations} listener calls without a higher version in ${id}: ${f.errorSamples.join('; ')}`);
      if (f.errors) this.fail(`check 1: ${f.errors} subscription errors in ${id}: ${f.errorSamples.join('; ')}`);
      if (f.failCount) this.fail(`check 2: ${f.failCount} audit failures in ${id}: ${f.failures.slice(0, 5).join(' | ')}`);
      if (f.waitFailed.length) this.fail(`check 3: waitForVersion(lastAcked) failed within 30 s in ${id}: ${f.waitFailed.slice(0, 3).join('; ')}`);
    }
    const state = await this.readback(db, this.lastAcked[di] ?? db.version0, url);
    const voter = Voter.restore(this.schema, state.tables as Record<string, VoterRow[]>, state.version);
    const hashOf = new Map<string, string>();
    let bad = 0;
    for (const f of this.finals.values()) {
      for (const [sid, hash] of f.subs as [number, string | null, number, boolean][]) {
        const s = readers.subs[sid];
        if (!s || s.db !== di) continue;
        const ir = physicalQuery(s.spec, this.V);
        const key = JSON.stringify(ir);
        let h = hashOf.get(key);
        if (h === undefined) hashOf.set(key, (h = resultHash(voter.query(ir))));
        if (h !== hash && ++bad <= 3) this.fail(`check 3: s${sid} ends with a result other than the database's at v${state.version} (${key})`);
      }
    }
    if (bad > 3) this.fail(`check 3: ${bad} subscriptions in all end with a result other than the database's`);
    voter.close();
    return state;
  }

  /** Check 2 for deliveries logged outside `analyze` (B6 churn): replays `db` and compares each delivery with Q(D_v). */
  checkDeliveries(db: Db, deliveries: { ir: QueryIR; version: number; hash: string }[]): void {
    const di = this.dbs.indexOf(db);
    const preload: Record<string, Iterable<Row>> = {};
    for (const p of db.preload) preload[p.table] = (function* () {
      for (let i = 0; i < p.count; i++) yield p.row(i);
    })();
    const replay = new Replay(this.schema, preload, db.version0);
    const list = deliveries.slice().sort((a, b) => a.version - b.version);
    let k = 0;
    let bad = 0;
    const check = () => {
      const cache = new Map<string, string>();
      for (; k < list.length && list[k]!.version <= replay.version; k++) {
        const d = list[k]!;
        if (d.version < replay.version) continue;
        const key = JSON.stringify(d.ir);
        let h = cache.get(key);
        if (h === undefined) cache.set(key, (h = replay.hash(d.ir)));
        if (h !== d.hash && ++bad <= 3) this.fail(`check 2 (R1): a delivery at v${d.version} differs from Q(D_v) of ${key}`);
      }
    };
    check();
    for (const w of this.#readWrites().filter((x) => x.db === di && x.r === 'a').sort((a, b) => a.version! - b.version!)) {
      replay.apply(w.version!, w.ops);
      check();
    }
    if (k < list.length) this.fail(`check 2: ${list.length - k} audit deliveries at versions above the last acknowledged write`);
    replay.voter.close();
  }

  // ─────────────────────────────── measurement ───────────────────────────────

  async serverCgroups(nodes = this.nodes): Promise<string[]> {
    return Promise.all(nodes.map((n) => cgroupOf(n.container)));
  }
  async cpu(nodes = this.nodes): Promise<number> {
    return (await this.serverCgroups(nodes)).reduce((a, d) => a + cpuSeconds(d), 0);
  }
  readerNet(nodes = this.nodes): Promise<number> {
    return netSum(nodes.map((n) => n.container), this.host.readerNet, 'tx');
  }
  peerNet(nodes = this.nodes): Promise<number> {
    if (nodes.length < 2) return Promise.resolve(0);
    return netSum(nodes.map((n) => n.container), this.env.peerNetName!, 'tx');
  }

  /**
   * The standard window: readers subscribe (unless this is a control run), writers start open loop at T, the window runs
   * [T + warm-up, T + warm-up + window), then everything quiesces and the readers check their final results.
   * `hooks.beforeSubscribe` / `afterSubscribe` take memory points (B2).
   */
  async standard(readers: ReaderGroup | null, writers: WriterGroup[], o: {
    beforeSubscribe?: () => Promise<void>;
    afterSubscribe?: () => Promise<void>;
    duringWindow?: (t: { start: number; winStart: number; winEnd: number }) => Promise<void>;
    cli?: boolean;
    /** Measurement window length instead of the configured one (B9). */
    windowMs?: number;
    latRange?: (t: { winStart: number; winEnd: number }) => [number, number];
    /** Generators whose subscriptions are left out of `lat` (B9's slow process). */
    latExclude?: readonly Gen[];
    /** false: no voter replay (fault scenarios check their final state by readback). */
    analyze?: boolean;
    /** false: the scenario applies check 4 itself (B11 exempts the seconds after each kill). */
    checkMutations?: boolean;
  } = {}): Promise<Measured> {
    const m = emptyMeasured();
    const allReaders = readers ? [...readers.normal, ...readers.audit] : [];
    const writerGens = writers.flatMap((w) => w.gens);
    await this.collect([...allReaders, ...writerGens], 120_000);
    await o.beforeSubscribe?.();
    if (allReaders.length) {
      const sub = await this.call(allReaders, { op: 'subscribe' }, 300_000);
      let failed = 0;
      for (const r of sub.values()) {
        m.ttfs.merge(r.ttfs as HistJson);
        failed += r.failed;
      }
      const subs = readers!.subs.length;
      if (failed > 0.001 * subs) this.fail(`check 4: ${failed} of ${subs} subscribes failed`);
      if (failed) this.note(`${failed} subscribes failed`);
    }
    await o.afterSubscribe?.();

    const dirs = await this.serverCgroups();
    const sampler = new MemSampler(dirs).start();
    this.sampler = sampler;
    const start = nowMs() + 1000;
    const winStart = start + this.cfg.warmupMs;
    const windowMs = o.windowMs ?? this.cfg.windowMs;
    const winEnd = winStart + windowMs;
    if (allReaders.length) await this.call(allReaders, { op: 'record', from: winStart });
    for (const w of writers) this.send(w.gens, (g) => ({ op: 'run', start, end: winEnd, rate: w.perProc, phase: (w.gens.indexOf(g) * 1000) / w.rate, winStart, winEnd }));
    const cliGens = o.cli && readers ? readers.normal : [];
    const cliDirs = await Promise.all(cliGens.map((g) => cgroupOf(g.container)));
    const during = o.duringWindow?.({ start, winStart, winEnd });

    await sleep(Math.max(0, winStart - nowMs()));
    const c0 = await this.cpu();
    const n0 = await this.readerNet();
    const p0 = await this.peerNet();
    const cli0 = cliDirs.reduce((a, d) => a + cpuSeconds(d), 0);
    await sleep(Math.max(0, winEnd - nowMs()));
    m.cpu = (await this.cpu()) - c0;
    m.net = (await this.readerNet()) - n0;
    m.peer = (await this.peerNet()) - p0;
    m.cliCpu = cliDirs.reduce((a, d) => a + cpuSeconds(d), 0) - cli0;
    m.memSteady = sampler.median(winStart, winEnd);
    m.memPeak = sampler.max(winStart, winEnd);
    await during;

    const written = await this.collect(writerGens, 120_000);
    const versions = this.dbs.map((d) => d.version0);
    let sent = 0;
    let bad = 0;
    let unknown = 0;
    for (const [id, w] of written) {
      m.ack.merge(w.ack as HistJson);
      sent += w.sent;
      bad += w.rejected + w.unknown + w.pending;
      unknown += w.unknown + w.pending;
      (w.lastAcked as number[]).forEach((v, i) => {
        const db = this.dbs.indexOf(this.dbs.find((d) => d.name === this.#writerDbs(id)[i])!);
        if (db >= 0 && v > versions[db]!) versions[db] = v;
      });
      if (w.maxDelayMs > 0.01 * windowMs) {
        this.behind = true;
        this.note(`writer ${id} fell ${w.maxDelayMs.toFixed(0)} ms behind its schedule`);
      }
      if (Object.keys(w.codes).length) this.note(`writer ${id} errors: ${JSON.stringify(w.codes)}`);
    }
    if (o.checkMutations !== false && bad > 0.001 * sent) this.fail(`check 4: ${bad} of ${sent} mutations failed`);
    if (this.faultFree && unknown) this.fail(`check 5: ${unknown} mutations with outcome unknown in a fault-free scenario`);

    if (cliGens.length) {
      await this.call(cliGens, { op: 'gc' });
      m.cliAnon = cliDirs.reduce((a, d) => a + anonOf(d), 0);
    }
    sampler.stop();
    m.extra.memSamples = sampler.samples.length;
    this.lastAcked = versions;
    if (this.cfg.mode === 'stub') return m;
    if (allReaders.length) {
      const finals = await this.call(allReaders, { op: 'final', versions, timeoutMs: 30_000 }, 120_000);
      this.finals = finals;
      if (o.analyze === false) return m;
      await this.analyze(readers!, finals, { winStart, winEnd, latRange: o.latRange?.({ winStart, winEnd }), latExclude: new Set((o.latExclude ?? []).map((g) => g.id)) }, m, new Set(cliGens.map((g) => g.id)));
    } else {
      m.writes = this.#countWrites(winStart, winEnd);
    }
    return m;
  }

  #writerDbs(genId: string): string[] {
    const params = JSON.parse(fs.readFileSync(`${this.host.workDir}/${genId}.json`, 'utf8')).params;
    return params.dbs;
  }

  #readWrites(): WriteEntry[] {
    const out: WriteEntry[] = [];
    for (const g of this.writerGens) {
      const names = this.#writerDbs(g.id);
      const path = `${this.host.workDir}/${g.id}.writes.ndjson`;
      if (!fs.existsSync(path)) continue;
      for (const line of fs.readFileSync(path, 'utf8').split('\n')) {
        if (!line) continue;
        const [d, sched, sent, settled, version, r, , ops] = JSON.parse(line);
        out.push({ db: this.dbs.findIndex((x) => x.name === names[d]), sched, sent, settled, version, r, ops });
      }
    }
    return out;
  }

  #countWrites(winStart: number, winEnd: number): number {
    return this.#readWrites().filter((w) => w.r === 'a' && w.sched >= winStart && w.sched < winEnd).length;
  }

  // ─────────────────────────────── analysis ───────────────────────────────

  /**
   * Voter replay of every database: affected pairs in the window, `lat` from the callback logs of non-audit subscriptions, R1 at
   * every fully checked audit delivery, and the final results (§14.2 checks 1–3).
   */
  async analyze(readers: ReaderGroup, finals: Map<string, any>, win: { winStart: number; winEnd: number; latRange?: [number, number]; latExclude?: Set<string> }, m: Measured, cliGens: Set<string>): Promise<void> {
    // check 1 and 3 from the readers' own reports
    const finalHash = new Map<number, { hash: string | null; version: number; closed: boolean }>();
    for (const [id, f] of finals) {
      if (f.violations) this.fail(`check 1: ${f.violations} listener calls without a higher version in ${id}: ${f.errorSamples.join('; ')}`);
      if (f.errors) this.fail(`check 1: ${f.errors} subscription errors in ${id}: ${f.errorSamples.join('; ')}`);
      if (f.failCount) this.fail(`check 2: ${f.failCount} audit failures in ${id}: ${f.failures.slice(0, 5).join(' | ')}`);
      if (f.waitFailed.length) this.fail(`check 3: waitForVersion(lastAcked) failed within 30 s in ${id}: ${f.waitFailed.slice(0, 3).join('; ')}`);
      for (const [sid, hash, version, closed] of f.subs) finalHash.set(sid, { hash, version, closed });
      m.extra.finalWaitMs = Math.max(m.extra.finalWaitMs ?? 0, f.waitMs);
    }

    const writes = this.#readWrites();
    const replays = new Map<number, { replay: Replay; sched: Map<number, number>; qOf: Map<number, QState> }>();
    const t0 = nowMs();
    for (const [di, db] of this.dbs.entries()) {
      const subs = readers.subs.filter((s) => s.db === di);
      if (!subs.length) continue;
      const acked = writes.filter((w) => w.db === di && w.r === 'a').sort((a, b) => a.version! - b.version!);
      const preload: Record<string, Iterable<Row>> = {};
      for (const p of db.preload) preload[p.table] = (function* () {
        for (let i = 0; i < p.count; i++) yield p.row(i);
      })();
      const replay = new Replay(this.schema, preload, db.version0);
      const qOf = new Map<number, QState>();
      for (const s of subs) qOf.set(s.id, replay.track(physicalQuery(s.spec, this.V)));
      // audit deliveries of this database, by version
      const deliveries = this.#auditDeliveries(readers, di);
      let di2 = 0;
      const checkAt = (v: number) => {
        const cache = new Map<string, string>();
        while (di2 < deliveries.length && deliveries[di2]!.version <= v) {
          const d = deliveries[di2++]!;
          if (d.version < v) {
            if (d.version < db.version0) this.fail(`check 2: s${d.sub} delivered v${d.version}, before the preloaded version ${db.version0}`);
            continue;
          }
          const q = qOf.get(d.sub)!;
          let h = cache.get(q.key);
          if (h === undefined) cache.set(q.key, (h = replay.hash(q.ir)));
          if (h !== d.hash) this.fail(`check 2 (R1): s${d.sub} delivered a result at v${d.version} that differs from Q(D_v) of ${q.key}`);
        }
      };
      checkAt(replay.version);
      const sched = new Map<number, number>();
      let gap = false;
      for (const w of acked) {
        if (w.version! !== replay.version + 1) {
          if (!gap) this.fail(`replay of ${db.name}: version ${w.version} follows ${replay.version} (a write the runner did not see as acknowledged)`);
          gap = true;
          break;
        }
        sched.set(w.version!, w.sched);
        try {
          replay.apply(w.version!, w.ops);
        } catch (e) {
          this.fail(`replay of ${db.name}: the voter rejects the write acknowledged at v${w.version}: ${(e as Error).message}`);
          gap = true;
          break;
        }
        checkAt(replay.version);
      }
      if (di2 < deliveries.length && !gap) this.fail(`check 2: ${deliveries.length - di2} audit deliveries at versions above the last acknowledged write`);
      if (gap) continue;
      // check 3: final result of every subscription equals the voter's
      const finalOf = new Map<string, string>();
      let mismatched = 0;
      for (const s of subs) {
        const q = qOf.get(s.id)!;
        let h = finalOf.get(q.key);
        if (h === undefined) finalOf.set(q.key, (h = replay.hash(q.ir)));
        const f = finalHash.get(s.id);
        if (!f || f.closed || f.hash !== h) {
          mismatched++;
          if (mismatched <= 3) this.fail(`check 3: s${s.id} final result ${f ? (f.closed ? 'closed' : `at v${f.version}`) : 'missing'} differs from the voter's at v${replay.version} (${q.key})`);
        }
      }
      if (mismatched > 3) this.fail(`check 3: ${mismatched} subscriptions in all end with a result other than the voter's`);
      replays.set(di, { replay, sched, qOf });
    }
    m.extra.replayMs = nowMs() - t0;

    // pairs and lat
    const cb = this.callbacks(readers);
    for (const s of readers.subs) {
      const r = replays.get(s.db);
      if (!r) continue;
      const q = r.qOf.get(s.id)!;
      const log = cb.get(s.id);
      let j = 0;
      for (let i = 0; i < q.changes.length; i++) {
        const v = q.changes[i]!;
        const at = r.sched.get(v)!;
        if (at < win.winStart || at >= win.winEnd) continue;
        m.pairs++;
        if (cliGens.has(s.gen)) m.cliPairs++;
        if (s.audit || win.latExclude?.has(s.gen)) continue;
        while (log && j < log.n && log.v[j]! < v) j++;
        if (!log || j >= log.n) {
          m.missed++;
          continue;
        }
        if (q.mode === 'hash') {
          const prev = i ? q.hashes[i - 1] : q.initialHash;
          let undone = false;
          for (let k = i + 1; k < q.changes.length && q.changes[k]! <= log.v[j]!; k++) if (q.hashes[k] === prev) undone = true;
          if (undone) continue;
        }
        m.lat.add(Math.max(0, log.t[j]! - at));
        if (win.latRange && at >= win.latRange[0] && at < win.latRange[1]) m.latIn.add(Math.max(0, log.t[j]! - at));
      }
    }
    m.cliSubs = readers.subs.filter((s) => cliGens.has(s.gen)).length;
    m.writes = writes.filter((w) => w.r === 'a' && w.sched >= win.winStart && w.sched < win.winEnd).length;
    if (m.missed) this.note(`${m.missed} affected pairs without a later callback (restored before delivery, or never delivered)`);
  }

  #auditDeliveries(readers: ReaderGroup, db: number): { sub: number; version: number; hash: string }[] {
    const out: { sub: number; version: number; hash: string }[] = [];
    for (const g of readers.audit) {
      const path = `${this.host.workDir}/${g.id}.audit.bin`;
      if (!fs.existsSync(path)) continue;
      const buf = fs.readFileSync(path);
      for (let o = 0; o + 40 <= buf.length; o += 40) {
        const sub = buf.readUInt32LE(o);
        if (readers.subs[sub]?.db !== db) continue;
        out.push({ sub, version: buf.readUInt32LE(o + 4), hash: buf.toString('hex', o + 8, o + 40) });
      }
    }
    return out.sort((a, b) => a.version - b.version);
  }

  /** Callback logs grouped by subscription, in call order. */
  callbacks(readers: ReaderGroup): Map<number, { n: number; v: Uint32Array; t: Float64Array }> {
    const out = new Map<number, { n: number; v: Uint32Array; t: Float64Array }>();
    for (const g of readers.normal) {
      const path = `${this.host.workDir}/${g.id}.cb.bin`;
      if (!fs.existsSync(path)) continue;
      const buf = fs.readFileSync(path);
      const n = Math.floor(buf.length / 16);
      const counts = new Map<number, number>();
      for (let k = 0; k < n; k++) {
        const s = buf.readUInt32LE(k * 16);
        counts.set(s, (counts.get(s) ?? 0) + 1);
      }
      for (const [s, c] of counts) out.set(s, { n: 0, v: new Uint32Array(c), t: new Float64Array(c) });
      for (let k = 0; k < n; k++) {
        const e = out.get(buf.readUInt32LE(k * 16))!;
        e.v[e.n] = buf.readUInt32LE(k * 16 + 4);
        e.t[e.n++] = buf.readDoubleLE(k * 16 + 8);
      }
    }
    return out;
  }

  /** Hash of Q(D) for a query at the end of the replay of `db` (spot checks in scenarios without subscriptions). */
  replayFinal(db: Db, irs: QueryIR[]): Map<string, string> {
    const di = this.dbs.indexOf(db);
    const preload: Record<string, Iterable<Row>> = {};
    for (const p of db.preload) preload[p.table] = (function* () {
      for (let i = 0; i < p.count; i++) yield p.row(i);
    })();
    const replay = new Replay(this.schema, preload, db.version0);
    for (const w of this.#readWrites().filter((x) => x.db === di && x.r === 'a').sort((a, b) => a.version! - b.version!)) replay.apply(w.version!, w.ops);
    return new Map(irs.map((ir) => [JSON.stringify(ir), replay.hash(ir)]));
  }
}

// ─────────────────────────────── scenarios ───────────────────────────────

export interface MetricDef {
  key: string;
  /** Weight within the scenario (§14.4). */
  weight: number;
  unit: 'ms' | 'us' | 'B' | 'MB' | 'w/s';
  better: 'lower' | 'higher';
  /** Values are raised to this before ratios (§14.5). */
  floor: number;
}

export interface Scenario {
  id: string;
  title: string;
  pts: number;
  level: 'L1' | 'L2' | 'L3';
  metrics: MetricDef[];
  /** Scores `cpu`: also run with the same writes and no subscriptions (§14.2). */
  control?: boolean;
  /** Scores `cli_*`: also run the readers on the no-op SDK (§14.2). */
  cli?: boolean;
  /** Injects faults: unknown outcomes are expected (§14.2 check 5 does not apply). */
  faults?: boolean;
  run(r: Run): Promise<Measured>;
  /** Scored metric values from the main run and, when the scenario has them, the control and stub runs. */
  values(m: Measured, control: Measured | null, stub: Measured | null): Record<string, number>;
  /** Reported, unscored values. */
  report?(m: Measured): Record<string, number>;
}

export const lower = (key: string, weight: number, unit: MetricDef['unit'], floor: number): MetricDef => ({ key, weight, unit, better: 'lower', floor });
export const MS = (key: string, weight: number, floor = 1) => lower(key, weight, 'ms', floor);
export const MB = 2 ** 20;
/** Server CPU over the window minus the control run's, in microseconds. */
export const cpuUs = (m: Measured, c: Measured | null) => Math.max(0, m.cpu - (c?.cpu ?? 0)) * 1e6;
export const per = (x: number, n: number) => (n > 0 ? x / n : NaN);
