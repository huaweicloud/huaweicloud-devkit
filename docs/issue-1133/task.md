# Tasks: Issue #1133

- [x] 红：新增 `test/issue-1133-risk-preflight-credential-fallback.test.mjs`
  - plan 公网管理员端口 deny + finding
  - 只读低风险 allow 回归
  - warn 不升级 deny 且进入 warnings
  - run_approved_command 风险 deny 不执行
  - D3-B3 注入失败回退 profile、负缓存、真 STS 成功不变、真失败不静默 allow
- [x] 绿：`planHcloudCommand` 合并 `evaluateCommandRisk` / `mergeRiskDecision`
- [x] 绿：`runApprovedCommand` 风险 deny 结构化拒绝
- [x] 绿：`runHcloud` 认证源降级重试 + 负缓存 + 凭证脱敏
- [x] 验证：`node --test test/issue-1133-*.test.mjs`、`npm test`、`npm run validate`、`npm run lint:js`
