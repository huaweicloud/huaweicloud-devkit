import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';

import { withDepLock } from '../../dep/receipts.ts';
import { VaultError } from './refs.ts';

// Master-key custody for the secret vault. One 32-byte key encrypts every
// secret (AES-256-GCM, per-write random IV, ref as AAD — see store.ts); this
// module decides where that key lives, in preference order:
//
//   1. env HW_VAULT_MASTER_KEY  — CI/devbox; must be base64 or hex of exactly
//      32 bytes. Strict on purpose: silently normalizing an arbitrary string
//      would let a "same" env value derive a DIFFERENT key than the one the
//      keychain holds, and every secret encrypted under it becomes
//      undecryptable. Fail loud at the boundary instead.
//   2. OS keychain (macOS Keychain / Linux Secret Service / Windows
//      PasswordVault) under service `huaweicloud-devkit`, account
//      `vault-master`. Stores never put the key in argv (ps-visible); writes
//      go through stdin, reads come back on captured stdout.
//   3. keyfile `<root>/.master-key` (0600) — the headless fallback, created
//      with an explicit downgrade warning.
//
// Read-time semantics: the first tier that EXISTS wins; a tier that exists
// but errors (locked keychain, "user interaction not allowed") fails loud —
// it never silently falls through to a different key, because two live keys
// is exactly the divergence that orphans ciphertext. Bootstrap (creating the
// key the first time) serializes on the same lock the store uses, writes via
// temp+rename, and verifies by reading back; a bootstrap race converges by
// adopting the winner's key.
//
// Resolution is sync with a per-root process cache: the hot path
// (resolveCredentials → vaultGet) must not spawn a keychain helper per call.

export type CustodyTier = 'env' | 'keychain' | 'keyfile';

export interface ResolvedMasterKey {
  key: Buffer;
  tier: CustodyTier;
}

export interface CustodyOptions {
  root?: string;
  spawnImpl?: typeof spawnSync;
}

// Extends VaultError (the shared base in refs.ts) so every consumer that
// distinguishes vault failures from "not configured" — the sandbox
// credentials tool, status surfaces — sees custody-tier failures (locked
// keychain, corrupt keyfile) in the same catch.
export class VaultCustodyError extends VaultError {
  constructor(code: string, message: string) {
    super(code, message);
  }
}

const KEYCHAIN_SERVICE = 'huaweicloud-devkit';
const KEYCHAIN_ACCOUNT = 'vault-master';
const SPAWN_TIMEOUT_MS = 10_000;

export function defaultSecretsRoot(): string {
  return join(process.env.HUAWEICLOUD_HOME || homedir(), '.config', 'huaweicloud', 'secrets');
}

function rootOf(options?: CustodyOptions): string {
  return options?.root ?? defaultSecretsRoot();
}

function spawnerOf(options?: CustodyOptions): typeof spawnSync {
  return options?.spawnImpl ?? spawnSync;
}

function keyfilePath(root: string): string {
  return join(root, '.master-key');
}

// env tier: strict base64/hex of exactly 32 bytes.
function masterKeyFromEnv(): Buffer | null {
  const raw = process.env.HW_VAULT_MASTER_KEY;
  if (!raw || !raw.trim()) return null;
  const value = raw.trim();
  let decoded: Buffer | null;
  if (/^[0-9a-fA-F]{64}$/.test(value)) {
    decoded = Buffer.from(value, 'hex');
  } else {
    try {
      decoded = Buffer.from(value, 'base64');
    } catch {
      decoded = null;
    }
  }
  if (!decoded || decoded.length !== 32) {
    throw new VaultCustodyError(
      'HW_VAULT_MASTER_KEY_INVALID',
      'HW_VAULT_MASTER_KEY must be base64 or hex encoding exactly 32 bytes (e.g. `openssl rand -base64 32`).',
    );
  }
  return decoded;
}

interface ToolRun {
  ok: boolean;
  /** The child's exit status; null when the spawn itself failed or timed out. */
  status: number | null;
  stdout: string;
  stderr: string;
}

function runTool(spawn: typeof spawnSync, command: string, args: string[], input?: string): ToolRun | null {
  let result;
  try {
    result = spawn(command, args, {
      input: input === undefined ? undefined : Buffer.from(input, 'utf8'),
      timeout: SPAWN_TIMEOUT_MS,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf8',
    });
  } catch {
    return null;
  }
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    return { ok: false, status: result.status ?? null, stdout: '', stderr: String(result.error) };
  }
  return {
    ok: result.status === 0,
    status: result.status ?? null,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || ''),
  };
}

function decodeMasterKeyB64(text: string): Buffer | null {
  const value = text.trim();
  if (!value) return null;
  try {
    const decoded = Buffer.from(value, 'base64');
    return decoded.length === 32 ? decoded : null;
  } catch {
    return null;
  }
}

// macOS Keychain. Reads: `security find-generic-password -w` prints the
// password to stdout (argv carries only service/account, never the key).
// Writes: `security -i` reads the command from stdin so the key never lands
// in argv. A locked keychain fails ("user interaction is not allowed")
// instead of prompting — this process is a non-TTY agent child.
function macosRead(spawn: typeof spawnSync): { status: 'absent' | 'key' | 'error'; key?: Buffer; error?: string } {
  const run = runTool(spawn, '/usr/bin/security', [
    'find-generic-password',
    '-s',
    KEYCHAIN_SERVICE,
    '-a',
    KEYCHAIN_ACCOUNT,
    '-w',
  ]);
  if (run === null) return { status: 'absent' };
  if (!run.ok) {
    if (/could not be found|SecKeychainSearch|item not found/i.test(run.stderr)) return { status: 'absent' };
    return { status: 'error', error: run.stderr.trim().slice(0, 200) };
  }
  const key = decodeMasterKeyB64(run.stdout);
  if (!key) return { status: 'error', error: 'keychain item did not decode to a 32-byte key' };
  return { status: 'key', key };
}

function macosWrite(spawn: typeof spawnSync, key: Buffer): { status: 'written' | 'error'; error?: string } {
  const script = `add-generic-password -s ${KEYCHAIN_SERVICE} -a ${KEYCHAIN_ACCOUNT} -w ${key.toString('base64')}\n`;
  const run = runTool(spawn, '/usr/bin/security', ['-i'], script);
  if (run === null) return { status: 'error', error: '/usr/bin/security not available' };
  if (!run.ok) return { status: 'error', error: run.stderr.trim().slice(0, 200) };
  return { status: 'written' };
}

// Linux Secret Service via secret-tool: `lookup` prints the secret to
// stdout; `store` reads it from stdin. Attributes only in argv. A silent
// non-zero exit is the documented not-found shape; stderr output means the
// backend itself failed (no D-Bus session, locked keyring, daemon down) —
// that is an error, never an absent tier, or a transient outage during
// `secret set` would bootstrap a second master key and orphan the vault.
function linuxRead(spawn: typeof spawnSync): { status: 'absent' | 'key' | 'error'; key?: Buffer; error?: string } {
  const run = runTool(spawn, 'secret-tool', ['lookup', 'service', KEYCHAIN_SERVICE, 'account', KEYCHAIN_ACCOUNT]);
  if (run === null) return { status: 'absent' };
  if (!run.ok) {
    if (run.status !== null && !run.stderr.trim()) return { status: 'absent' };
    return {
      status: 'error',
      error: `${run.stderr.trim().slice(0, 200) || 'secret-tool lookup failed with no exit status'} (if the Secret Service is permanently unavailable — e.g. headless without a keyring daemon — set HW_VAULT_MASTER_KEY or ensure secret-tool is not on PATH so the keyfile tier is used)`,
    };
  }
  const key = decodeMasterKeyB64(run.stdout);
  if (!key) return { status: 'error', error: 'secret-service item did not decode to a 32-byte key' };
  return { status: 'key', key };
}

function linuxWrite(spawn: typeof spawnSync, key: Buffer): { status: 'written' | 'error'; error?: string } {
  const run = runTool(
    spawn,
    'secret-tool',
    ['store', '--label=huaweicloud-devkit vault master key', 'service', KEYCHAIN_SERVICE, 'account', KEYCHAIN_ACCOUNT],
    key.toString('base64'),
  );
  if (run === null) return { status: 'error', error: 'secret-tool not available' };
  if (!run.ok) return { status: 'error', error: run.stderr.trim().slice(0, 200) };
  return { status: 'written' };
}

// Windows PasswordVault via PowerShell reading the script from stdin
// (-Command -). -NonInteractive so a prompt fails instead of hanging. The
// script separates not-found (exit 3, the vault answered and has no item)
// from real failures (exit 2): a failing vault tier must be an error, never
// an absent tier, or a transient outage would fork the master key.
function windowsRead(spawn: typeof spawnSync): { status: 'absent' | 'key' | 'error'; key?: Buffer; error?: string } {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    'try {',
    '  $vault = [Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime]::new()',
    `  $match = $vault.RetrieveAll() | Where-Object { $_.Resource -eq '${KEYCHAIN_SERVICE}' -and $_.UserName -eq '${KEYCHAIN_ACCOUNT}' } | Select-Object -First 1`,
    '  if (-not $match) { exit 3 }',
    '  Write-Output $match.Password',
    '} catch {',
    '  exit 2',
    '}',
  ].join('\n');
  const run = runTool(spawn, 'powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '-'], script);
  if (run === null) return { status: 'absent' };
  if (run.status === 3) return { status: 'absent' };
  if (!run.ok) {
    return {
      status: 'error',
      error: run.stderr.trim().slice(0, 200) || `PasswordVault read failed (exit ${String(run.status)})`,
    };
  }
  const key = decodeMasterKeyB64(run.stdout);
  if (!key) return { status: 'error', error: 'PasswordVault item did not decode to a 32-byte key' };
  return { status: 'key', key };
}

function windowsWrite(spawn: typeof spawnSync, key: Buffer): { status: 'written' | 'error'; error?: string } {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    'try {',
    '  $vault = [Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime]::new()',
    `  $pass = ConvertTo-SecureString -String '${key.toString('base64')}' -AsPlainText -Force`,
    `  $cred = [Windows.Security.Credentials.PasswordCredential]::new('${KEYCHAIN_SERVICE}', '${KEYCHAIN_ACCOUNT}', $pass)`,
    '  $vault.Add($cred)',
    '} catch {',
    '  exit 2',
    '}',
  ].join('\n');
  const run = runTool(spawn, 'powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '-'], script);
  if (run === null) return { status: 'error', error: 'powershell.exe not available' };
  if (!run.ok) return { status: 'error', error: run.stderr.trim().slice(0, 200) };
  return { status: 'written' };
}

type KeychainResult = { status: 'absent' | 'key' | 'error'; key?: Buffer; error?: string };

function keychainRead(spawn: typeof spawnSync): KeychainResult {
  switch (process.platform) {
    case 'darwin':
      return macosRead(spawn);
    case 'win32':
      return windowsRead(spawn);
    default:
      return linuxRead(spawn);
  }
}

function keychainWrite(spawn: typeof spawnSync, key: Buffer): { status: 'written' | 'error'; error?: string } {
  switch (process.platform) {
    case 'darwin':
      return macosWrite(spawn, key);
    case 'win32':
      return windowsWrite(spawn, key);
    default:
      return linuxWrite(spawn, key);
  }
}

function keychainTierName(): string {
  switch (process.platform) {
    case 'darwin':
      return 'macOS Keychain';
    case 'win32':
      return 'Windows PasswordVault';
    default:
      return 'Secret Service (secret-tool)';
  }
}

function readKeyfile(root: string): Buffer | null {
  const file = keyfilePath(root);
  if (!existsSync(file)) return null;
  const key = decodeMasterKeyB64(readFileSync(file, 'utf8'));
  if (!key) {
    throw new VaultCustodyError(
      'VAULT_KEYFILE_CORRUPT',
      `The vault master keyfile ${file} is corrupt (expected base64 of 32 bytes). Restore it from backup, or delete the vault directory and re-create secrets.`,
    );
  }
  return key;
}

const cache = new Map<string, ResolvedMasterKey>();

export function clearCustodyCache(root?: string): void {
  if (root === undefined) cache.clear();
  else cache.delete(root);
}

export function resolveMasterKey(options?: CustodyOptions): ResolvedMasterKey | null {
  const root = rootOf(options);
  const hit = cache.get(root);
  if (hit) return hit;

  const envKey = masterKeyFromEnv();
  if (envKey) {
    const resolved = { key: envKey, tier: 'env' as const };
    cache.set(root, resolved);
    return resolved;
  }

  const keychain = keychainRead(spawnerOf(options));
  if (keychain.status === 'key') {
    const resolved = { key: keychain.key!, tier: 'keychain' as const };
    cache.set(root, resolved);
    return resolved;
  }
  if (keychain.status === 'error') {
    throw new VaultCustodyError(
      'VAULT_CUSTODY_READ_FAILED',
      `The ${keychainTierName()} holds the vault master key but reading it failed: ${keychain.error}. Unlock the keychain and retry; refusing to fall back to a different key because that would orphan every secret encrypted under this one.`,
    );
  }

  const fileKey = readKeyfile(root);
  if (fileKey) {
    const resolved = { key: fileKey, tier: 'keyfile' as const };
    cache.set(root, resolved);
    return resolved;
  }
  return null;
}

function writeKeyfile(root: string, key: Buffer): void {
  mkdirSync(root, { recursive: true });
  const file = keyfilePath(root);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, key.toString('base64'), { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, file);
  const readBack = decodeMasterKeyB64(readFileSync(file, 'utf8'));
  if (!readBack || !readBack.equals(key)) {
    throw new VaultCustodyError(
      'VAULT_KEYFILE_VERIFY_FAILED',
      `The master keyfile ${file} did not verify after write.`,
    );
  }
}

// First-use bootstrap: create the master key under the store's lock so two
// processes first-touching the vault converge on ONE key. The losing racer
// adopts the winner's key (re-read after write), so no ciphertext orphans.
// Called by the mutating paths (set); the read path never bootstraps —
// reading a vault with no key anywhere is a loud "not initialized".
// Whether any secret record exists under the store root — the orphaning
// question the bootstrap escape hatch turns on. Kept local (not imported
// from store.ts) so custody stays the layer store depends on, not vice
// versa.
function storeHasRecords(root: string): boolean {
  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (readdirSync(join(root, entry.name)).some((file) => file.endsWith('.json'))) return true;
    }
  } catch {
    // Absent or unreadable root: no records to protect.
  }
  return false;
}

export function ensureMasterKey(options?: CustodyOptions): ResolvedMasterKey {
  const root = rootOf(options);
  // The entry read may legitimately throw (keychain tier exists but is
  // failing); the locked section below re-reads and decides — the
  // fresh-vault escape hatch and the records check both live there.
  try {
    const existing = resolveMasterKey(options);
    if (existing) return existing;
  } catch {
    // fall through to the locked bootstrap path
  }

  const spawn = spawnerOf(options);
  return withDepLock(() => {
    // The in-lock re-read decides between three outcomes: a racing writer
    // already placed a key (adopt it), a failing-but-present keychain tier
    // (the records check below decides loud-failure vs fresh-vault
    // fallback), or nothing at all (bootstrap).
    let raced: ResolvedMasterKey | null = null;
    let readFailure: string | null = null;
    let readFailureError: unknown = null;
    try {
      raced = resolveMasterKey(options);
    } catch (error) {
      readFailureError = error;
      readFailure = error instanceof Error ? error.message : String(error);
    }
    if (raced) return raced;

    // A keychain tier that exists but cannot be READ fails loud — EXCEPT
    // when the store holds no records yet. Nothing can be orphaned by a
    // fresh key, and secret-tool-on-PATH-without-a-daemon is a common
    // headless-server shape that would otherwise dead-end the very first
    // `secret set`.
    if (readFailure !== null && storeHasRecords(root)) {
      // Preserve the typed error (VAULT_KEYFILE_CORRUPT etc.) so callers
      // keying remediation off the code see the right guidance.
      if (readFailureError instanceof VaultCustodyError) throw readFailureError;
      throw new VaultCustodyError('VAULT_CUSTODY_READ_FAILED', readFailure);
    }
    // No key resolvable at all (keychain entry deleted, keyfile lost, env
    // tier removed) WITH records on disk is a LOST key: minting a fresh one
    // would re-key the next write and orphan every other record. The only
    // recovery is restoring the key or deleting the vault directory.
    if (readFailure === null && storeHasRecords(root)) {
      throw new VaultCustodyError(
        'VAULT_MASTER_KEY_LOST',
        `The vault holds secrets under ${root} but no master key can be resolved (keychain entry gone, keyfile deleted, or HW_VAULT_MASTER_KEY unset). Refusing to mint a new key — it would orphan every stored secret. Restore the original key, or delete ${root} and re-create the secrets.`,
      );
    }
    if (readFailure !== null) {
      console.error(
        `\x1b[33m[WARN]\x1b[0m No existing secrets to protect, falling back to the keyfile tier despite the keychain read failure: ${readFailure}`,
      );
    }

    const key = randomBytes(32);
    const keychain = keychainWrite(spawn, key);
    if (keychain.status === 'written') {
      const confirmed = keychainRead(spawn);
      if (confirmed.status === 'key') {
        const resolved: ResolvedMasterKey = { key: confirmed.key!, tier: 'keychain' };
        cache.set(root, resolved);
        return resolved;
      }
      // Lost the bootstrap race or the write did not stick: fall through to
      // the keyfile tier with the SAME key only when nothing else exists.
    }
    writeKeyfile(root, key);
    console.error(
      `\x1b[33m[WARN]\x1b[0m Vault master key stored in a plaintext keyfile (${keyfilePath(root)}, 0600) — no OS keychain was usable (${keychainTierName()}: ${keychain.status === 'error' ? keychain.error : 'unavailable'}). Same-user processes can read it; the secrets themselves remain encrypted.`,
    );
    const resolved: ResolvedMasterKey = { key, tier: 'keyfile' };
    cache.set(root, resolved);
    return resolved;
  }, root);
}

export function custodyReport(options?: CustodyOptions): { initialized: boolean; tier: CustodyTier | null } {
  const resolved = resolveMasterKey(options);
  return { initialized: resolved !== null, tier: resolved?.tier ?? null };
}
