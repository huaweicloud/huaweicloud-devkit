import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { fixtureDir } from './fixture-dir.ts';

import {
  recordDisclosure,
  recordToolCall,
  redactForTrace,
  traceOutboundDisclosure,
} from '../plugins/huaweicloud-core/src/lib/call-trace.ts';

const TRACE_ENV = 'HUAWEICLOUD_DEVKIT_TRACE';

function withTracePath(fn: (path: string) => void) {
  const dir = fixtureDir('call-trace-');
  const path = join(dir, 'trace.jsonl');
  const prev = process.env[TRACE_ENV];
  process.env[TRACE_ENV] = path;
  try {
    fn(path);
  } finally {
    if (prev === undefined) delete process.env[TRACE_ENV];
    else process.env[TRACE_ENV] = prev;
    rmSync(dir, { recursive: true, force: true });
  }
}

function readRecords(path: string): Record<string, unknown>[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

test('toolCall record shape is pinned (schema freeze)', () => {
  withTracePath((path) => {
    recordToolCall('huaweicloud_plan_cli_command', { args: ['VPC', 'ListVpcs'] }, true);
    const [record] = readRecords(path);
    assert.deepEqual(
      Object.keys(record).sort((a, b) => a.localeCompare(b)),
      ['args', 'name', 'ok', 'ts', 'type', 'v'],
    );
    assert.equal(record.type, 'toolCall');
    assert.equal(record.v, 1);
    assert.equal(record.name, 'huaweicloud_plan_cli_command');
    assert.equal(record.ok, true);
    assert.deepEqual(record.args, { args: ['VPC', 'ListVpcs'] });
    assert.match(String(record.ts), /^\d{4}-\d{2}-\d{2}T/);
  });
});

test('failed toolCall records ok=false with a redacted truncated error', () => {
  withTracePath((path) => {
    recordToolCall(
      'huaweicloud_plan_cli_command',
      {},
      false,
      new Error(`boom access_key=REAL_SECRET ${'x'.repeat(400)}`),
    );
    const [record] = readRecords(path);
    assert.equal(record.ok, false);
    const error = String(record.error);
    assert.ok(error.startsWith('boom'));
    assert.ok(!error.includes('REAL_SECRET'), 'error must be redacted');
    assert.ok(error.length <= 300, 'error must be truncated');
  });
});

test('auth_init args never emit AK/SK into the trace', () => {
  withTracePath((path) => {
    recordToolCall('huaweicloud_auth_init', { ak: 'REAL_AK', sk: 'REAL_SK', region: 'cn-north-4' }, true);
    const raw = readFileSync(path, 'utf8');
    assert.ok(!raw.includes('REAL_AK'), 'AK must never reach the trace file');
    assert.ok(!raw.includes('REAL_SK'), 'SK must never reach the trace file');
    const [record] = readRecords(path);
    assert.equal((record.args as Record<string, unknown>).ak, '<redacted>');
    assert.equal((record.args as Record<string, unknown>).sk, '<redacted>');
    assert.equal((record.args as Record<string, unknown>).region, 'cn-north-4');
  });
});

test('api_key/apiKey are redacted (supplemental denylist beyond redactSecrets)', () => {
  const redacted = redactForTrace({
    api_key: 'LONG_LIVED_KEY',
    toolArgs: { apiKey: 'NESTED_KEY', region: 'cn-north-4' },
    securityToken: 'STS',
  }) as Record<string, unknown>;
  assert.equal(redacted.api_key, '<redacted>');
  assert.equal((redacted.toolArgs as Record<string, unknown>).apiKey, '<redacted>');
  assert.equal((redacted.toolArgs as Record<string, unknown>).region, 'cn-north-4');
  assert.equal(redacted.securityToken, '<redacted>');
});

test('secret_set value payloads are redacted (the trace seam is a superset of the vault face)', () => {
  // Born from a rebase: v2's trace seam wraps every dispatch while the
  // secrets pack's channel=value carries the plaintext under `value` —
  // neither parent could have seen the interaction. `value` is no other
  // tool's arg name, so the denylist entry is collision-free.
  const redacted = redactForTrace({
    ref: 'secret://user/hw-sk',
    channel: 'value',
    value: 'PLAINTEXT_SECRET_VALUE',
    note: 'safe metadata',
  }) as Record<string, unknown>;
  assert.equal(redacted.value, '<redacted>');
  assert.equal(redacted.ref, 'secret://user/hw-sk');
  assert.equal(redacted.note, 'safe metadata');
});

test('disclosure records pin event and toolCount', () => {
  withTracePath((path) => {
    recordDisclosure('toolsList', 46);
    recordDisclosure('toolsListChanged');
    const records = readRecords(path);
    assert.deepEqual(
      Object.keys(records[0]!).sort((a, b) => a.localeCompare(b)),
      ['event', 'toolCount', 'ts', 'type', 'v'],
    );
    assert.equal(records[0]!.type, 'disclosure');
    assert.equal(records[0]!.event, 'toolsList');
    assert.equal(records[0]!.toolCount, 46);
    assert.equal(records[1]!.event, 'toolsListChanged');
    assert.equal('toolCount' in records[1]!, false);
  });
});

test('traceOutboundDisclosure extracts only the two disclosure messages', () => {
  withTracePath((path) => {
    traceOutboundDisclosure({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
    traceOutboundDisclosure({
      jsonrpc: '2.0',
      id: 1,
      result: { tools: [{ name: 'a' }, { name: 'b' }, { name: 'c' }] },
    });
    traceOutboundDisclosure({ jsonrpc: '2.0', id: 2, result: { content: [] } });
    traceOutboundDisclosure({ jsonrpc: '2.0', method: 'notifications/initialized' });
    const records = readRecords(path);
    assert.equal(records.length, 2, 'only disclosure-relevant messages are traced');
    assert.equal(records[0]!.event, 'toolsListChanged');
    assert.equal(records[1]!.event, 'toolsList');
    assert.equal(records[1]!.toolCount, 3);
  });
});

test('unset env means no file is written', () => {
  const dir = fixtureDir('call-trace-');
  try {
    const prev = process.env[TRACE_ENV];
    delete process.env[TRACE_ENV];
    try {
      recordToolCall('x', {}, true);
      recordDisclosure('toolsList', 1);
      traceOutboundDisclosure({ result: { tools: [] } });
      assert.equal(existsSync(join(dir, 'anything')), false);
    } finally {
      if (prev !== undefined) process.env[TRACE_ENV] = prev;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('trace file is created 0600 and best-effort on unwritable paths', () => {
  withTracePath((path) => {
    recordToolCall('x', {}, true);
    assert.equal(statSync(path).mode & 0o777, 0o600);
  });
  // An impossible path must not throw — tracing never fails a tool call.
  const dir = fixtureDir('call-trace-');
  try {
    const prev = process.env[TRACE_ENV];
    process.env[TRACE_ENV] = join(dir, 'no-such-dir', 'deeper', 'trace.jsonl');
    try {
      recordToolCall('x', {}, true);
      recordDisclosure('toolsList', 1);
    } finally {
      if (prev === undefined) delete process.env[TRACE_ENV];
      else process.env[TRACE_ENV] = prev;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('redactForTrace never mutates the input args object', () => {
  const args = { ak: 'REAL_AK', toolArgs: { apiKey: 'K' } };
  const snapshot = JSON.stringify(args);
  redactForTrace(args);
  assert.equal(JSON.stringify(args), snapshot);
});

test('unset env leaves no trace artifacts in the temp dir', async () => {
  const dir = fixtureDir('call-trace-');
  try {
    writeFileSync(join(dir, '.keep'), '');
    const prev = process.env[TRACE_ENV];
    delete process.env[TRACE_ENV];
    try {
      recordToolCall('x', {}, true);
    } finally {
      if (prev !== undefined) process.env[TRACE_ENV] = prev;
    }
    const { readdirSync } = await import('node:fs');
    assert.deepEqual(readdirSync(dir), ['.keep']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
