import { readFileSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';

import {
  writeGlobalCredentials,
  writeObsConfig as writeObsConfigFile,
  setConfiguredBySession,
  backupGlobalCredentials,
  writeLastSync,
  globalCredentialsPath,
  readGlobalCredentials,
} from '../auth/credentials.ts';
import { fingerprint, runHcloudConfigure, resolveManagedProfile } from '../auth/reconcile.ts';
import { clearUserHash } from '../telemetry/telemetry.ts';
import { hdkitGenerateUserHash } from './hdkit/hdkitservice-api.ts';
import { asText } from './as-text.ts';
import { resolveSecretValue, vaultGet } from './secret-vault/store.ts';
import { formatSecretRef, parseSecretRef } from './secret-vault/refs.ts';

// Credential session helpers shared by the auth and sandbox packs
// (src/packs/auth/tools.ts, src/packs/sandbox/tools.ts), hoisted from
// src/tools.ts so the packs import them from lib instead of value-importing
// tools.ts — which would form a value cycle with tools.ts importing the
// packs' handler maps. Dependencies reach only into src/auth/, telemetry,
// and the hdkit api module; no dependency on tools.ts or tool-schemas.ts.

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

// Boundary narrowing for credential-shaped values: only string fields survive,
// so callers keep truthiness checks and string plumbing.
export interface CredentialLike {
  ak?: string;
  sk?: string;
  securityToken?: string;
  region?: string;
}

export function asCredentialRecord(value: unknown): CredentialLike | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const result: CredentialLike = {};
  if (typeof record.ak === 'string') result.ak = record.ak;
  if (typeof record.sk === 'string') result.sk = record.sk;
  if (typeof record.securityToken === 'string') result.securityToken = record.securityToken;
  if (typeof record.region === 'string') result.region = record.region;
  return result;
}

export interface PendingConfirm {
  newAk: string;
  newSk: string;
  newSecurityToken: string;
  newRegion: string;
  oldFingerprint: string;
  newFingerprint: string;
  fromImport: boolean;
}

export const pendingConfirms = new Map<string, PendingConfirm>();

export function readImportFile() {
  const path = join(dirname(globalCredentialsPath()), 'creds-import.json');
  try {
    if (!existsSync(path)) return null;
    const data: unknown = JSON.parse(readFileSync(path, 'utf8'));
    const record = asRecord(data);
    return {
      ak: asText(record.ak || ''),
      sk: asText(record.sk || ''),
      securityToken: asText(record.securityToken || ''),
      region: asText(record.region || ''),
    };
  } catch {
    // Malformed/undecodable import file is un-replayable — wipe it. A VALID
    // file is kept so a rejected persist can be replayed (see #502).
    try {
      rmSync(path, { force: true });
    } catch {
      // ignore
    }
    return null;
  }
}

export function clearImportFile() {
  const path = join(dirname(globalCredentialsPath()), 'creds-import.json');
  try {
    rmSync(path, { force: true });
  } catch {
    // best-effort: an absent or locked file is not an error
  }
}

// When S1 already holds a secret:// ref for a field and that ref resolves to
// the SAME value being persisted, keep the ref in the file instead of
// downgrading the representation to plaintext. The mirrors (S2/S3) still
// receive the resolved value; only S1's at-rest form is preserved. A ref
// that resolves differently (or fails to resolve) loses to the incoming
// plaintext — the caller's value is the new truth.
export function preserveRefForm(plaintext: string, rawStored: unknown): string {
  if (typeof rawStored !== 'string') return plaintext;
  const ref = parseSecretRef(rawStored);
  if (!ref) return plaintext;
  try {
    if (vaultGet(formatSecretRef(ref)).value === plaintext) return rawStored;
  } catch {
    // Unresolvable: the strict read in auth_switch already surfaced this;
    // fall through to the plaintext write.
  }
  return plaintext;
}

export function persistCredentials(ak: string, sk: string, securityToken: string, region: string) {
  if (String(securityToken || '')) {
    return {
      status: 'error',
      error: 'Temporary STS credentials cannot be persisted (R3). Use action=temporary.',
      scope: 'rejected',
    };
  }
  // Incoming values may themselves be secret:// refs (auth_switch mode=
  // memory with refs, or a creds-import.json carrying them). Resolve them
  // BEFORE any fan-out: a literal ref string written into
  // ~/.obsutilconfig or a KooCLI profile breaks both mirrors. S1 keeps the
  // ref representation via preserveRefForm when the resolved value matches.
  const akValue = resolveSecretValue(ak) ?? ak;
  const skValue = resolveSecretValue(String(sk)) ?? String(sk);
  const before = backupGlobalCredentials();
  const rawStored = readGlobalCredentials();
  writeGlobalCredentials({
    ak: preserveRefForm(akValue, rawStored?.ak),
    sk: preserveRefForm(skValue, rawStored?.sk),
    securityToken: '',
    region,
    configuredBySession: true,
  });
  setConfiguredBySession(true);
  let obs: { ok: boolean; error?: string };
  try {
    writeObsConfigFile({ ak: akValue, sk: skValue, securityToken, region });
    obs = { ok: true };
  } catch (error) {
    obs = { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  const profile = resolveManagedProfile();
  let hcloud: { ok: boolean; error?: string; reason?: string };
  if (!profile) {
    hcloud = { ok: false, reason: 'KooCLI current profile unresolved' };
  } else {
    hcloud = runHcloudConfigure(profile, akValue, skValue, region);
  }
  if (hcloud.ok) {
    writeLastSync({ kooCliProfile: profile, s1Fingerprint: fingerprint(akValue, skValue) });
  }
  return {
    status: obs.ok && hcloud.ok ? 'ok' : 'partial',
    scope: 'persist',
    backedUp: Boolean(before),
    obs: obs.ok ? { configured: true } : { configured: false, error: obs.error },
    hcloud,
    note: 'S1 written with configuredBySession (R9), which now takes priority over env-injected credentials; S2(current profile) and S3 synced. Note: running `auth init` later clears the configuredBySession flag and env credentials regain priority.',
  };
}

export function refreshUserHashAfterAuthChange({ regenerate = true }: { regenerate?: boolean } = {}) {
  clearUserHash();
  if (regenerate) {
    hdkitGenerateUserHash().catch(() => {});
  }
}
