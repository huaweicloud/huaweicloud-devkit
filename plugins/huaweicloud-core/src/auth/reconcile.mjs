import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';

import {
  hasRuntimeCredentials,
  obsConfigPath,
  readGlobalCredentials,
  readLastSync,
  resolveCredentialsWithRuntime,
} from './credentials.mjs';

export { hasRuntimeCredentials };

function baseHome() {
  return process.env.HUAWEICLOUD_HOME || homedir();
}

export function fingerprint(ak, sk) {
  if (!ak || !sk) return '';
  return createHash('sha256').update(`${ak}${sk}`).digest('hex').slice(0, 8);
}

export function isManualModified(path) {
  if (!existsSync(path)) return false;
  const lastSync = readLastSync();
  try {
    const fts = statSync(path).mtimeMs;
    if (!lastSync) return true; // no marker → treat as manual
    return fts > lastSync.ts;
  } catch {
    return false;
  }
}

export function readKooCliProfiles() {
  const configPath = join(baseHome(), '.hcloud', 'config.json');
  if (!existsSync(configPath)) return { error: 'KooCLI config not found' };
  try {
    const raw = JSON.parse(readFileSync(configPath, 'utf8'));
    const current = String(raw.current || 'default');
    const profiles = Array.isArray(raw.profiles) ? raw.profiles : [];
    const mtimeMs = statSync(configPath).mtimeMs;
    return {
      current,
      mtimeMs,
      profiles: profiles.map((p) => ({
        name: String(p.name || ''),
        fingerprint: fingerprint(p.accessKeyId, p.secretAccessKey),
        accessKeyId: p.accessKeyId || '',
      })),
    };
  } catch {
    return { error: 'KooCLI config parse failed' };
  }
}

export function resolveManagedProfile() {
  const res = readKooCliProfiles();
  if (res.error) return null;
  return res.current;
}

export function currentFingerprintFromHcloud(res) {
  if (res.error) return null;
  const cur = res.profiles.find((p) => p.name === res.current);
  return cur ? cur.fingerprint : null;
}

export function scanState() {
  const s1 = readGlobalCredentials() || {};
  const envAk = process.env.HW_ACCESS_KEY || '';
  const envSk = process.env.HW_SECRET_KEY || '';
  const kooCli = readKooCliProfiles();
  const currentFp = currentFingerprintFromHcloud(kooCli);
  const inconsistencies = [];

  const s1Fingerprint = fingerprint(s1.ak, s1.sk);
  const envFingerprint = fingerprint(envAk, envSk);
  const s3 = existsSync(obsConfigPath()) ? parseS3ObsConfig(obsConfigPath()) : null;
  const s3Fingerprint = s3 ? fingerprint(s3.ak, s3.sk) : null;

  let hasRuntime = false;
  let runtimeFingerprint = null;
  try {
    const rt = resolveCredentialsWithRuntime();
    hasRuntime = hasRuntimeCredentials();
    if (hasRuntime) runtimeFingerprint = fingerprint(rt.ak, rt.sk);
  } catch {
    // nothing resolvable → runtime store inactive
  }

  if (s1Fingerprint && currentFp && s1Fingerprint !== currentFp) {
    inconsistencies.push({
      store: 'S2-current',
      source: 'KooCLI current profile',
      fingerprint: currentFp,
      manualModified: isManualModified(join(baseHome(), '.hcloud', 'config.json')),
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
      currentFingerprint: currentFp,
      s3Fingerprint,
      runtimeFingerprint,
    },
    kooCliCurrent: kooCli.error ? null : kooCli.current,
    inconsistencies,
    hasRuntime,
    runtimeFingerprint,
  };
}

function parseS3ObsConfig(path) {
  try {
    const text = readFileSync(path, 'utf8');
    const get = (k) => {
      const m = text.match(new RegExp(`^${k}=(.+)$`, 'm'));
      return m ? m[1].trim() : '';
    };
    return { ak: get('ak'), sk: get('sk'), region: inferRegion(text) };
  } catch {
    return null;
  }
}

function inferRegion(text) {
  const m = text.match(/endpoint=https:\/\/obs\.([^.]+)\./);
  return m ? m[1] : '';
}

export function exportStateForStatus(_jailed) {
  const scan = scanState();
  return {
    ...scan,
    // fields below are consumed by getAuthStatus in service.mjs
    inconsistent: scan.inconsistencies.length > 0,
  };
}

export function runHcloudConfigure(profile, ak, sk, region) {
  const bin = process.env.HCLOUD_BIN || 'hcloud';
  const args = [
    'configure',
    'set',
    `--cli-profile=${profile}`,
    `--cli-access-key=${ak}`,
    `--cli-secret-key=${sk}`,
    `--cli-region=${region || ''}`,
  ];
  const r = spawnSync(bin, args, { shell: false, windowsHide: true, stdio: 'pipe', timeout: 30000 });
  return {
    ok: r.status === 0,
    error: String(r.stderr || '')
      .trim()
      .slice(0, 240),
  };
}
