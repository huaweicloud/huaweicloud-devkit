import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  consumeApprovalToken,
  createApprovalToken,
  hashArgs,
  inspectApprovalToken,
  planHcloudCommand,
  redactArgsWithObs,
  resolveStsInjectArgs,
  runHcloud,
  extractApiError,
  redactOutput,
} from '../plugins/huaweicloud-core/src/hcloud-cli.mjs';
import { clearRuntimeCredentials, setRuntimeCredentials } from '../plugins/huaweicloud-core/src/auth/credentials.mjs';
import { callTool } from '../plugins/huaweicloud-core/src/tools.mjs';

async function withTempAuthHome(fn) {
  const home = mkdtempSync(join(tmpdir(), 'huaweicloud-toolkit-auth-'));
  const previous = {
    HUAWEICLOUD_HOME: process.env.HUAWEICLOUD_HOME,
    HCLOUD_CONFIG_PATH: process.env.HCLOUD_CONFIG_PATH,
    HCLOUD_OBS_CONFIG_PATH: process.env.HCLOUD_OBS_CONFIG_PATH,
    HW_ACCESS_KEY: process.env.HW_ACCESS_KEY,
    HW_SECRET_KEY: process.env.HW_SECRET_KEY,
    HW_SECURITY_TOKEN: process.env.HW_SECURITY_TOKEN,
  };
  process.env.HUAWEICLOUD_HOME = home;
  process.env.HCLOUD_CONFIG_PATH = join(home, '.hcloud', 'config.json');
  process.env.HCLOUD_OBS_CONFIG_PATH = join(home, '.obsutilconfig');
  delete process.env.HW_ACCESS_KEY;
  delete process.env.HW_SECRET_KEY;
  delete process.env.HW_SECURITY_TOKEN;
  try {
    return await fn(home);
  } finally {
    clearRuntimeCredentials();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(home, { recursive: true, force: true });
  }
}

function fakeHcloudScript(source) {
  const dir = mkdtempSync(join(tmpdir(), 'huaweicloud-toolkit-'));
  const script = join(dir, 'fake-hcloud.mjs');
  writeFileSync(script, source, 'utf8');
  return script;
}

function fakeHcloudExecutable(source) {
  const dir = mkdtempSync(join(tmpdir(), 'huaweicloud-toolkit-bin-'));
  const script = join(dir, 'fake-hcloud');
  writeFileSync(script, `#!/usr/bin/env node\n${source}`, 'utf8');
  chmodSync(script, 0o755);
  return script;
}

function withMetaRepo(files) {
  const dir = mkdtempSync(join(tmpdir(), 'huaweicloud-toolkit-meta-'));
  for (const [name, items] of Object.entries(files)) {
    writeFileSync(join(dir, name), JSON.stringify({ items }));
  }
  return dir;
}

test('planHcloudCommand includes copyable command text and password history warning', () => {
  const plan = planHcloudCommand(['ECS', 'CreateServers', '--server.adminPass=Secret123!'], {
    allowWrites: true,
  });
  assert.match(plan.executableBlock, /hcloud ECS CreateServers/);
  assert.ok(plan.warnings.some((warning) => /shell history/i.test(warning)));
});

test('planHcloudCommand correctly classifies read-only command', () => {
  const plan = planHcloudCommand(['ECS', 'ListServersDetails']);
  assert.equal(plan.classification.decision, 'allow');
  assert.equal(plan.safeToRun, true);
});

test('planHcloudCommand marks write command as unsafe without approval', () => {
  const plan = planHcloudCommand(['ECS', 'CreateServers']);
  assert.equal(plan.safeToRun, false);
  assert.equal(plan.classification.decision, 'deny');
});

test('planHcloudCommand adds resource-manifest hint for OBS write operations', () => {
  const plan = planHcloudCommand(['OBS', 'mb', 'obs://test-bucket', '-location=cn-north-4']);
  assert.ok(plan.warnings.some((warning) => /resource manifest/i.test(warning)));
  assert.equal(plan.classification.decision, 'deny');
});

test('planHcloudCommand adds no manifest hint for OBS read operations', () => {
  const plan = planHcloudCommand(['OBS', 'ls']);
  assert.ok(!plan.warnings.some((warning) => /resource manifest/i.test(warning)));
});

test('createApprovalToken persists hashed/redacted args and never raw secrets', async () => {
  await withTempAuthHome((home) => {
    const token = createApprovalToken(['ECS', 'CreateServers', '--server.adminPass=Secret123!']);
    const file = join(home, '.config', 'huaweicloud', 'approvals.json');
    assert.ok(existsSync(file), 'approval file must be persisted to disk');
    const raw = readFileSync(file, 'utf8');
    assert.ok(raw.includes(token), 'token must be present in the persisted file');
    assert.ok(!raw.includes('Secret123'), 'plaintext secret must never be written to disk');

    const stored = consumeApprovalToken(token);
    assert.ok(stored);
    assert.equal(stored.argsHash, hashArgs(['ECS', 'CreateServers', '--server.adminPass=Secret123!']));
    assert.ok(Array.isArray(stored.argsRedacted));
    assert.ok(!JSON.stringify(stored).includes('Secret123'));

    // single-use
    assert.equal(consumeApprovalToken(token), null);
  });
});

test('approval token survives a fresh file read (cross-process) and expires by TTL', async () => {
  await withTempAuthHome((home) => {
    const token = createApprovalToken(['OBS', 'mb', 'obs://bucket']);
    // consume reads from the file (single source of truth), not from a memory map
    const stored = consumeApprovalToken(token);
    assert.equal(stored.argsHash, hashArgs(['OBS', 'mb', 'obs://bucket']));

    // TTL: backdate an entry to before the window and expect null
    const ttlToken = createApprovalToken(['OBS', 'rm', 'obs://bucket']);
    const file = join(home, '.config', 'huaweicloud', 'approvals.json');
    const map = JSON.parse(readFileSync(file, 'utf8'));
    map[ttlToken].createdAt = Date.now() - 6 * 60_000;
    writeFileSync(file, JSON.stringify(map), 'utf8');
    assert.equal(consumeApprovalToken(ttlToken), null);
  });
});

test('runHcloud retries transient network errors and reports retry count', async () => {
  const stateFile = join(mkdtempSync(join(tmpdir(), 'huaweicloud-toolkit-state-')), 'count.txt');
  const script = fakeHcloudScript(`
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
const stateFile = ${JSON.stringify(stateFile)};
const count = existsSync(stateFile) ? Number(readFileSync(stateFile, 'utf8')) : 0;
writeFileSync(stateFile, String(count + 1));
if (count === 0) {
  console.error('[NETWORK_ERROR]Connection timed out');
  process.exit(1);
}
console.log(JSON.stringify({ ok: true, args: process.argv.slice(2) }));
`);
  const result = await runHcloud(['ECS', 'ListServersDetails'], {
    executable: process.execPath,
    executableArgs: [script],
    maxRetries: 1,
    retryBaseDelayMs: 1,
  });
  assert.equal(result.ok, true);
  assert.equal(result.retries, 1);
  assert.match(result.stdout, /ListServersDetails/);
});

test('runHcloud returns a timeout result instead of hanging', async () => {
  const script = fakeHcloudScript('setTimeout(() => {}, 10_000);');
  const result = await runHcloud(['ECS', 'ListServersDetails'], {
    executable: process.execPath,
    executableArgs: [script],
    timeoutMs: 50,
    forceKillAfterMs: 50,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'TIMEOUT');
  assert.match(result.error, /timed out/i);
});

test('runHcloud respects cwd parameter', async () => {
  const cwdDir = mkdtempSync(join(tmpdir(), 'huaweicloud-toolkit-cwd-'));
  writeFileSync(join(cwdDir, 'test.txt'), 'works', 'utf8');
  const script = fakeHcloudScript(`
import { readFileSync } from 'node:fs';
const content = readFileSync('test.txt', 'utf8');
console.log(content);
`);
  const result = await runHcloud(['test'], {
    executable: process.execPath,
    executableArgs: [script],
    cwd: cwdDir,
  });
  assert.equal(result.ok, true);
  assert.match(result.stdout, /works/);
});

test('921 A: exit code 0 but output carries a KooCLI parameter error → ok:false with PARAM_ERROR', async () => {
  const script = fakeHcloudScript(`
console.log('[ERROR]: unknown parameter: --delete_ip');
process.exit(0);
`);
  const result = await runHcloud(['ECS', 'ListServersDetails', '--delete_ip=true'], {
    executable: process.execPath,
    executableArgs: [script],
    maxRetries: 0,
  });
  assert.equal(result.ok, false, 'a parameter error with exit 0 must NOT be reported as success');
  assert.equal(result.errorCode, 'PARAM_ERROR');
  assert.match(result.errorMessage, /unknown parameter/);
});

test('921 A: non-zero exit code with "successfully" in a failed output → ok:false (old broad regex false positive)', async () => {
  const script = fakeHcloudScript(`
console.log('upload successfully, but rollback completed');
console.error('ERROR: create failed after upload');
process.exit(1);
`);
  const result = await runHcloud(['ECS', 'ListServersDetails'], {
    executable: process.execPath,
    executableArgs: [script],
    maxRetries: 0,
  });
  assert.equal(result.ok, false, 'a failed output mentioning "successfully" must not be reported as success');
});

test('921 A: OBS non-zero exit with a clean success output stays ok:true (narrowed heuristic, #57)', async () => {
  const script = fakeHcloudScript(`
console.log('Upload successfully, 3 files, 1.2 KB');
process.exit(1);
`);
  const result = await runHcloud(['OBS', 'ls', 'obs://test-bucket'], {
    executable: process.execPath,
    executableArgs: [script],
    maxRetries: 0,
  });
  assert.equal(result.ok, true, 'obsutil-style commands return non-zero on success (#57) — kept for OBS only');
});

test('runHcloud captures stderr and returns failed status', async () => {
  const script = fakeHcloudScript(`
console.error('something went wrong');
process.exit(1);
`);
  const result = await runHcloud(['failing'], {
    executable: process.execPath,
    executableArgs: [script],
    maxRetries: 0,
  });
  assert.equal(result.ok, false);
  assert.match(result.stderr, /something went wrong/);
});

test('runHcloud redacts passwords in output', async () => {
  const script = fakeHcloudScript(`
console.log('adminPass=MySecret123!');
`);
  const result = await runHcloud(['test'], {
    executable: process.execPath,
    executableArgs: [script],
  });
  assert.doesNotMatch(result.stdout, /MySecret123!/);
});

test('redactOutput redacts bare token= via redactSecrets reuse (#726 D4-27)', () => {
  // Plain-text path: redactOutput falls back to redactSecrets(text).
  const textOut = redactOutput('token=TokenValueABCDEF123456');
  assert.equal(textOut, 'token=<redacted>');
  assert.doesNotMatch(textOut, /TokenValueABCDEF123456/);
  // JSON path: redactOutput parses JSON then redacts via redactSecrets.
  const jsonOut = redactOutput('{"token": "TokenValueABCDEF123456", "note": "keep"}');
  const parsed = JSON.parse(jsonOut);
  assert.equal(parsed.token, '<redacted>');
  assert.equal(parsed.note, 'keep');
  // No regression on long token-bearing keys and other secrets.
  const reg = redactOutput('security_token=stABC\nx_auth_token=xatABC\npassword=pw1');
  assert.equal(reg, 'security_token=<redacted>\nx_auth_token=<redacted>\npassword=<redacted>');
});

test('redactOutput redacts admin-pass / admin_pass / adminPass variants (#726 D4-27 v2)', () => {
  // Text path: all three separator forms must redact under the /i flag.
  assert.equal(redactOutput('adminPass=Secret123!'), 'adminPass=<redacted>');
  assert.equal(redactOutput('admin-pass=Secret123!'), 'admin-pass=<redacted>');
  assert.equal(redactOutput('admin_pass=Secret123!'), 'admin_pass=<redacted>');
  // JSON path: object-key normalization already classifies all variants.
  const jsonOut = redactOutput('{"admin-pass": "Secret123!", "admin_pass": "v2"}');
  const parsed = JSON.parse(jsonOut);
  assert.equal(parsed['admin-pass'], '<redacted>');
  assert.equal(parsed.admin_pass, '<redacted>');
});

test('runHcloud succeeds with active runtime credentials and no KooCLI config (no-crash, no authWarning)', async () => {
  const script = fakeHcloudScript(`
console.log(JSON.stringify({ ok: true }));
`);
  await withTempAuthHome(async () => {
    setRuntimeCredentials('RT_AK', 'RT_SK', undefined, 'cn-north-4');
    const result = await runHcloud(['--version'], {
      executable: process.execPath,
      executableArgs: [script],
    });
    assert.equal(result.ok, true);
    assert.equal(result.authWarning, undefined);
  });
});

test('runHcloud emits authWarning when runtime differs from current profile', async () => {
  const script = fakeHcloudScript(`
console.log(JSON.stringify({ ok: true }));
`);
  await withTempAuthHome(async (home) => {
    const cfgDir = join(home, '.hcloud');
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(
      join(cfgDir, 'config.json'),
      JSON.stringify({
        current: 'deploy',
        profiles: [{ name: 'deploy', accessKeyId: 'CUR_AK', secretAccessKey: 'CUR_SK', region: 'cn-north-4' }],
      }),
      'utf8',
    );
    setRuntimeCredentials('RT_AK', 'RT_SK', undefined, 'cn-north-4');
    const result = await runHcloud(['--version'], {
      executable: process.execPath,
      executableArgs: [script],
    });
    assert.equal(result.ok, true);
    assert.match(result.authWarning, /KooCLI current/);
  });
});

test(
  'koocli lang G4: approved plan end-to-end does NOT mutate the approved command',
  { skip: process.platform === 'win32' },
  async () => {
    const home = mkdtempSync(join(tmpdir(), 'appr-home-'));
    const metaRepo = join(home, '.hcloud', 'metaRepo');
    mkdirSync(metaRepo, { recursive: true });
    writeFileSync(join(metaRepo, 'services_cn.json'), JSON.stringify({ items: [{ Service: { Text: 'BSS' } }] }));
    writeFileSync(join(metaRepo, 'services_en.json'), JSON.stringify({ items: [{ Service: { Text: 'ECS' } }] }));

    const binDir = mkdtempSync(join(tmpdir(), 'appr-bin-'));
    const logFile = join(binDir, 'calls.txt');
    const fake = fakeHcloudExecutable(`
import { appendFileSync } from 'node:fs';
const logFile = ${JSON.stringify(logFile)};
const args = process.argv.slice(2);
appendFileSync(logFile, JSON.stringify(args) + '\\n');
console.error('Unsupported service: BSS');
process.exit(1);
`);

    const previousHome = process.env.HOME;
    const previousBin = process.env.HCLOUD_BIN;
    process.env.HOME = home;
    process.env.HCLOUD_BIN = fake;
    try {
      const plan = await callTool('huaweicloud_plan_cli_command', {
        args: ['BSS', 'ShowCustomerAccountBalances'],
        allowWrites: true,
      });
      assert.ok(plan.approvalToken, 'plan produces an approvalToken');
      assert.equal(plan.safeToRun, true);
      assert.ok(!plan.args.includes('--cli-lang'), 'approved args carry no lang flag');

      const result = await callTool('huaweicloud_run_approved_command', {
        args: ['BSS', 'ShowCustomerAccountBalances'],
        approvalToken: plan.approvalToken,
        approvedByUser: true,
        maxRetries: 0,
      });
      assert.equal(result.approved, true, 'approved execution flag preserved');
      assert.equal(result.ok, false, 'command itself failed with Unsupported');
      assert.equal(result.langCause, 'lang-missing');
      assert.match(result.langNextStep, /hcloud configure set --cli-lang=cn/);
      assert.equal(result.injectedLang, undefined, 'no lang flag injected into the approved command');
      assert.equal(result.autoRetried, undefined);

      const calls = readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean);
      assert.equal(calls.length, 1, 'exactly one child invocation, command unchanged');
      assert.deepEqual(JSON.parse(calls[0]), ['BSS', 'ShowCustomerAccountBalances']);
    } finally {
      process.env.HOME = previousHome;
      if (previousBin === undefined) delete process.env.HCLOUD_BIN;
      else process.env.HCLOUD_BIN = previousBin;
      rmSync(home, { recursive: true, force: true });
      rmSync(binDir, { recursive: true, force: true });
    }
  },
);

test('koocli lang G4: approval token still rejects args that differ from the approved plan', async () => {
  const plan = await callTool('huaweicloud_plan_cli_command', {
    args: ['BSS', 'ShowCustomerAccountBalances'],
    allowWrites: true,
  });
  await assert.rejects(
    callTool('huaweicloud_run_approved_command', {
      args: ['BSS', 'DifferentOperation'],
      approvalToken: plan.approvalToken,
      approvedByUser: true,
    }),
    /do not match the approved plan/,
  );
});

test('hcloud binding path: placeholder rejection never burns the token; corrected retry executes', async () => {
  const home = mkdtempSync(join(tmpdir(), 'huaweicloud-binding-'));
  const binDir = mkdtempSync(join(tmpdir(), 'huaweicloud-binding-bin-'));
  const logFile = join(binDir, 'calls.txt');
  const fake = fakeHcloudExecutable(`
import { appendFileSync } from 'node:fs';
const logFile = ${JSON.stringify(logFile)};
appendFileSync(logFile, JSON.stringify(process.argv.slice(2)) + '\\n');
console.log('{"ok": true}');
`);
  const previousHome = process.env.HOME;
  const previousBin = process.env.HCLOUD_BIN;
  process.env.HOME = home;
  process.env.HCLOUD_BIN = fake;
  try {
    // The plan displays the secret slot redacted; the approval binds the
    // RAW args.
    const plan = await callTool('huaweicloud_plan_cli_command', {
      args: ['ECS', 'CreateServers', '--admin_pass', 'AAA', '--cli-region=cn-north-4'],
      allowWrites: true,
    });
    assert.ok(plan.args.includes('<redacted>'), 'plan display scrubs the secret slot');
    // Placeholder echo: loud rejection, token NOT consumed.
    await assert.rejects(
      callTool('huaweicloud_run_approved_command', {
        args: ['ECS', 'CreateServers', '--admin_pass', '<redacted>', '--cli-region=cn-north-4'],
        approvalToken: plan.approvalToken,
        approvedByUser: true,
      }),
      /placeholder/,
    );
    // Corrected retry with the real value: executes (the shared
    // binding-before-consume restructure, on the hcloud wiring).
    const retry = await callTool('huaweicloud_run_approved_command', {
      args: ['ECS', 'CreateServers', '--admin_pass', 'AAA', '--cli-region=cn-north-4'],
      approvalToken: plan.approvalToken,
      approvedByUser: true,
    });
    assert.equal(retry.approved, true);
    assert.notEqual(retry.outcome, 'already_processed');
    const calls = readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean);
    assert.equal(calls.length, 1, 'exactly one child invocation');
    assert.ok(JSON.parse(calls[0]).includes('AAA'), 'the real secret reached the child');
  } finally {
    process.env.HOME = previousHome;
    if (previousBin === undefined) delete process.env.HCLOUD_BIN;
    else process.env.HCLOUD_BIN = previousBin;
    rmSync(home, { recursive: true, force: true });
    rmSync(binDir, { recursive: true, force: true });
  }
});

test('koocli lang: extractApiError keeps JSON keys stable under Chinese KooCLI output', () => {
  const result = extractApiError(
    'ListVpcs有多个版本,默认使用该API版本v3{ "error_code": "BSS.0001", "error_msg": "指定余额不足" }',
  );
  assert.equal(result.errorCode, 'BSS.0001');
  assert.equal(result.errorMessage, '指定余额不足');
});

test('runHcloud surfaces Chinese-mode KooCLI JSON error with code and message', async () => {
  const metaDir = withMetaRepo({
    'services_cn.json': [{ Service: { Text: 'ECS' } }],
    'services_en.json': [{ Service: { Text: 'ECS' } }],
  });
  const script = fakeHcloudScript(`
console.log('ListVpcs有多个版本,默认使用该API版本v3' + '{ "error_code": "BSS.0001", "error_msg": "指定余额不足" }');
process.exit(1);
`);
  try {
    const result = await runHcloud(['ECS', 'ListServersDetails'], {
      executable: process.execPath,
      executableArgs: [script],
      maxRetries: 0,
      metaDir,
    });
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, 'BSS.0001');
    assert.equal(result.errorMessage, '指定余额不足');
  } finally {
    rmSync(metaDir, { recursive: true, force: true });
    rmSync(join(script, '..'), { recursive: true, force: true });
  }
});

test('resolveStsInjectArgs returns empty for long-lived creds (no token)', () => {
  clearRuntimeCredentials();
  setRuntimeCredentials('AK_NO_TOKEN', 'SK_NO_TOKEN', '');
  assert.deepEqual(resolveStsInjectArgs(['ECS', 'ListServersDetails']), []);
  clearRuntimeCredentials();
});

test('resolveStsInjectArgs injects STS args for live runtime tokens', () => {
  clearRuntimeCredentials();
  setRuntimeCredentials('STS_AK', 'STS_SK', 'STS_TOKEN', 'cn-north-4');
  const injected = resolveStsInjectArgs(['VPC', 'ListVpcs']);
  assert.deepEqual(injected, ['--cli-access-key=STS_AK', '--cli-secret-key=STS_SK', '--cli-security-token=STS_TOKEN']);
  clearRuntimeCredentials();
});

test('resolveStsInjectArgs uses obsutil -i/-k/-t for OBS subcommands', () => {
  clearRuntimeCredentials();
  setRuntimeCredentials('STS_AK', 'STS_SK', 'STS_TOKEN', 'cn-north-4');
  const injected = resolveStsInjectArgs(['OBS', 'ls']);
  assert.deepEqual(injected, ['-i', 'STS_AK', '-k', 'STS_SK', '-t', 'STS_TOKEN']);
  clearRuntimeCredentials();
});

test('resolveStsInjectArgs still injects when obsutil WORD options are present (-include/-threshold are not credentials)', () => {
  clearRuntimeCredentials();
  setRuntimeCredentials('STS_AK', 'STS_SK', 'STS_TOKEN', 'cn-north-4');
  // The taught static-website workflow shape: word-form options must not
  // skip STS injection (only credential shapes -iAK/-i=AK/-kSK/-tTOKEN
  // and the separated -i/-k/-t do).
  const injected = resolveStsInjectArgs([
    'OBS',
    'cp',
    'dist',
    'obs://b',
    '-include=*.html',
    '-exclude=*.js',
    '-threshold=52428800',
    '-acl=public-read',
  ]);
  assert.deepEqual(injected, ['-i', 'STS_AK', '-k', 'STS_SK', '-t', 'STS_TOKEN']);
  clearRuntimeCredentials();
});

test('runHcloud appends STS args to executed command when runtime token is set', async () => {
  await withTempAuthHome(async () => {
    const script = fakeHcloudScript('console.log(JSON.stringify({ ok: true, args: process.argv.slice(2) }));');
    clearRuntimeCredentials();
    setRuntimeCredentials('RUN_AK', 'RUN_SK', 'RUN_TOKEN', 'cn-north-4');
    const result = await runHcloud(['VPC', 'ListVpcs'], { executable: process.execPath, executableArgs: [script] });
    assert.equal(result.ok, true);
    const parsed = JSON.parse(result.stdout);
    // Secret values are redacted to `<redacted>`; presence proves injection.
    assert.ok(
      parsed.args.some((a) => a.startsWith('--cli-security-token=')),
      JSON.stringify(parsed.args),
    );
    assert.ok(parsed.args.some((a) => a.startsWith('--cli-access-key=')));
    assert.ok(parsed.args.some((a) => a.startsWith('--cli-secret-key=')));
    clearRuntimeCredentials();
  });
});

test('runHcloud does NOT inject STS args for long-lived creds (no token)', async () => {
  await withTempAuthHome(async () => {
    const script = fakeHcloudScript('console.log(JSON.stringify({ ok: true, args: process.argv.slice(2) }));');
    clearRuntimeCredentials();
    const result = await runHcloud(['VPC', 'ListVpcs'], { executable: process.execPath, executableArgs: [script] });
    assert.equal(result.ok, true);
    const parsed = JSON.parse(result.stdout);
    const injected = parsed.args.filter((a) => a.startsWith('--cli-security-token='));
    assert.equal(injected.length, 0, JSON.stringify(parsed.args));
  });
});

test('resolveStsInjectArgs skips help/metadata commands', () => {
  clearRuntimeCredentials();
  setRuntimeCredentials('STS_AK', 'STS_SK', 'STS_TOKEN', 'cn-north-4');
  assert.deepEqual(resolveStsInjectArgs(['--help']), []);
  assert.deepEqual(resolveStsInjectArgs(['ECS', '--help']), []);
  assert.deepEqual(resolveStsInjectArgs(['help']), []);
  clearRuntimeCredentials();
});

test('resolveStsInjectArgs skips bash/sudo wrapper invocations', () => {
  clearRuntimeCredentials();
  setRuntimeCredentials('STS_AK', 'STS_SK', 'STS_TOKEN', 'cn-north-4');
  assert.deepEqual(resolveStsInjectArgs(['bash', '-c', 'hcloud ECS ListServersDetails']), []);
  assert.deepEqual(resolveStsInjectArgs(['sudo', 'hcloud', 'ECS', 'ListServersDetails']), []);
  assert.deepEqual(resolveStsInjectArgs(['/bin/sh', '-c', 'hcloud ECS ListServersDetails']), []);
  clearRuntimeCredentials();
});

test('resolveStsInjectArgs skips configure/config and existing explicit creds', () => {
  clearRuntimeCredentials();
  setRuntimeCredentials('STS_AK', 'STS_SK', 'STS_TOKEN', 'cn-north-4');
  assert.deepEqual(resolveStsInjectArgs(['configure', 'set']), []);
  assert.deepEqual(resolveStsInjectArgs(['config', 'list']), []);
  assert.deepEqual(resolveStsInjectArgs(['ECS', 'ListServersDetails', '--cli-access-key=EXPLICIT']), []);
  assert.deepEqual(resolveStsInjectArgs(['OBS', 'ls', '-i', 'EXPLICIT']), []);
  clearRuntimeCredentials();
});

test('resolveStsInjectArgs honors HUAWEICLOUD_INJECT_STS_CMD=0 kill switch', () => {
  clearRuntimeCredentials();
  setRuntimeCredentials('STS_AK', 'STS_SK', 'STS_TOKEN', 'cn-north-4');
  const prev = process.env.HUAWEICLOUD_INJECT_STS_CMD;
  try {
    process.env.HUAWEICLOUD_INJECT_STS_CMD = '0';
    assert.deepEqual(resolveStsInjectArgs(['VPC', 'ListVpcs']), []);
  } finally {
    if (prev === undefined) delete process.env.HUAWEICLOUD_INJECT_STS_CMD;
    else process.env.HUAWEICLOUD_INJECT_STS_CMD = prev;
  }
  clearRuntimeCredentials();
});

test('runHcloud redacts injected STS from returned plan.rawArgs', async () => {
  await withTempAuthHome(async () => {
    const script = fakeHcloudScript('console.log(JSON.stringify({ ok: true }));');
    clearRuntimeCredentials();
    setRuntimeCredentials('RUN_AK', 'RUN_SK', 'RUN_TOKEN', 'cn-north-4');
    const result = await runHcloud(['VPC', 'ListVpcs'], { executable: process.execPath, executableArgs: [script] });
    assert.equal(result.ok, true);
    const redactedArgs = result.plan.rawArgs;
    assert.ok(Array.isArray(redactedArgs));
    // Injected STS must be redacted, not present in cleartext.
    assert.ok(redactedArgs.some((a) => a.startsWith('--cli-security-token=')));
    assert.ok(!redactedArgs.includes('--cli-security-token=RUN_TOKEN'));
    assert.ok(!redactedArgs.includes('--cli-access-key=RUN_AK'));
    assert.ok(!redactedArgs.includes('--cli-secret-key=RUN_SK'));
    clearRuntimeCredentials();
  });
});

test('resolveStsInjectArgs skips injection when security token is expired (R3)', () => {
  clearRuntimeCredentials();
  const past = Math.floor(Date.now() / 1000) - 120; // expired 2 min ago
  const token = Buffer.from(JSON.stringify({ exp: past })).toString('base64url');
  setRuntimeCredentials('STS_AK', 'STS_SK', token, 'cn-north-4');
  assert.deepEqual(resolveStsInjectArgs(['VPC', 'ListVpcs']), []);
  clearRuntimeCredentials();
});

test('resolveStsInjectArgs skips injection when expiry is within 60s grace (R3)', () => {
  clearRuntimeCredentials();
  const soon = Math.floor(Date.now() / 1000) + 30; // expires in 30s
  const token = Buffer.from(JSON.stringify({ exp: soon })).toString('base64url');
  setRuntimeCredentials('STS_AK', 'STS_SK', token, 'cn-north-4');
  assert.deepEqual(resolveStsInjectArgs(['VPC', 'ListVpcs']), []);
  clearRuntimeCredentials();
});

test('resolveStsInjectArgs still injects when expiry is unparseable (R3 fallback)', () => {
  clearRuntimeCredentials();
  setRuntimeCredentials('STS_AK', 'STS_SK', 'HSTANOTATOKEN', 'cn-north-4');
  const injected = resolveStsInjectArgs(['VPC', 'ListVpcs']);
  assert.ok(injected.length > 0);
  assert.ok(injected.some((a) => a.startsWith('--cli-security-token=')));
  clearRuntimeCredentials();
});

test('resolveStsInjectArgs injects when expiry is in the future (R3)', () => {
  clearRuntimeCredentials();
  const future = Math.floor(Date.now() / 1000) + 3600; // 1h out
  const token = Buffer.from(JSON.stringify({ exp: future })).toString('base64url');
  setRuntimeCredentials('STS_AK', 'STS_SK', token, 'cn-north-4');
  const injected = resolveStsInjectArgs(['VPC', 'ListVpcs']);
  assert.ok(injected.some((a) => a.startsWith('--cli-security-token=')));
  clearRuntimeCredentials();
});

test('redactArgsWithObs redacts obsutil -i/-k/-t standalone values', () => {
  const out = redactArgsWithObs(['OBS', 'ls', '-i', 'SOME_AK', '-k', 'SOME_SK', '-t', 'SOME_TOKEN']);
  assert.deepEqual(out, ['OBS', 'ls', '-i', '<redacted>', '-k', '<redacted>', '-t', '<redacted>']);
});

test('redactArgsWithObs redacts hcloud key=value form and leaves non-secrets', () => {
  const out = redactArgsWithObs(['VPC', 'ListVpcs', '--cli-access-key=AK', '--cli-region=cn-south-1']);
  assert.ok(out.some((a) => a === '--cli-access-key=<redacted>'));
  assert.ok(out.includes('--cli-region=cn-south-1'));
});

test('runHcloud redacts OBS STS args from returned plan.rawArgs', async () => {
  await withTempAuthHome(async () => {
    const script = fakeHcloudScript('console.log(JSON.stringify({ ok: true }));');
    clearRuntimeCredentials();
    setRuntimeCredentials('OBS_AK', 'OBS_SK', 'OBS_TOKEN', 'cn-south-1');
    const result = await runHcloud(['OBS', 'ls'], { executable: process.execPath, executableArgs: [script] });
    assert.equal(result.ok, true);
    const raw = result.plan.rawArgs;
    // The injected OBS STS values must be redacted, not in cleartext.
    const joined = raw.join(' ');
    assert.ok(!joined.includes('OBS_AK'));
    assert.ok(!joined.includes('OBS_SK'));
    assert.ok(!joined.includes('OBS_TOKEN'));
    // -i / -k / -t placeholders present.
    assert.ok(joined.includes('-i <redacted>') || joined.includes('-i<redacted>'), JSON.stringify(raw));
    clearRuntimeCredentials();
  });
});

test('resolveStsInjectArgs skips when obsutil attached -iAK/-kSK/-tTOK present', () => {
  clearRuntimeCredentials();
  setRuntimeCredentials('STS_AK', 'STS_SK', 'STS_TOKEN', 'cn-north-4');
  assert.deepEqual(resolveStsInjectArgs(['OBS', 'ls', '-iAK_VAL']), []);
  assert.deepEqual(resolveStsInjectArgs(['OBS', 'ls', '-kSK_VAL', '-tTOK_VAL']), []);
  assert.deepEqual(resolveStsInjectArgs(['OBS', 'ls', '-iAK_VAL', '-d']), []);
  clearRuntimeCredentials();
});

test('D3-B7: runHcloud spawn error result includes ok and exitCode fields', async () => {
  const result = await runHcloud(['ECS', 'ListServersDetails'], {
    executable: '/nonexistent/hcloud-binary-that-does-not-exist',
    maxRetries: 0,
  });
  assert.equal(result.ok, false);
  assert.ok('exitCode' in result, 'exitCode must be present in spawn error result');
  assert.equal(result.exitCode, null);
  assert.equal(result.code, 'SPAWN_ERROR');
});

test('D3-B7: runHcloud timeout result includes ok and exitCode fields', async () => {
  const script = fakeHcloudScript('setTimeout(() => {}, 10_000);');
  const result = await runHcloud(['ECS', 'ListServersDetails'], {
    executable: process.execPath,
    executableArgs: [script],
    timeoutMs: 50,
    forceKillAfterMs: 50,
    maxRetries: 0,
  });
  assert.equal(result.ok, false);
  assert.ok('exitCode' in result, 'exitCode must be present in timeout result');
  assert.equal(result.code, 'TIMEOUT');
  rmSync(join(script, '..'), { recursive: true, force: true });
});

test('D3-B7: runHcloud approved command result includes ok and exitCode on success', async () => {
  // Use process.execPath + HCLOUD_BIN_ARGS_JSON instead of a shebang script,
  // so spawn(shell:false) works on Windows where shebang scripts are not executed
  // (same pattern as #771 d166294 and test/auth-credentials.test.mjs:116).
  const script = fakeHcloudScript(`
console.log(JSON.stringify({ vpcs: [{ id: 'vpc-123', name: 'test-vpc', cidr: '192.168.0.0/16' }] }));
`);
  const previousBin = process.env.HCLOUD_BIN;
  const previousArgsJson = process.env.HCLOUD_BIN_ARGS_JSON;
  process.env.HCLOUD_BIN = process.execPath;
  process.env.HCLOUD_BIN_ARGS_JSON = JSON.stringify([script]);
  await withTempAuthHome(async () => {
    const plan = await callTool('huaweicloud_plan_cli_command', {
      args: ['VPC', 'ListVpcs'],
      allowWrites: true,
    });
    assert.ok(plan.approvalToken, 'plan produces an approvalToken');
    assert.equal(plan.safeToRun, true);

    const result = await callTool('huaweicloud_run_approved_command', {
      args: ['VPC', 'ListVpcs'],
      approvalToken: plan.approvalToken,
      approvedByUser: true,
      maxRetries: 0,
    });
    assert.equal(result.approved, true);
    assert.ok('ok' in result, 'ok must be present in approved command result');
    assert.ok('exitCode' in result, 'exitCode must be present in approved command result');
    assert.equal(result.ok, true);
    assert.equal(result.exitCode, 0);
  });
  if (previousBin === undefined) delete process.env.HCLOUD_BIN;
  else process.env.HCLOUD_BIN = previousBin;
  if (previousArgsJson === undefined) delete process.env.HCLOUD_BIN_ARGS_JSON;
  else process.env.HCLOUD_BIN_ARGS_JSON = previousArgsJson;
  rmSync(join(script, '..'), { recursive: true, force: true });
});

test('A: runHcloud fails fast with CREDENTIAL_EXPIRED for expired temp STS (no exec)', async () => {
  await withTempAuthHome(async () => {
    const marker = join(mkdtempSync(join(tmpdir(), 'hcdk-gate-')), 'ran.txt');
    const script = fakeHcloudScript(`
import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(marker)}, 'executed', 'utf8');
console.log(JSON.stringify({ ok: true }));
`);
    const past = Math.floor(Date.now() / 1000) - 300; // expired 5 min ago
    const token = Buffer.from(JSON.stringify({ exp: past })).toString('base64url');
    clearRuntimeCredentials();
    setRuntimeCredentials('GATE_AK', 'GATE_SK', token, 'cn-north-4');
    const result = await runHcloud(['VPC', 'ListVpcs'], {
      executable: process.execPath,
      executableArgs: [script],
      maxRetries: 0,
    });
    clearRuntimeCredentials();
    assert.equal(result.ok, false);
    assert.equal(result.code, 'CREDENTIAL_EXPIRED');
    assert.match(result.error, /STS.*expired/i);
    assert.ok(!existsSync(marker), 'expired STS must not reach hcloud spawn');
    rmSync(join(script, '..'), { recursive: true, force: true });
    rmSync(join(marker, '..'), { recursive: true, force: true });
  });
});

test('A: runHcloud does NOT gate permanent AK/SK (no token) when none expired', async () => {
  await withTempAuthHome(async () => {
    const script = fakeHcloudScript('console.log(JSON.stringify({ ok: true, args: process.argv.slice(2) }));');
    clearRuntimeCredentials();
    const result = await runHcloud(['VPC', 'ListVpcs'], {
      executable: process.execPath,
      executableArgs: [script],
    });
    assert.equal(result.ok, true);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.args.length, 2, JSON.stringify(parsed.args)); // VPC ListVpcs only
  });
});

test('A: runHcloud does NOT gate temp STS with unknown expiry (can not prove stale)', async () => {
  await withTempAuthHome(async () => {
    const script = fakeHcloudScript('console.log(JSON.stringify({ ok: true, args: process.argv.slice(2) }));');
    clearRuntimeCredentials();
    setRuntimeCredentials('GATE_AK', 'GATE_SK', 'NOT_A_DECODABLE_TOKEN', 'cn-north-4');
    const result = await runHcloud(['VPC', 'ListVpcs'], {
      executable: process.execPath,
      executableArgs: [script],
    });
    clearRuntimeCredentials();
    assert.equal(result.ok, true);
    assert.ok(result.code !== 'CREDENTIAL_EXPIRED');
  });
});

// D4-24 (#745): approval token precise JSON contract.
// Expired and already-consumed tokens must return structured results with
// machine-assertable codes instead of throwing a generic Error string.
test('inspectApprovalToken classifies a fresh token as valid', async () => {
  await withTempAuthHome(() => {
    const token = createApprovalToken(['ECS', 'ListServersDetails']);
    const inspection = inspectApprovalToken(token);
    assert.equal(inspection.state, 'valid');
    assert.ok(inspection.entry, 'valid state carries the stored entry');
    assert.equal(inspection.entry.argsHash, hashArgs(['ECS', 'ListServersDetails']));
  });
});

test('inspectApprovalToken classifies an expired token as expired', async () => {
  await withTempAuthHome((home) => {
    const token = createApprovalToken(['ECS', 'ListServersDetails']);
    const file = join(home, '.config', 'huaweicloud', 'approvals.json');
    const map = JSON.parse(readFileSync(file, 'utf8'));
    map[token].createdAt = Date.now() - 6 * 60_000;
    writeFileSync(file, JSON.stringify(map), 'utf8');

    const inspection = inspectApprovalToken(token);
    assert.equal(inspection.state, 'expired');
    assert.equal(inspection.entry, undefined, 'expired state does not leak the entry');
  });
});

test('inspectApprovalToken classifies an already-consumed token as already_consumed', async () => {
  await withTempAuthHome(() => {
    const token = createApprovalToken(['ECS', 'ListServersDetails']);
    const first = consumeApprovalToken(token);
    assert.ok(first, 'first consume returns the stored entry');

    const inspection = inspectApprovalToken(token);
    assert.equal(inspection.state, 'already_consumed');
  });
});

test('inspectApprovalToken classifies an unknown token as not_found', async () => {
  await withTempAuthHome(() => {
    const inspection = inspectApprovalToken('never-created-uuid');
    assert.equal(inspection.state, 'not_found');
  });
});

test('consumeApprovalToken keeps a tombstone so the second call is distinguishable from not_found', async () => {
  await withTempAuthHome(() => {
    const token = createApprovalToken(['ECS', 'ListServersDetails']);
    const first = consumeApprovalToken(token);
    assert.ok(first);
    // Second consume still returns null (backward compatible), but
    // inspectApprovalToken must report already_consumed, not not_found.
    assert.equal(consumeApprovalToken(token), null);
    assert.equal(inspectApprovalToken(token).state, 'already_consumed');
  });
});

// D4-24 (#745): runApprovedCommand returns precise JSON for expired and
// already-processed tokens instead of throwing a generic Error string.
test('runApprovedCommand: expired token returns {status:rejected, code:CONFIRM_TOKEN_EXPIRED}', async () => {
  await withTempAuthHome(async (home) => {
    const fake = fakeHcloudExecutable('console.log(JSON.stringify({ ok: true }));');
    const prevBin = process.env.HCLOUD_BIN;
    process.env.HCLOUD_BIN = fake;
    try {
      const plan = await callTool('huaweicloud_plan_cli_command', {
        args: ['ECS', 'ListServersDetails'],
      });
      assert.ok(plan.approvalToken);

      // Backdate the token past the 5-minute TTL.
      const file = join(home, '.config', 'huaweicloud', 'approvals.json');
      const map = JSON.parse(readFileSync(file, 'utf8'));
      map[plan.approvalToken].createdAt = Date.now() - 6 * 60_000;
      writeFileSync(file, JSON.stringify(map), 'utf8');

      const result = await callTool('huaweicloud_run_approved_command', {
        args: ['ECS', 'ListServersDetails'],
        approvalToken: plan.approvalToken,
        approvedByUser: true,
        maxRetries: 0,
      });
      assert.equal(result.status, 'rejected');
      assert.equal(result.code, 'CONFIRM_TOKEN_EXPIRED');
    } finally {
      if (prevBin === undefined) delete process.env.HCLOUD_BIN;
      else process.env.HCLOUD_BIN = prevBin;
      rmSync(join(fake, '..'), { recursive: true, force: true });
    }
  });
});

test('runApprovedCommand: same token submitted twice returns {status:ok, outcome:already_processed}', async () => {
  await withTempAuthHome(async () => {
    const fake = fakeHcloudExecutable('console.log(JSON.stringify({ ok: true }));');
    const prevBin = process.env.HCLOUD_BIN;
    process.env.HCLOUD_BIN = fake;
    try {
      const plan = await callTool('huaweicloud_plan_cli_command', {
        args: ['ECS', 'ListServersDetails'],
      });
      assert.ok(plan.approvalToken);

      const first = await callTool('huaweicloud_run_approved_command', {
        args: ['ECS', 'ListServersDetails'],
        approvalToken: plan.approvalToken,
        approvedByUser: true,
        maxRetries: 0,
      });
      assert.equal(first.approved, true, 'first call executes the command');

      const second = await callTool('huaweicloud_run_approved_command', {
        args: ['ECS', 'ListServersDetails'],
        approvalToken: plan.approvalToken,
        approvedByUser: true,
        maxRetries: 0,
      });
      assert.equal(second.status, 'ok');
      assert.equal(second.outcome, 'already_processed');
    } finally {
      if (prevBin === undefined) delete process.env.HCLOUD_BIN;
      else process.env.HCLOUD_BIN = prevBin;
      rmSync(join(fake, '..'), { recursive: true, force: true });
    }
  });
});

test('runApprovedCommand: unknown token returns {status:rejected, code:CONFIRM_TOKEN_NOT_FOUND}', async () => {
  await withTempAuthHome(async () => {
    const result = await callTool('huaweicloud_run_approved_command', {
      args: ['ECS', 'ListServersDetails'],
      approvalToken: 'never-created-uuid',
      approvedByUser: true,
      maxRetries: 0,
    });
    assert.equal(result.status, 'rejected');
    assert.equal(result.code, 'CONFIRM_TOKEN_NOT_FOUND');
  });
});
