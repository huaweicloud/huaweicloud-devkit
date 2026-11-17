import { fingerprint } from '../../auth/reconcile.ts';
import { readCodeArtsCredentials } from '../../auth/credentials.ts';
import { peekImportFile } from '../../lib/credentials.ts';
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
// The binding value is the call's RESOLVED CREDENTIAL SNAPSHOT with the
// consent plumbing (vendorConfirmed, approvalToken, approvedByUser,
// command) normalized away. Resolution mirrors the handler's channel
// precedence exactly — the args pair wins when present, else the mode's
// backing store (the import file for mode=import, the CodeArts injection
// for mode=mcp-config), with secret:// refs resolved — and the backing
// store is PEEKED, never read-for-wipe: the gate runs before any consent,
// so a read with a side effect (the malformed-file wipe) would mutate the
// user's state on the refusal path. The handler EXECUTES this snapshot
// (threaded through dispatch as opts.approvedBinding), never a
// post-consent re-read — interrogate round 1, finding 2: the account the
// confirmation view named is the account that switches, and a rewrite of
// the import file between the shown form and the accept lands nowhere.
// Folding the resolved region and security token into the BINDING (not
// just the display) extends the same doctrine to the full effect: a
// same-fingerprint call with a different region or STS re-asks instead
// of executing under the old approval (round 1, finding 3).
//
// The cost of a resolved binding: the post-dispatch outcome recorder
// re-derives it AFTER the handler wiped a consumed import file, so its
// argsHash can miss the arrival row — the annotate is best-effort by
// contract and a missing outcome line is the documented consequence.

function asStr(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function resolved(value: string): string {
  return resolveSecretValue(value) ?? value;
}

// Shape guard for the dispatch-threaded snapshot: it comes from our own
// gate, but the narrow keeps the handler's fallback honest against any
// future binding-shape change.
export function isApprovedSwitchSnapshot(value: unknown): value is ApprovedSwitchSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.mode === 'string' &&
    typeof v.action === 'string' &&
    typeof v.ak === 'string' &&
    typeof v.sk === 'string' &&
    typeof v.securityToken === 'string' &&
    typeof v.region === 'string' &&
    typeof v.account === 'string' &&
    typeof v.fromImport === 'boolean'
  );
}

// The resolved credential record the switch handler executes, and the ONE
// place the resolution precedence lives (the gate's normalizeArgs and the
// handler's no-binding fallback both call this). Shape-guards in the
// handler (isApprovedSwitchSnapshot) keep the threading an in-process
// contract: it comes from our own gate, but the narrow costs nothing.
export interface ApprovedSwitchSnapshot {
  mode: string;
  action: string;
  ak: string;
  sk: string;
  securityToken: string;
  region: string;
  // The 8-hex fingerprint of the resolved account (display + pin view).
  account: string;
  // True when the import file supplied the values (the handler wipes it on
  // non-replayable outcomes, exactly as its own read did).
  fromImport: boolean;
}

// Resolve the switch substance with the handler's own precedence: the args
// pair wins when present, else the mode's backing store (full replace for
// the import channel; the CodeArts channel defaults region from the
// injection and falls back to the args). Refs resolve to plaintext, the
// same seam the handler resolved through.
export function switchSnapshot(args: ToolArgs): ApprovedSwitchSnapshot {
  const mode = args.mode || 'memory';
  const action = args.action || 'temporary';
  if (action === 'clear') {
    return { mode, action: 'clear', ak: '', sk: '', securityToken: '', region: '', account: '', fromImport: false };
  }
  let ak = asStr(args.ak);
  let sk = asStr(args.sk);
  let securityToken = asStr(args.securityToken);
  let region = asStr(args.region);
  let fromImport = false;
  if (mode === 'import' && (!ak || !sk)) {
    const imported = peekImportFile();
    if (imported) {
      ({ ak, sk, securityToken, region } = imported);
      fromImport = true;
    }
  }
  if (mode === 'mcp-config' && (!ak || !sk)) {
    const cc = readCodeArtsCredentials();
    if (cc) {
      ak = cc.ak;
      sk = cc.sk;
      securityToken = cc.securityToken || '';
      region = cc.region || region;
    }
  }
  const akValue = resolved(ak);
  const skValue = resolved(sk);
  const securityTokenValue = resolved(securityToken);
  return {
    mode,
    action,
    ak: akValue,
    sk: skValue,
    securityToken: securityTokenValue,
    region,
    account: fingerprint(akValue, skValue),
    fromImport,
  };
}

// Resolve the init substance with the SAME seam the switch snapshot uses
// (round 2, the twin path): the args may carry secret:// refs, and the
// binding must hash and name the RESOLVED account — the fingerprint of the
// ref strings is the fingerprint of nothing. Resolution at snapshot time
// also refuses the doomed shape pre-mint (an unresolvable ref throws
// VaultError at the gate, before any consent surface or token store
// write), and makes a vault swap behind the same refs change the binding
// hash, so a confirmed retry re-asks instead of executing an unseen
// account.
function initSnapshot(args: ToolArgs): Record<string, unknown> {
  if (args.clear) return { clear: true };
  const ak = resolved(asStr(args.ak));
  const sk = resolved(asStr(args.sk));
  const region = resolved(asStr(args.region));
  return {
    ak,
    sk,
    ...(region ? { region } : {}),
    account: fingerprint(ak, sk),
  };
}

// Shape guard for the init twin's dispatched snapshot: ak/sk/account are
// strings (the resolved values), and the switch snapshot's channel keys
// are absent — the two bindings never cross.
export interface ApprovedInitSnapshot {
  ak: string;
  sk: string;
  region?: string;
  account: string;
}

export function isApprovedInitSnapshot(value: unknown): value is ApprovedInitSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.ak === 'string' &&
    typeof v.sk === 'string' &&
    typeof v.account === 'string' &&
    !('mode' in v) &&
    !('fromImport' in v)
  );
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

function switchView(binding: ApprovedSwitchSnapshot) {
  if (binding.action === 'clear') {
    return {
      summary: "huaweicloud_auth_switch: clear this session's runtime credentials (fall back to env/file/S1)",
      argsHash: hashArgs(binding),
      pinView: { action: 'clear' },
      command: "huaweicloud_auth_switch (clear the session's runtime credentials)",
    };
  }
  const account = binding.account || '(unknown)';
  const source = SOURCE_LABELS[binding.mode] ?? binding.mode;
  const scope = SCOPE_LABELS[binding.action] ?? binding.action;
  const regionNote = binding.region ? `, region ${binding.region}` : '';
  const stsNote = binding.securityToken ? ', session-scoped STS' : '';
  return {
    summary: `huaweicloud_auth_switch: switch to account ${account} from ${source}${regionNote}${stsNote} (${scope})`,
    argsHash: hashArgs(binding),
    pinView: {
      account,
      source: binding.mode,
      scope: binding.action,
      ...(binding.region ? { region: binding.region } : {}),
      ...(binding.securityToken ? { sts: true } : {}),
    },
    command: `huaweicloud_auth_switch (switch the account to ${account}, source ${binding.mode}${regionNote}${stsNote}, ${binding.action})`,
  };
}

export const AUTH_APPROVAL_SPECS: Readonly<Record<'huaweicloud_auth_init' | 'huaweicloud_auth_switch', ApprovalSpec>> =
  {
    huaweicloud_auth_init: {
      domain: 'auth',
      flavor: 'always',
      tokenSource: 'gate',
      normalizeArgs: initSnapshot,
      // NoDoomedToken (round 1, finding 4): the handler refuses a set call
      // with no credential pair, so the gate refuses it before any mint —
      // the user is never asked to approve a call the execution would
      // reject.
      assertArgsExecutable: (bindingValue) => {
        const binding = (bindingValue ?? {}) as Record<string, unknown>;
        if (binding.clear) return;
        if (
          typeof binding.ak !== 'string' ||
          binding.ak === '' ||
          typeof binding.sk !== 'string' ||
          binding.sk === ''
        ) {
          throw new Error(
            'ak and sk are required to set runtime credentials (secret:// vault refs are accepted). ' +
              'Pass clear=true to clear the session\u2019s runtime credentials instead.',
          );
        }
      },
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
        const account = asStr(binding.account) || '(unknown)';
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
      normalizeArgs: switchSnapshot,
      // NoDoomedToken (round 1, finding 4): no mint for a switch with no
      // resolvable target account (an absent or malformed import file, an
      // empty injection), and no mint for a persist shape the handler
      // rejects anyway — a regionless persist (invalid_region, round 2's
      // close of the recorded residual) or an STS persist (R3).
      assertArgsExecutable: (bindingValue) => {
        const binding = bindingValue as ApprovedSwitchSnapshot;
        if (binding.action === 'clear') return;
        if (
          typeof binding.ak !== 'string' ||
          binding.ak === '' ||
          typeof binding.sk !== 'string' ||
          binding.sk === ''
        ) {
          throw new Error(
            'the account switch has no resolvable target account: pass ak/sk (mode=memory), ' +
              'a valid creds-import.json (mode=import), or an injected mcp_settings.json (mode=mcp-config).',
          );
        }
        if (binding.action === 'persist' && !binding.region.trim()) {
          throw new Error(
            'region is required to persist credentials. Pass --region, or include "region" in creds-import.json (mode=import).',
          );
        }
        if (binding.action === 'persist' && binding.securityToken !== '') {
          throw new Error('Temporary STS credentials cannot be persisted (R3). Use action=temporary.');
        }
      },
      summarize: (bindingValue) => switchView(bindingValue as ApprovedSwitchSnapshot),
    },
  };
