/**
 * Suite T7 — compile-time API tests (SPEC §9, §13).
 * Run: `tsc --noEmit -p kit/tsconfig.json` with `@rsdb/client` resolving to the submission's built package.
 * Every `@ts-expect-error` line MUST fail to type-check; everything else MUST pass.
 */
import {
  createClient,
  defineSchema,
  RsdbError,
  t,
  table,
  type CountSnapshot,
  type InsertRow,
  type Patch,
  type Row,
  type RowsSnapshot,
  type UpsertRow,
} from '@rsdb/client';

type Equal<A, B> = (<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

const schema = defineSchema({
  tables: {
    users: table({
      name: t.string(),
      age: t.int().optional(),
      active: t.bool().default(true),
      meta: t.json<{ tags: string[] }>().optional(),
    }).index('by_age', ['age']),
    todos: table({
      ownerId: t.string(),
      title: t.string(),
      done: t.bool().default(false),
      score: t.float(),
      createdAt: t.int(),
    }).index('by_owner_created', ['ownerId', 'createdAt'], { unique: false }),
  },
});
type S = typeof schema;

// ── Derived row types ─────────────────────────────────────────────────────
export type T01 = Expect<
  Equal<Row<S, 'users'>, { id: string; name: string; age: number | null; active: boolean; meta: { tags: string[] } | null }>
>;
export type T02 = Expect<
  Equal<InsertRow<S, 'users'>, { id?: string; name: string; age?: number | null; active?: boolean; meta?: { tags: string[] } | null }>
>;
export type T03 = Expect<
  Equal<
    InsertRow<S, 'todos'>,
    { id?: string; ownerId: string; title: string; done?: boolean; score: number; createdAt: number }
  >
>;
export type T04 = Expect<Equal<UpsertRow<S, 'todos'>['id'], string>>;
export type T05 = Expect<Equal<Patch<S, 'todos'>['createdAt'], number | { $inc: number } | undefined>>;
export type T06 = Expect<Equal<Patch<S, 'todos'>['title'], string | undefined>>;

// ── Schema DSL errors ─────────────────────────────────────────────────────
// @ts-expect-error `id` is reserved
table({ id: t.string() });
// @ts-expect-error index on an unknown column
table({ a: t.int() }).index('by_b', ['b']);
// @ts-expect-error index needs at least one column
table({ a: t.int() }).index('empty', []);
// @ts-expect-error default must match the column type
t.int().default('x');
// @ts-expect-error json columns cannot be indexed
table({ a: t.int(), m: t.json() }).index('by_m', ['m']);

const db = createClient({ url: 'http://127.0.0.1:7700', database: 'app', schema });

export async function queries(): Promise<void> {
  // ── Valid queries ───────────────────────────────────────────────────────
  db.from('todos').where({ done: false, createdAt: { gt: 5, lte: 10 } }).orderBy('createdAt', 'desc').limit(10);
  db.from('todos').where({ $or: [{ ownerId: 'a' }, { ownerId: { in: ['b', 'c'] } }] });
  db.from('todos').where({ title: { startsWith: 'wr' } }).where({ id: { ne: 'x' } });
  db.from('users').where({ age: null }).orderBy('age').orderBy('name', 'asc');
  db.from('users').where({ age: { ne: null, gte: 18 } });
  db.from('todos').orderBy('id', 'desc');

  // ── Invalid queries ─────────────────────────────────────────────────────
  // @ts-expect-error unknown table
  db.from('nope');
  // @ts-expect-error unknown column in a filter
  db.from('todos').where({ titel: 'x' });
  // @ts-expect-error wrong literal type
  db.from('todos').where({ done: 'yes' });
  // @ts-expect-error range operators are not defined on bool
  db.from('todos').where({ done: { gt: true } });
  // @ts-expect-error startsWith is only defined on strings
  db.from('todos').where({ createdAt: { startsWith: '1' } });
  // @ts-expect-error json columns are not filterable
  db.from('users').where({ meta: null });
  // @ts-expect-error json columns are not sortable
  db.from('users').orderBy('meta');
  // @ts-expect-error null is not allowed for range operators
  db.from('users').where({ age: { gt: null } });
  // @ts-expect-error select needs at least one column
  db.from('todos').select();
  // @ts-expect-error select of an unknown column
  db.from('todos').select('nope');

  // ── Result types ────────────────────────────────────────────────────────
  const full = await db.from('users').fetch();
  type FullRow = (typeof full.rows)[number];
  type _full = Expect<Equal<FullRow, Row<S, 'users'>>>;

  const projected = db.from('todos').select('title', 'createdAt').subscribe((snap) => {
    type R = (typeof snap.rows)[number];
    type _r = Expect<Equal<R, { id: string; title: string; createdAt: number }>>;
    type _s = Expect<Equal<typeof snap, RowsSnapshot<{ id: string; title: string; createdAt: number }>>>;
    if (snap.diff) {
      const removed: readonly string[] = snap.diff.removed;
      const fromVersion: number = snap.diff.fromVersion;
      void removed;
      void fromVersion;
    }
  });
  const first = await projected.ready;
  const v: number = first.version;
  const synced: number = projected.syncedVersion;
  projected.onError((e) => {
    const code: RsdbError['code'] = e.code;
    void code;
  });
  projected.unsubscribe();

  const counter = db.from('todos').where({ done: false }).count().subscribe((snap) => {
    type _c = Expect<Equal<typeof snap, CountSnapshot>>;
  });
  const n: number = (await counter.ready).count;
  const fetched: number = (await db.from('todos').count().fetch({ minVersion: 0 })).count;
  void v, synced, n, fetched;

  const ir = db.from('todos').where({ done: false }).limit(5).toIR();
  const kind: 'rows' = ir.kind;
  const countKind: 'count' = db.from('todos').count().toIR().kind;
  void kind, countKind;
}

export async function mutations(): Promise<void> {
  // ── Valid mutations ─────────────────────────────────────────────────────
  const { id, version } = await db.insert('todos', { ownerId: 'u1', title: 'x', score: 1.5, createdAt: 1 });
  await db.insert('users', { id: 'u1', name: 'Ann' });
  await db.upsert('users', { id: 'u1', name: 'Ann', age: 30, meta: { tags: [] } });
  await db.update('todos', id, { done: true, score: { $inc: 0.5 }, createdAt: { $inc: 1 } });
  await db.update('users', 'u1', { age: null });
  const { deleted } = await db.delete('todos', id);
  const { count } = await db.updateWhere('todos', { done: true }, { done: false });
  await db.deleteWhere('todos', {});
  const batch = await db.batch((tx) => {
    tx.insert('todos', { ownerId: 'u1', title: 'y', score: 0, createdAt: 2 });
    tx.update('users', 'u1', { name: 'Bob' });
    tx.deleteWhere('todos', { createdAt: { lt: 0 } });
    // @ts-expect-error missing required columns inside a batch
    tx.insert('todos', { title: 'z' });
  });
  const last: number = db.lastWriteVersion;
  await db.waitForVersion(batch.version, { timeoutMs: 5_000 });
  void version, deleted, count, last;

  // ── Invalid mutations ───────────────────────────────────────────────────
  // @ts-expect-error missing required column
  await db.insert('todos', { title: 'x', score: 1, createdAt: 1 });
  // @ts-expect-error unknown column
  await db.insert('users', { name: 'a', nickname: 'b' });
  // @ts-expect-error upsert requires id
  await db.upsert('users', { name: 'a' });
  // @ts-expect-error $inc is not defined on strings
  await db.update('todos', 'id', { title: { $inc: 1 } });
  // @ts-expect-error null into a required column
  await db.update('users', 'u1', { name: null });
  // @ts-expect-error id cannot be patched
  await db.update('users', 'u1', { id: 'u2' });
  // @ts-expect-error wrong value type
  await db.updateWhere('todos', {}, { createdAt: 'now' });
}

// ── Untyped client (fuzzers, other tools) stays usable ────────────────────
export async function untyped(): Promise<void> {
  const loose = createClient({ url: ['http://n1:7700', 'http://n2:7700'], database: 'fuzz' });
  await loose.insert('anything', { id: 'a', x: 1 });
  loose.from('anything').where({ x: { gt: 1 } }).orderBy('x').select('x');
  const err = new RsdbError('TIMEOUT', 'timed out', { outcome: null });
  const code: 'TIMEOUT' | string = err.code;
  void code;
}
