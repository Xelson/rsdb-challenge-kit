/**
 * B6 Subscription churn (SPEC §14.4): 5,000 subscribes/s over 200 connections with exponential lifetimes (mean 1 s), 80 % top-20
 * rows and 20 % count queries, under 500 updates/s; then everything is unsubscribed and the server idles 30 s.
 */
import fs from 'node:fs';
import type { HistJson } from '../lib/hist.ts';
import { cgroupOf, cpuSeconds, type Gen, nowMs, sleep } from '../lib/host.ts';
import { cpuUs, emptyMeasured, lower, MB, MS, per, type Scenario } from '../lib/scenario.ts';
import { physicalQuery, type QSpec } from '../lib/workload.ts';
import { b3Data } from './common.ts';

export default {
  id: 'B6', title: 'Subscription churn', pts: 5, level: 'L1', control: true,
  metrics: [MS('ttfs_p50', 0.2), MS('ttfs_p99', 0.3), lower('cpu_per_subscribe', 0.2, 'us', 1), lower('retained_mem', 0.3, 'MB', 16)],
  async run(r) {
    const m = emptyMeasured();
    const [node] = await r.server('single');
    const db = await r.database('b6');
    const { users, teams } = await b3Data(r, db);
    const limit = r.V.limit(20, 'B6');
    const dir = r.V.dir('desc', 'B6');
    const specs: QSpec[] = [];
    for (let k = 0; k < teams; k++) specs.push(['team', k, limit, dir], ['team', k, limit, dir], ['team', k, limit, dir], ['team', k, limit, dir], ['teamCount', k]);
    const writers = await r.writers([db], r.rate(500), { kind: 'updateScore', users });
    const rate = r.rate(5000);
    const conns = r.conns(200);
    const procs = r.cfg.mode === 'control' ? 0 : Math.max(1, Math.ceil(rate / 1000));
    const churners: Gen[] = [];
    for (let p = 0; p < procs; p++) {
      churners.push(await r.gen('churn', 'reader', { db: db.name, urls: r.urls, conns: Math.max(1, Math.round(conns / procs)), variant: r.V.seed, specs, audit: false, seed: `${r.cfg.seed}:c${p}` }));
    }
    // audit: 2 % of the subscribes, from a process the server cannot tell apart from the others (§14.2 check 2)
    const auditor = procs ? await r.gen('churn', 'reader', { db: db.name, urls: r.urls, conns: Math.max(1, Math.round(conns * 0.02)), variant: r.V.seed, specs, audit: true, seed: `${r.cfg.seed}:ca` }) : null;
    const all = [...churners, ...(auditor ? [auditor] : [])];
    await r.collect([...all, ...writers.gens], 120_000);
    const memBefore = await r.memNow();
    const dir0 = await cgroupOf(node!.container);
    const start = nowMs() + 1000;
    const winStart = start + r.cfg.warmupMs;
    const winEnd = winStart + r.cfg.windowMs;
    r.send(writers.gens, (g) => ({ op: 'run', start, end: winEnd, rate: writers.perProc, phase: (writers.gens.indexOf(g) * 1000) / writers.rate, winStart, winEnd }));
    const perProc = rate / procs;
    r.send(churners, (g) => ({ op: 'run', start, end: winEnd, rate: perProc * 0.98, phase: (churners.indexOf(g) * 1000) / rate, winStart, winEnd, meanLifeMs: 1000 }));
    if (auditor) r.send([auditor], { op: 'run', start, end: winEnd, rate: rate * 0.02, phase: 0, winStart, winEnd, meanLifeMs: 1000 });
    await sleep(winStart - nowMs());
    const c0 = cpuSeconds(dir0);
    await sleep(winEnd - nowMs());
    m.cpu = cpuSeconds(dir0) - c0;
    const written = await r.collect(writers.gens, 120_000);
    for (const w of written.values()) {
      m.ack.merge(w.ack as HistJson);
      if (w.rejected + w.unknown + w.pending > 0.001 * w.sent) r.fail(`check 4: ${w.rejected + w.unknown + w.pending} of ${w.sent} mutations failed`);
      if (w.unknown + w.pending) r.fail(`check 5: ${w.unknown + w.pending} mutations with outcome unknown`);
      if (w.maxDelayMs > 0.01 * r.cfg.windowMs) r.behind = true;
    }
    if (!procs) {
      m.writes = r.writes().filter((w) => w.r === 'a' && w.sched >= winStart && w.sched < winEnd).length;
      return m;
    }
    const churned = await r.collect(all, 120_000);
    let subscribes = 0;
    let failed = 0;
    for (const [id, c] of churned) {
      if (id !== auditor?.id) m.ttfs.merge(c.ttfs as HistJson);
      subscribes += c.inWindow;
      failed += c.failed;
      if (c.maxDelayMs > 0.01 * r.cfg.windowMs) r.behind = true;
    }
    m.extra.subscribes = subscribes;
    if (failed > 0.001 * (subscribes || 1)) r.fail(`check 4: ${failed} of ${subscribes} subscribes failed: ${[...churned.values()].flatMap((c) => c.errorSamples ?? []).slice(0, 3).join('; ')}`);
    const ended = await r.call(all, { op: 'unsubscribe' });
    for (const [id, e] of ended) {
      if (e.violations) r.fail(`check 1: ${e.violations} listener calls without a higher version in ${id}`);
      if (e.failures.length) r.fail(`check 2: audit failures in ${id}: ${e.failures.slice(0, 5).join(' | ')}`);
    }
    const lastUnsub = nowMs();
    await sleep(1000);
    const st = await fetch(`${node!.url}/v1/stats`).then((x) => x.json()) as { subscriptions: number };
    if (st.subscriptions !== 0) r.fail(`gate: /v1/stats.subscriptions is ${st.subscriptions} after unsubscribing everything, expected 0`);
    await sleep(Math.max(0, lastUnsub + 30_000 - nowMs()));
    m.extra.retainedMB = ((await r.memNow()) - memBefore) / MB;
    // R1 at every audit delivery
    const buf = fs.existsSync(`${r.host.workDir}/${auditor!.id}.audit.bin`) ? fs.readFileSync(`${r.host.workDir}/${auditor!.id}.audit.bin`) : Buffer.alloc(0);
    const deliveries = [];
    for (let o = 0; o + 40 <= buf.length; o += 40) deliveries.push({ ir: physicalQuery(specs[buf.readUInt32LE(o)]!, r.V), version: buf.readUInt32LE(o + 4), hash: buf.toString('hex', o + 8, o + 40) });
    m.extra.auditDeliveries = deliveries.length;
    r.checkDeliveries(db, deliveries);
    return m;
  },
  values: (m, c) => ({ ttfs_p50: m.ttfs.quantile(0.5), ttfs_p99: m.ttfs.quantile(0.99), cpu_per_subscribe: per(cpuUs(m, c), m.extra.subscribes ?? 0), retained_mem: m.extra.retainedMB ?? NaN }),
} satisfies Scenario;
