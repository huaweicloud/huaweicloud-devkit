import { randomBytes } from 'node:crypto';

import { execOneShot, execWithSession, getCurrentWorkspaceId } from '../../sandbox/session-manager.ts';
import { hdkitCredentials } from '../../lib/hdkit/hdkitservice-api.ts';
import { getCredentials } from '../../lib/hdkit/hwlink-api.ts';
import { validateIamCredentials } from '../../auth/credential-validator.ts';
import { resolveCredentialsWithRuntime } from '../../auth/credentials.ts';
import { asCredentialRecord, type CredentialLike } from '../../lib/credentials.ts';
import { vaultGet, VaultError } from '../../lib/secret-vault/store.ts';
import { isSecretRef } from '../../lib/secret-vault/refs.ts';
import type { CallToolOptions, ToolArgs } from '../../tools.ts';

// The credentials handler for the sandbox pack, extracted verbatim from
// tools.ts in the within-pack split for the jscpd complex-file bar; the
// tools.ts face imports it for SANDBOX_TOOL_HANDLERS. Owns the vault-ref
// api_key resolution, the IAM pre-validation, and the /tmp creds-file
// injection pair (hw_creds.sh + hw_api_key).

// POSIX single-quote escaping for every generated export line: vault values
// are arbitrary user strings, and an unescaped `'` in a value would either
// break the sourced script or inject commands into the sandbox shell.
function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export async function handleCredentials(args: ToolArgs = {}, _opts: CallToolOptions = {}) {
  const devStageId = args.dev_stage_id || getCurrentWorkspaceId();
  let resolved: CredentialLike | null;
  let resolveError: unknown;
  try {
    resolved = asCredentialRecord(resolveCredentialsWithRuntime());
  } catch (error) {
    resolved = null;
    resolveError = error;
  }
  if (!resolved?.ak || !resolved?.sk) {
    // A broken S1 vault link is NOT "not configured" — and the auth init
    // remediation would overwrite the refs with plaintext. Distinguish.
    if (resolveError instanceof VaultError) {
      return {
        ok: false,
        error: `Stored credentials use a secret vault ref that cannot be resolved: ${resolveError.message}`,
        hint: 'Fix the vault (check "npx huaweicloud-devkit secret list" from a terminal; the master key may be missing or rotated) or replace the refs in ~/.config/huaweicloud/credentials.json with plaintext.',
      };
    }
    return {
      ok: false,
      error: 'Huawei Cloud credentials are not configured. Nothing was injected into the sandbox.',
      hint: 'Run "npx huaweicloud-devkit auth init" or set HW_ACCESS_KEY/HW_SECRET_KEY, then retry.',
    };
  }
  const validation = await validateIamCredentials({
    ak: resolved.ak,
    sk: resolved.sk,
    securityToken: resolved.securityToken,
    region: args.region || resolved.region,
  });
  if (!validation.valid && !validation.skipped) {
    return {
      ok: false,
      error: 'Credential validation failed before injection: ' + validation.error,
      hint: 'Credentials were NOT injected into the sandbox. Fix AK/SK first: run "npx huaweicloud-devkit auth init" or correct HW_ACCESS_KEY/HW_SECRET_KEY, then retry.',
    };
  }
  const credResult = await hdkitCredentials(args.session_id, devStageId, args.enable_sts !== false);
  const sandboxWsIdCred = args.dev_stage_id || getCurrentWorkspaceId();
  // The DevBridge API Key is a LONG-LIVED account-level credential (no expiry, manual
  // revocation only) — unlike the temporary STS AK/SK. It is stored in its own file
  // (/tmp/hw_api_key, 0600) so an accidental dump of /tmp/hw_creds.sh never exposes it,
  // and the local HW_API_KEY env takes precedence over the tool param so the key can be
  // delivered without entering the conversation. The param also accepts a vault ref
  // (secret://<scope>/<name>), resolved here so the plaintext stays out of the
  // conversation and out of argv.
  const rawApiKey = process.env.HW_API_KEY || args.api_key || '';
  let apiKey = rawApiKey;
  if (isSecretRef(rawApiKey)) {
    try {
      apiKey = vaultGet(rawApiKey).value;
    } catch (error) {
      return {
        ok: false,
        error: `Cannot resolve the api_key vault ref: ${error instanceof Error ? error.message : String(error)}`,
        hint: 'Check the ref with "npx huaweicloud-devkit secret list" from your terminal, or pass the key via the local HW_API_KEY environment variable.',
      };
    }
  }
  const apiKeyFile = '/tmp/hw_api_key';
  if (sandboxWsIdCred) {
    try {
      const { ak, sk, securitytoken } = getCredentials();
      const credsScript = [
        `export HW_ACCESS_KEY=${shellSingleQuote(ak)}`,
        `export HW_SECRET_KEY=${shellSingleQuote(sk)}`,
        securitytoken ? `export HW_SECURITY_TOKEN=${shellSingleQuote(securitytoken)}` : '',
        securitytoken ? `export X_HW_SECURITY_TOKEN=${shellSingleQuote(securitytoken)}` : '',
        validation.projectId ? `export HW_PROJECT_ID=${shellSingleQuote(validation.projectId)}` : '',
      ]
        .filter(Boolean)
        .join('\n');
      const credsFile = '/tmp/hw_creds.sh';
      // Random per-call heredoc delimiter: vault values are arbitrary user
      // strings, and a fixed delimiter line inside a value would terminate
      // the heredoc early and execute the remainder as root shell commands.
      const credsDelim = `HWCREDS_${randomBytes(8).toString('hex')}`;
      await execOneShot(
        sandboxWsIdCred,
        `cat > ${credsFile} << '${credsDelim}'\n${credsScript}\n${credsDelim}\nchmod 600 ${credsFile}`,
        'root',
        15000,
      );
      await execWithSession(sandboxWsIdCred, `source ${credsFile} && echo "CREDS_SOURCED"`, 'root', 15000);
      if (apiKey) {
        const apiKeyDelim = `HWAPIKEY_${randomBytes(8).toString('hex')}`;
        await execOneShot(
          sandboxWsIdCred,
          `cat > ${apiKeyFile} << '${apiKeyDelim}'\nexport HW_API_KEY=${shellSingleQuote(apiKey)}\n${apiKeyDelim}\nchmod 600 ${apiKeyFile}`,
          'root',
          15000,
        );
      } else {
        // Refresh with no key → drop any stale copy, same semantics as the creds file rewrite.
        await execOneShot(sandboxWsIdCred, `rm -f ${apiKeyFile}`, 'root', 15000);
      }
    } catch {
      // best-effort: the hdkitservice injection already succeeded; the /tmp files only supplement shell access
    }
  }
  const result: Record<string, unknown> = {
    ...credResult,
    credentialValidation: validation.warning ? 'passed-with-warning' : 'passed',
  };
  if (sandboxWsIdCred) result.apiKeyInjected = Boolean(apiKey);
  if (apiKey) {
    result.apiKeyHint =
      'DevBridge API Key written to /tmp/hw_api_key (0600, kept separate from the temporary AK/SK in /tmp/hw_creds.sh — it is a long-lived account-level credential). Release builds of devbridge 0.2.x use it via: source /tmp/hw_api_key && devbridge auth login --api-key "$HW_API_KEY". DevBridge auth is fixed to API Key (AK/SK login removed) — the huawei-sandbox skill\'s expose ladder auto-creates the per-account × per-pool key when neither the keyring nor this file has one. Never echo the key into logs.';
  } else {
    result.apiKeyHint =
      'No DevBridge API Key provided — devbridge auth is fixed to API Key (AK/SK login removed), and you can skip providing one: the expose ladder auto-creates the per-account × per-pool key (devkit-ephemeral/devkit-persistent) via the relay API, injects it, and reports authMode API_KEY_AUTO. To bring your own key instead, create one at https://devstation.connect.huaweicloud.com/space/devbridge/apikey and re-run with api_key, or set the local HW_API_KEY environment variable (preferred — keeps the key out of the conversation).';
  }
  if (validation.projectId) result.projectId = validation.projectId;
  if (validation.warning) result.warning = validation.warning;
  if (validation.skipped) result.warning = validation.error;
  return result;
}
