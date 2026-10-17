# E2E Testing Design (agent-level suite)

The suite lives in `test/e2e/`, gated by `E2E_ENABLE=1` (`npm run test:e2e`),
and runs nightly plus on demand. It is the mechanism-verification tier of the
agent-level test story; the real-cloud guidance tier is
`test/huaweicloud-agent-toolkit-test/` (see Division of labor below).

## What is under test

The devkit's **observable outbound behavior** after a real tarball install,
driven by a real, unmocked code agent (opencode headless, real LLM). The
agent layer is never mocked; the Huawei Cloud boundary is fully fake but
recording. Assertion surfaces:

| Channel                            | Seam                                                                                                      | Owner                                                       |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| hcloud argv                        | `HCLOUD_BIN` + `HCLOUD_BIN_ARGS_JSON` + `HCLOUD_FAKE_LOG` (+ `HCLOUD_FAKE_SCRIPT`, `HCLOUD_FAKE_VERSION`) | env contract (long-standing)                                |
| HTTP (hdkitservice / IAM / hwlink) | `HDKITSERVICE_ENDPOINT`, `HW_IAM_ENDPOINT`, `HWLINK_ENDPOINT` → local `HttpFake`                          | env contract (long-standing)                                |
| gateway sidecar                    | `OPENMCP_BIN` (+ fixture knob `FAKE_POLICY`, recording `OPENMCP_FAKE_LOG`)                                | env contract (long-standing)                                |
| icons manifest                     | `HUAWEICLOUD_ICONS_OFFLINE=1` (forces the bundled snapshot; case-scoped `E2eCase.env`)                    | env contract (long-standing)                                |
| npm registry (update pack)         | `HUAWEICLOUD_NPM_REGISTRY` → local `HttpFake`, honored by `queryDistTags` on both faces                   | env contract (extended — see Known boundaries)              |
| tool-call trace                    | `HUAWEICLOUD_DEVKIT_TRACE` (see below)                                                                    | new contract, frozen                                        |
| disclosure events                  | same trace file, recorded at the stdio transport's outbound wire face                                     | new contract, frozen                                        |
| file artifacts                     | HOME-relative paths under the throwaway home                                                              | installer layout (pinned by cross-platform-install.test.ts) |

## Coupling classification (test → devkit dependency health)

Every assertion surface, classified:

- **(a) Stable public seam.** All env vars above; the MCP protocol surface
  (tool names, tools/list roster, tools/list_changed notification); pack
  posture via the operator channel (`install --packs`); the installed file
  layout. These survive behavior-preserving refactors by construction.
- **(b) Product feature that IS the test surface.** The plan → approval →
  run sequence and its token contract; pack trimming disclosure; the
  consent protocols (sandbox agreement, gateway policy refusal); credential
  persistence artifacts (S1 vault, `~/.obsutilconfig`, `hcloud configure set`
  argv). Tests here are SUPPOSED to break when the behavior changes.
- **(c) Frozen contract, deliberately promoted.** The
  `HUAWEICLOUD_DEVKIT_TRACE` record schema (see below). It lives in product
  code (`src/lib/call-trace.ts`), is versioned (`v: 1`), redaction-guaranteed,
  and pinned by `test/call-trace.test.ts` — changing it is a deliberate
  contract edit in the same change as the tests that read it.

Non-couplings, by design: hcloud argv flag ORDER is agent-authored (the
matcher is order-insensitive; only the Service/Operation head and
prompt-pinned flag values match literally); tool RESULT payloads are asserted
via outbound effects, never echoed text; agent free text is a soft
(non-gating) signal.

## The trace contract

`HUAWEICLOUD_DEVKIT_TRACE=<absolute path>` enables a JSONL append, one
object per line, two discriminated shapes, `v: 1`:

```
{ type: 'toolCall', v, ts, name, args, ok, error? }
{ type: 'disclosure', v, ts, event: 'toolsList'|'toolsListChanged', toolCount? }
```

- Redaction: args pass `redactSecrets` plus a supplemental `api_key` /
  `apiKey` denylist BEFORE the write; credentials never reach the file. The
  file is created 0600. Best-effort: a trace write error never fails a tool
  call.
- Scope: `toolCall` records only calls that reached `callTool`'s dispatch —
  SDK-level zod validation rejects a call BEFORE `callTool` and is
  deliberately not traced (that path is pinned by mcp-server.test.ts).
- **Emission ≠ delivery.** Recording `toolsListChanged` proves the server
  EMITTED the notification in a live stdio session. Client-side convergence
  (delivery) is covered by the in-memory unit tests (packs-configure.test.ts)
  and by the trimmed-disclosure E2E case observing the client-visible roster.

## Hermeticity contract

`test/e2e/env-policy.ts` is the single env assembly point (pin test:
`test/e2e-env-policy.test.ts`). Merge order is fixed: trimmed process env →
throwaway-home relocation (HOME/USERPROFILE/HOMEDRIVE/HOMEPATH/
HUAWEICLOUD_HOME + XDG_*) → driver vars → seam vars → fixed posture
overrides. Stripped: all six proxy spellings, `HW_*` credentials, KooCLI
config paths, `DEVKIT_PACKS` (posture rides `install --packs` only).
Pinned: `HUAWEICLOUD_DEVKIT_TELEMETRY=off`, `HUAWEICLOUD_DEVKIT_SKIP_UPDATE=1`,
`HUAWEICLOUD_INJECT_STS_CMD=0`, `NO_PROXY` for localhost. The HTTP boundary
env vars point at the local fake for EVERY case — scripted or not — so no
request can leave the machine (unknown paths answer 404 fast).

Auth: a dedicated E2E API key via env (`E2E_APIKEY` / `E2E_TEST_API_KEY`),
written into the throwaway home's opencode auth.json (0600). Real auth files
are never copied. Local config: gitignored `test/e2e/.env`.

## Known boundaries

- **Windows**: compatible by construction (5-var home recipe, execPath shim,
  single-point case-insensitive env merge, npm.cmd, matcher normalization),
  but executed on Linux only. Windows behavior is unverified until a Windows
  runner exists. open-mcp cases skip on win32 with a recorded reason
  (`OPENMCP_BIN` resolution is path-only — no args-prefix seam; add
  `OPENMCP_BIN_ARGS_JSON` to lift).
- **Order sensitivity**: `hashArgs` keeps string-array order (product
  semantics, approval-tokens.ts), so a model that re-orders flags between
  plan and run gets "args do not match the approved plan". Prompts pin flag
  order; this remains a known retry-worthy jitter source.
- **ws-exec boundary: faked since P2.** The local hwlink fake
  (test/e2e/ws-fake/) speaks the product's binary protocol through the
  product's own codec and marker vocabulary, covers exec one-shot and
  session semantics, upload_file (b64 batches → decode → true-md5
  verification), upload_project (tunnel relay + in-fake HTTP file server),
  and the deploy probes/marker synthesis. Remaining unfaked: the real
  PTY's echo/canonical quirks (the fake never echoes input — a legal
  client-side mode), and devbridge itself (the tunnel URL is synthesized
  to satisfy the domain-pinned pattern, never fetched).
- **update pack**: covered since the registry seam landed. The earlier "no
  env seam" note was half-wrong: `HUAWEICLOUD_NPM_REGISTRY` existed but only
  the CLI face honored it — the MCP tool face's default query spawned
  `npm view` and ignored the var. The seam now delegates in `queryDistTags`
  itself, so both faces honor it; update cases relax exactly
  `HUAWEICLOUD_DEVKIT_SKIP_UPDATE` (the env-policy whitelist's only entry,
  type-level) and point the registry at the local HTTP fake. The npm child
  process is deliberately NOT intercepted (PATH shims would also capture the
  installer's own npm; `npm_config_registry` would hijack every session npm
  and depends on npm-internal endpoint shapes).
- **search_marketplace: no hermetic case possible.** `INDEX_URL` is
  hardcoded (search-market.ts) with an in-memory cache only — no env seam.
  Covering it needs a product seam (an `HUAWEICLOUD_MARKETPLACE_INDEX`-style
  override); until one lands, this tool has no E2E case.
- **LLM cost/latency**: a single case takes 1 to 4 min with an attempts cap
  of 2. A full run covers all 28 cases and measures about 40 min wall clock
  (first-attempt passes). Failures attach every recording to the JSON report
  for offline triage.

## Division of labor: this suite vs the nightly real-cloud harness

`test/huaweicloud-agent-toolkit-test/` (the devkit-test SKILL) answers "can
the plugin GUIDE an agent through real cloud operations" — real credentials,
real resources, cleanup discipline. This suite answers "does the devkit
initiate the right outbound behavior" — fake boundary, mechanism contracts,
hermetic, cheap enough for per-iteration runs. Case id vocabularies are
independent; a capability covered by both (CLI write flows) deliberately
differs in tier: consent mechanics here, guidance completeness there.

## Runner mechanics

Custom runner (not node --test) because gating, per-case budgets,
process-group teardown, and the JSON report shape are runner concerns, not
test-framework concerns. Serial by default. Each attempt gets a fresh
throwaway home + workdir + fake set; the agent is spawned in its own process
group and killed tree-wide on timeout; a startup sweep removes stale
`hwc-e2e-*` temp dirs older than a day (signal-death self-healing).
`selfcheck` subcommand proves the full chain (tarball → install → MCP server
→ callTool → fakes) without the LLM.

Nightly (`.github/workflows/e2e-nightly.yml`): the only required repository
setting is the `E2E_TEST_MODEL_APIKEY` secret. Provider/model/baseURL default
to the committed values in the workflow (mirroring `test/e2e/.env`'s
non-secret model config — maas / modelarts / glm-5.2 at the time of writing)
and stay overridable via the `E2E_TEST_*` vars; the preflight step fails fast
on a missing secret. opencode is pinned to the version the suite was verified
against (an upgrade is an explicit suite event). Local runs read the
gitignored `test/e2e/.env` instead; the report records agent/model/version
per run so drift between the two sources is visible, not silent.
