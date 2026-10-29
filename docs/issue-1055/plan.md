# Issue #1055 修复方案（plan）

## 修改映射

| 缺陷 | 文件 | 修改 |
|------|------|------|
| D4-16 | `safety/rules/cloud-risk-rules.json` | env-dump 正则前缀类 `(^|\s)` → `(^|[^A-Za-z0-9_.-])` 并加 `\b`，命中引号内 `env`/`printenv` |
| D4-3 | `safety/rules/cloud-risk-rules.json` + `safety/policy.json` | secret-value-read 正则与 `blockedSecretOperations` 追加 `DecryptData` |
| D4-21 | `safety/rules/cloud-risk-rules.json` | iam-admin-policy 第 2/3 条件追加 HCL 语法分支（`actions = ["*"]` / `resource "huaweicloud_iam_policy"`） |
| D4-17 | `safety/rules/cloud-risk-rules.json` | 新增 deny 规则 `hwc-command-substitution-exec`（命令替换/反引号 + 管道入解释器） |
| D2-4 | `src/safety-policy.mjs` + `src/risk-rule-engine.mjs` | AK/SK 正则加 `gi`，并用 `(?<![A-Za-z])` 防止 `task=`/`flask=` 误伤 |
| D9-12 | `src/mcp-protocol.mjs` | dispatch 增加 per-session `initializedSessions` 门禁，`tools/list`/`tools/call`/`resources/list` 未初始化抛 -32002 |
| D3-S7 | `src/tools.mjs` serviceCatalog | deploymentIntent 正则命中时把 sandbox 路由并入 matched（部署目标不丢） |
| EXP-E01 | `src/tools.mjs` serviceCatalog | ECS 关键词表追加「云主机」 |
| D2-10 | `src/auth/reconcile.mjs` | `readKooCliProfiles` 的 `error` 字段返回精确英文契约串，中文指引保留在 `messageZh` |
| D3-C14 | `src/sandbox/hdkitservice-api.mjs` + `src/auth/service.mjs` + `src/auth/credentials.mjs` | hdkit 表面无凭证抛精确串 `credentials not configured`；onboarding message 同步契约串 |
| D1-68 | `src/auth/credentials.mjs`（3 处）+ `src/setup-cli.mjs` | region 解析统一 `HUAWEICLOUD_REGION || HW_REGION` |
| D8-9 | `src/telemetry/telemetry.mjs` | `sanitizeValue` 先过 `redactSecrets` 再截断 |

## 验证

- 新增 `test/issue-1055-defects.test.mjs`：12 项契约逐一断言。
- 更新受契约变更影响的既有测试：`test/reconcile.test.mjs`（D2-10）、`test/hdkitservice-api.test.mjs`（D3-C14）、`test/issue-1014-telemetry-flush.test.mjs`（D9-12 时序）。
- 全量 `npm test`（851 用例，仅剩基线即存在的 proxy-agent 环境性失败）、`npm run lint:js`（0 error）、`npm run validate`、`npm run pack:verify` 通过。
