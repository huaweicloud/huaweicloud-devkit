# Tasks — Issue #981

| #   | 任务                                                                                                                                         | 状态    |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| 1   | `buildDeployCheckScript` 增加只读端口探测（`ss` / conf `listen` / `nginx -T` root 匹配）与 `PORT_DRIFT` / `NGINX_LISTEN_PORT` / `PROBE_PORT` | done    |
| 2   | `nginx_serving`、`content_verified` 指纹、`tunnel_url_accessible` 改用 `PROBE_PORT`                                                          | done    |
| 3   | `parseDeployCheckOutput` 返回 `requestedPort` / `nginxListenPort` / `portDrift`，`remediation` 指向实际端口                                  | done    |
| 4   | 工具描述与 `huawei-sandbox` 技能文档同步 drift 契约                                                                                          | done    |
| 5   | 新增 `test/issue-981-port-drift.test.mjs`（漂移/无漂移/未知/OSC 噪声/不评分）                                                                | done    |
| 6   | 自动重绑安全边界评估（文档，不落码）                                                                                                         | done    |
| 7   | `npm test` / `npm run lint` / `npm run validate` / `npm run format:check`                                                                    | pending |
