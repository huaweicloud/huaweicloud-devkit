# Safety Model

The toolkit assumes coding agents can accidentally expose secrets or perform expensive/destructive cloud operations. V1 therefore defaults to read-only execution and explicit approval gates.

## Blocked By Default

- Reading `.hcloud` or `.huaweicloud` credential files.
- Printing cloud credential environment variables.
- Calling secret-value APIs that return plaintext secret strings or binary secrets.
- Running write operations such as create, delete, update, resize, start, stop, authorize, revoke, attach, detach, enable, or disable without explicit approval.
- Echoing password-like fields such as `adminPass` back into generated reports or command output without a shell-history warning.

## Enforcement

- `plugins/huaweicloud-core/skills/huaweicloud-safety/SKILL.md` teaches agents when to classify risk.
- `huaweicloud_hook_check_command`, `huaweicloud_hook_check_artifacts`, and `huaweicloud_hook_check_deploy_plan` let MCP-capable agents proactively inspect planned work.
- `plugins/huaweicloud-core/hooks/huaweicloud-safety.mjs` blocks command-stage deny rules for Codex native hooks without requiring Python.
- `plugins/huaweicloud-core/hooks/huaweicloud-safety.py` remains available for Hermes/Python hook compatibility.
- `plugins/huaweicloud-core/src/safety-policy.mjs` handles Codex/OpenCode MCP paths and merges existing command safety with public cloud risk rules.
- `plugins/huaweicloud-core/safety/policy.json` stores hard safety vocabulary.
- `plugins/huaweicloud-core/safety/rules/cloud-risk-rules.json` stores generalized cloud risk rules.

## Write Operations

The default write path is planning: `huaweicloud_plan_cli_command` returns a command for review. The optional execution path is `huaweicloud_run_approved_command`, which requires an exact command string already shown to the user plus explicit approval. This is an agent workflow guardrail, not a substitute for IAM least privilege or human review.

`decision` stays binary, so a `deny` must not be read as "the operation is impossible". Each deny carries the additive fields `requiresApproval` and `blockedBy` (#1175 / D4-18):

- `requiresApproval: true` + `blockedBy: 'approval'` — a write/execution operation held at the approval gate. The plan issued an `approvalToken`; the operation runs after explicit user approval via `huaweicloud_run_approved_command` / `run_approved_manifest`.
- `requiresApproval: false` + `blockedBy: 'policy'` — a hard block (secret or credential read, invalid command, shared cloud-risk-rule hit). Approval cannot lift it, so no usable token path exists.
- `allow` results omit both fields. `safeToRun` remains `decision === 'allow'`.

Full field table and compatibility window: `docs/plan-run-approval-contract.md` §4.

## Design Decision: session-level approval pass-through (rejected, #921 B)

**Request**: after a user approves a multi-resource deployment manifest, skip the per-command approval gate for every command inside the approved list (session-level pass-through), or auto-renew approval tokens; only stop for commands that deviate from the list. Motivation: a 4-resource ECS deployment needs 10+ `plan → approve → run` round trips, and an expired token forces a full re-plan.

**Decision**: rejected for the enforcement layer — the wrapper keeps one token per command, one-shot consumption, and the 5-minute TTL. Reasons:

1. **The MCP/CLI wrapper is the last enforcement layer** of the 3-layer safety model (skills teach → hooks block → wrappers enforce). If it silently executes any command carrying a "blessed" token, a plan/run desync, an args hash collision, or a stale list no longer matching session state would execute unreviewed — exactly the "骗过校验" false-success class this toolkit exists to prevent.
2. **The friction is already addressed at the skill layer without weakening the wrapper**: `huaweicloud-iac` Stage 6 (Provisioning Rules) collects ONE manifest-level approval from the user, then executes each resource via `plan → approve → run` without re-asking list-level consent — the tokens are machine-generated per command, so the user's cost is one approval per deployment, not per command.
3. **Deviation-stop is already the contract**: `runApprovedCommand` rejects args whose hash differs from the planned args (`CONFIRM_TOKEN_*` JSON states, see `docs/plan-run-approval-contract.md`), so an off-manifest command stops the run today.

If token TTL friction is measured again in the field, the acceptable follow-up is a TTL extension scoped to explicitly declared multi-command manifests at the skill layer (re-planning the whole list on expiry), not a wrapper-level pass-through.

## Non-Goals

This is not a hard security boundary. Users still need IAM least privilege, audit logs, secure local credential storage, and review of generated commands or code.
