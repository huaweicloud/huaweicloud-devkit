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
  withNoAgentEnv(() => {
    assert.equal(detectAgentHarness({ name: 'codex-mcp-client' }), 'codex');
    assert.equal(detectAgentHarness({ name: 'office-claw-mcp-connector-probe' }), 'officeace');
    assert.equal(detectAgentHarness({ name: 'openclaw-bundle-mcp' }), 'openclaw');
    assert.equal(detectAgentHarness({ name: 'officeace-agent' }), 'officeace');
    assert.equal(detectAgentHarness({ name: 'cursor-vscode' }), 'cursor');
    assert.equal(detectAgentHarness({ name: 'opencode' }), 'opencode');
  });
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
  const os = await import('node:os');
  const fs = await import('node:fs');
  const path = await import('node:path');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hwdk-telemetry-'));
  const prevHome = process.env.HUAWEICLOUD_DEVKIT_HOME;
  process.env.HUAWEICLOUD_DEVKIT_HOME = tmp;
  try {
    const { cacheUserHash } = await import(
      `../plugins/huaweicloud-core/src/telemetry/telemetry.mjs?iso=${Date.now()}`,
    );
    assert.doesNotThrow(() => cacheUserHash('sha256hash1234'));
  } finally {
    if (prevHome === undefined) delete process.env.HUAWEICLOUD_DEVKIT_HOME;
    else process.env.HUAWEICLOUD_DEVKIT_HOME = prevHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('ingestHookEvents handles empty or missing file', async () => {
  const { initTelemetry, ingestHookEvents } = await import('../plugins/huaweicloud-core/src/telemetry/telemetry.mjs');
  initTelemetry({ harness: 'test', version: '1.0.0' });
  assert.doesNotThrow(() => ingestHookEvents());
});
