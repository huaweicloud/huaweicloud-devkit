import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { isSupportedNode, sqliteGuidance } from '../plugins/huaweicloud-core/src/node-runtime.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));

test('isSupportedNode matches the declared floor', () => {
  assert.equal(isSupportedNode('22.18.9'), false);
  assert.equal(isSupportedNode('22.19.0'), true);
  assert.equal(isSupportedNode('22.20.0'), true);
  assert.equal(isSupportedNode('23.3.0'), false);
  assert.equal(isSupportedNode('23.4.0'), true);
  assert.equal(isSupportedNode('24.0.0'), true);
  assert.equal(isSupportedNode('v22.19.0'), true);
});

test('sqliteGuidance names the supported floor', () => {
  const guidance = sqliteGuidance('22.11.0');
  assert.match(guidance, /Node\.js >= 22\.19/);
  assert.match(guidance, /23\.4/);
  assert.doesNotMatch(guidance, /22\.5/);
  assert.doesNotMatch(guidance, /22\.13/);
});

test('package and lockfile declare the same node floor', () => {
  assert.equal(pkg.engines.node, '^22.19.0 || >=23.4.0');
  assert.equal(lock.packages[''].engines.node, pkg.engines.node);
});
