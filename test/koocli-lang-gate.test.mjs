import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  classifyUnsupported,
  readServiceCatalogs,
  runHcloud,
  shouldInjectLang,
} from '../plugins/huaweicloud-core/src/hcloud-cli.mjs';

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

test('koocli gate G1: injects when service is in cn catalog but not en', () => {
  const dir = withCatalog({
    'services_cn.json': [{ Service: { Text: 'BSS' } }],
    'services_en.json': [{ Service: { Text: 'ECS' } }],
  });
  try {
    assert.equal(shouldInjectLang(['BSS', 'ShowCustomerAccountBalances'], dir), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('koocli gate G1: does not inject obsutil-style OBS subcommands', () => {
  const dir = withCatalog({
    'services_cn.json': [{ Service: { Text: 'OBS' } }],
    'services_en.json': [],
  });
  try {
    assert.equal(shouldInjectLang(['OBS', 'cp', 'obs://a', 'obs://b'], dir), false);
    assert.equal(shouldInjectLang(['OBS', 'CP', 'obs://a', 'obs://b'], dir), false);
    assert.equal(shouldInjectLang(['OBS', 'ls', 'obs://a'], dir), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('koocli gate G2: no injection when --cli-lang is already explicit', () => {
  const dir = withCatalog({
    'services_cn.json': [{ Service: { Text: 'BSS' } }],
    'services_en.json': [{ Service: { Text: 'ECS' } }],
  });
  try {
    assert.equal(shouldInjectLang(['BSS', 'ShowCustomerAccountBalances', '--cli-lang=en'], dir), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('koocli gate G3: service name is uppercased before classification', () => {
  const dir = withCatalog({
    'services_cn.json': [{ Service: { Text: 'BSS' } }],
    'services_en.json': [{ Service: { Text: 'ECS' } }],
  });
  try {
    assert.equal(shouldInjectLang(['bss', 'ShowCustomerAccountBalances'], dir), true);
    assert.equal(shouldInjectLang(['Bss', 'ShowCustomerAccountBalances'], dir), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('koocli gate: no injection when service is in neither catalog', () => {
  const dir = withCatalog({
    'services_cn.json': [{ Service: { Text: 'BSS' } }],
    'services_en.json': [{ Service: { Text: 'ECS' } }],
  });
  try {
    assert.equal(shouldInjectLang(['MadeUpService', 'SomeOperation'], dir), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('koocli gate review: missing catalog file is "unknown", not lang-missing', () => {
  // cn-only machine (en catalog file absent): a standard service must NOT be
  // proactively injected — its absence from en proves nothing.
  const dir = withCatalog({ 'services_cn.json': [{ Service: { Text: 'ECS' } }] });
  try {
    assert.equal(classifyUnsupported('ECS', dir), 'unknown');
    assert.equal(shouldInjectLang(['ECS', 'ListServers'], dir), false);
    assert.equal(shouldInjectLang(['BSS', 'x'], dir), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('koocli gate review: en-only machine (#597) classify unknown, no proactive', () => {
  const dir = withCatalog({ 'services_en.json': [{ Service: { Text: 'ECS' } }] });
  try {
    assert.equal(classifyUnsupported('BSS', dir), 'unknown');
    assert.equal(shouldInjectLang(['BSS', 'ShowCustomerAccountBalances'], dir), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('koocli gate review: both catalogs missing stays unknown, never proactive', () => {
  const dir = withCatalog({});
  try {
    assert.equal(classifyUnsupported('BSS', dir), 'unknown');
    assert.equal(shouldInjectLang(['BSS', 'ShowCustomerAccountBalances'], dir), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('koocli gate review: mixed-case catalog entries are normalized (G3 closes)', () => {
  // Real catalogs store mixed-case names (DevStar, CloudTable); lookups are uppercase.
  const dir = withCatalog({
    'services_cn.json': [{ Service: { Text: 'DevStar' } }, { Service: { Text: 'ECS' } }],
    'services_en.json': [{ Service: { Text: 'ECS' } }],
  });
  try {
    assert.equal(classifyUnsupported('DevStar', dir), 'lang-missing');
    assert.equal(shouldInjectLang(['DevStar', 'SomeOp'], dir), true);
    assert.equal(shouldInjectLang(['devstar', 'SomeOp'], dir), true);
    assert.equal(shouldInjectLang(['DEVSTAR', 'SomeOp'], dir), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('koocli gate review: full catalogs keep lang-missing / other / not-found', () => {
  const dir = withCatalog({
    'services_cn.json': [{ Service: { Text: 'BSS' } }, { Service: { Text: 'ECS' } }],
    'services_en.json': [{ Service: { Text: 'ECS' } }],
  });
  try {
    assert.equal(classifyUnsupported('BSS', dir), 'lang-missing');
    assert.equal(shouldInjectLang(['BSS', 'ShowCustomerAccountBalances'], dir), true);
    assert.equal(classifyUnsupported('ECS', dir), 'other');
    assert.equal(shouldInjectLang(['ECS', 'ListServers'], dir), false);
    assert.equal(classifyUnsupported('MadeUpService', dir), 'not-found');
    assert.equal(shouldInjectLang(['MadeUpService', 'x'], dir), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('koocli gate: no injection when service is in both catalogs', () => {
  const dir = withCatalog({
    'services_cn.json': [{ Service: { Text: 'ECS' } }, { Service: { Text: 'BSS' } }],
    'services_en.json': [{ Service: { Text: 'ECS' } }],
  });
  try {
    assert.equal(shouldInjectLang(['ECS', 'ListServers'], dir), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('koocli gate: empty or non-array args never inject', () => {
  const dir = withCatalog({
    'services_cn.json': [{ Service: { Text: 'BSS' } }],
    'services_en.json': [],
  });
  try {
    assert.equal(shouldInjectLang([], dir), false);
    assert.equal(shouldInjectLang(undefined, dir), false);
    assert.equal(shouldInjectLang('BSS', dir), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('classifyUnsupported: lang-missing / not-found / other', () => {
  const dir = withCatalog({
    'services_cn.json': [{ Service: { Text: 'BSS' } }, { Service: { Text: 'ECS' } }],
    'services_en.json': [{ Service: { Text: 'ECS' } }],
  });
  try {
    assert.equal(classifyUnsupported('BSS', dir), 'lang-missing');
    assert.equal(classifyUnsupported('NoSuchService', dir), 'not-found');
    assert.equal(classifyUnsupported('ECS', dir), 'other');
    assert.equal(classifyUnsupported('', dir), 'other');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runHcloud lang: proactively injects --cli-lang=cn once and tags the result', async () => {
  const dir = withCatalog({
    'services_cn.json': [{ Service: { Text: 'BSS' } }],
    'services_en.json': [{ Service: { Text: 'ECS' } }],
  });
  const stateFile = join(mkdtempSync(join(tmpdir(), 'koocli-state-')), 'count.txt');
  const script = fakeHcloudScript(`
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
const stateFile = ${JSON.stringify(stateFile)};
const count = existsSync(stateFile) ? Number(readFileSync(stateFile, 'utf8')) : 0;
writeFileSync(stateFile, String(count + 1));
const args = process.argv.slice(2);
if (!args.includes('--cli-lang=cn')) {
  console.error('Unsupported service: BSS');
  process.exit(1);
}
console.log(JSON.stringify({ ok: true, langs: args.filter((a) => a.startsWith('--cli-lang=')).length }));
`);
  try {
    const result = await runHcloud(['BSS', 'ShowCustomerAccountBalances'], {
      executable: process.execPath,
      executableArgs: [script],
      maxRetries: 0,
      metaDir: dir,
    });
    assert.equal(result.ok, true);
    assert.equal(result.autoRetried, true);
    assert.equal(result.injectedLang, 'cn');
    assert.equal(Number(JSON.parse(result.stdout).langs), 1);
    assert.equal(Number(readFileHelper(stateFile)), 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(stateFile, { recursive: true, force: true });
    rmSync(join(script, '..'), { recursive: true, force: true });
  }
});

test('runHcloud lang: reactive fallback runs at most once on Unsupported service', async () => {
  // cn-only catalog (en file missing): classify='unknown', no proactive inject,
  // but reactive is allowed and runs exactly once.
  const dir = withCatalog({
    'services_cn.json': [{ Service: { Text: 'BSS' } }, { Service: { Text: 'ECS' } }],
  });
  const stateFile = join(mkdtempSync(join(tmpdir(), 'koocli-reactive-state-')), 'count.txt');
  const script = fakeHcloudScript(`
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
const stateFile = ${JSON.stringify(stateFile)};
const count = existsSync(stateFile) ? Number(readFileSync(stateFile, 'utf8')) : 0;
writeFileSync(stateFile, String(count + 1));
const args = process.argv.slice(2);
if (count === 0) {
  console.error('Unsupported service: ECS');
  process.exit(1);
}
if (!args.includes('--cli-lang=cn')) {
  console.error('Unsupported service: ECS');
  process.exit(1);
}
console.log(JSON.stringify({ ok: true }));
`);
  try {
    const result = await runHcloud(['ECS', 'ListServersDetails'], {
      executable: process.execPath,
      executableArgs: [script],
      maxRetries: 0,
      retryBaseDelayMs: 1,
      metaDir: dir,
    });
    assert.equal(result.ok, true);
    assert.equal(result.autoRetried, true);
    assert.equal(result.reactiveFallback, true);
    assert.equal(result.injectedLang, 'cn');
    assert.equal(Number(readFileHelper(stateFile)), 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(stateFile, { recursive: true, force: true });
    rmSync(join(script, '..'), { recursive: true, force: true });
  }
});

test('runHcloud lang: does not inject when --cli-lang is already explicit', async () => {
  const dir = withCatalog({
    'services_cn.json': [{ Service: { Text: 'BSS' } }],
    'services_en.json': [{ Service: { Text: 'ECS' } }],
  });
  const argLog = join(mkdtempSync(join(tmpdir(), 'koocli-arglog-')), 'args.txt');
  const script = fakeHcloudScript(`
import { writeFileSync } from 'node:fs';
const argLog = ${JSON.stringify(argLog)};
writeFileSync(argLog, JSON.stringify(process.argv.slice(2)));
console.log(JSON.stringify({ ok: true }));
`);
  try {
    const result = await runHcloud(['BSS', 'ShowCustomerAccountBalances', '--cli-lang=en'], {
      executable: process.execPath,
      executableArgs: [script],
      maxRetries: 0,
      metaDir: dir,
    });
    assert.equal(result.ok, true);
    assert.equal(result.autoRetried, undefined);
    assert.equal(result.injectedLang, undefined);
    const seen = JSON.parse(readFileHelper(argLog));
    assert.ok(seen.includes('--cli-lang=en'));
    assert.ok(!seen.some((a) => a === '--cli-lang=cn'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(argLog, { recursive: true, force: true });
    rmSync(join(script, '..'), { recursive: true, force: true });
  }
});

test('runHcloud lang: unresolvable Unsupported service returns diagnostic with cause and nextStep', async () => {
  const dir = withCatalog({
    'services_cn.json': [{ Service: { Text: 'ECS' } }],
    'services_en.json': [{ Service: { Text: 'ECS' } }],
  });
  const script = fakeHcloudScript(`
console.error('Unsupported service: NoSuchService');
process.exit(1);
`);
  try {
    const result = await runHcloud(['NoSuchService', 'SomeOperation'], {
      executable: process.execPath,
      executableArgs: [script],
      maxRetries: 0,
      retryBaseDelayMs: 1,
      metaDir: dir,
    });
    assert.equal(result.ok, false);
    assert.equal(result.langCause, 'not-found');
    assert.match(result.langHint, /Unsupported service/i);
    assert.match(result.langHint, /refresh KooCLI metadata/i);
    assert.equal(
      result.langNextStep,
      'Check the service name, or refresh KooCLI metadata (hcloud upgrade / configure).',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(join(script, '..'), { recursive: true, force: true });
  }
});

test('runHcloud lang: exhausted injection still returns diagnostic with --cli-lang next step', async () => {
  const dir = withCatalog({
    'services_cn.json': [{ Service: { Text: 'BSS' } }, { Service: { Text: 'ECS' } }],
    'services_en.json': [{ Service: { Text: 'ECS' } }],
  });
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
    assert.equal(result.autoRetried, true);
    assert.equal(result.injectedLang, 'cn');
    assert.equal(result.langCause, 'lang-missing');
    assert.match(result.langHint, /--cli-lang=cn/);
    assert.equal(result.langNextStep, 'Re-run with --cli-lang=cn, or set hcloud configure set --cli-lang=cn.');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(join(script, '..'), { recursive: true, force: true });
  }
});
