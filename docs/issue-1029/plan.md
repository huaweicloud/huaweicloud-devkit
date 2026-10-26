# Issue #1029 实现方案（本仓 A 部分）

## 改动文件

| 文件 | 改动 |
|------|------|
| `plugins/huaweicloud-core/src/telemetry/agent-detect.mjs` | 删除 `installSegment` 导入与 `|安装段` 兜底拼接；`detectAgent()`/`detectAgentHarness()` 白名单未命中一律返回 `unknown` |
| `plugins/huaweicloud-core/src/telemetry/agent-registry.mjs` | `installSegment()` 加注释限定用途（遥测安装位置字段），禁止进入 agent 名；白名单/matchAgent 不变 |
| `plugins/huaweicloud-core/src/sandbox/hdkitservice-api.mjs` | `hdkitRequest()` 请求头新增 `X-HW-Agent: detectAgent().harness` |
| `plugins/huaweicloud-core/src/telemetry/telemetry.mjs` | 遥测上报 POST 头新增 `X-HW-Agent: agentHarness` |
| `test/telemetry.test.mjs` | 兜底断言 null → `unknown`（含探针名用例） |
| `test/issue-1029-agent-attribution.test.mjs` | 新增：兜底 unknown、白名单仍有效、AGENT_HARNESS 仍生效、X-HW-Agent 头完整性（领券/状态/赛事领券 + 遥测 POST） |

## 兼容性说明

- `AGENT_HARNESS` 环境变量优先级不变（命中即透出）。
- 白名单命中路径（envVars / pathPatterns / clientNames / id 同名）行为不变。
- 既有消费方（keepalive 判断 `harness === 'hermes'` 等）仅依赖白名单值，不受影响。

## 测试策略

- 单测直接断言 harness 值与请求头（本地 http server 捕获 headers）。
- 时间/网络均为确定性输入，无毫秒级相等断言。
