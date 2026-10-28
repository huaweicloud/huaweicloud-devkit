import { test } from 'node:test';
import assert from 'node:assert';

// #1045: huaweicloud_sandbox_connect persist_mode（ephemeral/persistent，缺省向后兼容）
process.env.HW_ACCESS_KEY = 'TESTAK';
process.env.HW_SECRET_KEY = 'TESTSK';
process.env.HDKITSERVICE_ENDPOINT = 'https://example.test/hdkitservice/';

const { hdkitConnect } = await import('../plugins/huaweicloud-core/src/sandbox/hdkitservice-api.mjs');
const { callTool, TOOL_DEFINITIONS } = await import('../plugins/huaweicloud-core/src/tools.mjs');

function withMockFetch(responseBody, run) {
  const originalFetch = global.fetch;
  const captured = { url: null, method: null, body: null, calls: 0 };
  global.fetch = async (url, opts) => {
    captured.calls += 1;
    captured.url = url;
    captured.method = opts?.method;
    captured.body = opts?.body ? JSON.parse(opts.body) : null;
    return new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  return run(captured).finally(() => {
    global.fetch = originalFetch;
  });
}

test('#1045 A1: explicit persist_mode is forwarded in the connect request body', async () => {
  for (const mode of ['persistent', 'ephemeral']) {
    await withMockFetch({ session_id: 's-1' }, async (captured) => {
      await hdkitConnect({ persist_mode: mode });
      assert.equal(captured.url, 'https://example.test/hdkitservice/connect');
      assert.equal(captured.method, 'POST');
      assert.equal(captured.body.persist_mode, mode);
    });
  }
});

test('#1045 A2: omitting persist_mode keeps the request body byte-identical to legacy (key absent)', async () => {
  await withMockFetch({ session_id: 's-1' }, async (captured) => {
    await hdkitConnect({});
    assert.equal(captured.calls, 1);
    assert.equal(
      Object.hasOwn(captured.body, 'persist_mode'),
      false,
      'persist_mode key must NOT exist when omitted (backward compatibility)',
    );
    assert.deepEqual(Object.keys(captured.body), []);
  });
});

test('#1045 A3: invalid persist_mode fails fast with a param error naming valid values', async () => {
  let fetchCalled = false;
  const originalFetch = global.fetch;
  global.fetch = async () => {
    fetchCalled = true;
    throw new Error('fetch must not be called for invalid params');
  };
  try {
    const err = await callTool('huaweicloud_sandbox_connect', { persist_mode: 'bogus' }).then(
      () => null,
      (error) => error,
    );
    assert.ok(err, 'expected callTool to reject');
    assert.match(err.message, /persist_mode/);
    assert.match(err.message, /ephemeral/);
    assert.match(err.message, /persistent/);
    assert.equal(fetchCalled, false);
  } finally {
    global.fetch = originalFetch;
  }
});

test('#1045 A4: tool schema documents both modes and the default-omitted semantics', () => {
  const tool = TOOL_DEFINITIONS.find((t) => t.name === 'huaweicloud_sandbox_connect');
  assert.ok(tool, 'huaweicloud_sandbox_connect tool definition missing');
  const prop = tool.inputSchema.properties.persist_mode;
  assert.ok(prop, 'persist_mode property missing from inputSchema');
  assert.deepEqual(prop.enum, ['ephemeral', 'persistent']);
  assert.match(prop.description, /ephemeral/);
  assert.match(prop.description, /persistent/);
  assert.match(prop.description, /default/i);
});

test('#1045 extra: connect result passes through sandbox_mode metadata when the server reports it', async () => {
  await withMockFetch({ session_id: 's-1', persist_mode: 'persistent' }, async () => {
    const result = await callTool('huaweicloud_sandbox_connect', { persist_mode: 'persistent' });
    assert.equal(result.sandbox_mode, 'persistent');
  });
});

test('#1045 extra: connect result does NOT hardcode sandbox_mode when the server omits it', async () => {
  await withMockFetch({ session_id: 's-1' }, async () => {
    const result = await callTool('huaweicloud_sandbox_connect', {});
    assert.equal(Object.hasOwn(result, 'sandbox_mode'), false);
  });
});
