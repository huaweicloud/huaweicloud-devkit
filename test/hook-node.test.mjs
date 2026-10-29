import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

const hookPath = join(process.cwd(), 'plugins', 'huaweicloud-core', 'hooks', 'huaweicloud-safety.mjs');

function runHook(payload) {
  return spawnSync(process.execPath, [hookPath], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
  });
}

test('node hook file exists', () => {
  assert.ok(existsSync(hookPath));
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

test('node hook fails safe when safety/policy.json is missing or corrupt', () => {
  const pluginRoot = join(process.cwd(), 'plugins', 'huaweicloud-core');
  for (const scenario of ['missing', 'corrupt', 'empty', 'emptylist', 'wrongtype', 'arraytype']) {
    const tmp = mkdtempSync(join(tmpdir(), 'hw-hook-failsafe-'));
    const dest = join(tmp, 'huaweicloud-core');
    cpSync(pluginRoot, dest, { recursive: true, filter: (src) => !src.startsWith(join(pluginRoot, 'telemetry')) });
    const policyDest = join(dest, 'safety', 'policy.json');
    if (scenario === 'missing') {
      rmSync(policyDest);
    } else if (scenario === 'empty') {
      writeFileSync(policyDest, '{}');
    } else if (scenario === 'emptylist') {
      writeFileSync(
        policyDest,
        JSON.stringify({
          credentialFilePatterns: ['\\.hcloud'],
          blockedSecretOperations: ['ShowSecret'],
          writeOperationPrefixes: [],
          agentartsCommandPolicy: {},
        }),
      );
    } else if (scenario === 'wrongtype') {
      writeFileSync(
        policyDest,
        JSON.stringify({
          credentialFilePatterns: ['\\.hcloud'],
          blockedSecretOperations: ['ShowSecret'],
          writeOperationPrefixes: ['Delete'],
          agentartsCommandPolicy: 'approved',
        }),
      );
    } else if (scenario === 'arraytype') {
      writeFileSync(
        policyDest,
        JSON.stringify({
          credentialFilePatterns: ['\\.hcloud'],
          blockedSecretOperations: ['ShowSecret'],
          writeOperationPrefixes: ['Delete'],
          agentartsCommandPolicy: ['approved'],
        }),
      );
    } else {
      writeFileSync(policyDest, '{not valid json');
    }
    const result = spawnSync(process.execPath, [join(dest, 'hooks', 'huaweicloud-safety.mjs')], {
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'agentarts launch' } }),
      encoding: 'utf8',
    });
    rmSync(tmp, { recursive: true, force: true });
    assert.equal(result.status, 0, `${scenario}: hook must not crash through (allow) — ${result.stderr}`);
    const output = JSON.parse(result.stdout);
    assert.equal(output.hookSpecificOutput.permissionDecision, 'deny', scenario);
    assert.match(output.hookSpecificOutput.permissionDecisionReason, /failed to load/i, scenario);
  }
});

test('hook denies reads of the agentarts memory one-time key file (filename pattern)', async () => {
  const { classifyTextCommand } = await import('../plugins/huaweicloud-core/src/safety-policy.mjs');
  // The state root (~/.config/huaweicloud) is NOT itself matched — the
  // FILENAME component is the deny pattern (adversarial U2 round-2: the
  // pre-fix claim of hook-blocking was aspirational, cat was allowed).
  assert.equal(classifyTextCommand('cat ~/.config/huaweicloud/agentarts-memory-api-key-sp1.txt').decision, 'deny');
  assert.equal(classifyTextCommand('head -1 agentarts-memory-api-key-x.txt').decision, 'deny');
  // The truncation side files stay readable (the large-output contract).
  assert.equal(classifyTextCommand('cat /tmp/huaweicloud-devkit/agentarts-output-123.json').decision, 'allow');
});
