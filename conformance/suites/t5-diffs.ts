/**
 * T5 Diffs and spurious updates (SPEC §13.5): each step is one batch, so it has one version and at most one callback; the expected
 * callbacks (none, or rows plus diff) are written by hand. Every call also goes through the Observer checks of §13.2 (R2, R3, R5).
 */
import type { QueryIR, SchemaIR } from '@rsdb/client';
import { canonical } from '../voter/voter.ts';
import { clip, must, open, Recorder, sortById, withTimeout, type AnyClient } from '../lib/client.ts';
import { Observer } from '../lib/observe.ts';
import type { CaseCtx, Suite } from '../lib/suite.ts';

const SCHEMA: SchemaIR = {
  format: 'rsdb-schema/1',
  tables: {
    items: {
      columns: {
        x: { type: 'int', nullable: false },
        y: { type: 'int', nullable: true },
        name: { type: 'string', nullable: false, default: '' },
        j: { type: 'json', nullable: true },
      },
      indexes: [{ name: 'by_x', columns: ['x'], unique: false }],
    },
    other: { columns: { x: { type: 'int', nullable: false, default: 0 } }, indexes: [] },
  },
};

const row = (id: string, o: Record<string, unknown>) => ({ id, x: 0, y: null, name: '', j: null, ...o });

interface Expect {
  rows?: unknown[];
  added?: unknown[];
  updated?: unknown[];
  removed?: string[];
  count?: number;
  previous?: number | null;
}

type Write = (c: AnyClient) => Promise<{ version: number }>;

const rowsIR = (o: Partial<Extract<QueryIR, { kind: 'rows' }>> = {}): QueryIR =>
  ({ format: 'rsdb-query/1', kind: 'rows', table: 'items', where: null, orderBy: [], limit: null, select: null, ...o }) as QueryIR;

/** Subscribes `build(c)` after `setup`, checks the initial snapshot and returns a step function. */
async function start(t: CaseCtx, o: { ir: QueryIR; build: (c: AnyClient) => any; setup?: (tx: any) => void; initial: Expect; listener?: (s: any) => void }) {
  const { c } = await open(t, SCHEMA);
  if (o.setup) await must(t, c.batch(o.setup), 'setup batch');
  const rec = new Recorder();
  const obs = new Observer(t, { label: 'sub', query: o.ir });
  const sub = o.build(c).subscribe((s: any) => {
    obs.listener(s);
    rec.listener(s);
    o.listener?.(s);
  });
  obs.attach(sub);
  t.defer(() => sub.unsubscribe());
  const snap = await must(t, sub.ready, 'subscribe');
  await must(t, withTimeout(c.waitForVersion(snap.version), 6000, 'waitForVersion'), 'waitForVersion after subscribe');
  const first = rec.take();
  if (first.length !== 1) t.abort(`initial snapshot: ${first.length} callbacks, expected 1`);
  t.eq(first[0]!.diff ?? null, null, 'initial snapshot diff');
  if (o.initial.rows) t.eq(first[0]!.rows, o.initial.rows, 'initial rows');
  if (o.initial.count !== undefined) t.eq([first[0]!.count, first[0]!.previous], [o.initial.count, null], 'initial count and previous');

  const step = async (label: string, write: Write, expect: Expect | null) => {
    const r = await must(t, write(c), label);
    await must(t, withTimeout(c.waitForVersion(r.version), 6000, 'waitForVersion'), `${label}: waitForVersion(${r.version})`);
    obs.sample();
    const calls = rec.take();
    if (!expect) {
      if (calls.length) t.fail(`${label}: expected no callback (R3), got ${calls.length}: ${clip(canonical(calls))}`);
    } else if (calls.length !== 1) t.fail(`${label}: expected one callback, got ${calls.length}: ${clip(canonical(calls))}`);
    else {
      const call = calls[0]!;
      t.eq(call.version, r.version, `${label}: callback version`);
      if (expect.rows) t.eq(call.rows, expect.rows, `${label}: rows`);
      if (expect.count !== undefined) t.eq([call.count, call.previous], [expect.count, expect.previous], `${label}: count and previous`);
      if (!('count' in call)) {
        const d = call.diff as { added: unknown[]; updated: unknown[]; removed: string[] } | null;
        t.eq(d && { added: d.added, updated: d.updated, removed: d.removed }, {
          added: sortById(([...(expect.added ?? [])] as { id: string }[])),
          updated: sortById(([...(expect.updated ?? [])] as { id: string }[])),
          removed: [...(expect.removed ?? [])].sort(),
        }, `${label}: diff`);
      }
    }
    if (sub.syncedVersion < r.version) t.fail(`${label}: syncedVersion ${sub.syncedVersion} below ${r.version} after waitForVersion (R7)`);
  };
  return { c, sub, step };
}

const cases: { name: string; run: (t: CaseCtx) => Promise<void> }[] = [
  {
    name: 'no-op writes cause no callback',
    async run(t) {
      const a = row('a', { x: 1 });
      const b = row('b', { x: 2 });
      const { step } = await start(t, {
        ir: rowsIR(),
        build: (c) => c.from('items'),
        setup: (tx) => { tx.insert('items', { id: 'a', x: 1 }); tx.insert('items', { id: 'b', x: 2 }); },
        initial: { rows: [a, b] },
      });
      await step('update to the same value', (c) => c.update('items', 'a', { x: 1 }), null);
      await step('$inc 0 on every row', (c) => c.updateWhere('items', {}, { x: { $inc: 0 } }), null);
      await step('upsert of an identical row', (c) => c.upsert('items', { id: 'a', x: 1 }), null);
      const aj = row('a', { x: 1, j: { k: [1, 2], m: 'z' } });
      await step('json value set', (c) => c.update('items', 'a', { j: { k: [1, 2], m: 'z' } }), { rows: [aj, b], updated: [aj] });
      await step('json with reordered keys', (c) => c.update('items', 'a', { j: { m: 'z', k: [1, 2] } }), null);
      const b0 = row('b', { x: 0 });
      await step('set 0', (c) => c.update('items', 'b', { x: 0 }), { rows: [aj, b0], updated: [b0] });
      await step('set -0 over 0', (c) => c.update('items', 'b', { x: -0 }), null);
      await step('delete of a missing id', (c) => c.delete('items', 'zz'), null);
      await step('write to another table', (c) => c.insert('other', { id: 'o1' }), null);
      await step('change and change back in one batch', (c) => c.batch((tx: any) => { tx.update('items', 'a', { x: 5 }); tx.update('items', 'a', { x: 1 }); }), null);
      await step('delete and identical re-insert in one batch', (c) => c.batch((tx: any) => { tx.delete('items', 'a'); tx.insert('items', { id: 'a', x: 1, j: { k: [1, 2], m: 'z' } }); }), null);
      const a7 = row('a', { x: 7 });
      await step('delete and different re-insert in one batch', (c) => c.batch((tx: any) => { tx.delete('items', 'a'); tx.insert('items', { id: 'a', x: 7 }); }), { rows: [a7, b0], updated: [a7] });
      await step('insert and delete of a new id in one batch', (c) => c.batch((tx: any) => { tx.insert('items', { id: 'n', x: 3 }); tx.delete('items', 'n'); }), null);
    },
  },
  {
    name: 'unselected columns',
    async run(t) {
      const { step } = await start(t, {
        ir: rowsIR({ orderBy: [{ field: 'x', dir: 'asc' }], select: ['x'] }),
        build: (c) => c.from('items').orderBy('x').select('x'),
        setup: (tx) => { tx.insert('items', { id: 'a', x: 1, y: 1, name: 'a' }); tx.insert('items', { id: 'b', x: 2 }); },
        initial: { rows: [{ id: 'a', x: 1 }, { id: 'b', x: 2 }] },
      });
      await step('update of an unselected int', (c) => c.update('items', 'a', { y: 5 }), null);
      await step('update of an unselected string', (c) => c.update('items', 'a', { name: 'q' }), null);
      await step('update of an unselected json', (c) => c.update('items', 'b', { j: [1] }), null);
      await step('selected column changes order', (c) => c.update('items', 'a', { x: 3 }), { rows: [{ id: 'b', x: 2 }, { id: 'a', x: 3 }], updated: [{ id: 'a', x: 3 }] });
      await step('selected unchanged, unselected changed', (c) => c.update('items', 'a', { x: 3, y: 9 }), null);
      await step('insert', (c) => c.insert('items', { id: 'c', x: 0, y: 4 }), { rows: [{ id: 'c', x: 0 }, { id: 'b', x: 2 }, { id: 'a', x: 3 }], added: [{ id: 'c', x: 0 }] });
    },
  },
  {
    name: 'limit window: changes outside, entry and exit',
    async run(t) {
      const r = (id: string, x: number, o: Record<string, unknown> = {}) => row(id, { x, ...o });
      const { step } = await start(t, {
        ir: rowsIR({ orderBy: [{ field: 'x', dir: 'asc' }], limit: 3 }),
        build: (c) => c.from('items').orderBy('x', 'asc').limit(3),
        setup: (tx) => { for (let i = 1; i <= 6; i++) tx.insert('items', { id: `r${i}`, x: i }); },
        initial: { rows: [r('r1', 1), r('r2', 2), r('r3', 3)] },
      });
      await step('update below the window', (c) => c.update('items', 'r5', { x: 7 }), null);
      await step('delete below the window', (c) => c.delete('items', 'r6'), null);
      await step('insert below the window', (c) => c.insert('items', { id: 'r7', x: 10 }), null);
      await step('insert at the top', (c) => c.insert('items', { id: 'r0', x: 0 }), { rows: [r('r0', 0), r('r1', 1), r('r2', 2)], added: [r('r0', 0)], removed: ['r3'] });
      await step('a row leaves, the next enters', (c) => c.update('items', 'r2', { x: 100 }), { rows: [r('r0', 0), r('r1', 1), r('r3', 3)], added: [r('r3', 3)], removed: ['r2'] });
      await step('a row from below jumps to the top', (c) => c.update('items', 'r4', { x: -1 }), { rows: [r('r4', -1), r('r0', 0), r('r1', 1)], added: [r('r4', -1)], removed: ['r3'] });
      await step('update inside the window', (c) => c.update('items', 'r0', { y: 5 }), { rows: [r('r4', -1), r('r0', 0, { y: 5 }), r('r1', 1)], updated: [r('r0', 0, { y: 5 })] });
      await step('tie just below the window (id tiebreaker)', (c) => c.insert('items', { id: 't1', x: 1 }), null);
      await step('delete inside the window pulls in the tie', (c) => c.delete('items', 'r1'), { rows: [r('r4', -1), r('r0', 0, { y: 5 }), r('t1', 1)], added: [r('t1', 1)], removed: ['r1'] });
      await step('window refills after two exits in one batch', (c) => c.batch((tx: any) => { tx.delete('items', 'r4'); tx.delete('items', 'r0'); }), {
        rows: [r('t1', 1), r('r3', 3), r('r5', 7)], added: [r('r3', 3), r('r5', 7)], removed: ['r0', 'r4'],
      });
    },
  },
  {
    name: 'pure reorder: callback with empty diff sets',
    async run(t) {
      const n = (id: string, name: string) => ({ id, name });
      const { step } = await start(t, {
        ir: rowsIR({ orderBy: [{ field: 'x', dir: 'asc' }], select: ['name'] }),
        build: (c) => c.from('items').orderBy('x').select('name'),
        setup: (tx) => { tx.insert('items', { id: 'a', x: 1, name: 'A' }); tx.insert('items', { id: 'b', x: 2, name: 'B' }); tx.insert('items', { id: 'c', x: 3, name: 'C' }); },
        initial: { rows: [n('a', 'A'), n('b', 'B'), n('c', 'C')] },
      });
      await step('move the last row first', (c) => c.update('items', 'c', { x: 0 }), { rows: [n('c', 'C'), n('a', 'A'), n('b', 'B')] });
      await step('tie resolved by id', (c) => c.update('items', 'a', { x: 0 }), { rows: [n('a', 'A'), n('c', 'C'), n('b', 'B')] });
      await step('sort key changes, order does not', (c) => c.update('items', 'b', { x: 10 }), null);
    },
  },
  {
    name: 'filter boundaries: leave and return, insert and update',
    async run(t) {
      const r = (id: string, x: number) => row(id, { x });
      const { step } = await start(t, {
        ir: rowsIR({ where: { op: 'gt', field: 'x', value: 0 } }),
        build: (c) => c.from('items').where({ x: { gt: 0 } }),
        setup: (tx) => { tx.insert('items', { id: 'a', x: 1 }); tx.insert('items', { id: 'z', x: -5 }); },
        initial: { rows: [r('a', 1)] },
      });
      await step('leave and return in one batch', (c) => c.batch((tx: any) => { tx.update('items', 'a', { x: -1 }); tx.update('items', 'a', { x: 1 }); }), null);
      await step('update of a non-matching row', (c) => c.update('items', 'z', { x: -6 }), null);
      await step('insert and update of a new row in one batch', (c) => c.batch((tx: any) => { tx.insert('items', { id: 'n', x: 5 }); tx.update('items', 'n', { x: 6 }); }), { rows: [r('a', 1), r('n', 6)], added: [r('n', 6)] });
      await step('a row enters the filter', (c) => c.update('items', 'z', { x: 2 }), { rows: [r('a', 1), r('n', 6), r('z', 2)], added: [r('z', 2)] });
      await step('a row leaves the filter', (c) => c.update('items', 'a', { x: 0 }), { rows: [r('n', 6), r('z', 2)], removed: ['a'] });
      await step('deleteWhere of non-matching rows', (c) => c.deleteWhere('items', { x: { lte: 0 } }), null);
    },
  },
  {
    name: 'several changes in one batch',
    async run(t) {
      const { step } = await start(t, {
        ir: rowsIR(),
        build: (c) => c.from('items'),
        setup: (tx) => { tx.insert('items', { id: 'a', x: 1 }); tx.insert('items', { id: 'b', x: 2 }); tx.insert('items', { id: 'c', x: 3 }); },
        initial: { rows: [row('a', { x: 1 }), row('b', { x: 2 }), row('c', { x: 3 })] },
      });
      await step('insert, update, delete and a no-op update', (c) => c.batch((tx: any) => {
        tx.insert('items', { id: 'd', x: 4 });
        tx.update('items', 'a', { x: 10 });
        tx.delete('items', 'b');
        tx.update('items', 'c', { x: 3 });
      }), { rows: [row('a', { x: 10 }), row('c', { x: 3 }), row('d', { x: 4 })], added: [row('d', { x: 4 })], updated: [row('a', { x: 10 })], removed: ['b'] });
      await step('upsert replacing a row with defaults', (c) => c.upsert('items', { id: 'c', x: 3, name: 'n' }), {
        rows: [row('a', { x: 10 }), row('c', { x: 3, name: 'n' }), row('d', { x: 4 })], updated: [row('c', { x: 3, name: 'n' })],
      });
      await step('deleteWhere of everything', (c) => c.deleteWhere('items', {}), { rows: [], removed: ['a', 'c', 'd'] });
    },
  },
  {
    name: 'byte order and NULL order in incremental results',
    async run(t) {
      const names = ['pre', 'prefix', 'pre\u{1F600}', 'pre�', 'pr', 'Pre'];
      const s = (id: string, name: string) => ({ id, name });
      const { step } = await start(t, {
        ir: rowsIR({ where: { op: 'startsWith', field: 'name', value: 'pre' }, orderBy: [{ field: 'name', dir: 'asc' }], select: ['name'] }),
        build: (c) => c.from('items').where({ name: { startsWith: 'pre' } }).orderBy('name').select('name'),
        setup: (tx) => names.forEach((name, i) => tx.insert('items', { id: `s${i}`, x: i, name })),
        initial: { rows: [s('s0', 'pre'), s('s1', 'prefix'), s('s3', 'pre�'), s('s2', 'pre\u{1F600}')] },
      });
      await step('a row enters between others', (c) => c.update('items', 's4', { name: 'pre!' }), {
        rows: [s('s0', 'pre'), s('s4', 'pre!'), s('s1', 'prefix'), s('s3', 'pre�'), s('s2', 'pre\u{1F600}')], added: [s('s4', 'pre!')],
      });
      await step('case-sensitive prefix', (c) => c.update('items', 's5', { name: 'Prefix' }), null);
      await step('astral row moves before U+FFFD', (c) => c.update('items', 's2', { name: 'pre' }), {
        rows: [s('s0', 'pre'), s('s4', 'pre!'), s('s1', 'prefix'), s('s2', 'pre'), s('s3', 'pre�')], updated: [s('s2', 'pre')],
      });
    },
  },
  {
    name: 'NULLs first ascending, last descending',
    async run(t) {
      const y = (id: string, v: number | null) => ({ id, y: v });
      const asc = await start(t, {
        ir: rowsIR({ orderBy: [{ field: 'y', dir: 'asc' }], limit: 2, select: ['y'] }),
        build: (c) => c.from('items').orderBy('y', 'asc').limit(2).select('y'),
        setup: (tx) => { tx.insert('items', { id: 'a', x: 0 }); tx.insert('items', { id: 'b', x: 0, y: 1 }); tx.insert('items', { id: 'c', x: 0, y: 2 }); },
        initial: { rows: [y('a', null), y('b', 1)] },
      });
      await asc.step('NULL row gets a value and leaves', (c) => c.update('items', 'a', { y: 5 }), { rows: [y('b', 1), y('c', 2)], added: [y('c', 2)], removed: ['a'] });
      await asc.step('a value becomes NULL and enters first', (c) => c.update('items', 'c', { y: null }), { rows: [y('c', null), y('b', 1)], updated: [y('c', null)] });
      const desc = await start(t, {
        ir: rowsIR({ orderBy: [{ field: 'y', dir: 'desc' }], limit: 2, select: ['y'] }),
        build: (c) => c.from('items').orderBy('y', 'desc').limit(2).select('y'),
        setup: (tx) => { tx.insert('items', { id: 'a', x: 0 }); tx.insert('items', { id: 'b', x: 0, y: 1 }); tx.insert('items', { id: 'c', x: 0, y: 2 }); },
        initial: { rows: [y('c', 2), y('b', 1)] },
      });
      await desc.step('NULL stays below the window', (c) => c.insert('items', { id: 'd', x: 0 }), null);
      await desc.step('a value becomes NULL and leaves', (c) => c.update('items', 'b', { y: null }), { rows: [y('c', 2), y('a', null)], added: [y('a', null)], removed: ['b'] });
    },
  },
  {
    name: 'count: changes, unchanged counts, previous',
    async run(t) {
      const { step } = await start(t, {
        ir: { format: 'rsdb-query/1', kind: 'count', table: 'items', where: { op: 'gte', field: 'x', value: 2 } },
        build: (c) => c.from('items').where({ x: { gte: 2 } }).orderBy('x', 'desc').limit(1).count(),
        setup: (tx) => { tx.insert('items', { id: 'a', x: 1 }); tx.insert('items', { id: 'b', x: 2 }); tx.insert('items', { id: 'c', x: 3 }); },
        initial: { count: 2 },
      });
      await step('insert outside the filter', (c) => c.insert('items', { id: 'd', x: 0 }), null);
      await step('insert inside the filter', (c) => c.insert('items', { id: 'e', x: 5 }), { count: 3, previous: 2 });
      await step('update of an unfiltered column', (c) => c.update('items', 'b', { y: 1 }), null);
      await step('one in, one out in one batch', (c) => c.batch((tx: any) => { tx.insert('items', { id: 'f', x: 9 }); tx.delete('items', 'c'); }), null);
      await step('move a matching row within the filter', (c) => c.update('items', 'b', { x: 4 }), null);
      await step('updateWhere bringing every row in', (c) => c.updateWhere('items', {}, { x: 3 }), { count: 5, previous: 3 });
      await step('write to another table', (c) => c.insert('other', { id: 'o' }), null);
      await step('deleteWhere of everything', (c) => c.deleteWhere('items', {}), { count: 0, previous: 5 });
    },
  },
  {
    name: 'a throwing listener is reported and the subscription continues',
    async run(t) {
      const errors: any[] = [];
      let calls = 0;
      const { sub, step } = await start(t, {
        ir: rowsIR(),
        build: (c) => c.from('items'),
        initial: { rows: [] },
        listener: () => {
          if (++calls === 2) throw new Error('listener failure');
        },
      });
      sub.onError((e: any) => errors.push(e));
      await step('insert (listener throws)', (c) => c.insert('items', { id: 'a', x: 1 }), { rows: [row('a', { x: 1 })], added: [row('a', { x: 1 })] });
      await step('insert after the exception', (c) => c.insert('items', { id: 'b', x: 2 }), { rows: [row('a', { x: 1 }), row('b', { x: 2 })], added: [row('b', { x: 2 })] });
      t.check(errors.length === 1 && errors[0] instanceof t.sdk.RsdbError, `onError calls for the listener exception: ${errors.length}, RsdbError: ${errors[0] instanceof t.sdk.RsdbError}`);
      t.check(!sub.closed, 'subscription closed after a listener exception');
    },
  },
];

const suite: Suite = {
  id: 'T5',
  level: 'L1',
  weight: 3,
  needsSdk: true,
  cases: () => cases.map((c) => ({ name: c.name, run: c.run })),
};
export default suite;
