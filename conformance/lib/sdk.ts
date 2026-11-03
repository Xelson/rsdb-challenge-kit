/**
 * Loads the submission's SDK. The judge resolves `@rsdb/client` to `/sdk` through a private node_modules, so that no
 * `node_modules/@rsdb/client` exists on the path of schema files the CLI loads (SPEC §5.4) — only T7 links the global one.
 */
import fs from 'node:fs';
import { registerHooks } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export type Sdk = typeof import('@rsdb/client');
export const SDK_DIR = process.env.RSDB_SDK ?? '/sdk';
const RESOLVE_ROOT = '/tmp/rsdb-judge-resolve';

let installed = false;
function installResolver(): void {
  if (installed) return;
  installed = true;
  fs.mkdirSync(`${RESOLVE_ROOT}/node_modules/@rsdb`, { recursive: true });
  const link = `${RESOLVE_ROOT}/node_modules/@rsdb/client`;
  if (!fs.existsSync(link)) fs.symlinkSync(SDK_DIR, link, 'dir');
  const parentURL = pathToFileURL(`${RESOLVE_ROOT}/resolver.js`).href;
  registerHooks({
    resolve(specifier, context, next) {
      if (specifier === '@rsdb/client' || specifier.startsWith('@rsdb/client/')) return next(specifier, { ...context, parentURL });
      return next(specifier, context);
    },
  });
}

export async function loadSdk(): Promise<Sdk> {
  installResolver();
  return (await import('@rsdb/client')) as Sdk;
}

/** Absolute path of the `rsdb` bin declared by the SDK package (SPEC §10); the judge runs it as `node <bin>`. */
export function cliBin(): string {
  const pkg = JSON.parse(fs.readFileSync(path.join(SDK_DIR, 'package.json'), 'utf8'));
  const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.rsdb;
  if (typeof bin !== 'string') throw new Error('sdk/package.json declares no `rsdb` bin');
  return path.resolve(SDK_DIR, bin);
}
