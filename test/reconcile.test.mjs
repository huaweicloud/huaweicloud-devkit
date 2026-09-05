import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  fingerprint,
  hasRuntimeCredentials,
  isManualModified,
  readKooCliProfiles,
  scanState,
} from '../plugins/huaweicloud-core/src/auth/reconcile.mjs';
import { lastSyncPath, writeGlobalCredentials } from '../plugins/huaweicloud-core/src/auth/credentials.mjs';

function withTempHome(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'huaweicloud-rec-'));
  const prev = process.env.HUAWEICLOUD_HOME;
  process.env.HUAWEICLOUD_HOME = dir;
  delete process.env.HW_ACCESS_KEY;
  delete process.env.HW_SECRET_KEY;
  delete process.env.HW_SECURITY_TOKEN;
  try {
    return fn(dir);
  } finally {
    if (prev === undefined) delete process.env.HUAWEICLOUD_HOME;
    else process.env.HUAWEICLOUD_HOME = prev;
    rmSync(dir, { recursive: true, force: true });
  }
}

// HUAWEICLOUD_HOME is the temp dir here, so the fake KooCLI config must live
// under it (readKooCliProfiles resolves ~=.hcloud/config.json via baseHome →
// HUAWEICLOUD_HOME), NOT under the real os.homedir().
function writeFakeKooCli(current, profiles) {
  const home = process.env.HUAWEICLOUD_HOME;
  const p = join(home, '.hcloud', 'config.json');
  mkdirSync(join(home, '.hcloud'), { recursive: true });
  writeFileSync(p, JSON.stringify({ current, profiles }, null, 2));
  return p;
}

test('fingerprint is a stable masked digest', () => {
  assert.equal(fingerprint('AK1', 'SK1').length, 8);
  assert.equal(fingerprint('AK1', 'SK1'), fingerprint('AK1', 'SK1'));
  assert.notEqual(fingerprint('AK1', 'SK1'), fingerprint('AK1', 'SK2'));
  assert.equal(fingerprint('', ''), '');
});

test('readKooCliProfiles parses current + profiles with fingerprint/mtime', () => {
  withTempHome(() => {
    writeFakeKooCli('deploy', [
      { name: 'default', accessKeyId: 'AK_A', secretAccessKey: 'SK_A', region: 'cn-east-3' },
      { name: 'deploy', accessKeyId: 'AK_B', secretAccessKey: 'SK_B', region: 'cn-north-4' },
    ]);
    const res = readKooCliProfiles();
    assert.equal(res.current, 'deploy');
    assert.equal(res.profiles.length, 2);
    assert.equal(res.profiles.find((p) => p.name === 'default').fingerprint, fingerprint('AK_A', 'SK_A'));
  });
});

test('readKooCliProfiles handles missing config', () => {
  withTempHome(() => {
    const res = readKooCliProfiles();
    assert.equal(res.error, 'KooCLI config not found');
  });
});

test('scanState detects S1 vs KooCLI current-profile mismatch', () => {
  withTempHome(() => {
    writeGlobalCredentials({ ak: 'AK_S1', sk: 'SK_S1', region: 'cn-north-4' });
    writeFakeKooCli('deploy', [
      { name: 'deploy', accessKeyId: 'AK_B', secretAccessKey: 'SK_B', region: 'cn-north-4' },
    ]);
    const scan = scanState();
    assert.equal(scan.stores.s1Fingerprint, fingerprint('AK_S1', 'SK_S1'));
    assert.equal(scan.stores.currentFingerprint, fingerprint('AK_B', 'SK_B'));
    assert.ok(scan.inconsistencies.some((i) => i.store === 'S2-current'));
  });
});

test('isManualModified compares mtime vs .last_sync', () => {
  withTempHome((dir) => {
    const cfgDir = join(dir, '.config', 'huaweicloud');
    mkdirSync(cfgDir, { recursive: true });
    const lastSync = Date.now() - 60_000;
    writeFileSync(lastSyncPath(), JSON.stringify({ ts: lastSync }));

    const store = join(dir, '.hcloud', 'config.json');
    mkdirSync(join(dir, '.hcloud'), { recursive: true });
    writeFileSync(store, '{}');

    // Store last modified before the sync marker → not a manual change
    const before = new Date(lastSync - 60_000);
    utimesSync(store, before, before);
    assert.equal(isManualModified(store), false);

    // Store touched after the sync marker → manual change
    const after = new Date(lastSync + 60_000);
    utimesSync(store, after, after);
    assert.equal(isManualModified(store), true);
  });
});

test('hasRuntimeCredentials reflects resolvable credentials', () => {
  withTempHome(() => {
    // Nothing resolvable (no env, no vault) → false
    assert.equal(hasRuntimeCredentials(), false);

    // Environment credentials present → true
    process.env.HW_ACCESS_KEY = 'AK_ENV';
    process.env.HW_SECRET_KEY = 'SK_ENV';
    assert.equal(hasRuntimeCredentials(), true);
  });
});