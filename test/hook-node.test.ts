import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

test('node hook denies fail-closed when the policy cannot be loaded (interrogate round 1)', () => {
  // A payload too broken to load its own policy (safety/ missing —
  // DEFAULT_POLICY throws at module load) must deny with the cause named
  // instead of dying with no verdict, which a PreToolUse harness reads as
  // "allow". The py twin's fail-closed posture. The verdict is written
  // SYNCHRONOUSLY before process.exit (interrogate round 2) — pending async
  // pipe writes are not waited for, and a dropped verdict reads as allow.
  const dir = mkdtempSync(join(tmpdir(), 'hwc-hook-nopolicy-'));
  try {
    const pluginRoot = join(process.cwd(), 'plugins', 'huaweicloud-core');
    cpSync(join(pluginRoot, 'hooks'), join(dir, 'hooks'), { recursive: true });
    cpSync(join(pluginRoot, 'src'), join(dir, 'src'), { recursive: true });
    assert.ok(!existsSync(join(dir, 'dist')), 'fixture must not contain dist');
    assert.ok(!existsSync(join(dir, 'safety')), 'fixture must not contain safety/');

    const result = spawnSync(process.execPath, [join(dir, 'hooks', 'huaweicloud-safety.mjs')], {
      input: JSON.stringify({
        tool_name: 'Bash',
        tool_input: { command: 'hcloud ECS ListServers' },
      }),
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, `the broken-payload hook must exit 0, not crash: ${result.stderr.slice(0, 200)}`);
    const output = JSON.parse(result.stdout);
    assert.equal(output.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(output.hookSpecificOutput.permissionDecisionReason, /safety policy failed to load/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('node hook denies fail-closed when classification itself throws (corrupt rules file, interrogate round 2)', () => {
  // The load-time guard covers DEFAULT_POLICY only; a truncated
  // cloud-risk-rules.json kills risk-rule-engine's JSON.parse INSIDE
  // classifyTextCommand — the same verdict-less crash, one call later. The
  // classify call is guarded with the same fail-closed deny (natural return
  // — no exit race). The py twin degrades gracefully on the same file
  // (load_cloud_risk_rules try/except).
  const dir = mkdtempSync(join(tmpdir(), 'hwc-hook-badrules-'));
  try {
    const pluginRoot = join(process.cwd(), 'plugins', 'huaweicloud-core');
    cpSync(join(pluginRoot, 'hooks'), join(dir, 'hooks'), { recursive: true });
    cpSync(join(pluginRoot, 'src'), join(dir, 'src'), { recursive: true });
    cpSync(join(pluginRoot, 'safety'), join(dir, 'safety'), { recursive: true });
    mkdirSync(join(dir, 'safety', 'rules'), { recursive: true });
    writeFileSync(join(dir, 'safety', 'rules', 'cloud-risk-rules.json'), '{"rules": [trunc', 'utf8');
    assert.ok(!existsSync(join(dir, 'dist')), 'fixture must not contain dist');

    for (const command of ['hcloud ECS ListServers', 'echo hello']) {
      const result = spawnSync(process.execPath, [join(dir, 'hooks', 'huaweicloud-safety.mjs')], {
        input: JSON.stringify({ tool_name: 'Bash', tool_input: { command } }),
        encoding: 'utf8',
      });
      assert.equal(result.status, 0, `${command}: must exit 0, not crash: ${result.stderr.slice(0, 200)}`);
      const output = JSON.parse(result.stdout);
      assert.equal(output.hookSpecificOutput.permissionDecision, 'deny', `${command} must deny fail-closed`);
      // The classify-time reason names the actual break (round 3: the
      // policy parsed fine — the rules file died mid-classification).
      assert.match(output.hookSpecificOutput.permissionDecisionReason, /safety classifier failed to run/);
    }
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

test('node hook denies Windows-script-wrapped hcloud writes (#731/#760)', () => {
  // Whichever module the wrapper loads (compiled dist/ when present —
  // stale dist fails this test on purpose — or the src/ fallback in a raw
  // checkout) must carry the wrapper unwrap. The mjs face is the third
  // enforcement layer: TS classifier and the py hook are pinned by the
  // hook-parity battery; this pins the Node entry point itself.
  const denied = [
    'cmd /c "hcloud ECS DeleteServers --server.id=1"',
    'powershell -NoProfile -Command "hcloud ECS DeleteServers --server.id=1"',
    'C:\\Windows\\System32\\cmd.exe /c "hcloud ECS DeleteServers"',
    'cmd /c start /b hcloud ECS DeleteServers --server.id=1',
  ];
  for (const command of denied) {
    const result = runHook({ tool_name: 'Bash', tool_input: { command } });
    assert.equal(result.status, 0, `${command}: ${result.stderr}`);
    const output = JSON.parse(result.stdout);
    assert.equal(output.hookSpecificOutput.permissionDecision, 'deny', command);
    assert.match(output.hookSpecificOutput.permissionDecisionReason, /write|plan|approv/i, command);
  }
  // Wrapped reads stay allowed through the mjs face too.
  for (const command of ['cmd /c "hcloud ECS ListServers"', 'powershell -Command "hcloud ECS ListServers"']) {
    const result = runHook({ tool_name: 'Bash', tool_input: { command } });
    assert.equal(result.status, 0, `${command}: ${result.stderr}`);
    assert.equal(result.stdout.trim(), '', command);
  }
});
