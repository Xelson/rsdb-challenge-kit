/**
 * D3 Follower writes (SPEC §13.5, §11.1): writes sent to a follower are forwarded to the leader transparently, with the leader's
 * answer (results, error code, opIndex, outcome); R6 holds for clients connected to a follower; concurrent writes through
 * different nodes get distinct versions, lose no `$inc` and respect unique indexes.
 */
import { client, must, mutRejects, ok, rejects, withTimeout } from '../lib/client.ts';
import { NOTES, leaderOf, nodeById } from '../lib/cluster.ts';
import type { NodeHandle } from '../lib/env.ts';
import type { CaseCtx, Scale, Suite } from '../lib/suite.ts';

async function setup(t: CaseCtx): Promise<{ nodes: NodeHandle[]; db: string; v0: number; leader: NodeHandle; followers: NodeHandle[] }> {
  const { nodes } = await t.env('cluster');
  const { name, version } = await t.database(nodes[0]!.url, NOTES, 'd3');
  const leader = nodeById(nodes, await leaderOf(t, nodes, name));
  return { nodes, db: name, v0: version, leader, followers: nodes.filter((n) => n !== leader) };
}

async function forwarding(t: CaseCtx): Promise<void> {
  const { db, v0, leader, followers } = await setup(t);
  const [f1, f2] = followers as [NodeHandle, NodeHandle];
  const c1 = client(t, f1.url, db);
  const c2 = client(t, f2.url, db);
  const cl = client(t, leader.url, db);

  const ins = await must(t, c1.insert('notes', { id: 'a', body: 'via follower' }), `insert through follower ${f1.nodeId}`);
  t.check(ins.id === 'a' && ins.version > v0, `insert through a follower returned ${JSON.stringify(ins)}`);
  t.check(c1.lastWriteVersion === ins.version, `lastWriteVersion ${c1.lastWriteVersion} after a write acknowledged at ${ins.version}`);
  const f = await must(t, c1.from('notes').fetch(), `fetch on ${f1.nodeId} after its own write`);
  if (f.version < ins.version) t.fail(`R6 on follower ${f1.nodeId}: fetch at version ${f.version} after a write acknowledged at ${ins.version}`);
  t.eq(f.rows, [{ id: 'a', body: 'via follower', n: 0, u: null }], `rows on ${f1.nodeId} after its own write`);
  const sub = c1.from('notes').subscribe(() => {});
  const snap = await must(t, withTimeout<any>(sub.ready, 15_000, 'ready'), `subscribe on ${f1.nodeId} after its own write`);
  if (snap.version < ins.version) t.fail(`R6 on follower ${f1.nodeId}: first snapshot at version ${snap.version} after a write acknowledged at ${ins.version}`);
  t.eq(snap.rows, [{ id: 'a', body: 'via follower', n: 0, u: null }], 'first snapshot');
  sub.unsubscribe();

  const up = await must(t, c2.update('notes', 'a', { n: { $inc: 5 }, body: 'via other follower' }), `update through follower ${f2.nodeId}`);
  if (up.version <= ins.version) t.fail(`update acknowledged at ${up.version}, not after the insert at ${ins.version}`);
  const f2r = await must(t, c2.from('notes').fetch(), `fetch on ${f2.nodeId}`);
  if (f2r.version < up.version) t.fail(`R6 on follower ${f2.nodeId}: fetch at version ${f2r.version} after its write at ${up.version}`);
  t.eq(f2r.rows, [{ id: 'a', body: 'via other follower', n: 5, u: null }], `rows on ${f2.nodeId} after its update`);

  // The leader's errors reach the client through the follower unchanged; nothing is applied.
  await rejects(t, c2.batch((tx: any) => {
    tx.insert('notes', { id: 'b' });
    tx.insert('notes', { id: 'a' });
  }), 'DUPLICATE_ID', { opIndex: 1, outcome: 'not_applied' }, `batch with a duplicate id through ${f2.nodeId}`);
  await mutRejects(t, c1.update('notes', 'missing', { n: 1 }), 'NOT_FOUND', `update of a missing id through ${f1.nodeId}`);
  const del = await must(t, c1.delete('notes', 'missing'), `delete of a missing id through ${f1.nodeId}`);
  t.eq(del.deleted, false, 'deleted flag for a missing id');
  const ub = await must(t, c1.insert('notes', { id: 'u1', u: 'same' }), `insert with a unique value through ${f1.nodeId}`);
  await mutRejects(t, c2.insert('notes', { id: 'u2', u: 'same' }), 'CONSTRAINT_VIOLATION', `duplicate unique value through ${f2.nodeId}`);
  const all = await must(t, cl.from('notes').fetch({ minVersion: ub.version }), 'fetch on the leader');
  t.eq(all.rows.map((r: { id: string }) => r.id), ['a', 'u1'], 'rows after the rejected batches');
}

/** Each node's client writes and immediately reads its own write, many times, concurrently with the others. */
async function readYourWrites(t: CaseCtx, scale: Scale): Promise<void> {
  const { nodes, db } = await setup(t);
  const iterations = scale === 'full' ? 300 : 100;
  const clients = nodes.map((n) => client(t, n.url, db));
  const owner = new Map<number, string>();
  await Promise.all(clients.map(async (c, k) => {
    const who = nodes[k]!.nodeId;
    let prev = 0;
    for (let i = 0; i < iterations; i++) {
      const id = `k${k}_${i % 10}`;
      const body = `${who}:${i}`;
      const r = await ok(t, i < 10 ? c.insert('notes', { id, body }) : c.update('notes', id, { body, n: { $inc: 1 } }), `${who} write ${i}`);
      if (!r) continue;
      if (r.version <= prev) t.fail(`${who}: write ${i} acknowledged at ${r.version}, not after its previous write at ${prev}`);
      prev = r.version;
      const other = owner.get(r.version);
      if (other) t.fail(`version ${r.version} acknowledged to ${who} and to ${other}`);
      owner.set(r.version, who);
      const f = await ok(t, c.from('notes').where({ id }).fetch(), `${who} read ${i}`);
      if (f) {
        if (f.version < r.version) t.fail(`R6 ${who}: fetch at version ${f.version} after its write at ${r.version}`);
        if (f.rows[0]?.body !== body) t.fail(`R6 ${who}: read ${JSON.stringify(f.rows[0]?.body)} after writing ${JSON.stringify(body)} at v${r.version}`);
      }
      if (i % 10 === 9) {
        const sub = c.from('notes').where({ id }).subscribe(() => {});
        const s = await ok(t, withTimeout<any>(sub.ready, 15_000, 'ready'), `${who} subscribe ${i}`);
        if (s && (s.version < r.version || s.rows[0]?.body !== body)) t.fail(`R6 ${who}: first snapshot at v${s.version} with ${JSON.stringify(s.rows[0]?.body)} after writing ${JSON.stringify(body)} at v${r.version}`);
        sub.unsubscribe();
      }
    }
  }));
}

/** `$inc` and unique indexes under concurrent writes through all three nodes. */
async function concurrentWrites(t: CaseCtx): Promise<void> {
  const { nodes, db } = await setup(t);
  const clients = nodes.map((n) => client(t, n.url, db));
  await must(t, clients[0].insert('notes', { id: 'ctr' }), 'insert the counter');
  let top = 0;
  await Promise.all(clients.map(async (c, k) => {
    for (let i = 0; i < 100; i++) {
      const r = await ok(t, c.update('notes', 'ctr', { n: { $inc: 1 } }), `${nodes[k]!.nodeId} $inc ${i}`);
      if (r) top = Math.max(top, r.version);
    }
  }));
  for (const [k, c] of clients.entries()) {
    const f = await ok(t, c.from('notes').where({ id: 'ctr' }).fetch({ minVersion: top }), `counter on ${nodes[k]!.nodeId}`);
    if (f) t.eq(f.rows[0]?.n, 300, `counter on ${nodes[k]!.nodeId} after 3 × 100 increments`);
  }
  for (let round = 0; round < 20; round++) {
    const results = await Promise.allSettled(clients.map((c, k) => c.insert('notes', { id: `r${round}_${k}`, u: `v${round}` })));
    const won = results.filter((r) => r.status === 'fulfilled').length;
    const lost = results.filter((r) => r.status === 'rejected' && r.reason?.code === 'CONSTRAINT_VIOLATION' && r.reason?.outcome === 'not_applied').length;
    if (won !== 1 || lost !== 2) {
      t.fail(`round ${round}: concurrent inserts of one unique value: ${results.map((r) => (r.status === 'fulfilled' ? 'acknowledged' : `${r.reason?.code}/${r.reason?.outcome}`)).join(', ')}; expected one acknowledged and two CONSTRAINT_VIOLATION/not_applied`);
    }
  }
}

const suite: Suite = {
  id: 'D3',
  level: 'L2',
  weight: 2,
  needsSdk: true,
  cases: (_seeds, scale) => [
    { name: 'forwarding and errors', fresh: true, run: forwarding },
    { name: 'read-your-writes on every node', fresh: true, run: (t: CaseCtx) => readYourWrites(t, scale) },
    { name: 'concurrent $inc and unique values', fresh: true, run: concurrentWrites },
  ],
};
export default suite;
