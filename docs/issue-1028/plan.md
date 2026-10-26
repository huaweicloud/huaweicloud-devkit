# Issue #1028 Plan（本仓 A 部分）

## 改动清单

| # | 文件 | 改动 | 对应 |
|---|------|------|------|
| 1 | `plugins/huaweicloud-core/src/telemetry/agent-detect.mjs` | 移除 `installSegment` 导入与拼接；两函数未命中时返回 `unknown` | A1 |
| 2 | `plugins/huaweicloud-core/src/telemetry/agent-registry.mjs` | `installSegment()` 注释限定仅作遥测安装位置字段 | A2 |
| 3 | `plugins/huaweicloud-core/src/sandbox/hdkitservice-api.mjs` | `hdkitRequest` 请求头增加 `X-HW-Agent: detectAgent().harness` | A3 |
| 4 | `plugins/huaweicloud-core/src/telemetry/telemetry.mjs` | 遥测 POST 头增加 `X-HW-Agent: agentHarness \|\| 'unknown'` | A3 |
| 5 | `test/telemetry.test.mjs` | 未命中断言改 `unknown`；新增探针名/兜底/无安装段用例；flush 测试断言 `x-hw-agent` 头 | A4 |
| 6 | `test/hdkitservice-api.test.mjs` | 新增 `X-HW-Agent` 头用例（默认 `unknown` + `AGENT_HARNESS` 覆盖） | A4 |
| 7 | `test/structure.test.mjs` | 守卫：agent-detect 禁用 installSegment；api/telemetry 必含 X-HW-Agent | A4 |

## 兼容性说明

- `detectAgentHarness` 未命中返回值由 `null`/裸名称改为 `'unknown'`：
  调用方 `mcp-protocol.mjs`（经 `detectAgent`）与 `mcp-server.mjs`
  keepalive 判断（仅与 `=== 'hermes'` 比较）不受影响。
- 服务端归一化（B 部分）负责把 `unknown` 与历史污染值收敛。

## 验证

```bash
npm test          # 837 pass
npm run lint:js   # 0 errors
npm run validate  # 29 skills, KooCLI 7.3.12
npm run pack:verify
```
