/**
 * Conformance runner (SPEC §13). Runs inside the kit Node image with the Docker socket, the built SDK at /sdk and the kit at /kit;
 * start it with kit/conformance/run.sh.
 *
 *   node /kit/conformance/run.ts [--suite T1,D2,...] [--level L1|L2|L3] [--scale public|full] [--seeds T3=1,2,3;T4=7] [--out /out]
 *
 * --level runs the suites of that level and below (default: every suite).
 *
 * Environment: RSDB_SERVER_IMAGE (image under test), RSDB_SELF (this container's name), RSDB_RUN (run id),
 * RSDB_NODE_ENV (JSON object of extra node environment, for example RSDB_LOG).
 */
import fs from 'node:fs';
import { docker } from './lib/docker.ts';
import { loadSdk, type Sdk } from './lib/sdk.ts';
import { runSuite, type RunOptions, type Scale, type Suite } from './lib/suite.ts';
import t1 from './suites/t1-schema-cli.ts';
import t2 from './suites/t2-mutations.ts';
import t3 from './suites/t3-queries.ts';
import t4 from './suites/t4-reactive.ts';
import t5 from './suites/t5-diffs.ts';
import t6 from './suites/t6-faults.ts';
import t7 from './suites/t7-types.ts';
import d1 from './suites/d1-formation.ts';
import d2 from './suites/d2-consistency.ts';
import d3 from './suites/d3-follower-writes.ts';
import d4 from './suites/d4-follower-crash.ts';
import d5 from './suites/d5-many-databases.ts';
import f1 from './suites/f1-leader-crash.ts';
import f2 from './suites/f2-leader-partition.ts';
import f3 from './suites/f3-rolling-restart.ts';
import f4 from './suites/f4-sdk-failover.ts';

export const SUITES: Suite[] = [t1, t2, t3, t4, t5, t6, t7, d1, d2, d3, d4, d5, f1, f2, f3, f4];

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i]!;
  if (!a.startsWith('--')) throw new Error(`unexpected argument ${a}`);
  args.set(a.slice(2), process.argv[++i] ?? '');
}
const level = (args.get('level') ?? 'L3').toUpperCase();
if (!['L1', 'L2', 'L3'].includes(level)) throw new Error(`unknown level ${level}`);
const wanted = (args.get('suite') ?? SUITES.filter((s) => s.level <= level).map((s) => s.id).join(',')).split(',').map((s) => s.trim().toUpperCase());
const unknown = wanted.filter((id) => !SUITES.some((s) => s.id === id));
if (unknown.length) throw new Error(`unknown suite(s): ${unknown.join(', ')}`);
const seeds: Record<string, number[]> = {};
for (const part of (args.get('seeds') ?? '').split(';').filter(Boolean)) {
  const [id, list] = part.split('=');
  seeds[id!.trim().toUpperCase()] = list!.split(',').map(Number);
}

const run = process.env.RSDB_RUN ?? `r${Date.now().toString(36)}`;
const self = process.env.RSDB_SELF;
const clientNet = `rsdb-${run}-client`;
const opts: RunOptions = {
  run,
  image: process.env.RSDB_SERVER_IMAGE ?? 'rsdb-server:local',
  clientNet,
  scale: (args.get('scale') ?? 'public') as Scale,
  out: args.get('out') ?? '/out',
  seeds,
  nodeEnv: JSON.parse(process.env.RSDB_NODE_ENV || '{}'),
  log: (line) => console.log(line),
};

async function cleanup() {
  const filter = encodeURIComponent(JSON.stringify({ label: [`rsdb.run=${run}`] }));
  const containers = await docker<{ Id: string }[]>('GET', `/containers/json?all=1&filters=${filter}`).catch(() => []);
  for (const c of containers) await docker('DELETE', `/containers/${c.Id}?force=1&v=1`).catch(() => {});
  if (self) await docker('POST', `/networks/${clientNet}/disconnect`, { Container: self, Force: true }).catch(() => {});
  const networks = await docker<{ Id: string }[]>('GET', `/networks?filters=${filter}`).catch(() => []);
  for (const n of networks) await docker('DELETE', `/networks/${n.Id}`).catch(() => {});
  const volumes = await docker<{ Volumes: { Name: string }[] | null }>('GET', `/volumes?filters=${filter}`).catch(() => ({ Volumes: [] }));
  for (const v of volumes.Volumes ?? []) await docker('DELETE', `/volumes/${v.Name}?force=1`).catch(() => {});
}

async function main() {
  if (!self) throw new Error('RSDB_SELF must name this container (kit/conformance/run.sh sets it)');
  // Internal (no gateway): a node cut from the peer network has no other route to its peers (§11.2 partition model).
  await docker('POST', '/networks/create', { Name: clientNet, Driver: 'bridge', Internal: true, Labels: { 'rsdb.run': run } });
  await docker('POST', `/networks/${clientNet}/connect`, { Container: self });
  let sdk: Sdk | null = null;
  let sdkError: string | null = null;
  try {
    sdk = await loadSdk();
  } catch (e) {
    sdkError = String((e as Error)?.message ?? e);
    opts.log(`SDK failed to load: ${sdkError}`);
  }
  const summary: { suite: string; level: string; points: number; weight: number; passed: number; total: number }[] = [];
  for (const suite of SUITES.filter((s) => wanted.includes(s.id))) {
    const { results, points } = await runSuite(suite, opts, sdk, sdkError);
    summary.push({ suite: suite.id, level: suite.level, points, weight: suite.weight, passed: results.filter((r) => r.pass).length, total: results.length });
  }
  fs.mkdirSync(opts.out, { recursive: true });
  fs.writeFileSync(`${opts.out}/summary.json`, JSON.stringify({ run, image: opts.image, scale: opts.scale, summary }, null, 1));
  console.log('\nsuite  level  passed      points');
  for (const s of summary) console.log(`${s.suite.padEnd(6)} ${s.level.padEnd(6)} ${`${s.passed}/${s.total}`.padEnd(11)} ${s.points.toFixed(2)} / ${s.weight}`);
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
