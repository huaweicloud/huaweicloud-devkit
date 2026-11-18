# plan: D9-12 / D4-17 修复方案（dev 基线）

## 分支与 PR 策略

- 开发分支：`fix/issue-1055-d912-d417`（基于最新 origin/dev）。
- **不复用 `feat/issue-1055`**：该分支名已被 open PR #1056（12 项合并修复）占用为
  head 分支；向其推送会污染/重写该 PR。独立分支 → 独立 PR（base: dev），
  与 #1056 合入顺序解耦（同文件冲突由人工按先合者为准裁决，与 #1056 ↔ #1084 先例一致）。

## D9-12 方案（mcp-protocol.mjs）

| 步骤 | 内容                                                                                                                                                                    |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | 模块级 `initializedSessions: Set` 握手状态机，按 sessionId 记录 initialize 完成态；导出 `_resetInitializedSessions()` 供测试复位                                        |
| 2    | `dispatch('initialize')` 成功路径 `initializedSessions.add(sessionId)`                                                                                                  |
| 3    | `tools/list` / `tools/call` / `resources/list` 分支前统一门禁：未握手 → 抛 `code = -32002`（MCP 生命周期：Server not initialized）；未知方法仍走 -32601，不改变既有语义 |
| 4    | 既有直连 dispatch 的测试补 initialize 握手（issue-1014-telemetry-flush）                                                                                                |

## D4-17 方案（规则 + 引擎双层）

| 层                           | 内容                                                                                                                                                                                                                                                                            |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 规则层 cloud-risk-rules.json | 新增 deny 规则 `hwc-command-substitution-exec`（stages: command）。`all`: 文本含命令替换 `$(`（排除算术 `$((`）或反引号对，或含 `curl/wget`；`any`: 分隔符 `\|;&&` 后紧跟 shell 解释器（bash/sh/zsh/dash/ksh/python/node/powershell/pwsh，可带 sudo）。双 Node/Python hook 生效 |
| 引擎层 risk-rule-engine.mjs  | ① command 阶段提取替换体内命令追加到匹配文本（识别动态执行内容，内层载荷可被既有规则命中）；② 嵌套替换（替换体内再含 `$(`/反引号）静态不可解析 → 合成 deny 发现（ruleId 同名，fail-closed），仅当尚无 deny 发现时追加，不覆盖既有更高优先级语义                                 |

## 测试计划（TDD）

新增 `test/issue-1055-d912-d417.test.mjs`：

- D9-12：未握手 tools/list/tools/call/resources/list → -32002；握手后正常；会话隔离；reset 复位。
- D4-17：三种替换/远程执行形态 deny + ruleId 断言；嵌套替换 fail-closed；替换体内层
  载荷命中 credential 规则；三个 allow 误伤回归。

## 验证

- `node --test test/issue-1055-d912-d417.test.mjs`（新增，全过）
- 全量 `npm test`（关注 risk-rule-engine / safety-policy / mcp-server / plugins-e2e / hook-*）
- `npm run lint`、`npm run validate`、`npm run pack:verify`
