/**
 * Benchmark runner (SPEC §14). Runs inside the kit Node image with the Docker socket and the host cgroup namespace; start it with
 * kit/bench/run-local.sh (development, §14.6).
 *
 *   node /kit/bench/run.ts [--scale 0.25] [--only B2,B3] [--reps 1] [--variant <seed>] [--pin] [--warmup 10] [--window 60]
 *                          [--keep-logs] [--out /out]
 *
 * --pin gives every container dedicated cpusets (the bench host, §14.1); without it containers get CPU quotas only. --warmup and
 * --window shorten the phases for quick local checks; scored runs use the defaults. Prints raw metrics per scenario as a table and
 * as JSON, and writes the JSON to <out>/bench-<run>.json. No points (§14.6): see bench/score.ts.
 *
 * Environment: RSDB_RUN, RSDB_SELF (this container), RSDB_SERVER_IMAGE, RSDB_HOST_KIT / RSDB_HOST_SDK / RSDB_HOST_OUT (host paths of
 * /kit, /sdk and /out, mounted into generator containers), RSDB_NODE_ENV (JSON of extra server environment), RSDB_GEN_ENV (JSON of
 * extra generator environment).
 */
import fs from 'node:fs';
import { docker } from '../conformance/lib/docker.ts';
import { loadSdk } from '../conformance/lib/sdk.ts';
import { Control } from './lib/control.ts';
import { CONTROL_PORT, Host } from './lib/host.ts';
import { type Measured, Run, type Scenario } from './lib/scenario.ts';
import { Variant } from './lib/workload.ts';
import { SCENARIOS } from './scenarios/index.ts';

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i]!;
  if (!a.startsWith('--')) throw new Error(`unexpected argument ${a}`);
  if (a === '--pin' || a === '--keep-logs') args.set(a.slice(2), '1');
  else args.set(a.slice(2), process.argv[++i] ?? '');
}
const scale = Number(args.get('scale') ?? 0.25);
const reps = Number(args.get('reps') ?? 1);
const only = (args.get('only') ?? SCENARIOS.map((s) => s.id).join(',')).split(',').map((s) => s.trim().toUpperCase());
const unknown = only.filter((id) => !SCENARIOS.some((s) => s.id === id));
if (unknown.length) throw new Error(`unknown scenario(s): ${unknown.join(', ')}`);
const variant = new Variant(args.has('variant') ? Number(args.get('variant')) : null);
const warmupMs = Number(args.get('warmup') ?? 10) * 1000;
const windowMs = Number(args.get('window') ?? 60) * 1000;
const out = args.get('out') ?? '/out';

const run = process.env.RSDB_RUN ?? `b${Date.now().toString(36)}`;
const self = process.env.RSDB_SELF;
const kitVersion = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const host = new Host({
  run,
  self: self ?? '',
  serverImage: process.env.RSDB_SERVER_IMAGE ?? 'rsdb-server:local',
  nodeImage: process.env.RSDB_NODE_IMAGE ?? `rsdb-kit/node:${kitVersion}`,
  hostKit: process.env.RSDB_HOST_KIT ?? '',
  hostSdk: process.env.RSDB_HOST_SDK ?? '',
  hostStub: `${process.env.RSDB_HOST_KIT}/bench/stub`,
  hostOut: process.env.RSDB_HOST_OUT ?? '',
  out,
  pin: args.has('pin'),
  keepLogs: args.has('keep-logs'),
  nodeEnv: JSON.parse(process.env.RSDB_NODE_ENV || '{}'),
  genEnv: JSON.parse(process.env.RSDB_GEN_ENV || '{}'),
});
const ctl = new Control();
const log = (line: string) => console.log(line);

interface RepResult {
  values: Record<string, number>;
  report: Record<string, number>;
  invalid: string[];
  notes: string[];
  seconds: number;
}
interface ScenarioResult {
  id: string;
  title: string;
  pts: number;
  valid: boolean;
  invalid: string[];
  /** Median over the repetitions (§14.1). */
  values: Record<string, number>;
  units: Record<string, string>;
  reps: RepResult[];
}

const median = (xs: number[]) => {
  const v = xs.filter((x) => !Number.isNaN(x)).sort((a, b) => a - b);
  return v.length ? v[Math.floor((v.length - 1) / 2)]! : NaN;
};

async function execute(sc: Scenario, mode: 'main' | 'control' | 'stub', rep: number, sdk: Awaited<ReturnType<typeof loadSdk>>): Promise<{ m: Measured | null; r: Run }> {
  const r = new Run(host, ctl, sdk, { scale, variant, warmupMs, windowMs, seed: `${sc.id}:${rep}`, mode, log }, { faultFree: !sc.faults });
  try {
    return { m: await sc.run(r), r };
  } catch (e) {
    const down = await host.serverDown(r.nodes);
    r.fail(down ? `${mode} run failed: ${down}; then ${(e as Error)?.message ?? e}` : `${mode} run failed: ${(e as Error)?.stack ?? e}`);
    return { m: null, r };
  } finally {
    await r.exit().catch(() => {});
    await host.reset();
  }
}

/** Runs one mode, retrying up to twice when a writer process fell behind its schedule (§14.1). */
async function attempt(sc: Scenario, mode: 'main' | 'control' | 'stub', rep: number, sdk: Awaited<ReturnType<typeof loadSdk>>) {
  for (let k = 1; ; k++) {
    log(`  ${sc.id} rep ${rep} ${mode}${k > 1 ? ` (attempt ${k})` : ''}`);
    const res = await execute(sc, mode, rep, sdk);
    if (!res.r.behind || mode === 'stub') return res;
    if (k === 3) {
      res.r.fail('writers fell more than 1 % behind their schedule in three attempts (§14.1 schedule health)');
      return res;
    }
  }
}

async function scenario(sc: Scenario, sdk: Awaited<ReturnType<typeof loadSdk>>): Promise<ScenarioResult> {
  const results: RepResult[] = [];
  for (let rep = 1; rep <= reps; rep++) {
    const t0 = Date.now();
    const main = await attempt(sc, 'main', rep, sdk);
    const control = sc.control && main.m ? await attempt(sc, 'control', rep, sdk) : null;
    const stub = sc.cli && main.m ? await attempt(sc, 'stub', rep, sdk) : null;
    const invalid = [...main.r.invalid, ...(control?.r.invalid ?? []).map((x) => `control: ${x}`)];
    if (stub && !stub.m) invalid.push(...stub.r.invalid.map((x) => `stub: ${x}`));
    const values = main.m ? sc.values(main.m, control?.m ?? null, stub?.m ?? null) : {};
    const report: Record<string, number> = main.m
      ? { pairs: main.m.pairs, writes: main.m.writes, lat_samples: main.m.lat.n, lat_max: main.m.lat.maxUs / 1000, ack_p99: main.m.ack.quantile(0.99), ...main.m.extra, ...(sc.report?.(main.m) ?? {}) }
      : {};
    results.push({ values, report, invalid, notes: main.r.notes, seconds: (Date.now() - t0) / 1000 });
    log(`  ${sc.id} rep ${rep}: ${invalid.length ? 'INVALID' : 'valid'} in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
    for (const x of invalid.slice(0, 8)) log(`    ✗ ${x.split('\n')[0]}`);
  }
  const invalid = results.flatMap((r) => r.invalid);
  const values: Record<string, number> = {};
  for (const m of sc.metrics) values[m.key] = median(results.map((r) => r.values[m.key] ?? NaN));
  return { id: sc.id, title: sc.title, pts: sc.pts, valid: invalid.length === 0, invalid, values, units: Object.fromEntries(sc.metrics.map((m) => [m.key, m.unit])), reps: results };
}

const fmt = (x: number) => (Number.isNaN(x) ? '—' : Math.abs(x) >= 100 ? x.toFixed(0) : Math.abs(x) >= 1 ? x.toFixed(2) : x.toPrecision(3));

async function cleanup() {
  ctl.close();
  host.dispose();
  const filter = encodeURIComponent(JSON.stringify({ label: [`rsdb.run=${run}`] }));
  const containers = await docker<{ Id: string }[]>('GET', `/containers/json?all=1&filters=${filter}`).catch(() => []);
  for (const c of containers) await docker('DELETE', `/containers/${c.Id}?force=1&v=1`).catch(() => {});
  const networks = await docker<{ Id: string; Name: string }[]>('GET', `/networks?filters=${filter}`).catch(() => []);
  for (const n of networks) {
    if (self) await docker('POST', `/networks/${n.Id}/disconnect`, { Container: self, Force: true }).catch(() => {});
    await docker('DELETE', `/networks/${n.Id}`).catch(() => {});
  }
  const volumes = await docker<{ Volumes: { Name: string }[] | null }>('GET', `/volumes?filters=${filter}`).catch(() => ({ Volumes: [] }));
  for (const v of volumes.Volumes ?? []) await docker('DELETE', `/volumes/${v.Name}?force=1`).catch(() => {});
}

async function main() {
  if (!self || !process.env.RSDB_HOST_KIT || !process.env.RSDB_HOST_SDK || !process.env.RSDB_HOST_OUT) {
    throw new Error('RSDB_SELF and RSDB_HOST_{KIT,SDK,OUT} must be set (kit/bench/run-local.sh sets them)');
  }
  await host.init();
  await ctl.listen(CONTROL_PORT);
  const sdk = await loadSdk();
  log(`bench run ${run}: scale ${scale}, ${reps} repetition(s), warm-up ${warmupMs / 1000} s, window ${windowMs / 1000} s${variant.seed !== null ? `, variant ${variant.seed} (factor ${variant.factor.toFixed(3)})` : ''}${host.o.pin ? ', pinned' : ''}`);
  const results: ScenarioResult[] = [];
  for (const sc of SCENARIOS.filter((s) => only.includes(s.id))) {
    log(`${sc.id} ${sc.title}`);
    results.push(await scenario(sc, sdk));
  }
  console.log('\nscenario               status   metric                value       unit');
  for (const r of results) {
    const keys = Object.keys(r.values);
    keys.forEach((k, i) => {
      const head = i === 0 ? `${`${r.id} ${r.title}`.padEnd(22)} ${(r.valid ? 'valid' : 'INVALID').padEnd(8)}` : ' '.repeat(31);
      console.log(`${head} ${k.padEnd(21)} ${fmt(r.values[k]!).padStart(10)}  ${r.units[k]}`);
    });
  }
  const json = { run, scale, reps, variant: variant.seed, factor: variant.factor, warmupMs, windowMs, pinned: host.o.pin, results };
  fs.writeFileSync(`${out}/bench-${run}.json`, JSON.stringify(json, null, 1));
  console.log(`\n${JSON.stringify({ run, scale, results: results.map((r) => ({ id: r.id, valid: r.valid, values: r.values })) })}`);
  console.log(`\nfull results: bench-${run}.json`);
}

const stop = async (code: number) => {
  await cleanup();
  process.exit(code);
};
process.on('SIGINT', () => void stop(130));
process.on('SIGTERM', () => void stop(143));
main().then(() => stop(0), async (e) => {
  console.error(e?.stack ?? e);
  await stop(1);
});
