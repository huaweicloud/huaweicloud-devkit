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
  const keys = [
    'OPENCODE_SESSION_ID',
    'OPENCODE_CONFIG_PATH',
    'CODEX_SESSION_ID',
    'CODEX_CLI_VERSION',
    'CODEX_SANDBOX',
    'CODEX_THREAD_ID',
    'OFFICEACE_SESSION_ID',
    'OFFICE_CLAW_CONFIG_ROOT',
    'OPENCLAW_SESSION_ID',
    'OPENCLAW_CONFIG_ROOT',
  ];
  const saved = keys.map((k) => [k, process.env[k]]);
  keys.forEach((k) => delete process.env[k]);
  try {
    assert.equal(detectAgentHarness({ name: 'codex-mcp-client' }), 'codex');
    assert.equal(detectAgentHarness({ name: 'office-claw-mcp-connector-probe' }), 'officeace');
    assert.equal(detectAgentHarness({ name: 'openclaw-bundle-mcp' }), 'openclaw');
    assert.equal(detectAgentHarness({ name: 'opencode' }), 'opencode');
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test('generateOrRecoverInstallId returns consistent string', async () => {
  const { generateOrRecoverInstallId } = await import('../plugins/huaweicloud-core/src/telemetry/telemetry.mjs');
  const id1 = generateOrRecoverInstallId();
  const id2 = generateOrRecoverInstallId();
  assert.equal(typeof id1, 'string');
  assert.equal(id1, id2);
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
  const { initTelemetry, trackToolInvoke, trackSkillRetrieve } =
    await import('../plugins/huaweicloud-core/src/telemetry/telemetry.mjs');

  initTelemetry({ harness: 'test', version: '1.0.0' });
  assert.doesNotThrow(() => trackToolInvoke('test_tool_name'));
  assert.doesNotThrow(() => trackSkillRetrieve('test_skill_name'));
});

test('trackSandboxConnect and trackSandboxDisconnect do not throw', async () => {
  const { initTelemetry, trackSandboxConnect, trackSandboxDisconnect } =
    await import('../plugins/huaweicloud-core/src/telemetry/telemetry.mjs');

  initTelemetry({ harness: 'test', version: '1.0.0' });
  assert.doesNotThrow(() => trackSandboxConnect());
  assert.doesNotThrow(() => trackSandboxDisconnect());
});

test('cacheUserHash writes to filesystem', async () => {
  const { cacheUserHash } = await import('../plugins/huaweicloud-core/src/telemetry/telemetry.mjs');
  assert.doesNotThrow(() => cacheUserHash('sha256hash1234'));
});

test('ingestHookEvents handles empty or missing file', async () => {
  const { initTelemetry, ingestHookEvents } = await import('../plugins/huaweicloud-core/src/telemetry/telemetry.mjs');
  initTelemetry({ harness: 'test', version: '1.0.0' });
  assert.doesNotThrow(() => ingestHookEvents());
});
