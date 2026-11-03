/**
 * Suites, cases and scoring (SPEC §13.5). A case is a hand-written case or one seed. A case fails on any safety failure; a case
 * whose only failures are time bounds is rerun up to twice and passes if a rerun passes.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { SchemaIR } from '@rsdb/client';
import { freshDb } from './admin.ts';
import { Env, type NodeHandle } from './env.ts';
import { Rng } from './rng.ts';
import type { Sdk } from './sdk.ts';
import { canonical } from '../voter/voter.ts';

export type Level = 'L1' | 'L2' | 'L3';
export type Scale = 'public' | 'full';

export interface RunOptions {
  run: string;
  image: string;
  clientNet: string;
  scale: Scale;
  out: string;
  /** Seeds per suite id; suites without an entry use their public seeds. */
  seeds: Record<string, number[]>;
  /** Extra environment for server nodes. */
  nodeEnv: Record<string, string>;
  log: (line: string) => void;
}

export interface Case {
  name: string;
  seed?: number;
  /** Cases that start their own nodes; others share one single-node server per suite. */
  fresh?: boolean;
  run: (t: CaseCtx) => Promise<void>;
}

export interface Suite {
  id: string;
  level: Level;
  weight: number;
  needsSdk: boolean;
  publicSeeds?: number[];
  cases(seeds: number[], scale: Scale): Case[];
  /** Custom score from the case results (T3). */
  score?(results: CaseResult[]): number;
}

export interface CaseResult {
  suite: string;
  name: string;
  seed: number | null;
  pass: boolean;
  attempts: number;
  ms: number;
  failures: string[];
  timeFailures: string[];
  data?: unknown;
}

const MAX_FAILURES = 25;
class Abort extends Error {}

export class CaseCtx {
  readonly name: string;
  readonly opts: RunOptions;
  readonly sdk: Sdk;
  readonly rng: Rng;
  readonly failures: string[] = [];
  readonly timeFailures: string[] = [];
  /** Free-form result data saved with the case (T3 answers, signatures). */
  data: unknown = undefined;
  #shared: () => Promise<NodeHandle>;
  #envs: Env[] = [];
  #cleanup: (() => unknown)[] = [];
  #dbSeq = 0;

  constructor(name: string, opts: RunOptions, sdk: Sdk, rng: Rng, shared: () => Promise<NodeHandle>) {
    this.name = name;
    this.opts = opts;
    this.sdk = sdk;
    this.rng = rng;
    this.#shared = shared;
  }

  log(line: string): void {
    this.opts.log(`  [${this.name}] ${line}`);
  }
  /** A safety failure: the case fails. */
  fail(message: string): void {
    if (this.failures.length < MAX_FAILURES) this.failures.push(message);
    else if (this.failures.length === MAX_FAILURES) this.failures.push('… further failures suppressed');
  }
  /** A failure of a time bound only (§13.5): the case is rerun. */
  failTime(message: string): void {
    if (this.timeFailures.length < MAX_FAILURES) this.timeFailures.push(message);
  }
  check(cond: unknown, message: string): boolean {
    if (!cond) this.fail(message);
    return !!cond;
  }
  /** Deep equality with JSON semantics, object key order ignored. */
  eq(actual: unknown, expected: unknown, message: string): boolean {
    const a = canonical(actual);
    const e = canonical(expected);
    if (a !== e) this.fail(`${message}: expected ${clip(e)}, got ${clip(a)}`);
    return a === e;
  }
  /** Stops the case after a failure that makes the rest meaningless. */
  abort(message: string): never {
    this.fail(message);
    throw new Abort(message);
  }

  /** The suite's shared single-node server. */
  shared(): Promise<NodeHandle> {
    return this.#shared();
  }
  /** Fresh nodes for this case, removed when it ends. */
  async env(kind: 'single' | 'cluster', extra: Partial<ConstructorParameters<typeof Env>[0]> = {}): Promise<{ env: Env; nodes: NodeHandle[] }> {
    const env = new Env({ image: this.opts.image, clientNet: this.opts.clientNet, run: this.opts.run, env: this.opts.nodeEnv, ...extra });
    this.#envs.push(env);
    const nodes = kind === 'single' ? await env.single() : await env.cluster();
    return { env, nodes };
  }
  /** A unique database name for this case. */
  dbName(label = 'db'): string {
    return `${label}_${this.name.replace(/[^a-z0-9]+/gi, '_').toLowerCase().slice(0, 30)}_${++this.#dbSeq}_${this.rng.int(1e6)}`.slice(0, 63);
  }
  /** Creates a database with a schema on a node; returns its name and the version of the push. */
  async database(url: string, schema: SchemaIR, label?: string): Promise<{ name: string; version: number }> {
    const name = this.dbName(label);
    return { name, version: await freshDb(url, name, schema) };
  }
  defer(fn: () => unknown): void {
    this.#cleanup.push(fn);
  }
  async dispose(): Promise<void> {
    for (const fn of this.#cleanup.splice(0).reverse()) await Promise.resolve().then(fn).catch(() => {});
    for (const env of this.#envs.splice(0)) await env.dispose();
  }
}

const clip = (s: string, n = 300) => (s.length > n ? `${s.slice(0, n)}…(${s.length} chars)` : s);

export async function runSuite(suite: Suite, opts: RunOptions, sdk: Sdk | null, sdkError: string | null): Promise<{ results: CaseResult[]; points: number }> {
  const seeds = opts.seeds[suite.id] ?? suite.publicSeeds ?? [];
  const cases = suite.cases(seeds, opts.scale);
  const results: CaseResult[] = [];
  let sharedEnv: Env | null = null;
  let sharedNode: Promise<NodeHandle> | null = null;
  const shared = () => {
    if (!sharedNode) {
      sharedEnv = new Env({ image: opts.image, clientNet: opts.clientNet, run: opts.run, env: opts.nodeEnv });
      sharedNode = sharedEnv.single().then((n) => n[0]!);
    }
    return sharedNode;
  };
  opts.log(`${suite.id}: ${cases.length} case(s)`);
  for (const c of cases) {
    const t0 = Date.now();
    let attempts = 0;
    let t: CaseCtx;
    for (;;) {
      attempts++;
      t = new CaseCtx(c.name, opts, sdk as Sdk, new Rng(`${suite.id}:${c.name}:${c.seed ?? 0}`), shared);
      if (suite.needsSdk && !sdk) t.fail(`SDK could not be loaded: ${sdkError}`);
      else {
        try {
          await c.run(t);
        } catch (e) {
          if (!(e instanceof Abort)) t.fail(`case crashed: ${(e as Error)?.stack ?? e}`);
        } finally {
          await t.dispose();
        }
      }
      if (t.failures.length > 0 || t.timeFailures.length === 0 || attempts === 3) break;
      opts.log(`  ${c.name}: time bound missed (${t.timeFailures[0]}), rerun ${attempts}`);
    }
    const r: CaseResult = {
      suite: suite.id, name: c.name, seed: c.seed ?? null, attempts, ms: Date.now() - t0,
      pass: t.failures.length === 0 && t.timeFailures.length === 0, failures: t.failures, timeFailures: t.timeFailures, data: t.data,
    };
    results.push(r);
    opts.log(`  ${r.pass ? 'PASS' : 'FAIL'} ${c.name} (${(r.ms / 1000).toFixed(1)} s)${r.pass ? '' : `: ${[...r.failures, ...r.timeFailures].slice(0, 3).join(' | ')}`}`);
  }
  if (sharedEnv) await (sharedEnv as Env).dispose();
  const points = suite.score ? suite.score(results) : results.length ? (suite.weight * results.filter((r) => r.pass).length) / results.length : 0;
  fs.mkdirSync(opts.out, { recursive: true });
  fs.writeFileSync(path.join(opts.out, `${suite.id}.json`), JSON.stringify({ suite: suite.id, level: suite.level, weight: suite.weight, points, results }, null, 1));
  opts.log(`${suite.id}: ${results.filter((r) => r.pass).length}/${results.length} passed, ${points.toFixed(2)} of ${suite.weight} points`);
  return { results, points };
}
