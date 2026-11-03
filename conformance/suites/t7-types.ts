/** T7 Types (SPEC §13.5): `types/api.test-d.ts` compiles unchanged against the built package. */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { SDK_DIR } from '../lib/sdk.ts';
import type { Suite } from '../lib/suite.ts';

const KIT = new URL('../../', import.meta.url).pathname;
const LINK = '/node_modules/@rsdb/client';

const suite: Suite = {
  id: 'T7',
  level: 'L1',
  weight: 2,
  needsSdk: false,
  cases: () => [
    {
      name: 'api.test-d.ts',
      async run(t) {
        fs.mkdirSync('/node_modules/@rsdb', { recursive: true });
        fs.rmSync(LINK, { force: true });
        fs.symlinkSync(SDK_DIR, LINK, 'dir');
        t.defer(() => fs.rmSync(LINK, { force: true }));
        const r = spawnSync('/node_modules/.bin/tsc', ['-p', `${KIT}types/tsconfig.judge.json`, '--listFiles'], { encoding: 'utf8', timeout: 300_000 });
        const out = `${r.stdout}${r.stderr}`;
        const errors = out.split('\n').filter((l) => /error TS\d+/.test(l));
        if (r.status !== 0) return void t.fail(`tsc exit ${r.status}:\n${(errors.length ? errors : out.split('\n')).slice(0, 30).join('\n')}`);
        const sdkReal = fs.realpathSync(SDK_DIR);
        t.check(out.split('\n').some((l) => l.startsWith(`${sdkReal}/`) || l.startsWith(`${LINK}/`)), '@rsdb/client did not resolve to the built package in /sdk');
      },
    },
  ],
};
export default suite;
