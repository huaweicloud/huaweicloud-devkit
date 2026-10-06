import assert from 'node:assert/strict';
import test from 'node:test';

import { redactSecrets } from '../plugins/huaweicloud-core/src/safety-policy.mjs';

test('D2-4: redactSecrets redacts short-key credentials in object path (#857)', () => {
  const out = redactSecrets({ ak: 'AKID123', sk: 'SKXYZ456', token: 'TOKEN_ABC' });
  assert.equal(out.ak, '<redacted>');
  assert.equal(out.sk, '<redacted>');
  assert.equal(out.token, '<redacted>');
});

test('D4-27: redactSecrets redacts short-key credentials in JSON string path (#857)', () => {
  const json = '{"ak":"AKID123","sk":"SKXYZ456","access_token":"TOK_ABC","token":"TOK_X"}';
  const out = redactSecrets(json);
  assert.doesNotMatch(out, /AKID123/);
  assert.doesNotMatch(out, /SKXYZ456/);
  assert.doesNotMatch(out, /TOK_ABC/);
  assert.doesNotMatch(out, /TOK_X/);
  assert.match(out, /"ak":"<redacted>"/);
  assert.match(out, /"sk":"<redacted>"/);
  assert.match(out, /"access_token":"<redacted>"/);
  assert.match(out, /"token":"<redacted>"/);
});

test('D4-27: redactSecrets redacts lowercase ak=/sk= inline (#857)', () => {
  const out = redactSecrets('ak=AKID123 sk=SKXYZ456 token=ABC123');
  assert.doesNotMatch(out, /AKID123/);
  assert.doesNotMatch(out, /SKXYZ456/);
  assert.match(out, /ak=<redacted>/);
  assert.match(out, /sk=<redacted>/);
  assert.match(out, /token=<redacted>/);
});

test('D4-27: redactSecrets redacts nested JSON credentials (#857)', () => {
  const out = redactSecrets('{"credentials":{"ak":"AKID","sk":"SK","access_key":"AK"}}');
  assert.doesNotMatch(out, /AKID/);
  assert.doesNotMatch(out, /"SK"/);
  assert.match(out, /"ak":"<redacted>"/);
  assert.match(out, /"sk":"<redacted>"/);
});

test('D4-27: AK/SK case-insensitive regex does not false-positive on flake/mask/break (#857)', () => {
  const out = redactSecrets('flake=abc mask=xyz break=123');
  assert.equal(out, 'flake=abc mask=xyz break=123');
});

test('D4-27: uppercase AK=/SK= still redacted (no regression, #857)', () => {
  const out = redactSecrets('AK=AKID123 SK=SKXYZ456 token=ABC123');
  assert.doesNotMatch(out, /AKID123/);
  assert.doesNotMatch(out, /SKXYZ456/);
  assert.match(out, /AK=<redacted>/);
  assert.match(out, /SK=<redacted>/);
});

test('D4-27: access_token object key redacted via policy.json pattern (#857)', () => {
  const out = redactSecrets({ access_token: 'TOK_ABC', sec_token: 'SEC_X' });
  assert.equal(out.access_token, '<redacted>');
  assert.equal(out.sec_token, '<redacted>');
});
