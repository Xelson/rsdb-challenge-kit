/**
 * T6 Faults (SPEC §13.5): T4-style load while a TCP proxy cuts every client connection every 2 s (R10), and SIGKILL plus restart
 * of the node under writes (durability, version continuity, client recovery). Checks of §13.2: acknowledged versions distinct and
 * within the accounting bounds, acknowledged inserts present, per-writer counters within [acked, acked + unknown], R2 across
 * reconnects, R1 by voter replay up to the first unknown outcome.
 */
import { dropDb } from '../lib/admin.ts';
import { sleep } from '../lib/env.ts';
import { FUZZ_SCHEMA } from '../lib/gen.ts';
import { Workload, type WorkloadOptions } from '../lib/load.ts';
import { CutProxy } from '../lib/proxy.ts';
import type { CaseCtx, Scale, Suite } from '../lib/suite.ts';

const SCALE = {
  public: { writers: 3, batches: 1500, quiesceEvery: 500, readers: 4, subs: 30, recorded: 10, maxRowsPerWriter: 300, initialRows: 200 },
  full: { writers: 6, batches: 6000, quiesceEvery: 1000, readers: 8, subs: 100, recorded: 20, maxRowsPerWriter: 1000, initialRows: 500 },
} as const;

const common = (scale: Scale): Omit<WorkloadOptions, 'db' | 'pushVersion' | 'adminUrl' | 'url'> => ({
  ...SCALE[scale],
  faultFree: false,
  counters: true,
  timeoutMs: 10_000,
  convergeMs: 10_000,
});

/** Connections through the proxy are cut every 2 s while the load runs; the load continues until at least 5 cuts happened. */
async function proxyCuts(t: CaseCtx, scale: Scale): Promise<void> {
  const node = await t.shared();
  const db = await t.database(node.url, FUZZ_SCHEMA, 't6cut');
  t.defer(() => dropDb(node.url, db.name));
  const proxy = new CutProxy(node.url);
  const via = await proxy.start();
  t.defer(() => proxy.close());
  const w = new Workload(t, {
    ...common(scale), db: db.name, pushVersion: db.version, adminUrl: node.url, url: () => via, until: () => proxy.cuts >= 5,
  });
  await w.setup();
  let running = true;
  const cutter = (async () => {
    while (running) {
      await sleep(2000);
      if (running && !w.quiescing) proxy.cutAll();
    }
  })();
  try {
    await w.run();
  } finally {
    running = false;
    await cutter;
  }
  await w.finish();
  t.log(`${proxy.cuts} cuts`);
  if (proxy.cuts < 5) t.fail(`only ${proxy.cuts} connection cuts happened during the load`);
}

/** SIGKILL at 25 % and 60 % of the batches, restart on the same data dir 0.5 s later; writes continue throughout. */
async function killRestart(t: CaseCtx, scale: Scale): Promise<void> {
  const { env, nodes } = await t.env('single');
  const node = nodes[0]!;
  const db = await t.database(node.url, FUZZ_SCHEMA, 't6kill');
  const marks = [0.25, 0.6].map((f) => Math.round(f * SCALE[scale].batches));
  let kills = 0;
  let fault: Promise<unknown> = Promise.resolve();
  const w = new Workload(t, {
    ...common(scale), db: db.name, pushVersion: db.version, adminUrl: node.url, url: () => node.url,
    until: () => kills === marks.length,
    beforeQuiesce: () => fault,
  });
  await w.setup();
  const killer = (async () => {
    for (const mark of marks) {
      await w.afterBatches(mark);
      fault = (async () => {
        await env.kill(node);
        kills++;
        await sleep(500);
        const t0 = Date.now();
        try {
          await env.restart(node, 15_000);
          t.log(`kill ${kills} after ${mark} batches: healthy ${Date.now() - t0} ms after restart`);
        } catch (e) {
          w.stop(`restart ${kills} failed: ${(e as Error).message}`);
        }
      })();
      await fault;
    }
  })();
  await w.run();
  await fault;
  if (w.stopped) return t.abort(`the node did not come back after SIGKILL (${w.stopped})`);
  await w.finish();
  if (kills < marks.length) t.fail(`only ${kills} of ${marks.length} kills happened`);
  void killer;
}

const suite: Suite = {
  id: 'T6',
  level: 'L1',
  weight: 3,
  needsSdk: true,
  publicSeeds: [1],
  cases: (seeds, scale) =>
    seeds.flatMap((seed) => [
      { name: `proxy cuts, seed ${seed}`, seed, run: (t: CaseCtx) => proxyCuts(t, scale) },
      { name: `SIGKILL and restart, seed ${seed}`, seed, fresh: true, run: (t: CaseCtx) => killRestart(t, scale) },
    ]),
};
export default suite;
