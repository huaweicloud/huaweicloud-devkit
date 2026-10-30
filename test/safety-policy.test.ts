import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  classifyHcloudArgs,
  classifyTextCommand,
  deriveSecretOperationAlternation,
  loadPolicy,
  redactSecrets,
} from '../plugins/huaweicloud-core/src/safety-policy.ts';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

test('unquoted bash -c payloads truncate to bare hcloud and deny fail-closed', () => {
  // Real bash passes only the next argument to -c (`ECS Delete…` become
  // $0/$1) — but the flattened form is indistinguishable from the quoted
  // original (`bash -c "hcloud ECS Delete…"`), so the script word being
  // a bin re-joins the tail and classifies the whole command
  // (fail-closed: deny either way, now as the write it flattens).
  const result = classifyTextCommand('bash -c hcloud ECS DeleteServers --server.id=1');
  assert.equal(result.decision, 'deny');
  assert.equal(result.risk, 'write');
  // The nested bare-hcloud shape (a script whose continuation line is
  // just the bin) denies the same way.
  const nested = classifyTextCommand("bash -c 'echo; hcloud' && echo done");
  assert.equal(nested.decision, 'deny');
  assert.equal(nested.risk, 'invalid');
  // A bare trailing `hcloud` mention never routes into classification.
  for (const cmd of ['hcloud', 'sudo hcloud', 'hcloud --', 'echo hcloud']) {
    assert.equal(classifyTextCommand(cmd).decision, 'allow', cmd);
  }
});

test('deriveSecretOperationAlternation survives degenerate policy shapes', () => {
  // Empty or absent list → never-matching pattern (mirrors the py layer's
  // `if blocked_secrets:` skip; an empty alternation branch would match
  // EVERYTHING and brick the TS Bash face).
  for (const empty of [[], [''], ['', '']]) {
    const alternation = deriveSecretOperationAlternation(empty);
    assert.equal(alternation, '(?!)');
    assert.equal(new RegExp(alternation, 'i').test('git status'), false);
  }
  // Empty-string entries are dropped, not treated as stems of everything.
  assert.equal(deriveSecretOperationAlternation(['', 'ShowSecret']), 'showsecret');
  // Identity compares originals (py parity): case-variant duplicates count
  // as distinct entries, so each becomes a guarded stem of the other.
  const caseDup = deriveSecretOperationAlternation(['ShowSecret', 'showsecret']);
  assert.match(caseDup, /\(\?<!\[A-Za-z0-9._\/-\]\)showsecret/);
  assert.match(caseDup, /showsecret\(\?!\[A-Za-z0-9._\/-\]\)/);
});

test('in-word hcloud keyword splits still route and classify (#927 audit)', () => {
  for (const cmd of [
    "hc'loud ECS DeleteServer --server_id=i-1",
    "h'cloud ECS DeleteServer --server_id=i-1",
    "sudo h'cloud ECS DeleteServer --server_id=i-1",
  ]) {
    assert.equal(classifyTextCommand(cmd).decision, 'deny', `${cmd} must deny`);
  }
  assert.equal(classifyTextCommand("hc'loud ECS ListServers").decision, 'allow', 'mangled-keyword read stays allowed');
});

test('Delete/Reboot-class mangled operations deny by the quote-stripped shadow (#927 audit)', () => {
  assert.equal(classifyTextCommand("hcloud ECS De'leteServer --server.id=x").decision, 'deny');
  assert.equal(classifyTextCommand("hcloud IAM Dele'teUser --user.id=x").decision, 'deny');
  // Reboot denies (label: write via the shadow — the execution label tests
  // the raw token only; decision is what matters, pinned as deliberate).
  assert.equal(classifyTextCommand("hcloud ECS Re'bootServer --server.id=x").decision, 'deny');
  assert.equal(classifyTextCommand("hcloud ECS Li'stServers").decision, 'allow', 'mangled read op stays allowed');
});

test('the argv form of a mangled secret operation denies (#927 audit)', () => {
  const result = classifyHcloudArgs(['hcloud', 'DEW', "Show'Secret'Version", '--body.kms_key_id=x']);
  assert.equal(result.decision, 'deny');
  assert.equal(result.risk, 'secret');
});

test('newline payloads: a READ line routes as read, CRLF+indent classified (#928 audit)', () => {
  assert.equal(classifyTextCommand('echo hello\nhcloud ECS ListServers').decision, 'allow');
  assert.equal(classifyTextCommand('echo hello\nhcloud ECS ListServers').risk, 'read_only');
  assert.equal(classifyTextCommand('echo hello\r\n  hcloud ECS DeleteServer --server.id=x').decision, 'deny');
});

test('unquoted prose mentioning hcloud stays allowed (#927 audit)', () => {
  assert.equal(classifyTextCommand('see hcloud docs').decision, 'allow');
  assert.equal(classifyTextCommand('echo hcloud is a CLI').decision, 'allow');
});

test('secret exec does not launder hcloud write classification', () => {
  const write = classifyTextCommand(
    'npx huaweicloud-devkit secret exec --env K=secret://user/ak -- hcloud ECS CreateServers --cli-region=cn-north-4',
  );
  assert.equal(write.decision, 'deny');
  assert.match(write.reason ?? '', /write/i);
  const read = classifyTextCommand(
    'npx huaweicloud-devkit secret exec --env K=secret://user/ak -- hcloud ECS ListServers --cli-region=cn-north-4',
  );
  assert.equal(read.decision, 'allow');
});

test('the vault reveal deny survives adversarial spellings (quotes, versions, source form)', () => {
  const revealCommands = [
    "npx huaweicloud-devkit secret 'get' secret://user/hw-sk --stdout",
    'npx huaweicloud-devkit secret "get" secret://user/hw-sk',
    'npx huaweicloud-devkit@latest secret get secret://user/hw-sk --stdout',
    'npx huaweicloud-devkit@2.3.0 secret get secret://user/hw-sk',
    'node ./plugins/huaweicloud-core/src/setup-cli.ts secret get secret://user/hw-sk --stdout',
    'node dist/setup-cli.mjs secret get secret://user/hw-sk',
    './node_modules/.bin/huaweicloud-devkit.exe secret get secret://user/hw-sk',
  ];
  for (const command of revealCommands) {
    assert.equal(classifyTextCommand(command).decision, 'deny', command);
  }
});

test('secret exec laundering survives adversarial spellings (version specs, shells, segments)', () => {
  const launderedWrites = [
    'npx huaweicloud-devkit@2.3.0 secret exec --env K=x -- bash -c "hcloud ECS CreateServers --cli-region=cn-north-4"',
    "npx huaweicloud-devkit secret exec --env K=x -- bash -c 'hcloud ECS DeleteServers --cli-region=cn-north-4'",
    'echo hello && npx huaweicloud-devkit secret exec -- hcloud ECS CreateServers --cli-region=cn-north-4',
    'node ./plugins/huaweicloud-core/src/setup-cli.ts secret exec -- hcloud ECS NovaCreateServers',
  ];
  for (const command of launderedWrites) {
    const result = classifyTextCommand(command);
    assert.equal(result.decision, 'deny', command);
    assert.match(result.reason ?? '', /write/i, command);
  }
  // Reads through the wrapper stay allowed — the gate is the write, not the wrapper.
  assert.equal(
    classifyTextCommand(
      'npx huaweicloud-devkit@latest secret exec --env K=secret://user/ak -- hcloud ECS ListServers --cli-region=cn-north-4',
    ).decision,
    'allow',
  );
});

test('quote-adjacent hcloud keeps its classification in plain shell too', () => {
  // Pre-existing gap closed alongside the exec unwrap: the presence gate ran
  // on raw text, so `bash -c "hcloud ..."` never routed into the classifier.
  const result = classifyTextCommand('bash -c "hcloud ECS CreateServers --cli-region=cn-north-4"');
  assert.equal(result.decision, 'deny');
  // A quoted hcloud mention that is not a command stays allowed.
  assert.equal(classifyTextCommand('echo "hcloud rocks"').decision, 'allow');
});

test('the reveal deny survives ANSI-C quoting, expansion quotes, and multi-invocation lines', () => {
  const revealCommands = [
    "npx huaweicloud-devkit secret $'get' secret://user/hw-sk --stdout",
    'npx huaweicloud-devkit secret $"get" secret://user/hw-sk --stdout',
    "npx huaweicloud-devkit sec$'r'et get secret://user/hw-sk --stdout",
    'npx huaweicloud-devkit secret g"e"t secret://user/hw-sk --stdout',
  ];
  for (const command of revealCommands) {
    assert.equal(classifyTextCommand(command).decision, 'deny', command);
  }
});

test('secret exec laundering survives earlier devkit invocations and npm separators', () => {
  const launderedWrites = [
    'npx huaweicloud-devkit secret list && npx huaweicloud-devkit secret exec -- bash -c "hcloud ECS CreateServers --cli-region=x"',
    'npx huaweicloud-devkit --version && npx huaweicloud-devkit secret exec -- bash -c "hcloud ECS DeleteServers"',
    'npx -- huaweicloud-devkit secret exec --env K=x -- bash -c "hcloud ECS CreateServers"',
    'npm exec huaweicloud-devkit -- secret exec --env K=x -- bash -c "hcloud ECS DeleteServers"',
    'node dist/setup-cli.mjs secret exec -- bash -c "hcloud ECS DeleteServers"',
    'secret list | npx huaweicloud-devkit secret exec -- hcloud ECS CreateServers',
    // No devkit involvement: a non-leading shell-wrapped segment must classify too.
    'echo hi && bash -c "hcloud ECS CreateServers --cli-region=x"',
  ];
  for (const command of launderedWrites) {
    const result = classifyTextCommand(command);
    assert.equal(result.decision, 'deny', command);
    assert.match(result.reason ?? '', /write/i, command);
  }
});

test('the write gate classifies every line and command position of a payload', () => {
  const denyCases = [
    'hcloud ECS ListServers\nhcloud ECS CreateServers --server.name=x',
    'echo hello\nhcloud ECS CreateServers --server.name=x',
    'hcloud ECS ListServers & hcloud ECS DeleteServers',
    'for i in 1 2 3; do hcloud ECS DeleteServers --server.id=$i; done',
    'echo i-123 | xargs hcloud ECS DeleteServers --server.id=x',
    'env HW_REGION=cn-north-4 hcloud ECS DeleteServers --server.id=x',
    'nohup hcloud ECS DeleteServers --server.id=x',
    '/usr/bin/hcloud ECS DeleteServers',
    './hcloud ECS DeleteServers',
    'echo $(hcloud ECS DeleteServers)',
    'echo `hcloud ECS DeleteServers`',
    "hclou'd' ECS DeleteServers",
    'h\\cloud ECS DeleteServers',
  ];
  for (const command of denyCases) {
    assert.equal(classifyTextCommand(command).decision, 'deny', command);
  }
  // Command-position env prefix stays legitimate; prose and filenames do
  // not fire the env-dump family.
  const allowCases = [
    'env -i hcloud ECS ListServers',
    'cat environment.md | grep nothing',
    'python3 env_setup.py --region cn-north-4 HUAWEICLOUD',
    'npx huaweicloud-devkit secret set secret://user/ak --file /tmp/key.txt',
  ];
  for (const command of allowCases) {
    assert.equal(classifyTextCommand(command).decision, 'allow', command);
  }
});

test('the reveal deny survives npm separators; ANSI-C escape obfuscation is denied outright', () => {
  assert.equal(
    classifyTextCommand('npm exec huaweicloud-devkit -- secret get secret://user/hw-sk --stdout').decision,
    'deny',
  );
  assert.equal(
    classifyTextCommand('npx huaweicloud-devkit -- secret get secret://user/hw-sk --stdout').decision,
    'deny',
  );
  // Escape-sequence ANSI-C builds argv the shadow cannot reconstruct — deny
  // the obfuscated invocation instead of parsing it. Interrogate round 3:
  // with the ANSI-C decode feeding the gate's candidates, the mangled
  // subcommand reconstructs to `secret get` and the reveal-family check
  // fires FIRST with its more actionable message — still denied outright,
  // now with the remediation that actually matches the intent. The reason
  // is pinned to the SPECIFIC reveal text (interrogate round 4: the old
  // /vault secrets|obfuscated/ alternation passed with the decode
  // reverted, via the obfuscation fallback — vacuous).
  const obfuscated = 'npx huaweicloud-devkit secret $' + "'\\x67et' secret://user/hw-sk --stdout";
  const result = classifyTextCommand(obfuscated);
  assert.equal(result.decision, 'deny');
  assert.match(result.reason ?? '', /vault secrets/i);
});

test('the env-dump family closes the full-dump and pipe-grep forms', () => {
  const denyCases = [
    'env',
    'printenv',
    'env -0',
    'export -p | grep HW_',
    'env | grep HW_ACCESS_KEY',
    'printenv PATH HW_SECRET_KEY',
  ];
  for (const command of denyCases) {
    assert.equal(classifyTextCommand(command).decision, 'deny', command);
  }
  assert.equal(classifyTextCommand('printenv PATH').decision, 'allow');
});
