# Issue #911 任务拆解（Task）

| # | 任务 | 状态 |
|---|------|------|
| 1 | 走查 `queryDistTagsFetch` 全部调用点，确认默认值变更影响面 | 待办 |
| 2 | 修改 `queryDistTagsFetch`：传 `signal`、默认 `timeoutMs=5000`、`errorText` 安全字符串化 | 待办 |
| 3 | `test/update-check.test.mjs` 新增 3 条超时/日志边界用例（慢服务器方案） | 待办 |
| 4 | 运行 `node --test test/update-check.test.mjs` + `npm run lint` + `npm run validate` | 待办 |
| 5 | 自审查（5 轴）→ 原子提交 → push `feat/issue-911` | 待办 |
| 6 | 创建 PR（base=dev）→ Issue 评论告知 → A2A QA → tasks complete | 待办 |
