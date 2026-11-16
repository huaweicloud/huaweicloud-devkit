import { fingerprint } from '../../auth/reconcile.ts';
import { readCodeArtsCredentials } from '../../auth/credentials.ts';
import { readImportFile } from '../../lib/credentials.ts';
import { resolveSecretValue } from '../../lib/secret-vault/store.ts';
import { hashArgs } from '../../lib/approval-tokens.ts';
import type { ApprovalSpec } from '../../approval-types.ts';
import type { ToolArgs } from '../../tools.ts';

// The auth pack's approval registration (PR-3b): the account-switch pair.
// The account switch is the one step that can redirect every downstream
// approved write to a different account, so both faces join the roster as
// always-gated — the vendor gate in front asserts the vendor (the quote),
// this gate asserts the human (the confirmation). auth_confirm stays OFF
// this table per the parked decision: its pendingConfirms flow is the
// persist-conflict reconciliation's own confirmation, and gating it would
// ask the same human twice about the same switch (the double-ask on a
// persist conflict is the recorded known transient, not a defect to
// collapse here). auth_sync, auth_status, and check_account_type stay
// unregistered — read or operator-configured faces.
//
// The binding value is the call's credential SUBSTANCE with the consent
// plumbing (vendorConfirmed, approvalToken, approvedByUser, command)
// normalized away, the same doctrine as the cli pack's normalizeArgs
// binding the effective argv instead of the raw tool args. Two properties
// ride on that: a chat-round-trip retry (the same call plus
// approvedByUser) hashes identically to the arrival whose envelope was
// shown, so the T3 binding resolves; and the vendor quote never lands in
// the hash, the pin view, or the consent row.
//
// The `account` field inside the binding is the fingerprint the product
// already renders for account reconciliation (reconcile.ts's sha256
// prefix), derived with the handler's own resolution precedence: the args
// pair when present, else the backing store the mode names — with
// secret:// refs resolved first, exactly as the handler resolves them.
// Folding it into the BINDING (not just the display) is what makes the
// confirmation answer "which account wins" binding: a swapped import
// file between the shown envelope and the retry changes the hash, so the
// retry gets a fresh envelope for the new account instead of executing
// on the old approval. The cost is that normalizeArgs reads the backing
// store at call time; the post-dispatch outcome recorder re-derives the
// same value AFTER the handler wiped a consumed import file, so its
// argsHash can miss the arrival row — the annotate is best-effort by
// contract and a missing outcome line is the documented consequence.

function asStr(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

// The account the call switches to, as the 8-hex fingerprint. Mirrors the
// handler's precedence: the args pair wins when it is present (the handler
// ignores the backing store then), else the mode's backing store.
function accountFingerprint(ak: string, sk: string, mode: string): string {
  if (ak && sk) return fingerprint(resolveSecretValue(ak) ?? ak, resolveSecretValue(sk) ?? sk);
  if (mode === 'import') {
    const imported = readImportFile();
    if (imported) {
      return fingerprint(
        resolveSecretValue(imported.ak) ?? imported.ak,
        resolveSecretValue(imported.sk) ?? imported.sk,
      );
    }
  }
  if (mode === 'mcp-config') {
    const cc = readCodeArtsCredentials();
    if (cc) {
      return fingerprint(resolveSecretValue(cc.ak) ?? cc.ak, resolveSecretValue(cc.sk) ?? cc.sk);
    }
  }
  return '';
}

function initSubstance(args: ToolArgs): Record<string, unknown> {
  if (args.clear) return { clear: args.clear };
  const ak = asStr(args.ak);
  const sk = asStr(args.sk);
  const region = asStr(args.region);
  return {
    ak,
    sk,
    ...(region ? { region } : {}),
    account: accountFingerprint(ak, sk, 'memory'),
  };
}

function switchSubstance(args: ToolArgs): Record<string, unknown> {
  const action = args.action || 'temporary';
  if (action === 'clear') return { action: 'clear' };
  const mode = args.mode || 'memory';
  const ak = asStr(args.ak);
  const sk = asStr(args.sk);
  const securityToken = asStr(args.securityToken);
  const region = asStr(args.region);
  return {
    mode,
    action,
    ak,
    sk,
    ...(securityToken ? { securityToken } : {}),
    ...(region ? { region } : {}),
    account: accountFingerprint(ak, sk, mode),
  };
}

function accountOf(binding: Record<string, unknown>): string {
  const fp = asStr(binding.account);
  return fp || '(unknown)';
}

const SOURCE_LABELS: Record<string, string> = {
  memory: 'session arguments',
  import: 'the devkit credentials import file (creds-import.json)',
  'mcp-config': 'the CodeArts mcp_settings.json injection',
};

const SCOPE_LABELS: Record<string, string> = {
  persist: 'persist: S1 + KooCLI profile + OBS mirrors',
  temporary: 'temporary: this MCP process only',
};

function switchView(binding: Record<string, unknown>) {
  if (binding.action === 'clear') {
    return {
      summary: "huaweicloud_auth_switch: clear this session's runtime credentials (fall back to env/file/S1)",
      argsHash: hashArgs(binding),
      pinView: { action: 'clear' },
      command: "huaweicloud_auth_switch (clear the session's runtime credentials)",
    };
  }
  const account = accountOf(binding);
  const mode = asStr(binding.mode) || 'memory';
  const action = asStr(binding.action) || 'temporary';
  const source = SOURCE_LABELS[mode] ?? mode;
  const scope = SCOPE_LABELS[action] ?? action;
  return {
    summary: `huaweicloud_auth_switch: switch to account ${account} from ${source} (${scope})`,
    argsHash: hashArgs(binding),
    pinView: {
      account,
      source: mode,
      scope: action,
      ...(binding.region ? { region: binding.region } : {}),
      ...(binding.securityToken ? { sts: true } : {}),
    },
    command: `huaweicloud_auth_switch (switch the account to ${account}, source ${mode}, ${action})`,
  };
}

export const AUTH_APPROVAL_SPECS: Readonly<Record<'huaweicloud_auth_init' | 'huaweicloud_auth_switch', ApprovalSpec>> =
  {
    huaweicloud_auth_init: {
      domain: 'auth',
      flavor: 'always',
      tokenSource: 'gate',
      normalizeArgs: initSubstance,
      summarize: (bindingValue) => {
        const binding = (bindingValue ?? {}) as Record<string, unknown>;
        if (binding.clear) {
          return {
            summary: "huaweicloud_auth_init: clear this session's runtime credentials (fall back to env/file)",
            argsHash: hashArgs(binding),
            pinView: { clear: true },
            command: "huaweicloud_auth_init (clear the session's runtime credentials)",
          };
        }
        const account = accountOf(binding);
        const region = asStr(binding.region);
        return {
          summary:
            `huaweicloud_auth_init: switch this session's runtime credentials to account ${account}` +
            `${region ? ` (region ${region})` : ''} (source: session arguments)`,
          argsHash: hashArgs(binding),
          pinView: { account, ...(region ? { region } : {}) },
          command: `huaweicloud_auth_init (switch the session's runtime credentials to account ${account})`,
        };
      },
    },
    huaweicloud_auth_switch: {
      domain: 'auth',
      flavor: 'always',
      tokenSource: 'gate',
      normalizeArgs: switchSubstance,
      summarize: (bindingValue) => switchView((bindingValue ?? {}) as Record<string, unknown>),
    },
  };
