/**
 * D1 Cluster formation (SPEC §13.5, §11.1): health and membership on every node; admin writes sent to any node apply cluster-wide;
 * create and drop of a name are linearizable; no node answers UNKNOWN_DATABASE, UNKNOWN_TABLE or DATABASE_EXISTS from stale state;
 * every node reports the same leader and, once writes stop, the same versions.
 */
import type { SchemaIR } from '@rsdb/client';
import { api, errorCode, type ApiResponse } from '../lib/admin.ts';
import { client, must, ok, readRejects } from '../lib/client.ts';
import { NOTES, appliedEqual, leaderOf, waitVersions } from '../lib/cluster.ts';
import { sleep, type NodeHandle } from '../lib/env.ts';
import type { CaseCtx, Suite } from '../lib/suite.ts';

const NOTES2: SchemaIR = structuredClone(NOTES);
NOTES2.tables.notes!.columns.tag = { type: 'string', nullable: true };

const dbPath = (name: string) => `/v1/databases/${encodeURIComponent(name)}`;

function expectStatus(t: CaseCtx, r: ApiResponse, status: number, code: string | null, what: string): boolean {
  if (r.status === status && (code === null || errorCode(r) === code)) return true;
  t.fail(`${what}: HTTP ${r.status} ${JSON.stringify(r.body)?.slice(0, 300)}, expected ${status}${code ? ` ${code}` : ''}`);
  return false;
}

/** Polls `probe` until it returns true, up to `ms`; a miss is a failed time bound. */
async function within(t: CaseCtx, ms: number, what: string, probe: () => Promise<boolean>): Promise<boolean> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await probe().catch(() => false)) return true;
    if (Date.now() > deadline) {
      t.failTime(`${what} (not within ${ms} ms)`);
      return false;
    }
    await sleep(100);
  }
}

async function health(t: CaseCtx, nodes: NodeHandle[]): Promise<void> {
  for (const n of nodes) {
    const h = await api(n.url, 'GET', '/healthz');
    t.eq({ status: h.status, body: h.body }, { status: 200, body: { status: 'ok', nodeId: n.nodeId } }, `${n.nodeId} /healthz`);
    const s = await api(n.url, 'GET', '/v1/stats');
    if (s.status !== 200 || ['connections', 'subscriptions', 'uniqueQueries', 'openDatabases'].some((k) => !Number.isInteger(s.body?.[k]))) {
      t.fail(`${n.nodeId} /v1/stats: HTTP ${s.status} ${JSON.stringify(s.body)}`);
    }
    const l = await api(n.url, 'GET', '/v1/databases');
    t.eq({ status: l.status, body: l.body }, { status: 200, body: [] }, `${n.nodeId} /v1/databases on a new cluster`);
  }
  const ids = nodes.map((n) => n.nodeId).sort();
  for (const n of nodes) {
    await within(t, 10_000, `${n.nodeId} /v1/cluster lists ${ids.join(', ')} alive`, async () => {
      const r = await api(n.url, 'GET', '/v1/cluster');
      const list = (r.body?.nodes ?? []) as { id: string; alive: boolean }[];
      return r.status === 200 && JSON.stringify(list.map((x) => x.id).sort()) === JSON.stringify(ids) && list.every((x) => x.alive === true);
    });
  }
}

async function adminAnywhere(t: CaseCtx, nodes: NodeHandle[]): Promise<void> {
  const [a, b, c] = nodes as [NodeHandle, NodeHandle, NodeHandle];
  const name = t.dbName('d1');
  const created = await api(b.url, 'POST', '/v1/databases', { name });
  if (!expectStatus(t, created, 201, null, `create ${name} on ${b.nodeId}`)) return t.abort('cannot create a database');
  t.eq({ name: created.body.name, version: created.body.version }, { name, version: 0 }, 'create response');
  const inc = created.body.incarnation as string;
  for (const n of [a, c]) expectStatus(t, await api(n.url, 'POST', '/v1/databases', { name }), 409, 'DATABASE_EXISTS', `create ${name} again on ${n.nodeId} right after ${b.nodeId} created it`);
  for (const n of nodes) {
    const r = await api(n.url, 'GET', `${dbPath(name)}/schema`);
    if (expectStatus(t, r, 200, null, `schema of ${name} on ${n.nodeId} right after the create (no UNKNOWN_DATABASE from stale state)`)) t.eq(r.body.schemaVersion, 0, `${n.nodeId} schemaVersion before any push`);
  }

  // Push on c; a client of a, created right after, reads the new table without UNKNOWN_TABLE (§11.1).
  const pushed = await api(c.url, 'PUT', `${dbPath(name)}/schema?dryRun=0&force=0`, NOTES);
  if (!expectStatus(t, pushed, 200, null, `push on ${c.nodeId}`)) return t.abort('cannot push a schema');
  t.eq({ applied: pushed.body.applied, version: pushed.body.version, schemaVersion: pushed.body.schemaVersion }, { applied: true, version: 1, schemaVersion: 1 }, 'first push');
  const ca = client(t, a.url, name);
  const f = await ok(t, ca.from('notes').fetch(), `fetch on ${a.nodeId} right after the push on ${c.nodeId} (no UNKNOWN_TABLE from stale state)`);
  if (f) t.eq(f.rows, [], 'rows of the new table');

  // A dry run on a answers what the push would get (§4.3), at the version the cluster is at.
  const dry = await api(a.url, 'PUT', `${dbPath(name)}/schema?dryRun=1&force=0`, NOTES2);
  if (expectStatus(t, dry, 200, null, `dry run on ${a.nodeId}`)) {
    t.eq({ applied: dry.body.applied, version: dry.body.version, schemaVersion: dry.body.schemaVersion, plan: dry.body.plan }, {
      applied: true, version: 2, schemaVersion: 2, plan: [{ action: 'addColumn', table: 'notes', column: 'tag', destructive: false }],
    }, `dry run on ${a.nodeId}`);
  }
  const real = await api(b.url, 'PUT', `${dbPath(name)}/schema?dryRun=0&force=0`, NOTES2);
  if (expectStatus(t, real, 200, null, `push on ${b.nodeId}`)) t.eq({ applied: real.body.applied, version: real.body.version }, { applied: true, version: 2 }, `push on ${b.nodeId} after the dry run`);
  await within(t, 5000, `every node lists ${name} at version 2 with incarnation ${inc}`, async () => {
    const lists = await Promise.all(nodes.map((n) => api(n.url, 'GET', '/v1/databases')));
    return lists.every((l) => (l.body as any[]).some((d) => d.name === name && d.incarnation === inc && d.version === 2 && d.schemaVersion === 2));
  });
  const destructive = await api(a.url, 'PUT', `${dbPath(name)}/schema?dryRun=0&force=0`, NOTES);
  if (expectStatus(t, destructive, 409, 'DESTRUCTIVE_CHANGE', `destructive push on ${a.nodeId}`)) {
    t.eq(destructive.body.error.plan, [{ action: 'dropColumn', table: 'notes', column: 'tag', destructive: true }], 'plan in the DESTRUCTIVE_CHANGE error');
  }

  // Drop on a; a client of c bound to that incarnation fails with UNKNOWN_DATABASE, also after the name is created again.
  const cc = client(t, c.url, name);
  await must(t, cc.from('notes').fetch(), `fetch on ${c.nodeId}`);
  expectStatus(t, await api(a.url, 'DELETE', dbPath(name)), 204, null, `drop on ${a.nodeId}`);
  expectStatus(t, await api(b.url, 'DELETE', dbPath(name)), 404, 'UNKNOWN_DATABASE', `drop on ${b.nodeId} right after ${a.nodeId} dropped it`);
  const again = await api(c.url, 'POST', '/v1/databases', { name });
  if (expectStatus(t, again, 201, null, `create ${name} again on ${c.nodeId} right after the drop`)) {
    if (again.body.incarnation === inc) t.fail('the new database has the incarnation of the dropped one');
  }
  await readRejects(t, cc.from('notes').fetch(), 'UNKNOWN_DATABASE', `fetch on ${c.nodeId} by a client bound to the dropped incarnation`);
  await within(t, 5000, `every node lists ${name} with the new incarnation`, async () => {
    const lists = await Promise.all(nodes.map((n) => api(n.url, 'GET', '/v1/databases')));
    return lists.every((l) => (l.body as any[]).filter((d) => d.name === name).map((d) => d.incarnation).join() === again.body.incarnation);
  });
}

/** Linearizable create and drop: the same name sent to all three nodes at once. */
async function concurrentCreates(t: CaseCtx, nodes: NodeHandle[]): Promise<void> {
  for (let round = 0; round < 10; round++) {
    const name = t.dbName('race');
    const created = await Promise.all(nodes.map((n) => api(n.url, 'POST', '/v1/databases', { name })));
    const wins = created.filter((r) => r.status === 201);
    const lost = created.filter((r) => r.status === 409 && errorCode(r) === 'DATABASE_EXISTS');
    if (wins.length !== 1 || lost.length !== 2) {
      t.fail(`round ${round}: concurrent creates of ${name} answered ${created.map((r) => `${r.status} ${errorCode(r) ?? ''}`).join(', ')}; expected one 201 and two 409 DATABASE_EXISTS`);
      continue;
    }
    const inc = wins[0]!.body.incarnation;
    await within(t, 5000, `round ${round}: every node lists ${name} once, incarnation ${inc}`, async () => {
      const lists = await Promise.all(nodes.map((n) => api(n.url, 'GET', '/v1/databases')));
      return lists.every((l) => (l.body as any[]).filter((d) => d.name === name).map((d) => d.incarnation).join() === inc);
    });
    const dropped = await Promise.all(nodes.map((n) => api(n.url, 'DELETE', dbPath(name))));
    const ok204 = dropped.filter((r) => r.status === 204).length;
    const gone = dropped.filter((r) => r.status === 404 && errorCode(r) === 'UNKNOWN_DATABASE').length;
    if (ok204 !== 1 || gone !== 2) t.fail(`round ${round}: concurrent drops answered ${dropped.map((r) => `${r.status} ${errorCode(r) ?? ''}`).join(', ')}; expected one 204 and two 404 UNKNOWN_DATABASE`);
  }
}

/** Databases created on different nodes, written through clients on every node: leaders and versions agree everywhere. */
async function agreement(t: CaseCtx, nodes: NodeHandle[]): Promise<void> {
  const names: string[] = [];
  for (let k = 0; k < 6; k++) {
    const home = nodes[k % 3]!;
    const name = t.dbName(`agree${k}`);
    expectStatus(t, await api(home.url, 'POST', '/v1/databases', { name }), 201, null, `create ${name} on ${home.nodeId}`);
    expectStatus(t, await api(nodes[(k + 1) % 3]!.url, 'PUT', `${dbPath(name)}/schema?dryRun=0&force=0`, NOTES), 200, null, `push ${name}`);
    names.push(name);
  }
  const finals = new Map<string, number>();
  await Promise.all(names.map(async (name, k) => {
    const clients = nodes.map((n) => client(t, n.url, name));
    let last = 0;
    for (let i = 0; i < 30; i++) {
      const c = clients[(i + k) % 3];
      const r = await ok(t, c.insert('notes', { body: `${name}:${i}` }), `insert ${i} into ${name}`);
      if (r) last = Math.max(last, r.version);
    }
    finals.set(name, last);
  }));
  for (const name of names) {
    const v = finals.get(name)!;
    if ((await waitVersions(nodes, name, v, 30_000)) === null) t.failTime(`${name}: not every node reached version ${v} within 30 s`);
    const leader = await leaderOf(t, nodes, name);
    const views = await Promise.all(nodes.map((n) => api(n.url, 'GET', '/v1/cluster')));
    for (const [i, r] of views.entries()) {
      const l = r.body?.databases?.[name]?.leader;
      if (l !== leader) t.fail(`${nodes[i]!.nodeId} /v1/cluster reports leader ${l} for ${name}, /v1/databases reports ${leader}`);
    }
    await appliedEqual(t, nodes, name, v, 30_000, name);
  }
  const leaders = await Promise.all(names.map((n) => leaderOf(t, nodes, n)));
  t.log(`leaders: ${leaders.join(', ')}`);
}

const cases: [string, (t: CaseCtx, nodes: NodeHandle[]) => Promise<void>][] = [
  ['health and membership', health],
  ['admin writes on any node', adminAnywhere],
  ['concurrent create and drop', concurrentCreates],
  ['leaders and versions agree', agreement],
];

const suite: Suite = {
  id: 'D1',
  level: 'L2',
  weight: 1,
  needsSdk: true,
  cases: () => cases.map(([name, fn]) => ({
    name, fresh: true,
    run: async (t: CaseCtx) => fn(t, (await t.env('cluster')).nodes),
  })),
};
export default suite;
