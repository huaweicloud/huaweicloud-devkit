# dev→v2 port program — 2026-11-17 close-out record

The port program landed dev-line (1.1.x) features into the v2 line as an eight-step ladder on the `dev_feats` trunk. This file is the durable in-repo record of what landed, what was deliberately not ported, and where the process deviated from its own protocol. The full receipts, interrogate seat reports, and gate logs live outside the repo (session-scoped `/tmp/opencode/port-program-2026-11-17/`); the table below carries the pointers that matter.

## Ladder (all MERGED into `dev_feats`)

| Step | Content                                                                                                                  | PR  | Merge      |
| ---- | ------------------------------------------------------------------------------------------------------------------------ | --- | ---------- |
| PR-1 | 409 forced version gate + bounded 502/504 connect retry (dev 501fd8b4 + e1255a4b + e0c8700b)                             | #8  | `200a996f` |
| PR-2 | npm failure-reason extraction + credential-stripped upgrade child env (dev 7a36a7e8 + 4890d78c strip content)            | #7  | `4e5f8482` |
| PR-3 | `update` gated on the Node 22.19 floor (dev cdc910f5)                                                                    | #15 | `483f7e70` |
| PR-4 | Selective devbridge tunnel cleanup — all four delete-all hot paths replaced (dev 97c4bc8a cluster + 6100026e + bde7ae56) | #16 | `e2a66c44` |
| PR-5 | Pool-Selection Gate doctrine + acceptance suite (dev b1ab4029)                                                           | #17 | `df7a463f` |
| PR-6 | `huaweicloud_sandbox_shutdown` tool, approval-roster/policy/hdkit/skill four-face sync (dev 5d89c880 + 3bfc1f53)         | #18 | `baebd97f` |
| PR-7 | `HDKIT_TEMPLATE_QUOTA_EXCEEDED` structured exit + three-code caliber (dev dff5df91 + 45dd4f99)                           | #19 | `07c03449` |
| PR-8 | template_id retirement — no upload, no pinning, schema/doctrine removal, tests flipped (dev 8c1af52e)                    | #20 | `78ead57c` |

Trunk after close-out: `49b9164c` (close-out ledger) → timing-pin fix `12175a84`. Tool count moved 57→58, sandbox pack 15→16 (the shutdown tool).

## Deliberately not ported

- The silent auto-upgrade cluster (dev 36045514 + 9c2c0e08 + e010d59d + 4890d78c + bec48cf9 + d51a521c) — deferred by the ladder plan's standing default, never a live operator ratification; the ledger entry in `docs/CHANGELOG.md` is the authoritative wording. Its zero-read status is measurable via `scripts/lib/dev-port-scan.mjs`.
- dev `a97f5897` (lazy better-sqlite3 + Node 22.5 floor) — superseded by this line's `node:sqlite` + 22.19 floor.
- dev planning docs (`docs/sandbox/*spec/plan/task*`) — not ported by this fork's recorded convention.
- #1014's userHash pre-flush backfill — stays recorded-NOT-done with the initialize-prewarm rationale in the #1014 wave's ledger line.

## Process deviations (recorded for the audit trail)

1. Three lanes (PR-6/7/8) stopped before their push/PR/receipt step; root completed those mechanical steps and marked the substitution in each PR comment. Root's merge entry now wants a machine check (remote branch exists, PR head equals the receipt head, both seat reports predate the merge).
2. PR #18 merged on a single durable seat report; the second seat's round-3 report landed six minutes after the merge and confirmed the same zero-blocking verdict. A supplementary re-seat of the shutdown face was run on the merged trunk as the durable record.
3. Two adversarial seats went silent mid-round (one under host load 10-18 from another program's residue) and were replaced per protocol; PR-8's second seat was run by root after the lane exited early.

## Tooling note

`scripts/lib/dev-port-scan.mjs` is a coarse screen, never a verdict: PRESENT requires doctrine + acceptance-test confirmation (the pool-selection gate once scored PRESENT on generic pool vocabulary while its doctrine was absent). The final scan at `49b9164c` read PRESENT=110 / PARTIAL=10 / MISSING=2 / NOTOK=5; every PARTIAL and NOTOK was triaged in the session record, and both MISSINGS are the deliberate exclusions above.
