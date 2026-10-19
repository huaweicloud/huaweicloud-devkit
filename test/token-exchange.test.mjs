import assert from 'node:assert/strict';
import test from 'node:test';
import { exchangeTokenForCredentials } from '../plugins/huaweicloud-core/src/auth/token-exchange.mjs';

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