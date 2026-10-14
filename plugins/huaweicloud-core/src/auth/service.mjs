import { existsSync } from 'node:fs';

import { getAgentRegistrationStatuses } from './agent-registration.mjs';
import { resolveAndApplyProjectId } from './project-id.mjs';
import {
  globalCredentialsPath,
  isCodeArtsContext,
  isPlaceholder,
  obsConfigPath,
  parseStsExpiry,
  readCodeArtsCredentials,
  readGlobalCredentials,
  resolveCredentialsWithRuntime,
  writeLastSync,
  writeObsConfig,
} from './credentials.mjs';
import { buildOnboardingSteps, errorFromTable } from './guidance.mjs';
import {
  fingerprint,
  exportStateForStatus,
  hasRuntimeCredentials,
  resolveManagedProfile,
  runHcloudConfigure,
} from './reconcile.mjs';
import { hcloudProbeNextStep, hcloudProbeRaw, probeHcloud } from '../hcloud-probe.mjs';

function envHasRealTriplet() {
  return (
    !isPlaceholder(process.env.HW_ACCESS_KEY) &&
    Boolean(process.env.HW_ACCESS_KEY) &&
    !isPlaceholder(process.env.HW_SECRET_KEY) &&
    Boolean(process.env.HW_SECRET_KEY) &&
    !isPlaceholder(process.env.HW_SECURITY_TOKEN) &&
    Boolean(process.env.HW_SECURITY_TOKEN)
  );
}

// Onboarding guidance (scenarios 1-4) for credential setup.
// scenario: 1=S1 exists, no env/…; 2=conflict (S1 vs injected); 3=everything
// missing (fresh user); 4=S1 empty but injected creds exist (import candidate).
export function computeOnboarding({ credentials, reconciled } = {}) {
  const creds = credentials ?? readGlobalCredentials();
  const scan = reconciled ?? exportStateForStatus();
  const s1Has = Boolean(creds?.ak && creds?.sk && !isPlaceholder(creds.ak) && !isPlaceholder(creds.sk));
  const s4Creds = readCodeArtsCredentials();
  const s4Has = Boolean(s4Creds?.ak && s4Creds?.sk);
  const injected = envHasRealTriplet();
  // env has real non-triplet creds that are NOT placeholders (e.g. devspace AK/SK w/o token)
  const envRealAk = !isPlaceholder(process.env.HW_ACCESS_KEY) && Boolean(process.env.HW_ACCESS_KEY);
  const envRealSk = !isPlaceholder(process.env.HW_SECRET_KEY) && Boolean(process.env.HW_SECRET_KEY);
  const envHasCreds = envRealAk && envRealSk;
  // Same context detector the resolveCredentials failure path uses (#900): the
  // codearts flag must select the identical builder variant on both paths.
  const codeArts = isCodeArtsContext();
  const accountHint = s1Has ? fingerprint(creds.ak, creds.sk) : null;

  let scenario;
  let reason;
  let message;
  let steps;

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
    message = `已保存账号(指纹 ${accountHint})可直接使用。`;
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
      message = `已保存账号(指纹 ${accountHint})优先于平台注入,可直接使用。`;
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

  return { needsSetup: true, scenario, reason, message, steps, accountHint };
}

// Compute temporary-STS expiry info for auth_status. Permanent AK/SK creds carry
// no security token and therefore have no expiry — we return null so callers only
// see expiry for the platform-injected temporary STS case.
function computeStsExpiry() {
  let creds;
  try {
    creds = resolveCredentialsWithRuntime({ allowMissing: true });
  } catch {
    creds = null;
  }
  if (!creds?.ak || !creds?.sk || !creds.securityToken) return null;
  const expiresAt = parseStsExpiry({ securityToken: creds.securityToken });
  if (expiresAt === null) return { status: 'unknown', expiresAt: null };
  const remainingMs = expiresAt - Date.now();
  const expiresAtUtc = new Date(expiresAt).toISOString();
  const expiresAtLocal = new Date(expiresAt).toString();
  let status = 'valid';
  if (remainingMs <= 0) status = 'expired';
  else if (remainingMs <= 5 * 60 * 1000) status = 'expiring_soon';
  return { expiresAt, expiresAtUtc, expiresAtLocal, remainingMs, status };
}

export function getAuthStatus(target = 'all') {
  const credentials = readGlobalCredentials();
  const reconciled = { ...exportStateForStatus(), runtimeActive: hasRuntimeCredentials() };
  const hcloud = probeHcloud();
  const s4Creds = readCodeArtsCredentials();
  const onboarding = computeOnboarding({ credentials, reconciled });
  const stsExpiry = computeStsExpiry();
  const credentialPanel = {
    sts: stsExpiry, // 临时 STS（MCP==沙箱同源）
    s1: {
      configured: Boolean(credentials?.ak && credentials?.sk),
      fingerprint: credentials?.ak ? fingerprint(credentials.ak, credentials.sk) : null,
      persistent: true, // 永久，无过期
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

export function syncAuth(target = 'all') {
  const credentials = readGlobalCredentials();
  if (!credentials?.ak || !credentials?.sk) {
    // #900: unified error shape from the shared ERROR_TABLE.
    const e = errorFromTable('HDKIT_CRED_MISSING');
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

  let obs;
  try {
    obs = writeObsConfig(credentials);
  } catch (error) {
    const missingRegion = !String(credentials?.region || '').trim();
    return {
      ok: false,
      error: error.message,
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
    return {
      ok: false,
      error: e.messageZh,
      code: e.code,
      messageZh: e.messageZh,
      action: e.action,
      nextStep: projectIdCause
        ? e.nextStep
        : 'Run "npx huaweicloud-devkit auth init" in a real terminal to refresh the KooCLI config.',
      obs: { configured: true, path: obs.path, endpoint: obs.endpoint },
    };
  }

  const project = resolveAndApplyProjectId({ region: credentials.region, profile });

  writeLastSync({ kooCliProfile: profile, s1Fingerprint: fingerprint(credentials.ak, credentials.sk) });

  const result = {
    ok: true,
    profile,
    obs: { configured: true, path: obs.path, endpoint: obs.endpoint },
    hcloud: { ok: true, message: `KooCLI config synced to profile=${profile}` },
    credentialsConfigured: true,
    agents: getAgentRegistrationStatuses(target).agents,
    note: 'OBS credentials were synced from the global credential vault. Agent MCP registration is managed by "npx huaweicloud-devkit install --target <agent>".',
  };
  if (project.ok) result.projectId = project.projectId;
  return result;
}
