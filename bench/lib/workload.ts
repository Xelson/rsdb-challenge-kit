/**
 * Benchmark workload shared by the controller and the generators (SPEC §14.3, §14.4): the schema as IR, the hidden variant
 * (§14.1), deterministic preload rows, query families and write generators. Everything is generated from indices and seeds,
 * so the controller's voter rebuilds exactly what the generators sent without shipping it around.
 *
 * Code works with logical names (messages.channel, ...); `Variant` maps them to the physical names the server sees. Rows, ops
 * and queries leave this module physical.
 */
import type { ExprIR, JsonValue, MutationIR, QueryIR, SchemaIR } from '@rsdb/client';
import { plainDsl, type GenQuery } from '../../conformance/lib/gen.ts';
import { Rng } from '../../conformance/lib/rng.ts';

/** bench/schema.ts as IR. The voter and the admin push use this, never the SDK's own DSL output. */
export const BENCH_SCHEMA: SchemaIR = {
  format: 'rsdb-schema/1',
  tables: {
    messages: {
      columns: {
        channel: { type: 'int', nullable: false },
        author: { type: 'string', nullable: false },
        body: { type: 'string', nullable: false },
        ts: { type: 'float', nullable: false },
        sentAt: { type: 'float', nullable: false },
        meta: { type: 'json', nullable: true },
      },
      indexes: [{ name: 'by_channel_ts', columns: ['channel', 'ts'], unique: false }],
    },
    users: {
      columns: {
        name: { type: 'string', nullable: false },
        team: { type: 'int', nullable: false },
        score: { type: 'int', nullable: false },
        active: { type: 'bool', nullable: false, default: true },
        sentAt: { type: 'float', nullable: false, default: 0 },
      },
      indexes: [
        { name: 'by_team_score', columns: ['team', 'score'], unique: false },
        { name: 'by_score', columns: ['score'], unique: false },
      ],
    },
    counters: { columns: { value: { type: 'int', nullable: false, default: 0 } }, indexes: [] },
  },
};

export type Row = Record<string, JsonValue>;

// ─────────────────────────────── variant ───────────────────────────────

/**
 * The scored runs' variant (§14.1): renamed tables and columns, permuted column order, one scale factor in [0.8, 1.25] for rates
 * and data sizes, and query parameters drawn from each scenario's family. `seed: null` is the identity used by run-local.
 */
export class Variant {
  readonly seed: number | null;
  readonly factor: number;
  #tables = new Map<string, string>();
  #cols = new Map<string, Map<string, string>>();
  #order = new Map<string, string[]>();

  constructor(seed: number | null) {
    this.seed = seed;
    const rng = seed === null ? null : new Rng(`variant:${seed}`);
    this.factor = rng ? 0.8 + rng.next() * 0.45 : 1;
    const used = new Set<string>();
    const fresh = (prefix: string) => {
      for (;;) {
        const name = `${prefix}${Math.floor(rng!.next() * 36 ** 5).toString(36).padStart(5, '0')}`;
        if (!used.has(name)) return used.add(name), name;
      }
    };
    for (const [t, def] of Object.entries(BENCH_SCHEMA.tables)) {
      this.#tables.set(t, rng ? fresh('t') : t);
      const cols = new Map<string, string>();
      for (const c of Object.keys(def.columns)) cols.set(c, rng ? fresh('c') : c);
      this.#cols.set(t, cols);
      this.#order.set(t, rng ? rng.shuffle(Object.keys(def.columns)) : Object.keys(def.columns));
    }
  }

  table(t: string): string {
    return this.#tables.get(t) ?? fail(`unknown table ${t}`);
  }
  col(t: string, c: string): string {
    return c === 'id' ? 'id' : (this.#cols.get(t)?.get(c) ?? fail(`unknown column ${t}.${c}`));
  }

  schema(): SchemaIR {
    const tables: SchemaIR['tables'] = {};
    for (const [t, def] of Object.entries(BENCH_SCHEMA.tables)) {
      const columns: SchemaIR['tables'][string]['columns'] = {};
      for (const c of this.#order.get(t)!) columns[this.col(t, c)] = def.columns[c]!;
      tables[this.table(t)] = { columns, indexes: def.indexes.map((i) => ({ ...i, columns: i.columns.map((c) => this.col(t, c)) })) };
    }
    return { format: 'rsdb-schema/1', tables };
  }

  row(t: string, row: Row): Row {
    const out: Row = {};
    for (const [k, v] of Object.entries(row)) out[this.col(t, k)] = v;
    return out;
  }

  expr(t: string, e: ExprIR): ExprIR {
    if ('args' in e) return { op: e.op, args: e.args.map((a) => this.expr(t, a)) };
    return { ...e, field: this.col(t, e.field) } as ExprIR;
  }

  query(q: QueryIR): QueryIR {
    const t = q.table;
    const where = q.where ? this.expr(t, q.where) : null;
    if (q.kind === 'count') return { ...q, table: this.table(t), where };
    return {
      ...q,
      table: this.table(t),
      where,
      orderBy: q.orderBy.map((o) => ({ field: this.col(t, o.field), dir: o.dir })),
      select: q.select ? q.select.map((c) => this.col(t, c)) : null,
    };
  }

  op(m: MutationIR): MutationIR {
    const t = m.table;
    const set = (s: Record<string, unknown>) => this.row(t, s as Row) as never;
    switch (m.op) {
      case 'insert':
      case 'upsert':
        return { ...m, table: this.table(t), row: this.row(t, m.row as Row) as never };
      case 'update':
        return { ...m, table: this.table(t), set: set(m.set) };
      case 'delete':
        return { ...m, table: this.table(t) };
      case 'updateWhere':
        return { ...m, table: this.table(t), where: m.where ? this.expr(t, m.where) : null, set: set(m.set) };
      case 'deleteWhere':
        return { ...m, table: this.table(t), where: m.where ? this.expr(t, m.where) : null };
    }
  }

  /** A query parameter: `def` in the identity variant, otherwise drawn from the family by `key`. */
  limit(def: number, key: string): number {
    return this.seed === null ? def : new Rng(`limit:${this.seed}:${key}`).range(5, 50);
  }
  dir(def: 'asc' | 'desc', key: string): 'asc' | 'desc' {
    return this.seed === null ? def : new Rng(`dir:${this.seed}:${key}`).pick(['asc', 'desc'] as const);
  }
}

const fail = (m: string): never => {
  throw new Error(m);
};

// ─────────────────────────────── data ───────────────────────────────

/** 32-bit integer hash of (i, salt). */
export function mix(i: number, salt = 0): number {
  let h = Math.imul(i ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(salt + 0x632be5ab, 0xc2b2ae35);
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  return (h ^ (h >>> 16)) >>> 0;
}

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789 ';
/** Deterministic ASCII text of `len` characters. */
export function text(seed: number, len: number): string {
  let s = '';
  let h = seed >>> 0 || 1;
  for (let k = 0; k < len; k++) {
    h ^= h << 13;
    h ^= h >>> 17;
    h ^= h << 5;
    s += ALPHABET[(h >>> 0) % ALPHABET.length];
  }
  return s;
}

/** Live inserts sort after every preloaded row on `ts`. */
export const LIVE_TS = 1e12;

export interface MessageLayout {
  /** Rows are spread over channels [base, base + channels). */
  channels: number;
  base?: number;
  bodyLen?: number;
}
export function message(i: number, l: MessageLayout): Row {
  const h = mix(i, 11);
  return {
    id: `m${i}`,
    channel: (l.base ?? 0) + (i % l.channels),
    author: `a${h % 1000}`,
    body: text(h, l.bodyLen ?? 40),
    ts: i,
    sentAt: 0,
    meta: i % 10 === 0 ? { tags: [`t${h % 7}`] } : null,
  };
}

/** Score range of `users.score`. */
export const MAX_SCORE = 100_000;
export const userName = (h: number) => (h % 36 ** 6).toString(36).padStart(6, '0');
export function user(i: number, teams: number): Row {
  const h = mix(i, 23);
  return { id: `u${i}`, name: userName(h), team: i % teams, score: mix(i, 29) % MAX_SCORE, active: mix(i, 31) % 10 !== 0, sentAt: 0 };
}

export const COUNTERS = 10;
export const counter = (i: number): Row => ({ id: `c${i}`, value: 0 });

// ─────────────────────────────── queries ───────────────────────────────

/** A subscription or fetch, compact enough to ship 100k of them to the generators: family name and arguments. */
export type QSpec = readonly (string | number)[];

const rows = (table: string, where: ExprIR | null, orderBy: { field: string; dir: 'asc' | 'desc' }[], limit: number | null, select: string[] | null = null): QueryIR =>
  ({ format: 'rsdb-query/1', kind: 'rows', table, where, orderBy, limit, select });
const count = (table: string, where: ExprIR | null): QueryIR => ({ format: 'rsdb-query/1', kind: 'count', table, where });
const eq = (field: string, value: JsonValue): ExprIR => ({ op: 'eq', field, value } as ExprIR);
const and = (...args: ExprIR[]): ExprIR => ({ op: 'and', args });

/** Logical IR of a spec. */
export function logicalQuery(spec: QSpec): QueryIR {
  const [family, ...a] = spec;
  const n = (k: number) => a[k] as number;
  switch (family) {
    case 'ch': // messages{channel:k} ts <dir> limit L
      return rows('messages', eq('channel', n(0)), [{ field: 'ts', dir: a[2] as 'asc' | 'desc' }], n(1));
    case 'chAll': // messages{channel:k}, no limit
      return rows('messages', eq('channel', n(0)), [], null);
    case 'team': // users{team:k} score <dir> limit L
      return rows('users', eq('team', n(0)), [{ field: 'score', dir: a[2] as 'asc' | 'desc' }], n(1));
    case 'teamCount':
      return count('users', eq('team', n(0)));
    case 'teamScore': // users{team:k, score >= x} score desc limit L
      return rows('users', and(eq('team', n(0)), { op: 'gte', field: 'score', value: n(1) }), [{ field: 'score', dir: 'desc' }], n(2));
    case 'teamScoreCount':
      return count('users', and(eq('team', n(0)), { op: 'gte', field: 'score', value: n(1) }));
    case 'quiet': // a count on a table nobody writes
      return count('counters', null);
    case 'counters': // every counter, highest first (B11)
      return rows('counters', null, [{ field: 'value', dir: 'desc' }], 10);
    case 'b13':
      return mixedQuery(n(0), n(1), n(2));
    default:
      throw new Error(`unknown query family ${family}`);
  }
}

export function physicalQuery(spec: QSpec, v: Variant): QueryIR {
  return v.query(logicalQuery(spec));
}

/** The query as the generators build it through the SDK (one plain DSL spelling). */
export function genQuery(spec: QSpec, v: Variant): GenQuery {
  const ir = physicalQuery(spec, v);
  return { ir, wheres: ir.where ? [plainDsl(ir.where)] : [] };
}

/**
 * B13 family (§14.4): ranges and `in` on indexed and unindexed columns, `startsWith` on name, `$or` of two teams, filters on
 * `active`, projections, limits and unlimited results of at most 2,000 rows; 20 % count queries. `sentAt` is never selected or
 * filtered. Projections always keep the sort column, so a change of order is always a change of returned values.
 */
export function mixedQuery(i: number, users: number, teams: number): QueryIR {
  const rng = new Rng(`b13:${i}`);
  const team = () => rng.int(teams);
  const perTeam = users / teams;
  // a score window holding about `rowsWanted` rows of the whole table
  const window = (rowsWanted: number) => {
    const w = Math.max(1, Math.floor((rowsWanted * MAX_SCORE) / users));
    const lo = rng.int(Math.max(1, MAX_SCORE - w));
    return [lo, lo + w] as const;
  };
  const shapes: (() => ExprIR)[] = [
    () => ({ op: 'in', field: 'team', values: [team(), team()] }),
    () => and(eq('team', team()), { op: 'gte', field: 'score', value: rng.int(MAX_SCORE) }),
    () => {
      const [lo, hi] = window(Math.min(1500, users / 4));
      return and({ op: 'gte', field: 'score', value: lo }, { op: 'lt', field: 'score', value: hi });
    },
    () => ({ op: 'startsWith', field: 'name', value: userName(mix(rng.int(users), 23)).slice(0, 3) }),
    () => ({ op: 'or', args: [eq('team', team()), eq('team', team())] }),
    () => and(eq('team', team()), eq('active', false)),
    () => {
      const [lo] = window(Math.min(1500, users / 4));
      return and(eq('active', true), { op: 'gt', field: 'score', value: lo });
    },
    () => ({ op: 'in', field: 'name', values: [0, 1, 2].map(() => userName(mix(rng.int(users), 23))) }),
  ];
  const shape = rng.int(shapes.length);
  const where = shapes[shape]!();
  if (rng.chance(0.2)) return count('users', where);
  // shape 6 is a wide range over the whole table: always limited; the others hold at most 2,000 rows (two teams of perTeam ≤ 1,000)
  const unlimitedOk = shape !== 6 && perTeam <= 1000;
  const limit = unlimitedOk && rng.chance(0.4) ? null : rng.range(5, 50);
  const dir = rng.pick(['asc', 'desc'] as const);
  const orderBy = shape === 3 || shape === 7 ? [{ field: 'name', dir }] : [{ field: 'score', dir }];
  const select = rng.chance(0.4) ? [...new Set([orderBy[0]!.field, rng.pick(['name', 'team', 'score', 'active'])])] : null;
  return rows('users', where, orderBy, limit, select);
}

// ─────────────────────────────── writes ───────────────────────────────

/** Write generator of one writer process; `next` returns the logical ops of write k scheduled at `schedMs`. */
export interface OpGen {
  next(k: number, schedMs: number): MutationIR[];
}

export interface OpGenSpec {
  kind: string;
  [k: string]: unknown;
}

/** `prefix` makes the ids of rows this process inserts unique across all writer processes of a run. */
export function opGen(spec: OpGenSpec, rng: Rng, proc: number, procs: number, prefix = `w${proc}`): OpGen {
  const num = (k: string) => spec[k] as number;
  switch (spec.kind) {
    case 'insertMessage': {
      // new message in a random channel of [base, base + channels), or of `hot` when given
      const hot = spec.hot as number[] | undefined;
      return {
        next: (k, schedMs) => [{
          op: 'insert', table: 'messages',
          row: {
            id: `${prefix}_${k}`, channel: hot ? rng.pick(hot) : num('base') + rng.int(num('channels')), author: prefix,
            body: text(mix(k, proc), num('bodyLen') || 40), ts: LIVE_TS + schedMs, sentAt: schedMs, meta: null,
          },
        }],
      };
    }
    case 'updateScore':
      return { next: () => [{ op: 'update', table: 'users', id: `u${rng.int(num('users'))}`, set: { score: rng.int(MAX_SCORE) } }] };
    case 'updateBody':
      return { next: (k) => [{ op: 'update', table: 'messages', id: `m${rng.int(num('rows'))}`, set: { body: text(mix(k, proc + 97), num('bodyLen')) } }] };
    case 'bulkInc': {
      // updateWhere over `teamsPerWrite` random teams (B5)
      const teams = num('teams');
      return { next: () => [{ op: 'updateWhere', table: 'users', where: { op: 'in', field: 'team', values: rng.sample(range(teams), num('teamsPerWrite')) }, set: { score: { $inc: 1 } } }] };
    }
    case 'insertOrInc': {
      // B11: inserts and $inc on the counters
      return {
        next: (k, schedMs) => rng.chance(0.5)
          ? [{ op: 'insert', table: 'messages', row: { id: `${prefix}_${k}`, channel: rng.int(num('channels')), author: prefix, body: text(mix(k, proc), 40), ts: LIVE_TS + schedMs, sentAt: schedMs, meta: null } }]
          : [{ op: 'update', table: 'counters', id: `c${rng.int(COUNTERS)}`, set: { value: { $inc: 1 } } }],
      };
    }
    case 'mixed':
      return mixedWrites(rng, proc, procs, num('users'), num('teams'), prefix);
    default:
      throw new Error(`unknown write generator ${spec.kind}`);
  }
}

const range = (n: number) => Array.from({ length: n }, (_, i) => i);

/**
 * B13 writes: 60 % updates of score, name, active or sentAt, 20 % inserts, 20 % deletes. Each writer process owns the preloaded
 * users with index ≡ proc (mod procs) plus its own inserts, so no write targets a row another process deleted.
 */
function mixedWrites(rng: Rng, proc: number, procs: number, users: number, teams: number, prefix: string): OpGen {
  const live: string[] = [];
  for (let i = proc; i < users; i += procs) live.push(`u${i}`);
  const pick = () => {
    const k = rng.int(live.length);
    return [k, live[k]!] as const;
  };
  return {
    next: (k, schedMs) => {
      const r = rng.next();
      if (r < 0.2 || live.length < 10) {
        const id = `${prefix}_${k}`;
        live.push(id);
        const h = mix(k, 1000 + proc);
        return [{ op: 'insert', table: 'users', row: { id, name: userName(h), team: rng.int(teams), score: rng.int(MAX_SCORE), active: true, sentAt: schedMs } }];
      }
      if (r < 0.4) {
        const [at, id] = pick();
        live[at] = live[live.length - 1]!;
        live.pop();
        return [{ op: 'delete', table: 'users', id }];
      }
      const [, id] = pick();
      const field = rng.pick(['score', 'name', 'active', 'sentAt'] as const);
      const value = field === 'score' ? rng.int(MAX_SCORE) : field === 'name' ? userName(mix(k, 2000 + proc)) : field === 'active' ? rng.chance(0.5) : schedMs;
      return [{ op: 'update', table: 'users', id, set: { [field]: value } }];
    },
  };
}
