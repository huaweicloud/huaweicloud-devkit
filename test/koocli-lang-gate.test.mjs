import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { classifyUnsupported, readServiceCatalogs, runHcloud } from '../plugins/huaweicloud-core/src/hcloud-cli.mjs';

function withCatalog(files) {
  const dir = mkdtempSync(join(tmpdir(), 'koocli-meta-'));
  for (const [name, items] of Object.entries(files)) {
    writeFileSync(join(dir, name), JSON.stringify({ items }));
  }
  return dir;
}

function fakeHcloudScript(source) {
  const dir = mkdtempSync(join(tmpdir(), 'koocli-fake-hcloud-'));
  const script = join(dir, 'fake-hcloud.mjs');
  writeFileSync(script, source, 'utf8');
  return script;
}

function readFileHelper(filePath) {
  return readFileSync(filePath, 'utf8');
}

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
  const stateFile = join(mkdtempSync(join(tmpdir(), 'koocli-diag-state-')), 'count.txt');
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
    const result = await runHcloud(['BSS', 'ShowCustomerAccountBalances'], {
      executable: process.execPath,
      executableArgs: [script],
      maxRetries: 0,
      retryBaseDelayMs: 1,
      metaDir: dir,
    });
    assert.equal(result.ok, false);
    assert.equal(result.langCause, 'lang-missing');
    assert.match(result.langNextStep, /hcloud configure set --cli-lang=cn/);
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
    assert.match(result.langNextStep, /hcloud configure set --cli-lang=cn/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(join(script, '..'), { recursive: true, force: true });
  }
});

test('runHcloud: Unsupported service (not-found, both catalogs) → metadata hint, no lang hint', async () => {
  const dir = withCatalog({
    'services_cn.json': [{ Service: { Text: 'BSS' } }],
    'services_en.json': [{ Service: { Text: 'BSS' } }],
  });
  const script = fakeHcloudScript(`
console.error('Unsupported service: MadeUpService');
process.exit(1);
`);
  try {
    const result = await runHcloud(['MadeUpService', 'x'], {
      executable: process.execPath,
      executableArgs: [script],
      maxRetries: 0,
      retryBaseDelayMs: 1,
      metaDir: dir,
    });
    assert.equal(result.langCause, 'not-found');
    assert.match(result.langNextStep, /Check the service name/);
    assert.doesNotMatch(result.langNextStep, /configure set --cli-lang=cn/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(join(script, '..'), { recursive: true, force: true });
  }
});

test('runHcloud: successful command is untouched (no diagnostic artifacts)', async () => {
  const dir = withCatalog({
    'services_cn.json': [{ Service: { Text: 'BSS' } }],
    'services_en.json': [{ Service: { Text: 'ECS' } }],
  });
  const script = fakeHcloudScript(`console.log(JSON.stringify({ ok: true }));`);
  try {
    const result = await runHcloud(['ECS', 'ListServers'], {
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
