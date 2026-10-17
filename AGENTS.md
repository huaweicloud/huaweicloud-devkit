# AGENTS.md — HuaweiCloud DevKit

## Commands

```bash
npm test                 # all tests (node --test)
npm run build            # compile src → dist/ AND regenerate the skills/ tree from src/packs/*/skills/
npm run typecheck        # tsc type gate (src + test projects)
npm run lint             # ESLint + markdownlint
npm run lint:js          # ESLint only
npm run lint:md          # markdownlint only
npm run lint:dup         # jscpd copy/paste scan (local: full clone report; CI/test gate: new clones only)
npm run format           # Prettier format all files
npm run format:check     # Prettier check (no write)
npm run validate         # structural validation + README beta badge sync check
npm run badge:sync       # rewrite README beta badge to the next stable version
npm run smoke:agents     # pre-release smoke: pack → install tarball → per-agent install + MCP roundtrip
npm run test:e2e         # agent-level E2E (real opencode + LLM): gated by E2E_ENABLE=1, reads gitignored
                         #   test/e2e/.env for the model config; 1-4 min per case, attempts cap 2 —
                         #   NEVER in npm test or the PR gate; selfcheck subcommand runs chain-only
node --test test/structure.test.ts    # single test file
node --test test/real-agents.test.ts  # real opencode/codex lifecycle (needs the CLIs on PATH; CI: DEVKIT_REAL_AGENT_TESTS=1)
node ./scripts/validate-package.mjs   # validation alone
```

TypeScript sources under `plugins/huaweicloud-core/src` compile to `dist/`, and every runtime entry point reads `dist/` (`bin/setup.cjs` → `dist/setup-cli.js`, `.mcp.json` → `dist/mcp-server.js`, the Node hook imports `dist/safety-policy.js`). `npm run typecheck` is the type gate and covers two projects: the `src` tsconfig and the strict `test/tsconfig.json` (noEmit, `allowImportingTsExtensions`). A test importing a repo `.mjs` script gets a sibling `.d.mts` declaration (see `scripts/lib/pack-boundaries.d.mts`) instead of per-file suppression. Development needs Node >= 22.18 for type stripping — not just for running the `.ts` tests directly but for every script that imports repo TypeScript: the build chain (`scripts/sync-skills.mjs` and `scripts/validate-package.mjs`, via `src/lib/skill-tree.ts` — build, validate, prepack) and the release/verification scripts (`scripts/pack-verify.mjs` via `src/lib/skill-manifest.ts`, plus the pre-existing `scripts/registry-snapshot-diff.mjs` and `scripts/smoke-agents.mjs` importers). The published `engines` mirrors that floor (`>= 22.18`); the shipped artifact itself is compiled `dist/` JS and would run on any 22.x, but git-URL installs execute prepack, so the floor is the honest contract. One runtime dependency (undici for proxy support).

## Architecture

This is an **agent guidance + safety package**, not a service encyclopedia. Six compact meta-skills route agent intent to the right capability path (Skills / KooCLI / API / SDK / MCP / Terraform).

**Skills are server data, with native disclosure for the six core meta-skills.** The skills tree ships next to the MCP server (`plugins/huaweicloud-core/skills/` inside every per-agent plugin dir). The 24 non-core service skills are disclosed through the MCP tools — `huaweicloud_list_packs` (inventory incl. per-pack skill names), `huaweicloud_pack_info`, `huaweicloud_list_skills` (one-call metadata catalog of every enabled non-core pack's skills: name, description, version, pack, reference filenames — plus `skillRoot`, the tree's absolute location, stdio sessions only, so a same-machine agent can read `<skillRoot>/<name>/SKILL.md` and `references/` directly with its own file tools), `huaweicloud_service_catalog` (intent routing), `huaweicloud_search_docs`, and `huaweicloud_retrieve_skill` (its `name` schema is `^[a-z0-9-]+$`, a boundary guard; the gated, telemetry-bearing, portable loader). `DEVKIT_PACKS` gating is disclosure-level: catalog entries never reference a trimmed pack's skills, while the stdio-only `skillRoot` discloses the shared tree (every skill, including trimmed packs' and the six core meta-skills) — the same doctrine `enable.ts` applies to pack handlers. The six core meta-skills are ADDITIONALLY installed as full native copies into the native skill dirs of the eight directory-based agents (opencode, openclaw, codearts user+project, codearts-work, workbuddy, dsh, hermes, atomcode; never codex-desktop or officeace, never the codex/claude/cursor manifest surfaces) for system-prompt visibility. Ownership derives from the per-skill `packOf` map in `skills/.manifest.json` (written by `scripts/sync-skills.mjs`, parsed by the zod-free `src/lib/skill-manifest.ts`; the installer fails loud when it is unusable). Placement rides the `PAYLOAD_TARGETS` rows (`nativeSkills` field) through the single `syncNativeSkillsForTarget` seam in both install and update; convergence is remove-then-copy per skill plus a `.huaweicloud-devkit-native.json` receipt per dir — the ownership memory that separates devkit-managed copies from pre-MCP residue and keeps renamed/retired skills deletable. The receipt codec is one shared module, `src/lib/native-receipt.ts`: the setup CLI imports it as source, and `bin/dsh-postinstall.cjs` loads its compiled `dist/lib/` copy via dynamic `import()` (the same ESM-loading pattern `bin/setup.cjs` uses, so no Node-version dependency) — the two writers of `~/.dsh/skills` cannot drift on the receipt's state machine (shape-broken names classify as corrupt everywhere). The receipt also records WHO placed the copies: the DSH marketplace (npm-in-profile) postinstall writes `layout: 'package-root'` plus its package root. Doctor detects the marketplace layout from the receipt — never from patch-file markers, which the bundled `cordis.patch.yml` a real profile consumes never carries — resolves the freshness comparator and roster from the payload the target actually runs (the profile's package tree, its own manifest), and its remediation is per-layout (the marketplace names the package upgrade; `update --target` would refuse there). Uninstall honors the same attribution, dir-gated to the DSH native dir (a hand-copied package-root receipt anywhere else earns nothing) and liveness-gated: a receipt whose recorded package root still carries a payload tree names the profile package as the maintainer and the copies are left for it; a dead maintainer (npm removed the profile package — nothing devkit-side runs on npm uninstall) protects nothing and the copies go. `packageRoot` is accepted only as an absolute path, control-character-stripped at read, and the shared age-gated `sweepReceiptTmpFiles` (young in-flight tmps of concurrent writers are never taken) reclaims crash residue for both the writer and the uninstall path. `cleanupNativeDirs()` (the old `purgeStaleNativeSkills()`) reconciles every native dir with receipt precision — user skills sharing the `huawei*` prefix always survive, and receipt-remembered names carry delete rights only in dirs a sync row manages — and doctor checks native freshness against each target's installed payload.

```
plugins/huaweicloud-core/
  skills/           ← GENERATED runtime tree (all 30 skills + .manifest.json roster); sources in src/packs/<id>/skills/; a gitignored build artifact (like dist/), regenerated by npm run build (staged swap)
  src/              ← TypeScript MCP server sources (stdio/remote JSON-RPC, 50 tools)
  src/packs/        ← capability packs: per-pack handlers/schemas/skills + registry (ownership truth) + enable (DEVKIT_PACKS)
  dist/             ← tsc output; every runtime entry point loads this
  safety/           ← shared policy.json + risk rules
  hooks/            ← PreToolUse hook (Node huaweicloud-safety.mjs, wired via hooks.json; .py variant kept for compatibility)
  .codex-plugin/    ← Codex plugin manifest
  .claude-plugin/   ← Claude Code plugin manifest
  .cursor-plugin/   ← Cursor plugin manifest
  .workbuddy-plugin/← WorkBuddy plugin manifest
  .hermes-plugin/   ← Hermes plugin manifest
  .mcp.json         ← MCP server config for agents
  openclaw.plugin.json ← OpenClaw plugin manifest
```

Safety is 3-layer: **skills teach → hooks block → MCP/CLI wrappers enforce**.

Also in the repo:

- `bin/setup.cjs` — interactive installer (`huaweicloud-devkit`); dispatches to each agent's plugin dir.
- `integrations/` — per-agent adapter configs (opencode, dsh, hermes, workbuddy, atomcode), separate from the plugin.
- `src/tools.ts` — the 12 core tools plus the `callTool` dispatch: the 38 pack tools go through the central `PACK_TOOL_HANDLERS` map in `src/packs/registry.ts` (compile-time complete via `satisfies Record<PackToolName, …>`), the core tools are switch cases inside `dispatchTool`, the extracted dispatch body, and the default never-guard checks `Exclude<ToolName, PackToolName>`. Cross-cutting concerns (numeric-arg normalization, telemetry, error pass-through) stay at the top of `callTool`, above the `dispatchTool` extraction; with `HUAWEICLOUD_DEVKIT_TRACE` set, `callTool` also wraps every dispatch in the trace seam (`src/lib/call-trace.ts`, recording tool name, redacted args, and ok or error) on both the core and pack paths. Tool names and core descriptions are literal in `TOOL_DEFINITIONS_LITERALS` (the `as const` array `ToolName` derives from); pack tool descriptions are derived from the owning packs' `X_TOOLS` arrays via `packDescription()`, which fails fast at module load on a name with no pack entry — descriptions have exactly one copy, in the pack that owns the tool. Input schemas live in `src/tool-schemas.ts` (zod, single source of truth for validation and tools/list rendering; it spreads each pack's `X_TOOL_SCHEMAS` so its `satisfies Record<ToolName, …>` check still covers all 50). `SKILLS_ROOT` here is `join(__dirname, '..', 'skills')` — server-relative only, no agent-dir probing. The MCP server runs on `@modelcontextprotocol/sdk` (high-level `McpServer` + `registerTool`): `src/mcp-protocol.ts` is the server factory (it also owns the session disclosure re-sync — `huaweicloud_packs_configure` mutates the runtime override and the factory diffs the wanted set against the registered `RegisteredTool` handles, then sends `tools/list_changed`), `src/mcp-stdio-transport.ts` is a custom Transport carrying the dual Content-Length/newline framing (the SDK stdio transport is newline-only), `src/mcp-server-remote.ts` is the stateless Streamable HTTP remote (it never registers `huaweicloud_packs_configure`; the handler also refuses calls whose opts carry no `onPacksChanged` seam, so no cross-request mutable pack state exists there). The SDK and zod are devDependencies bundled into `dist/mcp-server.js` at build time (esbuild; undici stays external) — agent plugin dirs have no SDK node_modules, so nothing else may import the SDK. `scripts/registry-snapshot-diff.mjs` guards the zod schemas against the legacy JSON-Schema snapshot in `test/fixtures/legacy-registry-snapshot.json`.
- `src/packs/` — capability-granularity units. `<id>/tools.ts` co-locates a pack's tool definitions, zod schemas, and handlers (`X_TOOLS` / `X_TOOL_SCHEMAS` / `X_TOOL_HANDLERS`); `<id>/skills/` is the authoritative source for pack-owned skills (all six packs that own skills: core with the six meta-skills, huaweicloud-cli with the twenty service skills, obs, sandbox, voucher, huaweicloud-open-mcp), generated into `skills/` by `scripts/sync-skills.mjs`. `registry.ts` is the composition root: `PACK_OF` (50-key tool → pack ownership truth), `PACKS` (10 packs; `huaweicloud-cli` is a mixed pack — the 20 service skills plus the 7 KooCLI execution tools sunk from core), and the central `PACK_TOOL_HANDLERS` dispatch map. The `huaweicloud-open-mcp` pack proxies the local huaweicloud-open-mcp gateway (Python sidecar): a process-scope singleton in `src/packs/huaweicloud-open-mcp/sidecar.ts` speaking hand-rolled newline JSON-RPC (only `dist/mcp-server.js` may import the MCP SDK), lazily spawned by the first tool call, lifetime bound to the parent's stdin pipe — it dies with the MCP server process, never with an McpServer object (the remote transport closes one per HTTP request). `OPENMCP_BIN` overrides binary resolution (tests point it at `test/fixtures/fake-open-mcp-sidecar.mjs`); the default chain is `~/.local/bin` → PATH (pip, pipx, uv tool install) → a `uvx huaweicloud-open-mcp` fallback that needs no persistent install. `enable.ts` resolves `DEVKIT_PACKS` (unset = all packs, unknown ids fail fast at boot; core is force-included for disclosure — the pack meta tools can never be trimmed away — while the CLI approval chain lives in `huaweicloud-cli` and trims together with the CLI execution face) and owns the session-scoped runtime override (`huaweicloud_packs_configure`, stdio sessions only, never persists, core-floored; a null override means the operator env posture rules). Trimming is disclosure-level: a trimmed pack's handlers stay dispatchable through `callTool`. The open-mcp gateway face delegates authorization to the gateway's own policy engine (empty policy = deny, probed), so a trimmed `core,huaweicloud-open-mcp` configuration carries delegated gateway writes whose control plane is the operator policy file; the devkit-side floors (secret operations, protected tree, manage_policy shape) always load with the pack. The PreToolUse hook keeps denying raw Bash writes regardless. The guard `scripts/lib/pack-boundaries.mjs` (run by both `npm run validate` and `structure.test.ts`) keeps pack modules from importing siblings or the registry at value level.
- `src/dep/` — the dependency subsystem (host binaries packs need: hcloud, open-mcp-gateway, devbridge), organized by abstraction level: `dep/receipts.ts` is the leaf (receipts, the uninstall-decision lock, and the shared contracts `DepUninstallResult` / `ResolvedUninstallContext` / `ManagedChildInstallResult`); `dep/installers/{hcloud,gateway}.ts` are the per-dependency installers (install, manual instructions, escape hatch, receipt-gated uninstall — one module per installable id); `dep/installers/table.ts` is the composition root (`DEP_INSTALLERS` + the kind-shaped installer interfaces, kind-correlated via the `InstallerFor` conditional, `devbridge: null` declares "no host installer"); `dep/provision.ts` is the dependency-agnostic decision core (the provisioning policy loop and the receipt-gated uninstall gate). The declaration half stays in `src/lib/dependency-model.ts` + `src/lib/dep-resolve.ts` — zod-free shared vocabulary the mcp-server graph also imports, deliberately NOT under dep/. Everything under dep/ compiles into the **unbundled** `dist/setup-cli.js` graph (zod-free; `structure.test.ts` walks the `src/dep/` tree to enforce it). **Adding a dependency B**: declare it in `lib/dependency-model.ts` (id + spec + pack edge — `satisfies` makes omissions compile errors), write `src/dep/installers/<id>.ts` exporting its lifecycle, and add the table entry in `dep/installers/table.ts` (the annotation demands one key per `DependencyId`, kind-matched; a missing or wrong-kind entry fails the build, and `dep-provision.test.ts` mirrors the invariant at runtime). Installer defaults are per-id from the table, so a second member of an existing kind provisions through its own installer out of the box; only the `ProvisionOptions` override names are single-member (`probeHcloud`/`installKooCli`/`installGateway`, identity-scoped to their named dependency) — collapsing them into per-id overrides is a cosmetic rename when a second member lands. A cli-kind `uninstall` must escalate sudo -n only onto its own known landing sites (the catalog's platform candidates ∪ the paths the installer places — receipts are untrusted input; precedent `hcloudInstallLandingSites`) and never delete an env-tier (user-override) resolution. Dialog text (manual instructions, confirm-prompt suffix, escape hatch) belongs to the installer, never the loop. Known touchpoints beyond those three files, kept honest on purpose: the `--clean-*` `AccountLevelArtifact` family in `setup-cli.ts` is hand-maintained per artifact (derive it from installers only when a second receipt-gated cleanup shape lands); the cross-platform install runner extraction is deferred until a second archive-shaped installer exists (one adapter is a hypothetical seam); `DepReceipt.tier` stays centrally whitelisted in `readReceipt` (receipts are untrusted input — never make the tier opaque per-adapter); doctor's hcloud block is a deliberate id-island (version pinning — other deps get the generic resolution check); and if a pack's MCP tools must probe the dependency, the module joins `scripts/lib/pack-boundaries.mjs`'s `CORE_VALUE_FILES` (precedent: `hcloud-probe.ts`). `dep install <id>` bypasses installPolicy **deliberately** — it is the explicit CI path and downloads on non-TTY; only the provisioning policy loop refuses non-TTY downloads.
- `src/setup-cli.ts` — installer/doctor logic; honors `HCLOUD_BIN`. Every install/update path ships the server payload (dist + safety + skills) through `copyServerPayload()` (which also prunes retired skill names from the plugin-dir tree) and reconciles the native core-skill copies through the `PAYLOAD_TARGETS`-driven `syncNativeSkillsForTarget` seam plus `cleanupNativeDirs()` — but only when the run will actually place the payload. Also owns the post-install `packs` command family (`packs status | enable <ids> | disable <ids> | all [--target]`), which rewrites `DEVKIT_PACKS` in each installed target's MCP config through the per-target slot table — the one write path allowed to overwrite an existing value, since the command is the operator's explicit management action (install-time `--packs` never overwrites, per the keptUserValue contract). Compiles to `dist/setup-cli.js`, the entry `bin/setup.cjs` loads.
- `scripts/*.mjs` — validation, version sync, packaging, release helpers.
- `.superpowers/` + `docs/superpowers/` — planning/spec workflow used for larger changes.

## Skill Naming: Meta vs Service

- **Meta-skills** (`huaweicloud-*`, 6 required): horizontal capability skills such as routing, discovery, CLI/auth, API/SDK, safety, troubleshooting. Owned by the `core` pack (force-enabled). Agent always starts here.
- **Service skills** (`huawei-*`, 20): vertical domain knowledge for specific Huawei Cloud services (ecs, vpc, iam, dew, ...). All owned by the zero-tool `huaweicloud-cli` pack, so `DEVKIT_PACKS` can trim them for CLI-only agents; sources live in `src/packs/huaweicloud-cli/skills/`, generated into `skills/` by `npm run build` (or `npm run skills:sync` on demand). Agents load them through `huaweicloud_retrieve_skill` (names and descriptions come from `huaweicloud_list_skills` / `huaweicloud_list_packs` / `huaweicloud_service_catalog` / `huaweicloud_search_docs`), or — on stdio sessions — read the files directly under the `skillRoot` the list_skills payload discloses.

Required meta-skills (tethered to `test/structure.test.ts`):
`huaweicloud-api-and-sdk`, `huaweicloud-capability-discovery`, `huaweicloud-cli-and-auth`, `huaweicloud-core`, `huaweicloud-safety`, `huaweicloud-troubleshooting`

## File Naming: Design Docs vs Implementation

`docs/` holds planning/design artifacts (`*-design.md`, `architecture.md`, `safety-model.md`, ...). These are historical and may lag reality. The **actual implementation** is in `plugins/huaweicloud-core/` — `huaweicloud-*` for meta-skills and `huawei-*` for service skills. Trust the filesystem, not the docs.

## Creating or Editing Skills

- Every `SKILL.md` must start with `---\nname: huaweicloud-<name>` or `---\nname: huawei-<name>` YAML frontmatter (validated by both `npm run validate` and `structure.test.ts`)
- No `TODO` or `[TODO]` markers in committed files (also validated)
- The 6 meta-skills must always exist. Service skills can be added freely. `test/structure.test.ts` enforces a minimum of 6 skills and `scripts/validate-package.mjs` a minimum of 5; the installed set is not an exact count.
- Update `test/structure.test.ts` if introducing new testable invariants (e.g., new required sections in SKILL.md)
- Add `node --test` tests if introducing new measurable invariants

### Skill Design Principles

**Frontmatter description forms.** `src/lib/skill-frontmatter.ts` (the one parser behind search_docs, retrieve_skill, list_skills) supports unquoted single-line, single-quoted (multi-line; `''` escapes a quote; one blank line folds to one newline), and double-quoted (`\"`, `\\`, `\n` escapes only) descriptions. A key-shaped line (e.g. `version: 2`) inside a quoted description is description content, never a hijacked field; unsupported forms (block scalars `>`/`|`) fail the structure invariant.

**Parameters are discovered via `--help`, not hardcoded.** Every service skill must instruct the agent:

> Always run `hcloud <Service> <Operation> --help` before constructing commands to discover exact parameter names and requirements.

The skill provides the correct **service name and operation names** (which agents cannot reliably discover). Parameters come from `--help` (which is self-documenting and never stale).

**Three-class parameter value rule.** When a command in a SKILL.md or reference file contains a concrete value (not a `<placeholder>`), classify it before committing:

| Class           | Definition                                | Action                           |
| --------------- | ----------------------------------------- | -------------------------------- |
| **HELPFUL**     | `--help` cannot reveal this knowledge     | **Keep** the concrete value      |
| **UNNECESSARY** | `--help` already documents this correctly | **Replace** with `<placeholder>` |
| **WRONG**       | Contradicts what `--help` says            | **Fix immediately**              |

```
HELPFUL examples (keep):
  --publicip.associate_instance_type=PORT   # ECS→PORT mapping is non-obvious
  --x_cff_request_version=v0                # v0=raw, v1=APIG-wrapped semantics
  --delete_publicip=true                    # default=false leaks EIP; teach override
  --code_type=inline                        # zip unreliable on KooCLI
  --loadbalancer_provider=elb               # elb=public, lvs=internal-only

UNNECESSARY examples (replace with placeholder):
  --publicip.type=5_bgp       → <type>       # --help lists valid types
  --bandwidth.size=5          → <size>       # user-determined
  --security_group_rule.direction=ingress → <direction>  # --help lists ingress/egress
  --server.root_volume.volumetype=SSD → <type>          # --help lists SSD/SAS/…
  --cli-region=cn-north-4     → <region>     # example region
```

**Duplication rule:** If the same UNNECESSARY value repeats across 3+ files, fix all occurrences together. Single-occurrence values in reference files are acceptable tradeoffs for teaching clarity.

**Reference files vs SKILL.md:** SKILL.md is the routing layer (~80 lines) — prefer placeholders or omit inline values entirely. `references/*.md` are teaching files — complete working commands are expected, but UNNECESSARY values should still use placeholders unless the value itself is the teaching point.

**Only document non-obvious traps.** If `--help` already explains a parameter correctly, don't repeat it. Document what `--help` gets wrong:

- Parameters marked optional that are actually required (e.g., `protocol`/`sl_domain`/`env_name`/`env_id` for DEDICATEDGATEWAY)
- Deprecated values (e.g., `APIG` trigger type, use `DEDICATEDGATEWAY`)
- Format traps (e.g., event_data uses dotted `--event_data.key=value`, NOT JSON strings)
- Hidden behavior (e.g., `--code_filename` is filename-only, no paths; `:latest` suffix breaks DeleteFunction)

**Cross-skill references must not be dead ends.** If skill A says "see skill B for X", skill B must actually cover X. Cross-skill references are the most common failure point in end-to-end workflows.

**Target ~80 lines per SKILL.md.** Move detailed examples and parameter tables to `references/` files. The SKILL.md is the routing layer; references are loaded on demand.

**Update skills from real test failures, not speculation.** Every gotcha added to a skill should trace back to an actual error encountered during testing.

### CLI Command Construction: 4-Step Workflow

Before executing any `hcloud` command, follow this discovery chain:

```
1. hcloud --help                     → discover available services
2. hcloud <Service> --help           → discover available operations
3. hcloud <Service> <Operation> --help → discover exact parameter names
4. Execute the command
```

Service skills may skip steps 1-2 when the correct service name and operation are already provided.

## Safety Model

Write-capable `hcloud` commands are blocked by default. The only write path for hcloud command I/O is `huaweicloud_run_approved_command` (owned by the `huaweicloud-cli` pack), which requires `args` + `approvalToken` + `approvedByUser: true`. Non-hcloud tools that mutate state by design (e.g., `huaweicloud_auth_init`, `huaweicloud_voucher_claim`, `huaweicloud_sandbox_connect`, `huaweicloud_upgrade`) do not require approval.

Policy vocabulary lives in `plugins/huaweicloud-core/safety/policy.json`. Both `src/safety-policy.ts` and `hooks/huaweicloud-safety.py` read from it. If you add a blocked pattern, update the policy JSON, not just one enforcement layer.

The encrypted secret vault (`secret://<scope>/<name>` refs, `src/lib/secret-vault/` — refs/custody/store/cli, zod-free so it sits in the setup-cli graph) backs the `secrets` pack (`huaweicloud_secret_set/list/delete`, no value-retrieval tool, withheld from the unauthenticated remote surface via `remoteSurface`) and the `secret` CLI family. AES-256-GCM with the custody master key (OS keychain, else 0600 keyfile), ref as AAD. S1 credential values may be refs; every PROPAGATING consumer folds `readGlobalCredentialsStrict()` (the seam in `src/auth/credentials.ts`), display paths degrade to the raw read with `s1RefError` surfaced. The classifier unwraps `secret exec … --` wrappers (any bin spelling, any position) so embedded hcloud writes keep their deny; `blockedSecretCliPatterns` (matched against a quote-stripped shadow) denies the `secret get` reveal on the agent Bash face in all three hook layers. Variable/command indirection building the reveal is a documented residual in the safety skill's `references/secrets.md`.

## Before You Commit

```bash
npm run lint            # markdownlint + ESLint
npm test                # node --test (includes structure.test.ts and the jscpd new-duplication gate)
npm run validate        # package/version/skill/kooCli pairing checks
npm run format          # prettier --write
npm run pack:verify     # simulate npm pack, catch missing files (e.g. new manifests)
```

If you changed a SKILL.md, add or update a guard in `test/structure.test.ts` and the corresponding test. If you changed the paired KooCLI version, run `npm run validate` to confirm every pinned URL matches. Release process: see `docs/RELEASING.md`.

## Common Gotchas

- KooCLI 7.x uses `--param=value`, not space-separated. Array params are 1-indexed (`nics.1.subnet_id`, not `.0`).
- KooCLI's English service catalog (`~/.hcloud/metaRepo/services_en.json`) is incomplete (~70 services, incl. BSS). `Unsupported service: X` usually means the en catalog lacks the service — `hcloud-cli.ts` detects the cause and advises the global switch `hcloud configure set --cli-lang=cn`. KooCLI rejects a per-command `--cli-lang` flag, so never append one; keep `classifyUnsupported`/`readServiceCatalogs` presence semantics (file missing → `unknown`, not `lang-missing`).
- `hcloud` must be in PATH or `HCLOUD_BIN` set. Agent processes inherit the environment of their launcher.
- Codex and WorkBuddy manifests (`plugin.json`) must NOT include a `hooks` field — Codex fails schema validation, WorkBuddy triggers manual trust prompts.
- `npm version` only bumps `package.json`. Run `node scripts/sync-version.mjs` to sync the 5 plugin manifests (`.codex-plugin`, `.claude-plugin`, `.cursor-plugin`, `.workbuddy-plugin`, `.hermes-plugin`). `npm run validate` enforces version parity across 7 files and will fail if root `plugin.json` or `openclaw.plugin.json` is out of sync.
- KooCLI version is paired via `kooCliVersion` in `package.json` (single source of truth). Install URLs in `src/setup-cli.ts` and skills must pin `cli/<kooCliVersion>`; the `hcloud_install.sh` one-liner is the only allowed `cli/latest` (it cannot be pinned). `npm run validate` enforces this — before releasing, confirm whether `kooCliVersion` should bump to the latest KooCLI. `check_cli`/`doctor` warn (soft, non-blocking) when the installed `hcloud version` does not exactly match.
- Skills are compact routing workflows, not service docs. Do not copy Huawei Cloud documentation into them. Point to `support.huaweicloud.com` instead.
- For complex params (nested objects, arrays with special characters), prefer `--cli-jsonInput=<file>` over inline quoting to avoid shell escaping traps.
- `HCLOUD_BIN` must be respected consistently across ALL tools and scripts (check_cli, doctor, runHcloud, etc.). Use `process.env.HCLOUD_BIN || 'hcloud'` everywhere, never hardcode `'hcloud'`.
- OBS via KooCLI uses obsutil-style commands: `hcloud OBS help` (not `--help`), subcommands like `mb`/`cp`/`rm`/`chattri`. Always use `-f` to avoid interactive prompts that hang agents.
- Bucket ACL does NOT cascade to objects. For static websites, set both bucket-level AND object-level `-acl=public-read`.
- `InvokeFunction` / `Execute` / `Trigger` / `Deploy` operations are classified as write (require approval) — they have execution side effects even without data mutation.
- Codex plugin marketplace name is read from `.agents/plugins/marketplace.json`. `getMarketplaceName()` must match, never hardcode.
- OpenCode integration lives in `integrations/opencode/` (separate from the plugin).
- Node >= 22.18 required (engines), ESM only. Type stripping is on the whole build chain, not just the `.ts` test suite: build/validate/prepack scripts import repo `.ts` modules, and git-URL installs run prepack — on older 22.x the chain dies with `ERR_UNKNOWN_FILE_EXTENSION .ts`.
- Test temp fixtures: create them through the shared `fixtureDir()` registry (`test/fixture-dir.ts` — registry-created dirs are removed at process exit) or clean them per-test. `test/structure.test.ts` enforces this deny-by-default: a `test/*.test.ts` with raw `mkdtempSync` must import the registry or sit on the per-test-cleaner allowlist. Never run the suite with `TMPDIR=$HOME` — the 2026-10-09 ext4 lock-verification runs leaked 614 fixture dirs into the home directory that way (the same leak is invisible on tmpfs `/tmp`, where reboots erase it). Signal death (SIGKILL/SIGINT/SIGTERM) skips exit handlers, so an interrupted run can still leave dirs behind.
- Test helpers that spawn `install` against a fake HOME are network-bound: every cold-cache install fetches undici from the npm registry into `$HOME/.npm` (measured 79s on a high-latency registry day; seconds when warm). That is why install-bearing helpers use `timeout: 240000` — a 60s bound kills installs mid-flight (spawn status `null`) and reads as a test failure, not a network flake.
- npm tarballs ship a built `dist/` and generated `skills/` tree (prepack). Neither is committed: a raw git clone or marketplace file copy lacks both — run `npm run build` before using `.mcp.json`/`bin/setup.cjs` from a checkout. The safety hook wrapper falls back to the `.ts` source on its own, but the MCP server config does not; a missing skills tree makes the MCP server refuse to start (fail-loud by design).
- jscpd (`npm run lint:dup`) gates _new_ duplication only. The committed `.jscpd-baseline.json` fingerprints the legacy clones (generated from the v2 tree); the gate compares against it, never against a branch ref, and there is deliberately no `threshold` (total-percentage gates fail builds on legacy duplication and are the documented top reason teams disable copy/paste gates). Scan scope: hand-written TS/JS under `plugins/huaweicloud-core/src`, `hooks`, `scripts`, `bin`, `test`, `integrations`, plus `eslint.config.mjs`. Exclusion works by three mechanisms, not one: the roots keep the generated `plugins/huaweicloud-core/skills/` tree (now also gitignored) and the root `skills/` dir out; the `formats` restriction is a TypeScript-and-JavaScript allowlist — the authoritative skill sources inside the scanned `src` root (`src/packs/*/skills/`) are markdown and therefore excluded, and a TypeScript or JavaScript file added there is scanned; the `ignore` globs cover `**/dist/**` (belt-and-braces; the built tree already sits outside the roots), `*.d.mts` declaration twins, `test/fixtures/`, and the `test/huaweicloud-*` scaffolding. Legitimate regen-worthy hits: moved-not-deleted duplication (extracting one copy of an intra-file self-clone into a helper), intentional test repetition, and edits inside a baselined clone region. Fingerprints are whitespace-sensitive: run `npm run format` before regenerating with `npm run lint:dup -- --baseline .jscpd-baseline.json --update-baseline`, then commit the file alongside the change. When upgrading jscpd, keep the exact pin (ratchet flags are documented only in `--help`), re-check config parity (a config-file run must match a CLI-flag run), and regenerate the baseline. The generated skills tree is likewise excluded from `.prettierignore` and the `lint:md` globs: its rendered shape is pinned by the packs-sync round-trip test and the `--check` gate, not by the formatters.
- When verifying a gate from a shell, capture the exit code directly (`cmd > /tmp/gate.log 2>&1; echo $?`) — never through a pipe (`cmd | tail; echo $?` reports tail's exit code, not the command's). A masked-exit-code "lint green" claim is how a red eslint shipped as green in this repo's history; the same applies to any summarized gate output. On a shared checkout, serialize heavyweight gates (`npm test` and `npm run pack:verify` race each other's staging swaps).
