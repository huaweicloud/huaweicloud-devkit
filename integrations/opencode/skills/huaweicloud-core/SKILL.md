---
name: huaweicloud-core
description: OpenCode entry skill for HuaweiCloud DevKit. Use when a developer asks OpenCode to use Huawei Cloud Skills, KooCLI, APIs, SDKs, future MCP tools, or low-priority Terraform guidance.
---

# Huawei Cloud Core For OpenCode

Use this skill as the OpenCode entry point. Prefer the full skill set under `plugins/huaweicloud-core/skills/` when the repository is available, or install those skills into OpenCode's skill directory with `scripts/install-opencode-local.ps1`.

## Routing

1. Use Huawei Cloud Skills for scenario workflows.
2. Use KooCLI `hcloud` for local read-only inspection and reviewed commands.
3. Use official API docs for exact request and response contracts.
4. Use SDK docs when writing application integration code.
5. Use approved MCP tools when they exist.
6. Keep Terraform Provider low priority in V1; mention it for reviewed IaC only.

## Safety

Never ask the user to paste credentials. Never read `.hcloud` or `.huaweicloud` files into context. Plan writes first, ask for explicit approval, then verify with read-only checks.

For commands that assemble Huawei Cloud parameters through variables, string concatenation, subshells, encoded payloads, or generated scripts, inspect the final expanded command text before execution. If OpenCode cannot determine the final values, ask for explicit review or run the planning/check tool on the expanded command.

## KooCLI Basics

- Install guide: `https://support.huaweicloud.com/qs-hcli/hcli_02_003.html`.
- Verify with `hcloud version`; set `HCLOUD_BIN` if OpenCode cannot find `hcloud`.
- Discover exact operations with `hcloud <Service> --help` before guessing.
- Prefer `--param=value`; array indexes start at 1, for example `--server.nics.1.subnet_id=<subnet-id>`.
- Respect region intent: Singapore -> `ap-southeast-3`, Hong Kong -> `ap-southeast-2`, Beijing -> `cn-north-4`. Do not scan all regions blindly.
- Warn before commands containing `adminPass`, `password`, tokens, or other values that may remain in shell history.
