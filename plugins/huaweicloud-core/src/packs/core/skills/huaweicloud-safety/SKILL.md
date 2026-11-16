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
5. For any non-read-only operation, follow the plan, confirm, run contract: plan with `huaweicloud_plan_cli_command`, show the user the command, then run with `huaweicloud_run_approved_command`. The confirm step follows the plan's `userConfirmation`: by default (token mode) show the terminal confirmation line and wait for the user to run it in their own terminal; when `userConfirmation.mode` is `ask`, call the run tool and let the SERVER ask the user — a capable client raises a form during the call, and any other client answers with `ASK_CONFIRMATION_REQUIRED` so you can show the command in chat and retry with `approvedByUser: true`. See `references/approvals.md`. The same gate covers the registered non-CLI mutators (`huaweicloud_obs_set_website_config`, `huaweicloud_obs_set_cors`, `huaweicloud_upgrade`, `huaweicloud_secret_delete`, `huaweicloud_packs_configure`): call the tool and let the gate confirm — obs `action=get` runs unconfirmed as a signed read; the shell CLI twins (`update`/`upgrade`, `secret rm`, `packs enable/disable`) are hook-denied on the Bash face.
6. Redact secrets from command output, errors, JSON, logs, and generated reports.
7. If a command contains `adminPass`, `password`, token, or any secret-like field, warn that plaintext can remain in shell history. Prefer local-only input, runtime injection, or user-side execution.

## Enforcement Layers

- Hooks: `hooks/huaweicloud-safety.mjs` blocks risky Codex native hook calls without requiring Python; `hooks/huaweicloud-safety.py` remains for Hermes/Python hook compatibility. The hook also denies the `approve`, `pin`, and account-switch (`auth init` / `auth sync`) verbs on the agent Bash face — those CLIs are the operator's own terminal surface, and the account switch is approval-gated on the MCP tools.
- MCP wrapper: the Node MCP server applies the same safety policy for Codex/OpenCode paths that do not enforce hooks, and the run tool refuses a non-read command without the user's terminal confirmation.
- Skills: this document teaches agents the rule before they act.

## Write Execution Boundary

1. Plan: call `huaweicloud_plan_cli_command`. The result echoes the exact command and carries `userConfirmation: { needed, command }` in the default token mode, or `userConfirmation: { needed, mode: "ask", note }` when the plan ran under `DEVKIT_APPROVAL_MODE=ask`.
2. Confirm (token mode, the default): when `needed` is true, show the user the plan echo and the `userConfirmation.command` line (`npx huaweicloud-devkit approve <approvalToken>`), then wait. The USER runs that line in their own terminal, where a TTY check and a PIN gate the confirmation. First use: the user runs `npx huaweicloud-devkit pin` once in their own terminal to enroll the PIN.
3. Confirm (ask mode): when `userConfirmation.mode` is `ask`, there is no terminal line and no token. The FIRST unattested call to `huaweicloud_run_approved_command` (same args and the `command` field, no `approvedByUser`) makes the server ask: an elicitation-capable client renders a form, and any other client returns `ASK_CONFIRMATION_REQUIRED`, whose envelope carries the command — show it to the user in chat, then retry that same call with `approvedByUser: true`. That retry is model-relayed posture trust, labeled as such, and its envelope stays live for the session's TTL, so further identical retries of the SAME command execute without re-asking. Different args get their own envelope first.
4. Run: in token mode call `huaweicloud_run_approved_command` with the same `args`, the `command` field, the plan's `approvalToken`, and `approvedByUser: true`. In ask mode the run call IS the confirmation (step 3): withhold `approvedByUser: true` on the FIRST call so the server asks, and send it only on the retry after the user answered in chat.

In token mode, a non-read command without that terminal confirmation is rejected with `USER_CONFIRMATION_REQUIRED`. The refusal does not consume the token, so retry the same call after the user confirms. Re-running a write needs a fresh plan and a fresh confirmation. In ask mode there is no token to refuse or consume: a new command line asks the user first, and a declined, dismissed, or timed-out form refuses fail-closed. Once the user has approved a line, its envelope stays live for the session's TTL, so retrying that same line does not ask again.

Never run the approve or pin commands yourself; the hook denies both verbs on the agent's Bash face. The `approvedByUser: true` argument is not the terminal confirmation: in token mode the run tool still requires the terminal-confirmed grant, and in ask mode it is only the chat round-trip's retry marker, sent after the user answered (posture trust, which the server cannot verify).

Without the devkit tools, show the reviewed command and let the user execute it in their own terminal. After a write, verify with `huaweicloud_run_readonly_command` or another read-only check.

## Gate-source roster tools (no plan face)

Beyond the hcloud plan/run pair, other registered tools carry the same gate with NO plan step — the gate itself mints the approval token. Today that is the account-switch pair, `huaweicloud_auth_init` and `huaweicloud_auth_switch`: every call confirms, and the confirmation view names the target account fingerprint and the credential source, because switching accounts is the step that can redirect every later approved write. In the default token mode the first call returns `USER_CONFIRMATION_REQUIRED` with a minted `approvalToken`; the user confirms it in their own terminal (`npx huaweicloud-devkit approve <token>`) and you retry the same call with the token. Under ask mode the ladder is the same as for hcloud writes: the form on a capable client, the `ASK_CONFIRMATION_REQUIRED` chat round-trip on the rest. Never switch accounts through the devkit CLI instead (`npx huaweicloud-devkit auth init` from Bash is hook-denied); the gate's confirmation is the only agent-side path, and the account the user confirmed is the account that switches.

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
- Use the approval contract for writes: plan, user confirm, run — token mode by default; under `DEVKIT_APPROVAL_MODE=ask` the server raises the confirmation itself (a form, or the chat round-trip when the client cannot render one). See `references/approvals.md`.
- Use read-only verification after a write.
- Prefer reviewed IaC for durable infrastructure changes.
