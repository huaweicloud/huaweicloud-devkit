import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const hookPath = join(process.cwd(), 'integrations', 'hermes', 'hooks', 'huaweicloud-telemetry.py');
const pythonBin = process.platform === 'win32' ? 'python' : 'python3';

interface TelemetryHookPayload {
  hook_event_name?: string;
  tool_name: string;
  tool_input: { command?: string; name?: string };
  session_id?: string;
  cwd?: string;
}

function _runHook(payload: TelemetryHookPayload) {
  return spawnSync(pythonBin, [hookPath], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
  });
}

function pythonUnavailable(result: { error?: NodeJS.ErrnoException | null }): boolean {
  return result.error?.code === 'ENOENT';
}

// Use a temp telemetry dir to avoid polluting real data.
// The hook resolves plugin dir from __file__, so we test via importlib
// with HUAWEICLOUD_PLUGIN_DIR pointing to a temp location.
const TMP_PLUGIN_DIR = join(process.cwd(), 'test', '.tmp-telemetry-plugin');
const TMP_TELEMETRY_DIR = join(TMP_PLUGIN_DIR, 'telemetry');
const TMP_EVENTS_PATH = join(TMP_TELEMETRY_DIR, 'hook-events.jsonl');

function runHookWithTempDir(payload: TelemetryHookPayload) {
  // Clean and recreate temp dir
  rmSync(TMP_PLUGIN_DIR, { recursive: true, force: true });
  mkdirSync(TMP_TELEMETRY_DIR, { recursive: true });

  return spawnSync(pythonBin, [hookPath], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, HUAWEICLOUD_PLUGIN_DIR: TMP_PLUGIN_DIR },
  });
}

function readEvents() {
  if (!existsSync(TMP_EVENTS_PATH)) return [];
  return readFileSync(TMP_EVENTS_PATH, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

test('telemetry hook file exists', () => {
  assert.ok(existsSync(hookPath));
});

test('telemetry hook always exits 0 (never blocks)', () => {
  const result = runHookWithTempDir({
    tool_name: 'terminal',
    tool_input: { command: 'hcloud ECS ListServers' },
  });
  if (pythonUnavailable(result)) return;
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), '', 'telemetry hook should produce no stdout');
});

test('telemetry hook captures hcloud read commands', () => {
  const result = runHookWithTempDir({
    tool_name: 'terminal',
    tool_input: { command: 'hcloud ECS ListServers --cli-region=cn-north-4' },
  });
  if (pythonUnavailable(result)) return;

  const events = readEvents();
  assert.equal(events.length, 1);
  assert.equal(events[0].key, 'cli:read');
  assert.match(events[0].value, /ECS ListServers/);
  assert.equal(events[0].capability, 'cli');
});

test('telemetry hook captures hcloud write commands', () => {
  const result = runHookWithTempDir({
    tool_name: 'Bash',
    tool_input: { command: 'hcloud ECS CreateServers --server.flavorRef=xxx' },
  });
  if (pythonUnavailable(result)) return;

  const events = readEvents();
  assert.equal(events.length, 1);
  assert.equal(events[0].key, 'cli:write');
  assert.match(events[0].value, /ECS CreateServers/);
});

// Devkit skills are server data disclosed over MCP: skill-view events carry
// no devkit signal anymore, so the hook must not classify them at all
// (retrieval telemetry rides trackSkillRetrieve in huaweicloud_retrieve_skill;
// direct reads via the stdio skillRoot disclosure are observable only as
// catalog calls, never as which skill file was consumed).
test('telemetry hook does not classify skill tool loading', () => {
  for (const name of ['huawei-ecs', 'some-other-skill']) {
    const result = runHookWithTempDir({
      tool_name: 'skill_view',
      tool_input: { name },
    });
    if (pythonUnavailable(result)) return;

    const events = readEvents();
    assert.equal(events.length, 0, `skill_view of ${name} must produce no event`);
  }
});

test('telemetry hook captures MCP huaweicloud tool invocations', () => {
  const result = runHookWithTempDir({
    tool_name: 'mcp__huaweicloud__huaweicloud_check_cli',
    tool_input: {},
  });
  if (pythonUnavailable(result)) return;

  const events = readEvents();
  assert.equal(events.length, 1);
  assert.equal(events[0].key, 'tool:mcp__huaweicloud__huaweicloud_check_cli');
  assert.equal(events[0].capability, 'mcp');
});

test('telemetry hook ignores non-hcloud commands', () => {
  const result = runHookWithTempDir({
    tool_name: 'terminal',
    tool_input: { command: 'ls -la /tmp' },
  });
  if (pythonUnavailable(result)) return;

  const events = readEvents();
  assert.equal(events.length, 0);
});

test('telemetry hook handles Hermes format (hook_event_name present)', () => {
  const result = runHookWithTempDir({
    hook_event_name: 'pre_tool_call',
    tool_name: 'terminal',
    tool_input: { command: 'hcloud VPC ListVpcs' },
    session_id: 'test',
    cwd: '/tmp',
  });
  if (pythonUnavailable(result)) return;

  assert.equal(result.status, 0);
  const events = readEvents();
  assert.equal(events.length, 1);
  assert.equal(events[0].key, 'cli:read');
  assert.match(events[0].value, /VPC ListVpcs/);
});

// Cleanup
test('cleanup temp telemetry dir', () => {
  rmSync(TMP_PLUGIN_DIR, { recursive: true, force: true });
  assert.ok(true);
});
