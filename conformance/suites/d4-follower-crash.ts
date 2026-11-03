/**
 * D4 Follower crash (SPEC §13.5, §11.1): T4-style load on a cluster while a node that leads no database under test is SIGKILLed and
 * restarted. Writes continue while it is down; it serves /healthz within 15 s of the restart and has caught up within 30 s; its
 * clients fail over to the other URLs (R10). Checks: everything of T6 (accounting, acknowledged data, counters, replay with
 * checkpoints) plus R8 across nodes.
 */
import { FUZZ_SCHEMA } from '../lib/gen.ts';
import { FAULT_SCALE, appliedEqual, clusterWorkload, leaderOf, restartAndCatchUp } from '../lib/cluster.ts';
import { sleep } from '../lib/env.ts';
import type { CaseCtx, Scale, Suite } from '../lib/suite.ts';

async function runSeed(t: CaseCtx, scale: Scale): Promise<void> {
  const { env, nodes } = await t.env('cluster');
  const db = await t.database(nodes[0]!.url, FUZZ_SCHEMA, 'd4');
  // Right after a quiescence point, so that a whole phase of writes runs while the node is down.
  const every = FAULT_SCALE[scale].quiesceEvery;
  const marks = (scale === 'full' ? [1, 3] : [1]).map((p) => p * every + 10);
  let done = 0;
  let fault: Promise<unknown> = Promise.resolve();
  const w = clusterWorkload(t, nodes, db, scale, { until: () => done === marks.length, beforeQuiesce: () => fault });
  await w.setup();
  const injector = (async () => {
    for (const mark of marks) {
      await w.afterBatches(mark);
      if (w.stopped) return;
      fault = (async () => {
        const leader = await leaderOf(t, nodes, db.name);
        const victim = t.rng.pick(nodes.filter((n) => n.nodeId !== leader));
        const ackedBefore = w.stats.acked;
        await env.kill(victim);
        t.log(`SIGKILL ${victim.nodeId} (leader is ${leader}) after ${w.attempted} batches`);
        await sleep(3000);
        if (w.stats.acked === ackedBefore) t.failTime(`no write was acknowledged during the 3 s ${victim.nodeId} was down (§11.1: writes continue)`);
        if (!(await restartAndCatchUp(t, env, nodes, victim, db.name))) return w.stop(`${victim.nodeId} never came back after SIGKILL`);
        done++;
      })();
      await fault;
    }
  })();
  await w.run();
  await injector;
  if (w.stopped) return t.abort(w.stopped);
  const { vFinal } = await w.finish();
  await appliedEqual(t, nodes, db.name, vFinal, 30_000, 'after the load');
}

const suite: Suite = {
  id: 'D4',
  level: 'L2',
  weight: 2,
  needsSdk: true,
  publicSeeds: [1],
  cases: (seeds, scale) => seeds.map((seed) => ({ name: `seed ${seed}`, seed, fresh: true, run: (t: CaseCtx) => runSeed(t, scale) })),
};
export default suite;
