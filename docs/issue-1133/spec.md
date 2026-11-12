# Spec: Issue #1133 — 确认流程风险预检 + 只读认证源降级

## 背景

1.1.13 每日测试缺陷合并单杀重后剩余两项：

- **D4-19 [P0]** 确认流程（plan → approve → run）只区分写/只读，未合并 `risk-rule-engine` 决策，公网暴露 + 管理员端口组合未被拦截。
- **D3-B3 [P1]** 只读工具把占位 S1/env STS 凭证注入命令行，覆盖可用的 KooCLI profile，返回 `APIGW.0301`。

## 目标

- 规划阶段合并风险规则：命中的高危参数在 plan 中呈现 `blockedByRiskRule` 与 deny finding，并阻断 `run_approved_command`。
- 只读通道在注入凭证鉴权失败时降级到 KooCLI profile，成功返回真实数据；真 STS 成功路径保持不变。

## 范围

In:

- `plugins/huaweicloud-core/src/hcloud-cli.mjs`：`planHcloudCommand` 合并风险决策；`runHcloud` 认证源降级与进程内负缓存。
- `plugins/huaweicloud-core/src/tools.mjs`：`run_approved_command` 对风险 deny 返回结构化拒绝。
- `test/issue-1133-*.test.mjs`：覆盖验收断言。

Out:

- `classifyTextCommand` 一致性（D4-8 / #1055 线）。
- 风险规则增删、CHANGELOG 与发版。

## 验收标准

- [ ] 公网 22 端口安全组规则 plan → `safeToRun=false`、`decision=deny`、`blockedByRiskRule=true`、finding `hwc-network-public-admin-port`（`severity=deny`）。
- [ ] 只读低风险命令 plan → `decision=allow`、`safeToRun=true`、无 `blockedByRiskRule`。
- [ ] warn 级命中不升级 deny，finding 出现在顶层 `warnings`。
- [ ] 风险 deny 的 `run_approved_command` 不执行，返回 `CONFIRM_BLOCKED_BY_RISK_RULE`。
- [ ] 占位 STS + 可用 profile：只读工具 `ok=true`，结果含 `credentialFallback={from:'sts-inject',to:'koocli-profile'}`。
- [ ] 真 STS 成功路径行为不变；失败不静默 allow；凭证保持脱敏。
- [ ] `npm test` / `npm run validate` 通过。
