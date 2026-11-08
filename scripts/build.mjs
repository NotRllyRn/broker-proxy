import { spawnSync } from 'node:child_process';
import { access, mkdir, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
const sdk = resolve(process.env.PROXYKIT_SOURCE || '/code/proxykit', 'sdk/index.mjs');
await access(sdk);
// Type-check against the actual installed checkout, without vendoring an unlicensed SDK.
await mkdir('.generated', { recursive: true });
await writeFile('.generated/tsconfig.json', JSON.stringify({ extends: '../tsconfig.json', compilerOptions: {
  baseUrl: '..', paths: { '@proxykit/sdk': [sdk.replace(/\.mjs$/, '.d.mts')] },
}}));
await rm('build', { recursive: true, force: true });
const result = spawnSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', '.generated/tsconfig.json'], { stdio: 'inherit' });
process.exitCode = result.status ?? 1;
