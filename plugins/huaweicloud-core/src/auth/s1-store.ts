// The S1 credential store, extracted from the credentials monolith (the
// stable src/auth/credentials.ts face re-exports this family): the JSON
// vault on disk (~/.config/huaweicloud/credentials.json), its secret-ref
// resolution seam, the last-sync sidecar, and the backup/restore pair.
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { asText } from '../lib/as-text.ts';
import { devkitStateBase, huaweiConfigBase } from '../lib/pack-state.ts';
import { resolveSecretValue } from '../lib/secret-vault/store.ts';

// The credential vault is JSON on disk shaped like this. Fields stay `unknown`
// until a typeof/Array.isArray guard surfaces a string, because the file (and
// platform-injected JSON) is untrusted input.
export interface StoredCredentials {
  ak?: unknown;
  sk?: unknown;
  securityToken?: unknown;
  region?: unknown;
  endpoint?: unknown;
  configuredBySession?: unknown;
}

export interface LastSyncRecord {
  ts?: unknown;
  kooCliProfile?: unknown;
  s1Fingerprint?: unknown;
}

// Verify a credential file ended up with 0600. On Windows-mounted drives inside WSL
// (drvfs/9p) chmod is silently ignored, so the file can be world-readable (0777).
// Native Windows has no POSIX modes (statSync always reports 0666), so skip the check there.
//
// Family-internal export (the OBS config writer folds the same verification);
// not part of the face's public surface.
export function ensurePrivateMode(path: string): void {
  if (process.platform === 'win32') return;
  try {
    chmodSync(path, 0o600);
  } catch {
    // best-effort chmod; the statSync check below warns when the mode did not stick
  }
  try {
    const mode = statSync(path).mode & 0o777;
    if (mode !== 0o600) {
      console.warn(
        `\x1b[33m[WARN]\x1b[0m Could not set 0600 on ${path} (current mode ${mode.toString(8)}). Credentials may be readable by other users.`,
      );
      console.warn(`\x1b[33m       If running under WSL, move the credential home to the Linux filesystem:\x1b[0m`);
      console.warn(`\x1b[33m         export HUAWEICLOUD_HOME=$HOME  (then re-run auth init)\x1b[0m`);
      console.warn(
        `\x1b[33m       Or skip file storage entirely with HW_ACCESS_KEY/HW_SECRET_KEY environment variables.\x1b[0m`,
      );
    }
  } catch {
    // best-effort: if even stat fails there is no mode left to verify or warn about
  }
}

export function globalCredentialsPath(): string {
  return join(devkitStateBase(), 'credentials.json');
}

// The historical read location. On a read-only-home fallback the config tree
// may still carry a pre-provisioned credentials.json; reads prefer the
// writable state tree but fall back here so those credentials keep working.
function legacyGlobalCredentialsPath(): string {
  return join(huaweiConfigBase(), 'credentials.json');
}

function readJsonObject(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function readGlobalCredentials(): StoredCredentials | null {
  const primary = globalCredentialsPath();
  const stored = readJsonObject(primary);
  if (stored) return stored;
  if (!existsSync(primary)) {
    const legacy = legacyGlobalCredentialsPath();
    if (legacy !== primary) return readJsonObject(legacy);
  }
  return null;
}

// S1 may hold secret://<scope>/<name> refs in its secret-bearing fields (the
// vault is the at-rest-encrypted alternative to plaintext AK/SK). This is the
// one seam every S1 value CONSUMER goes through: refs resolve to plaintext,
// plain strings pass through, and an unresolvable ref throws — a broken vault
// link in the credential chain is a loud failure, never a silent fallthrough
// to env or another store (that would resurrect exactly the drift the
// resolver priority chain exists to prevent). Preserving callers (the
// read-modify-write in setConfiguredBySession, backup/restore) keep the raw
// readGlobalCredentials so refs survive on disk instead of being replaced by
// resolved plaintext.
export function resolveStoredRefs(stored: StoredCredentials | null): StoredCredentials | null {
  if (!stored) return null;
  const resolveField = (value: unknown): unknown =>
    typeof value === 'string' && value ? resolveSecretValue(value) : value;
  return {
    ...stored,
    ak: resolveField(stored.ak),
    sk: resolveField(stored.sk),
    securityToken: resolveField(stored.securityToken),
  };
}

export function readGlobalCredentialsResolved(): StoredCredentials | null {
  return resolveStoredRefs(readGlobalCredentials());
}

export type StrictS1Read =
  | { ok: true; credentials: StoredCredentials | null }
  | { ok: false; credentials: null; error: string; nextStep: string };

// The strict read every PROPAGATING S1 consumer folds: refs resolve, and an
// unresolvable ref returns one loud error with remediation at the seam
// itself. Per-call-site copies of this block are what let a fourth consumer
// (auth reconcile) escape the seam with the raw read — the fold is the seam.
export function readGlobalCredentialsStrict(): StrictS1Read {
  try {
    return { ok: true, credentials: readGlobalCredentialsResolved() };
  } catch (error) {
    return {
      ok: false,
      credentials: null,
      error: `S1 holds a secret ref the vault cannot resolve: ${error instanceof Error ? error.message : String(error)}`,
      nextStep:
        'Fix the vault (npx huaweicloud-devkit secret list; check the master key) or replace the refs in ~/.config/huaweicloud/credentials.json with plaintext.',
    };
  }
}

export interface WriteGlobalCredentialsInput {
  ak?: unknown;
  sk?: unknown;
  securityToken?: unknown;
  region?: unknown;
  configuredBySession?: unknown;
}

export function writeGlobalCredentials(credentials: WriteGlobalCredentialsInput = {}): string {
  const path = globalCredentialsPath();
  mkdirSync(dirname(path), { recursive: true });
  const payload = {
    ak: asText(credentials.ak || ''),
    sk: asText(credentials.sk || ''),
    securityToken: asText(credentials.securityToken || ''),
    region: asText(credentials.region || ''),
    ...(credentials.configuredBySession === undefined
      ? {}
      : { configuredBySession: Boolean(credentials.configuredBySession) }),
  };
  writeFileSync(path, JSON.stringify(payload, null, 2), { encoding: 'utf8', mode: 0o600 });
  ensurePrivateMode(path);
  return path;
}

export function setConfiguredBySession(flag: unknown): void {
  const stored = readGlobalCredentials();
  const next = { ...(stored || {}), configuredBySession: Boolean(flag) };
  writeGlobalCredentials(next);
}

export function lastSyncPath(): string {
  return join(devkitStateBase(), '.last_sync');
}

function readLastSyncFile(path: string): LastSyncRecord | null {
  return readJsonObject(path);
}

export function readLastSync(): LastSyncRecord | null {
  const primary = lastSyncPath();
  const stored = readLastSyncFile(primary);
  if (stored) return stored;
  if (!existsSync(primary)) {
    const legacy = join(huaweiConfigBase(), '.last_sync');
    if (legacy !== primary) return readLastSyncFile(legacy);
  }
  return null;
}

export interface LastSyncMetadata {
  kooCliProfile?: unknown;
  s1Fingerprint?: unknown;
}

export function writeLastSync(metadata: LastSyncMetadata = {}): void {
  const path = lastSyncPath();
  mkdirSync(dirname(path), { recursive: true });
  const payload = {
    ts: Date.now(),
    ...(metadata.kooCliProfile ? { kooCliProfile: asText(metadata.kooCliProfile) } : {}),
    ...(metadata.s1Fingerprint ? { s1Fingerprint: asText(metadata.s1Fingerprint) } : {}),
  };
  writeFileSync(path, JSON.stringify(payload), { encoding: 'utf8', mode: 0o600 });
  ensurePrivateMode(path);
}

export function backupGlobalCredentials(): string | null {
  const target = globalCredentialsPath();
  const source = existsSync(target) ? target : legacyGlobalCredentialsPath();
  if (!existsSync(source)) return null;
  const bakPath = `${target}.bak`;
  try {
    mkdirSync(dirname(bakPath), { recursive: true });
    copyFileSync(source, bakPath);
    ensurePrivateMode(bakPath);
    return bakPath;
  } catch {
    return null;
  }
}

export function restoreGlobalCredentialsBackup(): boolean {
  const path = globalCredentialsPath();
  const bakPath = `${path}.bak`;
  if (!existsSync(bakPath)) return false;
  try {
    copyFileSync(bakPath, path);
    ensurePrivateMode(path);
    return true;
  } catch {
    return false;
  }
}
