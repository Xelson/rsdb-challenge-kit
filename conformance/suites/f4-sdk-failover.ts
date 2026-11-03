/**
 * F4 SDK failover (SPEC §13.5, §11.2, R10): a client whose first URL is a node that dies (SIGKILL of a follower, SIGKILL of the
 * leader) or goes silent (a proxy that stops forwarding without closing anything) reconnects to another URL within 5 s (the judge
 * allows 1 s more for the reconnect itself). Its subscriptions converge on the writes made meanwhile through other nodes, keep
 * R2/R3/R5 across the gap, and a subscription whose result did not change gets no callback at all (no repeated initial snapshot).
 * Afterwards the client writes and reads its own write (R6).
 */
import type { ConnectionStatus, QueryIR } from '@rsdb/client';
import { canonical } from '../voter/voter.ts';
import { client, must, ok, withTimeout } from '../lib/client.ts';
import { NOTES, leaderOf, nodeById } from '../lib/cluster.ts';
import { sleep, type NodeHandle } from '../lib/env.ts';
import { Observer } from '../lib/observe.ts';
import { CutProxy } from '../lib/proxy.ts';
import type { CaseCtx, Suite } from '../lib/suite.ts';

type Fault = 'follower' | 'leader' | 'silent';
const RECONNECT_MS = 6000;

const rowsIR = (table: string): QueryIR => ({ format: 'rsdb-query/1', kind: 'rows', table, where: null, orderBy: [], limit: null, select: null });

async function failover(t: CaseCtx, fault: Fault): Promise<void> {
  const { env, nodes } = await t.env('cluster');
  const { name: db } = await t.database(nodes[0]!.url, NOTES, 'f4');
  const leader = nodeById(nodes, await leaderOf(t, nodes, db));
  const target = fault === 'leader' ? leader : t.rng.pick(nodes.filter((n) => n !== leader));
  const others = nodes.filter((n) => n !== target);
  let first = target.url;
  let proxy: CutProxy | null = null;
  if (fault === 'silent') {
    proxy = new CutProxy(target.url);
    first = await proxy.start();
    t.defer(() => proxy!.close());
  }
  const c = client(t, [first, ...others.map((n) => n.url)], db);
  const writer = client(t, others.map((n) => n.url), db);
  const statuses: { s: ConnectionStatus; at: number }[] = [];
  c.onStatus((s: ConnectionStatus) => statuses.push({ s, at: Date.now() }));

  for (let i = 0; i < 10; i++) await must(t, writer.insert('notes', { id: `a${i}`, body: `${i}` }), `insert a${i}`);
  await must(t, writer.insert('quiet', { id: 'q', x: 1 }), 'insert into quiet');
  const rows = new Observer(t, { label: 'notes', query: rowsIR('notes') }).attach(c.from('notes').subscribe((s: any) => rows.listener(s)));
  const count = new Observer(t, { label: 'count', query: { format: 'rsdb-query/1', kind: 'count', table: 'notes', where: null } });
  count.attach(c.from('notes').count().subscribe(count.listener));
  const quiet = new Observer(t, { label: 'quiet', query: rowsIR('quiet') }).attach(c.from('quiet').subscribe((s: any) => quiet.listener(s)));
  for (const o of [rows, count, quiet]) await must(t, withTimeout(o.sub.ready, 15_000, 'ready'), `${o.label} ready`);
  await must(t, c.waitForVersion(writer.lastWriteVersion), 'waitForVersion before the fault');
  // A replica may have served first snapshots from before the writer's inserts (R6 binds only c's own writes); from here on
  // `quiet` holds its final result and must stay silent.
  const quietCalls = quiet.calls;
  const sampler = setInterval(() => [rows, count, quiet].forEach((o) => o.sample()), 50);
  t.defer(() => clearInterval(sampler));

  const at = Date.now();
  if (proxy) proxy.freeze();
  else await env.kill(target);
  t.log(`${fault === 'silent' ? 'froze the connection to' : 'SIGKILL'} ${target.nodeId}${target === leader ? ' (leader)' : ''}`);

  // Writes go on through the surviving nodes (a new leader may take a few seconds).
  for (let i = 10; i < 50; i++) {
    await writer.insert('notes', { id: `a${i}`, body: `${i}` }).catch(() => {});
    await sleep(150);
  }
  const reopened = statuses.find((x) => x.s === 'open' && x.at > at && statuses.some((y) => y.s !== 'open' && y.at >= at && y.at <= x.at));
  if (!reopened) t.failTime(`the client never reconnected after the fault (status changes: ${statuses.filter((x) => x.at >= at).map((x) => `${x.s}@${x.at - at}ms`).join(', ') || 'none'})`);
  else if (reopened.at - at > RECONNECT_MS) t.failTime(`the client reconnected ${reopened.at - at} ms after the fault (bound 5 s + 1 s)`);
  else t.log(`reconnected ${reopened.at - at} ms after the fault`);

  // Convergence on the writes made meanwhile (R4, R10), then R7 against a fetch at the same version.
  const truth = await must(t, writer.from('notes').fetch(), 'fetch through the writer');
  try {
    await c.waitForVersion(truth.version, { timeoutMs: 10_000 });
  } catch (e: any) {
    t.failTime(`R10: the client did not reach v${truth.version} within 10 s after the fault (${e?.code ?? e})`);
  }
  const cur = rows.sub.current;
  if (cur && cur.version <= truth.version && rows.sub.syncedVersion >= truth.version) {
    t.eq(canonical(cur.rows), canonical(truth.rows), `R10 rows after the failover (current v${cur.version}, fetch v${truth.version})`);
    const n = count.sub.current;
    if (n && n.version <= truth.version && count.sub.syncedVersion >= truth.version) t.eq(n.count, truth.rows.length, 'R10 count after the failover');
  }
  if (quiet.calls !== quietCalls) t.fail(`R10: the subscription to an unchanged table got ${quiet.calls - quietCalls} callback(s) across the failover`);

  // The client writes through its new node and reads its write (R6).
  const r = await ok(t, c.insert('notes', { id: 'after', body: 'x' }), 'insert after the failover');
  if (r) {
    const f = await ok(t, c.from('notes').where({ id: 'after' }).fetch(), 'read-your-write after the failover');
    if (f && (f.version < r.version || f.rows.length !== 1)) t.fail(`R6 after the failover: fetch at v${f.version} with ${f.rows.length} rows after a write at v${r.version}`);
  }
  if (!proxy) await env.restart(target).catch(() => {});
}

const suite: Suite = {
  id: 'F4',
  level: 'L3',
  weight: 1,
  needsSdk: true,
  cases: () => (['follower', 'leader', 'silent'] as Fault[]).map((f) => ({
    name: f === 'silent' ? 'silent connection' : `killed ${f}`,
    fresh: true,
    run: (t: CaseCtx) => failover(t, f),
  })),
};
export default suite;
