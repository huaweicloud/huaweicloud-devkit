# Issue #981 — deploy_check 端口漂移感知（P2）

## 背景

每日复核（v1.1.14-next.2）报告：D3-S3 沙箱预览出 URL 在端口漂移后 `deploy_check` 返回 `complete=false`，agent 用旧端口反复重试。

事实链（QA 核证）：

- `deployNginx` 在请求端口被占用时会自增端口（`session-manager.mjs` 端口探测循环），并把**实际端口**放在返回的 `port` 字段；
- 漂移提示只有 `formatPortDriftWarning`（:208）一段文案，且只在 `deployNginx` 的 `tunnelActive` 分支附着到 `warning`（:1011）；
- `deploy_check` 全链路按**调用方传入的 `port`** 探测：`nginx_serving`、`content_verified`、`tunnel_url_accessible` 均拼旧端口，无漂移感知；
- 失败后返回 `nextStep=expose_via_devbridge` + `buildExposeRemediation(port)`（:1278），指引里仍是旧端口（仅在文案里提示"若 deploy_nginx 报告了别的端口请用那个"）。

结论：缺的是**检查侧识别漂移并回传正确端口**的能力，不是解析或校验 bug；自动重绑属产品取舍，需先评估安全边界。

## 需求

1. `deploy_check` 以只读方式获取 nginx **实际监听端口**（`ss -tlnp` + `nginx -T` 中 `root/alias` 命中当前 `output_dir` 的 `listen`）。
2. 与调用方 `port` 比对，漂移时返回明确字段：`portDrift: { requested, actual, message }` + `nginxListenPort`。
3. 所有本地探测（nginx 响应、部署指纹、隧道 URL）使用实际端口，使"用错端口"不再导致假失败。
4. `remediation` 直接指向实际端口，agent 无需自行换算；`nextStep` 语义保持不变（`expose_via_devbridge`）。
5. 探测失败（无法识别端口）时**失败开放**：不报漂移、保持原端口行为，评分口径不变。
6. 漂移诊断**不进入评分**（不新增 PASS/TOTAL 项），避免改变既有 `score` 契约。

## 非目标（本期不做）

- 不自动执行 `devbridge port create` / 重启 `devbridge host`（安全边界见 `plan.md` §4）。
- 不修改 `deploy_nginx` 的端口自增逻辑与 `formatPortDriftWarning` 文案。
- 不重复修改 OSC-133 `strip`（解析侧 :805 已修复，#983 调用点改动保留但非本缺陷必需）。

## 验收

- 漂移场景：`PORT_DRIFT:8080->8081` + `NGINX_LISTEN_PORT:8081` 的检查输出，解析结果 `portDrift.actual=8081`、`nginxListenPort=8081`、`requestedPort=8080`，隧道探测 URL 与 `remediation` 均为 8081。
- 无漂移：不返回 `portDrift`，行为与 1.1.14-next.2 完全一致。
- 无法识别：`PORT_DRIFT:unknown`，不报漂移、不改变 `nextStep`/`score`。
- OSC-133/CRLF 噪声下仍可解析。
