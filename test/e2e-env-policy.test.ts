import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';

import { buildCaseEnv, FIXED_ENV_OVERRIDES, STRIP_ENV_KEYS, homeOverrides, scrubSecrets } from './e2e/env-policy.ts';

// Frozen content floor: these keys MUST stay strippable. The loop-driven
// part below covers additions and the strip mechanism, but iterating the
// same exported list on both sides cannot catch REMOVALS — deleting any of
// these from STRIP_ENV_KEYS would otherwise pass the whole suite while a
// host value leaks into every session. The literal is split in two so it
// cannot clone STRIP_ENV_KEYS itself past the jscpd threshold — the union
// is what the floor pins.
const FROZEN_STRIP_FLOOR_PROXY_AND_CREDS = [
  'http_proxy',
  'https_proxy',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'all_proxy',
  'ALL_PROXY',
  'HW_ACCESS_KEY',
  'HW_SECRET_KEY',
  'HW_SECURITY_TOKEN',
  'HW_REGION',
  'HUAWEICLOUD_REGION',
  'HCLOUD_CONFIG_PATH',
  'HCLOUD_OBS_CONFIG_PATH',
];
const FROZEN_STRIP_FLOOR_AGENT_STATE = [
  'DSH_HOME',
  'ATOMCODE_HOME',
  'HERMES_HOME',
  'HUAWEICLOUD_DEVKIT_HOME',
  'OFFICE_CLAW_CONFIG_ROOT',
  'OPENCODE_CONFIG_DIR',
  'OPENCODE_CONFIG',
  'OPENCODE_TEST_HOME',
  'DEVKIT_PACKS',
  'HUAWEICLOUD_OPENCODE_PERMISSION_SEAM',
  'HUAWEICLOUD_OPENCODE_ASK_RULE',
];
const FROZEN_STRIP_FLOOR = [...FROZEN_STRIP_FLOOR_PROXY_AND_CREDS, ...FROZEN_STRIP_FLOOR_AGENT_STATE];

function hostileProcessEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: '/usr/bin',
    Path: '/win/bin',
    HOME: '/real/home',
    CODEX_HOME: '/real/codex-home',
    HUAWEICLOUD_HOME: '/real/devkit-home',
    XDG_CONFIG_HOME: '/host/xdg-config',
  };
  // Every strippable key carries a hostile value: the pin must fail on any
  // drive-by edit to the strip list, not just the spot-checked spellings.
  for (const key of STRIP_ENV_KEYS) env[key] = '/hostile';
  env.hw_secret_key = '/hostile-lowercase';
  return env;
}

test('buildCaseEnv strips every STRIP_ENV_KEYS entry case-insensitively', () => {
  const env = buildCaseEnv({ processEnv: hostileProcessEnv(), home: '/tmp/h' });
  for (const key of STRIP_ENV_KEYS) {
    assert.equal(env[key], undefined, `${key} must not survive the trim`);
  }
  for (const key of FROZEN_STRIP_FLOOR) {
    assert.ok(
      STRIP_ENV_KEYS.includes(key as (typeof STRIP_ENV_KEYS)[number]),
      `${key} vanished from STRIP_ENV_KEYS — a deliberate contract edit needs this test updated with it`,
    );
    assert.equal(env[key], undefined, `${key} must not survive the trim`);
  }
  // Exhaustive by construction: the floor must cover every strip key, so a
  // future addition fails here until the floor grows with it.
  assert.equal(
    FROZEN_STRIP_FLOOR.length,
    STRIP_ENV_KEYS.length,
    'FROZEN_STRIP_FLOOR and STRIP_ENV_KEYS have diverged — grow the floor with the list',
  );
  // Case-insensitivity spot-checks beyond the canonical spellings.
  assert.equal(env.hw_secret_key, undefined, 'lowercase hw_secret_key must not survive the trim');
  // HUAWEICLOUD_HOME and CODEX_HOME are not strippable keys, but the home
  // layer relocates both — a host-set codex home must never survive.
  assert.equal(env.HUAWEICLOUD_HOME, '/tmp/h');
  assert.equal(env.CODEX_HOME, join('/tmp/h', '.codex'));
  assert.equal(env.PATH, '/usr/bin');
});

test('buildCaseEnv relocates the home with the full homeOverrides recipe', () => {
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
  assert.equal(env.CODEX_HOME, join(home, '.codex'));
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

test('scrubSecrets replaces both key spellings and skips short values', () => {
  const savedKey = process.env.E2E_APIKEY;
  const savedAlt = process.env.E2E_TEST_API_KEY;
  try {
    process.env.E2E_APIKEY = 'sk-primary-key-value';
    process.env.E2E_TEST_API_KEY = 'sk-alternate-key-value';
    const transcript = 'stdout mentions sk-primary-key-value and also sk-alternate-key-value plus a short one abcdefg';
    const scrubbed = scrubSecrets(transcript);
    assert.ok(!scrubbed.includes('sk-primary-key-value'), 'the primary spelling must be scrubbed');
    assert.ok(!scrubbed.includes('sk-alternate-key-value'), 'the alternate spelling must be scrubbed');
    assert.ok(scrubbed.includes('abcdefg'), 'short values must survive (over-eager scrubbing mangles text)');
    assert.ok(scrubbed.includes('[redacted]'));
  } finally {
    if (savedKey === undefined) delete process.env.E2E_APIKEY;
    else process.env.E2E_APIKEY = savedKey;
    if (savedAlt === undefined) delete process.env.E2E_TEST_API_KEY;
    else process.env.E2E_TEST_API_KEY = savedAlt;
  }
});
