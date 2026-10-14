# Issue #911 任务拆解（Task）

| #   | 任务                                                                                              | 状态 |
| --- | ------------------------------------------------------------------------------------------------- | ---- |
| 1   | 走查 `queryDistTagsFetch` 全部调用点，确认默认值变更影响面                                        | 完成 |
| 2   | 修改 `queryDistTagsFetch`：传 `signal`、默认 `timeoutMs=5000`、`errorText` 安全字符串化           | 完成 |
| 3   | `test/update-check.test.mjs` 新增超时/日志边界用例（慢服务器 + fetch mock 无 message 拒绝值方案） | 完成 |
| 4   | 运行 `node --test test/update-check.test.mjs` + `npm run lint` + `npm run validate`               | 完成 |
| 5   | 自审查（5 轴）→ 原子提交 → push `feat/issue-911`                                                  | 完成 |
| 6   | 创建 PR（base=dev）→ Issue 评论告知 → A2A QA → tasks complete                                     | 完成 |
| 7   | PR #912 审查修复：setup-cli.mjs 调用点走 5s 默认值、errorText JSON 分支真实覆盖、Prettier 格式化  | 完成 |
