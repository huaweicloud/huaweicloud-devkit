import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyHcloudArgs, classifyTextCommand } from '../plugins/huaweicloud-core/src/safety-policy.ts';
import { needsUserConfirmation, planHcloudCommand } from '../plugins/huaweicloud-core/src/hcloud-cli.ts';

// The dry_run preflight carve-out (classify-hcloud.ts): an allowlisted ECS
// create operation carrying the EXACT token `--dry_run=true` classifies as
// allow/preflight on the argv tool faces — the service validates the request
// and creates nothing (the KooCLI --help contract), so plan/run need no
// confirmation. Every other shape keeps its write verdict, and the text/hook
// faces never take the carve-out at all.

const PREFLIGHT_ARGS = [
  'ECS',
  'CreatePostPaidServers',
  '--dry_run=true',
  '--server.name=ecs-trial',
  '--server.flavorRef=at7.large.05',
  '--server.imageRef=11111111-2222-3333-4444-555555555555',
];

test('argv preflight: allowlisted op with exact --dry_run=true classifies allow/preflight', () => {
  const postpaid = classifyHcloudArgs(PREFLIGHT_ARGS);
  assert.equal(postpaid.decision, 'allow');
  assert.equal(postpaid.risk, 'preflight');

  const create = classifyHcloudArgs(['ECS', 'CreateServers', '--dry_run=true', '--server.name=x']);
  assert.equal(create.decision, 'allow');
  assert.equal(create.risk, 'preflight');
});

test('argv preflight: classification is posture-independent (allowWrites:true stays preflight)', () => {
  const result = classifyHcloudArgs(PREFLIGHT_ARGS, { allowWrites: true });
  assert.equal(result.decision, 'allow');
  assert.equal(result.risk, 'preflight');
});

test('argv preflight: plan needs no user confirmation and reports safeToRun', () => {
  assert.equal(needsUserConfirmation(PREFLIGHT_ARGS), false);
  const plan = planHcloudCommand(PREFLIGHT_ARGS, { approvalMode: 'ask' });
  assert.equal(plan.userConfirmation.needed, false);
  assert.equal(plan.safeToRun, true);
  assert.equal(plan.classification.risk, 'preflight');
  // Token mode still mints (the plan face always does), but the strict
  // verdict carries: no userConfirmation and no grant requirement at
  // consume time — the same no-confirmation contract across postures.
  const tokenPlan = planHcloudCommand(PREFLIGHT_ARGS, { approvalMode: 'token' });
  assert.equal(tokenPlan.userConfirmation.needed, false);
  assert.equal(tokenPlan.safeToRun, true);
});

function assertStillWrite(args: string[]): void {
  const result = classifyHcloudArgs(args);
  assert.equal(result.decision, 'deny', args.join(' '));
  assert.equal(result.risk, 'write', args.join(' '));
}

test('argv preflight: global --dryrun flag classifies allow/preflight for any operation', () => {
  // The KooCLI global flag ("Print the request message after verification,
  // without execution") never sends a request, so the zero-side-effect
  // fact does not depend on the operation.
  const create = classifyHcloudArgs(['ECS', 'CreateServers', '--cli-region=cn-north-4', '--dryrun']);
  assert.equal(create.decision, 'allow');
  assert.equal(create.risk, 'preflight');

  const deleteOp = classifyHcloudArgs(['ECS', 'DeleteServer', '--server_id=i-123', '--dryrun']);
  assert.equal(deleteOp.decision, 'allow');
  assert.equal(deleteOp.risk, 'preflight');

  const plan = planHcloudCommand(['ECS', 'CreateServers', '--dryrun'], { approvalMode: 'ask' });
  assert.equal(plan.userConfirmation.needed, false);
  assert.equal(plan.safeToRun, true);
});

test('preflight fences: misspelled or absent dry_run keeps the write verdict', () => {
  const notPreflight = [
    ['ECS', 'CreatePostPaidServers', '--server.name=x'], // no flag at all
    ['ECS', 'CreatePostPaidServers', '--dry_run', '--server.name=x'], // bare body flag
    ['ECS', 'CreatePostPaidServers', '--dry_run=True', '--server.name=x'], // case variant
    ['ECS', 'CreatePostPaidServers', '--dry_run=TRUE', '--server.name=x'],
    ['ECS', 'CreatePostPaidServers', '--dry_run=1', '--server.name=x'],
    ['ECS', 'CreatePostPaidServers', '--dry-run=true', '--server.name=x'], // hyphen spelling
    ['ECS', 'CreatePostPaidServers', '--dryrun=true', '--server.name=x'], // =value on the global flag
  ];
  for (const args of notPreflight) {
    assertStillWrite(args);
  }
});

test('preflight fences: non-allowlisted operations keep the write verdict', () => {
  const result = classifyHcloudArgs(['RDS', 'CreateInstance', '--dry_run=true', '--name=x']);
  assert.equal(result.decision, 'deny');
  assert.equal(result.risk, 'write');
});

test('preflight fences: --cli-jsonInput presence keeps the write verdict', () => {
  // A JSON body could carry a conflicting dry_run value under a precedence
  // the CLI owns and the classifier cannot see, so the carve-out refuses it.
  const result = classifyHcloudArgs([
    'ECS',
    'CreatePostPaidServers',
    '--dry_run=true',
    '--cli-jsonInput=/tmp/create.json',
  ]);
  assert.equal(result.decision, 'deny');
  assert.equal(result.risk, 'write');
});

test('preflight faces: raw Bash text never takes the carve-out (hook parity)', () => {
  // classifyTextCommand is what the PreToolUse hooks and the opencode
  // in-process gate consume; raw Bash keeps its deny so agents route
  // preflights through the sanctioned MCP tools.
  const result = classifyTextCommand('hcloud ECS CreatePostPaidServers --dry_run=true --server.name=x');
  assert.equal(result.decision, 'deny');
  assert.equal(result.risk, 'write');
});

test('preflight faces: classifyHcloudArgs with rawCommand set keeps the write verdict', () => {
  const result = classifyHcloudArgs(['ECS', 'CreatePostPaidServers', '--dry_run=true'], {
    rawCommand: 'hcloud ECS CreatePostPaidServers --dry_run=true',
  });
  assert.equal(result.decision, 'deny');
  assert.equal(result.risk, 'write');
});

test('preflight segments: a compound argv carrying a write fragment denies fail-closed', () => {
  // A value containing `;` fragments the segment pass; the severity merge
  // must let the write-classified fragment win, never the preflight one.
  const compound = [
    'ECS',
    'CreatePostPaidServers',
    '--dry_run=true',
    '--server.name=a;hcloud',
    'ECS',
    'DeleteServer',
    '--server_id=i-123',
  ];
  const result = classifyHcloudArgs(compound);
  assert.equal(result.decision, 'deny');
});

test('preflight segments: text compound with a write segment denies', () => {
  const result = classifyTextCommand(
    'hcloud ECS CreatePostPaidServers --dry_run=true && hcloud ECS DeleteServer --server_id=i-123',
  );
  assert.equal(result.decision, 'deny');
  assert.equal(result.risk, 'write');
});

test('preflight keeps --help as local metadata', () => {
  const result = classifyHcloudArgs(['ECS', 'CreatePostPaidServers', '--help']);
  assert.equal(result.decision, 'allow');
  assert.equal(result.risk, 'local_metadata');
});

test('CreatePostPaidServers plan warns on missing server.vpcid (live KooCLI evidence)', () => {
  const plan = planHcloudCommand([
    'ECS',
    'CreatePostPaidServers',
    '--server.name=x',
    '--server.flavorRef=at7.large.05',
    '--server.imageRef=11111111-2222-3333-4444-555555555555',
    '--server.nics.1.subnet_id=1ce847c4-060f-4bd1-8145-e92a5ea75e43',
  ]);
  const missing = plan.warnings.find((w) => typeof w === 'string' && w.includes('Missing required parameters'));
  assert.ok(missing, 'expected a missing-required-parameters warning');
  assert.match(String(missing), /server\.vpcid/);

  const complete = planHcloudCommand([
    'ECS',
    'CreatePostPaidServers',
    '--server.name=x',
    '--server.flavorRef=at7.large.05',
    '--server.imageRef=11111111-2222-3333-4444-555555555555',
    '--server.nics.1.subnet_id=1ce847c4-060f-4bd1-8145-e92a5ea75e43',
    '--server.vpcid=24d1ba0b-34e0-4633-bcca-968236366a73',
  ]);
  assert.equal(
    complete.warnings.find((w) => typeof w === 'string' && w.includes('Missing required parameters')),
    undefined,
  );
});
