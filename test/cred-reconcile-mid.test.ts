import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import test from 'node:test';

import { fingerprint, scanState } from '../plugins/huaweicloud-core/src/auth/reconcile.ts';
import {
  backupGlobalCredentials,
  globalCredentialsPath,
  lastSyncPath,
  readGlobalCredentials,
  resolveCredentials,
  resolveCredentialsWithRuntime,
  restoreGlobalCredentialsBackup,
  setRuntimeCredentials,
  writeGlobalCredentials,
  writeLastSync,
} from '../plugins/huaweicloud-core/src/auth/credentials.ts';
import { getAuthStatus, syncAuth } from '../plugins/huaweicloud-core/src/auth/service.ts';
import { gatedAuthSwitchCall, type AuthSwitchResult } from './cred-reconcile-harness.ts';
import {
  FAKE_HCLOUD_FAIL,
  FAKE_HCLOUD_FAIL_PROJECT_ID,
  FAKE_HCLOUD_PRIVACY,
  setFakeHcloud,
  withTempHome,
  writeFakeKooCli,
} from './cred-reconcile-harness.ts';

test('12 auth_switch mode=import reads creds-import.json then wipes it', async () => {
  await withTempHome(async (dir) => {
    const importPath = join(dir, '.config', 'huaweicloud', 'creds-import.json');
    mkdirSync(dirname(importPath), { recursive: true });
    writeFileSync(importPath, JSON.stringify({ ak: 'E2E12_IMP_AK', sk: 'E2E12_IMP_SK', region: 'cn-north-4' }));

    const out = (await gatedAuthSwitchCall({
      vendorConfirmed: 'test: vendor established by the harness',
      mode: 'import',
      action: 'temporary',
    })) as AuthSwitchResult;
    assert.equal(out.status, 'ok');
    assert.equal(out.scope, 'temporary');
    assert.equal(existsSync(importPath), false, 'import file must be wiped after reading');

    const resolved = resolveCredentialsWithRuntime({});
    assert.equal(resolved!.ak, 'E2E12_IMP_AK');
    assert.equal(resolved!.sk, 'E2E12_IMP_SK');
  });
});

test('13 without configuredBySession, env credentials win over S1', () => {
  withTempHome(() => {
    writeGlobalCredentials({ ak: 'E2E13_S1_AK', sk: 'E2E13_S1_SK', region: 'cn-north-4' });
    process.env.HW_ACCESS_KEY = 'E2E13_ENV_AK';
    process.env.HW_SECRET_KEY = 'E2E13_ENV_SK';
    const creds = resolveCredentials();
    assert.equal(creds!.ak, 'E2E13_ENV_AK');
    assert.equal(creds!.sk, 'E2E13_ENV_SK');
  });
});

test('14 with configuredBySession=true, S1 wins over env (R9)', () => {
  withTempHome(() => {
    writeGlobalCredentials({ ak: 'E2E14_S1_AK', sk: 'E2E14_S1_SK', region: 'cn-north-4', configuredBySession: true });
    process.env.HW_ACCESS_KEY = 'E2E14_ENV_AK';
    process.env.HW_SECRET_KEY = 'E2E14_ENV_SK';
    const creds = resolveCredentials();
    assert.equal(creds!.ak, 'E2E14_S1_AK');
    assert.equal(creds!.sk, 'E2E14_S1_SK');
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
    // #900: the table shape replaces the old "suppressed (R10)" English string.
    assert.equal(res.code, 'HDKIT_SYNC_SKIPPED_RUNTIME');
    assert.match(res.messageZh ?? '', /运行时凭证生效,自动同步已跳过。/);
    assert.doesNotMatch(res.error, /R10/);
  });
});

test('16 restoreGlobalCredentialsBackup restores the previous S1', () => {
  withTempHome(() => {
    writeGlobalCredentials({ ak: 'E2E16_A_AK', sk: 'E2E16_A_SK', region: 'cn-north-4' });
    assert.ok(backupGlobalCredentials(), 'initial backup must succeed');
    writeGlobalCredentials({ ak: 'E2E16_B_AK', sk: 'E2E16_B_SK', region: 'cn-north-4' });
    assert.equal(readGlobalCredentials()!.ak, 'E2E16_B_AK');
    assert.equal(restoreGlobalCredentialsBackup(), true);
    assert.equal(readGlobalCredentials()!.ak, 'E2E16_A_AK');
  });
});

test('17 persist with securityToken is rejected (R3) and S1 is not written (mode=memory)', async () => {
  await withTempHome(async () => {
    const out = (await gatedAuthSwitchCall({
      vendorConfirmed: 'test: vendor established by the harness',
      mode: 'memory',
      action: 'persist',
      ak: 'E2E17_AK',
      sk: 'E2E17_SK',
      securityToken: 'E2E17_TOKEN',
      region: 'cn-north-4',
    })) as AuthSwitchResult;
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

    const out = (await gatedAuthSwitchCall({
      vendorConfirmed: 'test: vendor established by the harness',
      mode: 'mcp-config',
      action: 'persist',
    })) as AuthSwitchResult;
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
      gatedAuthSwitchCall({
        vendorConfirmed: 'test: vendor established by the harness',
        mode: 'import',
        action: 'temporary',
      }),
      /ak and sk are required/,
    );
    assert.equal(existsSync(importPath), false, 'malformed import file must still be wiped');
  });
});

test('20 syncAuth returns ok:false and skips .last_sync when S2 configure fails', () => {
  withTempHome((dir) => {
    setFakeHcloud(join(dir, 'hcloud.log'), FAKE_HCLOUD_FAIL);
    writeFakeKooCli('deploy', [
      { name: 'deploy', accessKeyId: 'E2E20_OLD_AK', secretAccessKey: 'E2E20_OLD_SK', region: 'cn-north-4' },
    ]);
    writeGlobalCredentials({ ak: 'E2E20_AK', sk: 'E2E20_SK', region: 'cn-north-4' });

    const res = syncAuth('all');
    assert.equal(res.ok, false);
    assert.ok(res.error, 'failure must carry an error message');
    // Non-projectId configure failure: the table's KOOCLI_NOT_READY action
    // would advise reinstalling a CLI the probe just passed — action follows
    // the survivor's auth-init refresh verb instead (coherent remediation).
    assert.equal(res.code, 'HDKIT_KOOCLI_NOT_READY');
    assert.equal(res.action, 'npx huaweicloud-devkit auth init');
    assert.match(res.nextStep ?? '', /real terminal/);
    assert.equal(existsSync(lastSyncPath()), false, 'no .last_sync marker may be stamped when S2 sync failed');
  });
});

test('20b #900: configure failure with project_id stderr routes to HDKIT_PROJECT_ID_MISSING', () => {
  withTempHome((dir) => {
    setFakeHcloud(join(dir, 'hcloud.log'), FAKE_HCLOUD_FAIL_PROJECT_ID);
    writeFakeKooCli('deploy', [
      { name: 'deploy', accessKeyId: 'E2E20B_OLD_AK', secretAccessKey: 'E2E20B_OLD_SK', region: 'cn-north-4' },
    ]);
    writeGlobalCredentials({ ak: 'E2E20B_AK', sk: 'E2E20B_SK', region: 'cn-north-4' });

    const res = syncAuth('all');
    assert.equal(res.ok, false);
    // The projectIdCause heuristic: stderr mentions project id → the table's
    // project-id entry, with the executable configure action as nextStep.
    assert.equal(res.code, 'HDKIT_PROJECT_ID_MISSING');
    assert.match(res.messageZh ?? '', /KooCLI 配置缺少 project_id/);
    assert.match(res.messageZh ?? '', /invalid project id for region/);
    assert.equal(res.action, 'hcloud configure set --cli-project-id=<id>');
    assert.equal(res.nextStep, res.action);
    assert.ok(res.obs?.configured, 'OBS was already written before the configure step');
  });
});

test('20c #900: a not-ready probe routes to HDKIT_KOOCLI_NOT_READY with raw side-channel', () => {
  withTempHome((dir) => {
    setFakeHcloud(join(dir, 'hcloud.log'), FAKE_HCLOUD_PRIVACY);
    writeFakeKooCli('deploy', [
      { name: 'deploy', accessKeyId: 'E2E20C_OLD_AK', secretAccessKey: 'E2E20C_OLD_SK', region: 'cn-north-4' },
    ]);
    writeGlobalCredentials({ ak: 'E2E20C_AK', sk: 'E2E20C_SK', region: 'cn-north-4' });

    const res = syncAuth('all');
    assert.equal(res.ok, false);
    assert.equal(res.code, 'HDKIT_KOOCLI_NOT_READY');
    assert.match(res.messageZh ?? '', /隐私协议待同意/);
    // Top-level nextStep is the executable table action; the verbose
    // English guidance (accept the agreement in a real terminal) is raw-only.
    assert.equal(res.nextStep, 'npx huaweicloud-devkit install-hcloud');
    assert.match(res.raw ?? '', /privacy agreement/i);
    assert.match(res.raw ?? '', /real terminal/);

    // getAuthStatus surfaces the same composition: executable kooCliNextStep
    // plus the verbose kooCliRaw side-channel.
    const status = getAuthStatus('all');
    assert.equal(status.kooCliStatus, 'privacy_pending');
    assert.equal(status.kooCliNextStep, 'npx huaweicloud-devkit install-hcloud');
    assert.match(status.kooCliRaw ?? '', /privacy agreement/i);
  });
});

test('21 scanState trusts fresh DevKit sync marker when KooCLI stores transformed SK', () => {
  withTempHome(() => {
    const ak = 'E2E21_AK';
    const sk = 'E2E21_SK';
    const region = 'cn-north-4';
    writeGlobalCredentials({ ak, sk, region });
    writeFakeKooCli('deploy', [
      { name: 'deploy', accessKeyId: ak, secretAccessKey: 'encrypted-or-transformed-by-koocli', region },
    ]);
    writeLastSync({ kooCliProfile: 'deploy', s1Fingerprint: fingerprint(ak, sk) });

    const scan = scanState();
    assert.equal(scan.stores.currentFingerprint, fingerprint(ak, sk));
    assert.equal(
      scan.inconsistencies.some((i) => i.store === 'S2-current'),
      false,
    );
  });
});

test('22 scanState still reports S2-current mismatch when KooCLI AK differs from S1', () => {
  withTempHome(() => {
    const ak = 'E2E22_AK';
    const sk = 'E2E22_SK';
    const region = 'cn-north-4';
    writeGlobalCredentials({ ak, sk, region });
    writeFakeKooCli('deploy', [
      { name: 'deploy', accessKeyId: 'E2E22_OTHER_AK', secretAccessKey: 'encrypted-or-transformed-by-koocli', region },
    ]);
    writeLastSync({ kooCliProfile: 'deploy', s1Fingerprint: fingerprint(ak, sk) });

    const scan = scanState();
    const inc = scan.inconsistencies.find((i) => i.store === 'S2-current');
    assert.ok(inc, 'expected an S2-current inconsistency');
  });
});
