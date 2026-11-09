import assert from 'node:assert/strict';
import test from 'node:test';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';

import { fixtureDir } from './fixture-dir.ts';
import {
  planHcloudCommand,
  redactArgsWithObs,
  type HcloudPlan,
  runHcloud,
  redactOutput,
  type HcloudRunResult,
} from '../plugins/huaweicloud-core/src/hcloud-cli.ts';
import {
  fakeHcloudExecutable,
  fakeHcloudScript,
  isWin,
  withMetaRepo,
  withTempAuthHome,
  type ApprovedRunResult,
  type FakeHcloudOutput,
} from './hcloud-cli-harness.ts';
import { clearRuntimeCredentials, setRuntimeCredentials } from '../plugins/huaweicloud-core/src/auth/credentials.ts';
import { classifyHcloudProbe } from '../plugins/huaweicloud-core/src/hcloud-probe.ts';
import { callTool } from '../plugins/huaweicloud-core/src/tools.ts';

// Deterministic-tier seam: disable the once-per-session first-assertion
// vendor challenge (HUAWEICLOUD_VENDOR_CHALLENGE=off, the installer-override
// pattern). Set before the src imports: the gate captures the env at module
// load, so the harness import's seam is order-dependent — this line is not.
process.env.HUAWEICLOUD_VENDOR_CHALLENGE = 'off';

test('runHcloud retries transient network errors and reports retry count', async () => {
  const stateFile = join(fixtureDir('huaweicloud-toolkit-state-'), 'count.txt');
  const script = fakeHcloudScript(`
import {chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
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
  assert.match(result.stdout!, /ListServersDetails/);
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
  assert.match(result.error!, /timed out/i);
});

test('runHcloud respects cwd parameter', async () => {
  const cwdDir = fixtureDir('huaweicloud-toolkit-cwd-');
  writeFileSync(join(cwdDir, 'test.txt'), 'works', 'utf8');
  const script = fakeHcloudScript(`
import {readFileSync} from 'node:fs';
const content = readFileSync('test.txt', 'utf8');
console.log(content);
`);
  const result = await runHcloud(['test'], {
    executable: process.execPath,
    executableArgs: [script],
    cwd: cwdDir,
    // The single-token fake service must not trip the catalog triage on a
    // machine that carries real metaRepo catalogs — this test pins cwd
    // plumbing, not catalog evidence (2026-11-06 unknown-service triage).
    metaDir: fixtureDir('run-no-meta-'),
  });
  assert.equal(result.ok, true);
  assert.match(result.stdout!, /works/);
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
    metaDir: fixtureDir('run-no-meta-'),
  });
  assert.equal(result.ok, false);
  assert.match(result.stderr!, /something went wrong/);
});

test('runHcloud redacts passwords in output', async () => {
  const script = fakeHcloudScript(`
console.log('adminPass=MySecret123!');
`);
  const result = await runHcloud(['test'], {
    executable: process.execPath,
    executableArgs: [script],
    metaDir: fixtureDir('run-no-meta-'),
  });
  assert.doesNotMatch(result.stdout!, /MySecret123!/);
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
    assert.match(result.authWarning!, /KooCLI current/);
  });
});

test(
  'koocli lang G4: approved plan end-to-end does NOT mutate the approved command',
  { skip: process.platform === 'win32' },
  async () => {
    const home = fixtureDir('appr-home-');
    const metaRepo = join(home, '.hcloud', 'metaRepo');
    mkdirSync(metaRepo, { recursive: true });
    writeFileSync(join(metaRepo, 'services_cn.json'), JSON.stringify({ items: [{ Service: { Text: 'BSS' } }] }));
    writeFileSync(join(metaRepo, 'services_en.json'), JSON.stringify({ items: [{ Service: { Text: 'ECS' } }] }));

    const binDir = fixtureDir('appr-bin-');
    const logFile = join(binDir, 'calls.txt');
    const fake = fakeHcloudExecutable(`
import {appendFileSync} from 'node:fs';
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
      const plan = (await callTool('huaweicloud_plan_cli_command', {
        vendorConfirmed: 'test: vendor established by the harness',
        args: ['BSS', 'ShowCustomerAccountBalances'],
        allowWrites: true,
      })) as HcloudPlan;
      assert.ok(plan.approvalToken, 'plan produces an approvalToken');
      assert.equal(plan.safeToRun, true);
      assert.ok(!plan.args.includes('--cli-lang'), 'approved args carry no lang flag');

      const result = (await callTool('huaweicloud_run_approved_command', {
        vendorConfirmed: 'test: vendor established by the harness',
        args: ['BSS', 'ShowCustomerAccountBalances'],
        approvalToken: plan.approvalToken,
        approvedByUser: true,
        maxRetries: 0,
      })) as ApprovedRunResult;
      assert.equal(result.approved, true, 'approved execution flag preserved');
      assert.equal(result.ok, false, 'command itself failed with Unsupported');
      assert.equal(result.langCause, 'lang-missing');
      assert.match(result.langNextStep!, /hcloud configure set --cli-lang=cn/);
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

test('runHcloud appends STS args to executed command when runtime token is set', async () => {
  await withTempAuthHome(async () => {
    const script = fakeHcloudScript('console.log(JSON.stringify({ ok: true, args: process.argv.slice(2) }));');
    clearRuntimeCredentials();
    setRuntimeCredentials('RUN_AK', 'RUN_SK', 'RUN_TOKEN', 'cn-north-4');
    const result = await runHcloud(['VPC', 'ListVpcs'], { executable: process.execPath, executableArgs: [script] });
    assert.equal(result.ok, true);
    const parsed = JSON.parse(result.stdout!) as FakeHcloudOutput;
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

test('per-call env cannot bypass binary resolution with a stale HCLOUD_BIN', { skip: isWin }, async () => {
  const home = fixtureDir('huaweicloud-toolkit-stale-home-');
  const binDir = join(home, 'bin');
  mkdirSync(binDir, { recursive: true });
  const fake = join(binDir, 'hcloud');
  writeFileSync(
    fake,
    '#!/usr/bin/env node\nconsole.log(JSON.stringify({ ok: true, args: process.argv.slice(2) }));\n',
    'utf8',
  );
  chmodSync(fake, 0o755);
  // HOME redirected and the fake named `hcloud` on a prepended PATH so the
  // candidate tier cannot answer with a machine's real install.
  const savedPath = process.env.PATH;
  const savedBin = process.env.HCLOUD_BIN;
  const savedHome = process.env.HOME;
  process.env.PATH = `${binDir}${delimiter}${savedPath || ''}`;
  delete process.env.HCLOUD_BIN;
  process.env.HOME = home;
  try {
    const result = await runHcloud(['VPC', 'ListVpcs'], {
      env: { HCLOUD_BIN: join(binDir, 'no-such-binary') },
      maxRetries: 0,
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    const parsed = JSON.parse(result.stdout!) as FakeHcloudOutput;
    assert.deepEqual(parsed.args.slice(0, 2), ['VPC', 'ListVpcs'], 'the PATH fake answered');
  } finally {
    process.env.PATH = savedPath;
    if (savedBin === undefined) delete process.env.HCLOUD_BIN;
    else process.env.HCLOUD_BIN = savedBin;
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
  }
});

test('runHcloud does NOT inject STS args for long-lived creds (no token)', async () => {
  await withTempAuthHome(async () => {
    const script = fakeHcloudScript('console.log(JSON.stringify({ ok: true, args: process.argv.slice(2) }));');
    clearRuntimeCredentials();
    const result = await runHcloud(['VPC', 'ListVpcs'], { executable: process.execPath, executableArgs: [script] });
    assert.equal(result.ok, true);
    const parsed = JSON.parse(result.stdout!) as FakeHcloudOutput;
    const injected = parsed.args.filter((a) => a.startsWith('--cli-security-token='));
    assert.equal(injected.length, 0, JSON.stringify(parsed.args));
  });
});

test('runHcloud redacts injected STS from returned plan.rawArgs', async () => {
  await withTempAuthHome(async () => {
    const script = fakeHcloudScript('console.log(JSON.stringify({ ok: true }));');
    clearRuntimeCredentials();
    setRuntimeCredentials('RUN_AK', 'RUN_SK', 'RUN_TOKEN', 'cn-north-4');
    const result = await runHcloud(['VPC', 'ListVpcs'], { executable: process.execPath, executableArgs: [script] });
    assert.equal(result.ok, true);
    const redactedArgs = result.plan!.rawArgs;
    assert.ok(Array.isArray(redactedArgs));
    // Injected STS must be redacted, not present in cleartext.
    assert.ok(redactedArgs.some((a) => a.startsWith('--cli-security-token=')));
    assert.ok(!redactedArgs.includes('--cli-security-token=RUN_TOKEN'));
    assert.ok(!redactedArgs.includes('--cli-access-key=RUN_AK'));
    assert.ok(!redactedArgs.includes('--cli-secret-key=RUN_SK'));
    clearRuntimeCredentials();
  });
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
    const raw = result.plan!.rawArgs;
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

test('A: runHcloud fails fast with CREDENTIAL_EXPIRED for expired temp STS (no exec)', async () => {
  await withTempAuthHome(async () => {
    const marker = join(fixtureDir('hcdk-gate-'), 'ran.txt');
    const script = fakeHcloudScript(`
import {writeFileSync} from 'node:fs';
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
    });
    clearRuntimeCredentials();
    assert.equal(result.ok, false);
    assert.equal(result.code, 'CREDENTIAL_EXPIRED');
    assert.match(result.error ?? '', /STS.*expired/i);
    assert.ok(!existsSync(marker), 'expired STS must not reach hcloud spawn');
  });
});

// Driver for the never-gated family: set a runtime credential shape, run a
// harmless read through a fake hcloud, and clear the runtime store again.
async function runWithRuntimeCreds(
  ak: string,
  sk: string,
  securityToken: string | undefined,
): Promise<HcloudRunResult> {
  const script = fakeHcloudScript('console.log(JSON.stringify({ ok: true, args: process.argv.slice(2) }));');
  clearRuntimeCredentials();
  setRuntimeCredentials(ak, sk, securityToken, 'cn-north-4');
  try {
    return await runHcloud(['VPC', 'ListVpcs'], {
      executable: process.execPath,
      executableArgs: [script],
    });
  } finally {
    clearRuntimeCredentials();
  }
}

test('A: runHcloud does NOT gate permanent AK/SK (no token) when none expired', async () => {
  await withTempAuthHome(async () => {
    const result = await runWithRuntimeCreds('GATE_PERM_AK', 'GATE_PERM_SK', undefined);
    assert.equal(result.ok, true);
    assert.ok(result.code !== 'CREDENTIAL_EXPIRED', 'permanent AK/SK must never be gated');
  });
});

test('A: runHcloud does NOT gate an unparseable-expiry STS token (unknown → inject anyway)', async () => {
  await withTempAuthHome(async () => {
    const result = await runWithRuntimeCreds('GATE_UNK_AK', 'GATE_UNK_SK', 'not-a-parseable-token');
    assert.equal(result.ok, true);
    assert.ok(result.code !== 'CREDENTIAL_EXPIRED', 'unknown expiry must not be treated as expired');
  });
});

// ── D4-24 (#745): approval token precise JSON contract ─────────────────────

test('KooCLI 7.3.12 pin: the OBS write-subcommand advisory covers the new names', () => {
  // The plan advisory (OBS_WRITE_SUBCOMMANDS) fires for the eleven denied
  // obsutil writes (the 7.3.12 additions plus the pre-existing catches) —
  // its vocabulary has no other regression pin.
  for (const op of [
    'bucket-tagging',
    'object-tagging',
    'encryption',
    'custom-domain',
    'mirror-back-to-source',
    'put-public-access-block',
    'delete-public-access-block',
    'abort',
    'archive',
    'create-share',
    'update',
  ]) {
    // custom-domain's real flag form is -cname/certificate options (not
    // -method); the other ten are -method or full-name writes.
    const opArgs = op === 'custom-domain' ? ['-cname=x.com'] : ['-method=put'];
    const plan = planHcloudCommand(['OBS', op, 'obs://bucket', ...opArgs], { allowWrites: false });
    assert.equal(plan.safeToRun, false, `OBS ${op} must not read as safe to run`);
    // The advisory lands in plan.warnings (the OBS mb pin's shape) — asserting
    // the reason regex alone would pass for every OBS deny regardless of
    // OBS_WRITE_SUBCOMMANDS membership.
    assert.ok(
      plan.warnings.some((w) => typeof w === 'string' && /resource manifest/i.test(w)),
      `OBS ${op} should carry the obsutil batch-approval advisory in plan.warnings`,
    );
  }
  // Read controls stay advisory-free.
  const read = planHcloudCommand(['OBS', 'get-public-access-block', 'obs://bucket'], { allowWrites: false });
  assert.equal(read.safeToRun, true);
});

// A4 (#935): the KooCLI 7.2.x per-command version-upgrade banner must never
// reach agent-facing output. The strip is SHAPE-ANCHORED (see
// koocli-version.ts): a JSON value, an error message, or help text that
// merely MENTIONS hcloud update 更新至 survives verbatim — only the banner's
// own line shape is removed.

test('runHcloud strips the KooCLI update banner from command output (#935 A4)', async () => {
  const dir = fixtureDir('huaweicloud-banner-');
  const script = join(dir, 'fake-hcloud.mjs');
  writeFileSync(
    script,
    'console.log("可执行 hcloud update 更新至 7.3.12");\nconsole.log(\'{"result":"ok"}\');\n',
    'utf8',
  );
  const result = await runHcloud(['ECS', 'ListServersDetails'], {
    executable: process.execPath,
    executableArgs: [script],
  });
  assert.ok(!String(result.stdout).includes('hcloud update 更新至'), 'banner must not reach tool output');
  assert.match(String(result.stdout), /result/, 'real output must survive');
});

test('runHcloud strips the banner from stderr too (#935 A4)', async () => {
  const dir = fixtureDir('huaweicloud-banner-err-');
  const script = join(dir, 'fake-hcloud.mjs');
  writeFileSync(
    script,
    'console.error("可执行 hcloud update 更新至 7.3.12");\nconsole.error("boom");\nprocess.exit(1);\n',
    'utf8',
  );
  const result = await runHcloud(['ECS', 'ListServersDetails'], {
    executable: process.execPath,
    executableArgs: [script],
  });
  assert.ok(!String(result.stderr).includes('hcloud update 更新至'), 'banner must not ride stderr either');
  assert.match(String(result.stderr), /boom/, 'the real diagnostic must survive');
});

test('classifyHcloudProbe parses the INSTALLED version, not the banner target (#935 A4)', () => {
  // Banner-first probe output: the banner names the TARGET (7.3.12) while the
  // installed version is 7.2.12 — the classification must see 7.2.12.
  const classified = classifyHcloudProbe({
    status: 0,
    stdout: '可执行 hcloud update 更新至 7.3.12\nKooCLI 当前版本:7.2.12\n',
    stderr: '',
  });
  assert.equal(classified.installedVersion, '7.2.12');
  assert.equal(classified.status, 'version_mismatch');
});

// ── Leading-bin normalization seam (2026-11-05 UX report #6) ────────────────
// The tools take hcloud ARGUMENTS, but agents paste the bin anyway. Before
// the seam, classification stripped the leading token while the plan echo and
// the spawned child kept it (`hcloud hcloud obs ls`), and the OBS-write hint
// plus the required-parameter table silently skipped prefixed input.

test('planHcloudCommand strips a leading hcloud bin token and warns, classification and echo agree', () => {
  const plan = planHcloudCommand(['hcloud', 'obs', 'ls']);
  assert.equal(plan.command, 'hcloud obs ls');
  assert.deepEqual(plan.classification.args, ['obs', 'ls']);
  assert.match(String(plan.warnings[0]), /Leading executable\/wrapper token/);
  // Same-root divergence: prefixed input used to skip the OBS-write hint and
  // the required-parameter table (`hcloud OBS mb` found no table row).
  const prefixedWrite = planHcloudCommand(['hcloud', 'OBS', 'mb']);
  assert.ok(
    prefixedWrite.warnings.some((w) => String(w).includes('obs://')),
    'required-param validation must see the stripped args',
  );
  assert.ok(
    prefixedWrite.warnings.some((w) => String(w).includes('OBS write')),
    'the OBS-write hint must see the stripped args',
  );
  // No false strip: a bucket named hcloud-backup is data, not the bin.
  const keep = planHcloudCommand(['obs', 'ls', 'hcloud-backup']);
  assert.deepEqual(keep.args, ['obs', 'ls', 'hcloud-backup']);
});

test('runHcloud passes the stripped argv to the child (no doubled hcloud prefix)', async () => {
  const fake = fakeHcloudExecutable(`console.log('ARGV:' + process.argv.slice(2).join(','));`);
  const result = await runHcloud(['hcloud', 'obs', 'ls'], { executable: fake, maxRetries: 0 });
  assert.equal(result.ok, true);
  assert.match(result.stdout ?? '', /^ARGV:obs,ls$/m);
});

test('the KooCLI USE_ERROR format-error shape is a PARAM_ERROR, not a false success (#921 family)', async () => {
  // `[USE_ERROR]参数ls的格式错误` exits 0 — the old ok-gate missed the shape
  // and reported ok:true for a command that never ran.
  const fake = fakeHcloudExecutable(`console.log('[USE_ERROR]参数ls的格式错误,正确格式为:--param=value');`);
  const result = await runHcloud(['hcloud', 'obs', 'ls'], { executable: fake, maxRetries: 0 });
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'PARAM_ERROR');
  assert.match(result.errorMessage ?? '', /格式错误/);
});

test('wrapper/env-prefixed input normalizes through the classifier vocabulary (loop round 2 R1)', () => {
  // The classifier deep-unwraps env/sudo prefixes; the seam must too, or
  // plan/argv keep the doubled-bin shape classification never sees.
  for (const prefixed of [
    ['HW_REGION=x', 'hcloud', 'ECS', 'ListServersDetails'],
    ['sudo', 'hcloud', 'obs', 'ls'],
    ['env', 'X=1', 'hcloud', 'obs', 'ls'],
  ] as const) {
    const plan = planHcloudCommand([...prefixed]);
    assert.ok(!plan.command.includes('hcloud hcloud'), `${prefixed[0]} form must not double the bin: ${plan.command}`);
    assert.deepEqual(
      plan.classification.args,
      plan.args,
      `${prefixed[0]} form: classification must see the effective args`,
    );
    assert.match(String(plan.warnings[0]), /Leading executable\/wrapper token/);
  }
  const envObs = planHcloudCommand(['HW_REGION=x', 'hcloud', 'OBS', 'mb']);
  assert.ok(
    envObs.warnings.some((w) => String(w).includes('obs://')),
    'the env-prefixed OBS write must not skip the required-param table',
  );
  assert.ok(!envObs.command.includes('hcloud hcloud'));
});

test('long dotted parameter names are inside the USE_ERROR gate (loop round 2 R5)', async () => {
  // `server.nics.1.subnet_id` (23 chars) escaped the old bounded span and
  // reported ok:true for a command that never ran.
  const fake = fakeHcloudExecutable(
    `console.log('[USE_ERROR]参数server.nics.1.subnet_id的格式错误,正确格式为:--param=value');`,
  );
  const result = await runHcloud(['hcloud', 'ECS', 'ListServersDetails'], { executable: fake, maxRetries: 0 });
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'PARAM_ERROR');
});

test('a successful payload quoting a historical USE_ERROR line stays ok:true (loop round 2 R5)', async () => {
  // Log-query/task-detail results embed past CLI errors mid-text; the
  // ok-gate must not read quoted data as this command's own failure.
  const fake = fakeHcloudExecutable(
    `console.log(JSON.stringify({logs:['2026-01-01 command failed: [USE_ERROR]参数flavorRef的格式错误'],count:3}));`,
  );
  const result = await runHcloud(['obs', 'ls'], { executable: fake, maxRetries: 0 });
  assert.equal(result.ok, true, `quoted USE_ERROR data must not become PARAM_ERROR, got: ${result.errorCode}`);
});

test('a child that exits without reading stdin no longer crashes the process with EPIPE', async () => {
  // Deterministic EPIPE: the child never reads, so the 64KB kernel pipe
  // buffer saturates and node still holds pending stdin bytes when the child
  // exits and the read end closes — the write fails with EPIPE. The tiny
  // default 'y\\n' with a node child loses that race (loop round 2 R8: the
  // first version of this test passed with the handler reverted).
  if (isWin) return; // the deterministic reproduction relies on POSIX pipe semantics
  const fake = fakeHcloudExecutable(`process.exit(0);`);
  const result = await runHcloud(['obs', 'ls'], {
    executable: fake,
    maxRetries: 0,
    stdin: 'x'.repeat(256 * 1024),
  });
  assert.equal(result.ok, true);
});

test('a multi-line payload with a line-initial historical USE_ERROR stays ok:true (loop round 3 S1-B4)', async () => {
  // OBS cat of a log file preserves whole lines; a historical CLI error that
  // begins its own line inside a larger body must not read as THIS command's
  // failure — only a whole-output single USE_ERROR line is a PARAM_ERROR.
  const fake = fakeHcloudExecutable(
    `console.log('2026-10-01 job started');\nconsole.log('[USE_ERROR]参数flavorRef的格式错误,正确格式为:--param=value');\nconsole.log('2026-10-02 job finished');`,
  );
  const result = await runHcloud(['obs', 'cat', 'obs://logs/run.log'], { executable: fake, maxRetries: 0 });
  assert.equal(
    result.ok,
    true,
    `a quoted line-initial USE_ERROR inside data must stay ok:true, got: ${result.errorCode}`,
  );
});
