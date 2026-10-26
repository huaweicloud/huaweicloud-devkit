# Issue #1029 任务拆解（本仓 A 部分）

- [x] A1 agent-detect.mjs 兜底收敛（detectAgent / detectAgentHarness → unknown）
- [x] A2 agent-registry.mjs installSegment 用途限定（仅遥测安装位置字段）
- [x] A3 hdkitservice-api.mjs 统一携带 X-HW-Agent 头
- [x] A3 telemetry.mjs 上报 POST 携带 X-HW-Agent 头
- [x] A4 新增 test/issue-1029-agent-attribution.test.mjs；更新 telemetry.test.mjs 兜底断言
- [x] 验证：npm test 838/838 绿；eslint/prettier/validate 通过
- [x] 建 PR（base=dev，关联 Issue #1029，PR 描述互链关联仓 hdkitservice B 部分 PR）
