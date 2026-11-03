/**
 * B8 Footprint (SPEC §14.4): (a) 20,000 clients with one count subscription each on a table nobody writes: memory per connection;
 * (b) 1,000 databases of 1k messages with two subscribed clients each and one insert/s per database.
 */
import { exec } from '../lib/host.ts';
import { cpuUs, emptyMeasured, lower, MB, MS, per, type Db, type Scenario } from '../lib/scenario.ts';
import { message } from '../lib/workload.ts';

export default {
  id: 'B8', title: 'Footprint', pts: 6, level: 'L1', control: true,
  metrics: [lower('mem_per_conn', 0.3, 'B', 64), lower('mem_steady_b', 0.4, 'MB', 16), MS('lat_p99', 0.2), lower('cpu_per_write', 0.1, 'us', 1)],
  async run(r) {
    let memPerConn = NaN;
    if (r.cfg.mode !== 'control') {
      // (a)
      const [node] = await r.server('single');
      const db = await r.database('b8a');
      const conns = r.conns(20_000);
      const before = await r.memNow();
      const readers = await r.readers(Array.from({ length: conns }, () => ({ db, specs: [['quiet']] })));
      const all = [...readers.normal, ...readers.audit];
      await r.collect(all, 300_000);
      const sub = await r.call(all, { op: 'subscribe', timeoutMs: 120_000 }, 600_000);
      const failed = [...sub.values()].reduce((a, x) => a + x.failed, 0);
      if (failed > 0.001 * conns) r.fail(`check 4: ${failed} of ${conns} subscribes failed`);
      const after = await r.memNow(2000);
      memPerConn = per(after - before, conns);
      const ss = await exec(node!.container, "ss -Htn state established '( sport = :7700 )' | wc -l");
      const established = Number(ss.trim());
      if (!(established >= conns)) r.fail(`(a) gate: ss shows ${established} established client connections, expected ${conns}`);
      r.lastAcked = [db.version0];
      r.finals = await r.call(all, { op: 'final', versions: [db.version0], timeoutMs: 30_000 }, 300_000);
      await r.analyze(readers, r.finals, { winStart: 0, winEnd: 0 }, emptyMeasured(), new Set());
      await r.fresh();
    }
    // (b)
    await r.server('single');
    const n = r.n(1000);
    const rows = r.n(1000);
    const dbs: Db[] = [];
    for (let i = 0; i < n; i++) dbs.push(await r.database(`b8b${i}`));
    for (let i = 0; i < n; i += 8) await Promise.all(dbs.slice(i, i + 8).map((db) => r.preload(db, 'messages', rows, (k) => message(k, { channels: 1 }))));
    const limit = r.V.limit(10, 'B8');
    const dir = r.V.dir('desc', 'B8');
    const readers = r.cfg.mode === 'control' ? null : await r.readers(dbs.flatMap((db) => [{ db, specs: [['ch', 0, limit, dir]] }, { db, specs: [['ch', 0, limit, dir]] }]));
    const writers = await r.writers(dbs, n * r.rate(1), { kind: 'insertMessage', base: 0, channels: 1 }, { conns: 1 });
    const m = await r.standard(readers, [writers]);
    m.extra.memPerConn = memPerConn;
    return m;
  },
  values: (m, c) => ({ mem_per_conn: m.extra.memPerConn!, mem_steady_b: m.memSteady / MB, lat_p99: m.lat.quantile(0.99), cpu_per_write: per(cpuUs(m, c), m.writes) }),
} satisfies Scenario;
