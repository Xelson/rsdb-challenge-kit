/**
 * RSDB Challenge — normative public surface of the `@rsdb/client` package (SPEC.md §5–§9).
 *
 * A submission MUST export these runtime values and types with compatible signatures.
 * Extra exports and more precise types are allowed as long as `kit/types/api.test-d.ts`
 * compiles unchanged against the built package.
 */

// ═══════════════════════════════ Wire-neutral IR ═══════════════════════════════

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type ColumnType = 'string' | 'int' | 'float' | 'bool' | 'json';

export interface ColumnIR {
  type: ColumnType;
  nullable: boolean;
  /** Absent means "no default". */
  default?: JsonValue;
}
export interface IndexIR {
  name: string;
  columns: string[];
  unique: boolean;
}
export interface TableIR {
  /** The implicit `id` primary key is not listed. */
  columns: Record<string, ColumnIR>;
  indexes: IndexIR[];
}
export interface SchemaIR {
  format: 'rsdb-schema/1';
  tables: Record<string, TableIR>;
}

export type Literal = string | number | boolean;

export type ExprIR =
  | { op: 'and' | 'or'; args: ExprIR[] }
  | { op: 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte'; field: string; value: Literal }
  | { op: 'in' | 'nin'; field: string; values: Literal[] }
  | { op: 'isNull' | 'notNull'; field: string }
  | { op: 'startsWith'; field: string; value: string };

export interface OrderIR {
  field: string;
  dir: 'asc' | 'desc';
}
export interface RowsQueryIR {
  format: 'rsdb-query/1';
  kind: 'rows';
  table: string;
  where: ExprIR | null;
  /** The implicit `id asc` tiebreaker is not included. */
  orderBy: OrderIR[];
  limit: number | null;
  select: string[] | null;
}
export interface CountQueryIR {
  format: 'rsdb-query/1';
  kind: 'count';
  table: string;
  where: ExprIR | null;
}
export type QueryIR = RowsQueryIR | CountQueryIR;

/** `{ $inc: n }` is an increment only on int/float columns; on json columns it is a literal object. */
export type SetIR = Record<string, JsonValue | { $inc: number }>;

export type MutationIR =
  | { op: 'insert'; table: string; row: Record<string, JsonValue> }
  | { op: 'upsert'; table: string; row: Record<string, JsonValue> & { id: string } }
  | { op: 'update'; table: string; id: string; set: SetIR }
  | { op: 'delete'; table: string; id: string }
  | { op: 'updateWhere'; table: string; where: ExprIR | null; set: SetIR }
  | { op: 'deleteWhere'; table: string; where: ExprIR | null };

/** Per-operation result: insert/upsert → id, delete → deleted, *Where → count, update → {}. */
export type OpResult = { id: string } | { deleted: boolean } | { count: number } | Record<string, never>;

// ═══════════════════════════════ Errors ═══════════════════════════════

export type ErrorCode =
  | 'INVALID_ARGUMENT'
  | 'TYPE_ERROR'
  | 'UNKNOWN_FIELD'
  | 'UNKNOWN_TABLE'
  | 'UNKNOWN_DATABASE'
  | 'NOT_FOUND'
  | 'DATABASE_EXISTS'
  | 'DUPLICATE_ID'
  | 'CONSTRAINT_VIOLATION'
  | 'DESTRUCTIVE_CHANGE'
  | 'SCHEMA_MISMATCH'
  | 'RESULT_TOO_LARGE'
  | 'UNAVAILABLE'
  | 'TIMEOUT'
  | 'CLOSED'
  | 'INTERNAL';

export declare class RsdbError extends Error {
  constructor(
    code: ErrorCode,
    message: string,
    init?: { outcome?: 'not_applied' | 'unknown' | null; opIndex?: number | null },
  );
  readonly name: 'RsdbError';
  readonly code: ErrorCode;
  /**
   * Mutations only (SPEC §7.3): 'not_applied' if the request never left the SDK or the server rejected it;
   * 'unknown' for any other failure after it was sent, whatever the code. Null for reads.
   */
  readonly outcome: 'not_applied' | 'unknown' | null;
  /** Index of the failing operation inside a batch, if any. */
  readonly opIndex: number | null;
}

// ═══════════════════════════════ Schema DSL ═══════════════════════════════

export interface Column<V, N extends boolean = boolean, D extends boolean = boolean, K extends ColumnType = ColumnType> {
  readonly type: K;
  readonly nullable: N;
  readonly hasDefault: D;
  /** Phantom carrier of the TypeScript value type; never set at runtime. */
  readonly __value?: V;
  /** Make the column nullable (`T | null`); optional on insert. */
  optional(): Column<V, true, D, K>;
  /** Value used when the column is omitted on insert/upsert; makes it optional on insert. */
  default(value: V): Column<V, N, true, K>;
}
export type AnyColumn = Column<any, boolean, boolean, ColumnType>;
export type Columns = Record<string, AnyColumn>;

export declare const t: {
  string(): Column<string, false, false, 'string'>;
  /** Safe integer (|x| ≤ 2^53−1). */
  int(): Column<number, false, false, 'int'>;
  /** Finite IEEE-754 double. */
  float(): Column<number, false, false, 'float'>;
  bool(): Column<boolean, false, false, 'bool'>;
  /** Any JSON value except a top-level null (use `.optional()`); not filterable, sortable or indexable. `V` is a typing aid only. */
  json<V = NonNullable<JsonValue>>(): Column<V, false, false, 'json'>;
};

/** Columns that may appear in indexes, filters and sort keys (everything except json). */
export type ScalarColumnName<C extends Columns> = {
  [K in keyof C & string]: C[K] extends { type: 'json' } ? never : K;
}[keyof C & string];

export interface Table<C extends Columns = Columns> {
  readonly columns: C;
  readonly indexes: readonly IndexIR[];
  index(
    name: string,
    columns: readonly [ScalarColumnName<C>, ...ScalarColumnName<C>[]],
    options?: { unique?: boolean },
  ): Table<C>;
}

/** `id` is reserved: every table has an implicit `id: string` primary key. */
export declare function table<C extends Columns & { id?: never }>(columns: C): Table<C>;

export type Tables = Record<string, Table<any>>;

export interface Schema<T extends Tables = Tables> {
  readonly tables: T;
  toIR(): SchemaIR;
}
export type AnySchema = Schema<Tables>;

export declare function defineSchema<T extends Tables>(definition: { tables: T }): Schema<T>;

// ═══════════════════════════════ Type helpers ═══════════════════════════════

export type Simplify<T> = { [K in keyof T]: T[K] };

export type TableName<S extends AnySchema> = keyof S['tables'] & string;

export type ColumnsOf<S extends AnySchema, T extends TableName<S>> =
  S['tables'][T] extends Table<infer C extends Columns> ? C : never;

/** TypeScript value of a column, `| null` when nullable. */
export type ValueOf<C> = C extends Column<infer V, any, any, any> ? (C extends { nullable: true } ? V | null : V) : never;

type RequiredOnInsert = { nullable: false; hasDefault: false };
type Comparable = 'string' | 'int' | 'float';

export type FieldFilter<V, K extends ColumnType> = {
  eq?: V | null;
  ne?: V | null;
  in?: readonly V[];
  nin?: readonly V[];
} & (K extends Comparable ? { gt?: V; gte?: V; lt?: V; lte?: V } : {}) &
  (K extends 'string' ? { startsWith?: string } : {});

type RowOf<C extends Columns> = Simplify<{ id: string } & { [K in keyof C & string]: ValueOf<C[K]> }>;

type InsertOf<C extends Columns> = Simplify<
  { id?: string } & { [K in keyof C & string as C[K] extends RequiredOnInsert ? K : never]: ValueOf<C[K]> } & {
    [K in keyof C & string as C[K] extends RequiredOnInsert ? never : K]?: ValueOf<C[K]>;
  }
>;

type PatchOf<C extends Columns> = {
  [K in keyof C & string]?: ValueOf<C[K]> | (C[K]['type'] extends 'int' | 'float' ? { $inc: number } : never);
};

type WhereOf<C extends Columns> = {
  [K in keyof C & string as C[K] extends { type: 'json' } ? never : K]?:
    | ValueOf<C[K]>
    | FieldFilter<NonNullable<ValueOf<C[K]>>, C[K]['type']>;
} & {
  id?: string | FieldFilter<string, 'string'>;
  $and?: readonly WhereOf<C>[];
  $or?: readonly WhereOf<C>[];
};

export type Row<S extends AnySchema, T extends TableName<S>> = RowOf<ColumnsOf<S, T>>;
export type InsertRow<S extends AnySchema, T extends TableName<S>> = InsertOf<ColumnsOf<S, T>>;
export type UpsertRow<S extends AnySchema, T extends TableName<S>> = Simplify<InsertOf<ColumnsOf<S, T>> & { id: string }>;
export type Patch<S extends AnySchema, T extends TableName<S>> = PatchOf<ColumnsOf<S, T>>;
export type Where<S extends AnySchema, T extends TableName<S>> = WhereOf<ColumnsOf<S, T>>;

export type DataColumn<S extends AnySchema, T extends TableName<S>> = keyof ColumnsOf<S, T> & string;
export type SortableColumn<S extends AnySchema, T extends TableName<S>> =
  | 'id'
  | { [K in DataColumn<S, T>]: ColumnsOf<S, T>[K] extends { type: 'json' } ? never : K }[DataColumn<S, T>];

type ProjectOf<C extends Columns, K extends keyof C> = Simplify<{ id: string } & { [P in K]: ValueOf<C[P]> }>;

// ═══════════════════════════════ Client ═══════════════════════════════

export type ConnectionStatus = 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface ClientOptions<S extends AnySchema> {
  /** One or more node URLs (`http://host:7700`). The client may use any and MUST fail over to the others. */
  url: string | readonly string[];
  database: string;
  /** Typing aid; validation happens on the server. */
  schema?: S;
  /** Connection wait and default operation timeout. Default 10_000. */
  timeoutMs?: number;
}

export declare function createClient<S extends AnySchema = AnySchema>(options: ClientOptions<S>): Client<S>;

export interface ReadOptions {
  /** Default: `client.lastWriteVersion` (read-your-writes). Pass 0 to opt out. */
  minVersion?: number;
  timeoutMs?: number;
}
export interface SubscribeOptions {
  /** Default: `client.lastWriteVersion` (read-your-writes). Pass 0 to opt out. */
  minVersion?: number;
  /** `ready` rejects with TIMEOUT if no node can serve `minVersion` in time. Default: the client's `timeoutMs`. */
  timeoutMs?: number;
}

export interface RowsResult<R> {
  readonly rows: R[];
  readonly version: number;
}
export interface CountResult {
  readonly count: number;
  readonly version: number;
}

export interface RowsDiff<R> {
  /** `current.version` just before this callback (it may have advanced silently, SPEC R3). */
  readonly fromVersion: number;
  readonly added: readonly R[];
  /** Rows present before and after whose returned values changed (exactly those). */
  readonly updated: readonly R[];
  readonly removed: readonly string[];
}
export interface RowsSnapshot<R> {
  readonly version: number;
  /** Full ordered result; valid until the next callback; may be materialized lazily. */
  readonly rows: readonly R[];
  /** `null` for the first snapshot of a subscription. */
  readonly diff: RowsDiff<R> | null;
}
export interface CountSnapshot {
  readonly version: number;
  readonly count: number;
  /** `null` for the first snapshot of a subscription. */
  readonly previous: number | null;
}

export interface Subscription<Snap> {
  /** Resolves with the first snapshot; rejects if the subscription fails before it. */
  readonly ready: Promise<Snap>;
  /** Latest known exact result. Its version may advance without a listener call when the result is unchanged (SPEC R3). */
  readonly current: Snap | undefined;
  /** Highest version at which `current` is known to be the exact result (R7). -1 before the first snapshot. */
  readonly syncedVersion: number;
  readonly closed: boolean;
  /** Errors: listener exceptions (subscription continues) and terminal errors (closed becomes true). */
  onError(listener: (error: RsdbError) => void): () => void;
  unsubscribe(): void;
}

export interface CountQuery<S extends AnySchema, T extends TableName<S>> {
  toIR(): CountQueryIR;
  fetch(options?: ReadOptions): Promise<CountResult>;
  subscribe(listener: (snapshot: CountSnapshot) => void, options?: SubscribeOptions): Subscription<CountSnapshot>;
}

export interface RowsQuery<S extends AnySchema, T extends TableName<S>, R> {
  /** Repeated calls are AND-ed. */
  where(filter: Where<S, T>): RowsQuery<S, T, R>;
  /** Repeated calls append sort keys; `id asc` is always the implicit last key. */
  orderBy(column: SortableColumn<S, T>, direction?: 'asc' | 'desc'): RowsQuery<S, T, R>;
  /** 1..10_000. */
  limit(n: number): RowsQuery<S, T, R>;
  /** Projection; `id` is always included. A later call replaces an earlier one. */
  select<K extends DataColumn<S, T>>(...columns: [K, ...K[]]): RowsQuery<S, T, ProjectOf<ColumnsOf<S, T>, K>>;
  count(): CountQuery<S, T>;
  toIR(): RowsQueryIR;
  fetch(options?: ReadOptions): Promise<RowsResult<R>>;
  subscribe(listener: (snapshot: RowsSnapshot<R>) => void, options?: SubscribeOptions): Subscription<RowsSnapshot<R>>;
}

export interface Batch<S extends AnySchema> {
  insert<T extends TableName<S>>(table: T, row: InsertRow<S, T>): void;
  upsert<T extends TableName<S>>(table: T, row: UpsertRow<S, T>): void;
  update<T extends TableName<S>>(table: T, id: string, set: Patch<S, T>): void;
  delete<T extends TableName<S>>(table: T, id: string): void;
  updateWhere<T extends TableName<S>>(table: T, where: Where<S, T>, set: Patch<S, T>): void;
  deleteWhere<T extends TableName<S>>(table: T, where: Where<S, T>): void;
}

export interface Client<S extends AnySchema = AnySchema> {
  readonly database: string;
  readonly status: ConnectionStatus;
  /** Highest version among this client's acknowledged mutations; 0 initially. */
  readonly lastWriteVersion: number;

  from<T extends TableName<S>>(table: T): RowsQuery<S, T, Row<S, T>>;

  insert<T extends TableName<S>>(table: T, row: InsertRow<S, T>): Promise<{ id: string; version: number }>;
  upsert<T extends TableName<S>>(table: T, row: UpsertRow<S, T>): Promise<{ id: string; version: number }>;
  update<T extends TableName<S>>(table: T, id: string, set: Patch<S, T>): Promise<{ version: number }>;
  delete<T extends TableName<S>>(table: T, id: string): Promise<{ deleted: boolean; version: number }>;
  /** `{}` matches every row. */
  updateWhere<T extends TableName<S>>(table: T, where: Where<S, T>, set: Patch<S, T>): Promise<{ count: number; version: number }>;
  deleteWhere<T extends TableName<S>>(table: T, where: Where<S, T>): Promise<{ count: number; version: number }>;
  /** Atomic batch of 1..10_000 operations, applied in order (SPEC §7.2). */
  batch(build: (tx: Batch<S>) => void): Promise<{ version: number; results: OpResult[] }>;

  /** Resolves when every live subscription of this client has `syncedVersion >= version` (R7). */
  waitForVersion(version: number, options?: { timeoutMs?: number }): Promise<void>;
  onStatus(listener: (status: ConnectionStatus) => void): () => void;
  /** Ends all subscriptions; pending operations reject with `CLOSED`. */
  close(): Promise<void>;
}
