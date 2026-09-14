import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { getAgentRegistrationStatuses } from './agent-registration.mjs';
import { resolveAndApplyProjectId } from './project-id.mjs';
import {
  globalCredentialsPath,
  isPlaceholder,
  obsConfigPath,
  readGlobalCredentials,
  writeLastSync,
  writeObsConfig,
} from './credentials.mjs';
import {
  fingerprint,
  exportStateForStatus,
  hasRuntimeCredentials,
  resolveManagedProfile,
  runHcloudConfigure,
} from './reconcile.mjs';
import { hcloudProbeNextStep, probeHcloud } from '../hcloud-probe.mjs';

function isCodeArtsHome() {
  return (
    existsSync(join(process.cwd(), '.codeartsdoer')) ||
    existsSync(join(homedir(), '.codeartsdoer')) ||
    existsSync(join(homedir(), '.codeartswork'))
  );
}

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
  const injected = envHasRealTriplet();
  // env has real non-triplet creds that are NOT placeholders (e.g. devspace AK/SK w/o token)
  const envRealAk = !isPlaceholder(process.env.HW_ACCESS_KEY) && Boolean(process.env.HW_ACCESS_KEY);
  const envRealSk = !isPlaceholder(process.env.HW_SECRET_KEY) && Boolean(process.env.HW_SECRET_KEY);
  const envHasCreds = envRealAk && envRealSk;
  const codeArts = isCodeArtsHome();
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
    scenario = 0; // platform injection, nothing to do
    reason = 'platform-injected';
    message = 'Platform credentials are active; nothing to configure.';
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
  } else if (s1Has && envHasCreds && !injected) {
    scenario = 2;
    reason = 'conflict';
    message = '检测到两套账号:已保存 与 环境注入,请选择其一。';
    steps = [
      { order: 1, action: 'switch-persist', args: { mode: 'memory', action: 'persist' }, label: '使用已保存账号覆盖' },
      {
        order: 2,
        action: 'switch-env',
        args: { mode: 'mcp-config', action: 'persist' },
        label: '使用环境注入账号导入',
      },
    ];
  } else if (!s1Has && envHasCreds && !injected) {
    scenario = 4;
    reason = 'import-injected';
    message = '检测到配置中已有有效账号,可导入为正式凭证。';
    steps = [
      {
        order: 1,
        action: 'switch-persist',
        args: { mode: codeArts ? 'mcp-config' : 'import', action: 'persist' },
        label: '导入该账号',
      },
    ];
  } else {
    scenario = 3;
    reason = 's1-missing';
    message = '未配置华为云凭证,需要完成登录后才能使用云能力。';
    steps = [
      { order: 1, action: 'obtain-aksk', target: 'console', label: '获取 AK/SK(华为云控制台)' },
      ...(codeArts
        ? [
            {
              order: 2,
              action: 'write-import',
              target: join(homedir(), '.config', 'huaweicloud', 'creds-import.json'),
              label: '把 AK/SK 写入 creds-import.json',
            },
            { order: 3, action: 'auth_switch', args: { mode: 'import', action: 'persist' }, label: '执行导入完成配置' },
          ]
        : [{ order: 2, action: 'auth-init', args: {}, label: '运行 npx huaweicloud-devkit auth init' }]),
    ];
  }

  return { needsSetup: true, scenario, reason, message, steps, accountHint };
}

export function getAuthStatus(target = 'all') {
  const credentials = readGlobalCredentials();
  const reconciled = { ...exportStateForStatus(), runtimeActive: hasRuntimeCredentials() };
  const hcloud = probeHcloud();
  const onboarding = computeOnboarding({ credentials, reconciled });
  return {
    target,
    credentialsConfigured: Boolean(credentials?.ak && credentials?.sk),
    credentialsPath: globalCredentialsPath(),
    obsConfigured: existsSync(obsConfigPath()),
    obsConfigPath: obsConfigPath(),
    kooCliInstalled: hcloud.installed,
    kooCliStatus: hcloud.status,
    kooCliNextStep: hcloudProbeNextStep(hcloud),
    reconciled,
    onboarding,
    agents: getAgentRegistrationStatuses(target).agents,
  };
}

export function syncAuth(target = 'all') {
  const credentials = readGlobalCredentials();
  if (!credentials?.ak || !credentials?.sk) {
    return {
      ok: false,
      error: 'Global credentials are not configured.',
      nextStep: 'Run "npx huaweicloud-devkit auth init" first.',
    };
  }
  if (hasRuntimeCredentials()) {
    return {
      ok: false,
      error: 'Runtime credentials are active; auto-sync suppressed (R10).',
      nextStep: 'Run huaweicloud_auth_switch action=clear or action=persist first.',
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
    return {
      ok: false,
      error:
        hcloud.status === 'sandbox_home_failure'
          ? 'KooCLI detected but cannot resolve the user home directory in this agent sandbox.'
          : hcloud.status === 'privacy_pending'
            ? 'KooCLI privacy agreement is pending.'
            : 'KooCLI not ready.',
      nextStep: hcloudProbeNextStep(hcloud),
      obs: { configured: true, path: obs.path, endpoint: obs.endpoint },
    };
  }

  const { ok, error } = runHcloudConfigure(profile, credentials.ak, credentials.sk, credentials.region);
  if (!ok) {
    return {
      ok: false,
      error: error || 'KooCLI config sync failed',
      nextStep: 'Run "npx huaweicloud-devkit auth init" in a real terminal to refresh the KooCLI config.',
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
