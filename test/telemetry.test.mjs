import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { AGENTS } from '../plugins/huaweicloud-core/src/telemetry/agent-registry.mjs';
import { detectAgentHarness } from '../plugins/huaweicloud-core/src/telemetry/agent-detect.mjs';

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

// 隔离 telemetry.mjs 的模块级目录常量（GLOBAL_TELEMETRY_DIR 在 import 时固定）：
// 临时 HUAWEICLOUD_DEVKIT_HOME + 带 query 的 import 强制新模块实例，用完恢复并清理。
async function withIsolatedTelemetry(fn) {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hwdk-telemetry-'));
  const prevHome = process.env.HUAWEICLOUD_DEVKIT_HOME;
  process.env.HUAWEICLOUD_DEVKIT_HOME = tmp;
  try {
    const telemetry = await import(`../plugins/huaweicloud-core/src/telemetry/telemetry.mjs?iso=${Date.now()}`);
    return await fn(telemetry);
  } finally {
    if (prevHome === undefined) delete process.env.HUAWEICLOUD_DEVKIT_HOME;
    else process.env.HUAWEICLOUD_DEVKIT_HOME = prevHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

test('detectAgentHarness returns known when no env set', () => {
  const result = detectAgentHarness();
  assert.ok(result === null || (typeof result === 'string' && result.length > 0));
});

test('detectAgentHarness respects AGENT_HARNESS env', () => {
  const prev = process.env.AGENT_HARNESS;
  process.env.AGENT_HARNESS = 'opencode';
  try {
    assert.equal(detectAgentHarness(), 'opencode');
  } finally {
    if (prev) process.env.AGENT_HARNESS = prev;
    else delete process.env.AGENT_HARNESS;
  }
});

test('detectAgentHarness detects opencode from env', () => {
  const prev = process.env.OPENCODE_SESSION_ID;
  process.env.OPENCODE_SESSION_ID = 'test-session';
  try {
    assert.equal(detectAgentHarness(), 'opencode');
  } finally {
    if (prev) process.env.OPENCODE_SESSION_ID = prev;
    else delete process.env.OPENCODE_SESSION_ID;
  }
});

test('detectAgentHarness returns null when nothing matches', () => {
  withNoAgentEnv(() => {
    assert.equal(detectAgentHarness(), null);
  });
});

test('detectAgentHarness classifies MCP client names to canonical harness', () => {
  const nameBackedAgents = AGENTS.filter((a) => a.clientNames?.length);
  const idNameAgents = AGENTS.filter((a) => a.envVars?.length);
  const cases = [
    ...nameBackedAgents.flatMap((a) => a.clientNames.map((n) => [n, a.id])),
    ...idNameAgents.map((a) => [a.id, a.id]),
  ];
  withNoAgentEnv(() => {
    for (const [name, expected] of cases) {
      assert.equal(detectAgentHarness({ name }), expected, `name=${name}`);
    }
  });
});

test('detectAgentHarness prefers real host env over clientInfo.name', () => {
  const hostBackedAgents = AGENTS.filter((a) => a.envVars?.length);
  withNoAgentEnv(() => {
    for (const agent of hostBackedAgents) {
      process.env[agent.envVars[0]] = 'simulated';
      assert.equal(
        detectAgentHarness({ name: 'unknown-mcp-client-probe' }),
        agent.id,
        `env ${agent.envVars[0]} should win over name for ${agent.id}`,
      );
      delete process.env[agent.envVars[0]];
    }
  });
});

test('generateOrRecoverInstallId returns consistent string', async () => {
  await withIsolatedTelemetry(async ({ generateOrRecoverInstallId }) => {
    const id1 = generateOrRecoverInstallId();
    const id2 = generateOrRecoverInstallId();
    assert.equal(typeof id1, 'string');
    assert.equal(id1, id2);
  });
});

test('isTelemetryEnabled defaults to true', async () => {
  const { isTelemetryEnabled } = await import('../plugins/huaweicloud-core/src/telemetry/telemetry.mjs');
  assert.equal(isTelemetryEnabled(), true);
});

test('isTelemetryEnabled returns false when env set to off', async () => {
  const prev = process.env.HUAWEICLOUD_DEVKIT_TELEMETRY;
  process.env.HUAWEICLOUD_DEVKIT_TELEMETRY = 'off';
  try {
    const { isTelemetryEnabled } = await import('../plugins/huaweicloud-core/src/telemetry/telemetry.mjs');
    assert.equal(isTelemetryEnabled(), false);
  } finally {
    if (prev) process.env.HUAWEICLOUD_DEVKIT_TELEMETRY = prev;
    else delete process.env.HUAWEICLOUD_DEVKIT_TELEMETRY;
  }
});

test('initTelemetry and trackToolInvoke do not throw', async () => {
  await withIsolatedTelemetry(async ({ initTelemetry, trackToolInvoke, trackSkillRetrieve }) => {
    initTelemetry({ harness: 'test', version: '1.0.0' });
    assert.doesNotThrow(() => trackToolInvoke('test_tool_name'));
    assert.doesNotThrow(() => trackSkillRetrieve('test_skill_name'));
  });
});

test('trackSandboxConnect and trackSandboxDisconnect do not throw', async () => {
  await withIsolatedTelemetry(async ({ initTelemetry, trackSandboxConnect, trackSandboxDisconnect }) => {
    initTelemetry({ harness: 'test', version: '1.0.0' });
    assert.doesNotThrow(() => trackSandboxConnect());
    assert.doesNotThrow(() => trackSandboxDisconnect());
  });
});

test('sanitizeValue truncates long values to 255', async () => {
  const { sanitizeValue } = await import('../plugins/huaweicloud-core/src/telemetry/telemetry.mjs');
  const out = sanitizeValue('x'.repeat(500));
  assert.equal(out.length, 255);
  assert.ok(out.endsWith('...'));
});

test('sanitizeValue replaces newlines and tabs with spaces', async () => {
  const { sanitizeValue } = await import('../plugins/huaweicloud-core/src/telemetry/telemetry.mjs');
  assert.equal(sanitizeValue('a\nb\tc'), 'a b c');
});

test('sanitizeValue keeps short values intact', async () => {
  const { sanitizeValue } = await import('../plugins/huaweicloud-core/src/telemetry/telemetry.mjs');
  assert.equal(sanitizeValue('hcloud version'), 'hcloud version');
});

test('sanitizeValue coerces non-strings and nulls safely', async () => {
  const { sanitizeValue } = await import('../plugins/huaweicloud-core/src/telemetry/telemetry.mjs');
  assert.equal(sanitizeValue(null), '');
  assert.equal(sanitizeValue(undefined), '');
  assert.equal(sanitizeValue(123), '123');
});

test('cacheUserHash writes to filesystem', async () => {
  await withIsolatedTelemetry(async ({ cacheUserHash }) => {
    assert.doesNotThrow(() => cacheUserHash('sha256hash1234'));
  });
});

test('ingestHookEvents handles empty or missing file', async () => {
  await withIsolatedTelemetry(async ({ initTelemetry, ingestHookEvents }) => {
    initTelemetry({ harness: 'test', version: '1.0.0' });
    assert.doesNotThrow(() => ingestHookEvents());
  });
});

// #1014: events enqueued before identity resolution (no user-hash file yet)
// must be backfilled with the hash at flush time, not permanently null.
test('flushEvents backfills userHash written after enqueue', async () => {
  const PROXY_ENV_KEYS = ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'NO_PROXY', 'no_proxy'];
  const prevProxy = Object.fromEntries(PROXY_ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of PROXY_ENV_KEYS) delete process.env[key];

  await withIsolatedTelemetry(async (telemetry) => {
    const http = await import('node:http');
    const fs = await import('node:fs');
    const path = await import('node:path');

    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const waitFor = async (predicate, timeoutMs = 8000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (predicate()) return true;
        await sleep(20);
      }
      return false;
    };

    const received = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        try {
          received.push(...JSON.parse(body));
        } catch {}
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

    const prevEndpoint = process.env.HUAWEICLOUD_DEVKIT_TELEMETRY_ENDPOINT;
    process.env.HUAWEICLOUD_DEVKIT_TELEMETRY_ENDPOINT = `http://127.0.0.1:${server.address().port}/events`;
    try {
      // Pre-create AGENT_TELEMETRY_DIR stamps (module-relative, gitignored) so the
      // initial flush at initTelemetry time is a no-op and the test only observes
      // the batch we control. Without this the test result depends on whether a
      // previous run already touched first-use/dau stamps.
      const agentTelemetryDir = path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        '..',
        'plugins',
        'huaweicloud-core',
        'telemetry',
      );
      fs.mkdirSync(agentTelemetryDir, { recursive: true });
      fs.writeFileSync(path.join(agentTelemetryDir, 'install-counter'), '0', 'utf8');
      fs.writeFileSync(path.join(agentTelemetryDir, 'install-stamp'), '', 'utf8');
      fs.writeFileSync(path.join(agentTelemetryDir, 'dau-stamp'), '', 'utf8');
      fs.writeFileSync(path.join(agentTelemetryDir, 'first-use-stamp'), '', 'utf8');

      telemetry.initTelemetry({ harness: 'test', version: '1.0.0' });

      // 1) enqueue events while NO user-hash file exists
      for (let i = 0; i < 5; i++) telemetry.trackToolInvoke('pre_identity_tool');
      const baseline = received.length;

      // 2) identity resolves AFTER enqueue (user-hash file written by another path)
      const userHashPath = path.join(
        process.env.HUAWEICLOUD_DEVKIT_HOME,
        '.huaweicloud-devkit',
        'telemetry',
        'user-hash',
      );
      fs.mkdirSync(path.dirname(userHashPath), { recursive: true });
      fs.writeFileSync(userHashPath, 'sha256hash_late_identity', 'utf8');

      // 3) fill the queue to BATCH_SIZE to trigger flush
      for (let i = 0; i < 96; i++) telemetry.trackToolInvoke('batch_tool');
      assert.ok(
        await waitFor(() => received.length >= baseline + 100),
        `flush should deliver the batch (got ${received.length - baseline})`,
      );

      const flushed = received.slice(baseline);
      const preIdentity = flushed.filter((e) => e.key === 'tool:pre_identity_tool');
      assert.equal(preIdentity.length, 5, 'pre-identity events should be in the flushed batch');
      for (const event of flushed) {
        assert.equal(event.userHash, 'sha256hash_late_identity', `event ${event.key} should carry backfilled hash`);
      }
    } finally {
      if (prevEndpoint === undefined) delete process.env.HUAWEICLOUD_DEVKIT_TELEMETRY_ENDPOINT;
      else process.env.HUAWEICLOUD_DEVKIT_TELEMETRY_ENDPOINT = prevEndpoint;
      server.close();
    }
  }).finally(() => {
    for (const [key, value] of Object.entries(prevProxy)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
});
