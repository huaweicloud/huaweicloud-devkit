# Terminal Confirmation For Write Commands

A write or execution command runs only after the user confirms the plan token in their own interactive terminal. The agent plans, the user confirms, the agent runs. One confirmation covers exactly one execution.

## The three-step contract

1. Plan: call `huaweicloud_plan_cli_command` with the final hcloud arguments. The result echoes the exact command and carries `userConfirmation`.
   - `needed: true` means the command is a write or has execution side effects, and `command` is the exact line the user must run: `npx huaweicloud-devkit approve <approvalToken>`.
   - `needed: false` means the command is read-only, so the terminal confirmation does not apply.
2. Confirm: show the user the plan echo and the `userConfirmation.command` line, then wait. The user runs that line in their own terminal. The terminal prints the redacted command and states that this authorizes one execution.
3. Run: call `huaweicloud_run_approved_command` with the same `approvalToken`, the same `args`, and `approvedByUser: true`.

An unconfirmed non-read command is rejected with `status: "rejected"` and `code: "USER_CONFIRMATION_REQUIRED"`, plus a `nextStep` naming the approve line. The refusal does not consume the token, so retry the same call after the user confirms.

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

## Ask mode (DEVKIT_APPROVAL_MODE=ask)

An alternative posture where the confirmation happens in the harness client's own permission prompt instead of the terminal. The plan mints no token and its `userConfirmation` carries `{ needed: true, mode: "ask", note }` instead of a `command` line; `huaweicloud_run_approved_command` needs only the same `args` plus `approvedByUser: true` — the client's prompt on that call IS the user's confirmation.

The operator opts in; it is never the default. On OpenCode the installer (at or above 2.0) writes a top-level `permissions` array entry with effect `ask` for the `huaweicloud-devkit_huaweicloud_run_approved_command` action, plus `DEVKIT_APPROVAL_MODE=ask` in the mcp entry's environment, so the client half and the server half move together — the rule without the env double-gates (the client prompts AND the server still demands a token), the env without the rule fail-opens (the server trusts a prompt nobody shows). On other harnesses the operator sets `DEVKIT_APPROVAL_MODE=ask` in the server environment themselves; Claude Code needs no permission rule because the run tool declares `_meta` `anthropic/requiresUserInteraction` and the client prompts on every call.

What changes: no approval token, no UUID in the model's context, no 5-minute TTL, and no single-use replay guard — a retried or repeated call simply prompts the user again. The PIN and TTY checks do not apply; the client's own prompt UI is the gate. `approvedByUser: true` is still required and still means the user approved this exact command.

Honest trust boundary: the evidence is the client prompt itself — a harness without a per-tool prompt (or one whose permission system auto-approves) would execute without any user confirmation, which is why the mode is opt-in and the pair must stay whole. OpenCode's "Allow always" answer to the prompt saves an `allow` rule on the same action that removes the gate from then on — `npx huaweicloud-devkit doctor` fails that state; delete the rule or set its effect back to `ask`. The remote transport refuses ask mode outright and forces token mode. Token mode remains the default and the fallback for harnesses without a per-tool prompt.

## What the agent must not do

- Never run `npx huaweicloud-devkit approve` or `npx huaweicloud-devkit pin` yourself, in any spelling. The confirmation's value is that the user's own terminal records it, and the safety hook denies both verbs on the agent Bash face for exactly that reason.
- Never treat `approvedByUser: true` as the confirmation. It is the agent's statement that the user approved the exact command, and the run tool still requires the terminal-confirmed grant.
- Never ask the user for their PIN, and never enter a PIN on the user's behalf.
- Never retry a run with different arguments under the same token. Plan again and get a fresh confirmation.

## Honest security boundary

The terminal confirmation defends: execution needs a user-recorded, PIN-checked grant made at an interactive terminal; the grant is a custody-keyed mac bound to the token, the confirmation time, and every stored field the run gate trusts (command hash, pin view, redacted form, secret-pinning flag, mint time), so a same-user edit of the state string or any trusted field does not verify; and a non-read command without a valid grant never runs.

It does NOT defend against: a socially engineered user who approves a command they did not read (the terminal prints the command, but the PIN proves presence, not comprehension); a same-user process that holds BOTH the custody master key and write access to `~/.config/huaweicloud/`, which can forge a grant for any pending token on the keyfile tier; a harness without the safety hook, where the TTY check is the only barrier and an agent driving a pseudo-terminal looks like a terminal; or the hook's text gate missing variable-indirect verbs (`V=approve; npx huaweicloud-devkit $V` — the same indirection residual the shell shadow documents for the secret gate), where the agent reaches the CLI spelling through a shell variable. This is a consent gate, not an isolation boundary.
