# Project Graph: huaweicloud/huaweicloud-devkit

> Last updated: 2026-10-05T05:21:40.503365+08:00 | Branches: main, master | Commit: 7456d0598876b68a9313eb641eea985b63687262

## Architecture Overview
**Exploration: main entry point application startup**

Found 63 symbols across 3 files.

**Blast radius — what depends on these (update/verify before editing)**

- `main` (plugins/huaweicloud-core/src/setup-cli.mjs:5020) — 1 caller in `plugins/huaweicloud-core/src/setup-cli.mjs`; ⚠️ no covering tests found
- `main` (plugins/huaweicloud-core/hooks/huaweicloud-safety.mjs:42) — 1 caller in `plugins/huaweicloud-core/hooks/huaweicloud-safety.mjs`; ⚠️ no covering tests found
- `main` (plugins/huaweicloud-core/hooks/huaweicloud-safety.py:191) — 1 caller in `plugins/huaweicloud-core/hooks/huaweicloud-

## Module Dependency Graph
**Exploration: module import dependency**

Found 29 symbols across 5 files.

**Blast radius — what depends on these (update/verify before editing)**

- `importUndici` (plugins/huaweicloud-core/src/proxy/proxy-agent.mjs:17) — 3 callers in `plugins/huaweicloud-core/src/proxy/proxy-agent.mjs`; ⚠️ no covering tests found
- `readImportFile` (plugins/huaweicloud-core/src/tools.mjs:980) — 1 caller in `plugins/huaweicloud-core/src/tools.mjs`; ⚠️ no covering tests found
- `clearImportFile` (plugins/huaweicloud-core/src/tools.mjs:1003) — 1 caller in `plugins/huaweicloud-core/src/tools.mjs`; ⚠️ no coveri

## Core Call Chains
**Exploration: API routes endpoints handlers**

Found 28 symbols across 3 files.

**Blast radius — what depends on these (update/verify before editing)**

- `apiGet` (plugins/huaweicloud-core/src/sandbox/hwlink-api.mjs:85) — 1 caller in `plugins/huaweicloud-core/src/sandbox/hwlink-api.mjs`; ⚠️ no covering tests found
- `apiPost` (plugins/huaweicloud-core/src/sandbox/hwlink-api.mjs:103) — 1 caller in `plugins/huaweicloud-core/src/sandbox/hwlink-api.mjs`; ⚠️ no covering tests found
- `DEFAULT_ENDPOINT` (plugins/huaweicloud-core/src/telemetry/telemetry.mjs:68) — 1 caller in `plugins/huaweicloud-c

## Branch Structure
['main', 'master']

## Key Files

Project Structure (120 files):

├── .github
│   ├── ISSUE_TEMPLATE
│   │   ├── bug_report.yml (yaml, 0 symbols)
│   │   ├── config.yml (yaml, 0 symbols)
│   │   └── feature_request.yml (yaml, 0 symbols)
│   ├── workflows
│   │   ├── ci.yml (yaml, 0 symbols)
│   │   ├── npm-publish.yml (yaml, 0 symbols)
│   │   ├── release.yml (yaml, 0 symbols)
│   │   ├── security-scan.yml (yaml, 0 symbols)
│   │   ├── status-transition.yml (yaml, 0 symbols)
│   │   ├── sync-to-gitcode.yml (yaml, 0 symbols)
│   │   └── triage-issue.yml (yaml, 0 symbols)
│   └── dependabot.yml (yaml, 0 symbols)
├── bin
│   ├──
