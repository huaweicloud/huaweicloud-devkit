import { z } from 'zod';

// Zod schema building blocks shared between src/tool-schemas.ts (core tools)
// and the per-pack tool modules (src/packs/<id>/tools.ts). They live in lib/
// because a pack cannot value-import them from tool-schemas.ts: tool-schemas
// value-imports each pack's X_TOOL_SCHEMAS spread, so the reverse edge would
// be a fatal ESM cycle. This module imports only zod.

// number | "123" | null | undefined — the exact input space the old
// presence-only validation accepted for NUMERIC_ARG_KEYS fields.
export const numericArg = z.union([z.number(), z.string()]).nullable();

// A JSON-encoded string of a string array — the model's double-encoded
// wire form ("args": "[\"VPC\", \"CreateSecurityGroup\"]", measured on the
// 2026-11-03 e2e-nightly runs: glm-3 re-wrapped the planned command as a
// JSON string on EVERY huaweicloud_run_approved_command retry) — parsed
// back to the array before validation. The preprocess is TRANSPARENT in
// z.toJSONSchema (zod 4.6.7 renders the inner schema), so tools/list and
// the legacy registry snapshot keep teaching the canonical array shape;
// a string that does not parse to a string array fails the inner check
// with the instructive expected-array message.
export const stringArrayArg = z.preprocess((value) => {
  if (typeof value !== 'string') return value;
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((item) => typeof item === 'string') ? parsed : value;
  } catch {
    return value;
  }
}, z.array(z.string()));

// "true"/"false" as strings — the model's boolean wire form (measured in
// the same run: "approvedByUser": "true" on every retry) — converted to
// real booleans before validation. Garbage strings fail the inner
// z.boolean() with the instructive message. Like numericArg this is
// wire-shape tolerance, not semantics change: the approvedByUser
// attestation still must be explicitly present and true, and the
// approvalToken still binds the exact command.
export const booleanArg = z.preprocess(
  (value) => (value === 'true' ? true : value === 'false' ? false : value),
  z.boolean(),
);

// Free-form object the tool narrows itself (env vars, deploy plans).
export const looseObject = z.record(z.string(), z.unknown());

// The vendor gate parameter, shared by every cloud-facing tool schema.
// Optional in the schema ON PURPOSE: a missing value must pass zod and
// reach callTool's gate, which throws the teaching rejection (SDK-level
// zod rejects happen before callTool and never carry a teaching message;
// a required field would silence the very consent instruction the gate
// exists to deliver). The gate, not the schema, is the enforcement —
// this part only renders the rule where the model reads tool contracts.
// Mirrors the approvedByUser attestation pattern the approval chain
// measured models honor (core-approval-negative green): an explicit
// user-context boolean the model must actively assert, with the
// availability-is-not-consent denial written into the description.
export const vendorConfirmed = z
  .string()
  .optional()
  .describe(
    "Vendor gate: quote the user's words that establish Huawei Cloud — the sentence or turn where they named it, their hcloud/KooCLI artifacts, a myhuaweicloud endpoint, a Huawei region ID, or an earlier confirmation. The devkit being installed or this tool being available is NOT confirmation, and neither is service vocabulary: a quote you invented is a fabricated user statement. If you cannot quote the user, the vendor is not established — ask which cloud they mean instead of calling.",
  );

export const gitConfig = z.looseObject({
  repo_url: z.string().optional(),
  repo_branch: z.string().optional(),
  repo_name: z.string().optional(),
  target_path: z.string().optional(),
  open_type: z.string().optional(),
});

export const workspaceId = z
  .string()
  .optional()
  .describe(
    'Workspace ID from huaweicloud_sandbox_connect return value. Required - must be passed explicitly when HW_WORKSPACE_ID is not set.',
  );

export const username = z.string().optional().describe('Login username (default: root)');
