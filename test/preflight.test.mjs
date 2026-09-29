import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  maybePreinstallKooCli,
  kooCliInstallLogPath,
  resolvePreinstallCliEntry,
} from '../plugins/huaweicloud-core/src/preflight.mjs';

// NOTE: preflight reads findHcloudBin() which relies on HCLOUD_BIN env + fixed
// install dirs. Tests use HCLOUD_BIN pointing at a fake binary to simulate
// "installed" and unset it to simulate "missing" (spawn skipped via env flag).
function withPreinstallEnv(fn) {
  const prev = {
    HUAWEICLOUD_SKIP_HCLOUD_PREINSTALL: process.env.HUAWEICLOUD_SKIP_HCLOUD_PREINSTALL,
    HCLOUD_BIN: process.env.HCLOUD_BIN,
    HUAWEICLOUD_HOME: process.env.HUAWEICLOUD_HOME,
  };
  const tempHome = mkdtempSync(join(tmpdir(), 'preflight-home-'));
  process.env.HUAWEICLOUD_HOME = tempHome;
  process.env.HUAWEICLOUD_SKIP_HCLOUD_PREINSTALL = '0';
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(tempHome, { recursive: true, force: true });
  }
}

test('preinstall skips when HCLOUD_BIN already exists (installed)', () => {
  withPreinstallEnv(() => {
    const fakeBinDir = mkdtempSync(join(tmpdir(), 'preflight-bin-'));
    const fakeBin = join(fakeBinDir, 'hcloud');
    try {
      writeFileSync(fakeBin, '#!/usr/bin/env node\nconsole.log("7.2.12")', 'utf8');
      process.env.HCLOUD_BIN = fakeBin;
      const { launched, reason } = maybePreinstallKooCli();
      assert.equal(launched, false);
      assert.match(reason, /already installed/i);
    } finally {
      rmSync(fakeBinDir, { recursive: true, force: true });
    }
  });
});

test('preinstall spawn entry resolves to an existing sibling src/setup-cli.mjs (no download)', () => {
  const entry = resolvePreinstallCliEntry();
  assert.ok(entry.endsWith(join('src', 'setup-cli.mjs')), entry);
  assert.ok(existsSync(entry), `spawn entry missing: ${entry}`);
});

test('preinstall is disabled by HUAWEICLOUD_SKIP_HCLOUD_PREINSTALL=1', () => {
  withPreinstallEnv(() => {
    delete process.env.HCLOUD_BIN;
    const prev = process.env.HUAWEICLOUD_SKIP_HCLOUD_PREINSTALL;
    process.env.HUAWEICLOUD_SKIP_HCLOUD_PREINSTALL = '1';
    const { launched, reason } = maybePreinstallKooCli();
    assert.equal(launched, false);
    assert.match(reason, /disabled/i);
    if (prev === undefined) delete process.env.HUAWEICLOUD_SKIP_HCLOUD_PREINSTALL;
    else process.env.HUAWEICLOUD_SKIP_HCLOUD_PREINSTALL = prev;
  });
});

test('preinstall config path is under the huaweicloud config dir', () => {
  withPreinstallEnv(() => {
    const p = kooCliInstallLogPath();
    assert.ok(p.endsWith('koocli-install.log'));
    assert.ok(p.includes('.config'));
  });
});
