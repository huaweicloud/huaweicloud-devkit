import { existsSync } from 'node:fs';

import { getAgentRegistrationStatuses, type AgentRegistrationStatus } from './agent-registration.ts';
import { resolveAndApplyProjectId } from './project-id.ts';
import {
  globalCredentialsPath,
  isCodeArtsContext,
  isPlaceholder,
  obsConfigPath,
  parseStsExpiry,
  readCodeArtsCredentials,
  readGlobalCredentials,
  readGlobalCredentialsResolved,
  readGlobalCredentialsStrict,
  resolveCredentialsWithRuntime,
  writeLastSync,
  writeObsConfig,
} from './credentials.ts';
import { buildOnboardingSteps, errorFromTable, type GuidanceStep } from './error-table.ts';
import {
  fingerprint,
  exportStateForStatus,
  hasRuntimeCredentials,
  resolveManagedProfile,
  runHcloudConfigure,
  runHcloudProfileDelete,
} from './reconcile.ts';
import { hcloudProbeNextStep, hcloudProbeRaw, probeHcloud } from '../hcloud-probe.ts';

interface CredentialRecord {
  ak?: string;
  sk?: string;
  securityToken?: string;
  region?: string;
  endpoint?: string;
}

// Boundary narrowing for credential-shaped values: only string fields survive,
// so callers can keep truthiness checks and string plumbing.
function asCredentialRecord(value: unknown): CredentialRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const result: CredentialRecord = {};
  if (typeof record.ak === 'string') result.ak = record.ak;
  if (typeof record.sk === 'string') result.sk = record.sk;
  if (typeof record.securityToken === 'string') result.securityToken = record.securityToken;
  if (typeof record.region === 'string') result.region = record.region;
  if (typeof record.endpoint === 'string') result.endpoint = record.endpoint;
  return result;
}

function isCodeArtsHome(): boolean {
  // #900: same context detector the resolveCredentials failure path uses —
  // the codearts flag must select the identical builder variant on both paths.
  return isCodeArtsContext();
}

function envHasRealTriplet(): boolean {
  return (
    !isPlaceholder(process.env.HW_ACCESS_KEY) &&
    Boolean(process.env.HW_ACCESS_KEY) &&
    !isPlaceholder(process.env.HW_SECRET_KEY) &&
    Boolean(process.env.HW_SECRET_KEY) &&
    !isPlaceholder(process.env.HW_SECURITY_TOKEN) &&
    Boolean(process.env.HW_SECURITY_TOKEN)
  );
}

// The onboarding step shape is the error-table leaf's GuidanceStep — one
// definition shared by computeOnboarding and the resolver's failure path.
export type OnboardingStep = GuidanceStep;

export interface OnboardingResult {
  needsSetup: boolean;
  scenario: number;
  reason: string;
  message: string;
  steps: OnboardingStep[];
  accountHint: string | null;
}

// Display paths (status/onboarding) degrade to the raw S1 read when a
// secret:// ref cannot resolve — scanState surfaces the failure as
// s1RefError, and a broken vault must not take auth_status down with it.
// Propagation paths (syncAuth) use the strict resolved read instead: writing
// a literal ref string into ~/.obsutilconfig or a KooCLI profile would
// corrupt both mirrors.
function readGlobalCredentialsForStatus(): CredentialRecord | null {
  try {
    return asCredentialRecord(readGlobalCredentialsResolved());
  } catch {
    return asCredentialRecord(readGlobalCredentials());
  }
}

// Onboarding guidance (scenarios 1-4) for credential setup.
// scenario: 1=S1 exists, no env/…; 2=conflict (S1 vs injected); 3=everything
// missing (fresh user); 4=S1 empty but injected creds exist (import candidate).
export function computeOnboarding({
  credentials,
  reconciled,
}: {
  credentials?: CredentialRecord | null;
  reconciled?: { hasRuntime?: boolean; s1RefError?: string | null };
} = {}): OnboardingResult {
  const creds = credentials ?? readGlobalCredentialsForStatus();
  const scan = reconciled ?? exportStateForStatus();
  const s1Has = Boolean(creds?.ak && creds?.sk && !isPlaceholder(creds.ak) && !isPlaceholder(creds.sk));
  const s4Creds = asCredentialRecord(readCodeArtsCredentials());
  const s4Has = Boolean(s4Creds?.ak && s4Creds?.sk);
  const injected = envHasRealTriplet();
  // env has real non-triplet creds that are NOT placeholders (e.g. devspace AK/SK w/o token)
  const envRealAk = !isPlaceholder(process.env.HW_ACCESS_KEY) && Boolean(process.env.HW_ACCESS_KEY);
  const envRealSk = !isPlaceholder(process.env.HW_SECRET_KEY) && Boolean(process.env.HW_SECRET_KEY);
  const envHasCreds = envRealAk && envRealSk;
  const codeArts = isCodeArtsHome();
  // A broken vault link makes the raw-ref fingerprint meaningless — the same
  // account shows a different hint when the vault works.
  const s1RefError = typeof scan.s1RefError === 'string' && scan.s1RefError ? scan.s1RefError : null;
  const accountHint = s1Has && !s1RefError ? fingerprint(creds?.ak, creds?.sk) : null;

  let scenario: number;
  let reason: string;
  let message: string;
  let steps: OnboardingStep[];

  if (scan.hasRuntime) {
    scenario = 0;
    reason = 'runtime-active';
    message = 'Runtime credentials are active; no setup needed.';
    return { needsSetup: false, scenario, reason, message, steps: [], accountHint };
  }
  if (envHasRealTriplet() && !s1Has) {
    scenario = 0;
    reason = 'platform-injected';
    message = 'Platform credentials are active; nothing to configure.';
    return { needsSetup: false, scenario, reason, message, steps: [], accountHint };
  }
  if (s4Has && !s1Has && !envHasCreds) {
    // CodeArts Work/IDE carries the user's temporary STS credentials in the MCP
    // settings file only (not surfaced in the UI, not in S1/env).
    scenario = 0;
    reason = 'mcp-settings-injected';
    message = '已从码道 MCP settings 读取到临时凭证,MCP 工具可直接使用。';
    return { needsSetup: false, scenario, reason, message, steps: [], accountHint };
  }
  if (s1Has && !envHasCreds) {
    scenario = 1;
    reason = 's1-only';
    message = accountHint ? `已保存账号(指纹 ${accountHint})可直接使用。` : '已保存账号可直接使用。';
    steps = [
      { order: 1, action: 'use-s1', args: {}, label: '直接使用已保存账号' },
      { order: 2, action: 'switch-new', args: { mode: 'import', action: 'persist' }, label: '改用新账号(导入)' },
    ];
  } else if (s1Has && envHasCreds) {
    // Covers both plain env creds (conflict) AND platform triplet when S1
    // exists. resolveCredentials' STS gate keeps S1 in front of a triplet,
    // so the effective account is S1 → scenario 1 semantics plus a note.
    if (injected) {
      scenario = 1;
      reason = 's1-with-platform-injected';
      message = accountHint
        ? `已保存账号(指纹 ${accountHint})优先于平台注入,可直接使用。`
        : '已保存账号优先于平台注入,可直接使用。';
      steps = [
        { order: 1, action: 'use-s1', args: {}, label: '使用已保存账号' },
        {
          order: 2,
          action: 'switch-platform',
          args: { mode: 'mcp-config', action: 'persist' },
          label: '改用平台注入账号',
        },
      ];
    } else {
      scenario = 2;
      reason = 'conflict';
      message = '检测到两套账号:已保存 与 环境注入,请选择其一。';
      steps = [
        {
          order: 1,
          action: 'switch-persist',
          args: { mode: 'memory', action: 'persist' },
          label: '使用已保存账号覆盖',
        },
        {
          order: 2,
          action: 'switch-env',
          args: { mode: 'mcp-config', action: 'persist' },
          label: '使用环境注入账号导入',
        },
      ];
    }
  } else if (!s1Has && envHasCreds && !injected) {
    scenario = 4;
    reason = 'import-injected';
    message = '检测到配置中已有有效账号,可导入为正式凭证。';
    steps = buildOnboardingSteps(4, { codearts: codeArts });
  } else {
    scenario = 3;
    reason = 's1-missing';
    message = '未配置华为云凭证,需要完成登录后才能使用云能力。';
    steps = buildOnboardingSteps(3, { codearts: codeArts });
  }

  if (s1RefError) {
    // S1 is configured but every value consumer throws: the "可直接使用"
    // claims above are false until the vault link is fixed. Annotate instead
    // of silently reporting a healthy account.
    message = `${message} ⚠ S1 中的 secret:// 引用无法解析:${s1RefError}`;
    steps = [
      ...steps,
      {
        order: steps.length + 1,
        action: 'fix-vault',
        args: {},
        label: '修复 vault(终端运行 npx huaweicloud-devkit secret list 检查)或将 S1 中的引用换回明文',
      },
    ];
  }
  return { needsSetup: true, scenario, reason, message, steps, accountHint };
}

// Compute temporary-STS expiry info for auth_status. Permanent AK/SK creds carry
// no security token and therefore have no expiry — we return null so callers only
// see expiry for the platform-injected temporary STS case.
function computeStsExpiry(): {
  expiresAt: number | null;
  expiresAtUtc: string | null;
  expiresAtLocal: string | null;
  remainingMs: number | null;
  status: string;
} | null {
  // The ACTIVE credential set (runtime-first), not the S1 display read: the
  // panel's "sts" half reflects what a tool call would actually authenticate
  // with right now.
  let creds;
  try {
    creds = asCredentialRecord(resolveCredentialsWithRuntime({ allowMissing: true }));
  } catch {
    creds = null;
  }
  if (!creds?.ak || !creds?.sk || !creds.securityToken) return null;
  const expiresAt = parseStsExpiry({ securityToken: creds.securityToken });
  if (expiresAt === null)
    return { status: 'unknown', expiresAt: null, expiresAtUtc: null, expiresAtLocal: null, remainingMs: null };
  const remainingMs = expiresAt - Date.now();
  const expiresAtUtc = new Date(expiresAt).toISOString();
  const expiresAtLocal = new Date(expiresAt).toString();
  let status = 'valid';
  if (remainingMs <= 0) status = 'expired';
  else if (remainingMs <= 5 * 60 * 1000) status = 'expiring_soon';
  return { expiresAt, expiresAtUtc, expiresAtLocal, remainingMs, status };
}

export function getAuthStatus(target = 'all') {
  const credentials = readGlobalCredentialsForStatus();
  const reconciled = { ...exportStateForStatus(), runtimeActive: hasRuntimeCredentials() };
  const hcloud = probeHcloud();
  const s4Creds = asCredentialRecord(readCodeArtsCredentials());
  const onboarding = computeOnboarding({ credentials, reconciled });
  const stsExpiry = computeStsExpiry();
  // The credential panel (#919 follow-up UX): one glance separates the
  // temporary STS (same source as the sandbox MCP session) from the permanent
  // S1 store, and names which one is active.
  const credentialPanel = {
    sts: stsExpiry,
    s1: {
      configured: Boolean(credentials?.ak && credentials?.sk),
      fingerprint: credentials?.ak ? fingerprint(credentials.ak, credentials.sk) : null,
      persistent: true, // permanent, no expiry
    },
    activeSource: stsExpiry ? 'temporary-sts' : credentials?.ak ? 's1-persistent' : 'none',
  };
  return {
    target,
    credentialsConfigured: Boolean(credentials?.ak && credentials?.sk),
    credentialsPath: globalCredentialsPath(),
    mcpSettingsConfigured: Boolean(s4Creds?.ak && s4Creds?.sk),
    mcpSettingsSource: s4Creds ? 'codearts' : null,
    stsExpiry,
    credentialPanel,
    obsConfigured: existsSync(obsConfigPath()),
    obsConfigPath: obsConfigPath(),
    kooCliInstalled: hcloud.installed,
    kooCliStatus: hcloud.status,
    kooCliNextStep: hcloudProbeNextStep(hcloud),
    kooCliRaw: hcloudProbeRaw(hcloud),
    reconciled,
    onboarding,
    agents: getAgentRegistrationStatuses(target).agents,
  };
}

interface ObsSyncTarget {
  configured: boolean;
  path: string;
  endpoint: string;
}

export interface SyncAuthFailure {
  ok: false;
  error: string;
  nextStep: string;
  code?: string;
  messageZh?: string;
  action?: string;
  raw?: string;
  obs?: ObsSyncTarget;
}

export interface SyncAuthSuccess {
  ok: true;
  profile: string;
  obs: ObsSyncTarget;
  hcloud: { ok: boolean; message: string };
  credentialsConfigured: boolean;
  agents: Record<string, AgentRegistrationStatus>;
  note: string;
  projectId?: string;
}

export type SyncAuthResult = SyncAuthSuccess | SyncAuthFailure;

export function syncAuth(target = 'all'): SyncAuthResult {
  // Strict resolved read through the shared seam: refs must become plaintext
  // BEFORE fanning out to S2/S3 (a literal secret:// string in
  // ~/.obsutilconfig or a KooCLI profile breaks both), and an unresolvable
  // ref fails the sync loud.
  const strict = readGlobalCredentialsStrict();
  if (!strict.ok) {
    return { ok: false, error: strict.error, nextStep: strict.nextStep };
  }
  const credentials = asCredentialRecord(strict.credentials);
  if (!credentials?.ak || !credentials?.sk) {
    // UX report #3 (2026-11-05): with session-scoped credentials active
    // (runtime tier or env injection) but nothing persisted in S1, the
    // generic HDKIT_CRED_MISSING read as "nothing configured" while
    // auth_status's reconciled panel showed the same process as configured.
    // auth_sync only ever propagates S1, so the honest answer names the tier
    // it can see and the persist path. The strict read stays FIRST — an
    // unresolvable S1 ref keeps its loud failure even with runtime active.
    let sessionCreds: ReturnType<typeof resolveCredentialsWithRuntime>;
    try {
      sessionCreds = resolveCredentialsWithRuntime({ allowMissing: true });
    } catch {
      sessionCreds = null;
    }
    const code = sessionCreds?.ak && sessionCreds?.sk ? 'HDKIT_SYNC_S1_MISSING_SESSION_ACTIVE' : 'HDKIT_CRED_MISSING';
    // #900: unified error shape from the shared ERROR_TABLE.
    const e = errorFromTable(code);
    return {
      ok: false,
      error: e.messageZh,
      code: e.code,
      messageZh: e.messageZh,
      action: e.action,
      nextStep: e.nextStep,
    };
  }
  if (hasRuntimeCredentials()) {
    // R10: runtime credentials suppress auto-sync. The codename stays in code
    // comments only, never in user-facing strings (#900).
    const e = errorFromTable('HDKIT_SYNC_SKIPPED_RUNTIME');
    return {
      ok: false,
      error: e.messageZh,
      code: e.code,
      messageZh: e.messageZh,
      action: e.action,
      nextStep: e.nextStep,
    };
  }

  let obs: { path: string; endpoint: string };
  try {
    obs = writeObsConfig(credentials);
  } catch (error) {
    const missingRegion = !String(credentials?.region || '').trim();
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      nextStep: missingRegion
        ? 'Credential region is missing — run huaweicloud_auth_switch action=persist with --region, or add "region" to creds-import.json and re-import.'
        : 'Run "npx huaweicloud-devkit auth init" to refresh credentials and region.',
    };
  }

  const profile = resolveManagedProfile();
  if (!profile) {
    return {
      ok: false,
      error: 'KooCLI current profile unresolved; run "npx huaweicloud-devkit auth init" in a real terminal.',
      nextStep: 'Run "npx huaweicloud-devkit auth init" in a real terminal to create the KooCLI current profile.',
      obs: { configured: true, path: obs.path, endpoint: obs.endpoint },
    };
  }

  const hcloud = probeHcloud();
  if (!hcloud.ok) {
    // #900: three probe states share the table code; the detail distinguishes.
    const detail =
      hcloud.status === 'sandbox_home_failure'
        ? '无法解析用户主目录'
        : hcloud.status === 'privacy_pending'
          ? '隐私协议待同意'
          : '';
    const e = errorFromTable('HDKIT_KOOCLI_NOT_READY', detail);
    return {
      ok: false,
      error: e.messageZh,
      code: e.code,
      messageZh: e.messageZh,
      action: e.action,
      // #900 issue comment: nextStep is the executable table action; the
      // verbose English guidance survives only in the `raw` side-channel.
      nextStep: hcloudProbeNextStep(hcloud),
      raw: hcloudProbeRaw(hcloud),
      obs: { configured: true, path: obs.path, endpoint: obs.endpoint },
    };
  }

  // #920: the same purge the persist path walks — `configure set` refuses an
  // empty --cli-security-token, so a stale token in the profile would survive
  // this sync and poison every hcloud call with APIGW.0301 while syncAuth
  // still reports ok. Best-effort, shared seam, nothing to clean is fine —
  // but the outcome is SURFACED (profileReset), never silently swallowed.
  const purge = runHcloudProfileDelete(profile);
  const profileReset = purge.ok || /not (exist|found)/i.test(purge.error || '');

  const { ok, error } = runHcloudConfigure(profile, credentials.ak, credentials.sk, credentials.region);
  if (!ok) {
    // #900: `hcloud configure set` failures are usually a missing/invalid
    // project_id for the target region; anything else keeps the raw (already
    // redacted) stderr as the detail argument.
    const detail = String(error || '').trim();
    const projectIdCause = /project[_\s-]?id/i.test(detail);
    const e = projectIdCause
      ? errorFromTable('HDKIT_PROJECT_ID_MISSING', detail)
      : errorFromTable('HDKIT_KOOCLI_NOT_READY', detail || 'KooCLI 配置同步失败');
    // For the non-projectId configure failure the table's KOOCLI_NOT_READY
    // action ("install-hcloud") would advise reinstalling a CLI the probe just
    // passed — the coherent remediation is the survivor's auth-init refresh,
    // so action follows nextStep's verb instead of the table default.
    const configureFailureAction = projectIdCause ? e.action : 'npx huaweicloud-devkit auth init';
    return {
      ok: false,
      error: e.messageZh,
      code: e.code,
      messageZh: e.messageZh,
      action: configureFailureAction,
      nextStep: projectIdCause
        ? e.nextStep
        : 'Run "npx huaweicloud-devkit auth init" in a real terminal to refresh the KooCLI config.',
      obs: { configured: true, path: obs.path, endpoint: obs.endpoint },
    };
  }

  const project = resolveAndApplyProjectId({ region: credentials.region, profile });

  writeLastSync({ kooCliProfile: profile, s1Fingerprint: fingerprint(credentials.ak, credentials.sk) });

  const result: SyncAuthSuccess = {
    ok: true,
    profile,
    obs: { configured: true, path: obs.path, endpoint: obs.endpoint },
    hcloud: {
      ok: true,
      message: profileReset
        ? `KooCLI config synced to profile=${profile}`
        : `KooCLI config synced to profile=${profile} (profile reset failed: ${
            purge.error || 'unknown error'
          } — a stale security token may survive the sync)`,
    },
    credentialsConfigured: true,
    agents: getAgentRegistrationStatuses(target).agents,
    note: 'OBS credentials were synced from the global credential vault. Agent MCP registration is managed by "npx huaweicloud-devkit install --target <agent>".',
  };
  if (project.ok) {
    result.projectId = project.projectId;
  } else {
    // The purge above wiped the profile's cli-project-id, and the restoration
    // failed — a lie-by-omission here would leave region-scoped calls broken
    // with APIGW.0301 on an ok:true result (the round-4 review gap).
    result.hcloud.message += ` (project-id not restored after the profile reset: ${project.reason} — region-scoped hcloud calls may fail with APIGW.0301 until configured)`;
  }
  return result;
}
