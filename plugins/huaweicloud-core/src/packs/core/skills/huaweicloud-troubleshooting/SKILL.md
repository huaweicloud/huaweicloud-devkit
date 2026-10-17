---
name: huaweicloud-troubleshooting
description: Troubleshoot Huawei Cloud CLI, API, SDK, deployment, permission, region, quota, endpoint, and resource errors. Use when commands fail, APIs return errors, resources are missing, or the user needs a structured diagnosis.
---

# Huawei Cloud Troubleshooting

**STOP - Do not answer from general knowledge.** Follow the procedure below.

Use evidence before fixes. Do not guess service behavior when request IDs, region, project_id, and exact errors can identify the issue.

## Critical Warnings

| Trap                                    | Why                                                                                                                  |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Error in response body, not HTTP status | Many APIs return HTTP 200 with error in JSON body. Always check `error_code` and `error_msg`                         |
| Missing `project_id` is common          | New users often omit project_id from API path or CLI. Get it from `IAM KeystoneListProjects`                         |
| Sandbox may block hcloud                | OpenCode/Codex sandbox can block hcloud metadata files in `~/.hcloud/`. Use `dangerouslyDisableSandbox` or Bash tool |
| KooCLI param prefix varies              | VPC params need `--vpc.x`, ECS params need `--server.x`, ALWAYS check `--help` first                                 |

## Workflow

1. Capture the redacted error message, service, operation, region, project_id, and request_id.
2. Classify likely cause:
   - auth or permission
   - wrong region or endpoint
   - wrong project_id
   - missing resource
   - quota or account limit
   - invalid request body
   - service-side failure
3. Run the smallest read-only check that can prove or disprove the cause.
4. Compare with official API/SDK docs or Huawei Cloud Skills if the operation contract is uncertain.
5. Propose one fix at a time.
6. Verify with read-only observation after the fix.

## Common Checks

| Check                      | Command                                                                                                                                                                                                                                                                                                                       |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authentication             | `hcloud configure list` (redacted)                                                                                                                                                                                                                                                                                            |
| Region                     | Match CLI region, endpoint, and resource region                                                                                                                                                                                                                                                                               |
| Project ID                 | `hcloud IAM KeystoneListProjects`                                                                                                                                                                                                                                                                                             |
| Pagination                 | Add `--limit=100` and check `marker`                                                                                                                                                                                                                                                                                          |
| Quota                      | Check service quotas in console or API                                                                                                                                                                                                                                                                                        |
| IAM Permission             | Verify user/role has required action — see `huawei-iam` skill                                                                                                                                                                                                                                                                 |
| KooCLI version             | `hcloud version`                                                                                                                                                                                                                                                                                                              |
| Public IP (outbound)       | **必须绕过系统代理 + 多源交叉验证**：PowerShell `Invoke-WebRequest` 会走系统代理返回代理出口 IP（实测 167.x vs 真实 117.x，SSH 白名单放错 IP）。正确姿势：`node -e "fetch('https://cip.cc').then(r=>r.text()).then(console.log)"`（node 直连国内源，不继承 IE 代理）+ `curl --noproxy '*' ifconfig.me` 交叉比对；不一致即告警 |
| SSH 超时但安全组规则"正确" | 先怀疑探测到的公网 IP 走了代理 → 按上行方法重取真实出口 IP，删旧规则加新规则                                                                                                                                                                                                                                                  |

## Common Error Codes

| Error                                   | Likely Cause                                                                 | Fix                                                                                            |
| --------------------------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| AuthFailure / 401                       | AK/SK invalid or expired                                                     | Regenerate AK/SK, re-run `npx huaweicloud-devkit auth init`                                    |
| AccessDenied / 403                      | IAM permission missing                                                       | Check `huawei-iam` skill, add required policy action                                           |
| NoSuchKey / 404                         | Resource not found                                                           | Verify resource ID, region, and project_id                                                     |
| QuotaExceeded                           | Account limit reached                                                        | Request quota increase in console                                                              |
| [USE_ERROR] 不正确的参数                | Wrong param name                                                             | Run `--help`, check `--param=value` format and nested prefix                                   |
| `[USE_ERROR]缺少必填参数 cli-domain-id` | Invalid/expired credentials — KooCLI's account-id lookup failed (APIGW.0301) | Re-run `npx huaweicloud-devkit auth init`; KooCLI auto-resolves domain-id once creds are valid |
| Ecs.0005                                | Flavor-image mismatch                                                        | Check image `__support_*` against flavor virtualization type                                   |
| FSS.0400                                | FunctionGraph latest version error                                           | Strip `:latest` from function URN                                                              |
| FSS.1417                                | DEDICATEDGATEWAY missing params                                              | Add instance_id, group_id, protocol, env_name, env_id                                          |
| APIC.7201                               | Missing security_group_id                                                    | Add `--security_group_id` param for APIG CreateInstanceV2                                      |
| [NETWORK_ERROR]                         | Transient network failure                                                    | Retry with `maxRetries` param or wait and retry                                                |

## KooCLI Error Types

KooCLI classifies errors into 5 types. The error type prefix in the message guides initial diagnosis:

| Type              | Meaning                      | First Check                                           |
| ----------------- | ---------------------------- | ----------------------------------------------------- |
| `[NETWORK_ERROR]` | HTTP request exception       | Network connectivity, firewall, endpoint reachability |
| `[CLI_ERROR]`     | KooCLI internal error        | Contact KooCLI support                                |
| `[USE_ERROR]`     | Incorrect command parameters | Run `--help`, check param names and format            |
| `[OPENAPI_ERROR]` | Cloud service API error      | Check service docs, contact service support           |
| `[APIE_ERROR]`    | API Explorer metadata error  | Contact API Explorer support                          |

Enable debug with `--cli-debug=true` to see the underlying HTTP request/response and pinpoint network or endpoint issues.

## Cross-Skill References

- **IAM permissions**: See `huawei-iam`
- **CLI auth setup**: See `huaweicloud-cli-and-auth`
- **ECS specific errors**: See `huawei-ecs`
- **FunctionGraph specific**: See `huawei-functiongraph`
