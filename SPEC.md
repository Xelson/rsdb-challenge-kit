# RSDB Challenge — Specification v1.0-draft

A head-to-head evaluation of autonomous coding harnesses. Each harness, working alone, builds the same
system: **a replicated, reactive database server on top of SQLite (Rust) plus a typed TypeScript SDK and CLI**.
Every submission exposes the same API, so one conformance suite and one benchmark measure all of them,
and every harness publishes the tokens it spent, measured by itself.

The key words MUST, MUST NOT, SHOULD, MAY are used as in RFC 2119. Sections marked *(informative)* are not requirements.

---

## 0. Roles and kit contents

- **Organizers** freeze the kit, run the infrastructure and the judge pipeline (build, conformance, benchmark, accounting checks) and
  publish results. They are a neutral third party accepted by both participants, or both participants acting jointly. Every system that
  produces evidence (LLM gateway, repositories, telemetry storage, provider account) is readable by both participants during and after
  the run, and no participant alone can alter its records.
- **Harness**: the autonomous coding system under test. A = Claude Code baseline (§16.5), B = challenger system. The harness, not a human, writes all code.
- **Submission**: the git repository a harness produces (§3).
- **Kit**: this directory, copied verbatim into every submission as `/kit` and frozen at commit `KIT_SHA` before kickoff.

| Path | Status | Purpose |
|---|---|---|
| `SPEC.md` | normative | this document |
| `api/rsdb.d.ts` | normative | public TypeScript surface of `@rsdb/client` and the wire-neutral IR |
| `types/api.test-d.ts` | normative | compile-time API tests (suite T7) |
| `bench/schema.ts` | normative | benchmark schema |
| `accounting/usage-event.schema.json`, `accounting/usage.schema.json` | normative | token accounting formats |
| `conformance/` | organizers ship before kickoff | suites T1–T7, D1–D5, F1–F4, SQLite voter (§13.3), fault proxy |
| `bench/runner/`, `bench/run-local.sh` | organizers ship before kickoff | load generators, metric collection, scoring, local runs (§14.6) |
| `docker/`, `rust-toolchain.toml` | organizers ship before kickoff | build images; compose files for 1 and 3 nodes |
| `accounting/prices.json`, `accounting/verify/`, `accounting/CALIBRATION.md` | organizers ship before kickoff | price table, usage verifier, calibration task |
| `RUNBOOK.md` | organizers ship before kickoff | infrastructure recovery procedure (§16.3) |
| `package.json`, `types/tsconfig.judge.json` | normative | pinned TypeScript version and compiler settings for T7 |

The kit MUST be complete and frozen before kickoff; nothing in it changes during a run.

## 1. Parameters (agreed before kickoff)

| ID | Parameter | Default |
|---|---|---|
| P1 | Wall-clock limit `T_MAX` (kickoff → `submission` tag push) | 12 h |
| P2 | Cost cap `COST_CAP` (list-price USD, §16.3) | $400 |
| P3 | Max operator nudges `N_NUDGE`, penalty per nudge | 3, −1 Q point each |
| P4 | Token verification level (§17.6) | V1 (organizer LLM gateway confirmed by the provider's usage report) for both; pay-as-you-go API keys only, no subscription plans |
| P5 | Dev machine (identical for both) | Linux x86_64, 16 vCPU, 32 GB RAM, 200 GB NVMe, Docker, Node 24 LTS, toolchain from `rust-toolchain.toml`, internet access |
| P6 | Bench host (same for both) | Linux x86_64, 32 dedicated vCPU, 64 GB RAM, NVMe, cgroup v2 |
| P7 | Bench repetitions | 3, median |
| P8 | Winner thresholds (§15.3) | ΔQ ≥ 3 points; cost difference ≥ 15 % |
| P9 | Kit commit | `KIT_SHA` |
| P10 | Outbound network allowlist for dev machines, by exact host name | the LLM gateway, the only LLM endpoint; crates.io and its index and static hosts; registry.npmjs.org; github.com (own repository through the push key, public read); docs.rs, doc.rust-lang.org, sqlite.org, nodejs.org, typescriptlang.org, developer.mozilla.org |

---

## 2. What to build

1. **`rsdb-server`** (Rust): hosts many databases, each backed by SQLite; tables defined by a declarative schema; mutations,
   one-shot queries and **live queries** (subscriptions) that push incremental diffs; optional 3-node replication.
2. **`@rsdb/client`** (TypeScript, Node 24): typed schema DSL, typed query builder, mutations, subscriptions; plus the **`rsdb` CLI**
   that creates databases and publishes (pushes) a schema written in TypeScript.

Levels:

| Level | Content | Scored by |
|---|---|---|
| L1 core | single node, everything in §4–§10 | T1–T7, B1–B9, B12, B13 |
| L2 replication | 3-node cluster, static leadership, follower reads, write forwarding (§11.1) | D1–D5, B10 |
| L3 failover | automatic leader election, majority commit (§11.2) | F1–F4, B11 |

Out of scope: authentication, row-level security, TLS, joins, aggregates other than `count`, full-text search, browser support,
cluster membership changes, backups, more than 3 nodes.

The optimization targets are memory footprint, update delivery latency, the cost of handling many subscriptions, and the size and
precision of diffs. The start of §14 shows how many points each one carries.

---

## 3. Submission layout and build contract

```
/server/              Cargo workspace; binary target `rsdb-server`; Cargo.lock committed
/server/PROTOCOL.md   wire protocol documentation (§12)
/sdk/                 npm package `@rsdb/client` (ESM); package-lock.json committed; bin `rsdb`
/kit/                 verbatim copy of the kit at KIT_SHA — MUST NOT be modified (checksum-verified)
/README.md            how to build and run; run summary (§18)
/RESULTS/             run evidence and token accounting (§17, §18)
```

Build, performed by the judge with the kit images:

- server: `cargo build --release --locked -p rsdb-server` using `kit/rust-toolchain.toml`. Cargo profile settings
  (LTO, codegen-units, panic strategy) and allocator choice are up to the submission.
- sdk: `npm ci && npm run build` in `/sdk`. The result MUST be importable as `@rsdb/client` (with types) and MUST provide the `rsdb` bin.
- No system packages beyond the kit images. SQLite MUST be compiled from source through a crate (for example `rusqlite` with `bundled`), version ≥ 3.46.

Dependencies:

- Allowed: any OSI-licensed general-purpose crate or npm package: async runtimes, SQLite bindings, serialization, compression,
  consensus libraries (`openraft`, `raft-rs`), allocators. SQLite's own session/changeset extension, update hooks and pre-update hooks are allowed.
- Forbidden: embedding, wrapping or copying products that already provide the core features: replicated SQLite servers
  (rqlite, dqlite, LiteFS, Litestream, libSQL/sqld, mvSQLite, Marmot, cr-sqlite) and sync or reactive engines (ElectricSQL, PowerSync,
  Zero, Convex, InstantDB, Triplit, RxDB and similar). SQLite forks (libSQL, SQLCipher) are forbidden.

---

## 4. Server process contract

### 4.1 Flags

```
rsdb-server --data-dir <path> [--listen <host:port>] [--node-id <id>]
            [--peers <id>=<host:port>,<id>=<host:port>,...] [--peer-listen <host:port>]
```

| Flag | Default | Meaning |
|---|---|---|
| `--data-dir` | required | all persistent state; restarting on the same dir MUST restore every acknowledged change |
| `--listen` | `0.0.0.0:7700` | the only port for SDK, CLI and admin traffic (HTTP/1.1) |
| `--node-id` | `n1` | node name |
| `--peers` | absent = single node | full membership including self; addresses are peers' `--peer-listen` endpoints |
| `--peer-listen` | `0.0.0.0:7701` | inter-node traffic only (cluster mode) |

Extra flags are allowed if they have defaults; the judge passes only the flags above. `RSDB_LOG` sets log verbosity; logs go to stderr.

### 4.2 Lifecycle

- `GET /healthz` returns 200 within 5 s of start (single node, empty data dir), or within 15 s after all 3 nodes started (cluster).
  Before that it returns 503 or refuses connections.
- SIGTERM: graceful exit within 5 s. SIGKILL at any moment MUST NOT lose acknowledged state (§7.3).
- The server writes only inside `--data-dir` (and the system temp dir).
- With `ulimit -n 65536` a node MUST handle ≥ 25,000 concurrent client connections and ≥ 10,000 databases (opening them lazily is fine).

### 4.3 Admin HTTP API

Served on `--listen` by every node. JSON bodies. Errors: `{"error":{"code":ErrorCode,"message":string}}` with the HTTP status from Appendix C.

| Method and path | Request | Success response |
|---|---|---|
| `GET /healthz` | — | 200 `{"status":"ok","nodeId":"n1"}` |
| `POST /v1/databases` | `{"name":"app"}` | 201 `{"name":"app","incarnation":string,"version":0}` |
| `GET /v1/databases` | — | 200 `[{"name","incarnation","version","schemaVersion","leader"}]` |
| `DELETE /v1/databases/{name}` | — | 204 |
| `GET /v1/databases/{name}/schema` | — | 200 `{"schemaVersion":n,"schema":SchemaIR}` |
| `PUT /v1/databases/{name}/schema?dryRun=0\|1&force=0\|1` | `SchemaIR` | 200 `PushResult` (409 `DESTRUCTIVE_CHANGE` carries the plan in `error.plan`) |
| `GET /v1/cluster` | — | 200 `{"nodes":[{"id","addr","alive"}],"databases":{"<db>":{"leader":"n1","applied":{"n1":v,"n2":v,"n3":v}}}}` |
| `GET /v1/stats` | — | 200 `{"connections":n,"subscriptions":n,"uniqueQueries":n,"openDatabases":n}` |

```
PushResult = { applied: boolean, version: number | null, schemaVersion: number, plan: PlanStep[] }
PlanStep   = { action: "createTable" | "dropTable" | "addColumn" | "dropColumn" | "makeNullable" | "makeRequired"
                     | "setDefault" | "createIndex" | "dropIndex",
               table: string, column?: string, index?: string, destructive: boolean }
```

- `schemaVersion` is the database version at which the current schema was applied; 0 before the first push.
- A plan has one step per change and is compared as a multiset. `createTable` alone covers the new table's columns and indexes;
  `dropTable` alone covers its indexes; changing an index (its columns or `unique`) is `dropIndex` + `createIndex`. `destructive` is true
  exactly for `dropTable`, `dropColumn` and `makeRequired`.
- `dryRun=1` returns exactly what the real push would return, including 409 `DESTRUCTIVE_CHANGE` without `force`, and applies nothing.
- `/v1/stats`: `connections` = open client connections; `subscriptions` = live SDK `Subscription` handles (the same query subscribed
  twice counts twice); `uniqueQueries` = distinct live queries after any deduplication. It is self-reported and used only for leak gates
  (R11, B6), never for performance points.
- In cluster mode admin writes (create, drop, push) sent to any node apply cluster-wide (§11.1).
- An admin write returns 2xx only once its effect is durable (§7.3). Versions and other state in admin responses follow the commit point (§8.1).

All SDK traffic MUST use the `--listen` port, via HTTP/1.1 Upgrade (WebSocket or a custom upgrade protocol). The wire format is free (§12).

---

## 5. Data model and schema

### 5.1 Concepts

A node hosts **databases**. A database is an isolated namespace with its own schema, tables and version counter (§8.1).
A **table** holds rows; every row has the primary key `id: string`.

### 5.2 Column types

| Type | TS value | Filter operators | Sortable |
|---|---|---|---|
| `string` | `string` | `eq ne in nin lt lte gt gte startsWith`, null checks | yes, UTF-8 byte order |
| `int` | `number`, safe integer (abs ≤ 2^53−1) | `eq ne in nin lt lte gt gte`, null checks | yes |
| `float` | `number`, finite | `eq ne in nin lt lte gt gte`, null checks | yes |
| `bool` | `boolean` | `eq ne in nin`, null checks | yes, `false < true` |
| `json` | any JSON value | none | no |
| `id` (implicit) | `string` | as `string` | yes |

Columns are NOT NULL unless declared `.optional()`. `.default(v)` supplies the value when a column is omitted on insert or upsert.
For an optional `json` column, JSON `null` and SQL NULL are the same value; a required `json` column rejects `null`.
Storage layout (affinity, JSON as TEXT or JSONB, extra internal columns) is the implementation's choice.

Value rules for rows, patches, filter literals and ids:

- Strings MUST be well-formed Unicode (no lone surrogates) without U+0000; otherwise `TYPE_ERROR`.
- `-0` is stored and returned as `0`.
- A key whose value is `undefined` is absent: in rows the default applies, in patches the column is untouched, in filters there is no
  condition. A patch that becomes empty this way is `INVALID_ARGUMENT`.

### 5.3 Names and limits

- Database names: `^[a-z][a-z0-9_]{0,62}$`.
- Table, column and index names: `^[A-Za-z][A-Za-z0-9_]{0,62}$`, unique case-insensitively within their scope (index names: per table).
  Lookups are exact-case. `id` is reserved as a column name.
- Client-supplied ids: 1–128 bytes of UTF-8 without U+0000. Server-generated ids: ≤ 64 chars of `[0-9A-Za-z_-]`, unique within the table.
- ≤ 256 tables per database, ≤ 256 columns and ≤ 32 indexes per table.
- Sizes are measured as UTF-8 bytes of `JSON.stringify` of the value, independent of the wire encoding: a row ≤ 1 MiB, a batch's
  `MutationIR[]` ≤ 16 MiB; larger → `INVALID_ARGUMENT`. Transports MUST accept frames up to 17 MiB.

### 5.4 TypeScript schema DSL

The normative types are in `api/rsdb.d.ts`. A schema file looks like this:

```ts
import { defineSchema, table, t } from '@rsdb/client';

export default defineSchema({
  tables: {
    users: table({
      name: t.string(),
      age: t.int().optional(),
      active: t.bool().default(true),
    }).index('by_age', ['age']),
    todos: table({
      ownerId: t.string(),
      title: t.string(),
      done: t.bool().default(false),
      createdAt: t.int(),
    }).index('by_owner_created', ['ownerId', 'createdAt']),
  },
});
```

The default export of a schema file MUST be the value returned by `defineSchema`. The file MAY import other modules; relative imports
carry explicit extensions (`./columns.ts`). The CLI MUST load a `.ts` schema file from any location (Node 24 type stripping or its own
bundling): `@rsdb/client` imported by the schema or its modules resolves to the CLI's own package, whether or not a `node_modules`
exists nearby. The CLI calls `toIR()` on the default export without `instanceof` checks. `schema.toIR()` returns the `SchemaIR`.

### 5.5 Schema push and migrations

A push compares the desired `SchemaIR` with the current one and computes a plan:

| Change | Class |
|---|---|
| create table; drop index; change default; required → optional | safe |
| add column that is optional or has a default | safe |
| create index | safe; a unique index fails with `CONSTRAINT_VIOLATION` if duplicates exist |
| optional → required | destructive; with `force` fails with `CONSTRAINT_VIOLATION` if NULLs exist |
| drop column; drop table | destructive |
| add required column without default; change column type; index on a `json` column | rejected (`INVALID_ARGUMENT`) |
| rename | not supported (it is a drop plus an add) |

- A destructive plan without `force` is refused with `DESTRUCTIVE_CHANGE` and nothing is applied. Dry runs: §4.3.
- A push is atomic. A non-empty plan commits exactly one version (§8.1). An empty plan is a no-op: `applied: false`, no version consumed.
- An added column with a default fills existing rows with the default; an added optional column without one fills them with NULL.
- NULLs are distinct in unique indexes (as in SQLite).
- Live subscriptions on changed tables: a query *references* a column if it appears in its `where`, `orderBy` or `select`. If every
  referenced table and column still exists, the query is re-evaluated at the new version and a snapshot is delivered if the result changed
  (for example unprojected rows gaining or losing a column). Otherwise the subscription is terminated with `SCHEMA_MISMATCH`.

---

## 6. Queries

### 6.1 Query IR

The SDK builds queries with a typed builder (`client.from(table).where(...).orderBy(...).limit(...).select(...)`, or `.count()`).
`query.toIR()` returns the wire-neutral `QueryIR` defined in `api/rsdb.d.ts`:

```ts
type ExprIR =
  | { op: 'and' | 'or'; args: ExprIR[] }
  | { op: 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte'; field: string; value: string | number | boolean }
  | { op: 'in' | 'nin'; field: string; values: (string | number | boolean)[] }
  | { op: 'isNull' | 'notNull'; field: string }
  | { op: 'startsWith'; field: string; value: string };

type QueryIR =
  | { format: 'rsdb-query/1'; kind: 'rows'; table: string; where: ExprIR | null;
      orderBy: { field: string; dir: 'asc' | 'desc' }[]; limit: number | null; select: string[] | null }
  | { format: 'rsdb-query/1'; kind: 'count'; table: string; where: ExprIR | null };
```

`toIR()` output must be semantically equivalent to the builder calls; its exact shape (nesting of `and`) is not tested.

### 6.2 Semantics

These rules deliberately coincide with stock SQLite: BINARY collation, default NULL ordering, and SQL comparison semantics, which reduce
to two-valued logic because the IR has no general NOT. The SQLite voter (§13.3) therefore evaluates them by direct translation.

1. **Filter.** Two-valued logic per row:
   - every comparison (`eq`/`ne` with a non-null value, `lt`, `lte`, `gt`, `gte`, `in`, `nin`, `startsWith`) on a NULL field is **false**;
   - `in []` is false; `nin []` is true, also for NULL; `and []` is true; `or []` is false;
   - a literal MUST match the column type (string → string, int → safe integer, float → finite number, bool → boolean), otherwise `TYPE_ERROR`;
     so does an operator not defined for the column type (§5.2), and any filter or sort on a `json` column;
   - strings compare by UTF-8 bytes (memcmp, SQLite `BINARY` collation). JS `<` on strings compares UTF-16 code units and disagrees
     for code points above U+FFFF versus U+E000–U+FFFF;
   - `startsWith` is a case-sensitive byte prefix. SQLite `LIKE` is case-insensitive for ASCII and treats `%`/`_` as wildcards, so it is not a drop-in;
   - in the DSL, repeated `.where()` calls, keys of one filter object, and operators inside one field filter are all AND-ed;
     `{f: null}` and `{f: {eq: null}}` mean `isNull`, `{f: {ne: null}}` means `notNull`; `$or`/`$and` take arrays of filters.
2. **Order.** By the `orderBy` keys, then `id ASC` as the implicit final tiebreaker (unless `id` is already a key).
   NULL sorts before every value in ASC and after every value in DESC. No `orderBy` means `id ASC`.
3. **Limit.** 1..10,000 rows. Without a limit the result may hold at most 100,000 rows, otherwise `RESULT_TOO_LARGE`
   (on subscribe or fetch, or later when a live result grows past it, which terminates the subscription).
4. **Projection.** `select` (non-empty, no duplicates, without `id`) returns `id` plus the selected columns; no `select` returns all columns.
5. **Count.** Number of rows matching the filter; `orderBy`, `limit` and `select` set before `.count()` are ignored.
6. Limits: `in` ≤ 1,000 values; nesting of the user's `$and`/`$or` ≤ 16 levels; ≤ 8 `orderBy` keys, not counting the implicit `id`.

### 6.3 Execution forms

- `fetch()`: one-shot read, consistent at a single version, returns `{rows, version}` or `{count, version}`.
- `subscribe(listener)`: live query (§8).

---

## 7. Mutations

### 7.1 Operations

| Operation | Semantics | Result |
|---|---|---|
| `insert(table, row)` | omitted columns take the default or NULL; a missing required column → `TYPE_ERROR`; unknown field → `UNKNOWN_FIELD`; existing id → `DUPLICATE_ID`; unique index violation → `CONSTRAINT_VIOLATION`; no `id` → server-generated | `{id}` |
| `upsert(table, row)` | `row.id` required; inserts, or replaces the whole row (omitted columns take default/NULL) | `{id}` |
| `update(table, id, set)` | partial update; unknown id → `NOT_FOUND` | `{}` |
| `delete(table, id)` | a missing id is not an error | `{deleted}` |
| `updateWhere(table, where, set)` | updates all matching rows; `{}` matches all | `{count}` (rows matched) |
| `deleteWhere(table, where)` | deletes all matching rows | `{count}` |

`set` MUST be non-empty and MUST NOT contain `id`. `{ $inc: n }` is allowed on `int` and `float` columns: NULL counts as 0, and an int
result outside the safe range → `TYPE_ERROR`. On a `json` column `{ $inc: n }` is an ordinary JSON object.

Cases not named above:

| Case | Code |
|---|---|
| empty `set`; `id` in `set`; `upsert` without `id`; an id that is not a string, empty or over 128 bytes; limits of §5.3, §6.2, §7.2 | `INVALID_ARGUMENT` |
| operator not defined for the column type; filter or sort on `json`; non-integer `$inc` on int; a result that is not finite or not a safe integer | `TYPE_ERROR` |

When several errors apply, the first in this order wins: `UNKNOWN_DATABASE`, `UNKNOWN_TABLE`, `INVALID_ARGUMENT`, `UNKNOWN_FIELD`,
`TYPE_ERROR`, then data errors (`NOT_FOUND`, `DUPLICATE_ID`, `CONSTRAINT_VIOLATION`).

### 7.2 Batches

Every mutation is a batch of 1..10,000 operations (≤ 16 MiB, §5.3); single-operation SDK calls are batches of one.
Operations apply in order inside one transaction, and later operations see the effects of earlier ones. If any operation fails,
nothing is applied, no version is consumed, and the error carries `opIndex` of the first failing operation. Interactive
(read-then-write) transactions are out of scope.

### 7.3 Acknowledgement and durability

A resolved mutation promise means the batch is committed with version `v` and durable: it survives SIGKILL of any process (L1, L2)
and, under L3, the loss of any one node. *Loss* means a crash or a network partition with the node's data dir intact. Power-loss
durability is out of scope; SQLite WAL with `synchronous=NORMAL` is acceptable.

Every mutation promise settles within `timeoutMs` + 1 s. Every mutation error has a `code` for its cause and an independent `outcome`:

- `'not_applied'`: the request never left the SDK, or a node answered that the batch was not applied and never will be. A node that cannot
  know this (a follower whose forwarded request got no answer, a leader that lost leadership before the commit) MUST say so in its
  answer, and the SDK then reports `'unknown'`.
- `'unknown'`: every other failure after the request may have left the SDK, whatever the `code` (typically `UNAVAILABLE`, `TIMEOUT`, `CLOSED`).

Tests classify mutation errors by `outcome` only. Neither the SDK nor a node forwarding a write may resend a batch whose outcome is
unknown, unless the server deduplicates it (for example client idempotency keys, which is encouraged). Deduplication records are part of
the replicated, durable state and survive failover; a deduplicated retry returns the original version.

---

## 8. Versions, consistency, reactivity

### 8.1 Versions

Each database has a version counter: 0 at creation, +1 for every committed batch and every applied non-empty schema push.
A version is the position of a batch or push among the database's committed ones, assigned when it is applied; failed batches consume
none, so versions are dense. Cluster-wide, at most one batch or push is ever acknowledged for a given version.
`D_v` is the database state after version `v`; `Q(D_v)` is query `Q` evaluated by §6.2 on it.

**Commit point.** No output refers to version `v` before `v` is durable on the node producing it (§7.3) and, under L3, committed on a
majority: not acknowledgements, snapshots, `fetch` results, `version` in `/v1/databases`, `applied` in `/v1/cluster`, nor a `PushResult`.
After a restart a node's state is a prefix of the committed history.

**Incarnations.** Each creation of a database gets a new `incarnation` id, returned by `POST /v1/databases`, listed by
`GET /v1/databases` and checked in the SDK handshake. Versions count within one incarnation. Create and drop of a name are linearizable.
A client binds to the first incarnation it observes; once that incarnation is dropped, its subscriptions end and its operations fail
with `UNKNOWN_DATABASE`, even if a database with the same name exists again.

### 8.2 Invariants

| ID | Invariant |
|---|---|
| R1 | **Snapshot correctness.** A snapshot delivered with version `v` has `rows` exactly equal to `Q(D_v)` (order and values); a count snapshot has `count = count(D_v)`. |
| R2 | **Monotonicity.** Within one subscription, successive listener calls have strictly increasing versions, also across reconnects. `current.version` and `syncedVersion` never decrease. |
| R3 | **No spurious callbacks.** The listener runs for the first snapshot and then only when the result differs from the one passed to the previous call (ids, order, or any returned value; JSON compared deeply, key order ignored). When a newer version leaves the result unchanged, the SDK advances `current.version` and `syncedVersion` without calling the listener. |
| R4 | **Convergence.** If no writes follow version `v`, every live subscription reaches `syncedVersion ≥ v`. Conformance bound: 5 s without faults; under partitions see §11.2. |
| R5 | **Diff correctness.** `diff.fromVersion` is `current.version` just before the call. `diff.removed` = ids present in the previous call's rows and absent now; `diff.added` = rows absent before and present now; `diff.updated` = exactly the rows present in both whose returned values changed. A pure reorder produces a callback whose diff sets may be empty; order is conveyed by `rows`. |
| R6 | **Read-your-writes.** `subscribe` and `fetch` default to `minVersion = client.lastWriteVersion`; the first snapshot (or fetch result) has `version ≥ minVersion`. A node that cannot reach `minVersion` (for example it is cut off from the leader) answers `UNAVAILABLE` and the SDK tries its other URLs; once the operation's `timeoutMs` has passed, `ready` or `fetch` rejects with `TIMEOUT`. |
| R7 | **Synced version.** `sub.syncedVersion = s` means `current.rows = Q(D_u)` for every `u` in `[current.version, s]`. `client.waitForVersion(v)` resolves only when the node the client is connected to has applied `v`, every live subscription of the client has `syncedVersion ≥ v`, and every listener call for snapshots with version ≤ `v` has completed; it rejects with `TIMEOUT` after `timeoutMs`. |
| R8 | **No fork.** For any database and version `v`, all nodes and all subscribers observe the same `D_v`. |
| R9 | **Atomicity.** No observation reflects a partially applied batch (follows from R1). |
| R10 | **Reconnect transparency.** After a lost connection the SDK reconnects (to any URL in its list) with backoff and resubscribes with `minVersion = max(lastWriteVersion, syncedVersion)`; R1–R3 keep holding; no reset-to-empty, no repeated initial snapshot, no callback if the result did not change across the gap. |
| R11 | **Unsubscribe.** After `unsubscribe()` the listener never runs again, and `/v1/stats.subscriptions` reflects the release within 1 s. `client.close()` releases its connection. |
| R12 | **Isolation.** Writes in database X never cause callbacks or version changes in database Y. |

Coalescing is allowed and encouraged under load: a subscription may skip intermediate versions and deliver only the latest state;
the diff then spans `fromVersion → version`. A listener that throws is reported through `sub.onError`; the subscription continues.
Deleting a database terminates its subscriptions with `UNKNOWN_DATABASE`. The server MUST bound the memory spent on a slow consumer
(coalesce per subscription rather than queue every change); B9 tests this.

---

## 9. TypeScript SDK

The normative surface is `api/rsdb.d.ts`. A submission MUST export the same runtime values (`createClient`, `defineSchema`, `table`,
`t`, `RsdbError`) and types. It MAY add exports or make types more precise, as long as `kit/types/api.test-d.ts` compiles unchanged
against the built package.

```ts
import { createClient } from '@rsdb/client';
import schema from './schema.ts';

const db = createClient({ url: ['http://n1:7700', 'http://n2:7700'], database: 'app', schema });

const { id } = await db.insert('todos', { ownerId: 'u1', title: 'write spec', createdAt: Date.now() });

const sub = db.from('todos')
  .where({ ownerId: 'u1', done: false })
  .orderBy('createdAt', 'desc')
  .limit(20)
  .select('title', 'createdAt')
  .subscribe(({ rows, diff, version }) => render(rows));     // rows: { id; title; createdAt }[]

await db.update('todos', id, { done: true });                 // sub fires: row removed
const open = await db.from('todos').where({ done: false }).count().fetch();
sub.unsubscribe();
```

Behaviour:

- Runtime: Node 24 LTS, ESM. Browser support is not required.
- Each `Client` owns exactly one transport connection: opened by `createClient`, kept open while idle, re-established after a loss,
  closed only by `close()`, never shared with another client. (The benchmark treats every client as a separate device.)
- `createClient` never throws for connectivity problems. Operations wait up to `timeoutMs` (default 10,000) for a connection, then fail with `UNAVAILABLE`.
- With several URLs the client may connect to any of them and MUST try the others on failure.
- Builder methods and `subscribe()` never throw; errors arrive through promises, `ready` and `onError`. `ready` never causes an
  unhandled rejection. `unsubscribe()` or `close()` before the first snapshot rejects `ready` with `CLOSED`. `onError` fires for listener
  exceptions and for termination by the server, not for a close the user asked for.
- The schema passed to `createClient` serves typing; validation happens on the server.
- `snapshot.rows` stays valid until the next callback and MAY be materialized lazily. Unchanged row objects SHOULD keep their identity across snapshots.
- `lastWriteVersion` is the highest version among this client's acknowledged mutations.
- `close()` ends all subscriptions and rejects pending operations with `CLOSED`.
- One client serves one database. A process may hold thousands of clients (the benchmark does); clients MUST NOT share state in a way that breaks this.
- Every error the SDK throws or reports is an `RsdbError`.

---

## 10. CLI

Shipped in `@rsdb/client` as bin `rsdb`. Global options: `--url <http://host:port>` (default: env `RSDB_URL`, then `http://127.0.0.1:7700`),
`--json` (print the admin API response body verbatim).

| Command | Effect |
|---|---|
| `rsdb db create <name>` | create a database |
| `rsdb db list` | list databases |
| `rsdb db drop <name> --yes` | delete a database |
| `rsdb push <schema.ts> --db <name> [--dry-run] [--force]` | load the TS schema, print the plan, apply it |
| `rsdb schema show --db <name>` | print the current `SchemaIR` |
| `rsdb status` | print `/v1/cluster` |

Exit codes:

| Code | Meaning |
|---|---|
| 0 | success, including a no-op push and a dry run that would succeed |
| 1 | other errors, including `UNKNOWN_DATABASE` (push never creates a database) |
| 2 | usage error, including `db drop` without `--yes` |
| 3 | destructive change refused, also on `--dry-run` |
| 4 | server unreachable |
| 5 | a schema file that fails to load, or `INVALID_ARGUMENT` / `CONSTRAINT_VIOLATION` from a push |

---

## 11. Distribution

### 11.1 L2: replication

- A cluster is exactly 3 nodes started with identical `--peers`.
- Every database exists on every node. Each database has exactly one leader at a time; under L2 leadership MAY be static
  (deterministic, for example a hash of the name) and SHOULD spread databases across nodes.
- Every node accepts SDK connections for every database. Reads and subscriptions are served from the local replica; writes are
  forwarded to the leader transparently.
- Replication preserves version order. R1–R12 hold cluster-wide, and R6 holds for a client connected to a follower.
- L2 MAY replicate asynchronously: an acknowledged write is durable on the leader (§7.3) and reaches the followers later. L2 promises
  nothing about a database while its leader is down; the D suites crash only nodes that lead no database under test.
- A follower that crashes or restarts catches up automatically. Writes continue while a follower is down. A restarted node serves
  `/healthz` within 15 s and has caught up within 30 s.
- Admin writes go through the cluster: create and drop of a name are linearizable, and a push is an entry in the database's replicated
  log, planned by the leader against the schema at the version where it applies. A node never answers `UNKNOWN_DATABASE`,
  `UNKNOWN_TABLE`, `SCHEMA_MISMATCH` or `DATABASE_EXISTS` from stale state: it catches up first, or answers `UNAVAILABLE` if it cannot
  within the request's timeout.
- Nodes MAY report different leaders for a database for up to 10 s after a fault; otherwise every node reports the same leader.
- Replication SHOULD ship row-level changes (changesets, WAL frames), never per-subscription data; B10 measures bytes between nodes per write.

### 11.2 L3: automatic failover

- **Partition model.** A partition cuts traffic between nodes; clients may still reach every node. A node that has been out of contact
  with a majority for more than 3 s rejects SDK operations with `UNAVAILABLE` and closes its SDK sessions, so clients move to another URL.
  The SDK detects a dead or silent connection within 5 s (for example with heartbeats).
- **Liveness.** If a leader fails (SIGKILL or partition) and a majority stays connected, the majority side acknowledges its first write
  within 10 s of the fault and then acknowledges at least 90 % of writes. After the failed node returns or the partition heals, every
  node reports the same `applied` version in `/v1/cluster` within 30 s.
- A write is acknowledged only after it is durable on a majority (2 of 3). Notifications expose only majority-committed versions
  (commit point, §8.1); anything else can violate R8.
- A minority side MUST NOT acknowledge writes.
- No acknowledged write is lost and R8 is never violated. Writes with unknown outcome may or may not appear, but atomically.
- R4 holds on the majority side during a partition, and on every node from 10 s after it heals.
- SDK clients connected to a dead or isolated node reconnect to another URL, and their subscriptions converge (R10).

---

## 12. Wire protocol

The encoding (JSON, MessagePack, custom binary, compression, delta formats) and the session protocol are free. `server/PROTOCOL.md`
MUST describe it well enough for a third party to write another SDK: handshake, framing, message types, how the IR is carried,
error codes, resume after reconnect, flow control. A missing or clearly insufficient document costs 2 Q points.

---

## 13. Conformance testing

The kit runs suites against the built images. Public seeds ship in the kit so harnesses can test themselves; the final evaluation uses
secret seeds and larger operation counts.

### 13.1 No reference implementation

The kit contains no reference implementation of the system and no hand-written model of its semantics. Correctness comes from three sources:

1. **Checks that need no expected answer** (§13.2). They cover most of the reactive behaviour.
2. **The SQLite voter** (§13.3): a mechanical translation of the IR to SQL on stock SQLite, cross-checked against the other submission
   wherever both see the same input (§13.4).
3. **Hand-written cases** with literal expected outputs (T1, T2, T5).

### 13.2 Checks without an expected answer

| Check | Covers |
|---|---|
| Successive listener calls of one subscription: versions strictly increase, results differ, previous rows + diff = next rows, `diff.fromVersion` = previous `current.version`, diff sets exact | R2, R3, R5 |
| Version accounting, with `A` acknowledged batches, `U` batches with unknown outcome and `P` applied pushes: acknowledged versions are distinct; the final version satisfies `A + P ≤ V_final ≤ A + U + P`; no observed version exceeds `V_final`. In a fault-free run `U` must be 0 (an unknown outcome fails the seed), so the acknowledged versions are exactly `1..N` | lost or phantom commits |
| After a mutation resolved with `v`, a new subscription or `fetch` on the same client starts at `version ≥ v` | R6 |
| Quiescence points (writers pause every 1,000 batches): `waitForVersion(lastAcked)` resolves within 5 s; then for every subscription the same client runs `fetch({minVersion: lastAcked})` of the same query, and the rows must equal `current.rows` whenever `current.version ≤ fetch.version ≤ syncedVersion` (otherwise the pair is sampled again) | R4, R7, drift of incrementally maintained results |
| Bank workload: batches move amounts between rows with two `$inc` operations; every snapshot of a subscription covering a closed group of rows shows the same total | R9 |
| No callback after `unsubscribe()`; `/v1/stats.subscriptions` back to the expected value within 1 s | R11 |
| Writes in database X cause no callback and no version change in database Y | R12 |
| Cluster: every `(query, version)` observed on several nodes has identical results. After the last fault heals, a client pinned to each node fetches every table with `minVersion = V_final`: all nodes return the same version and rows, and the same bank totals | R8 |
| Faults: acknowledged inserts present; each counter within `[acked, acked + unknown]`; versions monotonic across reconnects; the liveness bounds of §11.2 | §7.3, §11, R10 |

### 13.3 SQLite voter

A kit module of a few hundred lines, reviewed by both participants before the kit is frozen. It:

- creates a stock SQLite database from a `SchemaIR` (NOT NULL, DEFAULT, unique indexes);
- applies `MutationIR` batches in version order (`$inc` as `coalesce(col, 0) + n`, upsert as full replace);
- translates `QueryIR` to SQL with §6.2 semantics (BINARY collation, byte-prefix `startsWith`, implicit `id` tiebreaker) and converts
  results to SDK value types.

§6.2 coincides with SQLite's own behaviour, so the translation stays mechanical. Versions are dense and every acknowledged mutation returns
its version, so a fault-free test knows the complete log of committed batches. The voter replays it and computes `Q(D_v)` for every snapshot
observed at version `v`, which checks R1 at every delivered version, not only at quiescence. A run with unknown-outcome writes is replayed
up to the first version that no acknowledgement covers; later deliveries rely on §13.2.

Cost is bounded so that a seed takes at most 10 minutes on a P5 machine: fuzz generators keep each table at or below 20,000 rows
(deletes balance inserts); the voter checks every delivery of 30 randomly chosen subscriptions per seed and, for all other subscriptions,
the last delivery before each quiescence point; results are compared by hash, and in full only when the hashes differ.

### 13.4 Cross-checking and triage

T3 gives A, B and the voter the same data and the same queries, so each query has three answers:

| Outcome | Verdict |
|---|---|
| the submission agrees with the voter | pass |
| the submission disagrees with the voter; the other submission agrees with the voter or has no answer | fail |
| both submissions agree with each other against the voter | triage |
| all three differ | triage |

Concurrent fuzz runs produce a different history in each submission, so there the voter judges alone. A voter-only finding that appears in
both submissions with the same signature also goes to triage. Both submissions run on SQLite and may share a translation mistake with the
voter, so a majority is not proof: either participant may refer any failure signature to triage within 24 hours of the preliminary results.

Triage: the judge decides from the text of this specification, whichever answers agreed with the voter, and publishes the decision with its reasoning. A voter bug is fixed and every
affected case is re-run for both submissions; an ambiguity in the specification voids the case for both. Any other kit bug found after
kickoff (runner, flaky test) is handled the same way: fixed by the judge before scoring and re-run identically for both. Harnesses cannot
change the kit; they may record suspected kit bugs in `RESULTS/KIT_ISSUES.md`.

*(informative)* Compared with a hand-written model, this gives up one independent implementation of the semantics: a mistake in the voter's
translation is caught only by the cross-check in T3 and by triage.

### 13.5 Suites and points

Conformance runs on a P5 machine, one suite at a time. Every fuzz suite (T3, T4, T6, D2, D4, F1–F3) runs 20 secret seeds.
Each suite scores `weight × passed_cases / total_cases`, where a case is a hand-written case or a seed, with these rules:

- A **safety violation** (a wrong result or diff, a lost acknowledged write, a fork, a broken invariant) fails the seed whenever it occurs.
- A seed that fails **only a time bound** (R4's 5 s, R11's 1 s, the bounds of §4.2, §9 and §11) is rerun up to twice and passes if a rerun passes.
- **T3** counts distinct failures instead of seeds: the kit shrinks every confirmed failing query to a signature (operator, column type,
  nullability, value class such as NULL, empty, astral-plane or shared-prefix string), and T3 scores `6 × max(0, 1 − signatures / 10)`.

| Suite | Pts | Content |
|---|---|---|
| **L1** | **30** | |
| T1 Schema and CLI | 4 | CLI commands and exit codes, plans, every migration class from §5.5, effect of schema changes on live subscriptions, name rules |
| T2 Mutations | 4 | every operation and error code, batch atomicity and `opIndex`, defaults, `$inc`, size limits |
| T3 Query semantics | 6 | fuzz schema with all types and nullability; a deterministic dataset of 2,000 rows of adversarial values (NULLs, duplicates, empty and astral-plane strings, shared prefixes, large ints, ±0); 5,000 random queries per seed through `fetch` and initial snapshots; each query judged by §13.4 |
| T4 Reactive fuzz | 8 | 8 writer clients send 20,000 random batches (1–20 ops, every kind) with quiescence points and a bank workload; 300 subscriptions over 20 reader clients (rows and count queries, with/without limit and select, subscribe/unsubscribe churn); §13.2 checks on every callback, R1 through voter replay |
| T5 Diffs and spurious updates | 3 | no-op updates, updates of unselected columns, updates outside the limit window, top-K entry and exit, pure reorders, delete and re-insert of one id in one batch; expected callbacks written by hand |
| T6 Faults | 3 | connections cut by a TCP proxy every 2 s during T4-style load (R10); SIGKILL and restart under writes (durability, version continuity, client recovery); §13.2 fault checks |
| T7 Types | 2 | `types/api.test-d.ts` compiled with the TypeScript version pinned in `kit/package.json` and `kit/types/tsconfig.judge.json`; `@rsdb/client` resolves through `/kit/node_modules/@rsdb/client` → `/sdk` via its `exports["."].types` |
| **L2** | **8** | |
| D1 Cluster formation | 1 | health, admin operations on any node apply cluster-wide |
| D2 Cross-node consistency | 2 | the same subscriptions on all 3 nodes under T4-style load; R1 through voter replay, R8 |
| D3 Follower writes | 2 | forwarding, R6 for follower-connected clients |
| D4 Follower crash | 2 | SIGKILL of a node that leads no database under test, under load; writes continue; it serves `/healthz` within 15 s of restart and catches up within 30 s |
| D5 Many databases | 1 | 1,000 databases; leaders reported consistently by every node |
| **L3** | **7** | |
| F1 Leader crash | 3 | SIGKILL of the leader under writes and `$inc` counters; acknowledged inserts all present; each counter within `[acked, acked + unknown]`; no fork; liveness of §11.2 (first acknowledgement within 10 s, ≥ 90 % of later writes acknowledged, equal `applied` within 30 s of the restart) |
| F2 Leader partition | 2 | the leader's traffic to its peers is cut for 30 s while clients still reach it; no acknowledgement from the isolated node for a request sent more than 2 s after the cut; it rejects SDK operations after 3 s; same checks as F1; R4 on the majority side, and on every node 10 s after the heal |
| F3 Rolling restart | 1 | restart all nodes one at a time under load |
| F4 SDK failover | 1 | client on a killed node reconnects to another URL within 5 s; subscriptions converge |

---

## 14. Benchmarks

The 55 performance points measure the four optimization targets from §2, plus throughput and failover. The totals follow from the
weights in §14.4:

| Target | Points | Metrics (§14.2) | Scenarios |
|---|---|---|---|
| Update delivery latency | 12.7 | `lat`, `ack`, convergence after a stall | B1, B2, B3, B4, B5, B8, B9, B10, B13 |
| Memory | 11.85 | `mem` (server), `cli_mem` (SDK) | B2, B4, B5, B6, B8, B9, B10 |
| Subscription handling cost | 11.8 | server `cpu` per write, per affected pair and per subscribe, `ttfs`, fetch latency | B1, B2, B3, B6, B7, B8, B13 |
| Diffs and traffic | 12.65 | `net`, `peer`, `cli_cpu`, bytes to a recovering slow client | B1, B2, B3, B4, B5, B9, B10, B13 |
| Throughput and failover | 6 | highest sustained write rate, write unavailability, recovery time | B11, B12 |

Diff precision (no spurious callbacks, exact diff sets) is scored under correctness as well: T5, R5 inside T4, and the audit
subscriptions of every benchmark run (§14.2). The specification fixes results, not techniques: how a submission matches writes to
subscriptions and computes diffs is its own choice (§8).

### 14.1 Environment

- **Hosts.** Bench host P6, swap off. Single-node scenarios: the server container gets 4 dedicated CPUs (no SMT sibling shared with
  another container) and 8 GB. Cluster scenarios: 3 server containers with 2 dedicated CPUs and 4 GB each; peers talk over a separate
  `peer` network with 1 ms one-way delay (`tc netem`).
- **Networks.** Writers and readers use separate networks, `writer` and `reader`. The server has an interface on each, so traffic to
  readers is counted apart from writes and their acknowledgements.
- **Load generators** are kit Node 24 processes in containers of 2 pinned CPUs on the remaining cores, with at most 5,000 connections
  per container. Each scenario's runner file fixes the number of processes, clients per process and placement; a writer process sends
  at most 1,000 writes/s. Generators use only the submission's public SDK API, so SDK efficiency counts. Before kickoff organizers
  confirm, with a stub SDK and a stub server, that the generators sustain twice every scenario's rates.
- **Clock.** `process.hrtime.bigint()` (CLOCK_MONOTONIC, one clock for every container on the host).
- **Integrity.** Generators start with `node --import kit/bench/runner/guard.mjs`, which captures the clock, timers and `process.*`
  functions before the SDK loads; the runner measures only through those references. An SDK that patches runtime globals or touches
  the runner's objects is disqualified; organizers scan the built package for such code.
- **Procedure.** Each scenario: fresh data dir → preload (untimed unless stated) → 10 s warm-up → 60 s measurement → quiesce → validation.
  Scenarios that score `cpu` also make a **control run** with the same write schedule and no subscriptions (§14.2).
- **Schedule health.** Writers schedule open loop. If a writer process falls more than 1 % behind its schedule over the window, the run
  is retried up to twice; if it happens again, the scenario is invalid for that submission. Readers' event-loop lag comes from the SDK
  and counts against it; it is reported.
- **Repetitions.** Submissions run alternately (A, B, B, A, A, B); each metric is the median of P7 repetitions. A correctness failure in
  any repetition invalidates the scenario; an infrastructure failure (host, runner) is rerun.
- **Hidden variant.** The scored runs rename tables and columns, permute column order, scale rates and data sizes by one random factor
  in [0.8, 1.25] (connection counts never above their base value), and draw each scenario's query parameters (constants, limits in
  [5, 50], sort direction, and for B13 the filter shapes) from the family the scenario describes. The variant seed is committed by
  sha256 before kickoff and revealed with the results; both submissions run the same variant.

### 14.2 Metrics

An **affected pair** `(v, s)` is a write with version `v` and a subscription `s` whose result it changed: `Q_s(D_v) ≠ Q_s(D_{v−1})`
(rows, order or a returned value; the number for count queries). The runner computes the pairs after the run from the write log and
the scenario's data, by voter replay restricted to the subscriptions whose filter matches the written row before or after the write.
Pairs depend only on the workload, so "per pair" metrics have a denominator the submission cannot change, and coalescing lowers the
cost per pair instead of raising it.

| Metric | Definition |
|---|---|
| `lat` | delivery latency, one sample per affected pair `(v, s)`: the first time `s`'s listener receives a snapshot with version ≥ `v`, minus the time `v`'s write was scheduled. A pair whose change a later write undoes before such a callback is not sampled. Writers schedule open loop, so a slow server cannot slow the schedule (no coordinated omission). HDR histogram; p50, p99, p99.9, max reported |
| `ack` | mutation latency: promise resolution − scheduled send time |
| `ttfs` | time to first snapshot: `sub.ready` resolution − `subscribe()` call |
| `mem` | server memory from the cgroup `memory.stat` of the server container(s): `anon + shmem + sock + kernel + file_mapped + file_dirty`. Clean, unmapped page cache is excluded, so reading SQLite files through the OS cache is free and mapping them is not. Sampled every 50 ms; steady = median over the window, peak = max. "Per subscription" and "per connection" values are the difference between two sample points the scenario names, divided by the count |
| `cpu` | server CPU seconds from cgroup `cpu.stat usage_usec` over the window, minus the same for the control run: the CPU spent on subscriptions, matching and delivery rather than on committing writes |
| `net` | server egress bytes on the `reader` network |
| `peer` | bytes sent on the `peer` network, per committed write |
| `cli_cpu`, `cli_mem` | SDK cost, measured outside the SDK on dedicated reader containers: cgroup CPU over the window, and cgroup `anon` after a forced GC (`node --expose-gc`), each minus the value for the same container running the runner with a no-op stub instead of the SDK |
| `sync` | time for `waitForVersion(latestAcked)` to resolve on a probe client, sampled every second |

**Validation.** A run is invalid, and the scenario scores 0, if any of these checks fails:

1. Every subscription: listener versions strictly increase; no error other than those the scenario provokes.
2. **Audit subscriptions.** 2 % of each scenario's subscriptions (at least 50), chosen at random and opened by reader processes the
   server cannot tell apart from the others (they are left out of `cli_*`), get every per-callback check of §13.2, and the voter (§13.3)
   checks R1 at every version they deliver.
3. After quiescence every client's `waitForVersion(lastAcked)` resolves within 30 s, and every subscription's final result equals the
   voter's (compared by hash).
4. Failed mutations and subscribes are at most 0.1 % of those issued in the window, unless the scenario says otherwise (B11, B12).
5. In a scenario without injected faults, any mutation with `outcome: 'unknown'` invalidates the run.

### 14.3 Benchmark schema

`bench/schema.ts` (renamed in the hidden variant):

```ts
messages: table({ channel: t.int(), author: t.string(), body: t.string(), ts: t.float(), sentAt: t.float(),
                  meta: t.json<{ tags?: string[] }>().optional() }).index('by_channel_ts', ['channel', 'ts']),
users:    table({ name: t.string(), team: t.int(), score: t.int(), active: t.bool().default(true),
                  sentAt: t.float().default(0) }).index('by_team_score', ['team', 'score']).index('by_score', ['score']),
counters: table({ value: t.int().default(0) }),
```

Writers fill `sentAt` with the scheduled send time. It serves spot checks only; `lat` is measured from the write log (§14.2).

### 14.4 Scenarios

"conns × subs" means connections (clients) × subscriptions per connection. Weights are within the scenario. "Pair" is an affected pair (§14.2).

| ID | Pts | Setup | Load | Metrics (weight) | Extra gates |
|---|---|---|---|---|---|
| B1 Broadcast | 4 | 10k messages; 5,000 × 1 identical `messages{channel:1} ts desc limit 20` | 100 inserts/s into channel 1 | lat p50 (15 %), lat p99 (25 %), cpu per 1k pairs (25 %), net per pair (35 %) | |
| B2 Many queries | 6 | 1M messages over 100k channels; 1,000 × 100 distinct `messages{channel:k} ts desc limit 10` | 2,000 inserts/s, random channel | mem per subscription: all subscriptions ready and 10 s idle, minus all clients connected before subscribing (30 %); lat p50 (10 %), lat p99 (15 %), cpu per write (30 %), net per pair (15 %) | |
| B3 Top-K churn | 5 | 1M users over 1,000 teams; 200 × 10, each team's `users{team:k} score desc limit 10` subscribed twice | 5,000 updates/s: random user gets random `score` | lat p50 (10 %), lat p99 (20 %), cpu per write (30 %), net per pair (40 %) | |
| B4 Wide result | 5 | 20k messages in channel 0 (200 B bodies); 200 × 1 `messages{channel:0}`, no limit | 500 updates/s, new 200 B `body` on a random row | net per pair (45 %), cli_cpu per pair (30 %), lat p99 (10 %), cli_mem per subscription (15 %) | |
| B5 Bulk update | 3 | B3 data; 100 × 10 distinct team top-10 queries | 2/s `updateWhere({team:{in:[10 teams]}}, {score:{$inc:1}})` (10k rows each) + 500 single updates/s | ack p99 (20 %), lat p99 (30 %), mem peak (30 %), net per pair (20 %) | |
| B6 Subscription churn | 5 | B3 data; 200 connections | 5,000 subscribes/s, lifetime exponential with 1 s mean (80 % top-20 rows queries, 20 % count queries); 500 updates/s; then unsubscribe all and idle 30 s | ttfs p50 (20 %), ttfs p99 (30 %), cpu per subscribe (20 %), retained mem: 30 s after the last unsubscribe minus before the first subscribe, in MB (30 %) | `/v1/stats.subscriptions` = 0 at the end |
| B7 Cold reads | 2 | B3 data; before the measurement the server is restarted on the preloaded data dir and the host page cache is dropped | 1,000 sequential `fetch` of `users{team:k, score≥x} score desc limit 50`; 1,000 sequential subscribe → ready → unsubscribe of count queries | fetch p50 (25 %), fetch p99 (25 %), count ttfs p50 (25 %), p99 (25 %); preload rate reported, unscored | |
| B8 Footprint | 6 | (a) 20,000 clients, each holding one count subscription on a table nobody writes; (b) 1,000 databases × 1k messages, 2 × 1 subscriptions each | (b) 1 insert/s per database | (a) mem per connection: all subscriptions ready minus before connecting (30 %); (b) steady mem (40 %), lat p99 (20 %), cpu per write (10 %) | (a) `ss` shows 20,000 established client connections |
| B9 Slow consumer | 4 | 100 × 100 normal subscriptions plus one slow process with 1 × 100 hot subscriptions; the slow process's network namespace has `net.ipv4.tcp_rmem` max 64 KiB | 1,000 inserts/s on the hot channels + 1,000/s random; after 30 s the slow process is SIGSTOPped for 60 s, then SIGCONTed | mem growth while stopped (30 %); normal clients' lat p99 while stopped (25 %); convergence: SIGCONT → every hot subscription synced past the latest version acknowledged at SIGCONT (25 %); bytes the slow client receives until convergence, from its container's `rx_bytes` (20 %) | growth ≤ 256 MB; convergence ≤ 30 s |
| B10 Cluster fan-out | 5 | L2; 300k messages over 30k channels; 100 × 100 subscriptions per node | 1,000 inserts/s through writers spread over all nodes | lat p50 (10 %), lat p99 (20 %), peer bytes per write (40 %), total mem of 3 nodes (30 %) | |
| B11 Failover | 3 | L3; 3,000 subscriptions over all nodes | 200 writes/s (inserts and `$inc` on 10 counters); five times, every 40 s: SIGKILL the current leader, restart it 20 s later | medians over the five kills: write unavailability, last ack before the kill → first ack after (50 %); recovery, kill → all subscriptions synced past the first post-failover version (50 %) | F1 checks; unavailability ≤ 10 s; check 4 ignores the 15 s after each kill |
| B12 Max throughput | 3 | 1,000 channels, 1,000 subscriptions; 64 writer connections | open-loop single-row inserts from 1,000/s, ×1.5 every 15 s until a step fails, then three 15 s bisection steps between the last passing and the failing rate; after a failing step writes pause until `sync` < 1 s (at most 30 s) | highest passing rate (100 %) | a step passes if lat p99 ≤ 250 ms, ack p99 ≤ 250 ms, errors ≤ 0.1 %, no unknown outcome and writers on schedule; validation covers the steps up to the last passing one |
| B13 Mixed queries | 4 | B3 data; 200 × 25 subscriptions from a family: ranges and `in` on indexed and unindexed columns, `startsWith` on `name`, `$or` of two teams, filters on `active`, projections, limits and unlimited results (≤ 2,000 rows); 20 % count queries | 2,000 writes/s: 60 % updates of `score`, `name`, `active` or `sentAt` (`sentAt` is never selected or filtered), 20 % inserts, 20 % deletes | lat p50 (10 %), lat p99 (25 %), cpu per write (35 %), net per pair (30 %) | |

### 14.5 Performance points

For each metric of scenario `s`, `best` is the best value among valid submissions. Lower-is-better metrics score `r = best / own`,
higher-is-better metrics `r = own / best`. Scenario points are `Pts_s × Σ weight_m × r_m`; an invalid scenario scores 0.

Before the ratio every value is raised to its metric's floor, so differences below measurement resolution do not count:

| Metric | Floor |
|---|---|
| latencies and times (`lat`, `ack`, `ttfs`, fetch, `sync`, convergence, unavailability, recovery) | 1 ms; B10 latency 5 ms, which absorbs the extra round trip of majority commit under L3 |
| `cpu` and `cli_cpu` per write, per pair or per subscribe | 1 µs |
| bytes per pair or per write | 16 B; B9 slow-client bytes 64 KiB |
| memory per subscription or per connection | 64 B |
| memory totals, peaks, growth and retained memory | 16 MB |

**Noise.** If the ranges (minimum to maximum over the repetitions) of the two submissions' values for a metric overlap, both get `r = 1`
on it. The report also shows P computed from each repetition alone, as an indication of spread.

There are no absolute targets. Points are relative to the best valid submission, and neither harness sees the other's numbers during the
run, so every improvement counts in proportion: halving a metric on which a submission trails doubles that metric's points, and improving
one on which it leads lowers the other submission's points.

### 14.6 Running benchmarks during development

`kit/bench/run-local.sh [--scale 0.25] [--only B2,B3]` runs on the dev machine (P5). It builds the submission, runs the selected scenarios
with every count and rate from §14.4 multiplied by the scale (default 0.25), applies the same metric definitions, control runs and
validation, and prints raw metrics per scenario as a table and as JSON. It prints no points, because points depend on the other
submission. Cluster scenarios run as three containers on the same machine. The dev machine differs from the bench host, so local numbers
show direction and relative change, not final values.

---

## 15. Scoring and winner

### 15.1 Quality score

`Q = C + P − penalties`, maximum 100.

- `C`, correctness: 45 points (§13).
- `P`, performance: 55 points (§14).
- Penalties: −1 per operator nudge (P3); −2 for missing or insufficient `PROTOCOL.md`.
- Build failure: Q = 0. A modified `/kit`, a forbidden dependency, or human-written code: disqualification.

### 15.2 Reported efficiency (published, not part of Q)

- Total tokens by class and model, cost in USD (§17), wall-clock to submission.
- Q per USD and Q per hour.
- Quality over time: the judge runs the conformance suite on the last commit before every full hour and plots `C(t)` against cumulative
  cost from `usage-events.jsonl` timestamps, which shows what each harness had built at every level of spend.

### 15.3 Winner rule and outcomes (fixed before kickoff)

1. A harness that forfeits (§17.2) or is disqualified loses.
2. Otherwise the higher Q wins if the difference is ≥ 3 points (P8).
3. Otherwise the lower total cost wins if `(higher − lower) / lower ≥ 15 %` (P8).
4. Otherwise the shorter wall-clock time (§16.4) wins. Equal on everything is a draw.

| Situation | Result |
|---|---|
| both forfeit, both are disqualified, or one forfeits and the other is disqualified | no contest |
| a harness aborts during preflight (§17.2) | forfeit by that harness; the other harness does not run; no rescheduling unless both participants agree |
| both submissions have Q = 0 | draw; rules 3–4 do not apply |
| a harness's top-level process crashes | it counts as stopped (§16.3) |
| a kit bug found during the run | handled by §13.4; a requirement that the bug made impossible for both is voided for both |

---

## 16. Run protocol

### 16.1 Before kickoff

1. **Configuration freeze.** Each harness publishes `HARNESS.md` (§18) and freezes its configuration: every prompt, memory, skill, tool,
   index, model setting and file the harness can read at kickoff, plus its usage converter (§17.5) and resume command (§16.3).
   Organizers record a sha256 manifest of it. The freeze happens **before** either participant receives the kit for review.
   Anything derived from this specification found later in a harness's configuration, storage or reachable locations is a disqualification.
   The frozen configuration is published with the results (`RESULTS/config/`, §18). A part that a participant does not want to publish
   is declared before kickoff and kept in organizer escrow, open to inspection by the other participant; only its manifest entries are published.
2. The kit is completed, reviewed and accepted by both participants (the SQLite voter in particular, §13.3), tagged `KIT_SHA` and published.
3. Organizers run the LLM gateway (§17.6) from open-source code at a commit both participants approve. It writes its log to append-only
   storage that both participants can read during and after the run. Provider keys belong to a provider account owned by the organizers,
   with a separate workspace (project) per harness and, inside it, separate keys for calibration and for the run that serve nothing else,
   so the provider's own usage report for a run workspace covers exactly one harness's run. Dev machines hold no provider credentials.
   Harnesses use pay-as-you-go API access through the gateway; subscription plans cannot be verified and are not allowed under V1.
4. Both harnesses pass the TAG preflight (§17.2).
5. Organizers create two repositories they own from the kit template, with protection against force-push and against deleting or moving
   tags, and a push key that exists only on the corresponding dev machine. GitHub Actions, Codespaces, Pages, webhooks and app
   installations are disabled on both repositories, so no code runs on GitHub's side. They provision two identical dev machines (P5) whose outbound
   network is limited to the allowlist P10, with shell-session recording (for example auditd).

### 16.2 Kickoff prompt

Identical for both harnesses, given once, verbatim:

> You are taking part in the RSDB Challenge. The complete specification is `kit/SPEC.md` in this repository; it is the only source of
> requirements. Implement the system it describes (the Rust server in `server/`, the TypeScript SDK and CLI in `sdk/`) and maximize the
> quality score defined in §15 within the time limit. Do not modify `kit/`. Commit and push your progress to `origin/main` regularly.
> When you are done, create and push the git tag `submission`. Nobody will answer questions or give further help.

### 16.3 During the run

- **Access.** No participant has interactive or write access to a dev machine, its harness or the repositories. Both may observe
  read-only (logs, transcripts, gateway dashboard). Session recordings are published with the results.
- **Where work happens.** Every harness process runs on its dev machine. Cloud agents, remote runners, CI jobs or other machines doing
  LLM-driven work are forbidden. All LLM traffic goes through the gateway, and no LLM inference runs on the dev machine itself (§17.3).
- **Prior work.** Code written for this challenge before kickoff MUST NOT be used; general-purpose libraries from public registries are
  allowed (§3). Organizers scan submissions for similarity against public repositories created after the kit was first shared.
- **Stopping and nudges.** A harness has *stopped* when its top-level process (declared in `HARNESS.md`) has exited and the `submission`
  tag has not been pushed. Only then may the operator resume it, with the declared resume command (for A: `claude -p --continue`) and the
  fixed text `Continue working on the challenge until you push the submission tag.` Each resume is a nudge: −1 Q point, at most N_NUDGE,
  after which the run ends. Re-prompting that happens inside the running top-level process is part of the harness and free.
  *(informative)* This deliberately charges a harness that cannot keep itself going: autonomy is part of what is compared.
- **Crashes and infrastructure.** A top-level process that dies from a harness fault counts as stopped. A failure of the machine,
  network, gateway or provider is infrastructure: organizers restore it following `kit/RUNBOOK.md` and resume with the fixed text
  `Infrastructure was restored. Continue working on the challenge until you push the submission tag.` These resumes are not nudges.
  Time lost is not refunded.
- **Rate limits** are part of the harness. Each side declares its provider tiers and limits in `HARNESS.md`; waiting time is not refunded.
- **Cost cap.** The gateway refuses requests once the harness's cumulative list-price cost reaches COST_CAP. The evaluated state is the
  last push before that moment (gateway time).
- **Forbidden**, leading to disqualification: human input other than the above; access to the other participant's machine, repository or
  gateway keys; disabling or editing the harness's own telemetry.
- Every operator action goes to `RESULTS/interventions.log` (ISO time, type, verbatim text).

### 16.4 Submission and timeline

- Push times come from the push events of the organizer-owned repositories, backed by organizer `git ls-remote` snapshots every
  5 minutes. Commit dates are ignored.
- The submission is the first push of the tag `submission` (tags are protected) before kickoff + T_MAX and before the cost-cap moment.
  Without a tag, the last commit pushed to `main` before the earlier of those two moments counts.
- **Wall-clock** = push time of the `submission` tag − kickoff; T_MAX if there is no tag.
- After pushing `submission` the harness MUST stop. Organizers revoke push access and disable the run's gateway keys at the deadline.
- At the deadline organizers snapshot each machine's raw telemetry and transcripts, with sha256 hashes in `RESULTS/raw/MANIFEST`.
  The frozen converter (§16.1) turns the snapshot into `usage-events.jsonl` and `usage.json`. `RESULTS/` is committed within 2 hours, in
  commits that touch only `RESULTS/`, tagged `results`.
- No force-push and no history rewrite on `main`.

### 16.5 Baseline definition (harness A)

"Baseline Claude Code" means:

- a pinned Claude Code version with auto-update disabled;
- an agreed model and effort setting, recorded in `HARNESS.md`;
- a fresh config directory (`CLAUDE_CONFIG_DIR`) with no user `CLAUDE.md`, custom agents, skills, plugins, hooks or MCP servers;
  built-in tools and built-in subagents are allowed;
- headless mode (`claude -p`) with permissions bypassed inside the isolated dev machine, pointed at the gateway through `ANTHROPIC_BASE_URL`;
- a launch script of at most ~150 lines that only: sets telemetry (Appendix A), runs the preflight, starts the session, watches telemetry
  and triggers the abort rule (§17.2), and resumes under §16.3. Its resumes are nudges. The script is published.

---

## 17. Token accounting

### 17.1 Principle

Two layers. **Self-measurement** (mandatory): each harness measures every LLM request with its own instrumentation and publishes the raw
evidence; a harness that cannot do this aborts (§17.2). **Independent verification**: the organizer gateway logs every request, the
provider's own usage report confirms the gateway's totals (§17.6), and all three records must agree.

### 17.2 Token Accounting Gate (TAG)

1. **Preflight**, before kickoff, on calibration keys. Each harness runs `kit/accounting/CALIBRATION.md` in a scratch repository,
   exercising every component declared in `HARNESS.md`, and its frozen converter produces `calibration/usage-events.jsonl` and
   `calibration/usage.json`. `kit/accounting/verify` passes when: both files validate against the schemas; totals equal the sum of events;
   every declared component has at least one event with `output_tokens > 0`; every model used is priced in `prices.json`; and the events
   match the gateway log under the rules of point 4.
2. **Abort on inability.** A harness that cannot measure its token usage MUST stop before doing any challenge work, print the line
   `RSDB_ABORT TOKEN_ACCOUNTING_UNAVAILABLE: <reason>` and exit with status 86. The experiment ends there, recorded as a forfeit by that harness.
3. **Abort on loss.** Accounting is *lost* when an LLM request is covered by none of the harness's native sources. A harness that detects
   this MUST stop working, print `RSDB_ABORT TOKEN_ACCOUNTING_LOST: <reason>` and exit with status 86: a forfeit. Native telemetry is shipped
   continuously to organizer storage outside the harness's write reach. Every 15 minutes organizers compare it with the gateway log;
   requests left uncovered for more than 15 minutes stop the run with the same outcome. Code produced so far is still published.
4. **Matching rules.** Every gateway request matches exactly one event by `request_id`, or belongs to exactly one aggregated event (§17.5)
   whose token fields equal the sum of its requests. Every `requestId` in a harness transcript appears in the events. Billed requests that
   failed appear as events with `status: "error"`. Any other difference is a discrepancy: organizers rule on it and publish their reasoning;
   deliberate under-reporting is a disqualification.
5. A component that cannot report its usage, or cannot route its traffic through the gateway, MUST NOT be used.

### 17.3 What counts

Every LLM request billed to the run keys, from kickoff until the last harness process exits (at the latest the deadline, when the keys are
disabled): main agents, subagents, planners, critics, judges, summarization and context compaction, auxiliary calls (titles,
classification), retries and failed requests that were billed, embeddings, rerankers, model calls inside tools, and server-side tool fees
(web search). Every request goes through the gateway: self-hosted and local models are not allowed, because they would leave no
independent record. A model missing from `prices.json` fails the TAG. Calibration uses separate keys and is reported separately.

Tokens spent before kickoff, on building or tuning a harness, are not counted and cannot be: the challenge topic is known in advance.
Publishing the frozen configuration (§16.1) makes such preparation visible instead.

Headline numbers: **input = input + cache_read + cache_write**, **output** (including reasoning), **cost USD**.

### 17.4 Normalization

| Field | Anthropic Messages | OpenAI Responses / Chat Completions | Google Gemini |
|---|---|---|---|
| `input_tokens` (uncached) | `input_tokens` | `input_tokens − input_tokens_details.cached_tokens` / `prompt_tokens − prompt_tokens_details.cached_tokens` | `promptTokenCount + toolUsePromptTokenCount − cachedContentTokenCount` |
| `cache_read_tokens` | `cache_read_input_tokens` | `cached_tokens` | `cachedContentTokenCount` |
| `cache_write_tokens` | `cache_creation_input_tokens` | 0 | 0 |
| `cache_write_1h_tokens` | `cache_creation.ephemeral_1h_input_tokens` | 0 | 0 |
| `output_tokens` (includes reasoning) | `output_tokens` | `output_tokens` / `completion_tokens` | `candidatesTokenCount + thoughtsTokenCount` |
| `reasoning_tokens` (subset, if reported) | null | `output_tokens_details.reasoning_tokens` / `completion_tokens_details.reasoning_tokens` | `thoughtsTokenCount` |

Tokenizers differ between providers, so token counts compare like with like only within a provider; cost is the common currency.

### 17.5 Formats

- `RESULTS/usage-events.jsonl`: one line per LLM request, schema `accounting/usage-event.schema.json`. A native source that only reports
  per-turn totals (for example Codex `turn.completed`) may emit one aggregated event per turn with `requests > 1` and the request ids when
  known.
- `RESULTS/usage.json`: summary, schema `accounting/usage.schema.json`. Its totals MUST equal the sum of the events exactly.
- `RESULTS/raw/`: the snapshot of native records (§16.4) and the frozen converter.

### 17.6 Verification levels

| Level | Evidence | Matching |
|---|---|---|
| V1 (default) | organizer-run LLM gateway that holds all provider keys and logs every request with id, model, service tier and usage; and the provider's usage report for the harness's run workspace (for example the Anthropic Usage & Cost Admin API or the OpenAI Usage API), fetched when `RESULTS/` is assembled (§16.4) | events match the gateway log exactly (§17.2 point 4); the gateway's totals per model and token class match the provider report, and a difference above 0.5 % is a discrepancy under §17.2 point 4 |
| V2 (only if both participants agree in P4) | harness-native records only, for example subscription plans that cannot use a gateway | internal consistency only; results labelled "self-reported, not verified". V2 rests on trust alone; participants SHOULD refuse it |

Under V1 the three records come from different parties: the provider's billing, which neither participant controls; the gateway, which
neither participant alone can alter; and the harness's own instrumentation. A falsified harness record disagrees with the gateway, and a
falsified gateway log disagrees with the provider.

### 17.7 Cost

The verifier computes each event's cost from `kit/accounting/prices.json`: list prices on the kickoff date for the model, `speed`,
`service_tier` and region actually used, including cache-write TTL rates, long-context premiums and server-side tool fees. If the 5-minute /
1-hour split of a cache write is unknown, it is taken from the gateway log, otherwise priced at the 1-hour rate. The harness's own cost
estimate is a cross-check only.

---

## 18. Publication on GitHub

- The repositories `github.com/<organizers>/rsdb-<harness>` are owned by the organizers, private during the run, and made public within
  24 hours after the deadline, both at the same time. License: MIT or Apache-2.0.
- At tag `results` a repository contains the full history of `main`, the submission (§3), and:

```
RESULTS/
  HARNESS.md            declared and frozen configuration (§16.1)
  config/               the frozen configuration and its sha256 manifest; escrowed parts appear as manifest entries only (§16.1)
  usage.json            summary (§17.5)
  usage-events.jsonl    per-request events
  raw/                  telemetry and transcript snapshot from the deadline, sha256 in raw/MANIFEST; the frozen converter;
                        files over 100 MB as release assets
  calibration/          preflight evidence (§17.2)
  gateway/              the gateway log for the run keys
  provider/             the provider's usage report for the run workspace (§17.6)
  interventions.log     every operator action
  verify.txt            output of kit/accounting/verify
  KIT_ISSUES.md         suspected kit bugs noticed during the run (optional, §13.4)
```

- The top of `README.md` carries a run summary generated by the verifier: tokens by class and model, cost, wall-clock, number of nudges,
  verification level.
- Organizers redact secrets in published transcripts (replaced with `[REDACTED]`, nothing else altered) and keep the unredacted snapshot
  in escrow for disputes. The verifier checks that usage fields are intact.
- The judge publishes all conformance and benchmark results, raw numbers included, in the kit repository.

---

## Appendix A. Claude Code: native token accounting *(informative)*

Claude Code can measure its own usage without plugins; the model inside does not see these counters, the CLI process records them.
Three independent native sources:

1. **OpenTelemetry** (primary). With `CLAUDE_CODE_ENABLE_TELEMETRY=1`, Claude Code exports the metric `claude_code.token.usage`
   (attribute `type` = `input` | `output` | `cacheRead` | `cacheCreation`, plus `model`), the metric `claude_code.cost.usage`, and one
   `claude_code.api_request` event per API request with `request_id`, `input_tokens`, `output_tokens`, `cache_read_tokens`,
   `cache_creation_tokens`, `cache_creation_5m_tokens`, `cache_creation_1h_tokens`, `cost_usd` (an estimate), `model` and `query_source`.
   Subagent, auxiliary and compaction requests are included and distinguished by `query_source`. The 5m/1h fields are `0`, not absent,
   when the API response does not report the split; the verifier then uses the gateway log (§17.7).

   ```bash
   export CLAUDE_CODE_ENABLE_TELEMETRY=1
   export OTEL_METRICS_EXPORTER=otlp
   export OTEL_LOGS_EXPORTER=otlp                 # api_request events travel as OTel logs
   export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
   export OTEL_EXPORTER_OTLP_ENDPOINT=http://<collector>:4318
   ```

   An OpenTelemetry Collector outside the harness's write reach stores the stream (§17.2 point 3). Each `api_request` record maps to one
   usage event: `input_tokens` → `input_tokens`, `cache_read_tokens` → `cache_read_tokens`, `cache_creation_tokens` → `cache_write_tokens`,
   `cache_creation_1h_tokens` → `cache_write_1h_tokens`, `output_tokens` → `output_tokens` (thinking included), `request_id` → `request_id`.
2. **Session transcripts**: JSONL files under `$CLAUDE_CONFIG_DIR/projects/`, including subagent transcripts. Assistant entries carry
   `message.usage` and `requestId`. One API response can span several lines that repeat the same usage, so deduplicate by `requestId`
   before summing. Auxiliary requests may be missing from transcripts, so OTel is the primary source; every transcript `requestId` must
   still appear among the events (§17.2 point 4).
3. **Headless result**: `claude -p --output-format json` (or `stream-json --verbose`) ends with a result message holding `usage`,
   per-model `modelUsage` and `total_cost_usd` for that process run.

Preflight and watchdog for the baseline: run the calibration prompt headless, then check that the collector received at least one
`api_request` event with `output_tokens > 0` and that the headless result reports usage. During the run the launch script compares the
transcripts' `requestId`s with the collector's events every few minutes. Either check failing makes it print the matching `RSDB_ABORT`
line and exit with 86.

## Appendix B. Other components *(informative)*

- **Codex CLI**: `codex exec --json` emits `turn.completed` events whose `usage` holds input, cached input, output and reasoning output
  tokens for the whole turn, so they become aggregated events (§17.5). Session rollout files (`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`)
  contain `token_count` events with cumulative `total_token_usage`; take deltas between consecutive events, not the raw values.
  `--ephemeral` disables rollout files and is forbidden. OpenAI's `input_tokens` includes cached tokens, so subtract them (§17.4).
  Check these formats against the pinned version during preflight.
- **Multi-system orchestrators** aggregate across all subsystems, tag every event with `component` and `agent_id`, and ship one frozen
  converter per subsystem in `RESULTS/raw/`.

## Appendix C. Error codes

| Code | HTTP | Meaning |
|---|---|---|
| `INVALID_ARGUMENT` | 400 | malformed request, limits, rejected schema change |
| `TYPE_ERROR` | 400 | value or literal does not match the column type, missing required column, int overflow |
| `UNKNOWN_FIELD` | 400 | column not in schema |
| `UNKNOWN_TABLE` | 404 | |
| `UNKNOWN_DATABASE` | 404 | |
| `NOT_FOUND` | 404 | `update` of a missing id |
| `DATABASE_EXISTS` | 409 | |
| `DUPLICATE_ID` | 409 | `insert` of an existing id |
| `CONSTRAINT_VIOLATION` | 409 | unique index, NOT NULL during migration |
| `DESTRUCTIVE_CHANGE` | 409 | push needs `force` |
| `SCHEMA_MISMATCH` | 409 | subscription invalidated by a schema change |
| `RESULT_TOO_LARGE` | 413 | unbounded result over 100,000 rows |
| `UNAVAILABLE` | 503 | no connection, no leader, minority side |
| `TIMEOUT` | 504 | operation or `waitForVersion` timed out |
| `CLOSED` | — | SDK only: client closed |
| `INTERNAL` | 500 | |
