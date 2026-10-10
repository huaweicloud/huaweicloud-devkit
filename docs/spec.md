# PRD: Telemetry Disclosure in README

## Background

Issue #871 requests that huaweicloud-devkit's README.md disclose the plugin's
telemetry mechanism so users understand what data is collected, how it is
transmitted, how privacy is protected, and how to opt out.

The reference model is [vercel/vercel-plugin](https://github.com/vercel/vercel-plugin)
which includes a "Telemetry" section in its README.

## Current State

The plugin already collects anonymous telemetry via
`plugins/huaweicloud-core/src/telemetry/telemetry.mjs`, but neither
`README.md` nor `README.zh-CN.md` mentions this fact.

## Requirements

### Functional

1. **README.md** — add a `## Telemetry` section (English) disclosing:
   - What data is collected (installation ID, user hash, plugin version, agent harness,
     agent version, OS type/version, capability, event keys and sanitized values)
   - What data is **not** collected (no AK/SK, no credentials, no user input,
     no code content, no IP addresses)
   - How data is collected and transmitted (in-memory queue, batched HTTP POST
     to the Huawei Cloud telemetry endpoint, respects proxy settings)
   - Privacy protections (installation ID is a SHA-256 hash of machine
     fingerprint, user hash is server-generated not local PII,
     values sanitized/truncated, no raw PII)
   - How to opt out (`HUAWEICLOUD_DEVKIT_TELEMETRY=off`)
   - How to debug (`HUAWEICLOUD_DEVKIT_DEBUG=true`)

2. **README.zh-CN.md** — add the equivalent `## 遥测` section in Chinese.

3. **Structure test** — add a test in `test/structure.test.mjs` that asserts
   both READMEs contain a Telemetry section with the opt-out env var.

### Non-functional

- The disclosure must accurately reflect the actual telemetry implementation
  in `telemetry.mjs` — no fabricated claims.
- Markdown must pass `markdownlint` (existing `npm run lint:md`).
- Content must be concise (the README is already long).

## Acceptance Criteria

- [ ] README.md has a `## Telemetry` section
- [ ] README.zh-CN.md has a `## 遥测` section
- [ ] Both sections mention `HUAWEICLOUD_DEVKIT_TELEMETRY=off` as the opt-out
- [ ] Both sections describe the data collection scope (what is and is not collected)
- [ ] A structure test verifies the above
- [ ] `npm run lint` passes
- [ ] `npm test` passes
- [ ] `npm run format:check` passes
