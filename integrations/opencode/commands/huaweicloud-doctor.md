---
description: Self-check Huawei Cloud DevKit readiness — hcloud, MCP, skills, auth.
---

Use HuaweiCloud DevKit tools to perform a comprehensive readiness check:

1. Check if KooCLI `hcloud` is installed: `huaweicloud_check_cli`. If not, guide user to install.
2. Check if hcloud has active credentials: `hcloud configure list` (redacted).
3. List the devkit skill inventory via `huaweicloud_list_packs` (each pack carries its skill names) and browse skill metadata with `huaweicloud_list_skills`. Service skills are server data disclosed over MCP, never files in `~/.config/opencode/skills/` (the stdio list_skills payload carries `skillRoot` — the server-side tree's location — for direct reads); the six core meta-skills (`huaweicloud-*`) are additionally installed there as native copies for system-prompt visibility, and `npx huaweicloud-devkit doctor` verifies them against the installed payload.
4. Verify MCP server is reachable by calling any read-only tool.
5. Summarize: installed (OK) vs missing (action needed).
6. Do not print AK/SK, tokens, passwords, credential files, or raw profile secrets.

If MCP tools are unavailable (fresh install), run `npx huaweicloud-devkit doctor` in terminal.
