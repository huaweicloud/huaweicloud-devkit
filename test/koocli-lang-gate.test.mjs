import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  classifyUnsupported,
  readServiceCatalogs,
  shouldInjectLang,
} from '../plugins/huaweicloud-core/src/hcloud-cli.mjs';

function withCatalog(files) {
  const dir = mkdtempSync(join(tmpdir(), 'koocli-meta-'));
  for (const [name, items] of Object.entries(files)) {
    writeFileSync(join(dir, name), JSON.stringify({ items }));
  }
  return dir;
}

test('readServiceCatalogs: maps items[].Service.Text into cn/en sets', () => {
  const dir = withCatalog({
    'services_cn.json': [{ Service: { Text: 'BSS' } }, { Service: { Text: 'ECS' } }],
    'services_en.json': [{ Service: { Text: 'ECS' } }],
  });
  try {
    const { cn, en } = readServiceCatalogs(dir);
    assert.deepEqual([...cn].sort((a, b) => a.localeCompare(b)), ['BSS', 'ECS']);
    assert.deepEqual([...en].sort((a, b) => a.localeCompare(b)), ['ECS']);
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