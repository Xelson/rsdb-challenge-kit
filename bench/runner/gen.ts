/**
 * Generator process (SPEC §14.1): `node --expose-gc --import /kit/bench/runner/guard.mjs /kit/bench/runner/gen.ts <config.json>`.
 * Loads the SDK after the guard, then runs one role from roles.ts against the controller's command channel. Every result it posts
 * carries the guard's list of tampered globals, so a patching SDK is reported at the first barrier after the patch.
 */
import fs from 'node:fs';
import { loadSdk } from '../../conformance/lib/sdk.ts';
import { sync } from '../lib/control.ts';
import { ROLES, type Guard } from './roles.ts';

const guard = (globalThis as Record<symbol, unknown>)[Symbol.for('rsdb.bench.guard')] as Guard | undefined;
if (!guard) {
  console.error('gen.ts must start with node --import /kit/bench/runner/guard.mjs');
  process.exit(2);
}
const cfg = JSON.parse(fs.readFileSync(process.argv[2]!, 'utf8')) as { id: string; role: string; params: unknown };
const base = process.env.RSDB_CONTROL!;
const role = ROLES[cfg.role];
if (!role) throw new Error(`unknown role ${cfg.role}`);
const sdk = await loadSdk();
await role({
  id: cfg.id,
  params: cfg.params,
  sdk,
  guard,
  work: '/work',
  cmd: (result) => sync(base, cfg.id, `cmd:${cfg.id}`, { result, tampered: guard.tampered() }),
});
process.exit(0);
