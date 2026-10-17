import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const hookPath = join(process.cwd(), 'plugins', 'huaweicloud-core', 'hooks', 'huaweicloud-safety.py');
const pythonBin = process.platform === 'win32' ? 'python' : 'python3';

interface HookPayload {
  hook_event_name?: string;
  tool_name: string;
  tool_input: { command: string };
  session_id?: string;
  cwd?: string;
}

function runHook(payload: HookPayload) {
  return spawnSync(pythonBin, [hookPath], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
  });
}

function pythonUnavailable(result: { error?: NodeJS.ErrnoException | null }): boolean {
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

function runEvaluate(toolName: string, toolInput: { command: string }) {
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

test('python hook blocks the vault CLI reveal face, including quoted spellings', () => {
  const cases = [
    'npx huaweicloud-devkit secret get secret://user/hw-sk --stdout',
    "npx huaweicloud-devkit secret 'get' secret://user/hw-sk --stdout",
    'npx huaweicloud-devkit@latest secret get secret://user/hw-sk',
  ];
  for (const command of cases) {
    const result = runHook({ tool_name: 'Bash', tool_input: { command } });
    if (pythonUnavailable(result)) return;
    assert.equal(result.status, 0, command);
    const output = JSON.parse(result.stdout);
    assert.equal(output.hookSpecificOutput.permissionDecision, 'deny', command);
    assert.match(output.hookSpecificOutput.permissionDecisionReason, /vault secrets/i, command);
  }
});

// One decision oracle for Bash-face payloads: run the hook, parse the
// verdict, assert. pythonUnavailable short-circuits (no python3 on PATH).
function expectHookDecision(command: string, expected: 'deny' | 'allow'): void {
  const result = runHook({ tool_name: 'Bash', tool_input: { command } });
  if (pythonUnavailable(result)) return;
  assert.equal(result.status, 0, command);
  if (expected === 'allow') {
    assert.equal(result.stdout.trim(), '', command);
    return;
  }
  const output = JSON.parse(result.stdout);
  assert.equal(output.hookSpecificOutput.permissionDecision, 'deny', command);
}

test('python hook write-gate sees quote-adjacent hcloud inside secret exec', () => {
  const result = runHook({
    tool_name: 'Bash',
    tool_input: {
      command:
        'npx huaweicloud-devkit secret exec --env K=secret://user/ak -- bash -c "hcloud ECS DeleteServers --cli-region=cn-north-4"',
    },
  });
  if (pythonUnavailable(result)) return;
  assert.equal(result.status, 0);
  const output = JSON.parse(result.stdout);
  assert.equal(output.hookSpecificOutput.permissionDecision, 'deny');
  // The block must come from the write gate — with ENV_DUMP now anchored,
  // `--env` can no longer trigger an accidental env-dump match, so the
  // reason names the unapproved write (this assertion is what makes the
  // test about the gate it names).
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /unapproved|write/i);
});

test('python hook write-gate blocks plain spellings and multi-invocation laundering', () => {
  const denyCases = [
    'hcloud ECS CreateServers --server.name=x',
    'npx huaweicloud-devkit secret list && npx huaweicloud-devkit secret exec -- bash -c "hcloud ECS CreateServers"',
    "npx huaweicloud-devkit secret $'get' secret://user/hw-sk --stdout",
  ];
  for (const command of denyCases) expectHookDecision(command, 'deny');
  // Reads and the sanctioned exec path stay allowed; a read token elsewhere
  // in the line must not suppress (nor trigger) anything.
  const allowCases = [
    'hcloud ECS ListServers --cli-region=cn-north-4',
    'npx huaweicloud-devkit secret exec --env K=x -- node script.js',
    'npx huaweicloud-devkit secret exec --env K=x -- bash -c "hcloud ECS ListServers"',
    'npx huaweicloud-devkit secret list',
  ];
  for (const command of allowCases) expectHookDecision(command, 'allow');
});

test('python hook blocks quoted credential dumps ($HW_ family parity with TS)', () => {
  expectHookDecision("bash -c 'printenv HW_SECRET_KEY'", 'deny');
  // Single-quoted $HW_* is a shell literal, not an expansion — exempt like TS.
  expectHookDecision("echo '$HW_SECRET_KEY is literal'", 'allow');
});

test('python hook: positional write gate, newline payloads, and OBS writes', () => {
  const denyCases = [
    'hcloud ECS ListServers\nhcloud ECS CreateServers --server.name=x',
    'hcloud ECS DeleteServers --cli-jsonInput=list-servers.json',
    'hcloud OBS rm obs://bucket/obj -f',
    'hcloud OBS cp obs://b/o obs://b2/o2 -f',
    'env',
    'npm exec huaweicloud-devkit -- secret get secret://user/hw-sk --stdout',
    '/usr/bin/hcloud ECS DeleteServers',
  ];
  for (const command of denyCases) expectHookDecision(command, 'deny');
  // Quoted prose after echo is one token, not a command — the deny message
  // itself tells agents to present planned commands this way.
  const allowCases = [
    'echo "next: hcloud ECS DeleteServers --server_id=x"',
    "echo 'run hcloud ECS CreateServers later'",
    'env -i hcloud ECS ListServers',
    'python3 env_setup.py --region cn-north-4 HUAWEICLOUD',
    'hcloud OBS ls obs://bucket',
  ];
  for (const command of allowCases) expectHookDecision(command, 'allow');
});
