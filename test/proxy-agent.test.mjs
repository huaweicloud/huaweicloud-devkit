import { test, mock } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { getProxyDispatcher, clearProxyDispatcherCache, PROXY_TLS_OPTIONS } =
  await import('../plugins/huaweicloud-core/src/proxy/proxy-agent.mjs');

function pushProxyEnv() {
  return {
    https: process.env.HTTPS_PROXY,
    http: process.env.HTTP_PROXY,
    noProxy: process.env.NO_PROXY,
  };
}

function setProxyEnv(saved, https = '', http = '', noProxy = '') {
  if (https) process.env.HTTPS_PROXY = https;
  else delete process.env.HTTPS_PROXY;
  if (http) process.env.HTTP_PROXY = http;
  else delete process.env.HTTP_PROXY;
  if (noProxy) process.env.NO_PROXY = noProxy;
  else delete process.env.NO_PROXY;
  return saved;
}

function restoreProxyEnv(saved) {
  if (saved.https === undefined) delete process.env.HTTPS_PROXY;
  else process.env.HTTPS_PROXY = saved.https;
  if (saved.http === undefined) delete process.env.HTTP_PROXY;
  else process.env.HTTP_PROXY = saved.http;
  if (saved.noProxy === undefined) delete process.env.NO_PROXY;
  else process.env.NO_PROXY = saved.noProxy;
}

test('PROXY_TLS_OPTIONS relaxes both proxy and tunneled target TLS legs', () => {
  assert.deepEqual(PROXY_TLS_OPTIONS, {
    proxyTls: { rejectUnauthorized: false },
    requestTls: { rejectUnauthorized: false },
  });
});

test('getProxyDispatcher returns undefined when no proxy is configured', async () => {
  const saved = pushProxyEnv();
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-agent-test-'));
  const savedHome = process.env.HUAWEICLOUD_HOME;
  try {
    setProxyEnv(saved, '', '', '');
    process.env.HUAWEICLOUD_HOME = tmpHome;
    clearProxyDispatcherCache();

    const dispatcher = await getProxyDispatcher('https://devkit.huaweicloud.com/rest/');
    assert.equal(dispatcher, undefined);
  } finally {
    restoreProxyEnv(saved);
    if (savedHome === undefined) delete process.env.HUAWEICLOUD_HOME;
    else process.env.HUAWEICLOUD_HOME = savedHome;
    clearProxyDispatcherCache();
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test(
  'getProxyDispatcher constructs ProxyAgent with relaxed TLS options',
  { skip: typeof mock?.module !== 'function' },
  async (t) => {
    const saved = pushProxyEnv();
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-agent-test-'));
    const savedHome = process.env.HUAWEICLOUD_HOME;
    let captured = null;

    t.mock.module('undici', {
      exports: {
        ProxyAgent: class {
          constructor(options) {
            captured = options;
          }
          dispatch() {}
        },
      },
    });

    try {
      setProxyEnv(saved, 'http://proxy.internal:8080', '', '');
      process.env.HUAWEICLOUD_HOME = tmpHome;
      clearProxyDispatcherCache();

      await getProxyDispatcher('https://devkit.huaweicloud.com/rest/developer/server/hdkitservice/');

      assert.ok(captured, 'expected ProxyAgent to be constructed');
      assert.equal(captured.uri, 'http://proxy.internal:8080');
      assert.deepEqual(captured.proxyTls, { rejectUnauthorized: false });
      assert.deepEqual(captured.requestTls, { rejectUnauthorized: false });
    } finally {
      restoreProxyEnv(saved);
      if (savedHome === undefined) delete process.env.HUAWEICLOUD_HOME;
      else process.env.HUAWEICLOUD_HOME = savedHome;
      clearProxyDispatcherCache();
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  },
);
