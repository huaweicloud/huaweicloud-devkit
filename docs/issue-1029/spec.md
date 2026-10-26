# Issue #1029 本仓 A 部分：agent 识别兜底收敛 + 对外请求携带 X-HW-Agent

## 背景

看板「agent 接入分布」与用户/领券数据对不上：现网约 73% 遥测记录的 agent 名被安装段污染
（`startup|plugins` 5045、`test|.npm/...` 等），且领券链路不携带 agent 身份，无法按 agent 归因。

关联仓 B 部分（huaweicloud-mate/hdkitservice）：服务端归一化、用户口径统计、领券落库 agent。

## 根因（本仓）

1. `agent-detect.mjs` `detectAgent()`：白名单/envVar 未命中时兜底拼接 `${clientInfo.name}|${installSegment()}`，
   把探针名/安装路径当 agent 名上报。
2. `detectAgentHarness()`：兜底裸返 `clientInfo.name`，为第二污染出口。
3. 全仓无 `X-HW-Agent` 请求头设置点，服务端无法按 agent 归因领券等请求。

## 需求（A1-A4）

- A1 `detectAgent()` / `detectAgentHarness()`：白名单/AGENT_HARNESS 未命中时 harness 一律返回
  `unknown`；`startup` / `voucher-claim*` / `test*` 等探针类 clientName 同样归 `unknown`；
  删除 `|安装段` 拼接。
- A2 `agent-registry.mjs` `installSegment()`：仅保留用于遥测安装位置字段，禁止进入 agent 名
  （AGENTS 白名单与 matchAgent 规则不变）。
- A3 对外请求统一携带 `X-HW-Agent: <detectAgent().harness>`：
  - `hdkitservice-api.mjs` `hdkitRequest()`（覆盖领券 huaweicloud_voucher_claim /
    huaweicloud_competition_voucher_claim、check-user、connect 等全部 hdkitservice 调用）
  - `telemetry.mjs` 遥测上报 POST
- A4 单测：detect 兜底返 unknown、白名单不受影响、X-HW-Agent 头完整性；`node --test` 全绿。

## 验收

- 白名单未命中的任何 clientInfo（含探针名）→ harness = `unknown`，不含 `|`、不含路径段。
- 所有 hdkitservice 请求与遥测 POST 均携带 `X-HW-Agent` 头，值为白名单 agent id 或 `unknown`。
- `npm test` / `npm run lint` / `npm run validate` 通过。

## 范围外

代金券月度额度（HD.60630042）、未实名引导（HD.60630022）、赛事报名 C1 重试——另立 issue。
