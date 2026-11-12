# Plan — Issue #981 端口漂移感知

## 1. 方案总览

只读感知 + 明确回传 + 精确补救；自动重绑以 `auto_rebind` 显式 opt-in 落地（默认关闭，保持只读）。

| 层       | 文件                                                                                        | 变更                                                                                                                                                                                                                                                                                                                   |
| -------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 检查脚本 | `src/sandbox/session-manager.mjs` `buildDeployCheckScript`                                  | 新增端口探测块：`ss -tlnp` 取 nginx LISTEN 端口集合 → 失败回退 `grep listen /etc/nginx/conf.d/*.conf`；再用 `sudo nginx -T` 找 `root/alias` 命中当前 `outputPath` 的 server 的 `listen`。输出 `PORT_DRIFT`、`PORT_DRIFT_BASIS`、`NGINX_LISTEN_PORT`、`PROBE_PORT`；`nginx_serving` / 指纹 / 隧道 URL 改用 `PROBE_PORT` |
| 解析器   | `parseDeployCheckOutput`                                                                    | 解析上述标记；返回 `requestedPort`、`nginxListenPort`、`portDrift {requested, actual, basis, message}`；`remediation` 用 `effectivePort`                                                                                                                                                                               |
| 重绑编排 | `src/tools.mjs` `huaweicloud_sandbox_deploy_check` + `shouldAutoRebind` / `applyAutoRebind` | `auto_rebind: true` 时：漂移 + `tunnel_url_accessible:FAIL` → 复用 `exposeTunnel`（`cleanup_mode=stale`）按实际端口重绑 → 复检 → 返回 `autoRebind {attempted, ok, from, to, publicUrl}`，保留原 `requestedPort` / `portDrift` 证据                                                                                     |
| 工具描述 | `src/tools.mjs`                                                                             | `huaweicloud_sandbox_deploy_check` 描述补 `portDrift.basis` / 失败开放 / `auto_rebind` 语义                                                                                                                                                                                                                            |
| 技能文档 | `skills/huawei-sandbox/SKILL.md`                                                            | 检查项列表 + pitfall 表 + Step 7 补救说明（选择性清理、auto_rebind）                                                                                                                                                                                                                                                   |
| 测试     | `test/issue-981-port-drift.test.mjs` + `test/session-manager.test.mjs`                      | 漂移/无漂移/未知/basis/OSC 噪声/不评分 + 多站点歧义 + **shell 执行级**漂移用例 + auto_rebind 单测                                                                                                                                                                                                                      |

## 2. 端口选择优先级

1. `nginx -T` 中 `root|alias` 命中当前 `outputPath` 的 `listen` 端口，且该端口在 LISTEN 集合中 → 用它（最权威，排除历史残留 conf）；
2. 调用方 `port` 在 LISTEN 集合中 → 无漂移；
3. 配置命中端口（即便不在 LISTEN 集合）→ 用它（`basis=configured`，文案提示 reload）；
4. LISTEN 集合**恰好一个**端口 → 用它（归属无歧义）；
5. 其余（含多端口且无 root 命中）→ `PORT_DRIFT:unknown`，回退调用方端口（失败开放）。

> `root|alias` 匹配为**路径边界**语义（`v == want` 或 `want + "/"` 前缀），不再用 `index()` 子串——`/workspace/app/dist-old`、`/workspace/app/dist2` 不会被误认成本次部署。

## 3. 为什么改 `deploy_check` 而不是 `deploy_nginx`

- `deploy_nginx` 已返回实际 `port` 字段，缺的是"调用方用错端口时能被纠正"；
- 把纠正放在检查侧，不改变部署侧行为，零回归面；
- 探测全为只读命令（`ss`/`grep`/`nginx -T`/`curl localhost`），不触碰隧道与 nginx 配置。

## 4. 自动重绑：显式 opt-in（已落码）

触发条件（全部满足）：`auto_rebind: true` + 测到真实漂移 + `tunnel_url_accessible` FAIL。默认 `false`，`deploy_check` 仍为只读。

| 风险         | 约束 / 实现                                                                                                                |
| ------------ | -------------------------------------------------------------------------------------------------------------------------- |
| 隧道归属     | 只按 `portDrift.actual` 走 `exposeTunnel` 的 `cleanup_mode=stale`；绝不 `delete-all`，旧端口隧道保持不动，不猜隧道 ID      |
| 端口占用冲突 | 重绑目标 = nginx 实际监听端口；`exposeTunnel` 自带同端口替换与 10006 配额逐条清理                                          |
| 认证与凭据   | 复用既有 auth waterfall（keyring → auto-create → `/tmp/hw_api_key`），失败返回 `autoRebind.ok=false` + `error`，不静默降级 |
| 幂等/并发    | 仅"漂移 + 隧道 FAIL"才写；隧道已服务实际端口时短路；`nginx -T`/探测临时文件改 `mktemp`，并发调用互不覆盖                   |
| 幂等失败回滚 | 重绑失败不改原结果（保留 `nextStep=expose_via_devbridge` 与 remediation）；成功才复检并替换 `complete`/`publicUrl`         |
| 可观测性     | 返回 `autoRebind {attempted, ok, from, to, publicUrl                                                                       | error}`，并保留 `requestedPort`/`portDrift`/`nginxListenPort` 作为诊断证据 |

## 5. 提交拆分（原子）

1. `feat(sandbox): #981 detect nginx port drift in deploy_check and return the actual port`
2. `test(sandbox): #981 drift awareness guards for deploy_check`
3. `docs(sandbox): #981 deploy_check drift contract + auto-rebind safety assessment`
4. 审查修复：`fix(sandbox): #981 review fixes — selective expose cleanup, path-bounded attribution, auto_rebind opt-in`

## 6. 验证

```bash
node --test test/issue-981-port-drift.test.mjs test/session-manager.test.mjs
npm test
npm run lint
npm run validate
npm run format:check
```
