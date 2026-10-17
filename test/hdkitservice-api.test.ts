import { test, after } from 'node:test';
import assert from 'node:assert';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

process.env.HW_ACCESS_KEY = 'TESTAK';
process.env.HW_SECRET_KEY = 'TESTSK';
process.env.HDKITSERVICE_ENDPOINT = 'https://example.test/hdkitservice/';

// Every test in this file stubs global.fetch and asserts its envelopes:
// the direct branch of hdkitRequest is the premise. Ambient proxy
// configuration — either env spelling (the resolver reads
// process.env.HTTPS_PROXY || process.env.https_proxy; the https_proxy
// spelling routes these https:// endpoints) or a developer's proxy.json —
// routes the request through the undici dispatcher instead and bypasses
// the stub entirely. Establish "no proxy" from every source the resolver
// reads, for the whole file.
const PROXY_ENV_KEYS = ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy'] as const;
const savedProxyEnv: Record<string, string | undefined> = {};
for (const key of PROXY_ENV_KEYS) {
  savedProxyEnv[key] = process.env[key];
  delete process.env[key];
}
const savedHermeticHome = process.env.HUAWEICLOUD_HOME;
const hermeticHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hdkit-no-proxy-'));
process.env.HUAWEICLOUD_HOME = hermeticHome;

after(() => {
  for (const key of PROXY_ENV_KEYS) {
    if (savedProxyEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedProxyEnv[key];
  }
  if (savedHermeticHome === undefined) delete process.env.HUAWEICLOUD_HOME;
  else process.env.HUAWEICLOUD_HOME = savedHermeticHome;
  fs.rmSync(hermeticHome, { recursive: true, force: true });
});

const { hdkitConnect, hdkitVoucherStatus, hdkitVoucherClaim } =
  await import('../plugins/huaweicloud-core/src/lib/hdkit/hdkitservice-api.ts');
const { clearRuntimeCredentials } = await import('../plugins/huaweicloud-core/src/auth/credentials.ts');

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
      (error) => error,
    );
    assert.ok(err, 'expected hdkitConnect to reject');
    assert.equal(err.message, 'HDKIT_INTERNAL: 服务内部错误 [trace: trace-123]');
    assert.equal(err.code, 'HDKIT_INTERNAL');
    assert.equal(err.status, 500);
    assert.equal(err.traceId, 'trace-123');
    assert.equal(requestedUrl, 'https://example.test/hdkitservice/connect');
  } finally {
    global.fetch = originalFetch;
  }
});

type VoucherResult = {
  claimed: boolean;
  code: unknown;
  message: string;
  remediation?: { hint: string; steps: string[] };
};

test('voucher status returns CRED_MISSING when credentials are absent', async () => {
  const savedAk = process.env.HW_ACCESS_KEY;
  const savedSk = process.env.HW_SECRET_KEY;
  const savedHome = process.env.HUAWEICLOUD_HOME;
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hdkit-test-'));
  try {
    delete process.env.HW_ACCESS_KEY;
    delete process.env.HW_SECRET_KEY;
    process.env.HUAWEICLOUD_HOME = tmpHome;
    clearRuntimeCredentials();

    const result = (await hdkitVoucherStatus()) as VoucherResult;
    assert.equal(result.claimed, false);
    assert.equal(result.code, 'HDKIT_CRED_MISSING');
    assert.match(result.message, /credentials are not configured/);
  } finally {
    if (savedAk === undefined) delete process.env.HW_ACCESS_KEY;
    else process.env.HW_ACCESS_KEY = savedAk;
    if (savedSk === undefined) delete process.env.HW_SECRET_KEY;
    else process.env.HW_SECRET_KEY = savedSk;
    if (savedHome === undefined) delete process.env.HUAWEICLOUD_HOME;
    else process.env.HUAWEICLOUD_HOME = savedHome;
    clearRuntimeCredentials();
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test('voucher claim passes through error code and message on non-2xx', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () =>
    new Response(JSON.stringify({ code: 'HDKIT_INTERNAL', message: '服务内部错误' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  try {
    const result = (await hdkitVoucherClaim('some-domain')) as VoucherResult;
    assert.equal(result.claimed, false);
    assert.equal(result.code, 'HDKIT_INTERNAL');
    assert.match(result.message, /HDKIT_INTERNAL/);
  } finally {
    global.fetch = originalFetch;
  }
});

test('voucher status returns remediation when HDKIT_CRED_INVALID', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () =>
    new Response(JSON.stringify({ code: 'HDKIT_CRED_INVALID', message: '凭证已失效' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  try {
    const result = (await hdkitVoucherStatus()) as VoucherResult;
    assert.equal(result.claimed, false);
    assert.equal(result.code, 'HDKIT_CRED_INVALID');
    assert.ok(result.remediation, 'expected remediation field to exist');
    assert.equal(result.remediation.hint, '已保存的凭证(S1)可能已失效。请执行以下操作之一：');
    assert.ok(Array.isArray(result.remediation.steps));
    assert.equal(result.remediation.steps.length, 3);
    assert.match(result.remediation.steps[0], /huaweicloud_auth_status/);
    assert.match(result.remediation.steps[1], /huaweicloud_auth_switch action=clear/);
    assert.match(result.remediation.steps[2], /auth init/);
  } finally {
    global.fetch = originalFetch;
  }
});

test('voucher claim returns remediation when HDKIT_CRED_INVALID', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () =>
    new Response(JSON.stringify({ code: 'HDKIT_CRED_INVALID', message: '凭证已失效' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  try {
    const result = (await hdkitVoucherClaim('some-domain')) as VoucherResult;
    assert.equal(result.claimed, false);
    assert.equal(result.code, 'HDKIT_CRED_INVALID');
    assert.ok(result.remediation, 'expected remediation field to exist');
    assert.equal(result.remediation.hint, '已保存的凭证(S1)可能已失效。请执行以下操作之一：');
    assert.ok(Array.isArray(result.remediation.steps));
    assert.equal(result.remediation.steps.length, 3);
  } finally {
    global.fetch = originalFetch;
  }
});

test('voucher status does NOT include remediation for non-CRED_INVALID errors', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () =>
    new Response(JSON.stringify({ code: 'HDKIT_INTERNAL', message: '服务内部错误' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  try {
    const result = (await hdkitVoucherStatus()) as VoucherResult;
    assert.equal(result.claimed, false);
    assert.equal(result.code, 'HDKIT_INTERNAL');
    assert.equal(result.remediation, undefined);
  } finally {
    global.fetch = originalFetch;
  }
});
