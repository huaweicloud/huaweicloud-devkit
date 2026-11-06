import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { planHcloudCommand } from '../plugins/huaweicloud-core/src/hcloud-plan.ts';
import { runHcloud } from '../plugins/huaweicloud-core/src/hcloud-cli.ts';
import { resolveMetaDir, triageUnknownService } from '../plugins/huaweicloud-core/src/hcloud-triage.ts';
import { fakeHcloudScript, withMetaRepo } from './hcloud-cli-harness.ts';
import { fixtureDir } from './fixture-dir.ts';

// The both-catalogs ECS fixture shared by the face tests — one spelling, so
// the fixture block never becomes a jscpd clone against itself.
const ecsBothCatalogs = (): Record<string, Array<{ Service: { Text: string } }>> => ({
  'services_cn.json': [{ Service: { Text: 'ECS' } }],
  'services_en.json': [{ Service: { Text: 'ECS' } }],
});

// ── triageUnknownService: the evidence matrix ───────────────────────────────

test('triage: both catalogs present, service in neither → service-not-found', () => {
  const triage = triageUnknownService('FooBar', withMetaRepo(ecsBothCatalogs()));
  assert.equal(triage.cause, 'service-not-found');
  assert.match(triage.message, /FooBar/);
  assert.match(triage.nextStep, /--help/);
});

test('triage: mixed-case and whitespace-padded input normalizes before lookup', () => {
  const dir = withMetaRepo(ecsBothCatalogs());
  assert.equal(triageUnknownService('  fOoBaR  ', dir).cause, 'service-not-found');
  assert.equal(triageUnknownService('ecs', dir).cause, 'operation-unknown');
});

test('triage: cn-only entry → lang-missing with the shared cn hint', () => {
  const dir = withMetaRepo({
    'services_cn.json': [{ Service: { Text: 'FooBar' } }],
    'services_en.json': [{ Service: { Text: 'ECS' } }],
  });
  const triage = triageUnknownService('FooBar', dir);
  assert.equal(triage.cause, 'lang-missing');
  assert.match(triage.nextStep, /hcloud configure set --cli-lang=cn/);
});

test('triage: real service, unrecognized operation → operation-unknown carries no message', () => {
  const triage = triageUnknownService('ECS', withMetaRepo(ecsBothCatalogs()));
  assert.deepEqual(triage, { cause: 'operation-unknown' });
});

test('triage: either catalog file missing → no-evidence (a bare HOME proves nothing)', () => {
  const enOnly = withMetaRepo({ 'services_en.json': [{ Service: { Text: 'ECS' } }] });
  const none = fixtureDir('triage-empty-');
  assert.equal(triageUnknownService('FooBar', enOnly).cause, 'no-evidence');
  assert.equal(triageUnknownService('FooBar', none).cause, 'no-evidence');
});

test('triage: an empty service token is no-evidence, never not-found', () => {
  assert.equal(triageUnknownService('', fixtureDir('triage-empty2-')).cause, 'no-evidence');
  assert.equal(triageUnknownService(undefined, fixtureDir('triage-empty3-')).cause, 'no-evidence');
});

test('resolveMetaDir: explicit wins over env, env wins over the homedir default', () => {
  const prev = process.env.HCLOUD_META_DIR;
  try {
    process.env.HCLOUD_META_DIR = '/env/meta';
    assert.equal(resolveMetaDir('/explicit/meta'), '/explicit/meta');
    assert.equal(resolveMetaDir(), '/env/meta');
    delete process.env.HCLOUD_META_DIR;
    assert.match(resolveMetaDir(), /[.]hcloud[/\\]metaRepo$/);
  } finally {
    if (prev === undefined) delete process.env.HCLOUD_META_DIR;
    else process.env.HCLOUD_META_DIR = prev;
  }
});

// ── the plan face: the single seam the run face inherits ────────────────────

test('plan: catalog-not-found service refines the classification to deny', () => {
  const plan = planHcloudCommand(['FooBar', 'BazQux', '--nonsense=1'], { metaDir: withMetaRepo(ecsBothCatalogs()) });
  assert.equal(plan.classification.decision, 'deny');
  assert.equal(plan.classification.risk, 'invalid');
  assert.match(plan.classification.reason ?? '', /not in the local KooCLI service catalog/);
  assert.equal(plan.safeToRun, false);
  assert.ok(
    plan.warnings.some((w) => typeof w === 'string' && /not in the local KooCLI service catalog/.test(w)),
    'the plan echo must carry the triage note',
  );
  // The approval contract is unchanged: a token still mints (the agent was
  // told at plan time; burning it on a doomed approval is the documented
  // cost, not a dead end).
  assert.ok(plan.approvalToken);
});

test('plan: lang-missing service stays allow with the cn hint in warnings', () => {
  const dir = withMetaRepo({
    'services_cn.json': [{ Service: { Text: 'FooBar' } }],
    'services_en.json': [{ Service: { Text: 'ECS' } }],
  });
  const plan = planHcloudCommand(['FooBar', 'BazQux'], { metaDir: dir });
  assert.equal(plan.classification.decision, 'allow');
  assert.equal(plan.classification.risk, 'unknown_read');
  assert.equal(plan.safeToRun, true);
  assert.ok(plan.warnings.some((w) => typeof w === 'string' && /--cli-lang=cn/.test(w)));
});

test('plan: operation-unknown keeps bare unknown_read semantics, no triage noise', () => {
  const plan = planHcloudCommand(['ECS', 'BazQux'], { metaDir: withMetaRepo(ecsBothCatalogs()) });
  assert.equal(plan.classification.decision, 'allow');
  assert.equal(plan.classification.risk, 'unknown_read');
  assert.ok(plan.warnings.every((w) => typeof w !== 'string' || !/catalog/.test(w)));
});

test('plan: a known read is untouched by the triage', () => {
  const plan = planHcloudCommand(['ECS', 'ListServers'], { metaDir: withMetaRepo(ecsBothCatalogs()) });
  assert.equal(plan.classification.decision, 'allow');
  assert.equal(plan.classification.risk, 'read_only');
});

// ── the run face inherits the deny through assertAllowed ────────────────────

test('run: a catalog-not-found service denies before any spawn', async () => {
  const marker = join(fixtureDir('triage-spawn-'), 'spawned.txt');
  const script = fakeHcloudScript(`
import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(marker)}, 'x');
`);
  await assert.rejects(
    runHcloud(['FooBar', 'BazQux'], {
      executable: process.execPath,
      executableArgs: [script],
      metaDir: withMetaRepo(ecsBothCatalogs()),
      maxRetries: 0,
    }),
    /not in the local KooCLI service catalog/,
  );
  assert.equal(existsSync(marker), false, 'the deny must preempt the spawn entirely');
});

test('run: no catalogs → the fabricated service reaches the child and fails there (no-evidence stays open)', async () => {
  const script = fakeHcloudScript(`console.error('Unsupported service: FooBar'); process.exit(1);`);
  const result = await runHcloud(['FooBar', 'BazQux'], {
    executable: process.execPath,
    executableArgs: [script],
    metaDir: fixtureDir('triage-empty4-'),
    maxRetries: 0,
  });
  assert.equal(result.ok, false);
  assert.equal(result.langCause, 'unknown');
});
