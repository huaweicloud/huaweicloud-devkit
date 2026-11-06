# Issue #980 任务拆解（task）

- [x] T1 复现与根因核对：sanitizeValue 无脱敏 / redactString 仅大写 AK/SK（对照每日测试评论 D8-9、D2-4）
- [x] T2 编写失败测试（RED）：telemetry 4 用例 + safety-policy 2 用例
- [x] T3 实现 sanitizeValue 脱敏（redactSensitiveText，gi 大小写变体）
- [x] T4 实现 redactString `i` 标志 + isSecretKeyName `^(ak|sk)$`
- [x] T5 全量回归：node --test 810/810 通过
- [x] T6 门禁：npm run validate / prettier 通过
- [x] T7 提交 feat/issue-980 并创建 PR（base dev）
- [x] T8 Issue 评论告知 + A2A 通知 QA 审查
