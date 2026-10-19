import assert from 'node:assert/strict';
import test from 'node:test';

import { exchangeTokenForCredentials, getTokenCredentials, __resetTokenCache } from '../plugins/huaweicloud-core/src/auth/token-exchange.mjs';

function stubFetch(status, body) {
  return async (url, opts) => ({
    status,
    json: async () => body,
    _url: url,
    _opts: opts,
  });
}

test('exchangeTokenForCredentials returns temporary credential when 201', async () => {
  const response = {
    credential: {
      access: 'TEMP_AK',
      secret: 'TEMP_SK',
      securitytoken: 'TEMP_STS',
      expires_at: '2026-10-20T08:56:33.710000Z',
    },
  };
  let captured;
  const fetchImpl = async (url, opts) => {
    captured = { url, opts };
    return { status: 201, json: async () => response };
  };
  const result = await exchangeTokenForCredentials('the-token', { fetchImpl });
  assert.deepEqual(result, {
    ak: 'TEMP_AK',
    sk: 'TEMP_SK',
    securityToken: 'TEMP_STS',
    expiresAt: Date.parse('2026-10-20T08:56:33.710000Z'),
  });
  assert.match(captured.url, /\/v3\.0\/OS-CREDENTIAL\/securitytokens$/);
  const body = JSON.parse(captured.opts.body);
  assert.deepEqual(body.auth.identity.methods, ['token']);
  assert.equal(body.auth.identity.token.id, 'the-token');
  assert.equal(body.auth.identity.token.duration_seconds, 900);
});

test('exchangeTokenForCredentials throws TOKEN_INVALID on 401', async () => {
  await assert.rejects(
    exchangeTokenForCredentials('bad-token', { fetchImpl: stubFetch(401, {}) }),
    (err) => err.code === 'TOKEN_INVALID',
  );
});

test('exchangeTokenForCredentials throws TOKEN_EXCHANGE_FAILED on non-201', async () => {
  await assert.rejects(
    exchangeTokenForCredentials('bad-token', { fetchImpl: stubFetch(500, {}) }),
    (err) => err.code === 'TOKEN_EXCHANGE_FAILED',
  );
});

test('getTokenCredentials caches the result and avoids re-exchange while valid', async () => {
  __resetTokenCache();
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return {
      status: 201,
      json: async () => ({
        credential: {
          access: 'AK',
          secret: 'SK',
          securitytoken: 'STS',
          expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
        },
      }),
    };
  };
  const a = await getTokenCredentials('t', { fetchImpl });
  const b = await getTokenCredentials('t', { fetchImpl });
  assert.equal(calls, 1, 'second call should hit cache');
  assert.equal(a.ak, b.ak);
  __resetTokenCache();
});

test('getTokenCredentials re-exchanges when cached credential is expired', async () => {
  __resetTokenCache();
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return {
      status: 201,
      json: async () => ({
        credential: {
          access: 'AK' + calls,
          secret: 'SK',
          securitytoken: 'STS',
          expires_at: new Date(Date.now() - 1000).toISOString(), // 已过期
        },
      }),
    };
  };
  const a = await getTokenCredentials('t', { fetchImpl });
  const b = await getTokenCredentials('t', { fetchImpl });
  assert.equal(calls, 2, 'expired credential should force re-exchange');
  assert.notEqual(a.ak, b.ak);
  __resetTokenCache();
});
