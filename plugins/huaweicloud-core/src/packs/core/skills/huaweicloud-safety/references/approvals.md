# Terminal Confirmation For Write Commands

A write or execution command runs only after the user confirms the plan token in their own interactive terminal. The agent plans, the user confirms, the agent runs. One confirmation covers exactly one execution.

## The three-step contract

1. Plan: call `huaweicloud_plan_cli_command` with the final hcloud arguments. The result echoes the exact command and carries `userConfirmation`.
   - `needed: true` means the command is a write or has execution side effects, and `command` is the exact line the user must run: `npx huaweicloud-devkit approve <approvalToken>`.
   - `needed: false` means the command is read-only, so the terminal confirmation does not apply.
2. Confirm: show the user the plan echo and the `userConfirmation.command` line, then wait. The user runs that line in their own terminal. The terminal prints the redacted command and states that this authorizes one execution.
3. Run (token mode): call `huaweicloud_run_approved_command` with the same `approvalToken`, the same `args`, the same `command` line (copy the plan echo's `command` field verbatim), and `approvedByUser: true` — the flag is your statement that the user approved; the terminal-confirmed grant is the confirmation. Ask mode has its own ladder below.

An unconfirmed non-read command is rejected with `status: "rejected"` and `code: "USER_CONFIRMATION_REQUIRED"`, plus a `nextStep` naming the approve line. The refusal does not consume the token, so retry the same call after the user confirms.

## The command field

Always send `command`: the full hcloud command line, for example `hcloud ECS DeleteServer --server_id=i-123`. The plan result already carries it as the TOP-LEVEL `command` field (the redacted echo); forward that field verbatim. It is not `userConfirmation.command`, which is the approve line in token mode. Where the plan shows `<redacted>` for a secret value, substitute the real value in BOTH `args` and `command`.

The harness permission popup renders the tool input, so `command` is the first line the user reads before allowing the call; `args` stays the machine-precision binding beside it. The server checks that `command` equals the line the `args` array spells. A mismatch is rejected with `code: "COMMAND_ARGS_MISMATCH"` and nothing executes, because the line the user read must be the line that runs. A `command` with no `args` is rejected as malformed with `code: "COMMAND_REQUIRES_ARGS"`.

The field is optional in the schema only so a legacy args-only caller still reaches the gate and executes unchanged. New calls always send it.

## The PIN and the TTY check

The approve command refuses to record a confirmation unless stdin and stdout are both terminals. A pipe cannot answer a prompt, so an agent that shells out to Bash cannot drive the confirmation. A human at an interactive terminal can.

First use is two steps, both in the user's own terminal: run `npx huaweicloud-devkit pin` once to choose an approvals PIN (at least 6 characters, typed twice), then confirm plans with `npx huaweicloud-devkit approve <approvalToken>`. The approve command refuses outright on a machine with no enrolled PIN instead of enrolling one inline. Every confirmation verifies the PIN with three attempts per invocation.

A wrong PIN also counts toward a persistent failure lockout: every sixth cumulative failure locks verification for 5 minutes, doubling per lockout episode and capped at 24 hours, and a correct PIN clears the counter. The failure lockout is guidance, not a boundary — a same-user process can edit the PIN record the same way it can edit any file under `~/.config/huaweicloud/`.

The PIN record stores only a mac over the vault custody master key, never the plaintext. The PIN proves presence at the terminal. It does not prove the user read the command.

## One confirmation per execution

The confirmation authorizes one execution of one command.

- The plan token expires 5 minutes after the plan. An expired token is refused, and the agent must plan the command again.
- A run consumes the token. A repeat run of the same token reports `outcome: "already_processed"`, never a second execution.
- A run result's plan is minted without a token, so it never carries a usable approval. Re-running the command needs a fresh `huaweicloud_plan_cli_command` call and a fresh terminal confirmation.
- Changing the arguments rejects the run, because the token pins the exact command hash and any real secret values in it.

## Ask mode (DEVKIT_APPROVAL_MODE=ask): the server-run confirmation

The confirmation happens on the server, in one of two tiers.

1. **The form.** A client that declares the MCP elicitation form capability gets a form raised by the devkit during the tool call. The form shows the command line and a redacted summary; approving runs the call once, dismissing or declining cancels it, and an unanswered form times out after five minutes. You do nothing for this tier: make the call and let the human answer.
2. **The chat round-trip.** A client with no form capability answers the call with `status: "rejected"` and `code: "ASK_CONFIRMATION_REQUIRED"`. The envelope carries the command line, the redacted summary, and the instruction: show the command to the user in chat, wait for their explicit answer, then retry the same call with `approvedByUser: true`. That retry is posture trust: it is the user's word as you report it, with no mechanical proof a human answered. Never send the retry before the user answers, and never answer for them.

Every non-approval answer refuses fail-closed: a decline, a dismiss, the timeout, and a transport failure all return a clean rejection (`ELICITATION_DECLINED`, `ELICITATION_CANCELLED`, `ELICITATION_TIMEOUT`, `ELICITATION_FAILED`) with nothing executed and nothing recorded. Do not retry a refused command without a fresh approval.

The `command` field is first-class in both tiers. Send it on every call, because it is what the user reads: the form body on a capable client, your chat message on the rest. The plan result already carries it as the top-level `command` field; forward that verbatim and substitute real values where the plan shows `<redacted>`.

The consent ledger records which tier answered: `evidence: "elicitation"` for a form answer, `evidence: "posture"` for a chat-round-trip retry. A ledger row that says posture means a model reported the user's approval, not that a human was mechanically verified.

OpenCode's saved "always allow" row can no longer suppress the confirmation, because the form is raised inside the tool call and never routes through the client's permission evaluation. `npx huaweicloud-devkit doctor` still lists such rows as a stale-grant WARNING, with the `opencode api GET /api/permission/saved` and `opencode api DELETE /api/permission/saved/<id>` commands that remove them. The remote transport refuses ask mode outright and forces token mode. Token mode remains the default and the fallback for harnesses without a per-call confirmation surface.

## What the agent must not do

- Never run `npx huaweicloud-devkit approve` or `npx huaweicloud-devkit pin` yourself, in any spelling. The confirmation's value is that the user's own terminal records it, and the safety hook denies both verbs on the agent Bash face for exactly that reason.
- Never treat `approvedByUser: true` as the confirmation. In token mode it is the agent's statement that the user approved the exact command and the run tool still requires the terminal-confirmed grant; in ask mode it is the chat round-trip's retry marker, sent only after the user answered, and it never substitutes for the form or the round-trip.
- Never ask the user for their PIN, and never enter a PIN on the user's behalf.
- Never retry a run with different arguments under the same token. Plan again and get a fresh confirmation.
- Never send a `command` line that differs from the `args` you send, and never send a prettified or shortened line. The gate rejects the mismatch instead of running it.
- Never invent the user's answer to the chat round-trip. Wait for it, then retry with `approvedByUser: true` only after they approve.

## Honest security boundary

The terminal confirmation defends: execution needs a user-recorded, PIN-checked grant made at an interactive terminal; the grant is a custody-keyed mac bound to the token, the confirmation time, and every stored field the run gate trusts (command hash, pin view, redacted form, secret-pinning flag, mint time), so a same-user edit of the state string or any trusted field does not verify; and a non-read command without a valid grant never runs.

It does NOT defend against: a socially engineered user who approves a command they did not read (the terminal prints the command, but the PIN proves presence, not comprehension); a same-user process that holds BOTH the custody master key and write access to `~/.config/huaweicloud/`, which can forge a grant for any pending token on the keyfile tier; a harness without the safety hook, where the TTY check is the only barrier and an agent driving a pseudo-terminal looks like a terminal; or the hook's text gate missing variable-indirect verbs (`V=approve; npx huaweicloud-devkit $V` — the same indirection residual the shell shadow documents for the secret gate), where the agent reaches the CLI spelling through a shell variable. This is a consent gate, not an isolation boundary.
