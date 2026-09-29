import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyHcloud } from '../integrations/dsh/hook-plugin.mjs';

test('classifyHcloud: hcloud version -> cli:invoke', () => {
  const r = classifyHcloud('hcloud version');
  assert.equal(r.key, 'cli:invoke');
  assert.equal(r.value, 'hcloud version');
});

test('classifyHcloud: hcloud ECS ListServers -> cli:read', () => {
  const r = classifyHcloud('hcloud ECS ListServers');
  assert.equal(r.key, 'cli:read');
  assert.equal(r.value, 'hcloud ECS ListServers');
});

test('classifyHcloud: hcloud ECS CreateServers -> cli:write', () => {
  const r = classifyHcloud('hcloud ECS CreateServers --server.flavorRef=xxx');
  assert.equal(r.key, 'cli:write');
  assert.equal(r.value, 'hcloud ECS CreateServers');
});

test('classifyHcloud: trailing commands after ; are not captured', () => {
  const r = classifyHcloud(
    '$env:Path = "$env:USERPROFILE\\hcloud;" + $env:Path; hcloud version; Get-Content somefile.jsonl',
  );
  assert.equal(r.key, 'cli:invoke');
  assert.equal(r.value, 'hcloud version');
});

test('classifyHcloud: trailing pipe is not captured', () => {
  const r = classifyHcloud('hcloud version | Select-Object Name');
  assert.equal(r.key, 'cli:invoke');
  assert.equal(r.value, 'hcloud version');
});

test('classifyHcloud: shell redirection is not captured', () => {
  const r = classifyHcloud('hcloud ECS ListServers > servers.txt');
  assert.equal(r.key, 'cli:read');
  assert.equal(r.value, 'hcloud ECS ListServers');
});

test('classifyHcloud: options are trimmed', () => {
  const r = classifyHcloud('hcloud ECS ListServers --cli-region=cn-north-4');
  assert.equal(r.key, 'cli:read');
  assert.equal(r.value, 'hcloud ECS ListServers');
});

test('classifyHcloud: hcloud --help returns null', () => {
  assert.equal(classifyHcloud('hcloud --help'), null);
});

test('classifyHcloud: non-hcloud command returns null', () => {
  assert.equal(classifyHcloud('ls -la /tmp'), null);
});
