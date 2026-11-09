import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { appendLangHint } from '../plugins/huaweicloud-core/src/hcloud-catalog.ts';
import {
  classifyUnsupported,
  readServiceCatalogs,
  runHcloud,
  type HcloudRunResult,
} from '../plugins/huaweicloud-core/src/hcloud-cli.ts';
import { fixtureDir } from './fixture-dir.ts';

function withCatalog(files: Record<string, Array<{ Service: { Text: string } }>>): string {
  const dir = fixtureDir('koocli-meta-');
  for (const [name, items] of Object.entries(files)) {
    writeFileSync(join(dir, name), JSON.stringify({ items }));
  }
  return dir;
}

function fakeHcloudScript(source: string): string {
  const dir = fixtureDir('koocli-fake-hcloud-');
  const script = join(dir, 'fake-hcloud.mjs');
  writeFileSync(script, source, 'utf8');
  return script;
}

function readFileHelper(filePath: string): string {
  return readFileSync(filePath, 'utf8');
}

type LangGateResult = HcloudRunResult & { injectedLang?: unknown; autoRetried?: unknown };

test('readServiceCatalogs: maps items[].Service.Text into cn/en sets', () => {
  const dir = withCatalog({
    'services_cn.json': [{ Service: { Text: 'BSS' } }, { Service: { Text: 'ECS' } }],
    'services_en.json': [{ Service: { Text: 'ECS' } }],
  });
  try {
    const { cn, en } = readServiceCatalogs(dir);
    assert.deepEqual(
      [...cn].sort((a, b) => a.localeCompare(b)),
      ['BSS', 'ECS'],
    );
    assert.deepEqual(
      [...en].sort((a, b) => a.localeCompare(b)),
      ['ECS'],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('classify: full catalogs → lang-missing / other / not-found / unknown', () => {
  const dir = withCatalog({
    'services_cn.json': [{ Service: { Text: 'BSS' } }, { Service: { Text: 'ECS' } }],
    'services_en.json': [{ Service: { Text: 'ECS' } }],
  });
  try {
    assert.equal(classifyUnsupported('BSS', dir), 'lang-missing'); // cn only
    assert.equal(classifyUnsupported('ECS', dir), 'other'); // both
    assert.equal(classifyUnsupported('MadeUpService', dir), 'not-found'); // neither
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('classify: missing catalog file is "unknown", not lang-missing (G-rev)', () => {
  // cn-only machine: en file absent. A standard service must NOT be treated as
  // en-missing — its absence from en proves nothing.
  const dir = withCatalog({ 'services_cn.json': [{ Service: { Text: 'ECS' } }] });
  try {
    assert.equal(classifyUnsupported('ECS', dir), 'unknown');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('classify: en-only machine (#597) → unknown, both missing → unknown', () => {
  const enOnly = withCatalog({ 'services_en.json': [{ Service: { Text: 'ECS' } }] });
  const none = withCatalog({});
  try {
    assert.equal(classifyUnsupported('BSS', enOnly), 'unknown');
    assert.equal(classifyUnsupported('BSS', none), 'unknown');
  } finally {
    rmSync(enOnly, { recursive: true, force: true });
    rmSync(none, { recursive: true, force: true });
  }
});

test('classify: mixed-case catalog entries are normalized (G3)', () => {
  const dir = withCatalog({
    'services_cn.json': [{ Service: { Text: 'DevStar' } }, { Service: { Text: 'ECS' } }],
    'services_en.json': [{ Service: { Text: 'ECS' } }],
  });
  try {
    assert.equal(classifyUnsupported('DevStar', dir), 'lang-missing');
    assert.equal(classifyUnsupported('devstar', dir), 'lang-missing');
    assert.equal(classifyUnsupported('DEVSTAR', dir), 'lang-missing');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runHcloud: Unsupported service (lang-missing) → diagnostic with configure-set hint, no arg mutation', async () => {
  const dir = withCatalog({
    'services_cn.json': [{ Service: { Text: 'BSS' } }],
    'services_en.json': [{ Service: { Text: 'ECS' } }],
  });
  const stateFile = join(fixtureDir('koocli-diag-state-'), 'count.txt');
  const script = fakeHcloudScript(`
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
const stateFile = ${JSON.stringify(stateFile)};
const count = existsSync(stateFile) ? Number(readFileSync(stateFile, 'utf8')) : 0;
writeFileSync(stateFile, String(count + 1));
const args = process.argv.slice(2);
console.error(JSON.stringify({ seenArgs: args }));
if (args.some((a) => a.startsWith('--cli-lang='))) { console.error('INJECTED'); process.exit(1); }
console.error('Unsupported service: BSS');
process.exit(1);
`);
  try {
    const result: LangGateResult = await runHcloud(['BSS', 'ShowCustomerAccountBalances'], {
      executable: process.execPath,
      executableArgs: [script],
      maxRetries: 0,
      retryBaseDelayMs: 1,
      metaDir: dir,
    });
    assert.equal(result.ok, false);
    assert.equal(result.langCause, 'lang-missing');
    assert.match(result.langNextStep!, /hcloud configure set --cli-lang=cn/);
    assert.equal(result.injectedLang, undefined, 'no language flag injected into the command');
    assert.equal(Number(readFileHelper(stateFile)), 1, 'command ran exactly once, no retry');
    assert.ok(!result.injectedLang);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(stateFile, { recursive: true, force: true });
    rmSync(join(script, '..'), { recursive: true, force: true });
  }
});

test('runHcloud: Unsupported service (unknown, cn catalog missing) → configure-set hint', async () => {
  const dir = withCatalog({ 'services_en.json': [{ Service: { Text: 'ECS' } }] });
  const script = fakeHcloudScript(`
console.error('Unsupported service: BSS');
process.exit(1);
`);
  try {
    const result = await runHcloud(['BSS', 'ShowCustomerAccountBalances'], {
      executable: process.execPath,
      executableArgs: [script],
      maxRetries: 0,
      retryBaseDelayMs: 1,
      metaDir: dir,
    });
    assert.equal(result.ok, false);
    assert.equal(result.langCause, 'unknown');
    assert.match(result.langNextStep!, /hcloud configure set --cli-lang=cn/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(join(script, '..'), { recursive: true, force: true });
  }
});

test('runHcloud: Unsupported service (not-found, both catalogs) → the triage denies before spawn', async () => {
  // 2026-11-06 contract change: a service absent from BOTH local catalogs is
  // negative evidence — the plan-face triage denies it and the run engine
  // inherits through assertAllowed, so the "Unsupported service" output this
  // test used to annotate can no longer happen with catalogs present. The
  // annotation branch itself stays covered directly below (defense in depth).
  const dir = withCatalog({
    'services_cn.json': [{ Service: { Text: 'BSS' } }],
    'services_en.json': [{ Service: { Text: 'BSS' } }],
  });
  const stateFile = join(fixtureDir('koocli-diag-state-'), 'count.txt');
  const script = fakeHcloudScript(`
import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(stateFile)}, 'ran');
console.error('Unsupported service: MadeUpService');
process.exit(1);
`);
  try {
    await assert.rejects(
      runHcloud(['MadeUpService', 'x'], {
        executable: process.execPath,
        executableArgs: [script],
        maxRetries: 0,
        retryBaseDelayMs: 1,
        metaDir: dir,
      }),
      /not in the local KooCLI service catalog/,
    );
    assert.equal(existsSync(stateFile), false, 'the triage deny must preempt the spawn');
  } finally {
    rmSync(stateFile, { recursive: true, force: true });
    rmSync(join(script, '..'), { recursive: true, force: true });
  }
});

test('appendLangHint: not-found cause carries the metadata hint, no lang hint (defense in depth)', () => {
  const dir = withCatalog({
    'services_cn.json': [{ Service: { Text: 'BSS' } }],
    'services_en.json': [{ Service: { Text: 'BSS' } }],
  });
  const result = appendLangHint({ ok: false } as HcloudRunResult, 'MadeUpService', dir);
  assert.equal(result.langCause, 'not-found');
  assert.match(result.langNextStep!, /Check the service name/);
  assert.doesNotMatch(result.langNextStep!, /configure set --cli-lang=cn/);
});

test('runHcloud: successful command is untouched (no diagnostic artifacts)', async () => {
  const dir = withCatalog({
    'services_cn.json': [{ Service: { Text: 'BSS' } }],
    'services_en.json': [{ Service: { Text: 'ECS' } }],
  });
  const script = fakeHcloudScript(`console.log(JSON.stringify({ ok: true }));`);
  try {
    const result: LangGateResult = await runHcloud(['ECS', 'ListServers'], {
      executable: process.execPath,
      executableArgs: [script],
      maxRetries: 0,
      retryBaseDelayMs: 1,
      metaDir: dir,
    });
    assert.equal(result.ok, true);
    assert.equal(result.langCause, undefined);
    assert.equal(result.injectedLang, undefined);
    assert.equal(result.autoRetried, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(join(script, '..'), { recursive: true, force: true });
  }
});
