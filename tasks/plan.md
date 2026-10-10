# Plan: Telemetry Disclosure in README

## Task Breakdown

| #   | Task                                        | Files                     | Complexity |
| --- | ------------------------------------------- | ------------------------- | ---------- |
| 1   | Add `## Telemetry` section to README.md     | `README.md`               | Simple     |
| 2   | Add `## 遥测` section to README.zh-CN.md    | `README.zh-CN.md`         | Simple     |
| 3   | Add structure test for telemetry disclosure | `test/structure.test.mjs` | Simple     |
| 4   | Run lint, tests, format check               | —                         | Simple     |

## Design Decisions

- Place the Telemetry section after "Configure Proxy" and before "What It Does"
  (EN) / "功能特性" (ZH) — it fits naturally with configuration topics.
- Content is grounded in the actual `telemetry.mjs` source code:
  - `isTelemetryEnabled()` checks `HUAWEICLOUD_DEVKIT_TELEMETRY !== 'off'`
  - `DEFAULT_ENDPOINT` = `https://devkit.huaweicloud.com/.../telemetry/events`
  - `sanitizeValue()` truncates to 255 chars and strips newlines/tabs
  - `generateOrRecoverInstallId()` uses SHA-256 of machine fingerprint
  - No AK/SK, no credentials, no user input in event payloads
- No external API dependencies.
