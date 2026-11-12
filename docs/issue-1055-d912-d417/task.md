# task: D9-12 / D4-17 执行清单

- [x] D9-12: mcp-protocol.mjs 增加握手状态机（per-session）+ -32002 门禁
- [x] D9-12: 既有 dispatch 直连测试补 initialize 握手（issue-1014-telemetry-flush）
- [x] D4-17: cloud-risk-rules.json 新增 hwc-command-substitution-exec deny 规则
- [x] D4-17: risk-rule-engine.mjs 替换体内容展开进匹配文本
- [x] D4-17: risk-rule-engine.mjs 嵌套替换 fail-closed 合成 deny 发现
- [x] 新增回归测试 test/issue-1055-d912-d417.test.mjs（D9-12×5 + D4-17×6）
- [x] 全量 npm test / lint / validate / pack:verify 通过

## PR #1093 审查反馈追加（2026-11-04）

- [x] 规则 any 条件补解释器形态：python3/ruby/perl/php/lua/路径前缀/`-c` 解释器参数、`bash $(...)`、`eval \"$(...)\"`（原仅覆盖 `| sh` 管道形态）
- [x] risk-rule-engine.mjs 嵌套探测补算术外壳：`$(( $(...) ))` 内含 `$(`/反引号即 fail-closed
- [x] huaweicloud-safety.py 同步嵌套/算术外壳 fail-closed（Python hook 与 Node 引擎语义一致）
- [x] 回归用例补 5 组（Node 引擎/MCP check_command/Python hook 三层 + 误伤回归）
