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
