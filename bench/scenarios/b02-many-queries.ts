/** B2 Many queries (SPEC §14.4): 100k distinct channel feeds over 1M messages, 2,000 inserts/s into random channels. */
import { cpuUs, lower, MS, per, type Scenario } from '../lib/scenario.ts';
import { message } from '../lib/workload.ts';
import { connsOf } from './common.ts';

export default {
  id: 'B2', title: 'Many queries', pts: 6, level: 'L1', control: true,
  metrics: [lower('mem_per_sub', 0.3, 'B', 64), MS('lat_p50', 0.1), MS('lat_p99', 0.15), lower('cpu_per_write', 0.3, 'us', 1), lower('net_per_pair', 0.15, 'B', 16)],
  async run(r) {
    await r.server('single');
    const db = await r.database('b2');
    const channels = r.n(100_000);
    await r.preload(db, 'messages', r.n(1_000_000), (i) => message(i, { channels }));
    const limit = r.V.limit(10, 'B2');
    const dir = r.V.dir('desc', 'B2');
    const subs = Math.min(channels, r.conns(1000) * 100);
    const specs = Array.from({ length: subs }, (_, k) => ['ch', k, limit, dir]);
    const readers = r.cfg.mode === 'control' ? null
      : await r.readers(connsOf(specs, 100).map((s) => ({ db, specs: s })), { procs: Math.max(1, Math.round(4 * r.cfg.scale)) });
    const writers = await r.writers([db], r.rate(2000), { kind: 'insertMessage', base: 0, channels });
    let connected = NaN;
    let idle = NaN;
    const m = await r.standard(readers, [writers], {
      beforeSubscribe: async () => {
        connected = await r.memNow();
      },
      afterSubscribe: async () => {
        await new Promise((res) => setTimeout(res, 10_000));
        idle = await r.memNow();
      },
    });
    m.extra.memPerSub = per(idle - connected, subs);
    m.extra.subs = subs;
    return m;
  },
  values: (m, c) => ({
    mem_per_sub: m.extra.memPerSub!, lat_p50: m.lat.quantile(0.5), lat_p99: m.lat.quantile(0.99),
    cpu_per_write: per(cpuUs(m, c), m.writes), net_per_pair: per(m.net, m.pairs),
  }),
} satisfies Scenario;
