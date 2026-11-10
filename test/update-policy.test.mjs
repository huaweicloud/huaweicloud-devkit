import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  _resetUpgradePolicyCache,
  getUpgradePolicy,
  hdkitPolicyUrl,
} from '../plugins/huaweicloud-core/src/update-policy.mjs';

const ENV = {
  HDKITSERVICE_ENDPOINT: 'https://example.test/hdkitservice',
  HUAWEICLOUD_DEVKIT_SKIP_UPDATE: '',
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('policy URL normalizes the endpoint trailing slash', () => {
  assert.equal(hdkitPolicyUrl(ENV), 'https://example.test/hdkitservice/upgrade/policy');
  assert.equal(
    hdkitPolicyUrl({ HDKITSERVICE_ENDPOINT: 'https://example.test/hdkitservice/' }),
    'https://example.test/hdkitservice/upgrade/policy',
  );
});

test('policy exposes an active minimum version', async () => {
  _resetUpgradePolicyCache();
  let seenUrl = null;
  let seenHeaders = null;
  const policy = await getUpgradePolicy({
    env: ENV,
    doFetch: async (url, opts) => {
      seenUrl = url;
      seenHeaders = opts.headers;
      return jsonResponse({
        schemaVersion: 1,
        minVersion: '1.1.14',
        minVersionActive: true,
        latestStable: '1.1.14',
        latestNext: '1.1.15-next.1',
        upgradeHint: 'hint',
        serverTimeMs: 1,
      });
    },
  });
  assert.equal(seenUrl, 'https://example.test/hdkitservice/upgrade/policy');
  assert.equal(seenHeaders.Accept, 'application/json');
  assert.match(seenHeaders['X-HW-Client-Version'], /^\d+\.\d+\.\d+/);
  assert.deepEqual(policy, {
    minVersion: '1.1.14',
    active: true,
    latestStable: '1.1.14',
    latestNext: '1.1.15-next.1',
    upgradeHint: 'hint',
  });
});

test('policy is inactive when the flag is false or minVersion is invalid', async () => {
  _resetUpgradePolicyCache();
  const inactive = await getUpgradePolicy({
    env: ENV,
    doFetch: async () => jsonResponse({ minVersion: '1.1.14', minVersionActive: false }),
  });
  assert.equal(inactive.active, false);
  assert.equal(inactive.minVersion, '1.1.14');

  _resetUpgradePolicyCache();
  const invalid = await getUpgradePolicy({
    env: ENV,
    doFetch: async () => jsonResponse({ minVersion: 'not-a-version', minVersionActive: true }),
  });
  assert.equal(invalid.active, false);
  assert.equal(invalid.minVersion, '');
});

test('policy failures return null and are throttled', async () => {
  _resetUpgradePolicyCache();
  let calls = 0;
  const doFetch = async () => {
    calls += 1;
    return new Response('{}', { status: 404 });
  };
  const now = Date.now();
  assert.equal(await getUpgradePolicy({ env: ENV, now, doFetch }), null);
  assert.equal(await getUpgradePolicy({ env: ENV, now: now + 60_000, doFetch }), null);
  assert.equal(calls, 1);
});

test('policy is cached for the TTL', async () => {
  _resetUpgradePolicyCache();
  let calls = 0;
  const doFetch = async () => {
    calls += 1;
    return jsonResponse({ minVersion: '1.1.14', minVersionActive: true });
  };
  const now = Date.now();
  await getUpgradePolicy({ env: ENV, now, doFetch });
  await getUpgradePolicy({ env: ENV, now: now + 5 * 60_000, doFetch });
  assert.equal(calls, 1);
});

test('SKIP_UPDATE disables the policy fetch', async () => {
  _resetUpgradePolicyCache();
  let calls = 0;
  const policy = await getUpgradePolicy({
    env: { ...ENV, HUAWEICLOUD_DEVKIT_SKIP_UPDATE: '1' },
    doFetch: async () => {
      calls += 1;
      return jsonResponse({ minVersion: '1.1.14', minVersionActive: true });
    },
  });
  assert.equal(policy, null);
  assert.equal(calls, 0);
});
