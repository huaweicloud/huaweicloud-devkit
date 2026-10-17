# Plan: Issue #888 deploy_check 结构化结论摘要

## 改动点

1. `session-manager.mjs`
   - `deployCheck()`：`parseDeployCheckOutput(stdout, { port, isCrossPlatform, frameworkType })` 透传 frameworkType
   - `parseDeployCheckOutput()`：新增结构化结论组装（status/结构化 checks/publicUrl:null/summary）
2. `tools.mjs`：`huaweicloud_sandbox_deploy_check` 描述补充结构化结论字段说明
3. `skills/huawei-sandbox/SKILL.md`：Deployment Completion Check 章节文档化新增字段
4. `test/session-manager.test.mjs`：新增 4 个测试（pass 汇总 / fail 汇总 / SSR skip / 无隧道 publicUrl null）

## 映射规则

| 结构化键    | 原始键                | 规则                                                                                                                                                            |
| ----------- | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| nginx       | nginx_serving         | PASS→ok:true；FAIL→ok:false；detail 取原始 detail                                                                                                               |
| devbridge   | devbridge_tunnel      | 同上                                                                                                                                                            |
| url         | tunnel_url_accessible | 同上                                                                                                                                                            |
| fingerprint | content_verified      | PASS/FAIL 同上；SKIP 或缺失且 frameworkType=ssr → ok:true, "skipped (SSR proxy)"；其他 SKIP → ok:true, "skipped (<原因>)"；缺失 → ok:false "check not reported" |

- `status = complete ? 'pass' : 'fail'`
- `publicUrl = tunnelMatch ? url : null`
- `summary`：pass → "Deployment complete: nginx serving, DevBridge tunnel active, tunnel URL accessible, fingerprint verified."；fail → "Deployment check failed: <失败项> (nextStep: <nextStep>)"

## 风险

- 与 PR #891（#887）sandbox 区域潜在重叠：本改动为纯增量字段，基于最新 dev 解析，冲突面小
- 时间字段断言规范：本改动无时间字段，无偶发风险

## 验证

`npm test`（全量）+ `npm run lint` + `npm run validate`
