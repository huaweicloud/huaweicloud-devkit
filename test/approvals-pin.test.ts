import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { after, before, test } from 'node:test';

import {
  approvalsPinPath,
  enrollApprovalsPin,
  isApprovalsPinEnrolled,
  verifyApprovalsPin,
} from '../plugins/huaweicloud-core/src/lib/approvals-pin.ts';
import { clearCustodyCache } from '../plugins/huaweicloud-core/src/lib/secret-vault/custody.ts';
import { fixtureDir } from './fixture-dir.ts';

// The approval PIN: the boundary credential the terminal confirm flow
// checks. The no-reveal doctrine mirrors the vault — only a mac over the
// custody master key is ever persisted, never the plaintext pin.

const TEST_KEY = Buffer.alloc(32, 0x33).toString('base64');
const PIN = 'pin-correct-42';

// One vault-backed home for the file's process (hooks, not a wrapper):
// every test resets its own enrollment state, and enroll-overwrite keeps
// the tests order-independent.
const home = fixtureDir('approvals-pin-home-');
const previousHome = process.env.HUAWEICLOUD_HOME;
const previousKey = process.env.HW_VAULT_MASTER_KEY;

before(() => {
  process.env.HUAWEICLOUD_HOME = home;
  process.env.HW_VAULT_MASTER_KEY = TEST_KEY;
  clearCustodyCache();
});

after(() => {
  clearCustodyCache();
  for (const [name, saved] of Object.entries({
    HUAWEICLOUD_HOME: previousHome,
    HW_VAULT_MASTER_KEY: previousKey,
  })) {
    if (saved === undefined) delete process.env[name];
    else process.env[name] = saved;
  }
});

function resetEnrollment(): void {
  rmSync(approvalsPinPath(), { force: true, recursive: true });
}

test('no pin enrolled: verify fails closed with the enrollment reason', () => {
  resetEnrollment();
  assert.equal(isApprovalsPinEnrolled(), false);

  const result = verifyApprovalsPin('anything-goes');
  assert.equal(result.ok, false);
  assert.match(result.reason ?? '', /no approvals PIN is enrolled/);
});

test('enroll rejects pins shorter than six characters without persisting', () => {
  resetEnrollment();
  const result = enrollApprovalsPin('12345');
  assert.equal(result.ok, false);
  assert.match(result.reason ?? '', /at least 6/);
  assert.equal(isApprovalsPinEnrolled(), false, 'a rejected enroll persists nothing');
});

test('enroll persists only a mac: round-trip verify passes, the wrong pin fails', () => {
  resetEnrollment();
  const result = enrollApprovalsPin(PIN);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(isApprovalsPinEnrolled(), true);

  const raw = readFileSync(approvalsPinPath(), 'utf8');
  const record = JSON.parse(raw) as { pinMac?: string };
  assert.match(record.pinMac ?? '', /^[0-9a-f]{64}$/, 'the record is a sha256-hex mac');
  assert.ok(!raw.includes(PIN), 'the plaintext pin is never persisted');
  if (process.platform !== 'win32') {
    assert.equal(statSync(approvalsPinPath()).mode & 0o777, 0o600, 'the pin record is owner-only');
  }

  assert.equal(verifyApprovalsPin(PIN).ok, true, 'the enrolled pin verifies');
  const wrong = verifyApprovalsPin('pin-correct-43');
  assert.equal(wrong.ok, false);
  assert.match(wrong.reason ?? '', /does not match/);
});

test('re-enroll overwrites: the old pin stops verifying, the new one starts', () => {
  resetEnrollment();
  assert.equal(enrollApprovalsPin('first-pin-99').ok, true);
  assert.equal(enrollApprovalsPin('second-pin-77').ok, true, 're-enroll is the recovery path');
  assert.equal(verifyApprovalsPin('first-pin-99').ok, false, 'the overwritten pin no longer verifies');
  assert.equal(verifyApprovalsPin('second-pin-77').ok, true);
});

test('a mangled pin record reads as not enrolled (fail closed)', () => {
  resetEnrollment();
  assert.equal(enrollApprovalsPin(PIN).ok, true);
  writeFileSync(approvalsPinPath(), JSON.stringify({ pinMac: 'not-a-mac' }), 'utf8');

  assert.equal(isApprovalsPinEnrolled(), false, 'a malformed record reads as absent');
  const result = verifyApprovalsPin(PIN);
  assert.equal(result.ok, false);
  assert.match(result.reason ?? '', /no approvals PIN is enrolled/);
});

test('a broken custody tier fails verify closed', () => {
  resetEnrollment();
  assert.equal(enrollApprovalsPin(PIN).ok, true);

  const savedKey = process.env.HW_VAULT_MASTER_KEY;
  process.env.HW_VAULT_MASTER_KEY = 'too-short';
  clearCustodyCache();
  try {
    const result = verifyApprovalsPin(PIN);
    assert.equal(result.ok, false, 'no mac can recompute under a broken tier');
    assert.match(result.reason ?? '', /HW_VAULT_MASTER_KEY/);
  } finally {
    if (savedKey === undefined) delete process.env.HW_VAULT_MASTER_KEY;
    else process.env.HW_VAULT_MASTER_KEY = savedKey;
    clearCustodyCache();
  }
});

test('an unresolvable master key fails verify closed', () => {
  resetEnrollment();
  assert.equal(enrollApprovalsPin(PIN).ok, true);

  const savedKey = process.env.HW_VAULT_MASTER_KEY;
  delete process.env.HW_VAULT_MASTER_KEY;
  clearCustodyCache();
  try {
    const result = verifyApprovalsPin(PIN);
    assert.equal(result.ok, false, 'with no resolvable key the mac cannot be recomputed');
    assert.equal(typeof result.reason, 'string');
  } finally {
    if (savedKey === undefined) delete process.env.HW_VAULT_MASTER_KEY;
    else process.env.HW_VAULT_MASTER_KEY = savedKey;
    clearCustodyCache();
  }
});

test('an unpersistable pin path fails the enrollment closed', () => {
  resetEnrollment();
  // A directory squatting on the record path makes the atomic rename fail:
  // the write failure must surface as {ok:false}, never a silent success.
  rmSync(approvalsPinPath(), { force: true, recursive: true });
  mkdirSync(approvalsPinPath(), { recursive: true });

  const result = enrollApprovalsPin(PIN);
  assert.equal(result.ok, false);
  assert.match(result.reason ?? '', /failed to persist/);
  assert.equal(isApprovalsPinEnrolled(), false, 'a failed enroll reports unenrolled');
});
