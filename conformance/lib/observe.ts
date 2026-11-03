/**
 * Per-subscription checks that need no expected answer (SPEC §13.2 row 1, R2, R3, R5, R11): every listener call is checked
 * against the previous one as it happens. Snapshot rows are only valid until the next callback, so everything is copied
 * (as canonical JSON) inside the listener.
 */
import { createHash } from 'node:crypto';
import type { CountSnapshot, QueryIR, RowsSnapshot, Subscription } from '@rsdb/client';
import { canonical } from '../voter/voter.ts';
import type { CaseCtx } from './suite.ts';

export const hashOf = (body: string) => createHash('sha256').update(body).digest('hex');
/** Same hashing as the voter's resultHash, from already canonical text. */
export const rowsHash = (canonRows: string) => hashOf(`rows:${canonRows}`);
export const countHash = (n: number) => hashOf(`count:${n}`);

export interface Delivery {
  version: number;
  hash: string;
  /** Delivered result as canonical JSON when small, for failure reports. */
  sample?: string;
}

interface State {
  version: number;
  ids: string[];
  byId: Map<string, string>;
  canon: string;
  count: number;
  /** Only the version is known (a light check, `ObserverOptions.light`). */
  partial?: boolean;
}

export interface ObserverOptions {
  label: string;
  query: QueryIR;
  /** Record every delivery for voter replay (§13.3: 30 chosen subscriptions per seed). */
  record?: boolean;
  /** Extra invariant on every rows snapshot (bank totals, R9); returns a message when violated. */
  invariant?: (rows: readonly Record<string, unknown>[], version: number) => string | null;
  onCall?: (version: number) => void;
  /** Every delivery with its hash (cross-node comparison, R8). */
  onDelivery?: (d: Delivery) => void;
  /**
   * Asked before each rows callback after the first; true skips reading the rows (benchmark audit budget, §14.2): versions, the
   * presence and bounds of the diff and R11 are still checked, and the next full check does not compare against this one.
   */
  light?: () => boolean;
}

export class Observer {
  readonly label: string;
  readonly query: QueryIR;
  readonly deliveries: Delivery[] = [];
  calls = 0;
  sub!: Subscription<any>;
  unsubscribed = false;
  terminated: { code: string; message: string } | null = null;
  #t: CaseCtx;
  #o: ObserverOptions;
  #last: State | null = null;
  #sampledVersion = -1;
  #sampledSynced = -1;

  constructor(t: CaseCtx, o: ObserverOptions) {
    this.#t = t;
    this.#o = o;
    this.label = o.label;
    this.query = o.query;
  }

  /** Attaches to a subscription created with `observer.listener` as its listener. */
  attach(sub: Subscription<any>): this {
    this.sub = sub;
    sub.onError((e) => {
      if (sub.closed && !this.unsubscribed) this.terminated = { code: e.code, message: e.message };
    });
    return this;
  }

  get version(): number {
    return this.#last?.version ?? -1;
  }

  readonly listener = (snap: RowsSnapshot<any> | CountSnapshot): void => {
    const t = this.#t;
    const L = this.label;
    this.calls++;
    if (this.unsubscribed) t.fail(`R11 ${L}: listener ran after unsubscribe() at version ${snap.version}`);
    const prev = this.#last;
    const v = snap.version;
    if (!Number.isInteger(v) || v < 0) t.fail(`${L}: snapshot version ${v} is not a version`);
    if (prev && v <= prev.version) t.fail(`R2 ${L}: version ${v} after ${prev.version}`);
    if (v <= this.#sampledVersion) t.fail(`R2 ${L}: version ${v} not above current.version ${this.#sampledVersion} observed before the call`);

    let next: State;
    if (this.query.kind === 'count') {
      const s = snap as CountSnapshot;
      next = { version: v, ids: [], byId: new Map(), canon: String(s.count), count: s.count };
      if (!Number.isInteger(s.count) || s.count < 0) t.fail(`${L}: count ${s.count}`);
      if (!prev && s.previous !== null) t.fail(`${L}: first count snapshot has previous=${s.previous}, expected null`);
      if (prev && s.previous !== prev.count) t.fail(`R5 ${L}: previous=${s.previous}, expected ${prev.count} at v${v}`);
      if (prev && s.count === prev.count) t.fail(`R3 ${L}: callback at v${v} with unchanged count ${s.count}`);
    } else if (prev && this.#o.light?.()) {
      const s = snap as RowsSnapshot<any>;
      if (!s.diff) t.fail(`R5 ${L}: no diff at v${v}`);
      else if (s.diff.fromVersion < prev.version || s.diff.fromVersion >= v) t.fail(`R5 ${L}: diff.fromVersion ${s.diff.fromVersion} at v${v}, previous call v${prev.version}`);
      this.#last = { version: v, ids: [], byId: new Map(), canon: '', count: -1, partial: true };
      this.#o.onCall?.(v);
      return;
    } else {
      const s = snap as RowsSnapshot<any>;
      const rows = [...s.rows];
      const ids = rows.map((r) => r.id as string);
      const byId = new Map<string, string>();
      for (const r of rows) byId.set(r.id, canonical(r));
      const canon = `[${rows.map((r) => byId.get(r.id)).join(',')}]`;
      next = { version: v, ids, byId, canon, count: rows.length };
      this.#shape(rows, v);
      if (byId.size !== rows.length) t.fail(`${L}: duplicate ids in rows at v${v}`);
      if (!prev) {
        if (s.diff !== null) t.fail(`${L}: first snapshot has a diff, expected null`);
      } else if (!s.diff) t.fail(`R5 ${L}: no diff at v${v}`);
      else if (!prev.partial) {
        if (prev.canon === canon) t.fail(`R3 ${L}: callback at v${v} with an unchanged result`);
        this.#checkDiff(prev, next, s.diff, v);
      }
      const bad = this.#o.invariant?.(rows, v);
      if (bad) t.fail(`R9 ${L} at v${v}: ${bad}`);
    }
    if (this.#o.record || this.#o.onDelivery) {
      const hash = this.query.kind === 'count' ? countHash(next.count) : rowsHash(next.canon);
      const d = { version: v, hash, ...(next.canon.length <= 2000 ? { sample: next.canon } : {}) };
      if (this.#o.record) this.deliveries.push(d);
      this.#o.onDelivery?.(d);
    }
    this.#last = next;
    this.#o.onCall?.(v);
  };

  #shape(rows: Record<string, unknown>[], v: number) {
    const q = this.query;
    if (q.kind !== 'rows') return;
    if (q.limit !== null && rows.length > q.limit) this.#t.fail(`${this.label}: ${rows.length} rows over limit ${q.limit} at v${v}`);
    if (q.select) {
      const want = canonical(['id', ...q.select].sort());
      const r = rows.find((x) => canonical(Object.keys(x).sort()) !== want);
      if (r) this.#t.fail(`${this.label}: row keys ${Object.keys(r).join(',')} do not match the projection at v${v}`);
    }
  }

  #checkDiff(prev: State, next: State, diff: RowsSnapshot<any>['diff'] & {}, v: number) {
    const t = this.#t;
    const L = this.label;
    if (diff.fromVersion < prev.version || diff.fromVersion < this.#sampledVersion || diff.fromVersion >= v) {
      t.fail(`R5 ${L}: diff.fromVersion ${diff.fromVersion} at v${v}, previous call v${prev.version}, current.version seen ${this.#sampledVersion}`);
    }
    const removed = prev.ids.filter((id) => !next.byId.has(id)).sort();
    const added = next.ids.filter((id) => !prev.byId.has(id)).map((id) => next.byId.get(id)!).sort();
    const updated = next.ids.filter((id) => prev.byId.has(id) && prev.byId.get(id) !== next.byId.get(id)).map((id) => next.byId.get(id)!).sort();
    const got = {
      removed: [...diff.removed].sort(),
      added: diff.added.map((r) => canonical(r)).sort(),
      updated: diff.updated.map((r) => canonical(r)).sort(),
    };
    for (const k of ['removed', 'added', 'updated'] as const) {
      const exp = k === 'removed' ? removed : k === 'added' ? added : updated;
      if (canonical(got[k]) !== canonical(exp)) t.fail(`R5 ${L}: diff.${k} at v${v} is ${clip(canonical(got[k]))}, expected ${clip(canonical(exp))}`);
    }
  }

  /** Samples current.version and syncedVersion; both must never decrease (R2). */
  sample(): void {
    const s = this.sub;
    if (!s || this.unsubscribed || s.closed) return;
    const cv = s.current?.version ?? -1;
    if (cv < this.#sampledVersion) this.#t.fail(`R2 ${this.label}: current.version went from ${this.#sampledVersion} to ${cv}`);
    if (s.syncedVersion < this.#sampledSynced) this.#t.fail(`R2 ${this.label}: syncedVersion went from ${this.#sampledSynced} to ${s.syncedVersion}`);
    if (s.current && s.syncedVersion < cv) this.#t.fail(`R7 ${this.label}: syncedVersion ${s.syncedVersion} below current.version ${cv}`);
    this.#sampledVersion = Math.max(this.#sampledVersion, cv);
    this.#sampledSynced = Math.max(this.#sampledSynced, s.syncedVersion);
  }

  /** The exact result the subscription holds now: `current` at `current.version` (R7), as a delivery. */
  current(): Delivery | null {
    const c = this.sub?.current;
    if (!c) return null;
    if (this.query.kind === 'count') return { version: c.version, hash: countHash(c.count) };
    const canon = `[${c.rows.map((r: unknown) => canonical(r)).join(',')}]`;
    return { version: c.version, hash: rowsHash(canon), ...(canon.length <= 2000 ? { sample: canon } : {}) };
  }

  unsubscribe(): void {
    this.unsubscribed = true;
    this.sub?.unsubscribe();
  }
}

const clip = (s: string, n = 200) => (s.length > n ? `${s.slice(0, n)}…` : s);
