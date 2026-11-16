import { hashArgs } from '../../lib/approval-tokens.ts';
import { redactSecrets } from '../../safety-policy.ts';
import { asString } from '../../lib/as-text.ts';
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
function upgradeBinding(args: ToolArgs): Record<string, unknown> {
  return { target: args.target, version: args.version };
}

export const UPDATE_APPROVAL_SPECS: Readonly<Record<'huaweicloud_upgrade', ApprovalSpec>> = {
  huaweicloud_upgrade: {
    domain: 'update',
    flavor: 'always',
    tokenSource: 'gate',
    normalizeArgs: upgradeBinding,
    // The view folds through the shared redaction vocabulary before any
    // field reaches the summary or pin view (the ApprovalSpec contract:
    // never the raw argument stream); the hash binds the raw content.
    summarize: (value) => {
      const safe = redactSecrets(value) as { target?: unknown; version?: unknown };
      return {
        summary: `huaweicloud_upgrade: upgrade huaweicloud-devkit to version ${asString(safe.version) ?? 'latest'} (target ${asString(safe.target) ?? 'all'})`,
        argsHash: hashArgs(value),
        pinView: safe,
      };
    },
  },
};
