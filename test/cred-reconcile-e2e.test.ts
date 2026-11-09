import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import test from 'node:test';

import { syncAuth } from '../plugins/huaweicloud-core/src/auth/service.ts';
import { callTool } from '../plugins/huaweicloud-core/src/tools.ts';
import { fingerprint, runHcloudConfigure, scanState } from '../plugins/huaweicloud-core/src/auth/reconcile.ts';
import {
  clearRuntimeCredentials,
  globalCredentialsPath,
  hasRuntimeCredentials,
  lastSyncPath,
  readGlobalCredentials,
  resolveCredentialsWithRuntime,
  setRuntimeCredentials,
  writeGlobalCredentials,
  writeObsConfig,
} from '../plugins/huaweicloud-core/src/auth/credentials.ts';
import type { AuthSwitchResult } from './cred-reconcile-harness.ts';
import type { SyncAuthResult } from '../plugins/huaweicloud-core/src/auth/service.ts';
import {
  assertDeleteBeforeSet,
  readHcloudCalls,
  setFakeHcloud,
  withTempHome,
  writeFakeKooCli,
} from './cred-reconcile-harness.ts';

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
    // #900: the unified ERROR_TABLE shape — messageZh carries the Chinese
    // verdict, action is executable, and no internal codename (R10) leaks.
    assert.equal(res.code, 'HDKIT_SYNC_SKIPPED_RUNTIME');
    assert.match(res.messageZh ?? '', /运行时凭证生效,自动同步已跳过。/);
    assert.equal(res.action, 'huaweicloud_auth_switch action=clear');
    assert.equal(res.nextStep, res.action);
    assert.doesNotMatch(res.error, /R10/);
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

    // #920: syncAuth walks the SAME purge as the persist path — delete before
    // set — and the honest message carries no stale-token warning on success.
    assertDeleteBeforeSet(readHcloudCalls(log));
    assert.match(res.hcloud.message, /synced to profile=deploy/);
    assert.doesNotMatch(res.hcloud.message, /profile reset failed/);
    assert.doesNotMatch(res.hcloud.message, /project-id not restored/);
    // And the purge's project-id wipe is restored end-to-end.
    assert.equal(res.projectId, 'proj-e2e-001');
  });
});

test('06 auth_switch temporary activates runtime; auth_sync is then rejected (R10)', async () => {
  await withTempHome(async () => {
    writeGlobalCredentials({ ak: 'E2E6_AK', sk: 'E2E6_SK', region: 'cn-north-4' });
    const out = (await callTool('huaweicloud_auth_switch', {
      vendorConfirmed: 'test: vendor established by the harness',
      mode: 'memory',
      action: 'temporary',
      ak: 'E2E6_RT_AK',
      sk: 'E2E6_RT_SK',
      region: 'cn-north-4',
    })) as AuthSwitchResult;
    assert.equal(out.status, 'ok');
    assert.equal(out.scope, 'temporary');
    assert.equal(resolveCredentialsWithRuntime({})!.ak, 'E2E6_RT_AK');

    const sync = (await callTool('huaweicloud_auth_sync', { target: 'all' })) as SyncAuthResult;
    assert.equal(sync.ok, false);
    // #900: the table shape — Chinese messageZh, executable action, no codename.
    assert.equal(sync.code, 'HDKIT_SYNC_SKIPPED_RUNTIME');
    assert.match(sync.messageZh ?? '', /运行时凭证生效,自动同步已跳过。/);
    assert.doesNotMatch(sync.error, /R10/);
  });
});

test('07 auth_switch persist first time writes configuredBySession and keeps files consistent', async () => {
  await withTempHome(async (dir) => {
    setFakeHcloud(join(dir, 'hcloud.log'));
    const ak = 'E2E7_AK';
    const sk = 'E2E7_SK';
    const region = 'cn-north-4';
    writeFakeKooCli('deploy', [{ name: 'deploy', accessKeyId: ak, secretAccessKey: sk, region }]);

    const out = (await callTool('huaweicloud_auth_switch', {
      vendorConfirmed: 'test: vendor established by the harness',
      mode: 'memory',
      action: 'persist',
      ak,
      sk,
      region,
    })) as AuthSwitchResult;
    assert.equal(out.status, 'ok');
    assert.equal(out.scope, 'persist');
    assert.equal(readGlobalCredentials()!.configuredBySession, true);

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
    const out = (await callTool('huaweicloud_auth_switch', {
      vendorConfirmed: 'test: vendor established by the harness',
      mode: 'memory',
      action: 'persist',
      ak: 'E2E8_B_AK',
      sk: 'E2E8_B_SK',
      region: 'cn-north-4',
    })) as AuthSwitchResult;
    assert.equal(out.status, 'needs_confirmation');
    assert.ok(typeof out.confirmToken === 'string' && out.confirmToken.length > 0);
    assert.equal(readGlobalCredentials()!.ak, 'E2E8_A_AK', 'S1 must be unchanged before confirmation');
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

    const switched = (await callTool('huaweicloud_auth_switch', {
      vendorConfirmed: 'test: vendor established by the harness',
      mode: 'memory',
      action: 'persist',
      ak: newAk,
      sk: newSk,
      region,
    })) as AuthSwitchResult;
    assert.equal(switched.status, 'needs_confirmation');

    const out = (await callTool('huaweicloud_auth_confirm', {
      vendorConfirmed: 'test: vendor established by the harness',
      token: switched.confirmToken,
      decision: 'newImported',
    })) as AuthSwitchResult;
    assert.equal(out.status, 'ok');
    assert.equal(out.backedUp, true);
    assert.equal(readGlobalCredentials()!.ak, newAk);
    assert.equal(readGlobalCredentials()!.configuredBySession, true);
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
    const switched = (await callTool('huaweicloud_auth_switch', {
      vendorConfirmed: 'test: vendor established by the harness',
      mode: 'memory',
      action: 'persist',
      ak: 'E2E10_B_AK',
      sk: 'E2E10_B_SK',
      region: 'cn-north-4',
    })) as AuthSwitchResult;
    assert.equal(switched.status, 'needs_confirmation');

    const out = (await callTool('huaweicloud_auth_confirm', {
      vendorConfirmed: 'test: vendor established by the harness',
      token: switched.confirmToken,
      decision: 's1',
    })) as AuthSwitchResult;
    assert.equal(out.status, 'ok');
    assert.equal(out.outcome, 'aborted');
    assert.equal(readGlobalCredentials()!.ak, 'E2E10_A_AK');
  });
});

test('10b auth_confirm(newImported) from import clears the import file on success', async () => {
  await withTempHome(async (dir) => {
    setFakeHcloud(join(dir, 'hcloud.log'));
    const newAk = 'E2E10B_B_AK';
    const newSk = 'E2E10B_B_SK';
    const region = 'cn-north-4';
    writeFakeKooCli('deploy', [{ name: 'deploy', accessKeyId: newAk, secretAccessKey: newSk, region }]);
    writeGlobalCredentials({ ak: 'E2E10B_A_AK', sk: 'E2E10B_A_SK', region });

    const importFile = join(dir, '.config', 'huaweicloud', 'creds-import.json');
    mkdirSync(dirname(importFile), { recursive: true });
    writeFileSync(importFile, JSON.stringify({ ak: newAk, sk: newSk, region }), 'utf8');

    const switched = (await callTool('huaweicloud_auth_switch', {
      vendorConfirmed: 'test: vendor established by the harness',
      mode: 'import',
      action: 'persist',
    })) as AuthSwitchResult;
    assert.equal(switched.status, 'needs_confirmation');
    assert.equal(existsSync(importFile), true, 'import file kept while awaiting confirmation');

    const out = (await callTool('huaweicloud_auth_confirm', {
      vendorConfirmed: 'test: vendor established by the harness',
      token: switched.confirmToken,
      decision: 'newImported',
    })) as AuthSwitchResult;
    assert.equal(out.status, 'ok');
    assert.equal(readGlobalCredentials()!.ak, newAk);
    assert.equal(existsSync(importFile), false, 'import file cleared after successful confirm');
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

    const out = (await callTool('huaweicloud_auth_switch', {
      vendorConfirmed: 'test: vendor established by the harness',
      action: 'clear',
    })) as AuthSwitchResult;
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
    assert.equal((res as { error?: string }).error, undefined);
    assert.doesNotMatch(JSON.stringify(res), /R10/);
    assert.match(readFileSync(log, 'utf8'), /--cli-access-key=E2E11_AK/);
  });
});

// ── UX report #3 (2026-11-05): S1 empty + session-scoped credentials ────────

test('04b syncAuth with empty S1 but active runtime credentials names the session tier', () => {
  withTempHome(() => {
    setRuntimeCredentials('E2E4B_RT_AK', 'E2E4B_RT_SK');
    try {
      const res = syncAuth('all');
      assert.equal(res.ok, false);
      // The generic missing-credential error read as "nothing configured"
      // while auth_status showed the same process as configured; the dedicated
      // code names the state and the persist path.
      assert.equal(res.code, 'HDKIT_SYNC_S1_MISSING_SESSION_ACTIVE');
      assert.match(res.messageZh ?? '', /落盘凭证未配置/);
      assert.match(res.messageZh ?? '', /临时凭证/);
      assert.equal(res.action, 'huaweicloud_auth_switch action=persist');
      assert.equal(res.nextStep, res.action);
    } finally {
      clearRuntimeCredentials();
    }
  });
});

test('04c syncAuth with empty S1 but env credentials reports the same session-tier outcome', () => {
  withTempHome(() => {
    process.env.HW_ACCESS_KEY = 'E2E4C_ENV_AK';
    process.env.HW_SECRET_KEY = 'E2E4C_ENV_SK';
    try {
      const res = syncAuth('all');
      assert.equal(res.ok, false);
      assert.equal(res.code, 'HDKIT_SYNC_S1_MISSING_SESSION_ACTIVE');
    } finally {
      delete process.env.HW_ACCESS_KEY;
      delete process.env.HW_SECRET_KEY;
    }
  });
});

test('04d syncAuth with nothing configured anywhere keeps the generic missing-credential error', () => {
  withTempHome(() => {
    const res = syncAuth('all');
    assert.equal(res.ok, false);
    assert.equal(res.code, 'HDKIT_CRED_MISSING');
    assert.equal(res.action, 'npx huaweicloud-devkit auth init');
  });
});
