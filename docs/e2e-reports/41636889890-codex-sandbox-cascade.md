# e2e-nightly codex 腿 sandbox 级联修复报告

子集:codex 腿 8 个 sandbox 级联 case(任务书修正版)。run:fork 41636889890(push 9bee29b6),基线 upstream 41378291316 同批更重,证明既有问题。

## 结论(先说结果)

单一根因修复:`test/e2e/drivers/gateway-proxy.ts` 在响应侧为扁平 `function_call` 帧回填 `namespace`,codex 0.162.1 的 MCP 派发从此恢复。真 236MB wire dump 回放:165/165 个扁平调用被修复,0 误伤,0 解析失败。8 个 case 中 7 个由此闭环;第 8 个(sandbox-upload-file-md5)的 connect 级联同样被修复,但共享期望钉 `wsConnections 2..2` 存在另一个失败模式(见遗留 1),归 e2efix-omcp。

## 根因机制(证据链)

1. codex 0.162.1 把 MCP 工具声明为 namespace 型工具(`{"type":"namespace","name":"mcp__hwc","tools":[…]}`,dump 每个请求都携带,548/548),且**只**通过 function_call 响应项的 `namespace` 字段派发:`build_tool_call` 直接 `ToolName::new(namespace, name).with_default_namespace()`(codex-rs core/src/tools/router.rs:285),无扁平名兜底;注册表查找 miss 即 `unsupported call: <name>`(registry.rs:1151)。派发来源是 `response.output_item.done` 项(client.rs:2567 → stream_events_utils.rs:335),`response.completed` 镜像与 `added` 帧不参与。
2. e2e 网关代理为避 400 剥掉请求里 function_call 项的 `namespace`(2026-10-21 spike 测量;gateway-proxy.ts 既有行为),于是模型看到的历史全是扁平名,后续调用模仿历史发出扁平调用。实测该 run:226 个 huaweicloud 工具 emission 中 165 个(73%)无 namespace;**100% 的扁平调用被 codex 回 `unsupported call: X`,从未到达 devkit 服务器**;61 个带 namespace 的 100% 派发成功(对抗验证:按 call_id 关联 165+61 个 done 帧与其输出)。
3. 触发链:vendor challenge(产品按设计在每个 session 首个 gated 调用弹一次,e2e 层从不关闭)→ 模型按挑战消息正确重试 → 重试是"后续调用",大概率扁平 → `unsupported call` → 级联。沙箱 8 case 的 connect 首调全部命中此链(如 sandbox-exec-session-reuse a2:dump L55927 namespaced 首调吃挑战 → L56042-57555 共 44 个扁平 connect 全部 unsupported)。

## 根因表

| Case                                 | 根因                                                                                                                                                                                          | 归类                            | 证据                                                                                                                                                                                             | 修复                                                        |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| sandbox-connect-session              | 扁平 connect 重试无法派发;attempt2 仅 check_account_type/check_user(带 ns)成功,connect 全灭;agent 调试后凭 curl 结果编造会话信息                                                              | (a) harness                     | 报告 attempt2 traced `check_account_type(ok=true)\|check_user(ok=true)`、POST /connect 0 次;dump L30993 connect(ok=false)→`unsupported call`                                                     | 响应侧 namespace 回填(下述)                                 |
| sandbox-expose-tunnel                | connect(ok=false) 级联,devbridge 5 组 intent 全 0                                                                                                                                             | (a)                             | 报告 attempt 终态 `connect(ok=false)`、全 intent 0                                                                                                                                               | 同上                                                        |
| sandbox-exec-one-shot-ws             | attempt1: connect 扁平未派发(curl 冒充 POST /connect),exec_one_shot 带偶然 ns 成功(仅 echo 1 连接 < min2);attempt2: connect 带 ns 成功(delete-all+export-path 2 连接),exec 扁平 `unsupported` | (a)                             | attempt1 wsCalls `echo`×1、httpCalls `GET /check-user`×2+`POST /connect`+1 对 connections(模型 exec 调试链);dump L54178 connect ok、L54243 `unsupported call: huaweicloud_sandbox_exec_one_shot` | 同上                                                        |
| sandbox-exec-session-reuse           | connect 挑战后重试扁平,44 次全 unsupported,0 连接                                                                                                                                             | (a)                             | 报告 0 POST /connect、wsConnections 0;dump L55927-57555                                                                                                                                          | 同上                                                        |
| sandbox-exec-session-close-reconnect | 同级联;attempt2 connect 一次成功(3 连接中的 ws 部分)但 close_session/exec 后续扁平                                                                                                            | (a)                             | 报告 close_session 0 次、wsConnections 1(abrupt)                                                                                                                                                 | 同上                                                        |
| sandbox-upload-file-md5(codex 腿)    | connect 级联(rm/printf/base64/md5sum 全 0)                                                                                                                                                    | (a)(另有共享期望钉风险见遗留 1) | 报告 connect(ok=false) 级联、全 intent 0                                                                                                                                                         | 同上;期望钉归 e2efix-omcp                                   |
| sandbox-upload-project-tunnel        | connect(ok=false) 级联,kill/write/start-fileserver 全 0                                                                                                                                       | (a)                             | 报告 upload_project(ok=false) 级联                                                                                                                                                               | 同上                                                        |
| sandbox-deploy-nginx                 | connect 级联 + attempt2 超时(exit null,flail 循环烧尽预算)                                                                                                                                    | (a)                             | 报告 deploy_nginx 0 调用、nginx-installed 等 0;attempt2 httpCalls 显示 POST /connect 后 flail                                                                                                    | 同上(派发恢复后 4-8 个请求完成流程,不再烧 34-39 个调试请求) |

产品侧(vendor challenge、connect 的 ws setup、上传/部署全链路)在派发恢复后行为正确——opencode 腿同批通过这些 case 是对照证明;codex 腿 dump 内带 ns 的偶发成功派发(I254kL:connect 完整跑出 2 ws;3abi7d:exec_one_shot 返回 e2e-one-shot-output)也是对照。

## 修复(最小改动,1 个产品外文件 + 测试)

`test/e2e/drivers/gateway-proxy.ts`:

- 请求侧不变(仍剥 namespace 避 400),新增从每个 POST 的 tools 声明构建 `NamespaceIndex`(namespace → 扁平函数名,歧义/被顶层同名遮蔽的名字不回填)。
- 响应侧:`response.output_item.done` 的 function_call 项缺 namespace 且名字无歧义解析时回填(这正是 codex 的唯一派发来源)。两种模式(dump 开/关)统一行缓冲;dump 记录回填后的线(codex 实收的 wire)。
- 加固(interrogate 产物):CRLF 帧容忍(剥尾 `\r` 再回填重附)、U+2028/U+2029 用 `[\s\S]` 捕获(JS `.` 不匹配它们,否则整类静默失效)、无 tools 数组的 POST 不清索引、JSON-null body 不吞 dump 行、`emptyIndex()` 每次新建(自察:共享可变初值)。

`test/e2e-driver-codex.test.ts`:`indexNamespaceDecls`/`reattachNamespaceInFrame` 纯函数钉 + 端到端集成钉(回填、已带 ns 不动、顶层工具不动、CRLF 流式路径、tools-less POST 不清索引)。`.jscpd-baseline.json` 增 1 条指纹(两个集成测试共享的 11 行 listen→proxy→fetch 样板,仓库文档明示的 intentional test repetition)。

**验证**:真实 run 的 236MB dump 全量回放(request 建索引、frame 过重写器)165/165 修复、0 漏、0 误伤、0 解析失败;对抗 agent 另以真实 codex 0.162.1 二进制过真实 proxy 做了 A/B:重写关 → 0 派发,重写开 → 1 派发(帧长变化经 TCP 拆分后解析无恙)。

## interrogate 轮次记录

| 轮                                      | 发现                                                                                                                                                                                                       | 处置                                                                                               |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 自察(轮前)                              | `EMPTY_INDEX` 共享可变初值可被外部变异污染                                                                                                                                                                 | 已修(每次新建)                                                                                     |
| 1(3 对抗:wire 保真 / 完备性 / 爆炸半径) | 4 个潜在(LOW)发现:F1 CRLF 静默失效、F2 尾行合成 `\n`、F3 非 UTF-8 重编码、F4 并发索引覆盖+tools-less 清索引                                                                                                | 修 F1、F4a;F2/F3/F4b 记录为残余(实测 wire 0 出现:236MB 0 个 CR 字节、548/548 JSON+SSE、请求全串行) |
| 2(2 对抗)                               | F-R2-1 U+2028/2029 静默漏写(已修+钉);实质发现:8/8 声明对 upload-file-md5 过头(opencode 腿全派发仍因模型自查 `ls` 开第 3 连接败于 2..2 钉)→ 归 e2efix-omcp;2 个测试缺口(CRLF 流式路径、dump 记回填后线)已补 | 全部处置                                                                                           |
| 3(1 对抗,最终扫)                        | **0 缺点(SHIP)**;1 条诊断级观察(null body 丢 dump 行)顺手关闭                                                                                                                                              | 关闭                                                                                               |

## 门禁输出摘要(全绿;exit code 直取,不经管道)

- `npm ci` ✓(新 worktree)
- `npm run typecheck` → 0
- 全量 `node --experimental-test-module-mocks --test --test-concurrency=6 "test/*.test.ts"` → 1486 tests / 1484 pass / **0 fail**(2 skip 为平台分支)
- `npm run lint` → 0(0 errors;74 个 warnings 均预存在,无一在我改的文件)
- `npm run lint:dup` → 0;jscpd 对 committed baseline 零新克隆
- `npm run validate` → 0(30 skills、KooCLI 7.3.12 配对、pack boundaries、skills sync)
- `npm run format:check` → 0

并发说明:默认并发跑全量时 `hook-parity` 的 ReDoS 时序探针(`Date.now()-tsStart < 1000`,hook-parity.test.ts:1015)在共享机上 4 次超时失败(1006-1216ms)。归因证据:该探针单跑 5 次全过(分类实测 415-560ms,预算仅 ~2x 裕度);本机 load 10-23(三个并行 agent worktree);stash 我的 diff 后默认并发全量过一次(更轻负载窗口);限并发 6 后带 diff 全量两次全绿。属负载敏感时序 flake,与本 diff 无机制交集(改动不触 hook/safety 路径)。CI 专用 runner 无此争抢。

## 遗留与风险

1. **sandbox-upload-file-md5(codex 腿)的残余风险**:connect 级联已修,但共享期望钉 `wsConnections {min 2, max 2}` 会被模型自己的上传后核验 one-shot(第 3 连接 `ls`)打破——这正是 opencode 腿同名 case 的既有失败(其 attempt2:3 连接,`closes: abrupt,open,abrupt`)。该钉与 opencode 腿修复同属 e2efix-omcp 范围(任务书明示);本修复单独证明 7/8,钉放宽后第 8 个闭环。codex 有 2 次 attempt 预算,attempt2 若不做额外核验也可能自然过,但证据不支持把它算作已修。
2. **跨界影响(共享根因)**:本修复同时治愈 e2efix-core 的 4 个非 sandbox case(auth-switch / core-approval-positive / service-catalog / voucher-claim 均为同一 namespace 丢失机制的 `ok=false` 级联)与两个 installPacks skip 无关的 case。gateway-proxy 是共享 harness 文件,改动最小化;若 e2efix-core 在同文件另有改动,合并时以先落者为准重跑门禁。
3. **已记录残余(0 实测出现,静默失效类已全部关闭)**:未终结尾行合成 `\n`(JSON/SSE 均容忍);非 UTF-8 body 会 U+FFFD 重编码(本 wire 全 JSON);并发请求索引 latest-wins(codex 每 session 串行);BOM 前缀首 data 行不回填。
4. e2e-nightly.yml L188 注释("the exact upstream frame is only observable here")对回填后的帧略过期——该文件 drift-guard(main/v2 字节一致)且非本子集范围,有意不动。
5. e2e 级验证本地不可跑(无 test/e2e/.env),由 run-e2e label 的 PR 承担;vendor challenge 仍按设计每 session 消耗一次弹跳+重试(opencode 腿同构通过为对照)。
