# Issue #815 / D3-S6 — FunctionGraph CreateFunction parameter assembly

## Defect

The daily-test scenario D3-S6 (`new-fg-rds-probe`) creates one FunctionGraph
function plus a TIMER trigger, then probes RDS from the function. The function
creation fails parameter validation, so no `func_urn` exists and the trigger
fails with it.

Two gaps produced that outcome:

1. **The example was a bare operation name.** `SERVICE_EXAMPLES.FUNCTIONGRAPH`
   returned `create: 'FunctionGraph CreateFunction'` — no parameters. An agent
   following the example assembles the request body itself, and the API rejects
   the call on whichever mandatory field its validation reaches first. Across
   releases this surfaced as `function_name` (v1.1.9-next.0, v1.1.15),
   `code.filename` (v1.1.9/v1.1.10/v1.1.14) and `code.zip_file` (v1.1.10 second
   run) — one defect, four spellings, no stable instruction to act on.
2. **The trigger was planned with the function.** `CreateFunctionTrigger`
   consumes `func_urn`, which only exists after a _successful_ create. Batched
   with the create, the trigger runs against a placeholder and takes the
   scenario down with it.

## Fix

- `plugins/huaweicloud-core/src/tools.mjs`
  - `SERVICE_EXAMPLES.FUNCTIONGRAPH.create` is now one complete command carrying
    the whole minimal set: `--func_name --package --runtime --handler
--memory_size --timeout --code_type --func_code.file --cli-region`, exposed
    with `createRequired` and a serial `createTrigger` example that names the URN
    it needs.
  - `manifestDependencyIssues()` is the serial guard: a manifest that batches
    `CreateFunctionTrigger` with `CreateFunction`, or that passes a placeholder
    / empty `--function_urn`, gets `CREATE_FUNCTION_TRIGGER_BEFORE_URN` or
    `PLACEHOLDER_FUNCTION_URN`, `safeToRun: false`, and
    `huaweicloud_run_approved_manifest` refuses the batch before consuming the
    approval token (`MANIFEST_DEPENDENCY_ORDER`).
- `plugins/huaweicloud-core/src/hcloud-cli.mjs`
  - `FUNCTIONGRAPH_CREATE_REQUIRED` / `FUNCTIONGRAPH_CODE_SOURCE` define the
    contract once; the pre-execution check reads flag keys instead of
    substring-matching the joined command, so a value can no longer satisfy a
    missing flag.
  - `FUNCTIONGRAPH_CREATE_ALIASES` maps the body-field spellings onto the flags
    and reports them as corrections (`--function_name` → `--func_name`), while
    the missing list always names the canonical field — the reported field no
    longer floats with the release.
  - `--code_type` plus one of `func_code.file` (inline) / `code_filename`
    (zip/jar) / `code_url` (obs) is required as a group, so a code-less create
    is stopped before the API call rather than creating an empty function.
- `plugins/huaweicloud-core/skills/huawei-functiongraph/` — `SKILL.md`,
  `references/create-function.md`, `references/deploy-workflow.md` teach the same
  two facts (body field names are not flags; create then trigger, serially).

## Tests

`test/issue-815-d3-s6-functiongraph-create.test.mjs` (10 cases): the example
carries the full set; a contract-assembled create raises no missing-parameter
warning; a code-less create names `func_code.file`; body-field spellings produce
one canonical report plus a correction; a create+trigger batch is flagged and
refused; a placeholder URN alone is flagged; the serial flow (create, then
trigger with the returned URN) is clean.

## Verification

- `node --test test/issue-815-d3-s6-functiongraph-create.test.mjs` — 10/10 pass.
- Full `npm test` with a writable `$HOME` — 969/973 pass; the four failures are
  environment-bound (`$HOME` read-only in the runner) and unrelated
  (install/marker tests); `officeace uninstall locates root via persisted marker`
  is the only one left once `$HOME` is writable, and it does not touch this
  change.
- `npx eslint` on changed files, `markdownlint-cli2` on changed skills,
  `prettier --check`, `node ./scripts/validate-package.mjs` — clean.
- Regression evidence is aligned to the D3-S6 `new-fg-rds-probe` scenario: one
  function (`func_name=new-fg-rds-probe`), inline code, TIMER trigger created
  from the returned URN.

## Out of scope

Routing (`serviceCatalog` already resolves FunctionGraph) and the `routeMap`
change carried separately by PR #843.
