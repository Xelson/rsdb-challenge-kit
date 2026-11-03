/**
 * T4 Reactive fuzz (SPEC §13.5): writer clients send random batches of every kind plus bank transfers, readers hold row and count
 * subscriptions with churn; §13.2 checks on every callback, quiescence points every 1,000 batches, R1 by voter replay. A second
 * database with live subscriptions must see no callback and no version change (R12).
 */
import { dbInfo, dropDb } from '../lib/admin.ts';
import { client, withTimeout } from '../lib/client.ts';
import { FUZZ_SCHEMA, build, query } from '../lib/gen.ts';
import { Workload } from '../lib/load.ts';
import { Observer } from '../lib/observe.ts';
import type { CaseCtx, Scale, Suite } from '../lib/suite.ts';

export const T4_SCALE = {
  public: { writers: 4, batches: 2000, quiesceEvery: 1000, readers: 6, subs: 60, recorded: 15, maxRowsPerWriter: 500, initialRows: 300 },
  full: { writers: 8, batches: 20_000, quiesceEvery: 1000, readers: 20, subs: 300, recorded: 30, maxRowsPerWriter: 2400, initialRows: 1000 },
} as const;

async function runSeed(t: CaseCtx, scale: Scale): Promise<void> {
  const node = await t.shared();
  const db = await t.database(node.url, FUZZ_SCHEMA, 't4');
  t.defer(() => dropDb(node.url, db.name));

  // R12: another database on the same node, with live subscriptions that must stay silent.
  const iso = await t.database(node.url, FUZZ_SCHEMA, 'iso');
  t.defer(() => dropDb(node.url, iso.name));
  const ic = client(t, node.url, iso.name);
  const isoObs = [query(t.rng, FUZZ_SCHEMA, { countRate: 0 }), query(t.rng, FUZZ_SCHEMA, { countRate: 1 })].map((q, k) => {
    const obs = new Observer(t, { label: `iso${k}`, query: q.ir });
    obs.attach(build(ic, q).subscribe(obs.listener));
    return obs;
  });
  await Promise.all(isoObs.map((o) => withTimeout(o.sub.ready, 15_000, 'ready')));

  const w = new Workload(t, {
    ...T4_SCALE[scale],
    db: db.name,
    pushVersion: db.version,
    adminUrl: node.url,
    url: () => node.url,
    faultFree: true,
  });
  await w.setup();
  await w.run();
  await w.finish();

  for (const o of isoObs) if (o.calls !== 1) t.fail(`R12: subscription ${o.label} in another database got ${o.calls} callbacks, expected only its first snapshot`);
  const after = await dbInfo(node.url, iso.name);
  if (after?.version !== iso.version) t.fail(`R12: version of the other database moved from ${iso.version} to ${after?.version}`);
  for (const o of isoObs) o.unsubscribe();
}

const suite: Suite = {
  id: 'T4',
  level: 'L1',
  weight: 8,
  needsSdk: true,
  publicSeeds: [1, 2],
  cases: (seeds, scale) => seeds.map((seed) => ({ name: `seed ${seed}`, seed, run: (t: CaseCtx) => runSeed(t, scale) })),
};
export default suite;
