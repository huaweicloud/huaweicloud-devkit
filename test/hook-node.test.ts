import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const hookPath = join(process.cwd(), 'plugins', 'huaweicloud-core', 'hooks', 'huaweicloud-safety.mjs');

interface HookPayload {
  tool_name: string;
  tool_input: { command: string };
}

function runHook(payload: HookPayload) {
  return spawnSync(process.execPath, [hookPath], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
  });
}

test('node hook file exists', () => {
  assert.ok(existsSync(hookPath));
});

test('node hook still blocks when the plugin copy has no built dist', () => {
  // A raw git or marketplace copy of the plugin carries src/ but no dist/.
  // The wrapper must fall back to the TypeScript source instead of crashing
  // the PreToolUse safety gate.
  const dir = mkdtempSync(join(tmpdir(), 'hwc-hook-nodist-'));
  try {
    const pluginRoot = join(process.cwd(), 'plugins', 'huaweicloud-core');
    cpSync(join(pluginRoot, 'hooks'), join(dir, 'hooks'), { recursive: true });
    cpSync(join(pluginRoot, 'src'), join(dir, 'src'), { recursive: true });
    cpSync(join(pluginRoot, 'safety'), join(dir, 'safety'), { recursive: true });
    assert.ok(!existsSync(join(dir, 'dist')), 'fixture must not contain dist');

    const result = spawnSync(process.execPath, [join(dir, 'hooks', 'huaweicloud-safety.mjs')], {
      input: JSON.stringify({
        tool_name: 'Bash',
        tool_input: {
          command:
            'hcloud VPC CreateSecurityGroupRule --security_group_rule.port_range_min=22 --security_group_rule.remote_ip_prefix=0.0.0.0/0',
        },
      }),
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.hookSpecificOutput.permissionDecision, 'deny');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('node hook blocks public admin port through shared rules', () => {
  const result = runHook({
    tool_name: 'mcp__huaweicloud__create_security_group_rule',
    tool_input: {
      command:
        'hcloud VPC CreateSecurityGroupRule --security_group_rule.port_range_min=22 --security_group_rule.remote_ip_prefix=0.0.0.0/0',
    },
  });

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /blocked this action/i);
});

test('node hook blocks credential file reads', () => {
  const result = runHook({
    tool_name: 'Bash',
    tool_input: { command: 'Get-Content ~/.hcloud/config.json' },
  });

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /credential|profile/i);
});

test('node hook blocks encoded shell payload execution through shared rules', () => {
  const result = runHook({
    tool_name: 'Bash',
    tool_input: { command: 'echo ZWNobyBoaQ== | base64 -d | bash' },
  });

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /encoded payload|interpreter/i);
});

test('node hook allows safe commands with empty stdout', () => {
  const result = runHook({
    tool_name: 'Bash',
    tool_input: { command: 'git status --short' },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), '');
});
