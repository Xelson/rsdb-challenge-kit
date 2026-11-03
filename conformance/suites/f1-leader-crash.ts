/**
 * F1 Leader crash (SPEC §13.5, §11.2): T4-style load with `$inc` counters on a cluster; the leader of the database is SIGKILLed and
 * restarted 8 s later. Safety: acknowledged inserts present, counters within [acked, acked + unknown], no fork (mirrored deliveries
 * and the state read back through every node agree), R1 by replay from checkpoints. Liveness: the first acknowledgement within 10 s
 * of the fault, then ≥ 90 % of writes acknowledged, every node at the same `applied` version within 30 s of the restart.
 */
import { FUZZ_SCHEMA } from '../lib/gen.ts';
import { FAULT_SCALE, ackRate, appliedEqual, clusterWorkload, firstAck, leaderOf, nodeById, restartAndCatchUp } from '../lib/cluster.ts';
import { sleep } from '../lib/env.ts';
import type { CaseCtx, Scale, Suite } from '../lib/suite.ts';

const DOWN_MS = 8000;

async function runSeed(t: CaseCtx, scale: Scale): Promise<void> {
  const { env, nodes } = await t.env('cluster');
  const db = await t.database(nodes[0]!.url, FUZZ_SCHEMA, 'f1');
  let done = false;
  let killAt = 0;
  let restartAt = 0;
  // Quiescence points do not wait for the restart: writes and checks go on while the old leader is down.
  const w = clusterWorkload(t, nodes, db, scale, { until: () => done });
  await w.setup();
  const injector = (async () => {
    await w.afterBatches(FAULT_SCALE[scale].quiesceEvery + 10);
    if (w.stopped) return;
    const victim = nodeById(nodes, await leaderOf(t, nodes, db.name));
    t.log(`SIGKILL leader ${victim.nodeId} after ${w.attempted} batches`);
    await env.kill(victim);
    killAt = Date.now();
    await sleep(DOWN_MS);
    restartAt = Date.now();
    if (!(await restartAndCatchUp(t, env, nodes, victim, db.name))) return w.stop(`${victim.nodeId} never came back after SIGKILL`);
    done = true;
  })();
  await w.run();
  await injector;
  if (w.stopped) return t.abort(w.stopped);
  const end = Date.now();
  const first = firstAck(t, w.writes, killAt, 'leader crash');
  if (first !== null) ackRate(t, w.writes, first, end, 'leader crash');
  const { vFinal } = await w.finish();
  await appliedEqual(t, nodes, db.name, vFinal, Math.max(5000, restartAt + 30_000 - Date.now()), 'after the restart');
  await leaderOf(t, nodes, db.name);
}

const suite: Suite = {
  id: 'F1',
  level: 'L3',
  weight: 3,
  needsSdk: true,
  publicSeeds: [1],
  cases: (seeds, scale) => seeds.map((seed) => ({ name: `seed ${seed}`, seed, fresh: true, run: (t: CaseCtx) => runSeed(t, scale) })),
};
export default suite;
