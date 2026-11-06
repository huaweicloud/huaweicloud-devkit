import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  classifyHcloudArgs,
  classifyTextCommand,
  deriveSecretOperationAlternation,
  loadPolicy,
  redactSecrets,
} from '../plugins/huaweicloud-core/src/safety-policy.ts';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

test('classifyHcloudArgs blocks secret value reads', () => {
  const result = classifyHcloudArgs(['CSMS', 'ShowSecretVersion', '--secret_name', 'prod/db']);
  assert.equal(result.decision, 'deny');
  assert.match(result.reason ?? '', /secret value/i);
});

test('classifyHcloudArgs blocks ShowSecret as an operation (#770 D4-3)', () => {
  const result = classifyHcloudArgs(['CSMS', 'ShowSecret', '--secret_name', 'prod/db']);
  assert.equal(result.decision, 'deny');
  assert.equal(result.risk, 'secret');
});

test('classifyHcloudArgs blocks unapproved writes', () => {
  const result = classifyHcloudArgs(['ECS', 'NovaCreateServers', '--body', '{}']);
  assert.equal(result.decision, 'deny');
  assert.match(result.reason ?? '', /write operation/i);
});

test('classifyHcloudArgs blocks Apply* operations as writes (#644)', () => {
  // EIP ApplyEip was classified as unknown_read and allowed through (issue #644 EXP-E04).
  const applyWrites = [
    ['EIP', 'ApplyEip'],
    ['WAF', 'ApplyCertificateToHost'],
    ['CDN', 'ApplyDomainTemplate'],
    ['RDS', 'ApplyConfigurationAsync'],
  ];
  for (const args of applyWrites) {
    const result = classifyHcloudArgs(args);
    assert.equal(result.decision, 'deny', args.join(' '));
    assert.equal(result.risk, 'write', args.join(' '));
  }
});

test('classifyHcloudArgs keeps read operations containing Apply substring as read-only', () => {
  const result = classifyHcloudArgs(['ECS', 'ListConfigurationApplyHistories']);
  assert.equal(result.decision, 'allow');
  assert.equal(result.risk, 'read_only');
});

test('classifyHcloudArgs allows local help for Apply operations', () => {
  const result = classifyHcloudArgs(['EIP', 'ApplyEip', '--help']);
  assert.equal(result.decision, 'allow');
  assert.equal(result.risk, 'local_metadata');
});

test('classifyHcloudArgs unwraps shell-wrapped hcloud write commands (#650 D4-16)', () => {
  const wrapped = [
    ['bash', '-c', 'hcloud ECS CreateServers --flavor=x'],
    ['sh', '-c', 'hcloud CCE DeleteCluster --cluster_id=x'],
    ['bash', '-c', 'sudo hcloud OBS rm obs://bucket/obj'],
    ['sudo', 'hcloud', 'ECS', 'CreateServers'],
    ['/bin/bash', '-c', 'bash -c "hcloud ECS DeleteServers --servers=[]"'],
  ];
  for (const args of wrapped) {
    const result = classifyHcloudArgs(args);
    assert.equal(result.decision, 'deny', args.join(' '));
    assert.equal(result.risk, 'write', args.join(' '));
  }
});

test('classifyHcloudArgs detects hcloud write commands mid-concatenation (#650 review)', () => {
  const concatenated = [
    ['bash', '-c', 'echo x; hcloud ECS CreateServers --flavor=x'],
    ['bash', '-c', 'echo done && hcloud CCE DeleteCluster --cluster_id=x'],
    ['sudo', 'sh', '-c', 'hcloud OBS rm obs://b/x && echo ok'],
  ];
  for (const args of concatenated) {
    const result = classifyHcloudArgs(args);
    assert.equal(result.decision, 'deny', args.join(' '));
    assert.equal(result.risk, 'write', args.join(' '));
  }
  const textResult = classifyTextCommand('echo x && hcloud ECS CreateServers --flavor=x');
  assert.equal(textResult.decision, 'deny');
  assert.equal(textResult.risk, 'write');
  // Read-only hcloud prefix keeps working.
  const readResult = classifyTextCommand('hcloud ECS ListServers; echo done');
  assert.equal(readResult.decision, 'allow');
  assert.equal(readResult.risk, 'read_only');
});

test('classifyHcloudArgs allows local help for write operations', () => {
  const result = classifyHcloudArgs(['ECS', 'CreateServers', '--help']);
  assert.equal(result.decision, 'allow');
  assert.equal(result.risk, 'local_metadata');
});

test('classifyHcloudArgs allows read-only list and show operations', () => {
  assert.equal(classifyHcloudArgs(['ECS', 'NovaListServers']).decision, 'allow');
  assert.equal(classifyHcloudArgs(['ECS', 'ListServersDetails']).decision, 'allow');
  assert.equal(classifyHcloudArgs(['VPC', 'ShowVpc']).decision, 'allow');
  assert.equal(classifyHcloudArgs(['IMS', 'GlanceShowImage']).decision, 'allow');
  assert.equal(classifyHcloudArgs(['IAM', 'KeystoneListUsers']).decision, 'allow');
});

test('classifyHcloudArgs blocks obsutil write commands', () => {
  const writes = ['mb', 'cp', 'mv', 'rm', 'delete', 'mkdir', 'sync', 'chattri', 'bucketpolicy'];
  for (const op of writes) {
    assert.equal(classifyHcloudArgs(['obs', op, 'obs://bucket']).decision, 'deny', `obs ${op} should be blocked`);
  }
  // Regression pin for the cors/website entries: upstream main's #1001 removed
  // them as "nonexistent subcommands", but that was measured on a 7.2.x binary —
  // the pinned 7.3.12 live-serves both (`OBS help cors` exit 0; `-method=get` on
  // a nonexistent bucket returns OBS-side NoSuchBucket, so the commands reach
  // the service). They are write-capable via -method=put and must stay denied.
  assert.equal(classifyHcloudArgs(['obs', 'cors', 'obs://bucket']).decision, 'deny', 'obs cors should be blocked');
  assert.equal(
    classifyTextCommand('hcloud OBS cors obs://bucket -method=put -localfile=c.xml').decision,
    'deny',
    'raw-text hcloud OBS cors -method=put should be blocked',
  );
  assert.equal(
    classifyHcloudArgs(['obs', 'website', 'obs://bucket']).decision,
    'deny',
    'obs website should be blocked',
  );
  assert.equal(
    classifyTextCommand('hcloud OBS website obs://bucket -method=put -localfile=w.xml').decision,
    'deny',
    'raw-text hcloud OBS website -method=put should be blocked',
  );
});

test('classifyHcloudArgs blocks the KooCLI 7.3.12 obsutil write subcommands (7.3.12 pin)', () => {
  // 7.3.12 added these set/put/delete-capable subcommands (writes ride on
  // -method=put/set/delete) — they must hit the same deny as their older
  // siblings, on every layer (TS classifier, py hook twin, plan/read faces).
  const methodWrites = ['bucket-tagging', 'object-tagging', 'encryption', 'mirror-back-to-source'];
  for (const op of methodWrites) {
    assert.equal(
      classifyHcloudArgs(['obs', op, 'obs://bucket', '-method=put']).decision,
      'deny',
      `obs ${op} -method=put should be blocked`,
    );
    assert.equal(
      classifyHcloudArgs(['OBS', op, 'obs://bucket', '-method=delete']).decision,
      'deny',
      `OBS ${op} -method=delete should be blocked (case-insensitive service)`,
    );
    assert.equal(
      classifyTextCommand(`hcloud OBS ${op} obs://bucket -method=set -localfile=c.xml`).decision,
      'deny',
      `raw-text hcloud OBS ${op} -method=set should be blocked`,
    );
  }
  // custom-domain writes ride on -cname/certificate options, not -method.
  assert.equal(classifyHcloudArgs(['obs', 'custom-domain', 'obs://bucket', '-cname=x.com']).decision, 'deny');
  assert.equal(classifyTextCommand('hcloud OBS custom-domain obs://b -cname=x.com').decision, 'deny');
  // The full-name public-access-block writes (no -method — the verb is the
  // command name; deleting re-opens public access) and the pre-existing
  // abort/archive writes the 7.3.12-pin sweep dispositioned.
  for (const op of ['put-public-access-block', 'delete-public-access-block', 'abort', 'archive']) {
    assert.equal(classifyHcloudArgs(['obs', op, 'obs://bucket']).decision, 'deny', `obs ${op} should be blocked`);
    assert.equal(
      classifyTextCommand(`hcloud OBS ${op} obs://bucket`).decision,
      'deny',
      `raw-text hcloud OBS ${op} should be blocked`,
    );
  }
  // Read controls of the same families stay allowed (regression pin: a
  // vocabulary over-reach flipping reads to deny fails here).
  for (const op of ['get-public-access-block', 'get-bucket-policy-status', 'get-bucket-public-status', 'check', 'ls']) {
    assert.equal(classifyHcloudArgs(['obs', op, 'obs://bucket']).decision, 'allow', `obs ${op} should stay a read`);
  }
});

test('classifyHcloudArgs allows obsutil read commands', () => {
  const reads = ['ls', 'stat', 'help', 'version'];
  for (const op of reads) {
    assert.equal(classifyHcloudArgs(['obs', op]).decision, 'allow', `obs ${op} should be allowed`);
  }
});

test('classifyHcloudArgs blocks execution operations (Invoke, Trigger, Deploy)', () => {
  const execs = ['InvokeFunction', 'SyncInvokeFunction', 'AsyncInvokeFunction', 'Send'];
  for (const op of execs) {
    assert.equal(classifyHcloudArgs(['FunctionGraph', op]).decision, 'deny', `${op} should be blocked as execution`);
  }
  assert.equal(classifyHcloudArgs(['ECS', 'StartServers']).decision, 'deny', 'ECS StartServers should be blocked');
  assert.equal(classifyHcloudArgs(['ECS', 'RebootServers']).decision, 'deny', 'ECS RebootServers should be blocked');
});

test('classifyHcloudArgs blocks hcloud configure show without allowCredentialRead', () => {
  const result = classifyHcloudArgs(['configure', 'show']);
  assert.equal(result.decision, 'deny');
  assert.equal(result.risk, 'credential');
});

test('classifyHcloudArgs rejects empty args', () => {
  assert.equal(classifyHcloudArgs([]).decision, 'deny');
  assert.equal(classifyHcloudArgs([]).risk, 'invalid');
});

test('classifyHcloudArgs allows version commands', () => {
  assert.equal(classifyHcloudArgs(['version']).risk, 'local_metadata');
  assert.equal(classifyHcloudArgs(['--version']).risk, 'local_metadata');
});

// ── Read-vocabulary completion (2026-11-06 loop round 2 R4) ──────────────────
// The six write prefixes added for the UX #8 leak-nets (Register/Restore/
// Migrate/Import/Uninstall/Assign) are substring-matched, so real READ
// operations carrying those words mid-name flipped to deny. The corpus scan
// (148 services, 13,737 operations) pinned 8 false positives; the read
// vocabulary answers with new prefixes (Download/Recognize/Collect/Check/
// Glance) and a Result(s) suffix arm.

test('query-result operations stay reads despite write-prefixed names (loop round 2 R4, exact list round 4)', () => {
  // The corpus scan is the authority: shape-based generalizations (a
  // Result(s) suffix in round 3, Download/Recognize/Collect/Check prefixes in
  // round 2) each freed real writes (112 POST + 4 PUT for the prefixes), so
  // the exemption is an EXACT list of the eight pinned reads.
  const reads: Array<[string, string]> = [
    ['DDM', 'MigrateResults'], // Query Shard Change Task Details
    ['DATAARTSSTUDIO', 'ImportResult'], // Querying the Import Result
    ['CFW', 'DownloadImportResult'], // Downloading the Imported Rules
    ['CFW', 'DownloadImportTemplate'],
    ['GAUSSDB', 'DownloadImportExcelTemplate'],
    ['OCR', 'RecognizeHouseholdRegister'], // OCR inference, non-mutating
    ['CONFIG', 'CollectPolicyAssignmentsStatesSummary'], // compliance summary query
    ['DDM', 'CheckMigrateLogicDb'], // shard-change pre-check
  ];
  for (const [service, operation] of reads) {
    const result = classifyHcloudArgs([service, operation]);
    assert.equal(result.decision, 'allow', `${service} ${operation} is a read`);
    assert.equal(result.risk, 'read_only', `${service} ${operation} must classify read_only`);
  }
  // Corpus writes the round-2 prefixes would have freed stay out of the
  // blessed-read set (SMS CollectLog=POST, DRS CollectDbObjectsAsync=POST,
  // HSS DownloadAssetFile=POST, RDS CheckInstanceForUpgrade=PUT) — they fall
  // to unknown_read (advisory warn, the #8 mitigation), never read_only.
  for (const [service, operation] of [
    ['SMS', 'CollectLog'],
    ['DRS', 'CollectDbObjectsAsync'],
    ['HSS', 'DownloadAssetFile'],
    ['RDS', 'CheckInstanceForUpgrade'],
  ] as const) {
    const result = classifyHcloudArgs([service, operation]);
    assert.notEqual(result.risk, 'read_only', `${service} ${operation} must NOT be a blessed read`);
  }
});

test('the write leak-nets stay closed (loop round 2 R4)', () => {
  for (const [service, operation] of [
    ['IMS', 'RegisterImage'],
    ['RDS', 'RestoreToNewInstance'],
    ['IMS', 'ImportImage'],
    ['ECS', 'MigrateServer'],
    ['CES', 'UninstallAgent'],
    ['VPC', 'AssignIpv6Addresses'],
    ['ECS', 'BatchStopServers'],
  ] as const) {
    const result = classifyHcloudArgs([service, operation]);
    assert.equal(result.decision, 'deny', `${service} ${operation} is a write`);
    assert.equal(result.risk, 'write');
  }
});

test('Glance-prefixed IMS operations classify as reads (the tools own show example)', () => {
  // SERVICE_EXAMPLES teaches `IMS GlanceShowImage`; the advisory face used
  // to warn "unrecognized operation" on the devkit's own example.
  const result = classifyHcloudArgs(['IMS', 'GlanceShowImage']);
  assert.equal(result.risk, 'read_only');
});

// ── Loop round 3: the Glance prefix narrows and the suffix arm becomes exact ──

test('glance-prefixed WRITES stay denied — only GlanceShow/GlanceList read (loop round 3 S2-B1)', async () => {
  for (const operation of [
    'glancedeleteimage', // DELETE
    'glanceupdateimage', // PATCH
    'glancecreateimage',
    'glanceaddmember',
  ]) {
    const result = classifyHcloudArgs(['IMS', operation]);
    assert.equal(result.decision, 'deny', `IMS ${operation} is a write`);
    assert.equal(result.risk, 'write');
  }
  for (const operation of ['glanceshowimage', 'glancelistimages']) {
    const result = classifyHcloudArgs(['IMS', operation]);
    assert.equal(result.risk, 'read_only', `IMS ${operation} is a read`);
  }
});

test('real writes ending in Result(s) stay denied — the exception list is exact (loop round 3 S2-B2)', async () => {
  // Corpus-verified writes: CloudTest settaskresult (POST), SMS
  // updatecommandresult (POST), SMS updateconsistencyresult (POST), CloudTest
  // createtaskdefaultresult (POST), MANAGEONESCHCS reportexecutedsubscriptionsresult
  // (PUT). The round-2 Result(s)-suffix regex freed all five.
  for (const [service, operation] of [
    ['CloudTest', 'settaskresult'],
    ['SMS', 'updatecommandresult'],
    ['SMS', 'updateconsistencyresult'],
    ['CloudTest', 'createtaskdefaultresult'],
    ['MANAGEONESCHCS', 'reportexecutedsubscriptionsresult'],
  ] as const) {
    const result = classifyHcloudArgs([service, operation]);
    assert.equal(result.decision, 'deny', `${service} ${operation} is a write`);
    assert.equal(result.risk, 'write');
  }
  // The two corpus reads the exact list exists for keep their exemption.
  for (const [service, operation] of [
    ['DDM', 'MigrateResults'],
    ['DATAARTSSTUDIO', 'ImportResult'],
  ] as const) {
    const result = classifyHcloudArgs([service, operation]);
    assert.equal(result.risk, 'read_only', `${service} ${operation} stays a read`);
  }
});

test('case-variant exception names match exactly, trailing garbage does not (loop round 3 S2-B3)', () => {
  assert.equal(classifyHcloudArgs(['DDM', 'migrateresults']).risk, 'read_only');
  // A trailing newline inside the quoted operation must not ride a loose
  // suffix anchor into a read — the exact match rejects it on both layers.
  assert.equal(classifyHcloudArgs(['DDM', 'MigrateResult\n']).decision, 'deny');
});
