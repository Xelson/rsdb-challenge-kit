/**
 * B11 Failover (SPEC §14.4): L3, 3,000 subscriptions over all nodes, 200 writes/s (inserts and $inc on 10 counters); five times,
 * every 40 s, the current leader is SIGKILLed and restarted 20 s later. Write unavailability and subscription recovery per kill.
 */
import type { NodeHandle } from '../../conformance/lib/env.ts';
import { nowMs, sleep } from '../lib/host.ts';
import { MS, type Scenario } from '../lib/scenario.ts';
import { counter, COUNTERS, message } from '../lib/workload.ts';
import { connsOf } from './common.ts';

const KILLS = 5;
const EVERY_MS = 40_000;
const DOWN_MS = 20_000;
const EXEMPT_MS = 15_000;

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) / 2)] ?? NaN;

export default {
  id: 'B11', title: 'Failover', pts: 3, level: 'L3', faults: true,
  metrics: [MS('unavailability', 0.5), MS('recovery', 0.5)],
  async run(r) {
    const nodes = await r.server('cluster');
    const db = await r.database('b11');
    const channels = r.n(1000);
    await r.preload(db, 'messages', channels * 10, (i) => message(i, { channels }));
    await r.preload(db, 'counters', COUNTERS, counter);
    const limit = r.V.limit(10, 'B11');
    const dir = r.V.dir('desc', 'B11');
    const subs = r.conns(120) * 25;
    const specs = Array.from({ length: subs }, (_, k) => (k % 3 === 2 ? ['counters'] : ['ch', k % channels, limit, dir]));
    const conns = connsOf(specs, 25).map((s, i) => ({ db, specs: s, urls: [...r.urls.slice(i % 3), ...r.urls.slice(0, i % 3)] }));
    const readers = await r.readers(conns, { procs: 3, trackSynced: true });
    const writers = await r.writers([db], r.rate(200), { kind: 'insertOrInc', channels });
    const kills: { t: number; node: NodeHandle }[] = [];
    const restarts: Promise<void>[] = [];
    const m = await r.standard(readers, [writers], {
      windowMs: KILLS * EVERY_MS,
      analyze: false,
      checkMutations: false,
      duringWindow: async ({ winStart }) => {
        for (let k = 0; k < KILLS; k++) {
          await sleep(winStart + 10_000 + k * EVERY_MS - nowMs());
          const node = await r.leader(db);
          await r.env.kill(node);
          kills.push({ t: nowMs(), node });
          restarts.push(sleep(DOWN_MS).then(() => r.env.restart(node, 30_000)));
        }
        await Promise.all(restarts);
      },
    });
    const writes = r.writes();
    const acked = writes.filter((w) => w.r === 'a').sort((a, b) => a.settled - b.settled);
    // F1 checks: every version acknowledged once; acknowledged writes present, rejected ones absent
    const seen = new Set<number>();
    for (const w of acked) {
      if (seen.has(w.version!)) r.fail(`F1: version ${w.version} acknowledged twice`);
      seen.add(w.version!);
    }
    // Check 4's exemption also covers the second before each kill: a write sent then may still be in flight to the killed leader and
    // end UNKNOWN through no fault of the submission.
    const exempt = (w: { sched: number }) => kills.some((k) => w.sched >= k.t - 1000 && w.sched < k.t + EXEMPT_MS);
    const counted = writes.filter((w) => !exempt(w));
    const failed = counted.filter((w) => w.r !== 'a').length;
    if (failed > 0.001 * counted.length) r.fail(`check 4: ${failed} of ${counted.length} mutations failed outside the ${EXEMPT_MS / 1000} s after each kill`);
    const unavail: number[] = [];
    const recovery: number[] = [];
    const finals = [...r.finals.values()];
    for (const k of kills) {
      const before = acked.filter((w) => w.settled < k.t).at(-1);
      const after = acked.find((w) => w.settled > k.t && w.sent >= k.t);
      if (!before || !after) {
        r.fail(`no acknowledged write around the kill at +${((k.t - kills[0]!.t) / 1000).toFixed(0)} s`);
        continue;
      }
      unavail.push(after.settled - before.settled);
      if (after.settled - before.settled > 10_000) r.fail(`gate: writes unavailable for ${((after.settled - before.settled) / 1000).toFixed(1)} s after a kill (limit 10 s)`);
      let done = k.t;
      for (const f of finals) {
        const at = (f.synced as [number, number][]).find(([t, v]) => t >= k.t && v >= after.version!)?.[0];
        if (at === undefined) {
          done = NaN;
          break;
        }
        done = Math.max(done, at);
      }
      recovery.push(done - k.t);
    }
    m.extra.unavailabilityMs = median(unavail);
    m.extra.recoveryMs = median(recovery);
    m.extra.kills = kills.length;
    const state = await r.finalByReadback(readers, db);
    const table = r.V.table('messages');
    const ids = new Set((state.tables[table] ?? []).map((x) => x.id));
    for (const w of writes) {
      const op = w.ops[0];
      if (op.op !== 'insert') continue;
      if (w.r === 'a' && !ids.has(op.row.id)) r.fail(`F1: acknowledged insert ${op.row.id} (v${w.version}) is missing after the kills`);
      if (w.r === 'r' && ids.has(op.row.id)) r.fail(`F1: rejected insert ${op.row.id} is present`);
    }
    const valueCol = r.V.col('counters', 'value');
    for (const row of state.tables[r.V.table('counters')] ?? []) {
      const incs = writes.filter((w) => w.ops[0].op === 'update' && w.ops[0].id === row.id);
      const lo = incs.filter((w) => w.r === 'a').length;
      const hi = lo + incs.filter((w) => w.r === 'u').length;
      const v = row[valueCol] as number;
      if (v < lo || v > hi) r.fail(`F1: counter ${row.id} is ${v}, expected ${lo}..${hi} from acknowledged and unknown $inc`);
    }
    return m;
  },
  values: (m) => ({ unavailability: m.extra.unavailabilityMs!, recovery: m.extra.recoveryMs! }),
} satisfies Scenario;
