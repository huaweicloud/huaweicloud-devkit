import { z } from 'zod';

import { getAuthStatus, syncAuth } from '../../auth/service.ts';
import {
  setRuntimeCredentials,
  clearRuntimeCredentials,
  readGlobalCredentialsStrict,
  backupGlobalCredentials,
  readCodeArtsCredentials,
} from '../../auth/credentials.ts';
import { fingerprint } from '../../auth/reconcile.ts';
import {
  persistCredentials,
  readImportFile,
  clearImportFile,
  pendingConfirms,
  refreshUserHashAfterAuthChange,
} from '../../lib/credentials.ts';
import { resolveSecretValue } from '../../lib/secret-vault/store.ts';
import type { PackToolDefinition, LooseToolSchema } from '../../lib/pack-types.ts';
import type { CallToolOptions, ToolArgs } from '../../tools.ts';

// Handlers migrated verbatim from src/tools.ts; CallToolOptions
// (sessionId/doQuery) is passed through unchanged by the delegating case.

async function handleAuthStatus(args: ToolArgs = {}, _opts: CallToolOptions = {}) {
  return getAuthStatus(args.target || 'all');
}

async function handleAuthSync(args: ToolArgs = {}, _opts: CallToolOptions = {}) {
  const result = syncAuth(args.target || 'all');
  refreshUserHashAfterAuthChange();
  return result;
}

async function handleAuthInit(args: ToolArgs = {}, _opts: CallToolOptions = {}) {
  if (args.clear) {
    clearRuntimeCredentials();
    refreshUserHashAfterAuthChange({ regenerate: false });
    return { status: 'cleared', message: 'Runtime credentials cleared. Fallback to env/file.' };
  }
  if (!args.ak || !args.sk) {
    throw new Error('ak and sk are required. Set clear=true to clear runtime credentials.');
  }
  // Incoming values may be secret:// refs. Resolve them so the runtime store
  // carries usable credentials (same contract as auth_switch and the CLI's
  // auth init); an unresolvable ref throws VaultError with its own
  // remediation.
  const ak = resolveSecretValue(args.ak) ?? args.ak;
  const sk = resolveSecretValue(args.sk) ?? args.sk;
  const region = resolveSecretValue(args.region) ?? args.region;
  setRuntimeCredentials(ak, sk, undefined, region);
  refreshUserHashAfterAuthChange();
  return { status: 'ok', message: 'Runtime credentials set for this MCP session.' };
}

async function handleAuthSwitch(args: ToolArgs = {}, _opts: CallToolOptions = {}) {
  const action = args.action || 'temporary';
  if (action === 'clear') {
    clearRuntimeCredentials();
    refreshUserHashAfterAuthChange({ regenerate: false });
    return { status: 'cleared', message: 'Runtime credentials cleared. Fallback to env/file/S1.' };
  }

  let ak = args.ak || '';
  let sk = args.sk || '';
  let securityToken = args.securityToken || '';
  let region = args.region || '';
  const sourceChannel = args.mode || 'memory';
  let importedFromFile = false;

  if (sourceChannel === 'import' && (!ak || !sk)) {
    const imported = readImportFile();
    if (imported) {
      ({ ak, sk, securityToken, region } = imported);
      importedFromFile = true;
    }
  }
  if (sourceChannel === 'mcp-config' && (!ak || !sk)) {
    const cc = readCodeArtsCredentials();
    if (cc) {
      ak = cc.ak;
      sk = cc.sk;
      securityToken = cc.securityToken || '';
      region = cc.region || region;
    }
  }

  // Incoming values may be secret:// refs (mode=memory with refs, or an
  // import file carrying them). Resolve before any comparison or fan-out:
  // the conflict check and displayed fingerprints must compare plaintext,
  // and persistCredentials' mirrors must never see a literal ref string.
  // An unresolvable ref throws VaultError with its own remediation.
  ak = resolveSecretValue(ak) ?? ak;
  sk = resolveSecretValue(sk) ?? sk;
  securityToken = resolveSecretValue(securityToken) ?? securityToken;

  if (!ak || !sk) {
    throw new Error('ak and sk are required (or provide creds-import.json for mode=import).');
  }

  if (action === 'persist' && !String(region || '').trim()) {
    return {
      status: 'error',
      scope: 'invalid_region',
      error:
        'region is required to persist credentials. Pass --region, or include "region" in creds-import.json (mode=import).',
    };
  }

  if (action === 'temporary') {
    setRuntimeCredentials(ak, sk, securityToken || undefined, region);
    refreshUserHashAfterAuthChange();
    if (importedFromFile) clearImportFile();
    return {
      status: 'ok',
      scope: 'temporary',
      note: 'Runtime credentials active for this MCP process. hcloud commands still use the KooCLI current profile; use action=persist to align files.',
    };
  }

  // action === 'persist'
  // Strict resolved read through the shared seam: the conflict check and
  // displayed fingerprints must compare plaintext against plaintext when S1
  // holds secret:// refs, and an unresolvable ref fails loud instead of
  // fingerprinting the ref string.
  const prevRead = readGlobalCredentialsStrict();
  if (!prevRead.ok) throw new Error(`${prevRead.error} Next: ${prevRead.nextStep}`);
  const prev = prevRead.credentials;
  const conflict = prev?.ak && prev.ak !== ak;
  if (conflict) {
    backupGlobalCredentials();
    const token = `switch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    pendingConfirms.set(token, {
      newAk: ak,
      newSk: sk,
      newSecurityToken: securityToken,
      newRegion: region,
      oldFingerprint: fingerprint(prev.ak, prev.sk),
      newFingerprint: fingerprint(ak, sk),
      fromImport: importedFromFile,
    });
    return {
      status: 'needs_confirmation',
      confirmToken: token,
      options: [
        { key: 's1', label: '以 S1 现有账号为准（不切换，恢复 backup）' },
        { key: 'newImported', label: `以新账号（${fingerprint(ak, sk)}）为准，覆盖 S1 并同步全部凭证文件` },
      ],
    };
  }

  const persisted = persistCredentials(ak, sk, securityToken, region);
  // Clear the import file for non-replayable outcomes (success, or an
  // unfixable rejection such as STS R3). Keep it only for a retryable
  // 'partial' (S1 written but a mirror failed).
  if (importedFromFile && persisted.status !== 'partial') clearImportFile();
  refreshUserHashAfterAuthChange();
  return persisted;
}

async function handleAuthConfirm(args: ToolArgs = {}, _opts: CallToolOptions = {}) {
  const pending = pendingConfirms.get(args.token || '');
  if (!pending) throw new Error('confirmToken not found or expired.');
  pendingConfirms.delete(args.token || '');
  if (args.decision === 's1') {
    return { status: 'ok', outcome: 'aborted', message: '保持 S1 现有账号，未覆盖。' };
  }
  const confirmed = persistCredentials(pending.newAk, pending.newSk, pending.newSecurityToken, pending.newRegion);
  if (pending.fromImport && confirmed.status !== 'partial') clearImportFile();
  refreshUserHashAfterAuthChange();
  return confirmed;
}

const authStatusSchema = z.looseObject({
  target: z
    .string()
    .optional()
    .describe(
      'Agent target to check: opencode, codex, codex-desktop, codearts, codearts-work, workbuddy, dsh, officeace, hermes, openclaw, atomcode, or all (default).',
    ),
});

const authSyncSchema = z.looseObject({
  target: z
    .string()
    .optional()
    .describe(
      'Agent target to report after sync: opencode, codex, codex-desktop, codearts, codearts-work, workbuddy, dsh, officeace, hermes, or all (default).',
    ),
});

const authInitSchema = z.looseObject({
  ak: z.string().optional().describe('Huawei Cloud Access Key (required unless clear=true)'),
  sk: z.string().optional().describe('Huawei Cloud Secret Key (required unless clear=true)'),
  region: z.string().optional().describe('Default region (optional)'),
  clear: z.boolean().optional().describe('Set to true to clear runtime credentials and revert to env/file'),
});

const authSwitchSchema = z.looseObject({
  mode: z.enum(['import', 'memory', 'mcp-config']).optional().describe('Credential source channel'),
  action: z.enum(['persist', 'temporary', 'clear']).optional().describe('Apply scope'),
  ak: z.string().optional(),
  sk: z.string().optional(),
  securityToken: z.string().optional(),
  region: z.string().optional(),
});

const authConfirmSchema = z.looseObject({
  token: z.string().optional().describe('confirmation token from the needs_confirmation response'),
  decision: z.enum(['s1', 'newImported']).optional(),
});

export const AUTH_TOOLS = [
  {
    name: 'huaweicloud_auth_status',
    description:
      'Check unified Huawei Cloud authentication status across the global credential vault, OBS, KooCLI, and all supported agent MCP registrations. Returns only redacted/status information, never credentials.',
    schema: authStatusSchema,
    handler: handleAuthStatus,
  },
  {
    name: 'huaweicloud_auth_sync',
    description:
      'Synchronize credentials from the global Huawei Cloud credential vault to OBS and report agent registration status. Does not write secrets into any agent config.',
    schema: authSyncSchema,
    handler: handleAuthSync,
  },
  {
    name: 'huaweicloud_auth_init',
    description:
      'Set or clear runtime Huawei Cloud credentials (AK/SK) for this MCP session. Runtime credentials take highest priority over environment variables and config files for all subsequent API calls. Use when switching accounts within the same Agent session — call with AK/SK to switch, or with clear=true to fall back to env/file credentials.',
    schema: authInitSchema,
    handler: handleAuthInit,
  },
  {
    name: 'huaweicloud_auth_switch',
    description:
      'Switch Huawei Cloud credentials within the current session. action=temporary keeps AK/SK in memory only (restart loses them; hcloud commands are unaffected and an A+C warning will be raised). action=persist writes S1 (single source of truth) with configuredBySession flag and propagates to S2 (KooCLI current profile) and S3 (OBS). action=clear resets runtime credentials. mode=import reads AK/SK from ~/.config/huaweicloud/creds-import.json then wipes it (SK never enters conversation). mode=memory passes AK/SK as tool arguments (SK is visible to model - prefer import). mode=mcp-config reads the injected mcp_settings environment.',
    schema: authSwitchSchema,
    handler: handleAuthSwitch,
  },
  {
    name: 'huaweicloud_auth_confirm',
    description:
      'Confirm a pending credential reconciliation choice returned by auth_switch persist when S1 already holds a different account (R2). decision=s1 keeps S1 as source of truth and propagates it; decision=newImported propagates the newly imported account into S1 and mirrors.',
    schema: authConfirmSchema,
    handler: handleAuthConfirm,
  },
] as const satisfies readonly PackToolDefinition[];

export type AuthToolName = (typeof AUTH_TOOLS)[number]['name'];

// Schema map keyed by tool name for src/tool-schemas.ts: TOOL_SCHEMAS spreads
// it in place, keeping the satisfies Record<ToolName, LooseToolSchema>
// completeness check over every ToolName key.
export const AUTH_TOOL_SCHEMAS: Readonly<Record<AuthToolName, LooseToolSchema>> = {
  huaweicloud_auth_status: authStatusSchema,
  huaweicloud_auth_sync: authSyncSchema,
  huaweicloud_auth_init: authInitSchema,
  huaweicloud_auth_switch: authSwitchSchema,
  huaweicloud_auth_confirm: authConfirmSchema,
};

// Dispatch map merged into PACK_TOOL_HANDLERS in packs/registry.ts. Typed over
// AuthToolName, so a tool added to AUTH_TOOLS without a handler entry
// here — or the reverse — fails to compile instead of failing at runtime.
export const AUTH_TOOL_HANDLERS: Readonly<Record<AuthToolName, PackToolDefinition['handler']>> = {
  huaweicloud_auth_status: handleAuthStatus,
  huaweicloud_auth_sync: handleAuthSync,
  huaweicloud_auth_init: handleAuthInit,
  huaweicloud_auth_switch: handleAuthSwitch,
  huaweicloud_auth_confirm: handleAuthConfirm,
};
