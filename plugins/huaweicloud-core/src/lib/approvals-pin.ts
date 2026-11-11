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

// The pin mac's domain separator: distinct from the approval grant's, so
// custody-keyed material from one HMAC use never verifies in another.
const PIN_MAC_DOMAIN = 'huaweicloud-pin';

export function approvalsPinPath(): string {
  return join(huaweiConfigBase(), 'approvals-pin.json');
}

// The record is untrusted input: anything malformed reads as absent, and
// absent reads as not enrolled — the fail-closed direction for every caller.
function readPinRecord(): { pinMac: string } | null {
  try {
    const path = approvalsPinPath();
    if (!existsSync(path)) return null;
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const pinMac = (parsed as Record<string, unknown>).pinMac;
    if (typeof pinMac !== 'string' || !/^[0-9a-f]{64}$/.test(pinMac)) return null;
    return { pinMac };
  } catch {
    return null;
  }
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
    const path = approvalsPinPath();
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ pinMac }), { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, path);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: `failed to persist the approvals PIN: ${message}` };
  }
  return { ok: true };
}

export function verifyApprovalsPin(pin: string): ApprovalsPinResult {
  const record = readPinRecord();
  if (!record) return { ok: false, reason: 'no approvals PIN is enrolled' };
  const master = resolveVerificationMasterKey();
  if ('failure' in master) return { ok: false, reason: master.failure };
  const expected = createHmac('sha256', master.key).update(`${PIN_MAC_DOMAIN}\x00${pin}`).digest('hex');
  const matches = timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(record.pinMac, 'hex'));
  return matches ? { ok: true } : { ok: false, reason: 'the approvals PIN does not match' };
}
