import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { planHcloudCommand, runHcloud } from '../plugins/huaweicloud-core/src/hcloud-cli.mjs';
import { clearRuntimeCredentials, setRuntimeCredentials } from '../plugins/huaweicloud-core/src/auth/credentials.mjs';

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
