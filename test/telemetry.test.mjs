import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { detectAgentHarness } from '../plugins/huaweicloud-core/src/telemetry/agent-detect.mjs';

test('detectAgentHarness returns known when no env set', () => {
  const result = detectAgentHarness();
  assert.equal(typeof result, 'string');
  assert.ok(result.length > 0);
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

test('detectAgentHarness detects vscode', () => {
  const prev = process.env.VSCODE_PID;
  process.env.VSCODE_PID = '12345';
  try {
    assert.equal(detectAgentHarness(), 'vscode');
  } finally {
    if (prev) process.env.VSCODE_PID = prev;
    else delete process.env.VSCODE_PID;
  }
});

test('generateOrRecoverInstallId returns consistent string', async () => {
  const { generateOrRecoverInstallId } = await import(
    '../plugins/huaweicloud-core/src/telemetry/telemetry.mjs'
  );
  const id1 = generateOrRecoverInstallId();
  const id2 = generateOrRecoverInstallId();
  assert.equal(typeof id1, 'string');
  assert.equal(id1, id2);
});

test('isTelemetryEnabled defaults to true', async () => {
  const { isTelemetryEnabled } = await import(
    '../plugins/huaweicloud-core/src/telemetry/telemetry.mjs'
  );
  assert.equal(isTelemetryEnabled(), true);
});

test('isTelemetryEnabled returns false when env set to off', async () => {
  const prev = process.env.HUAWEICLOUD_DEVKIT_TELEMETRY;
  process.env.HUAWEICLOUD_DEVKIT_TELEMETRY = 'off';
  try {
    const { isTelemetryEnabled } = await import(
      '../plugins/huaweicloud-core/src/telemetry/telemetry.mjs'
    );
    assert.equal(isTelemetryEnabled(), false);
  } finally {
    if (prev) process.env.HUAWEICLOUD_DEVKIT_TELEMETRY = prev;
    else delete process.env.HUAWEICLOUD_DEVKIT_TELEMETRY;
  }
});

test('initTelemetry and trackToolInvoke do not throw', async () => {
  const { initTelemetry, trackToolInvoke, trackSkillRetrieve } = await import(
    '../plugins/huaweicloud-core/src/telemetry/telemetry.mjs'
  );

  initTelemetry({ harness: 'test', version: '1.0.0' });
  assert.doesNotThrow(() => trackToolInvoke('test_tool_name'));
  assert.doesNotThrow(() => trackSkillRetrieve('test_skill_name'));
});

test('trackSandboxConnect and trackSandboxDisconnect do not throw', async () => {
  const { initTelemetry, trackSandboxConnect, trackSandboxDisconnect } = await import(
    '../plugins/huaweicloud-core/src/telemetry/telemetry.mjs'
  );

  initTelemetry({ harness: 'test', version: '1.0.0' });
  assert.doesNotThrow(() => trackSandboxConnect());
  assert.doesNotThrow(() => trackSandboxDisconnect());
});

test('cacheUserHash writes to filesystem', async () => {
  const { cacheUserHash } = await import(
    '../plugins/huaweicloud-core/src/telemetry/telemetry.mjs'
  );
  assert.doesNotThrow(() => cacheUserHash('sha256hash1234'));
});

test('ingestHookEvents handles empty or missing file', async () => {
  const { initTelemetry, ingestHookEvents } = await import(
    '../plugins/huaweicloud-core/src/telemetry/telemetry.mjs'
  );
  initTelemetry({ harness: 'test', version: '1.0.0' });
  assert.doesNotThrow(() => ingestHookEvents());
});