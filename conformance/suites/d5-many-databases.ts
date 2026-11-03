/**
 * D5 Many databases (SPEC §13.5, §11.1): 1,000 databases created and pushed through all three nodes; every node lists all of them
 * with the same incarnation and the same leader, in /v1/databases and /v1/cluster; a sample is written and read through other
 * nodes; half are dropped and every node converges on the rest.
 */
import { api, errorCode } from '../lib/admin.ts';
import { client, ok } from '../lib/client.ts';
import { NOTES } from '../lib/cluster.ts';
import { sleep, type NodeHandle } from '../lib/env.ts';
import type { CaseCtx, Suite } from '../lib/suite.ts';

const COUNT = 1000;
const POOL = 16;

async function pool<T>(items: readonly T[], fn: (x: T, i: number) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: POOL }, async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i]!, i);
    }
  }));
}

/** Every node lists exactly `expected` (name → incarnation) among the names with `prefix`; waits up to `ms`. */
async function listsConverge(t: CaseCtx, nodes: NodeHandle[], prefix: string, expected: Map<string, string>, ms: number, what: string): Promise<any[][]> {
  const deadline = Date.now() + ms;
  let lists: any[][] = [];
  for (;;) {
    lists = await Promise.all(nodes.map((n) => api(n.url, 'GET', '/v1/databases', undefined, 30_000).then((r) => (Array.isArray(r.body) ? r.body : []), () => [])));
    const bad = lists.map((l) => {
      const mine = l.filter((d) => d.name.startsWith(prefix));
      const wrong = mine.filter((d) => expected.get(d.name) !== d.incarnation).length;
      return wrong + Math.abs(expected.size - mine.length);
    });
    if (bad.every((b) => b === 0)) return lists;
    if (Date.now() > deadline) {
      t.failTime(`${what}: after ${ms} ms the nodes' lists differ from the expected ${expected.size} databases by ${bad.join(', ')} entries`);
      return lists;
    }
    await sleep(500);
  }
}

async function many(t: CaseCtx): Promise<void> {
  const { nodes } = await t.env('cluster');
  const prefix = `d5_${t.rng.int(1e6)}_`;
  const names = Array.from({ length: COUNT }, (_, i) => `${prefix}${i}`);
  const incs = new Map<string, string>();
  const t0 = Date.now();
  await pool(names, async (name, i) => {
    const c = await api(nodes[i % 3]!.url, 'POST', '/v1/databases', { name }, 30_000);
    if (c.status !== 201) return t.fail(`create ${name} on ${nodes[i % 3]!.nodeId}: HTTP ${c.status} ${JSON.stringify(c.body)}`);
    incs.set(name, c.body.incarnation);
    const p = await api(nodes[(i + 1) % 3]!.url, 'PUT', `/v1/databases/${name}/schema?dryRun=0&force=0`, NOTES, 30_000);
    if (p.status !== 200 || p.body?.version !== 1) t.fail(`push ${name} on ${nodes[(i + 1) % 3]!.nodeId}: HTTP ${p.status} ${JSON.stringify(p.body)}`);
  });
  t.log(`${COUNT} databases created and pushed in ${Date.now() - t0} ms`);
  if (incs.size < COUNT) return t.abort(`only ${incs.size} of ${COUNT} databases could be created`);

  // Same names, incarnations and leaders on every node, in /v1/databases and /v1/cluster.
  const lists = await listsConverge(t, nodes, prefix, incs, 30_000, 'after creating');
  const ids = new Set(nodes.map((n) => n.nodeId));
  const leaders = lists.map((l) => new Map(l.filter((d) => d.name.startsWith(prefix)).map((d) => [d.name, d.leader])));
  const views = await Promise.all(nodes.map((n) => api(n.url, 'GET', '/v1/cluster', undefined, 30_000)));
  let disagree = 0;
  const spread = new Map<string, number>();
  for (const name of names) {
    const l = leaders[0]!.get(name);
    spread.set(String(l), (spread.get(String(l)) ?? 0) + 1);
    const all = [...leaders.map((m) => m.get(name)), ...views.map((v) => v.body?.databases?.[name]?.leader)];
    if (!ids.has(l) || all.some((x) => x !== l)) {
      if (disagree++ < 5) t.fail(`${name}: leaders reported by n1..n3 in /v1/databases and /v1/cluster: ${all.join(', ')}`);
    }
  }
  if (disagree > 5) t.fail(`${disagree} databases with leaders that differ between nodes`);
  t.log(`leaders: ${[...spread].map(([k, v]) => `${k} ${v}`).join(', ')}`);

  // A sample written through one node and read through another.
  await pool(t.rng.sample(names, 30), async (name, i) => {
    const w = client(t, nodes[i % 3]!.url, name);
    const r = await ok(t, w.insert('notes', { id: 'x', body: name }), `insert into ${name}`);
    if (!r) return;
    const c = client(t, nodes[(i + 1) % 3]!.url, name);
    const f = await ok(t, c.from('notes').fetch({ minVersion: r.version }), `fetch ${name} on another node`);
    if (f) t.eq(f.rows.map((x: { body: string }) => x.body), [name], `${name} read through another node`);
    await Promise.all([w.close(), c.close()]);
  });

  // Half dropped through random nodes; every node converges on the rest.
  const dropped = names.filter((_, i) => i % 2 === 1);
  await pool(dropped, async (name, i) => {
    const r = await api(nodes[(i + 2) % 3]!.url, 'DELETE', `/v1/databases/${name}`, undefined, 30_000);
    if (r.status !== 204) t.fail(`drop ${name}: HTTP ${r.status} ${errorCode(r) ?? JSON.stringify(r.body)}`);
    incs.delete(name);
  });
  await listsConverge(t, nodes, prefix, incs, 30_000, 'after dropping half');
}

const suite: Suite = {
  id: 'D5',
  level: 'L2',
  weight: 1,
  needsSdk: true,
  cases: () => [{ name: `${COUNT} databases`, fresh: true, run: many }],
};
export default suite;
