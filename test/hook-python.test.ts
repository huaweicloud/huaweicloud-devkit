import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { fixtureDir } from './fixture-dir.ts';

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
  // Telemetry gated off: runHook spawns the REAL hook (no copy, no path
  // redirect), so its record_cli_event side effect would append to the
  // SHARED agent-dir spool (plugins/huaweicloud-core/telemetry/
  // hook-events.jsonl) and flood later tests' telemetry ingests — the
  // windows-CI flake behind the #1040 flush pin (see hook-parity.test.ts's
  // battery comment). The spool-writing behavior itself is pinned by the
  // copy-based test below, which redirects the write into its own fixture.
  return spawnSync(pythonBin, [hookPath], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, HUAWEICLOUD_DEVKIT_TELEMETRY: 'off' },
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

test('python hook blocks SECRET_ACCESS_KEY spellings and ShowSecret (parity with TS)', () => {
  expectHookDecision('echo $HUAWEICLOUD_SECRET_ACCESS_KEY', 'deny');
  expectHookDecision('echo ${HUAWEICLOUD_SECRET_ACCESS_KEY}', 'deny');
  expectHookDecision('printenv HWC_SECRET_ACCESS_KEY', 'deny');
  expectHookDecision('env | grep HW_SECRET_ACCESS_KEY', 'deny');
  expectHookDecision('hcloud CSMS ShowSecret --secret_name prod/db', 'deny');
  // The ShowSecret token is boundary-guarded in the py layer too: longer
  // operation names and stem-containing values are not secret reads.
  expectHookDecision('hcloud CSMS ShowSecretList', 'allow');
  expectHookDecision('hcloud CSMS ListSecrets --secret_name=showsecret-demo', 'allow');
  expectHookDecision('hcloud KMS ShowKey', 'allow');
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

// port-v2defects (interrogate round 1): the DEGRADED-mode doctrine, pinned
// behaviorally. The hook is copied into a fixture dir WITHOUT its safety/
// sibling (and, in the second variant, with a policy whose LATER field
// carries an invalid regex) so the policy-load failure modes fire for real:
// an unavailable write vocabulary must fail its gates CLOSED (the
// obfuscation clause's is-None arm; hcloud_write_blocked's routed deny) —
// never reopen plain writes while the mangled forms deny — and per-field
// isolation must keep unrelated corruption (a bad credentialFilePatterns
// regex) from triggering the fail-closed arms while the vocabularies are
// intact.
test('python hook fails closed when the policy vocabulary is unavailable (degraded-mode doctrine)', () => {
  // The copies mirror the deployed layout (hooks/ under the plugin dir,
  // safety/ its sibling) so the hook's parents[1] resolves inside the
  // fixture, not the surrounding tmpdir.
  const dir = fixtureDir('hook-degraded-');
  mkdirSync(join(dir, 'hooks'), { recursive: true });
  const hookCopy = join(dir, 'hooks', 'huaweicloud-safety.py');
  copyFileSync(hookPath, hookCopy);
  const runDegraded = (command: string) =>
    spawnSync(pythonBin, [hookCopy], {
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command } }),
      encoding: 'utf8',
    });
  if (pythonUnavailable(runDegraded('echo hello'))) return;

  // No safety/ sibling: every policy-derived regex stays None.
  const cases: Array<[command: string, verdict: 'deny' | 'allow', why: string]> = [
    ["$'\\x68'cloud FunctionGraph InvokeFunction --func_urn=x", 'deny', 'mangled write: the is-None vocab arm'],
    ['hcloud ECS DeleteServers --server.id=x', 'deny', 'plain write: the fail-closed write gate'],
    ['hcloud ECS ListServers', 'deny', 'plain read: fail-closed with the cause named (no vocabulary to prove safety)'],
    [
      'bash -c "hcloud ECS DeleteServers --server.id=x"',
      'deny',
      'nested script: the leading-segment walk is policy-free',
    ],
    ['echo Delete | xargs hcloud ECS', 'deny', 'xargs feeder: the leading-segment walk'],
    // Round 3: the walk runs UNCONDITIONALLY — the narrow routing tail
    // ([\s)\]}'\"]) missed these executable `xargs hcloud` tails.
    ['echo ECS DeleteServers | xargs hcloud;', 'deny', 'semicolon tail: the unconditional walk'],
    ['echo ECS DeleteServers | xargs hcloud|cat', 'deny', 'pipe tail: the unconditional walk'],
    ['echo ECS DeleteServers | xargs hcloud>out', 'deny', 'redirect tail: the unconditional walk'],
    ['echo ECS DeleteServers | xargs hcloud&&true', 'deny', '&& tail: the unconditional walk'],
    ['hcloud --help', 'deny', 'degraded mode denies all hcloud-leading invocations (the recorded trade)'],
    [
      'echo "see the hcloud docs"',
      'allow',
      'prose mention: invocation-scoped, not mention-scoped (interrogate round 2)',
    ],
    ['grep hcloud README.md', 'allow', 'same — one corrupt policy must not block every mention of the CLI'],
    ['echo $(date)', 'deny', 'non-cloud obfuscation: the blast radius, chosen fail-closed'],
    ['echo hello', 'allow', 'plain non-hcloud text keeps no jurisdiction'],
    ['ls -la', 'allow', 'same'],
  ];
  for (const [command, expected, why] of cases) {
    const result = runDegraded(command);
    assert.equal(result.status, 0, `${command}: the degraded hook must not crash: ${result.stderr.slice(0, 200)}`);
    assert.equal(result.stderr, '', `${command}: no stderr in degraded mode`);
    if (expected === 'allow') {
      assert.equal(result.stdout.trim(), '', `${command} must allow (${why})`);
    } else {
      const output = JSON.parse(result.stdout);
      assert.equal(output.hookSpecificOutput.permissionDecision, 'deny', `${command} must deny (${why})`);
    }
  }
  // The routed deny names the cause (actionable, not a bare refusal).
  const writeResult = JSON.parse(runDegraded('hcloud ECS DeleteServers --server.id=x').stdout);
  assert.match(writeResult.hookSpecificOutput.permissionDecisionReason, /policy could not be loaded/);

  // Per-field isolation: an invalid regex in a LATER policy field
  // (credentialFilePatterns) must not abort the load before the
  // write/read vocabularies compile — the fail-closed arms stay untriggered
  // while the vocabularies are intact.
  const isolated = fixtureDir('hook-isolated-');
  mkdirSync(join(isolated, 'hooks'), { recursive: true });
  mkdirSync(join(isolated, 'safety'), { recursive: true });
  const policy = JSON.parse(
    readFileSync(join(process.cwd(), 'plugins', 'huaweicloud-core', 'safety', 'policy.json'), 'utf8'),
  );
  policy.credentialFilePatterns = ['('];
  writeFileSync(join(isolated, 'safety', 'policy.json'), JSON.stringify(policy));
  const isolatedHook = join(isolated, 'hooks', 'huaweicloud-safety.py');
  copyFileSync(hookPath, isolatedHook);
  const runIsolated = (command: string) =>
    spawnSync(pythonBin, [isolatedHook], {
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command } }),
      encoding: 'utf8',
    });
  if (pythonUnavailable(runIsolated('echo hello'))) return;
  const isolatedCases: Array<[command: string, verdict: 'deny' | 'allow', why: string]> = [
    ['echo $(date)', 'allow', 'unrelated corruption must not trigger the vocab fail-closed arm'],
    ['hcloud ECS DeleteServers --server.id=x', 'deny', 'the intact write vocabulary still denies writes'],
    ['hcloud ECS ListServers', 'allow', 'the intact read vocabulary still allows reads'],
    ['hcloud ECS Update-Show-x', 'deny', 'the read exemption stays start-anchored'],
  ];
  for (const [command, expected, why] of isolatedCases) {
    const result = runIsolated(command);
    assert.equal(result.status, 0, `${command}: ${result.stderr.slice(0, 200)}`);
    if (expected === 'allow') {
      assert.equal(result.stdout.trim(), '', `${command} must allow (${why})`);
    } else {
      const output = JSON.parse(result.stdout);
      assert.equal(output.hookSpecificOutput.permissionDecision, 'deny', `${command} must deny (${why})`);
    }
  }
  assert.ok(existsSync(hookCopy), 'fixture registry owns the copies (cleaned at exit)');
});

// port-v2defects (interrogate round 2): the safety hook's own CLI telemetry
// labeling. record_cli_event matches its regexes against the "Service
// Operation" cmd string — the write prefix regex's (^|[A-Za-z0-9]) class
// never matched the SPACE before the operation, so the canonical
// `hcloud ECS CreateServers` labeled cli:invoke. The label search is now
// per-word; OBS subcommand writes stay cli:invoke (the label vocabulary is
// the policy prefix list, same as the gate's — recorded residual).
test('python safety hook labels canonical writes cli:write (per-word write search)', () => {
  const dir = fixtureDir('hook-labels-');
  mkdirSync(join(dir, 'hooks'), { recursive: true });
  mkdirSync(join(dir, 'safety'), { recursive: true });
  copyFileSync(hookPath, join(dir, 'hooks', 'huaweicloud-safety.py'));
  copyFileSync(
    join(process.cwd(), 'plugins', 'huaweicloud-core', 'safety', 'policy.json'),
    join(dir, 'safety', 'policy.json'),
  );
  const runLabeled = (command: string) =>
    spawnSync(pythonBin, [join(dir, 'hooks', 'huaweicloud-safety.py')], {
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command } }),
      encoding: 'utf8',
      env: { ...process.env, HUAWEICLOUD_DEVKIT_TELEMETRY: '1' },
    });
  if (pythonUnavailable(runLabeled('echo hello'))) return;
  for (const command of [
    'hcloud ECS CreateServers --server.flavorRef=xxx',
    'hcloud ECS ListServers',
    'hcloud ECS NovaCreateServers',
    'hcloud OBS rm obs://b -f',
  ]) {
    const result = runLabeled(command);
    assert.equal(result.status, 0, `${command}: ${result.stderr.slice(0, 200)}`);
  }
  const events = readFileSync(join(dir, 'telemetry', 'hook-events.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const keys = events.map((event) => `${event.value} -> ${event.key}`);
  assert.ok(keys.includes('hcloud ECS CreateServers -> cli:write'), `write label missing: ${keys.join(', ')}`);
  assert.ok(keys.includes('hcloud ECS ListServers -> cli:read'), `read label missing: ${keys.join(', ')}`);
  assert.ok(
    keys.includes('hcloud ECS NovaCreateServers -> cli:write'),
    `compound write label missing: ${keys.join(', ')}`,
  );
  // The recorded residual: OBS subcommand writes label cli:invoke (prefix
  // vocabulary only) — pinned so a future change is deliberate.
  assert.ok(keys.includes('hcloud OBS rm -> cli:invoke'), `OBS label drifted: ${keys.join(', ')}`);
});
