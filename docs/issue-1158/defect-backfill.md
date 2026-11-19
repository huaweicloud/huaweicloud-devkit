# Issue #1158 — v1 (dev) defect backfill

Carrier for the five QA-confirmed gaps that had no fix载体 on the 1.1.x line
(PR #1159 covers the v2 line and is deliberately not touched here):

| ID                       | Defect                                                                                       | Fix                                                                                                                                                                |
| ------------------------ | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D4-2                     | `env \| grep access_key` / `secret_key` fell through to allow                                | env-dump gate + `hwc-command-env-dump` rule now accept the vendor-neutral key family, prefixed (`TF_VAR_access_key`, `AWS_ACCESS_KEY_ID`, `MY_SECRET_KEY`) or bare |
| D4-6 (stages)            | `--admin-pass` never surfaced at the command stage                                           | `hwc-command-adminpass-exposure` stages add `command`; regex adds the hyphenated form                                                                              |
| D4-6 / D4-26 (redaction) | `--admin_pass value` space form and `"admin_pass":"…"` quoted key escaped the key-name table | `classifyTextCommand`/`redactSecrets` and `risk-rule-engine.redactEvidence` gain both shapes                                                                       |
| D9-12 (version check)    | `initialize` never ran `runVersionCheck`                                                     | the handshake runs a bounded KooCLI probe (1.5 s) and reports the version facts under `serverInfo.kooCli`                                                          |
| D10-3                    | Chinese intent 云主机 missed ECS                                                             | ECS route-map keywords add 云主机                                                                                                                                  |

D4-21 (`actions=["*"]` / managed-policy references) is carried by open PR
#1084 on this line, so it is not duplicated here.

D9-12 is only half closed by this PR: the other half ("`tools/list` before
`initialize` must return -32002") is carried by PR #1093 and is still open, so
merging this PR does not close D9-12 on its own.

## Tests

- `test/safety-policy.test.mjs`: generic and prefixed env-dump deny; flag-space and quoted-key redaction.
- `test/risk-rule-engine.test.mjs`: env-dump rule (generic + prefixed); command-stage adminPass warn; evidence redaction.
- `test/hook-python.test.mjs`: Python hook parity for the generic/prefixed key family.
- `test/tools.test.mjs`: 云主机 routes to ECS.
- `test/mcp-protocol-version-check.test.mjs`: initialize reports the fake KooCLI probe facts and bounds a hanging probe.
