# Issue #1040 spec：agent 识别兜底收敛 unknown + 对外请求统一 X-HW-Agent 头

## 背景

/dashboard/agent/distribution 出现 `startup|plugins`、`test|.npm/...` 等 `|` 污染 agent 名。
根因：`detectAgent()` 白名单未命中时兜底拼接 `clientInfo.name|installSegment()`，探针类
clientName（startup/voucher-claim*/test*）与安装目录段一起进入了 harness 字段。

## 需求（A 线，devkit 仓）

- A1 `agent-detect.mjs`：白名单/AGENT_HARNESS 未命中时不拼接安装段；`detectAgent()` 与
  `detectAgentHarness()` 的 harness 一律返回 `unknown`；探针类 clientName 同样归 `unknown`。
- A2 `agent-registry.mjs`：`installSegment()` 仅用于遥测安装位置字段（telemetry 事件独立
  字段 `installSegment`），不进入 agent 名；AGENTS 白名单与 matchAgent 规则不变。
- A3 对外请求统一携带 `X-HW-Agent: <detectAgent().harness>` 头：
  - `hdkitservice-api.mjs` 的 `hdkitRequest()`（领券、check-user、sandbox 等全部 hdkitservice 调用）
  - `telemetry.mjs` 的 `performFlush()`（遥测上报，值取 initTelemetry 缓存的 harness，即
    detectAgent 结果）
- A4 单测：detect 兜底归 unknown、X-HW-Agent 头完整性（node --test 绿）。

## 验收

- agent 名不再出现 `|` 污染；installSegment 不进入 agent 名。
- 所有 hdkitservice 对外调用携带 X-HW-Agent 头。
- node --test 相关用例通过。
- PR base=dev，PR 描述引用关联仓 hdkitservice 对应 PR。
