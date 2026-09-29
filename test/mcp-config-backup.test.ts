import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import {
  mcpBackupFilePath,
  readAgentDelta,
  saveAgentDelta,
  takeAgentDelta,
  purgeBackup,
} from '../plugins/huaweicloud-core/src/mcp-config-backup.ts';

function tempBase() {
  return mkdtempSync(join(tmpdir(), 'devkit-mcp-backup-'));
}

test('mcpBackupFilePath honors HUAWEICLOUD_HOME and default layout', () => {
  const base = tempBase();
  const file = mcpBackupFilePath(base);
  assert.equal(file, join(base, '.config', 'huaweicloud', 'devkit-mcp-backup.json'));
});

test('saveAgentDelta writes file, readAgentDelta reads it back', () => {
  const base = tempBase();
  const file = mcpBackupFilePath(base);
  assert.equal(readAgentDelta('opencode', file), null);
  assert.equal(saveAgentDelta('opencode', { commandExtra: ['--flag'] }, file), true);
  const delta = readAgentDelta('opencode', file);
  assert.deepEqual(delta.commandExtra, ['--flag']);
  assert.ok(delta.savedAt);
});

test('saveAgentDelta overwrites prior delta for same agent, keeps others', () => {
  const base = tempBase();
  const file = mcpBackupFilePath(base);
  saveAgentDelta('opencode', { commandExtra: ['--old'] }, file);
  saveAgentDelta('workbuddy', { argsExtra: ['--w'] }, file);
  saveAgentDelta('opencode', { commandExtra: ['--new'] }, file);
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(raw.opencode.commandExtra, ['--new']);
  assert.deepEqual(raw.workbuddy.argsExtra, ['--w']);
});

test('takeAgentDelta consumes the entry and removes the file when empty', () => {
  const base = tempBase();
  const file = mcpBackupFilePath(base);
  saveAgentDelta('opencode', { commandExtra: ['--flag'] }, file);
  const delta = takeAgentDelta('opencode', file);
  assert.deepEqual(delta.commandExtra, ['--flag']);
  assert.equal(readAgentDelta('opencode', file), null);
  assert.equal(existsSync(file), false);
  assert.equal(takeAgentDelta('opencode', file), null);
});

test('takeAgentDelta keeps file when other agents remain', () => {
  const base = tempBase();
  const file = mcpBackupFilePath(base);
  saveAgentDelta('opencode', { commandExtra: ['--a'] }, file);
  saveAgentDelta('hermes', { argsExtra: ['--b'] }, file);
  takeAgentDelta('opencode', file);
  assert.equal(existsSync(file), true);
  assert.deepEqual(readAgentDelta('hermes', file).argsExtra, ['--b']);
});

test('corrupt backup file is treated as empty, not fatal', () => {
  const base = tempBase();
  const file = mcpBackupFilePath(base);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, '{not json');
  assert.equal(readAgentDelta('opencode', file), null);
  assert.equal(saveAgentDelta('opencode', { commandExtra: ['--flag'] }, file), true);
  assert.deepEqual(readAgentDelta('opencode', file).commandExtra, ['--flag']);
});

test('purgeBackup removes the file; saveAgentDelta rejects invalid input', () => {
  const base = tempBase();
  const file = mcpBackupFilePath(base);
  assert.equal(purgeBackup(file), false);
  saveAgentDelta('opencode', { commandExtra: ['--flag'] }, file);
  assert.equal(purgeBackup(file), true);
  assert.equal(existsSync(file), false);
  assert.equal(saveAgentDelta('opencode', null, file), false);
  assert.equal(saveAgentDelta('', { commandExtra: ['--flag'] }, file), false);
});
