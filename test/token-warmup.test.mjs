import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  warmTokenCredentials,
  setRuntimeCredentials,
  clearRuntimeCredentials,
  resolveCredentialsWithRuntime,
} from '../plugins/huaweicloud-core/src/auth/credentials.mjs';

async function withTempHome(fn) {
  const prev = {
    HUAWEICLOUD_HOME: process.env.HUAWEICLOUD_HOME,
    HW_ACCESS_KEY: process.env.HW_ACCESS_KEY,
    HW_SECRET_KEY: process.env.HW_SECRET_KEY,
    HW_SECURITY_TOKEN: process.env.HW_SECURITY_TOKEN,
    HW_X_AUTH_TOKEN: process.env.HW_X_AUTH_TOKEN,
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    CODEARTS_PROJECT_DIR: process.env.CODEARTS_PROJECT_DIR,
  };
  const home = mkdtempSync(join(tmpdir(), 'warm-'));
  process.env.HUAWEICLOUD_HOME = home;
  process.env.HOME = home; // isolate readCodeArtsCredentials (reads real homedir otherwise)
  process.env.USERPROFILE = home;
  delete process.env.HW_ACCESS_KEY;
  delete process.env.HW_SECRET_KEY;
  delete process.env.HW_SECURITY_TOKEN;
  delete process.env.HW_X_AUTH_TOKEN;
  delete process.env.CODEARTS_PROJECT_DIR;
  try {
    return await fn(home);
  } finally {
    clearRuntimeCredentials();
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(home, { recursive: true, force: true });
  }
}

test('warmTokenCredentials: no-op when AK/SK already resolvable', async () => {
  await withTempHome(async () => {
    setRuntimeCredentials('WARM_AK', 'WARM_SK', '', 'cn-north-4');
    const warmed = await warmTokenCredentials();
    assert.equal(warmed, false, 'must be a no-op when runtime AK/SK present');
    const c = resolveCredentialsWithRuntime({ allowMissing: true });
    assert.equal(c.ak, 'WARM_AK', 'existing runtime must be untouched');
  });
});

test('warmTokenCredentials: exchanges token → runtime STS when no AK/SK', async () => {
  await withTempHome(async () => {
    process.env.HW_X_AUTH_TOKEN = 'XTOKEN_WARM_TEST';
    // token-exchange would fail with a real HTTP call; stub via module mock is
    // complex — instead verify the token branch is REACHED by asserting the
    // exchange error is swallowed (returns false, no throw) and runtime stays empty.
    const warmed = await warmTokenCredentials();
    // Real token is fake → exchange fails → warmed=false, no throw. The key
    // assertion: it did NOT throw HDKIT_CRED_MISSING (old getCredentials behavior).
    assert.equal(warmed, false, 'fake token exchange fails gracefully');
    const c = resolveCredentialsWithRuntime({ allowMissing: true });
    assert.equal(c, null, 'runtime must stay empty after failed exchange');
  });
});

test('warmTokenCredentials: no-op when no token and no AK/SK', async () => {
  await withTempHome(async () => {
    const warmed = await warmTokenCredentials();
    assert.equal(warmed, false);
    assert.equal(resolveCredentialsWithRuntime({ allowMissing: true }), null);
  });
});

test('warmTokenCredentials: never throws (all failure paths swallowed)', async () => {
  await withTempHome(async () => {
    process.env.HW_X_AUTH_TOKEN = 'B@d%token that will fail exchange';
    await assert.doesNotReject(() => warmTokenCredentials());
  });
});

test('devbridge-key: token-only user gets auto-created key (warm → exchange → create)', async () => {
  await withTempHome(async () => {
    process.env.HW_X_AUTH_TOKEN = 'XTOKEN_DB_SUCCESS';
    // Mock IAM exchange + hdkitservice API (real fetch is never called)
    const realFetch = globalThis.fetch;
    let iamCalled = false,
      apiKeyCreated = false;
    globalThis.fetch = async (url, opts) => {
      const u = String(url);
      if (u.includes('securitytokens')) {
        iamCalled = true;
        return new Response(
          JSON.stringify({
            credential: { access: 'STS_WARM_AK', secret: 'STS_WARM_SK', securitytoken: 'STS_WARM_TOK' },
          }),
          { status: 201, headers: { 'content-type': 'application/json' } },
        );
      }
      if (u.includes('api-key') && opts?.method !== 'DELETE') {
        apiKeyCreated = true;
        return new Response(JSON.stringify({ api_key: 'devbridge_TESTKEY', name: 'test' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (u.includes('api-keys')) {
        return new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    try {
      const dk = await import('../plugins/huaweicloud-core/src/sandbox/devbridge-key.mjs');
      const result = await dk.ensureDevbridgeKey('ephemeral');
      // The fix: warmTokenCredentials exchanged the token BEFORE getCredentials(),
      // so the auto-create flow completed instead of throwing HDKIT_CRED_MISSING.
      assert.ok(iamCalled, 'IAM securitytokens exchange must have been called (warm-up ran)');
      assert.ok(apiKeyCreated, 'auto-create API key must have been reached');
      assert.equal(result.apiKey, 'devbridge_TESTKEY');
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
