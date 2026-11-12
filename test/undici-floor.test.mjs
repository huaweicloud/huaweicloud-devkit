import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

import { isSupportedNode } from '../plugins/huaweicloud-core/src/node-runtime.mjs';

const require = createRequire(import.meta.url);
const supported = isSupportedNode(process.versions.node);
const skipUnsupported = supported ? false : 'Node.js >= 22.19 required';

test('undici loads on the supported node floor', { skip: skipUnsupported }, () => {
  assert.doesNotThrow(() => require('undici'));
});
