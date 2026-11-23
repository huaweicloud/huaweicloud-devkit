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

#### Token lifecycle states (D4-24 precise JSON contract, #745)

A token transitions through these states. Non-success states return a
structured JSON result (they do **not** throw a generic Error) so clients
can machine-assert each case:

| State              | Trigger                                                                 | Result shape                                              |
| ------------------ | ----------------------------------------------------------------------- | --------------------------------------------------------- |
| `valid`            | token exists, not expired, not yet consumed                             | normal execution result                                   |
| `expired`          | `createdAt` is past `APPROVAL_TTL_MS` (5 min)                           | `{ status: 'rejected', code: 'CONFIRM_TOKEN_EXPIRED' }`   |
| `already_consumed` | same token submitted a second time                                      | `{ status: 'ok', outcome: 'already_processed' }`          |
| `not_found`        | token was never created (typo / unknown / pruned past tombstone window) | `{ status: 'rejected', code: 'CONFIRM_TOKEN_NOT_FOUND' }` |

A consumed token leaves a **tombstone** (`{ consumedAt, createdAt }`) in the
approval store so a second submission is classified as `already_consumed`
rather than `not_found`. Tombstones age out past `APPROVAL_TTL_MS` via the
normal prune sweep.

`huaweicloud_auth_confirm` follows the same contract: a repeat call with an
already-consumed `confirmToken` returns `{ status: 'ok', outcome: 'already_processed' }`,
and an unknown token returns `{ status: 'rejected', code: 'CONFIRM_TOKEN_NOT_FOUND' }`.

### 4. Deny semantics: approval gate vs hard block (#1175 / D4-18)

`decision` stays binary (`allow` / `deny`) for the whole 1.1.x–1.2.x compatibility
window. Reading `decision: 'deny'` as "the command was rejected" is wrong for
writes: an unapproved write is a _pending approval_, not a refusal. To let callers
tell the two apart mechanically instead of parsing `reason`, every `deny` carries
two additive fields:

| Field              | Approval gate                 | Hard block                                           |
| ------------------ | ----------------------------- | ---------------------------------------------------- |
| `decision`         | `deny`                        | `deny`                                               |
| `requiresApproval` | `true`                        | `false`                                              |
| `blockedBy`        | `'approval'`                  | `'policy'`                                           |
| `approvalToken`    | issued by `planHcloudCommand` | cannot be honoured — approval does not lift the deny |
| `safeToRun`        | `false`                       | `false` (unchanged: `decision === 'allow'`)          |

- **Approval gate** — unapproved write / execution / OBS-write operations, e.g.
  `huaweicloud_plan_cli_command({ args: ['VPC','DeleteVpc','--vpc_id=abc'] })`.
  Present the plan, collect explicit user approval, then execute through
  `huaweicloud_run_approved_command` (or `run_approved_manifest`) with the token.
- **Hard block** — empty/invalid commands, credential or secret reads, and shared
  cloud-risk-rule hits (public admin-port exposure, encoded shell payloads).
  Re-planning with `allowWrites: true` does not clear these.
- **Concatenated commands** — any hard-blocked segment makes the aggregate
  `blockedBy: 'policy'` / `requiresApproval: false`; if every hcloud segment is
  approval-gated the aggregate reports `blockedBy: 'approval'` /
  `requiresApproval: true`.
- `allow` results omit both fields; absence means "not blocked".

Compatibility: purely additive. Callers branching on `decision` are unaffected, and
the existing `decision === 'deny'` assertions stay valid. A third value
(`decision: 'confirm'`) is **not** introduced in 1.1.x/1.2.x; once callers have
migrated to `requiresApproval`/`blockedBy`, a future major (2.x) may switch
approval-gated results to `decision: 'confirm'` — tests and this document must
change together at that point.

## Implementation

### Token Storage

Tokens are stored in an in-memory `Map` in the MCP server process:

```js
const approvalStore = new Map(); // token → { rawArgs, createdAt }
const APPROVAL_TTL_MS = 5 * 60_000; // 5 minutes
```

- Token is a UUID v4
- Tokens are single-use (consumed on first retrieval)
- Tokens expire after 5 minutes
- Periodic cleanup runs every 20 stored tokens

### Key Functions

| Function                       | Location         | Purpose                                     |
| ------------------------------ | ---------------- | ------------------------------------------- |
| `createApprovalToken(rawArgs)` | `hcloud-cli.mjs` | Stores args, returns token                  |
| `inspectApprovalToken(token)`  | `hcloud-cli.mjs` | Classifies token state without consuming it |
| `consumeApprovalToken(token)`  | `hcloud-cli.mjs` | Validates, returns args, writes tombstone   |
| `planHcloudCommand()`          | `hcloud-cli.mjs` | Returns `approvalToken` in result           |
| `runApprovedCommand()`         | `tools.mjs`      | Validates token, executes with stored args  |

## Why Token Instead of String Comparison

Previous design compared `approvedCommand` string with `plan.command` string. This failed when:

1. Secrets were redacted (`<redacted>` ≠ real value)
2. JSON parameters had different escaping (`\"` vs `"`)
3. Shell quoting changed between plan and run context

Token-based approval eliminates the string round-trip entirely. Args stay in their original structured format from plan to execution.

## Anti-Patterns

❌ Do NOT add new `--key=<redacted>` normalization rules to the comparison logic.

❌ Do NOT attempt to match `approvedCommand` string against `plan.command`.

❌ Do NOT store approval tokens in files or external storage. In-memory Map is sufficient.

## Migration

New tools using this pattern should follow the same contract:

1. Planning function returns `approvalToken`
2. Execution function accepts `approvalToken` and validates via `consumeApprovalToken`
