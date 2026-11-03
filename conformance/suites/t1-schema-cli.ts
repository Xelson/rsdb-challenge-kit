/**
 * T1 Schema and CLI (SPEC §13.5): CLI commands and exit codes (§10), TS schema loading (§5.4), plans and every migration class of
 * §5.5, dry runs, name rules (§5.3), and the effect of schema changes on live subscriptions. The CLI runs as `node <bin>` with the
 * `bin` that sdk/package.json declares; schema files live under /tmp, where no node_modules provides @rsdb/client.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { SchemaIR } from '@rsdb/client';
import { canonical } from '../voter/voter.ts';
import { api, createDb, dbInfo, errorCode, push } from '../lib/admin.ts';
import { client, must, open, readRejects, Recorder, withTimeout } from '../lib/client.ts';
import { cliBin } from '../lib/sdk.ts';
import type { CaseCtx, Suite } from '../lib/suite.ts';

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function rsdb(args: string[], o: { url?: string | null; cwd?: string; env?: Record<string, string> } = {}): Promise<CliResult> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('RSDB_') && v !== undefined) env[k] = v;
  Object.assign(env, o.env ?? {});
  const argv = [cliBin(), ...(o.url ? ['--url', o.url] : []), ...args];
  return new Promise((resolve) => {
    const p = spawn(process.execPath, argv, { cwd: o.cwd ?? '/tmp', env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => p.kill('SIGKILL'), 60_000);
    p.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

async function expectExit(t: CaseCtx, r: Promise<CliResult>, code: number, what: string): Promise<CliResult> {
  const res = await r;
  if (res.code !== code) t.fail(`${what}: exit ${res.code}, expected ${code}${res.stderr ? ` (stderr: ${res.stderr.trim().slice(0, 300)})` : ''}`);
  return res;
}

function jsonOut(t: CaseCtx, r: CliResult, what: string): any {
  try {
    return JSON.parse(r.stdout);
  } catch {
    t.fail(`${what}: --json output is not JSON: ${r.stdout.slice(0, 200)}`);
    return undefined;
  }
}

/** A fresh directory under /tmp for schema files. */
function workdir(t: CaseCtx, files: Record<string, string>): string {
  const dir = fs.mkdtempSync('/tmp/rsdb-t1-');
  for (const [name, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), body);
  }
  t.defer(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

type Step = { action: string; table: string; column?: string; index?: string; destructive: boolean };
const step = (action: string, table: string, extra: { column?: string; index?: string } = {}): Step => ({
  action, table, ...extra, destructive: action === 'dropTable' || action === 'dropColumn' || action === 'makeRequired',
});
/** Plans compare as multisets; null keys count as absent. */
const planKey = (plan: unknown) =>
  Array.isArray(plan)
    ? plan.map((s) => canonical(Object.fromEntries(Object.entries(s as object).filter(([, v]) => v !== null && v !== undefined)))).sort()
    : plan;

/** Schema IR comparison: indexes compared as a set by name. */
const schemaKey = (s: any) =>
  s && typeof s === 'object' && s.tables
    ? canonical({ ...s, tables: Object.fromEntries(Object.entries(s.tables as Record<string, any>).map(([n, tb]) => [n, { ...tb, indexes: [...(tb.indexes ?? [])].sort((a: any, b: any) => (a.name < b.name ? -1 : 1)) }])) })
    : canonical(s);

// ─────────────────────────────── schema files ───────────────────────────────

const COLUMNS_TS = `import { t } from '@rsdb/client';

interface Meta { label: string }
const meta: Meta = { label: 'users' };
export const label: string = meta.label;

export const userColumns = {
  name: t.string(),
  age: t.int().optional(),
  active: t.bool().default(true),
  prefs: t.json<{ theme: string }>().optional(),
};
`;

const SCHEMA_TS = (extra = '', usersIndex = ".index('by_age', ['age'])") => `import { defineSchema, table, t } from '@rsdb/client';
import { userColumns } from './lib/columns.ts';

export default defineSchema({
  tables: {
    users: table(userColumns)${usersIndex},
    todos: table({
      ownerId: t.string(),
      title: t.string(),
      done: t.bool().default(false),
      createdAt: t.int(),
      score: t.float().default(0.5),${extra}
    })
      .index('by_owner_created', ['ownerId', 'createdAt'])
      .index('u_title', ['title'], { unique: true }),
  },
});
`;

const SCHEMA_IR = (extra: Record<string, unknown> = {}): SchemaIR => ({
  format: 'rsdb-schema/1',
  tables: {
    users: {
      columns: {
        name: { type: 'string', nullable: false },
        age: { type: 'int', nullable: true },
        active: { type: 'bool', nullable: false, default: true },
        prefs: { type: 'json', nullable: true },
      },
      indexes: [{ name: 'by_age', columns: ['age'], unique: false }],
    },
    todos: {
      columns: {
        ownerId: { type: 'string', nullable: false },
        title: { type: 'string', nullable: false },
        done: { type: 'bool', nullable: false, default: false },
        createdAt: { type: 'int', nullable: false },
        score: { type: 'float', nullable: false, default: 0.5 },
        ...extra,
      } as SchemaIR['tables'][string]['columns'],
      indexes: [
        { name: 'by_owner_created', columns: ['ownerId', 'createdAt'], unique: false },
        { name: 'u_title', columns: ['title'], unique: true },
      ],
    },
  },
});

/** A fake @rsdb/client next to the schema: the CLI must ignore it and use its own package (§5.4). */
const FAKE_PACKAGE = {
  'node_modules/@rsdb/client/package.json': JSON.stringify({ name: '@rsdb/client', version: '0.0.0-fake', type: 'module', exports: { '.': './index.js' } }),
  'node_modules/@rsdb/client/index.js': `const fake = () => { throw new Error('the fake @rsdb/client next to the schema was loaded'); };
export const defineSchema = fake, table = fake, createClient = fake;
export const t = new Proxy({}, { get: () => fake });
export class RsdbError extends Error {}
`,
};

// ─────────────────────────────── cases ───────────────────────────────

const cases: { name: string; run: (t: CaseCtx) => Promise<void> }[] = [
  {
    name: 'CLI: database commands, --json, URL selection, exit codes',
    async run(t) {
      const node = await t.shared();
      const url = node.url;
      const name = t.dbName('cli');
      const created = jsonOut(t, await expectExit(t, rsdb(['--json', 'db', 'create', name], { url }), 0, 'db create --json'), 'db create');
      t.eq(created && { name: created.name, version: created.version, inc: typeof created.incarnation }, { name, version: 0, inc: 'string' }, 'db create --json prints the admin response');
      await expectExit(t, rsdb(['db', 'create', name], { url }), 1, 'db create of an existing name');
      await expectExit(t, rsdb(['db', 'create', 'Bad-Name'], { url }), 1, 'db create with an invalid name');
      const list = jsonOut(t, await expectExit(t, rsdb(['db', 'list', '--json'], { url }), 0, 'db list --json'), 'db list');
      t.check(Array.isArray(list) && list.some((d: any) => d.name === name), 'db list --json lists the new database');
      const viaEnv = await expectExit(t, rsdb(['db', 'list', '--json'], { env: { RSDB_URL: url } }), 0, 'db list with RSDB_URL');
      t.check(viaEnv.stdout.includes(name), 'RSDB_URL selects the server');
      await expectExit(t, rsdb(['db', 'list'], { url: null }), 4, 'default URL http://127.0.0.1:7700 with no server there');
      await expectExit(t, rsdb(['db', 'list'], { url: 'http://127.0.0.1:9' }), 4, 'unreachable --url');
      await expectExit(t, rsdb(['status'], { url: 'http://127.0.0.1:9' }), 4, 'status, unreachable');
      const status = jsonOut(t, await expectExit(t, rsdb(['status', '--json'], { url }), 0, 'status --json'), 'status');
      const cluster = (await api(url, 'GET', '/v1/cluster')).body;
      t.eq(status && Object.keys(status).sort(), Object.keys(cluster).sort(), 'status --json prints /v1/cluster');
      t.check(Array.isArray(status?.nodes) && status?.databases && typeof status.databases === 'object', 'status --json has nodes and databases');
      await expectExit(t, rsdb(['db', 'drop', name], { url }), 2, 'db drop without --yes');
      t.check(!!(await dbInfo(url, name)), 'db drop without --yes must not drop');
      await expectExit(t, rsdb(['db', 'drop', name, '--yes'], { url }), 0, 'db drop --yes');
      t.check(!(await dbInfo(url, name)), 'db drop --yes drops');
      await expectExit(t, rsdb(['db', 'drop', name, '--yes'], { url }), 1, 'db drop of a missing database');
      await expectExit(t, rsdb(['frobnicate'], { url }), 2, 'unknown command');
      await expectExit(t, rsdb(['db', 'create'], { url }), 2, 'db create without a name');
      await expectExit(t, rsdb(['push', 'x.ts'], { url }), 2, 'push without --db');
    },
  },
  {
    name: 'CLI: push loads a TS schema from anywhere',
    async run(t) {
      const node = await t.shared();
      const url = node.url;
      const name = t.dbName('push');
      await createDb(url, name);
      const dir = workdir(t, { 'schema.ts': SCHEMA_TS(), 'lib/columns.ts': COLUMNS_TS });
      await expectExit(t, rsdb(['push', path.join(dir, 'schema.ts'), '--db', name], { url }), 0, 'push (absolute path)');
      const shown = jsonOut(t, await expectExit(t, rsdb(['schema', 'show', '--db', name, '--json'], { url }), 0, 'schema show --json'), 'schema show');
      t.eq(schemaKey(shown?.schema), schemaKey(SCHEMA_IR()), 'pushed SchemaIR');
      t.eq(shown?.schemaVersion, 1, 'schemaVersion after the first push');
      const again = jsonOut(t, await expectExit(t, rsdb(['push', 'schema.ts', '--db', name, '--json'], { url, cwd: dir }), 0, 'push of the same schema (relative path)'), 'no-op push');
      t.eq(again && { applied: again.applied, version: again.version, plan: again.plan }, { applied: false, version: null, plan: [] }, 'no-op push result');
      t.eq((await dbInfo(url, name))?.version, 1, 'a no-op push consumes no version');

      const changed = workdir(t, { 'schema.ts': SCHEMA_TS('\n      note: t.string().optional(),'), 'lib/columns.ts': COLUMNS_TS, ...FAKE_PACKAGE });
      const dry = jsonOut(t, await expectExit(t, rsdb(['push', path.join(changed, 'schema.ts'), '--db', name, '--dry-run', '--json'], { url }), 0, 'push --dry-run with a fake @rsdb/client nearby'), 'dry run');
      t.eq(planKey(dry?.plan), planKey([step('addColumn', 'todos', { column: 'note' })]), 'dry-run plan');
      t.eq((await dbInfo(url, name))?.version, 1, 'a dry run applies nothing');
      const real = jsonOut(t, await expectExit(t, rsdb(['push', path.join(changed, 'schema.ts'), '--db', name, '--json'], { url }), 0, 'push next to a fake @rsdb/client'), 'push');
      t.eq(real, dry, 'the dry run returned exactly what the push returned');
      t.eq(real && { applied: real.applied, version: real.version, schemaVersion: real.schemaVersion }, { applied: true, version: 2, schemaVersion: 2 }, 'push result');

      const broken = workdir(t, {
        'syntax.ts': 'export default defineSchema({ tables: { ',
        'nodefault.ts': "import { defineSchema } from '@rsdb/client';\nexport const schema = defineSchema({ tables: {} });\n",
        'throws.ts': "throw new Error('schema module failure');\n",
      });
      for (const f of ['syntax.ts', 'nodefault.ts', 'throws.ts', 'missing.ts']) await expectExit(t, rsdb(['push', path.join(broken, f), '--db', name], { url }), 5, `push of ${f}`);
      await expectExit(t, rsdb(['push', path.join(dir, 'schema.ts'), '--db', t.dbName('nodb')], { url }), 1, 'push to a missing database (push never creates one)');
      t.check(!(await api(url, 'GET', '/v1/databases')).body.some((d: any) => d.name.startsWith('nodb_')), 'push must not create a database');
    },
  },
  {
    name: 'CLI: push classes and exit codes',
    async run(t) {
      const node = await t.shared();
      const url = node.url;
      const name = t.dbName('cls');
      await createDb(url, name);
      const files = (extra: string, users = COLUMNS_TS, usersIndex?: string) => workdir(t, { 'schema.ts': SCHEMA_TS(extra, usersIndex), 'lib/columns.ts': users });
      await expectExit(t, rsdb(['push', path.join(files(''), 'schema.ts'), '--db', name], { url }), 0, 'initial push');
      const c = client(t, url, name);
      await must(t, c.insert('todos', { ownerId: 'o', title: 'a', createdAt: 1 }), 'insert');
      await must(t, c.insert('todos', { ownerId: 'o', title: 'b', createdAt: 2 }), 'insert');
      const noUsersAge = COLUMNS_TS.replace('  age: t.int().optional(),\n', '');
      const dropCol = path.join(files('', noUsersAge, ''), 'schema.ts');
      const r3 = await expectExit(t, rsdb(['push', dropCol, '--db', name, '--json'], { url }), 3, 'destructive push without --force');
      t.eq(planKey(jsonOut(t, r3, 'destructive push')?.error?.plan), planKey([step('dropColumn', 'users', { column: 'age' }), step('dropIndex', 'users', { index: 'by_age' })]), 'plan in the DESTRUCTIVE_CHANGE error');
      await expectExit(t, rsdb(['push', dropCol, '--db', name, '--dry-run'], { url }), 3, 'destructive dry run without --force');
      await expectExit(t, rsdb(['push', dropCol, '--db', name, '--dry-run', '--force'], { url }), 0, 'destructive dry run with --force');
      t.eq((await dbInfo(url, name))?.version, 3, 'refused and dry-run pushes apply nothing');
      await expectExit(t, rsdb(['push', dropCol, '--db', name, '--force'], { url }), 0, 'destructive push with --force');
      const dupTitles = SCHEMA_TS('', '').replace(".index('u_title', ['title'], { unique: true })", ".index('u_title', ['title'], { unique: true }).index('u_owner', ['ownerId'], { unique: true })");
      await expectExit(t, rsdb(['push', path.join(workdir(t, { 'schema.ts': dupTitles, 'lib/columns.ts': noUsersAge }), 'schema.ts'), '--db', name], { url }), 5, 'unique index over duplicates (CONSTRAINT_VIOLATION)');
      await expectExit(t, rsdb(['push', path.join(files('', noUsersAge.replace('name: t.string()', 'name: t.int()'), ''), 'schema.ts'), '--db', name, '--force'], { url }), 5, 'column type change (INVALID_ARGUMENT)');
      await expectExit(t, rsdb(['push', path.join(files('\n      due: t.int(),', noUsersAge, ''), 'schema.ts'), '--db', name], { url }), 5, 'required column without default (INVALID_ARGUMENT)');
      t.eq((await dbInfo(url, name))?.version, 4, 'rejected pushes apply nothing');
    },
  },
  {
    name: 'migrations: every class of §5.5 through the admin API',
    async run(t) {
      const node = await t.shared();
      const url = node.url;
      const name = t.dbName('mig');
      await createDb(url, name);
      const col = (type: string, nullable: boolean, def?: unknown) => ({ type, nullable, ...(def === undefined ? {} : { default: def }) });
      let schema: any = {
        format: 'rsdb-schema/1',
        tables: {
          items: { columns: { a: col('string', false), b: col('int', true), c: col('bool', false, false), j: col('json', true) }, indexes: [{ name: 'by_b', columns: ['b'], unique: false }] },
          old: { columns: { x: col('int', false) }, indexes: [{ name: 'by_x', columns: ['x'], unique: false }] },
        },
      };
      let version = 0;
      const c = client(t, url, name);
      const apply = async (label: string, next: any, plan: Step[], o: { force?: boolean } = {}) => {
        const dry = await push(url, name, next, { dryRun: true, force: o.force });
        const real = await push(url, name, next, { force: o.force });
        if (real.status !== 200) return void t.fail(`${label}: HTTP ${real.status} ${canonical(real.body).slice(0, 300)}`);
        t.eq(dry, real, `${label}: dry run equals the push`);
        t.eq(planKey(real.body.plan), planKey(plan), `${label}: plan`);
        t.eq({ applied: real.body.applied, version: real.body.version, schemaVersion: real.body.schemaVersion }, { applied: true, version: version + 1, schemaVersion: version + 1 }, `${label}: result`);
        version++;
        schema = next;
        const shown = (await api(url, 'GET', `/v1/databases/${name}/schema`)).body;
        t.eq(schemaKey(shown?.schema), schemaKey(next), `${label}: GET schema`);
        t.eq(shown?.schemaVersion, version, `${label}: schemaVersion`);
      };
      const rejectPush = async (label: string, next: any, status: number, code: string, o: { force?: boolean } = {}) => {
        for (const dryRun of [true, false]) {
          const r = await push(url, name, next, { dryRun, force: o.force });
          t.eq([r.status, errorCode(r)], [status, code], `${label}${dryRun ? ' (dry run)' : ''}`);
        }
        t.eq((await dbInfo(url, name))?.version, version, `${label}: nothing applied`);
      };
      const edit = (f: (s: any) => void) => {
        const s = structuredClone(schema);
        f(s);
        return s;
      };
      const rows = async (select?: string[]) => (await must(t, (select ? c.from('items').select(...select) : c.from('items')).fetch(), 'fetch items')).rows;

      await apply('initial push', schema, [step('createTable', 'items'), step('createTable', 'old')]);
      const empty = await push(url, name, schema);
      t.eq(empty.body && { applied: empty.body.applied, version: empty.body.version, plan: empty.body.plan }, { applied: false, version: null, plan: [] }, 'empty plan');
      t.eq((await dbInfo(url, name))?.version, version, 'an empty plan consumes no version');
      await must(t, c.batch((tx: any) => { tx.insert('items', { id: 'r1', a: 'x', b: 1 }); tx.insert('items', { id: 'r2', a: 'y' }); }), 'insert rows');
      version++;

      await apply('create table', edit((s) => (s.tables.extra = { columns: { v: col('float', true) }, indexes: [] })), [step('createTable', 'extra')]);
      await apply('add optional column', edit((s) => (s.tables.items.columns.d = col('float', true))), [step('addColumn', 'items', { column: 'd' })]);
      await apply('add column with default', edit((s) => (s.tables.items.columns.e = col('string', false, 'z'))), [step('addColumn', 'items', { column: 'e' })]);
      t.eq((await rows(['d', 'e'])), [{ id: 'r1', d: null, e: 'z' }, { id: 'r2', d: null, e: 'z' }], 'existing rows: NULL for an optional column, the default for a defaulted one');
      await apply('change default', edit((s) => (s.tables.items.columns.c.default = true)), [step('setDefault', 'items', { column: 'c' })]);
      t.eq((await rows(['c'])).map((r: any) => r.c), [false, false], 'changing a default leaves existing rows');
      await apply('remove default', edit((s) => delete s.tables.items.columns.e.default), [step('setDefault', 'items', { column: 'e' })]);
      await apply('required → optional', edit((s) => (s.tables.items.columns.a.nullable = true)), [step('makeNullable', 'items', { column: 'a' })]);
      await apply('drop index', edit((s) => (s.tables.items.indexes = [])), [step('dropIndex', 'items', { index: 'by_b' })]);
      await apply('create index', edit((s) => s.tables.items.indexes.push({ name: 'by_e', columns: ['e'], unique: false })), [step('createIndex', 'items', { index: 'by_e' })]);
      await rejectPush('unique index over duplicates', edit((s) => s.tables.items.indexes.push({ name: 'u_e', columns: ['e'], unique: true })), 409, 'CONSTRAINT_VIOLATION');
      await apply('unique index without duplicates (NULLs are distinct)', edit((s) => s.tables.items.indexes.push({ name: 'u_d', columns: ['d'], unique: true })), [step('createIndex', 'items', { index: 'u_d' })]);
      await apply('change index columns', edit((s) => (s.tables.items.indexes.find((i: any) => i.name === 'by_e').columns = ['e', 'd'])), [step('dropIndex', 'items', { index: 'by_e' }), step('createIndex', 'items', { index: 'by_e' })]);
      await apply('change index uniqueness', edit((s) => (s.tables.items.indexes.find((i: any) => i.name === 'u_d').unique = false)), [step('dropIndex', 'items', { index: 'u_d' }), step('createIndex', 'items', { index: 'u_d' })]);

      const required = edit((s) => (s.tables.items.columns.b.nullable = false));
      const r409 = await push(url, name, required);
      t.eq([r409.status, errorCode(r409)], [409, 'DESTRUCTIVE_CHANGE'], 'optional → required without force');
      t.eq(planKey(r409.body?.error?.plan), planKey([step('makeRequired', 'items', { column: 'b' })]), 'plan carried by DESTRUCTIVE_CHANGE');
      t.eq(await push(url, name, required, { dryRun: true }), r409, 'dry run of a refused push returns the same 409');
      await rejectPush('optional → required with NULLs present', required, 409, 'CONSTRAINT_VIOLATION', { force: true });
      await must(t, c.update('items', 'r2', { b: 2 }), 'fill the NULL');
      version++;
      await apply('optional → required', required, [step('makeRequired', 'items', { column: 'b' })], { force: true });

      const dropD = edit((s) => {
        delete s.tables.items.columns.d;
        s.tables.items.indexes = s.tables.items.indexes.filter((i: any) => !i.columns.includes('d'));
      });
      await rejectPush('drop column without force', dropD, 409, 'DESTRUCTIVE_CHANGE');
      await apply('drop column (with its indexes)', dropD, [step('dropColumn', 'items', { column: 'd' }), step('dropIndex', 'items', { index: 'by_e' }), step('dropIndex', 'items', { index: 'u_d' })], { force: true });
      t.eq(Object.keys((await rows())[0] ?? {}).sort(), ['a', 'b', 'c', 'e', 'id', 'j'], 'rows after drop column');
      await apply('drop table (indexes included)', edit((s) => delete s.tables.old), [step('dropTable', 'old')], { force: true });
      await apply('rename = drop + add', edit((s) => {
        s.tables.items.columns.f = s.tables.items.columns.e;
        delete s.tables.items.columns.e;
        s.tables.items.columns.f.nullable = true;
      }), [step('dropColumn', 'items', { column: 'e' }), step('addColumn', 'items', { column: 'f' })], { force: true });
      await apply('several changes in one push', edit((s) => {
        s.tables.items.columns.g = col('int', false, 0);
        s.tables.items.columns.c.default = false;
        s.tables.items.indexes.push({ name: 'by_g', columns: ['g'], unique: false });
        s.tables.more = { columns: { m: col('int', true) }, indexes: [] };
      }), [step('addColumn', 'items', { column: 'g' }), step('setDefault', 'items', { column: 'c' }), step('createIndex', 'items', { index: 'by_g' }), step('createTable', 'more')]);

      await rejectPush('add a required column without default', edit((s) => (s.tables.items.columns.h = col('int', false))), 400, 'INVALID_ARGUMENT', { force: true });
      await rejectPush('change a column type', edit((s) => (s.tables.items.columns.b.type = 'float')), 400, 'INVALID_ARGUMENT', { force: true });
      await rejectPush('index on a json column', edit((s) => s.tables.items.indexes.push({ name: 'by_j', columns: ['j'], unique: false })), 400, 'INVALID_ARGUMENT', { force: true });
      const missing = await push(url, t.dbName('missing'), schema);
      t.eq([missing.status, errorCode(missing)], [404, 'UNKNOWN_DATABASE'], 'push to a missing database');
    },
  },
  {
    name: 'name rules and limits (§5.3)',
    async run(t) {
      const node = await t.shared();
      const url = node.url;
      const name = t.dbName('names');
      await createDb(url, name);
      const one = (tables: Record<string, unknown>) => ({ format: 'rsdb-schema/1', tables });
      const tbl = (columns: Record<string, unknown> = { v: { type: 'int', nullable: true } }, indexes: unknown[] = []) => ({ columns, indexes });
      const n63 = `T${'a'.repeat(62)}`;
      const bad: [string, unknown][] = [
        ['table name starting with a digit', one({ '1abc': tbl() })],
        ['table name with a dash', one({ 'a-b': tbl() })],
        ['table name of 64 characters', one({ [`T${'a'.repeat(63)}`]: tbl() })],
        ['tables differing only in case', one({ Users: tbl(), users: tbl() })],
        ['column named id', one({ a: tbl({ id: { type: 'string', nullable: false } }) })],
        ['columns differing only in case', one({ a: tbl({ Name: { type: 'string', nullable: true }, name: { type: 'string', nullable: true } }) })],
        ['column name with a space', one({ a: tbl({ 'b c': { type: 'string', nullable: true } }) })],
        ['indexes differing only in case', one({ a: tbl(undefined, [{ name: 'ix', columns: ['v'], unique: false }, { name: 'IX', columns: ['v'], unique: false }]) })],
        ['index with no columns', one({ a: tbl(undefined, [{ name: 'ix', columns: [], unique: false }]) })],
        ['index on an unknown column', one({ a: tbl(undefined, [{ name: 'ix', columns: ['nope'], unique: false }]) })],
        ['unknown column type', one({ a: tbl({ v: { type: 'date', nullable: true } }) })],
        ['257 columns', one({ a: tbl(Object.fromEntries(Array.from({ length: 257 }, (_, i) => [`c${i}`, { type: 'int', nullable: true }]))) })],
        ['33 indexes', one({ a: tbl(undefined, Array.from({ length: 33 }, (_, i) => ({ name: `i${i}`, columns: ['v'], unique: false }))) })],
        ['257 tables', one(Object.fromEntries(Array.from({ length: 257 }, (_, i) => [`t${i}`, tbl()])))],
        ['not a schema document', { format: 'rsdb-schema/2', tables: {} }],
      ];
      for (const [what, s] of bad) {
        const r = await push(url, name, s as SchemaIR, { force: true });
        t.eq([r.status, errorCode(r)], [400, 'INVALID_ARGUMENT'], what);
      }
      t.eq((await dbInfo(url, name))?.version, 0, 'rejected schemas apply nothing');
      const good = one({
        [n63]: tbl({ [`c${'x'.repeat(62)}`]: { type: 'int', nullable: true } }, [{ name: `i${'x'.repeat(62)}`, columns: [`c${'x'.repeat(62)}`], unique: false }]),
        Users: tbl({ Name: { type: 'string', nullable: true }, v: { type: 'int', nullable: true } }, [{ name: 'ix', columns: ['v'], unique: false }]),
        other: tbl(undefined, [{ name: 'ix', columns: ['v'], unique: false }]),
        wide: tbl(Object.fromEntries(Array.from({ length: 256 }, (_, i) => [`c${i}`, { type: 'int', nullable: true }])), Array.from({ length: 32 }, (_, i) => ({ name: `i${i}`, columns: [`c${i}`], unique: false }))),
      });
      const ok = await push(url, name, good as SchemaIR);
      t.eq(ok.status, 200, `63-character names, mixed case, index names per table, 256 columns and 32 indexes (${canonical(ok.body).slice(0, 200)})`);
      const c = client(t, url, name);
      await must(t, c.insert('Users', { id: 'u', Name: 'n' }), 'insert into a mixed-case table');
      await readRejects(t, c.from('users').fetch(), 'UNKNOWN_TABLE', 'table lookups are exact-case');
      await readRejects(t, c.from('Users').where({ name: 'n' }).fetch(), 'UNKNOWN_FIELD', 'column lookups are exact-case');
      t.eq((await must(t, c.from('Users').where({ Name: 'n' }).fetch(), 'exact-case fetch')).rows.length, 1, 'exact-case lookup');
    },
  },
  {
    name: 'live subscriptions across schema changes',
    async run(t) {
      const base: SchemaIR = {
        format: 'rsdb-schema/1',
        tables: {
          items: {
            columns: { a: { type: 'string', nullable: false }, b: { type: 'int', nullable: true }, c: { type: 'json', nullable: true } },
            indexes: [],
          },
        },
      };
      const { c, url, db } = await open(t, base, 'live');
      await must(t, c.batch((tx: any) => { tx.insert('items', { id: 'r1', a: 'x', b: 1, c: [1] }); tx.insert('items', { id: 'r2', a: 'y', b: 2 }); }), 'insert');
      const mk = (label: string, q: any) => {
        const rec = new Recorder();
        const errors: any[] = [];
        const sub = q.subscribe(rec.listener);
        sub.onError((e: any) => errors.push(e));
        t.defer(() => sub.unsubscribe());
        return { label, rec, sub, errors };
      };
      const subs = {
        ab: mk('select a where b > 0', c.from('items').where({ b: { gt: 0 } }).select('a')),
        all: mk('all columns', c.from('items')),
        cnt: mk('count where a = x', c.from('items').where({ a: 'x' }).count()),
        ob: mk('orderBy b select a', c.from('items').orderBy('b').select('a').limit(5)),
      };
      for (const s of Object.values(subs)) await must(t, s.sub.ready, `${s.label}: ready`);
      await must(t, withTimeout(c.waitForVersion(c.lastWriteVersion), 6000), 'waitForVersion');
      for (const s of Object.values(subs)) s.rec.take();
      let schema = structuredClone(base);
      const change = async (label: string, f: (s: SchemaIR) => void, expect: Record<keyof typeof subs, 'none' | 'snapshot' | 'SCHEMA_MISMATCH' | 'closed'>, check?: () => void) => {
        f(schema);
        const r = await push(url, db, schema, { force: true });
        if (r.status !== 200) return t.abort(`${label}: push HTTP ${r.status} ${canonical(r.body).slice(0, 200)}`);
        const v = r.body.version as number;
        await must(t, withTimeout(c.waitForVersion(v), 6000, 'waitForVersion'), `${label}: waitForVersion(${v})`);
        const deadline = Date.now() + 2000;
        while (Date.now() < deadline && Object.entries(expect).some(([k, e]) => e === 'SCHEMA_MISMATCH' && !subs[k as keyof typeof subs].sub.closed)) await new Promise((res) => setTimeout(res, 20));
        for (const [k, e] of Object.entries(expect)) {
          const s = subs[k as keyof typeof subs];
          const calls = s.rec.take();
          if (e === 'closed') continue;
          if (e === 'SCHEMA_MISMATCH') {
            t.check(s.sub.closed, `${label}: ${s.label} must be terminated`);
            t.eq(s.errors.map((x: any) => x.code), ['SCHEMA_MISMATCH'], `${label}: ${s.label} onError`);
          } else {
            t.check(!s.sub.closed, `${label}: ${s.label} must stay live`);
            t.eq(calls.length, e === 'snapshot' ? 1 : 0, `${label}: ${s.label} callbacks`);
            if (e === 'snapshot' && calls[0]) t.eq(calls[0].version, v, `${label}: ${s.label} snapshot version`);
            if (s.sub.syncedVersion < v) t.fail(`${label}: ${s.label} syncedVersion ${s.sub.syncedVersion} below the push version ${v}`);
          }
        }
        check?.();
      };
      await change('add a column with a default', (s) => (s.tables.items!.columns.d = { type: 'int', nullable: false, default: 7 }), { ab: 'none', all: 'snapshot', cnt: 'none', ob: 'none' });
      t.eq(subs.all.sub.current?.rows, [{ id: 'r1', a: 'x', b: 1, c: [1], d: 7 }, { id: 'r2', a: 'y', b: 2, c: null, d: 7 }], 'rows gain the new column');
      t.eq(subs.all.rec.calls.at(-1)?.diff && { added: (subs.all.rec.calls.at(-1)!.diff as any).added.length, updated: (subs.all.rec.calls.at(-1)!.diff as any).updated.map((r: any) => r.id), removed: (subs.all.rec.calls.at(-1)!.diff as any).removed }, { added: 0, updated: ['r1', 'r2'], removed: [] }, 'diff of a schema change');
      await change('required → optional on an unreferenced column', (s) => (s.tables.items!.columns.d = { type: 'int', nullable: true, default: 7 }), { ab: 'none', all: 'none', cnt: 'none', ob: 'none' });
      await change('drop an unreferenced column', (s) => delete s.tables.items!.columns.c, { ab: 'none', all: 'snapshot', cnt: 'none', ob: 'none' });
      t.eq(subs.all.sub.current?.rows?.map((r: any) => Object.keys(r).sort().join(',')), ['a,b,d,id', 'a,b,d,id'], 'rows lose the dropped column');
      await change('drop a referenced column', (s) => delete s.tables.items!.columns.b, { ab: 'SCHEMA_MISMATCH', all: 'snapshot', cnt: 'none', ob: 'SCHEMA_MISMATCH' });
      await readRejects(t, c.from('items').where({ b: 1 }).fetch(), 'UNKNOWN_FIELD', 'a new query on the dropped column');
      await change('drop the table', (s) => delete s.tables.items, { ab: 'closed', all: 'SCHEMA_MISMATCH', cnt: 'SCHEMA_MISMATCH', ob: 'closed' });
      const cl = client(t, url, db);
      await readRejects(t, cl.from('items').fetch(), 'UNKNOWN_TABLE', 'a new query on the dropped table');
    },
  },
];

const suite: Suite = {
  id: 'T1',
  level: 'L1',
  weight: 4,
  needsSdk: true,
  cases: () => cases.map((c) => ({ name: c.name, run: c.run })),
};
export default suite;
