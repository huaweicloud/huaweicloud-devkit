# task: D9-12 / D4-17 执行清单

- [x] D9-12: mcp-protocol.mjs 增加握手状态机（per-session）+ -32002 门禁
- [x] D9-12: 既有 dispatch 直连测试补 initialize 握手（issue-1014-telemetry-flush）
- [x] D4-17: cloud-risk-rules.json 新增 hwc-command-substitution-exec deny 规则
- [x] D4-17: risk-rule-engine.mjs 替换体内容展开进匹配文本
- [x] D4-17: risk-rule-engine.mjs 嵌套替换 fail-closed 合成 deny 发现
- [x] 新增回归测试 test/issue-1055-d912-d417.test.mjs（D9-12×5 + D4-17×6）
- [x] 全量 npm test / lint / validate / pack:verify 通过
