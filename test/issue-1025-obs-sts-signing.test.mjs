import assert from 'node:assert/strict';
import test from 'node:test';

import { callTool } from '../plugins/huaweicloud-core/src/tools.mjs';
import { clearProxyDispatcherCache } from '../plugins/huaweicloud-core/src/proxy/proxy-agent.mjs';

// ---- #1025: obsSignedRequest must include x-amz-security-token in the AWS4
// signature when STS credentials carry a securityToken, and must not change
// behavior for permanent AK/SK credentials. ----

function withMockedFetch(handler, fn, { securityToken = '' } = {}) {
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };
  for (const key of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']) delete process.env[key];
  process.env.NO_PROXY = '*';
  process.env.HW_ACCESS_KEY = 'test-ak';
  process.env.HW_SECRET_KEY = 'test-sk';
  process.env.HW_SECURITY_TOKEN = securityToken;
  clearProxyDispatcherCache();
  globalThis.fetch = handler;
  return Promise.resolve(fn()).finally(() => {
    globalThis.fetch = originalFetch;
    process.env = originalEnv;
    clearProxyDispatcherCache();
  });
}

test('STS credentials: SignedHeaders and sent headers both contain x-amz-security-token (#1025)', async () => {
  let seen;
  await withMockedFetch(
    async (url, opts) => {
      seen = { url: String(url), headers: opts?.headers };
      return {
        status: 200,
        text: async () =>
          '<WebsiteConfiguration><IndexDocument><Suffix>index.html</Suffix></IndexDocument></WebsiteConfiguration>',
      };
    },
    async () => {
      const res = await callTool('huaweicloud_obs_set_website_config', {
        action: 'set',
        bucket: 'my-bucket',
        region: 'cn-north-4',
        indexDocument: 'index.html',
      });
      assert.equal(res.ok, true);
      assert.equal(seen.headers['x-amz-security-token'], 'sts-test-token');
      assert.match(
        seen.headers.Authorization,
        /SignedHeaders=host;x-amz-content-sha256;x-amz-date;x-amz-security-token,/,
        'SignedHeaders must list x-amz-security-token when STS credentials are used',
      );
    },
    { securityToken: 'sts-test-token' },
  );
});

test('permanent AK/SK: SignedHeaders unchanged, no security-token header sent (#1025 regression)', async () => {
  let seen;
  await withMockedFetch(
    async (url, opts) => {
      seen = { url: String(url), headers: opts?.headers };
      return {
        status: 200,
        text: async () =>
          '<WebsiteConfiguration><IndexDocument><Suffix>index.html</Suffix></IndexDocument></WebsiteConfiguration>',
      };
    },
    async () => {
      const res = await callTool('huaweicloud_obs_set_website_config', {
        action: 'set',
        bucket: 'my-bucket',
        region: 'cn-north-4',
        indexDocument: 'index.html',
      });
      assert.equal(res.ok, true);
      assert.equal('x-amz-security-token' in seen.headers, false);
      assert.match(
        seen.headers.Authorization,
        /SignedHeaders=host;x-amz-content-sha256;x-amz-date,/,
        'SignedHeaders must stay unchanged for permanent credentials',
      );
    },
  );
});
