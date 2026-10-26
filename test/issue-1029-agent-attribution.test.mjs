import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// #1029（本仓 A 部分）: agent 识别兜底不再拼接 `|安装段`/探针名，
// 白名单未命中一律归 'unknown'；对外请求（领券 / 遥测上报等）统一携带
// X-HW-Agent 头，使看板统计与领券归因有纯净的 agent 口径。

const PROXY_KEYS = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy'];

const { AGENTS } = await import('../plugins/huaweicloud-core/src/telemetry/agent-registry.mjs');
const { detectAgent, detectAgentHarness } = await import('../plugins/huaweicloud-core/src/telemetry/agent-detect.mjs');

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

test('#1029 detectAgent fallback returns unknown for non-whitelist client names', () => {
  withNoAgentEnv(() => {
    const cases = [
      { name: 'startup', version: '1.0.0' },
      { name: 'test-client', version: '1.0.0' },
      { name: 'voucher-claim-probe', version: '1.0.0' },
      { name: 'test|.npm/_npx/some-pkg', version: '1.0.0' },
      { name: 'whatever-mcp-client', version: '1.0.0' },
      {},
    ];
    for (const ci of cases) {
      const result = detectAgent(ci);
      assert.equal(result.harness, 'unknown', `clientInfo=${JSON.stringify(ci)} should map to unknown`);
      assert.ok(!result.harness.includes('|'), 'harness must never contain the install-segment separator');
      assert.ok(!result.harness.includes('/'), 'harness must never leak path segments');
    }
  });
});

test('#1029 detectAgentHarness fallback returns unknown instead of raw client name', () => {
  withNoAgentEnv(() => {
    assert.equal(detectAgentHarness(), 'unknown');
    assert.equal(detectAgentHarness({ name: 'startup' }), 'unknown');
    assert.equal(detectAgentHarness({ name: 'test-client' }), 'unknown');
  });
});

test('#1029 whitelist matching still works (env / clientName / id)', () => {
  withNoAgentEnv(() => {
    assert.equal(detectAgent({ name: 'codex-mcp-client' }).harness, 'codex');
    assert.equal(detectAgent({ name: 'office-claw-mcp-connector-probe' }).harness, 'officeace');
    assert.equal(detectAgent({ name: 'opencode' }).harness, 'opencode');
    process.env.OPENCODE_SESSION_ID = 'simulated';
    try {
      assert.equal(detectAgent({ name: 'startup' }).harness, 'opencode');
    } finally {
      delete process.env.OPENCODE_SESSION_ID;
    }
  });
});

test('#1029 AGENT_HARNESS env is still honored when set', () => {
  withNoAgentEnv(() => {
    process.env.AGENT_HARNESS = 'opencode';
    try {
      assert.equal(detectAgent().harness, 'opencode');
      assert.equal(detectAgentHarness(), 'opencode');
    } finally {
      delete process.env.AGENT_HARNESS;
    }
  });
});

test('#1029 hdkitservice requests carry X-HW-Agent header (voucher claim)', async () => {
  const prev = {
    ak: process.env.HW_ACCESS_KEY,
    sk: process.env.HW_SECRET_KEY,
    endpoint: process.env.HDKITSERVICE_ENDPOINT,
    home: process.env.HUAWEICLOUD_HOME,
  };
  const captured = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      captured.push({ url: req.url, headers: req.headers, body });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ claimed: true, ok: true }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hwdk-1029-'));
  process.env.HW_ACCESS_KEY = 'TESTAK';
  process.env.HW_SECRET_KEY = 'TESTSK';
  process.env.HDKITSERVICE_ENDPOINT = `http://127.0.0.1:${port}/hdkit/`;
  process.env.HUAWEICLOUD_HOME = tmpHome;
  process.env.NO_PROXY = 'localhost,127.0.0.1';
  for (const k of PROXY_KEYS) delete process.env[k];

  // 隔离 agent 环境变量，验证兜底路径下头值为 'unknown'
  try {
    const api = await import(`../plugins/huaweicloud-core/src/sandbox/hdkitservice-api.mjs?iso-1029-${Date.now()}`);
    await withNoAgentEnv(async () => {
      await api.hdkitVoucherClaim('some-domain');
      await api.hdkitVoucherStatus();
      await api.hdkitCompetitionVoucherClaim('some-domain');
    });

    assert.equal(captured.length, 3, 'expected 3 outbound hdkitservice requests');
    for (const req of captured) {
      assert.equal(req.headers['x-hw-agent'], 'unknown', `X-HW-Agent must be present and clean for ${req.url}`);
      assert.ok(!String(req.headers['x-hw-agent']).includes('|'));
    }

    // AGENT_HARNESS 命中时头值透出该 agent
    process.env.AGENT_HARNESS = 'opencode';
    captured.length = 0;
    await api.hdkitVoucherClaim('some-domain');
    assert.equal(captured[0].headers['x-hw-agent'], 'opencode');
  } finally {
    delete process.env.AGENT_HARNESS;
    server.close();
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test('#1029 telemetry flush POST carries X-HW-Agent header', async () => {
  const prev = {
    home: process.env.HUAWEICLOUD_DEVKIT_HOME,
    endpoint: process.env.HUAWEICLOUD_DEVKIT_TELEMETRY_ENDPOINT,
    noProxy: process.env.NO_PROXY,
    proxy: Object.fromEntries(PROXY_KEYS.map((k) => [k, process.env[k]])),
  };
  const captured = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      captured.push({ headers: req.headers, body });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hwdk-tel-1029-'));
  process.env.HUAWEICLOUD_DEVKIT_HOME = tmp;
  process.env.HUAWEICLOUD_DEVKIT_TELEMETRY_ENDPOINT = `http://127.0.0.1:${port}/t`;
  process.env.NO_PROXY = 'localhost,127.0.0.1';
  for (const k of PROXY_KEYS) delete process.env[k];

  const signalListenersBefore = {
    SIGTERM: process.listeners('SIGTERM'),
    SIGINT: process.listeners('SIGINT'),
  };

  try {
    withNoAgentEnv(() => {});
    const telemetry = await import(
      `../plugins/huaweicloud-core/src/telemetry/telemetry.mjs?iso-1029-${Date.now()}-${port}`
    );
    telemetry.initTelemetry({ harness: 'codearts', version: '1.2.3' });
    telemetry.trackToolInvoke('huaweicloud_voucher_claim');
    await telemetry.flushEvents();

    assert.ok(captured.length >= 1, 'expected at least one telemetry POST');
    assert.equal(captured[0].headers['x-hw-agent'], 'codearts');

    // 事件体内的 harness 字段同样不包含安装段污染
    const events = captured.flatMap((c) => {
      try {
        return JSON.parse(c.body);
      } catch {
        return [];
      }
    });
    for (const e of events) {
      assert.equal(e.harness, 'codearts');
      assert.ok(!String(e.harness).includes('|'));
    }
  } finally {
    for (const [sig, before] of Object.entries(signalListenersBefore)) {
      for (const listener of process.listeners(sig)) {
        if (!before.includes(listener)) process.removeListener(sig, listener);
      }
    }
    server.close();
    for (const [key, value] of Object.entries(prev)) {
      if (key === 'proxy') {
        for (const [k, v] of Object.entries(value)) {
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        }
      } else if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
