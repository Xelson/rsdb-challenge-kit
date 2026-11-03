/** Admin HTTP API client (SPEC §4.3). */
import type { SchemaIR } from '@rsdb/client';

export interface ApiResponse<T = any> {
  status: number;
  body: T;
}

export async function api<T = any>(base: string, method: string, path: string, body?: unknown, timeoutMs = 15_000): Promise<ApiResponse<T>> {
  const res = await fetch(base + path, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  return { status: res.status, body: parsed as T };
}

/** The error code of an admin error body, or null. */
export const errorCode = (r: ApiResponse): string | null => (r.body && typeof r.body === 'object' && r.body.error?.code) || null;

async function ok<T>(p: Promise<ApiResponse<T>>, what: string): Promise<T> {
  const r = await p;
  if (r.status >= 300) throw new Error(`${what}: HTTP ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}

export const createDb = (url: string, name: string) =>
  ok<{ name: string; incarnation: string; version: number }>(api(url, 'POST', '/v1/databases', { name }), `create ${name}`);
export const dropDb = (url: string, name: string) => ok(api(url, 'DELETE', `/v1/databases/${encodeURIComponent(name)}`), `drop ${name}`);
export const push = (url: string, db: string, schema: SchemaIR, o: { dryRun?: boolean; force?: boolean } = {}) =>
  api(url, 'PUT', `/v1/databases/${encodeURIComponent(db)}/schema?dryRun=${o.dryRun ? 1 : 0}&force=${o.force ? 1 : 0}`, schema);
export const pushOk = (url: string, db: string, schema: SchemaIR, o: { dryRun?: boolean; force?: boolean } = {}) =>
  ok<{ applied: boolean; version: number | null; schemaVersion: number; plan: unknown[] }>(push(url, db, schema, o), `push ${db}`);

export interface DbInfo {
  name: string;
  incarnation: string;
  version: number;
  schemaVersion: number;
  leader: string;
}
export async function dbInfo(url: string, name: string): Promise<DbInfo | undefined> {
  const list = await ok<DbInfo[]>(api(url, 'GET', '/v1/databases'), 'list databases');
  return list.find((d) => d.name === name);
}
export const stats = (url: string) =>
  ok<{ connections: number; subscriptions: number; uniqueQueries: number; openDatabases: number }>(api(url, 'GET', '/v1/stats'), 'stats');
export const cluster = (url: string) => ok<any>(api(url, 'GET', '/v1/cluster'), 'cluster');

/** Creates a database and pushes a schema; returns the version of the push. */
export async function freshDb(url: string, name: string, schema: SchemaIR): Promise<number> {
  await createDb(url, name);
  const r = await pushOk(url, name, schema);
  return r.version ?? 0;
}
