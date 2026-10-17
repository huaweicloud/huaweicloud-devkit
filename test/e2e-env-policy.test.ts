import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';

import { buildCaseEnv, FIXED_ENV_OVERRIDES, STRIP_ENV_KEYS, homeOverrides } from './e2e/env-policy.ts';

function hostileProcessEnv(): NodeJS.ProcessEnv {
  return {
    PATH: '/usr/bin',
    Path: '/win/bin',
    http_proxy: 'http://corp-proxy:8080',
    HTTPS_PROXY: 'http://corp-proxy:8080',
    HW_ACCESS_KEY: 'REAL_AK',
    hw_secret_key: 'REAL_SK',
    HW_SECURITY_TOKEN: 'REAL_STS',
    HW_REGION: 'cn-north-4',
    HCLOUD_CONFIG_PATH: '/real/.hcloud',
    DEVKIT_PACKS: 'core',
    HUAWEICLOUD_HOME: '/real/devkit-home',
    HOME: '/real/home',
  };
}

test('buildCaseEnv strips every hostile key case-insensitively', () => {
  const env = buildCaseEnv({ processEnv: hostileProcessEnv(), home: '/tmp/h' });
  for (const key of [
    'http_proxy',
    'HTTPS_PROXY',
    'HW_ACCESS_KEY',
    'hw_secret_key',
    'HW_SECURITY_TOKEN',
    'HW_REGION',
    'HCLOUD_CONFIG_PATH',
    'DEVKIT_PACKS',
  ]) {
    assert.equal(env[key], undefined, `${key} must not survive the trim`);
  }
  // HUAWEICLOUD_HOME is stripped from the process env and then legitimately
  // relocated by the home layer — it must point at the throwaway home.
  assert.equal(env.HUAWEICLOUD_HOME, '/tmp/h');
  assert.equal(env.PATH, '/usr/bin');
});

test('buildCaseEnv relocates the home with the five-variable recipe plus XDG', () => {
  const home = '/tmp/hwc-e2e-home';
  const env = buildCaseEnv({
    processEnv: { ...hostileProcessEnv(), XDG_CONFIG_HOME: '/host/xdg-config' },
    home,
  });
  const recipe = homeOverrides(home);
  assert.equal(env.HOME, recipe.HOME);
  assert.equal(env.USERPROFILE, recipe.USERPROFILE);
  assert.equal(env.HOMEDRIVE, recipe.HOMEDRIVE);
  assert.equal(env.HOMEPATH, recipe.HOMEPATH);
  assert.equal(env.HUAWEICLOUD_HOME, recipe.HUAWEICLOUD_HOME);
  // Host XDG values must never survive — the agent would read the host's
  // config/storage instead of the throwaway home's.
  assert.equal(env.XDG_CONFIG_HOME, join(home, '.config'));
  assert.equal(env.XDG_DATA_HOME, join(home, '.local', 'share'));
  assert.equal(env.XDG_STATE_HOME, join(home, '.local', 'state'));
  assert.equal(env.XDG_CACHE_HOME, join(home, '.cache'));
});

test('buildCaseEnv applies every fixed posture override', () => {
  const env = buildCaseEnv({ processEnv: hostileProcessEnv(), home: '/tmp/h' });
  for (const [key, value] of Object.entries(FIXED_ENV_OVERRIDES)) {
    assert.equal(env[key], value, `${key} must be pinned`);
  }
});

test('driver vars cannot shadow seam vars or the fixed posture', () => {
  const env = buildCaseEnv({
    processEnv: hostileProcessEnv(),
    home: '/tmp/h',
    driverVars: { HCLOUD_BIN: 'evil-hcloud', HUAWEICLOUD_DEVKIT_TELEMETRY: 'on' },
    seamVars: { HCLOUD_BIN: '/fake/hcloud' },
  });
  assert.equal(env.HCLOUD_BIN, '/fake/hcloud');
  assert.equal(env.HUAWEICLOUD_DEVKIT_TELEMETRY, 'off');
});

test('relaxFixed removes exactly the whitelisted key and nothing else', () => {
  const env = buildCaseEnv({
    processEnv: hostileProcessEnv(),
    home: '/tmp/h',
    relaxFixed: ['HUAWEICLOUD_DEVKIT_SKIP_UPDATE'],
  });
  assert.equal(env.HUAWEICLOUD_DEVKIT_SKIP_UPDATE, undefined, 'the relaxed key must be removed');
  assert.equal(env.HUAWEICLOUD_DEVKIT_TELEMETRY, 'off', 'telemetry stays pinned');
  assert.equal(env.HUAWEICLOUD_INJECT_STS_CMD, '0', 'STS injection stays pinned');
  assert.equal(env.NO_PROXY, '127.0.0.1,localhost', 'NO_PROXY stays pinned');
});

test('STRIP_ENV_KEYS and FIXED_ENV_OVERRIDES stay disjoint', () => {
  const strip = new Set(STRIP_ENV_KEYS.map((key) => key.toLowerCase()));
  for (const key of Object.keys(FIXED_ENV_OVERRIDES)) {
    assert.equal(strip.has(key.toLowerCase()), false, `${key} appears in both layers`);
  }
});
