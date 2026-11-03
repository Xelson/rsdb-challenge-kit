/**
 * B12 Max throughput (SPEC §14.4): open-loop single-row inserts over 1,000 channels with one subscription each and 64 writer
 * connections, from 1,000 writes/s, ×1.5 every 15 s until a step fails, then three 15 s bisection steps between the last passing
 * and the failing rate. After a failing step writes pause until `sync` < 1 s (at most 30 s). Score: the highest passing rate.
 *
 * A step passes if lat p99 ≤ 250 ms, ack p99 ≤ 250 ms, errors ≤ 0.1 %, no unknown outcome and writers on schedule. Every insert
 * lands on top of its channel's feed, so each write is exactly one affected pair: the sub of its channel.
 */
import { Hist, type HistJson } from '../lib/hist.ts';
import { nowMs } from '../lib/host.ts';
import { emptyMeasured, type Scenario } from '../lib/scenario.ts';
import { message } from '../lib/workload.ts';
import { connsOf } from './common.ts';

const STEP_MS = 15_000;
const LIMIT_MS = 250;
/** Writer processes at full scale (each sends at most 1,000 writes/s, §14.1): the highest rate the runner can offer. */
const WRITER_PROCS = 24;

export default {
  id: 'B12', title: 'Max throughput', pts: 3, level: 'L1', faults: true,
  metrics: [{ key: 'max_rate', weight: 1, unit: 'w/s', better: 'higher', floor: 0 }],
  async run(r) {
    const m = emptyMeasured();
    await r.server('single');
    const db = await r.database('b12');
    const channels = r.n(1000);
    await r.preload(db, 'messages', channels * 10, (i) => message(i, { channels }));
    const limit = r.V.limit(10, 'B12');
    const dir = r.V.dir('desc', 'B12');
    const specs = Array.from({ length: channels }, (_, k) => ['ch', k, limit, dir]);
    const readers = await r.readers(connsOf(specs, 10).map((s) => ({ db, specs: s })));
    // audit processes keep no callback log: their channels' writes are not timed
    const subOf = new Map(readers.subs.filter((s) => !s.audit).map((s) => [s.spec[1] as number, s.id]));
    const procs = Math.max(2, Math.round(WRITER_PROCS * r.cfg.scale));
    const capacity = procs * 1000;
    const writers = await r.writers([db], capacity, { kind: 'insertMessage', base: 0, channels }, { conns: 64 });
    const all = [...readers.normal, ...readers.audit];
    await r.collect([...all, ...writers.gens], 120_000);
    const sub = await r.call(all, { op: 'subscribe' }, 300_000);
    const failedSubs = [...sub.values()].reduce((a, x) => a + x.failed, 0);
    if (failedSubs > 0.001 * channels) r.fail(`check 4: ${failedSubs} of ${channels} subscribes failed`);
    const first = nowMs();
    await r.call(all, { op: 'record', from: first });
    const channelCol = r.V.col('messages', 'channel');
    let maxAcked = db.version0;
    let lastPassEnd = first;

    const step = async (rate: number): Promise<boolean> => {
      const start = nowMs() + 500;
      const end = start + STEP_MS;
      const res = await r.call(writers.gens, (g) => ({ op: 'run', start, end, rate: rate / procs, phase: (writers.gens.indexOf(g) * 1000) / rate, winStart: start, winEnd: end, settleMs: 5000 }), 120_000);
      await r.call(readers.normal, { op: 'flush' });
      const ack = new Hist();
      let sent = 0;
      let bad = 0;
      let unknown = 0;
      let behind = 0;
      for (const w of res.values()) {
        ack.merge(w.ack as HistJson);
        sent += w.sent;
        bad += w.rejected + w.unknown + w.pending;
        unknown += w.unknown + w.pending;
        behind = Math.max(behind, w.maxDelayMs);
        for (const v of w.lastAcked as number[]) maxAcked = Math.max(maxAcked, v);
      }
      const cb = r.callbacks(readers);
      const lat = new Hist();
      let missing = 0;
      for (const w of r.writes()) {
        if (w.r !== 'a' || w.sched < start || w.sched >= end) continue;
        const sid = subOf.get(w.ops[0].row[channelCol]);
        if (sid === undefined) continue;
        const log = cb.get(sid);
        let j = 0;
        while (log && j < log.n && log.v[j]! < w.version!) j++;
        if (!log || j >= log.n) missing++;
        else lat.add(Math.max(0, log.t[j]! - w.sched));
      }
      const latP99 = missing > 0.01 * sent ? Infinity : lat.quantile(0.99);
      const pass = latP99 <= LIMIT_MS && ack.quantile(0.99) <= LIMIT_MS && bad <= 0.001 * sent && unknown === 0 && behind <= 0.01 * STEP_MS;
      r.note(`${rate.toFixed(0)} w/s: ${pass ? 'pass' : 'FAIL'} (lat p99 ${latP99.toFixed(1)} ms, ack p99 ${ack.quantile(0.99).toFixed(1)} ms, errors ${bad}/${sent}, unknown ${unknown}, behind ${behind.toFixed(0)} ms${missing ? `, ${missing} undelivered` : ''})`);
      if (pass) {
        lastPassEnd = end;
        m.lat.merge(lat);
        m.ack.merge(ack);
      } else {
        // pause until sync < 1 s, at most 30 s
        const t0 = nowMs();
        while (nowMs() - t0 < 30_000) {
          const s = await r.call(readers.normal, { op: 'sync', version: maxAcked, timeoutMs: 30_000 }, 60_000);
          if (Math.max(...[...s.values()].map((x) => x.ms)) < 1000) break;
        }
      }
      return pass;
    };

    let rate = r.rate(1000);
    let lo = 0;
    let hi = NaN;
    for (;;) {
      if (rate > capacity) {
        r.note(`the runner's ${procs} writer processes offer at most ${capacity} w/s; stopping there`);
        break;
      }
      if (!(await step(rate))) {
        hi = rate;
        break;
      }
      lo = rate;
      rate *= 1.5;
    }
    if (!Number.isNaN(hi)) {
      for (let k = 0; k < 3; k++) {
        const mid = (lo + hi) / 2;
        if (await step(mid)) lo = mid;
        else hi = mid;
      }
    }
    m.extra.maxRate = lo;
    // validation covers the steps up to the last passing one: final results by readback (later steps may leave unknown outcomes)
    r.lastAcked = [maxAcked];
    r.finals = await r.call(all, { op: 'final', versions: [maxAcked], timeoutMs: 30_000 }, 120_000);
    await r.finalByReadback(readers, db);
    void lastPassEnd;
    return m;
  },
  values: (m) => ({ max_rate: m.extra.maxRate! }),
  report: (m) => ({ lat_p99_passing: m.lat.quantile(0.99), ack_p99_passing: m.ack.quantile(0.99) }),
} satisfies Scenario;
