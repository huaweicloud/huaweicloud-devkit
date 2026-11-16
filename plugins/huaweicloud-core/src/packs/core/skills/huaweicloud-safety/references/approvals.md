# The Approval Gate For Registered Tools

A registered tool's mutating call runs only after the user confirms it. The confirmation channel is the server-run ladder: an elicitation form on a capable client, a chat round-trip envelope on the rest, or the terminal token in token mode. The agent never confirms anything itself; `approvedByUser: true` is only ever a statement or a retry marker, never the confirmation.

## The registered tools today

One per line, append-shaped: a sibling registration adds its tools here without touching the rest.

- `huaweicloud_run_approved_command` — the hcloud pair's run face (the PR-1 registration)
- `huaweicloud_sandbox_connect`
- `huaweicloud_sandbox_exec_with_session`
- `huaweicloud_sandbox_exec_one_shot`
- `huaweicloud_sandbox_expose_tunnel`
- `huaweicloud_sandbox_renew_tunnel`
- `huaweicloud_sandbox_keepalive_watchdog`
- `huaweicloud_sandbox_sign_agreement`
- `huaweicloud_sandbox_credentials`

## The two gate flavors

- **Always.** The call confirms on every invocation — connect, the tunnel faces, sign_agreement, credentials, and the hcloud run face's write-classified commands. No content rule ever exempts them.
- **Classified.** The two sandbox exec faces classify the `command` string first (the same engines the Bash safety face uses). A benign command runs with NO confirmation surface at all — no form, no envelope, no token. A write-classified command confirms on every call. Destructive, credential-reading, secret-bearing, and invalid commands are refused outright with the rule named — no confirmation unlocks them, not even a terminal approve, because the strict classification still arbitrates content after the confirm.

## Token mode (the default)

1. Call the tool. A first no-token call returns `status: "rejected"`, `code: "USER_CONFIRMATION_REQUIRED"`, a minted `approvalToken`, and `userConfirmation.command` — the exact line the user must run in their own terminal: `npx huaweicloud-devkit approve <approvalToken>`. Nothing executed.
2. The user confirms in their own interactive terminal (PIN-checked; first use enrolls the PIN via `npx huaweicloud-devkit pin`). The terminal prints the redacted request and states that this authorizes one execution.
3. Retry the same call with the same `approvalToken` and `approvedByUser: true`. The confirmation authorizes one execution of one command.

- The token expires five minutes after minting. An expired token is refused; the call needs a fresh terminal confirmation, never a blind retry.
- A retry consumes the token. A repeat of the same token reports `outcome: "already_processed"`, never a second execution.
- Changing the arguments rejects the call — the token pins the exact arguments and any real secret values in it.

For the hcloud run face, `command` is the display anchor: the full hcloud command line, checked against the args array (a mismatch rejects with `COMMAND_ARGS_MISMATCH`, nothing executes). The plan result carries it as the TOP-LEVEL `command` field (the redacted echo; substitute real values wherever it shows `<redacted>`). The sandbox tools carry no anchor — their `command` field IS the content.

## Ask mode (DEVKIT_APPROVAL_MODE=ask): the server-run confirmation

The confirmation happens on the server, in one of two tiers.

1. **The form.** A client that declares the MCP elicitation form capability gets a form raised by the devkit during the tool call. The form shows the command line when there is one (the exec faces), else the redacted summary (the lifecycle faces), and one boolean approval. Approving runs the call once, dismissing or declining cancels it, and an unanswered form times out after five minutes. You do nothing for this tier: make the call and let the human answer. The form also offers "Remember for this session": a tick grants standing consent for the exact same call in this session — identical later calls run without asking again, and the grant dies when the devkit server restarts.
2. **The chat round-trip.** A client with no form capability answers the call with `status: "rejected"` and `code: "ASK_CONFIRMATION_REQUIRED"`. The envelope carries the command or summary and the instruction: show it to the user in chat, wait for their explicit answer, then retry the same call with `approvedByUser: true`. That retry is posture trust: it is the user's word as you report it, with no mechanical proof a human answered. Never send the retry before the user answers, and never answer for them.

Every non-approval answer refuses fail-closed: a decline, a dismiss, the timeout, and a transport failure all return a clean rejection (`ELICITATION_DECLINED`, `ELICITATION_CANCELLED`, `ELICITATION_TIMEOUT`, `ELICITATION_FAILED`) with nothing executed and nothing recorded. Do not retry a refused command without a fresh approval.

## The retry memo (uncertain delivery)

When an approved call's delivery was uncertain — the call threw and whether it completed is unknowable — a byte-identical retry reuses the prior consent: no second form, no fresh envelope, no new approval. The response carries `approvedVia: "retry-uncertain"` so you can tell the reuse from a fresh confirmation. The memo is scoped to the result: after a delivered outcome it is cleared, so a confirmed consequence is never silently repeated — an identical retry then confirms again like any first call. A retry with different arguments is a different key and always confirms. A session standing-consent grant answers the same way with `approvedVia: "standing-session"`.

The consent ledger records which tier answered: `evidence: "elicitation"` for a form answer, `evidence: "posture"` for a chat-round-trip retry. A ledger row that says posture means a model reported the user's approval, not that a human was mechanically verified. A memo reuse inherits the original event's tier and never upgrades it.

On OpenCode the installer writes one exact `allow` rule per roster tool ahead of the server's own confirmation. That rule is yield-only: it suppresses the redundant client popup and never confirms anything — the form does on a form-capable client (opencode 2.x), and on 1.19–1.x the chat round-trip does, recorded as posture trust. A saved "always allow" row from a pre-yield install is likewise inert, because the server's confirmation is raised inside the tool call and never routes through the client's permission evaluation, and the yield rules mean the popup no longer appears to recreate one. `npx huaweicloud-devkit doctor` lists such rows as a stale-grant WARNING, with the `opencode api GET /api/permission/saved` and `opencode api DELETE /api/permission/saved/<id>` commands that remove them. Doctor also lists recorded session standing consents. A `deny` rule on a roster tool still blocks the call in the client, and doctor fails it. The remote transport refuses ask mode outright and forces token mode. Token mode remains the default and the fallback for harnesses without a per-call confirmation surface.

## The PIN and the TTY check

The approve command refuses to record a confirmation unless stdin and stdout are both terminals. A pipe cannot answer a prompt, so an agent that shells out to Bash cannot drive the confirmation. A human at an interactive terminal can.

First use is two steps, both in the user's own terminal: run `npx huaweicloud-devkit pin` once to choose an approvals PIN (at least 6 characters, typed twice), then confirm with `npx huaweicloud-devkit approve <approvalToken>`. The approve command refuses outright on a machine with no enrolled PIN instead of enrolling one inline. Every confirmation verifies the PIN with three attempts per invocation.

A wrong PIN also counts toward a persistent failure lockout: every sixth cumulative failure locks verification for 5 minutes, doubling per lockout episode and capped at 24 hours, and a correct PIN clears the counter. The failure lockout is guidance, not a boundary — a same-user process can edit the PIN record the same way it can edit any file under `~/.config/huaweicloud/`.

The PIN record stores only a mac over the vault custody master key, never the plaintext. The PIN proves presence at the terminal. It does not prove the user read the command.

## What the agent must not do

- Never run `npx huaweicloud-devkit approve` or `npx huaweicloud-devkit pin` yourself, in any spelling. The confirmation's value is that the user's own terminal records it, and the safety hook denies both verbs on the agent Bash face for exactly that reason.
- Never treat `approvedByUser: true` as the confirmation. In token mode it is the agent's statement that the user approved the exact call and the tool still requires the terminal-confirmed grant; in ask mode it is the chat round-trip's retry marker, sent only after the user answered, and it never substitutes for the form or the round-trip.
- Never ask the user for their PIN, and never enter a PIN on the user's behalf.
- Never retry a call with different arguments under the same memo or token. The reuse covers the byte-identical call only; anything else confirms again.
- Always send `command` on the hcloud run face: the full command line, never a prettified or shortened one. The gate rejects a mismatch with the `args` instead of running it; the sandbox exec faces' `command` is content, not a display anchor, and the six lifecycle faces carry no field at all.
- Never invent the user's answer to the chat round-trip. Wait for it, then retry with `approvedByUser: true` only after they approve.
- Never treat a refusal you can see through (`rm -rf`, credential reads, secret reads) as approval-shaped: the strict classification denies them before any confirmation surface exists, and no channel unlocks them.

## Honest security boundary

The gate defends: execution needs a user-recorded confirmation — a PIN-checked terminal grant bound to the token and every stored field the run gate trusts (command hash, pin view, redacted form, mint time), or a server-raised form answer the client relayed, or an explicitly-labelled posture attestation whose line was shown first. The terminal grant is a custody-keyed mac, so a same-user edit of the state string or any trusted field does not verify; and a gated call without a valid confirmation never runs.

It does NOT defend against: a socially engineered user who approves a command they did not read (the form and terminal print the request, but neither proves comprehension); a same-user process that holds BOTH the custody master key and write access to `~/.config/huaweicloud/`, which can forge a grant for any pending token on the keyfile tier; a harness without the safety hook, where the TTY check is the only barrier and an agent driving a pseudo-terminal looks like a terminal; the hook's text gate missing variable-indirect verbs (`V=approve; npx huaweicloud-devkit $V` — the same indirection residual the shell shadow documents for the secret gate), where the agent reaches the CLI spelling through a shell variable; or a posture-tier retry, which trusts the model's report of the user's answer by design and is labelled as such on every surface that shows it. This is a consent gate, not an isolation boundary.
