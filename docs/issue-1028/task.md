# Issue #1028 Task（本仓 A 部分）

- [x] A1 agent-detect：删除安装段拼接，未命中/探针名归 `unknown`
- [x] A2 agent-registry：`installSegment` 限定遥测安装位置用途
- [x] A3 hdkitservice 全调用 + 遥测上报携带 `X-HW-Agent` 头
- [x] A4 单测：telemetry / hdkitservice-api / structure 守卫
- [x] `npm test` 837 pass；lint:js / validate / pack:verify 通过
- [x] 文档：docs/issue-1028/{spec,plan,task}.md
- [ ] PR base=dev 创建并关联 Issue #1028（含跨仓 B 部分说明与互链占位）
- [ ] A2A QA 审查
