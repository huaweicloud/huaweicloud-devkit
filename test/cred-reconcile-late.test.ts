import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import test from 'node:test';

import { getAuthStatus } from '../plugins/huaweicloud-core/src/auth/service.ts';
import { callTool } from '../plugins/huaweicloud-core/src/tools.ts';
import { fingerprint, scanState } from '../plugins/huaweicloud-core/src/auth/reconcile.ts';
import { gatedAuthSwitchCall, type AuthSwitchResult } from './cred-reconcile-harness.ts';
import {
  assertDeleteBeforeSet,
  persistViaSwitch,
  readFakeProfile,
  readHcloudCalls,
  setFakeHcloud,
  withTempHome,
  writeFakeKooCli,
} from './cred-reconcile-harness.ts';
import {
  clearRuntimeCredentials,
  lastSyncPath,
  setRuntimeCredentials,
  writeGlobalCredentials,
} from '../plugins/huaweicloud-core/src/auth/credentials.ts';

test('23 scanState reports manualModified when KooCLI config is newer than .last_sync', () => {
  withTempHome(() => {
    const ak = 'E2E23_AK';
    const sk = 'E2E23_SK';
    const region = 'cn-north-4';
    writeGlobalCredentials({ ak, sk, region });
    writeFileSync(
      lastSyncPath(),
      JSON.stringify({ ts: Date.now() - 60_000, kooCliProfile: 'deploy', s1Fingerprint: fingerprint(ak, sk) }),
      'utf8',
    );
    writeFakeKooCli('deploy', [
      { name: 'deploy', accessKeyId: ak, secretAccessKey: 'encrypted-or-transformed-by-koocli', region },
    ]);

    const scan = scanState();
    const inc = scan.inconsistencies.find((i) => i.store === 'S2-current');
    assert.ok(inc, 'expected an S2-current inconsistency after manual KooCLI edit');
    assert.equal(inc.manualModified, true);
  });
});

test('24 persist without a security token resets the profile (delete + recreate) so a stale token cannot survive (#920)', async () => {
  await withTempHome(async (dir) => {
    setFakeHcloud(join(dir, 'hcloud.log'));
    const ak = 'E2E24_AK';
    const sk = 'E2E24_SK';
    const region = 'cn-north-4';
    writeFakeKooCli('deploy', [{ name: 'deploy', accessKeyId: ak, secretAccessKey: sk, region }]);

    const out = await persistViaSwitch(ak, sk, region);
    assert.equal(out.status, 'ok');
    assert.equal(out.hcloud?.profileReset, true, 'persist without a token must walk the delete/recreate path');

    const calls = readHcloudCalls(join(dir, 'hcloud.log'));
    assertDeleteBeforeSet(calls);
    const deleteIdx = calls.findIndex((c) => c[0] === 'configure' && c[1] === 'delete');
    assert.ok(
      calls[deleteIdx]!.some((a) => String(a).startsWith('--cli-profile=')),
      'the delete must target the managed profile',
    );

    // END state (the fake implements configure delete/set against the real
    // config path): the recreated profile carries the new AK/SK and the
    // project-id the persist re-applies after the purge wiped every setting.
    const recreated = readFakeProfile(dir, 'deploy');
    assert.equal(recreated.accessKeyId, ak);
    assert.equal(recreated.projectId, 'proj-e2e-001', 'project-id is re-applied after the purge');
    assert.ok(!('securityToken' in recreated), 'no security token at rest');

    // The recreated profile keeps the credential stores consistent.
    const scan = scanState();
    assert.equal(scan.inconsistencies.length, 0);
  });
});

test('24b persist still succeeds when the profile to reset does not exist (delete is best-effort, #920)', async () => {
  await withTempHome(async (dir) => {
    setFakeHcloud(join(dir, 'hcloud.log'));
    const ak = 'E2E24B_AK';
    const sk = 'E2E24B_SK';
    writeFakeKooCli('deploy', [{ name: 'deploy', accessKeyId: ak, secretAccessKey: sk, region: 'cn-north-4' }]);
    // Simulate a KooCLI that reports "profile does not exist" on delete.
    process.env.HCLOUD_FAKE_DELETE_ERROR = '1';

    const out = await persistViaSwitch(ak, sk, 'cn-north-4');
    assert.equal(out.status, 'ok');
    assert.equal(out.hcloud?.ok, true, 'a missing profile on delete must not fail the persist');
    assert.equal(out.hcloud?.profileReset, true, '"not exist" on delete counts as nothing-to-clean');
  });
});

test('25 initial scenario: a preset profile with a stale/expired securityToken is reset by persist (#920)', async () => {
  await withTempHome(async (dir) => {
    setFakeHcloud(join(dir, 'hcloud.log'));
    const ak = 'E2E25_AK';
    const sk = 'E2E25_SK';
    const region = 'cn-north-4';
    // Initial scenario: the preset profile already carries a stale/expired
    // securityToken. `configure set` refuses empty values, so the token can
    // never be overwritten in place — only the delete/recreate path removes it.
    writeFakeKooCli('deploy', [
      { name: 'deploy', accessKeyId: ak, secretAccessKey: sk, region, securityToken: 'E2E25_STALE_TOKEN' },
    ]);

    const out = await persistViaSwitch(ak, sk, region);
    assert.equal(out.status, 'ok');
    assert.equal(
      out.hcloud?.profileReset,
      true,
      'persist must walk the delete/recreate path when the preset profile carries a stale token',
    );

    const calls = readHcloudCalls(join(dir, 'hcloud.log'));
    assertDeleteBeforeSet(calls);
    const setIdx = calls.findIndex((c) => c[0] === 'configure' && c[1] === 'set');
    assert.ok(
      calls[setIdx]!.every((a) => !String(a).startsWith('--cli-security-token=')),
      'the re-create must not pass a security token (no new token at rest)',
    );

    // END state: the preset profile's stale securityToken is GONE from the
    // on-disk config (the fake implements the delete/set effects), and the
    // project-id survives the purge via the persist's re-application.
    const recreated = readFakeProfile(dir, 'deploy');
    assert.ok(!('securityToken' in recreated), 'the stale securityToken is gone');
    assert.equal(recreated.projectId, 'proj-e2e-001', 'project-id is re-applied after the purge');

    // The recreated profile keeps the credential stores consistent.
    const scan = scanState();
    assert.equal(scan.inconsistencies.length, 0);
  });
});

test('26 auth_confirm: same token submitted twice returns {status:ok, outcome:already_processed}', async () => {
  await withTempHome(async () => {
    writeGlobalCredentials({ ak: 'E2E26_A_AK', sk: 'E2E26_A_SK', region: 'cn-north-4' });
    const switched = (await gatedAuthSwitchCall({
      mode: 'memory',
      action: 'persist',
      ak: 'E2E26_B_AK',
      sk: 'E2E26_B_SK',
      region: 'cn-north-4',
      vendorConfirmed: 'test: vendor established by the harness',
    })) as AuthSwitchResult;
    assert.equal(switched.status, 'needs_confirmation');

    const first = (await callTool('huaweicloud_auth_confirm', {
      vendorConfirmed: 'test: vendor established by the harness',
      token: switched.confirmToken,
      decision: 's1',
    })) as { status: string; outcome: string };
    assert.equal(first.status, 'ok');
    assert.equal(first.outcome, 'aborted');

    const second = (await callTool('huaweicloud_auth_confirm', {
      vendorConfirmed: 'test: vendor established by the harness',
      token: switched.confirmToken,
      decision: 's1',
    })) as { status: string; outcome: string };
    assert.equal(second.status, 'ok');
    assert.equal(second.outcome, 'already_processed');
  });
});

test("26b auth_confirm: unknown token returns {status:'rejected', code:'CONFIRM_TOKEN_NOT_FOUND'}", async () => {
  await withTempHome(async () => {
    const out = (await callTool('huaweicloud_auth_confirm', {
      vendorConfirmed: 'test: vendor established by the harness',
      token: 'never-created-token',
      decision: 'newImported',
    })) as { status: string; code: string };
    assert.equal(out.status, 'rejected');
    assert.equal(out.code, 'CONFIRM_TOKEN_NOT_FOUND');
  });
});

test('27 auth_status exposes credentialPanel with sts/s1/activeSource', async () => {
  await withTempHome(async () => {
    // No STS anywhere → panel reports S1-absent, activeSource none.
    const bare = getAuthStatus('all');
    assert.equal(bare.credentialPanel.s1.configured, false);
    assert.equal(bare.credentialPanel.activeSource, 'none');
    assert.equal(bare.stsExpiry, null);

    // Permanent S1 → s1 configured with fingerprint, activeSource s1-persistent.
    writeGlobalCredentials({ ak: 'E2E27_AK', sk: 'E2E27_SK', region: 'cn-north-4' });
    const withS1 = getAuthStatus('all');
    assert.equal(withS1.credentialPanel.s1.configured, true);
    assert.equal(withS1.credentialPanel.s1.fingerprint, fingerprint('E2E27_AK', 'E2E27_SK'));
    assert.equal(withS1.credentialPanel.s1.persistent, true);
    assert.equal(withS1.credentialPanel.activeSource, 's1-persistent');

    // Runtime temporary STS (unexpired) → panel's sts half populated and active.
    const future = Math.floor(Date.now() / 1000) + 3600;
    const token = Buffer.from(JSON.stringify({ exp: future })).toString('base64url');
    setRuntimeCredentials('E2E27_RT_AK', 'E2E27_RT_SK', token, 'cn-north-4');
    const withSts = getAuthStatus('all');
    assert.equal(typeof withSts.stsExpiry?.status, 'string');
    assert.equal(withSts.credentialPanel.activeSource, 'temporary-sts');
    clearRuntimeCredentials();
  });
});
