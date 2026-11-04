import assert from 'node:assert/strict';
import test from 'node:test';

// #1090 验收测试：exposeTunnel 认证编排（resolveDevbridgeAuth）——
// 自愈盲区（keyring 空 + 陈旧 CACHE_HIT）、失败归因（merged attempts）、
// 配额结构化降级、DI 守卫（缺 buildKeyringInjectScript 不裸调）。
// 沙箱 I/O（run/probe）全部注入，无需真实沙箱。注意：初次 probe 由调用方
// （exposeTunnel）完成并传入解析结果，这里注入的 probe 只承担「重跑」轮次。

import { resolveDevbridgeAuth } from '../plugins/huaweicloud-core/src/sandbox/session-manager.mjs';

const INJECT_SCRIPT = 'echo "DB_KEY_INJECTED=1"';

function probeStdout({ mode, keyringAttempt }) {
  const lines = [];
  if (keyringAttempt) lines.push(`DB_ATTEMPT_KEYRING=${keyringAttempt}`);
  lines.push(`DB_AUTH_MODE=${mode}`);
  return lines.join('\n');
}

/** outcomes: 每次 probe() 调用的 { mode, keyringAttempt, stderr } 队列 */
function makeDeps({ probeOutcomes = [] } = {}) {
  const calls = { injects: [], probes: [], ensures: [], recreates: [], runCalls: 0 };
  const d = {
    calls,
    buildKeyringInjectScript: (apiKey) => {
      calls.injects.push(apiKey);
      return INJECT_SCRIPT;
    },
    run: async (script) => {
      calls.runCalls += 1;
      assert.equal(script, INJECT_SCRIPT, 'run must only receive validated inject scripts');
      return { stdout: '', stderr: '' };
    },
    probe: async () => {
      const outcome = probeOutcomes[calls.probes.length] || probeOutcomes[probeOutcomes.length - 1];
      calls.probes.push(1);
      return { stdout: probeStdout(outcome), stderr: outcome.stderr || '' };
    },
  };
  return d;
}

test('#1090 phase 1: keyring login-failed triggers recreate → inject → re-probe → API_KEY_AUTO', async () => {
  const d = makeDeps({ probeOutcomes: [{ mode: 'API_KEY_KEYRING' }] });
  d.recreateDevbridgeKey = async () => {
    d.calls.recreates.push(1);
    return { apiKey: 'devbridge_FRESH', mode: 'CREATED' };
  };
  d.ensureDevbridgeKey = async () => {
    d.calls.ensures.push(1);
    return { apiKey: 'devbridge_ENSURED', mode: 'CREATED' };
  };

  const result = await resolveDevbridgeAuth({
    authMode: 'NO_CREDENTIAL',
    attempts: { KEYRING: 'login-failed' },
    poolType: 'ephemeral',
    ...d,
  });
  assert.equal(result.effectiveAuthMode, 'API_KEY_AUTO');
  assert.equal(result.quota, null);
  assert.equal(d.calls.recreates.length, 1);
  assert.deepEqual(d.calls.injects, ['devbridge_FRESH']);
  assert.equal(d.calls.probes.length, 1);
  // heal succeeded → ensure phase must NOT run (no redundant ensure/inject/probe)
  assert.equal(d.calls.ensures.length, 0);
});

test('#1090 blind spot: keyring empty + stale CACHE_HIT → recreate breaks the dead loop', async () => {
  const d = makeDeps({
    probeOutcomes: [
      { mode: 'NO_CREDENTIAL', keyringAttempt: 'login-failed' }, // stale injected key
      { mode: 'API_KEY_KEYRING' }, // rebuilt key works
    ],
  });
  d.ensureDevbridgeKey = async () => {
    d.calls.ensures.push(1);
    return { apiKey: 'devbridge_STALE', mode: 'CACHE_HIT' };
  };
  d.recreateDevbridgeKey = async () => {
    d.calls.recreates.push(1);
    return { apiKey: 'devbridge_REBUILT', mode: 'CREATED' };
  };

  const result = await resolveDevbridgeAuth({
    authMode: 'NO_CREDENTIAL',
    attempts: { KEYRING: 'no-valid-key' },
    poolType: 'ephemeral',
    ...d,
  });
  assert.equal(result.effectiveAuthMode, 'API_KEY_AUTO');
  // the stale CACHE_HIT key must be injected once, then the rebuilt key once
  assert.deepEqual(d.calls.injects, ['devbridge_STALE', 'devbridge_REBUILT']);
  assert.equal(d.calls.recreates.length, 1);
  assert.equal(d.calls.probes.length, 2);
  // attribution merged: the failing tier (login-failed) must be visible
  assert.equal(result.attempts.KEYRING, 'login-failed');
});

test('#1090 attribution: final failure reports the LAST failing tier, not probe1', async () => {
  const d = makeDeps({
    probeOutcomes: [{ mode: 'NO_CREDENTIAL', keyringAttempt: 'login-failed', stderr: 'login boom' }],
  });
  d.ensureDevbridgeKey = async () => ({ apiKey: 'devbridge_STALE', mode: 'CACHE_HIT' });
  d.recreateDevbridgeKey = async () => ({ apiKey: 'devbridge_REBUILT', mode: 'CREATED' });

  const result = await resolveDevbridgeAuth({
    authMode: 'NO_CREDENTIAL',
    attempts: { KEYRING: 'no-valid-key' },
    poolType: 'ephemeral',
    ...d,
  });
  assert.equal(result.effectiveAuthMode, 'NO_CREDENTIAL');
  // merged attempts: later probe wins — login-failed (the real cause), not no-valid-key
  assert.equal(result.attempts.KEYRING, 'login-failed');
  // loginOutput accumulates probe raw output for support escalation
  assert.match(result.loginOutput, /login boom/);
});

test('#1090 quota: HDKIT_DEVBRIDGE_KEY_QUOTA_EXCEEDED returns a structured quota result with key hint', async () => {
  const d = makeDeps({ probeOutcomes: [] });
  const quotaError = Object.assign(new Error('13002: quota exceeded'), {
    code: 'HDKIT_DEVBRIDGE_KEY_QUOTA_EXCEEDED',
  });
  d.ensureDevbridgeKey = async () => {
    throw quotaError;
  };
  d.listKeysForQuotaHint = async () => [{ name: 'devkit-ephemeral', id: 'k1', lastUsed: '2026-11-01' }];

  const result = await resolveDevbridgeAuth({
    authMode: 'NO_CREDENTIAL',
    attempts: { KEYRING: 'no-valid-key' },
    poolType: 'ephemeral',
    ...d,
  });
  assert.equal(result.quota.error, quotaError);
  assert.deepEqual(result.quota.keysHint, [{ name: 'devkit-ephemeral', id: 'k1', lastUsed: '2026-11-01' }]);
  // nothing was injected (create failed before any key existed)
  assert.equal(d.calls.injects.length, 0);
});

test('#1090 DI guard: missing buildKeyringInjectScript → no bare call, degrade without crash', async () => {
  const d = makeDeps({ probeOutcomes: [] });
  d.ensureDevbridgeKey = async () => ({ apiKey: 'devbridge_X', mode: 'CREATED' });
  d.recreateDevbridgeKey = async () => ({ apiKey: 'devbridge_X', mode: 'CREATED' });

  const result = await resolveDevbridgeAuth({
    authMode: 'NO_CREDENTIAL',
    attempts: { KEYRING: 'login-failed' },
    poolType: 'ephemeral',
    // buildKeyringInjectScript intentionally omitted
    ensureDevbridgeKey: d.ensureDevbridgeKey,
    recreateDevbridgeKey: d.recreateDevbridgeKey,
    run: d.run,
    probe: d.probe,
  });
  // No TypeError, no injection attempted, clean degrade with correct attribution
  assert.equal(result.effectiveAuthMode, 'NO_CREDENTIAL');
  assert.equal(result.attempts.KEYRING, 'login-failed');
  assert.equal(d.calls.injects.length, 0);
  assert.equal(d.calls.runCalls, 0);
});

test('#1090 phase 2 only: ensure CREATED key works on the first re-probe (no redundant recreate)', async () => {
  const d = makeDeps({ probeOutcomes: [{ mode: 'API_KEY_FILE' }] });
  d.ensureDevbridgeKey = async () => {
    d.calls.ensures.push(1);
    return { apiKey: 'devbridge_CREATED', mode: 'CREATED' };
  };
  d.recreateDevbridgeKey = async () => {
    d.calls.recreates.push(1);
    return { apiKey: 'devbridge_R', mode: 'CREATED' };
  };

  const result = await resolveDevbridgeAuth({
    authMode: 'NO_CREDENTIAL',
    attempts: { KEYRING: 'no-valid-key' },
    poolType: 'ephemeral',
    ...d,
  });
  assert.equal(result.effectiveAuthMode, 'API_KEY_AUTO');
  // exactly one inject + one re-probe — no redundant ensure/inject/probe round (#1090 轻量项)
  assert.deepEqual(d.calls.injects, ['devbridge_CREATED']);
  assert.equal(d.calls.probes.length, 1);
  assert.equal(d.calls.recreates.length, 0);
});
