# Plan — Issue #985

## 任务拆解（原子提交粒度）

| #   | 任务                                                          | 文件                                                                                | 提交                                                                    |
| --- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| 1   | huawei-billing 增加「询价能力边界」section                    | `plugins/huaweicloud-core/skills/huawei-billing/SKILL.md`                           | `docs(billing): #985 BSS inquiry boundary section`                      |
| 2   | gaussdb skill 增加 EIP 回收重绑指引 + BSS 询价边界 + 上游跟踪 | `plugins/huaweicloud-core/skills/huawei-cloud-gaussdb-instance-management/SKILL.md` | `docs(gaussdb): #985 EIP rebind + inquiry boundary + upstream tracking` |
| 3   | structure.test.mjs 增加守卫断言                               | `test/structure.test.mjs`                                                           | `test(structure): #985 guard billing/gaussdb inquiry boundary sections` |
| 4   | spec/plan 文档                                                | `docs/issue-985/spec.md`、`docs/issue-985/plan.md`                                  | `docs(issue-985): #985 spec + plan`                                     |

## 验证步骤

1. `npm run lint`（markdownlint + ESLint）
2. `npm test`（node --test，含 structure.test.mjs）
3. `npm run validate`（package/version/skill/kooCli pairing）
4. `npm run format:check`（prettier）

## 风险与回滚

- 改动集中在 skill 文档层，无代码逻辑变更，回滚成本低（revert 单 commit）；
- BSS 询价边界口径必须与 `huawei-iac/references/resource-catalog.md` 一致——以该文件为单一事实源。
