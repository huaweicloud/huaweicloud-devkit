# Tasks — Issue #981

| #   | 任务                                                                                                                                         | 状态    |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| 1   | `buildDeployCheckScript` 增加只读端口探测（`ss` / conf `listen` / `nginx -T` root 匹配）与 `PORT_DRIFT` / `NGINX_LISTEN_PORT` / `PROBE_PORT` | done    |
| 2   | `nginx_serving`、`content_verified` 指纹、`tunnel_url_accessible` 改用 `PROBE_PORT`                                                          | done    |
| 3   | `parseDeployCheckOutput` 返回 `requestedPort` / `nginxListenPort` / `portDrift`，`remediation` 指向实际端口                                  | done    |
| 4   | 工具描述与 `huawei-sandbox` 技能文档同步 drift 契约                                                                                          | done    |
| 5   | 新增 `test/issue-981-port-drift.test.mjs`（漂移/无漂移/未知/OSC 噪声/不评分）                                                                | done    |
| 6   | 自动重绑安全边界评估（文档，不落码）                                                                                                         | done    |
| 7   | 审查 R1：报告场景闭环——`deploy_check` 新增 `auto_rebind` 显式 opt-in（选择性重绑 + 复检 + `autoRebind` 回执）                                | done    |
| 8   | 审查 R2：`buildExposeRemediation` 移除 `devbridge delete-all`，改 `devbridge list` + 选择性删除                                              | done    |
| 9   | 审查 R3：root/alias 路径边界匹配；多端口无命中降级 `PORT_DRIFT:unknown`（失败开放）                                                          | done    |
| 10  | 审查建议：`nginx -T` / 隧道探测临时文件改 `mktemp`；`PORT_DRIFT_BASIS` 区分 configured/listening                                             | done    |
| 11  | 审查建议：漂移 shell 分支补执行级测试（假 `ss`/`sudo`/`nginx`/`curl` 实跑）                                                                  | done    |
| 12  | PR #983 描述按新 head 更新（不再停留在 OSC-133）                                                                                             | done    |
| 13  | `npm test` / `npm run lint` / `npm run validate` / `npm run format:check`                                                                    | pending |
