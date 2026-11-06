# Issue #992 — 任务拆解

## 任务清单

| #   | 任务                                                                      | 文件                                    | 状态 |
| --- | ------------------------------------------------------------------------- | --------------------------------------- | ---- |
| 1   | 撰写「浏览器直传（BrowserJS SDK）」章节（需求 1–5，含最小修复片段）       | `references/common-pitfalls.md`（追加） | ☐    |
| 2   | 撰写「CORS 配置」章节（需求 6：KooCLI 缺口 + 两条替代路径）               | `references/common-pitfalls.md`（追加） | ☐    |
| 3   | SKILL.md description 补触发词 + References 补 common-pitfalls.md 链接     | `SKILL.md`                              | ☐    |
| 4   | 7 条 grep 验收逐条自测                                                    | —                                       | ☐    |
| 5   | `npm run lint` + `npm test` + `npm run format:check` + `npm run validate` | —                                       | ☐    |
| 6   | 原子提交 → push → 建 PR（base=dev，关联 #992）                            | git                                     | ☐    |
| 7   | Issue 评论告知 + A2A QA                                                   | grape CLI                               | ☐    |

## 提交策略

- 单一原子提交：`feat: #992 huawei-obs 浏览器直传避坑与 CORS 配置指引`（skill 文档变更整体是一个语义单元）
- PR body 注明 `fixes #992`（GitHub 自动关联关闭）

## 验收 checklist（7 条 grep + lint）

- [ ] `grep -c 'x-amz-security-token' common-pitfalls.md` ≥ 1
- [ ] 同文件含 `is_signature_negotiation` / `signatureContext` / `?apiversion`
- [ ] CORS 示例 AllowedMethod 同时含 GET/PUT/POST/DELETE/HEAD
- [ ] 含 OPTIONS 预检诊断命令（`Access-Control-Request-Method` 字样）
- [ ] `grep setBucketCors` ≥ 1 且含 `PUT /?cors`
- [ ] KooCLI 无 cors 子命令的说明可 grep 命中
- [ ] `grep -c '浏览器直传' SKILL.md` ≥ 1
- [ ] `npm run lint` 退出码 0
