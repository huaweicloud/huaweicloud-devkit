// The fake-hcloud harness for the KooCLI execution tests, extracted from
// hcloud-cli.test.ts: the deterministic vendor-challenge seam, the temp
// auth-home isolation, and the fake binary/script/meta-repo builders.
import assert from 'node:assert/strict';
import { chmodSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { type HcloudRunResult } from '../plugins/huaweicloud-core/src/hcloud-cli.ts';
import { clearRuntimeCredentials } from '../plugins/huaweicloud-core/src/auth/credentials.ts';
import { fixtureDir } from './fixture-dir.ts';

// Deterministic-tier seam: disable the once-per-session first-assertion
// vendor challenge (HUAWEICLOUD_VENDOR_CHALLENGE=off, the installer-override
// pattern) so cold-attested calls in this file dispatch without the
// challenge bounce. The challenge itself is pinned where it is the subject
// (tools.test.ts's gate test drives the dance; the selfcheck drives it on
// the wire); the real-model e2e tier never sets this seam.
process.env.HUAWEICLOUD_VENDOR_CHALLENGE = 'off';

export const isWin = process.platform === 'win32';

export interface FakeHcloudOutput {
  ok: boolean;
  args: string[];
}

export interface ApprovedRunResult extends HcloudRunResult {
  approved: boolean;
  injectedLang?: unknown;
  autoRetried?: unknown;
}

export async function withTempAuthHome(fn: (home: string) => Promise<void> | void) {
  const home = fixtureDir('huaweicloud-toolkit-auth-');
  const previous = {
    HUAWEICLOUD_HOME: process.env.HUAWEICLOUD_HOME,
    HCLOUD_CONFIG_PATH: process.env.HCLOUD_CONFIG_PATH,
    HCLOUD_OBS_CONFIG_PATH: process.env.HCLOUD_OBS_CONFIG_PATH,
    HW_ACCESS_KEY: process.env.HW_ACCESS_KEY,
    HW_SECRET_KEY: process.env.HW_SECRET_KEY,
    HW_SECURITY_TOKEN: process.env.HW_SECURITY_TOKEN,
    HW_STS_EXPIRES_AT: process.env.HW_STS_EXPIRES_AT,
  };
  process.env.HUAWEICLOUD_HOME = home;
  process.env.HCLOUD_CONFIG_PATH = join(home, '.hcloud', 'config.json');
  process.env.HCLOUD_OBS_CONFIG_PATH = join(home, '.obsutilconfig');
  delete process.env.HW_ACCESS_KEY;
  delete process.env.HW_SECRET_KEY;
  delete process.env.HW_SECURITY_TOKEN;
  // parseStsExpiry prioritizes this env over the token itself — a stray value
  // would flip the CREDENTIAL_EXPIRED gate tests.
  delete process.env.HW_STS_EXPIRES_AT;
  try {
    return await fn(home);
  } finally {
    clearRuntimeCredentials();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(home, { recursive: true, force: true });
  }
}

export function fakeHcloudScript(source: string) {
  const dir = fixtureDir('huaweicloud-toolkit-');
  const script = join(dir, 'fake-hcloud.mjs');
  writeFileSync(script, source, 'utf8');
  return script;
}

// POSIX-only shape: this writes an extension-less shebang script, which
// Windows cannot exec — a shell:false spawn of it fails before the child
// runs (SPAWN_ERROR, observed on the windows lanes, run 42979717544).
// Windows callers must guard with a win32 skip or assert spawn-indifferent
// outcomes (the approval battery's approved:true shape).
export function fakeHcloudExecutable(source: string) {
  const dir = fixtureDir('huaweicloud-toolkit-bin-');
  const script = join(dir, 'fake-hcloud');
  writeFileSync(script, `#!/usr/bin/env node\n${source}`, 'utf8');
  chmodSync(script, 0o755);
  return script;
}

export function withMetaRepo(files: Record<string, unknown[]>) {
  const dir = fixtureDir('huaweicloud-toolkit-meta-');
  for (const [name, items] of Object.entries(files)) {
    writeFileSync(join(dir, name), JSON.stringify({ items }));
  }
  return dir;
}
