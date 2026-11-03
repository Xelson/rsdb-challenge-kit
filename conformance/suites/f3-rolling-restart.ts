/**
 * F3 Rolling restart (SPEC §13.5, §11.2): during T4-style load every node in turn gets SIGTERM (graceful exit within 5 s, §4.2),
 * comes back on the same data dir and catches up before the next one goes. Each stop must be followed by an acknowledgement within
 * 10 s; the safety checks of F1 apply throughout.
 */
import { FUZZ_SCHEMA } from '../lib/gen.ts';
import { FAULT_SCALE, appliedEqual, clusterWorkload, firstAck, leaderOf, restartAndCatchUp } from '../lib/cluster.ts';
import { sleep } from '../lib/env.ts';
import type { CaseCtx, Scale, Suite } from '../lib/suite.ts';

async function runSeed(t: CaseCtx, scale: Scale): Promise<void> {
  const { env, nodes } = await t.env('cluster');
  const db = await t.database(nodes[0]!.url, FUZZ_SCHEMA, 'f3');
  const every = FAULT_SCALE[scale].quiesceEvery;
  const stops: { node: string; at: number }[] = [];
  let lastRestart = 0;
  const w = clusterWorkload(t, nodes, db, scale, { until: () => lastRestart > 0 });
  await w.setup();
  const injector = (async () => {
    for (const [k, node] of nodes.entries()) {
      await w.afterBatches((k + 1) * every + 10);
      if (w.stopped) return;
      const leader = await leaderOf(t, nodes, db.name);
      const ms = await env.terminate(node);
      stops.push({ node: node.nodeId, at: Date.now() });
      t.log(`SIGTERM ${node.nodeId}${node.nodeId === leader ? ' (leader)' : ''}: exited in ${ms} ms`);
      if (ms > 5000) t.failTime(`${node.nodeId} took ${ms} ms to exit after SIGTERM (§4.2: 5 s)`);
      await sleep(1000);
      if (!(await restartAndCatchUp(t, env, nodes, node, db.name))) return w.stop(`${node.nodeId} never came back after SIGTERM`);
    }
    lastRestart = Date.now();
  })();
  await w.run();
  await injector;
  if (w.stopped) return t.abort(w.stopped);
  for (const s of stops) firstAck(t, w.writes, s.at, `stop of ${s.node}`);
  const { vFinal } = await w.finish();
  await appliedEqual(t, nodes, db.name, vFinal, Math.max(5000, lastRestart + 30_000 - Date.now()), 'after the last restart');
  await leaderOf(t, nodes, db.name);
}

const suite: Suite = {
  id: 'F3',
  level: 'L3',
  weight: 1,
  needsSdk: true,
  publicSeeds: [1],
  cases: (seeds, scale) => seeds.map((seed) => ({ name: `seed ${seed}`, seed, fresh: true, run: (t: CaseCtx) => runSeed(t, scale) })),
};
export default suite;
