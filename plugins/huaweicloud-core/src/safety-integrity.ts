import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// The deployed-payload integrity receipt (the integrity unit's layer 3):
// install/update records a hash manifest of the CLASSIFIER files the
// in-process gates import — the same artifacts the layer-1 path gate
// protects and the layer-2 canaries behavior-check. Doctor compares the
// current hashes against the receipt: drift (an agent-side rewrite the
// path gate missed, a half-landed overwrite) FAILs with the reinstall
// remediation; a payload placed by an older devkit (no receipt yet) WARNs
// instead — backward compatibility, never a false red.
//
// Scope is the classifier chain, not the whole payload: dist/safety-policy.js
// plus its dist/safety/ import graph (the JS classifier the adapter and the
// .mjs hook load), safety/policy.json (the vocabulary both faces read), and
// safety/rules/ (the risk catalog). skills/ and node_modules/ are outside
// it — they have their own freshness/equality probes, and hashing them
// would make the receipt churn on every skill edit.
//
// A receipt-style marker beside the `.installed` precedent: written by the
// one shared placement seam (copyServerPayload), owned by the devkit,
// removed with the plugin dir on uninstall. Unlike `.installed` it
// persists across server boots (the server deletes the restart marker at
// boot; the receipt must survive for doctor to read).

export const INTEGRITY_RECEIPT_FILE = '.safety-integrity.json';

export interface IntegrityReceipt {
  version: 1;
  files: Record<string, string>;
}

export type IntegrityStatus =
  | { status: 'no-payload' }
  | { status: 'no-receipt' }
  | { status: 'match' }
  | { status: 'mismatch'; drifted: string[]; missing: string[]; unrecorded: string[] };

function sha256Of(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

// The classifier artifacts present under a deployed payload dir, as sorted
// relative paths. Absent entries (a skipDist payload ships safety/ without
// dist/) simply stay out of the scope — the receipt records what shipped.
// The receipt's keys are wire vocabulary (pinned deep-equal in the tests and
// spelled forward-slash in policy docs), so the platform separator is
// normalized to posix: join()/readdirSync() produce '\' segments on win32
// and a raw slice would ship platform-dependent receipt keys.
export function integrityScopeFiles(dir: string): string[] {
  const rel: string[] = [];
  const push = (path: string) => {
    if (existsSync(join(dir, path))) rel.push(path);
  };
  push('dist/safety-policy.js');
  for (const file of filesUnder(join(dir, 'dist', 'safety'))) {
    rel.push(file.slice(dir.length + 1).replaceAll('\\', '/'));
  }
  push('safety/policy.json');
  for (const file of filesUnder(join(dir, 'safety', 'rules'))) {
    rel.push(file.slice(dir.length + 1).replaceAll('\\', '/'));
  }
  return rel.sort((a, b) => a.localeCompare(b));
}

export function integrityReceiptPath(dir: string): string {
  return join(dir, INTEGRITY_RECEIPT_FILE);
}

// Written at placement time over what actually landed (the verified-copy
// seam guarantees the bytes; hashing the DEST is the honest record).
export function writeIntegrityReceipt(dir: string): void {
  const files: Record<string, string> = {};
  for (const rel of integrityScopeFiles(dir)) files[rel] = sha256Of(join(dir, rel));
  const receipt: IntegrityReceipt = { version: 1, files };
  writeFileSync(integrityReceiptPath(dir), `${JSON.stringify(receipt, null, 2)}\n`);
}

// The doctor-side comparison. A receipt entry whose file changed or vanished
// drifts; a scope file present on disk but absent from the receipt drifts
// too — no legit path lands classifier files without rewriting the receipt
// (every install/update writes it), so an unrecorded classifier file is the
// dropped-in-later tamper shape.
export function verifyIntegrity(dir: string): IntegrityStatus {
  const receiptFile = integrityReceiptPath(dir);
  const scope = integrityScopeFiles(dir);
  if (scope.length === 0) return { status: 'no-payload' };
  if (!existsSync(receiptFile)) return { status: 'no-receipt' };
  let receipt: IntegrityReceipt;
  try {
    receipt = JSON.parse(readFileSync(receiptFile, 'utf8')) as IntegrityReceipt;
  } catch {
    return { status: 'no-receipt' };
  }
  if (
    receipt === null ||
    typeof receipt !== 'object' ||
    receipt.version !== 1 ||
    receipt.files === null ||
    typeof receipt.files !== 'object'
  ) {
    return { status: 'no-receipt' };
  }
  const recorded = new Set(Object.keys(receipt.files));
  const drifted: string[] = [];
  const missing: string[] = [];
  for (const rel of scope) {
    if (!recorded.has(rel)) continue; // counted as unrecorded below
    const expected = receipt.files[rel];
    if (typeof expected !== 'string' || sha256Of(join(dir, rel)) !== expected) drifted.push(rel);
  }
  for (const rel of Object.keys(receipt.files)) {
    if (!existsSync(join(dir, rel))) missing.push(rel);
  }
  const unrecorded = scope.filter((rel) => !recorded.has(rel));
  if (drifted.length > 0 || missing.length > 0 || unrecorded.length > 0) {
    return { status: 'mismatch', drifted, missing, unrecorded };
  }
  return { status: 'match' };
}
