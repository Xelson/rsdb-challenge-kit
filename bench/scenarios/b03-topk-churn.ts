/** B3 Top-K churn (SPEC §14.4): each team's top 10 subscribed twice, 5,000 random score updates/s. */
import { cpuUs, lower, MS, per, type Scenario } from '../lib/scenario.ts';
import { b3Data, connsOf } from './common.ts';

export default {
  id: 'B3', title: 'Top-K churn', pts: 5, level: 'L1', control: true,
  metrics: [MS('lat_p50', 0.1), MS('lat_p99', 0.2), lower('cpu_per_write', 0.3, 'us', 1), lower('net_per_pair', 0.4, 'B', 16)],
  async run(r) {
    await r.server('single');
    const db = await r.database('b3');
    const { users, teams } = await b3Data(r, db);
    const limit = r.V.limit(10, 'B3');
    const dir = r.V.dir('desc', 'B3');
    const specs = Array.from({ length: Math.min(2 * teams, r.conns(200) * 10) }, (_, k) => ['team', k % teams, limit, dir]);
    const readers = r.cfg.mode === 'control' ? null : await r.readers(connsOf(specs, 10).map((s) => ({ db, specs: s })));
    const writers = await r.writers([db], r.rate(5000), { kind: 'updateScore', users });
    return r.standard(readers, [writers]);
  },
  values: (m, c) => ({ lat_p50: m.lat.quantile(0.5), lat_p99: m.lat.quantile(0.99), cpu_per_write: per(cpuUs(m, c), m.writes), net_per_pair: per(m.net, m.pairs) }),
} satisfies Scenario;
