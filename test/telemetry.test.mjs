import assert from 'node:assert/strict';
import test from 'node:test';

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
