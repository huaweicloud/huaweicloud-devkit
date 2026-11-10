// Startup upgrade policy: an ungated hdkitservice endpoint tells the client
// whether a minimum version is currently enforced. It is deliberately tiny
// and best-effort; any failure falls back to the ordinary npm channel.
import { fetchWithProxy } from './proxy/proxy-agent.mjs';
import { getRuntimeVersion, semverParse } from './update-check.mjs';

const POLICY_TIMEOUT_MS = 2000;
const POLICY_TTL_MS = 10 * 60 * 1000;
const POLICY_FAIL_THROTTLE_MS = 5 * 60 * 1000;

let cachedPolicy = null;
let cachedAt = 0;
let failedAt = 0;

export function hdkitBaseUrl(env = process.env) {
  const raw = env.HDKITSERVICE_ENDPOINT || 'https://devkit.huaweicloud.com/rest/developer/server/hdkitservice/';
  return raw.endsWith('/') ? raw : `${raw}/`;
}

export function hdkitPolicyUrl(env = process.env) {
  return new URL('upgrade/policy', hdkitBaseUrl(env)).toString();
}

export function _resetUpgradePolicyCache() {
  cachedPolicy = null;
  cachedAt = 0;
  failedAt = 0;
}

function sanitizeMinVersion(value) {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  return semverParse(raw) ? raw : null;
}

export async function getUpgradePolicy({
  doFetch = fetchWithProxy,
  now = Date.now(),
  env = process.env,
  timeoutMs = POLICY_TIMEOUT_MS,
} = {}) {
  if (env.HUAWEICLOUD_DEVKIT_SKIP_UPDATE === '1') return null;
  if (cachedPolicy && now - cachedAt <= POLICY_TTL_MS) return cachedPolicy;
  if (!cachedPolicy && now - failedAt < POLICY_FAIL_THROTTLE_MS) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await doFetch(hdkitPolicyUrl(env), {
      headers: {
        Accept: 'application/json',
        'X-HW-Client-Version': getRuntimeVersion(),
      },
      signal: controller.signal,
    });
    if (!resp || !resp.ok) {
      failedAt = now;
      return null;
    }
    const data = await resp.json().catch(() => null);
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      failedAt = now;
      return null;
    }
    const minVersion = sanitizeMinVersion(data.minVersion);
    const active = data.minVersionActive === true && Boolean(minVersion);
    cachedPolicy = {
      minVersion: minVersion || '',
      active,
      latestStable: typeof data.latestStable === 'string' ? data.latestStable : '',
      latestNext: typeof data.latestNext === 'string' ? data.latestNext : '',
      upgradeHint: typeof data.upgradeHint === 'string' ? data.upgradeHint : '',
    };
    cachedAt = now;
    return cachedPolicy;
  } catch {
    failedAt = now;
    return null;
  } finally {
    clearTimeout(timer);
  }
}
