import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  classifyConnectionError,
  createConnection,
  CONNECTION_RETRY_BACKOFF_MS,
} from '../plugins/huaweicloud-core/src/sandbox/hwlink-api.mjs';
import { clearProxyDispatcherCache } from '../plugins/huaweicloud-core/src/proxy/proxy-agent.mjs';
import {
  buildDevbridgeAuthProbe,
  parseDevbridgeAuthOutput,
  evaluateDevbridgeVersion,
  buildDevbridgeExposeScript,
  buildDevbridgeVerifyScript,
} from '../plugins/huaweicloud-core/src/sandbox/session-manager.mjs';
import { classifyTextCommand } from '../plugins/huaweicloud-core/src/safety-policy.mjs';

const pluginRoot = join(import.meta.dirname, '..', 'plugins', 'huaweicloud-core');

// ---- #997 P0-1: createConnection classification + retry ----

test('classifyConnectionError maps the drifting restriction codes to one transient class (#997)', () => {
  assert.equal(classifyConnectionError({ error_code: 'HDKIT_SUB_ACCOUNT_RESTRICTED' }, 200), 'transient_restricted');
  assert.equal(classifyConnectionError({ error_code: 'HD.83700029' }, 200), 'transient_restricted');
  assert.equal(classifyConnectionError({}, 503), 'retryable_server');
  assert.equal(classifyConnectionError({}, 429), 'retryable_server');
  assert.equal(classifyConnectionError({ error_code: 'HD.9700053' }, 200), 'fatal');
  assert.equal(classifyConnectionError({ error_code: 'HDKIT_CRED_INVALID' }, 401), 'fatal');
});

function withMockedFetch(handler, fn) {
  const originalFetch = globalThis.fetch;
  const originalProxy = { ...process.env };
  // Force the no-dispatcher branch so the module's global fetch call is mockable.
  for (const key of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']) delete process.env[key];
  process.env.NO_PROXY = '*';
  clearProxyDispatcherCache();
  globalThis.fetch = handler;
  return Promise.resolve(fn()).finally(() => {
    globalThis.fetch = originalFetch;
    process.env = originalProxy;
    clearProxyDispatcherCache();
  });
}

const restrictedResponse = {
  status: 200,
  json: async () => ({
    error_code: 'HDKIT_SUB_ACCOUNT_RESTRICTED',
    error_msg: '由于沙箱使用限制，当前子账号暂时无法使用沙箱。请切换主账号后重试。',
  }),
};
const connectedResponse = {
  status: 200,
  json: async () => ({ error_code: '0000', result: { connection_id: 721668 } }),
};
const polledConnectionResponse = {
  status: 200,
  json: async () => ({
    result: {
      connection_id: 721668,
      connection_info: { url: 'https://example.devstation/ws', extensions: { source: 'CLI' } },
    },
  }),
};

test('createConnection retries transient restriction errors and succeeds (#997)', async () => {
  let postCalls = 0;
  await withMockedFetch(
    (url, opts) => {
      if (opts?.method === 'POST') {
        postCalls += 1;
        return postCalls <= 2 ? restrictedResponse : connectedResponse;
      }
      return polledConnectionResponse;
    },
    async () => {
      const result = await createConnection('env1', 'ak', 'sk', undefined, { backoffMs: [1, 1, 1] });
      assert.equal(result.wsUrl, 'https://example.devstation/ws?source=CLI');
      assert.equal(result.source, 'CLI');
      assert.equal(postCalls, 3, 'must retry twice before the success');
    },
  );
});

test('createConnection exhausts retries and throws a NON-misleading error (#997)', async () => {
  let postCalls = 0;
  await withMockedFetch(
    (url, opts) => {
      if (opts?.method === 'POST') {
        postCalls += 1;
        return restrictedResponse;
      }
      return polledConnectionResponse;
    },
    async () => {
      await assert.rejects(
        createConnection('env1', 'ak', 'sk', undefined, { maxRetries: 2, backoffMs: [1, 1] }),
        (err) => {
          assert.equal(postCalls, 3, '1 initial + 2 retries, no more');
          assert.equal(err.code, 'HDKIT_SUB_ACCOUNT_RESTRICTED');
          assert.equal(err.kind, 'transient_restricted');
          assert.match(err.message, /TRANSIENT server-side state, NOT an account problem/);
          assert.match(err.message, /Do NOT switch to the main account/);
          assert.match(err.message, /retry with backoff/);
          assert.ok(err.retryable, 'error must be marked retryable');
          assert.ok(err.suggestedRetryAfterMs > 0, 'must carry a retryAfter suggestion');
          return true;
        },
      );
    },
  );
});

test('createConnection fails fast on fatal (non-transient) errors (#997)', async () => {
  let postCalls = 0;
  await withMockedFetch(
    (url, opts) => {
      if (opts?.method === 'POST') {
        postCalls += 1;
        return { status: 200, json: async () => ({ error_code: 'HD.9700053', error_msg: 'no such devenv' }) };
      }
      return polledConnectionResponse;
    },
    async () => {
      await assert.rejects(createConnection('env1', 'ak', 'sk', undefined, { backoffMs: [1, 1, 1] }), (err) => {
        assert.equal(postCalls, 1, 'fatal errors must not be retried');
        assert.match(err.message, /Failed to create connection/);
        return true;
      });
    },
  );
});

test('CONNECTION_RETRY_BACKOFF_MS defaults to three spaced retries (#997)', () => {
  assert.equal(CONNECTION_RETRY_BACKOFF_MS.length, 3);
  for (const ms of CONNECTION_RETRY_BACKOFF_MS) assert.ok(ms >= 1000, 'default backoff must be >= 1s');
});

// ---- #998 P0-2: devbridge version probe inside the auth waterfall ----

test('buildDevbridgeAuthProbe probes the version in the same exec and prepends the workspace bin (#998/#999)', () => {
  const script = buildDevbridgeAuthProbe();
  assert.match(script, /DB_VERSION=\$\(devbridge version 2>\/dev\/null \| head -1\)/);
  assert.match(script, /echo "DB_VERSION=\$\{DB_VERSION\}"/);
  assert.match(script, /export PATH="\/workspace\/\.local\/bin:\$HOME\/\.huawei\/bin:\$PATH"/);
});

test('parseDevbridgeAuthOutput returns the probed version, OSC-escape safe (#998)', () => {
  const osc = '\x1b]133;C\x07';
  const stdout = `${osc}DB_VERSION=0.1.13-release\n${osc}DB_AUTH_MODE=AKSK_SUPPORTED\n`;
  const parsed = parseDevbridgeAuthOutput(stdout);
  assert.equal(parsed.version, '0.1.13-release');
  assert.equal(parsed.authMode, 'AKSK_SUPPORTED');

  const empty = parseDevbridgeAuthOutput('DB_AUTH_MODE=NO_CREDENTIAL\n');
  assert.equal(empty.version, '', 'missing version probe must yield an empty version, not a crash');
});

test('evaluateDevbridgeVersion blocks 0.1.x with devbridge_too_old + remediation (#998)', () => {
  const blocked = evaluateDevbridgeVersion('0.1.13-release');
  assert.equal(blocked.blocked, true);
  assert.match(blocked.error, /devbridge_too_old/);
  assert.match(blocked.error, /0\.1\.13-release/);
  assert.match(blocked.remediation, /Step 0/);
  assert.match(blocked.remediation, /workspace\/\.local\/bin/);

  assert.equal(evaluateDevbridgeVersion('0.2.2-release').blocked, false);
  assert.equal(evaluateDevbridgeVersion('').blocked, false, 'absent binary must not block — auth handles it');
  assert.equal(evaluateDevbridgeVersion(undefined).blocked, false);
});

test('expose/verify scripts bypass the injected proxy on tunnel probes (#1000)', () => {
  const exposeScript = buildDevbridgeExposeScript(8080);
  assert.match(exposeScript, /curl -s --noproxy '\*' -o \/tmp\/\.db_probe_body/);

  const verifyScript = buildDevbridgeVerifyScript('https://abc12345-8080.devbridge-s2.hwtunnel.com');
  assert.match(verifyScript, /curl -s --noproxy '\*' -o \/tmp\/devbridge_verify_body/);
});

// ---- #1001 P2-1: obsutilWrites no longer grades nonexistent commands ----

test('OBS cors/website are no longer write-graded; real write commands unchanged (#1001)', () => {
  for (const cmd of ['hcloud OBS cors put', 'hcloud OBS website put']) {
    const result = classifyTextCommand(cmd);
    assert.notEqual(result.decision, 'deny', `${cmd} does not exist in KooCLI OBS — must not be graded as a write`);
  }
  assert.equal(classifyTextCommand('hcloud OBS rm x').decision, 'deny', 'real OBS writes must stay denied');
  assert.equal(classifyTextCommand('hcloud OBS ls').decision, 'allow', 'OBS reads must stay allowed');
});

// ---- #999/#1000 structure guards ----

test('huawei-sandbox SKILL.md documents the persistence table and workspace-first install (#999)', () => {
  const body = readFileSync(join(pluginRoot, 'skills', 'huawei-sandbox', 'SKILL.md'), 'utf8');
  assert.match(body, /what survives a reboot/);
  assert.match(body, /`\/workspace\/\.local\/bin`/);
  assert.match(body, /Rolled back to the image state/);
  // The system-disk wipe is the measured root cause — the doc must say so explicitly.
  assert.match(body, /reboot reverted/);
  assert.match(body, /0\.2\.2 to the image's 0\.1\.13|0\.2\.2 变回镜像 0\.1\.13/);
});

test('huawei-sandbox SKILL.md tunnel verify commands carry the proxy trap (#1000)', () => {
  const body = readFileSync(join(pluginRoot, 'skills', 'huawei-sandbox', 'SKILL.md'), 'utf8');
  assert.match(body, /curl -s --noproxy '\*' -o \/dev\/null -w "%\{http_code\}" --max-time 10 "\$TUNNEL_URL"/);
  assert.match(body, /Proxy trap on verify commands/);
  assert.match(body, /windows-ssh\.md §0\.1/);
});
