# Spec: Issue #887 — Automate deploy_check at sre skill finalize phase

> Source: Issue Agent Spec (https://github.com/huaweicloud/huaweicloud-devkit/issues/887#issuecomment-6123165950) | Developability: ready | 2026-10-12

## Objective

在 sandbox 部署 skill 的 finalize 阶段强制自动执行 `huaweicloud_sandbox_deploy_check`（从「推荐步骤」升级为「强制收尾步骤」）；`complete: false` 则终止流程不返回 URL。

## Scope

- **In**: `plugins/huaweicloud-core/skills/huawei-sandbox/SKILL.md` Workflow 步骤 10 之后新增强制收尾步骤（含 MANDATORY 标注）；Deployment Completion Check 章节守门语义强化；Pitfalls 表对应守门规则对齐。
- **Out**: #888 结论摘要字段扩展、#889 发布编排接入、deploy_check 工具返回值结构修改、DevBridge/nginx 部署实现逻辑。

## Acceptance Criteria

1. Workflow 步骤 10 之后存在显式强制 deploy_check 收尾步骤（MANDATORY 标注）
2. `complete: true` 方可返回 URL；`complete: false` 终止流程不返回 URL
3. Deployment Completion Check 与 Pitfalls 守门规则语义一致无矛盾
4. 全流程无需人工触发 deploy_check
5. 所有现有测试通过；新增测试覆盖（文档守门校验用例同步更新）
