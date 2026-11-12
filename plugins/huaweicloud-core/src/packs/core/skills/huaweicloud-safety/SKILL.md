---
name: huaweicloud-safety
description: Huawei Cloud safety policy for agents. Use when handling credentials, secrets, IAM, public exposure, billing, destructive actions, scaling, write operations, hooks, command approval, output redaction, or risk review.
---

# Huawei Cloud Safety

**STOP - Do not answer from general knowledge.** Follow the procedure below.

Use this skill before any Huawei Cloud action that may expose secrets, change resources, affect cost, change IAM, or expose a network endpoint.

## Rules

1. Never ask the user to paste AK/SK, SK, tokens, passwords, private keys, or credential files.
2. Never read local `.hcloud` or `.huaweicloud` credential files into the agent context.
3. Never call APIs or CLI operations that return secret values directly into the agent context.
4. Always classify operations before execution:
   - read-only
   - write
   - secret
   - IAM/security
   - cost/payment
   - public exposure
5. For any non-read-only operation, follow the plan, confirm, run contract: plan with `huaweicloud_plan_cli_command`, show the user the command, then run with `huaweicloud_run_approved_command`. The confirm step follows the plan's `userConfirmation`: by default (token mode) show the terminal confirmation line and wait for the user to run it in their own terminal; when `userConfirmation.mode` is `ask`, call the run tool directly — the harness client prompts the user on that call. See `references/approvals.md`.
6. Redact secrets from command output, errors, JSON, logs, and generated reports.
7. If a command contains `adminPass`, `password`, token, or any secret-like field, warn that plaintext can remain in shell history. Prefer local-only input, runtime injection, or user-side execution.

## Enforcement Layers

- Hooks: `hooks/huaweicloud-safety.mjs` blocks risky Codex native hook calls without requiring Python; `hooks/huaweicloud-safety.py` remains for Hermes/Python hook compatibility. The hook also denies the `approve` and `pin` verbs on the agent Bash face.
- MCP wrapper: the Node MCP server applies the same safety policy for Codex/OpenCode paths that do not enforce hooks, and the run tool refuses a non-read command without the user's terminal confirmation.
- Skills: this document teaches agents the rule before they act.

## Write Execution Boundary

1. Plan: call `huaweicloud_plan_cli_command`. The result echoes the exact command and carries `userConfirmation: { needed, command }` in the default token mode, or `userConfirmation: { needed, mode: "ask", note }` when the plan ran under `DEVKIT_APPROVAL_MODE=ask`.
2. Confirm (token mode, the default): when `needed` is true, show the user the plan echo and the `userConfirmation.command` line (`npx huaweicloud-devkit approve <approvalToken>`), then wait. The USER runs that line in their own terminal, where a TTY check and a PIN gate the confirmation. First use: the user runs `npx huaweicloud-devkit pin` once in their own terminal to enroll the PIN.
3. Confirm (ask mode): when `userConfirmation.mode` is `ask`, there is no terminal line and no token. Call `huaweicloud_run_approved_command` with the same args and `approvedByUser: true`; the harness client prompts the user on that call, and that prompt IS the confirmation.
4. Run: call `huaweicloud_run_approved_command` with the same `args` and `approvedByUser: true`, plus the plan's `approvalToken` in token mode — no token in ask mode.

In token mode, a non-read command without that terminal confirmation is rejected with `USER_CONFIRMATION_REQUIRED`. The refusal does not consume the token, so retry the same call after the user confirms. Re-running a write needs a fresh plan and a fresh confirmation. In ask mode there is no token to refuse or consume; a retried call prompts the user again.

Never run the approve or pin commands yourself; the hook denies both verbs on the agent's Bash face. The `approvedByUser: true` argument is not the terminal confirmation and never replaces it (in ask mode the harness client's own prompt is the confirmation the server trusts).

Without the devkit tools, show the reviewed command and let the user execute it in their own terminal. After a write, verify with `huaweicloud_run_readonly_command` or another read-only check.

## Proactive Hook Checks

Before executing, deploying, or handing generated cloud artifacts to the user, run the matching check when available:

- `huaweicloud_hook_check_command` for shell or KooCLI command text.
- `huaweicloud_hook_check_artifacts` for generated policy, IaC, config, workflow, or deployment files.
- `huaweicloud_hook_check_deploy_plan` for sandbox, preview, FunctionGraph, ECS, CCE, APIG, OBS, IAM, or cost-affecting plans.

If the result is `deny`, repair the command, artifact, or deployment plan before execution. If the result is `warn`, show the warning to the user and repair or ask for explicit confirmation.

## Static Analysis Boundary

Hook checks inspect the command or plan text that is available before execution. If a command builds cloud parameters through shell variables, string concatenation, subshells, encoded payloads, or generated scripts, first expand the final command into reviewable text and run `huaweicloud_hook_check_command` on that final form. When the final values cannot be determined, stop and ask the user to review the expanded command or use `huaweicloud_plan_cli_command` before execution.

## Safe Alternatives

- Use redacted profile inspection instead of raw `hcloud configure show`.
- Use runtime secret injection instead of fetching secret values into chat.
- Use the encrypted secret vault for durable secrets: store values as `secret://<scope>/<name>` refs and pass refs, never values. See `references/secrets.md`.
- Use the approval contract for writes: plan, user confirm, run — token mode by default, the harness client's permission prompt when `DEVKIT_APPROVAL_MODE=ask`. See `references/approvals.md`.
- Use read-only verification after a write.
- Prefer reviewed IaC for durable infrastructure changes.
