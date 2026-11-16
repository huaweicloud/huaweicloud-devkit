import { hashArgs } from '../../lib/approval-tokens.ts';
import { redactSecrets } from '../../safety-policy.ts';
import type { ApprovalSpec } from '../../approval-types.ts';
import type { ToolArgs } from '../../tools.ts';

// The secrets pack's approval registration (PR-3c): secret_delete is
// ALWAYS gated — it destroys the stored ciphertext with no version
// history, so a deleted ref is gone until its owner re-stores it. The
// binding and the confirmation view name the ref, because the ref is the
// entire consequence of the call. secret_set stays UNREGISTERED: the
// plaintext arrives from the user (channel=value is the user pasting it,
// file/envVar are user-designated sources), so the human is present by
// construction and a second confirmation would confirm nothing new.
// secret_list is the read-only inventory and stays ungated the same way.
function deleteBinding(args: ToolArgs): Record<string, unknown> {
  return { ref: args.ref };
}

export const SECRETS_APPROVAL_SPECS: Readonly<Record<'huaweicloud_secret_delete', ApprovalSpec>> = {
  huaweicloud_secret_delete: {
    domain: 'secrets',
    flavor: 'always',
    tokenSource: 'gate',
    normalizeArgs: deleteBinding,
    // The view folds through the shared redaction vocabulary before any
    // field reaches the summary or pin view (the ApprovalSpec contract);
    // the hash binds the raw content.
    summarize: (value) => {
      const safe = redactSecrets(value) as { ref?: unknown };
      return {
        summary: `huaweicloud_secret_delete: delete secret ${String(safe.ref)} from the local vault (no version history)`,
        argsHash: hashArgs(value),
        pinView: safe,
      };
    },
  },
};
