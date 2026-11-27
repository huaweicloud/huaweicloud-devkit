import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyConnectionError,
  createConnection,
  CONNECTION_RETRY_BACKOFF_MS,
} from '../plugins/huaweicloud-core/src/lib/hdkit/hwlink-api.ts';
import { clearProxyDispatcherCache } from '../plugins/huaweicloud-core/src/proxy/proxy-agent.ts';

// ---- #997 P0-1: createConnection classification + retry ----

test('classifyConnectionError maps the drifting restriction codes to one transient class (#997)', () => {
  assert.equal(classifyConnectionError({ error_code: 'HDKIT_SUB_ACCOUNT_RESTRICTED' }, 200), 'transient_restricted');
  assert.equal(classifyConnectionError({ error_code: 'HD.83700029' }, 200), 'transient_restricted');
  assert.equal(classifyConnectionError({}, 503), 'retryable_server');
  assert.equal(classifyConnectionError({}, 429), 'retryable_server');
  assert.equal(classifyConnectionError({ error_code: 'HD.9700053' }, 200), 'fatal');
  assert.equal(classifyConnectionError({ error_code: 'HDKIT_CRED_INVALID' }, 401), 'fatal');
  assert.deepEqual([...CONNECTION_RETRY_BACKOFF_MS], [1000, 4000, 10000]);
});

// Force the no-dispatcher branch so the module's global fetch call is mockable
// (same doctrine as hdkitservice-api.test.ts). The handler returns
// Response-shaped stubs ({ status, text }) — readResponseBody reads exactly
// those two, so the cast is the honest boundary. (An env pin like the
// hdkitservice sibling's would be ineffective here: hwlink-api reads
// HWLINK_ENDPOINT at module scope and ESM import hoisting evaluates the
// module before any test-file statement runs; the mocked fetch makes the
// default endpoint value irrelevant anyway.)
type StubResponse = { status: number; text: () => Promise<string> };
function withMockedFetch(
  handler: (url: unknown, opts: unknown) => StubResponse | Promise<StubResponse>,
  fn: () => Promise<unknown>,
): Promise<unknown> {
  const originalFetch = globalThis.fetch;
  const originalProxy = { ...process.env };
  for (const key of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']) delete process.env[key];
  process.env.NO_PROXY = '*';
  clearProxyDispatcherCache();
  globalThis.fetch = handler as unknown as typeof globalThis.fetch;
  return Promise.resolve(fn()).finally(() => {
    globalThis.fetch = originalFetch;
    process.env = originalProxy;
    clearProxyDispatcherCache();
  });
}

const restrictedResponse = {
  status: 200,
  text: async () =>
    JSON.stringify({
      error_code: 'HDKIT_SUB_ACCOUNT_RESTRICTED',
      error_msg: '由于沙箱使用限制，当前子账号暂时无法使用沙箱。请切换主账号后重试。',
    }),
};
const connectedResponse = {
  status: 200,
  text: async () => JSON.stringify({ error_code: '0000', result: { connection_id: 721668 } }),
};
const polledConnectionResponse = {
  status: 200,
  text: async () =>
    JSON.stringify({
      result: {
        connection_id: 721668,
        connection_info: { url: 'https://example.devstation/ws', extensions: { source: 'CLI' } },
      },
    }),
};
// The common real-world gateway-transient shape: 502/503 with an HTML body —
// readResponseBody's text-then-parse turns it into a status-keyed synthetic
// payload instead of dying as a SyntaxError before classification.
const htmlGatewayResponse = {
  status: 503,
  text: async () => '<html><body>Service Unavailable</body></html>',
};

// One POST-counting handler for every retry test (postCalls is read via the
// returned closure; non-POST requests get the polled connection response).
function countingPostHandler(postResponses: Array<() => StubResponse>): {
  postCalls: () => number;
  handler: (url: unknown, opts: unknown) => Promise<StubResponse>;
} {
  let calls = 0;
  return {
    postCalls: () => calls,
    handler: async (_url, opts) => {
      if (String((opts as { method?: string } | undefined)?.method ?? '') === 'POST') {
        const respond = postResponses[Math.min(calls, postResponses.length - 1)]!;
        calls += 1;
        return respond();
      }
      return polledConnectionResponse;
    },
  };
}

test('createConnection retries transient restriction errors and succeeds (#997)', async () => {
  const { postCalls, handler } = countingPostHandler([
    () => restrictedResponse,
    () => restrictedResponse,
    () => connectedResponse,
  ]);
  await withMockedFetch(handler, async () => {
    const result = await createConnection('env1', 'ak', 'sk', '', { backoffMs: [1, 1, 1] });
    assert.equal(result.wsUrl, 'https://example.devstation/ws?source=CLI');
    assert.equal(result.source, 'CLI');
    assert.equal(postCalls(), 3, 'must retry twice before the success');
  });
});

test('createConnection retries 5xx responses with non-JSON bodies (#997 hardening)', async () => {
  // The gateway 503 with an HTML page: text-then-parse turns it into a
  // status-keyed synthetic payload, the retryable_server class fires, and the
  // retry succeeds.
  const { postCalls, handler } = countingPostHandler([() => htmlGatewayResponse, () => connectedResponse]);
  await withMockedFetch(handler, async () => {
    const result = await createConnection('env1', 'ak', 'sk', '', { backoffMs: [1, 1, 1] });
    assert.equal(result.wsUrl, 'https://example.devstation/ws?source=CLI');
    assert.equal(postCalls(), 2, 'the non-JSON 503 must be retried, not thrown as a SyntaxError');
  });
});

test('createConnection exhausts retries and throws a NON-misleading error (#997)', async () => {
  const { postCalls, handler } = countingPostHandler([() => restrictedResponse]);
  await withMockedFetch(handler, async () => {
    await assert.rejects(
      createConnection('env1', 'ak', 'sk', '', { maxRetries: 2, backoffMs: [1, 1] }),
      (err: Error & { code?: string; kind?: string; retryable?: boolean; suggestedRetryAfterMs?: number }) => {
        assert.equal(postCalls(), 3, '1 initial + 2 retries, no more');
        assert.equal(err.code, 'HDKIT_SUB_ACCOUNT_RESTRICTED');
        assert.equal(err.kind, 'transient_restricted');
        assert.match(err.message, /TRANSIENT server-side state, NOT an account problem/);
        assert.match(err.message, /Do NOT switch to the main account/);
        assert.match(err.message, /retry with backoff/);
        assert.ok(err.retryable, 'error must be marked retryable');
        assert.ok((err.suggestedRetryAfterMs ?? 0) > 0, 'must carry a retryAfter suggestion');
        return true;
      },
    );
  });
});

test('the retry-exhausted suggestion is the NEXT wait, not always the max (deliberate divergence)', async () => {
  // maxRetries: 1 with the default [1s, 4s, 10s] ladder — main would suggest
  // the max (10s); v2 suggests the wait the next attempt would use (4s).
  const { handler } = countingPostHandler([() => restrictedResponse]);
  await withMockedFetch(handler, async () => {
    await assert.rejects(
      createConnection('env1', 'ak', 'sk', '', { maxRetries: 1 }),
      (err: { suggestedRetryAfterMs?: number }) => {
        assert.equal(err.suggestedRetryAfterMs, 4000);
        return true;
      },
    );
  });
});

test('the backoff waits actually happen between attempts (#997)', async () => {
  const { handler } = countingPostHandler([() => restrictedResponse, () => connectedResponse]);
  await withMockedFetch(handler, async () => {
    const started = Date.now();
    await createConnection('env1', 'ak', 'sk', '', { backoffMs: [40, 60] });
    const elapsed = Date.now() - started;
    // Wall-clock measurement of a libuv-timer wait: the two clocks carry
    // independent ±1ms rounding, so a genuinely-elapsed 40ms timer reads
    // 39 on the boundary (live: CI run 45928310550, ubuntu-24.04/node24,
    // elapsed 39ms). The 2ms tolerance absorbs the ruler's reading error
    // only — an implementation that does not await the backoff still
    // measures ~0ms and stays red.
    assert.ok(elapsed >= 38, `the first backoff must actually be awaited (elapsed ${elapsed}ms)`);
  });
});

test('createConnection fails fast on fatal (non-transient) errors (#997)', async () => {
  const { postCalls, handler } = countingPostHandler([
    () => ({
      status: 200,
      text: async () => JSON.stringify({ error_code: 'HD.9700053', error_msg: 'no such devenv' }),
    }),
  ]);
  await withMockedFetch(handler, async () => {
    await assert.rejects(createConnection('env1', 'ak', 'sk', '', { backoffMs: [1, 1, 1] }), (err: Error) => {
      assert.equal(postCalls(), 1, 'fatal errors must not be retried');
      assert.match(err.message, /Failed to create connection/);
      return true;
    });
  });
});
