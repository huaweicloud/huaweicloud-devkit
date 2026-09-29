import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

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

test('python hook write-gate still allows read-only Nova ops', () => {
  const result = runEvaluate('terminal', { command: 'hcloud ECS NovaListServers --limit=1' });
  if (pythonUnavailable(result)) return;

  assert.equal(result.status, 0);
  assert.equal(JSON.parse(result.stdout), null);
});
