import assert from 'node:assert/strict';
import test from 'node:test';

import { needsSqliteFlag, sqliteGuidance, sqliteSupport } from '../plugins/huaweicloud-core/src/node-runtime.mjs';

test('sqliteSupport classifies the node floor and flag ranges', () => {
  assert.equal(sqliteSupport('22.4.0'), 'unsupported');
  assert.equal(sqliteSupport('22.5.0'), 'flag');
  assert.equal(sqliteSupport('22.12.9'), 'flag');
  assert.equal(sqliteSupport('22.13.0'), 'ok');
  assert.equal(sqliteSupport('23.3.0'), 'flag');
  assert.equal(sqliteSupport('23.4.0'), 'ok');
  assert.equal(sqliteSupport('24.0.0'), 'ok');
});

test('needsSqliteFlag matches the flag ranges', () => {
  assert.equal(needsSqliteFlag('22.4.0'), false);
  assert.equal(needsSqliteFlag('22.5.0'), true);
  assert.equal(needsSqliteFlag('22.12.9'), true);
  assert.equal(needsSqliteFlag('22.13.0'), false);
  assert.equal(needsSqliteFlag('23.3.0'), true);
  assert.equal(needsSqliteFlag('23.4.0'), false);
  assert.equal(needsSqliteFlag('24.0.0'), false);
});

test('sqliteGuidance sticks to the declared node floor', () => {
  const flagGuidance = sqliteGuidance('22.11.0');
  assert.match(flagGuidance, /Node\.js >= 22\.5/);
  assert.match(flagGuidance, /--experimental-sqlite/);
  assert.doesNotMatch(flagGuidance, /22\.13/);

  const unsupportedGuidance = sqliteGuidance('22.4.0');
  assert.match(unsupportedGuidance, /Node\.js >= 22\.5/);
  assert.doesNotMatch(unsupportedGuidance, /--experimental-sqlite/);
});
