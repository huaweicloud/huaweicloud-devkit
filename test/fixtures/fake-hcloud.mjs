#!/usr/bin/env node
// Fake hcloud: records argv to HCLOUD_FAKE_LOG, configure set exits 0 (ESM)
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const log = process.env.HCLOUD_FAKE_LOG || '/tmp/hcloud-fake.log';
if (process.argv[2] === 'configure') {
  const dir = dirname(resolve(log));
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  appendFileSync(log, JSON.stringify(process.argv.slice(2)) + '\n');
  process.exit(0);
}
if (process.argv[2] === 'version') {
  console.log('KooCLI Fake 7.2.12');
  process.exit(0);
}
process.exit(0);
