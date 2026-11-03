// No-op SDK for the cli_* baseline (SPEC §14.2): the same runner code runs against it, so the measured difference is the SDK's.
// Nothing connects; subscriptions are ready at once and never call their listener.
const snapshot = { version: 0, rows: [], diff: null, count: 0, previous: null };
const done = () => Promise.resolve({ version: 0, id: 'stub', deleted: false, count: 0, results: [] });

function query() {
  const q = {
    where: () => q, orderBy: () => q, limit: () => q, select: () => q, count: () => q,
    toIR: () => null,
    fetch: () => Promise.resolve(snapshot),
    subscribe: () => ({
      ready: Promise.resolve(snapshot), current: snapshot, syncedVersion: Number.MAX_SAFE_INTEGER, closed: false,
      onError: () => () => {}, unsubscribe() {},
    }),
  };
  return q;
}

export function createClient(options) {
  return {
    database: options.database, status: 'open', lastWriteVersion: 0,
    from: query,
    insert: done, upsert: done, update: done, delete: done, updateWhere: done, deleteWhere: done, batch: done,
    waitForVersion: () => Promise.resolve(),
    onStatus: () => () => {},
    close: () => Promise.resolve(),
  };
}

export const defineSchema = (s) => s;
export const table = (columns) => ({ columns, index() { return this; } });
export const t = new Proxy({}, { get: () => () => ({ optional() { return this; }, default() { return this; } }) });
export class RsdbError extends Error {}
