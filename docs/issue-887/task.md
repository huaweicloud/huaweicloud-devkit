# Task: Issue #887

- [x] T1 阅读现有 SKILL.md，定位 Workflow 步骤 10 / Deployment Completion Check / Pitfalls 三处
- [x] T2 Workflow 新增步骤 11（MANDATORY finalize，自动调用，complete:false 终止不返回 URL）
- [x] T3 Deployment Completion Check 章节升级为强制门控语义（Hard gate semantics 段）
- [x] T4 Pitfalls 两行 + Activation + Tool Selection Guide 对齐（消除推荐式表述）
- [x] T5 test/structure.test.mjs 新增守门测试（步骤顺序/语义/Pitfalls 一致性）
- [x] T6 验证：npm test / lint / validate / format:check 全通过
- [x] T7 提交推送 feat/issue-887，创建 PR，Issue 评论告知，A2A QA
