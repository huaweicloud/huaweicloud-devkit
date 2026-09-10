import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { removeKooCli, removeObsConfig } from '../plugins/huaweicloud-core/src/sandbox/uninstall-cleanup.mjs';

test('removeKooCli removes default hcloud binary and config dir', () => {
  const home = mkdtempSync(join(tmpdir(), 'cleanup-kocli-'));
  try {
    const bin = join(home, '.local', 'bin', 'hcloud');
    mkdirSync(join(home, '.local', 'bin'), { recursive: true });
    writeFileSync(bin, '#!/bin/sh\n');
    const configDir = join(home, '.hcloud');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'config.json'), '{}');
    const installDir = join(home, 'hcloud');
    mkdirSync(installDir, { recursive: true });
    writeFileSync(join(installDir, 'hcloud.exe'), 'x');

    const removed = removeKooCli(home);

    assert.ok(!existsSync(bin), 'hcloud binary should be removed');
    assert.ok(!existsSync(configDir), '.hcloud config dir should be removed');
    assert.ok(!existsSync(join(installDir, 'hcloud.exe')), 'hcloud.exe should be removed');
    assert.ok(removed.length >= 3, `expected at least 3 removed paths, got ${removed.length}`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('removeKooCli does not touch an empty non-hcloud install dir', () => {
  const home = mkdtempSync(join(tmpdir(), 'cleanup-kocli2-'));
  try {
    const removed = removeKooCli(home);
    assert.deepEqual(removed, []);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('removeObsConfig removes the OBS config file', () => {
  const home = mkdtempSync(join(tmpdir(), 'cleanup-obs-'));
  const prev = process.env.HCLOUD_OBS_CONFIG_PATH;
  try {
    const obsFile = join(home, '.obsutilconfig');
    process.env.HCLOUD_OBS_CONFIG_PATH = obsFile;
    writeFileSync(obsFile, 'ak=x\nsk=y\n');

    const removed = removeObsConfig();

    assert.deepEqual(removed, [obsFile]);
    assert.ok(!existsSync(obsFile));
  } finally {
    if (prev === undefined) delete process.env.HCLOUD_OBS_CONFIG_PATH;
    else process.env.HCLOUD_OBS_CONFIG_PATH = prev;
    rmSync(home, { recursive: true, force: true });
  }
});

test('removeObsConfig returns empty when no OBS config exists', () => {
  const home = mkdtempSync(join(tmpdir(), 'cleanup-obs2-'));
  const prev = process.env.HCLOUD_OBS_CONFIG_PATH;
  try {
    process.env.HCLOUD_OBS_CONFIG_PATH = join(home, '.obsutilconfig');
    assert.deepEqual(removeObsConfig(), []);
  } finally {
    if (prev === undefined) delete process.env.HCLOUD_OBS_CONFIG_PATH;
    else process.env.HCLOUD_OBS_CONFIG_PATH = prev;
    rmSync(home, { recursive: true, force: true });
  }
});
