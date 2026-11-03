/**
 * D2 Cross-node consistency (SPEC §13.5, §11.1): T4-style load on a 3-node cluster, writers spread over all nodes (writes to
 * followers are forwarded), every subscription mirrored on a reader of each node. Deliveries at the same version must be equal
 * across nodes (R8), every recorded delivery is replayed on the voter (R1), and the full state read back from each node at every
 * quiescence point must be identical.
 */
import { FUZZ_SCHEMA } from '../lib/gen.ts';
import { Workload } from '../lib/load.ts';
import { appliedEqual, leaderOf } from '../lib/cluster.ts';
import type { CaseCtx, Scale, Suite } from '../lib/suite.ts';

const SCALE = {
  public: { writers: 3, batches: 1500, quiesceEvery: 500, readers: 6, subs: 30, recorded: 10, maxRowsPerWriter: 400, initialRows: 300 },
  full: { writers: 6, batches: 10_000, quiesceEvery: 1000, readers: 12, subs: 100, recorded: 20, maxRowsPerWriter: 1500, initialRows: 1000 },
} as const;

async function runSeed(t: CaseCtx, scale: Scale): Promise<void> {
  const { nodes } = await t.env('cluster');
  const db = await t.database(nodes[0]!.url, FUZZ_SCHEMA, 'd2');
  const leader = await leaderOf(t, nodes, db.name);
  t.log(`leader ${leader}`);
  const w = new Workload(t, {
    ...SCALE[scale],
    db: db.name,
    pushVersion: db.version,
    adminUrl: nodes[0]!.url,
    adminUrls: nodes.map((n) => n.url),
    url: (_role, i) => nodes[i % 3]!.url,
    mirrors: 3,
    checkpointUrls: nodes.map((n) => n.url),
    faultFree: true,
  });
  await w.setup();
  await w.run();
  const { vFinal } = await w.finish();
  await appliedEqual(t, nodes, db.name, vFinal, 30_000, 'after the load');
}

const suite: Suite = {
  id: 'D2',
  level: 'L2',
  weight: 2,
  needsSdk: true,
  publicSeeds: [1],
  cases: (seeds, scale) => seeds.map((seed) => ({ name: `seed ${seed}`, seed, fresh: true, run: (t: CaseCtx) => runSeed(t, scale) })),
};
export default suite;
