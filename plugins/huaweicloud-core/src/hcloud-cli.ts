// Stable public face of the KooCLI execution subsystem. The internals live
// in the src/hcloud-* family (planning + approval, the run engine, the
// service-catalog/language knowledge, STS injection, OBS redaction, the
// SG preflight, and the API-error/output-redaction pipeline); this module
// is the re-export seam every consumer imports — same exported names, same
// import path, same behavior (the safety-policy.ts precedent).

// The CLI face's consent layer lives in src/lib/approval-tokens.ts; these
// re-exports keep existing import sites (tests) compiling — the
// tool-schemas.ts re-export precedent.
export { hashArgs, createApprovalToken, consumeApprovalToken, inspectApprovalToken } from './lib/approval-tokens.ts';
// The #935 A4 banner strip (see koocli-version.ts) re-exported for the
// executor's existing test import sites.
export { stripKooCliUpdateBanner } from './koocli-version.ts';

// The OBS arg redaction and the API-error/output-redaction family.
export { redactArgsWithObs } from './hcloud-obs-redact.ts';
export { extractApiError, redactOutput, type ApiErrorInfo } from './hcloud-api-error.ts';

// The service-catalog, STS-injection, and SG-preflight families.
export {
  readServiceCatalogs,
  classifyUnsupported,
  type ServiceCatalogCache,
  type UnsupportedCause,
} from './hcloud-catalog.ts';
export { resolveStsInjectArgs } from './hcloud-sts.ts';
export type { SgFinding } from './hcloud-sg-preflight.ts';

// The plan and run engine. stripLeadingHcloudBinArgs rides the face so the
// approval handler hashes the same effective args the plan minted its token
// over (the 2026-11-05 UX report #6 seam).
export {
  planHcloudCommand,
  stripLeadingHcloudBinArgs,
  firstPlaceholderSecretArg,
  pinViewArgs,
  type HcloudPlan,
  type HcloudPlanWithArgs,
} from './hcloud-plan.ts';
export { runHcloud, type HcloudRunResult, type HcloudRunOptions } from './hcloud-run.ts';
