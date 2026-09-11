import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  fingerprint,
  hasRuntimeCredentials,
  isManualModified,
  kooCliConfigPath,
  readKooCliProfiles,
  scanState,
} from '../plugins/huaweicloud-core/src/auth/reconcile.mjs';
import {
  clearRuntimeCredentials,
  lastSyncPath,
  setRuntimeCredentials,
  writeGlobalCredentials,
} from '../plugins/huaweicloud-core/src/auth/credentials.mjs';

function withTempHome(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'huaweicloud-rec-'));
  const previous = {
    HUAWEICLOUD_HOME: process.env.HUAWEICLOUD_HOME,
    HCLOUD_CONFIG_PATH: process.env.HCLOUD_CONFIG_PATH,
    HCLOUD_OBS_CONFIG_PATH: process.env.HCLOUD_OBS_CONFIG_PATH,
    HW_ACCESS_KEY: process.env.HW_ACCESS_KEY,
    HW_SECRET_KEY: process.env.HW_SECRET_KEY,
    HW_SECURITY_TOKEN: process.env.HW_SECURITY_TOKEN,
    HW_REGION: process.env.HW_REGION,
    HUAWEICLOUD_REGION: process.env.HUAWEICLOUD_REGION,
  };
  process.env.HUAWEICLOUD_HOME = dir;
  process.env.HCLOUD_CONFIG_PATH = join(dir, '.hcloud', 'config.json');
  process.env.HCLOUD_OBS_CONFIG_PATH = join(dir, '.obsutilconfig');
  delete process.env.HW_ACCESS_KEY;
  delete process.env.HW_SECRET_KEY;
  delete process.env.HW_SECURITY_TOKEN;
  delete process.env.HW_REGION;
  delete process.env.HUAWEICLOUD_REGION;
  try {
    return fn(dir);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

// The fake KooCLI config lives under the temp dir and is wired to
// HCLOUD_CONFIG_PATH, so readKooCliProfiles (production: ~/.hcloud/config.json
// from homedir()) reads the fake file without touching the real one.
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
    writeFakeKooCli('deploy', [{ name: 'deploy', accessKeyId: 'AK_B', secretAccessKey: 'SK_B', region: 'cn-north-4' }]);
    const scan = scanState();
    assert.equal(scan.stores.s1Fingerprint, fingerprint('AK_S1', 'SK_S1'));
    assert.equal(scan.stores.currentFingerprint, fingerprint('AK_B', 'SK_B'));
    assert.ok(scan.inconsistencies.some((i) => i.store === 'S2-current'));
  });
});

test('scanState does not misreport S2 drift when KooCLI authEncrypt=true', () => {
  withTempHome(() => {
    writeGlobalCredentials({ ak: 'AK_S1', sk: 'SK_S1', region: 'cn-north-4' });
    // KooCLI authEncrypt stores ciphertext for the SAME AK/SK — must NOT be
    // compared against plaintext S1 and reported as a drift (#533).
    const home = process.env.HUAWEICLOUD_HOME;
    const p = join(home, '.hcloud', 'config.json');
    mkdirSync(join(home, '.hcloud'), { recursive: true });
    writeFileSync(
      p,
      JSON.stringify(
        {
          current: 'default',
          // KooCLI serializes the flag as the string "true" — mirror that here.
          authEncrypt: 'true',
          profiles: [
            {
              name: 'default',
              accessKeyId: 'uhGFuo-ciphertext',
              secretAccessKey: 'hkLG8n-ciphertext',
              region: 'cn-north-4',
            },
          ],
        },
        null,
        2,
      ),
    );
    const scan = scanState();
    assert.equal(scan.s2Encrypted, true);
    assert.equal(
      scan.inconsistencies.some((i) => i.store === 'S2-current'),
      false,
    );
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

test('hasRuntimeCredentials reflects only runtime-injected credentials', () => {
  withTempHome(() => {
    clearRuntimeCredentials();

    // Env credentials are resolvable but NOT runtime-injected → false
    process.env.HW_ACCESS_KEY = 'AK_ENV';
    process.env.HW_SECRET_KEY = 'SK_ENV';
    assert.equal(hasRuntimeCredentials(), false);

    // Runtime-injected → true
    setRuntimeCredentials('AK_RT', 'SK_RT');
    assert.equal(hasRuntimeCredentials(), true);

    // Cleared → false
    clearRuntimeCredentials();
    assert.equal(hasRuntimeCredentials(), false);
  });
});

test('scanState reports real runtime-store hasRuntime and runtimeFingerprint', () => {
  withTempHome(() => {
    clearRuntimeCredentials();

    const none = scanState();
    assert.equal(none.hasRuntime, false);
    assert.equal(none.runtimeFingerprint, null);

    setRuntimeCredentials('RT_AK', 'RT_SK', undefined, 'cn-north-4');
    const active = scanState();
    assert.equal(active.hasRuntime, true);
    assert.equal(active.runtimeFingerprint, fingerprint('RT_AK', 'RT_SK'));
    assert.equal(active.stores.runtimeFingerprint, fingerprint('RT_AK', 'RT_SK'));

    clearRuntimeCredentials();
    const cleared = scanState();
    assert.equal(cleared.hasRuntime, false);
    assert.equal(cleared.runtimeFingerprint, null);
  });
});

test('kooCliConfigPath honors HCLOUD_CONFIG_PATH then falls back to homedir', () => {
  const prev = process.env.HCLOUD_CONFIG_PATH;
  try {
    delete process.env.HCLOUD_CONFIG_PATH;
    assert.equal(kooCliConfigPath(), join(homedir(), '.hcloud', 'config.json'));
    process.env.HCLOUD_CONFIG_PATH = '/fake/hcloud/config.json';
    assert.equal(kooCliConfigPath(), '/fake/hcloud/config.json');
  } finally {
    if (prev === undefined) delete process.env.HCLOUD_CONFIG_PATH;
    else process.env.HCLOUD_CONFIG_PATH = prev;
  }
});
