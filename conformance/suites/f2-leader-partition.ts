/**
 * F2 Leader partition (SPEC §13.5, §11.2): during T4-style load the leader's traffic to its peers is cut for 30 s while clients still
 * reach it. A client pinned to the isolated node keeps writing: no acknowledgement for a request sent more than 2 s after the cut,
 * and reads are rejected 8 s after it (§11.2: 3 s, plus the SDK's detection). R4 on the majority side during the partition and on
 * every node 10 s after the heal; the checks of F1 otherwise.
 */
import { client } from '../lib/client.ts';
import { FUZZ_SCHEMA, columnsOf, itemRow } from '../lib/gen.ts';
import { FAULT_SCALE, ackRate, appliedEqual, clusterWorkload, firstAck, leaderOf, nodeById } from '../lib/cluster.ts';
import { sleep, type NodeHandle } from '../lib/env.ts';
import type { CaseCtx, Scale, Suite } from '../lib/suite.ts';

const PARTITION_MS = 30_000;

/** R4: a fresh client on each node reaches `v` within 5 s. */
async function convergedOn(t: CaseCtx, nodes: readonly NodeHandle[], db: string, v: number, label: string): Promise<void> {
  await Promise.all(nodes.map(async (n) => {
    const c = client(t, n.url, db, { timeoutMs: 5000 });
    try {
      await c.waitForVersion(v, { timeoutMs: 5000 });
    } catch (e: any) {
      t.failTime(`R4 ${label}: ${n.nodeId} did not reach v${v} within 5 s (${e?.code ?? e})`);
    } finally {
      await c.close();
    }
  }));
}

async function runSeed(t: CaseCtx, scale: Scale): Promise<void> {
  const { env, nodes } = await t.env('cluster');
  const db = await t.database(nodes[0]!.url, FUZZ_SCHEMA, 'f2');
  const cols = columnsOf(FUZZ_SCHEMA, 'items');
  let done = false;
  let cutAt = 0;
  let healAt = 0;
  const w = clusterWorkload(t, nodes, db, scale, { until: () => done });
  await w.setup();
  const injector = (async () => {
    await w.afterBatches(FAULT_SCALE[scale].quiesceEvery + 10);
    if (w.stopped) return;
    const isolated = nodeById(nodes, await leaderOf(t, nodes, db.name));
    const majority = nodes.filter((n) => n !== isolated);
    const probe = client(t, isolated.url, db.name, { timeoutMs: 3000 });
    await probe.from('counters').fetch().catch(() => {});
    await env.partition(isolated);
    cutAt = Date.now();
    t.log(`partitioned leader ${isolated.nodeId} after ${w.attempted} batches`);

    // The pinned client keeps writing; nothing sent 2 s after the cut may be acknowledged by the minority.
    const rng = t.rng.fork('probe');
    const probing = (async () => {
      for (let k = 0; Date.now() < cutAt + PARTITION_MS - 5000; k++) {
        const r = await w.writeVia(probe, [{ op: 'insert', table: 'items', row: { ...itemRow(rng, cols), id: `iso_${k}`, u: null } }]);
        if (r.r === 'ack' && r.t0 >= cutAt + 2000) t.fail(`the isolated node ${isolated.nodeId} acknowledged a write sent ${r.t0 - cutAt} ms after the cut (v${r.version})`);
        await sleep(200);
      }
    })();
    await sleep(8000);
    const read = await probe.from('counters').fetch().then(() => null, (e: any) => e?.code ?? String(e));
    if (read === null) t.failTime(`the isolated node ${isolated.nodeId} answered a read 8 s after the cut (§11.2: it rejects SDK operations after 3 s)`);
    await sleep(4000);
    await convergedOn(t, majority, db.name, w.lastAcked, 'majority side during the partition');
    await probing;
    await sleep(Math.max(0, cutAt + PARTITION_MS - Date.now()));
    await env.heal(isolated);
    healAt = Date.now();
    t.log(`healed ${isolated.nodeId}`);
    await sleep(10_000);
    await convergedOn(t, nodes, db.name, w.lastAcked, '10 s after the heal');
    done = true;
  })();
  await w.run();
  await injector;
  if (w.stopped) return t.abort(w.stopped);
  const end = Date.now();
  const first = firstAck(t, w.writes, cutAt, 'leader partition');
  if (first !== null) ackRate(t, w.writes, first, end, 'leader partition');
  const { vFinal } = await w.finish();
  await appliedEqual(t, nodes, db.name, vFinal, Math.max(5000, healAt + 30_000 - Date.now()), 'after the heal');
  await leaderOf(t, nodes, db.name);
}

const suite: Suite = {
  id: 'F2',
  level: 'L3',
  weight: 2,
  needsSdk: true,
  publicSeeds: [1],
  cases: (seeds, scale) => seeds.map((seed) => ({ name: `seed ${seed}`, seed, fresh: true, run: (t: CaseCtx) => runSeed(t, scale) })),
};
export default suite;
