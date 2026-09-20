import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  shouldBypassProxy,
  getProxySettings,
  writeProxyConfig,
  proxyConfigPath,
} from '../plugins/huaweicloud-core/src/proxy/proxy-config.mjs';

function withIsolatedHome(fn) {
  const home = mkdtempSync(join(tmpdir(), 'proxy-config-test-'));
  const prev = process.env.HUAWEICLOUD_HOME;
  const savedEnv = {
    HTTPS_PROXY: process.env.HTTPS_PROXY,
    HTTP_PROXY: process.env.HTTP_PROXY,
    NO_PROXY: process.env.NO_PROXY,
    https_proxy: process.env.https_proxy,
    http_proxy: process.env.http_proxy,
    no_proxy: process.env.no_proxy,
  };
  process.env.HUAWEICLOUD_HOME = home;
  delete process.env.HTTPS_PROXY;
  delete process.env.HTTP_PROXY;
  delete process.env.NO_PROXY;
  delete process.env.https_proxy;
  delete process.env.http_proxy;
  delete process.env.no_proxy;
  try {
    return fn(home);
  } finally {
    if (prev === undefined) delete process.env.HUAWEICLOUD_HOME;
    else process.env.HUAWEICLOUD_HOME = prev;
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(home, { recursive: true, force: true });
  }
}

test('shouldBypassProxy returns true for IPv4 inside CIDR /8', () => {
  assert.equal(shouldBypassProxy('10.0.0.5', ['10.0.0.0/8']), true);
  assert.equal(shouldBypassProxy('10.255.255.255', ['10.0.0.0/8']), true);
});

test('shouldBypassProxy returns false for IPv4 outside CIDR /8', () => {
  assert.equal(shouldBypassProxy('11.0.0.1', ['10.0.0.0/8']), false);
  assert.equal(shouldBypassProxy('192.168.1.1', ['10.0.0.0/8']), false);
});

test('shouldBypassProxy handles /24 CIDR boundary correctly', () => {
  assert.equal(shouldBypassProxy('192.168.1.1', ['192.168.1.0/24']), true);
  assert.equal(shouldBypassProxy('192.168.1.254', ['192.168.1.0/24']), true);
  assert.equal(shouldBypassProxy('192.168.2.1', ['192.168.1.0/24']), false);
});

test('shouldBypassProxy handles /32 (single host) CIDR', () => {
  assert.equal(shouldBypassProxy('10.0.0.5', ['10.0.0.5/32']), true);
  assert.equal(shouldBypassProxy('10.0.0.6', ['10.0.0.5/32']), false);
});

test('shouldBypassProxy handles /0 (match all IPv4) CIDR', () => {
  assert.equal(shouldBypassProxy('8.8.8.8', ['0.0.0.0/0']), true);
  assert.equal(shouldBypassProxy('1.2.3.4', ['0.0.0.0/0']), true);
});

test('shouldBypassProxy supports IPv6 CIDR', () => {
  assert.equal(shouldBypassProxy('::1', ['::1/128']), true);
  assert.equal(shouldBypassProxy('::2', ['::1/128']), false);
  assert.equal(shouldBypassProxy('fd00::1', ['fd00::/8']), true);
  assert.equal(shouldBypassProxy('fe00::1', ['fd00::/8']), false);
});

test('shouldBypassProxy supports IPv4-mapped IPv6 against IPv4 CIDR', () => {
  assert.equal(shouldBypassProxy('::ffff:10.0.0.5', ['10.0.0.0/8']), true);
});

test('shouldBypassProxy does not match a hostname against a CIDR', () => {
  // Hostnames are never in a CIDR — suffix matching handles them.
  assert.equal(shouldBypassProxy('myhost.internal', ['10.0.0.0/8']), false);
});

test('shouldBypassProxy keeps existing suffix/wildcard matching intact', () => {
  assert.equal(shouldBypassProxy('example.com', ['example.com']), true);
  assert.equal(shouldBypassProxy('api.example.com', ['.example.com']), true);
  assert.equal(shouldBypassProxy('api.example.com', ['*.example.com']), true);
  assert.equal(shouldBypassProxy('anything', ['*']), true);
  assert.equal(shouldBypassProxy('foo.internal', ['internal']), true);
});

test('shouldBypassProxy ignores malformed CIDR patterns (falls through to suffix)', () => {
  // A pattern with '/' that is not a valid CIDR must not crash; it should be
  // treated as a plain hostname pattern (no suffix match here → false).
  assert.equal(shouldBypassProxy('10.0.0.5', ['not-a-cidr/abc']), false);
  assert.equal(shouldBypassProxy('10.0.0.5', ['999.999.999.999/8']), false);
});

test('shouldBypassProxy handles multiple no_proxy entries with mixed CIDR + host', () => {
  const list = ['localhost', '10.0.0.0/8', '.internal'];
  assert.equal(shouldBypassProxy('localhost', list), true);
  assert.equal(shouldBypassProxy('10.1.2.3', list), true);
  assert.equal(shouldBypassProxy('svc.internal', list), true);
  assert.equal(shouldBypassProxy('203.0.113.5', list), false);
});

test('getProxySettings returns null for CIDR-matched target via env NO_PROXY', () => {
  withIsolatedHome(() => {
    process.env.HTTPS_PROXY = 'http://proxy.internal:8080';
    process.env.NO_PROXY = '10.0.0.0/8';
    const settings = getProxySettings('http://10.0.0.5');
    assert.equal(settings, null);
  });
});

test('getProxySettings returns null for CIDR-matched target via file no_proxy', () => {
  withIsolatedHome((home) => {
    process.env.HTTPS_PROXY = 'http://proxy.internal:8080';
    const cfgDir = join(home, '.config', 'huaweicloud');
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(join(cfgDir, 'proxy.json'), JSON.stringify({ https_proxy: '', no_proxy: '10.0.0.0/8' }), 'utf8');
    // File no_proxy is used when env NO_PROXY is absent.
    delete process.env.NO_PROXY;
    const settings = getProxySettings('http://10.0.0.5');
    assert.equal(settings, null);
  });
});

test('getProxySettings returns proxy settings for IP outside CIDR', () => {
  withIsolatedHome(() => {
    process.env.HTTPS_PROXY = 'http://proxy.internal:8080';
    process.env.HTTP_PROXY = 'http://proxy.internal:8080';
    process.env.NO_PROXY = '10.0.0.0/8';
    const settings = getProxySettings('http://192.168.1.1');
    assert.ok(settings, 'expected proxy settings for out-of-CIDR target');
    assert.equal(settings.proxyUrl, 'http://proxy.internal:8080');
  });
});

test('getProxySettings returns null for IPv6 CIDR-matched target', () => {
  withIsolatedHome(() => {
    process.env.HTTPS_PROXY = 'http://proxy.internal:8080';
    process.env.NO_PROXY = 'fd00::/8';
    const settings = getProxySettings('http://[fd00::1]:8080');
    assert.equal(settings, null);
  });
});

test('writeProxyConfig round-trips no_proxy with CIDR entries', () => {
  withIsolatedHome(() => {
    writeProxyConfig({ https_proxy: 'http://proxy:8080', no_proxy: '10.0.0.0/8,::1/128,localhost' });
    // Read the written file directly to avoid env-var races with concurrent tests.
    const cfg = JSON.parse(readFileSync(proxyConfigPath(), 'utf8'));
    assert.ok(cfg.no_proxy.includes('10.0.0.0/8'));
    assert.ok(cfg.no_proxy.includes('::1/128'));
  });
});
