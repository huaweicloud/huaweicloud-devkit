import { hashArgs } from '../../lib/approval-tokens.ts';
import { redactSecrets } from '../../safety-policy.ts';
import type { ApprovalSpec, ClassifyVerdict } from '../../approval-types.ts';
import type { ToolArgs } from '../../tools.ts';

// The obs pack's approval registrations (PR-3c): both bucket-config tools
// are CLASSIFIED on their `action` argument — `get` is a signed read that
// must never confirm, while `set` and `delete` are signed PUT/DELETE on
// live buckets (the most exposed cloud writes in the inventory) and elicit
// or prompt-ask every call. classify-before-mint holds at the gate face:
// a read never mints, and a write never executes without the human.
// The binding value is the CONTENT projection of the args — action,
// bucket, region, and the config payload — never the gate fields
// (approvalToken/approvedByUser), so the hash the token binds is stable
// across the mint → approve → retry cycle. No commandAnchor and no
// summarize command: these tools sign REST calls internally, so there is
// no executable line to pin or display — the summarize view is the
// confirmation content, per the ApprovalSpec contract for tools whose
// args carry no command.
//
// setup_obs_config stays unregistered (the flagged boundary item): it
// syncs credentials the user just configured through the auth face, so
// the human is present by construction.

// The content fields of the website-config call, in the shape the handler
// reads. Undefined optional fields ride as undefined (dropped by the
// hash/pin-view serializations both times, so the projection is stable).
function websiteBinding(args: ToolArgs): Record<string, unknown> {
  return {
    action: args.action,
    bucket: args.bucket,
    region: args.region,
    indexDocument: args.indexDocument,
    errorDocument: args.errorDocument,
  };
}

function corsBinding(args: ToolArgs): Record<string, unknown> {
  return {
    action: args.action,
    bucket: args.bucket,
    region: args.region,
    rules: args.rules,
  };
}

// Pure classification over the binding value: `get` is a signed read
// (none — no consent, no mint), everything else requires the human.
// An unknown action fails closed onto `required`; zod's enum rejects it
// before dispatch, so the branch is defensive only.
function classifyObsAction(value: unknown): ClassifyVerdict {
  return (value as { action?: unknown }).action === 'get' ? 'none' : 'required';
}

// The set-preconditions the handlers themselves enforce, moved before the
// mint (NoDoomedToken: a malformed set call must not mint an approval it
// could never spend — the retry would need new args, hence a new hash,
// hence a fresh approval). Mirrors the handlers' own throw text.
function assertWebsiteExecutable(value: unknown): void {
  const { action, indexDocument } = value as { action?: unknown; indexDocument?: unknown };
  if (action === 'set' && (typeof indexDocument !== 'string' || indexDocument === '')) {
    throw new Error('indexDocument is required for action=set.');
  }
}

function assertCorsExecutable(value: unknown): void {
  const { action, rules } = value as { action?: unknown; rules?: unknown };
  if (action === 'set' && (!Array.isArray(rules) || rules.length === 0)) {
    throw new Error('rules array is required for action=set (allowedOrigin + allowedMethod, HEAD included).');
  }
}

// The summarize contract (approval-types.ts): the view is the REDACTED
// popup projection — never the raw argument stream. The whole binding
// folds through the shared redaction vocabulary (safety/redact.ts via the
// safety-policy face) before any field reaches the summary or the pin
// view, so a secret-shaped value riding any field is folded to
// <redacted>. The argsHash still binds the RAW content projection: the
// token pins what will actually execute, the view shows what the human
// may read.
function safeView(value: unknown): Record<string, unknown> {
  return redactSecrets(value) as Record<string, unknown>;
}

export const OBS_APPROVAL_SPECS: Readonly<
  Record<'huaweicloud_obs_set_website_config' | 'huaweicloud_obs_set_cors', ApprovalSpec>
> = {
  huaweicloud_obs_set_website_config: {
    domain: 'obs',
    flavor: 'classified',
    tokenSource: 'gate',
    normalizeArgs: websiteBinding,
    classify: classifyObsAction,
    assertArgsExecutable: assertWebsiteExecutable,
    summarize: (value) => {
      const safe = safeView(value);
      const index = safe.action === 'set' ? `, index ${String(safe.indexDocument)}` : '';
      return {
        summary: `huaweicloud_obs_set_website_config: ${String(safe.action)} website config on bucket ${String(safe.bucket)} (region ${String(safe.region)})${index}`,
        argsHash: hashArgs(value),
        pinView: safe,
      };
    },
  },
  huaweicloud_obs_set_cors: {
    domain: 'obs',
    flavor: 'classified',
    tokenSource: 'gate',
    normalizeArgs: corsBinding,
    classify: classifyObsAction,
    assertArgsExecutable: assertCorsExecutable,
    summarize: (value) => {
      const safe = safeView(value);
      const count = safe.action === 'set' ? ` (${Array.isArray(safe.rules) ? safe.rules.length : 0} rule(s))` : '';
      return {
        summary: `huaweicloud_obs_set_cors: ${String(safe.action)} CORS rules${count} on bucket ${String(safe.bucket)} (region ${String(safe.region)})`,
        argsHash: hashArgs(value),
        pinView: safe,
      };
    },
  },
};
