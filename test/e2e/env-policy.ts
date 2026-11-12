// The hermetic-seam contract for every E2E case session. buildCaseEnv is the
// single merge point: no other code path may assemble the env handed to the
// agent process. Merge order is fixed — trimmed process env, throwaway-home
// relocation, driver vars, then seam vars plus the fixed posture overrides —
// so a driver can never shadow a seam, and no host credential or proxy can
// leak into a session. The pin test in test/e2e-env-policy.test.ts freezes
// this list; changing it is a deliberate contract edit, not a drive-by.

import { join } from 'node:path';

// Proxy spellings: the smoke-agents.mjs cleanEnv precedent. A corporate
// proxy would route 127.0.0.1 fake-boundary traffic away from the fakes.
export const STRIP_ENV_KEYS: readonly string[] = [
  'http_proxy',
  'https_proxy',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'all_proxy',
  'ALL_PROXY',
  // Live Huawei Cloud credentials on the host would leak real AK/SK into
  // recordings (STS argv injection) and corrupt auth/voucher/sandbox cases.
  'HW_ACCESS_KEY',
  'HW_SECRET_KEY',
  'HW_SECURITY_TOKEN',
  'HW_REGION',
  'HUAWEICLOUD_REGION',
  'HCLOUD_CONFIG_PATH',
  'HCLOUD_OBS_CONFIG_PATH',
  // Ambient agent-home overrides (real-agents sandboxEnv precedent): a
  // host value would redirect the installer, the spawned server, or the
  // opencode config root out of the throwaway home.
  'DSH_HOME',
  'ATOMCODE_HOME',
  'HERMES_HOME',
  'HUAWEICLOUD_DEVKIT_HOME',
  'OFFICE_CLAW_CONFIG_ROOT',
  'OPENCODE_CONFIG_DIR',
  'OPENCODE_CONFIG',
  'OPENCODE_TEST_HOME',
  // Pack posture rides the install --packs channel; env must stay unset so
  // the runner controls the only delivery path per case.
  'DEVKIT_PACKS',
  // The installer's opencode permission-seam override is host state, not a
  // case seam: the runner's install relies on the natural version probe
  // (the driver's probe gate already enforces >= the seam floor), so a
  // host-set value must never leak into a case session.
  'HUAWEICLOUD_OPENCODE_PERMISSION_SEAM',
  // Same doctrine for the ask-rule gate: the runner's install relies on
  // the natural probe deciding whether the ASK posture's pair is written.
  'HUAWEICLOUD_OPENCODE_ASK_RULE',
];

// Posture overrides applied last: telemetry off (no production POSTs from
// nightly runs), update check off (its npm state would decorate the first
// tool result with LLM-visible nondeterminism), STS argv injection off,
// and a local NO_PROXY belt-and-braces behind the proxy strip.
export const FIXED_ENV_OVERRIDES: Readonly<Record<string, string>> = {
  HUAWEICLOUD_DEVKIT_TELEMETRY: 'off',
  HUAWEICLOUD_SKIP_HCLOUD_PREINSTALL: '1',
  HUAWEICLOUD_DEVKIT_SKIP_UPDATE: '1',
  HUAWEICLOUD_INJECT_STS_CMD: '0',
  NO_PROXY: '127.0.0.1,localhost',
  no_proxy: '127.0.0.1,localhost',
};

// The single relaxation any case may ever need: update cases must let the
// registry query run. The whitelist is type-level, so relaxing telemetry
// (production POSTs) or STS injection (credential argv leaks) is not
// expressible — a case cannot opt out of the posture that keeps sessions
// hermetic.
export const RELAXABLE_FIXED_KEYS = ['HUAWEICLOUD_DEVKIT_SKIP_UPDATE'] as const;
export type RelaxableFixedKey = (typeof RELAXABLE_FIXED_KEYS)[number];

// The cross-platform home relocation recipe (cross-platform-install.test.ts
// makeEnv precedent) plus XDG relocation and CODEX_HOME: opencode resolves
// its config, data, state, and cache from XDG_* when set, and codex resolves
// its whole home from CODEX_HOME — pointing them inside the throwaway home
// keeps the session hermetic without relying on the host having them unset.
export function homeOverrides(home: string): Record<string, string> {
  return {
    HOME: home,
    USERPROFILE: home,
    HOMEDRIVE: home.slice(0, 2),
    HOMEPATH: home.slice(2),
    HUAWEICLOUD_HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local', 'share'),
    XDG_STATE_HOME: join(home, '.local', 'state'),
    XDG_CACHE_HOME: join(home, '.cache'),
    CODEX_HOME: join(home, '.codex'),
  };
}

export interface BuildCaseEnvInput {
  processEnv: NodeJS.ProcessEnv;
  home: string;
  driverVars?: NodeJS.ProcessEnv;
  seamVars?: NodeJS.ProcessEnv;
  caseEnv?: Record<string, string>;
  relaxFixed?: readonly RelaxableFixedKey[];
}

export function buildCaseEnv(input: BuildCaseEnvInput): NodeJS.ProcessEnv {
  const stripSet = new Set(STRIP_ENV_KEYS.map((key) => key.toLowerCase()));
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(input.processEnv)) {
    if (value === undefined) continue;
    if (stripSet.has(key.toLowerCase())) continue;
    env[key] = value;
  }
  Object.assign(env, homeOverrides(input.home));
  if (input.driverVars) Object.assign(env, input.driverVars);
  if (input.seamVars) Object.assign(env, input.seamVars);
  // Case env lands BEFORE the fixed posture: a case may add seams, never
  // defeat the posture (relaxFixed is the only, whitelisted channel).
  if (input.caseEnv) Object.assign(env, input.caseEnv);
  Object.assign(env, FIXED_ENV_OVERRIDES);
  for (const key of input.relaxFixed ?? []) delete env[key];
  return env;
}

// Session-env secret values an agent could echo into its transcript
// (printenv and friends). The report is an uploaded CI artifact, so the
// known key values are replaced before anything is recorded or serialized.
// Short values are skipped: scrubbing an 8-char-or-less string would mangle
// ordinary transcript text.
export function scrubSecrets(text: string): string {
  let scrubbed = text;
  for (const key of ['E2E_APIKEY', 'E2E_TEST_API_KEY']) {
    const value = process.env[key];
    if (value && value.length >= 8) scrubbed = scrubbed.replaceAll(value, '[redacted]');
  }
  return scrubbed;
}
