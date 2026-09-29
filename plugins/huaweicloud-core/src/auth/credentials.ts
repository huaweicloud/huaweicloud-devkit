import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

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

export interface CodeArtsCredentials {
  ak: string;
  sk: string;
  securityToken: string;
  region: string;
}

export interface ResolvedCredentials {
  ak: string;
  sk: string;
  securityToken: string;
  region: string;
}

export interface LastSyncRecord {
  ts?: unknown;
  kooCliProfile?: unknown;
  s1Fingerprint?: unknown;
}

// Narrow untrusted parsed JSON to a record. Non-objects collapse to an empty
// record so property reads stay safe (same guarded-asRecord style as the other
// JSON boundaries).
function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

// Verify a credential file ended up with 0600. On Windows-mounted drives inside WSL
// (drvfs/9p) chmod is silently ignored, so the file can be world-readable (0777).
// Native Windows has no POSIX modes (statSync always reports 0666), so skip the check there.
function ensurePrivateMode(path: string): void {
  if (process.platform === 'win32') return;
  try {
    chmodSync(path, 0o600);
  } catch {}
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
  } catch {}
}

function baseHome(): string {
  return process.env.HUAWEICLOUD_HOME || homedir();
}

export function globalCredentialsPath(): string {
  return join(baseHome(), '.config', 'huaweicloud', 'credentials.json');
}

export function obsConfigPath(): string {
  // obsutil reads its config from a fixed location (~/.obsutilconfig), independent
  // of HUAWEICLOUD_HOME. HCLOUD_OBS_CONFIG_PATH exists solely for hermetic test injection.
  return process.env.HCLOUD_OBS_CONFIG_PATH || join(homedir(), '.obsutilconfig');
}

export function readGlobalCredentials(): StoredCredentials | null {
  const path = globalCredentialsPath();
  if (!existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as StoredCredentials)
      : null;
  } catch {
    return null;
  }
}

// R11: Placeholder / masked credential values are treated as "not configured".
// A vendor/IDE marketplace that pre-fills mcp_settings env with template text
// (e.g. "<HW_ACCESS_KEY>" or "${SECRET_KEY}") must not shadow the user's real
// S1 vault. Real AK/SK are >=20 char alphanumeric strings, so none of the
// template/masked patterns below can match a genuine credential.
export function isPlaceholder(value: unknown): boolean {
  if (typeof value !== 'string' || value.length === 0) return false;
  // <HW_ACCESS_KEY> / <your-ak> / <...>
  if (/^<[^>]*>$/.test(value)) return true;
  // ${HW_ACCESS_KEY}
  if (/^\$\{[^}]*\}$/.test(value)) return true;
  // YOUR_AK / ACCESS_KEY / SECRET_KEY / SECURITY_TOKEN / REGION (bare keyword)
  if (/^(YOUR_)?(AK|SK|ACCESS[_-]?KEY|SECRET[_-]?KEY|TOKEN|SECURITY[_-]?TOKEN|REGION)$/i.test(value)) return true;
  // placeholder / replace_me / change.me
  if (/\b(placeholder|replace[._-]?me|change[._-]?me)\b/i.test(value)) return true;
  // masked value: short alnum prefix + asterisk run (abc**** / token****) — the
  // S4 mirror writes the SK slot this way so the secret never lands in plaintext.
  if (/^[A-Za-z0-9]{3,8}\*+$/.test(value)) return true;
  // bare asterisks
  if (/^\*+$/.test(value)) return true;
  return false;
}

// Type guard so callers can narrow an untrusted value to a real, non-placeholder
// string and keep string plumbing later.
function present(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && !isPlaceholder(v);
}

// Pick the Huawei Cloud DevKit MCP server entry from a map using prefix matching.
// CodeArts Work marketplace presets keyed entries like `huaweicloud-devkit_1`
// (suffix per installed instance); match by prefix so `_1`/`_2`/`HuaweiCloud DevKit`
// all resolve without hardcoding an instance number.
// Deterministically choose the Huawei Cloud DevKit MCP server entry from a map.
// Priority (stable, independent of object key order):
//   1. exact `huaweicloud-devkit` (installer-managed key)
//   2. `HuaweiCloud Dev Kit`
//   3. prefixed instances `huaweicloud-devkit_N` sorted by ascending N
export function pickDevkitMcpServer(mcpMap: unknown): Record<string, unknown> | null {
  const map = asRecord(mcpMap);
  const keys = Object.keys(map);
  const rank = (k: string): number => {
    if (k === 'huaweicloud-devkit') return -2;
    if (k === 'HuaweiCloud DevKit') return -1;
    const m = /^huaweicloud-devkit_(\d+)$/i.exec(k);
    return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
  };
  const candidates = keys
    .filter((k) => /^huaweicloud-devkit(?:_|$)/i.test(k) || k === 'HuaweiCloud DevKit')
    .sort((a, b) => rank(a) - rank(b));
  for (const k of candidates) {
    if (map[k]) return map[k] as Record<string, unknown>;
  }
  return null;
}

export interface StsExpiryInput {
  securityToken?: unknown;
  expiresAtEnv?: unknown;
}

// Derive the expiry (epoch ms) of a temporary STS credential set.
// Priority: 1) HW_STS_EXPIRES_AT env (ISO8601 or epoch seconds); 2) decode the
// security token (JWT payload or bare URL-safe base64 JSON) reading common
// expiry fields (exp, timeout_at, expires_at, id_expires_at; issued_at+duration).
// Returns null when unknown/unparseable. Never throws.
export function parseStsExpiry({ securityToken, expiresAtEnv = process.env.HW_STS_EXPIRES_AT }: StsExpiryInput = {}):
  number | null {
  if (expiresAtEnv) {
    const v = String(expiresAtEnv).trim();
    if (!v) return null;
    const asNum = Number(v);
    if (Number.isFinite(asNum) && asNum > 0) return asNum > 1e12 ? asNum : asNum * 1000;
    const t = Date.parse(v);
    if (Number.isFinite(t)) return t;
    return null;
  }
  if (!securityToken || typeof securityToken !== 'string') return null;
  const token = String(securityToken).trim();
  if (!token) return null;

  const payload: unknown = (() => {
    try {
      if (token.includes('.')) {
        const parts = token.split('.');
        const b64 = parts.length >= 2 ? parts[1] : null;
        if (!b64) return null;
        const pad = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
        return JSON.parse(Buffer.from(pad.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
      }
      const pad = token + '='.repeat((4 - (token.length % 4)) % 4);
      return JSON.parse(Buffer.from(pad.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    } catch {
      return null;
    }
  })();
  if (!payload || typeof payload !== 'object') return null;
  const record = payload as Record<string, unknown>;

  const exp = Number(record.exp ?? record.expires_at ?? record.timeout_at ?? Number.NaN);
  if (Number.isFinite(exp) && exp > 0) return exp * 1000;
  const issued = Number(record.issued_at ?? record.iat ?? Number.NaN);
  const duration = Number(record.duration ?? record.expires_in ?? record.lifetime ?? Number.NaN);
  if (Number.isFinite(issued) && issued > 0 && Number.isFinite(duration) && duration > 0) {
    return (issued + duration) * 1000;
  }
  return null;
}

function readWorkEnvironmentEntry(config: unknown): CodeArtsCredentials | null {
  const server = pickDevkitMcpServer(asRecord(config).mcp);
  const environment = asRecord(server?.environment);
  const ak = environment.HW_ACCESS_KEY;
  const sk = environment.HW_SECRET_KEY;
  if (present(ak) && present(sk)) {
    return {
      ak,
      sk,
      securityToken: present(environment.HW_SECURITY_TOKEN) ? environment.HW_SECURITY_TOKEN : '',
      region: String(environment.HW_REGION || environment.HUAWEICLOUD_REGION || ''),
    };
  }
  return null;
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
    ak: String(credentials.ak || ''),
    sk: String(credentials.sk || ''),
    securityToken: String(credentials.securityToken || ''),
    region: String(credentials.region || ''),
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

export interface WriteObsConfigInput {
  ak?: unknown;
  sk?: unknown;
  securityToken?: unknown;
  region?: unknown;
  endpoint?: unknown;
}

export function writeObsConfig(credentials: WriteObsConfigInput = {}): { path: string; endpoint: string } {
  const region = String(credentials.region || '');
  const ak = String(credentials.ak || '');
  const sk = String(credentials.sk || '');
  const securityToken = String(credentials.securityToken || '');
  if (!region || !ak || !sk) {
    throw new Error('region, ak, and sk are required to write OBS config');
  }
  const path = obsConfigPath();
  const endpoint = String(credentials.endpoint || `https://obs.${region}.myhuaweicloud.com`);
  // Flat key=value format (no [default] section) as written by KooCLI 7.x `hcloud OBS config`.
  const content = `endpoint=${endpoint}\nak=${ak}\nsk=${sk}${securityToken ? `\ntoken=${securityToken}` : ''}\n`;
  writeFileSync(path, content, { encoding: 'utf8', mode: 0o600 });
  ensurePrivateMode(path);
  return { path, endpoint };
}

export interface ResolveCredentialsOptions {
  allowMissing?: boolean;
}

export function resolveCredentials(options: ResolveCredentialsOptions = {}): ResolvedCredentials | null {
  // R11: placeholder/masked env values are "not configured", never credentials.
  const envAk = process.env.HW_ACCESS_KEY;
  const envSk = process.env.HW_SECRET_KEY;
  const envSecurityToken = process.env.HW_SECURITY_TOKEN;
  let ak = present(envAk) ? envAk : '';
  let sk = present(envSk) ? envSk : '';
  let securityToken = present(envSecurityToken) ? envSecurityToken : '';
  let region = process.env.HW_REGION || process.env.HUAWEICLOUD_REGION || '';

  const codeartsCreds = isCodeArtsContext() ? readCodeArtsCredentials() : null;
  if (codeartsCreds) {
    if (!ak && codeartsCreds.ak) ak = codeartsCreds.ak;
    if (!sk && codeartsCreds.sk) sk = codeartsCreds.sk;
    if (!securityToken && codeartsCreds.securityToken) securityToken = codeartsCreds.securityToken;
    if (!region && codeartsCreds.region) region = codeartsCreds.region;
  }

  const stored = readGlobalCredentials();
  if (stored) {
    // R11: skip placeholder/masked values from the vault too (templates must
    // not win the truthiness check and shadow another store).
    if (!ak && present(stored.ak)) ak = stored.ak;
    if (!sk && present(stored.sk)) sk = stored.sk;
    if (!securityToken && present(stored.securityToken)) securityToken = stored.securityToken;
    if (!region && typeof stored.region === 'string' && stored.region) region = stored.region;
  }

  // R9: S1 written by `auth_switch persist` (configuredBySession) is the session's
  // source of truth and wins over env-injected defaults. Plain S1 (`auth init`)
  // still yields to env so devspace-style env injection keeps working.
  if (stored && stored.configuredBySession === true && present(stored.ak) && present(stored.sk)) {
    ak = stored.ak;
    sk = stored.sk;
    if (!securityToken) securityToken = present(stored.securityToken) ? stored.securityToken : '';
    if (!region && typeof stored.region === 'string' && stored.region) region = stored.region;
  }

  // Sandbox/platform-injected temporary STS credentials (env vars carrying a
  // security token) must not shadow the user's explicit permanent credentials
  // from `auth init`. Prefer the stored file when both exist.
  const envHasFullTriplet = present(envAk) && present(envSk) && present(envSecurityToken);
  if (envHasFullTriplet && stored && present(stored.ak) && present(stored.sk)) {
    ak = stored.ak;
    sk = stored.sk;
    securityToken = present(stored.securityToken) ? stored.securityToken : '';
    region = typeof stored.region === 'string' && stored.region ? stored.region : region;
  }

  if (!ak || !sk) {
    if (options.allowMissing) return null;
    const err = new Error(
      'Huawei Cloud credentials are not configured. Run "npx huaweicloud-devkit auth init" or set HW_ACCESS_KEY/HW_SECRET_KEY.',
    ) as CredentialError;
    err.code = 'HDKIT_CRED_MISSING';
    // Lightweight onboarding hint. HDKIT_CRED_MISSING fires when no credential
    // resolved: with env empty/masked and S1 absent, the scenario is 3 by
    // default. Scenario 4 (import a config-provided account) is only reachable
    // in the narrow case where CodeArts S4 offers real creds that the resolver
    // still couldn't adopt (e.g. CODEARTS_PROJECT_DIR set but the marker dir is
    // absent). Full guidance comes from getAuthStatus(); keep this branch cheap.
    const codeartsCreds = readCodeArtsCredentials();
    const injectedAvailable = present(codeartsCreds?.ak) && present(codeartsCreds?.sk);
    err.onboarding = injectedAvailable
      ? {
          scenario: 4,
          reason: 'import-injected',
          message: '检测到配置中已有有效账号,可导入为正式凭证。',
          steps: isCodeArtsContext()
            ? [{ action: 'auth_switch', args: { mode: 'mcp-config', action: 'persist' }, label: '导入配置中的账号' }]
            : [
                {
                  action: 'auth_switch',
                  args: { mode: 'import', action: 'persist' },
                  label: '通过 creds-import.json 导入',
                },
              ],
        }
      : {
          scenario: 3,
          reason: 's1-missing',
          message: '未配置华为云凭证,需要完成登录后才能使用云能力。',
          steps: isCodeArtsContext()
            ? [
                { action: 'write-import', target: join(homedir(), '.config', 'huaweicloud', 'creds-import.json') },
                { action: 'auth_switch', args: { mode: 'import', action: 'persist' } },
              ]
            : [{ action: 'auth-init', args: {} }],
        };
    throw err;
  }

  return { ak, sk, securityToken, region };
}

interface OnboardingHint {
  scenario: number;
  reason: string;
  message: string;
  steps: Array<Record<string, unknown>>;
}

interface CredentialError extends Error {
  code?: string;
  onboarding?: OnboardingHint;
}

let _parentCwd: string | null | undefined = undefined;

export function getParentCwd(): string | null {
  if (_parentCwd !== undefined) return _parentCwd;
  try {
    _parentCwd = readlinkSync(`/proc/${process.ppid}/cwd`);
    return _parentCwd;
  } catch {
    _parentCwd = null;
    return null;
  }
}

function isCodeArtsContext(): boolean {
  return (
    existsSync(join(process.cwd(), '.codeartsdoer')) ||
    existsSync(join(homedir(), '.codeartsdoer')) ||
    existsSync(join(homedir(), '.codeartswork')) ||
    existsSync(join(homedir(), '.codearts'))
  );
}

export function readCodeArtsCredentials(): CodeArtsCredentials | null {
  const parentCwd = getParentCwd();
  const searchDirs = [process.env.CODEARTS_PROJECT_DIR, parentCwd, process.cwd(), homedir()];

  for (const dir of searchDirs) {
    if (!dir) continue;
    const path = join(dir, '.codeartsdoer', 'mcp', 'mcp_settings.json');
    try {
      if (!existsSync(path)) continue;
      const config: unknown = JSON.parse(readFileSync(path, 'utf8'));
      const server = pickDevkitMcpServer(asRecord(config).mcpServers);
      const env = asRecord(server?.env);
      if (!server || !server.env) continue;

      const ak = env.HW_ACCESS_KEY;
      const sk = env.HW_SECRET_KEY;
      if (present(ak) && present(sk)) {
        return {
          ak,
          sk,
          securityToken: present(env.HW_SECURITY_TOKEN) ? env.HW_SECURITY_TOKEN : '',
          region: String(env.HW_REGION || env.HUAWEICLOUD_REGION || ''),
        };
      }
    } catch {
      // mcp_settings.json missing or invalid — skip
    }
  }

  // CodeArts Work — user-level only.
  // New layout (post platform migration): ~/.codearts/mcp/mcp_settings.json with
  // prefixed keys like `huaweicloud-devkit_1`; legacy ~/.codeartswork kept as
  // fallback while still in service.
  const workPaths = [
    join(homedir(), '.codearts', 'mcp', 'mcp_settings.json'),
    join(homedir(), '.codeartswork', 'mcp', 'mcp_settings.json'),
  ];
  for (const path of workPaths) {
    try {
      if (!existsSync(path)) continue;
      const config: unknown = JSON.parse(readFileSync(path, 'utf8'));
      const entry = readWorkEnvironmentEntry(config);
      if (entry) return entry;
    } catch {
      // mcp_settings.json missing or invalid — skip
    }
  }

  return null;
}

let runtimeCredentials: ResolvedCredentials | null = null;

export function setRuntimeCredentials(ak: unknown, sk: unknown, securityToken?: unknown, region?: unknown): void {
  runtimeCredentials = {
    ak: String(ak ?? ''),
    sk: String(sk ?? ''),
    securityToken: String(securityToken || ''),
    region: String(region || ''),
  };
}

export function clearRuntimeCredentials(): void {
  runtimeCredentials = null;
}

export function hasRuntimeCredentials(): boolean {
  return runtimeCredentials !== null;
}

export function resolveCredentialsWithRuntime(options: ResolveCredentialsOptions = {}): ResolvedCredentials | null {
  if (runtimeCredentials) {
    return {
      ak: runtimeCredentials.ak,
      sk: runtimeCredentials.sk,
      securityToken: runtimeCredentials.securityToken,
      region: runtimeCredentials.region,
    };
  }

  return resolveCredentials(options);
}

export function lastSyncPath(): string {
  return join(baseHome(), '.config', 'huaweicloud', '.last_sync');
}

export function readLastSync(): LastSyncRecord | null {
  const path = lastSyncPath();
  if (!existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as LastSyncRecord) : null;
  } catch {
    return null;
  }
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
    ...(metadata.kooCliProfile ? { kooCliProfile: String(metadata.kooCliProfile) } : {}),
    ...(metadata.s1Fingerprint ? { s1Fingerprint: String(metadata.s1Fingerprint) } : {}),
  };
  writeFileSync(path, JSON.stringify(payload), { encoding: 'utf8', mode: 0o600 });
  ensurePrivateMode(path);
}

export function backupGlobalCredentials(): string | null {
  const path = globalCredentialsPath();
  if (!existsSync(path)) return null;
  const bakPath = `${path}.bak`;
  try {
    copyFileSync(path, bakPath);
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
