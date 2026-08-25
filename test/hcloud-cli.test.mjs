import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { planHcloudCommand, runHcloud } from '../plugins/huaweicloud-core/src/hcloud-cli.mjs';

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
