/**
 * Performance points (SPEC §14.5) from the result files of the submissions' scored runs (bench/run.ts JSON, same variant):
 *
 *   node /kit/bench/score.ts A=/out/bench-<run a>.json B=/out/bench-<run b>.json
 *
 * Per metric: every value is raised to its floor, `best` is the best value among submissions whose scenario is valid, lower-is-better
 * metrics score r = best / own and higher-is-better r = own / best; if the two submissions' ranges over the repetitions overlap,
 * both get r = 1. Scenario points are Pts × Σ weight × r; an invalid scenario scores 0. Also prints P from each repetition alone.
 */
import fs from 'node:fs';
import type { MetricDef } from './lib/scenario.ts';
import { SCENARIOS } from './scenarios/index.ts';

interface Result {
  id: string;
  valid: boolean;
  values: Record<string, number>;
  reps: { values: Record<string, number> }[];
}

const inputs = process.argv.slice(2).map((a) => {
  const [name, path] = a.includes('=') ? a.split('=', 2) as [string, string] : [a, a];
  const json = JSON.parse(fs.readFileSync(path, 'utf8'));
  return { name, variant: json.variant as number | null, results: new Map<string, Result>((json.results as Result[]).map((r) => [r.id, r])) };
});
if (inputs.length < 1) throw new Error('usage: score.ts NAME=results.json [NAME=results.json ...]');
if (new Set(inputs.map((i) => i.variant)).size > 1) throw new Error('the result files come from different variants');

const floored = (m: MetricDef, x: number) => (Number.isNaN(x) ? NaN : m.better === 'lower' ? Math.max(x, m.floor) : x);

/** r per submission for one metric, from one value each (and ranges for the noise rule when given). */
function ratios(m: MetricDef, own: (number | null)[], ranges: ([number, number] | null)[] | null): number[] {
  const vals = own.map((x) => (x === null || Number.isNaN(x) ? null : floored(m, x)));
  const valid = vals.filter((x): x is number => x !== null);
  if (!valid.length) return own.map(() => 0);
  const best = m.better === 'lower' ? Math.min(...valid) : Math.max(...valid);
  const rs = vals.map((x) => (x === null ? 0 : m.better === 'lower' ? (x === 0 ? 1 : best / x) : best === 0 ? 1 : x / best));
  if (ranges && ranges.length === 2 && ranges[0] && ranges[1] && vals[0] !== null && vals[1] !== null) {
    const [a, b] = ranges.map((r) => r!.map((x) => floored(m, x))) as [number[], number[]];
    if (a[0]! <= b[1]! && b[0]! <= a[1]!) return [1, 1];
  }
  return rs;
}

const totals = inputs.map(() => 0);
const repTotals: number[][] = inputs.map(() => []);
const nReps = Math.max(...inputs.flatMap((i) => [...i.results.values()].map((r) => r.reps.length)));
console.log(`scenario               ${inputs.map((i) => i.name.padStart(10)).join(' ')}   (of)`);
for (const sc of SCENARIOS) {
  const res = inputs.map((i) => i.results.get(sc.id) ?? null);
  if (res.every((r) => !r)) continue;
  const pts = inputs.map(() => 0);
  for (const m of sc.metrics) {
    const own = res.map((r) => (r && r.valid ? r.values[m.key] ?? NaN : null));
    const ranges = res.map((r) => {
      if (!r || !r.valid) return null;
      const xs = r.reps.map((x) => x.values[m.key]!).filter((x) => !Number.isNaN(x));
      return xs.length ? [Math.min(...xs), Math.max(...xs)] as [number, number] : null;
    });
    ratios(m, own, ranges).forEach((r, k) => (pts[k]! += sc.pts * m.weight * r));
  }
  pts.forEach((p, k) => (totals[k]! += p));
  for (let rep = 0; rep < nReps; rep++) {
    const per = inputs.map(() => 0);
    for (const m of sc.metrics) {
      const own = res.map((r) => (r && r.valid && r.reps[rep] ? r.reps[rep]!.values[m.key] ?? NaN : null));
      ratios(m, own, null).forEach((r, k) => (per[k]! += sc.pts * m.weight * r));
    }
    per.forEach((p, k) => ((repTotals[k]![rep] ??= 0), (repTotals[k]![rep]! += p)));
  }
  const flags = res.map((r) => (!r ? ' (missing)' : r.valid ? '' : ' (invalid)'));
  console.log(`${`${sc.id} ${sc.title}`.padEnd(22)} ${pts.map((p, k) => `${p.toFixed(2)}${flags[k]}`.padStart(10)).join(' ')}   ${sc.pts}`);
}
const max = SCENARIOS.reduce((a, s) => a + s.pts, 0);
console.log(`${'P (performance)'.padEnd(22)} ${totals.map((t) => t.toFixed(2).padStart(10)).join(' ')}   ${max}`);
for (let rep = 0; rep < nReps; rep++) console.log(`${`  repetition ${rep + 1} alone`.padEnd(22)} ${repTotals.map((t) => (t[rep] ?? 0).toFixed(2).padStart(10)).join(' ')}`);
