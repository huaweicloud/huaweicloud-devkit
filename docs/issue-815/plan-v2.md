# Issue #815 / D3-S6 — FunctionGraph CreateFunction parameter assembly (v2)

Same defect as the dev-side fix, on the v2 baseline
(`plugins/huaweicloud-core/src/packs/huaweicloud-cli/tools.ts` and
`plugins/huaweicloud-core/src/hcloud-plan.ts`).

## Defect

1. **The example was a bare operation name.** `SERVICE_EXAMPLES.FUNCTIONGRAPH`
   returned `create: 'FunctionGraph CreateFunction'` — no parameters. An agent
   following the example assembles the request body itself, and the API rejects
   the call on whichever mandatory field its validation reaches first: across
   releases that surfaced as `function_name` (v1.1.9-next.0, v1.1.15),
   `code.filename` (v1.1.9 / v1.1.10 / v1.1.14) and `code.zip_file` (v1.1.10
   second run) — one defect, four spellings, no stable instruction to act on.
2. **The trigger was planned with the function.** `CreateFunctionTrigger`
   consumes `func_urn`, which only exists after a *successful* create, so the
   trigger failed together with the function and nothing said which step owed
   the URN.

## Fix (v2 shape)

- `src/packs/huaweicloud-cli/tools.ts` — the FunctionGraph `create` example is
  one complete command over the contract's minimal set
  (`--func_name --package --runtime --handler --memory_size --timeout
  --code_type --func_code.file --cli-region`); `SERVICE_EXAMPLES` is exported so
  the regression test can hold the example to the contract.
- `src/hcloud-plan.ts`
  - `FUNCTIONGRAPH_CREATE_REQUIRED` / `FUNCTIONGRAPH_CODE_SOURCE` define the
    contract once; the pre-execution check reads flag keys instead of
    substring-matching the joined command, so a value can no longer satisfy a
    missing flag.
  - `FUNCTIONGRAPH_CREATE_ALIASES` maps the body-field spellings onto the flags
    and reports them as corrections (`--function_name` → `--func_name`), while
    the missing list always names the canonical field — the reported field no
    longer floats with the release.
  - `--code_type` plus one of `func_code.file` (inline) / `code_filename`
    (zip/jar) / `code_url` (obs) is required as a group, so a code-less create is
    stopped before the API call.
  - `functionTriggerUrnWarning` names the serial step: a `CreateFunctionTrigger`
    planned with a placeholder or absent `--function_urn` is told to create the
    function first and pass the URN it returns. v2 has no manifest batch face, so
    this is the enforceable half of the serial ordering (dev additionally refuses
    the batch outright — see PR against `dev`).
- `src/packs/huaweicloud-cli/skills/huawei-functiongraph/` — `SKILL.md`,
  `references/create-function.md`, `references/deploy-workflow.md` teach the same
  two facts (body field names are not flags; create then trigger, serially).

## Tests

`test/issue-815-d3-s6-functiongraph-create.test.ts` (8 cases): the example
carries the full set; a contract-assembled create raises no missing-parameter
warning; a code-less create names `func_code.file`; body-field spellings produce
one canonical report plus a correction; a placeholder/absent trigger URN is
called out; the serial flow (create, then trigger with the returned URN) is
clean. Plans run with `mintApprovalToken: false` so no state dir is touched.

## Verification

- `node --test test/issue-815-d3-s6-functiongraph-create.test.ts` — 8/8 pass.
- `npm run typecheck` — clean.
- `npm run test:quick` — 2468/2481 pass; the 9 failures are environment-bound
  (read-only `$HOME`, file-mode and PATH probes) and reproduce with the
  unchanged baseline sources (verified by running `approval-ledger`,
  `project-id`, `auth-agent-registration` against `origin/v2` sources: identical
  5/1/1 failure counts).
- `npm run validate`, `npm run lint:dup`, `npm run lint:js` (0 errors),
  `npm run lint:md` (repo files clean; findings only in the runner-injected
  `.project-info/` and `.skills/` scaffolding), `prettier --check` — clean.

## Out of scope

Routing (`serviceCatalog` already resolves FunctionGraph) and the `routeMap`
change carried by PR #843 on branch `feat/issue-815`.