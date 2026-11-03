/**
 * Containers and measurements of a benchmark run (SPEC §14.1, §14.2): the `writer` and `reader` networks, server nodes with their
 * CPU and memory limits, generator containers, and the cgroup and interface counters the metrics come from. The controller runs
 * with the host cgroup namespace (`--cgroupns host`), so every container's cgroup is readable under /sys/fs/cgroup.
 */
import fs from 'node:fs';
import { demux, docker, logs } from '../../conformance/lib/docker.ts';
import { Env, type NodeHandle } from '../../conformance/lib/env.ts';

export interface HostOptions {
  run: string;
  /** This controller's container name; generators reach the control channel through it. */
  self: string;
  serverImage: string;
  nodeImage: string;
  /** Host paths mounted into generators (the Docker daemon resolves them, not this container). */
  hostKit: string;
  hostSdk: string;
  hostStub: string;
  /** Host path of the results directory, mounted here at `out`. */
  hostOut: string;
  out: string;
  /** Pin containers to dedicated cpusets (the bench host); otherwise CPU quotas only (run-local). */
  pin: boolean;
  /** Keep the generators' logs under <out>/work after each run (they reach hundreds of MB at full scale). */
  keepLogs?: boolean;
  nodeEnv: Record<string, string>;
  /** Extra environment for generator processes (for example an SDK's debug switch). */
  genEnv?: Record<string, string>;
}

export const CONTROL_PORT = 7800;
export const nowMs = () => Number(process.hrtime.bigint()) / 1e6;
export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface Gen {
  readonly id: string;
  readonly role: string;
  readonly container: string;
  /** Full container id (cgroup lookups). */
  cid: string;
}

export interface GenSpec {
  id: string;
  role: string;
  net: 'writer' | 'reader';
  /** `stub` mounts the no-op SDK instead of the submission's (cli_* baseline, §14.2). */
  sdk?: 'real' | 'stub';
  params: unknown;
  /** Namespaced sysctls, for example B9's `net.ipv4.tcp_rmem`. */
  sysctls?: Record<string, string>;
}

export class Host {
  readonly o: HostOptions;
  readonly writerNet: string;
  readonly readerNet: string;
  readonly workDir: string;
  #seq = 0;
  #nextCpu = 0;
  #gens: Gen[] = [];
  #envs: Env[] = [];

  constructor(o: HostOptions) {
    this.o = o;
    this.writerNet = `rsdb-${o.run}-writer`;
    this.readerNet = `rsdb-${o.run}-reader`;
    this.workDir = `${o.out}/work/${o.run}`;
  }

  /** Creates both client networks (internal, like the conformance runner's) and joins them. */
  async init(): Promise<void> {
    fs.mkdirSync(this.workDir, { recursive: true });
    for (const net of [this.writerNet, this.readerNet]) {
      await docker('POST', '/networks/create', { Name: net, Driver: 'bridge', Internal: true, Labels: { 'rsdb.run': this.o.run } });
      await docker('POST', `/networks/${net}/connect`, { Container: this.o.self });
    }
  }

  #cpus(n: number): Record<string, unknown> {
    if (!this.o.pin) return { NanoCpus: n * 1e9 };
    const first = this.#nextCpu;
    this.#nextCpu += n;
    return { CpusetCpus: `${first}-${first + n - 1}` };
  }

  /** Server nodes on both client networks: single node 4 CPUs and 8 GB, cluster nodes 2 CPUs and 4 GB each, swap off (§14.1). */
  async server(kind: 'single' | 'cluster'): Promise<{ env: Env; nodes: NodeHandle[] }> {
    const cpus = kind === 'single' ? 4 : 2;
    const mem = (kind === 'single' ? 8 : 4) * 2 ** 30;
    const env = new Env({
      image: this.o.serverImage,
      clientNet: this.writerNet,
      extraNets: [this.readerNet],
      run: this.o.run,
      env: this.o.nodeEnv,
      ...(kind === 'cluster' ? { peerDelay: '1ms' } : {}),
      hostConfig: { Memory: mem, MemorySwap: mem },
      nodeHostConfig: () => this.#cpus(cpus),
    });
    this.#envs.push(env);
    const nodes = kind === 'single' ? await env.single() : await env.cluster();
    return { env, nodes };
  }

  /** Starts a generator: `node --expose-gc --import guard.mjs gen.ts`, 2 CPUs, on one client network (§14.1). */
  async gen(spec: GenSpec): Promise<Gen> {
    const container = `rsdb-${this.o.run}-g${++this.#seq}-${spec.id}`;
    fs.writeFileSync(`${this.workDir}/${spec.id}.json`, JSON.stringify({ id: spec.id, role: spec.role, params: spec.params }));
    const net = spec.net === 'writer' ? this.writerNet : this.readerNet;
    await docker('POST', `/containers/create?name=${container}`, {
      Image: this.o.nodeImage,
      Cmd: ['node', '--expose-gc', '--import', '/kit/bench/runner/guard.mjs', '/kit/bench/runner/gen.ts', `/work/${spec.id}.json`],
      Env: [`RSDB_CONTROL=http://${this.o.self}:${CONTROL_PORT}`, `RSDB_GEN_ID=${spec.id}`, ...Object.entries(this.o.genEnv ?? {}).map(([k, v]) => `${k}=${v}`)],
      Labels: { 'rsdb.run': this.o.run, 'rsdb.gen': spec.id },
      HostConfig: {
        Init: true,
        NetworkMode: net,
        Ulimits: [{ Name: 'nofile', Soft: 65536, Hard: 65536 }],
        Mounts: [
          { Type: 'bind', Source: this.o.hostKit, Target: '/kit', ReadOnly: true },
          { Type: 'bind', Source: spec.sdk === 'stub' ? this.o.hostStub : this.o.hostSdk, Target: '/sdk', ReadOnly: true },
          { Type: 'bind', Source: `${this.o.hostOut}/work/${this.o.run}`, Target: '/work' },
        ],
        ...(spec.sysctls ? { Sysctls: spec.sysctls } : {}),
        ...this.#cpus(2),
      },
    });
    await docker('POST', `/containers/${container}/start`);
    const info = await docker<{ Id: string }>('GET', `/containers/${container}/json`);
    const g: Gen = { id: spec.id, role: spec.role, container, cid: info.Id };
    this.#gens.push(g);
    return g;
  }

  /** An error message if one of `gens` exited, for Control.gather. */
  async dead(gens: readonly Gen[]): Promise<string | null> {
    for (const g of gens) {
      const state = await stateOf(g.container);
      if (state && !state.Running) return `generator ${g.id} exited with ${state.ExitCode}${state.OOMKilled ? OOM : ''}\n${await logs(g.container, 40)}`;
    }
    return null;
  }

  /** An error message if one of the server `nodes` is not running (a run that fails reports this instead of its own error). */
  async serverDown(nodes: readonly NodeHandle[]): Promise<string | null> {
    for (const n of nodes) {
      const state = await stateOf(n.container);
      if (state && !state.Running) return `server node ${n.nodeId} exited with ${state.ExitCode}${state.OOMKilled ? OOM : ''}`;
    }
    return null;
  }

  /** Waits for generators to exit; a non-zero exit fails the run. */
  async waitGens(gens: readonly Gen[], timeoutMs = 120_000): Promise<void> {
    for (const g of gens) {
      const r = await docker<{ StatusCode: number }>('POST', `/containers/${g.container}/wait`, undefined, timeoutMs);
      if (r.StatusCode !== 0) throw new Error(`generator ${g.id} exited with ${r.StatusCode}\n${await logs(g.container, 40)}`);
    }
  }

  genLogs(g: Gen, tail = 50) {
    return logs(g.container, tail);
  }

  pause(g: Gen) {
    return docker('POST', `/containers/${g.container}/pause`);
  }
  unpause(g: Gen) {
    return docker('POST', `/containers/${g.container}/unpause`);
  }

  /** Drops the host page cache (B7): a short privileged container writes /proc/sys/vm/drop_caches. */
  async dropCaches(): Promise<void> {
    const name = `rsdb-${this.o.run}-dropcaches-${++this.#seq}`;
    await docker('POST', `/containers/create?name=${name}`, {
      Image: this.o.nodeImage,
      Cmd: ['sh', '-c', 'sync && echo 3 > /proc/sys/vm/drop_caches'],
      Labels: { 'rsdb.run': this.o.run },
      HostConfig: { Privileged: true, NetworkMode: 'none' },
    });
    await docker('POST', `/containers/${name}/start`);
    const r = await docker<{ StatusCode: number }>('POST', `/containers/${name}/wait`);
    const out = await logs(name, 20);
    await docker('DELETE', `/containers/${name}?force=1`).catch(() => {});
    if (r.StatusCode !== 0) throw new Error(`drop_caches failed: ${out}`);
  }

  /** Removes this run's generators, servers and (unless kept) logs; the networks stay for the next scenario. */
  async reset(): Promise<void> {
    for (const g of this.#gens.splice(0)) await docker('DELETE', `/containers/${g.container}?force=1&v=1`).catch(() => {});
    for (const e of this.#envs.splice(0)) await e.dispose();
    this.#nextCpu = 0;
    if (!this.o.keepLogs) for (const f of fs.readdirSync(this.workDir)) fs.rmSync(`${this.workDir}/${f}`, { force: true });
  }

  /** Removes the (empty unless kept) work directory at the end of the run. */
  dispose(): void {
    if (!this.o.keepLogs) fs.rmSync(this.workDir, { recursive: true, force: true });
  }
}

// ─────────────────────────────── cgroups ───────────────────────────────

const cgroupDirs = new Map<string, string>();

const OOM = " (killed by the kernel's out-of-memory killer: the container's limit, or the Docker VM's memory if that is smaller)";

async function stateOf(container: string) {
  const info = await docker<{ State: { Running: boolean; ExitCode: number; OOMKilled: boolean } }>('GET', `/containers/${container}/json`).catch(() => null);
  return info?.State ?? null;
}

export async function cgroupOf(container: string): Promise<string> {
  const info = await docker<{ Id: string }>('GET', `/containers/${container}/json`);
  const known = cgroupDirs.get(info.Id);
  if (known) return known;
  for (const dir of [`/sys/fs/cgroup/docker/${info.Id}`, `/sys/fs/cgroup/system.slice/docker-${info.Id}.scope`]) {
    if (fs.existsSync(`${dir}/memory.stat`)) {
      cgroupDirs.set(info.Id, dir);
      return dir;
    }
  }
  throw new Error(`no cgroup for ${container}: the bench controller needs --cgroupns host and cgroup v2`);
}

export function memoryStat(dir: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const line of fs.readFileSync(`${dir}/memory.stat`, 'utf8').split('\n')) {
    const [k, v] = line.split(' ');
    if (k && v) out[k] = Number(v);
  }
  return out;
}

/** §14.2 `mem`: anon + shmem + sock + kernel + file_mapped + file_dirty, in bytes. */
export function serverMem(dir: string): number {
  const s = memoryStat(dir);
  const kernel = s.kernel ?? (s.kernel_stack ?? 0) + (s.pagetables ?? 0) + (s.sec_pagetables ?? 0) + (s.percpu ?? 0) + (s.slab ?? 0) + (s.vmalloc ?? 0);
  return (s.anon ?? 0) + (s.shmem ?? 0) + (s.sock ?? 0) + kernel + (s.file_mapped ?? 0) + (s.file_dirty ?? 0);
}

export const anonOf = (dir: string) => memoryStat(dir).anon ?? 0;

/** cgroup CPU time in seconds. */
export function cpuSeconds(dir: string): number {
  const m = /usage_usec (\d+)/.exec(fs.readFileSync(`${dir}/cpu.stat`, 'utf8'));
  return m ? Number(m[1]) / 1e6 : 0;
}

/** Samples the summed server memory of `dirs` every 50 ms (§14.2). */
export class MemSampler {
  readonly samples: { t: number; bytes: number }[] = [];
  #timer: NodeJS.Timeout | null = null;
  #dirs: string[];

  constructor(dirs: string[]) {
    this.#dirs = dirs;
  }
  start(): this {
    const take = () => {
      try {
        this.samples.push({ t: nowMs(), bytes: this.#dirs.reduce((a, d) => a + serverMem(d), 0) });
      } catch {
        // a node that is down (B11) has no cgroup for a moment
      }
    };
    take();
    this.#timer = setInterval(take, 50);
    return this;
  }
  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }
  #in(t0: number, t1: number) {
    return this.samples.filter((s) => s.t >= t0 && s.t <= t1).map((s) => s.bytes);
  }
  median(t0: number, t1: number): number {
    const v = this.#in(t0, t1).sort((a, b) => a - b);
    return v.length ? v[Math.floor(v.length / 2)]! : NaN;
  }
  max(t0: number, t1: number): number {
    const v = this.#in(t0, t1);
    return v.length ? Math.max(...v) : NaN;
  }
  /** The latest sample at or before t. */
  at(t: number): number {
    let best = NaN;
    for (const s of this.samples) if (s.t <= t) best = s.bytes;
    return best;
  }
}

// ─────────────────────────────── interfaces ───────────────────────────────

export async function exec(container: string, script: string): Promise<string> {
  const { Id } = await docker<{ Id: string }>('POST', `/containers/${container}/exec`, { AttachStdout: true, AttachStderr: true, Cmd: ['sh', '-c', script] });
  return demux(await docker<Buffer>('POST', `/exec/${Id}/start`, { Detach: false, Tty: false }));
}

/** Byte counters of each network a container is attached to, keyed by network name. */
export async function netCounters(container: string): Promise<Record<string, { rx: number; tx: number }>> {
  const info = await docker<{ NetworkSettings: { Networks: Record<string, { MacAddress: string }> } }>('GET', `/containers/${container}/json`);
  const byMac = new Map(Object.entries(info.NetworkSettings.Networks).map(([net, n]) => [n.MacAddress.toLowerCase(), net]));
  const out: Record<string, { rx: number; tx: number }> = {};
  const text = await exec(container, 'for d in /sys/class/net/*; do echo "$(cat $d/address) $(cat $d/statistics/rx_bytes) $(cat $d/statistics/tx_bytes)"; done');
  for (const line of text.trim().split('\n')) {
    const [mac, rx, tx] = line.trim().split(/\s+/);
    const net = byMac.get((mac ?? '').toLowerCase());
    if (net) out[net] = { rx: Number(rx), tx: Number(tx) };
  }
  return out;
}

/** Sum over containers of one network's counter. */
export async function netSum(containers: readonly string[], net: string, dir: 'rx' | 'tx'): Promise<number> {
  let sum = 0;
  for (const c of containers) sum += (await netCounters(c))[net]?.[dir] ?? 0;
  return sum;
}
