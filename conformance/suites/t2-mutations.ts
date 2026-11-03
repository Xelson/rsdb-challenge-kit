/**
 * T2 Mutations (SPEC §13.5): every operation and error code of §7, batch atomicity and `opIndex`, defaults, `$inc`, value rules
 * (§5.2) and size limits (§5.3, §6.2, §7.2). Expected results are literal.
 */
import type { SchemaIR } from '@rsdb/client';
import { api, createDb, dbInfo, dropDb, errorCode, pushOk } from '../lib/admin.ts';
import { client, must, mutRejects, ok, open, readRejects, rejects, type AnyClient } from '../lib/client.ts';
import { sleep } from '../lib/env.ts';
import type { CaseCtx, Suite } from '../lib/suite.ts';

const S: SchemaIR = {
  format: 'rsdb-schema/1',
  tables: {
    users: {
      columns: {
        name: { type: 'string', nullable: false },
        age: { type: 'int', nullable: true },
        score: { type: 'float', nullable: false, default: 0.5 },
        active: { type: 'bool', nullable: false, default: true },
        meta: { type: 'json', nullable: true },
        tags: { type: 'json', nullable: false, default: ['x'] },
        email: { type: 'string', nullable: true },
      },
      indexes: [
        { name: 'u_email', columns: ['email'], unique: true },
        { name: 'by_age', columns: ['age'], unique: false },
      ],
    },
    counters: {
      columns: {
        n: { type: 'int', nullable: false, default: 0 },
        f: { type: 'float', nullable: true },
        j: { type: 'json', nullable: true },
        s: { type: 'string', nullable: true },
        b: { type: 'bool', nullable: true },
      },
      indexes: [],
    },
    wide: {
      columns: Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`c${i}`, { type: 'int' as const, nullable: true }])),
      indexes: [],
    },
  },
};

/** A users row as fetched: every column, defaults and NULLs filled in. */
const user = (id: string, o: Record<string, unknown>) => ({ id, age: null, score: 0.5, active: true, meta: null, tags: ['x'], email: null, ...o });

const GENERATED_ID = /^[0-9A-Za-z_-]{1,64}$/;

async function all(t: CaseCtx, c: AnyClient, table: string): Promise<any[]> {
  const r = await must(t, c.from(table).fetch(), `fetch ${table}`);
  return r.rows;
}
async function one(t: CaseCtx, c: AnyClient, table: string, id: string): Promise<any> {
  const r = await must(t, c.from(table).where({ id }).fetch(), `fetch ${table}/${id}`);
  return r.rows[0];
}
async function versionOf(url: string, db: string): Promise<number> {
  return (await dbInfo(url, db))!.version;
}

const cases: { name: string; run: (t: CaseCtx) => Promise<void> }[] = [
  {
    name: 'insert: results, defaults, NULLs, generated ids',
    async run(t) {
      const { c, v0 } = await open(t, S);
      const r1 = await must(t, c.insert('users', { name: 'ann' }), 'insert without id');
      t.check(typeof r1.id === 'string' && GENERATED_ID.test(r1.id), `generated id ${JSON.stringify(r1.id)} is not 1–64 chars of [0-9A-Za-z_-]`);
      t.eq(r1.version, v0 + 1, 'version of the first insert');
      t.eq(c.lastWriteVersion, v0 + 1, 'lastWriteVersion');
      const r2 = await must(t, c.insert('users', { id: 'u2', name: 'bob', age: 30, score: 1.25, active: false, meta: { a: [1, { b: null }] }, tags: [], email: 'b@x' }), 'insert with every column');
      t.eq(r2, { id: 'u2', version: v0 + 2 }, 'insert result');
      await must(t, c.insert('users', { id: 'u3', name: 'cy', age: undefined, meta: null }), 'insert with undefined and null');
      const r4 = await must(t, c.insert('users', { name: 'dee' }), 'second insert without id');
      t.check(r4.id !== r1.id, 'generated ids repeat');
      const rows = await all(t, c, 'users');
      const byId = new Map(rows.map((r) => [r.id, r]));
      t.eq(byId.get(r1.id), user(r1.id, { name: 'ann' }), 'row with defaults');
      t.eq(byId.get('u2'), user('u2', { name: 'bob', age: 30, score: 1.25, active: false, meta: { a: [1, { b: null }] }, tags: [], email: 'b@x' }), 'row with every column');
      t.eq(byId.get('u3'), user('u3', { name: 'cy' }), 'undefined is absent; null in an optional json column is NULL');
      t.eq(rows.length, 4, 'row count');
      const f = await must(t, c.from('users').fetch(), 'fetch');
      t.eq(f.version, v0 + 4, 'fetch version after four inserts');
      const b = await must(t, c.batch((tx: any) => { tx.insert('counters', {}); tx.insert('counters', {}); tx.insert('counters', { id: 'k' }); }), 'batch of inserts');
      const ids = b.results.map((r: any) => r.id);
      t.check(ids.slice(0, 2).every((id: unknown) => typeof id === 'string' && GENERATED_ID.test(id)) && ids[0] !== ids[1], `generated ids in one batch: ${JSON.stringify(ids)}`);
      t.eq(ids[2], 'k', 'client id in a batch');
      t.eq(await one(t, c, 'counters', 'k'), { id: 'k', n: 0, f: null, j: null, s: null, b: null }, 'counters row with defaults');
    },
  },
  {
    name: 'insert: error codes and precedence',
    async run(t) {
      const { c, url, db } = await open(t, S);
      await must(t, c.insert('users', { id: 'u2', name: 'bob', email: 'b@x' }), 'insert u2');
      await must(t, c.insert('users', { id: 'n1', name: 'n' }), 'insert n1 with NULL email');
      await must(t, c.insert('users', { id: 'n2', name: 'n' }), 'NULLs are distinct in unique indexes');
      const v = await versionOf(url, db);
      const ins = (row: unknown, table = 'users') => c.insert(table, row);
      await mutRejects(t, ins({ id: 'u2', name: 'x' }), 'DUPLICATE_ID', 'existing id');
      await mutRejects(t, ins({ name: 'x', nope: 1 }), 'UNKNOWN_FIELD', 'unknown field');
      await mutRejects(t, ins({ name: 'x' }, 'nope'), 'UNKNOWN_TABLE', 'unknown table');
      await mutRejects(t, ins({ name: 'x', email: 'b@x' }), 'CONSTRAINT_VIOLATION', 'unique index');
      const typeErrors: [string, unknown][] = [
        ['missing required column', {}],
        ['null in a required column', { name: null }],
        ['number for string', { name: 5 }],
        ['fraction for int', { name: 'x', age: 1.5 }],
        ['unsafe int', { name: 'x', age: 2 ** 53 }],
        ['string for int', { name: 'x', age: '1' }],
        ['string for float', { name: 'x', score: 'a' }],
        ['number for bool', { name: 'x', active: 1 }],
        ['null in a required json column', { name: 'x', tags: null }],
        ['lone surrogate', { name: 'a\uD800' }],
        ['U+0000', { name: 'a\u0000b' }],
        ['NaN', { name: 'x', score: NaN }],
        ['Infinity', { name: 'x', score: Infinity }],
        ['NaN in an optional column', { name: 'x', age: NaN }],
        ['U+0000 in an id', { id: 'a\u0000', name: 'x' }],
        ['lone surrogate in an id', { id: '\uDC00', name: 'x' }],
      ];
      for (const [what, row] of typeErrors) await mutRejects(t, ins(row), 'TYPE_ERROR', what);
      await mutRejects(t, ins({ id: '', name: 'x' }), 'INVALID_ARGUMENT', 'empty id');
      await mutRejects(t, ins({ id: 'é'.repeat(64) + 'a', name: 'x' }), 'INVALID_ARGUMENT', 'id of 129 bytes');
      await mutRejects(t, ins({ id: 5, name: 'x' }), 'INVALID_ARGUMENT', 'numeric id');
      await mutRejects(t, ins({ id: '', nope: 1 }), 'INVALID_ARGUMENT', 'INVALID_ARGUMENT before UNKNOWN_FIELD');
      await mutRejects(t, ins({ nope: 1, name: 5 }), 'UNKNOWN_FIELD', 'UNKNOWN_FIELD before TYPE_ERROR');
      await mutRejects(t, ins({ id: 'u2', name: 5 }), 'TYPE_ERROR', 'TYPE_ERROR before DUPLICATE_ID');
      await mutRejects(t, ins({ id: '' }, 'nope'), 'UNKNOWN_TABLE', 'UNKNOWN_TABLE before INVALID_ARGUMENT');
      t.eq(await versionOf(url, db), v, 'version after rejected inserts');
      t.eq((await all(t, c, 'users')).length, 3, 'rows after rejected inserts');
      const r = await must(t, ins({ id: 'é'.repeat(64), name: 'x' }), 'id of 128 bytes');
      t.eq(r.version, v + 1, 'rejected mutations consume no version');
      await must(t, ins({ id: '\u{1F600}', name: 'x' }), 'astral-plane id');
    },
  },
  {
    name: 'upsert: insert, full replace, errors',
    async run(t) {
      const { c } = await open(t, S);
      t.eq(await must(t, c.upsert('users', { id: 'p1', name: 'a', age: 5, email: 'p@x', meta: { m: 1 } }), 'upsert new').then((r: any) => r.id), 'p1', 'upsert result id');
      t.eq(await one(t, c, 'users', 'p1'), user('p1', { name: 'a', age: 5, email: 'p@x', meta: { m: 1 } }), 'upsert inserts');
      await must(t, c.upsert('users', { id: 'p1', name: 'b' }), 'upsert existing');
      t.eq(await one(t, c, 'users', 'p1'), user('p1', { name: 'b' }), 'upsert replaces the whole row; omitted columns take default or NULL');
      await mutRejects(t, c.upsert('users', { name: 'x' }), 'INVALID_ARGUMENT', 'upsert without id');
      await mutRejects(t, c.upsert('users', { id: 'p1' }), 'TYPE_ERROR', 'upsert missing a required column');
      await mutRejects(t, c.upsert('users', { id: 'p1', name: 'x', nope: 1 }), 'UNKNOWN_FIELD', 'upsert unknown field');
      await must(t, c.upsert('users', { id: 'p2', name: 'c', email: 'q@x' }), 'upsert p2');
      await mutRejects(t, c.upsert('users', { id: 'p1', name: 'b', email: 'q@x' }), 'CONSTRAINT_VIOLATION', 'upsert into a taken unique value');
      await must(t, c.upsert('users', { id: 'p2', name: 'c2', email: 'q@x' }), 'upsert keeping its own unique value');
      const b = await must(t, c.batch((tx: any) => tx.upsert('users', { id: 'p3', name: 'd' })), 'upsert in a batch');
      t.eq(b.results, [{ id: 'p3' }], 'batch result of upsert');
    },
  },
  {
    name: 'update: partial, NULL, errors and precedence',
    async run(t) {
      const { c, url, db } = await open(t, S);
      await must(t, c.insert('users', { id: 'x', name: 'a', age: 1, meta: { k: 1 }, email: 'x@x' }), 'insert x');
      await must(t, c.insert('users', { id: 'y', name: 'b', email: 'y@x' }), 'insert y');
      const r = await must(t, c.update('users', 'x', { age: 2 }), 'update');
      t.eq(Object.keys(r).sort(), ['version'], 'update result keys');
      t.eq(await one(t, c, 'users', 'x'), user('x', { name: 'a', age: 2, meta: { k: 1 }, email: 'x@x' }), 'partial update');
      await must(t, c.update('users', 'x', { age: null, meta: null }), 'set NULL');
      await must(t, c.update('users', 'x', { age: undefined, name: 'z' }), 'undefined key in a patch');
      await must(t, c.update('users', 'x', { tags: { $inc: 1 } }), '$inc on json');
      t.eq(await one(t, c, 'users', 'x'), user('x', { name: 'z', email: 'x@x', tags: { $inc: 1 } }), 'after NULLs, undefined and json $inc');
      const v = await versionOf(url, db);
      await mutRejects(t, c.update('users', 'missing', { age: 1 }), 'NOT_FOUND', 'missing id');
      await mutRejects(t, c.update('users', 'x', {}), 'INVALID_ARGUMENT', 'empty set');
      await mutRejects(t, c.update('users', 'x', { id: 'q' }), 'INVALID_ARGUMENT', 'id in set');
      await mutRejects(t, c.update('users', 'x', { age: undefined }), 'INVALID_ARGUMENT', 'set empty after dropping undefined');
      await mutRejects(t, c.update('users', '', { age: 1 }), 'INVALID_ARGUMENT', 'empty id');
      await mutRejects(t, c.update('users', 'x', { name: null }), 'TYPE_ERROR', 'NULL in a required column');
      await mutRejects(t, c.update('users', 'x', { age: 'a' }), 'TYPE_ERROR', 'string for int');
      await mutRejects(t, c.update('users', 'x', { nope: 1 }), 'UNKNOWN_FIELD', 'unknown field');
      await mutRejects(t, c.update('nope', 'x', { age: 1 }), 'UNKNOWN_TABLE', 'unknown table');
      await mutRejects(t, c.update('users', 'missing', { nope: 1 }), 'UNKNOWN_FIELD', 'UNKNOWN_FIELD before NOT_FOUND');
      await mutRejects(t, c.update('users', 'missing', { age: 'a' }), 'TYPE_ERROR', 'TYPE_ERROR before NOT_FOUND');
      await mutRejects(t, c.update('users', 'missing', {}), 'INVALID_ARGUMENT', 'INVALID_ARGUMENT before NOT_FOUND');
      await mutRejects(t, c.update('users', 'x', { email: 'y@x' }), 'CONSTRAINT_VIOLATION', 'unique index');
      t.eq(await versionOf(url, db), v, 'version after rejected updates');
      t.eq(await one(t, c, 'users', 'x'), user('x', { name: 'z', email: 'x@x', tags: { $inc: 1 } }), 'row after rejected updates');
    },
  },
  {
    name: '$inc: ints, floats, NULL, overflow',
    async run(t) {
      const { c } = await open(t, S);
      await must(t, c.insert('counters', { id: 'c1', n: 5 }), 'insert c1');
      await must(t, c.insert('counters', { id: 'c2' }), 'insert c2');
      const n = async () => (await one(t, c, 'counters', 'c1')) ?? {};
      await must(t, c.update('counters', 'c1', { n: { $inc: 3 } }), '$inc 3');
      t.eq((await n()).n, 8, 'int after $inc 3');
      await must(t, c.update('counters', 'c1', { n: { $inc: -10 } }), '$inc -10');
      t.eq((await n()).n, -2, 'int after $inc -10');
      await must(t, c.update('counters', 'c1', { f: { $inc: 1.5 } }), '$inc on NULL float');
      await must(t, c.update('counters', 'c1', { f: { $inc: 0.25 } }), '$inc 0.25');
      t.eq((await n()).f, 1.75, 'NULL counts as 0');
      await must(t, c.update('counters', 'c1', { j: { $inc: 1 } }), '$inc on json');
      t.eq((await n()).j, { $inc: 1 }, '$inc on json is an ordinary object');
      await mutRejects(t, c.update('counters', 'c1', { n: { $inc: 1.5 } }), 'TYPE_ERROR', 'fractional $inc on int');
      await mutRejects(t, c.update('counters', 'c1', { n: { $inc: NaN } }), 'TYPE_ERROR', '$inc NaN');
      await mutRejects(t, c.update('counters', 'c1', { s: { $inc: 1 } }), 'TYPE_ERROR', '$inc on string');
      await mutRejects(t, c.update('counters', 'c1', { b: { $inc: 1 } }), 'TYPE_ERROR', '$inc on bool');
      await must(t, c.update('counters', 'c1', { n: 9007199254740991, f: 1.7e308 }), 'set extremes');
      await mutRejects(t, c.update('counters', 'c1', { n: { $inc: 1 } }), 'TYPE_ERROR', 'int $inc beyond 2^53-1');
      await mutRejects(t, c.update('counters', 'c1', { f: { $inc: 1e308 } }), 'TYPE_ERROR', 'float $inc to Infinity');
      await must(t, c.update('counters', 'c1', { n: -9007199254740991 }), 'set the minimum');
      await mutRejects(t, c.update('counters', 'c1', { n: { $inc: -1 } }), 'TYPE_ERROR', 'int $inc below -(2^53-1)');
      await must(t, c.update('counters', 'c1', { n: 0, f: null }), 'reset');
      const r = await must(t, c.updateWhere('counters', {}, { n: { $inc: 2 } }), 'updateWhere $inc');
      t.eq(r.count, 2, 'updateWhere count');
      const b = await must(t, c.batch((tx: any) => { tx.update('counters', 'c1', { n: { $inc: 1 } }); tx.update('counters', 'c1', { n: { $inc: 1 }, f: { $inc: 2 } }); }), 'two $inc in one batch');
      t.eq(b.results, [{}, {}], 'batch results of updates');
      t.eq(await all(t, c, 'counters'), [{ id: 'c1', n: 4, f: 2, j: { $inc: 1 }, s: null, b: null }, { id: 'c2', n: 2, f: null, j: null, s: null, b: null }], 'counters');
    },
  },
  {
    name: 'delete: deleted flag, versions, reuse of ids',
    async run(t) {
      const { c } = await open(t, S);
      const v1 = (await must(t, c.insert('users', { id: 'd1', name: 'a' }), 'insert d1')).version;
      t.eq(await must(t, c.delete('users', 'd1'), 'delete d1'), { deleted: true, version: v1 + 1 }, 'delete existing');
      t.eq(await must(t, c.delete('users', 'd1'), 'delete d1 again'), { deleted: false, version: v1 + 2 }, 'delete of a missing id commits a version');
      t.eq(await all(t, c, 'users'), [], 'rows after delete');
      await mutRejects(t, c.delete('users', ''), 'INVALID_ARGUMENT', 'empty id');
      await mutRejects(t, c.delete('nope', 'd1'), 'UNKNOWN_TABLE', 'unknown table');
      await must(t, c.insert('users', { id: 'd1', name: 'b' }), 're-insert a deleted id');
      t.eq(await all(t, c, 'users'), [user('d1', { name: 'b' })], 'rows after re-insert');
    },
  },
  {
    name: 'updateWhere and deleteWhere: counts and errors',
    async run(t) {
      const { c, url, db } = await open(t, S);
      await must(t, c.batch((tx: any) => {
        [1, 2, 3, null, 5].forEach((age, i) => tx.insert('users', { id: `w${i}`, name: i % 2 ? `b${i}` : `a${i}`, age, email: `${i}@x` }));
      }), 'insert five rows');
      const uw = (where: unknown, set: unknown) => c.updateWhere('users', where, set);
      t.eq(await must(t, uw({ age: { gte: 2 } }, { active: false }), 'updateWhere'), { count: 3, version: (await versionOf(url, db)) + 0 }, 'updateWhere result');
      t.eq((await must(t, uw({ age: { gte: 2 } }, { active: false }), 'updateWhere again')).count, 3, 'rows matched count even when unchanged');
      t.eq((await must(t, uw({ age: null }, { age: 0 }), 'updateWhere isNull')).count, 1, 'updateWhere on NULL');
      t.eq((await must(t, uw({}, { score: 2 }), 'updateWhere all')).count, 5, '{} matches every row');
      const v = await versionOf(url, db);
      t.eq(await must(t, uw({ age: { gt: 100 } }, { score: 1 }), 'updateWhere none'), { count: 0, version: v + 1 }, 'updateWhere matching nothing commits a version');
      t.eq(await all(t, c, 'users'), [
        user('w0', { name: 'a0', age: 1, score: 2, email: '0@x' }),
        user('w1', { name: 'b1', age: 2, score: 2, active: false, email: '1@x' }),
        user('w2', { name: 'a2', age: 3, score: 2, active: false, email: '2@x' }),
        user('w3', { name: 'b3', age: 0, score: 2, email: '3@x' }),
        user('w4', { name: 'a4', age: 5, score: 2, active: false, email: '4@x' }),
      ], 'rows after updateWhere');
      const v2 = await versionOf(url, db);
      await mutRejects(t, uw({ meta: { eq: 1 } }, { age: 1 }), 'TYPE_ERROR', 'filter on json');
      await mutRejects(t, uw({ age: { startsWith: '1' } }, { age: 1 }), 'TYPE_ERROR', 'startsWith on int');
      await mutRejects(t, uw({ active: { lt: true } }, { age: 1 }), 'TYPE_ERROR', 'lt on bool');
      await mutRejects(t, uw({ age: 'x' }, { age: 1 }), 'TYPE_ERROR', 'literal type');
      await mutRejects(t, uw({ age: { in: [1, 'a'] } }, { age: 1 }), 'TYPE_ERROR', 'in with a wrong literal');
      await mutRejects(t, uw({ nope: 1 }, { age: 1 }), 'UNKNOWN_FIELD', 'unknown filter field');
      await mutRejects(t, uw({}, {}), 'INVALID_ARGUMENT', 'empty set');
      await mutRejects(t, uw({}, { id: 'x' }), 'INVALID_ARGUMENT', 'id in set');
      await mutRejects(t, uw({ age: { in: Array.from({ length: 1001 }, (_, i) => i) } }, { age: 1 }), 'INVALID_ARGUMENT', 'in with 1,001 values');
      await mutRejects(t, uw({ age: { gte: 2 } }, { email: 'same' }), 'CONSTRAINT_VIOLATION', 'updateWhere violating a unique index');
      await mutRejects(t, c.deleteWhere('users', { meta: { ne: null } }), 'TYPE_ERROR', 'deleteWhere filter on json');
      t.eq(await versionOf(url, db), v2, 'version after rejected *Where operations');
      t.eq((await must(t, uw({ age: { in: Array.from({ length: 1000 }, (_, i) => i) } }, { meta: [1] }), 'in with 1,000 values')).count, 5, 'in with 1,000 values');
      t.eq((await must(t, c.deleteWhere('users', { name: { startsWith: 'a' } }), 'deleteWhere')).count, 3, 'deleteWhere count');
      t.eq((await must(t, c.deleteWhere('users', {}), 'deleteWhere all')).count, 2, 'deleteWhere {}');
      t.eq(await all(t, c, 'users'), [], 'rows after deleteWhere {}');
    },
  },
  {
    name: 'batch: order, atomicity, opIndex',
    async run(t) {
      const { c, url, db } = await open(t, S);
      const b = await must(t, c.batch((tx: any) => {
        tx.insert('users', { id: 'b1', name: 'a' });
        tx.insert('users', { id: 'b2', name: 'b' });
        tx.update('users', 'b1', { age: 1 });
        tx.delete('users', 'b2');
        tx.update('users', 'b1', { age: { $inc: 1 } });
        tx.updateWhere('users', { age: 2 }, { score: 3 });
        tx.deleteWhere('users', { id: 'b2' });
      }), 'batch of every kind');
      const v = await versionOf(url, db);
      t.eq(b, { version: v, results: [{ id: 'b1' }, { id: 'b2' }, {}, { deleted: true }, {}, { count: 1 }, { count: 0 }] }, 'batch result');
      t.eq(await all(t, c, 'users'), [user('b1', { name: 'a', age: 2, score: 3 })], 'later operations see earlier ones');
      const batch = (ops: (tx: any) => void) => c.batch(ops);
      await mutRejects(t, batch((tx) => { tx.insert('users', { id: 'b3', name: 'c' }); tx.update('users', 'missing', { age: 1 }); }), 'NOT_FOUND', 'failing second operation', 1);
      await mutRejects(t, batch((tx) => { tx.insert('users', { id: 'b4', name: 'd' }); tx.insert('users', { id: 'b4', name: 'd' }); }), 'DUPLICATE_ID', 'duplicate inside the batch', 1);
      await mutRejects(t, batch((tx) => { tx.update('users', 'b1', { nope: 1 }); tx.insert('users', { id: '', name: 'x' }); }), 'UNKNOWN_FIELD', 'the first failing operation wins over a higher-ranked error later', 0);
      await mutRejects(t, batch((tx) => { tx.delete('users', 'b1'); tx.update('users', 'b1', { age: 1 }); }), 'NOT_FOUND', 'update after delete in one batch', 1);
      await mutRejects(t, batch((tx) => { tx.insert('users', { id: 'b5', name: 'e', email: 'e' }); tx.insert('users', { id: 'b6', name: 'f' }); tx.update('users', 'b6', { email: 'e' }); }), 'CONSTRAINT_VIOLATION', 'unique conflict with an earlier operation', 2);
      await mutRejects(t, batch(() => {}), 'INVALID_ARGUMENT', 'empty batch', null);
      t.eq(await versionOf(url, db), v, 'version after rejected batches');
      t.eq(await all(t, c, 'users'), [user('b1', { name: 'a', age: 2, score: 3 })], 'rows after rejected batches');
      await must(t, batch((tx) => { tx.insert('users', { id: 'b5', name: 'e' }); tx.delete('users', 'b5'); tx.insert('users', { id: 'b5', name: 'e2' }); }), 'insert, delete, insert of one id');
      t.eq(await one(t, c, 'users', 'b5'), user('b5', { name: 'e2' }), 'row after insert, delete, insert');
      await mutRejects(t, batch((tx) => { for (let i = 0; i < 10_001; i++) tx.insert('counters', { id: `k${i}` }); }), 'INVALID_ARGUMENT', '10,001 operations', null);
      await mutRejects(t, batch((tx) => { for (let i = 0; i < 9_999; i++) tx.insert('counters', { id: `k${i}` }); tx.insert('counters', { id: 'k5' }); }), 'DUPLICATE_ID', 'failure at the last of 10,000 operations', 9_999);
      const big = await must(t, batch((tx) => { for (let i = 0; i < 10_000; i++) tx.insert('counters', { id: `k${i}`, n: i }); }), '10,000 operations');
      t.eq(big.results.length, 10_000, 'results of 10,000 operations');
      t.eq(big.version, v + 2, 'version of the 10,000-operation batch');
      t.eq((await must(t, c.from('counters').count().fetch(), 'count')).count, 10_000, 'rows after 10,000 inserts');
    },
  },
  {
    name: 'size limits: rows and batches',
    async run(t) {
      const { c, url, db } = await open(t, S);
      const MiB = 1 << 20;
      const under = 'x'.repeat(MiB - 1024);
      await must(t, c.insert('users', { id: 'big', name: under }), 'row under 1 MiB');
      t.eq((await one(t, c, 'users', 'big'))?.name?.length, under.length, 'large string round trip');
      const v = await versionOf(url, db);
      await mutRejects(t, c.insert('users', { id: 'big2', name: 'x'.repeat(MiB + 1024) }), 'INVALID_ARGUMENT', 'row over 1 MiB');
      await mutRejects(t, c.insert('users', { id: 'big3', name: 'é'.repeat(MiB / 2 + 512) }), 'INVALID_ARGUMENT', 'row over 1 MiB in UTF-8 bytes, under in UTF-16 units');
      await mutRejects(t, c.update('users', 'big', { meta: 'y'.repeat(MiB + 1024) }), 'INVALID_ARGUMENT', 'update making a row over 1 MiB');
      const chunk = 'z'.repeat(1_000_000);
      await mutRejects(t, c.batch((tx: any) => { for (let i = 0; i < 17; i++) tx.insert('counters', { id: `c${i}`, s: chunk }); }), 'INVALID_ARGUMENT', 'batch over 16 MiB', null);
      t.eq(await versionOf(url, db), v, 'version after rejected sizes');
      const r = await must(t, c.batch((tx: any) => { for (let i = 0; i < 16; i++) tx.insert('counters', { id: `c${i}`, s: chunk }); }), 'batch of 16 MB');
      t.eq(r.version, v + 1, 'version of the 16 MB batch');
      const rows = (await must(t, c.from('counters').select('s').fetch(), 'fetch 16 MB')).rows;
      t.check(rows.length === 16 && rows.every((x: any) => x.s === chunk), '16 MB of rows round trip');
    },
  },
  {
    name: 'values: -0, extremes, Unicode, JSON',
    async run(t) {
      const { c } = await open(t, S);
      const json = { b: [1, 'é', { '\u{1F600}': null }], a: { z: -1.5e300, y: true, x: '' }, '': [[[]]] };
      await must(t, c.insert('users', { id: 'v1', name: '', age: 9007199254740991, score: -0, meta: json, tags: [0] }), 'insert extremes');
      await must(t, c.insert('users', { id: 'v2', name: '\u{1F600}é￿', age: -9007199254740991, score: 5e-324, meta: 'str', tags: 1.7976931348623157e308 }), 'insert extremes 2');
      await must(t, c.insert('users', { id: 'v3', name: 'x'.repeat(10_000), score: 0.1, meta: false, tags: { k: { $inc: 1 } } }), 'insert 3');
      const rows = await all(t, c, 'users');
      t.eq(rows, [
        user('v1', { name: '', age: 9007199254740991, score: 0, meta: json, tags: [0] }),
        user('v2', { name: '\u{1F600}é￿', age: -9007199254740991, score: 5e-324, meta: 'str', tags: 1.7976931348623157e308 }),
        user('v3', { name: 'x'.repeat(10_000), score: 0.1, meta: false, tags: { k: { $inc: 1 } } }),
      ], 'values round trip');
      t.check(Object.is(rows[0]?.score, 0), '-0 must be stored and returned as 0');
      const zero = await must(t, c.from('users').where({ score: 0 }).fetch(), 'filter score = 0');
      t.eq(zero.rows.map((r: any) => r.id), ['v1'], '-0 matches 0');
      const negZero = await must(t, c.from('users').where({ score: -0 }).fetch(), 'filter score = -0');
      t.eq(negZero.rows.map((r: any) => r.id), ['v1'], 'a -0 literal is 0');
      await readRejects(t, c.from('users').where({ score: NaN }).fetch(), 'TYPE_ERROR', 'NaN literal');
      await readRejects(t, c.from('users').where({ score: { lt: Infinity } }).fetch(), 'TYPE_ERROR', 'Infinity literal');
      await readRejects(t, c.from('users').where({ name: 'a\uD800' }).fetch(), 'TYPE_ERROR', 'lone surrogate literal');
      await readRejects(t, c.from('users').where({ age: 2 ** 53 }).fetch(), 'TYPE_ERROR', 'unsafe int literal');
    },
  },
  {
    name: 'query arguments: error codes and limits',
    async run(t) {
      const { c } = await open(t, S);
      await must(t, c.insert('users', { id: 'q1', name: 'a', age: 1 }), 'insert');
      await must(t, c.insert('wide', { id: 'w1' }), 'insert wide');
      const f = (q: any) => q.fetch();
      const u = () => c.from('users');
      await readRejects(t, f(c.from('nope')), 'UNKNOWN_TABLE', 'unknown table');
      await readRejects(t, f(u().where({ nope: 1 })), 'UNKNOWN_FIELD', 'unknown filter field');
      await readRejects(t, f(u().orderBy('nope')), 'UNKNOWN_FIELD', 'unknown sort field');
      await readRejects(t, f(u().select('nope')), 'UNKNOWN_FIELD', 'unknown selected field');
      await readRejects(t, f(u().where({ age: 'x' })), 'TYPE_ERROR', 'string literal for int');
      await readRejects(t, f(u().where({ age: 1.5 })), 'TYPE_ERROR', 'fractional literal for int');
      await readRejects(t, f(u().where({ name: 1 })), 'TYPE_ERROR', 'number literal for string');
      await readRejects(t, f(u().where({ active: 1 })), 'TYPE_ERROR', 'number literal for bool');
      await readRejects(t, f(u().where({ active: { gt: false } })), 'TYPE_ERROR', 'gt on bool');
      await readRejects(t, f(u().where({ age: { startsWith: '1' } })), 'TYPE_ERROR', 'startsWith on int');
      await readRejects(t, f(u().where({ meta: { eq: 1 } })), 'TYPE_ERROR', 'filter on json');
      await readRejects(t, f(u().where({ meta: null })), 'TYPE_ERROR', 'null check on json');
      await readRejects(t, f(u().orderBy('meta')), 'TYPE_ERROR', 'sort on json');
      await readRejects(t, f(u().where({ id: 5 })), 'TYPE_ERROR', 'number literal for id');
      for (const n of [0, 10_001, 1.5, -1]) await readRejects(t, f(u().limit(n)), 'INVALID_ARGUMENT', `limit(${n})`);
      await ok(t, f(u().limit(10_000)), 'limit(10000)');
      await readRejects(t, f(u().select()), 'INVALID_ARGUMENT', 'empty select');
      await readRejects(t, f(u().select('name', 'name')), 'INVALID_ARGUMENT', 'duplicate select');
      await readRejects(t, f(u().select('id')), 'INVALID_ARGUMENT', 'select with id');
      await readRejects(t, f(u().where({ age: { in: Array.from({ length: 1001 }, (_, i) => i) } })), 'INVALID_ARGUMENT', 'in with 1,001 values');
      await ok(t, f(u().where({ age: { nin: Array.from({ length: 1000 }, (_, i) => i) } })), 'nin with 1,000 values');
      const nest = (n: number): any => (n === 0 ? { age: 1 } : n % 2 ? { $and: [nest(n - 1)] } : { $or: [nest(n - 1)] });
      t.eq((await ok(t, f(u().where(nest(16))), '16 levels of $and/$or'))?.rows?.length, 1, 'rows of a 16-level filter');
      await readRejects(t, f(u().where(nest(17))), 'INVALID_ARGUMENT', '17 levels of $and/$or');
      let w = c.from('wide');
      for (let i = 0; i < 8; i++) w = w.orderBy(`c${i}`);
      await ok(t, f(w), '8 orderBy keys');
      await readRejects(t, f(w.orderBy('c8')), 'INVALID_ARGUMENT', '9 orderBy keys');
      await readRejects(t, c.from('users').where({ nope: 1 }).count().fetch(), 'UNKNOWN_FIELD', 'count with an unknown field');
      const sub = c.from('users').where({ age: 'x' }).subscribe(() => t.fail('listener called for an invalid query'));
      await readRejects(t, sub.ready, 'TYPE_ERROR', 'subscribe with a bad literal');
      await sleep(50);
      t.check(sub.closed, 'a subscription rejected by the server is closed');
    },
  },
  {
    name: 'RESULT_TOO_LARGE: fetch, subscribe, growth',
    async run(t) {
      const { c } = await open(t, S);
      for (let k = 0; k < 10; k++) {
        await must(t, c.batch((tx: any) => { for (let i = 0; i < 10_000; i++) tx.insert('counters', { id: `r${k}_${i}` }); }), `insert batch ${k}`);
      }
      const subErrors: any[] = [];
      const sub = c.from('counters').select('n').subscribe(() => {});
      sub.onError((e: any) => subErrors.push(e));
      const first = await must(t, sub.ready, 'subscribe to 100,000 rows');
      t.eq((first as any).rows.length, 100_000, 'rows of an unlimited query at the bound');
      await must(t, c.insert('counters', { id: 'over' }), 'grow past 100,000');
      const deadline = Date.now() + 5000;
      while (!sub.closed && Date.now() < deadline) await sleep(20);
      t.check(sub.closed, 'a live result growing past 100,000 rows terminates the subscription');
      t.eq(subErrors.map((e) => e.code), ['RESULT_TOO_LARGE'], 'onError of the terminated subscription');
      await readRejects(t, c.from('counters').fetch(), 'RESULT_TOO_LARGE', 'fetch of 100,001 rows');
      const s2 = c.from('counters').subscribe(() => t.fail('listener called for a too large result'));
      await readRejects(t, s2.ready, 'RESULT_TOO_LARGE', 'subscribe to 100,001 rows');
      t.eq((await ok(t, c.from('counters').limit(10).fetch(), 'limited fetch'))?.rows?.length, 10, 'limit avoids the bound');
      t.eq((await ok(t, c.from('counters').count().fetch(), 'count'))?.count, 100_001, 'count is not bounded');
    },
  },
  {
    name: 'databases: lifecycle, incarnations, UNKNOWN_DATABASE',
    async run(t) {
      const node = await t.shared();
      const url = node.url;
      const ghost = client(t, url, t.dbName('ghost'), { timeoutMs: 5000 });
      await rejects(t, ghost.insert('users', { name: 'x' }), 'UNKNOWN_DATABASE', { outcome: 'not_applied' }, 'insert into a missing database');
      await readRejects(t, ghost.from('users').fetch(), 'UNKNOWN_DATABASE', 'fetch from a missing database');

      const name = t.dbName('life');
      const created = await createDb(url, name);
      t.eq({ name: created.name, version: created.version, incType: typeof created.incarnation }, { name, version: 0, incType: 'string' }, 'create response');
      const dup = await api(url, 'POST', '/v1/databases', { name });
      t.eq([dup.status, errorCode(dup)], [409, 'DATABASE_EXISTS'], 'create of an existing name');
      for (const bad of ['Bad', '1a', 'a-b', '', 'a'.repeat(64)]) {
        const r = await api(url, 'POST', '/v1/databases', { name: bad });
        t.eq([r.status, errorCode(r)], [400, 'INVALID_ARGUMENT'], `database name ${JSON.stringify(bad)}`);
      }
      const longName = `l${t.rng.int(1e9)}`.padEnd(63, 'x');
      t.eq((await api(url, 'POST', '/v1/databases', { name: longName })).status, 201, '63-character database name');
      t.defer(() => dropDb(url, longName));
      const info = await dbInfo(url, name);
      t.eq(info && { name: info.name, incarnation: info.incarnation, version: info.version, schemaVersion: info.schemaVersion, leader: typeof info.leader },
        { name, incarnation: created.incarnation, version: 0, schemaVersion: 0, leader: 'string' }, 'GET /v1/databases entry');
      await pushOk(url, name, S);
      const c = client(t, url, name);
      const ins = await must(t, c.insert('users', { name: 'a' }), 'insert');
      t.eq(ins.version, 2, 'version after push and insert');
      const errors: any[] = [];
      const sub = c.from('users').subscribe(() => {});
      sub.onError((e: any) => errors.push(e));
      await must(t, sub.ready, 'subscribe');
      const del = await api(url, 'DELETE', `/v1/databases/${name}`);
      t.eq(del.status, 204, 'drop');
      const deadline = Date.now() + 5000;
      while (!sub.closed && Date.now() < deadline) await sleep(20);
      t.check(sub.closed, 'dropping a database ends its subscriptions');
      t.eq(errors.map((e) => e.code), ['UNKNOWN_DATABASE'], 'onError after drop');
      const again = await api(url, 'DELETE', `/v1/databases/${name}`);
      t.eq([again.status, errorCode(again)], [404, 'UNKNOWN_DATABASE'], 'drop of a missing database');
      const re = await createDb(url, name);
      t.check(re.incarnation !== created.incarnation, 'a new creation gets a new incarnation');
      await pushOk(url, name, S);
      await rejects(t, c.insert('users', { name: 'b' }), 'UNKNOWN_DATABASE', { outcome: 'not_applied' }, 'client bound to the dropped incarnation');
      await readRejects(t, c.from('users').fetch(), 'UNKNOWN_DATABASE', 'fetch on the dropped incarnation');
      const c2 = client(t, url, name);
      t.eq((await must(t, c2.insert('users', { name: 'b' }), 'insert into the new incarnation')).version, 2, 'versions restart in a new incarnation');
      t.eq((await must(t, c2.from('users').fetch(), 'fetch new incarnation')).rows.length, 1, 'the new incarnation starts empty');
      await dropDb(url, name);
    },
  },
];

const suite: Suite = {
  id: 'T2',
  level: 'L1',
  weight: 4,
  needsSdk: true,
  cases: () => cases.map((c) => ({ name: c.name, run: c.run })),
};
export default suite;
