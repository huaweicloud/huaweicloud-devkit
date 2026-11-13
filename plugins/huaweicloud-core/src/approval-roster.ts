// The approval-gate roster: which tools the dispatch-layer approval gate
// covers. Plain string arrays, zod-free, import-free — the .mjs hook twin
// and the opencode ask-rule writer both import this shape from the compiled
// tree, and neither may pull the SDK/zod graph (the hook runs before dist
// exists in a raw checkout; the writer lives in the unbundled setup-cli
// graph). The gate (approval-gate.ts) resolves specs from
// packs/registry.ts's APPROVAL_SPECS merge, which type-checks each entry
// against these names.
//
// PR-1 populates the roster with the hcloud pair's run face only; the pack
// registrations land in PR-3. Two lists, not one, because the two flavors
// need different downstream facts: always tools get client ask-rules and
// _meta flags, classified tools additionally need a classify in their spec
// (pinned by structure.test.ts: every APPROVAL_CLASSIFIED_TOOLS entry must
// provide one).

export const APPROVAL_TOOLS: ReadonlyArray<string> = ['huaweicloud_run_approved_command'];

export const APPROVAL_CLASSIFIED_TOOLS: ReadonlyArray<string> = [];
