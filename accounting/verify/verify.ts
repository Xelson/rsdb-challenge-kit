/**
 * Token accounting verifier (SPEC §17).
 *
 *   node kit/accounting/verify/verify.ts <results-dir> [--calibration] [--cost-cap <usd>] [--transcripts <dir>]
 *
 * Reads, under <results-dir> (or <results-dir>/calibration with --calibration):
 *   usage-events.jsonl, usage.json, gateway/*.jsonl, provider/*.json
 * Writes verify.txt and verify.json next to them. Exit status: 0 pass, 1 fail, 2 usage error.
 *
 * What it checks: schemas; usage.json totals against the events; declared components; prices for every model;
 * the gateway match of SPEC §17.2 point 4; transcript request ids; the provider report against the gateway (§17.6);
 * cost per event from prices.json (§17.7) and the moment the cost cap was crossed.
 */
import { readdirSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020Module from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';

const Ajv2020 = Ajv2020Module.default;
const addFormats = addFormatsModule.default;

const CLASSES = ['input_tokens', 'cache_read_tokens', 'cache_write_tokens', 'output_tokens'] as const;
type TokenClass = (typeof CLASSES)[number];
type Tokens = Record<TokenClass, number>;

interface UsageEvent extends Tokens {
  ts: string;
  component: string;
  agent_id: string;
  provider: string;
  model: string;
  requests: number;
  status: 'ok' | 'error';
  cache_write_1h_tokens?: number | null;
  server_tool_uses?: Record<string, number>;
  speed?: string | null;
  service_tier?: string | null;
  region?: string | null;
  account?: string | null;
  request_id?: string | null;
  request_ids?: string[];
  source: string;
  line: number;
}

interface GatewayRecord extends Tokens {
  ts: string;
  account: string;
  request_id: string;
  provider: string;
  model: string;
  status: number;
  speed?: string | null;
  service_tier?: string | null;
  region?: string | null;
  cache_write_1h_tokens?: number | null;
  server_tool_uses?: Record<string, number>;
  where: string;
}

interface ProviderReport {
  provider: string;
  account: string;
  by_model: Record<string, Tokens & { server_tool_uses?: Record<string, number> }>;
  where: string;
}

type Rates = { input: number; cache_write_5m: number; cache_write_1h: number; cache_read: number; output: number };
interface ModelPrice {
  rates?: Rates;
  tiers?: { max_prompt_tokens?: number; rates: Rates }[];
  speed?: Record<string, Rates>;
  regions: string[];
}
interface ProviderPrices {
  default_region: string;
  region_multipliers: Record<string, number>;
  default_service_tier: string;
  service_tier_multipliers: Record<string, number>;
  server_tools: Record<string, number>;
  models: Record<string, ModelPrice>;
}
interface Prices {
  fetched: string;
  providers: Record<string, ProviderPrices>;
}

interface Summary {
  harness: { name: string; components: string[] };
  status: string;
  window: { kickoff: string };
  verification: {
    level: 'V1' | 'V2';
    reconciliation?: { source: string; account: string; reported: Partial<Tokens>; unmatched_requests: number }[];
  };
  totals: Tokens & { requests: number };
  by_model: Record<string, Tokens & { requests: number }>;
  by_component: Record<string, Tokens & { requests: number }>;
}

// ── Arguments ──────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const resultsDir = args.find((a, i) => !a.startsWith('--') && !['--cost-cap', '--transcripts'].includes(args[i - 1] ?? ''));
if (!resultsDir) {
  console.error('usage: verify.ts <results-dir> [--calibration] [--cost-cap <usd>] [--transcripts <dir>]');
  process.exit(2);
}
const calibration = args.includes('--calibration');
const costCap = flag('--cost-cap') !== undefined ? Number(flag('--cost-cap')) : undefined;
const transcriptsDir = flag('--transcripts');
const base = resolve(resultsDir, calibration ? 'calibration' : '.');
const kitAccounting = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ── Findings ───────────────────────────────────────────────────────────────

type Severity = 'FAIL' | 'WARN' | 'INFO';
const findings: { severity: Severity; check: string; detail: string }[] = [];
const note = (severity: Severity, check: string, detail: string): void => {
  findings.push({ severity, check, detail });
};
const MAX_LISTED = 20;
const listSome = (items: string[]): string =>
  items.slice(0, MAX_LISTED).join('; ') + (items.length > MAX_LISTED ? `; … ${items.length - MAX_LISTED} more` : '');

// ── Loading and schemas ────────────────────────────────────────────────────

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const schema = (file: string) => ajv.compile(JSON.parse(readFileSync(join(kitAccounting, file), 'utf8')));
const validEvent = schema('usage-event.schema.json');
const validSummary = schema('usage.schema.json');
const validGateway = schema('gateway-record.schema.json');
const validProvider = schema('provider-report.schema.json');

function readJsonl(file: string): { value: unknown; line: number }[] {
  const out: { value: unknown; line: number }[] = [];
  readFileSync(file, 'utf8')
    .split('\n')
    .forEach((text, i) => {
      if (text.trim() === '') return;
      try {
        out.push({ value: JSON.parse(text), line: i + 1 });
      } catch {
        note('FAIL', 'schema', `${file}:${i + 1}: not valid JSON`);
      }
    });
  return out;
}

const filesIn = (dir: string, ext: string): string[] =>
  existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(ext)).sort().map((f) => join(dir, f)) : [];

const eventsFile = join(base, 'usage-events.jsonl');
const summaryFile = join(base, 'usage.json');
for (const f of [eventsFile, summaryFile]) {
  if (!existsSync(f)) {
    console.error(`missing ${f}`);
    process.exit(2);
  }
}

const events: UsageEvent[] = [];
for (const { value, line } of readJsonl(eventsFile)) {
  if (!validEvent(value)) {
    note('FAIL', 'schema', `usage-events.jsonl:${line}: ${ajv.errorsText(validEvent.errors)}`);
    continue;
  }
  events.push({ ...(value as Omit<UsageEvent, 'line'>), line });
}

const summary = JSON.parse(readFileSync(summaryFile, 'utf8')) as Summary;
if (!validSummary(summary)) note('FAIL', 'schema', `usage.json: ${ajv.errorsText(validSummary.errors)}`);

const gateway: GatewayRecord[] = [];
for (const file of filesIn(join(base, 'gateway'), '.jsonl')) {
  for (const { value, line } of readJsonl(file)) {
    if (!validGateway(value)) {
      note('FAIL', 'schema', `${file}:${line}: ${ajv.errorsText(validGateway.errors)}`);
      continue;
    }
    gateway.push({ ...(value as Omit<GatewayRecord, 'where'>), where: `${file}:${line}` });
  }
}

const reports: ProviderReport[] = [];
for (const file of filesIn(join(base, 'provider'), '.json')) {
  const value = JSON.parse(readFileSync(file, 'utf8'));
  if (!validProvider(value)) note('FAIL', 'schema', `${file}: ${ajv.errorsText(validProvider.errors)}`);
  else reports.push({ ...(value as Omit<ProviderReport, 'where'>), where: file });
}

const prices = JSON.parse(readFileSync(join(kitAccounting, 'prices.json'), 'utf8')) as Prices;

// ── Helpers ────────────────────────────────────────────────────────────────

const zero = (): Tokens & { requests: number } => ({
  requests: 0,
  input_tokens: 0,
  cache_read_tokens: 0,
  cache_write_tokens: 0,
  output_tokens: 0,
});
const add = (into: Tokens & { requests: number }, t: Tokens, requests: number): void => {
  into.requests += requests;
  for (const c of CLASSES) into[c] += t[c];
};
const sameTokens = (a: Tokens, b: Partial<Tokens>): boolean => CLASSES.every((c) => a[c] === (b[c] ?? 0));
const fmtTokens = (t: Tokens): string => CLASSES.map((c) => `${c}=${t[c]}`).join(' ');
const ms = (iso: string): number => Date.parse(iso);

// ── 1. usage.json totals equal the sum of events ───────────────────────────

{
  const totals = zero();
  const byModel = new Map<string, ReturnType<typeof zero>>();
  const byComponent = new Map<string, ReturnType<typeof zero>>();
  for (const e of events) {
    add(totals, e, e.requests);
    add(byModel.get(e.model) ?? byModel.set(e.model, zero()).get(e.model)!, e, e.requests);
    add(byComponent.get(e.component) ?? byComponent.set(e.component, zero()).get(e.component)!, e, e.requests);
  }
  const compare = (label: string, expected: ReturnType<typeof zero>, got: Partial<Tokens & { requests: number }> | undefined) => {
    if (!got) return note('FAIL', 'totals', `${label}: missing in usage.json`);
    if (!sameTokens(expected, got) || expected.requests !== got.requests) {
      note('FAIL', 'totals', `${label}: events sum to requests=${expected.requests} ${fmtTokens(expected)}; usage.json has requests=${got.requests} ${fmtTokens(got as Tokens)}`);
    }
  };
  compare('totals', totals, summary.totals);
  for (const [m, t] of byModel) compare(`by_model[${m}]`, t, summary.by_model?.[m]);
  for (const [c, t] of byComponent) compare(`by_component[${c}]`, t, summary.by_component?.[c]);
  for (const m of Object.keys(summary.by_model ?? {})) if (!byModel.has(m)) note('FAIL', 'totals', `by_model[${m}] has no events`);
  for (const c of Object.keys(summary.by_component ?? {})) if (!byComponent.has(c)) note('FAIL', 'totals', `by_component[${c}] has no events`);
}

// ── 2. Components ──────────────────────────────────────────────────────────

{
  const declared = new Set(summary.harness?.components ?? []);
  const undeclared = [...new Set(events.map((e) => e.component))].filter((c) => !declared.has(c));
  if (undeclared.length) note('FAIL', 'components', `components not declared in harness.components: ${undeclared.join(', ')}`);
  if (calibration) {
    const silent = [...declared].filter((c) => !events.some((e) => e.component === c && e.output_tokens > 0));
    if (silent.length) note('FAIL', 'components', `declared components without an event with output_tokens > 0: ${silent.join(', ')}`);
  }
}

// ── 3. Gateway matching (SPEC §17.2 point 4) ───────────────────────────────

const matched = new Map<UsageEvent, GatewayRecord[]>();
let unmatchedGateway: GatewayRecord[] = [];
{
  const levelV1 = summary.verification?.level === 'V1';
  if (gateway.length === 0) {
    if (levelV1 || calibration) note('FAIL', 'gateway', `no gateway log in ${join(base, 'gateway')}`);
  } else {
    const byId = new Map<string, GatewayRecord>();
    for (const r of gateway) {
      if (byId.has(r.request_id)) note('FAIL', 'gateway', `duplicate request_id ${r.request_id} in the gateway log (${r.where})`);
      byId.set(r.request_id, r);
    }
    const owner = new Map<string, UsageEvent>();
    const phantoms: string[] = [];
    for (const e of events) {
      const ids = e.request_id ? [e.request_id] : (e.request_ids ?? []);
      for (const id of ids) {
        if (owner.has(id)) note('FAIL', 'gateway', `request ${id} is claimed by events on lines ${owner.get(id)!.line} and ${e.line}`);
        owner.set(id, e);
        const r = byId.get(id);
        if (!r) phantoms.push(`line ${e.line}: ${id}`);
        else (matched.get(e) ?? matched.set(e, []).get(e)!).push(r);
      }
    }
    if (phantoms.length) note('FAIL', 'gateway', `${phantoms.length} event request ids not in the gateway log: ${listSome(phantoms)}`);

    // Events without ids are matched by time: each takes the earliest unclaimed records of its model up to its own time.
    let pool = gateway.filter((r) => !owner.has(r.request_id)).sort((a, b) => ms(a.ts) - ms(b.ts));
    const loose = events.filter((e) => !e.request_id && !(e.request_ids?.length)).sort((a, b) => ms(a.ts) - ms(b.ts));
    let timeMatched = 0;
    for (const e of loose) {
      const take: GatewayRecord[] = [];
      for (const r of pool) {
        if (take.length === e.requests) break;
        if (r.provider === e.provider && r.model === e.model && ms(r.ts) <= ms(e.ts) + 2_000) take.push(r);
      }
      pool = pool.filter((r) => !take.includes(r));
      matched.set(e, take);
      timeMatched += take.length;
    }
    if (timeMatched) note('INFO', 'gateway', `${timeMatched} gateway records matched to ${loose.length} events without request ids by time`);
    unmatchedGateway = pool;
    if (pool.length) {
      note('FAIL', 'gateway', `${pool.length} gateway requests are covered by no event (accounting lost, SPEC §17.2 point 3): ${listSome(pool.map((r) => `${r.ts} ${r.request_id}`))}`);
    }

    const mismatches: string[] = [];
    for (const [e, recs] of matched) {
      const sum = zero();
      for (const r of recs) add(sum, r, 1);
      if (recs.length !== e.requests || !sameTokens(sum, e)) {
        mismatches.push(`line ${e.line}: event requests=${e.requests} ${fmtTokens(e)}; gateway requests=${recs.length} ${fmtTokens(sum)}`);
      }
      const failed = recs.some((r) => r.status >= 400);
      if (failed !== (e.status === 'error')) mismatches.push(`line ${e.line}: status ${e.status}, gateway HTTP ${recs.map((r) => r.status).join(',')}`);
    }
    if (mismatches.length) note('FAIL', 'gateway', `${mismatches.length} events differ from the gateway: ${listSome(mismatches)}`);
  }
}

// ── 4. Transcript request ids ──────────────────────────────────────────────

if (transcriptsDir) {
  const claimed = new Set(events.flatMap((e) => (e.request_id ? [e.request_id] : (e.request_ids ?? []))));
  const missing = new Set<string>();
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith('.jsonl')) {
        for (const text of readFileSync(p, 'utf8').split('\n')) {
          if (!text.includes('"requestId"')) continue;
          try {
            const id = (JSON.parse(text) as { requestId?: unknown }).requestId;
            if (typeof id === 'string' && !claimed.has(id)) missing.add(id);
          } catch {
            /* not a JSON line */
          }
        }
      }
    }
  };
  walk(resolve(transcriptsDir));
  if (missing.size) note('FAIL', 'transcripts', `${missing.size} transcript requestIds have no event: ${listSome([...missing])}`);
}

// ── 5. Provider reports against the gateway (SPEC §17.6) ───────────────────

{
  if (!calibration && summary.verification?.level === 'V1' && reports.length === 0) {
    note('FAIL', 'provider', `no provider report in ${join(base, 'provider')} (required under V1)`);
  }
  const TOLERANCE = 0.005;
  for (const rep of reports) {
    const gw = new Map<string, ReturnType<typeof zero>>();
    for (const r of gateway) {
      if (r.provider !== rep.provider || r.account !== rep.account) continue;
      add(gw.get(r.model) ?? gw.set(r.model, zero()).get(r.model)!, r, 1);
    }
    for (const model of new Set([...gw.keys(), ...Object.keys(rep.by_model)])) {
      const g = gw.get(model) ?? zero();
      const p = rep.by_model[model] ?? zero();
      for (const c of CLASSES) {
        const diff = Math.abs(g[c] - p[c]);
        if (diff > TOLERANCE * Math.max(g[c], p[c]) && diff > 0) {
          note('FAIL', 'provider', `${rep.where}: ${model} ${c}: gateway ${g[c]}, provider ${p[c]} (difference above 0.5 %)`);
        }
      }
    }
  }
  for (const rec of summary.verification?.reconciliation ?? []) {
    if (rec.source === 'gateway') {
      const g = zero();
      for (const r of gateway) if (r.account === rec.account) add(g, r, 1);
      if (gateway.length && !sameTokens(g, rec.reported)) {
        note('FAIL', 'provider', `usage.json reconciliation for gateway ${rec.account} reports ${fmtTokens(rec.reported as Tokens)}; the gateway log sums to ${fmtTokens(g)}`);
      }
      if (gateway.length && rec.unmatched_requests !== unmatchedGateway.filter((r) => r.account === rec.account).length) {
        note('FAIL', 'provider', `usage.json reconciliation for gateway ${rec.account}: unmatched_requests ${rec.unmatched_requests}, verifier found ${unmatchedGateway.length}`);
      }
    }
  }
}

// ── 6. Prices and cost (SPEC §17.7) ────────────────────────────────────────

type Priced = { ts: string; cost: number; model: string; component: string };
const unpriced = new Set<string>();

function costOf(u: Tokens & { provider: string; model: string; speed?: string | null; service_tier?: string | null; region?: string | null; cache_write_1h_tokens?: number | null; server_tool_uses?: Record<string, number> }, requests: number): number {
  const prov = prices.providers[u.provider];
  const model = prov?.models[u.model];
  const region = u.region ?? prov?.default_region;
  const tier = u.service_tier ?? prov?.default_service_tier;
  const key = `${u.provider}/${u.model} speed=${u.speed ?? 'standard'} tier=${tier} region=${region}`;
  if (!prov || !model || !region || !tier || !model.regions.includes(region) || prov.region_multipliers[region] === undefined || prov.service_tier_multipliers[tier] === undefined) {
    unpriced.add(key);
    return 0;
  }
  const prompt = (u.input_tokens + u.cache_read_tokens + u.cache_write_tokens) / Math.max(1, requests);
  let rates: Rates | undefined;
  if (u.speed && u.speed !== 'standard') rates = model.speed?.[u.speed];
  else if (model.tiers) rates = model.tiers.find((t) => t.max_prompt_tokens === undefined || prompt <= t.max_prompt_tokens)?.rates;
  else rates = model.rates;
  if (!rates) {
    unpriced.add(key);
    return 0;
  }
  const w1h = u.cache_write_1h_tokens ?? u.cache_write_tokens; // unknown split: all at the 1-hour rate
  const w5m = u.cache_write_tokens - w1h;
  let cost =
    (u.input_tokens * rates.input +
      u.cache_read_tokens * rates.cache_read +
      w5m * rates.cache_write_5m +
      w1h * rates.cache_write_1h +
      u.output_tokens * rates.output) /
    1e6;
  cost *= prov.region_multipliers[region]! * prov.service_tier_multipliers[tier]!;
  for (const [tool, uses] of Object.entries(u.server_tool_uses ?? {})) {
    const fee = prov.server_tools[tool];
    if (fee === undefined) unpriced.add(`${u.provider} server tool ${tool}`);
    else cost += fee * uses;
  }
  return cost;
}

const priced: Priced[] = [];
const eventCost = new Map<UsageEvent, number>();
for (const e of events) {
  const recs = matched.get(e);
  let cost = 0;
  if (recs && recs.length) {
    // Gateway records carry per-request usage, so tiers and the 5m/1h split are exact; priced with the event's attributes.
    for (const r of recs) {
      const c = costOf({ ...r, speed: r.speed ?? e.speed, service_tier: r.service_tier ?? e.service_tier, region: r.region ?? e.region, cache_write_1h_tokens: r.cache_write_1h_tokens ?? e.cache_write_1h_tokens }, 1);
      priced.push({ ts: r.ts, cost: c, model: e.model, component: e.component });
      cost += c;
    }
  } else {
    cost = costOf(e, e.requests);
    priced.push({ ts: e.ts, cost, model: e.model, component: e.component });
  }
  eventCost.set(e, cost);
}
for (const r of unmatchedGateway) priced.push({ ts: r.ts, cost: costOf(r, 1), model: r.model, component: '(unmatched gateway requests)' });
if (unpriced.size) note('FAIL', 'prices', `no price in prices.json (fetched ${prices.fetched}) for: ${listSome([...unpriced])}`);

const totalCost = priced.reduce((a, p) => a + p.cost, 0);
const costBy = (key: 'model' | 'component'): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const p of priced) out[p[key]] = (out[p[key]] ?? 0) + p.cost;
  return out;
};
let capCrossedAt: string | null = null;
if (costCap !== undefined) {
  let running = 0;
  for (const p of [...priced].sort((a, b) => ms(a.ts) - ms(b.ts))) {
    running += p.cost;
    if (running >= costCap) {
      capCrossedAt = p.ts;
      break;
    }
  }
}

// ── Report ─────────────────────────────────────────────────────────────────

const pass = !findings.some((f) => f.severity === 'FAIL');
const usd = (n: number): string => `$${n.toFixed(2)}`;
const headline = {
  input: summary.totals ? summary.totals.input_tokens + summary.totals.cache_read_tokens + summary.totals.cache_write_tokens : 0,
  output: summary.totals?.output_tokens ?? 0,
};
const out: string[] = [
  `RSDB token accounting verification — ${pass ? 'PASS' : 'FAIL'}`,
  `results: ${base}${calibration ? ' (calibration)' : ''}`,
  `harness: ${summary.harness?.name ?? '?'}; level ${summary.verification?.level ?? '?'}; status ${summary.status ?? '?'}`,
  `events: ${events.length}; gateway records: ${gateway.length}; provider reports: ${reports.length}; prices fetched ${prices.fetched}`,
  '',
  `headline: input ${headline.input} (input + cache_read + cache_write), output ${headline.output}, cost ${usd(totalCost)}`,
  ...(costCap !== undefined ? [`cost cap ${usd(costCap)}: ${capCrossedAt ? `crossed at ${capCrossedAt}` : 'not reached'}`] : []),
  '',
  'cost by model:',
  ...Object.entries(costBy('model')).map(([k, v]) => `  ${k}: ${usd(v)}`),
  'cost by component:',
  ...Object.entries(costBy('component')).map(([k, v]) => `  ${k}: ${usd(v)}`),
  '',
  findings.length ? 'findings:' : 'findings: none',
  ...findings.map((f) => `  [${f.severity}] ${f.check}: ${f.detail}`),
];
writeFileSync(join(base, 'verify.txt'), out.join('\n') + '\n');
writeFileSync(
  join(base, 'verify.json'),
  JSON.stringify(
    {
      format: 'rsdb-verify/1',
      pass,
      calibration,
      prices_fetched: prices.fetched,
      headline: { ...headline, cost_usd: totalCost },
      totals: summary.totals,
      cost_by_model: costBy('model'),
      cost_by_component: costBy('component'),
      cost_cap: costCap ?? null,
      cost_cap_crossed_at: capCrossedAt,
      event_costs: events.map((e) => ({ line: e.line, cost_usd: eventCost.get(e) ?? 0 })),
      findings,
    },
    null,
    2,
  ) + '\n',
);
console.log(out.join('\n'));
process.exit(pass ? 0 : 1);
