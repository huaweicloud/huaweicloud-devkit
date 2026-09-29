import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';

import {
  hasRuntimeCredentials,
  isPlaceholder,
  obsConfigPath,
  readGlobalCredentials,
  readLastSync,
  resolveCredentialsWithRuntime,
} from './credentials.ts';
import { resolveHcloudCommand } from '../hcloud-probe.ts';
import { redactSecrets } from '../safety-policy.ts';

export { hasRuntimeCredentials };

export interface KooCliProfile {
  name: string;
  fingerprint: string;
  accessKeyId: string;
  encrypted: boolean;
}

export interface KooCliProfiles {
  current: string;
  mtimeMs: number;
  configPath: string;
  authEncrypt: boolean;
  profiles: KooCliProfile[];
}

export interface KooCliProfilesError {
  error: string;
}

export type KooCliProfilesResult = KooCliProfiles | KooCliProfilesError;

export interface ObsConfig {
  ak: string;
  sk: string;
  region: string;
}

export interface Inconsistency {
  store: string;
  source: string;
  fingerprint: string | null;
  manualModified: boolean;
}

export interface ScanState {
  stores: {
    s1Fingerprint: string;
    envFingerprint: string;
    currentFingerprint: string | null;
    s3Fingerprint: string | null;
    runtimeFingerprint: string | null;
  };
  kooCliCurrent: string | null;
  envIsPlaceholder: boolean;
  s2Encrypted: boolean;
  inconsistencies: Inconsistency[];
  hasRuntime: boolean;
  runtimeFingerprint: string | null;
}

interface LastSyncRecord {
  ts?: unknown;
  kooCliProfile?: unknown;
  s1Fingerprint?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function toLastSync(value: unknown): LastSyncRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as LastSyncRecord) : {};
}

export function kooCliConfigPath(): string {
  // KooCLI keeps its config at a fixed location (~/.hcloud/config.json),
  // independent of HUAWEICLOUD_HOME (that env only relocates devkit's own S1/S3).
  // HCLOUD_CONFIG_PATH exists solely for hermetic test injection.
  return process.env.HCLOUD_CONFIG_PATH || join(homedir(), '.hcloud', 'config.json');
}

export function fingerprint(ak?: unknown, sk?: unknown): string {
  if (!ak || !sk) return '';
  return createHash('sha256')
    .update(`${String(ak)}${String(sk)}`)
    .digest('hex')
    .slice(0, 8);
}

export function isManualModified(path: string): boolean {
  if (!existsSync(path)) return false;
  const lastSyncRaw: unknown = readLastSync();
  try {
    const fts = statSync(path).mtimeMs;
    if (!lastSyncRaw) return true; // no marker → treat as manual
    return fts > Number(toLastSync(lastSyncRaw).ts);
  } catch {
    return false;
  }
}

export function readKooCliProfiles(): KooCliProfilesResult {
  const configPath = kooCliConfigPath();
  if (!existsSync(configPath)) return { error: 'KooCLI config not found' };
  try {
    const raw = asRecord(JSON.parse(readFileSync(configPath, 'utf8')));
    const current = String(raw.current || 'default');
    const profiles: unknown[] = Array.isArray(raw.profiles) ? raw.profiles : [];
    const mtimeMs = statSync(configPath).mtimeMs;
    // KooCLI 7.x stores AK/SK encrypted (authEncrypt=true): the on-disk values
    // are ciphertext, so a fingerprint computed from them can never match the
    // plaintext S1/S3 stores. Blind the comparable fields instead of treating
    // ciphertext as a real credential and misreporting a S2 drift (#533).
    // KooCLI serializes the flag as the string "true", not a boolean.
    const encrypted = raw.authEncrypt === true || raw.authEncrypt === 'true';
    return {
      current,
      mtimeMs,
      configPath,
      authEncrypt: encrypted,
      profiles: profiles.map((p) => {
        const profile = asRecord(p);
        return encrypted
          ? { name: String(profile.name || ''), fingerprint: '', accessKeyId: '', encrypted: true }
          : {
              name: String(profile.name || ''),
              fingerprint: fingerprint(profile.accessKeyId, profile.secretAccessKey),
              accessKeyId: String(profile.accessKeyId || ''),
              encrypted: false,
            };
      }),
    };
  } catch {
    return { error: 'KooCLI config parse failed' };
  }
}

export function resolveManagedProfile(): string | null {
  const res = readKooCliProfiles();
  if ('error' in res) return null;
  return res.current;
}

export function currentFingerprintFromHcloud(res: KooCliProfilesResult): string | null {
  if ('error' in res) return null;
  const cur = res.profiles.find((p) => p.name === res.current);
  return cur ? cur.fingerprint : null;
}

function currentProfileFromHcloud(res: KooCliProfilesResult): KooCliProfile | null {
  if ('error' in res) return null;
  return res.profiles.find((p) => p.name === res.current) || null;
}

function s2CurrentMatchesLastDevkitSync(
  kooCli: KooCliProfilesResult,
  s1: Record<string, unknown>,
  s1Fingerprint: string,
): boolean {
  if ('error' in kooCli) return false;
  const current = currentProfileFromHcloud(kooCli);
  const lastSync = toLastSync(readLastSync());
  if (!current || !lastSync.ts || !lastSync.kooCliProfile || !lastSync.s1Fingerprint) return false;
  if (!s1.ak || current.accessKeyId !== s1.ak) return false;
  if (lastSync.kooCliProfile !== kooCli.current) return false;
  if (lastSync.s1Fingerprint !== s1Fingerprint) return false;
  return Number(kooCli.mtimeMs || 0) <= Number(lastSync.ts) + 1000;
}

export function scanState(): ScanState {
  const s1 = asRecord(readGlobalCredentials());
  const envAk = isPlaceholder(process.env.HW_ACCESS_KEY) ? '' : process.env.HW_ACCESS_KEY || '';
  const envSk = isPlaceholder(process.env.HW_SECRET_KEY) ? '' : process.env.HW_SECRET_KEY || '';
  const kooCli = readKooCliProfiles();
  const inconsistencies: Inconsistency[] = [];
  const envIsPlaceholder =
    Boolean(process.env.HW_ACCESS_KEY && isPlaceholder(process.env.HW_ACCESS_KEY)) ||
    Boolean(process.env.HW_SECRET_KEY && isPlaceholder(process.env.HW_SECRET_KEY));

  const s1Fingerprint = fingerprint(s1.ak, s1.sk);
  const currentFp = currentFingerprintFromHcloud(kooCli);
  const s2SyncedByDevkit = s1Fingerprint ? s2CurrentMatchesLastDevkitSync(kooCli, s1, s1Fingerprint) : false;
  const effectiveCurrentFp = s2SyncedByDevkit ? s1Fingerprint : currentFp;
  const envFingerprint = fingerprint(envAk, envSk);
  const s3 = existsSync(obsConfigPath()) ? parseS3ObsConfig(obsConfigPath()) : null;
  const s3Fingerprint = s3 ? fingerprint(s3.ak, s3.sk) : null;

  let hasRuntime = false;
  let runtimeFingerprint: string | null = null;
  try {
    const rt = asRecord(resolveCredentialsWithRuntime());
    hasRuntime = hasRuntimeCredentials();
    if (hasRuntime) runtimeFingerprint = fingerprint(rt.ak, rt.sk);
  } catch {
    // nothing resolvable → runtime store inactive
  }

  if (s1Fingerprint && currentFp && s1Fingerprint !== effectiveCurrentFp) {
    inconsistencies.push({
      store: 'S2-current',
      source: 'KooCLI current profile',
      fingerprint: currentFp,
      manualModified: isManualModified(
        'error' in kooCli ? kooCliConfigPath() : kooCli.configPath || kooCliConfigPath(),
      ),
    });
  }
  if (s1Fingerprint && s3Fingerprint && s1Fingerprint !== s3Fingerprint) {
    inconsistencies.push({
      store: 'S3',
      source: 'obsutilconfig',
      fingerprint: s3Fingerprint,
      manualModified: isManualModified(obsConfigPath()),
    });
  }

  return {
    stores: {
      s1Fingerprint,
      envFingerprint,
      currentFingerprint: effectiveCurrentFp,
      s3Fingerprint,
      runtimeFingerprint,
    },
    kooCliCurrent: 'error' in kooCli ? null : kooCli.current,
    // R11: env carries placeholder/masked values → surface that explicitly so
    // diagnostics don't show a bogus fingerprint derived from template text.
    envIsPlaceholder,
    // S2 is encrypted storage (authEncrypt) → its fingerprint is unavailable,
    // so the S2-current drift check is intentionally skipped (#533).
    s2Encrypted: Boolean(!('error' in kooCli) && kooCli.authEncrypt),
    inconsistencies,
    hasRuntime,
    runtimeFingerprint,
  };
}

function parseS3ObsConfig(path: string): ObsConfig | null {
  try {
    const text = readFileSync(path, 'utf8');
    const get = (k: string): string => {
      const m = text.match(new RegExp(`^${k}=(.+)$`, 'm'));
      return m ? m[1].trim() : '';
    };
    return { ak: get('ak'), sk: get('sk'), region: inferRegion(text) };
  } catch {
    return null;
  }
}

function inferRegion(text: string): string {
  const m = text.match(/endpoint=https:\/\/obs\.([^.]+)\./);
  return m ? m[1] : '';
}

export function exportStateForStatus(_jailed?: boolean) {
  const scan = scanState();
  return {
    ...scan,
    // fields below are consumed by getAuthStatus in service.ts
    inconsistent: scan.inconsistencies.length > 0,
  };
}

export function runHcloudConfigure(
  profile: string,
  ak: string,
  sk: string,
  region?: string,
): { ok: boolean; error: string } {
  const { executable, argsPrefix } = resolveHcloudCommand();
  const args = [
    'configure',
    'set',
    `--cli-profile=${profile}`,
    `--cli-access-key=${ak}`,
    `--cli-secret-key=${sk}`,
    `--cli-region=${region || ''}`,
  ];
  const r = spawnSync(executable, [...argsPrefix, ...args], {
    shell: false,
    windowsHide: true,
    stdio: 'pipe',
    timeout: 30000,
  });
  return {
    ok: r.status === 0,
    error: redactSecrets(
      String(r.stderr || '')
        .trim()
        .slice(0, 240),
    ),
  };
}
