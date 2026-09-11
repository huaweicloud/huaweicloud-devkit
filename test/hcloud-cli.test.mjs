import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  consumeApprovalToken,
  createApprovalToken,
  hashArgs,
  planHcloudCommand,
  runHcloud,
  extractApiError,
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
  'koocli lang G4: approved plan end-to-end runs through internal --cli-lang injection',
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
if (!args.includes('--cli-lang=cn')) {
  console.error('Unsupported service: BSS');
  process.exit(1);
}
console.log(JSON.stringify({ ok: true, seen: args }));
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
      assert.ok(!plan.args.includes('--cli-lang'), 'approved args carry no injected lang flag');

      const result = await callTool('huaweicloud_run_approved_command', {
        args: ['BSS', 'ShowCustomerAccountBalances'],
        approvalToken: plan.approvalToken,
        approvedByUser: true,
        maxRetries: 0,
      });
      assert.equal(result.approved, true, 'approved execution flag preserved');
      assert.equal(result.ok, true);
      assert.equal(result.autoRetried, true, 'lang injection ran inside the approved path');
      assert.equal(result.injectedLang, 'cn');
      assert.deepEqual(JSON.parse(result.stdout).seen, ['BSS', 'ShowCustomerAccountBalances', '--cli-lang=cn']);

      const calls = readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean);
      assert.equal(calls.length, 1, 'exactly one child invocation, lang flag appended internally');
      assert.deepEqual(JSON.parse(calls[0]), ['BSS', 'ShowCustomerAccountBalances', '--cli-lang=cn']);
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
