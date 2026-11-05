# Issue #1040 plan

1. `plugins/huaweicloud-core/src/telemetry/agent-detect.mjs`
   - `AGENT_HARNESS` 仅在命中 AGENTS 白名单时生效，未命中走白名单匹配，最终兜底 `unknown`。
   - 删除 `installSegment` 拼接与 `clientInfo.name` 透传；`detectAgentHarness()` 兜底返回
     `'unknown'`（原 null）。
2. `plugins/huaweicloud-core/src/telemetry/agent-registry.mjs`
   - `installSegment()` 注释明确仅用于遥测安装位置字段；白名单与 matchAgent 不变。
3. `plugins/huaweicloud-core/src/telemetry/telemetry.mjs`
   - `buildEvent()` 增加 `installSegment` 字段（安装位置，sanitized，非白名单场景仍有值）。
   - `performFlush()` 请求头增加 `X-HW-Agent: agentHarness || 'unknown'`。
4. `plugins/huaweicloud-core/src/sandbox/hdkitservice-api.mjs`
   - `hdkitRequest()` 请求头增加 `X-HW-Agent: detectAgent().harness`。
5. 测试
   - 更新 `test/telemetry.test.mjs`：nothing-matches 断言从 null 改为 'unknown'。
   - 新增 `test/issue-1040-agent-unknown.test.mjs`：兜底 unknown / 探针名归 unknown /
     AGENT_HARNESS 未命中归 unknown / hdkitRequest 与 telemetry flush 的 X-HW-Agent 头。
   - 运行 `npm test`、`npm run lint`、`npm run validate`。
