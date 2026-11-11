# Plan — Issue #981 端口漂移感知

## 1. 方案总览

只读感知 + 明确回传 + 精确补救，不做自动重绑。

| 层       | 文件                                                                   | 变更                                                                                                                                                                                                                                                                                               |
| -------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 检查脚本 | `src/sandbox/session-manager.mjs` `buildDeployCheckScript`             | 新增端口探测块：`ss -tlnp` 取 nginx LISTEN 端口集合 → 失败回退 `grep listen /etc/nginx/conf.d/*.conf`；再用 `sudo nginx -T` 找 `root/alias` 命中当前 `outputPath` 的 server 的 `listen`。输出 `PORT_DRIFT`、`NGINX_LISTEN_PORT`、`PROBE_PORT`；`nginx_serving` / 指纹 / 隧道 URL 改用 `PROBE_PORT` |
| 解析器   | `parseDeployCheckOutput`                                               | 解析上述标记；返回 `requestedPort`、`nginxListenPort`、`portDrift`；`remediation` 用 `effectivePort`                                                                                                                                                                                               |
| 工具描述 | `src/tools.mjs`                                                        | `huaweicloud_sandbox_deploy_check` 描述补 `portDrift`/`nginxListenPort` 语义                                                                                                                                                                                                                       |
| 技能文档 | `skills/huawei-sandbox/SKILL.md`                                       | 检查项列表 + pitfall 表 + Step 7 补救说明                                                                                                                                                                                                                                                          |
| 测试     | `test/issue-981-port-drift.test.mjs` + `test/session-manager.test.mjs` | 漂移/无漂移/未知/OSC 噪声 + 脚本契约守卫                                                                                                                                                                                                                                                           |

## 2. 端口选择优先级

1. `nginx -T` 中 `root|alias` 命中当前 `outputPath` 的 `listen` 端口，且该端口在 LISTEN 集合中 → 用它（最权威，排除历史残留 conf）；
2. 调用方 `port` 在 LISTEN 集合中 → 无漂移；
3. 配置命中端口（即便不在 LISTEN 集合）→ 用它（配置已写入但未 reload 时仍能给出正确目标）；
4. LISTEN 集合首个端口；
5. 都识别不到 → `PORT_DRIFT:unknown`，回退调用方端口（失败开放）。

## 3. 为什么只改 `deploy_check`

- `deploy_nginx` 已返回实际 `port` 字段，缺的是"调用方用错端口时能被纠正"；
- 把纠正放在检查侧，不改变部署侧行为，零回归面；
- 探测全为只读命令（`ss`/`grep`/`nginx -T`/`curl localhost`），不触碰隧道与 nginx 配置。

## 4. 自动重绑：安全边界评估（本期不实现）

自动重绑 = 在 `deploy_check` 内执行 `devbridge port create <id> -p <actual>` + 重启 `devbridge host`。风险：

| 风险         | 说明                                                                                        | 需要的约束                                                                 |
| ------------ | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| 隧道归属     | `devbridge list` 只给 ID，不保证属于当前会话/当前部署；共享沙箱中重绑他人隧道会切断对方 URL | 必须绑定本会话创建的 tunnel（记录 `tunnelId` 于连接态），ID 不存在时禁止猜 |
| 端口占用冲突 | 重绑前需确认目标端口无其他 host 进程占用；已有 host 绑定旧端口需先停                        | 前置 `pgrep -af "devbridge host"` + 端口归属校验，冲突则拒绝               |
| 认证与凭据   | 重绑需登录态；`/tmp/hw_api_key` 可能缺失或过期                                              | 先跑既有 auth waterfall，失败即返回 remediation，不静默降级                |
| 幂等/并发    | `deploy_check` 可能被多个 agent 并发调用；二次重绑会抖动端口                                | 沙箱内文件锁 + "当前已绑定实际端口"短路                                    |
| 幂等失败回滚 | 重绑失败后 host 已停，原 URL 也失效                                                         | 需先探测新记录可用再重启 host；失败回滚到旧端口绑定                        |
| 可观测性     | 静默重绑会掩盖 `deploy_nginx` 端口漂移根因（端口被占）                                      | 必须返回 `autoRebound: true` + 变更前后端口，并保留 drift 字段             |

结论：自动重绑是**写操作且跨会话有副作用**，收益（少一轮 agent 交互）远小于误重绑代价。本期先交付只读感知 + 正确端口回传 + 精确 remediation；自动重绑列为后续增强，需 `auto_rebind: true` 显式 opt-in，并在实现前补齐上述 5 项约束与回滚测试。

## 5. 提交拆分（原子）

1. `feat(sandbox): #981 detect nginx port drift in deploy_check and return the actual port`
2. `test(sandbox): #981 drift awareness guards for deploy_check`
3. `docs(sandbox): #981 deploy_check drift contract + auto-rebind safety assessment`

## 6. 验证

```bash
node --test test/issue-981-port-drift.test.mjs test/session-manager.test.mjs
npm test
npm run lint
npm run validate
npm run format:check
```
