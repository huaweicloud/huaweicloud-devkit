import { createHmac, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { resolveVerificationMasterKey } from './approval-tokens.ts';
import { ensureMasterKey, type ResolvedMasterKey } from './secret-vault/custody.ts';
import { huaweiConfigBase } from './pack-state.ts';

// The approval PIN: the boundary credential the terminal confirm flow checks
// before recording a user confirmation (the confirm CLI owns the prompt and
// the TTY — this module is pure state + crypto, so it is independently
// testable). The vault's no-reveal doctrine applies in full: only a mac over
// the custody master key is ever persisted, and the plaintext pin is never
// stored or logged. Same-user file edits cannot forge a verifying record,
// because the mac key never leaves custody. Re-enrollment overwrites, which
// is the recovery path for a forgotten pin.

export interface ApprovalsPinResult {
  ok: boolean;
  reason?: string;
}

// The persisted record. `fails` is the cumulative wrong-PIN counter and
// `lockedUntil` the active cooldown deadline; both reset on a correct PIN
// and on (re-)enrollment.
interface PinRecord {
  pinMac: string;
  fails: number;
  lockedUntil: number;
}

// The pin mac's domain separator: distinct from the approval grant's, so
// custody-keyed material from one HMAC use never verifies in another.
const PIN_MAC_DOMAIN = 'huaweicloud-pin';

// The lockout ladder: every 6th cumulative failure locks verification for
// 5 minutes doubled per lockout episode, capped at 24 hours.
const LOCKOUT_BASE_MS = 5 * 60_000;
const LOCKOUT_CAP_MS = 24 * 60 * 60_000;

function lockoutDurationMs(fails: number): number {
  const episode = Math.floor(fails / 6);
  return Math.min(LOCKOUT_BASE_MS * 2 ** (episode - 1), LOCKOUT_CAP_MS);
}

export function approvalsPinPath(): string {
  return join(huaweiConfigBase(), 'approvals-pin.json');
}

// The record is untrusted input: anything malformed reads as absent, and
// absent reads as not enrolled — the fail-closed direction for every caller.
// A valid pinMac with malformed counters keeps the mac authority and reads
// the counters as zero: the counters are guidance, not a boundary.
function readPinRecord(): PinRecord | null {
  try {
    const path = approvalsPinPath();
    if (!existsSync(path)) return null;
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    const pinMac = record.pinMac;
    if (typeof pinMac !== 'string' || !/^[0-9a-f]{64}$/.test(pinMac)) return null;
    const fails =
      typeof record.fails === 'number' && Number.isFinite(record.fails) && record.fails >= 0 ? record.fails : 0;
    const lockedUntil =
      typeof record.lockedUntil === 'number' && Number.isFinite(record.lockedUntil) && record.lockedUntil >= 0
        ? record.lockedUntil
        : 0;
    return { pinMac, fails, lockedUntil };
  } catch {
    return null;
  }
}

// Atomic temp+rename write, the same discipline as the approvals store: a
// crash never leaves a torn record behind.
function writePinRecord(record: PinRecord): void {
  const path = approvalsPinPath();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(record), { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, path);
}

export function isApprovalsPinEnrolled(): boolean {
  return readPinRecord() !== null;
}

export function enrollApprovalsPin(pin: string): ApprovalsPinResult {
  if (typeof pin !== 'string' || pin.length < 6) {
    return { ok: false, reason: 'the approvals PIN must be at least 6 characters' };
  }
  let master: ResolvedMasterKey;
  try {
    // Mutating path, so bootstrap semantics match `secret set`: the first
    // enroll on a keyless machine creates the custody key.
    master = ensureMasterKey();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: `vault master key unavailable: ${message}` };
  }
  const pinMac = createHmac('sha256', master.key).update(`${PIN_MAC_DOMAIN}\x00${pin}`).digest('hex');
  try {
    // Enrollment resets the failure state: a fresh credential starts with a
    // clean counter (and re-enrollment is the recovery path for a forgotten
    // pin, which a stale lockout must not outlive).
    writePinRecord({ pinMac, fails: 0, lockedUntil: 0 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: `failed to persist the approvals PIN: ${message}` };
  }
  return { ok: true };
}

export function verifyApprovalsPin(pin: string): ApprovalsPinResult {
  const record = readPinRecord();
  if (!record) return { ok: false, reason: 'no approvals PIN is enrolled' };
  const now = Date.now();
  if (record.lockedUntil > now) {
    const minutes = Math.max(1, Math.ceil((record.lockedUntil - now) / 60_000));
    return {
      ok: false,
      reason: `too many incorrect attempts: the approvals PIN is locked, retry in ${minutes} minute(s)`,
    };
  }
  const master = resolveVerificationMasterKey();
  if ('failure' in master) return { ok: false, reason: master.failure };
  const expected = createHmac('sha256', master.key).update(`${PIN_MAC_DOMAIN}\x00${pin}`).digest('hex');
  const matches = timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(record.pinMac, 'hex'));
  if (matches) {
    if (record.fails !== 0 || record.lockedUntil !== 0) {
      try {
        writePinRecord({ pinMac: record.pinMac, fails: 0, lockedUntil: 0 });
      } catch {
        // The counter reset is guidance bookkeeping; its write failure must
        // not turn a correct PIN into a refusal.
      }
    }
    return { ok: true };
  }
  // The counter is guidance, not a boundary: a same-user process can edit
  // this record the same way it can edit approvals.json. It slows online
  // guessing across invocations; it cannot stop a writer that owns the file.
  const fails = record.fails + 1;
  const lockedUntil = fails % 6 === 0 ? now + lockoutDurationMs(fails) : record.lockedUntil;
  try {
    writePinRecord({ pinMac: record.pinMac, fails, lockedUntil });
  } catch {
    // Same guidance doctrine: the verdict is the mac comparison, not the
    // counter's persistence.
  }
  return { ok: false, reason: 'the approvals PIN does not match' };
}
