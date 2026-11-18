import { hashArgs } from '../../lib/approval-tokens.ts';
import { redactSecrets } from '../../safety-policy.ts';
import { asString } from '../../lib/as-text.ts';
import { SUPPORTED_AGENT_TARGETS } from '../../auth/agent-registration.ts';
import type { ApprovalSpec } from '../../approval-types.ts';
import type { ToolArgs } from '../../tools.ts';

// The update pack's approval registration (PR-3c): huaweicloud_upgrade is
// ALWAYS gated — it replaces the package on disk for every installed
// target, which redirects every later tool call onto code the operator
// never reviewed, so the trunk's description-level consent line
// ("执行前必须先征得用户同意") becomes a mechanical gate. The binding is
// the {target, version} projection (never the gate fields), so the
// confirmation pins exactly what will be upgraded. check_update stays
// unregistered: it is the read-only face of the pair.
//
// Interrogate round 2, finding 2 — display/binding integrity:
//   (a) An ABSENT version normalizes to the literal 'latest' INSIDE the
//       binding, so the value the popup displays is the value the token
//       binds: the natural retry with version:'latest' (what the user read)
//       hashes identically to the unversioned mint and executes, instead
//       of mismatch-burning the token.
//   (b) assertArgsExecutable refuses every version shape the handler's own
//       chain refuses (upgradePackage accepts 'latest' only): a concrete
//       version and an empty string never mint a doomed approval.
//   (c) 'latest' names the CHANNEL, not an artifact: the handler elects
//       the actual tag after consent (a stable current → @latest, a
//       prerelease current → @next). The summarize view says so. Residual,
//       recorded: the tag can move between consent and execution (a
//       registry publish lands mid-cycle); the consent pins the channel
//       and the target, never the resolved artifact.
//
// Interrogate round 3, finding — the target half of the same doctrine:
//   (a) An absent AND an empty target normalize to the literal 'all'
//       (the handler's own default for both), so the displayed '(target
//       all)' is the bound value and the natural retry with target:'all'
//       consumes instead of mismatch-burning the confirmed token.
//   (b) assertArgsExecutable also refuses targets outside the handler's
//       SUPPORTED_AGENT_TARGETS allowlist (upgradePackage answers
//       '不支持的升级目标' after the gate, review #717's shell-interpolation
//       guard), so a bogus or case-variant target never mints a doomed
//       approval.
function upgradeBinding(args: ToolArgs): Record<string, unknown> {
  return {
    target: args.target === undefined || args.target === '' ? 'all' : args.target,
    version: args.version === undefined ? 'latest' : args.version,
  };
}

function assertUpgradeExecutable(value: unknown): void {
  const { target, version } = value as { target?: unknown; version?: unknown };
  if (version !== 'latest') {
    throw new Error(
      `version must be "latest" (got ${JSON.stringify(version)}): the handler elects the actual dist tag from the channel. Send version: "latest" or omit it.`,
    );
  }
  const targetStr = String(target);
  if (targetStr !== 'all' && !SUPPORTED_AGENT_TARGETS.includes(targetStr)) {
    throw new Error(`不支持的升级目标：${targetStr}（有效目标：all，或 ${SUPPORTED_AGENT_TARGETS.join(', ')} 之一）`);
  }
}

export const UPDATE_APPROVAL_SPECS: Readonly<Record<'huaweicloud_upgrade', ApprovalSpec>> = {
  huaweicloud_upgrade: {
    domain: 'update',
    flavor: 'always',
    tokenSource: 'gate',
    normalizeArgs: upgradeBinding,
    assertArgsExecutable: assertUpgradeExecutable,
    // The view folds through the shared redaction vocabulary before any
    // field reaches the summary or pin view (the ApprovalSpec contract:
    // never the raw argument stream); the hash binds the raw content —
    // here the normalized content, so the displayed value IS the bound
    // value.
    summarize: (value) => {
      const safe = redactSecrets(value) as { target?: unknown; version?: unknown };
      return {
        summary:
          `huaweicloud_upgrade: upgrade huaweicloud-devkit to version ${asString(safe.version) ?? 'latest'} ` +
          `(target ${asString(safe.target) ?? 'all'}) — "latest" names the channel: the handler elects the stable ` +
          'or prerelease dist tag (a stable current upgrades to @latest, a prerelease current to @next) after consent',
        argsHash: hashArgs(value),
        pinView: safe,
      };
    },
  },
};
