import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { AGENTS } from '../plugins/huaweicloud-core/src/telemetry/agent-registry.mjs';
import { detectAgent, detectAgentHarness } from '../plugins/huaweicloud-core/src/telemetry/agent-detect.mjs';

// 与 test/telemetry.test.mjs 相同的 env 隔离方式。
const DETECTION_ENV_KEYS = ['AGENT_HARNESS', ...new Set(AGENTS.flatMap((agent) => agent.envVars || []))];

function withNoAgentEnv(fn) {
  const prev = Object.fromEntries(DETECTION_ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of DETECTION_ENV_KEYS) delete process.env[key];
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('#1040 detectAgent fallback harness is unknown, no | pollution', () => {
  withNoAgentEnv(() => {
    for (const ci of [
      {},
      { name: 'startup' },
      { name: 'test-client' },
      { name: 'voucher-claim-probe' },
      { name: 'startup', version: '1.0.0' },
    ]) {
      const { harness, version } = detectAgent(ci);
      assert.equal(harness, 'unknown', `clientInfo=${JSON.stringify(ci)}`);
      assert.ok(!harness.includes('|'), 'harness must not contain install segment separator');
      assert.equal(version, ci.version || '0.0.0');
    }
  });
});

test('#1040 detectAgentHarness fallback is unknown for probe-like client names', () => {
  withNoAgentEnv(() => {
    assert.equal(detectAgentHarness({ name: 'startup' }), 'unknown');
    assert.equal(detectAgentHarness({ name: 'test' }), 'unknown');
    assert.equal(detectAgentHarness({ name: 'voucher-claim-xyz' }), 'unknown');
    assert.equal(detectAgentHarness(), 'unknown');
  });
});

test('#1040 AGENT_HARNESS outside whitelist is ignored and falls back to unknown', () => {
  withNoAgentEnv(() => {
    process.env.AGENT_HARNESS = 'not-a-known-agent|with-pollution';
    try {
      assert.equal(detectAgentHarness(), 'unknown');
      assert.equal(detectAgent().harness, 'unknown');
    } finally {
      delete process.env.AGENT_HARNESS;
    }
  });
});

test('#1040 whitelisted AGENT_HARNESS still wins', () => {
  withNoAgentEnv(() => {
    process.env.AGENT_HARNESS = 'opencode';
    try {
      assert.equal(detectAgentHarness(), 'opencode');
      assert.equal(detectAgent().harness, 'opencode');
    } finally {
      delete process.env.AGENT_HARNESS;
    }
  });
});

test('#1040 known agents still match by env/client name (regression)', () => {
  withNoAgentEnv(() => {
    assert.equal(detectAgentHarness({ name: 'codex-mcp-client' }), 'codex');
    process.env.OPENCODE_SESSION_ID = 's1';
    try {
      assert.equal(detectAgentHarness({ name: 'startup' }), 'opencode');
    } finally {
      delete process.env.OPENCODE_SESSION_ID;
    }
  });
});

test('#1040 hdkitRequest sends X-HW-Agent header', async () => {
  process.env.HW_ACCESS_KEY = 'TESTAK';
  process.env.HW_SECRET_KEY = 'TESTSK';
  process.env.HDKITSERVICE_ENDPOINT = 'https://example.test/hdkitservice/';

  const { clearRuntimeCredentials } = await import('../plugins/huaweicloud-core/src/auth/credentials.mjs');
  clearRuntimeCredentials();

  // 隔离 env，保证 detectAgent 结果确定
  const prevEnv = Object.fromEntries(DETECTION_ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of DETECTION_ENV_KEYS) delete process.env[key];

  const { hdkitVoucherStatus } = await import('../plugins/huaweicloud-core/src/sandbox/hdkitservice-api.mjs');
  const originalFetch = global.fetch;
  let capturedHeaders = null;
  global.fetch = async (_url, opts) => {
    capturedHeaders = opts.headers;
    return new Response(JSON.stringify({ claimed: false }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  try {
    process.env.AGENT_HARNESS = 'opencode';
    await hdkitVoucherStatus();
    assert.equal(capturedHeaders['X-HW-Agent'], 'opencode', 'X-HW-Agent must equal detectAgent().harness');
  } finally {
    global.fetch = originalFetch;
    delete process.env.AGENT_HARNESS;
    for (const [key, value] of Object.entries(prevEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    clearRuntimeCredentials();
  }
});

test('#1040 telemetry flush sends X-HW-Agent header', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hwdk-1040-'));
  const prevHome = process.env.HUAWEICLOUD_DEVKIT_HOME;
  process.env.HUAWEICLOUD_DEVKIT_HOME = tmp;
  try {
    const telemetry = await import(`../plugins/huaweicloud-core/src/telemetry/telemetry.mjs?iso1040=${Date.now()}`);
    const originalFetch = global.fetch;
    let capturedHeaders = null;
    global.fetch = async (_url, opts) => {
      capturedHeaders = opts.headers;
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    try {
      telemetry.initTelemetry({ harness: 'dsh', version: '1.2.3' });
      telemetry.trackToolInvoke('huaweicloud_check_cli');
      await telemetry.flushEvents();
      assert.equal(capturedHeaders['X-HW-Agent'], 'dsh', 'telemetry POST must carry X-HW-Agent');
    } finally {
      global.fetch = originalFetch;
    }
  } finally {
    if (prevHome === undefined) delete process.env.HUAWEICLOUD_DEVKIT_HOME;
    else process.env.HUAWEICLOUD_DEVKIT_HOME = prevHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
