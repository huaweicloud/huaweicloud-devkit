import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { withTempAuthHome } from './hcloud-cli-harness.ts';
import {
  consumeApprovalToken,
  createApprovalToken,
  hashArgs,
  planHcloudCommand,
  type HcloudPlan,
} from '../plugins/huaweicloud-core/src/hcloud-cli.ts';

// Deterministic-tier seam: disable the once-per-session first-assertion
// vendor challenge (HUAWEICLOUD_VENDOR_CHALLENGE=off, the installer-override
// pattern). Set before the src imports: the gate captures the env at module
// load, so the harness import's seam is order-dependent — this line is not.
process.env.HUAWEICLOUD_VENDOR_CHALLENGE = 'off';

test('planHcloudCommand includes copyable command text and password history warning', () => {
  const plan = planHcloudCommand(['ECS', 'CreateServers', '--server.adminPass=Secret123!'], {
    allowWrites: true,
  });
  assert.match(plan.executableBlock, /hcloud ECS CreateServers/);
  assert.ok(plan.warnings.some((warning) => typeof warning === 'string' && /shell history/i.test(warning)));
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
  assert.ok(plan.warnings.some((warning) => typeof warning === 'string' && /resource manifest/i.test(warning)));
  assert.equal(plan.classification.decision, 'deny');
});

test('planHcloudCommand adds no manifest hint for OBS read operations', () => {
  const plan = planHcloudCommand(['OBS', 'ls']);
  assert.ok(!plan.warnings.some((warning) => typeof warning === 'string' && /resource manifest/i.test(warning)));
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
    if (stored.status !== 'consumed') assert.fail('the minted token must consume');
    assert.equal(stored.entry.argsHash, hashArgs(['ECS', 'CreateServers', '--server.adminPass=Secret123!']));
    assert.ok(Array.isArray(stored.entry.argsRedacted));
    assert.ok(!JSON.stringify(stored.entry).includes('Secret123'));

    // single-use
    assert.equal(consumeApprovalToken(token).status, 'gone');
  });
});

test('approval token survives a fresh file read (cross-process) and expires by TTL', async () => {
  await withTempAuthHome((home) => {
    const token = createApprovalToken(['OBS', 'mb', 'obs://bucket']);
    // consume reads from the file (single source of truth), not from a memory map
    const stored = consumeApprovalToken(token);
    if (stored.status !== 'consumed') assert.fail('the fresh read must consume');
    assert.equal(stored.entry.argsHash, hashArgs(['OBS', 'mb', 'obs://bucket']));

    // TTL: backdate an entry to before the window and expect a refusal
    const ttlToken = createApprovalToken(['OBS', 'rm', 'obs://bucket']);
    const file = join(home, '.config', 'huaweicloud', 'approvals.json');
    const map = JSON.parse(readFileSync(file, 'utf8'));
    map[ttlToken].createdAt = Date.now() - 6 * 60_000;
    writeFileSync(file, JSON.stringify(map), 'utf8');
    assert.equal(consumeApprovalToken(ttlToken).status, 'gone');
  });
});

test('planHcloudCommand echo survives banner-shaped argument values (#935 A4)', () => {
  // The plan face echoes a COMMAND string, not child-process output — an
  // argument value carrying banner-shaped text must not blank the command the
  // user is asked to approve.
  const plan = planHcloudCommand(
    ['ECS', 'CreateServers', '--server.name=ok', '--server.description=可执行 hcloud update 更新至 7.3.12'],
    { allowWrites: true },
  ) as HcloudPlan;
  assert.match(plan.command ?? '', /CreateServers/, 'the displayed command must stay visible');
  assert.match(plan.command ?? '', /server\.name=ok/);
});
