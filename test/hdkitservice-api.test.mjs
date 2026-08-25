import { test } from 'node:test';
import assert from 'node:assert';

process.env.HW_ACCESS_KEY = 'TESTAK';
process.env.HW_SECRET_KEY = 'TESTSK';
process.env.HDKITSERVICE_ENDPOINT = 'https://example.test/hdkitservice/';

const { hdkitConnect } = await import('../plugins/huaweicloud-core/src/sandbox/hdkitservice-api.mjs');

test('hdkitservice connect parses backend traceId (camelCase) on error', async () => {
  const originalFetch = global.fetch;
  let requestedUrl = null;
  global.fetch = async (url, _opts) => {
    requestedUrl = url;
    return new Response(
      JSON.stringify({
        code: 'HDKIT_INTERNAL',
        message: '服务内部错误',
        traceId: 'trace-123',
      }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  };

  try {
    const err = await hdkitConnect({}).then(
      () => null,
      (e) => e,
    );
    assert.ok(err, 'expected hdkitConnect to reject');
    assert.equal(err.message, '服务内部错误');
    assert.equal(err.code, 'HDKIT_INTERNAL');
    assert.equal(err.status, 500);
    assert.equal(err.traceId, 'trace-123');
    assert.equal(requestedUrl, 'https://example.test/hdkitservice/connect');
  } finally {
    global.fetch = originalFetch;
  }
});
