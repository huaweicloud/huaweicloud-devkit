import assert from 'node:assert/strict';
import test from 'node:test';

process.env.HUAWEICLOUD_ICONS_OFFLINE = '1';

const { getServiceIcon } = await import('../plugins/huaweicloud-core/src/icon-library.mjs');

test('icon library resolves english service ids from the bundled snapshot', async () => {
  const result = await getServiceIcon('ecs');
  assert.equal(result.ok, true);
  assert.equal(result.source, 'snapshot');
  assert.ok(result.count >= 1);
  assert.equal(result.results[0].id, 'ecs');
  assert.match(result.results[0].logo.source_url, /^https:\/\//);
  assert.equal(typeof result.results[0].name, 'string');
});

test('icon library resolves chinese service names', async () => {
  const result = await getServiceIcon('对象存储');
  assert.equal(result.ok, true);
  assert.ok(
    result.results.some((r) => r.id === 'obs'),
    'expected OBS for 对象存储',
  );
});

test('icon library resolves aliases and case-insensitive queries', async () => {
  const result = await getServiceIcon('MODELARTS');
  assert.equal(result.ok, true);
  assert.ok(result.results.some((r) => r.id === 'modelarts'));
});

test('icon library filters by category', async () => {
  const result = await getServiceIcon('', '存储');
  assert.equal(result.ok, true);
  assert.ok(result.results.length > 0);
  for (const r of result.results) {
    assert.equal(r.category, '存储');
  }
});

test('icon library returns zero results for unknown services', async () => {
  const result = await getServiceIcon('zzz-not-a-service');
  assert.equal(result.ok, true);
  assert.equal(result.count, 0);
  assert.deepEqual(result.results, []);
});
