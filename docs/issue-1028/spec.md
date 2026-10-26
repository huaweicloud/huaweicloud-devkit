# Issue #1028 Spec（本仓 A 部分）

看板 agent 分布统计口径与用户对不上 + 领券→agent 无法归因（跨仓：devkit + hdkitservice）。

## 问题

1. `plugins/huaweicloud-core/src/telemetry/agent-detect.mjs` 在白名单/envVar 未命中时，
   兜底把 `clientInfo.name` 与安装路径段拼接为 harness（`${base}|${seg}`），
   安装路径被当作 agent 名上报，造成现网 ~73% 污染（如 `startup|plugins` 5045 条）。
2. 全仓无 `X-HW-Agent` 请求头设置点，领券（`huaweicloud_voucher_claim`）等
   hdkitservice 调用无法按 agent 归因。

## 范围（本仓 A 部分）

- A1 `agent-detect.mjs`：删除 `|安装段` 兜底拼接；白名单/`AGENT_HARNESS` 未命中时
  harness 一律返回 `unknown`；`startup`、`voucher-claim*`、`test*` 等探针类
  clientName 同样归 `unknown`；`detectAgentHarness()` 的 `clientInfo.name`
  裸返回路径同步收敛为 `unknown`。
- A2 `agent-registry.mjs`：`installSegment()` 仅用于遥测安装位置字段，
  禁止进入 agent 名；AGENTS 白名单与 matchAgent 规则不变。
- A3 对外请求统一携带 `X-HW-Agent: <detectAgent().harness>` 头
  （`hdkitservice-api.mjs` 的 `hdkitRequest` 覆盖领券/沙箱/check-user 等全部调用，
  `telemetry.mjs` 的遥测上报 flush）。
- A4 单测：detect 兜底返 `unknown`（白名单外 clientInfo + 探针名）、
  `X-HW-Agent` 头完整性（hdkitservice 请求 + 遥测 POST），
  `test/structure.test.mjs` 增加守卫（agent-detect 禁用 installSegment、
  hdkitservice-api/telemetry 必须含 X-HW-Agent）。

## 跨仓 B 部分（不在本仓实施）

`huaweicloud-mate/hdkitservice`：`normalizeAgentName` 归一化、
`agentDistribution()` 改 `COUNT(DISTINCT user_hash)`、`voucher_record`
增加 `agent_name` 落库、读 `X-HW-Agent` 头。两仓 PR 建好后互链；
仅建其一为 BLOCKED。

## 验收

- `npm test` 全绿（含新增 #1028 用例）。
- `npm run lint:js`、`npm run validate`、`npm run pack:verify` 通过。
