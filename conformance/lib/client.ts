/** SDK helpers shared by the suites: clients closed with the case, error expectations, recorded listener calls. */
import type { SchemaIR } from '@rsdb/client';
import { canonical } from '../voter/voter.ts';
import type { NodeHandle } from './env.ts';
import type { CaseCtx } from './suite.ts';

export type AnyClient = any;

export function client(t: CaseCtx, url: string | string[], database: string, o: { timeoutMs?: number } = {}): AnyClient {
  const c = t.sdk.createClient({ url, database, ...o }) as AnyClient;
  t.defer(() => withTimeout(c.close(), 5000));
  return c;
}

/** A fresh database with `schema` on the suite's shared node and one client for it. */
export async function open(t: CaseCtx, schema: SchemaIR, label?: string): Promise<{ node: NodeHandle; url: string; db: string; v0: number; c: AnyClient }> {
  const node = await t.shared();
  const { name, version } = await t.database(node.url, schema, label);
  return { node, url: node.url, db: name, v0: version, c: client(t, node.url, name) };
}

export interface ErrorExpectation {
  opIndex?: number | null;
  /** Expected `outcome`; mutations rejected by the server are 'not_applied', reads null. */
  outcome?: 'not_applied' | 'unknown' | null;
}

/** Expects `p` to reject with an RsdbError of `code`. Returns the error, or null if it resolved or the error is not an RsdbError. */
export async function rejects(t: CaseCtx, p: Promise<unknown> | (() => Promise<unknown>), code: string, o: ErrorExpectation, what: string): Promise<any> {
  let value: unknown;
  try {
    value = await (typeof p === 'function' ? p() : p);
  } catch (e: any) {
    if (!(e instanceof t.sdk.RsdbError) || e.name !== 'RsdbError') {
      t.fail(`${what}: rejected with ${e?.name ?? typeof e} (${e?.message ?? e}), expected an RsdbError ${code}`);
      return null;
    }
    if (e.code !== code) t.fail(`${what}: code ${e.code} (${e.message}), expected ${code}`);
    if ('opIndex' in o && e.opIndex !== o.opIndex) t.fail(`${what}: opIndex ${e.opIndex}, expected ${o.opIndex}`);
    if ('outcome' in o && e.outcome !== o.outcome) t.fail(`${what}: outcome ${e.outcome}, expected ${o.outcome}`);
    return e;
  }
  t.fail(`${what}: resolved with ${clip(canonical(value ?? null))}, expected ${code}`);
  return null;
}

/** Mutation rejected by the server: nothing applied. A single-operation call is a batch of one, so its errors carry opIndex 0. */
export const mutRejects = (t: CaseCtx, p: Promise<unknown> | (() => Promise<unknown>), code: string, what: string, opIndex: number | null = 0) =>
  rejects(t, p, code, { outcome: 'not_applied', opIndex }, what);

/** Read rejected: outcome null. */
export const readRejects = (t: CaseCtx, p: Promise<unknown> | (() => Promise<unknown>), code: string, what: string) => rejects(t, p, code, { outcome: null }, what);

/** Awaits a promise and fails the case (without throwing) if it rejects. */
export async function ok<T = any>(t: CaseCtx, p: Promise<T>, what: string): Promise<T | undefined> {
  try {
    return await p;
  } catch (e: any) {
    t.fail(`${what}: rejected with ${e?.code ?? e?.name ?? 'error'}: ${e?.message ?? e}`);
    return undefined;
  }
}

/** Like ok(), but aborts the case: later steps depend on the result. */
export async function must<T = any>(t: CaseCtx, p: Promise<T>, what: string): Promise<T> {
  try {
    return await p;
  } catch (e: any) {
    return t.abort(`${what}: rejected with ${e?.code ?? e?.name ?? 'error'}: ${e?.message ?? e}`);
  }
}

export function withTimeout<T>(p: Promise<T>, ms: number, what = 'operation'): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} did not settle within ${ms} ms`)), ms);
    }),
  ]);
}

/** A listener that copies every call (rows as canonical-ready plain data) for literal comparison. */
export class Recorder {
  readonly calls: { version: number; rows?: unknown[]; count?: number; previous?: number | null; diff?: unknown }[] = [];
  readonly listener = (s: any) => {
    if ('count' in s && !('rows' in s)) this.calls.push({ version: s.version, count: s.count, previous: s.previous });
    else {
      const diff = s.diff && {
        fromVersion: s.diff.fromVersion,
        added: sortById(structuredClone([...s.diff.added])),
        updated: sortById(structuredClone([...s.diff.updated])),
        removed: [...s.diff.removed].sort(),
      };
      this.calls.push({ version: s.version, rows: structuredClone([...s.rows]), diff });
    }
  };
  /** Calls since the previous take(). */
  #taken = 0;
  take() {
    const out = this.calls.slice(this.#taken);
    this.#taken = this.calls.length;
    return out;
  }
}

export const sortById = (rows: { id: string }[]) => rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
export const clip = (s: string, n = 300) => (s.length > n ? `${s.slice(0, n)}…` : s);
