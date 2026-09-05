import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

import { getAgentRegistrationStatuses } from './agent-registration.mjs';
import {
  globalCredentialsPath,
  obsConfigPath,
  readGlobalCredentials,
  writeLastSync,
  writeObsConfig,
} from './credentials.mjs';
import {
  exportStateForStatus,
  hasRuntimeCredentials,
  resolveManagedProfile,
  runHcloudConfigure,
} from './reconcile.mjs';

function hcloudInstalled() {
  const bin = process.env.HCLOUD_BIN || 'hcloud';
  try {
    const r = spawnSync(`"${bin}" version`, [], {
      shell: true,
      windowsHide: true,
      stdio: 'pipe',
      timeout: 5000,
    });
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    return r.status === 0 && /KooCLI|Current.*version|当前KooCLI/i.test(out);
  } catch {
    return false;
  }
}

export function getAuthStatus(target = 'all') {
  const credentials = readGlobalCredentials();
  const reconciled = { ...exportStateForStatus(), runtimeActive: hasRuntimeCredentials() };
  return {
    target,
    credentialsConfigured: Boolean(credentials?.ak && credentials?.sk),
    credentialsPath: globalCredentialsPath(),
    obsConfigured: existsSync(obsConfigPath()),
    obsConfigPath: obsConfigPath(),
    kooCliInstalled: hcloudInstalled(),
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
    return {
      ok: false,
      error: error.message,
      nextStep: 'Run "npx huaweicloud-devkit auth init" to refresh credentials and region.',
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

  if (!hcloudInstalled()) {
    return {
      ok: false,
      error: 'KooCLI not installed.',
      nextStep: 'Install KooCLI or point HCLOUD_BIN at the hcloud executable.',
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

  writeLastSync();

  return {
    ok: true,
    profile,
    obs: { configured: true, path: obs.path, endpoint: obs.endpoint },
    hcloud: { ok: true, message: `KooCLI config synced to profile=${profile}` },
    credentialsConfigured: true,
    agents: getAgentRegistrationStatuses(target).agents,
    note: 'OBS credentials were synced from the global credential vault. Agent MCP registration is managed by "npx huaweicloud-devkit install --target <agent>".',
  };
}
