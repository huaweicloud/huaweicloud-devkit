import assert from 'node:assert/strict';
import test from 'node:test';

import { callTool } from '../plugins/huaweicloud-core/src/tools.ts';
import { extractApiError, resolveStsInjectArgs, type HcloudPlan } from '../plugins/huaweicloud-core/src/hcloud-cli.ts';
import { withTempAuthHome } from './hcloud-cli-harness.ts';
import { clearRuntimeCredentials, setRuntimeCredentials } from '../plugins/huaweicloud-core/src/auth/credentials.ts';

// Deterministic-tier seam: disable the once-per-session first-assertion
// vendor challenge (HUAWEICLOUD_VENDOR_CHALLENGE=off, the installer-override
// pattern). Set before the src imports: the gate captures the env at module
// load, so the harness import's seam is order-dependent — this line is not.
process.env.HUAWEICLOUD_VENDOR_CHALLENGE = 'off';

test('koocli lang G4: approval token still rejects args that differ from the approved plan', async () => {
  // Isolated home: without it the minted token lands in the real home's
  // approvals.json, where parallel test processes' mints race the whole-file
  // read-modify-write. A lost mint resolves the run as a structured
  // CONFIRM_TOKEN_NOT_FOUND instead of throwing, and assert.rejects reads
  // that as "Missing expected rejection" (observed once on ubuntu-22, PR
  // #10). Every sibling approval test isolates the home; this one was born
  // without the wrapper.
  await withTempAuthHome(async () => {
    const plan = (await callTool('huaweicloud_plan_cli_command', {
      vendorConfirmed: 'test: vendor established by the harness',
      args: ['BSS', 'ShowCustomerAccountBalances'],
      allowWrites: true,
    })) as HcloudPlan;
    await assert.rejects(
      callTool('huaweicloud_run_approved_command', {
        vendorConfirmed: 'test: vendor established by the harness',
        args: ['BSS', 'DifferentOperation'],
        approvalToken: plan.approvalToken,
        approvedByUser: true,
      }),
      /do not match the approved plan/,
    );
  });
});

test('koocli lang: extractApiError keeps JSON keys stable under Chinese KooCLI output', () => {
  const result = extractApiError(
    'ListVpcs有多个版本,默认使用该API版本v3{ "error_code": "BSS.0001", "error_msg": "指定余额不足" }',
  );
  assert.equal(result!.errorCode, 'BSS.0001');
  assert.equal(result!.errorMessage, '指定余额不足');
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

test('resolveStsInjectArgs skips when obsutil attached -iAK/-kSK/-tTOK present', () => {
  clearRuntimeCredentials();
  setRuntimeCredentials('STS_AK', 'STS_SK', 'STS_TOKEN', 'cn-north-4');
  assert.deepEqual(resolveStsInjectArgs(['OBS', 'ls', '-iAK_VAL']), []);
  assert.deepEqual(resolveStsInjectArgs(['OBS', 'ls', '-kSK_VAL', '-tTOK_VAL']), []);
  assert.deepEqual(resolveStsInjectArgs(['OBS', 'ls', '-iAK_VAL', '-d']), []);
  clearRuntimeCredentials();
});

// ── CREDENTIAL_EXPIRED fast-fail (#919 follow-up UX) ────────────────────────
