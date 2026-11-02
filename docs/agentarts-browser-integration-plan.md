# AgentArts 云浏览器接入计划（B1-B7）

日期: 2026-10-30。本计划把 AgentArts SDK 0.1.7 的云浏览器能力接入 devkit, 形式是镜像 memory 数据面桥的 SDK 桥接 MCP 工具族。消费者是宿主 agent（经 MCP 工具驱动隔离的云端浏览器）, 付费者是 S4 场景构建者（docs/agentarts-scenario-plan.md:56-70）。维护者继承 memory 桥的既有机械（approval-tokens、buildChildEnv、runOverPythonCandidates）, 新文件三枚。

SDK 钉版不升: 0.1.9 与 0.1.7 的 browser/code_interpreter 面字节级一致（wheel diff 实测, 2026-10-30）。

范围裁决: 仅 browser。code interpreter 另立计划——其 SDK 拦截表是死代码（`strict_block_pattrns = []`, 字符白名单放行 `rm -rf /home/user`, CI:673-685）, 桥接必须先设计 devkit 侧命令拦截层, 是独立的安全工程。

审批模型裁决: 会话租约。`start_session` 是审批边界（携带 allowed_domains/blocked_domains 域名围栏、session_timeout、profile 披露, BC:814-913）。租约载体是 0600 会话状态文件, 由已批准的 start 写入, stop 删除。approval-tokens.mjs 零改动。观察类动作（get_page_info/list_tabs/screenshot）在租约内免审批, 交互类动作（navigate/click/key_type 等）同租约内执行, 工具描述显式分类。

## How to read this

一个 box 一个工作单元, 证据存在才打勾。B1 → B2 → B3 → B4 → B5 → B6 → B7 顺序执行, B2 依赖 B1 的 region 裁决, B3 依赖 B1 的 key 来源裁决。

## Program checklist

### B1 真机 spike（docs only）【裁决完成 2026-10-30, 陷阱 61-70】

- [x] 探测前查凭证可用性（AK/SK env）, 全程脱敏: 不打印 AK/SK、api_key 值。e2e creds pair 有效, profile pair 无权限（陷阱 61 归因细化）
- [x] B1-3 region 可用性: cn-southwest-2 全链路真机通过（陷阱 70）
- [x] B1-1 create 响应是否含 api_key 值 → **否定裁决**: API_KEY 与 IAM 型响应均无 key 值; 身份面 1003 拒绝; 控制台是 API_KEY 型唯一路径 → **桥默认 IAM 型, 全程序化免 key**（陷阱 61）
- [x] B1-2 `access_endpoint` 即数据面 base URL（须补 https://）; 不注入报错不提端点（陷阱 62）
- [x] B1-8 start_session 最小参数面 = browser_name + session_name（陷阱 69）
- [x] B1-10 跨进程多动作连续性成立（陷阱 68, 即桥的每调用模型）
- [x] B1-5 invoke 响应形状 = MCP 工具结果信封; screenshot 原生 image 块 base64 jpeg, example.com 一页即 ~72KB（陷阱 64）
- [x] B1-6 会话过期错误形状 = ToolsAPIError "Session not found"（陷阱 66）
- [x] B1-7 take_control = 人类接管（automation disabled, 页面状态保留）, release_control 恢复（陷阱 66）
- [x] B1-9 allowed_domains start 不校验; 围栏在页面加载层执行, current_url 变 chrome-error:// 且 is_error 仍 false（陷阱 65）
- [x] B1-4 计费 → unknown, 降级为 skill 前置告知（陷阱 70）
- [x] 资源预算: 偏差已声明（2 browser 先后建均删 + 3 会话均 stop, 终态 total_count: 0）
- [x] 回写 docs/agentarts-pr0-findings.md browser 节（陷阱 61-70）+ docs/agentarts-upstream-asks.md（诉求 #29-34）
- [x] 仓库门禁: `npm run lint` + `npm test` + `npm run validate` + `npm run format` + `npm run pack:verify`（全绿, 提交 a13b0ae5）

### 对抗检视循环【R1-R7 七轮完成（陷阱 71-75）; R1-R6 无已知未修缺陷, R7 修复 B4 的八项】

- [x] R1: 三评审（契约/安全/平价漂移）, 18 项发现 → 9 修复 3 记录不修, 提交 92fb8055
- [x] R2: 双评审（验证+回归 / 全新角度）, 16 项发现 → 6 修复 2 记录不修（跨进程锁 + fail-closed store）
- [x] R3/R4: 确认轮（R2 新机械）→ 锁协议重写（pid 活性 + rename 原子破锁 + 属主校验释放）; R4 的不可读锁内容死循环被自家测试当场抓获修复
- [x] R5/R6: 终确认轮（R4 锁）→ 破锁 TOCTOU 修复（rename 后内容校验 + linkSync 原子放回）、空锁即释、真并发竞态测试（5 连跑稳定）; R5 验证 R4 其余不变量全部成立
- [x] R7: B4 轮（单评审）→ 八项修复（陷阱 75: dispatch 钉、精确名探测、租约保存披露、竞态披露、replay 指引、可达的写时守卫、描述更新、snippet 执行钉）; 9-11 记 Noted
- [x] R8/R9: 确认轮（R7 修复全验证, 七变异全杀）→ 手术轮三处（陷阱 76: token-存活真钉、扫描活性谓词、失败路径共享披露）; B4 九轮收敛
- [x] R10/R11: B5 轮（单评审）→ 八项修复（陷阱 77: 信封 error 不变量消灭 undefined 前缀、mouse_drag 缺省、无租约记录拒绝、截断下围栏检测、锚定映射、snippet 硬化）
- [x] R12/R13: 确认轮（R10/R11 全验证）→ 手术轮四处（陷阱 78: 守卫按路径清扫不可驱动记录、解码先于开文件、memory 信封同化不变量、重复注释）
- [x] R14/R15: B6 文档轮（单评审）→ 六项修复（陷阱 79: 五工具计数、core 路由 browser 词表、双计+锚定钉、枚举实名、tier 标签）; 桥行为零事实错误
- [x] B7: 真机终验 18/18 → trap-80 修复（锚定正则双前缀形状 + 死亡措辞双形覆盖）; 十五轮对抗 + 真机闭环, 无已知未修缺陷

### B2 读桥（控制面）【实现完成, 单测 8 绿】

- [x] 创建 `plugins/huaweicloud-core/src/agentarts-browser.mjs` + `agentarts-browser-tools.mjs`（read 部分）
- [x] 工具 `huaweicloud_agentarts_browser_read`: list_browsers/get_browser/list_browser_profiles/get_browser_profile
- [x] AK/SK 注入子进程（`injectCredentials: true`——控制面需要, 与 memory 数据面不同; 测试钉注入与 /dev/null 中和两态）【R1 增凭证前置门, R2 复核成立】
- [x] region 请求 JSON 显式传递, 默认 cn-southwest-2, 边界拒错类型
- [x] 复用 `runOverPythonCandidates`/`buildChildEnv`/`saveLargeOutput`; snippet 异常捕获 `except BaseException`（ToolsAPIError 陷阱, 源码钉测试钉住）【R1 增 SystemExit 重抛保退出码契约】
- [x] 测试镜像 memory 桩模式: `test/agentarts-browser.test.mjs`（边界表、注入两态、stdin 传输、信封三形态、富集、dispatch stub python）; `test/structure.test.mjs` 注册钉
- [x] 富集: API_KEY 型资源读面 advisory（trap 61 教学）; tag 过滤按 unknown-param 拒绝（未实测需求, 诚实边界）

### B3 写桥（资源生命周期）【B1 后设计修订; 实现完成, R1 对抗轮修复在档（陷阱 71）】

- [x] plan/write 对, namespace `agentarts-browser-sdk`, 单次消费 token 契约逐字复用
- [x] **默认 IAM 型**（B1 裁决, 陷阱 61）: create canonicalizes `auth_type=IAM`; 数据面 AK/SK 签名, 全程序化。**密钥文件机械整体出局**——无 0600 key 捕获、无 policy.json `credentialFilePatterns` 新条目、无 hook 拒读测试
- [x] API_KEY 型（用户控制台自建）支持: buildChildEnv 白名单加 `HUAWEICLOUD_SDK_BROWSER_API_KEY`（SDK 原生读取, BC:893）, skill 教导该 env 的设置与适用面【R1: 透传已实现, 含 STS securityToken 注入】
- [x] create/get 响应解析 `access_endpoint`（补 https://）存入资源档案, 供 B4 会话与 B5 动作接数据面端点（陷阱 62）【R1 修订: 无独立资源档案文件——B4 起 start 时经 get_browser 云端解析入会话状态文件, create 响应在结果面携带】
- [x] 删 browser 清理对应会话状态文件; skill 教 delete 后 list 秒级残留窗口需轮询确认（陷阱 63）【会话状态文件归 B4; 残留窗口教学已在富集 note】

### B4 会话生命周期【实现完成, R7 对抗轮修复在档（陷阱 75）】

- [x] start/stop/get_session/save_profile/update_stream: start/save/update 走 approved 写契约; get/stop/take_control 走新免审批工具 `huaweicloud_agentarts_browser_session`
- [x] start 捕获会话状态文件 `agentarts-browser-session-<session_id>.json`（0600, 无凭证）: browser/session 上下文、automation/live_view stream 端点（陷阱 68 的 getter-only 补偿）、租约到期（start + session_timeout）
- [x] start 前查既有会话文件（plan 时 + 写时 coded 重查, 二次 start 静默覆盖会孤儿化云侧会话, BC:904-905）; 陈旧记录自动清扫; mint 后并发租约披露（check-then-act 残余, 陷阱 75d）
- [x] stop_session 免审批（清理放行）; take_control 免审批（人类接管, 陷阱 66）; release_control = update_stream enabled 走写对（重武装方向受门控）
- [x] 会话用 browser name 寻址; 数据面端点从 start 写的控制面探测解析（access_endpoint + 精确名断言, 陷阱 62/75b）; save/update 的 region/端点/auth 从状态文件解析（不进审批面）

### B5 动作工具【实现完成, R10/R11 对抗轮修复在档（陷阱 77）】

- [x] `huaweicloud_agentarts_browser_invoke`, 18 类 action 枚举（SDK ACTION_TYPES 逐字, 结构钉 18 条）
- [x] 逐操作参数校验在桥内重实现: presses 1-100、keys 1-5、wait 0.1-30s、quality 1-100、format png/jpeg + 逐动作必填/适用性 + 严格类型; 动作字典显式缺省（click_count 1/button left/jpeg 80/full_page false——R11 补 mouse_drag button）
- [x] 租约门: 无记录→start 指引; 过期→SESSION_LEASE_EXPIRED coded 拒绝（陷阱 66）; 30s 窗警告; 无租约字段的损坏记录拒绝（R11, 陷阱 77c）; "Session not found"/"Stream is disabled" 锚定映射（R11 收紧）
- [x] **is_error + current_url 双检测**: 围栏 note（陷阱 65, R11 起截断下从原始 stdout 旁路推导）
- [x] snippet `except BaseException` + SystemExit 重抛 + 逐块容错（坏 base64 降级 decode_error 存根）+ 同毫秒计数防碰撞（R11）
- [x] screenshot: mcp-protocol 只支持 text 块（全工具单 JSON 文本信封）→ 裁决为 **snippet 侧解码落 0600 文件返路径/mime/尺寸**, base64 不上 stdout（陷阱 64; 假 SDK 执行测试钉 PNG 魔数/0600/零泄漏）
- [x] get_page_info 双重编码 text 富集层解析（陷阱 64）

### B6 skill 与文档【实现完成】

- [x] SKILL.md: 场景路由增 browser 行（触发词含 云浏览器/browser automation）、tier map 增 browser 三行（readonly/approved SDK control plane + lease-gated SDK data plane）、MCP Tools 增四条目、Measured Traps 增六行（全部 B1 实测）
- [x] `references/cli-workflows.md` 增 Browser Sessions and Actions 节（四工具、租约模型、七步 golden path、陷阱明细）; `references/credentials.md` 增 Browser credential model 节
- [x] `test/structure.test.mjs` 增 skill 路由钉（五工具名、三 tier 行、auth_type、围栏 URL、场景行、两 references 节——死路规则执行）
- [x] `docs/CHANGELOG.md` 落条目; 陷阱只写 B1 实测

### B7 真机 e2e 与对抗加固【完成: 终验 18/18, 陷阱 80】

- [x] 全工具面真机驱动（已交付工具函数, 非探测脚本）: read list/get → plan/write create → plan/write start → invoke navigate/get_page_info/screenshot → take_control → held 映射（真实验证）→ update_stream 重武装 → invoke after release → get_session → stop → plan/write delete → 按名过滤收敛
- [x] 真机抓获 R11 锚定正则从未生效（双前缀真实形状 + 服务端死亡措辞跨运行不稳定——Session not found / No active session 双形, gateway trap-54 类）; 修复 + 桩改真实形状 + 措辞双形入档（陷阱 80）
- [x] 运维发现入档: 探测脚本未校验清理结果致孤儿资源; 共享租户收敛判据须按名过滤

## 验证规则

每个 PR 的门是 `npm run lint` + `npm test` + `npm run validate` + `npm run format` + `npm run pack:verify`。单测只证明边界与契约, 不证明可达。可达性证据只在 B1 与 B7 的真机会话里产生。

## Appendix A. 已裁决项（源码闭环）

- invoke 通用分发器, 18 类 action 客户端封闭（BC:40-59, BC:1227-1229）
- update_browser 只吃 observability + tags（BC:472）
- api_key 不缓存于实例, 每次从 env 或参数解析（BC:893 及 5 处）
- 端点解析链 env > 构造参数 > runtime env > 空串; 空串报错不提端点（CO:138-155, HC:441-446）
- 控制面端点 region 模板 + 子进程 env 链被 buildChildEnv 白名单剥离（CO:73-104）
- 凭证全败时 metadata 3s 探测后 raise（MD:71-119）
- 会话四字段, 两 endpoint getter-only 不可恢复——桥自存会话文件（BC:129-166）
- 分页 items + total_count, tag 过滤上限 10（BC:322-356, BC:640-674）
- 名称规则 `^[a-z][a-z0-9-]{0,38}[a-z0-9]$`（BC:250-270）
- screenshot 默认 jpeg/80（BC:1578-1582）; 会话用 browser name 寻址（TH:429-436）
- get_resource_api_key 需 workload_access_token, 属 S3 身份面, 不作供给方案（identity_client.py:676）
- 0.1.9 与 0.1.7 browser 面字节一致（wheel diff 实测）

## Appendix B. 否决项

- 逐动作审批: 不可用, 浏览器自动化是高频循环
- 动作数组整批预计划: 动作自适应, 下一个动作取决于上一个页面状态
- approval-tokens 扩展多次使用 token: 会话状态文件即租约, 无需新 token 种类
- 钉版升 0.1.9: browser 面字节一致, 无收益
- code interpreter 并入本计划: 拦截层独立设计

## Appendix C. 风险【B1 后修订】

- ~~key 值仅控制台可取 → B3 降级~~ **已裁决**（陷阱 61）: 桥默认 IAM 型绕开此题; API_KEY 型经 env 白名单支持
- ~~`access_endpoint` 非数据面端点~~ **已裁决**（陷阱 62）: 即数据面 base URL, 须补 scheme
- 数据面 30s HTTP 硬超时与慢页面竞速（HC:87）→ B7 实测何时撞线
- invoke 18 类枚举客户端封闭 → 服务端新动作要等 SDK 发版
- 用户侧 `~/.config/opencode/skills/huawei-agentarts/` 是过期拷贝非软链 → 合并后需重跑 setup 同步（操作者步骤）

## Appendix D. 未裁决项【B1 后收口】

B1 十项全部裁决（陷阱 61-70）。仍开放: 计费（B1-4, 无 API 面, 控制台）; 30s 超时竞速实际表现（B7）; 桥 spawn 延迟预算（B7）; WS 端点真实握手（首版桥只返回 URL 不消费 WS, 不阻塞）; profile_configuration 形状与 save_profile 实际持久化内容（B4 实现时最小透传 + B7 观察）。D 类容错已入设计: 服务端 sandbox 拦截（范围外）、limit/offset 上限（保守默认 10/透传 100）、IAM auth_type 首版即默认（B1 实测数据面可用）。
