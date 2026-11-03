/**
 * B7 Cold reads (SPEC §14.4): B3 data; the server restarts on the preloaded data dir with the host page cache dropped, then 1,000
 * sequential fetches of a team's scores above a threshold and 1,000 sequential subscribe → ready → unsubscribe of count queries.
 */
import type { HistJson } from '../lib/hist.ts';
import { Hist } from '../lib/hist.ts';
import { nowMs } from '../lib/host.ts';
import { emptyMeasured, MS, type Scenario } from '../lib/scenario.ts';
import { MAX_SCORE, physicalQuery, type QSpec } from '../lib/workload.ts';
import { b3Data } from './common.ts';

export default {
  id: 'B7', title: 'Cold reads', pts: 2, level: 'L1',
  metrics: [MS('fetch_p50', 0.25), MS('fetch_p99', 0.25), MS('count_ttfs_p50', 0.25), MS('count_ttfs_p99', 0.25)],
  async run(r) {
    const m = emptyMeasured();
    const [node] = await r.server('single');
    const db = await r.database('b7');
    const t0 = nowMs();
    const { users, teams } = await b3Data(r, db);
    m.extra.preloadRowsPerSec = users / ((nowMs() - t0) / 1000);
    await r.env.terminate(node!);
    await r.host.dropCaches();
    await r.env.restart(node!, 60_000);
    const g = await r.gen('cold', 'reader', { db: db.name, urls: r.urls, variant: r.V.seed });
    await r.collect([g]);
    const n = r.n(1000);
    const rng = r.rng.fork('b7');
    const limit = r.V.limit(50, 'B7');
    const fetches: QSpec[] = Array.from({ length: n }, () => ['teamScore', rng.int(teams), rng.int(MAX_SCORE), limit]);
    const counts: QSpec[] = Array.from({ length: n }, () => ['teamScoreCount', rng.int(teams), rng.int(MAX_SCORE)]);
    const f = (await r.call([g], { op: 'fetch', specs: fetches })).get(g.id);
    const s = (await r.call([g], { op: 'subscribe', specs: counts })).get(g.id);
    m.extra.fetchP50 = Hist.from(f.hist as HistJson).quantile(0.5);
    m.extra.fetchP99 = Hist.from(f.hist as HistJson).quantile(0.99);
    m.ttfs.merge(s.hist as HistJson);
    for (const [what, res, total] of [['fetches', f, n], ['count subscribes', s, n]] as const) {
      if (res.failed > 0.001 * total) r.fail(`check 4: ${res.failed} of ${total} ${what} failed: ${res.errorSamples.join('; ')}`);
    }
    // every result equals the voter's at the preloaded version
    const irs = [...fetches, ...counts].map((q) => physicalQuery(q, r.V));
    const expect = r.replayFinal(db, irs);
    let bad = 0;
    for (const [list, specs] of [[f.results, fetches], [s.results, counts]] as const) {
      for (const [k, version, hash] of list as [number, number, string][]) {
        const key = JSON.stringify(physicalQuery(specs[k]!, r.V));
        if (version !== db.version0 || hash !== expect.get(key)) {
          if (++bad <= 3) r.fail(`R1: ${key} returned ${hash === expect.get(key) ? 'the right result' : 'a wrong result'} at v${version} (database at v${db.version0})`);
        }
      }
    }
    return m;
  },
  values: (m) => ({ fetch_p50: m.extra.fetchP50!, fetch_p99: m.extra.fetchP99!, count_ttfs_p50: m.ttfs.quantile(0.5), count_ttfs_p99: m.ttfs.quantile(0.99) }),
  report: (m) => ({ preload_rows_per_s: m.extra.preloadRowsPerSec! }),
} satisfies Scenario;
