import assert from 'node:assert/strict';
import test from 'node:test';

import { isDebugEnv } from '../plugins/huaweicloud-core/src/debug-env.mjs';

test('isDebugEnv true when HUAWEICLOUD_DEVKIT_DEBUG=1', () => {
  assert.equal(isDebugEnv('1'), true);
});

test('isDebugEnv true when HUAWEICLOUD_DEVKIT_DEBUG=true', () => {
  assert.equal(isDebugEnv('true'), true);
});

test('isDebugEnv false for unset/empty', () => {
  assert.equal(isDebugEnv(undefined), false);
  assert.equal(isDebugEnv(''), false);
});

test('isDebugEnv false for other values', () => {
  for (const value of ['0', 'false', 'TRUE', 'True', 'yes', 'on', '2', ' true']) {
    assert.equal(isDebugEnv(value), false, `value=${value}`);
  }
});

test('isDebugEnv reads process.env by default', () => {
  const prev = process.env.HUAWEICLOUD_DEVKIT_DEBUG;
  try {
    process.env.HUAWEICLOUD_DEVKIT_DEBUG = '1';
    assert.equal(isDebugEnv(), true);
    process.env.HUAWEICLOUD_DEVKIT_DEBUG = 'true';
    assert.equal(isDebugEnv(), true);
    process.env.HUAWEICLOUD_DEVKIT_DEBUG = '';
    assert.equal(isDebugEnv(), false);
  } finally {
    if (prev === undefined) delete process.env.HUAWEICLOUD_DEVKIT_DEBUG;
    else process.env.HUAWEICLOUD_DEVKIT_DEBUG = prev;
  }
});
