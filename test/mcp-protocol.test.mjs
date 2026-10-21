import assert from 'node:assert/strict';
import { test } from 'node:test';

import { dispatch } from '../plugins/huaweicloud-core/src/mcp-protocol.mjs';

// ============================================================================
// #817 D9-2: tools/list params type validation
// The tools/list branch must reject non-object params (string/number/boolean/
// array) with JSON-RPC -32602 Invalid params, while accepting omitted params
// (undefined/null) per the JSON-RPC 2.0 spec — aligning with the tools/call
// branch's existing -32602 validation pattern.
// ============================================================================

test('#817 tools/list with non-object params returns JSON-RPC -32602', async () => {
  for (const bad of ['string', 42, true, [1, 2], []]) {
    await assert.rejects(
      () => dispatch('tools/list', bad),
      (err) => {
        assert.equal(err.code, -32602, `params=${JSON.stringify(bad)} should yield -32602`);
        assert.match(err.message, /Invalid params/i);
        return true;
      },
    );
  }
});

test('#817 tools/list with omitted params (undefined/null) returns tool list', async () => {
  // undefined — JSON-RPC spec allows omitting params
  const rUndefined = await dispatch('tools/list', undefined);
  assert.ok(Array.isArray(rUndefined.tools), 'undefined params should return tools array');
  assert.ok(rUndefined.tools.length > 0, 'tools array should be non-empty');

  // null — treat as omitted, return tool list normally
  const rNull = await dispatch('tools/list', null);
  assert.ok(Array.isArray(rNull.tools), 'null params should return tools array');
  assert.ok(rNull.tools.length > 0, 'tools array should be non-empty');
});
