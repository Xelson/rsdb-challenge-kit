/**
 * SQLite voter (SPEC §13.3): computes Q(D_v) by translating the IR to SQL on stock SQLite (node:sqlite).
 *
 * One Voter holds one database. It replays committed schema pushes and mutation batches in version order and evaluates queries
 * at the current version. It is a translation, not a model: every rule of SPEC §6.2 is delegated to SQLite (BINARY collation,
 * NULL ordering, comparison semantics); the voter only validates input, binds values exactly and converts results.
 *
 * Choices that are the voter's, not SQLite's:
 * - defaults are filled when a row is built and bound as parameters, so values are never re-parsed from DDL text;
 * - `startsWith` compares a byte prefix of `CAST(col AS BLOB)`, because LIKE and GLOB are not prefix tests (§6.2);
 * - a schema push rebuilds every changed table (create, copy, drop, rename), which covers every class of §5.5 uniformly.
 */
import { createHash } from 'node:crypto';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type {
  ColumnIR, ErrorCode, ExprIR, JsonValue, MutationIR, OpResult, QueryIR, SchemaIR, SetIR, TableIR,
} from '@rsdb/client';

export class VoterError extends Error {
  readonly code: ErrorCode;
  readonly opIndex: number | null;
  constructor(code: ErrorCode, message: string, opIndex: number | null = null) {
    super(`${code}: ${message}`);
    this.code = code;
    this.opIndex = opIndex;
  }
}

export type VoterRow = Record<string, JsonValue>;
export type VoterResult = { kind: 'rows'; rows: VoterRow[] } | { kind: 'count'; count: number };

const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const NAME = /^[A-Za-z][A-Za-z0-9_]{0,62}$/;
const MAX_ROW_BYTES = 1 << 20;
const MAX_BATCH_BYTES = 16 << 20;
const MAX_UNLIMITED_ROWS = 100_000;
const SQL_TYPE = { string: 'TEXT', int: 'INTEGER', float: 'REAL', bool: 'INTEGER', json: 'TEXT' } as const;

type Param = null | number | bigint | string | Uint8Array;
type ColType = ColumnIR['type'] | 'id';

function fail(code: ErrorCode, message: string): never {
  throw new VoterError(code, message);
}
const q = (name: string) => `"${name.replaceAll('"', '""')}"`;
const tableSql = (table: string) => q(`t:${table}`);
const indexSql = (table: string, index: string) => q(`i:${table}:${index}`);
const bytes = (s: string) => Buffer.byteLength(s, 'utf8');
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function checkString(s: string, what: string): void {
  if (!s.isWellFormed() || s.includes('\u0000')) fail('TYPE_ERROR', `${what}: string is not well-formed or contains U+0000`);
}

/** Validates a JSON value (§5.2) and returns it with -0 normalized to 0. */
function checkJson(v: unknown, what: string): JsonValue {
  if (v === null || typeof v === 'boolean') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? v + 0 : fail('TYPE_ERROR', `${what}: number is not finite`);
  if (typeof v === 'string') return checkString(v, what), v;
  if (Array.isArray(v)) return v.map((x) => checkJson(x, what));
  if (isObject(v) && Object.getPrototypeOf(v) === Object.prototype) {
    const out: Record<string, JsonValue> = {};
    for (const [k, x] of Object.entries(v)) {
      checkString(k, what);
      if (x !== undefined) out[k] = checkJson(x, what);
    }
    return out;
  }
  return fail('TYPE_ERROR', `${what}: not a JSON value`);
}

/** A literal (row value, patch value or filter literal) of a column type, as a bound SQLite parameter. */
function toParam(type: ColType, v: unknown, what: string): Param {
  switch (type) {
    case 'id':
    case 'string':
      if (typeof v !== 'string') return fail('TYPE_ERROR', `${what}: expected a string`);
      checkString(v, what);
      return v;
    case 'int':
      if (!Number.isSafeInteger(v)) return fail('TYPE_ERROR', `${what}: expected a safe integer`);
      return BigInt(v as number);
    case 'float':
      if (typeof v !== 'number' || !Number.isFinite(v)) return fail('TYPE_ERROR', `${what}: expected a finite number`);
      return v + 0;
    case 'bool':
      if (typeof v !== 'boolean') return fail('TYPE_ERROR', `${what}: expected a boolean`);
      return v ? 1n : 0n;
    case 'json':
      return JSON.stringify(checkJson(v, what));
  }
}

function fromSql(type: ColType, v: unknown): JsonValue {
  if (v === null || v === undefined) return null;
  switch (type) {
    case 'bool':
      return Number(v) !== 0;
    case 'json':
      return JSON.parse(v as string) as JsonValue;
    case 'int':
    case 'float':
      return Number(v) + 0;
    default:
      return v as string;
  }
}

/** Structural id check (INVALID_ARGUMENT); well-formedness is a TYPE_ERROR checked after unknown fields (§7.1 order). */
function idArg(id: unknown, what: string): string {
  if (typeof id !== 'string' || id.length === 0 || bytes(id) > 128) return fail('INVALID_ARGUMENT', `${what}: invalid id`);
  return id;
}

/** Canonical JSON: object keys sorted recursively, -0 as 0. Equal results (R3) have equal canonical forms. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (isObject(v)) {
    const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  }
  if (typeof v === 'number') return JSON.stringify(v + 0);
  return JSON.stringify(v ?? null);
}

/** Hash of an ordered rows result or a count, as compared by the runner (§13.3). */
export function resultHash(result: VoterResult | { rows: readonly unknown[] } | { count: number }): string {
  const body = 'rows' in result ? `rows:${canonical(result.rows)}` : `count:${result.count}`;
  return createHash('sha256').update(body).digest('hex');
}

export function validateSchema(schema: SchemaIR): void {
  if (schema?.format !== 'rsdb-schema/1' || !isObject(schema.tables)) fail('INVALID_ARGUMENT', 'not a rsdb-schema/1 document');
  const tables = Object.entries(schema.tables);
  if (tables.length > 256) fail('INVALID_ARGUMENT', 'more than 256 tables');
  const lower = (names: string[], what: string) => {
    for (const n of names) if (!NAME.test(n)) fail('INVALID_ARGUMENT', `${what} name ${JSON.stringify(n)}`);
    if (new Set(names.map((n) => n.toLowerCase())).size !== names.length) fail('INVALID_ARGUMENT', `${what} names clash case-insensitively`);
  };
  lower(tables.map(([n]) => n), 'table');
  for (const [name, t] of tables) {
    const cols = Object.entries(t.columns);
    if (cols.length > 256 || t.indexes.length > 32) fail('INVALID_ARGUMENT', `${name}: too many columns or indexes`);
    lower(cols.map(([c]) => c), `${name} column`);
    if (cols.some(([c]) => c.toLowerCase() === 'id')) fail('INVALID_ARGUMENT', `${name}: id is reserved`);
    for (const [c, col] of cols) {
      if (!(col.type in SQL_TYPE)) fail('INVALID_ARGUMENT', `${name}.${c}: unknown type`);
      if (col.default !== undefined) {
        if (col.default === null) fail('INVALID_ARGUMENT', `${name}.${c}: null default`);
        toParam(col.type, col.default, `${name}.${c} default`);
      }
    }
    lower(t.indexes.map((i) => i.name), `${name} index`);
    for (const ix of t.indexes) {
      if (ix.columns.length === 0) fail('INVALID_ARGUMENT', `${name}.${ix.name}: no columns`);
      for (const c of ix.columns) {
        const col = t.columns[c];
        if (c !== 'id' && !col) fail('INVALID_ARGUMENT', `${name}.${ix.name}: unknown column ${c}`);
        if (col?.type === 'json') fail('INVALID_ARGUMENT', `${name}.${ix.name}: index on a json column`);
      }
    }
  }
}

export class Voter {
  #db = new DatabaseSync(':memory:');
  #schema: SchemaIR = { format: 'rsdb-schema/1', tables: {} };
  #version = 0;
  #stmts = new Map<string, StatementSync>();
  #generated = 0;

  constructor(schema?: SchemaIR) {
    if (schema) this.push(schema);
  }

  get version(): number {
    return this.#version;
  }
  get schema(): SchemaIR {
    return structuredClone(this.#schema);
  }

  close(): void {
    this.#db.close();
  }

  // ─────────────────────────────── schema ───────────────────────────────

  /**
   * Applies a schema push as committed by the server (forced if destructive). Returns false, consuming no version, if the
   * schema is unchanged (§5.5 empty plan). Rejected classes of §5.5 throw INVALID_ARGUMENT; data that violates the new schema
   * (NULLs in a now-required column, duplicates under a new unique index) throws CONSTRAINT_VIOLATION.
   */
  push(next: SchemaIR): boolean {
    validateSchema(next);
    const prev = this.#schema.tables;
    const changed = new Set<string>();
    for (const [name, t] of Object.entries(next.tables)) {
      const old = prev[name];
      if (old) {
        for (const [c, col] of Object.entries(t.columns)) {
          const was = old.columns[c];
          if (was && was.type !== col.type) fail('INVALID_ARGUMENT', `${name}.${c}: type change`);
          if (!was && !col.nullable && col.default === undefined) fail('INVALID_ARGUMENT', `${name}.${c}: required column without default`);
        }
      }
      if (!old || canonical(normTable(old)) !== canonical(normTable(t))) changed.add(name);
    }
    for (const name of Object.keys(prev)) if (!next.tables[name]) changed.add(name);
    if (changed.size === 0) return false;

    this.#transaction(() => {
      for (const name of changed) {
        const t = next.tables[name];
        const old = prev[name];
        if (!t) {
          this.#db.exec(`DROP TABLE ${tableSql(name)}`);
          continue;
        }
        const target = old ? q(`t:${name}:new`) : tableSql(name);
        const cols = Object.entries(t.columns)
          .map(([c, col]) => `, ${q(c)} ${SQL_TYPE[col.type]}${col.nullable ? '' : ' NOT NULL'}`)
          .join('');
        this.#db.exec(`CREATE TABLE ${target} (id TEXT PRIMARY KEY NOT NULL${cols}) STRICT`);
        if (old) {
          const names = ['id', ...Object.keys(t.columns)];
          const params: Param[] = [];
          const exprs = names.map((c) => {
            if (c === 'id' || old.columns[c]) return q(c);
            const col = t.columns[c]!;
            params.push(col.default === undefined ? null : toParam(col.type, col.default, `${name}.${c}`));
            return '?';
          });
          this.#run(`INSERT INTO ${target} (${names.map(q).join(', ')}) SELECT ${exprs.join(', ')} FROM ${tableSql(name)}`, params);
          this.#db.exec(`DROP TABLE ${tableSql(name)}`);
          this.#db.exec(`ALTER TABLE ${target} RENAME TO ${q(`t:${name}`)}`);
        }
        for (const ix of t.indexes) {
          const unique = ix.unique ? 'UNIQUE ' : '';
          this.#db.exec(`CREATE ${unique}INDEX ${indexSql(name, ix.name)} ON ${tableSql(name)} (${ix.columns.map(q).join(', ')})`);
        }
      }
    });
    this.#schema = structuredClone(next);
    this.#stmts.clear();
    this.#version++;
    return true;
  }

  // ─────────────────────────────── mutations ───────────────────────────────

  /**
   * Applies one batch atomically and consumes one version. `generatedIds[i]` supplies the id the server returned for an insert
   * without id (the voter cannot know generated ids); without it the voter generates one. Throws VoterError with `opIndex` of the
   * first failing operation (checked in order, each operation fully before the next); then nothing is applied.
   */
  applyBatch(ops: readonly MutationIR[], generatedIds: readonly (string | undefined)[] = []): OpResult[] {
    if (!Array.isArray(ops) || ops.length < 1 || ops.length > 10_000) fail('INVALID_ARGUMENT', 'a batch has 1..10000 operations');
    if (bytes(JSON.stringify(ops)) > MAX_BATCH_BYTES) fail('INVALID_ARGUMENT', 'batch larger than 16 MiB');
    const results = this.#transaction(() =>
      ops.map((op, i) => {
        try {
          return this.#apply(op, generatedIds[i]);
        } catch (e) {
          if (e instanceof VoterError) throw new VoterError(e.code, e.message, i);
          throw e;
        }
      }),
    );
    this.#version++;
    return results;
  }

  /** One operation, its errors in the §7.1 order: INVALID_ARGUMENT, UNKNOWN_FIELD, TYPE_ERROR, then data errors. */
  #apply(op: MutationIR, generatedId: string | undefined): OpResult {
    const t = this.#table(op.table);
    switch (op.op) {
      case 'insert':
      case 'upsert': {
        const { id, names, params } = this.#buildRow(t, op.row, op.op === 'upsert', generatedId);
        if (op.op === 'insert' && this.#get(`SELECT 1 AS x FROM ${tableSql(op.table)} WHERE id = ?`, [id])) {
          fail('DUPLICATE_ID', `${op.table}/${id}`);
        }
        const conflict = op.op === 'upsert'
          ? names.length > 1
            ? ` ON CONFLICT(id) DO UPDATE SET ${names.slice(1).map((c) => `${q(c)} = excluded.${q(c)}`).join(', ')}`
            : ' ON CONFLICT(id) DO NOTHING'
          : '';
        this.#write(`INSERT INTO ${tableSql(op.table)} (${names.map(q).join(', ')}) VALUES (${names.map(() => '?').join(', ')})${conflict}`, params);
        return { id };
      }
      case 'update': {
        const id = idArg(op.id, 'update id');
        const entries = setEntries(op.set);
        setFields(t, entries);
        checkString(id, 'update id');
        const set = buildSet(t, entries);
        if (!this.#get(`SELECT 1 AS x FROM ${tableSql(op.table)} WHERE id = ?`, [id])) fail('NOT_FOUND', `${op.table}/${id}`);
        this.#updateRow(op.table, t, id, set);
        return {};
      }
      case 'delete': {
        const id = idArg(op.id, 'delete id');
        checkString(id, 'delete id');
        return { deleted: this.#write(`DELETE FROM ${tableSql(op.table)} WHERE id = ?`, [id]) > 0 };
      }
      case 'updateWhere': {
        const entries = setEntries(op.set);
        checkShape(op.where);
        setFields(t, entries);
        const { sql, params } = this.#where(t, op.where);
        const set = buildSet(t, entries);
        const ids = this.#all(`SELECT id FROM ${tableSql(op.table)} WHERE ${sql} ORDER BY id`, params).map((r) => r.id as string);
        for (const id of ids) this.#updateRow(op.table, t, id, set);
        return { count: ids.length };
      }
      case 'deleteWhere': {
        const { sql, params } = this.#where(t, op.where);
        return { count: this.#write(`DELETE FROM ${tableSql(op.table)} WHERE ${sql}`, params) };
      }
      default:
        return fail('INVALID_ARGUMENT', `unknown operation ${(op as { op: unknown }).op}`);
    }
  }

  /** Full row for insert/upsert: given values, else the default, else NULL (§7.1). */
  #buildRow(t: TableIR, row: Record<string, unknown>, upsert: boolean, generatedId: string | undefined) {
    if (!isObject(row)) fail('INVALID_ARGUMENT', 'row is not an object');
    if (bytes(JSON.stringify(row)) > MAX_ROW_BYTES) fail('INVALID_ARGUMENT', 'row larger than 1 MiB');
    let id: string;
    if (row.id === undefined) {
      if (upsert) fail('INVALID_ARGUMENT', 'upsert without id');
      id = generatedId ?? `voter_${++this.#generated}`;
    } else id = idArg(row.id, 'row id');
    for (const k of Object.keys(row)) if (k !== 'id' && row[k] !== undefined && !t.columns[k]) fail('UNKNOWN_FIELD', k);
    checkString(id, 'row id');
    const names = ['id'];
    const params: Param[] = [id];
    for (const [c, col] of Object.entries(t.columns)) {
      const given = row[c];
      const v = given !== undefined ? given : col.default !== undefined ? col.default : null;
      if (v === null && !col.nullable) fail('TYPE_ERROR', `${c} is required`);
      names.push(c);
      params.push(v === null ? null : toParam(col.type, v, c));
    }
    return { id, names, params };
  }

  #updateRow(table: string, t: TableIR, id: string, set: { assigns: string[]; params: Param[]; incs: string[] }) {
    const returning = set.incs.length ? ` RETURNING ${set.incs.map(q).join(', ')}` : '';
    const sql = `UPDATE ${tableSql(table)} SET ${set.assigns.join(', ')} WHERE id = ?${returning}`;
    if (!returning) return void this.#write(sql, [...set.params, id]);
    const row = this.#writeReturning(sql, [...set.params, id]);
    for (const c of set.incs) {
      const v = row[c];
      const ok = t.columns[c]!.type === 'int'
        ? typeof v === 'bigint' ? v >= -MAX_SAFE && v <= MAX_SAFE : Number.isSafeInteger(v)
        : Number.isFinite(Number(v));
      if (!ok) fail('TYPE_ERROR', `${c}: $inc result out of range`);
    }
  }

  // ─────────────────────────────── queries ───────────────────────────────

  /** Q(D_v) at the current version, with SDK value types (§6.2). */
  query(ir: QueryIR): VoterResult {
    const t = this.#table(ir.table);
    if (ir.kind === 'count') {
      const { sql, params } = this.#where(t, ir.where);
      const row = this.#get(`SELECT count(*) AS n FROM ${tableSql(ir.table)} WHERE ${sql}`, params);
      return { kind: 'count', count: Number(row!.n) };
    }
    if (ir.kind !== 'rows') fail('INVALID_ARGUMENT', 'unknown query kind');
    const orderBy = ir.orderBy ?? [];
    if (orderBy.length > 8) fail('INVALID_ARGUMENT', 'more than 8 orderBy keys');
    for (const o of orderBy) if (o.dir !== 'asc' && o.dir !== 'desc') fail('INVALID_ARGUMENT', `order direction ${o.dir}`);
    if (ir.limit !== null && (!Number.isInteger(ir.limit) || ir.limit < 1 || ir.limit > 10_000)) fail('INVALID_ARGUMENT', 'limit');
    if (ir.select !== null) {
      if (ir.select.length === 0 || new Set(ir.select).size !== ir.select.length || ir.select.includes('id')) {
        fail('INVALID_ARGUMENT', 'select must be non-empty, without duplicates and without id');
      }
    }
    if (ir.where) checkShape(ir.where);
    const cols = ir.select ?? Object.keys(t.columns);
    for (const c of [...orderBy.map((o) => o.field), ...cols]) this.#field(t, c);
    const where = this.#where(t, ir.where);
    for (const o of orderBy) if (this.#field(t, o.field) === 'json') fail('TYPE_ERROR', `sort on json column ${o.field}`);
    const keys = orderBy.map((o) => `${q(o.field)} ${o.dir.toUpperCase()}`);
    if (!orderBy.some((o) => o.field === 'id')) keys.push('id ASC');
    const limit = ir.limit ?? MAX_UNLIMITED_ROWS + 1;
    const raw = this.#all(
      `SELECT ${['id', ...cols].map(q).join(', ')} FROM ${tableSql(ir.table)} WHERE ${where.sql} ORDER BY ${keys.join(', ')} LIMIT ${limit}`,
      where.params,
    );
    if (ir.limit === null && raw.length > MAX_UNLIMITED_ROWS) fail('RESULT_TOO_LARGE', `more than ${MAX_UNLIMITED_ROWS} rows`);
    const rows = raw.map((r) => {
      const out: VoterRow = { id: r.id as string };
      for (const c of cols) out[c] = fromSql(t.columns[c]!.type, r[c]);
      return out;
    });
    return { kind: 'rows', rows };
  }

  /**
   * A voter holding `tables` (rows as `dump` returns them) under `schema` at `version`: replay resumes from a state the test read
   * back from the nodes after a gap in the acknowledged log (fault suites, §13.2).
   */
  static restore(schema: SchemaIR, tables: Record<string, readonly VoterRow[]>, version: number): Voter {
    const v = new Voter(schema);
    for (const [table, rows] of Object.entries(tables)) {
      for (let k = 0; k < rows.length; k += 1000) v.applyBatch(rows.slice(k, k + 1000).map((row) => ({ op: 'insert', table, row })));
    }
    v.#version = version;
    return v;
  }

  /** Every row of a table in id order (final-state comparisons, §13.2 R8). */
  dump(table: string): VoterRow[] {
    const r = this.query({ format: 'rsdb-query/1', kind: 'rows', table, where: null, orderBy: [], limit: null, select: null });
    return (r as { rows: VoterRow[] }).rows;
  }

  /** Translates a filter (§6.2 point 1). Structural errors are checked before field and type errors (§7.1 order). */
  #where(t: TableIR, expr: ExprIR | null): { sql: string; params: Param[] } {
    if (expr === null || expr === undefined) return { sql: '1', params: [] };
    checkShape(expr);
    const fields = (e: ExprIR): void => {
      if ('args' in e) e.args.forEach(fields);
      else this.#field(t, e.field);
    };
    fields(expr);
    const params: Param[] = [];
    const walk = (e: ExprIR): string => {
      switch (e.op) {
        case 'and':
        case 'or':
          if (e.args.length === 0) return e.op === 'and' ? '1' : '0';
          return `(${e.args.map(walk).join(e.op === 'and' ? ' AND ' : ' OR ')})`;
        case 'isNull':
        case 'notNull':
          this.#scalar(t, e.field, e.op);
          return `${q(e.field)} IS ${e.op === 'isNull' ? '' : 'NOT '}NULL`;
        case 'in':
        case 'nin': {
          const type = this.#scalar(t, e.field, e.op);
          if (e.values.length === 0) return e.op === 'in' ? '0' : '1';
          for (const v of e.values) params.push(toParam(type, v, `${e.field} ${e.op}`));
          return `${q(e.field)} ${e.op === 'in' ? 'IN' : 'NOT IN'} (${e.values.map(() => '?').join(', ')})`;
        }
        case 'startsWith': {
          const type = this.#scalar(t, e.field, e.op);
          if (type !== 'string' && type !== 'id') fail('TYPE_ERROR', `startsWith on ${type} column ${e.field}`);
          toParam('string', e.value, `${e.field} startsWith`);
          if (e.value === '') return `${q(e.field)} IS NOT NULL`;
          const prefix = Buffer.from(e.value, 'utf8');
          params.push(BigInt(prefix.length), new Uint8Array(prefix));
          return `substr(CAST(${q(e.field)} AS BLOB), 1, ?) = ?`;
        }
        default: {
          const type = this.#scalar(t, e.field, e.op);
          if (type === 'bool' && e.op !== 'eq' && e.op !== 'ne') fail('TYPE_ERROR', `${e.op} on bool column ${e.field}`);
          params.push(toParam(type, e.value, `${e.field} ${e.op}`));
          return `${q(e.field)} ${SQL_CMP[e.op]} ?`;
        }
      }
    };
    return { sql: walk(expr), params };
  }

  #scalar(t: TableIR, field: string, op: string): ColType {
    const type = this.#field(t, field);
    if (type === 'json') fail('TYPE_ERROR', `${op} on json column ${field}`);
    return type;
  }

  #field(t: TableIR, field: string): ColType {
    if (field === 'id') return 'id';
    return t.columns[field]?.type ?? fail('UNKNOWN_FIELD', field);
  }

  #table(name: string): TableIR {
    return this.#schema.tables[name] ?? fail('UNKNOWN_TABLE', name);
  }

  // ─────────────────────────────── SQLite plumbing ───────────────────────────────

  #transaction<T>(fn: () => T): T {
    this.#db.exec('SAVEPOINT voter');
    try {
      const r = fn();
      this.#db.exec('RELEASE voter');
      return r;
    } catch (e) {
      this.#db.exec('ROLLBACK TO voter; RELEASE voter');
      throw sqliteError(e);
    }
  }

  #stmt(sql: string): StatementSync {
    let s = this.#stmts.get(sql);
    if (!s) {
      if (this.#stmts.size > 4096) this.#stmts.clear();
      s = this.#db.prepare(sql);
      this.#stmts.set(sql, s);
    }
    return s;
  }

  #run(sql: string, params: Param[]): number {
    try {
      return Number(this.#stmt(sql).run(...params).changes);
    } catch (e) {
      throw sqliteError(e);
    }
  }
  #write(sql: string, params: Param[]): number {
    return this.#run(sql, params);
  }
  #writeReturning(sql: string, params: Param[]): Record<string, unknown> {
    try {
      const s = this.#stmt(sql);
      s.setReadBigInts(true);
      const row = s.get(...params) as Record<string, unknown>;
      s.setReadBigInts(false);
      return row;
    } catch (e) {
      throw sqliteError(e);
    }
  }
  #get(sql: string, params: Param[]): Record<string, unknown> | undefined {
    return this.#stmt(sql).get(...params) as Record<string, unknown> | undefined;
  }
  #all(sql: string, params: Param[]): Record<string, unknown>[] {
    return this.#stmt(sql).all(...params) as Record<string, unknown>[];
  }
}

type SetEntries = [string, unknown][];

function setEntries(set: SetIR): SetEntries {
  if (!isObject(set)) fail('INVALID_ARGUMENT', 'set is not an object');
  const entries = Object.entries(set).filter(([, v]) => v !== undefined);
  if (entries.length === 0) fail('INVALID_ARGUMENT', 'empty set');
  if (entries.some(([k]) => k === 'id')) fail('INVALID_ARGUMENT', 'id in set');
  // A patch carries row values: one over the row limit makes the row exceed it too (§5.3).
  if (bytes(JSON.stringify(set)) > MAX_ROW_BYTES) fail('INVALID_ARGUMENT', 'set larger than 1 MiB');
  return entries;
}

function setFields(t: TableIR, entries: SetEntries): void {
  for (const [k] of entries) if (!t.columns[k]) fail('UNKNOWN_FIELD', k);
}

/** Patch → SQL assignments: `$inc` as `coalesce(col, 0) + n` on int/float columns, a literal otherwise. */
function buildSet(t: TableIR, entries: SetEntries) {
  const assigns: string[] = [];
  const params: Param[] = [];
  const incs: string[] = [];
  for (const [c, v] of entries) {
    const col = t.columns[c]!;
    const numeric = col.type === 'int' || col.type === 'float';
    if (numeric && isObject(v)) {
      const n = (v as { $inc?: unknown }).$inc;
      if (Object.keys(v).length !== 1 || typeof n !== 'number') fail('TYPE_ERROR', `${c}: expected a value or { $inc: n }`);
      assigns.push(`${q(c)} = coalesce(${q(c)}, 0) + ?`);
      params.push(toParam(col.type, n, `${c} $inc`));
      incs.push(c);
    } else {
      if (v === null && !col.nullable) fail('TYPE_ERROR', `${c} is required`);
      assigns.push(`${q(c)} = ?`);
      params.push(v === null ? null : toParam(col.type, v, c));
    }
  }
  return { assigns, params, incs };
}

const SQL_CMP = { eq: '=', ne: '<>', lt: '<', lte: '<=', gt: '>', gte: '>=' } as const;

function checkShape(e: ExprIR | null): void {
  if (e === null) return;
  if (!isObject(e)) fail('INVALID_ARGUMENT', 'filter is not an object');
  if (e.op === 'and' || e.op === 'or') {
    if (!Array.isArray((e as { args?: unknown }).args)) fail('INVALID_ARGUMENT', `${e.op} without args`);
  }
  if ('args' in e) return e.args.forEach(checkShape);
  if (!(e.op in SQL_CMP) && !['in', 'nin', 'isNull', 'notNull', 'startsWith'].includes(e.op)) fail('INVALID_ARGUMENT', `operator ${e.op}`);
  if (typeof e.field !== 'string') fail('INVALID_ARGUMENT', 'filter without field');
  if ((e.op === 'in' || e.op === 'nin') && (!Array.isArray(e.values) || e.values.length > 1000)) {
    fail('INVALID_ARGUMENT', `${e.op} takes at most 1000 values`);
  }
}

function sqliteError(e: unknown): unknown {
  const code = (e as { errcode?: number }).errcode;
  if (code === 3091) return new VoterError('TYPE_ERROR', (e as Error).message); // SQLITE_CONSTRAINT_DATATYPE
  if (code !== undefined && (code & 0xff) === 19) return new VoterError('CONSTRAINT_VIOLATION', (e as Error).message);
  return e;
}

/** Table IR with indexes in a canonical order, so that a reordered push is not a change. */
function normTable(t: TableIR) {
  return { columns: t.columns, indexes: [...t.indexes].sort((a, b) => (a.name < b.name ? -1 : 1)) };
}
