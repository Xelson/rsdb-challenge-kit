/** B1 Broadcast (SPEC §14.4): 5,000 identical channel feeds, 100 inserts/s into that channel. */
import { cpuUs, lower, MS, per, type Scenario } from '../lib/scenario.ts';
import { message } from '../lib/workload.ts';

export default {
  id: 'B1', title: 'Broadcast', pts: 4, level: 'L1', control: true,
  metrics: [MS('lat_p50', 0.15), MS('lat_p99', 0.25), lower('cpu_per_1k_pairs', 0.25, 'us', 1), lower('net_per_pair', 0.35, 'B', 16)],
  async run(r) {
    await r.server('single');
    const db = await r.database('b1');
    await r.preload(db, 'messages', r.n(10_000), (i) => message(i, { channels: 10 }));
    const spec = ['ch', 1, r.V.limit(20, 'B1'), r.V.dir('desc', 'B1')];
    const readers = r.cfg.mode === 'control' ? null
      : await r.readers(Array.from({ length: r.conns(5000) }, () => ({ db, specs: [spec] })), { procs: Math.max(1, Math.round(10 * r.cfg.scale)) });
    const writers = await r.writers([db], r.rate(100), { kind: 'insertMessage', base: 1, channels: 1 });
    return r.standard(readers, [writers]);
  },
  values: (m, c) => ({ lat_p50: m.lat.quantile(0.5), lat_p99: m.lat.quantile(0.99), cpu_per_1k_pairs: per(cpuUs(m, c), m.pairs) * 1000, net_per_pair: per(m.net, m.pairs) }),
} satisfies Scenario;
