/** Self-test of the SQLite voter: one literal case per rule of SPEC §5–§7 that the translation relies on. `node --test`. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ExprIR, RowsQueryIR, SchemaIR } from '@rsdb/client';
import { Voter, VoterError, canonical, resultHash } from './voter.ts';

const schema: SchemaIR = {
  format: 'rsdb-schema/1',
  tables: {
    items: {
      columns: {
        s: { type: 'string', nullable: true },
        n: { type: 'int', nullable: true },
        f: { type: 'float', nullable: true },
        b: { type: 'bool', nullable: false, default: false },
        j: { type: 'json', nullable: true },
        u: { type: 'string', nullable: true },
      },
      indexes: [{ name: 'by_u', columns: ['u'], unique: true }],
    },
  },
};

type Order = { field: string; dir: 'asc' | 'desc' }[];
const rows = (where: ExprIR | null, orderBy: Order = [], select: string[] | null = null): RowsQueryIR => ({
  format: 'rsdb-query/1', kind: 'rows', table: 'items', where, orderBy, limit: null, select,
});
const ids = (v: Voter, where: ExprIR | null, orderBy: Order = []) => {
  const r = v.query(rows(where, orderBy));
  assert.equal(r.kind, 'rows');
  return r.rows.map((x) => x.id);
};
const code = (fn: () => unknown, expected: string, opIndex?: number) =>
  assert.throws(fn, (e: unknown) => e instanceof VoterError && e.code === expected && (opIndex === undefined || e.opIndex === opIndex));

function seeded(): Voter {
  const v = new Voter(schema);
  v.applyBatch([
    { op: 'insert', table: 'items', row: { id: 'a', s: 'abc', n: 1, f: 1.5, b: true } },
    { op: 'insert', table: 'items', row: { id: 'b', s: 'ABC', n: -2, f: -0 } },
    { op: 'insert', table: 'items', row: { id: 'c', s: 'a%c', n: null } },
    { op: 'insert', table: 'items', row: { id: 'd', s: '\u{1F600}', n: 9007199254740991 } },
    { op: 'insert', table: 'items', row: { id: 'e', s: '�' } },
    { op: 'insert', table: 'items', row: { id: 'f', s: '' } },
  ]);
  return v;
}

test('strings compare by UTF-8 bytes, not UTF-16 code units', () => {
  const v = seeded();
  assert.deepEqual(ids(v, { op: 'notNull', field: 's' }, [{ field: 's', dir: 'asc' }]), ['f', 'b', 'c', 'a', 'e', 'd']);
  assert.deepEqual(ids(v, { op: 'gt', field: 's', value: '�' }), ['d']);
});

test('startsWith is a case-sensitive byte prefix without wildcards', () => {
  const v = seeded();
  assert.deepEqual(ids(v, { op: 'startsWith', field: 's', value: 'a' }), ['a', 'c']);
  assert.deepEqual(ids(v, { op: 'startsWith', field: 's', value: 'a%' }), ['c']);
  assert.deepEqual(ids(v, { op: 'startsWith', field: 's', value: 'a_' }), []);
  assert.deepEqual(ids(v, { op: 'startsWith', field: 's', value: '' }), ['a', 'b', 'c', 'd', 'e', 'f']);
  assert.deepEqual(ids(v, { op: 'startsWith', field: 'u', value: '' }), []);
  assert.deepEqual(ids(v, { op: 'startsWith', field: 'id', value: 'c' }), ['c']);
});

test('two-valued logic: comparisons on NULL are false; empty in/nin/and/or', () => {
  const v = seeded();
  assert.deepEqual(ids(v, { op: 'ne', field: 'n', value: 1 }), ['b', 'd']);
  assert.deepEqual(ids(v, { op: 'nin', field: 'n', values: [1] }), ['b', 'd']);
  assert.deepEqual(ids(v, { op: 'nin', field: 'n', values: [] }), ['a', 'b', 'c', 'd', 'e', 'f']);
  assert.deepEqual(ids(v, { op: 'in', field: 'n', values: [] }), []);
  assert.deepEqual(ids(v, { op: 'and', args: [] }), ['a', 'b', 'c', 'd', 'e', 'f']);
  assert.deepEqual(ids(v, { op: 'or', args: [] }), []);
  assert.deepEqual(ids(v, { op: 'or', args: [{ op: 'lt', field: 'n', value: 0 }, { op: 'isNull', field: 'n' }] }), ['b', 'c', 'e', 'f']);
});

test('order: NULL first ascending, last descending; id tiebreaker; false < true', () => {
  const v = seeded();
  assert.deepEqual(ids(v, null, [{ field: 'n', dir: 'asc' }]), ['c', 'e', 'f', 'b', 'a', 'd']);
  assert.deepEqual(ids(v, null, [{ field: 'n', dir: 'desc' }]), ['d', 'a', 'b', 'c', 'e', 'f']);
  assert.deepEqual(ids(v, null, [{ field: 'b', dir: 'desc' }]), ['a', 'b', 'c', 'd', 'e', 'f']);
  assert.deepEqual(ids(v, null, [{ field: 'id', dir: 'desc' }]), ['f', 'e', 'd', 'c', 'b', 'a']);
});

test('values come back as SDK types; -0 is 0; projection keeps id', () => {
  const v = seeded();
  const r = v.query(rows({ op: 'in', field: 'id', values: ['a', 'b'] }, [], ['f', 'b', 'j']));
  assert.deepEqual(r, { kind: 'rows', rows: [{ id: 'a', f: 1.5, b: true, j: null }, { id: 'b', f: 0, b: false, j: null }] });
  assert.ok(r.kind === 'rows' && !Object.is(r.rows[1]!.f, -0));
  assert.deepEqual(v.query({ format: 'rsdb-query/1', kind: 'count', table: 'items', where: { op: 'eq', field: 'b', value: false } }), { kind: 'count', count: 5 });
});

test('$inc: NULL counts as 0; out of safe range fails the whole batch', () => {
  const v = seeded();
  v.applyBatch([{ op: 'updateWhere', table: 'items', where: { op: 'in', field: 'id', values: ['a', 'c'] }, set: { n: { $inc: 5 }, f: { $inc: 0.25 } } }]);
  assert.deepEqual(v.dump('items').filter((r) => r.id === 'a' || r.id === 'c').map((r) => [r.n, r.f]), [[6, 1.75], [5, 0.25]]);
  const before = v.version;
  code(() => v.applyBatch([{ op: 'delete', table: 'items', id: 'a' }, { op: 'update', table: 'items', id: 'd', set: { n: { $inc: 1 } } }]), 'TYPE_ERROR', 1);
  code(() => v.applyBatch([{ op: 'update', table: 'items', id: 'a', set: { n: { $inc: 0.5 } } }]), 'TYPE_ERROR', 0);
  assert.equal(v.version, before);
  assert.equal(v.dump('items').length, 6);
  v.applyBatch([{ op: 'update', table: 'items', id: 'a', set: { j: { $inc: 1 } } }]);
  assert.deepEqual(v.dump('items')[0]!.j, { $inc: 1 });
});

test('upsert replaces the whole row; omitted columns take the default or NULL', () => {
  const v = seeded();
  const [r] = v.applyBatch([{ op: 'upsert', table: 'items', row: { id: 'a', n: 7 } }]);
  assert.deepEqual(r, { id: 'a' });
  assert.deepEqual(v.dump('items')[0], { id: 'a', s: null, n: 7, f: null, b: false, j: null, u: null });
});

test('mutation results and data errors', () => {
  const v = seeded();
  assert.deepEqual(
    v.applyBatch([
      { op: 'insert', table: 'items', row: { u: 'x' } },
      { op: 'delete', table: 'items', id: 'zz' },
      { op: 'deleteWhere', table: 'items', where: { op: 'startsWith', field: 's', value: 'a' } },
      { op: 'updateWhere', table: 'items', where: null, set: { b: true } },
    ], ['gen1']),
    [{ id: 'gen1' }, { deleted: false }, { count: 2 }, { count: 5 }],
  );
  code(() => v.applyBatch([{ op: 'insert', table: 'items', row: { id: 'b' } }]), 'DUPLICATE_ID', 0);
  code(() => v.applyBatch([{ op: 'insert', table: 'items', row: { id: 'q', u: 'x' } }]), 'CONSTRAINT_VIOLATION', 0);
  code(() => v.applyBatch([{ op: 'update', table: 'items', id: 'nope', set: { n: 1 } }]), 'NOT_FOUND', 0);
  v.applyBatch([{ op: 'insert', table: 'items', row: { id: 'n1', u: null } }, { op: 'insert', table: 'items', row: { id: 'n2' } }]);
});

test('error order: INVALID_ARGUMENT, UNKNOWN_FIELD, TYPE_ERROR, then data errors', () => {
  const v = seeded();
  code(() => v.applyBatch([{ op: 'update', table: 'items', id: '', set: { nope: 'x' } }]), 'INVALID_ARGUMENT');
  code(() => v.applyBatch([{ op: 'update', table: 'items', id: 'nope', set: { nope: 1, n: 'x' } }]), 'UNKNOWN_FIELD');
  code(() => v.applyBatch([{ op: 'update', table: 'items', id: 'nope', set: { n: 'x' } }]), 'TYPE_ERROR');
  code(() => v.applyBatch([{ op: 'insert', table: 'items', row: { id: 'a', s: 'bad\u0000' } }]), 'TYPE_ERROR');
  code(() => v.applyBatch([{ op: 'insert', table: 'items', row: { s: '\uD800' } }]), 'TYPE_ERROR');
  code(() => v.query({ ...rows({ op: 'lt', field: 'b', value: true }), limit: 0 }), 'INVALID_ARGUMENT');
  code(() => v.query(rows({ op: 'lt', field: 'b', value: true }, [{ field: 'zz', dir: 'asc' }])), 'UNKNOWN_FIELD');
  code(() => v.query(rows({ op: 'lt', field: 'b', value: true })), 'TYPE_ERROR');
  code(() => v.query(rows({ op: 'eq', field: 'n', value: 1.5 })), 'TYPE_ERROR');
  code(() => v.query(rows({ op: 'isNull', field: 'j' })), 'TYPE_ERROR');
  code(() => v.query(rows(null, [{ field: 'j', dir: 'asc' }])), 'TYPE_ERROR');
  code(() => v.query(rows(null, [], ['id'])), 'INVALID_ARGUMENT');
  code(() => v.query({ ...rows(null), table: 'Items' }), 'UNKNOWN_TABLE');
});

test('schema pushes rebuild changed tables and consume one version', () => {
  const v = seeded();
  const next = structuredClone(schema);
  assert.equal(v.push(next), false);
  const at = v.version;
  next.tables.items!.columns.k = { type: 'int', nullable: false, default: 3 };
  delete next.tables.items!.columns.j;
  next.tables.tags = { columns: { name: { type: 'string', nullable: false } }, indexes: [] };
  assert.equal(v.push(next), true);
  assert.equal(v.version, at + 1);
  assert.deepEqual(v.dump('items')[0], { id: 'a', s: 'abc', n: 1, f: 1.5, b: true, u: null, k: 3 });

  const required = structuredClone(next);
  required.tables.items!.columns.n!.nullable = false;
  code(() => v.push(required), 'CONSTRAINT_VIOLATION');
  const unique = structuredClone(next);
  unique.tables.items!.indexes.push({ name: 'by_b', columns: ['b'], unique: true });
  code(() => v.push(unique), 'CONSTRAINT_VIOLATION');
  const retyped = structuredClone(next);
  retyped.tables.items!.columns.n!.type = 'float';
  code(() => v.push(retyped), 'INVALID_ARGUMENT');
  const noDefault = structuredClone(next);
  noDefault.tables.items!.columns.z = { type: 'int', nullable: false };
  code(() => v.push(noDefault), 'INVALID_ARGUMENT');
  assert.equal(v.version, at + 1);
  assert.deepEqual(v.schema, next);
  assert.equal(v.dump('items').length, 6);
});

test('result hashes ignore JSON key order and distinguish row order', () => {
  assert.equal(canonical({ b: [1, { y: 2, x: -0 }], a: 'z' }), '{"a":"z","b":[1,{"x":0,"y":2}]}');
  assert.equal(resultHash({ rows: [{ id: 'a', j: { p: 1, q: 2 } }] }), resultHash({ rows: [{ j: { q: 2, p: 1 }, id: 'a' }] }));
  assert.notEqual(resultHash({ rows: [{ id: 'a' }, { id: 'b' }] }), resultHash({ rows: [{ id: 'b' }, { id: 'a' }] }));
  assert.notEqual(resultHash({ count: 1 }), resultHash({ rows: [{ id: '1' }] }));
});
