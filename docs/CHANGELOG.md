# Changelog

## Unreleased

- feat(secrets): encrypted local secret vault with secret:// ref plumbing — a zero-dependency vault library (src/lib/secret-vault/: refs/custody/store/cli, AES-256-GCM with the ref as AAD, HMAC fingerprint, master key in the OS keychain with a 0600 keyfile fallback, withDepLock-serialized writes, lost-key and mismatch refusals) backs the `secret set/get/list/rm/exec` CLI family (get requires an explicit --stdout/--file destination, exec refuses hcloud children and spawns shell:false) and the new `secrets` MCP pack (huaweicloud_secret_set/list/delete, no value-retrieval tool, withheld from the unauthenticated remote surface alongside the auth/OBS local-writer family); S1 credential values may be secret:// refs resolved through one seam (readGlobalCredentialsStrict) consumed by resolveCredentials, scanState (s1RefError surfaced in status/reconcile/onboarding), syncAuth, auth_switch/auth_init (ref representation preserved in S1 via preserveRefForm while mirrors receive plaintext), sandbox credentials, and the CLI's auth init/reconcile; the Bash-face safety policy was hardened in lockstep (quote/heredoc-aware shell scanner, command-position unwrapping incl. wrappers/redirects/control keywords, secret-exec laundering closure, ANSI-C/backtick obfuscation deny, order-independent reveal pair, credential-file pattern widening with quote/normalization blindness closed, env-dump family scoping, TS/python parity pinned by a shared 90-command battery) — shell-indirection and glob evasions are documented residuals in the safety skill's references/secrets.md; existing installs with a pinned DEVKIT_PACKS get the secrets pack as opt-in (doctor and `packs status` print a one-line INFO announcement, or a WARN when the vault is initialized but the pack is trimmed — `packs enable secrets` to disclose)

- feat(skills): `huaweicloud_list_skills` discloses `skillRoot` — the skills tree's absolute location, stdio sessions only — so a same-machine agent can read `<skillRoot>/<name>/SKILL.md` and `references/` directly with its own file tools (untruncated, selective), while `huaweicloud_retrieve_skill` stays the gated, telemetry-bearing, portable loader (remote sessions and manifest-based agents rely on it; the stateless remote withholds the field, so the list_skills payload on its unauthenticated CORS-* face never carries the host path). `DEVKIT_PACKS` gating is disclosure-level on both fields' terms: catalog entries never reference a trimmed pack's skills, while `skillRoot` discloses the shared tree (every skill, including trimmed packs' and the six core meta-skills) — the doctrine `enable.ts` applies to pack handlers, now stated for skill files. The direct-read teaching rides the funnel's hot lines (huaweicloud-core's handoff step and Tool Boundary, capability-discovery's discovery chain, both tool descriptions, the agent rules file), a structure guard pins the dual-path teaching, and the loading-doctrine copy is synced across every surface that states it (AGENTS/README/README.zh-CN/INSTALL, hermes manifest, doctor command, the five telemetry hooks — the atomcode one drops its native skill-load classification, the prefix-match misattribution branch the other four shed earlier, and their headers and blind-spot wording are now precise: direct reads are observable as catalog calls, never as which skill file was consumed — plus installer/doctor labels and the code comments that claimed "sole skill-loading surface").

- feat(skills): `huaweicloud_list_skills` — a one-call metadata catalog of every enabled non-core pack's skills (name, parsed description, version, owning pack, reference filenames; optional `pack` filter) so agents can browse before paying for `huaweicloud_retrieve_skill`'s full payload; skills of packs trimmed by `DEVKIT_PACKS` are omitted, and the six core meta-skills stay excluded (native disclosure / retrieve_skill territory). Frontmatter parsing (name/description/version) is consolidated into the pure `src/lib/skill-frontmatter.ts` shared by searchDocs, retrieveSkill, and the new catalog: a sequential field walker that never mistakes a key-shaped line inside a quoted description for a field, fixing the multi-line description truncation (huawei-ecs's second paragraph) and the YAML quotes that leaked into every quoted description's value. A structure invariant now requires every source SKILL.md to parse with a non-empty quote-free description, a frontmatter name equal to its directory name, and an absent-or-numeric version; retrieve_skill and search_docs carry consumer-level pins of the fixed shapes.

- fix(review): close the seventh-round gaps — uninstall attribution is dir-gated to the DSH native dir (matching the writer invariant doctor already enforces; a hand-copied package-root receipt anywhere else earns nothing), the postinstall hint gate's discriminating cell (broken package × destination failure) is test-pinned, the uninstall-path young-tmp survival is pinned, and AGENTS.md describes the age-gated sweep contract
- fix(review): close the sixth-round gaps — the postinstall's destination-failure catch returns the real package health (the availability hint never follows a refuse-to-start diagnosis), receipt tmp sweeps are age-gated through one shared sweepReceiptTmpFiles (a concurrent live writer's in-flight tmp is never taken), the marketplace liveness probe is single-sourced as marketplacePayloadTree, doctor honors a package-root receipt only on the dsh row, and the availability hint plus the attribution-path tmp sweep are test-pinned in both directions

- feat(skills): native disclosure for the six core meta-skills — the core routing skills ship as full native copies into the native skill dirs of the eight directory-based agents (receipt-gated convergence, manifest packOf ownership, PAYLOAD_TARGETS-driven sync, DSH postinstall parity); the 24 service skills stay MCP-only so DEVKIT_PACKS gating holds
- feat(doctor): native core-skill freshness checks — per-target content equality against the installed payload, orphan and foreign-dir detection, warn-only diagnostics
- fix(review): harden the native surface after adversarial review — DSH postinstall warn-and-continue on destination failures, doctor survives a missing skills tree and recognizes the DSH package-root layout (no false orphans, payload-manifest roster), receipts are shape-validated and atomically written with corrupt-torn writes treated as managed, uninstall consumes the receipt before destroying it (retired names go), and nativeSkillDirs derives from PAYLOAD_TARGETS instead of a hand list
- fix(review): close the third-round gaps — the receipt becomes one shared module (src/lib/native-receipt.ts, consumed by the postinstall via compiled dist) recording the DSH marketplace layout and package root, so doctor detects real marketplace installs (the bundled patch never carries the CLI-managed markers) and compares freshness against the profile's actual package with an honest remediation; the shape-broken corrupt boundary, foreign-dir delete rights, uninstall corrupt-receipt leftovers, and the some()-masked broken payload are fixed and pinned; the version-skew test now discriminates
- fix(review): close the fifth-round gaps — uninstall attribution is liveness-gated (a dead marketplace maintainer's copies are residue and go; npm uninstall of the profile package runs nothing devkit-side), the doctor hedge keys on resolvability (layout-less AND root-less marketplace receipts) and is scoped to the dsh row, the corrupt-receipt warning on the DSH dir names both remediations, packageRoot control characters are stripped at read in the shared module, writeNativeReceipt sweeps crashed predecessors' tmp files, and the postinstall gates its availability hint on package health
- fix(review): close the fourth-round gaps — uninstall honors the receipt's maintainer attribution (marketplace-owned copies and receipt stay, with the package-removal hint), the postinstall loads the shared dist libs via dynamic import() (no require(esm) Node-version dependency, honest load-failure diagnostics), doctor hedges layout-less receipts instead of prescribing the layout-converting fix and stays silent in the orphan branch when the receipt is corrupt, packageRoot is validated absolute and control-character-stripped when echoed, uninstall sweeps orphaned receipt tmp files, and pack:verify pins the postinstall and its dist/lib dependencies in the tarball

## 1.1.7 (2026-09-24)

- chore: merge dev into main for 1.1.7 release (#812)
- chore(release): 1.1.6 (#796)
- style: prettier normalize plugin manifests
- chore(release): 1.1.6
- chore(release): 1.1.5
- chore: sync README beta badge to v1.1.5
- chore: version override for 1.1.5 stable release
- chore(release): 1.1.4
- chore(release): 1.1.3 (#620)
- chore: advance main to 1.1.3-next.4 (business keeps dev; prepare stable 1.1.3) (#619)
- test(update-check): decouple upgrade-tag logic from repo package.json version
- chore(release): 1.1.2
- test: resolve structure.test.mjs to dev version (union-merge artifact)
- chore(release): 1.1.1 (#515)
- chore: merge dev into main for 1.1.1 stable release (#513)
- chore: add dsh.bundle manifest for DSH plugin ecosystem
- chore(release): 1.1.0 (#440)
- chore: merge dev into main for 1.1.0 release (#438)
- chore: version override for 1.1.0 stable release (#433)
- docs: add Huawei Cloud npm mirror recommendation for China users
- chore(release): 1.0.2
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

## 1.1.7-next.1 (2026-09-23)

- style(sandbox): split devbridge login/status chain for clearer diagnostics
- feat(sandbox): probe devbridge auth capability instead of assuming from version
- style: prettier normalize plugin manifests
- chore(release): 1.1.7-next.0 (advance dev prerelease line)

## Unreleased

- fix(packs): 第三轮实现检视四组修正——`callOpenMcpTool` 信封新增 `forwarded: true`（仅三个往返完成分支携带，catch 不带：超时/中途子死/spawn 失败都不是转发完成；JSON-RPC 错误答复如 Unknown tool 也保守归入 catch，对 eval 的词汇表内任务不可达），eval 的 `reached` 判据改读该字段（上一修正波的 `final.tool` 判据被三评审独立证伪——catch 无条件带 `tool`，60 秒超时与中途死亡被误计 reached，注释声称的不变量为假；首次 spawn 失败不带 `tool` 恰是 handler 预 await 的巧合分层而非信封性质）；新增 `forwarded marks completed round trips and nothing else` 回归测试钉全部四形态（成功/isError/信封失败带 forwarded，超时不带），夹具新增 `FAKE_SLOW_MS` 旋钮（延迟 tools/call 应答使短超时落入 request 计时器——tools/call 分支提取为 handleToolsCall 纯搬迁）；守卫片段延伸钉住 `include_sops`（`get_product (product; optional include_sops` 与 `list_apis` 全参数片段——该参数上轮恢复但无钉，再删一次仍全绿），`huawei-openapi` 技能的 list_apis/get_product 行补 include_sops 教学（两个教学面不再分叉），片段名提取改 `split(' ')[0]`；计数注释清扫补完上波遗漏（tools.ts "35 non-core"、registry.ts "35 pack-owned"、mcp-protocol.ts "11 tools"、plugins-e2e "all 46"、structure.test "33 total" 全部改派生表述）并修 `integrations/hermes/manifest.yaml` 的实际错误数字（"42 tools" 是其写作当年的数，该 manifest 的 stdio server 注册全部工具）；CHANGELOG 措辞对齐（上波"根治"过宣，实为列举范围内的清扫）
- fix(packs): 面收敛实现检视（三模型对抗评审）五组修正——服务侧 `gateway_call` 描述补 `include_sops`（get_product / list_apis 各一，原吸收时遗漏，该参数一度全 devkit 表面无处可学）；描述守卫从技能教学测试挪出为独立命名测试并改钉字面片段加整句 `Discovery chain: search_apis → list_apis → get_api → get_api_examples`（旧 `includes('get_api')` 被 `get_api_examples` 子串满足、`indexOf` 链序落进同一子串），片段名集与词汇表 deepEqual 防名字漂移；eval 脚本 `reached` 判据修正、`needsDiscovery` 死概念注释改写、`/home/cheney` 个人路径兜底改 `homedir()`；round-10 历史注释还原当年的 `huaweicloud_search_apis` 死名例证；计数注释改派生表述（七个 pack 的 `all 51 tools`、tool-schemas 八处 `all 46`、hermes-windows 的 `All 35 tools`）
- test(proxy): 网络类测试对环境代理密闭化——`hdkitRequest` 每次请求先问 `getProxyDispatcher`,解析器读双拼写（`HTTPS_PROXY || https_proxy`）加 proxy.json;环境有小写代理变量（curl 惯例；这些 https 目标实际由 `https_proxy` 分流）时 undici 分支绕开被桩的 `global.fetch`,六个测试在配代理的开发机上红而干净 CI 上绿（假绿）。proxy-agent 测试的环境帮助函数改为清理全部六种拼写、新增仅小写与仅大写两个单拼写钉测试（镜像堵住两种回归）；hdkitservice 测试文件级建立无代理前提（双拼写 env + 临时 `HUAWEICLOUD_HOME` 阻断 proxy.json 泄漏）。实测小写代理变量在场时全套件绿
- refactor(packs): open-mcp 六个只读专属面（`huaweicloud_search_apis` / `list_products` / `get_product` / `list_apis` / `get_api` / `get_api_examples`）删除，全部网关工具统一走 `huaweicloud_gateway_call`——`classify()` 成为 tools/call 的唯一咽喉（此前六个面绕过审批地板表，未来给只读名加底线会静默漏掉六个入口），披露面 9→3，工具总数 52→46。服务侧 `gateway_call` 描述吸收发现链（六个 readonly 名、search_apis → list_apis → get_api 链序、逐工具参数形状，pack 副本与 `src/tools.ts` TOOL_DEFINITIONS_LITERALS 副本字节一致），成为 tools/list 层唯一的零成本名字发现路径；`structure.test.ts` 新守卫断言描述必含全部 readonly 名与链序（eval 脚本的 +1 是声明常量，量不出描述内容，守卫才是真验证）。破坏性变更：已安装插件的 agent 需重装/重启会话才能看到新工具面；旧名调用得到 Unknown tool 报错，迁移方式是改用 `huaweicloud_gateway_call` 携 `tool: search_apis` 等网关名。`huawei-openapi` 技能 Discovery Chain 重写为 gateway_call 形态（保留全部 10 个词汇表名与 params 契约行，教学守卫继续钉住），capability-discovery 第 4 步同步改写。`scripts/eval-generic-face.mjs` 改写为单面度量（原通用对一等的比较前提随删除消失，原脚本直调已删名必然崩溃；+1 上界仪器保留）。参数校验路径变化：发现工具的非法参数从 devkit zod 英文错误（零 spawn）变为网关 pydantic 错误（花一次 spawn），与四个 routed 工具的委托哲学一致。`gatewayInt` 死常量随 schema 一并删除；README 双语、AGENTS.md、tool-schemas.ts 注释计数全部同步（52→46、41→35、9→3）
- refactor(packs): open-mcp 授权全面委托网关 policy engine（spec: `docs/open-mcp-approval-delegation-design.md`，三模型对抗评审 + 探针实测定案）——token 仪式从 gateway 面退役：once-grant 桥全套（bridgeLocks/bridgeExecuteApi/forwardWithOnceGrant 的锁与即焚计数）、mint/echo/consume/args-match 仪式、devkit 模式 pre-spend 守卫（identity/matchingDenyRule/sameLineRuleExists）、boundArgs 规范化、sidecar surface cache 集群（gatewaySurface/fetchGatewaySurface/refreshSurfaceOnUnknownTool）、`src/lib/policy-grammar.ts` 及 lockstep 语料全部删除；`HUAWEICLOUD_OPENMCP_APPROVAL` 退役为 fail-fast 迁移指引（设值即报错指向 operator policy 文件，DEVKIT_PACKS 未知 id 先例）；`classify` 坍缩为 `{deny, forward}` 地板表。保留地板补两条形状规则：F1 拼写严格（action/scope 原值必须等于 trim+lowercase，接替被删的规范化——round-5 实测 verbatim `' ONCE '` 授权永不即焚，该实测为 pre-a4 构建，2026-10-11 复测 v0.2.0a4 在 add 即拒非规范 scope（未知 scope 回显原拼写），地板独立于网关侧校验保持 fail-closed）、F2 ttl_seconds 拒绝（探针实测网关仅 temporary 接受 ttl，ephemeral 拼写下可拉长授权寿命）。探针实测（真实网关 v0.2.0a4，2026-10-10）：空 policy 文件下 execute_api 默认拒绝且拒绝 reason 自带同意教学（对话确认 → manage_policy 授予，api/api_session/product/readonly 预设、line 支持数组批量）；permanent add 网关直接接受并写入 operator policy 文件（devkit 永久地板是唯一屏障）；data tools 网关侧完全无 policy 门（地板即全部门）；秘密名 API 带 allow 规则越过 policy 层（devkit 秘密地板是唯一屏障）。接受风险记录于 docs/safety-model.md：manage_policy 的 overlay 遮蔽与跨层 remove、保护树与凭证模式外的本机读写、坏 policy 文件网关侧静默惰性。净删约千行（委托重构波至 6ba0f6c：14 文件 +675/-1655；文档对齐与检视修正波另计）；open-mcp 测试 58→45 全绿（检视修正波另 +1），新增地板矩阵九行、首调委托、零 spawn 地板拒绝、退役守卫、裁剪姿态反转（operator policy 文件为控制面）、schema 形状（approvalToken/approvedByUser 缺席）断言；SKILL.md 教学重写为委托同意流（拒绝 reason 即指引）。CLI 面 plan-run token 契约不动。检视修正波：退役守卫测试由死断言转为活断言（assert.throws 携设值 env，路径缺席即红）、remove 地板补 ttl_seconds 拒绝（与 add 分支对称）、fake 夹具按删除清单清扫死旋钮并改精确字符串语义（scope 词表校验、非规范拼写 add 即拒、仅规范 'once' 即焚）、新增文件层控制面测试（operator policy 文件规则授权 + 跨层 remove 回写文件，AR1 钉为具体行为）、approvals.json 路径与修剪时点的文档修正。第二三轮对抗评审修正波：夹具 once 即焚改按命中索引移除（回归测试改三规则中位执行，splice(-1)/splice(0)/indexOf 副本三种错误形状各失败一条断言，突变验证逐形确认）；夹具 remove 补 ttl_seconds 拒绝；list 改 overlay 先于文件层、add/remove 成功信封回显 policy 原文（回归钉顺序与回显：rules[0] 为 overlay 规则、注释行随 add 回显、跨层移除后规则自 policy 文本缺席）；execute_api 拒绝 reason 补齐探针实测的同意教学长尾（api/api_session/product/readonly 预设）并钉住两条尾专属子串；F1 拼写地板语义在全部存活表面按 v0.2.0a4 重述（夹具与测试注释的 pre-a4 '永不即焚授权' 叙述清扫）；探针引用从已删除的临时报告改指仓库内可重跑的 scripts/probe-openmcp-gateway.mjs（自打印经 shebang 解释器解析出的网关版本）
- fix(deps): 第十一轮检视锁修复的三项深化——rename 仲裁改自验证（评审活体复现：停顿 contender 的 rename 落在赢方 mkdir 之后对活锁成功，291ms 双持有静默退出——裸 rename 只收窄未关闭，6/6 绿与三倍收窄的概率相容。现 rename 成功后从 stash 内重读 pid，非同死者即被窃的活锁，rename 回去等待；新增停顿注入测试确定性复现该交错并断言不双持有）；releaseLock 同型 TOCTOU 修复（read-then-rmSync 的释放路径与接管路径同病——楔死持有者在接管后释放可删新持有者的锁，现释放同样走 rename-验证-删，stash pid 非本进程即还原）；stash 清扫（rename 与 rm 间崩溃泄漏 `*.takeover`/`*.release` 目录，acquire 入口 best-effort 清扫回收）。设计块与测试头的两处谎言注释改真（"机制未解释"与"结构性消除竞态类"均已过时——如实陈述缩窄历史与自验证原语）
- fix(packs): 第十一轮检视 lockstep 契约的三项强化——fixture 的 `semanticKeyOf` 升级为与 lib 同前缀的完整 kind 键（`empty:/unparseable:/server:` 加 rule 形态），lockstep 断言从等价类比较改为逐行键相等（评审实证：类比较对"lib 解析为 rule 而 fixture 返回 null"的单例分歧失明，server 行漂移全对通过）；语料补六形态（多等号钉 rpartition、api 内冒号钉首冒号分割、空 product、大写 SERVER 前缀钉大小写敏感、前导空格）加 matcher 表补 round-8 bug 形态（未终止类、类内反斜杠、首 `]`/`^` 字面）；execute 匹配路由进共享语义面（旧 inline 副本效果失明——deny 行可授权 execute——且无 per-side trim；`matchingRule` 改 first-match-wins 返回 grants 判定，`parseKey` 副本删除改用 semanticKeyOf 前缀判定；新增 deny 行拒绝加 spaced 行授权的网关语义钉）
- refactor(packs): 网关策略语法核心抽至 `src/lib/policy-grammar.ts`（parseRuleLine 判别式解析、fnmatchRegex 类翻译、productMatches 精确或 `*`、sideMatches、ruleSemanticKey——approval.ts 改导入加 re-export，pack-boundaries 守卫通过，零依赖 lib 模块），fixture 的 .mjs 镜像获得可执行的 lockstep 契约：`FAKE_GRAMMAR_ONLY=1` 环境下 fixture 只导出语法面不启动 stdio 服务，structure.test 以共享语料（18 行含空格/大小写/fnmatch 否定类/行内注释/脱敏形态）驱动两侧实现，断言语义键等价类与匹配器接受/拒绝逐对一致——镜像漂移即红，"verbatim copy" 从注释声明变为断言（七至十轮检视反复点名的第四五份副本收口）
- fix(deps): dep-receipts 锁的接管移除改为原子仲裁，四轮全量反复出现的 flake 根治——两个 contender 对同一死锁同时通过复读校验后，`rmSync` 是可竞态的：较慢的 rm 删掉较快方的新锁（rmSync 从不校验内容），双双持有临界区，tmpfs 与负载下约 30% 复现而隔离 ext4 干净，机制此前未解释。修复：死锁目录先 `renameSync` 到每进程唯一路径再清理——rename 原子且输方 EEXIST/ENOENT 失败回退等待，赢方下一次 mkdir 独占获得。修复后干净树 6/6 全绿、与重型安装测试并发跑全绿、消费方（dep-provision/doctor）回归零败
- fix(packs): 批三第一刀实现检视（第十轮 interrogator）六项修复——教学守卫反转为非循环方向（原正则手工枚举 10 名字再查表内——手写清单查手写清单，且 `_` 是词字符使 `\b` 失配 `huaweicloud_search_apis` 内部，实测四个发现名从未被检查、拼错名直接通过——现正向断言词表每名必被教授（裸或带前缀）加反向清扫（snake_case token 剥可选前缀后须在词表或 devkit 工具定义内））；params 哨兵 `[^.]` 改词边界（句尾与点后可逃逸实证）；params 行限定 `For execute_api`（发现工具参数是顶层命名的，harness 自己就顶层调 search_apis——无限定行误导 search 调用）；跨引用解析器泛化（`(?:[Ss]ee|load)` 遍历全部 skills 树——本 commit 加的 capability-discovery 引用用小写 `see` 恰好躲开原守卫，实证）；format 环结构闭合（renderGenerated 直接产出 prettier 沉降形态——原裸插入产物 format:check 拒收，每次 sync 不带 format 精确重演批三的 51 文件 CI 红；stripMarkerLine 双向容忍既有测试证明安全；渲染形态进 packs-sync.test 断言；validate 串接 sync --check）；评测 harness 五合一修正（discovery 改声明式字段并建模为每会话一次——原按 task.id 字符串耦合且逐任务列表使会话总数虚报 2 实为 1；`huaweicloud_gateway_call` 的工具描述本身列全四个路由名、读 tools/list 是每个 agent 的必经之路，+1 只界定既不读 skill 也不读描述的 agent 上界，输出如实框定两条零成本路径；generic-read 的 first-class 列改直调 curated 工具；Windows 路径 fileURLToPath；ms 列标注 warm 与顺序偏差，调用数为决策指标）。修正后实测：读任务零开销、首个状态改变任务 +1 后续复用 +0、会话 discovery 计数 1、行内合计等于会话总数
- fix(packs): 批三第一刀实现检视（第九轮 interrogate）九项修复——`huawei-openapi` skill 的 params 陷阱行改教真实嵌套（网关 docstring 契约：路径/query 平铺进 `toolArgs.params`、body 在 `toolArgs.params.body`——平铺顶层的散键被网关静默吞掉，探针实证 `limit: 1` 平铺被忽略照常执行，必填路径参数迟到失败发生在 token 已烧之后）；permanent 教学恢复 operator 框定（"an operator gesture, not an agent action — ask the operator"，拒绝信封的措辞，skill 不再读成绕自家审批面的 how-to）；死端 cross-reference 修复（`huawei-cli-and-auth` 缺前缀改名、safety 引用删除因其不含 token 模型）加 `version: 1`；意图路由补 openapi 行（serviceCatalog 此前无行，三个 start-here 面都不感知该 skill），capability-discovery 把 API 契约意图先送目录工具再 web 兜底；评测 harness 记账修正（Mode B 的 steps 死条件让 token 往返只记在 A 侧，实测 +2 而文档记 +1——现两侧同计 token 往返，差值只剩名字发现调用 +1；读任务产出实测行而非跳过断言；缺网关二进制硬失败退出 1，缺席不再产出伪绿表格；unskilled-agent 框定在输出中点名，加载 skill 的 agent 零开销）；structure.test 新守卫把教学面机械化钉住（skill 提到的网关工具名必须存在于 GATEWAY_TOOL_VOCABULARY、params 契约断言进 skill 文本、cross-reference 必须解析到真实 skill——错误的 params 行正是从这个守卫缺位溜过），漂移门测试改迭代表；`npm run format` 修复批三 sync 漏跑 format 留下的 51 文件 CI 红（AGENTS.md 提交规则的两条跳过各自产出真实缺陷：守卫缺位放过错误教学、format 缺位破了 CI 绿基线）
- feat(packs): open-mcp 教学层与词表单表化（批三第一刀）——新 service skill `huawei-openapi`（open-mcp pack 首个 skill，源在 pack skills/ 树经 sync-skills 生成进运行树）：四步发现链（search_apis → list_apis → get_api → get_api_examples）对应 CLI 发现链的 MCP 形态、泛型调用面的同意流教学（只读直通 / token 往返 / 三类硬拒及理由信封自解释）、两种审批模式的语义翻译（native 的 scope 标签按进程级如实披露）、五条陷阱表（region 缺省 cn-north-4、project_id 路径、params 平铺 body 入 `toolArgs.body`、x-constraint 前置条件、data 工具非只读）；`huaweicloud-api-and-sdk` 增 cross-reference 双向非死端；`huaweicloud-open-mcp/pack.ts` 声明 skill 归属（skills 数组从空到一，pack-info 披露生效）。词表收敛：`GATEWAY_TOOL_VOCABULARY` 单表（readonly + routed 两组）成为网关工具名的唯一枚举，classify 的 READONLY 集与 tools.ts 的 KNOWN_GATEWAY_TOOLS 投影全部从它派生——加一个网关工具从改三处清单变为改一行表项加一条 classify 行（七/八轮检视的 Consider 收口）。新增 `scripts/eval-generic-face.mjs`：泛型面对一等工具下界的对照评测 harness（真实 callTool 分发加真实网关二进制，openapi,data 模式），测量每任务的调用数与耗时差——首次实测：纯读任务零开销，token 类任务每任务 +1 次发现调用（token 往返为两种面共享的同意属性不计入差值），动态注册（Layer 3）按设计裁决维持 deferred 直至 agent 级评测示显著
- fix(packs): open-mcp 批二实现检视（第八轮 interrogate）六项修复——fnmatch 类翻译补否定语义（`[!A]` 此前直通为 JS 正向类，Python 对照双向皆错实证：网关拒绝对预检隐形、overlay allow 穿透文件 deny 完成逃逸；`[^a]` 反向过拒；类内 `\` 直通产生未终止 JS 类使 `new RegExp` 抛出且调用处无守卫——现按 `fnmatch.translate` 规则翻译（`[!`→`[^`、类首 `]`/`^` 字面、`\` 转义、未终止 `[` 字面），整体包 try/catch 字面兜底）；`parseRuleLine` 改判别式结果（`rule|server|unparseable|null`），无效 action 不再折叠为共享通配哨兵——`ruleSemanticKey` 对 unparseable 行映射 `unparseable:<lowered line>` 每行唯一（此前所有被脱敏弄乱的行共享一个 key，不同 token 后缀规则互相假冲突且补救死循环，端到端实证：文件里 `IAM:CreateAccessKey=allow` 让 `IAM:DeleteAccessKey` 的批准执行被拒、remove 返回未命中）；解析忠实化（`python3` 直跑安装模块实证：行内 `#` 注释与无冒号非 `*` 目标网关侧均 `RAISE`——现仅剥整行注释、无冒号非 `*` 判 unparseable；identity 校验集加 `#` 使授权行在自家解析器下恒可解析）；remove 加 scope 在 classify 即拒（网关 `manage_policy_ops` 对带 scope 的 remove 直接拒绝，token 门后的转发必然烧批准——实测源码对照）；`matchingDenyRule` 返回判别式 `{line, unparseable}`，坏行消息如实报"网关自身无法载入该行"而非伪装操作者 deny；产品侧匹配改精确或 `*`（网关 `evaluate` 仅 api 走 fnmatch，产品侧精确小写等值——比 fnmatch 更忠实）；canonicalize 数组分支入递归路径集（自引用数组此前绕过 seen-set 无限递归 RangeError，违反模块自身"只哈希不拒绝"契约）。fake 全面对齐：fnmatch 翻译逐字复制 `approval.ts`（注释交叉引用，.mjs 无法 import .ts）、add/remove 镜像网关解析拒绝与信封（未命中/格式非法 ok:false、scoped remove 拒绝）、`FAKE_POLICY_TEXT_ONLY` 旋钮（数组减为 overlay-only 使文件层测试真正钉住 policy 文本分支——真网关两层都报，旋钮是显式分支覆盖仪器）；文件层测试补 mkdir 修顺序依赖；三处错误的双层模型注释改为真模型（`list_rules` 数组含文件规则 scope permanent 加 policy 文本含原文）。真实网关探针 6/6：否定类两方向、坏行消息、交叉冲突关闭同冲突保留、remove+scope 分类即拒
- fix(packs): open-mcp 批二实现检视（第七轮 interrogate）五项修复加一项探针发现——网关语义忠实化：新增共享行解析器 `parseRuleLine`（镜像网关 `parse_policy`/`_rule_key` 源码语义：剥整行注释、trim、rpartition `=`、action 归一、target 冒号分割、两侧 strip-or-`*`），`sameLineRuleExists` 从字面比较改为语义键比较（实测网关 remove 按语义键首匹配——空格/大小写变体的操作者规则此前绕过冲突预检而桥的清理仍会删它），同时读 list 的两层暴露（结构化 `rules` 数组与 `policy` 文本字段——探针实测真实网关文件层规则只出现在后者，仅读数组整个文件层漏检），返回三态 `no-conflict|conflict|listing-failed:<reason>`（listing 失败不再伪装成 "already exists" 把 agent 引向删除不存在的规则）；`sideMatches` 升级 fnmatch 语义（网关用 `fnmatch.fnmatch`，`?` 与 `[...]` 是元字符——操作者 `ECS:Create?ervers=deny` 此前对预检不可见而网关执行它，`?`→`.`、字符类直译）；action 与 scope 同入 mint 规范化绑定（classify 归一 action 但 token 绑原始拼写转发原始，`'ADD'` 过门即烧 token 于网关拒收——boundArgs 现同归一两者，fake 回显 `received` 原始值断言非环形）；`redactString` AK/SK 加词边界（`task:`/`risk:`/`disk:` 的值被吃实证）加 `isSecretKeyName` 补 `input_value`（对象走查与字符串走查口径一致化）；canonicalize seen-set 改递归路径集（DAG 别名引用此前折叠为 null 造成哈希碰撞——`{a:X,b:X}` 与 `{a:X,b:null}` 同哈希，现路径进出删除，仅真环折叠，MCP JSON 无别名仅直连可触发）。fake 的 remove 语义化镜像网关跨层序（overlay 先文件后）加文件层支持（`FAKE_POLICY_FILE`/argv `--policy`），list 双层暴露，execute 评估 overlay 加文件并集。真实网关探针 5/5：空格操作者行语义冲突（拒绝→清文件→同 token 桥接 status=200）、fnmatch `?` deny 预检执行、`ADD`/`Once` 规范落地、未执行授权正确留存。行内注释澄清：网关只认整行注释，devkit 剥行内注释是故意的过度拒绝方向
- fix(packs): open-mcp 批二实现检视（第六轮 interrogate）五项修复——`sameLineRuleExists` 双侧过同一脱敏通道（list 结果经 `redactString` 后 `IAM:CreateToken=allow` 以 `…=<redacted>` 形态到达比较，单侧原始比较对整个 IAM token/password 类静默失效，端到端实证危害链：冲突漏检 → 桥旁跑 → execute 匹配既有规则不焚 → finally 删错授权留自己的——现本地行与返回行互经 `redactSecrets` 配对比较任一方向命中，listing 失败按冲突 fail-closed 拒绝）；manage_policy 动作词表白名单化（`'ADD'`/`' add '`/`['add']`/`append` 此前落入 token 放行，scope 门因此依赖网关拼写更严——现 trim+小写归一后仅 `list/add/remove` 进分支，未知动作与非字符串 deny）；`redactString` 授权头家族值捕获扩至行尾（`Authorization: Bearer <jwt>` 只红 `Bearer` 凭证本体过界，实证）加 AK/SK 引号键变体；路径扫描候选加反折叠变体（值本身是 JSON 字符串时分隔符在内存中翻倍，`read_json('{"path":"C:\\\\hcloud\\\\config"}')` 绕过单分隔符模式，实证——`replace(/\\\\/g,'\\')` 变体同时送检）；replay 侧同样先规范化 scope 再哈希再转发（mint 绑规范值而 replay 哈希原始拼写的单侧规范化让 note 教的"重发原始参数"必然失配烧 token——现两侧同为规范值，`' ONCE '` mint `'Once'` replay 直接成功，note 同步更新）。附一并项：canonicalize 加 seen-set（循环输入过 classify 后在 mint 层爆栈的不变量补全）、删引号字面量提取死重（整值候选是其超集，子串模式判定被整值包含，A 实证删除不改变任何判定）。fake 无改动需求。真实网关探针 9/9：token 后缀行经脱敏边界仍见冲突（拒绝 → 移除 → 同 token 过冲突门）、未知动作 deny、任一拼写 replay 成功、JSON 嵌套翻倍分隔符 deny、未执行授权正确留存
- fix(packs): open-mcp 批二实现检视（第五轮 interrogate）五项修复加一项探针发现——`canonicalize` 改 null 原型目标构造（`sorted['__proto__']=v` 在普通对象上触发原型 setter，键从自有属性与哈希中静默消失，批准形态与走私 `__proto__` 的重放哈希相同，实测复现；两 face 共享修复）；`redactString` 增引号键变体（`"adminPass":"..."` JSON 形态与 pydantic `input_value=` 回显形态此前漏网）加 `input_value` 键，isError 文本先 JSON.parse 成功则走对象脱敏（键名遍历强于任何字符串模式）；manage_policy 的 scope 规范化绑定（classify 判 `ONCE` 过门但转发原样拼写，网关存储后即焚语义永不匹配，实测 `' ONCE '` 授权执行一次后仍存活——现 mint 前重写 toolArgs.scope 为规范值，token 绑定规范化形态，原拼写重放自然失配），非字符串 scope 一律 deny（`['once']` 字符串化骗不过）；桥前同行冲突预检（`manage_policy remove` 按行首匹配，同行既有授权时桥的 finally 会删掉它留下自己的——现 `sameLineRuleExists` 经实时 list 检查，冲突即拒绝且不烧 token，教学错误指引先移除冲突规则；探针实测真实网关 list 返回结构化 `{line,scope}` 对象数组，bare-string 比较静默失效，已兼容双形态并让 fake 对齐真实 list 形状）；数据工具路径扫描重写（原始值递归遍历取代 JSON.stringify——序列化反斜杠翻倍使 Windows 无点路径 `C:\hcloud\config` 绕过凭证模式，实测；整值加引号内字面量须含路径分隔符才算路径形态，`.hcloud` 的纯文字提及不再误拒；seen-set 使循环结构终止而非抛错，classify 只裁决不 reject）。fake 增 attempt 计数器（双拒绝测试断言 `attempt 2` 证明重试发生、`attempt 1` 证明未知执行态不重发）与 `FAKE_BROKEN_EXECUTE`、`json_error_tool`。真实网关探针 9/9：scope 规范化绑定全链路、同行冲突拒绝加不烧 token 加清理后同 token 桥接 status=200、Windows 路径拒、无分隔符提及不误拒、零残留规则
- fix(packs): open-mcp 批二实现检视（第四轮 interrogate）七项加固——`manage_policy add` 的 scope 判定反转为规范化白名单（trim 加小写后仅 `once/session/temporary` 过 token，缺省与一切未知/持久拼写 deny；实测 `'PERMANENT'` 曾一次 token 买到永不即焚授权，remove 因网关侧忽略 scope 保持 token 绑规则原文）；`execute_api` 桥重试触发收窄到 `/safety policy/`（超时与 sidecar 死亡的执行态未知，一次批准不得重发写调用），双拒绝后 finally 按 add 次数逐条 remove 封死残留授权；isError 信封与 catch 错误消息过 `redactSecrets`（redactString 只重写凭证形状子串，拒绝原文不受影响）；漂移门从 execute_api 特例泛化为全部非只读工具的 surface 成员检查（探针曾对已藏掉的 transform_data 照样 mint 并把批准烧在 Unknown tool 上），`gateway_list_tools` 回写 surface 缓存（漂移报告即武装下一次调用的分类器）；query_data 与 transform_data 的 `out.path` 加 `tables.*.path` 全部过受保护树判定，toolArgs 序列化文本过 CLI 面凭证模式做 SQL 内 `read_csv()` 字面量的尽力而为扫描（残余：非凭证保护路径的 SQL 字面量不查，已注释）；操作者 deny 解析器剥尾注释、容忍分隔符空白、单 token 左侧按产品级 deny、歧义 effect token fail-closed；相对 `HUAWEICLOUD_MCP_POLICY_FILE`/`HUAWEICLOUD_MCP_AUDIT_FILE` 在 spawn 参数函数处直接拒绝（三处消费锚点不同，歧义形态整体拒收）；非对象 toolArgs 显式报错替代静默折空；enable 注释补 native 模式限定语。fake 网关增 `FAKE_REFUSE_EXECUTE`（桥双拒绝）与 `FAKE_FAIL_LIST_ONCE`（write-through：spawn 时列表失败缓存留空，漂移报告的成功列表成为唯一武装途径）。真实网关探针 14/14（openapi,data 混装模式：scope 白名单四种拒绝形态、tables 树拒、SQL 凭证字面量拒、桥接 status=200、零残留规则）
- feat(packs): open-mcp 通用调用面与审批机器落地（批二）——新增 `huaweicloud-open-mcp/approval.ts`：`classify(tool, toolArgs, mode, surface)` 纯决策表，三值判定 passthrough/token/deny（六个发现工具与 manage_policy list 直通；manage_policy 授予一律过 token、permanent 档两模式皆 deny 并指引手改 policy 文件；execute_api 秘密读取操作经 `classifyTextCommand` 映射 CLI 面词表硬拒、surface 缺失该工具时按漂移 deny 不烧同意、native 模式委派网关策略引擎、否则 token；transform_data 的 out.path 入受保护树 deny；query_data 与未知工具 fail-closed 走 token），`resolveApprovalMode` 调用时校验 `HUAWEICLOUD_OPENMCP_APPROVAL=devkit|native`（坏值报可行动错误而非污染 pack 无关的协议层），`matchingDenyRule` 读 LIVE policy 文件（操作者 env 优先、JSON 数组与手编纯文本双格式、`*` 通配）供桥前操作者拒绝预检。sidecar 增 `tools/list` surface 缓存（握手后填充、Unknown tool 错误即时刷新、onExit 清空、advisory 不阻塞调用）与成功载荷 `redactSecrets` 归一化边界脱敏（错误路径保持网关信封原文）
- feat(packs): 两个新静态工具上编译链（49→51）——`huaweicloud_gateway_list_tools` 返回网关子进程实时工具面与投影漂移报告；`huaweicloud_gateway_call` 以 `tool`+`toolArgs` 泛型代理任意网关工具：直通类照发，token 类首次调用返回绑定 `{tool, toolArgs}` 规范化哈希的 approvalToken 加脱敏回显（控制字段结构性排除在哈希外，重发须携原始未脱敏参数），devkit 模式 execute_api 桥 = 操作者 deny 预检（不烧 token）→ 消费 → 校验 → 每 `product:api` 尾链互斥内 铸 once 授权/转发/finally 回收，策略拒绝或子进程死亡各有一次有界重铸重试（授权丢失与并发竞态两类故障构造性闭合）。enable.ts 陈旧的"裁剪后无合法写路径"注释改写为真话：open-mcp 独立携带全部过 token 门的写路径。fake 网关增 `FAKE_POLICY`（manage_policy 内存规则、execute_api 通配匹配加 once 即焚、信封失败形态与真实网关一致）与 `FAKE_HIDE_TOOLS`（漂移降级注入）。十七项新测试经 `callTool` 真实分发面驱动：token 往返与参数失配、操作者拒绝不烧 token（拒绝移除后同 token 桥接成功证明）、漂移 deny 先于消费、桥接与即焚经 manage_policy list 断言、native 委派（返回网关策略拒绝而非 requiresApproval）、`DEVKIT_PACKS=core,huaweicloud-open-mcp` 写路径仅存在于 token 门后
- feat(packs): open-mcp 审批基座第一批落地（两轮设计检视 + 一轮实现检视修正后的形状）——新增 `src/lib/pack-state.ts`：`huaweiConfigBase(env)` 经 `resolve()` 一次绝对化，成为 devkit 配置树唯一解析器（`HUAWEICLOUD_HOME || homedir() → ~/.config/huaweicloud`，相对 HOME 不再分裂 store 与守卫的锚点；approvals.json 已改走它），`packStateDir(packId, env)` 按"写者读者集"归属判据建立 pack 级状态空间 `packs/<id>/`，`ensurePackState` 幂等供给（目录 0700 / 文件 0600、每趟 chmod 修复既有松权限、`wx` 独占创建原子且不清空并发对家的文件、失败抛 devkit 署名错误带 cause）；`isInsideProtectedTree` 是网关文件面写守卫：按"写入落地方式"解析（最深存在祖先 realpath 后拼接不存在尾部、相对路径锚定 tmpdir 父层），`..` 路径段与 win32 盘相对形态 fail-closed 直接拒绝（`path.resolve` 词法折叠 `..` 早于符号链接替换，实测 `link/../x` 可绕过词法检查落进保护树——两评审独立复现），悬空链接与不可解析根同样拒绝
- feat(packs): 网关 spawn 参数改为单一纯函数 `resolveGatewaySpawnArgs(env)`（pin-unless-env，`--log-file` 先例推广到 mode/policy），policy 文件名单一常量 `POLICY_FILE` 双点共用——`HUAWEICLOUD_MCP_MODE` 未设时钉 `--mode openapi`、已设时不传参让网关自己的 env 生效，`discover` 及未知组合在 devkit 侧即拒（外部 MCP 代理能力面未建模）；`--policy` 无条件供给（两种审批模式共用的同意基座，仅操作者设 `HUAWEICLOUD_MCP_POLICY_FILE` 时让位），供给先于 spawn；`--audit-file` 永不传参（网关 NDJSON 审计全量未脱敏参数且无轮转，缺省 NullAuditSink，操作者设 env 即显式选择加入）；子进程 cwd 为每子进程 `mkdtemp` scratch（双 MCP 进程的相对写不再碰撞；守卫锚定 tmpdir 父层，相对名只可能过度拒绝）
- fix(lib): approval token 三处加固——`hashArgs` 升级为规范化 JSON（递归排序对象键，agent 重序列化的键序漂移不再改变哈希；CLI 面 string[] 载荷逐字节不变）；`consumeApprovalToken` 前置 UUID 形状校验（伪造 token 零文件系统副作用，token 字符串不再未经消毒进入 `join()`——`..` 穿越与垃圾 marker 污染实测被封死），消费顺序重排为 读→验→claim→删（O_EXCL 独占 marker 只对真实有效 token 创建；竞态模拟测试钉住 marker 而非文件删除在拒绝重放；只读 HOME 优雅降级；过期 marker 由 mint 顺带清理）；fake 网关回显 argv/cwd/env 供 spawn 参数端到端断言。真实网关探针复验：默认 env 下参数计划 / policy 供给 / 空 policy 拒绝 / once 授权 / status=200 执行 / 即焚复拒全链路成立
- refactor(packs): 7 个 KooCLI 耦合工具从 core 下沉至 `huaweicloud-cli` 包——`huaweicloud_check_cli` / `plan_cli_command` / `run_readonly_command` / `list_operations` / `run_approved_command` / `show_profile_redacted` / `list_regions` 迁入 `src/packs/huaweicloud-cli/tools.ts`（handler 逐字迁移，schema 与描述字节级不变，registry-snapshot-diff 与 structure.test lockstep 门继续钉住）；core 回归通用面（安全 / 发现 / 元工具），工具数 17→10，`huaweicloud-cli` 0→7 成为知识+工具混合包，包工具并集 31→38，总工具数 48 不变。同意层已先行抽至 `src/lib/approval-tokens.ts`（commit 2134bc5），新包面直连该 lib 而非 hcloud-cli.ts 再导出垫片。裁剪语义 fail-closed：`DEVKIT_PACKS` 裁掉 `huaweicloud-cli` 时 CLI 执行面与审批工具（全库唯一 allowWrites:true 调用点）一并移除，被裁配置不存在合法写路径；core 强制包含的理由收窄为披露（list_packs / pack_info 不可被裁掉隐藏被禁内容）。PreToolUse hook 层不变，照旧拒绝裸 Bash 写操作（从不读取包状态）
- feat(packs): open-mcp 网关安装路径对齐上游——解析链 `~/.local/bin` → PATH（pip / pipx / uv tool install）→ `uvx huaweicloud-open-mcp` 兜底（零持久安装；uvx 首次冷启动拉取包可能超过握手超时，下次调用对热缓存自动重试）；找不到网关的错误指引改为 pip / uvx 优先；spawn 补 `windowsHide` 与 Windows `.exe` 候选后缀；解析函数按 `resolveEnabledPacks(env)` 先例接受 env 参数并可测
- fix(packs): open-mcp sidecar 对抗审查加固——子进程死亡窗口内的调用不再以未处理 EPIPE 击穿整个 server（stdin error 监听接入 onExit + request/notify alive 守卫，附竞态回归测试）；握手失败即杀子进程（SIGTERM→SIGKILL），孤儿 exit 不再误清健康单例（currentSidecar 身份比对）；spawn 显式 `--log-file` 指向 tmpdir（网关默认相对路径会在继承的 cwd——用户项目目录——创建 `logs/`，只读 cwd 下启动即死）；`limit`/`offset` schema 改非 nullable（网关 pydantic int 拒绝 null，实测）；网关信封失败 `reason` 映射为仓库标准 `error` 键（保留 reason）；归一化四分支补全覆盖（fake 网关新增 structuredContent/isError/信封失败/纯文本模式与握手失败开关）；六条工具描述纳入 structure.test lockstep 守卫（spread 断言泛化连字符 id→下划线导出名）。真实网关探针复验：日志落 tmpdir、cwd 零污染、失败归一在真实线协议上成立
- feat(packs): 新增 `huaweicloud-open-mcp` 能力包——经本地 huaweicloud-open-mcp 网关代理华为云全量 OpenAPI 目录发现（`huaweicloud_search_apis` / `list_products` / `get_product` / `list_apis` / `get_api` / `get_api_examples`，共 6 个只读工具）。Python sidecar 为进程级单例（`src/packs/huaweicloud-open-mcp/sidecar.ts`，手写换行 JSON-RPC，不依赖 MCP SDK），首次调用懒启动，生命周期绑定父进程 stdin 管道；remote 传输每请求构造/关闭 server 不影响单例；`DEVKIT_PACKS` 裁剪该包时零注册零 spawn；`OPENMCP_BIN` 可覆盖二进制解析，doctor 经 `PACK_BINARIES` 探测网关存在性。工具总数 42→48。API 执行（execute_api + 审批桥）为后续阶段
- docs(sandbox): huawei-sandbox 标注跨 pack 工具依赖的降级路径——`huaweicloud_detect_framework`（discovery pack）与 `huaweicloud_setup_obs_config`（obs pack）在 `DEVKIT_PACKS` 裁剪对应 pack 时给出可操作指引（询问开发者/改用手工配置），而非裸调未注册工具
- refactor(packs): pack id `services` 更名为 `huaweicloud-cli`(按执行面命名)。破坏性变更:`DEVKIT_PACKS` 持旧值的配置启动即失败并列出合法 id,改用新 id 或重跑安装器 `--packs all` 恢复(codex 目标由 codex CLI 托管需手改;DSH 吞启动错误,以 doctor 为发现途径);`sync-skills --check` 新增生成头路径校验,目录改名后漏跑 `skills:sync` 将直接失败
- feat(sandbox): devbridge 认证改为运行时能力探测——`0.2.2-release` 存在两个构建（镜像版保留 AK/SK 登录 + env 自动读取；发布版仅支持 API Key），暴露流程按 `auth login --help` 探测结果自动分支：镜像版直接使用注入的 AK/SK（零介入），发布版走 API Key 引导；`.codeartsdoer` sidecopy 同步，守护测试覆盖双分支

## 1.1.6-next.1 (2026-09-22)

- feat(sandbox): migrate DevBridge flow to 0.2.x (s2 gateway + API Key auth) (#793)
- fix(sandbox): proxy deploys no longer emit misleading port warnings
- docs(deployment): correct ShowAppDetailById param and annotate deprecated ops
- fix(sandbox): remediation cautions against stale port after drift
- style: apply prettier
- docs(sandbox): document devbridge host vs connect, description traps, and port drift
- docs(deployment): fix KooCLI service/operation names verified against hcloud --help
- fix(setup): doctor success message no longer demands a restart
- feat(sandbox): deploy_check returns executable remediation for expose_via_devbridge
- fix(sandbox): warn when port drift detaches an active DevBridge tunnel
- fix(sandbox): deploy_check no longer reports malformed publicUrl without tunnel
- fix(sandbox): port conflict warning reports real auto-assigned port
- fix(setup): workbuddy uninstall crash + honest uninstall skill counts (#556)
- fix(mcp): address #717 review — target allowlist, -32600, newline test
- fix(mcp): survive malformed JSON frames (-32700) and Windows npm EINVAL (#643)
- test(setup): make OfficeAce auto-detect hermetic in install tests (#654)
- fix(mcp): return -32602 for tools/call missing required params or unknown tool (#704)

## Unreleased

- feat(sandbox): `huaweicloud_sandbox_credentials` 新增 `api_key` 参数（或本地 `HW_API_KEY` 透传），注入沙箱供 devbridge 0.2.x 使用
- fix(sandbox): deploy_check/deploy_nginx 适配 DevBridge 0.2.x——网关迁移后隧道 URL 改用 `devbridge-s2.hwtunnel.com` 域名构造；「服务已迁移」占位页（HTTP 200）判为 FAIL，修复假 200 误判 complete
- fix(sandbox): 隧道探测版本感知——0.1.x 用 `list -j` JSON，0.2.x（已移除 `-j`）解析纯文本表格数据行的 8 位 base32 tunnelId
- docs(sandbox): SKILL.md 暴露流程重写——API Key 登录引导（获取入口/交付方式/失败路径/安全提示）、存量沙箱 0.1.x→0.2.x 原地单版本升级（官方 installer，GitCode 渠道优先 + GitHub 兜底 + `--http1.1` 规避 HTTP2 framing）、残留 `/usr/local/bin/devbridge` 清理、新域名格式说明
- test: 新增 devbridge s2 域名迁移/API Key 认证/版本升级守护测试；改写 `list -j` 断言为版本感知表述
- fix(sandbox): 审查加固——API Key（长期账号级凭据）与临时 AK/SK 分离存储（`/tmp/hw_api_key`，0600）；`api_key` 优先级改为本地 `HW_API_KEY` 环境变量优先；修复 PATH 追加写法导致旧镜像二进制抢占解析的问题（改为前置 + 显式比对清理残留）

## 1.1.6-next.0 (2026-09-16)

- chore: sync README beta badge to 1.1.6
- chore: set version-override to 1.1.6 (next -> 1.1.6-next.0)
- fix(hook): risk engine fails closed on malformed input (#564)
- fix(officeace): align runtime skill root env probe with installer (#559)
- fix(setup): make OfficeAce install/uninstall/register integrity reliable (#559)
- fix(mcp): resolve plugin version from plugin manifest in Codex cache layout (#576)
- feat(sandbox): add mandatory target-selection gate before sandbox lifecycle tools (#691)
- fix(safety+mcp): close env-dump and shell-wrap bypasses, JSON-RPC -32601 (#650) (#688)
- fix(mcp): actionable explain_error fallback guidance (#648)
- fix(proxy): skip TLS cert verify only for proxy connections (#667)
- fix(safety): classify Apply* operations as write (#644)
- feat(auth): onboarding guidance for credential setup (scenarios 1-4) (#665)
- test: fix Windows path compat in upgrade-session test (split('/') → path.basename)
- fix(#614/#607): review 两点 — 保留 failedAt 节流 + doQuery 注入口补真覆盖
- fix(#614/#607): dismiss + 查询失败路径 — 不写伪冷却、返回 check_failed

## 1.1.4-next.6 (2026-09-14)

- fix(setup): preserve user MCP config fields across install/update/uninstall (#615) (#661)

## 1.1.4-next.5 (2026-09-14)

- fix(#614/#607): dismiss + 查询失败路径 — 不写伪冷却、返回 check_failed (#659)
- feat(obs): add huaweicloud_obs_set_website_config MCP tool

## 1.1.4-next.4 (2026-09-14)

- fix(auth): treat placeholder/masked credentials as not configured (R11, #570) (#655)

## 1.1.4-next.3 (2026-09-12)

- fix(#606/#614): MCP 升级提示+dismiss 按会话隔离；remote 透传 session；pre线策略文档补全 (#646)

## 1.1.4-next.2 (2026-09-12)

- fix(koocli): stop injecting --cli-lang; detect and guide global switch (#633)

## 1.1.4-next.1 (2026-09-11)

- fix(auth): clear import file on unfixable reject and after confirm success (#502)
- fix(auth): validate region before persist and keep import file for replay (#502)

## 1.1.4-next.0 (2026-09-11)

- fix(koocli): auto-inject --cli-lang=cn for services missing from the English catalog (#627)
- docs(sandbox): replace ~8h empirical validity with expiresAt API reference
- fix(redact): mask opaque blob keys (user_data/metadata/private_key) entirely (#578)
- fix(approval): persist approval tokens to disk (hashed, cross-process) for plan->run (#578)
- fix(voucher): propagate credential errors instead of swallowing into generic message (#623)
- test(codex): assert JSON-based status detection, drop legacy-name recognition
- fix(codex): parse plugin list JSON instead of substring-matching status path
- refactor(codex): drop dead 'huaweicloud-core' fallback in codexStatus
- fix(sandbox): robust deploy_check output parsing for terminal artifacts
- chore(release): 1.1.3-next.4 (#617)
- fix: 受限网络下升级检测静默失败——checkForUpdate 改 fetch registry + 15s 超时 + DEBUG 日志 (#612) (#613)
- ci: trigger CI on push to dev (#501) (#605)
- chore(release): 1.1.3-next.3
- fix(safety): cover Nova*/Reset* destructive ops in hook risk rules (#501) (#594)
- fix(auth): resolve KooCLI config from homedir, not HUAWEICLOUD_HOME (#501) (#595)
- docs(iac): remove deposit (保证金) guidance - vouchers no longer require a deposit
- chore(docs): remove committed superpowers plan doc (already gitignored) (#501) (#599)
- fix(hermes): respect homedir() on Windows instead of LOCALAPPDATA
- fix(deps): override smol-toml to 1.8.0 to clear npm audit high vuln (#501)
- test: add E2E MCP tool invocation and schema validation tests
- chore(release): 1.1.3-next.2
- feat(install): interactive zero-detection install menu + generic MCP wiring (#592)
- chore(release): 1.1.3-next.1
- style: prettier-align credential priority tables in README (#520)
- fix(auth): skip S2 fingerprint drift when KooCLI authEncrypt stores ciphertext (#533)
- chore(release): 1.1.3-next.0 (#589)
- docs: align README credential docs with SKILL.md - priority, auth_switch, env security warning (#520)
- fix(mcp): allow maxRetries 0 in numeric arg validation (#530)
- fix(mcp): reject invalid numeric args (timeoutMs/maxRetries) instead of silently ignoring (#530)
- docs: replace static beta version badge with npm version badge (#530)
- docs(obs): mb return-code trap and website endpoint propagation delay (#485)
- chore: set version-override to 1.1.3 (next -> 1.1.3-next.0) (#588)
- chore(release): 1.1.2-next.8
- feat(rev4): send X-HW-Client-Version; SKILL wording; remove unreachable cmdUpdate reinstall (#586)
- test(update-check): decouple upgrade-tag logic from repo package.json version
- chore(release): 1.1.2-next.7
- fix(skills): correct cli-domain-id root cause — it signals invalid credentials, not a missing domain-id (#574)
- chore(release): 1.1.2-next.6
- style: prettier table alignment (#574)
- docs(voucher): drop in-flow domain-id discovery detail from test-env note (#574)
- fix(skills): teach agents to self-discover cli-domain-id via STS GetCallerIdentity (#574)
- feat(setup): unix auto-install, hermes restart hint, grouped status; docs: sandbox_credentials example (#265, #280)
- feat(telemetry): classify cursor-vscode and officeace-agent MCP client names
- docs(iac): verified traps from 2026-09-08 e2e report - keypair/RDS/DCS/EIP-quota/long-args/destroy-alignment
- chore(release): 1.1.2-next.5
- fix: clarify devkit version output
- docs(sandbox): index.html platform-overwrite symptom, recovery, and prevention (#263)
- docs: note mirror-lag fallback to official registry (#518)
- feat(auth): complete non-interactive guidance and detect existing KooCLI profile in auth init (#260)
- style: add trailing newline to hook-plugin test
- chore(release): 1.1.2-next.4
- fix codex install auth probe and safety hook
- chore(release): 1.1.2-next.3 (#550)
- fix(auth): spawn hcloud without shell in project-id resolution
- feat(auth): validate credentials before sandbox injection + auto-set project_id (#259, #262)
- feat(telemetry): route telemetry upload through proxy
- feat(telemetry): classify MCP client names to canonical agent harness
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
- chore(release): 1.1.2-next.2 (#541)
- fix(release): make create-release-pr path helpers idempotent (#537)
- fix(telemetry): regenerate userHash after credential switch
- docs: remove Cursor section from README
- feat(mcp): add remote (Streamable HTTP) transport mode (#531)
- docs: clarify Cursor marketplace status (not yet listed)
- docs: document Cursor Directory support alongside other agents
- fix(telemetry): bound hcloud capture and isolate failed event retries
- docs: move Cursor Directory section below Documentation
- fix: use agent-neutral wording for KooCLI config-write failure hint
- chore(release): 1.1.2-next.1 (#528)
- fix(release): bump version override to 1.1.2 for next preview line (#527)
- feat(update): session-level version update detection & auto-upgrade (#525)
- chore: sync root plugin.json version to 1.1.1-next.16
- chore(release): 1.1.1-next.16
- chore: address Cursor marketplace PR review feedback
- fix(skills): deposit prompt cites official FAQ links (frozen deposit explanation + amount rules)
- style: prettier re-align huawei-iac stage-5 table
- fix(skills): deposit prompt includes recharge portal link (balanceRecharge)
- fix(skills): deposit prompt includes amount range (约 1~5 元人民币不等)
- style: add trailing newline to plugin.json and mcp.json
- chore: add Open Plugins manifest for Cursor marketplace
- chore(skills): bootstrap Node template bumped to v22.14.0 LTS
- fix(skills): bootstrap Node template must match instance arch (arm64 vs x64)
- fix(safety+skills): web-port rule false-positive, China mirrors, keypair import flow, E2E report findings
- fix(skills): huawei-iac stage order - inspect code before offering options; scale and hosting are separate questions
- fix(skills): huawei-iac stage-3 architecture decision points must be surfaced
- fix: repair Python hook indentation and update stale DSH/telemetry tests
- fix(telemetry): unref flush interval so tests don't hang the process
- fix(workbuddy): remove hooks field from plugin manifest to pass validate
- fix: resolve eslint and prettier errors reported by PR #500 CI
- chore(release): 1.1.1-next.15
- feat(auth): 凭证一致化整改 — reconcile / R7 current档 / R9 会话优先 / R10 runtime守卫 (#498)
- chore(release): 1.1.1-next.14
- feat: detect new plugin versions on install/update
- chore(release): 1.1.1-next.13
- style: prettier re-align huawei-iac tables
- feat(uninstall): optional KooCLI/OBS cleanup on global uninstall
- fix(skills): correct zero-balance remedy order - voucher first, deposit is its prerequisite
- fix(skills): top-up is the only deposit path; vouchers offset fees but are not the deposit
- fix(skills): huawei-iac stage-5 deposit warning must be the first message at zero balance
- fix(setup-cli): verify file copies during install, retry on size mismatch
- feat: add `version` command reporting installed plugin version per agent
- fix(skills): deployment->iac routing is unconditional; existing VPC is not an exemption
- feat(skills): all deployment intents (except sandbox) route through huawei-iac
- fix(skills): huawei-ecs routes multi-resource purchases to huawei-iac
- fix(skills): huawei-iac asks scale tier when unknown instead of assuming
- fix(skills): huawei-iac consultation stages are proactive, not user-requested
- fix(skills): huawei-iac FunctionGraph verified params + zero-balance free-tier rule
- fix(skills): huawei-iac corrections from E2E round 4 (pricing API, CDN global region, ownership verification)
- feat(skills): add huawei-iac orchestration skill for multi-resource provisioning
- chore(release): 1.1.1-next.12
- fix: repair DSH bundle patch loading and MCP path resolution
- chore(release): 1.1.1-next.11
- style: wrap over-width line in validate-package.mjs
- fix: publish cordis.patch.yml referenced by dsh.bundle.patch
- chore(release): 1.1.1-next.10
- feat(telemetry): encode install dir into harness fallback for unknown agents
- chore: retry CI (#479)
- chore: retry CI (#479)
- chore: retry CI (#479)
- fix(auth): prefer auth-init creds over injected STS env creds (#479)
- fix(openclaw): match openclaw via install path and native mcp config
- fix: skip npm audit/fund when installing plugin runtime deps
- test: scope node --test to actual test files
- chore(release): 1.1.1-next.9
- fix(package): include integrations/atomcode in npm pack
- feat: add DSH post-install guidance for KooCLI and credentials setup
- feat(atomcode): add telemetry hook for Skill/CLI/MCP tracking
- fix(dsh): maintain existing state after legacy block cleanup
- fix: move createRequire after all imports, remove shebang, format
- refactor: remove better-sqlite3, auto-setup DSH via bundle patch
- feat: expand agent registry from 13 to 23 agents
- refactor: agent detection to table-driven registry pattern
- fix: add OfficeAce harness detection and version identification
- chore(release): 1.1.1-next.8
- feat: 安装提示补充由 AI 助手转达代金券的指令
- chore(release): 1.1.1-next.7
- feat: 安装完成提示首次使用可领取华为云代金券
- fix: restrict MCP keepalive to Hermes-on-Windows only, exit on stdin close for other agents
- docs(sandbox): find real build output dir across the whole project (#247)
- chore(release): 1.1.1-next.6 (#471)
- Revert "fix(ecs): change preflight SG check from hard-deny to require_user_confirmation (#468)" (#470)
- chore(release): 1.1.1-next.5 (#469)
- fix(ecs): change preflight SG check from hard-deny to require_user_confirmation (#468)
- chore: add dsh.bundle manifest for DSH plugin ecosystem
- fixE: include integrations/hermes in npm publish files
- feat(telemetry): fix harness/agentVersion detection and move telemetry hook to integrations
- chore(release): 1.1.1-next.4 (#465)
- fix(ecs): fix preflightSecurityGroupCheck regex and query parameter format (#443) (#464)
- chore(release): 1.1.1-next.3 (#463)
- feat(ecs): auto-check security group rules during plan phase (#443) (#462)
- fix: use CodeArts Work native MCP format (mcp key, command array, environment) (#461)
- fix(sandbox): add devbridge PATH to persistent session on connect
- chore(release): 1.1.1-next.2
- fix(safety): relax delete_publicip cascade rule + improve approvedCommand mismatch error
- docs: voucher_status 工具描述内嵌主动提示行为指令
- fix(detect): handle unquoted outDir in VitePress config
- fix(sandbox): clean URL support for static nginx + cross-arch build guidance
- fix: add integrations/workbuddy to npm files list
- chore(release): 1.1.1-next.1
- feat(workbuddy): integrate telemetry hook deployment into setup-cli.mjs
- docs: 强化 huawei-voucher skill 主动提示准则与话术
- fix(release): use JS filter instead of shell glob for tag lookup
- chore(release): 1.1.1-next.0
- chore: set version override to 1.1.1 for next preview release
- fix(sandbox): credential injection, nginx cleanup, and auto git clone
- fix(ecs): add security group reuse warning to Critical Warnings (#444)
- docs: add beta badge to Chinese README (#442)
- fix: include atomcode in skills root and report openclaw auth status
- docs: update beta badge version to v1.1.0 (#431)
- chore(release): 1.1.0-next.21
- fix(sandbox): auto-detect cross-platform from project files for QR check
- fix(sandbox): restrict QR auto-generation to cross-platform projects only
- docs: add beta badge to README (#428)
- fix(sandbox): always auto-generate QR code regardless of frameworkType
- chore(release): 1.1.0-next.20
- fix(sandbox): auto-generate QR code in deploy_check for cross-platform projects
- feat(cli): replace string matching with token-based plan-run approval (#421)
- chore(release): 1.1.0-next.19
- refactor(skill-tracker): remove CLI wrapper file, use single function-as-object pattern
- feat(cli): save large hcloud output to file and return path (#416)
- fix(sandbox): always run QR code check in deploy_check regardless of frameworkType
- fix(rds): correct ARM volume type from ULTRAHIGH to CLOUDSSD (#5) (#417)
- fix(safety): add STS credential exposure warning rule (#10) (#418)
- fix(safety): add rule to warn on all Delete/Detach/Remove cloud operations (#413)
- fix(auth): sync KooCLI hcloud config on auth sync (#411)
- fix(skill-tracker): prevent duplicate hook capture in IDE mode
- fix: remove UTF-8 BOM from files
- fix: remove UTF-8 BOM from files
- fix(skill-tracker): restore CLI entry wrapper file and setup-cli install logic
- style: prettier format fix
- style: prettier format fix
- chore: fix Unicode arrow encoding in skill-tracker comments
- refactor(skill-tracker): merge into single file using function-as-object pattern
- refactor(skill-tracker): unify IDE and CLI hook plugins into shared core
- feat: add HC activity ECS+Nginx deployment workflow reference doc
- feat: add HC activity ECS+Nginx deployment workflow to huawei-ecs skill
- style: prettier reformat huawei-vpc SKILL.md tables (#394)
- fix(vpc): correct subnet DNS addresses per region (#394)
- chore(release): 1.1.0-next.18
- docs(sandbox): fix source parameter value typos (#376)
- fix(sandbox): deploy_check captures all statuses + returns tunnel URL (#412)
- fix(telemetry): prevent duplicate DAU events on same-day process restart
- fix(hcloud): auto-accept privacy agreement on first use
- fix(setup): preserve user-customized MCP args and env during CodeArts register
- fix(safety): prevent false-positives in destructive-delete rule and approvedCommand
- docs(sandbox): scope GitCode SSL workaround to one-shot clone (#374)
- fix(telemetry): simplify checkDauPing to handle stamp deletion edge case
- fix: retry npm install on any failure and exit non-zero when it fails (#244)
- fix: add codex desktop skills dir to resolveSkillsRoot fallback chain (#170)
- refactor(telemetry): defer install stamp write to successful event delivery and remove trackInstall from setup CLI
- chore(release): bump version to 1.1.0-next.17 (#405)
- fix(sandbox): use valid devbridge list command (#382)
- fix(iam): correct 8 invalid CLI operations and parameters in skill (#354) (#403)
- fix(rds): correct 3 invalid CLI operations in skill (#355) (#402)
- fix(waf-aad): correct invalid AAD and WAF CLI operations in skill (#401)
- docs: add Huawei Cloud npm mirror recommendation for China users
- fix(hermes): install Python safety-hook plugin for v0.9.0 enforcement (#393)
- style: prettier formatting for hermes hook allowlist (#393)
- fix(hermes): pre-authorize safety hook in shell-hooks allowlist (#393)
- fix(smn-dms): replace hcloud DMS with Kafka/RabbitMQ/RocketMQ services (#357) (#397)
- feat(dsh): add Cordis hook plugin for telemetry interception
- test: add codearts-work E2E install tests and sync assertion (#396)
- revert(dsh): remove skill tracking from Python hook and hooks copying
- feat: add codearts-work (CodeArts Space) agent target support (#389)
- feat(telemetry): add skill retrieve tracking to Python hook
- fix(telemetry): remove duplicate ideVersion declaration
- feat(telemetry): detect DSH version from npm global package
- revert(dsh): remove endpoint env var reading from dshPatchBlock
- fix(dsh): support --hdkitservice-endpoint and --telemetry-endpoint CLI args
- chore(release): 1.1.0-next.15 (#388)
- feat(dsh): install skill-tracker.js hook for DSH agent
- feat: add codearts-work (CodeArts Space) agent target support (#387)
- fix(telemetry): use URL.pathname instead of fileURLToPath for path detection
- fix(telemetry): use file path to detect harness, remove vscode fallback
- fix(telemetry): fix harness and version detection priority
- fix(sandbox): default deploy_nginx config_name from 'app' to project name
- fix(telemetry): PLUGIN_VERSION reads undefined PLUGIN_DIR
- refactor(telemetry): move agent-specific data into agent install directories
- chore(release): 1.1.0-next.14
- fix(telemetry): fix agent_version reporting wrong IDE version
- fix(telemetry): use import.meta.url to detect agent harness in hook
- fix(telemetry): detect agent harness by env vars only, remove disk-based check
- test: update hdkitservice error message assertion to match new format
- fix: deploy_nginx auto-assign free port + SSR runtime env var injection
- fix: port conflict detection in deploy_nginx + SKILL.md docs
- fix(hdkitservice): improve credential and error diagnostics
- fix: batch fixes for deploy issues #15 #16 #5 #2 #22 #23
- fix: skill-tracker detectHarness 新增 .codeartsdoer 目录检测，解决 plugin 加载早于 MCP 导致检测为 unknown
- refactor: dau-stamp/first-use-stamp/hook-events/dev-log 全部下沉到 agent 子目录
- fix(hcloud): add runtime path discovery for hcloud binary
- fix: flushEvents 中残留的 INSTALL_STAMP 引用导致 ReferenceError，事件每 60s 重试
- fix: ensureDir 支持创建 agent 子目录，writeTextFile/touchFile 自动创建父目录
- fix(sandbox): graceful nginx restart with orphan worker recovery
- refactor: install-stamp/counter 改用 agent 子目录隔离
- refactor: install-stamp/counter 改为按 agent 隔离，支持多 agent 独立安装上报
- fix: 各 install 函数调用 trackInstall() 确保 plugin:install 事件在每次安装后触发
- fix(sandbox): move large_client_header_buffers to server level, harden port equality guard, add credential dev_stage_id fallback
- style: apply Prettier formatting
- fix(sandbox): prevent port conflicts, stale content, and header buffer errors in SSR deployments
- chore(release): 1.1.0-next.13 (#362)
- fix: scope MCP keepalive to after stdin close only (#361)
- feat: 完善 CodeArts 遥测支持 — skill/CLI 事件捕获与安装脚本同步
- chore(release): 1.1.0-next.12 (#360)
- fix(telemetry): restore writeEvent function accidentally removed in skill filter commit
- fix(telemetry): filter non-Huawei Cloud skills from skill:retrieve events
- fix(telemetry): extract DAU check to standalone function, call from 60s timer to ensure cross-day reporting when idle
- fix: correct broken CLI commands in billing/vpc/dew skills (#358)
- feat: add installCommand to search_marketplace results (#353)
- chore(release): 1.1.0-next.11 (#352)
- fix(hermes): fix uninstall order, config.yaml residue, and allowlist cleanup (#343)
- chore(release): 1.1.0-next.10 (#342)
- fix: prevent MCP server silent exit on Windows when stdin is closed (#340)
- chore(release): 1.1.0-next.9
- fix(sandbox): nginx cleanup, try_files, reload, config_name
- docs: add Codex install section to README
- fix(sandbox): git archive prefix, symlink resolve, permission hardening
- fix(sandbox): add build failure response rules to prevent silent auto-fixes
- fix(telemetry): anchor hcloud regex to command start to avoid false positives in quoted strings
- chore: add startopencode.bat to .gitignore
- chore: remove sync-opencode.ps1 from remote, add to .gitignore
- refactor(telemetry): rewrite skill-tracker hook for 3-channel coverage, fix input.tool_name bug, clean up orphaned files
- feat(sandbox): deploy_check tool, deploy_nginx nextStep, REQUIRED markers
- feat(telemetry): add event telemetry system with install counter and crash safety
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
- chore: bump version to 1.1.0-next.8 + fix Hermes MCP SDK (#326)
- style: fix ESLint catch-error-name and prettier
- chore: bump version to 1.1.0-next.8
- docs: add Hermes MCP Python SDK note to README
- fix(hermes): auto-install MCP Python SDK to fix silent tool discovery skip
- chore: bump version to 1.1.0-next.7
- fix(sandbox): expand **/ patterns for tar --exclude (globstar not supported)
- docs: rename Hermes Agent to Hermes for consistency (#321)
- fix(ws-exec): replace RegExp with indexOf/slice in stripEchoedLine to avoid RangeError on long commands
- fix(sandbox): **/node_modules exclusion, nginx cleanup, archive size warning, upload log rotation
- feat(hermes): complete Hermes Agent adaptation with safety hooks and MCP Catalog (#306)
- fix(sandbox): add output file verification and session fallback guidance
- chore(release): 1.1.0-next.6
- fix(sandbox): add tee build logging, outDir verification, post-timeout log dump
- feat: 代金券能力可发现化，新增 huawei-voucher skill 与路由
- fix(sandbox): add DevBridge quota auto-recovery, pre-cleanup, Taro build 900s timeout
- fix(sandbox): add DevBridge quota auto-recovery, pre-cleanup, Taro build 900s timeout
- fix(sandbox): add .swc/dist exclusion, post-upload permission fix, PNG QR priority, cross-platform 600s timeout
- fix(sandbox): add build timeout recovery, env injection, OS detection, dependency exclusion for upload
- fix(sandbox): add build timeout recovery, env injection, OS detection, dependency exclusion for upload
- chore(release): 1.1.0-next.5
- fix: voucher 工具 domain_id 参数标注为可选，避免 Agent 误判为必传 (#308)
- style: rename catch parameter err to error for unicorn/catch-error-name rule
- fix(sandbox): add retry for upload batch/tunnel failures, add process persistence and cross-platform warnings
- chore(release): 1.1.0-next.4
- fix(release): stop auto-deleting .version-override in create-release-pr
- chore(release): 1.1.0-next.3
- fix(release): restore .version-override to 1.1.0 until 1.1.0 stable release
- feat: add parent cwd and --codearts-project-dir fallback for CodeArts credential resolution (#299)
- feat: voucher MCP 工具支持可选 domain_id 参数
- chore(release): 1.1.0-next.1
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
- chore(release): 1.1.0-next.0
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
- docs: fix README Node.js requirement, discussions badge link, and repo URL
- feat(routing): offer deployment targets with sandbox first for static sites
- refactor(sandbox): remove huaweicloud_sandbox_release tool
- refactor(auth): point AK/SK guide directly to IAM access keys page
- refactor(install): Chinese next-steps prompt
- feat(install): next-steps prompt with unified auth init first, then restart and doctor
- fix(huawei-sandbox): workspace dir is /workspace at filesystem root, not \C:\Users\sunzy/workspace
- feat(huawei-sandbox): clone projects into sandbox workspace dir, never /tmp
- fix(install-hcloud): append+dedupe user PATH via SetEnvironmentVariable instead of clobbering setx PATH
- feat(huawei-sandbox): hide tunnel/DevBridge details from developers, treat as internal implementation
- refactor(auth): simplify credential hints to plain auth init command
- fix(auth): route credential hints to unified auth init instead of KooCLI-only configure init
- feat(huawei-sandbox): DevBridge reverse proxy workflow - install, AK/SK login, expose, return URL, no local downgrade
- feat(skills): route deploy-a-repo prompts to sandbox, detect web apps and offer sandbox proactively
- feat(auth): add AK/SK acquisition guide (Chinese) to auth init
- refactor(auth): single 'Credentials synchronized' message instead of per-target sync details
- feat(huawei-sandbox): install Node.js from Huawei Cloud mirror when sandbox lacks it
- fix(auth): skip 0600 check on native Windows (no POSIX modes, avoids false warnings)
- feat(auth): verify 0600 on credential files, warn on WSL-mounted drives
- feat(huawei-sandbox): offer sandbox proactively for runtime tasks, hide agreement/DevBridge details (#58)
- Update CONTRIBUTING.md
- Update README.md
- Update README.zh-CN.md
- fix: publish-dev bump tolerates package.json already at base (no 'Version not changed' failure)
- fix: sync plugin manifest versions to 1.0.1 and harden publish.yml against version drift
- fix: clear install marker when MCP server loads so doctor stops false 'restart needed' warnings
- fix: write obsutilconfig in flat key=value format for KooCLI 7.x (#49)
- release 1.0.1
- (feat): add cd-production
- add publish release CI.
- feat: purge credential vault on full uninstall, safer auth init prompts (visible AK, hidden SK, default region cn-north-4)
- fix: use file:// URL for ws-exec dynamic import (Windows ERR_UNSUPPORTED_ESM_URL_SCHEME)
- feat: remove one-shot sandbox exec tool, document per-agent update commands
- feat: incremental update per agent + dev publish manifest sync + hdkit endpoint
- docs: update prerequisites for unified auth
- feat: unify Huawei Cloud auth across agents
- feat(huawei-obs): add single-file quick share workflow
- docs: update huawei-sandbox SKILL.md with check_user/sign_agreement tools and workflow
- fix: Codex MCP wiring - desktop uses ~/.codex/config.toml, CLI plugin adds cwd, uninstall cleans marketplace
- feat: merge sandbox MCP tools into huaweicloud-devkit server
- docs: add hook-rule-model.md required by structure tests
- ci: add publish-dev workflow (npm next) to main
- fix: resolve #25 WorkBuddy adaptation + doctor hardening
- fix: resolve issues #9, #11, #6 + update README + merge upstream/dev
- @ feat: add WorkBuddy platform support
- fix: resolve 4 issues from scenario testing (#8, #12, #13, #14)
- fix: resolve 4 issues from scenario testing (#8, #12, #13, #14)
- docs: add contributors section to readmes
- feat: add Sync to GitCode workflow
- ci(dev): add publish-dev workflow (npm next) consistent with mate dev
- docs: English-first README (README.md=en, README.zh-CN.md=zh)
- docs: bilingual README (zh + en), fix dead links
- docs: remove internal docs not suitable for public
- chore: keep only validation + governance workflows on public mirror
- chore: remove duplicate uppercase PR template, keep plugin lowercase one
- chore: remove GitCode sync, keep GitHub org mirror only
- Add status transition workflow
- Add GitCode sync workflow
- Add triage workflow
- Add CI workflow
- Add dependabot config
- Add PR template
- Add issue config
- Add feature template
- Add bug template
- Add code of conduct
- Add security policy
- Add contributing guide
- Add CODEOWNERS
- Add README
- chore(release): v1.0.0
- ci: allow partial mirror sync with per-target failure reporting
- ci: sync npm releases to huaweicloud org and GitCode mirrors
- test: update structure test for removed acceptKooCliPrivacy function
- fix(#74,#78,#80): Codex CLI detection and doctor self-check for Codex Desktop
- fix(#75): installCodexDesktop missing .mcp.json and .codex-plugin
- 移除 Claude Code 和 Cursor 市场入口，清理 README/INSTALL 中相关引用
- fix: harden hook safety checks
- fix(#74,#78,#80): Codex CLI detection and doctor self-check for Codex Desktop
- chore(release): v0.1.24
- fix(#75): installCodexDesktop missing .mcp.json and .codex-plugin
- chore: remove build artifact, internal docs, and test-report for open source
- docs: add opencode hook safety test guide
- feat: add huaweicloud hook safety checks
- docs: add governance files (SECURITY/OWNERS/CODEOWNERS/templates/dependabot/SUPPORT/editorconfig)
- fix(#77 follow-up): remove remaining auto-accept privacy agreement patterns
- fix(#77): replace auto-accept privacy agreement with interactive prompt
- docs: add CONTRIBUTING and CODE_OF_CONDUCT from dev
- fix(#73): cross-reference cloud-init bootstrap for SCP-blocked SSH
- fix: unique DDS/DCS warning headings for lint
- fix: merge adjacent blockquotes for lint
- fix: wrap ECS shell commands in code fence for lint
- fix: markdownlint blockquote; remove untracked local spec
- fix: markdownlint violations in dev-synced skill files
- chore: sync package.json version to 0.1.23 with dev
- fix: banner version, VPC multi-version warning, FunctionGraph ListRuntimes, SCP SSH guidance
- fix(#71): read CLI banner version from package.json at runtime
- chore: main_01 = dev functionality + main management
- fix: add flavor AZ-status trap warning, SCP 0.0.0.0/0 block guidance (#101)
- fix(#68): add flavor status filtering to flavors.md and create-instance.md
- fix: prevent Windows error dialog when checkHcloud encounters invalid executables
- fix: correct ECS skill parameter names and add JMESPath filtering guidance
- feat: add huaweicloud_setup_obs_config MCP tool to sync credentials from hcloud to OBS
- rename MCP server from huaweicloud to huaweicloud-devkit
- fix: support newline-delimited JSON transport for MCP protocol compatibility
- docs: add CONTRIBUTING and CODE_OF_CONDUCT
- ci(dev): refuse to publish formal versions as next
- test: make codearts hcloud detection test platform-aware
- fix: resolve markdownlint violations in merged skill files
- fix: BOM in plugin JSONs, Linux hcloud.exe detection
- chore: bump to v0.1.22
- fix: sync findHcloudBin with CodeArts test, update structure test
- chore(release): bump version to 0.1.21
- test: add huaweicloud-codearts-cleanup skill for CodeArts environment reset
- feat: add CodeArts Agent target with KooCLI sandbox and privacy handling
- chore(release): bump version to 0.1.20
- ci(dev): add Publish Dev (next) workflow
- ci(dev): publish huaweicloud-devkit@next prerelease from dev branch
- test: fix CodeQL incomplete-escaping finding in URL checks
- fix: correct OpenCode activation message — @ is Codex syntax, OpenCode auto-matches
- fix: resolve markdownlint violations in skill files, keep strict config
- feat: aggressive restart warning on install, doctor detects pending-restart marker
- chore: sync plugin manifests to v0.1.19
- style: relax markdownlint rules for content files
- chore(release): v0.1.18
- test: verify KooCLI Windows/Linux/macOS download URLs in cli-and-auth skill
- feat: Windows hcloud auto-install — download, unzip, add to PATH via PowerShell
- fix: E2E test fixes — EIP unbind cmd, keypair param, DNS table, image search guidance
- report: deploy-to-website E2E test - 7 issues (P0: windows hcloud auto-install, MCP restart; P1: image search, DNS docs, cmd params, EIP cleanup)
- fix: --target codex now errors when Codex CLI missing; --target all gracefully skips
- chore: remove last 暂用于测试 label from README
- closes #45: rename npm package from huaweicloud-devkit-test to huaweicloud-devkit
- feat(ecs): add Prerequisites section + update SOP for 'from zero' flow
- fix(#61): add DNS params to CreateSubnet — prevent cloud-init silent failure
- docs(AGENTS): note npm version only bumps package.json, need to sync 3 plugin manifests
- fix(ci): bump plugin manifest versions to 0.1.17
- chore: bump to v0.1.17
- fix(RDS skill): 3 improvements from RDS MySQL 8.0 end-to-end test
- fix(#49, #50): uninstallCodexDesktop was defined but never called — orphan cleanup
- fix(#57): enable agent to accept KooCLI privacy agreement on user's behalf
- fix(#57): 7 fixes — OBS exit codes, ACL docs, auth detection, error codes
- docs(AGENTS): codify three-class parameter value rule
- refactor(#59): replace UNNECESSARY hardcoded values with placeholders
- fix(#59): correct 2 WRONG hardcoded values
- refactor(#59): remove ELB coverage claim from VPC skill
- fix(#60 follow-up): 3 missed locations from original analysis
- fix(#60): correct IMS __isregistered value + EIP quota wording
- fix(uninstall): cleanup commands/ directory on uninstall
- fix(vpc): add missing --subnet.gateway_ip required param to CreateSubnet template
- fix(vpc): add SYS.0403 SCP denial to troubleshooting table
- fix(ecs): add user_data/cloud-init mechanism + HTTP verification to create-instance
- fix(ecs): remove hardcoded flavor names from Flavor Selection Guide
- fix: remove hardcoded parameter values violating --help discovery principle
- fix(#52): EIP AssociatePublicips uses PORT type + port ID, not ecs
- chore: bump version to 0.1.16
- fix(#43): add non-interactive credential setup for Agent/CI environments
- fix(getting-started): add privacy policy acceptance step to KooCLI first-time setup
- fix(cce): #46 KooCLI OPENAPI_ERROR note, #47 CreateKubeConfig→CreateKubernetesClusterCert, #48 SWR IAM permission prerequisite
- chore: bump version to 0.1.15
- fix(issues36-40): APIG event format, IAM Agency, RDS dotted/password, EIP type, URN warning
- revert: remove auth modes table, keep original AKSK-only approach
- fix(cli): mark auth modes agent-safe vs user-only to avoid AK/SK leakage
- feat(cli): add 5 auth modes, output formatting, and KooCLI error types from external skill
- chore: bump version to 0.1.14
- fix(#25): add marketplace-sourced references for OBS, FunctionGraph, VPC, IAM
- refactor: port find-skills search to Node.js — zero dependencies, no Python required
- feat: add huaweicloud_search_marketplace MCP tool (Node.js port of find-skills, no Python required)
- feat(#25): upgrade RDS skill to match marketplace quality — command tables, parameter refs, backup/recovery, diagnosis, mutating ops list
- fix(#25): add ECS troubleshooting and OBS common-pitfalls references from real test findings
- fix(#26): expand VPC and IAM reference files based on real test findings
- closes #26: fixed 7 skill files — Critical Warnings, h2 headings, expanded short skills, troubleshooting content
- fix(#26): add Critical Warnings to 4 skills, expand 3 short skills, fix h2 headings, add troubleshooting ref content
- closes #35: V5 serverless test bugs #10-#18 all fixed in safety-policy + APIG + VPC skills
- fix: V5 serverless test — risk preservation, APIG params/status/sl_domain, VPC nested prefix
- feat: chain install -> hcloud check -> install-hcloud guide
- feat: add install-hcloud command with per-platform install guides from official docs
- docs: fix README skill count (26 not 27, 6 meta-skills not 7), fix opencode reference config
- chore: bump version to 0.1.13
- fix(issue34): 8 bugs from V3 FunctionGraph+APIG+OBS test report
- feat: enrich 9 template-level skills with verified operation names
- chore: bump version to 0.1.12
- fix(issue32): installer auto-detect, doctor package name, RDS skill overhaul
- fix(issue31): 7 defects — wrong service/operation names and param structures
- fix: add IAM permission disclaimer to get_regional_availability output
- fix: doctor authCheck also use HCLOUD_BIN (follow-up to #22)
- fix: add APIGW.0802 region permission error to explain_error and ECS troubleshooting
- fix: install-codex-local.ps1 marketplace name from JSON + error handling
- docs(agents): add gotchas from issue fixing — HCLOUD_BIN, obsutil, ACL, Invoke, marketplace
- fix(obs): BUG-1 add object ACL step to static website workflow, BUG-2/3 improve OBS credential guidance
- chore: bump version to 0.1.11
- fix: #21 marketplace name from JSON, #22 doctor respects HCLOUD_BIN
- fix: classify Invoke/Execute/Trigger/Deploy as write ops, add APIG cascade delete note
- docs: add update and uninstall commands to README
- ci: add test matrix with OS, CPU arch, and Node versions
- chore: remove outdated design doc 04-secret-safety-hook.py
- chore: bump version to 0.1.10
- fix: resolve issues #12 #15 #16 #17
- feat(installer): add --target codex-desktop support for Codex Desktop agent
- fix: issue #8 — OBS safety prefixes, obsutil auth note, -f and -flat gotchas
- fix: SKILLS_ROOT path, obsutil safety, execution classification, OBS ops, jsonc support, cwd, FG traps
- docs: use test package name with --yes flag in install commands
- test: add functiongraph round test report under ssy
- docs: rewrite README in AWS agent-toolkit style
- fix: resolve issue #5 — D1 D3 D4 D5 (search tokenizer, region cache, approved risk label, stdout error parsing)
- chore: bump version to 0.1.9
- chore: bump version to 0.1.5
- fix(mcp): fix 7 MCP server bugs from test reports
- fix(ci): move hashFiles from job.if to step.if in cd-staging
- fix(obs): rewrite SKILL.md with obsutil-style commands, add static website workflow
- chore: bump to v0.1.18
- fix: prevent AK/SK in shell history — mark hcloud configure set as DANGEROUS, prefer init
- test: verify KooCLI Windows/Linux/macOS download URLs in cli-and-auth skill
- feat: Windows hcloud auto-install — download, unzip, add to PATH via PowerShell
- docs: document the two-step release workflow
- fix: E2E test fixes — EIP unbind cmd, keypair param, DNS table, image search guidance
- report: deploy-to-website E2E test - 7 issues (P0: windows hcloud auto-install, MCP restart; P1: image search, DNS docs, cmd params, EIP cleanup)
- fix: --target codex now errors when Codex CLI missing; --target all gracefully skips
- chore: remove last 暂用于测试 label from README
- closes #45: rename npm package from huaweicloud-devkit-test to huaweicloud-devkit
- feat(ecs): add Prerequisites section + update SOP for 'from zero' flow
- fix(#61): add DNS params to CreateSubnet — prevent cloud-init silent failure
- docs(AGENTS): note npm version only bumps package.json, need to sync 3 plugin manifests
- fix(ci): bump plugin manifest versions to 0.1.17
- chore: bump to v0.1.17
- fix(RDS skill): 3 improvements from RDS MySQL 8.0 end-to-end test
- fix(#49, #50): uninstallCodexDesktop was defined but never called — orphan cleanup
- fix(#57): enable agent to accept KooCLI privacy agreement on user's behalf
- fix(#57): 7 fixes — OBS exit codes, ACL docs, auth detection, error codes
- docs(AGENTS): codify three-class parameter value rule
- refactor(#59): replace UNNECESSARY hardcoded values with placeholders
- fix(#59): correct 2 WRONG hardcoded values
- refactor(#59): remove ELB coverage claim from VPC skill
- fix(#60 follow-up): 3 missed locations from original analysis
- fix(#60): correct IMS __isregistered value + EIP quota wording
- fix(uninstall): cleanup commands/ directory on uninstall
- fix(vpc): add missing --subnet.gateway_ip required param to CreateSubnet template
- fix(vpc): add SYS.0403 SCP denial to troubleshooting table
- fix(ecs): add user_data/cloud-init mechanism + HTTP verification to create-instance
- fix(ecs): remove hardcoded flavor names from Flavor Selection Guide
- fix: remove hardcoded parameter values violating --help discovery principle
- fix(#52): EIP AssociatePublicips uses PORT type + port ID, not ecs
- chore: bump version to 0.1.16
- fix(#43): add non-interactive credential setup for Agent/CI environments
- fix(getting-started): add privacy policy acceptance step to KooCLI first-time setup
- fix(cce): #46 KooCLI OPENAPI_ERROR note, #47 CreateKubeConfig→CreateKubernetesClusterCert, #48 SWR IAM permission prerequisite
- chore: bump version to 0.1.15
- fix(issues36-40): APIG event format, IAM Agency, RDS dotted/password, EIP type, URN warning
- revert: remove auth modes table, keep original AKSK-only approach
- fix(cli): mark auth modes agent-safe vs user-only to avoid AK/SK leakage
- feat(cli): add 5 auth modes, output formatting, and KooCLI error types from external skill
- chore: bump version to 0.1.14
- fix(#25): add marketplace-sourced references for OBS, FunctionGraph, VPC, IAM
- refactor: port find-skills search to Node.js — zero dependencies, no Python required
- feat: add huaweicloud_search_marketplace MCP tool (Node.js port of find-skills, no Python required)
- feat(#25): upgrade RDS skill to match marketplace quality — command tables, parameter refs, backup/recovery, diagnosis, mutating ops list
- fix(#25): add ECS troubleshooting and OBS common-pitfalls references from real test findings
- fix(#26): expand VPC and IAM reference files based on real test findings
- closes #26: fixed 7 skill files — Critical Warnings, h2 headings, expanded short skills, troubleshooting content
- fix(#26): add Critical Warnings to 4 skills, expand 3 short skills, fix h2 headings, add troubleshooting ref content
- closes #35: V5 serverless test bugs #10-#18 all fixed in safety-policy + APIG + VPC skills
- fix: V5 serverless test — risk preservation, APIG params/status/sl_domain, VPC nested prefix
- feat: chain install -> hcloud check -> install-hcloud guide
- feat: add install-hcloud command with per-platform install guides from official docs
- docs: fix README skill count (26 not 27, 6 meta-skills not 7), fix opencode reference config
- chore: bump version to 0.1.13
- fix(issue34): 8 bugs from V3 FunctionGraph+APIG+OBS test report
- feat: enrich 9 template-level skills with verified operation names
- chore: bump version to 0.1.12
- fix(issue32): installer auto-detect, doctor package name, RDS skill overhaul
- fix(issue31): 7 defects — wrong service/operation names and param structures
- fix: add IAM permission disclaimer to get_regional_availability output
- fix: doctor authCheck also use HCLOUD_BIN (follow-up to #22)
- fix: add APIGW.0802 region permission error to explain_error and ECS troubleshooting
- fix: install-codex-local.ps1 marketplace name from JSON + error handling
- docs(agents): add gotchas from issue fixing — HCLOUD_BIN, obsutil, ACL, Invoke, marketplace
- fix(obs): BUG-1 add object ACL step to static website workflow, BUG-2/3 improve OBS credential guidance
- chore: bump version to 0.1.11
- fix: #21 marketplace name from JSON, #22 doctor respects HCLOUD_BIN
- fix: classify Invoke/Execute/Trigger/Deploy as write ops, add APIG cascade delete note
- docs: add update and uninstall commands to README
- ci: add test matrix with OS, CPU arch, and Node versions
- Revert "test: add functiongraph round test report under ssy"
- chore: remove outdated design doc 04-secret-safety-hook.py
- chore: bump version to 0.1.10
- fix: resolve issues #12 #15 #16 #17
- feat(installer): add --target codex-desktop support for Codex Desktop agent
- fix: issue #8 — OBS safety prefixes, obsutil auth note, -f and -flat gotchas
- fix: SKILLS_ROOT path, obsutil safety, execution classification, OBS ops, jsonc support, cwd, FG traps
- docs: use test package name with --yes flag in install commands
- test: add functiongraph round test report under ssy
- test: move functiongraph report out of main
- docs: rewrite README in AWS agent-toolkit style
- test: keep only functiongraph report under ssy; remove reports for other plugin
- test: add ssy round test reports (ecs-purchase/obs-deploy/functiongraph)
- fix: resolve issue #5 — D1 D3 D4 D5 (search tokenizer, region cache, approved risk label, stdout error parsing)
- chore: bump version to 0.1.9
- chore: bump version to 0.1.5
- fix(mcp): fix 7 MCP server bugs from test reports
- fix(ci): move hashFiles from job.if to step.if in cd-staging
- fix(obs): rewrite SKILL.md with obsutil-style commands, add static website workflow
- chore: sync plugin manifest versions to 0.1.4
- feat: enhance huawei-cce with SWR/CCI, enrich huawei-vpc EIP workflows, add Flexus to ECS
- chore: v0.1.4
- chore: sync version to v0.1.3
- fix: hashFiles not supported in job if, move to step check
- chore: bump to v0.1.2 for npm publish test
- chore: rename npm package to huaweicloud-devkit-test, remove redundant workflow
- fix: remove invalid image params, add doctor command, improve install UX
- ci: add GitHub Actions workflow for npm package publishing
- docs: add 4-step --help workflow, --cli-jsonInput tip, DEDICATEDGATEWAY json input example
- refactor: merge huawei-cloud-find-skills into capability-discovery, remove Python dependency
- docs: add skill design principles to AGENTS.md
- refactor: add --help discovery to all 16 service skills, fix bloated find-skills
- fix(apig): remove non-existent --eip_id param from AddIngressEipV2 example (N1)
- fix(apig): add CreateInstanceV2 + EIP binding guidance; fix PublishApiV2 -> BatchPublishOrOfflineApiV2
- style: fix trailing space in find-skills SKILL.md
- chore(release): v0.1.1
- chore: sync local changes
- fix(functiongraph): add inline demo, zip -j flattening, DEDICATEDGATEWAY pre-flight checklist
- chore: sync local changes
- fix: unify auth guidance, add FG/APIG IAM policies, document MCP path issue
- ci(release): bump via PR + publish via tag (no branch bypass needed)
- ci(release): push using PAT owner username instead of x-access-token
- refactor(functiongraph): shift from hardcoded parameters to --help discovery pattern
- fix(functiongraph): correct APIG trigger param names, add IAM permissions, code_filename path note
- chore: sync local changes
- ci: use ubuntu-24.04 runner to avoid hosted pool outage
- ci(release): add push token identity diagnostics
- ci(release): fix YAML syntax in gh-release tag_name
- ci(release): use RELEASE_PLEASE_TOKEN for protected main push
- chore: add .clawhub/ to gitignore
- feat: add marketplace skill discovery and update docs
- ci(release): push via PAT for protected main
- docs: add known issues from FunctionGraph deployment testing (R1-R3)
- fix(functiongraph): fix IAM op name, add DeleteFunction :latest gotcha, add refs precedence note
- refactor(functiongraph): slim SKILL.md from 457 to 93 lines, split details into references/
- fix(functiongraph): fix InvokeFunction body param, trigger event_data format, add project_id guide and response version docs
- ci(release): replace release-please with manual release workflow
- fix(functiongraph): correct service name, operation names, required params, add code deployment guide and end-to-end workflow
- ci(release): prefer PAT token with GITHUB_TOKEN fallback
- ci: add CI/CD and release pipeline
- docs: update README
- docs: gap analysis v3 — design blueprint fully delivered
- feat: add 14 new skills (APIG, Billing, CBR, CCE, CloudEye, CTS, DDS/DCS, Deployment, FunctionGraph, GaussDB, GettingStarted, ModelArts, RDS, SMN/DMS, WAF/AAD) and rules
- docs: update AGENTS.md for meta+service skill architecture
- docs: update design vs implementation gap analysis to v2
- chore: update docs, skills, tests, and plugin configs
- feat: add Claude/Cursor plugin configs, new skills (DEW/ECS/IAM/OBS/VPC), and update core tools
- docs: add AGENTS.md with project conventions and agent guidance
- feat: add project structure, plugins, integrations, and docs
- fix: remove BOM marker from docs
- docs: update design docs
- docs: Huawei Core 设计审查报告 v1 + v2
- docs: huawei-core plugin system design
- Initial commit

## 1.1.3 (2026-09-11)

- chore: advance main to 1.1.3-next.4 (business keeps dev; prepare stable 1.1.3) (#619)
- test(update-check): decouple upgrade-tag logic from repo package.json version
- chore(release): 1.1.2
- test: resolve structure.test.mjs to dev version (union-merge artifact)
- chore(release): 1.1.1 (#515)
- chore: merge dev into main for 1.1.1 stable release (#513)
- chore: add dsh.bundle manifest for DSH plugin ecosystem
- chore(release): 1.1.0 (#440)
- chore: merge dev into main for 1.1.0 release (#438)
- chore: version override for 1.1.0 stable release (#433)
- docs: add Huawei Cloud npm mirror recommendation for China users
- chore(release): 1.0.2
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
