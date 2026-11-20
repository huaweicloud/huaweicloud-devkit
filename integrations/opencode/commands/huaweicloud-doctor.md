---
description: Self-check Huawei Cloud DevKit readiness — hcloud, MCP, skills, auth.
---

Use HuaweiCloud DevKit tools to perform a comprehensive readiness check:

1. Check if KooCLI `hcloud` is installed: `huaweicloud_check_cli`. If not, guide user to install.
2. Check if hcloud has active credentials: `hcloud configure list` (redacted).
3. List the devkit skill inventory via `huaweicloud_list_packs` (each pack carries its skill names) and browse the effective skill catalog with `huaweicloud_list_skills` (which skills are ENABLED is pack-gated and can change at runtime). Service skills are server data disclosed over MCP, never files in `~/.config/opencode/skills/` (the stdio MCP server instructions state `skillRoot`, the server-side tree's location, at initialize, and the list_skills payload carries it too — the default load path is action-first: attempt the direct read, the attempt itself is the reachability check; if the attempted read fails or is denied, fall back to `huaweicloud_retrieve_skill` — it needs no file access); the six core meta-skills (`huaweicloud-*`) are additionally installed there as native copies for system-prompt visibility, and `npx huaweicloud-devkit doctor` verifies them against the installed payload.
4. Verify MCP server is reachable by calling any read-only tool.
5. Summarize: installed (OK) vs missing (action needed).
6. Do not print AK/SK, tokens, passwords, credential files, or raw profile secrets.
7. If direct skill reads prompt for approval, delegate to `npx huaweicloud-devkit doctor` — it verifies the skills-tree permission seam (the installer writes an `external_directory` allow paired with an `edit` deny over the skills-tree globs, plus an edit-only `deny` over the plugin payload root `huaweicloud-plugins/**` so the edit tools cannot rewrite the deployed classifier; honest semantics: the allow covers every path-taking tool including bash — shell-mediated writes to the tree stop asking — while the edit deny governs only the edit tools) and prints remediation when rules are missing or user-owned.

If MCP tools are unavailable (fresh install), run `npx huaweicloud-devkit doctor` in terminal.
