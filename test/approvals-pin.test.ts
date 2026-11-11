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
  const record = JSON.parse(raw) as { pinMac?: string; fails?: number; lockedUntil?: number };
  assert.match(record.pinMac ?? '', /^[0-9a-f]{64}$/, 'the record is a sha256-hex mac');
  assert.equal(record.fails, 0, 'a fresh enrollment starts the failure counter at zero');
  assert.equal(record.lockedUntil, 0, 'and unlocked');
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

// ── Failure lockout (F3) ─────────────────────────────────────────────────────
// Online guessing is slowed by a persistent counter: every 6th cumulative
// failure locks verification, the cooldown doubles per lockout episode, and
// a correct pin clears the state. The tests hand-edit the record to expire a
// lockout because a same-user process can do exactly that — the counter is
// guidance, not a boundary.

function readRecord(): { pinMac: string; fails: number; lockedUntil: number } {
  return JSON.parse(readFileSync(approvalsPinPath(), 'utf8')) as {
    pinMac: string;
    fails: number;
    lockedUntil: number;
  };
}

function writeRecord(record: { pinMac: string; fails: number; lockedUntil: number }): void {
  writeFileSync(approvalsPinPath(), JSON.stringify(record), 'utf8');
}

test('the sixth cumulative wrong pin locks verification; even the correct pin refuses during the cooldown', () => {
  resetEnrollment();
  assert.equal(enrollApprovalsPin(PIN).ok, true);

  for (let attempt = 1; attempt <= 5; attempt++) {
    const result = verifyApprovalsPin(`wrong-pin-${attempt}`);
    assert.equal(result.ok, false);
    assert.match(result.reason ?? '', /does not match/, `attempt ${attempt}: unlocked failures say so`);
  }
  assert.equal(verifyApprovalsPin('wrong-pin-6').ok, false, 'the sixth failure also refuses');

  const record = readRecord();
  assert.equal(record.fails, 6, 'the counter is cumulative across invocations');
  assert.ok(record.lockedUntil > Date.now(), 'the sixth failure engaged the lockout');

  const during = verifyApprovalsPin(PIN);
  assert.equal(during.ok, false, 'even the correct pin refuses while locked');
  assert.match(during.reason ?? '', /locked|cooldown|retry/i, 'the refusal names the cooldown');
});

test('a correct pin below the threshold clears the counter; lockout episodes double up to the 24-hour cap', () => {
  resetEnrollment();
  assert.equal(enrollApprovalsPin(PIN).ok, true);

  for (let attempt = 0; attempt < 3; attempt++) verifyApprovalsPin('early-wrong');
  assert.equal(verifyApprovalsPin(PIN).ok, true, 'a correct pin below the threshold still verifies');
  assert.equal(readRecord().fails, 0, 'the correct pin reset the counter');
  assert.equal(readRecord().lockedUntil, 0, 'and the lockout state');

  // Episode 1: six cumulative failures lock for 5 minutes.
  for (let attempt = 0; attempt < 6; attempt++) verifyApprovalsPin('ep1-wrong');
  const firstLock = readRecord();
  const firstCooldown = firstLock.lockedUntil - Date.now();
  assert.ok(firstCooldown > 4 * 60_000 && firstCooldown <= 5 * 60_000, 'the first episode locks for 5 minutes');

  // Hand-expire the lockout (the record is same-user editable), then episode 2
  // doubles the cooldown.
  writeRecord({ ...firstLock, lockedUntil: Date.now() - 1 });
  for (let attempt = 0; attempt < 6; attempt++) verifyApprovalsPin('ep2-wrong');
  const secondLock = readRecord();
  const secondCooldown = secondLock.lockedUntil - Date.now();
  assert.ok(
    secondCooldown > 8 * 60_000 && secondCooldown <= 10 * 60_000,
    'the second episode doubles the cooldown to 10 minutes',
  );

  // The cap: a counter near a high multiple (hand-written by the same-user
  // editor) locks for at most 24 hours.
  writeRecord({ pinMac: secondLock.pinMac, fails: 6 * 20 - 1, lockedUntil: 0 });
  verifyApprovalsPin('cap-probe');
  const capped = readRecord();
  const cappedCooldown = capped.lockedUntil - Date.now();
  assert.ok(cappedCooldown <= 24 * 60 * 60_000, 'the cooldown caps at 24 hours');
  assert.ok(cappedCooldown > 23 * 60 * 60_000, 'and reaches the cap from below');

  // After expiry a correct pin clears everything again.
  writeRecord({ ...capped, lockedUntil: Date.now() - 1 });
  assert.equal(verifyApprovalsPin(PIN).ok, true, 'the correct pin verifies after the cooldown');
  assert.equal(readRecord().fails, 0, 'and clears the counter');
  assert.equal(readRecord().lockedUntil, 0);
});
