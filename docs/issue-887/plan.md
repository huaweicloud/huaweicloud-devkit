# Plan: Issue #887

## 方案概述

在 `plugins/huaweicloud-core/skills/huawei-sandbox/SKILL.md` 的部署 finalize 阶段（Workflow 步骤 10 之后）嵌入 deploy_check 强制自动调用：部署暴露完成后必须调用 `huaweicloud_sandbox_deploy_check`，`complete: true` 方可返回 URL；`complete: false` 则终止流程并按 `nextStep` 引导修复。

## 改动点

| #   | 位置                             | 改动                                                                                                                                                                                                   | 提交       |
| --- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------- |
| 1   | Workflow 章节                    | 新增「步骤 11 — Deployment completeness check（MANDATORY finalize step — do not skip）」：自动调用、complete:true 为返回 URL 的唯一条件、complete:false 终止流程不返回 URL                             | 原子提交 1 |
| 2   | Deployment Completion Check 章节 | 标题升级为 `[REQUIRED — hard gate, not a recommendation]`；正文从推荐表述升级为强制门控（非可跳过、非人工触发），新增「Hard gate semantics」段                                                         | 原子提交 1 |
| 3   | Pitfalls 表                      | 「Call deploy_check before success」「Deploy is not just nginx」两条与步骤 11 呼应，消除矛盾；Activation「Deployment must end with a public URL」补 deploy_check 门控；Tool Selection Guide 对应行同步 | 原子提交 1 |
| 4   | test/structure.test.mjs          | 新增守门测试：步骤 11 存在且位于步骤 10 之后、MANDATORY/automatically/complete 语义、Hard gate 语义、Pitfalls 行对齐（无 "Always call" 推荐式残留）                                                    | 原子提交 2 |

## 验证

- `npm test`（565 通过，含新增守门测试）
- `npm run lint`（markdownlint + ESLint 0 issues）
- `npm run validate` + `npm run format:check`
