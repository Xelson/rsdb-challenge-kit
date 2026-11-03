/**
 * Generator roles (SPEC §14.1, §14.2). A role runs a command loop: it posts the result of its last command and receives the next
 * one from the controller. Roles call only the SDK's public API, and time and schedule only through the guard captured before the
 * SDK loaded.
 *
 * Logs written to /work for the controller's replay:
 * - `<id>.writes.ndjson`: one line per write, `[db, scheduled, sent, settled, version|null, a|r|u, code|null, ops]`;
 * - `<id>.cb.bin`: one 16-byte record per listener call inside the recording window, `u32 subscription, u32 version, f64 time`;
 * - `<id>.audit.bin`: one 40-byte record per fully checked audit delivery, `u32 subscription, u32 version, sha256`.
 */
import fs from 'node:fs';
import type { CountSnapshot, MutationIR, RowsSnapshot } from '@rsdb/client';
import { addOps, build, plainDsl } from '../../conformance/lib/gen.ts';
import { countHash, Observer, rowsHash } from '../../conformance/lib/observe.ts';
import { Rng } from '../../conformance/lib/rng.ts';
import type { CaseCtx } from '../../conformance/lib/suite.ts';
import { canonical } from '../../conformance/voter/voter.ts';
import { Hist } from '../lib/hist.ts';
import { genQuery, opGen, Variant, type OpGenSpec, type QSpec } from '../lib/workload.ts';

export interface Guard {
  now(): bigint;
  nowMs(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(t: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(t: unknown): void;
  gc: (() => void) | null;
  tampered(): string[];
}

export interface Cmd {
  op: string;
  [k: string]: any;
}

export interface GenCtx {
  id: string;
  params: any;
  sdk: any;
  guard: Guard;
  work: string;
  /** Posts the result of the last command and waits for the next one. */
  cmd(result: unknown): Promise<Cmd>;
}

const errInfo = (e: any) => ({ code: String(e?.code ?? 'ERROR'), outcome: e?.outcome as string | undefined, message: String(e?.message ?? e).slice(0, 300) });

class BinLog {
  #fd: number;
  #buf = Buffer.alloc(1 << 16);
  #pos = 0;
  constructor(path: string) {
    this.#fd = fs.openSync(path, 'w');
  }
  rec(sub: number, version: number, t: number): void {
    if (this.#pos + 16 > this.#buf.length) this.flush();
    this.#buf.writeUInt32LE(sub, this.#pos);
    this.#buf.writeUInt32LE(version, this.#pos + 4);
    this.#buf.writeDoubleLE(t, this.#pos + 8);
    this.#pos += 16;
  }
  recHash(sub: number, version: number, hex: string): void {
    if (this.#pos + 40 > this.#buf.length) this.flush();
    this.#buf.writeUInt32LE(sub, this.#pos);
    this.#buf.writeUInt32LE(version, this.#pos + 4);
    this.#buf.write(hex, this.#pos + 8, 32, 'hex');
    this.#pos += 40;
  }
  flush(): void {
    if (this.#pos) fs.writeSync(this.#fd, this.#buf, 0, this.#pos);
    this.#pos = 0;
  }
  close(): void {
    this.flush();
    fs.closeSync(this.#fd);
  }
}

class TextLog {
  #fd: number;
  #parts: string[] = [];
  #size = 0;
  constructor(path: string) {
    this.#fd = fs.openSync(path, 'w');
  }
  line(s: string): void {
    this.#parts.push(s, '\n');
    this.#size += s.length + 1;
    if (this.#size > 1 << 20) this.flush();
  }
  flush(): void {
    if (this.#parts.length) fs.writeSync(this.#fd, this.#parts.join(''));
    this.#parts = [];
    this.#size = 0;
  }
  close(): void {
    this.flush();
    fs.closeSync(this.#fd);
  }
}

/** Waits until every client reports `open` (SDKs that connect lazily are given up on after `ms`). */
async function opened(g: GenCtx, clients: any[], ms = 30_000): Promise<number> {
  const deadline = g.guard.nowMs() + ms;
  for (;;) {
    const pending = clients.filter((c) => c.status !== 'open').length;
    if (pending === 0 || g.guard.nowMs() > deadline) return pending;
    await new Promise<void>((r) => g.guard.setTimeout(r, 20));
  }
}

async function closeAll(g: GenCtx, clients: any[]): Promise<void> {
  await Promise.all(clients.map((c) => Promise.race([c.close().catch(() => {}), new Promise<void>((r) => g.guard.setTimeout(r, 5000))])));
}

function hashOfSnapshot(snap: any, kind: 'rows' | 'count'): string {
  return kind === 'count' ? countHash(snap.count) : rowsHash(`[${snap.rows.map((r: unknown) => canonical(r)).join(',')}]`);
}

/** One write through the SDK: single operations through their own call, several as a batch. */
function send(c: any, ops: readonly MutationIR[]): Promise<{ version: number }> {
  if (ops.length > 1) return c.batch((tx: any) => addOps(tx, ops));
  const op = ops[0]!;
  switch (op.op) {
    case 'insert':
      return c.insert(op.table, op.row);
    case 'upsert':
      return c.upsert(op.table, op.row);
    case 'update':
      return c.update(op.table, op.id, op.set);
    case 'delete':
      return c.delete(op.table, op.id);
    case 'updateWhere':
      return c.updateWhere(op.table, op.where ? plainDsl(op.where) : {}, op.set);
    case 'deleteWhere':
      return c.deleteWhere(op.table, op.where ? plainDsl(op.where) : {});
  }
}

// ─────────────────────────────── writer ───────────────────────────────

export interface WriterParams {
  dbs: string[];
  /** URL list per client; client i of every database uses urls[i % urls.length]. */
  urls: string[][];
  conns: number;
  gen: OpGenSpec;
  seed: string;
  variant: number | null;
  proc: number;
  procs: number;
  /** Prefix of inserted ids, unique per writer process of the run. */
  prefix: string;
}

/** `run` command: writes scheduled open loop at `start + phase + k/rate` until `end` (§14.1 schedule health). */
export interface RunCmd extends Cmd {
  start: number;
  end: number;
  rate: number;
  phase: number;
  winStart: number;
  winEnd: number;
  /** How long to wait for writes still in flight after `end`. */
  settleMs?: number;
}

async function writer(g: GenCtx): Promise<void> {
  const p = g.params as WriterParams;
  const V = new Variant(p.variant);
  const gen = opGen(p.gen, new Rng(p.seed), p.proc, p.procs, p.prefix);
  const clients = p.dbs.map((database) => Array.from({ length: p.conns }, (_, i) => g.sdk.createClient({ url: p.urls[i % p.urls.length], database })));
  const notOpen = await opened(g, clients.flat());
  const log = new TextLog(`${g.work}/${g.id}.writes.ndjson`);
  let k = 0;
  let cmd = await g.cmd({ ready: true, notOpen });
  for (;;) {
    if (cmd.op === 'run') {
      cmd = await g.cmd(await writeRound(g, cmd as RunCmd, p, clients, (sched) => gen.next(k, sched).map((o) => V.op(o)), () => k++, log));
    } else if (cmd.op === 'exit') {
      log.close();
      await closeAll(g, clients.flat());
      cmd = await g.cmd({ exited: true });
      return;
    } else throw new Error(`writer: unknown command ${cmd.op}`);
  }
}

function writeRound(g: GenCtx, cmd: RunCmd, p: WriterParams, clients: any[][], next: (sched: number) => MutationIR[], bump: () => number, log: TextLog) {
  const { guard } = g;
  const interval = 1000 / cmd.rate;
  const t0 = cmd.start + cmd.phase;
  const ack = new Hist();
  const delay = new Hist();
  const lastAcked = p.dbs.map(() => 0);
  const stats = { scheduled: 0, inWindow: 0, sent: 0, acked: 0, rejected: 0, unknown: 0, pending: 0, codes: {} as Record<string, number>, maxDelayMs: 0 };
  const inflight = new Set<Promise<void>>();
  let i = 0;
  return new Promise<unknown>((resolve) => {
    const fire = (sched: number) => {
      const kk = bump();
      const db = kk % p.dbs.length;
      const c = clients[db]![Math.floor(kk / p.dbs.length) % p.conns]!;
      const ops = next(sched);
      const sent = guard.nowMs();
      const inWin = sched >= cmd.winStart && sched < cmd.winEnd;
      stats.sent++;
      if (inWin) {
        stats.inWindow++;
        delay.add(sent - sched);
        stats.maxDelayMs = Math.max(stats.maxDelayMs, sent - sched);
      }
      let pr: Promise<void>;
      try {
        pr = send(c, ops).then(
          (r) => {
            const t = guard.nowMs();
            stats.acked++;
            if (r.version > lastAcked[db]!) lastAcked[db] = r.version;
            if (inWin) ack.add(t - sched);
            log.line(JSON.stringify([db, sched, sent, t, r.version, 'a', null, ops]));
          },
          (e) => {
            const t = guard.nowMs();
            const x = errInfo(e);
            const r = x.outcome === 'not_applied' ? 'r' : 'u';
            if (r === 'r') stats.rejected++;
            else stats.unknown++;
            stats.codes[x.code] = (stats.codes[x.code] ?? 0) + 1;
            log.line(JSON.stringify([db, sched, sent, t, null, r, x.code, ops]));
          },
        );
      } catch (e) {
        const x = errInfo(e);
        stats.unknown++;
        stats.codes[x.code] = (stats.codes[x.code] ?? 0) + 1;
        log.line(JSON.stringify([db, sched, sent, sent, null, 'u', x.code, ops]));
        pr = Promise.resolve();
      }
      inflight.add(pr);
      void pr.finally(() => inflight.delete(pr));
    };
    const finish = async () => {
      const settle = cmd.settleMs ?? 30_000;
      const deadline = guard.nowMs() + settle;
      while (inflight.size && guard.nowMs() < deadline) await new Promise<void>((r) => guard.setTimeout(r, 20));
      stats.pending = inflight.size;
      log.flush();
      resolve({ ...stats, lastAcked, ack: ack.toJSON(), delay: delay.toJSON() });
    };
    const tick = () => {
      const now = guard.nowMs();
      for (;;) {
        const sched = t0 + i * interval;
        if (sched >= cmd.end) return void finish();
        if (sched > now) return void guard.setTimeout(tick, Math.max(0, Math.floor(sched - guard.nowMs())));
        stats.scheduled++;
        fire(sched);
        i++;
      }
    };
    tick();
  });
}

// ─────────────────────────────── reader ───────────────────────────────

export interface ReaderParams {
  dbs: string[];
  conns: { db: number; urls: string[]; subs: [number, QSpec][] }[];
  variant: number | null;
  /** Audit process: every callback checked as in §13.2 within a CPU budget, deliveries logged for the voter (§14.2 check 2). */
  audit: boolean;
  /** Log the minimum syncedVersion of this process's subscriptions over time (B11 recovery). */
  trackSynced?: boolean;
}

interface Live {
  id: number;
  client: any;
  kind: 'rows' | 'count';
  sub: any;
  obs?: Observer;
  last: number;
}

/** Audit check budget: full checks while they used under half of the time since recording started. */
const AUDIT_SHARE = 0.5;

async function reader(g: GenCtx): Promise<void> {
  const p = g.params as ReaderParams;
  const { guard } = g;
  const V = new Variant(p.variant);
  const clients = p.conns.map((c) => g.sdk.createClient({ url: c.urls, database: p.dbs[c.db] }));
  const notOpen = await opened(g, clients);
  const cb = new BinLog(`${g.work}/${g.id}.cb.bin`);
  const audit = p.audit ? new BinLog(`${g.work}/${g.id}.audit.bin`) : null;
  const failures: string[] = [];
  let failCount = 0;
  const fakeT = {
    fail: (m: string) => {
      failCount++;
      if (failures.length < 50) failures.push(m);
    },
    failTime: (m: string) => fakeT.fail(m),
    log: () => {},
  } as unknown as CaseCtx;
  let recordFrom = Infinity;
  let busyMs = 0;
  let calls = 0;
  let violations = 0;
  let errors = 0;
  const errorSamples: string[] = [];
  const live: Live[] = [];
  const synced: [number, number][] = [];
  let syncedTimer: unknown = null;

  const light = () => recordFrom !== Infinity && busyMs > AUDIT_SHARE * (guard.nowMs() - recordFrom);
  const subscribeAll = async (timeoutMs: number) => {
    const ttfs = new Hist();
    let failed = 0;
    const waits: Promise<void>[] = [];
    p.conns.forEach((conn, ci) => {
      for (const [id, spec] of conn.subs) {
        const q = genQuery(spec, V);
        const kind = q.ir.kind;
        const l: Live = { id, client: clients[ci], kind, sub: null, last: -1 };
        let listener: (s: any) => void;
        if (audit) {
          const obs = new Observer(fakeT, {
            label: `s${id}`, query: q.ir, light,
            onDelivery: (d) => {
              if (guard.nowMs() >= recordFrom) audit.recHash(id, d.version, d.hash);
            },
          });
          l.obs = obs;
          listener = (snap) => {
            const t = guard.nowMs();
            calls++;
            obs.listener(snap);
            busyMs += guard.nowMs() - t;
          };
        } else {
          listener = (snap: RowsSnapshot<any> | CountSnapshot) => {
            const t = guard.nowMs();
            const v = snap.version;
            calls++;
            if (!(v > l.last)) {
              violations++;
              if (errorSamples.length < 10) errorSamples.push(`s${id}: version ${v} after ${l.last}`);
            }
            l.last = v;
            if (kind === 'rows') void (snap as RowsSnapshot<any>).rows.length;
            if (t >= recordFrom) cb.rec(id, v, t);
          };
        }
        const t0 = guard.nowMs();
        try {
          const sub = build(clients[ci], q).subscribe(listener);
          l.sub = sub;
          if (l.obs) l.obs.attach(sub);
          sub.onError((e: any) => {
            errors++;
            if (errorSamples.length < 10) errorSamples.push(`s${id}: ${errInfo(e).code} ${errInfo(e).message}`);
          });
          live.push(l);
          waits.push(
            Promise.race([sub.ready, new Promise((_, rej) => guard.setTimeout(() => rej(Object.assign(new Error('ready timed out'), { code: 'TIMEOUT' })), timeoutMs))]).then(
              () => ttfs.add(guard.nowMs() - t0),
              (e) => {
                failed++;
                if (errorSamples.length < 10) errorSamples.push(`s${id} subscribe: ${errInfo(e).code} ${errInfo(e).message}`);
              },
            ),
          );
        } catch (e) {
          failed++;
          if (errorSamples.length < 10) errorSamples.push(`s${id} subscribe threw: ${errInfo(e).message}`);
        }
      }
    });
    await Promise.all(waits);
    return { ttfs: ttfs.toJSON(), failed, subs: live.length };
  };

  let cmd = await g.cmd({ ready: true, notOpen });
  for (;;) {
    let result: unknown = {};
    switch (cmd.op) {
      case 'subscribe':
        result = await subscribeAll(cmd.timeoutMs ?? 30_000);
        if (p.trackSynced) {
          let min = -2;
          syncedTimer = guard.setInterval(() => {
            let m = Infinity;
            for (const l of live) if (!l.sub.closed) m = Math.min(m, l.sub.syncedVersion);
            if (m !== min && m !== Infinity) synced.push([guard.nowMs(), (min = m)]);
          }, 5);
        }
        break;
      case 'record':
        recordFrom = cmd.from;
        break;
      case 'flush':
        cb.flush();
        audit?.flush();
        break;
      case 'gc':
        guard.gc?.();
        guard.gc?.();
        break;
      case 'sync': {
        // time for waitForVersion(version) on every client (B12 pauses, §14.2 `sync`)
        const t0 = guard.nowMs();
        const r = await Promise.allSettled(clients.map((c) => c.waitForVersion(cmd.version, { timeoutMs: cmd.timeoutMs ?? 30_000 })));
        result = { ms: guard.nowMs() - t0, failed: r.filter((x) => x.status === 'rejected').length };
        break;
      }
      case 'final': {
        // callbacks that arrive while catching up still close affected pairs: record until every client is synced
        const versions = cmd.versions as number[];
        const t0 = guard.nowMs();
        const waits = await Promise.allSettled(p.conns.map((c, ci) => clients[ci].waitForVersion(versions[c.db] ?? 0, { timeoutMs: cmd.timeoutMs ?? 30_000 })));
        const waitMs = guard.nowMs() - t0;
        if (syncedTimer !== null) guard.clearInterval(syncedTimer);
        recordFrom = Infinity;
        const waitFailed = waits.map((w, ci) => (w.status === 'rejected' ? `conn ${ci}: ${errInfo(w.reason).code} ${errInfo(w.reason).message}` : null)).filter(Boolean);
        const subs: [number, string | null, number, boolean][] = [];
        for (const l of live) {
          const cur = l.sub.current;
          subs.push([l.id, cur ? hashOfSnapshot(cur, l.kind) : null, cur ? cur.version : -1, l.sub.closed]);
          l.obs?.sample();
        }
        cb.close();
        audit?.close();
        result = { subs, waitFailed, waitMs, calls, violations, errors, errorSamples, failures, failCount, synced };
        break;
      }
      case 'unsubscribe':
        for (const l of live) (l.obs ? l.obs.unsubscribe() : l.sub.unsubscribe());
        break;
      case 'exit':
        await closeAll(g, clients);
        await g.cmd({ exited: true });
        return;
      default:
        throw new Error(`reader: unknown command ${cmd.op}`);
    }
    cmd = await g.cmd(result);
  }
}

// ─────────────────────────────── churn (B6) ───────────────────────────────

export interface ChurnParams {
  db: string;
  urls: string[];
  conns: number;
  variant: number | null;
  /** Subscriptions drawn from these specs. */
  specs: QSpec[];
  audit: boolean;
  seed: string;
}

/** Open-loop subscribes with exponential lifetimes (B6). */
async function churn(g: GenCtx): Promise<void> {
  const p = g.params as ChurnParams;
  const { guard } = g;
  const V = new Variant(p.variant);
  const rng = new Rng(p.seed);
  const clients = Array.from({ length: p.conns }, () => g.sdk.createClient({ url: p.urls, database: p.db }));
  const notOpen = await opened(g, clients);
  const audit = p.audit ? new BinLog(`${g.work}/${g.id}.audit.bin`) : null;
  const failures: string[] = [];
  const fakeT = { fail: (m: string) => failures.length < 50 && failures.push(m), failTime: (m: string) => failures.length < 50 && failures.push(m), log: () => {} } as unknown as CaseCtx;
  const open = new Set<any>();
  const errorSamples: string[] = [];
  let violations = 0;
  let cmd = await g.cmd({ ready: true, notOpen });
  for (;;) {
    let result: unknown = {};
    if (cmd.op === 'run') {
      const ttfs = new Hist();
      const stats = { subscribes: 0, failed: 0, inWindow: 0, maxDelayMs: 0 };
      const interval = 1000 / cmd.rate;
      const t0 = cmd.start + cmd.phase;
      const pending = new Set<Promise<unknown>>();
      let i = 0;
      await new Promise<void>((resolve) => {
        const one = (sched: number) => {
          const si = rng.int(p.specs.length);
          const q = genQuery(p.specs[si]!, V);
          const c = clients[i % clients.length];
          const life = -Math.log(1 - rng.next()) * cmd.meanLifeMs;
          const inWin = sched >= cmd.winStart && sched < cmd.winEnd;
          let last = -1;
          const obs = audit ? new Observer(fakeT, { label: `c${g.id}:${i}`, query: q.ir, onDelivery: (d) => audit.recHash(si, d.version, d.hash) }) : null;
          const t = guard.nowMs();
          if (inWin) stats.maxDelayMs = Math.max(stats.maxDelayMs, t - sched);
          let sub: any;
          try {
            sub = build(c, q).subscribe(obs ? obs.listener : (s: any) => {
              if (!(s.version > last)) violations++;
              last = s.version;
            });
          } catch (e) {
            stats.failed++;
            if (errorSamples.length < 10) errorSamples.push(errInfo(e).message);
            return;
          }
          obs?.attach(sub);
          stats.subscribes++;
          if (inWin) stats.inWindow++;
          open.add(sub);
          // the lifetime starts at the first snapshot, so no subscription is dropped before it is ready
          const end = () => guard.setTimeout(() => {
            if (open.delete(sub)) (obs ? obs.unsubscribe() : sub.unsubscribe());
          }, life);
          const pr = sub.ready.then(
            () => {
              if (inWin) ttfs.add(guard.nowMs() - t);
              end();
            },
            (e: any) => {
              stats.failed++;
              if (errorSamples.length < 10) errorSamples.push(`${errInfo(e).code} ${errInfo(e).message}`);
              end();
            },
          );
          pending.add(pr);
          void pr.finally(() => pending.delete(pr));
        };
        const tick = () => {
          const now = guard.nowMs();
          for (;;) {
            const sched = t0 + i * interval;
            if (sched >= cmd.end) return resolve();
            if (sched > now) return void guard.setTimeout(tick, Math.max(0, Math.floor(sched - guard.nowMs())));
            one(sched);
            i++;
          }
        };
        tick();
      });
      await Promise.race([Promise.allSettled([...pending]), new Promise<void>((r) => guard.setTimeout(() => r(), 30_000))]);
      result = { ...stats, ttfs: ttfs.toJSON(), open: open.size, errorSamples };
    } else if (cmd.op === 'unsubscribe') {
      for (const s of open) s.unsubscribe();
      open.clear();
      audit?.close();
      result = { violations, errorSamples, failures };
    } else if (cmd.op === 'exit') {
      await closeAll(g, clients);
      await g.cmd({ exited: true });
      return;
    } else throw new Error(`churn: unknown command ${cmd.op}`);
    cmd = await g.cmd(result);
  }
}

// ─────────────────────────────── cold reads (B7) ───────────────────────────────

export interface ColdParams {
  db: string;
  urls: string[];
  variant: number | null;
}

/** Sequential fetches and sequential subscribe → ready → unsubscribe (B7). Every result is logged for the voter. */
async function cold(g: GenCtx): Promise<void> {
  const p = g.params as ColdParams;
  const { guard } = g;
  const V = new Variant(p.variant);
  const client = g.sdk.createClient({ url: p.urls, database: p.db });
  const notOpen = await opened(g, [client]);
  let cmd = await g.cmd({ ready: true, notOpen });
  for (;;) {
    let result: unknown = {};
    if (cmd.op === 'fetch' || cmd.op === 'subscribe') {
      const hist = new Hist();
      const results: [number, number, string][] = [];
      const errorSamples: string[] = [];
      let failed = 0;
      for (const [k, spec] of (cmd.specs as QSpec[]).entries()) {
        const q = genQuery(spec, V);
        const t0 = guard.nowMs();
        try {
          if (cmd.op === 'fetch') {
            const r = await build(client, q).fetch({ minVersion: 0 });
            hist.add(guard.nowMs() - t0);
            results.push([k, r.version, hashOfSnapshot(r, q.ir.kind)]);
          } else {
            const sub = build(client, q).subscribe(() => {});
            const snap = await sub.ready;
            hist.add(guard.nowMs() - t0);
            results.push([k, snap.version, hashOfSnapshot(snap, q.ir.kind)]);
            sub.unsubscribe();
          }
        } catch (e) {
          failed++;
          if (errorSamples.length < 10) errorSamples.push(`${errInfo(e).code} ${errInfo(e).message}`);
        }
      }
      result = { hist: hist.toJSON(), results, failed, errorSamples };
    } else if (cmd.op === 'exit') {
      await closeAll(g, [client]);
      await g.cmd({ exited: true });
      return;
    } else throw new Error(`cold: unknown command ${cmd.op}`);
    cmd = await g.cmd(result);
  }
}

export const ROLES: Record<string, (g: GenCtx) => Promise<void>> = { writer, reader, churn, cold };
