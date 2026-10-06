# Plan: Issue #857

## 改动清单

| # | 文件 | 改动 | 提交 |
|---|------|------|------|
| 1 | plugins/huaweicloud-core/src/safety-policy.mjs | redactString: JSON 分支 + AK/SK /i + 边界 + access_token/sec_token | commit 1 |
| 2 | plugins/huaweicloud-core/safety/policy.json | secretKeyNamePatterns: +access_token +sec_token | commit 1 |
| 3 | plugins/huaweicloud-core/src/risk-rule-engine.mjs | redactEvidence: 同步 /i + JSON 分支 | commit 2 |
| 4 | plugins/huaweicloud-core/src/tools.mjs | routeMap: +云主机/公网IP/云数据库/备份策略/消费/监控/HTTPS证书 + OBS 优先级覆盖 | commit 3 |
| 5 | test/issue-857-redaction.test.mjs | D2-4/D4-27 脱敏回归 | commit 4 |
| 6 | test/issue-857-routing.test.mjs | EXP-E01~E14 路由回归 | commit 4 |
| 7 | test/tools.test.mjs | 更新 static-website 测试为 OBS 优先 | commit 4 |

## 提交策略

- commit 1: fix(safety): JSON credential redaction + AK/SK case-insensitive (D2-4/D4-27)
- commit 2: fix(risk-engine): sync redactEvidence with /i + JSON branch
- commit 3: fix(catalog): add Chinese intent aliases + OBS static-website priority (EXP-E01~E14)
- commit 4: test: add issue-857 redaction + routing regression tests

## 风险

- AK/SK `/i` 误伤（flake/mask/break）→ `(?<![a-z])` 边界防护
- OBS 优先级覆盖影响 sandbox 场景 → 仅 `静态网站`/`静态站点`/`static website`/`static site` 触发，`preview`/`webapp` 仍归 sandbox
