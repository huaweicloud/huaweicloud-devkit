# Plan-Run Approval Contract

## Overview

The `planHcloudCommand` → `runApprovedCommand` workflow uses a **token-based approval** mechanism instead of string comparison. This eliminates mismatches caused by shell quoting, JSON escaping, credential redaction, and special character handling.

## Contract

### 1. `planHcloudCommand(args)` → `{ approvalToken, args, command, ... }`

The plan step returns an `approvalToken` alongside the display information. The token is a random UUID that links the plan to a stored args array.

```
plan → { approvalToken: "uuid-xxx", command: "...", args: [...], ... }
```

### 2. Agent presents the plan to the user and collects approval

The agent may show `command` to the user for review. The agent MUST NOT attempt to construct or modify the args array.

### 3. `runApprovedCommand({ approvalToken, args, approvedByUser })` → result

The run step validates:

1. `approvedByUser === true`
2. `approvalToken` is valid and not expired (5 minute TTL)
3. `args` JSON-serialized form matches the stored args from plan

If all checks pass, the stored args are used to execute `runHcloud`.

## Ask Mode (DEVKIT_APPROVAL_MODE=ask)

The token contract above is the default. `DEVKIT_APPROVAL_MODE=ask` moves the confirmation onto the server, inside the tool call — the operator opts in (the OpenCode installer at or above 1.19.0 writes the pair: one exact `allow` entry per approval-roster tool on its `huaweicloud-devkit_<tool>` action — a top-level `permissions` array entry on 2.0+, a `permission`-object key on 1.19–1.x — plus the server env together; other harnesses set the env themselves).

- Plan: `planHcloudCommand` mints NO token (nothing lands in the approvals store) and `userConfirmation` carries `{ needed: true, mode: 'ask', note }` instead of the approve `command` line.
- Run: `runApprovedCommand` requires only `approvedByUser: true` plus the same `args` — no `approvalToken` (the tool schema keeps it optional and documents it as token-mode-only). The server gate is the user's confirmation.
- Consent tiers: a client that declares the MCP elicitation form capability gets a form raised by the devkit during the call; a client without it answers `status: "rejected"` with `code: "ASK_CONFIRMATION_REQUIRED"`, and the retry after the user's explicit chat answer is recorded as posture trust. Every non-approval answer refuses fail-closed (decline, dismiss, timeout, transport failure).
- Client rules are yield-only: the installer's exact per-tool `allow` rules suppress the client's own permission popup so the server-run confirmation is the only prompt. On a form-capable client (opencode 2.x) that confirmation is the elicitation form; on 1.19–1.x there is no form, so the yield hands the confirmation to the T3 chat round-trip, which the consent ledger records as posture trust. A client `allow` rule cannot suppress the gate; a `deny` rule still blocks the call in the client, and `npx huaweicloud-devkit doctor` fails it. A user-set `DEVKIT_APPROVAL_MODE` value wins: no client rules are kept, and rules a past install wrote are removed value-exact. Install and update migrate the abandoned ask-effect rules away on every path that touches the config.
- Replay semantics: no 5-minute TTL and no single-use claim — a retried or repeated call prompts the user again. The placeholder-secret guard and the strict re-classification of the executed args are unchanged in both modes.
- Remote carve-out: the stateless remote transport has no per-call permission prompt to trust, so it refuses ask mode, forces token mode, and warns — ask mode is a stdio-harness posture.

## Implementation

### Token Storage

Tokens are persisted to a per-user file (`~/.config/huaweicloud/approvals.json`, mode 0600; the whole tree relocates via `HUAWEICLOUD_HOME`) so plan and run survive the process boundary (in-memory storage lost tokens across MCP sessions, issue #578). Only the sha256 of the canonical args plus the redacted form are stored, never the raw args.

- Token is a UUID
- Tokens are single-use (exclusive-create claim marker next to the store)
- Tokens expire after 5 minutes
- Stale entries and markers are pruned on every mint; consume replaces its entry with a tombstone (`{ consumedAt }`, D4-24/#745) so a replay classifies as already_processed instead of not_found

### Key Functions

| Function                       | Location                                                           | Purpose                                        |
| ------------------------------ | ------------------------------------------------------------------ | ---------------------------------------------- |
| `createApprovalToken(rawArgs)` | `lib/approval-tokens.ts`                                           | Stores hash + redacted args, returns token     |
| `consumeApprovalToken(token)`  | `lib/approval-tokens.ts`                                           | Validates, claims single-use, tombstones entry |
| `planHcloudCommand()`          | `src/hcloud-plan.ts` (re-exported by the `src/hcloud-cli.ts` face) | Returns `approvalToken` in result              |
| `runApprovedCommand()`         | `src/packs/huaweicloud-cli/tools.ts`                               | Validates token, executes with provided args   |

## Why Token Instead of String Comparison

Previous design compared `approvedCommand` string with `plan.command` string. This failed when:

1. Secrets were redacted (`<redacted>` ≠ real value)
2. JSON parameters had different escaping (`\"` vs `"`)
3. Shell quoting changed between plan and run context

Token-based approval eliminates the string round-trip entirely. Args stay in their original structured format from plan to execution.

## Anti-Patterns

❌ Do NOT add new `--key=<redacted>` normalization rules to the comparison logic.

❌ Do NOT attempt to match `approvedCommand` string against `plan.command`.

❌ Do NOT revert token storage to an in-memory Map — plan and run land in different processes (#578); the per-user file is the sanctioned store.

## Migration

New tools using this pattern should follow the same contract:

1. Planning function returns `approvalToken`
2. Execution function accepts `approvalToken` and validates via `consumeApprovalToken`
