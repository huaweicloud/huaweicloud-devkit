# Spec: deploy_check 结构化结论摘要（Issue #888）

## 目标

`huaweicloud_sandbox_deploy_check` 执行完成后，在现有返回字段（`complete`/`score`/`nextStep`）基础上**新增**结构化结论摘要，供下游编排（#887 sre finalize、#889 发布编排）与人工查阅。

## 输出 Schema（新增字段）

```json
{
  "status": "pass",
  "checks": {
    "nginx": { "ok": true, "detail": "..." },
    "devbridge": { "ok": true, "detail": "..." },
    "url": { "ok": true, "detail": "..." },
    "fingerprint": { "ok": true, "detail": "skipped (SSR proxy)" }
  },
  "publicUrl": "https://<id>-<port>.devbridge-s2.hwtunnel.com",
  "summary": "Deployment complete: ..."
}
```

## 字段定义

| 字段                 | 类型                | 说明                                                                                           |
| -------------------- | ------------------- | ---------------------------------------------------------------------------------------------- |
| `status`             | `"pass"` / `"fail"` | `complete:true`→`pass`；`complete:false`→`fail`                                                |
| `checks.nginx`       | `{ok, detail}`      | 映射现有 `nginx_serving`                                                                       |
| `checks.devbridge`   | `{ok, detail}`      | 映射现有 `devbridge_tunnel`                                                                    |
| `checks.url`         | `{ok, detail}`      | 映射现有 `tunnel_url_accessible`                                                               |
| `checks.fingerprint` | `{ok, detail}`      | 映射现有 `content_verified`；SSR proxy graceful skip → `ok:true, detail:"skipped (SSR proxy)"` |
| `publicUrl`          | `string \| null`    | 隧道公开地址；未建立时 `null`，禁止伪造                                                        |
| `summary`            | `string`            | 一句话摘要：pass 描述四项通过；fail 列出失败项                                                 |

## 向后兼容

- 保留 `complete`、`score`、`nextStep`、`missingSteps`、`remediation` 等现有字段不变
- 现有 `checks` 原始键（`nginx_serving` 等）保留，新增 `nginx`/`devbridge`/`url`/`fingerprint` 结构化键共存于同一对象
- `publicUrl` 未建立时由 `undefined` 收敛为 `null`（语义更明确，无消费方依赖 `undefined`）

## 实现范围

- `plugins/huaweicloud-core/src/sandbox/session-manager.mjs`：`deployCheck` 透传 `frameworkType`；`parseDeployCheckOutput` 组装结构化结论
- `plugins/huaweicloud-core/src/tools.mjs`：deploy_check 工具描述补充结构化结论说明
- `plugins/huaweicloud-core/skills/huawei-sandbox/SKILL.md`：文档化新增字段
- `test/session-manager.test.mjs`：新增断言（pass/fail/SSR skip/publicUrl null）

## 验收

- [x] status: pass/fail（映射 complete）
- [x] checks: nginx/devbridge/url/fingerprint 各 {ok, detail}，fingerprint SSR proxy graceful skip
- [x] publicUrl（null 禁伪造）+ summary 一句话摘要
