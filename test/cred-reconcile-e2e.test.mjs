// Full-scenario matrix for the credential reconciliation feature.
// Every test is hermetic: HUAWEICLOUD_HOME points at a temp dir, HW_* / HCLOUD_*
// env vars are wiped and restored, runtime credentials are cleared, and none of
// the developer's real ~/.config/huaweicloud or ~/.hcloud files are touched.
// Only masked fingerprints (sha256(ak+sk).slice(0,8)) appear in assertions.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  backupGlobalCredentials,
  clearRuntimeCredentials,
  globalCredentialsPath,
  hasRuntimeCredentials,
  lastSyncPath,
  readGlobalCredentials,
  resolveCredentials,
  resolveCredentialsWithRuntime,
  restoreGlobalCredentialsBackup,
  setRuntimeCredentials,
  writeGlobalCredentials,
  writeObsConfig,
} from '../plugins/huaweicloud-core/src/auth/credentials.mjs';
import { fingerprint, runHcloudConfigure, scanState } from '../plugins/huaweicloud-core/src/auth/reconcile.mjs';
import { syncAuth } from '../plugins/huaweicloud-core/src/auth/service.mjs';
import { callTool } from '../plugins/huaweicloud-core/src/tools.mjs';

const FAKE_HCLOUD = fileURLToPath(new URL('./fixtures/fake-hcloud.mjs', import.meta.url));
const FAKE_HCLOUD_FAIL = fileURLToPath(new URL('./fixtures/fake-hcloud-fail-config.mjs', import.meta.url));

const ENV_KEYS = [
  'HUAWEICLOUD_HOME',
  'HW_ACCESS_KEY',
  'HW_SECRET_KEY',
  'HW_SECURITY_TOKEN',
  'HW_REGION',
  'HUAWEICLOUD_REGION',
  'HCLOUD_BIN',
  'HCLOUD_FAKE_LOG',
  'CODEARTS_PROJECT_DIR',
];

async function withTempHome(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'huaweicloud-e2e-'));
  const prev = {};
  for (const key of ENV_KEYS) prev[key] = process.env[key];
  process.env.HUAWEICLOUD_HOME = dir;
  for (const key of ENV_KEYS) {
    if (key !== 'HUAWEICLOUD_HOME') delete process.env[key];
  }
  clearRuntimeCredentials();
  try {
    return await fn(dir);
  } finally {
    clearRuntimeCredentials();
    for (const key of ENV_KEYS) {
      if (prev[key] === undefined) delete process.env[key];
      else process.env[key] = prev[key];
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

// HUAWEICLOUD_HOME is the temp dir here, so the fake KooCLI config must live
// under it (readKooCliProfiles resolves via baseHome → HUAWEICLOUD_HOME).
function writeFakeKooCli(current, profiles) {
  const p = join(process.env.HUAWEICLOUD_HOME, '.hcloud', 'config.json');
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify({ current, profiles }, null, 2));
  return p;
}

function setFakeHcloud(logPath) {
  process.env.HCLOUD_BIN = FAKE_HCLOUD;
  process.env.HCLOUD_FAKE_LOG = logPath;
}

test('01 auth init path keeps S1/S2-current/S3 fingerprints equal', () => {
  withTempHome((dir) => {
    setFakeHcloud(join(dir, 'hcloud.log'));
    const ak = 'E2E1_AK';
    const sk = 'E2E1_SK';
    const region = 'cn-north-4';
    writeFakeKooCli('deploy', [{ name: 'deploy', accessKeyId: ak, secretAccessKey: sk, region }]);
    writeGlobalCredentials({ ak, sk, region });
    writeObsConfig({ ak, sk, region });
    const res = runHcloudConfigure('deploy', ak, sk, region);
    assert.equal(res.ok, true);

    const scan = scanState();
    assert.equal(scan.stores.s1Fingerprint, fingerprint(ak, sk));
    assert.equal(scan.stores.currentFingerprint, fingerprint(ak, sk));
    assert.equal(scan.stores.s3Fingerprint, fingerprint(ak, sk));
    assert.equal(scan.inconsistencies.length, 0);
  });
});

test('02 manual edit of KooCLI current profile reports S2-current manualModified', () => {
  withTempHome((dir) => {
    writeGlobalCredentials({ ak: 'E2E2_S1_AK', sk: 'E2E2_S1_SK', region: 'cn-north-4' });
    // Marker is written with an old ts BEFORE the config write so the mtime
    // comparison (config mtime > marker ts) is deterministic.
    const cfgDir = join(dir, '.config', 'huaweicloud');
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(lastSyncPath(), JSON.stringify({ ts: Date.now() - 60_000 }));
    writeFakeKooCli('deploy', [
      { name: 'deploy', accessKeyId: 'E2E2_S2_AK', secretAccessKey: 'E2E2_S2_SK', region: 'cn-north-4' },
    ]);

    const scan = scanState();
    const inc = scan.inconsistencies.find((i) => i.store === 'S2-current');
    assert.ok(inc, 'expected an S2-current inconsistency');
    assert.equal(inc.manualModified, true);
  });
});

test('03 manual edit of obsutilconfig reports S3 manualModified', () => {
  withTempHome((dir) => {
    writeGlobalCredentials({ ak: 'E2E3_S1_AK', sk: 'E2E3_S1_SK', region: 'cn-north-4' });
    const cfgDir = join(dir, '.config', 'huaweicloud');
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(lastSyncPath(), JSON.stringify({ ts: Date.now() - 60_000 }));
    writeObsConfig({ ak: 'E2E3_S3_AK', sk: 'E2E3_S3_SK', region: 'cn-north-4' });

    const scan = scanState();
    const inc = scan.inconsistencies.find((i) => i.store === 'S3');
    assert.ok(inc, 'expected an S3 inconsistency');
    assert.equal(inc.manualModified, true);
  });
});

test('04 syncAuth is rejected (R10) while runtime credentials are active', () => {
  withTempHome(() => {
    writeGlobalCredentials({ ak: 'E2E4_AK', sk: 'E2E4_SK', region: 'cn-north-4' });
    setRuntimeCredentials('E2E4_RT_AK', 'E2E4_RT_SK');
    const res = syncAuth('all');
    assert.equal(res.ok, false);
    assert.match(res.error, /R10/);
    assert.match(res.error, /auto-sync suppressed/);
  });
});

test('05 syncAuth propagates S1 into the KooCLI current profile', () => {
  withTempHome((dir) => {
    const log = join(dir, 'hcloud.log');
    setFakeHcloud(log);
    writeFakeKooCli('deploy', [
      { name: 'deploy', accessKeyId: 'E2E5_OLD_AK', secretAccessKey: 'E2E5_OLD_SK', region: 'cn-north-4' },
    ]);
    writeGlobalCredentials({ ak: 'E2E5_AK', sk: 'E2E5_SK', region: 'cn-north-4' });

    const res = syncAuth('all');
    assert.equal(res.ok, true);
    assert.equal(res.profile, 'deploy');

    const logContent = readFileSync(log, 'utf8');
    assert.match(logContent, /--cli-profile=deploy/);
    assert.match(logContent, /--cli-access-key=E2E5_AK/);
    assert.equal(existsSync(lastSyncPath()), true, 'syncAuth must write the .last_sync marker');
  });
});

test('06 auth_switch temporary activates runtime; auth_sync is then rejected (R10)', async () => {
  await withTempHome(async () => {
    writeGlobalCredentials({ ak: 'E2E6_AK', sk: 'E2E6_SK', region: 'cn-north-4' });
    const out = await callTool('huaweicloud_auth_switch', {
      mode: 'memory',
      action: 'temporary',
      ak: 'E2E6_RT_AK',
      sk: 'E2E6_RT_SK',
      region: 'cn-north-4',
    });
    assert.equal(out.status, 'ok');
    assert.equal(out.scope, 'temporary');
    assert.equal(resolveCredentialsWithRuntime({}).ak, 'E2E6_RT_AK');

    const sync = await callTool('huaweicloud_auth_sync', { target: 'all' });
    assert.equal(sync.ok, false);
    assert.match(sync.error, /R10/);
  });
});

test('07 auth_switch persist first time writes configuredBySession and keeps files consistent', async () => {
  await withTempHome(async (dir) => {
    setFakeHcloud(join(dir, 'hcloud.log'));
    const ak = 'E2E7_AK';
    const sk = 'E2E7_SK';
    const region = 'cn-north-4';
    writeFakeKooCli('deploy', [{ name: 'deploy', accessKeyId: ak, secretAccessKey: sk, region }]);

    const out = await callTool('huaweicloud_auth_switch', { mode: 'memory', action: 'persist', ak, sk, region });
    assert.equal(out.status, 'ok');
    assert.equal(out.scope, 'persist');
    assert.equal(readGlobalCredentials().configuredBySession, true);

    const scan = scanState();
    assert.equal(scan.inconsistencies.length, 0);
    assert.equal(scan.stores.s1Fingerprint, fingerprint(ak, sk));
    assert.equal(scan.stores.currentFingerprint, fingerprint(ak, sk));
    assert.equal(scan.stores.s3Fingerprint, fingerprint(ak, sk));
  });
});

test('08 auth_switch persist with conflicting S1 returns needs_confirmation and leaves S1 intact', async () => {
  await withTempHome(async () => {
    writeGlobalCredentials({ ak: 'E2E8_A_AK', sk: 'E2E8_A_SK', region: 'cn-north-4' });
    const out = await callTool('huaweicloud_auth_switch', {
      mode: 'memory',
      action: 'persist',
      ak: 'E2E8_B_AK',
      sk: 'E2E8_B_SK',
      region: 'cn-north-4',
    });
    assert.equal(out.status, 'needs_confirmation');
    assert.ok(typeof out.confirmToken === 'string' && out.confirmToken.length > 0);
    assert.equal(readGlobalCredentials().ak, 'E2E8_A_AK', 'S1 must be unchanged before confirmation');
  });
});

test('09 auth_confirm decision=newImported applies the new account and backs up S1', async () => {
  await withTempHome(async (dir) => {
    setFakeHcloud(join(dir, 'hcloud.log'));
    const newAk = 'E2E9_B_AK';
    const newSk = 'E2E9_B_SK';
    const region = 'cn-north-4';
    // Current profile already matches the new account so the post-confirm scan is consistent.
    writeFakeKooCli('deploy', [{ name: 'deploy', accessKeyId: newAk, secretAccessKey: newSk, region }]);
    writeGlobalCredentials({ ak: 'E2E9_A_AK', sk: 'E2E9_A_SK', region });

    const switched = await callTool('huaweicloud_auth_switch', {
      mode: 'memory',
      action: 'persist',
      ak: newAk,
      sk: newSk,
      region,
    });
    assert.equal(switched.status, 'needs_confirmation');

    const out = await callTool('huaweicloud_auth_confirm', { token: switched.confirmToken, decision: 'newImported' });
    assert.equal(out.status, 'ok');
    assert.equal(out.backedUp, true);
    assert.equal(readGlobalCredentials().ak, newAk);
    assert.equal(readGlobalCredentials().configuredBySession, true);
    assert.equal(existsSync(`${globalCredentialsPath()}.bak`), true, 'backup file must exist');

    const scan = scanState();
    assert.equal(scan.inconsistencies.length, 0);
    assert.equal(scan.stores.s1Fingerprint, fingerprint(newAk, newSk));
    assert.equal(scan.stores.currentFingerprint, fingerprint(newAk, newSk));
    assert.equal(scan.stores.s3Fingerprint, fingerprint(newAk, newSk));
  });
});

test('10 auth_confirm decision=s1 aborts and leaves S1 unchanged', async () => {
  await withTempHome(async () => {
    writeGlobalCredentials({ ak: 'E2E10_A_AK', sk: 'E2E10_A_SK', region: 'cn-north-4' });
    const switched = await callTool('huaweicloud_auth_switch', {
      mode: 'memory',
      action: 'persist',
      ak: 'E2E10_B_AK',
      sk: 'E2E10_B_SK',
      region: 'cn-north-4',
    });
    assert.equal(switched.status, 'needs_confirmation');

    const out = await callTool('huaweicloud_auth_confirm', { token: switched.confirmToken, decision: 's1' });
    assert.equal(out.status, 'ok');
    assert.equal(out.outcome, 'aborted');
    assert.equal(readGlobalCredentials().ak, 'E2E10_A_AK');
  });
});

test('11 auth_switch clear empties runtime and lets syncAuth run again', async () => {
  await withTempHome(async (dir) => {
    const log = join(dir, 'hcloud.log');
    setFakeHcloud(log);
    writeFakeKooCli('deploy', [
      { name: 'deploy', accessKeyId: 'E2E11_OLD', secretAccessKey: 'E2E11_OLD', region: 'cn-north-4' },
    ]);
    setRuntimeCredentials('E2E11_RT_AK', 'E2E11_RT_SK');

    const out = await callTool('huaweicloud_auth_switch', { action: 'clear' });
    assert.equal(out.status, 'cleared');
    assert.equal(hasRuntimeCredentials(), false);

    let threw = false;
    try {
      resolveCredentialsWithRuntime({});
    } catch {
      threw = true;
    }
    assert.equal(threw, true, 'no credentials resolvable after clear');

    writeGlobalCredentials({ ak: 'E2E11_AK', sk: 'E2E11_SK', region: 'cn-north-4' });
    const res = syncAuth('all');
    assert.equal(res.ok, true);
    assert.equal(res.error, undefined);
    assert.doesNotMatch(JSON.stringify(res), /R10/);
    assert.match(readFileSync(log, 'utf8'), /--cli-access-key=E2E11_AK/);
  });
});

test('12 auth_switch mode=import reads creds-import.json then wipes it', async () => {
  await withTempHome(async (dir) => {
    const importPath = join(dir, '.config', 'huaweicloud', 'creds-import.json');
    mkdirSync(dirname(importPath), { recursive: true });
    writeFileSync(importPath, JSON.stringify({ ak: 'E2E12_IMP_AK', sk: 'E2E12_IMP_SK', region: 'cn-north-4' }));

    const out = await callTool('huaweicloud_auth_switch', { mode: 'import', action: 'temporary' });
    assert.equal(out.status, 'ok');
    assert.equal(out.scope, 'temporary');
    assert.equal(existsSync(importPath), false, 'import file must be wiped after reading');

    const resolved = resolveCredentialsWithRuntime({});
    assert.equal(resolved.ak, 'E2E12_IMP_AK');
    assert.equal(resolved.sk, 'E2E12_IMP_SK');
  });
});

test('13 without configuredBySession, env credentials win over S1', () => {
  withTempHome(() => {
    writeGlobalCredentials({ ak: 'E2E13_S1_AK', sk: 'E2E13_S1_SK', region: 'cn-north-4' });
    process.env.HW_ACCESS_KEY = 'E2E13_ENV_AK';
    process.env.HW_SECRET_KEY = 'E2E13_ENV_SK';
    const creds = resolveCredentials();
    assert.equal(creds.ak, 'E2E13_ENV_AK');
    assert.equal(creds.sk, 'E2E13_ENV_SK');
  });
});

test('14 with configuredBySession=true, S1 wins over env (R9)', () => {
  withTempHome(() => {
    writeGlobalCredentials({ ak: 'E2E14_S1_AK', sk: 'E2E14_S1_SK', region: 'cn-north-4', configuredBySession: true });
    process.env.HW_ACCESS_KEY = 'E2E14_ENV_AK';
    process.env.HW_SECRET_KEY = 'E2E14_ENV_SK';
    const creds = resolveCredentials();
    assert.equal(creds.ak, 'E2E14_S1_AK');
    assert.equal(creds.sk, 'E2E14_S1_SK');
  });
});

test('15 active runtime shows in scanState and suppresses auto-write (R10)', () => {
  withTempHome(() => {
    writeGlobalCredentials({ ak: 'E2E15_AK', sk: 'E2E15_SK', region: 'cn-north-4' });
    setRuntimeCredentials('E2E15_RT_AK', 'E2E15_RT_SK');

    const scan = scanState();
    assert.equal(scan.hasRuntime, true);
    assert.equal(scan.stores.runtimeFingerprint, fingerprint('E2E15_RT_AK', 'E2E15_RT_SK'));

    const res = syncAuth('all');
    assert.equal(res.ok, false);
    assert.match(res.error, /R10/);
  });
});

test('16 restoreGlobalCredentialsBackup restores the previous S1', () => {
  withTempHome(() => {
    writeGlobalCredentials({ ak: 'E2E16_A_AK', sk: 'E2E16_A_SK', region: 'cn-north-4' });
    assert.ok(backupGlobalCredentials(), 'initial backup must succeed');
    writeGlobalCredentials({ ak: 'E2E16_B_AK', sk: 'E2E16_B_SK', region: 'cn-north-4' });
    assert.equal(readGlobalCredentials().ak, 'E2E16_B_AK');
    assert.equal(restoreGlobalCredentialsBackup(), true);
    assert.equal(readGlobalCredentials().ak, 'E2E16_A_AK');
  });
});

test('17 persist with securityToken is rejected (R3) and S1 is not written (mode=memory)', async () => {
  await withTempHome(async () => {
    const out = await callTool('huaweicloud_auth_switch', {
      mode: 'memory',
      action: 'persist',
      ak: 'E2E17_AK',
      sk: 'E2E17_SK',
      securityToken: 'E2E17_TOKEN',
      region: 'cn-north-4',
    });
    assert.equal(out.status, 'error');
    assert.equal(out.scope, 'rejected');
    assert.match(out.error, /R3/);
    assert.equal(existsSync(globalCredentialsPath()), false, 'S1 must not be written for STS credentials');
  });
});

test('18 persist via mcp-config with platform STS token is rejected (R3) and S1 untouched', async () => {
  await withTempHome(async (dir) => {
    const mcpDir = join(dir, 'codearts');
    mkdirSync(join(mcpDir, '.codeartsdoer', 'mcp'), { recursive: true });
    writeFileSync(
      join(mcpDir, '.codeartsdoer', 'mcp', 'mcp_settings.json'),
      JSON.stringify({
        mcpServers: {
          'huaweicloud-devkit': {
            env: {
              HW_ACCESS_KEY: 'E2E18_MCP_AK',
              HW_SECRET_KEY: 'E2E18_MCP_SK',
              HW_SECURITY_TOKEN: 'E2E18_MCP_TOKEN',
              HW_REGION: 'cn-north-4',
            },
          },
        },
      }),
      'utf8',
    );
    process.env.CODEARTS_PROJECT_DIR = mcpDir;

    const out = await callTool('huaweicloud_auth_switch', { mode: 'mcp-config', action: 'persist' });
    assert.equal(out.status, 'error');
    assert.equal(out.scope, 'rejected');
    assert.match(out.error, /R3/);
    assert.equal(existsSync(globalCredentialsPath()), false, 'S1 must not be written for platform STS token');

    const stored = readGlobalCredentials();
    assert.ok(!stored?.securityToken, 'no token may be at rest in S1');
  });
});

test('19 malformed creds-import.json is still wiped even though the import is rejected', async () => {
  await withTempHome(async (dir) => {
    const importPath = join(dir, '.config', 'huaweicloud', 'creds-import.json');
    mkdirSync(dirname(importPath), { recursive: true });
    writeFileSync(importPath, '{not-valid-json', 'utf8');

    await assert.rejects(
      callTool('huaweicloud_auth_switch', { mode: 'import', action: 'temporary' }),
      /ak and sk are required/,
    );
    assert.equal(existsSync(importPath), false, 'malformed import file must still be wiped');
  });
});

test('20 syncAuth returns ok:false and skips .last_sync when S2 configure fails', () => {
  withTempHome((dir) => {
    process.env.HCLOUD_BIN = FAKE_HCLOUD_FAIL;
    process.env.HCLOUD_FAKE_LOG = join(dir, 'hcloud.log');
    writeFakeKooCli('deploy', [
      { name: 'deploy', accessKeyId: 'E2E20_OLD_AK', secretAccessKey: 'E2E20_OLD_SK', region: 'cn-north-4' },
    ]);
    writeGlobalCredentials({ ak: 'E2E20_AK', sk: 'E2E20_SK', region: 'cn-north-4' });

    const res = syncAuth('all');
    assert.equal(res.ok, false);
    assert.ok(res.error, 'failure must carry an error message');
    assert.equal(existsSync(lastSyncPath()), false, 'no .last_sync marker may be stamped when S2 sync failed');
  });
});
