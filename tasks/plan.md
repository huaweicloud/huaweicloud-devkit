# Issue #866 任务拆解

1. [P0] safety-policy.mjs：Windows `%VAR%` 凭证引用分支 + 测试（RED→GREEN）
2. [P1] tools.mjs：serviceCatalog routeMap 中文同义词扩展 + 测试阈值 0.9（英文不回归）
3. [security] risk-rule-engine.mjs：ANSI-C 引号解码预处理层 + D4-15 测试
4. 全量回归：npm test / npm run lint / npm run validate / pack:verify
5. 五轴自审查 → 建 PR（base dev）→ Issue 评论 → A2A QA
