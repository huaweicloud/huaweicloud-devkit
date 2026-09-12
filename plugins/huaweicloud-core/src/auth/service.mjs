import { existsSync } from 'node:fs';

import { getAgentRegistrationStatuses } from './agent-registration.mjs';
import { resolveAndApplyProjectId } from './project-id.mjs';
import {
  globalCredentialsPath,
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

export function getAuthStatus(target = 'all') {
  const credentials = readGlobalCredentials();
  const reconciled = { ...exportStateForStatus(), runtimeActive: hasRuntimeCredentials() };
  const hcloud = probeHcloud();
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
