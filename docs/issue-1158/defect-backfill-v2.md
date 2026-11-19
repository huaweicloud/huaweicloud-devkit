# Issue #1158 — v2 defect backfill

Carrier for the QA-confirmed gaps that remain on the v2 line after PR #1159
(which is intentionally left untouched):

| ID                       | Defect                                                        | Fix                                                                                                                                                     |
| ------------------------ | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D4-2                     | `env \| grep access_key` / `secret_key` fell through to allow | the env-dump family accepts the vendor-neutral credential keys in the rule catalog, the TS text classifier, and its Python hook twin (parity preserved) |
| D4-6 (stages)            | `--admin-pass` never surfaced at the command stage            | `hwc-command-adminpass-exposure` stages add `command`; regex adds the hyphenated form while placeholder values stay exempt                              |
| D4-6 / D4-26 (redaction) | `--admin_pass value` space form escaped the key-value table   | `redactString`/`redactEvidenceText` gain the flag space form; the quoted-key form was already covered by #1157                                          |

## Tests

- `test/risk-rule-engine.test.ts`: generic env-dump deny; command-stage adminPass warn + redaction.
- `test/safety-text-command.test.ts`: generic env-dump deny in the text classifier.
- `test/safety-redact.test.ts`: flag-space and quoted-key redaction.
- `test/hook-parity.test.ts`: the Python hook and TS classifier agree on the generic keys.
