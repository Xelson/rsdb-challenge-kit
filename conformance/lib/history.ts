/**
 * The committed log of one database as the test observed it, version accounting (SPEC §13.2 row 2) and voter replay (§13.3):
 * every acknowledged batch carries its version, so a run knows the complete log up to the first version no acknowledgement covers.
 * Fault runs also record checkpoints (the full state read back at a quiescence point, equal on every node): replay resumes from the
 * first checkpoint after a gap, so deliveries after an unknown outcome are still checked.
 */
import type { MutationIR, OpResult, QueryIR, SchemaIR } from '@rsdb/client';
import { Voter, canonical, resultHash, type VoterResult, type VoterRow } from '../voter/voter.ts';
import type { Delivery } from './observe.ts';
import type { CaseCtx } from './suite.ts';

type Commit = { kind: 'batch'; ops: MutationIR[]; results: OpResult[] } | { kind: 'push'; schema: SchemaIR };

interface Expectation {
  label: string;
  query: QueryIR;
  delivery: Delivery;
}

export class History {
  readonly label: string;
  #t: CaseCtx;
  #commits = new Map<number, Commit>();
  #expect = new Map<number, Expectation[]>();
  #checkpoints = new Map<number, { schema: SchemaIR; tables: Record<string, VoterRow[]> }>();
  acked = 0;
  pushes = 0;
  unknown = 0;
  maxObserved = 0;

  constructor(t: CaseCtx, label: string) {
    this.#t = t;
    this.label = label;
  }

  push(version: number, schema: SchemaIR): void {
    this.#add(version, { kind: 'push', schema: structuredClone(schema) });
    this.pushes++;
  }
  ack(version: number, ops: MutationIR[], results: OpResult[]): void {
    this.#add(version, { kind: 'batch', ops, results });
    this.acked++;
  }
  #add(version: number, c: Commit) {
    if (!Number.isInteger(version) || version < 1) return this.#t.fail(`${this.label}: acknowledged version ${version} is not a version`);
    if (this.#commits.has(version)) return this.#t.fail(`${this.label}: version ${version} acknowledged twice`);
    this.#commits.set(version, c);
    this.maxObserved = Math.max(this.maxObserved, version);
  }
  /** The complete state at `version`, read back from the nodes (fault runs). */
  checkpoint(version: number, schema: SchemaIR, tables: Record<string, VoterRow[]>): void {
    this.maxObserved = Math.max(this.maxObserved, version);
    this.#checkpoints.set(version, { schema: structuredClone(schema), tables });
  }
  /** A mutation whose outcome is unknown (§7.3). */
  unknownOutcome(): void {
    this.unknown++;
  }
  /** A result some subscription or fetch delivered at a version, to be checked against Q(D_v). */
  expect(label: string, query: QueryIR, delivery: Delivery): void {
    this.maxObserved = Math.max(this.maxObserved, delivery.version);
    let list = this.#expect.get(delivery.version);
    if (!list) this.#expect.set(delivery.version, (list = []));
    list.push({ label, query, delivery });
  }
  get expectations(): number {
    let n = 0;
    for (const l of this.#expect.values()) n += l.length;
    return n;
  }

  /**
   * Version accounting against the final version and voter replay of the committed prefix. In a fault-free run every unknown
   * outcome fails and the acknowledged versions must be exactly 1..vFinal.
   */
  verify(vFinal: number, faultFree: boolean): { replayedTo: number; checked: number; restored: number; unchecked: number } {
    const t = this.#t;
    const L = this.label;
    const A = this.acked;
    const P = this.pushes;
    const U = this.unknown;
    if (faultFree && U > 0) t.fail(`${L}: ${U} mutation(s) with unknown outcome in a fault-free run`);
    if (vFinal < A + P || vFinal > A + U + P) t.fail(`${L}: final version ${vFinal} outside [A+P, A+U+P] = [${A + P}, ${A + U + P}]`);
    if (this.maxObserved > vFinal) t.fail(`${L}: version ${this.maxObserved} observed above the final version ${vFinal}`);

    let voter = new Voter();
    let checked = 0;
    let replayedTo = 0;
    let mismatches = 0;
    let restored = 0;
    const checkpoints = [...this.#checkpoints.keys()].sort((a, b) => a - b);
    const covered = new Set<number>();
    const checkAt = (v: number) => {
      covered.add(v);
      for (const e of this.#expect.get(v) ?? []) {
        checked++;
        let r: VoterResult;
        try {
          r = voter.query(e.query);
        } catch (err) {
          t.fail(`R1 ${e.label} at v${v}: the voter cannot evaluate the query (${(err as Error).message})`);
          continue;
        }
        if (resultHash(r) !== e.delivery.hash && mismatches++ < 10) {
          const exp = r.kind === 'rows' ? canonical(r.rows) : String(r.count);
          t.fail(`R1 ${e.label} at v${v}: delivered ${clip(e.delivery.sample ?? '(large result)')}, Q(D_v) is ${clip(exp)}`);
        }
      }
    };
    try {
      for (let v = 1; v <= vFinal; v++) {
        const c = this.#commits.get(v);
        if (!c) {
          if (faultFree) {
            t.fail(`${L}: version ${v} was committed but never acknowledged`);
            break;
          }
          const cp = checkpoints.find((x) => x >= v && x <= vFinal);
          if (cp === undefined) break;
          const { schema, tables } = this.#checkpoints.get(cp)!;
          voter.close();
          try {
            voter = Voter.restore(schema, tables, cp);
          } catch (e) {
            voter = new Voter();
            t.fail(`${L}: the state read back at v${cp} is not valid under the schema: ${(e as Error).message}`);
            break;
          }
          restored++;
          replayedTo = v = cp;
          checkAt(v);
          continue;
        }
        if (c.kind === 'push') {
          if (!voter.push(c.schema)) {
            t.fail(`${L}: push acknowledged at v${v} changes nothing`);
            break;
          }
        } else {
          const ids = c.ops.map((op, i) => (op.op === 'insert' && (op.row as { id?: unknown }).id === undefined ? (c.results[i] as { id?: string })?.id : undefined));
          let results: OpResult[];
          try {
            results = voter.applyBatch(c.ops, ids);
          } catch (e) {
            t.fail(`${L}: v${v} was acknowledged, but the voter rejects the batch: ${(e as Error).message}`);
            break;
          }
          if (canonical(results) !== canonical(c.results)) {
            t.fail(`${L}: v${v} results ${clip(canonical(c.results))}, voter ${clip(canonical(results))}`);
          }
        }
        if (voter.version !== v) {
          t.fail(`${L}: voter at version ${voter.version} after replaying v${v}`);
          break;
        }
        replayedTo = v;
        checkAt(v);
      }
    } finally {
      voter.close();
    }
    const unchecked = [...this.#expect.keys()].filter((v) => !covered.has(v)).length;
    if (faultFree && unchecked > 0) t.fail(`${L}: deliveries at ${unchecked} version(s) above the replayed prefix v${replayedTo}`);
    return { replayedTo, checked, restored, unchecked };
  }
}

const clip = (s: string, n = 400) => (s.length > n ? `${s.slice(0, n)}…` : s);
