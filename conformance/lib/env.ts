/**
 * Server nodes under test (SPEC §4, §11): one container per node, its data dir on a named volume, SDK traffic on the client network
 * (which the judge container is attached to), peer traffic on a separate network with fixed addresses so that partitions can cut it
 * without touching clients (§11.2 partition model). Both networks are internal: with a gateway, a node detached from the peer
 * network would still reach its peers through the host's routing.
 */
import { docker, ensureImage, logs } from './docker.ts';

export interface NodeHandle {
  readonly nodeId: string;
  readonly container: string;
  /** SDK and admin URL on the client network. */
  readonly url: string;
  readonly peerIp: string | null;
}

export interface EnvOptions {
  image: string;
  /** Docker network shared with the judge container. */
  clientNet: string;
  run: string;
  /** Extra environment for every node (for example RSDB_LOG, or defect injection in a mock). */
  env?: Record<string, string>;
  /** netem delay on peer links, for example "1ms" (§14.1). */
  peerDelay?: string;
  /** Docker HostConfig additions (cgroup limits, cpusets) used by the benchmark runner. */
  hostConfig?: Record<string, unknown>;
  /** Per-node HostConfig additions, for example a distinct cpuset per node. */
  nodeHostConfig?: (nodeId: string) => Record<string, unknown>;
  /** Further networks every node joins under its container name (the benchmark's separate `reader` network, §14.1). */
  extraNets?: string[];
}

const PEER_SUBNET = '10.77.0.0/24';
const peerIp = (i: number) => `10.77.0.${11 + i}`;
/** Container and network names are unique across every Env of a run. */
let seq = 0;

export class Env {
  readonly nodes: NodeHandle[] = [];
  #o: EnvOptions;
  #peerNet: string | null = null;
  #volumes: string[] = [];

  constructor(o: EnvOptions) {
    this.#o = o;
  }

  /** The cluster's peer network (byte counters of §14.2 `peer`); null for a single node. */
  get peerNetName(): string | null {
    return this.#peerNet;
  }

  /** Starts one single-node server and waits for /healthz (§4.2: 5 s, plus slack for container start). */
  async single(): Promise<NodeHandle[]> {
    await ensureImage(this.#o.image);
    const n = await this.#create('n1', null, {});
    await this.#start(n);
    await this.waitHealthy([n], 10_000);
    return [n];
  }

  /** Starts a 3-node cluster with identical --peers and waits for /healthz on all (§4.2: 15 s). */
  async cluster(): Promise<NodeHandle[]> {
    await ensureImage(this.#o.image);
    const name = `rsdb-${this.#o.run}-peer${++seq}`;
    await docker('POST', '/networks/create', {
      Name: name, Driver: 'bridge', Internal: true, Labels: { 'rsdb.run': this.#o.run },
      IPAM: { Config: [{ Subnet: PEER_SUBNET }] },
    });
    this.#peerNet = name;
    const ids = ['n1', 'n2', 'n3'];
    const peers = ids.map((id, i) => `${id}=${peerIp(i)}:7701`).join(',');
    const nodes = [];
    for (const [i, id] of ids.entries()) {
      nodes.push(await this.#create(id, peerIp(i), {
        RSDB_PEERS: peers, RSDB_PEER_SUBNET_PREFIX: '10.77.0.', ...(this.#o.peerDelay ? { RSDB_PEER_DELAY: this.#o.peerDelay } : {}),
      }));
    }
    await Promise.all(nodes.map((n) => this.#start(n)));
    await this.waitHealthy(nodes, 20_000);
    return nodes;
  }

  async #create(nodeId: string, ip: string | null, env: Record<string, string>): Promise<NodeHandle> {
    const container = `rsdb-${this.#o.run}-${nodeId}-${++seq}`;
    const volume = `${container}-data`;
    await docker('POST', '/volumes/create', { Name: volume, Labels: { 'rsdb.run': this.#o.run } });
    this.#volumes.push(volume);
    const allEnv = { RSDB_NODE_ID: nodeId, ...this.#o.env, ...env };
    const net = ip ? this.#peerNet! : this.#o.clientNet;
    await docker('POST', `/containers/create?name=${container}`, {
      Image: this.#o.image,
      Env: Object.entries(allEnv).map(([k, v]) => `${k}=${v}`),
      Labels: { 'rsdb.run': this.#o.run, 'rsdb.node': nodeId },
      HostConfig: {
        Mounts: [{ Type: 'volume', Source: volume, Target: '/data' }],
        CapAdd: ['NET_ADMIN'],
        Ulimits: [{ Name: 'nofile', Soft: 65536, Hard: 65536 }],
        NetworkMode: net,
        ...this.#o.hostConfig,
        ...this.#o.nodeHostConfig?.(nodeId),
      },
      NetworkingConfig: { EndpointsConfig: { [net]: { Aliases: [container], ...(ip ? { IPAMConfig: { IPv4Address: ip } } : {}) } } },
    });
    if (ip) await docker('POST', `/networks/${this.#o.clientNet}/connect`, { Container: container, EndpointConfig: { Aliases: [container] } });
    for (const extra of this.#o.extraNets ?? []) await docker('POST', `/networks/${extra}/connect`, { Container: container, EndpointConfig: { Aliases: [container] } });
    const node = { nodeId, container, url: `http://${container}:7700`, peerIp: ip };
    this.nodes.push(node);
    return node;
  }

  #start(n: NodeHandle) {
    return docker('POST', `/containers/${n.container}/start`);
  }

  async waitHealthy(nodes: NodeHandle[], timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (const n of nodes) {
      for (;;) {
        const ok = await fetch(`${n.url}/healthz`, { signal: AbortSignal.timeout(1000) }).then((r) => r.ok, () => false);
        if (ok) break;
        if (Date.now() > deadline) throw new Error(`${n.nodeId} not healthy within ${timeoutMs} ms\n${await logs(n.container, 50)}`);
        await sleep(100);
      }
    }
  }

  /** SIGKILL (§4.2). */
  kill(n: NodeHandle) {
    return docker('POST', `/containers/${n.container}/kill?signal=KILL`);
  }
  /** SIGTERM; the node must exit within 5 s (§4.2). Resolves with the time it took. */
  async terminate(n: NodeHandle): Promise<number> {
    const t0 = Date.now();
    await docker('POST', `/containers/${n.container}/stop?t=10`, undefined, 30_000);
    return Date.now() - t0;
  }
  /** Restarts a stopped node on the same data dir. */
  async restart(n: NodeHandle, healthTimeoutMs = 15_000): Promise<void> {
    await this.#start(n);
    await this.waitHealthy([n], healthTimeoutMs);
  }
  /** Cuts the node's traffic to its peers; clients still reach it (§11.2). */
  partition(n: NodeHandle) {
    return docker('POST', `/networks/${this.#peerNet}/disconnect`, { Container: n.container, Force: true });
  }
  heal(n: NodeHandle) {
    return docker('POST', `/networks/${this.#peerNet}/connect`, { Container: n.container, EndpointConfig: { IPAMConfig: { IPv4Address: n.peerIp } } });
  }
  async running(n: NodeHandle): Promise<boolean> {
    const info = await docker<{ State: { Running: boolean } }>('GET', `/containers/${n.container}/json`);
    return info.State.Running;
  }
  logs(n: NodeHandle, tail = 200) {
    return logs(n.container, tail);
  }

  async dispose(): Promise<void> {
    for (const n of this.nodes.splice(0)) await docker('DELETE', `/containers/${n.container}?force=1&v=1`).catch(() => {});
    for (const v of this.#volumes.splice(0)) await docker('DELETE', `/volumes/${v}?force=1`).catch(() => {});
    if (this.#peerNet) await docker('DELETE', `/networks/${this.#peerNet}`).catch(() => {});
    this.#peerNet = null;
  }
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
