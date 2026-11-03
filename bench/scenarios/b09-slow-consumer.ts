/**
 * B9 Slow consumer (SPEC §14.4): 100 × 100 normal subscriptions plus one process with 100 hot subscriptions and a 64 KiB receive
 * buffer. 1,000 inserts/s on the hot channels and 1,000/s at random; 30 s into the window the slow process is stopped for 60 s
 * (cgroup freezer: like SIGSTOP, the kernel keeps receiving into the socket buffer), then resumed.
 */
import { netCounters, nowMs, sleep } from '../lib/host.ts';
import { lower, MB, MS, type Scenario } from '../lib/scenario.ts';
import { message } from '../lib/workload.ts';
import { connsOf } from './common.ts';

const HOT = 100;
const RUN_MS = 30_000;
const STOP_MS = 60_000;
const CONVERGE_MS = 30_000;

export default {
  id: 'B9', title: 'Slow consumer', pts: 4, level: 'L1',
  metrics: [lower('mem_growth', 0.3, 'MB', 16), MS('lat_p99_stopped', 0.25), MS('convergence', 0.25), lower('slow_bytes', 0.2, 'B', 64 * 1024)],
  async run(r) {
    await r.server('single');
    const db = await r.database('b9');
    const normal = r.conns(100) * 100;
    const channels = HOT + normal;
    await r.preload(db, 'messages', channels * 10, (i) => message(i, { channels }));
    const limit = r.V.limit(10, 'B9');
    const dir = r.V.dir('desc', 'B9');
    const specs = Array.from({ length: normal }, (_, k) => ['ch', HOT + k, limit, dir]);
    const readers = await r.readers([
      ...connsOf(specs, 100).map((s) => ({ db, specs: s })),
      { db, specs: Array.from({ length: HOT }, (_, k) => ['ch', k, limit, dir]), slow: true },
    ], { slowSysctls: { 'net.ipv4.tcp_rmem': '4096 65536 65536' } });
    const slow = readers.slow!;
    const hot = await r.writers([db], r.rate(1000), { kind: 'insertMessage', hot: Array.from({ length: HOT }, (_, k) => k) });
    const random = await r.writers([db], r.rate(1000), { kind: 'insertMessage', base: 0, channels });
    let stopAt = 0;
    let contAt = 0;
    let rxStop = 0;
    const rx: [number, number][] = [];
    const m = await r.standard(readers, [hot, random], {
      windowMs: RUN_MS + STOP_MS + CONVERGE_MS,
      latExclude: [slow],
      latRange: ({ winStart }) => [winStart + RUN_MS, winStart + RUN_MS + STOP_MS],
      duringWindow: async ({ winStart }) => {
        await sleep(winStart + RUN_MS - nowMs());
        rxStop = (await netCounters(slow.container))[r.host.readerNet]!.rx;
        await r.host.pause(slow);
        stopAt = nowMs();
        await sleep(winStart + RUN_MS + STOP_MS - nowMs());
        await r.host.unpause(slow);
        contAt = nowMs();
        while (nowMs() < contAt + CONVERGE_MS) {
          rx.push([nowMs(), (await netCounters(slow.container))[r.host.readerNet]!.rx]);
          await sleep(250);
        }
      },
    });
    const s = r.sampler!;
    m.extra.memGrowthMB = (s.max(stopAt, contAt) - s.at(stopAt)) / MB;
    m.extra.latP99Stopped = m.latIn.quantile(0.99);
    // convergence: SIGCONT → every hot subscription synced past the latest version acknowledged at SIGCONT
    const vStar = Math.max(0, ...r.writes().filter((w) => w.r === 'a' && w.settled <= contAt).map((w) => w.version!));
    const synced = (r.finals.get(slow.id)?.synced ?? []) as [number, number][];
    const at = synced.find(([t, v]) => t >= contAt && v >= vStar)?.[0];
    m.extra.convergenceMs = at === undefined ? NaN : at - contAt;
    if (!(m.extra.convergenceMs <= CONVERGE_MS)) r.fail(`gate: the slow client did not sync past v${vStar} within 30 s of SIGCONT`);
    if (m.extra.memGrowthMB > 256) r.fail(`gate: server memory grew ${m.extra.memGrowthMB.toFixed(0)} MB while the slow client was stopped (limit 256 MB)`);
    const rxAt = at === undefined ? undefined : (rx.find(([t]) => t >= at) ?? rx[rx.length - 1]);
    m.extra.slowBytes = rxAt ? rxAt[1] - rxStop : NaN;
    return m;
  },
  values: (m) => ({ mem_growth: m.extra.memGrowthMB!, lat_p99_stopped: m.extra.latP99Stopped!, convergence: m.extra.convergenceMs!, slow_bytes: m.extra.slowBytes! }),
} satisfies Scenario;
