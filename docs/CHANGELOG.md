# Changelog

## 1.1.3-next.4 (2026-09-10)

- fix: 受限网络下升级检测静默失败——checkForUpdate 改 fetch registry + 15s 超时 + DEBUG 日志 (#612) (#613)
- ci: trigger CI on push to dev (#501) (#605)

## 1.1.3-next.3 (2026-09-10)

- fix(safety): cover Nova*/Reset* destructive ops in hook risk rules (#501) (#594)
- fix(auth): resolve KooCLI config from homedir, not HUAWEICLOUD_HOME (#501) (#595)
- docs(iac): remove deposit (保证金) guidance - vouchers no longer require a deposit
- chore(docs): remove committed superpowers plan doc (already gitignored) (#501) (#599)
- fix(deps): override smol-toml to 1.8.0 to clear npm audit high vuln (#501)

## 1.1.3-next.2 (2026-09-09)

- feat(install): interactive zero-detection install menu + generic MCP wiring (#592)

## 1.1.3-next.1 (2026-09-09)

- style: prettier-align credential priority tables in README (#520)
- fix(auth): skip S2 fingerprint drift when KooCLI authEncrypt stores ciphertext (#533)
- docs: align README credential docs with SKILL.md - priority, auth_switch, env security warning (#520)
- fix(mcp): allow maxRetries 0 in numeric arg validation (#530)
- fix(mcp): reject invalid numeric args (timeoutMs/maxRetries) instead of silently ignoring (#530)
- docs: replace static beta version badge with npm version badge (#530)
- docs(obs): mb return-code trap and website endpoint propagation delay (#485)
- test(update-check): decouple upgrade-tag logic from repo package.json version

## 1.1.3-next.0 (2026-09-09)

- chore: set version-override to 1.1.3 (next -> 1.1.3-next.0) (#588)

## 1.1.2-next.8 (2026-09-09)

- feat(rev4): send X-HW-Client-Version; SKILL wording; remove unreachable cmdUpdate reinstall (#586)
- feat(setup): unix auto-install, hermes restart hint, grouped status; docs: sandbox_credentials example (#265, #280)
- feat(telemetry): classify cursor-vscode and officeace-agent MCP client names

## 1.1.2-next.7 (2026-09-09)

- fix(skills): correct cli-domain-id root cause — it signals invalid credentials, not a missing domain-id (#574)

## 1.1.2-next.6 (2026-09-09)

- style: prettier table alignment (#574)
- docs(voucher): drop in-flow domain-id discovery detail from test-env note (#574)
- fix(skills): teach agents to self-discover cli-domain-id via STS GetCallerIdentity (#574)
- docs(iac): verified traps from 2026-09-08 e2e report - keypair/RDS/DCS/EIP-quota/long-args/destroy-alignment
- docs(sandbox): index.html platform-overwrite symptom, recovery, and prevention (#263)
- feat(auth): complete non-interactive guidance and detect existing KooCLI profile in auth init (#260)

## 1.1.2-next.5 (2026-09-09)

- fix: clarify devkit version output
- docs: note mirror-lag fallback to official registry (#518)
- style: add trailing newline to hook-plugin test
- fix(auth): spawn hcloud without shell in project-id resolution
- feat(auth): validate credentials before sandbox injection + auto-set project_id (#259, #262)
- feat(telemetry): route telemetry upload through proxy
- feat(telemetry): classify MCP client names to canonical agent harness
- fix(telemetry): regenerate userHash after credential switch
- fix(telemetry): bound hcloud capture and isolate failed event retries

## 1.1.2-next.4 (2026-09-08)

- fix codex install auth probe and safety hook

## 1.1.2-next.3 (2026-09-08)

- test: align sandbox warning assertion with unified codearts wording (#261)
- style: prettier format for hcloud-cli obs hint
- style: prettier format for hermes skills snapshot
- fix(setup): unify CodeArts sandbox warning with accurate settings path (#261)
- feat(hermes): add skills snapshot for one-shot bulk install
- fix(iac): manifest-first batch approval, verified timer schedule, OBS plan hint
- chore: add mcpName field to package.json (#543)
- fix(dew): distinguish auto-rotation enable vs RotateSecret trigger
- fix(dew): CSMS CreateSecret uses --name, not --secret_name
- test: add versionMismatch assertions for runVersionCheck
- feat: pin KooCLI version and align skills with KooCLI 7.2.12

## 1.1.2-next.2 (2026-09-08)

- fix(release): make create-release-pr path helpers idempotent (#537)
- docs: remove Cursor section from README
- feat(mcp): add remote (Streamable HTTP) transport mode (#531)
- docs: clarify Cursor marketplace status (not yet listed)
- docs: document Cursor Directory support alongside other agents
- docs: move Cursor Directory section below Documentation
- fix: use agent-neutral wording for KooCLI config-write failure hint

## 1.1.2-next.1 (2026-09-08)

- fix(release): bump version override to 1.1.2 for next preview line (#527)
- feat(update): session-level version update detection & auto-upgrade (#525)
- chore: sync root plugin.json version to 1.1.1-next.16
- chore: address Cursor marketplace PR review feedback
- style: add trailing newline to plugin.json and mcp.json
- chore: add Open Plugins manifest for Cursor marketplace

## 1.1.1-next.16 (2026-09-07)

- fix(skills): deposit prompt cites official FAQ links (frozen deposit explanation + amount rules)
- style: prettier re-align huawei-iac stage-5 table
- fix(skills): deposit prompt includes recharge portal link (balanceRecharge)
- fix(skills): deposit prompt includes amount range (约 1~5 元人民币不等)
- chore(skills): bootstrap Node template bumped to v22.14.0 LTS
- fix(skills): bootstrap Node template must match instance arch (arm64 vs x64)
- fix(safety+skills): web-port rule false-positive, China mirrors, keypair import flow, E2E report findings
- fix(skills): huawei-iac stage order - inspect code before offering options; scale and hosting are separate questions
- fix(skills): huawei-iac stage-3 architecture decision points must be surfaced
- fix: repair Python hook indentation and update stale DSH/telemetry tests
- fix(telemetry): unref flush interval so tests don't hang the process
- fix(workbuddy): remove hooks field from plugin manifest to pass validate
- fix: resolve eslint and prettier errors reported by PR #500 CI
- feat(telemetry): encode install dir into harness fallback for unknown agents
- fix(openclaw): match openclaw via install path and native mcp config
- fix(package): include integrations/atomcode in npm pack
- feat(atomcode): add telemetry hook for Skill/CLI/MCP tracking
- feat: expand agent registry from 13 to 23 agents
- refactor: agent detection to table-driven registry pattern
- fix: add OfficeAce harness detection and version identification
- fix: restrict MCP keepalive to Hermes-on-Windows only, exit on stdin close for other agents
- fixE: include integrations/hermes in npm publish files
- feat(telemetry): fix harness/agentVersion detection and move telemetry hook to integrations
- fix: add integrations/workbuddy to npm files list
- feat(workbuddy): integrate telemetry hook deployment into setup-cli.mjs
- refactor(skill-tracker): remove CLI wrapper file, use single function-as-object pattern
- fix(skill-tracker): prevent duplicate hook capture in IDE mode
- fix(skill-tracker): restore CLI entry wrapper file and setup-cli install logic
- chore: fix Unicode arrow encoding in skill-tracker comments
- refactor(skill-tracker): merge into single file using function-as-object pattern
- refactor(skill-tracker): unify IDE and CLI hook plugins into shared core
- fix(telemetry): prevent duplicate DAU events on same-day process restart
- fix(setup): preserve user-customized MCP args and env during CodeArts register
- fix(telemetry): simplify checkDauPing to handle stamp deletion edge case
- refactor(telemetry): defer install stamp write to successful event delivery and remove trackInstall from setup CLI
- feat(dsh): add Cordis hook plugin for telemetry interception
- revert(dsh): remove skill tracking from Python hook and hooks copying
- feat(telemetry): add skill retrieve tracking to Python hook
- fix(telemetry): remove duplicate ideVersion declaration
- feat(telemetry): detect DSH version from npm global package
- revert(dsh): remove endpoint env var reading from dshPatchBlock
- fix(dsh): support --hdkitservice-endpoint and --telemetry-endpoint CLI args
- feat(dsh): install skill-tracker.js hook for DSH agent
- fix(telemetry): use URL.pathname instead of fileURLToPath for path detection
- fix(telemetry): use file path to detect harness, remove vscode fallback
- fix(telemetry): fix harness and version detection priority
- fix(telemetry): PLUGIN_VERSION reads undefined PLUGIN_DIR
- refactor(telemetry): move agent-specific data into agent install directories
- fix(telemetry): fix agent_version reporting wrong IDE version
- fix(telemetry): use import.meta.url to detect agent harness in hook
- fix(telemetry): detect agent harness by env vars only, remove disk-based check
- fix: skill-tracker detectHarness 新增 .codeartsdoer 目录检测，解决 plugin 加载早于 MCP 导致检测为 unknown
- refactor: dau-stamp/first-use-stamp/hook-events/dev-log 全部下沉到 agent 子目录
- fix: flushEvents 中残留的 INSTALL_STAMP 引用导致 ReferenceError，事件每 60s 重试
- fix: ensureDir 支持创建 agent 子目录，writeTextFile/touchFile 自动创建父目录
- refactor: install-stamp/counter 改用 agent 子目录隔离
- refactor: install-stamp/counter 改为按 agent 隔离，支持多 agent 独立安装上报
- fix: 各 install 函数调用 trackInstall() 确保 plugin:install 事件在每次安装后触发
- feat: 完善 CodeArts 遥测支持 — skill/CLI 事件捕获与安装脚本同步
- fix(telemetry): restore writeEvent function accidentally removed in skill filter commit
- fix(telemetry): filter non-Huawei Cloud skills from skill:retrieve events
- fix(telemetry): extract DAU check to standalone function, call from 60s timer to ensure cross-day reporting when idle
- fix(telemetry): anchor hcloud regex to command start to avoid false positives in quoted strings
- chore: add startopencode.bat to .gitignore
- chore: remove sync-opencode.ps1 from remote, add to .gitignore
- refactor(telemetry): rewrite skill-tracker hook for 3-channel coverage, fix input.tool_name bug, clean up orphaned files
- feat(telemetry): add event telemetry system with install counter and crash safety

## 1.1.1-next.15 (2026-09-07)

- feat(auth): 凭证一致化整改 — reconcile / R7 current档 / R9 会话优先 / R10 runtime守卫 (#498)

## 1.1.1-next.14 (2026-09-05)

- feat: detect new plugin versions on install/update

## 1.1.1-next.13 (2026-09-05)

- feat(uninstall): optional KooCLI/OBS cleanup on global uninstall
- feat: add `version` command reporting installed plugin version per agent
- feat(skills): add huawei-iac orchestration skill for multi-resource provisioning

## 1.1.1-next.12 (2026-09-04)

- fix: repair DSH bundle patch loading and MCP path resolution

## 1.1.1-next.11 (2026-09-04)

- style: wrap over-width line in validate-package.mjs
- fix: publish cordis.patch.yml referenced by dsh.bundle.patch

## 1.1.1-next.10 (2026-09-04)

- chore: retry CI (#479)
- chore: retry CI (#479)
- chore: retry CI (#479)
- fix(auth): prefer auth-init creds over injected STS env creds (#479)
- fix: skip npm audit/fund when installing plugin runtime deps
- test: scope node --test to actual test files

## 1.1.1-next.9 (2026-09-04)

- feat: add DSH post-install guidance for KooCLI and credentials setup
- fix(dsh): maintain existing state after legacy block cleanup
- fix: move createRequire after all imports, remove shebang, format
- refactor: remove better-sqlite3, auto-setup DSH via bundle patch

## 1.1.1-next.8 (2026-09-03)

- feat: 安装提示补充由 AI 助手转达代金券的指令

## 1.1.1-next.7 (2026-09-03)

- feat: 安装完成提示首次使用可领取华为云代金券
- docs(sandbox): find real build output dir across the whole project (#247)

## 1.1.1-next.6 (2026-09-02)

- Revert "fix(ecs): change preflight SG check from hard-deny to require_user_confirmation (#468)" (#470)

## 1.1.1-next.5 (2026-09-02)

- fix(ecs): change preflight SG check from hard-deny to require_user_confirmation (#468)
- chore: add dsh.bundle manifest for DSH plugin ecosystem

## 1.1.1-next.4 (2026-09-02)

- fix(ecs): fix preflightSecurityGroupCheck regex and query parameter format (#443) (#464)

## 1.1.1-next.3 (2026-09-02)

- feat(ecs): auto-check security group rules during plan phase (#443) (#462)
- fix: use CodeArts Work native MCP format (mcp key, command array, environment) (#461)

## 1.1.1-next.2 (2026-09-02)

- docs: voucher_status 工具描述内嵌主动提示行为指令
- fix(detect): handle unquoted outDir in VitePress config
- fix(sandbox): clean URL support for static nginx + cross-arch build guidance
- fix(release): use JS filter instead of shell glob for tag lookup

## 1.1.1-next.1 (2026-09-02)

- docs: 强化 huawei-voucher skill 主动提示准则与话术

## 1.1.1-next.0 (2026-09-02)

- chore: set version override to 1.1.1 for next preview release
- fix(sandbox): credential injection, nginx cleanup, and auto git clone
- fix(ecs): add security group reuse warning to Critical Warnings (#444)
- docs: add beta badge to Chinese README (#442)
- fix: include atomcode in skills root and report openclaw auth status
- docs: update beta badge version to v1.1.0 (#431)

## 1.1.0-next.21 (2026-09-01)

- fix(sandbox): auto-detect cross-platform from project files for QR check
- fix(sandbox): restrict QR auto-generation to cross-platform projects only
- docs: add beta badge to README (#428)
- fix(sandbox): always auto-generate QR code regardless of frameworkType

## 1.1.0-next.20 (2026-09-01)

- fix(sandbox): auto-generate QR code in deploy_check for cross-platform projects
- feat(cli): replace string matching with token-based plan-run approval (#421)

## 1.1.0-next.19 (2026-09-01)

- feat(cli): save large hcloud output to file and return path (#416)
- fix(sandbox): always run QR code check in deploy_check regardless of frameworkType
- fix(rds): correct ARM volume type from ULTRAHIGH to CLOUDSSD (#5) (#417)
- fix(safety): add STS credential exposure warning rule (#10) (#418)
- fix(safety): add rule to warn on all Delete/Detach/Remove cloud operations (#413)
- fix(auth): sync KooCLI hcloud config on auth sync (#411)
- fix: remove UTF-8 BOM from files
- fix: remove UTF-8 BOM from files
- style: prettier format fix
- style: prettier format fix
- feat: add HC activity ECS+Nginx deployment workflow reference doc
- feat: add HC activity ECS+Nginx deployment workflow to huawei-ecs skill
- style: prettier reformat huawei-vpc SKILL.md tables (#394)
- fix(vpc): correct subnet DNS addresses per region (#394)

## 1.1.0-next.18 (2026-09-01)

- docs(sandbox): fix source parameter value typos (#376)
- fix(sandbox): deploy_check captures all statuses + returns tunnel URL (#412)
- fix(hcloud): auto-accept privacy agreement on first use
- fix(safety): prevent false-positives in destructive-delete rule and approvedCommand
- docs(sandbox): scope GitCode SSL workaround to one-shot clone (#374)
- fix: retry npm install on any failure and exit non-zero when it fails (#244)
- fix: add codex desktop skills dir to resolveSkillsRoot fallback chain (#170)

## 1.1.0-next.15 (2026-08-31)

- feat: add codearts-work (CodeArts Space) agent target support (#387)
- fix(sandbox): default deploy_nginx config_name from 'app' to project name

## 1.1.0-next.14 (2026-08-31)

- test: update hdkitservice error message assertion to match new format
- fix: deploy_nginx auto-assign free port + SSR runtime env var injection
- fix: port conflict detection in deploy_nginx + SKILL.md docs
- fix(hdkitservice): improve credential and error diagnostics
- fix: batch fixes for deploy issues #15 #16 #5 #2 #22 #23
- fix(hcloud): add runtime path discovery for hcloud binary
- fix(sandbox): graceful nginx restart with orphan worker recovery
- fix(sandbox): move large_client_header_buffers to server level, harden port equality guard, add credential dev_stage_id fallback
- style: apply Prettier formatting
- fix(sandbox): prevent port conflicts, stale content, and header buffer errors in SSR deployments

## 1.1.0-next.13 (2026-08-31)

- fix: scope MCP keepalive to after stdin close only (#361)

## 1.1.0-next.12 (2026-08-31)

- fix: correct broken CLI commands in billing/vpc/dew skills (#358)
- feat: add installCommand to search_marketplace results (#353)

## 1.1.0-next.11 (2026-08-29)

- fix(hermes): fix uninstall order, config.yaml residue, and allowlist cleanup (#343)

## 1.1.0-next.10 (2026-08-29)

- fix: prevent MCP server silent exit on Windows when stdin is closed (#340)

## 1.1.0-next.9 (2026-08-28)

- fix(sandbox): nginx cleanup, try_files, reload, config_name
- docs: add Codex install section to README
- fix(sandbox): git archive prefix, symlink resolve, permission hardening
- fix(sandbox): add build failure response rules to prevent silent auto-fixes
- feat(sandbox): deploy_check tool, deploy_nginx nextStep, REQUIRED markers
- style: remove unused escapedConfig variable
- feat(sandbox): add sandbox_deploy_nginx tool + permission auto-fix
- fix(sandbox): merge Step 8 QR into Step 7, add deployment completion checklist
- style: prettier format SKILL.md blank lines
- fix(sandbox): optimize deploy flow - permissions, credentials, env detection, tunnel cleanup
- fix(sandbox): pkill devbridge before tunnel creation to prevent zombies
- fix(sandbox): use git archive for git repos to exclude all untracked/ignored files
- fix(sandbox): post-build output verification, Node v24 native module guidance
- fix(sandbox): health-check tunnel URL before returning, auto-retry on failure
- fix(sandbox): save QR to outputDir for nginx serving, drop ANSI qrencode
- docs: add Hermes uninstall notes for Linux and Windows
- style: fix ESLint catch-error-name and prettier
- chore: bump version to 1.1.0-next.8
- docs: add Hermes MCP Python SDK note to README
- fix(hermes): auto-install MCP Python SDK to fix silent tool discovery skip

## 1.1.0-next.6 (2026-08-27)

- feat: 代金券能力可发现化，新增 huawei-voucher skill 与路由
- fix(sandbox): add DevBridge quota auto-recovery, pre-cleanup, Taro build 900s timeout
- fix(sandbox): add DevBridge quota auto-recovery, pre-cleanup, Taro build 900s timeout
- fix(sandbox): add .swc/dist exclusion, post-upload permission fix, PNG QR priority, cross-platform 600s timeout
- fix(sandbox): add build timeout recovery, env injection, OS detection, dependency exclusion for upload
- fix(sandbox): add build timeout recovery, env injection, OS detection, dependency exclusion for upload

## 1.1.0-next.5 (2026-08-27)

- fix: voucher 工具 domain_id 参数标注为可选，避免 Agent 误判为必传 (#308)
- style: rename catch parameter err to error for unicorn/catch-error-name rule
- fix(sandbox): add retry for upload batch/tunnel failures, add process persistence and cross-platform warnings

## 1.1.0-next.4 (2026-08-27)

- fix(release): stop auto-deleting .version-override in create-release-pr

## 1.1.0-next.3 (2026-08-27)

- fix(release): restore .version-override to 1.1.0 until 1.1.0 stable release

## 1.1.0-next.1 (2026-08-26)

- style: format fix
- fix: separate OpenClaw install from Codex Desktop
- style: format marketplace.json
- feat: codex-desktop install to Codex-standard plugin layout
- fix: 错误提示改为英文
- style: 修复 catch 参数命名，符合 unicorn/catch-error-name 规则
- fix: 修复 hdkitservice-api.mjs 中 undici 动态导入的 lint 报错
- fix: voucher 工具后端不可用时优雅降级
- style: 修复 prettier 格式问题
- feat: 新增激励金代金券 MCP 工具
- style: format fix
- feat: add web framework detection and sandbox deploy workflow

## 1.1.0-next.0 (2026-08-25)

- fix(release): restore manifest to 1.0.2 (latest stable)
- feat(release): support .version-override for dev branch, set next target to 1.1.0
- feat: add AtomCode as supported agent target
- chore(eslint): add eslint-plugin-import-x and eslint-plugin-unicorn
- chore(release): 1.0.3-next.0
- fix(workbuddy): update post-install message - no restart needed, add connector trust prompt
- style: prettier format fix
- fix(release): derive next preview version from latest stable tag instead of stale manifest
- fix: harden DSH install runtime deps and doctor checks
- feat(modelarts): add marketplace fallback for advanced workflows
- refactor(skills): remove orphaned huawei-cloud-find-skills, wire full marketplace flow
- fix(capability-discovery): replace dead skills-index URL with huaweicloud_search_marketplace tool reference
- chore(release): 1.0.2-next.23 (#254)
- docs: restore ClawHub-first install method for OpenClaw section (#253)
- fix: use separate clawhub-publish environment for ClawHub job (#249)
- chore(release): 1.0.2-next.22 (#252)
- fix(sandbox): add workspace_id validation and improve connect ID propagation (#251)
- style: fix prettier formatting
- fix(sandbox): add workspace_id validation and improve connect ID propagation
- chore(release): 1.0.2-next.21 (#248)
- feat: add ClawHub publish to CI pipeline (#236)
- fix: OpenClaw plugin issues - workspace cache, version sync, name unification (#243)
- feat: add OpenClaw agent target support (#229)
- style: prettier format
- chore: sync hermes plugin version to 1.0.2-next.20
- fix(release): add .hermes-plugin to version sync list
- chore(release): 1.0.2-next.20
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
- chore(release): 1.0.2-next.19
- style: prettier format
- chore: bump version to 1.0.2-next.18 (#205)
- chore: sync openclaw.plugin.json version to 1.0.2-next.18
- style: prettier format
- fix: resolve MCP server version to plugin package.json, add officeace version sync and tests
- chore(release): 1.0.2-next.17
- feat: add sandbox_upload_project tool with HTTP tunnel transfer
- style: prettier format for audit report and openclaw plugin manifest
- fix: resolve 6 critical issues from audit report
- feat: add openclaw.plugin.json for OpenClaw bundle adapter (v1.0.2-next.16)
- chore: remove retired publish-dev.yml, empty cd-production.yml stub, fix repo URL case
- fix: handle linux-arm64 in install-hcloud test, prettier format
- feat: add PR-triggered automated tests for agent compatibility and cross-platform
- style: format agent-install.test.mjs
- test: add ARM platform support to install-hcloud platform detection test
- docs: remove Codex from README support list and sections, drop Qixi demo files
- ci: add PR code review workflow with Huawei Cloud MaaS GLM-5.2
- chore: ignore deploy-qixi.mjs in eslint
- fix: add agent-install test, integration CI job, USERPROFILE cross-platform fix
- style: apply prettier formatting, fix lint warnings in auth tests
- fix: make USERPROFILE/HOME test work on both Linux and Windows
- refactor: remove dynamic SUPPORTED_AGENT_TARGETS README check, PR template suffices
- docs: PR template README checklist + CI warns instead of blocks
- feat: dynamic README validation from SUPPORTED_AGENT_TARGETS
- docs: update MCP config to npx in README, add sandbox feature, add README CI checks
- chore(qixi): add sandbox deployment script for cyber companion
- feat(qixi): add cyber companion web app for Qixi Festival
- docs: add Qixi cyber companion implementation plan
- docs: add Qixi cyber companion design spec
- fix: gate CodeArts credential source behind isCodeArtsContext check to avoid affecting other agents
- feat: add CodeArts mcp_settings.json as credential source for project-level AK/SK
- feat: runtime credential switching for multi-account sandbox isolation
- docs: fix English CodeArts sandbox settings path
- docs: fix CodeArts sandbox mode settings path in README and CLI
- chore(release): 1.0.2-next.13
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
- chore(release): 1.0.2-next.12
- fix: sandbox MCP improvements - execOneShot tool, timeout, devbridge, endpoint clarity
- chore(release): 1.0.2-next.11
- fix: move eslint-disable-next to correct line for node:undici import
- style: format proxy-agent.mjs with prettier
- fix(proxy): use undici fetch for proxy dispatcher, add node:undici fallback, load proxy env at startup
- docs: restructure README - unify command style, add install-hcloud/auth/install-all/update-all sections
- docs: update OpenCode section with --target recommendation
- docs: clarify auto-detection behavior when multiple agents are present
- fix(release): push to dev only tags, avoid auto-creating release PRs on code merges
- chore(release): 1.0.2-next.10
- feat: add huaweicloud-devkit-mcp bin entry for standard MCP config
- chore(release): 1.0.2-next.9
- style: prettier format fix for OfficeAce adapter
- feat: add OfficeAce adapter support
- fix(install): run npm install for runtime deps (undici) after copying src
- fix: format version files with prettier, fix lint in create-release-pr.mjs
- fix(release): run prettier on changed files before creating release PR
- fix: remove format from test job needs so formatting issues do not block tests
- feat(release): publish prereleases directly from dev, manual dispatch only
- style: apply prettier, relax structure assertion for reformatted fallback
- fix(tools): skip stale skills dirs in SKILLS_ROOT fallback, support symlinked skills
- feat(icons): integrate official Huawei Cloud Icons library logo search
- fix(setup): auto-detect agent target, reject unknown agents, stop if none detected
- refactor(proxy): remove dead undici dependency, simplify importUndici
- chore: add ESLint and Prettier for JS/YAML/MD/JSON formatting and linting
- fix(proxy): WebSocketImpl is not a constructor - use class instead of arrow function
- fix: reset dev version to 1.0.1 and sync all manifests
- fix(release): run tag step before release PR creation to avoid tagging the wrong branch
- fix(release): configure git user before creating release PR
- fix(proxy): resolve 6 proxy-related issues from test report
- feat(release): replace release-please with custom counter-increment workflow
- fix(skills): document CCE field-by-field errors and Flyway SQL dialect trap (#125)
- fix: escape backslashes in pack-verify.mjs quote helper (#122)
- fix(sandbox): validate local_path before file upload, register upload tool in policy (#121)
- feat(huawei-sandbox): add chunked file upload primitive for local-to-sandbox transfer (#120)
- fix(release): pass RELEASE_PLEASE_TOKEN to release-please so its PR pushes trigger CI
- fix(release): rename publish workflow to npm-publish and use quoted step names
- feat(release): separate verification from publication with tag-gated manual publish
- fix(release): actually add checkout and setup-node to prerelease publish job
- feat: skill 按 check-user 三种 403 分支分别引导用户
- feat: check-user 同时返回实名/协议状态，skill 支持两项缺失一并告知
- fix(release): add checkout steps to prerelease publish job, disable component-in-tag
- fix(release): use release-please-action v4 tag instead of invalid SHA pin
- chore(release): adopt release-please, retire manual publish workflows, sync workbuddy manifest
- fix: 协议签署必须由用户明确同意，严禁 agent 自动代签
- test(dsh): isolate DSH_HOME in auth tests
- feat(dsh): add DeepSeek Harness target support
- feat(proxy): add HTTP/HTTPS proxy support for all outbound connections
- chore: bump version to 1.0.2-dev.10 (next 预发布)
- fix: sandbox 错误响应解析 traceId 驼峰字段名，统一描述字段为驼峰
- feat(routing): offer deployment targets with sandbox first for static sites

## 1.0.3-next.0 (2026-08-24)

- fix(workbuddy): update post-install message - no restart needed, add connector trust prompt
- style: prettier format fix
- fix(release): derive next preview version from latest stable tag instead of stale manifest
- fix: harden DSH install runtime deps and doctor checks
- feat(modelarts): add marketplace fallback for advanced workflows
- refactor(skills): remove orphaned huawei-cloud-find-skills, wire full marketplace flow
- fix(capability-discovery): replace dead skills-index URL with huaweicloud_search_marketplace tool reference
- chore(release): 1.0.2-next.23 (#254)
- docs: restore ClawHub-first install method for OpenClaw section (#253)
- fix: use separate clawhub-publish environment for ClawHub job (#249)
- chore(release): 1.0.2-next.22 (#252)
- fix(sandbox): add workspace_id validation and improve connect ID propagation (#251)
- style: fix prettier formatting
- fix(sandbox): add workspace_id validation and improve connect ID propagation
- chore(release): 1.0.2-next.21 (#248)
- feat: add ClawHub publish to CI pipeline (#236)
- fix: OpenClaw plugin issues - workspace cache, version sync, name unification (#243)
- feat: add OpenClaw agent target support (#229)
- style: prettier format
- chore: sync hermes plugin version to 1.0.2-next.20
- fix(release): add .hermes-plugin to version sync list
- chore(release): 1.0.2-next.20
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
- chore(release): 1.0.2-next.19
- style: prettier format
- chore: bump version to 1.0.2-next.18 (#205)
- chore: sync openclaw.plugin.json version to 1.0.2-next.18
- style: prettier format
- fix: resolve MCP server version to plugin package.json, add officeace version sync and tests
- chore(release): 1.0.2-next.17
- feat: add sandbox_upload_project tool with HTTP tunnel transfer
- style: prettier format for audit report and openclaw plugin manifest
- fix: resolve 6 critical issues from audit report
- feat: add openclaw.plugin.json for OpenClaw bundle adapter (v1.0.2-next.16)
- chore: remove retired publish-dev.yml, empty cd-production.yml stub, fix repo URL case
- fix: handle linux-arm64 in install-hcloud test, prettier format
- feat: add PR-triggered automated tests for agent compatibility and cross-platform
- style: format agent-install.test.mjs
- test: add ARM platform support to install-hcloud platform detection test
- docs: remove Codex from README support list and sections, drop Qixi demo files
- ci: add PR code review workflow with Huawei Cloud MaaS GLM-5.2
- chore: ignore deploy-qixi.mjs in eslint
- fix: add agent-install test, integration CI job, USERPROFILE cross-platform fix
- style: apply prettier formatting, fix lint warnings in auth tests
- fix: make USERPROFILE/HOME test work on both Linux and Windows
- refactor: remove dynamic SUPPORTED_AGENT_TARGETS README check, PR template suffices
- docs: PR template README checklist + CI warns instead of blocks
- feat: dynamic README validation from SUPPORTED_AGENT_TARGETS
- docs: update MCP config to npx in README, add sandbox feature, add README CI checks
- chore(qixi): add sandbox deployment script for cyber companion
- feat(qixi): add cyber companion web app for Qixi Festival
- docs: add Qixi cyber companion implementation plan
- docs: add Qixi cyber companion design spec
- fix: gate CodeArts credential source behind isCodeArtsContext check to avoid affecting other agents
- feat: add CodeArts mcp_settings.json as credential source for project-level AK/SK
- feat: runtime credential switching for multi-account sandbox isolation
- docs: fix English CodeArts sandbox settings path
- docs: fix CodeArts sandbox mode settings path in README and CLI
- chore(release): 1.0.2-next.13
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
- chore(release): 1.0.2-next.12
- fix: sandbox MCP improvements - execOneShot tool, timeout, devbridge, endpoint clarity
- chore(release): 1.0.2-next.11
- fix: move eslint-disable-next to correct line for node:undici import
- style: format proxy-agent.mjs with prettier
- fix(proxy): use undici fetch for proxy dispatcher, add node:undici fallback, load proxy env at startup
- docs: restructure README - unify command style, add install-hcloud/auth/install-all/update-all sections
- docs: update OpenCode section with --target recommendation
- docs: clarify auto-detection behavior when multiple agents are present
- fix(release): push to dev only tags, avoid auto-creating release PRs on code merges
- chore(release): 1.0.2-next.10
- feat: add huaweicloud-devkit-mcp bin entry for standard MCP config
- chore(release): 1.0.2-next.9
- style: prettier format fix for OfficeAce adapter
- feat: add OfficeAce adapter support
- fix(install): run npm install for runtime deps (undici) after copying src
- fix: format version files with prettier, fix lint in create-release-pr.mjs
- fix(release): run prettier on changed files before creating release PR
- fix: remove format from test job needs so formatting issues do not block tests
- feat(release): publish prereleases directly from dev, manual dispatch only
- style: apply prettier, relax structure assertion for reformatted fallback
- fix(tools): skip stale skills dirs in SKILLS_ROOT fallback, support symlinked skills
- feat(icons): integrate official Huawei Cloud Icons library logo search
- fix(setup): auto-detect agent target, reject unknown agents, stop if none detected
- refactor(proxy): remove dead undici dependency, simplify importUndici
- chore: add ESLint and Prettier for JS/YAML/MD/JSON formatting and linting
- fix(proxy): WebSocketImpl is not a constructor - use class instead of arrow function
- fix: reset dev version to 1.0.1 and sync all manifests
- fix(release): run tag step before release PR creation to avoid tagging the wrong branch
- fix(release): configure git user before creating release PR
- fix(proxy): resolve 6 proxy-related issues from test report
- feat(release): replace release-please with custom counter-increment workflow
- fix(skills): document CCE field-by-field errors and Flyway SQL dialect trap (#125)
- fix: escape backslashes in pack-verify.mjs quote helper (#122)
- fix(sandbox): validate local_path before file upload, register upload tool in policy (#121)
- feat(huawei-sandbox): add chunked file upload primitive for local-to-sandbox transfer (#120)
- fix(release): pass RELEASE_PLEASE_TOKEN to release-please so its PR pushes trigger CI
- fix(release): rename publish workflow to npm-publish and use quoted step names
- feat(release): separate verification from publication with tag-gated manual publish
- fix(release): actually add checkout and setup-node to prerelease publish job
- feat: skill 按 check-user 三种 403 分支分别引导用户
- feat: check-user 同时返回实名/协议状态，skill 支持两项缺失一并告知
- fix(release): add checkout steps to prerelease publish job, disable component-in-tag
- fix(release): use release-please-action v4 tag instead of invalid SHA pin
- chore(release): adopt release-please, retire manual publish workflows, sync workbuddy manifest
- fix: 协议签署必须由用户明确同意，严禁 agent 自动代签
- test(dsh): isolate DSH_HOME in auth tests
- feat(dsh): add DeepSeek Harness target support
- feat(proxy): add HTTP/HTTPS proxy support for all outbound connections
- chore: bump version to 1.0.2-dev.10 (next 预发布)
- fix: sandbox 错误响应解析 traceId 驼峰字段名，统一描述字段为驼峰
- feat(routing): offer deployment targets with sandbox first for static sites

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
