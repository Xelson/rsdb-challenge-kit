/** B5 Bulk update (SPEC §14.4): 2/s updateWhere over 10 teams (10k rows each) plus 500 single updates/s, 1,000 team top-10s. */
import { lower, MB, MS, per, type Scenario } from '../lib/scenario.ts';
import { b3Data, connsOf } from './common.ts';

export default {
  id: 'B5', title: 'Bulk update', pts: 3, level: 'L1',
  metrics: [MS('ack_p99', 0.2), MS('lat_p99', 0.3), lower('mem_peak', 0.3, 'MB', 16), lower('net_per_pair', 0.2, 'B', 16)],
  async run(r) {
    await r.server('single');
    const db = await r.database('b5');
    const { users, teams } = await b3Data(r, db);
    const limit = r.V.limit(10, 'B5');
    const dir = r.V.dir('desc', 'B5');
    const specs = Array.from({ length: Math.min(teams, r.conns(100) * 10) }, (_, k) => ['team', k, limit, dir]);
    const readers = await r.readers(connsOf(specs, 10).map((s) => ({ db, specs: s })));
    const bulk = await r.writers([db], r.rate(2), { kind: 'bulkInc', teams, teamsPerWrite: Math.min(10, teams) }, { conns: 1 });
    const singles = await r.writers([db], r.rate(500), { kind: 'updateScore', users });
    return r.standard(readers, [bulk, singles]);
  },
  values: (m) => ({ ack_p99: m.ack.quantile(0.99), lat_p99: m.lat.quantile(0.99), mem_peak: m.memPeak / MB, net_per_pair: per(m.net, m.pairs) }),
} satisfies Scenario;
