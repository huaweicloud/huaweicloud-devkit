# Changelog

## 1.0.2 (2026-08-22)

- style: prettier format fix
- feat: v1.0.2 stable - merge all dev changes
- fix(release): update release trigger to workflow_dispatch and main push only
- feat(release): sync release workflow to main, seed manifest with 1.0.1
- fix(release): retire the live Publish Dev workflow on main
- fix(release): restore full publish flow with quoted step names
- fix(release): probe publish job with environment only
- fix(release): probe without job outputs and needs.outputs wiring
- fix(release): restore full tag-gated publish logic
- fix(release): reduce npm-publish workflow to minimal probe
- fix(release): drop workflow_dispatch inputs, derive dist-tag from the tag version
- fix(release): rename publish workflow to npm-publish to recover a fresh workflow_dispatch index
- fix(release): add pack-verify script to main
- fix(release): sync ci.yml with pack verification to main
- fix(release): add tag-gated Publish workflow to main so workflow_dispatch works from tags
- docs: fix README Node.js requirement, discussions badge link, and repo URL

## 1.0.2-next.23 (2026-08-22)

- docs: restore ClawHub-first install method for OpenClaw section (#253)
- fix: use separate clawhub-publish environment for ClawHub job (#249)

## 1.0.2-next.22 (2026-08-22)

- fix(sandbox): add workspace_id validation and improve connect ID propagation (#251)

## 1.0.2-next.21 (2026-08-22)

- feat: add ClawHub publish to CI pipeline (#236)
- fix: OpenClaw plugin issues - workspace cache, version sync, name unification (#243)
- feat: add OpenClaw agent target support (#229)

## 1.0.2-next.20 (2026-08-21)

- fix: resolve merge conflicts - remove extra braces from clash with hermes
- feat: add OpenClaw agent target support
- fix(officeace): replace restart prompt with connector enable guide
- style: prettier format
- fix: remove BOM from hermes plugin.json
- style: prettier format
- feat: add Hermes Agent target support
- fix(officeace): add officeaceCapabilitiesDirSafe fallback for non-Windows platforms
- fix(officeace): simplify lookup - registry first, scan incl LOCALAPPDATA, interactive prompt only
- fix(officeace): add LOCALAPPDATA\Programs to scan fallback
- chore: OFFICE_CLAW_CONFIG_ROOT before registry for env var override
- fix(officeace): use OFFICE_CLAW_CONFIG_ROOT + registry for install dir discovery
- style: prettier format
- test(ci): add multi-agent plugin install/uninstall e2e tests
- ci: bump all Node 20 references to 24 across workflows
- ci: bump Node.js test matrix from 20/22 to 22/24
- fix: align Node.js version declaration from >=20 to >=22
- style: apply prettier formatting
- fix: remove WorkBuddy hooks to avoid high-risk prompt, add sandbox-first scenario routing
- style: prettier format setup-cli.mjs
- fix: add timeout:300000 to MCP config in install scripts
- fix: increase upload_project default timeout from 120s to 300s
- fix: rename installed package name from huaweicloud-plugins to huaweicloud-devkit, add npx cache cleanup to README
- docs: add NOTICE and source attribution headers for hwlink-derived code
- Revert "[ci]: add PR code review workflow "

## 1.0.2-next.19 (2026-08-21)

- style: prettier format
- chore: bump version to 1.0.2-next.18 (#205)
- feat: add sandbox_upload_project tool with HTTP tunnel transfer
- ci: add PR code review workflow with Huawei Cloud MaaS GLM-5.2

## 1.0.2-next.13 (2026-08-19)

- ci: restore Windows jobs but skip actual build (branch protection requirement)
- ci: temporarily exclude Windows from test matrix (better-sqlite3 compile issue)
- ci: add back setup-python alongside msvc-dev-cmd for Windows
- ci: use msvc-dev-cmd for Windows node-gyp builds
- ci: set msvs_version and disable build-from-source on Windows
- refactor(officeace): switch back to better-sqlite3 for WAL support
- refactor(officeace): replace better-sqlite3 with sql.js (pure JS, no native compilation)
- test: update officeace structure tests for sqlite function renames
- refactor(officeace): replace node:sqlite with better-sqlite3 for Node 20 support
- feat(officeace): write MCP config directly to mcp-connectors.sqlite instead of capabilities.json

## 1.0.2-next.12 (2026-08-19)

- fix: sandbox MCP improvements - execOneShot tool, timeout, devbridge, endpoint clarity

## 1.0.2-next.11 (2026-08-19)

- fix: move eslint-disable-next to correct line for node:undici import
- style: format proxy-agent.mjs with prettier
- fix(proxy): use undici fetch for proxy dispatcher, add node:undici fallback, load proxy env at startup
- docs: restructure README - unify command style, add install-hcloud/auth/install-all/update-all sections
- docs: update OpenCode section with --target recommendation
- docs: clarify auto-detection behavior when multiple agents are present
- fix(release): push to dev only tags, avoid auto-creating release PRs on code merges

## 1.0.2-next.10 (2026-08-19)

- feat: add huaweicloud-devkit-mcp bin entry for standard MCP config
- chore(release): 1.0.2-next.9
- style: prettier format fix for OfficeAce adapter
- feat: add OfficeAce adapter support
- fix(install): run npm install for runtime deps (undici) after copying src
- fix: format version files with prettier, fix lint in create-release-pr.mjs
- fix(release): run prettier on changed files before creating release PR
- fix: remove format from test job needs so formatting issues do not block tests
- feat(release): publish prereleases directly from dev, manual dispatch only

## 1.0.2-next.9 (2026-08-19)

- style: prettier format fix for OfficeAce adapter
- feat: add OfficeAce adapter support
- fix(install): run npm install for runtime deps (undici) after copying src
- fix: format version files with prettier, fix lint in create-release-pr.mjs
- fix(release): run prettier on changed files before creating release PR
- fix: remove format from test job needs so formatting issues do not block tests
- feat(release): publish prereleases directly from dev, manual dispatch only
- style: apply prettier, relax structure assertion for reformatted fallback
- fix(tools): skip stale skills dirs in SKILLS_ROOT fallback, support symlinked skills

Release notes are generated from GitHub Releases. See https://github.com/huaweicloud/HuaweiCloud-Devkit/releases
