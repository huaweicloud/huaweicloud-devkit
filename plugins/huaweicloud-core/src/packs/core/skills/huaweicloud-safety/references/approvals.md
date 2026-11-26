# The Approval Gate For Registered Tools

A registered tool's mutating call runs only after the user confirms it. The confirmation channel is the server-run ladder (the default): an elicitation form on a capable client, a chat round-trip envelope on the rest, or the terminal token in opt-in token mode. The agent never confirms anything itself; `approvedByUser: true` is only ever a statement or a retry marker, never the confirmation.

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
- `huaweicloud_sandbox_shutdown`
- `huaweicloud_auth_init`
- `huaweicloud_auth_switch`

## The two gate flavors

- **Always.** The call confirms on every invocation — connect, shutdown, the tunnel faces, sign_agreement, credentials, and the hcloud run face's write-classified commands. No content rule ever exempts them.
- **Classified.** The two sandbox exec faces classify the `command` string first (the same engines the Bash safety face uses). A benign command runs with NO confirmation surface at all — no form, no envelope, no token. A write-classified command confirms on every call. The strict engine refuses some content with the rule named and no confirmation unlocks it — the families its rows cover: credential-file reads, environment dumps, recursive forced rm in any combined-flag spelling (`rm -rf`/`-fr`, flags interposed or after the target, `--`, quoted, glob, `$VAR`, dot-prefixed names, `.`, `..`, `~`, `$HOME`, `*`, `--no-preserve-root`), `find` with `-delete`, pipelines sweeping files into rm, downloads piped into a shell, disk format, and shutdown commands. The refusal set is those rows and nothing more: a command outside them is not silently stopped, so prefer targeted deletions (rm with exact file names, no combined -rf flag), and treat any refusal as a boundary to rework.

The same destructive rows also deny on the agent's own Bash face through the safety hook (the operator-approved widening): unanchored recursive rm — any combined-flag spelling, including `rm -rf node_modules` and the quoted/glob/`$VAR` forms — and `find … -delete` now refuse there too. The operator chose the safe direction: a false deny on the agent face costs one rephrased command, a miss costs the workspace. A human's own terminal is unaffected — the hook gates the agent face only.

## Token mode (opt-in: DEVKIT_APPROVAL_MODE=token; the forced posture on the remote transport)

1. Call the tool. A first no-token call returns `status: "rejected"`, `code: "USER_CONFIRMATION_REQUIRED"`, a minted `approvalToken`, and `userConfirmation.command` — the exact line the user must run in their own terminal: `npx huaweicloud-devkit approve <approvalToken>`. Nothing executed.
2. The user confirms in their own interactive terminal (PIN-checked; first use enrolls the PIN via `npx huaweicloud-devkit pin`). The terminal prints the redacted request and states that this authorizes one execution.
3. Retry the same call with the same `approvalToken` and `approvedByUser: true`. The confirmation authorizes one execution of one command.

- The token expires five minutes after minting. An expired token is refused; the call needs a fresh terminal confirmation, never a blind retry.
- A retry consumes the token. A repeat of the same token reports `outcome: "already_processed"`, never a second execution.
- Changing the arguments rejects the call — the token pins the exact arguments and any real secret values in it.

For the hcloud run face, `command` is the display anchor: the full hcloud command line, checked against the args array (a mismatch rejects with `COMMAND_ARGS_MISMATCH`, nothing executes). The plan result carries it as the TOP-LEVEL `command` field (the redacted echo; substitute real values wherever it shows `<redacted>`). The sandbox tools carry no anchor — their `command` field IS the content.

## Registered tools beyond the hcloud pair

The same gate covers every tool on the approval roster, not only the hcloud plan/run pair. A roster tool with no plan face mints its own token at the gate: the first call in token mode (opt-in) returns `USER_CONFIRMATION_REQUIRED` with a fresh `approvalToken` and a `userConfirmation` summary naming what the call does — the user confirms that token the same way (`npx huaweicloud-devkit approve <token>`), and the retry carries the token. In ask mode (the default) the same ladder as above applies: the form, or the `ASK_CONFIRMATION_REQUIRED` chat round-trip.

The account-switch pair is registered (PR-3b): `huaweicloud_auth_init` and `huaweicloud_auth_switch` confirm on every call, and their confirmation views name the target account fingerprint and the credential source, because the account switch is the step that can redirect every later approved write to a different account. The confirmation binds the resolved snapshot — the account, region, and session token of the switch — so the account the user confirmed is the account that switches; a changed file or a changed region re-asks instead of executing. The devkit CLI verbs (`npx huaweicloud-devkit auth init`, `auth sync`) are the operator's own terminal surface: the hook denies them on the agent Bash face, so an agent cannot use the CLI to bypass the gate the MCP tools carry. `auth_confirm` (the persist-conflict reconciliation) and the read faces (`auth_status`, `check_account_type`, `auth_sync` on the MCP surface) stay ungated by this chain.

## Ask mode (the default): the server-run confirmation

The confirmation happens on the server, in one of two tiers.

1. **The form.** A client that declares the MCP elicitation form capability gets a form raised by the devkit during the tool call. The form shows the command line when there is one (the exec faces), else the redacted summary (the lifecycle faces), and ONE three-choice decision: `approve-once` (run it exactly once), `approve-session` (also grant standing consent for the exact same call in this session — identical later calls run without asking again, and the grant dies when the devkit server restarts), or `decline`. A dismissed form and a five-minute timeout cancel the same way. You do nothing for this tier: make the call and let the human answer. The form's display strings resolve through a three-tier language ladder: the operator's `DEVKIT_CONFIRM_LANG` env pin first, then the `confirmLanguage` argument you may relay — send the user's conversation language (`zh` or `en`) so a Chinese conversation gets a Chinese form; the server never sees the chat, so this argument is the only channel that carries the conversation's language — and the machine locale last. A zh resolution renders the message, the field title, and the choice labels in Simplified Chinese; the decision VALUES stay the English wire vocabulary (`decline`, `approve-once`, `approve-session`) in every language.
2. **The chat round-trip.** A client with no form capability answers the call with `status: "rejected"` and `code: "ASK_CONFIRMATION_REQUIRED"`. The envelope carries the command or summary and the instruction: show it to the user in chat, wait for their explicit answer, then retry the same call with `approvedByUser: true`. That retry is posture trust: it is the user's word as you report it, with no mechanical proof a human answered. Never send the retry before the user answers, and never answer for them.

Every non-approval answer refuses fail-closed: a decline, a dismiss, the timeout, a transport failure, and an accept whose submitted content carries no valid decision value (a client that answers accept without answering the form schema it was shown — that shape gets its own code, `ELICITATION_INVALID_CONTENT`, so it is diagnosable from the refusal) all return a clean rejection (`ELICITATION_DECLINED`, `ELICITATION_CANCELLED`, `ELICITATION_TIMEOUT`, `ELICITATION_FAILED`, `ELICITATION_INVALID_CONTENT`) with nothing executed and nothing recorded. Do not retry a refused command without a fresh approval.

## The retry memo (uncertain delivery)

When an approved call's delivery was uncertain — the call threw and whether it completed is unknowable — a byte-identical retry reuses the prior consent: no second form, no fresh envelope, no new approval. The response carries `approvedVia: "retry-uncertain"` so you can tell the reuse from a fresh confirmation. The memo is scoped to the result: after a delivered outcome it is cleared, so a confirmed consequence is never silently repeated — an identical retry then confirms again like any first call. A retry with different arguments is a different key and always confirms. The memo lives in the devkit server process and dies with it: after a restart the same command confirms again. A session standing-consent grant answers the same way with `approvedVia: "standing-session"` and the same restart boundary.

The consent ledger records which tier answered: `evidence: "elicitation"` for a form answer, `evidence: "posture"` for a chat-round-trip retry. A ledger row that says posture means a model reported the user's approval, not that a human was mechanically verified. A memo reuse inherits the original event's tier and never upgrades it.

On OpenCode the installer writes one exact `allow` rule per roster tool ahead of the server's own confirmation. That rule is yield-only: it suppresses the redundant client popup and never confirms anything — the form does on a form-capable client (opencode 2.x), and on 1.19–1.x the chat round-trip does, recorded as posture trust. A saved "always allow" row from a pre-yield install is likewise inert, because the server's confirmation is raised inside the tool call and never routes through the client's permission evaluation, and the yield rules mean the popup no longer appears to recreate one. `npx huaweicloud-devkit doctor` lists such rows as a stale-grant WARNING, with the `opencode api GET /api/permission/saved` and `opencode api DELETE /api/permission/saved/<id>` commands that remove them. Doctor also lists recorded session standing consents. A `deny` rule on a roster tool still blocks the call in the client, and doctor fails it. Ask mode is the default everywhere a session lives; token mode is the operator's opt-in (`DEVKIT_APPROVAL_MODE=token`) and the remote transport's forced posture — the stateless remote face carries no session for either ask tier (no capability record, no shown-envelope memory), while the token state lives on disk where the terminal approve finds it, so the remote gate has exactly one channel and it is token.

## The PIN and the TTY check

The approve command refuses to record a confirmation unless stdin and stdout are both terminals. A pipe cannot answer a prompt, so an agent that shells out to Bash cannot drive the confirmation. A human at an interactive terminal can.

First use is two steps, both in the user's own terminal: run `npx huaweicloud-devkit pin` once to choose an approvals PIN (at least 6 characters, typed twice), then confirm with `npx huaweicloud-devkit approve <approvalToken>`. The approve command refuses outright on a machine with no enrolled PIN instead of enrolling one inline. Every confirmation verifies the PIN with three attempts per invocation.

A wrong PIN also counts toward a persistent failure lockout: every sixth cumulative failure locks verification for 5 minutes, doubling per lockout episode and capped at 24 hours, and a correct PIN clears the counter. The failure lockout is guidance, not a boundary — a same-user process can edit the PIN record the same way it can edit any file under `~/.config/huaweicloud/`.

The PIN record stores only a mac over the vault custody master key, never the plaintext. The PIN proves presence at the terminal. It does not prove the user read the command.

## What the agent must not do

- Never run `npx huaweicloud-devkit approve` or `npx huaweicloud-devkit pin` yourself, in any spelling. The confirmation's value is that the user's own terminal records it, and the safety hook denies both verbs on the agent Bash face for exactly that reason.
- Never run `npx huaweicloud-devkit auth init`, `auth sync`, or `auth reconcile` yourself, in any spelling. The account switch is approval-gated on the MCP tools, the CLI is the operator's own terminal surface, and the safety hook denies those verbs on the agent Bash face — shelling out to them would switch every later approved write's account with no confirmation.
- Never treat `approvedByUser: true` as the confirmation. In token mode it is the agent's statement that the user approved the exact call and the tool still requires the terminal-confirmed grant; in ask mode it is the chat round-trip's retry marker, sent only after the user answered, and it never substitutes for the form or the round-trip.
- Never ask the user for their PIN, and never enter a PIN on the user's behalf.
- Never retry a call with different arguments under the same memo or token. The reuse covers the byte-identical call only; anything else confirms again.
- Always send `command` on the hcloud run face: the full command line, never a prettified or shortened one. The gate rejects a mismatch with the `args` instead of running it; the sandbox exec faces' `command` is content, not a display anchor, and the seven lifecycle faces carry no field at all.
- Never invent the user's answer to the chat round-trip. Wait for it, then retry with `approvedByUser: true` only after they approve.
- Never treat a strict-engine refusal as approval-shaped: the engine denies credential-file reads, environment dumps, and the destructive families its rows name (recursive forced rm in any combined-flag spelling — quoted, glob, `$VAR`, dot-prefixed, `--`, interposed-flag targets — plus `find` with `-delete`, pipelines sweeping files into rm, pipe-to-shell downloads, disk format, shutdown) before any confirmation surface exists, and no channel unlocks them. The refusal set is those rows and nothing more — a command outside them is your responsibility to keep targeted. Rework any refused command instead of retrying it.

## Honest security boundary

The gate defends: execution needs a user-recorded confirmation — a PIN-checked terminal grant bound to the token and every stored field the run gate trusts (command hash, pin view, redacted form, mint time), or a server-raised form answer the client relayed, or an explicitly-labelled posture attestation whose line was shown first. The terminal grant is a custody-keyed mac, so a same-user edit of the state string or any trusted field does not verify; and a gated call without a valid confirmation never runs.

It does NOT defend against: a socially engineered user who approves a command they did not read (the form and terminal print the request, but neither proves comprehension); a same-user process that holds BOTH the custody master key and write access to `~/.config/huaweicloud/`, which can forge a grant for any pending token on the keyfile tier; a harness without the safety hook, where the TTY check is the only barrier and an agent driving a pseudo-terminal looks like a terminal (on opencode 2.x the shell face is no longer in this class: the installer-deployed safety-gate adapter classifies each scanner segment in-process and denies classifier-refused compounds before execution, leaving only the gate's own text residuals there — the indirection classes below); the text gates' indirection residuals — variable-indirect verbs (`V=approve; npx huaweicloud-devkit $V`, the same indirection residual the shell shadow documents for the secret gate) and script-file carriers (`bash /tmp/x.sh` runs a script whose content no text gate ever sees), both reaching a gated verb through a shell variable or an indirect file; an agent that rewrites the deployed classifier file itself — the same attack that was once open on every in-process gate is now three layers deep rather than closed: the classifier denies write-shaped bash commands targeting the deployed payload paths (policy.json's `protectedPayloadPathMarkers`), the adapter and the `.mjs` hook refuse an imported module that fails the load-time shape/behavior canaries, and doctor compares the deployed classifier files against the install-time integrity receipt — so the naive vector (echo/tee/cp over `dist/safety-policy.js`) is denied at the command itself, non-adversarial corruption (a stale replacement, a truncated overwrite) denies fail-closed at load, and any drift that lands anyway surfaces in doctor with the reinstall remediation. Against arbitrary user-permission bash NO purely local mechanism fully closes this — with the file system writable by the same user the gate runs under, an escape requires a crafted module that passes the canaries and a bypass of the path gate's own text residuals (quote/variable-indirect path spellings, verbs outside the shape table), which raises the cost to forging multiple artifacts at once; full closure needs out-of-band verification (a read-only install location, a signed payload, or an integrity check from a process the agent cannot write). The integrity receipt is itself local, so a determined attacker can rewrite it too — doctor's drift check is detection, not proof. Also outside the gate: a posture-tier retry, which trusts the model's report of the user's answer by design and is labelled as such on every surface that shows it. This is a consent gate, not an isolation boundary.

## The registered non-CLI tools

The gate also covers tools that have no plan face and no executable line. Call the tool and let the gate confirm: the no-token call mints the token itself and returns `USER_CONFIRMATION_REQUIRED` with the same approve line; ask mode raises the form or the chat round-trip on the call. These tools take NO `command` field — their confirmation view is the summarized request (the gate rejects a fabricated command line outright), and the obs pair's summarize names the bucket and region, upgrade's names the channel and target, secret_delete's names the ref, packs_configure's names the pack ids.

- `huaweicloud_obs_set_website_config` / `huaweicloud_obs_set_cors` gate per classification: `action=get` is a signed read — it runs unconfirmed; `set` and `delete` are signed writes on a live bucket and confirm every call.
- `huaweicloud_upgrade` confirms every call and displays the channel ("latest") plus the target: the handler elects the stable or prerelease dist tag from the installed version after consent, so the consent pins the channel, not the resolved artifact.
- `huaweicloud_secret_delete` confirms every call, names the ref, and warns that deleting a ref S1 credentials point at breaks those reads until re-stored. `huaweicloud_secret_set` stays ungated: the user is the plaintext source.
- `huaweicloud_packs_configure` confirms every call in a stdio session and names the enabled or disabled pack ids; sessionless surfaces are refused outright with no token minted.

`huaweicloud_setup_obs_config` stays ungated (it syncs credentials the user just configured). The devkit CLI twins of the gated mutations (`npx huaweicloud-devkit update|upgrade`, `secret rm`, `packs enable|disable|all`) are hook-denied on the agent Bash face — run the MCP tool instead, or let the user type the CLI line in their own terminal.
