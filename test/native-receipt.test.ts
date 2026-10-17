import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import {
  NATIVE_RECEIPT_NAME,
  nativeReceiptPath,
  readNativeReceipt,
  writeNativeReceipt,
} from '../plugins/huaweicloud-core/src/lib/native-receipt.ts';
import { fixtureDir } from './fixture-dir.ts';

// The receipt state machine is shared by the setup CLI and the DSH
// postinstall (the compiled dist copy); these units pin the boundary both
// writers rely on.
test('readNativeReceipt: absent dir and absent file read as null', () => {
  const absent = fixtureDir('hwc-receipt-absent-');
  assert.equal(readNativeReceipt(absent), null);
  const dir = fixtureDir('hwc-receipt-empty-');
  mkdirSync(dir, { recursive: true });
  assert.equal(readNativeReceipt(dir), null);
});

test('readNativeReceipt: valid receipt reads as ok with shape-validated names', () => {
  const dir = fixtureDir('hwc-receipt-ok-');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    nativeReceiptPath(dir),
    JSON.stringify({ names: ['huaweicloud-core', 'steal-me', 42, 'huaweicloud-safety'] }),
  );
  const read = readNativeReceipt(dir);
  assert.ok(read?.kind === 'ok');
  assert.deepEqual(
    [...read.receipt.names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    ['huaweicloud-core', 'huaweicloud-safety'],
    'only core-name-shaped entries earn delete rights',
  );
});

test('readNativeReceipt: torn JSON and shape-broken names are corrupt, never ok-empty', () => {
  const shapes = ['{"names": [torn', '{"names": null}', '{}', '["names"]', 'null'];
  for (const [i, shape] of shapes.entries()) {
    const dir = fixtureDir(`hwc-receipt-broken-${i}-`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(nativeReceiptPath(dir), shape);
    assert.deepEqual(readNativeReceipt(dir), { kind: 'corrupt' }, `shape: ${shape}`);
  }
});

test('readNativeReceipt: layout and packageRoot pass through with type validation', () => {
  const dir = fixtureDir('hwc-receipt-layout-');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    nativeReceiptPath(dir),
    JSON.stringify({ names: ['huaweicloud-core'], layout: 'package-root', packageRoot: '/x/y', extra: true }),
  );
  const read = readNativeReceipt(dir);
  assert.ok(read?.kind === 'ok');
  assert.equal(read.receipt.layout, 'package-root');
  assert.equal(read.receipt.packageRoot, '/x/y');
  writeFileSync(nativeReceiptPath(dir), JSON.stringify({ names: [], layout: 7, packageRoot: 42 }));
  const wrongTypes = readNativeReceipt(dir);
  assert.ok(wrongTypes?.kind === 'ok');
  assert.equal(wrongTypes.receipt.layout, undefined);
  assert.equal(wrongTypes.receipt.packageRoot, undefined);
  // A relative packageRoot would steer doctor's comparator from an
  // attacker-controlled base: dropped, never trusted.
  writeFileSync(
    nativeReceiptPath(dir),
    JSON.stringify({ names: ['huaweicloud-core'], layout: 'package-root', packageRoot: 'relative/pkg' }),
  );
  const relative = readNativeReceipt(dir);
  assert.ok(relative?.kind === 'ok');
  assert.equal(relative.receipt.packageRoot, undefined, 'a relative packageRoot is dropped');
  // Control characters are stripped at READ time — the single entry point
  // every echo (doctor, uninstall) inherits — so a forged ESC sequence can
  // never render fake [PASS]/[FAIL] terminal lines from any consumer.
  writeFileSync(
    nativeReceiptPath(dir),
    JSON.stringify({
      names: ['huaweicloud-core'],
      layout: 'package-root',
      packageRoot: `/pkg${String.fromCharCode(27)}[32m[FAKE-PASS]${String.fromCharCode(27)}[0m`,
    }),
  );
  const injected = readNativeReceipt(dir);
  assert.ok(injected?.kind === 'ok');
  assert.ok(injected.receipt.packageRoot, 'an absolute root survives');
  assert.ok(
    !injected.receipt.packageRoot.includes(String.fromCharCode(27)),
    'control characters are stripped from the packageRoot on read',
  );
});

test('writeNativeReceipt: atomic rename leaves no temp file behind', () => {
  const dir = fixtureDir('hwc-receipt-write-');
  mkdirSync(dir, { recursive: true });
  writeNativeReceipt(dir, { names: ['huaweicloud-core'], layout: 'plugin-dir' });
  assert.deepEqual(readdirSync(dir), [NATIVE_RECEIPT_NAME]);
  assert.deepEqual(JSON.parse(readFileSync(nativeReceiptPath(dir), 'utf8')), {
    names: ['huaweicloud-core'],
    layout: 'plugin-dir',
  });
});

// The writer reclaims crash residue, age-gated: only tmp files old enough
// to be crash residue go — a concurrent live writer's in-flight tmp
// (microseconds old) must survive, or its rename would ENOENT and its
// receipt write would be lost.
test('writeNativeReceipt sweeps only aged tmp files', () => {
  const dir = fixtureDir('hwc-receipt-write2-');
  mkdirSync(dir, { recursive: true });
  const old = join(dir, `${NATIVE_RECEIPT_NAME}.424242.tmp`);
  const young = join(dir, `${NATIVE_RECEIPT_NAME}.999999.tmp`);
  writeFileSync(old, 'torn');
  writeFileSync(young, 'in-flight');
  const stale = new Date(Date.now() - 120_000);
  utimesSync(old, stale, stale);
  writeNativeReceipt(dir, { names: ['huaweicloud-core'] });
  assert.ok(!existsSync(old), 'an aged tmp is reclaimed');
  assert.ok(existsSync(young), 'a young (possibly in-flight) tmp is never swept');
  // The next write after the grace window reclaims it too.
  utimesSync(young, stale, stale);
  writeNativeReceipt(dir, { names: ['huaweicloud-core'] });
  assert.deepEqual(readdirSync(dir), [NATIVE_RECEIPT_NAME], 'only the receipt remains');
});
