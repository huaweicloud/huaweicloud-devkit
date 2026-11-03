# REPORT — e2e-nightly codex 腿非 sandbox 4 case 修复 (e2e-nightly-fix-cx)

分工边界：仅本 worktree 的 4 个 codex 腿非 sandbox case。未触碰 sandbox 级联 8 case、opencode 腿 2 case、任何产品代码、任何 case 期望钉。

## 根因表

| Case                              | 根因                                                                                                                                                                            | 归类             | 证据                                                                                                                                                                                            | 修复                                                                                                                                               |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| core-approval-positive            | 一次 wire 缺陷的四重表现（见下）：vendor challenge 后模型重试的 function_call 丢失 `namespace` → codex 0.162.1 按命名空间解析 → `unsupported call: <tool>`，plan/run 链从未发生 | (a) harness 缺陷 | dump 行 5954/6924/8915 等：首调 `ns="mcp__hwc"`（被分派、渲染出 challenge），重试 `ns=undefined`（codex 原话拒绝，从未到服务器）；报告 verdict：run_approved 0 次、VPC CreateSecurityGroup 0 次 | gateway-proxy 响应侧 namespace 恢复（本表统一）                                                                                                    |
| core-service-catalog-routes-ecs   | 同上：service_catalog 首调 → challenge；重试无 ns → 未分派                                                                                                                      | (a)              | dump 行 8242/8915（ns 缺失的重试原样）；报告：仅 1 次 traced(ok=false)=challenge                                                                                                                | 同上                                                                                                                                               |
| auth-switch-persist-writes-stores | 同上：auth_switch 重试未分派 → agent 退化为手写 `configure set --profile=…`（键名系自造）                                                                                       | (a)              | dump 行 17600/20192；报告：hcloud 调用全是 agent 自造 flag 的手写 configure set；.obsutilconfig/credentials.json 缺失均为级联症状                                                               | 同上；round-3 对抗者用真实 harness 评估器驱动 persist 流，4 个期望钉全部可满足（configure set 的 pinned flags 与产品实际 argv 完全一致，计数 1≤1） |
| voucher-claim-posts               | 同上：voucher_claim 重试未分派；报告里的 POST /voucher/claim 是 agent 用 curl 伪造的（不是工具）                                                                                | (a)              | dump 行 24021/27300/28176（curl 命令原文）；http expectation 的"通过"是 curl 贡献，toolCall ok=true 未发生                                                                                      | 同上；round-3 驱动真实 MCP 服务器跑通完整 claim 流                                                                                                 |

**统一机制（每个 case 一次同一根因）**：codex 0.162.1 把 MCP 服务器呈现为单个 namespace 工具 `{"type":"namespace","name":"mcp__hwc","tools":[56]}`，模型的 function_call 必须带 `namespace:"mcp__hwc"`。e2e 网关代理在请求侧把 `namespace` 字段剥掉（真网关对它 400，2026-10-21 实测），但响应侧无人补回——模型看到的重试历史全无 namespace，重试生成（vendor gate 的 challenge 明说 "Retry the same call"）就照抄了剥离后的形状；codex 在默认命名空间里找不到该工具 → `unsupported call`（codex-rs `registry.rs` 的 `unsupported_tool_call_message`）。dump 全量复核：226 个 distinct huaweicloud 调用里 165 个无 ns；四个失败 session 内 19 个调用 = 8 个带 ns 被分派 + 11 个重试无 ns 全部撞墙。opencode 腿同样 4 case 全 PASS（同一服务器、同一 gate，无此 wire 概念）——佐证非产品缺陷。基线 run 41378291316（55f53ad0）同签名更重 → 既有问题，非 9bee29b6 引入。

**修复**（test/e2e/drivers/gateway-proxy.ts）：`clientToolNamespaces` 从每个请求的 namespace 工具派生 name→namespace 映射（与普通 function 工具重名、或被两个命名空间同时声明的名字不映射——歧义永不改路）；字节级行缓冲 relay 把每条完整 SSE 帧行过 `restoreNamespaces`——未触碰的行按**原始字节**转发（含非法 UTF-8 也字节不变），丢了 namespace（缺失/null/空）的 function_call 补回后再给 codex；任何 parse/walk 失败原样转发（transform bug 永不撕断响应）；每个 upstream chunk 一次 res.write（恢复前 relay 的写粒度）。dump 记录术后形态。hook-parity ReDoS 探针 TS 预算 1000ms→5000ms（共享基础设施最小改动，见跨界影响）。

## 归类判定依据

- **(a) harness 缺陷**（主因）：生产 codex 直连真网关时，历史里的 function_call 带 namespace，模型重试会照抄带 ns 的形状——是 e2e 代理自己的剥离手术破坏了往返保真。本地用真实 codex 0.162.1 + 真实 dist MCP 服务器 + 按 dump 帧语法编排的假网关复现：direct（无代理）出 `unsupported call`；加固定代理后 challenge→重试分派→vendor gate 通过→POST /voucher/claim→trace ok:true→exit 0。
- **(c) LLM 行为残余**（不修，记录）：plan_cli_command 的重试还把参数双重编码（`args` 值成了字符串化的旧 JSON 数组、`allowWrites:"true"`）。恢复后该重试到达服务器，SDK 的 -32602 错误信息准确点名两个问题（"expected array, received string at args" / "expected boolean, received string at allowWrites"），round-3 对抗者证明模型可据此恢复并走完 plan→run→CreateSecurityGroup 全链。此残余不归 harness 修（在代理里改参数=掩盖模型行为），e2e 级验证归 run-e2e label 的 PR。

## 每轮 interrogate 发现数（真实运行计数，收敛到 0）

| 轮  | 对抗者      | 发现                                                                                                                                                                                              | 处置                                                                                                                                                          |
| --- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 3           | 7（命名冲突重路由、递归 walk RangeError 撕流、非法 UTF-8 字节突变、深嵌套撕裂、probe "linear" 措辞失实、多行 data: 盲区、plan_cli 双编码残余披露缺失）                                            | 全部修复或记录：map 歧义跳过、walk 全程 try/catch、Buffer 级字节 relay、注释纠正、CHANGELOG 增加 RECORDED RESIDUALS                                           |
| 2   | 3           | 8（写粒度 writev EINVAL 悬崖 8/8 撕流 vs HEAD 0/8、null/空 namespace 不恢复、两个 round-1 加固无回归钉、CHANGELOG 引用失实：42/42 不可复现、F 编号错挂、-32602 引文不完整、数字字面量再编码低估） | 全部修复：每 chunk 一写、null/空恢复、helper 返回原始字节、两枚回归钉、CHANGELOG 逐项改写并自测数字（61/165/226、9/12/21——后被 r4 修正为 session 内 8/11/19） |
| 3   | 3           | 4（深嵌套测试的 frame 是非法 JSON→walk 从未运行=空转钉、EINVAL 修复无钉、"4176 frames" 单位混用；第三位对抗者 0 发现并附四 case 真实 MCP 全流程 PASS 佐证）                                       | 全部修复：平衡括号的合法深嵌套帧、200k 帧停读压力钉（mutant 红）、单位改写为 2088 data+2088 event=4176 行                                                     |
| 4   | 2           | 1（CHANGELOG 计数把 passing 的 approval-negative session 也算进"失败 case"范围：session 内实为 19/8/11）                                                                                          | 改写范围限定句；第二位对抗者 0 发现（另把四个工具全部过真实 codex、负载 29-37 下压力钉稳定）                                                                  |
| 5   | 1（收敛轮） | **0**（全部 CHANGELOG 数字独立重推导 MATCH；5/5 mutation 钉各自红在目标测试；全 dump 逐帧仿真：165 个无 ns 调用 0 漏恢复、851 个内建调用 0 误路由）                                               | 收敛                                                                                                                                                          |

Mutation 钉矩阵（r5 复验）：walk guard 去除→深嵌套测试红；per-line 写→压力测试红；原始字节 relay 改再编码→invalid-UTF-8 测试红；null/空 ns 恢复回退→null 测试红；歧义跳过去除→映射测试红。

## 门禁输出摘要（全部 exit 0）

- `npm ci` ✓（新 worktree）
- `npm run typecheck` ✓
- `npm test` ✓ — **1488 pass / 0 fail**（2 skip 为既有；含 jscpd 新克隆门、结构门、新增 8 个代理测试）
- `npm run lint` ✓（0 error）
- `npm run lint:dup` ✓（0 新克隆——测试样板已提 `proxyAroundUpstream`/`relayThroughProxy` 去重，未改共享 baseline）
- `npm run validate` ✓；`npm run format:check` ✓
- 运行中的门禁曾 3 次撞上 hook-parity ReDoS 探针的 1000ms 预算在满载机器上超时（干净树同样红，1100ms@load24，证明既有负载 flake 而非本改动引入）——已按最小改动放宽至 5000ms 并记录判别余量（pre-fix 指数形态 14.3s@26 reps，实测重构复测 >7.7s@25 reps；5000 reps 的合法分类 ~0.4s 无载 / 1.1-2.6s 满载）。
- e2e 级验证（真模型+真网关）本地不可行（无 test/e2e/.env）——按任务约定由 run-e2e label 的 PR 承担。

## 遗留与风险

1. **plan_cli 双编码参数残余**（唯一实质残余）：core-approval-positive 的绿最终多依赖一跳模型自我纠正（-32602 指令性错误→重试改对类型）。修复对其是必要条件、对另外三个 case 的形状是充分条件（round-3 真实流程全通）。判定概率高的依据：dump 显示其余三 case 的重试参数类型正确；glm 系对明确类型错误的自愈常见。若 nightly 仍红且 trace 显示 -32602 循环，属模型行为层，需再评估。
2. **多行 SSE data: 帧 / \u 转义的 type 拼写**不恢复——实测网关从不这么发帧（47533/47533 单行；标准序列化不 \u 转义 ASCII），该形状退化为 pre-fix 行为（透传），非损坏。已记录在代码注释与 CHANGELOG。
3. **恢复行再序列化**会重编码数字字面量（1e999→null、>2^53 取整、-0→0）——真实 codex 全部接受（rig 证明）、实测 wire 全是小整数；已记录。
4. 压力钉（200k 帧+3s 停读）在 r4 负载 29-37 下 3 次全绿；理论敏感度已记录（mutant 撕在 ~35k 帧，200k 是 ~5.7x 余量）。
5. codex 0.162.1 rig 观察到的偶发 `mcp__hwc…` 拼接名是零延迟假网关下 codex 侧注册竞态，真实 dump 0 例——不计。

## 跨界影响（共享面最小改动，均为有意为之）

- `test/hook-parity.test.ts`（共享测试基础设施）：ReDoS 探针 TS 预算 1000→5000ms + 注释修正。影响所有在本机跑 `npm test` 的 agent（放宽只会让满载门禁更稳；刀锋判别力经 3 个对抗者独立复测保留）。
- `test/e2e/drivers/gateway-proxy.ts`：codex 腿专属（opencode/hermes driver 不经过它）；对另外两位的 case 无影响。
- `docs/CHANGELOG.md`、`docs/e2e-testing-design.md`：ledger 条目 + 设计文档契约句更新（描述代理的既有 dump 契约从"字节不变"精确为"除 namespace 恢复行"）。
- 未触碰：4 个 case 的期望钉、sandbox 8 case、opencode 2 case、`.jscpd-baseline.json`、产品代码。
- 提醒 integrator：`.jscpd-baseline.json` 未动（本分支把测试样板重构成零新克隆）；若其他 agent 走 baseline 再生路线，无本分支冲突。
