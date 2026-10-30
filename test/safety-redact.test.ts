import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  classifyHcloudArgs,
  classifyTextCommand,
  deriveSecretOperationAlternation,
  loadPolicy,
  redactSecrets,
} from '../plugins/huaweicloud-core/src/safety-policy.ts';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

test('loadPolicy fails closed on a malformed policy file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hwc-policy-'));
  try {
    const write = (content: string) => writeFileSync(join(dir, 'policy.json'), content);
    const expectThrow = (content: string, fragment: string) => {
      write(content);
      assert.throws(() => loadPolicy(join(dir, 'policy.json')), /TypeError/, fragment);
    };
    expectThrow('[]', 'array root');
    expectThrow('null', 'null root');
    expectThrow('{"writeOperationPrefixes": "list-vpcs"}', 'non-array field');
    expectThrow('{"secretKeyNamePatterns": null}', 'null field');
    // Interrogate round 2: an EMPTIED write list reclassifies write commands
    // as safe — the exact fail-open the non-array throw prevents, one shape
    // over. Present-but-empty throws (an all-non-string list filters to
    // empty and throws the same way); the absent field still normalizes to
    // [] for older policies (asserted in the accept test below). A [""] list
    // stays legal: the entry is a string, survives the filter, and the
    // empty-branch regex matches everything — deny-all-writes, fail-closed.
    expectThrow('{"writeOperationPrefixes": []}', 'emptied write list');
    expectThrow('{"writeOperationPrefixes": [null, 1]}', 'all-non-string write list');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadPolicy accepts absent fields and the shipped policy', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hwc-policy-'));
  try {
    writeFileSync(join(dir, 'policy.json'), '{"writeOperationPrefixes": ["List"]}');
    const partial = loadPolicy(join(dir, 'policy.json'));
    assert.deepEqual(partial.writeOperationPrefixes, ['List']);
    assert.deepEqual(partial.secretKeyNamePatterns, []);
    // The absent write field stays the older-policy compat shape ([]), the
    // empty-present one does not (throws above).
    writeFileSync(join(dir, 'policy.json'), '{"readOperationPrefixes": ["List"]}');
    const absentWrite = loadPolicy(join(dir, 'policy.json'));
    assert.deepEqual(absentWrite.writeOperationPrefixes, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const shipped = loadPolicy();
  assert.ok(shipped.writeOperationPrefixes.length > 0, 'shipped policy keeps write prefixes');
});

test('redactSecrets removes credential-shaped values recursively', () => {
  const redacted = redactSecrets({
    profile: 'dev',
    access_key: 'example-access-key',
    nested: {
      secretAccessKey: 'example-secret-key',
      normal: 'visible',
    },
  }) as {
    profile: string;
    access_key: string;
    nested: { secretAccessKey: string; normal: string };
  };
  assert.equal(redacted.profile, 'dev');
  assert.equal(redacted.access_key, '<redacted>');
  assert.equal(redacted.nested.secretAccessKey, '<redacted>');
  assert.equal(redacted.nested.normal, 'visible');
});

test('redactSecrets redacts adminPass and password fields', () => {
  const redacted = redactSecrets({
    '--server.adminPass': 'MySecret123!',
    password: 'hunter2',
    normal_field: 'keep',
  }) as { '--server.adminPass': string; password: string; normal_field: string };
  assert.equal(redacted['--server.adminPass'], '<redacted>');
  assert.equal(redacted.password, '<redacted>');
  assert.equal(redacted.normal_field, 'keep');
});

test('redactSecrets handles array values', () => {
  const redacted = redactSecrets([
    { name: 'prod', secret_key: 'sk-xxx' },
    { name: 'dev', normal: 'value' },
  ]) as { name: string; secret_key: string; normal: string }[];
  assert.equal(redacted[0].secret_key, '<redacted>');
  assert.equal(redacted[1].normal, 'value');
});

test('redactSecrets handles string values with key=value patterns', () => {
  const out = redactSecrets('AK=HPUAI12345\nSK=abcdef\nnormal output');
  assert.match(out, /<redacted>/);
  assert.match(out, /normal output/);
  assert.doesNotMatch(out, /HPUAI12345/);
});

test('redactSecrets redacts bare token= values (#726 D4-27)', () => {
  const out = redactSecrets('token=TokenValueABCDEF123456');
  assert.equal(out, 'token=<redacted>');
  assert.doesNotMatch(out, /TokenValueABCDEF123456/);
  // Long secret-token keys still redact (no regression, longest-match first).
  assert.equal(redactSecrets('security_token=stABC123'), 'security_token=<redacted>');
  assert.equal(redactSecrets('x_auth_token=xatABC123'), 'x_auth_token=<redacted>');
  // Other secret keywords keep working alongside bare token.
  assert.equal(
    redactSecrets('token=t1\npassword=pw1\nadminPass=ap1\naccess_key=ak1'),
    'token=<redacted>\npassword=<redacted>\nadminPass=<redacted>\naccess_key=<redacted>',
  );
  // Non-secret tokens (e.g. tokenize=) must NOT be redacted — the '=' boundary
  // ensures 'token' is followed by '=' directly, not by 'ize'.
  assert.equal(redactSecrets('tokenize=abc\ntokenizer=xyz'), 'tokenize=abc\ntokenizer=xyz');
});

test('redactSecrets redacts admin-pass / admin_pass / adminPass variants (#726 D4-27 v2)', () => {
  // String path: redactString regex now uses admin[_-]?pass to cover all three
  // shapes (camelCase / hyphen / underscore) under the /i flag.
  assert.equal(redactSecrets('adminPass=Secret123!'), 'adminPass=<redacted>');
  assert.equal(redactSecrets('admin-pass=Secret123!'), 'admin-pass=<redacted>');
  assert.equal(redactSecrets('admin_pass=Secret123!'), 'admin_pass=<redacted>');
  assert.equal(redactSecrets('ADMIN-PASS=Secret123!'), 'ADMIN-PASS=<redacted>');
  assert.equal(redactSecrets('Admin_Pass=Secret123!'), 'Admin_Pass=<redacted>');
  // admin-password also redacts (password keyword catches it) — regression guard.
  assert.equal(redactSecrets('admin-password=Secret123!'), 'admin-password=<redacted>');
  // Object key path: isSecretKeyName normalizes separators, so all variants
  // are already secret-classified — regression guard.
  const obj = redactSecrets({
    adminPass: 'v1',
    'admin-pass': 'v2',
    admin_pass: 'v3',
  }) as { adminPass: string; 'admin-pass': string; admin_pass: string };
  assert.equal(obj.adminPass, '<redacted>');
  assert.equal(obj['admin-pass'], '<redacted>');
  assert.equal(obj.admin_pass, '<redacted>');
});

test('redactSecrets masks opaque blob keys (user_data / metadata / private_key) entirely', () => {
  const redacted = redactSecrets([
    'ECS',
    'CreateServers',
    '--server.user_data=ZXhwb3J0IEFQUF9TRUNSRVQ9czNjcjN0',
    '--server.user_data=echo TOKEN=abc123 >> /etc/x',
    '--server.metadata.db_password=secret123',
    '--keypair.private_key=-----BEGIN RSA PRIVATE KEY-----',
  ]) as string[];
  for (const arg of redacted) {
    assert.doesNotMatch(arg, /SECRET|TOKEN|abc123|secret123|RSA|PRIVATE/);
  }
  assert.match(redacted[2], /user_data=<redacted>/);
  assert.match(redacted[3], /user_data=<redacted>/);
  assert.match(redacted[4], /metadata.db_password=<redacted>/);
  assert.match(redacted[5], /private_key=<redacted>/);
});
