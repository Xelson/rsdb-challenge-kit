/** B13 Mixed queries (SPEC §14.4): 200 × 25 subscriptions from the mixed family, 2,000 writes/s of updates, inserts and deletes. */
import { cpuUs, lower, MS, per, type Scenario } from '../lib/scenario.ts';
import { b3Data, connsOf } from './common.ts';

export default {
  id: 'B13', title: 'Mixed queries', pts: 4, level: 'L1', control: true,
  metrics: [MS('lat_p50', 0.1), MS('lat_p99', 0.25), lower('cpu_per_write', 0.35, 'us', 1), lower('net_per_pair', 0.3, 'B', 16)],
  async run(r) {
    await r.server('single');
    const db = await r.database('b13');
    const { users, teams } = await b3Data(r, db);
    const variant = r.V.seed ?? 0;
    const specs = Array.from({ length: r.conns(200) * 25 }, (_, k) => ['b13', variant * 1_000_000 + k, users, teams]);
    const readers = r.cfg.mode === 'control' ? null : await r.readers(connsOf(specs, 25).map((s) => ({ db, specs: s })), { procs: Math.max(1, Math.round(2 * r.cfg.scale)) });
    const writers = await r.writers([db], r.rate(2000), { kind: 'mixed', users, teams });
    return r.standard(readers, [writers]);
  },
  values: (m, c) => ({ lat_p50: m.lat.quantile(0.5), lat_p99: m.lat.quantile(0.99), cpu_per_write: per(cpuUs(m, c), m.writes), net_per_pair: per(m.net, m.pairs) }),
} satisfies Scenario;
