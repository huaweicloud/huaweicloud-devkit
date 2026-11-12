# Plan: Issue #1133

## 方案

### D4-19 风险决策合并

- 唯一规划入口 `planHcloudCommand` 在写/只读分类后调用 `evaluateCommandRisk`，用 `mergeRiskDecision` 与安全组预检结果合并。
- deny：设置 `decision=deny`、`risk=category`、`reason=topFinding.message`、`blockedByRiskRule=true`、`findings`。
- warn：不升级 decision，finding 以 `severity: [ruleId] message` 写入顶层 `warnings`。
- `safeToRun` 由合并后的 decision 推导。
- `run_approved_command` 在 token 消费后、执行前检查 `blockedByRiskRule && decision===deny`，返回结构化拒绝，保持 token 一次性语义。

### D3-B3 认证源降级

- `runHcloud` 记录注入前的原始参数与 STS 注入指纹。
- 注入执行失败且错误码匹配 `APIGW|AKM|IAM|HDKIT_CRED` 或错误信息含鉴权失败关键词时，去掉注入重试一次，KooCLI 回退 `current` profile。
- 成功标注 `credentialFallback={from:'sts-inject',to:'koocli-profile'}`；两次失败返回降级结果并附 `firstAttempt` 诊断。
- 同进程按注入参数指纹负缓存，后续调用直接跳过注入。
- `result.plan.rawArgs` 继续走 `redactArgsWithObs` 脱敏。

## 关键决策

| 决策         | 选择                    | 理由                                |
| ------------ | ----------------------- | ----------------------------------- |
| 风险合并位置 | `planHcloudCommand`     | plan/approve/run 共享同一判定       |
| 认证源策略   | 失败后降级重试          | 避免每次冷调用额外 IAM 往返         |
| 占位凭证识别 | 不按结构识别            | 真实 AK 无固定前缀，结构匹配会误杀  |
| 降级失败返回 | 降级结果 + firstAttempt | 保留可排障信息，不误导 profile 可用 |

## 影响

`hcloud-cli.mjs`（修改）、`tools.mjs`（小改）、`risk-rule-engine.mjs` 与 `cloud-risk-rules.json`（复用，不改）、新增测试文件。
