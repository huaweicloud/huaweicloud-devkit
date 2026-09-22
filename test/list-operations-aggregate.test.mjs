import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { callTool } from '../plugins/huaweicloud-core/src/tools.mjs';

function fakeHcloudExecutable(source) {
  const dir = mkdtempSync(join(tmpdir(), 'listops-fake-bin-'));
  const script = join(dir, 'fake-hcloud');
  writeFileSync(script, `#!/usr/bin/env node\n${source}`, 'utf8');
  chmodSync(script, 0o755);
  return script;
}

// A fake hcloud that prints a recognizable marker per real KooCLI sub-service
// so the test can assert each sub-service was queried independently.
function fakeAggregateHcloudScript() {
  return `
const args = process.argv.slice(2);
// args: <Service> --help  OR  <Service> help
const svc = (args[0] || '').toLowerCase();
const help = {
  kafka: 'Kafka operations: CreateInstance, ListInstances, DeleteInstance',
  rabbitmq: 'RabbitMQ operations: CreateInstance, ListInstances',
  rocketmq: 'RocketMQ operations: CreateInstance, ListInstances',
  kms: 'KMS operations: CreateKey, ListKeys, Encrypt, Decrypt',
  csms: 'CSMS operations: CreateSecret, ListSecrets, ShowSecret',
};
const text = help[svc];
if (text) { console.log(text); process.exit(0); }
console.error('Unsupported service: ' + args[0]);
process.exit(1);
`;
}

function withFakeHcloud(fn) {
  const prevBin = process.env.HCLOUD_BIN;
  const prevHome = process.env.HUAWEICLOUD_HOME;
  const home = mkdtempSync(join(tmpdir(), 'listops-home-'));
  const bin = fakeHcloudExecutable(fakeAggregateHcloudScript());
  process.env.HCLOUD_BIN = bin;
  process.env.HUAWEICLOUD_HOME = home;
  return (async () => {
    try {
      return await fn();
    } finally {
      if (prevBin === undefined) delete process.env.HCLOUD_BIN;
      else process.env.HCLOUD_BIN = prevBin;
      if (prevHome === undefined) delete process.env.HUAWEICLOUD_HOME;
      else process.env.HUAWEICLOUD_HOME = prevHome;
      rmSync(home, { recursive: true, force: true });
      rmSync(join(bin, '..'), { recursive: true, force: true });
    }
  })();
}

test('list_operations DMS returns aggregated Kafka/RabbitMQ/RocketMQ operations (not unsupported)', async () => {
  await withFakeHcloud(async () => {
    const out = await callTool('huaweicloud_list_operations', { service: 'DMS' });
    assert.equal(out.service, 'DMS');
    assert.equal(out.aggregate, true);
    assert.deepEqual(out.aggregatedFrom, ['Kafka', 'RabbitMQ', 'RocketMQ']);
    assert.ok(Array.isArray(out.subServices), 'subServices must be an array');
    assert.equal(out.subServices.length, 3);
    const names = out.subServices.map((s) => s.subService);
    assert.deepEqual(names, ['Kafka', 'RabbitMQ', 'RocketMQ']);
    for (const sub of out.subServices) {
      assert.equal(sub.result.ok, true, `${sub.subService} --help should succeed`);
      assert.match(sub.result.stdout, /operations:/, `${sub.subService} help text present`);
    }
    // The aggregate response must not surface the old unsupported error shape.
    assert.equal(out.result, undefined, 'aggregate response must not carry a top-level unsupported result');
  });
});

test('list_operations DEW returns aggregated KMS/CSMS operations (not unsupported)', async () => {
  await withFakeHcloud(async () => {
    const out = await callTool('huaweicloud_list_operations', { service: 'DEW' });
    assert.equal(out.service, 'DEW');
    assert.equal(out.aggregate, true);
    assert.deepEqual(out.aggregatedFrom, ['KMS', 'CSMS']);
    assert.equal(out.subServices.length, 2);
    const names = out.subServices.map((s) => s.subService);
    assert.deepEqual(names, ['KMS', 'CSMS']);
    for (const sub of out.subServices) {
      assert.equal(sub.result.ok, true, `${sub.subService} --help should succeed`);
    }
  });
});

test('list_operations DMS is case-insensitive (dms lower-case input)', async () => {
  await withFakeHcloud(async () => {
    const out = await callTool('huaweicloud_list_operations', { service: 'dms' });
    assert.equal(out.aggregate, true);
    assert.deepEqual(out.aggregatedFrom, ['Kafka', 'RabbitMQ', 'RocketMQ']);
  });
});

test('list_operations ECS (non-aggregate) path unchanged — no aggregate field', async () => {
  // ECS is not in AGGREGATE_SERVICE_MAP; the response must keep the legacy shape.
  await withFakeHcloud(async () => {
    const out = await callTool('huaweicloud_list_operations', { service: 'ECS' });
    assert.equal(out.aggregate, undefined);
    assert.equal(out.subServices, undefined);
    // The fake hcloud returns "Unsupported service: ECS" → result.ok=false, but
    // the response shape is the legacy single-result form (not aggregated).
    assert.ok(out.result, 'legacy response carries a top-level result');
    assert.equal(out.result.ok, false);
  });
});

test('list_operations falls back to <sub> help when --help fails for a sub-service', async () => {
  // Some KooCLI sub-services answer to `help` rather than `--help` (e.g. OBS).
  // Verify the fallback path is exercised for aggregate sub-services too.
  const script = `
const args = process.argv.slice(2);
const svc = (args[0] || '').toLowerCase();
const flag = args[1];
if (svc === 'kafka' && flag === '--help') { console.error('No such command'); process.exit(1); }
if (svc === 'kafka' && flag === 'help') { console.log('Kafka operations: ListInstances'); process.exit(0); }
if (svc === 'rabbitmq') { console.log('RabbitMQ operations: ListInstances'); process.exit(0); }
if (svc === 'rocketmq') { console.log('RocketMQ operations: ListInstances'); process.exit(0); }
console.error('Unsupported service: ' + args[0]); process.exit(1);
`;
  const bin = fakeHcloudExecutable(script);
  const prevBin = process.env.HCLOUD_BIN;
  const prevHome = process.env.HUAWEICLOUD_HOME;
  const home = mkdtempSync(join(tmpdir(), 'listops-fallback-'));
  process.env.HCLOUD_BIN = bin;
  process.env.HUAWEICLOUD_HOME = home;
  try {
    const out = await callTool('huaweicloud_list_operations', { service: 'DMS' });
    assert.equal(out.aggregate, true);
    const kafka = out.subServices.find((s) => s.subService === 'Kafka');
    assert.equal(kafka.result.ok, true, 'Kafka fallback to `help` should succeed');
    assert.match(kafka.result.stdout, /Kafka operations:/);
  } finally {
    if (prevBin === undefined) delete process.env.HCLOUD_BIN;
    else process.env.HCLOUD_BIN = prevBin;
    if (prevHome === undefined) delete process.env.HUAWEICLOUD_HOME;
    else process.env.HUAWEICLOUD_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(join(bin, '..'), { recursive: true, force: true });
  }
});
