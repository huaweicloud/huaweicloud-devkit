import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { hookEventsPath } from '../plugins/huaweicloud-core/src/telemetry/telemetry.mjs';

const hookPath = join(process.cwd(), 'plugins', 'huaweicloud-core', 'hooks', 'huaweicloud-safety.py');
const pythonBin = process.platform === 'win32' ? 'python' : 'python3';

function runHook(payload) {
  return spawnSync(pythonBin, [hookPath], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
  });
}

function pythonUnavailable(result) {
  return result.error?.code === 'ENOENT';
}

test('python hook file exists', () => {
  assert.ok(existsSync(hookPath));
});

test('python hook blocks public admin port through shared rules', () => {
  const result = runHook({
    tool_name: 'mcp__huaweicloud__create_security_group_rule',
    tool_input: {
      command:
        'hcloud VPC CreateSecurityGroupRule --security_group_rule.port_range_min=22 --security_group_rule.remote_ip_prefix=0.0.0.0/0',
    },
  });
  if (pythonUnavailable(result)) return;

  assert.equal(result.status, 0);
  const output = JSON.parse(result.stdout);
  assert.equal(output.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /public|port|internet/i);
});

test('python hook still blocks credential files', () => {
  const result = runHook({
    tool_name: 'Bash',
    tool_input: { command: 'Get-Content ~/.hcloud/config.json' },
  });
  if (pythonUnavailable(result)) return;

  assert.equal(result.status, 0);
  const output = JSON.parse(result.stdout);
  assert.equal(output.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /credential|profile/i);
});

test('python hook blocks encoded shell payload execution through shared rules', () => {
  const result = runHook({
    tool_name: 'Bash',
    tool_input: { command: 'echo ZWNobyBoaQ== | base64 -d | bash' },
  });
  if (pythonUnavailable(result)) return;

  assert.equal(result.status, 0);
  const output = JSON.parse(result.stdout);
  assert.equal(output.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /encoded payload|interpreter/i);
});

test('python hook outputs Hermes format when hook_event_name is present', () => {
  const result = runHook({
    hook_event_name: 'pre_tool_call',
    tool_name: 'terminal',
    tool_input: { command: 'cat ~/.hcloud/config.json' },
    session_id: 'test',
    cwd: '/tmp',
  });
  if (pythonUnavailable(result)) return;

  assert.equal(result.status, 0);
  const output = JSON.parse(result.stdout);
  assert.equal(output.action, 'block');
  assert.match(output.message, /Huawei Cloud safety hook blocked this action/);
  assert.ok(!('hookSpecificOutput' in output), 'Hermes format must not include hookSpecificOutput');
});

test('python hook allows safe commands under Hermes context', () => {
  const result = runHook({
    hook_event_name: 'pre_tool_call',
    tool_name: 'terminal',
    tool_input: { command: 'ls -la' },
    session_id: 'test',
    cwd: '/tmp',
  });
  if (pythonUnavailable(result)) return;

  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), '', 'safe commands should produce no output');
});

function runEvaluate(toolName, toolInput) {
  const probe = [
    'import importlib.util, json',
    `spec = importlib.util.spec_from_file_location("hws", ${JSON.stringify(hookPath)})`,
    'm = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(m)',
    `print(json.dumps(m.evaluate(${JSON.stringify(toolName)}, ${JSON.stringify(toolInput)})))`,
  ].join('; ');
  return spawnSync(pythonBin, ['-c', probe], { encoding: 'utf8' });
}

test('python hook evaluate() is importable and blocks public admin port', () => {
  const result = runEvaluate('terminal', {
    command:
      'hcloud VPC CreateSecurityGroupRule --security_group_rule.port_range_min=22 --security_group_rule.remote_ip_prefix=0.0.0.0/0',
  });
  if (pythonUnavailable(result)) return;

  assert.equal(result.status, 0);
  const reason = JSON.parse(result.stdout);
  assert.equal(typeof reason, 'string');
  assert.match(reason, /public|port|internet/i);
});

test('python hook evaluate() allows safe commands', () => {
  const result = runEvaluate('terminal', { command: 'ls -la' });
  if (pythonUnavailable(result)) return;

  assert.equal(result.status, 0);
  assert.equal(JSON.parse(result.stdout), null);
});

test('python hook write-gate blocks prefixed destructive ops (NovaDelete*/Reset*)', () => {
  for (const cmd of [
    'hcloud ECS NovaDeleteServer --server_id=x',
    'hcloud ECS ResetServerPassword --server_id=x',
    'hcloud ECS BatchResetServersPassword --server_id=x',
  ]) {
    const result = runEvaluate('terminal', { command: cmd });
    if (pythonUnavailable(result)) return;
    assert.equal(result.status, 0);
    const reason = JSON.parse(result.stdout);
    assert.equal(typeof reason, 'string', `${cmd} should be blocked by the write-gate`);
    assert.match(reason, /write|plan|approv/i);
  }
});

test('python hook write-gate blocks standard "Service OpName" form (#1065 D4-25)', () => {
  // WRITE_OPERATION_RE previously required ^ or an alnum char before the write
  // prefix, so "VPC CreateVpc" (prefix preceded by a space) never matched and
  // standard-form write ops bypassed both the deny gate and cli:write telemetry.
  for (const cmd of [
    'hcloud VPC CreateVpc --vpc.name=x',
    'hcloud ECS CreateServers --server.1.name=x',
    'hcloud VPC DeleteVpc --vpc_id=x',
  ]) {
    const result = runEvaluate('terminal', { command: cmd });
    if (pythonUnavailable(result)) return;
    assert.equal(result.status, 0);
    const reason = JSON.parse(result.stdout);
    assert.equal(typeof reason, 'string', `${cmd} should be blocked by the write-gate`);
    assert.match(reason, /write|plan|approv/i);
  }
});

test('python hook WRITE_OPERATION_RE classifies space-separated write ops (#1065 D4-25)', () => {
  const probe = [
    'import importlib.util, json',
    `spec = importlib.util.spec_from_file_location("hws", ${JSON.stringify(hookPath)})`,
    'm = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(m)',
    'out = {',
    '  "write": bool(m.WRITE_OPERATION_RE.search("VPC CreateVpc")),',
    '  "readFirst": bool(m.READ_OPERATION_RE.search("VPC ListVpcs")),',
    '  "nova": bool(m.WRITE_OPERATION_RE.search("ECS NovaDeleteServer --server_id=x")),',
    '}',
    'print(json.dumps(out))',
  ].join('\n');
  const result = spawnSync(pythonBin, ['-c', probe], { encoding: 'utf8' });
  if (pythonUnavailable(result)) return;

  assert.equal(result.status, 0);
  const out = JSON.parse(result.stdout);
  assert.equal(out.write, true, '"VPC CreateVpc" must match WRITE_OPERATION_RE');
  assert.equal(out.readFirst, true, '"VPC ListVpcs" must still be classified read-first');
  assert.equal(out.nova, true, 'mid-word Nova/Reset compatibility must not regress');
});

test('python hook write-gate still allows read-only Nova ops', () => {
  const result = runEvaluate('terminal', { command: 'hcloud ECS NovaListServers --limit=1' });
  if (pythonUnavailable(result)) return;

  assert.equal(result.status, 0);
  assert.equal(JSON.parse(result.stdout), null);
});

test('python hook blocks env dumps with HW_ prefix (#561 D4-2)', () => {
  for (const cmd of ['env | grep HW_', 'printenv | grep HW_ACCESS', 'env | grep HUAWEICLOUD']) {
    const result = runEvaluate('terminal', { command: cmd });
    if (pythonUnavailable(result)) return;
    assert.equal(result.status, 0);
    const reason = JSON.parse(result.stdout);
    assert.equal(typeof reason, 'string', `${cmd} should be blocked`);
    assert.match(reason, /credential|env/i);
  }
});

test('python hook blocks credential variable references incl. HW_ prefix (#561 D4-2)', () => {
  const bypasses = [
    'echo $HW_SECRET_KEY',
    'printenv HW_ACCESS_KEY',
    'echo ${HW_SECURITY_TOKEN}',
    'echo $HUAWEICLOUD_SECRET_ACCESS_KEY',
    'echo $HW_SECRET_ACCESS_KEY',
    'grep $HW_ACCESS_KEY ./file',
  ];
  for (const cmd of bypasses) {
    const result = runEvaluate('terminal', { command: cmd });
    if (pythonUnavailable(result)) return;
    assert.equal(result.status, 0, `${cmd} should exit 0`);
    const reason = JSON.parse(result.stdout);
    assert.equal(typeof reason, 'string', `${cmd} should be blocked`);
    assert.match(reason, /credential|env/i);
  }
  // Literal-name references (single-quoted / backslash-escaped) stay allowed.
  for (const safe of ["echo '$HW_SECRET_KEY'", 'echo \\$HW_SECRET_KEY', 'echo $HW_CONFIG_PATH']) {
    const result = runEvaluate('terminal', { command: safe });
    if (pythonUnavailable(result)) return;
    assert.equal(result.status, 0);
    assert.equal(JSON.parse(result.stdout), null, `${safe} should be allowed`);
  }
});

// #1065 D4-25: the safety hook writes cli:* events into <plugin>/telemetry, and
// telemetry.mjs ingests exactly that directory. A different base made every
// hook event invisible end-to-end (dev wrote plugins/telemetry, installed wrote
// one level above the plugin root).
function pythonTelemetryPaths(hookFile) {
  const probe = [
    'import importlib.util, json',
    `spec = importlib.util.spec_from_file_location("hws", ${JSON.stringify(hookFile)})`,
    'm = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(m)',
    'print(json.dumps({',
    '  "plugin": str(m.PLUGIN_DIR),',
    '  "telemetry": str(m.TELEMETRY_DIR),',
    '  "events": str(m.HOOK_EVENTS_PATH),',
    '}))',
  ].join('\n');
  return spawnSync(pythonBin, ['-c', probe], { encoding: 'utf8' });
}

// Reproduce the installed layout the hook lands in: <plugin>/hooks/ +
// <plugin>/safety/ + <plugin>/src/telemetry/, so parents[1] is the plugin root.
function installedPluginLayout(t) {
  const root = mkdtempSync(join(tmpdir(), 'hwc-hook-paths-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pluginDir = join(root, 'huaweicloud-plugins');
  const pluginSrc = join(process.cwd(), 'plugins', 'huaweicloud-core');
  cpSync(join(pluginSrc, 'hooks'), join(pluginDir, 'hooks'), { recursive: true });
  cpSync(join(pluginSrc, 'safety'), join(pluginDir, 'safety'), { recursive: true });
  return { pluginDir, hookFile: join(pluginDir, 'hooks', 'huaweicloud-safety.py') };
}

test('python hook writes hook events into the telemetry.mjs ingest dir (#1065 D4-25)', () => {
  const result = pythonTelemetryPaths(hookPath);
  if (pythonUnavailable(result)) return;

  assert.equal(result.status, 0);
  const paths = JSON.parse(result.stdout);
  assert.equal(
    resolve(paths.plugin),
    resolve(process.cwd(), 'plugins', 'huaweicloud-core'),
    'PLUGIN_DIR must be the plugin root, not its parent (dev layout)',
  );
  assert.equal(resolve(paths.telemetry), resolve(paths.plugin, 'telemetry'));
  assert.equal(
    resolve(paths.events),
    resolve(hookEventsPath()),
    'safety hook must write the file telemetry.mjs ingests',
  );
});

test('python hook telemetry path stays inside the plugin root when installed (#1065 D4-25)', (t) => {
  const { pluginDir, hookFile } = installedPluginLayout(t);
  const result = pythonTelemetryPaths(hookFile);
  if (pythonUnavailable(result)) return;

  assert.equal(result.status, 0);
  const paths = JSON.parse(result.stdout);
  assert.equal(resolve(paths.plugin), resolve(pluginDir), 'installed PLUGIN_DIR must be the plugin root');
  assert.equal(
    resolve(paths.events),
    resolve(pluginDir, 'telemetry', 'hook-events.jsonl'),
    'installed hook events must not land outside the plugin root',
  );
});

test('python hook records cli:write / cli:read into that directory end-to-end (#1065 D4-25)', (t) => {
  const { pluginDir, hookFile } = installedPluginLayout(t);
  const eventsPath = join(pluginDir, 'telemetry', 'hook-events.jsonl');
  const runCommand = (command) =>
    spawnSync(pythonBin, [hookFile], {
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command } }),
      encoding: 'utf8',
    });

  const denied = runCommand('hcloud VPC CreateVpc --vpc.name=x');
  if (pythonUnavailable(denied)) return;
  assert.equal(denied.status, 0);
  assert.match(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecisionReason, /write|plan|approv/i);

  const allowed = runCommand('hcloud VPC ListVpcs --cli-region=cn-north-4');
  assert.equal(allowed.status, 0);
  assert.equal(allowed.stdout.trim(), '', 'read-only command should be allowed');

  assert.ok(existsSync(eventsPath), 'hook must record the event into <plugin>/telemetry/hook-events.jsonl');
  const events = readFileSync(eventsPath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    events.map((event) => event.key),
    ['cli:write', 'cli:read'],
    'write ops must classify as cli:write (not cli:invoke) and reads as cli:read',
  );
  assert.match(events[0].value, /VPC CreateVpc/);
});
