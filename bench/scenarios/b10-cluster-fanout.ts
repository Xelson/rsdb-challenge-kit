/** B10 Cluster fan-out (SPEC §14.4): L2, 100 × 100 subscriptions per node, 1,000 inserts/s through writers on all nodes. */
import { lower, MB, MS, per, type Scenario } from '../lib/scenario.ts';
import { message } from '../lib/workload.ts';
import { connsOf } from './common.ts';

export default {
  id: 'B10', title: 'Cluster fan-out', pts: 5, level: 'L2',
  metrics: [MS('lat_p50', 0.1, 5), MS('lat_p99', 0.2, 5), lower('peer_per_write', 0.4, 'B', 16), lower('mem_total', 0.3, 'MB', 16)],
  async run(r) {
    const nodes = await r.server('cluster');
    const db = await r.database('b10');
    const channels = r.n(30_000);
    await r.preload(db, 'messages', r.n(300_000), (i) => message(i, { channels }));
    const limit = r.V.limit(10, 'B10');
    const dir = r.V.dir('desc', 'B10');
    const perNode = r.conns(100) * 100;
    const conns = nodes.flatMap((n, i) => {
      const urls = [n.url, ...r.urls.filter((u) => u !== n.url)];
      const specs = Array.from({ length: perNode }, (_, k) => ['ch', (i * perNode + k) % channels, limit, dir]);
      return connsOf(specs, 100).map((s) => ({ db, urls, specs: s }));
    });
    const readers = await r.readers(conns, { procs: nodes.length });
    const writers = await r.writers([db], r.rate(1000), { kind: 'insertMessage', base: 0, channels }, { conns: 6 });
    return r.standard(readers, [writers]);
  },
  values: (m) => ({ lat_p50: m.lat.quantile(0.5), lat_p99: m.lat.quantile(0.99), peer_per_write: per(m.peer, m.writes), mem_total: m.memSteady / MB }),
} satisfies Scenario;
