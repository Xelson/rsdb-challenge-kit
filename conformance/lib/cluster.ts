/**
 * Cluster helpers for the D and F suites (SPEC §11): client URL lists, the leader every node reports, versions per node, the
 * `applied` view of /v1/cluster, and the liveness bounds of §11.2 computed from a workload's write log.
 */
import type { SchemaIR } from '@rsdb/client';
import { api, dbInfo } from './admin.ts';
import { sleep, type Env, type NodeHandle } from './env.ts';
import { Workload, type WorkloadOptions, type WriteRecord } from './load.ts';
import type { CaseCtx, Scale } from './suite.ts';

/** A small schema for the hand-written cluster cases. */
export const NOTES: SchemaIR = {
  format: 'rsdb-schema/1',
  tables: {
    notes: {
      columns: {
        body: { type: 'string', nullable: false, default: '' },
        n: { type: 'int', nullable: false, default: 0 },
        u: { type: 'string', nullable: true },
      },
      indexes: [{ name: 'u_unique', columns: ['u'], unique: true }],
    },
    quiet: { columns: { x: { type: 'int', nullable: false, default: 0 } }, indexes: [] },
  },
};

/** Every node's URL, `home` first: a client connects there and fails over to the others (§9, R10). */
export const urlsFrom = (nodes: readonly NodeHandle[], home: number): string[] =>
  nodes.map((_, i) => nodes[(home + i) % nodes.length]!.url);

/**
 * The leader of `db` once every node in `nodes` reports the same one, which must be a cluster member (§11.1). Nodes may disagree for
 * up to 10 s after a fault; past `ms` that is a failed time bound and the most reported leader is returned.
 */
export async function leaderOf(t: CaseCtx, nodes: readonly NodeHandle[], db: string, ms = 10_000): Promise<string> {
  const ids = new Set(nodes.map((n) => n.nodeId));
  const deadline = Date.now() + ms;
  let seen: (string | null)[] = [];
  for (;;) {
    seen = await Promise.all(nodes.map((n) => dbInfo(n.url, db).then((d) => d?.leader ?? null, () => null)));
    if (seen.every((l) => l !== null && l === seen[0] && ids.has(l))) return seen[0]!;
    if (Date.now() > deadline) break;
    await sleep(200);
  }
  t.failTime(`${db}: nodes ${nodes.map((n) => n.nodeId).join(', ')} report leaders ${seen.map(String).join(', ')} after ${ms} ms`);
  const counts = new Map<string, number>();
  for (const l of seen) if (l && ids.has(l)) counts.set(l, (counts.get(l) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? t.abort(`${db}: no node reports a leader`);
}

export const nodeById = (nodes: readonly NodeHandle[], id: string): NodeHandle =>
  nodes.find((n) => n.nodeId === id) ?? (() => { throw new Error(`no node ${id}`); })();

/** The version of `db` in each node's /v1/databases (null where the node does not answer or lacks it). */
export const versions = (nodes: readonly NodeHandle[], db: string): Promise<(number | null)[]> =>
  Promise.all(nodes.map((n) => dbInfo(n.url, db).then((d) => d?.version ?? null, () => null)));

/** Waits until every node reports at least version `v` of `db`; returns the time it took, or null after `ms`. */
export async function waitVersions(nodes: readonly NodeHandle[], db: string, v: number, ms: number): Promise<number | null> {
  const t0 = Date.now();
  for (;;) {
    const vs = await versions(nodes, db);
    if (vs.every((x) => x !== null && x >= v)) return Date.now() - t0;
    if (Date.now() - t0 > ms) return null;
    await sleep(100);
  }
}

/**
 * §11.2: after a fault every node reports the same `applied` version in /v1/cluster. Waits until each node's view lists every node
 * at version `v` of `db`, up to `ms`; reports the views as a failed time bound otherwise.
 */
export async function appliedEqual(t: CaseCtx, nodes: readonly NodeHandle[], db: string, v: number, ms: number, label: string): Promise<boolean> {
  const deadline = Date.now() + ms;
  let views: unknown[] = [];
  for (;;) {
    views = await Promise.all(nodes.map((n) => api(n.url, 'GET', '/v1/cluster', undefined, 5000).then((r) => (r.status === 200 ? r.body?.databases?.[db]?.applied ?? null : null), () => null)));
    if (views.every((a) => a && nodes.every((n) => (a as Record<string, unknown>)[n.nodeId] === v))) return true;
    if (Date.now() > deadline) break;
    await sleep(250);
  }
  t.failTime(`${label}: /v1/cluster applied for ${db} is not ${v} on every node after ${ms} ms: ${nodes.map((n, i) => `${n.nodeId} sees ${JSON.stringify(views[i])}`).join('; ')}`);
  return false;
}

/**
 * §11.2: a write sent after the fault at `at` is acknowledged within 10 s of it (acknowledgements of writes sent before the fault
 * may come from the failed leader). Returns the time of that acknowledgement.
 */
export function firstAck(t: CaseCtx, writes: readonly WriteRecord[], at: number, label: string): number | null {
  const first = writes.filter((w) => w.r === 'ack' && w.t0 >= at).sort((a, b) => a.t1 - b.t1)[0];
  if (!first || first.t1 - at > 10_000) {
    t.failTime(`${label}: first acknowledgement ${first ? `${first.t1 - at} ms` : 'never'} after the fault (bound 10 s)`);
    return null;
  }
  t.log(`${label}: first acknowledgement ${first.t1 - at} ms after the fault`);
  return first.t1;
}

/** §11.2: at least 90 % of the writes sent in [from, until] are acknowledged (data errors excluded). */
export function ackRate(t: CaseCtx, writes: readonly WriteRecord[], from: number, until: number, label: string): void {
  const sent = writes.filter((w) => w.t0 >= from && w.t0 <= until && w.r !== 'rejected');
  const acked = sent.filter((w) => w.r === 'ack').length;
  const why = new Map<string, number>();
  for (const w of sent) if (w.r !== 'ack') why.set(`${w.r} ${w.code}`, (why.get(`${w.r} ${w.code}`) ?? 0) + 1);
  const detail = [...why].map(([k, n]) => `${n} ${k}`).join(', ');
  t.log(`${label}: ${acked}/${sent.length} writes acknowledged after the first one${detail ? ` (${detail})` : ''}`);
  if (sent.length >= 20 && acked < 0.9 * sent.length) t.failTime(`${label}: ${acked} of ${sent.length} writes acknowledged after the first one (≥ 90 % required; ${detail})`);
}

/** Load for the fault suites D4 and F1–F3 (T4-style, smaller than D2 because faults stretch it). */
export const FAULT_SCALE = {
  public: { writers: 3, batches: 1500, quiesceEvery: 500, readers: 6, subs: 30, recorded: 10, maxRowsPerWriter: 300, initialRows: 200 },
  full: { writers: 6, batches: 6000, quiesceEvery: 1000, readers: 12, subs: 60, recorded: 20, maxRowsPerWriter: 1000, initialRows: 500 },
} as const;

/**
 * A fault-run workload on a cluster: every client lists all nodes with its home node first, subscriptions are mirrored on each
 * node, the state is read back through every node at each quiescence point, counters track unknown outcomes.
 */
export function clusterWorkload(t: CaseCtx, nodes: readonly NodeHandle[], db: { name: string; version: number }, scale: Scale, o: Partial<WorkloadOptions> = {}): Workload {
  const s = FAULT_SCALE[scale];
  return new Workload(t, {
    ...s,
    db: db.name,
    pushVersion: db.version,
    adminUrl: nodes[0]!.url,
    adminUrls: nodes.map((n) => n.url),
    url: (_role, i) => urlsFrom(nodes, i % nodes.length),
    mirrors: nodes.length,
    checkpointUrls: nodes.map((n) => n.url),
    faultFree: false,
    counters: true,
    convergeMs: 10_000,
    maxBatches: 50 * s.batches,
    ...o,
  });
}

/**
 * Restarts a stopped node: /healthz within 15 s (§11.1), then caught up with the version the other nodes report within 30 s.
 * Misses are failed time bounds; returns false if the node never came back.
 */
export async function restartAndCatchUp(t: CaseCtx, env: Env, nodes: readonly NodeHandle[], node: NodeHandle, db: string): Promise<boolean> {
  const t0 = Date.now();
  try {
    await env.restart(node, 15_000);
  } catch {
    t.failTime(`${node.nodeId} did not serve /healthz within 15 s of its restart`);
    try {
      await env.waitHealthy([node], 30_000);
    } catch {
      return false;
    }
  }
  const healthy = Date.now() - t0;
  const target = Math.max(0, ...(await versions(nodes.filter((n) => n !== node), db)).map((v) => v ?? 0));
  const caught = await waitVersions([node], db, target, 30_000);
  if (caught === null) t.failTime(`${node.nodeId} did not reach version ${target} within 30 s of its restart`);
  t.log(`${node.nodeId}: healthy ${healthy} ms after the restart, at v${target} ${caught ?? '>30000'} ms later`);
  return true;
}
