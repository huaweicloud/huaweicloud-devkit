#!/usr/bin/env node
// Fake hcloud that fails `configure set` (exits 1 with an error on stderr) but
// still answers `version` — so syncAuth's hcloudInstalled() probe passes while
// the S2 write itself fails.
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const log = process.env.HCLOUD_FAKE_LOG || '/tmp/hcloud-fake-fail.log';
if (process.argv[2] === 'configure') {
  const dir = dirname(resolve(log));
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  appendFileSync(log, JSON.stringify(process.argv.slice(2)) + '\n');
  process.stderr.write('cli-region format error\n');
  process.exit(1);
}
if (process.argv[2] === 'version') {
  console.log('KooCLI Fake 7.2.12');
  process.exit(0);
}
process.exit(0);