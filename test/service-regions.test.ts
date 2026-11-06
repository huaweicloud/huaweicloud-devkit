import assert from 'node:assert/strict';
import test from 'node:test';

import { callTool } from '../plugins/huaweicloud-core/src/tools.ts';
import { SERVICE_REGIONS } from '../plugins/huaweicloud-core/src/services/regions.ts';

// The 18-service list of the pre-migration `known` table in the former
// tools.ts getRegionalAvailability, order included (`kms` joined as the
// dew-family alias after the 2026-11-05 UX report #2 cache-miss probe).
// The hardcode is the migration voucher and the only pin on key-set
// completeness: the `satisfies` check on SERVICE_REGIONS covers the value
// shape only (Record<string, ...> is open-keyed), so this reconciliation is
// what fails when a service is added, dropped, or renamed in the descriptor.
const EXPECTED_SERVICES = [
  'ecs',
  'obs',
  'vpc',
  'iam',
  'rds',
  'gaussdb',
  'cce',
  'modelarts',
  'functiongraph',
  'dew',
  'kms',
  'smn',
  'ces',
  'cts',
  'apig',
  'cbr',
  'dds',
  'dcs',
] as const;

// Shared tail of every hit-path response, byte-exact literals from the
// pre-migration tools.ts (the miss path has neither field, which its own
// deepEqual pins by omission).
const HIT_TAIL = {
  sourcedFrom: 'static cache, update via npm package upgrade',
  disclaimer:
    'This result reflects service-level availability only. It does NOT guarantee that your IAM user has permissions in this region. Account-level restrictions (e.g., APIGW.0802) may block actual API calls even when the service is available.',
};

test('SERVICE_REGIONS covers exactly the 18 migrated services, in order', () => {
  assert.deepEqual(Object.keys(SERVICE_REGIONS), [...EXPECTED_SERVICES]);
});

test('kms mirrors the dew region list (same DEW-managed key family)', () => {
  assert.deepEqual(SERVICE_REGIONS.kms, SERVICE_REGIONS.dew);
});

test('every service has a non-empty, all-lowercase region list', () => {
  for (const [svc, regions] of Object.entries(SERVICE_REGIONS)) {
    assert.ok(regions.length > 0, `${svc} has an empty region list`);
    for (const region of regions) {
      assert.equal(region, region.toLowerCase(), `${svc} region "${region}" is not lowercase`);
    }
  }
});

test('iam is the global-entry service, migrated verbatim', () => {
  assert.deepEqual(SERVICE_REGIONS.iam, ['global']);
});

test('getRegionalAvailability hit path: (ecs, cn-north-4) matches the pre-migration response', async () => {
  const result = await callTool('huaweicloud_get_regional_availability', {
    service: 'ecs',
    region: 'cn-north-4',
  });
  assert.deepEqual(result, {
    ok: true,
    service: 'ecs',
    region: 'cn-north-4',
    known: true,
    available: true,
    note: 'ecs is available in cn-north-4.',
    ...HIT_TAIL,
  });
});

test('getRegionalAvailability lowercases and trims both arguments before the lookup', async () => {
  const result = await callTool('huaweicloud_get_regional_availability', {
    service: ' ECS ',
    region: 'CN-NORTH-4',
  });
  assert.deepEqual(result, {
    ok: true,
    service: 'ecs',
    region: 'cn-north-4',
    known: true,
    available: true,
    note: 'ecs is available in cn-north-4.',
    ...HIT_TAIL,
  });
});

test('getRegionalAvailability hit path: the iam "global" entry makes every region available', async () => {
  const result = await callTool('huaweicloud_get_regional_availability', {
    service: 'iam',
    region: 'cn-north-11',
  });
  assert.deepEqual(result, {
    ok: true,
    service: 'iam',
    region: 'cn-north-11',
    known: true,
    available: true,
    note: 'iam is available in cn-north-11.',
    ...HIT_TAIL,
  });
});

test('getRegionalAvailability hit path: known service, unlisted region stays available:false', async () => {
  const result = await callTool('huaweicloud_get_regional_availability', {
    service: 'rds',
    region: 'cn-mars-1',
  });
  assert.deepEqual(result, {
    ok: true,
    service: 'rds',
    region: 'cn-mars-1',
    known: true,
    available: false,
    note: 'rds availability in cn-mars-1 could not be confirmed. Verify at https://developer.huaweicloud.com/endpoint.',
    ...HIT_TAIL,
  });
});

test('getRegionalAvailability hit path: kms resolves through the dew-family alias', async () => {
  const result = await callTool('huaweicloud_get_regional_availability', {
    service: 'kms',
    region: 'cn-south-1',
  });
  assert.deepEqual(result, {
    ok: true,
    service: 'kms',
    region: 'cn-south-1',
    known: true,
    available: true,
    note: 'kms is available in cn-south-1.',
    ...HIT_TAIL,
  });
});

test('getRegionalAvailability miss path: unlisted service marks itself unknown, not unavailable', async () => {
  const result = await callTool('huaweicloud_get_regional_availability', {
    service: 'dibp',
    region: 'cn-north-4',
  });
  assert.deepEqual(result, {
    ok: false,
    service: 'dibp',
    region: 'cn-north-4',
    known: false,
    available: false,
    note: 'Service dibp is not in the regional availability cache. Run hcloud DIBP --help to verify, or check https://developer.huaweicloud.com/endpoint.',
  });
});

test('getRegionalAvailability requires both service and region', async () => {
  const result = await callTool('huaweicloud_get_regional_availability', {});
  assert.deepEqual(result, { ok: false, error: 'Both service and region are required.' });
});
