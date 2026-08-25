# AGENTS.md — HuaweiCloud Devkit

## Commands

```bash
npm test                 # all tests (node --test)
npm run lint             # ESLint + markdownlint
npm run lint:js          # ESLint only
npm run lint:md          # markdownlint only
npm run format           # Prettier format all files
npm run format:check     # Prettier check (no write)
npm run validate         # structural validation
node --test test/structure.test.mjs   # single test file
node ./scripts/validate-package.mjs   # validation alone
```

No build step, no typecheck. One runtime dependency (undici for proxy support).

## Architecture

This is an **agent guidance + safety package**, not a service encyclopedia. Six compact meta-skills route agent intent to the right capability path (Skills / KooCLI / API / SDK / MCP / Terraform).

```
plugins/huaweicloud-core/
  skills/           ← 6 meta-skills + service skills
  src/              ← Node.js MCP server (stdio JSON-RPC, 13 tools)
  safety/           ← shared policy.json
  hooks/            ← Python PreToolUse hook
  .codex-plugin/    ← Codex plugin manifest
  .claude-plugin/   ← Claude Code plugin manifest
  .cursor-plugin/   ← Cursor plugin manifest
  .officeace-plugin/← OfficeAce plugin manifest
  .mcp.json         ← MCP server config for agents
```

Safety is 3-layer: **skills teach → hooks block → MCP/CLI wrappers enforce**.

## Skill Naming: Meta vs Service

- **Meta-skills** (`huaweicloud-*`, 6 required): horizontal capability skills such as routing, discovery, CLI/auth, API/SDK, safety, troubleshooting. Agent always starts here.
- **Service skills** (`huawei-*`): vertical domain knowledge for specific Huawei Cloud services (ecs, obs, vpc, iam, dew, etc.). Loaded via `huaweicloud_retrieve_skill` after routing by the core meta-skill.

Required meta-skills (tethered to `test/structure.test.mjs`):
`huaweicloud-api-and-sdk`, `huaweicloud-capability-discovery`, `huaweicloud-cli-and-auth`, `huaweicloud-core`, `huaweicloud-safety`, `huaweicloud-troubleshooting`

## File Naming: Design Docs vs Implementation

Design docs in `docs/` use `huawei-*` and plan 20+ service skills. The **actual implementation** uses `huaweicloud-*` for meta-skills and `huawei-*` for service skills. Design docs are planning artifacts; trust the filesystem.

## Creating or Editing Skills

- Every `SKILL.md` must start with `---\nname: huaweicloud-<name>` or `---\nname: huawei-<name>` YAML frontmatter (validated by both `npm run validate` and `structure.test.mjs`)
- No `TODO` or `[TODO]` markers in committed files (also validated)
- The 6 meta-skills must always exist. Service skills can be added freely — `test/structure.test.mjs` enforces a minimum of 6, not an exact count.
- Update `test/structure.test.mjs` if introducing new testable invariants (e.g., new required sections in SKILL.md)
- Add `node --test` tests if introducing new measurable invariants

### Skill Design Principles

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

Write operations are blocked by default. The only write path is `huaweicloud_run_approved_command`, which requires `approvedCommand` + `approvedByUser: true`.

Policy vocabulary lives in `plugins/huaweicloud-core/safety/policy.json`. Both `src/safety-policy.mjs` and `hooks/huaweicloud-safety.py` read from it. If you add a blocked pattern, update the policy JSON, not just one enforcement layer.

## Common Gotchas

- KooCLI 7.x uses `--param=value`, not space-separated. Array params are 1-indexed (`nics.1.subnet_id`, not `.0`).
- `hcloud` must be in PATH or `HCLOUD_BIN` set. Agent processes inherit the environment of their launcher.
- Codex manifest (`plugin.json`) must NOT include a `hooks` field — it fails schema validation.
- `npm version` only bumps `package.json`. When changing version, also update `plugins/huaweicloud-core/.codex-plugin/plugin.json`, `.claude-plugin/plugin.json`, `.cursor-plugin/plugin.json`. The `npm run validate` script enforces they match.
- Skills are compact routing workflows, not service docs. Do not copy Huawei Cloud documentation into them. Point to `support.huaweicloud.com` instead.
- For complex params (nested objects, arrays with special characters), prefer `--cli-jsonInput=<file>` over inline quoting to avoid shell escaping traps.
- `HCLOUD_BIN` must be respected consistently across ALL tools and scripts (check_cli, doctor, runHcloud, etc.). Use `process.env.HCLOUD_BIN || 'hcloud'` everywhere, never hardcode `'hcloud'`.
- OBS via KooCLI uses obsutil-style commands: `hcloud OBS help` (not `--help`), subcommands like `mb`/`cp`/`rm`/`chattri`. Always use `-f` to avoid interactive prompts that hang agents.
- Bucket ACL does NOT cascade to objects. For static websites, set both bucket-level AND object-level `-acl=public-read`.
- `InvokeFunction` / `Execute` / `Trigger` / `Deploy` operations are classified as write (require approval) — they have execution side effects even without data mutation.
- Codex plugin marketplace name is read from `.agents/plugins/marketplace.json`. `getMarketplaceName()` must match, never hardcode.
- OpenCode integration lives in `integrations/opencode/` (separate from the plugin).
- Node >= 20 required, ESM only.
