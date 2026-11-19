# Issue #1158 — v1 (dev) defect backfill

Carrier for the four QA-confirmed gaps that had no fix载体 on the 1.1.x line
(PR #1159 covers the v2 line and is deliberately not touched here):

| ID                       | Defect                                                                                       | Fix                                                                                             |
| ------------------------ | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| D4-2                     | `env \| grep access_key` / `secret_key` fell through to allow                                | env-dump gate + `hwc-command-env-dump` rule now accept the vendor-neutral key family            |
| D4-6 (stages)            | `--admin-pass` never surfaced at the command stage                                           | `hwc-command-adminpass-exposure` stages add `command`; regex adds the hyphenated form           |
| D4-6 / D4-26 (redaction) | `--admin_pass value` space form and `"admin_pass":"…"` quoted key escaped the key-name table | `classifyTextCommand`/`redactSecrets` and `risk-rule-engine.redactEvidence` gain both shapes    |
| D9-12 (version check)    | `initialize` never ran `runVersionCheck`                                                     | the handshake now runs the KooCLI probe and reports the version facts under `serverInfo.kooCli` |
| D10-3                    | Chinese intent 云主机 missed ECS                                                             | ECS route-map keywords add 云主机                                                               |

D4-21 (`actions=["*"]` / managed-policy references) is carried by open PR
#1084 on this line, so it is not duplicated here.

## Tests

- `test/safety-policy.test.mjs`: generic env-dump deny; flag-space and quoted-key redaction.
- `test/risk-rule-engine.test.mjs`: env-dump rule; command-stage adminPass warn; evidence redaction.
- `test/tools.test.mjs`: 云主机 routes to ECS.
- `test/mcp-protocol-version-check.test.mjs`: initialize reports the fake KooCLI probe facts.
