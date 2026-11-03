/** Data sets shared by several scenarios (SPEC §14.4). */
import type { Db, Run } from '../lib/scenario.ts';
import { user } from '../lib/workload.ts';

/** "B3 data": 1M users over 1,000 teams (1,000 users per team at every scale). */
export async function b3Data(r: Run, db: Db): Promise<{ users: number; teams: number }> {
  const teams = r.n(1000);
  const users = teams * 1000;
  await r.preload(db, 'users', users, (i) => user(i, teams));
  return { users, teams };
}

/** Splits `total` specs into connections of `perConn`. */
export function connsOf<T>(specs: T[], perConn: number): T[][] {
  const out: T[][] = [];
  for (let k = 0; k < specs.length; k += perConn) out.push(specs.slice(k, k + perConn));
  return out;
}
