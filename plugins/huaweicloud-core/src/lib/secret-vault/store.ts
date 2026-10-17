import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { spawnSync } from 'node:child_process';

import { withDepLock } from '../../dep/receipts.ts';
import { clearCustodyCache, defaultSecretsRoot, ensureMasterKey, resolveMasterKey } from './custody.ts';
import {
  formatSecretRef,
  isValidNameSegment,
  isValidScopeSegment,
  parseSecretRef,
  VaultError,
  type SecretRef,
} from './refs.ts';

export { VaultError };

// The secret store: one JSON file per secret under
// <root>/<scope>/<name>.json, encrypted with the custody master key.
//
// Crypto: AES-256-GCM with the master key directly, a fresh random 12-byte
// IV per write, and the canonical ref string as AAD — swapping ciphertext
// between refs fails authentication. The master key is a high-entropy random
// value, so a KDF over it (scrypt etc.) adds no security and ~100ms of
// latency per read; the GCM construction is the whole contract. fingerprint
// = HMAC-SHA256(masterKey, value), first 16 hex chars, computed at set time
// and stored in the envelope so `list` never decrypts and an unkeyed hash of
// a low-entropy secret is never exposed (no offline guess-verification
// oracle, unlike reconcile.ts's display fingerprint).
//
// Concurrency: set/delete/bootstrap mutate and serialize on withDepLock
// (the dep receipts lock, dir-parameterized); get/list are pure reads of a
// whole file so the temp+rename swap makes them atomic without a lock. There
// is no lastUsed-on-read by design — a read that writes back would turn
// every get into a lost-update window against a concurrent rotation.
//
// Format: `format: 1`. Unknown format versions fail loud with an upgrade
// hint (npx runs the latest published package while the plugin payload pins
// a version; two devkit versions can share one store).

// spawnImpl exists only as the test seam for the custody tier (fake
// secret-tool / security / powershell); production callers omit it.
export interface StoreOptions {
  root?: string;
  spawnImpl?: typeof spawnSync;
}

export interface SecretRecord {
  format: number;
  version: number;
  created: string;
  updated: string;
  note: string;
  fingerprint: string;
  iv: string;
  tag: string;
  ciphertext: string;
}

export interface SecretMetadata {
  ref: string;
  scope: string;
  name: string;
  version: number;
  updated: string;
  note: string;
  fingerprint: string;
}

export interface SetResult {
  status: 'set' | 'unchanged';
  version: number;
  fingerprint: string;
}

const FORMAT_VERSION = 1;

function rootOf(options?: StoreOptions): string {
  return options?.root ?? defaultSecretsRoot();
}

function scopeDir(root: string, scope: string): string {
  return join(root, scope);
}

function secretFile(root: string, ref: SecretRef): string {
  return join(scopeDir(root, ref.scope), `${ref.name}.json`);
}

function fingerprintOf(masterKey: Buffer, value: string): string {
  return createHmac('sha256', masterKey).update(value, 'utf8').digest('hex').slice(0, 16);
}

function encrypt(
  masterKey: Buffer,
  ref: SecretRef,
  plaintext: string,
): { iv: string; tag: string; ciphertext: string } {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', masterKey, iv);
  cipher.setAAD(Buffer.from(formatSecretRef(ref), 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}

function decrypt(masterKey: Buffer, ref: SecretRef, record: SecretRecord): string {
  const decipher = createDecipheriv('aes-256-gcm', masterKey, Buffer.from(record.iv, 'base64'));
  decipher.setAAD(Buffer.from(formatSecretRef(ref), 'utf8'));
  decipher.setAuthTag(Buffer.from(record.tag, 'base64'));
  try {
    return Buffer.concat([decipher.update(Buffer.from(record.ciphertext, 'base64')), decipher.final()]).toString(
      'utf8',
    );
  } catch {
    throw new VaultError(
      'VAULT_DECRYPT_FAILED',
      `Decrypting ${formatSecretRef(ref)} failed: the master key does not match the one this secret was encrypted with (rotated custody tier?), or the file was tampered with. Version ${record.version}.`,
    );
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function readRecord(path: string): SecretRecord | null {
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    // A delete racing this read surfaces as ENOENT — that is a missing
    // secret, not corruption; the boundary error shape stays consistent.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new VaultError(
      'VAULT_RECORD_CORRUPT',
      `${path} is not valid JSON. Restore or delete it, then re-create the secret.`,
    );
  }
  const raw = asRecord(parsed);
  if (raw.format !== FORMAT_VERSION) {
    throw new VaultError(
      'VAULT_FORMAT_UNKNOWN',
      `${path} has store format ${String(raw.format)}; this devkit understands format ${FORMAT_VERSION}. Upgrade the devkit (npx huaweicloud-devkit@latest) and retry.`,
    );
  }
  const str = (key: string): string | null => (typeof raw[key] === 'string' ? raw[key] : null);
  const version =
    typeof raw.version === 'number' && Number.isSafeInteger(raw.version) && raw.version > 0 ? raw.version : null;
  // ciphertext is a presence check, NOT truthiness: encrypting '' yields an
  // empty string, and a truthiness check here would misread the record as
  // corrupt (bricking list/get/rotate for the whole vault). The other
  // fields are never empty in a record this store writes.
  const requiredNonEmpty = ['created', 'updated', 'fingerprint', 'iv', 'tag'];
  for (const key of requiredNonEmpty) {
    if (!str(key)) {
      throw new VaultError(
        'VAULT_RECORD_CORRUPT',
        `${path} is missing the ${key} field. Restore or delete it, then re-create the secret.`,
      );
    }
  }
  if (str('ciphertext') === null) {
    throw new VaultError(
      'VAULT_RECORD_CORRUPT',
      `${path} is missing the ciphertext field. Restore or delete it, then re-create the secret.`,
    );
  }
  if (version === null) {
    throw new VaultError(
      'VAULT_RECORD_CORRUPT',
      `${path} has an invalid version field. Restore or delete it, then re-create the secret.`,
    );
  }
  return {
    format: FORMAT_VERSION,
    version,
    created: str('created')!,
    updated: str('updated')!,
    note: str('note') || '',
    fingerprint: str('fingerprint')!,
    iv: str('iv')!,
    tag: str('tag')!,
    ciphertext: str('ciphertext')!,
  };
}

function writeRecord(root: string, ref: SecretRef, record: SecretRecord): void {
  const dir = scopeDir(root, ref.scope);
  mkdirSync(dir, { recursive: true });
  const file = secretFile(root, ref);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(record, null, 2), { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, file);
}

function masterKeyForRead(options: StoreOptions): Buffer {
  const resolved = resolveMasterKey(options);
  if (!resolved) {
    throw new VaultError(
      'VAULT_NOT_INITIALIZED',
      'The secret vault has no master key. Create one by storing the first secret (npx huaweicloud-devkit secret set secret://<scope>/<name> --file <path>) or set HW_VAULT_MASTER_KEY.',
    );
  }
  return resolved.key;
}

export function vaultSet(refInput: string, plaintext: string, note?: string, options?: StoreOptions): SetResult {
  const ref = parseSecretRef(refInput);
  if (!ref)
    throw new VaultError(
      'VAULT_BAD_REF',
      `"${refInput}" is not a valid secret ref (secret://<scope>/<name>, segments [a-z0-9-]).`,
    );
  // The shared boundary for both faces (CLI and MCP): an empty plaintext is
  // far more likely a botched delivery than a deliberate value, and storing
  // it would silently destroy the previous secret. The message stays
  // channel-agnostic — the CLI and MCP faces name their own channels.
  if (plaintext === '') {
    throw new VaultError(
      'VAULT_EMPTY_SECRET',
      `refusing to store an empty secret for ${refInput} — the delivered value was empty; check the delivery channel (a trailing newline is stripped).`,
    );
  }
  const root = rootOf(options);
  const master = ensureMasterKey(options);
  return withDepLock(() => {
    const now = new Date().toISOString();
    const existing = readRecord(secretFile(root, ref));
    const fingerprint = fingerprintOf(master.key, plaintext);
    if (existing && existing.fingerprint === fingerprint) {
      return { status: 'unchanged', version: existing.version, fingerprint };
    }
    // Overwrite guard: an existing record that does not DECRYPT under the
    // current master key means the key changed since it was written (stray
    // HW_VAULT_MASTER_KEY, recovered-but-different keychain). Overwriting
    // would destroy the last copy under the original key — there is no
    // version history. The custody bootstrap already refuses to mint a key
    // over records; this closes the different-but-resolvable-key shape.
    if (existing) {
      try {
        decrypt(master.key, ref, existing);
      } catch {
        throw new VaultError(
          'VAULT_MASTER_KEY_MISMATCH',
          `The existing record for ${refInput} does not decrypt under the current master key; refusing to overwrite (that would destroy the previous value). Restore the original key, or run "npx huaweicloud-devkit secret rm ${refInput}" first if the old value is truly gone.`,
        );
      }
    }
    const encrypted = encrypt(master.key, ref, plaintext);
    const record: SecretRecord = {
      format: FORMAT_VERSION,
      version: (existing?.version ?? 0) + 1,
      created: existing?.created ?? now,
      updated: now,
      note: note ?? existing?.note ?? '',
      fingerprint,
      ...encrypted,
    };
    writeRecord(root, ref, record);
    return { status: 'set', version: record.version, fingerprint };
  }, root);
}

export interface SecretValue {
  value: string;
  version: number;
  note: string;
}

export function vaultGet(refInput: string, options?: StoreOptions): SecretValue {
  const ref = parseSecretRef(refInput);
  if (!ref)
    throw new VaultError(
      'VAULT_BAD_REF',
      `"${refInput}" is not a valid secret ref (secret://<scope>/<name>, segments [a-z0-9-]).`,
    );
  const root = rootOf(options);
  const masterKey = masterKeyForRead(options ?? {});
  const record = readRecord(secretFile(root, ref));
  if (!record) {
    throw new VaultError(
      'VAULT_REF_NOT_FOUND',
      `${formatSecretRef(ref)} is not stored in the vault. Store it first: npx huaweicloud-devkit secret set ${formatSecretRef(ref)} --file <path>.`,
    );
  }
  return { value: decrypt(masterKey, ref, record), version: record.version, note: record.note };
}

export function vaultDelete(refInput: string, options?: StoreOptions): { removed: number } {
  const ref = parseSecretRef(refInput);
  if (!ref)
    throw new VaultError(
      'VAULT_BAD_REF',
      `"${refInput}" is not a valid secret ref (secret://<scope>/<name>, segments [a-z0-9-]).`,
    );
  const root = rootOf(options);
  return withDepLock(() => {
    const file = secretFile(root, ref);
    if (!existsSync(file)) return { removed: 0 };
    rmSync(file, { force: true });
    return { removed: 1 };
  }, root);
}

export function vaultList(scope?: string, options?: StoreOptions): SecretMetadata[] {
  const root = rootOf(options);
  if (scope !== undefined && !isValidScopeSegment(scope)) {
    throw new VaultError('VAULT_BAD_SCOPE', `"${String(scope)}" is not a valid scope (segments [a-z0-9-]).`);
  }
  const scopes: string[] = [];
  if (scope === undefined) {
    if (!existsSync(root)) return [];
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (isValidScopeSegment(entry.name)) scopes.push(entry.name);
    }
    scopes.sort((a, b) => a.localeCompare(b));
  } else {
    scopes.push(scope);
  }
  const out: SecretMetadata[] = [];
  for (const scopeName of scopes) {
    const dir = scopeDir(root, scopeName);
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir).sort((a, b) => a.localeCompare(b))) {
      if (!entry.endsWith('.json') || !isValidNameSegment(entry.slice(0, -'.json'.length))) continue;
      const name = entry.slice(0, -'.json'.length);
      const record = readRecord(join(dir, entry));
      if (!record) continue;
      out.push({
        ref: `secret://${scopeName}/${name}`,
        scope: scopeName,
        name,
        version: record.version,
        updated: record.updated,
        note: record.note,
        fingerprint: record.fingerprint,
      });
    }
  }
  return out;
}

// Resolve a value that may be a secret ref; plain strings pass through.
// The seam every credential consumer goes through so no raw `secret://`
// string propagates into KooCLI/OBS config or fingerprints.
export function resolveSecretValue(value: string | undefined, options?: StoreOptions): string | undefined {
  if (value === undefined) return undefined;
  const ref = parseSecretRef(value);
  if (!ref) return value;
  return vaultGet(formatSecretRef(ref), options).value;
}

export { clearCustodyCache };
