/**
 * Fuzz generators for T3, T4, T6 and the D/F suites: a schema with every type and nullability, adversarial values, random
 * queries and random batches. A query is generated once as IR (what the voter evaluates) and once as DSL calls (what goes
 * through the submission's builder), following the DSL → IR rules of SPEC §6.2 point 1, so the SDK's own `toIR()` is never trusted.
 */
import type { ColumnIR, ExprIR, JsonValue, MutationIR, QueryIR, SchemaIR } from '@rsdb/client';
import type { Rng } from './rng.ts';

export const FUZZ_SCHEMA: SchemaIR = {
  format: 'rsdb-schema/1',
  tables: {
    items: {
      columns: {
        s: { type: 'string', nullable: false },
        so: { type: 'string', nullable: true },
        i: { type: 'int', nullable: false },
        io: { type: 'int', nullable: true },
        f: { type: 'float', nullable: false },
        fo: { type: 'float', nullable: true },
        b: { type: 'bool', nullable: false, default: false },
        bo: { type: 'bool', nullable: true },
        j: { type: 'json', nullable: true },
        jr: { type: 'json', nullable: false, default: { k: 1 } },
        u: { type: 'string', nullable: true },
        grp: { type: 'int', nullable: false, default: 0 },
      },
      indexes: [
        { name: 'by_s', columns: ['s'], unique: false },
        { name: 'by_i_f', columns: ['i', 'f'], unique: false },
        { name: 'by_so', columns: ['so'], unique: false },
        { name: 'u_unique', columns: ['u'], unique: true },
        { name: 'by_grp_i', columns: ['grp', 'i'], unique: false },
      ],
    },
    accounts: {
      columns: { grp: { type: 'int', nullable: false }, bal: { type: 'int', nullable: false, default: 0 } },
      indexes: [{ name: 'by_grp', columns: ['grp'], unique: false }],
    },
    counters: { columns: { n: { type: 'int', nullable: false, default: 0 } }, indexes: [] },
  },
};

// ─────────────────────────────── values ───────────────────────────────

export const STRINGS = [
  '', ' ', 'a', 'A', 'ab', 'abc', 'abd', 'b', 'Z', 'z', 'zz', 'a%', 'a_', '%', '_', '%a', 'é', 'é', 'É', 'ß', 'ẞ',
  'ÿ', 'Ā', '߿', 'ࠀ', '', '�', '￿', '\u{10000}', '\u{1F600}', '\u{1F600}x', '\u{10FFFF}',
  'pre', 'pref', 'prefix', 'prefix\u{1F600}', 'préfix', 'pre�', '10', '9', '-1', 'null', 'NULL', 'true', 'a\tb', 'a\nb',
  '"quoted"', "it's", '\\', 'x'.repeat(300), '日本', '日本語',
];
export const INTS = [0, -0, 1, -1, 2, -2, 7, 9, 10, 100, -100, 2147483647, -2147483648, 4294967296, 9007199254740991, -9007199254740991, 9007199254740990, 123456789];
export const FLOATS = [
  0, -0, 0.5, -0.5, 1, -1, 0.1, 0.2, 0.30000000000000004, 1e-300, -1e-300, 5e-324, 1e300, 1.7976931348623157e308,
  -1.7976931348623157e308, 9007199254740992, 3.14159, 1e21, 2, 7, 100.25,
];
export const JSONS: JsonValue[] = [
  0, 1.5, '', 'x', true, false, [], {}, [1, 2, { a: null }], { b: 1, a: [true, '\u{1F600}'] }, { '': 0 }, { z: { y: { x: [[]] } } },
  'é', [null], { a: 1, A: 2 },
];

type Type = ColumnIR['type'] | 'id';
export interface Col {
  name: string;
  type: Type;
  nullable: boolean;
}

export function columnsOf(schema: SchemaIR, table: string): Col[] {
  return Object.entries(schema.tables[table]!.columns).map(([name, c]) => ({ name, type: c.type, nullable: c.nullable }));
}

export function value(rng: Rng, type: Type): JsonValue {
  switch (type) {
    case 'id':
    case 'string':
      return rng.chance(0.85) ? rng.pick(STRINGS) : `${rng.pick(STRINGS)}${rng.pick(STRINGS)}`;
    case 'int':
      return rng.chance(0.8) ? rng.pick(INTS) : rng.range(-50, 50);
    case 'float':
      return rng.chance(0.8) ? rng.pick(FLOATS) : rng.range(-500, 500) / 8;
    case 'bool':
      return rng.chance(0.5);
    case 'json':
      return rng.pick(JSONS);
  }
}

/** A row for `items` with every column set (NULL for optional columns at ~20 %). */
export function itemRow(rng: Rng, cols: Col[]): Record<string, JsonValue> {
  const row: Record<string, JsonValue> = {};
  for (const c of cols) {
    if (c.name === 'u') row.u = rng.chance(0.85) ? null : `u${rng.int(1e9)}`;
    else if (c.name === 'grp') row.grp = rng.int(4);
    else if (c.nullable && rng.chance(0.2)) row[c.name] = null;
    else if (!c.nullable && c.name === 'jr' && rng.chance(0.3)) continue; // default applies
    else row[c.name] = value(rng, c.type);
  }
  return row;
}

/** Ids that stress ordering and prefix tests, plus plain ones. */
export function ids(rng: Rng, n: number): string[] {
  const out = new Set<string>();
  for (const s of STRINGS) if (s && Buffer.byteLength(s) <= 128) out.add(s);
  while (out.size < n) out.add(rng.chance(0.5) ? `r${out.size.toString().padStart(5, '0')}` : `${rng.pick(STRINGS).slice(0, 20)}#${out.size}`);
  return rng.shuffle([...out].filter((s) => s.isWellFormed())).slice(0, n);
}

// ─────────────────────────────── queries ───────────────────────────────

/** Operators defined per column type (SPEC §5.2). */
export function opsFor(type: Type): ExprIR['op'][] {
  const base: ExprIR['op'][] = ['eq', 'ne', 'in', 'nin', 'isNull', 'notNull'];
  if (type === 'bool') return base;
  const cmp: ExprIR['op'][] = [...base, 'lt', 'lte', 'gt', 'gte'];
  return type === 'string' || type === 'id' ? [...cmp, 'startsWith', 'startsWith'] : cmp;
}

function prefix(rng: Rng): string {
  const cps = Array.from(rng.pick(STRINGS));
  return cps.slice(0, rng.int(Math.min(cps.length, 4) + 1)).join('');
}

export function leaf(rng: Rng, col: Col): ExprIR {
  const op = rng.pick(opsFor(col.type));
  const field = col.name;
  switch (op) {
    case 'isNull':
    case 'notNull':
      return { op, field };
    case 'in':
    case 'nin':
      return { op, field, values: Array.from({ length: rng.pick([0, 1, 2, 3, 5]) }, () => value(rng, col.type) as string | number | boolean) };
    case 'startsWith':
      return { op, field, value: prefix(rng) };
    default:
      return { op: op as 'eq', field, value: value(rng, col.type) as string | number | boolean };
  }
}

export function expr(rng: Rng, cols: Col[], depth = 3): ExprIR {
  if (depth > 0 && rng.chance(0.35)) {
    return { op: rng.chance(0.6) ? 'and' : 'or', args: Array.from({ length: rng.pick([0, 1, 2, 2, 3]) }, () => expr(rng, cols, depth - 1)) };
  }
  return leaf(rng, rng.pick(cols));
}

export interface GenQuery {
  ir: QueryIR;
  /** Arguments of successive `.where()` calls (AND-ed). */
  wheres: Record<string, unknown>[];
  /** Calls made before `.count()` that it must ignore. */
  ignoredBeforeCount?: { orderBy: { field: string; dir: 'asc' | 'desc' }[]; limit: number | null };
}

/** DSL filter for an IR expression, choosing randomly among the equivalent spellings of §6.2 point 1. */
export function dsl(rng: Rng, e: ExprIR): Record<string, unknown> {
  switch (e.op) {
    case 'and': {
      const leaves = e.args.filter((a) => a.op !== 'and' && a.op !== 'or') as Exclude<ExprIR, { args: unknown }>[];
      if (leaves.length === e.args.length && e.args.length > 1 && rng.chance(0.5)) {
        // one object: distinct fields as keys, repeated fields as several operators of one field filter
        const out: Record<string, Record<string, unknown>> = {};
        let ok = true;
        for (const l of leaves) {
          const [k, v] = Object.entries(dsl(rng, l))[0]!;
          const ops = typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : { eq: v };
          const cur = (out[k] ??= {});
          for (const [op, x] of Object.entries(ops)) {
            if (op in cur) ok = false;
            cur[op] = x;
          }
        }
        if (ok) return out;
      }
      return { $and: e.args.map((a) => dsl(rng, a)) };
    }
    case 'or':
      return { $or: e.args.map((a) => dsl(rng, a)) };
    case 'isNull':
      return { [e.field]: rng.chance(0.5) ? null : { eq: null } };
    case 'notNull':
      return { [e.field]: { ne: null } };
    case 'eq':
      return { [e.field]: rng.chance(0.5) ? e.value : { eq: e.value } };
    case 'in':
    case 'nin':
      return { [e.field]: { [e.op]: [...e.values] } };
    default:
      return { [e.field]: { [e.op]: e.value } };
  }
}

export interface QueryOptions {
  table?: string;
  countRate?: number;
  /** Probability of a limit; without one the filter should be selective for large tables. */
  limitRate?: number;
  maxLimit?: number;
  depth?: number;
}

export function query(rng: Rng, schema: SchemaIR, o: QueryOptions = {}): GenQuery {
  const table = o.table ?? 'items';
  const cols = columnsOf(schema, table);
  const filterable: Col[] = [{ name: 'id', type: 'id', nullable: false }, ...cols.filter((c) => c.type !== 'json')];
  const where = rng.chance(0.1) ? null : expr(rng, filterable, o.depth ?? 3);
  let wheres: Record<string, unknown>[] = where === null ? [] : [dsl(rng, where)];
  if (where?.op === 'and' && where.args.length > 1 && rng.chance(0.3)) wheres = where.args.map((a) => dsl(rng, a));
  if (rng.chance(o.countRate ?? 0.2)) {
    const ignored = rng.chance(0.3) ? { orderBy: [{ field: rng.pick(filterable).name, dir: 'desc' as const }], limit: 1 } : undefined;
    return { ir: { format: 'rsdb-query/1', kind: 'count', table, where }, wheres, ignoredBeforeCount: ignored };
  }
  const orderBy = rng.sample(filterable, rng.pick([0, 0, 1, 1, 2, 3])).map((c) => ({ field: c.name, dir: rng.pick(['asc', 'desc'] as const) }));
  const limit = rng.chance(o.limitRate ?? 0.5) ? rng.pick([1, 2, 3, 5, 10, 20, o.maxLimit ?? 50]) : null;
  const select = rng.chance(0.4) ? rng.sample(cols.map((c) => c.name), rng.range(1, 3)) : null;
  return { ir: { format: 'rsdb-query/1', kind: 'rows', table, where, orderBy, limit, select }, wheres };
}

/** Builds the query through the submission's typed builder. */
export function build(client: any, q: GenQuery): any {
  let b = client.from(q.ir.table);
  for (const w of q.wheres) b = b.where(w);
  if (q.ir.kind === 'count') {
    if (q.ignoredBeforeCount) {
      for (const o of q.ignoredBeforeCount.orderBy) b = b.orderBy(o.field, o.dir);
      if (q.ignoredBeforeCount.limit) b = b.limit(q.ignoredBeforeCount.limit);
    }
    return b.count();
  }
  for (const o of q.ir.orderBy) b = b.orderBy(o.field, o.dir);
  if (q.ir.limit !== null) b = b.limit(q.ir.limit);
  if (q.ir.select) b = b.select(...q.ir.select);
  return b;
}

export const describe = (q: GenQuery) => JSON.stringify(q.ir);

/** A filter leaf the server must reject with TYPE_ERROR (§6.2 point 1): wrong literal type, operator or column. */
export function invalidLeaf(rng: Rng, schema: SchemaIR, table = 'items'): ExprIR {
  const cols = columnsOf(schema, table);
  const json = cols.find((c) => c.type === 'json');
  const pick = (type: Type) => cols.find((c) => c.type === type)?.name ?? 'id';
  return rng.pick<ExprIR>([
    { op: 'eq', field: pick('int'), value: 'x' },
    { op: 'eq', field: pick('int'), value: 1.5 },
    { op: 'gt', field: pick('int'), value: 2 ** 53 },
    { op: 'eq', field: pick('string'), value: 1 },
    { op: 'startsWith', field: pick('int'), value: '1' },
    { op: 'lt', field: pick('bool'), value: true },
    { op: 'eq', field: pick('bool'), value: 0 },
    { op: 'in', field: pick('float'), values: [1, 'a'] },
    { op: 'eq', field: pick('string'), value: 'a\uD800' },
    ...(json ? [{ op: 'eq', field: json.name, value: 1 } as ExprIR, { op: 'isNull', field: json.name } as ExprIR] : []),
  ]);
}

/** Deterministic DSL for a (shrunk) IR expression: one spelling, no randomness. */
export function plainDsl(e: ExprIR): Record<string, unknown> {
  switch (e.op) {
    case 'and':
    case 'or':
      return { [`$${e.op}`]: e.args.map(plainDsl) };
    case 'isNull':
      return { [e.field]: null };
    case 'notNull':
      return { [e.field]: { ne: null } };
    case 'in':
    case 'nin':
      return { [e.field]: { [e.op]: [...e.values] } };
    default:
      return { [e.field]: { [e.op]: e.value } };
  }
}

// ─────────────────────────────── batches ───────────────────────────────

/** A set of ids with O(1) random pick and removal. */
export class IdPool {
  readonly #list: string[] = [];
  readonly #at = new Map<string, number>();
  get size(): number {
    return this.#list.length;
  }
  has(id: string): boolean {
    return this.#at.has(id);
  }
  add(id: string): void {
    if (this.#at.has(id)) return;
    this.#at.set(id, this.#list.length);
    this.#list.push(id);
  }
  delete(id: string): void {
    const i = this.#at.get(id);
    if (i === undefined) return;
    const last = this.#list.pop()!;
    this.#at.delete(id);
    if (last !== id) {
      this.#list[i] = last;
      this.#at.set(last, i);
    }
  }
  pick(rng: Rng): string | undefined {
    return this.#list.length ? this.#list[rng.int(this.#list.length)] : undefined;
  }
  values(): readonly string[] {
    return this.#list;
  }
}

/**
 * What one writer knows about its own rows. Writers insert ids under their own prefix and update or delete mostly those, so that
 * concurrent writers rarely make each other's batches fail; the view is still approximate (updateWhere and the occasional foreign
 * id) and only aims operations.
 */
export class WriterState {
  readonly prefix: string;
  readonly ids = new IdPool();
  readonly accounts: { id: string; grp: number }[] = [];
  maxRows: number;
  seq = 0;
  constructor(prefix: string, maxRows: number) {
    this.prefix = prefix;
    this.maxRows = maxRows;
  }
  newId(): string {
    return `${this.prefix}${(this.seq++).toString(36)}`;
  }
}

function patch(rng: Rng, cols: Col[]): Record<string, JsonValue | { $inc: number }> {
  const set: Record<string, JsonValue | { $inc: number }> = {};
  for (const c of rng.sample(cols.filter((x) => x.name !== 'u' && x.name !== 'grp'), rng.range(1, 3))) {
    if ((c.type === 'int' || c.type === 'float') && rng.chance(0.4)) set[c.name] = { $inc: c.type === 'int' ? rng.range(-3, 3) : rng.range(-8, 8) / 4 };
    else if (c.nullable && rng.chance(0.2)) set[c.name] = null;
    else set[c.name] = value(rng, c.type);
  }
  return set;
}

/**
 * One random batch of 1..maxOps operations of every kind on `items`. Some fail on purpose (missing ids, duplicate unique values,
 * $inc overflow); deletes balance inserts once the writer holds maxRows rows.
 */
export function batch(rng: Rng, st: WriterState, cols: Col[], maxOps = 20): MutationIR[] {
  const ops: MutationIR[] = [];
  const known = () => st.ids.pick(rng) ?? `${st.prefix}missing`;
  const n = rng.range(1, maxOps);
  for (let k = 0; k < n; k++) {
    const full = st.ids.size >= st.maxRows;
    const r = rng.next();
    if (r < (full ? 0.04 : 0.36)) {
      const row = itemRow(rng, cols);
      if (rng.chance(0.7)) row.id = st.newId();
      ops.push({ op: 'insert', table: 'items', row });
    } else if (r < 0.44) ops.push({ op: 'upsert', table: 'items', row: { ...itemRow(rng, cols), id: rng.chance(0.7) ? known() : st.newId() } });
    else if (r < 0.7) ops.push({ op: 'update', table: 'items', id: rng.chance(0.97) ? known() : `${st.prefix}missing`, set: patch(rng, cols) });
    else if (r < (full ? 0.97 : 0.88)) ops.push({ op: 'delete', table: 'items', id: rng.chance(0.95) ? known() : `${st.prefix}missing` });
    else if (r < (full ? 0.995 : 0.99)) ops.push({ op: 'updateWhere', table: 'items', where: narrow(rng, st), set: patch(rng, cols) });
    else ops.push({ op: 'deleteWhere', table: 'items', where: { op: 'startsWith', field: 'id', value: `${st.prefix}${rng.int(36).toString(36)}${rng.int(36).toString(36)}` } });
  }
  return ops;
}

/** Filters that touch few rows, so that updateWhere does not rewrite the table. */
function narrow(rng: Rng, st: WriterState): ExprIR {
  return rng.pick<ExprIR>([
    { op: 'eq', field: 'i', value: rng.pick(INTS) },
    { op: 'and', args: [{ op: 'eq', field: 'grp', value: rng.int(4) }, { op: 'eq', field: 's', value: rng.pick(STRINGS) }] },
    { op: 'startsWith', field: 'id', value: `${st.prefix}${rng.int(36).toString(36)}` },
    { op: 'in', field: 'so', values: [rng.pick(STRINGS), rng.pick(STRINGS)] },
  ]);
}

/** Updates the writer's view from an acknowledged batch. */
export function learn(st: WriterState, ops: MutationIR[], results: unknown[]): void {
  ops.forEach((op, i) => {
    if (op.op === 'insert' || op.op === 'upsert') {
      if (op.table === 'items') st.ids.add((results[i] as { id: string }).id);
    } else if (op.op === 'delete') st.ids.delete(op.id);
    else if (op.op === 'deleteWhere' && op.where?.op === 'startsWith') {
      const p = op.where.value;
      for (const id of [...st.ids.values()]) if (id.startsWith(p)) st.ids.delete(id);
    }
  });
}

/** A bank transfer (R9): two `$inc` operations inside one group keep the group's total. */
export function transfer(rng: Rng, st: WriterState): MutationIR[] {
  const a = rng.pick(st.accounts);
  const b = rng.pick(st.accounts.filter((x) => x.grp === a.grp && x.id !== a.id));
  const amount = rng.range(1, 50);
  return [
    { op: 'update', table: 'accounts', id: a.id, set: { bal: { $inc: -amount } } },
    { op: 'update', table: 'accounts', id: b.id, set: { bal: { $inc: amount } } },
  ];
}

/** Adds IR operations to an SDK batch builder (filters through the plain DSL spelling). */
export function addOps(tx: any, ops: readonly MutationIR[]): void {
  for (const op of ops) {
    switch (op.op) {
      case 'insert':
        tx.insert(op.table, op.row);
        break;
      case 'upsert':
        tx.upsert(op.table, op.row);
        break;
      case 'update':
        tx.update(op.table, op.id, op.set);
        break;
      case 'delete':
        tx.delete(op.table, op.id);
        break;
      case 'updateWhere':
        tx.updateWhere(op.table, op.where ? plainDsl(op.where) : {}, op.set);
        break;
      case 'deleteWhere':
        tx.deleteWhere(op.table, op.where ? plainDsl(op.where) : {});
        break;
    }
  }
}
