/** B4 Wide result (SPEC §14.4): 200 subscriptions to a 20k-row result, 500 body updates/s. Scores SDK cost (cli_*). */
import { lower, MS, per, type Scenario } from '../lib/scenario.ts';
import { message } from '../lib/workload.ts';

export default {
  id: 'B4', title: 'Wide result', pts: 5, level: 'L1', cli: true,
  metrics: [lower('net_per_pair', 0.45, 'B', 16), lower('cli_cpu_per_pair', 0.3, 'us', 1), MS('lat_p99', 0.1), lower('cli_mem_per_sub', 0.15, 'B', 64)],
  async run(r) {
    await r.server('single');
    const db = await r.database('b4');
    const rows = r.n(20_000);
    await r.preload(db, 'messages', rows, (i) => message(i, { channels: 1, bodyLen: 200 }));
    const readers = await r.readers(Array.from({ length: r.conns(200) }, () => ({ db, specs: [['chAll', 0]] })), { procs: Math.max(1, Math.round(4 * r.cfg.scale)) });
    const writers = await r.writers([db], r.rate(500), { kind: 'updateBody', rows, bodyLen: 200 });
    return r.standard(readers, [writers], { cli: true });
  },
  values: (m, _c, s) => ({
    net_per_pair: per(m.net, m.pairs),
    cli_cpu_per_pair: per(Math.max(0, m.cliCpu - (s?.cliCpu ?? 0)) * 1e6, m.cliPairs),
    lat_p99: m.lat.quantile(0.99),
    cli_mem_per_sub: per(Math.max(0, m.cliAnon - (s?.cliAnon ?? 0)), m.cliSubs),
  }),
} satisfies Scenario;
