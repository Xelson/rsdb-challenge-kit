/**
 * T3 cross-check (SPEC §13.4): compares the per-query answers of two submissions run with the same seeds against the voter.
 *
 *   node kit/conformance/crosscheck.ts <results-A> <results-B> [--out crosscheck.json]
 *
 * For each query where a submission disagrees with the voter: if the other submission agrees with the voter or has no answer,
 * it is a failure; if both submissions agree with each other against the voter, or all three differ, it goes to triage.
 * Prints the rescored T3 points of both and writes the triage list for the judge.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { T3Data } from './suites/t3-queries.ts';

type T3File = { results: { name: string; pass: boolean; data?: T3Data }[] };

const [dirA, dirB] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (!dirA || !dirB) {
  console.error('usage: crosscheck.ts <results-A> <results-B> [--out file]');
  process.exit(2);
}
const outArg = process.argv.indexOf('--out');
const out = outArg > 0 ? process.argv[outArg + 1]! : 'crosscheck.json';
const load = (dir: string) => JSON.parse(fs.readFileSync(path.join(dir, 'T3.json'), 'utf8')) as T3File;
const A = load(dirA);
const B = load(dirB);

const bySeed = (f: T3File) => new Map(f.results.filter((r) => r.data).map((r) => [r.data!.seed, r]));
const seedsA = bySeed(A);
const seedsB = bySeed(B);

interface Triage {
  seed: number;
  query: number;
  reason: 'both-agree-against-voter' | 'all-differ';
  signatureA?: string;
  signatureB?: string;
}
const confirmed = { A: new Set<string>(), B: new Set<string>() };
const triage: Triage[] = [];
const voterMismatch: number[] = [];

for (const [seed, ra] of seedsA) {
  const rb = seedsB.get(seed);
  const a = ra.data!;
  const b = rb?.data;
  for (const [side, mine, other] of [['A', a, b], ['B', b, a]] as const) {
    if (!mine) continue;
    for (const [k, sig] of Object.entries(mine.failing ?? {})) {
      const i = Number(k);
      const v = mine.voter[i];
      const theirs = other?.answers[i];
      if (other && other.voter[i] !== v) voterMismatch.push(seed);
      if (theirs === undefined || theirs === v) confirmed[side].add(sig);
      else if (side === 'A') {
        triage.push({ seed, query: i, reason: theirs === mine.answers[i] ? 'both-agree-against-voter' : 'all-differ', signatureA: sig, signatureB: other?.failing?.[i] });
      }
    }
  }
}
// Seeds that crashed without answers count as one signature of their own, as in the T3 score.
for (const [side, f] of [['A', A], ['B', B]] as const) {
  for (const r of f.results) if (!r.pass && !(r.data?.signatures?.length)) confirmed[side].add(`case:${r.name}`);
}

const points = (n: number) => 6 * Math.max(0, 1 - n / 10);
const report = {
  A: { dir: dirA, signatures: [...confirmed.A].sort(), points: points(confirmed.A.size) },
  B: { dir: dirB, signatures: [...confirmed.B].sort(), points: points(confirmed.B.size) },
  triage,
  voterMismatchSeeds: [...new Set(voterMismatch)],
};
fs.writeFileSync(out, JSON.stringify(report, null, 1));
for (const side of ['A', 'B'] as const) console.log(`${side}: ${report[side].signatures.length} confirmed signature(s), T3 ${report[side].points.toFixed(2)} / 6`);
console.log(`triage: ${triage.length} quer${triage.length === 1 ? 'y' : 'ies'} (${new Set(triage.map((t) => t.signatureA)).size} signature(s)) → ${out}`);
if (report.voterMismatchSeeds.length) console.log(`warning: the voter answered differently in the two runs for seeds ${report.voterMismatchSeeds.join(', ')}; the runs are not comparable`);
