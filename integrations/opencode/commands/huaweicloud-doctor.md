---
description: Self-check Huawei Cloud DevKit readiness — hcloud, MCP, skills, auth.
---

Use HuaweiCloud DevKit tools and skills to perform a comprehensive readiness check:

1. Check if KooCLI `hcloud` is installed: `huaweicloud_check_cli`. If not, guide user to install.
2. Check if hcloud has active credentials: `hcloud configure list` (redacted).
3. List installed skills via `huaweicloud_search_docs` or count directories in `~/.config/opencode/skills/`.
4. Verify MCP server is reachable by calling any read-only tool.
5. Summarize: installed (OK) vs missing (action needed).
6. Do not print AK/SK, tokens, passwords, credential files, or raw profile secrets.

If MCP tools are unavailable (fresh install), run `npx huaweicloud-devkit doctor` in terminal.
