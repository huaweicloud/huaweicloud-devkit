# Dev Report — Issue #935（1024活动第二批）

Branch: `issue/935-1024-batch2`（从 `upstream/dev` @ `04dae37` 历史切出）
Commit: `901ae21` — 已推送至 `origin`（issue/935-1024-batch2）
Scope: 代码 + 技能文档 + 测试，仅限 issue 归属范围内文件；未创建 PR（由汇总 agent 统一创建）。

---

## 一、逐项改动

### A 组：真 Bug — 代码修复

**A1. `plugins/huaweicloud-core/src/sandbox/session-manager.mjs`（deployNginx）**

- 新增导出 `resolveNginxConfigPath(configName, project)`：对 configName 做 basename 校验清洗——含路径分隔符（`/` 或 `\`）的值只取文件名并剥离 `.conf` 后缀，拼回 `/etc/nginx/conf.d/<name>.conf`，杜绝 `/etc/nginx/conf.d//root/xxx.conf` 类损坏路径；纯文件名（合法取值）行为不变（含空值回退到 project 的既有行为）。
- deployNginx 的 tee 写入行改用清洗后的 `configPath`；脚本末尾追加回验块：目标文件存在性（`DB_NGINX_CONFIG_MISSING=1`）+ `nginx -t` 判定（`DB_NGINX_T=PASS|FAIL`，失败输出以 `DB_NGINX_T_OUTPUT:` 行回显）。
- 新增导出 `parseDeployNginxVerifyOutput(stdout)` 与 `evaluateDeployNginxVerify(result, verify, configPath)`：tee 写入失败、nginx -t 失败、脚本非零退出任一命中时返回 `ok:false` + 显式错误信息（不再出现 tee 写入失败仍 `ok:true`）；成功路径返回带 `verification: { configPath, nginxTest }` 字段。

**A2. `plugins/huaweicloud-core/src/sandbox/session-manager.mjs`（exposeTunnel）**

- `buildDevbridgeExposeScript` 健康检查从「固定 `sleep 12` + 单次 curl」改为带重试与退避的 4 次探测循环（`for i in 1 2 3 4`，每轮 `DB_PROBE_n=<code>` 回显，200/304 提前退出，失败轮间退避 `sleep 5`）；网关就绪前的 502/000 不立即判定失败；空 TUNNEL_URL 直接跳过探测。
- 新增导出 `parseDevbridgeProbeSequence(stdout)`（解析探测序列 + 最终判定码）与 `formatTunnelReachabilityWarning(httpCode)`（200/304 → 无告警）。
- `exposeTunnel` 的可达性告警改用 `formatTunnelReachabilityWarning(parsed.httpCode)`——parsed.httpCode 即最终一轮探测结果，与实际 HTTP 状态一致，消除「告警 HTTP 非 200/304 但实测 200」的假告警；入参/出参结构不变（约束遵守）。

**A3. `plugins/huaweicloud-core/src/tools.mjs`（explain_error 的 hwErrorPatterns）**

- `Ecs` 条目新增：`Ecs.0019`（flavor 已下线 → `hcloud ECS ListFlavors` 查在售规格 + references/flavors.md 状态字段规则切换替代规格）、`Ecs.0319`（可用区容量不足 → 换 AZ 或换规格后重试）、`Ecs.0067`（余额受限 → 查 BSS 现金余额并充值，说明代金券不参与按量付费下单风控）。
- 新增 `Kps` 服务条目 + `kps`/`KPS` 别名：`KPS.9004`（密钥对创建受限 → 现金余额 + 历史欠费结清后重试 `hcloud ECS NovaCreateKeypair`）。

**A4. `plugins/huaweicloud-core/src/hcloud-cli.mjs`**

- 新增导出 `stripKooCliUpdateBanner(output)`：过滤 KooCLI 7.2.x 每次输出中「可执行 hcloud update 更新至 7.3.12」横幅行（匹配含 `hcloud update` 且含 `更新至`/`update to` 的行）。
- 接入 `redactOutput`（全部 close/timeout 输出路径的唯一清洗点）——横幅不再到达 MCP 工具输出；DevKit 自身的一次性升级提示（check_cli/doctor 版本不匹配软提示）不被过滤，语义与「file missing → unknown」catalog 语义均保留（约束遵守）。

### B 组：技能文档补强

| 项  | 文件                                                                                                       | 补充内容                                                                                                                                                                                                                                                     |
| --- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| B1  | `huawei-ecs/references/create-instance.md` §4 + `huawei-iac/SKILL.md`（stage-5 行 + Critical Warnings 行） | 模板/预置子网 `dnsList` 可能为空 → cloud-init 域名解析与 yum/dnf 静默失败；创建 ECS 前先 `hcloud VPC UpdateSubnet --subnet.dnsList.1=100.125.1.250 --subnet.dnsList.2=100.125.129.250`（参数格式经 `hcloud VPC UpdateSubnet --help` 实测确认）               |
| B2  | `huawei-ecs/references/windows-ssh.md` 新增 §0.1                                                           | 本机代理使 `api.ipify` 返回代理出口而非真实直连出口；Windows 用 `Invoke-RestMethod -NoProxy` 检测真实出口，放通 `/32` 精确规则                                                                                                                               |
| B3  | `huawei-ecs/references/troubleshooting.md` 新增小节                                                        | EulerOS 3.0 内置 firewalld 默认拒绝 SSH 入站；镜像内 `firewall-cmd` 放行或 cloud-init user_data 自动部署                                                                                                                                                     |
| B4  | `huawei-ecs/references/troubleshooting.md` 新增小节                                                        | `NovaShowJob` 操作不存在；删除 ECS 后用 `hcloud ECS ListServersDetails` 轮询直至 `DELETED`（或列表 404）                                                                                                                                                     |
| B5  | `huawei-sandbox/SKILL.md`（Web Application Deployment 段）                                                 | 沙箱无 systemd，`systemctl` 全部失效；用 `nginx -t` + `nginx -s reload` / 直接执行 nginx 二进制；deployNginx 返回的 nextStep 文案与该语义一致                                                                                                                |
| B6  | `huawei-sandbox/SKILL.md`（Step 1 段落 + 新增陷阱块）                                                      | ① devbridge 0.2.2 无 `--huaweicloud` 标志（文档超前于二进制），直接用 `devbridge auth login --access-key/--secret-key`；② MCP 注入的 STS 凭证为 obsutil 加密态存储，devbridge 读到密文报 `APIGW.0301`，需上传本地明文凭证库（AK 20 位/SK 40 位）后再创建隧道 |
| B7  | `huawei-iac/SKILL.md`（stage-5 行 + Critical Warnings 新行）                                               | 按量付费下单校验现金余额而非代金券（券只在账单结算时抵扣）；历史欠费（即使金额很小）同样触发 `KPS.9004`/`Ecs.0067`；门禁检查项包含现金余额充足 + 欠费已结清                                                                                                  |
| B8  | `huawei-ecs/references/create-instance.md` 新增小节                                                        | 已运行实例更新站点内容用 scp/rsync + `nginx -s reload`，无需重建；user_data/cloud-init 仅适用于创建时写入                                                                                                                                                    |
| B9  | `huaweicloud-ecs/references/troubleshooting.md` 新增小节                                                   | SSH 超时诊断流程：先比对真实直连出口 IP（Windows `Invoke-RestMethod -NoProxy`）与安全组 22 端口规则源 IP，不一致则更新规则                                                                                                                                   |
| B10 | `huawei-iam/SKILL.md`（Agencies 新增小节）                                                                 | STS 报委托不存在时需先预创建 `SELF_VERIFY` 自委托（活动/新环境默认不预置），含创建命令与排查顺序                                                                                                                                                             |
| B11 | `huawei-ecs/references/hc-activity.md` 新增小节                                                            | api_link 校验规则：① 路径须含 `/hc-activity/` 与 `index.html`（否则 400 `OPENSERVICE_PARAM_ERROR`）；② 客户端正则宽松，提交前以服务端严格规则本地预校验；③ 「作品链接无效」可能是服务端未探活成功，等 1-2 分钟后重试                                         |

### C 组：活动侧问题 — 仅记录，不实现（按 issue 约束）

积分不可查、活动页进度面板不支持 Agent 鉴权、作品展览馆 GitCode OAuth、第三方二维码外泄、活动页余额提示文案 —— 均属活动平台，不在本仓修复范围，后续反馈活动方。本批次未做任何实现。

---

## 二、验收标准逐条对照

| 验收标准                                                                                                                   | 结果      | 证据                                                                                                                                                                                                |
| -------------------------------------------------------------------------------------------------------------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm test` 退出码 0                                                                                                        | ⚠️ 见下注 | 756 tests, 739 pass, 3 fail —— 3 个失败均为已知 Windows 本地环境伪影（见「关键决策」#3 双证据判定），非本批次回归                                                                                   |
| `npm run lint` 退出码 0                                                                                                    | ✅        | 0 errors（2 个 import/no-cycle warning 为基线既有，位于本批次未触碰的 hcloud-probe.mjs/preflight.mjs）                                                                                              |
| `npm run validate` 退出码 0                                                                                                | ✅        | Validated 29 skills; KooCLI version pairing: 7.3.12                                                                                                                                                 |
| `npm run format` / `format:check`                                                                                          | ✅        | All matched files use Prettier code style!                                                                                                                                                          |
| `npm run pack:verify`                                                                                                      | ✅        | 221 files, install OK                                                                                                                                                                               |
| configName `/root/xxx.conf` → `/etc/nginx/conf.d/xxx.conf`（不含 `//`）                                                    | ✅        | `test/issue-935-fix.test.mjs` 「resolveNginxConfigPath strips path separators…」断言通过                                                                                                            |
| tee 写入失败 / `nginx -t` 失败 → `ok:false` 且含错误信息                                                                   | ✅        | `evaluateDeployNginxVerify returns ok:false…`（tee write failed / nginx -t did not pass / exited with code 1）3 个断言通过                                                                          |
| 健康检查含重试循环；最终 ok 取自最后一轮探测；「中间轮 502/000、末轮 200」不告警                                           | ✅        | `buildDevbridgeExposeScript probes with a retry loop…` + `a 502/000 → 200 probe sequence produces NO reachability warning` 通过                                                                     |
| `grep Ecs.0019 / Ecs.0319 / Ecs.0067 / KPS.9004` tools.mjs 各 ≥1 且指引含替代规格/充值关键词                               | ✅        | 各命中 2 处；指引含 `ListFlavors`/`replacement`/`top up                                                                                                                                             | 充值`/`代金券`/`欠费` |
| 横幅清洗测试：清洗后不含该行；版本不匹配仍输出一次升级提示                                                                 | ✅        | `stripKooCliUpdateBanner removes…`（横幅移除 + 真实输出保留）与 `keeps real output and the DevKit one-shot upgrade hint`（check_cli 软提示 verbatim 保留）通过；另有 `runHcloud strips…` 端到端断言 |
| `100.125.1.250`（create-instance.md）与 `UpdateSubnet`（huawei-iac/SKILL.md）各 ≥1                                         | ✅        | 各命中 2 处                                                                                                                                                                                         |
| `NoProxy`（windows-ssh.md）≥1                                                                                              | ✅        | 命中 2 处                                                                                                                                                                                           |
| `firewalld`、`ListServersDetails`（troubleshooting.md）各 ≥1；后者段落不以 NovaShowJob 作推荐轮询                          | ✅        | 各命中 3 处；`NovaShowJob` 仅出现于「操作**不存在**」纠正表述（structure.test.mjs 守卫逐行断言）                                                                                                    |
| `systemctl`（huawei-sandbox/SKILL.md）≥1 且同段落含 `nginx -s reload` 或「无 systemd」                                     | ✅        | 命中 1 处，同段落两者均含                                                                                                                                                                           |
| `devbridge auth login` 与 `APIGW.0301`（huawei-sandbox/SKILL.md）各 ≥1                                                     | ✅        | 7 处 / 3 处                                                                                                                                                                                         |
| `现金余额` 与 `欠费`（huawei-iac/SKILL.md）≥1 且位于 stage-5 门禁段落                                                      | ✅        | 各 2 处；structure.test.mjs 守卫断言 stage-5（Cost + balance gate）行同时含两者                                                                                                                     |
| `scp\|rsync`（create-instance.md）≥1                                                                                       | ✅        | 命中 4 处                                                                                                                                                                                           |
| `SELF_VERIFY`（huawei-iam/SKILL.md）≥1                                                                                     | ✅        | 命中 3 处                                                                                                                                                                                           |
| hc-activity.md 含 `hc-activity` 且命中 `OPENSERVICE_PARAM_ERROR`、`index.html`、`作品链接无效`（含 1-2 分钟重试语义）各 ≥1 | ✅        | 2 / 4 / 1 处，含「等 1-2 分钟后重试」                                                                                                                                                               |
| 改动 SKILL.md 通过 YAML frontmatter 校验，无 TODO 标记                                                                     | ✅        | `npm run validate` 通过；改动文件 TODO 命中 0                                                                                                                                                       |

**npm test 的 3 个失败 — 双证据判定为本地环境伪影（非回归）**：

1. `test/preflight.test.mjs` 「install log is created 0600」expected 0600 got 666 —— Windows 文件权限基线失败。
2. `test/tools.test.mjs` 「counts symlinked skill dirs」EPERM symlink —— Windows symlink 基线失败（任务说明中明示的已知伪影）。
3. `test/mcp-server.test.mjs` 「reports version from plugin package.json」initialize 超时 —— 并行负载下的偶发超时，**隔离重跑即通过**（isolated: 48 tests, 2 fail 仅为上面 1/2 两项）。

双证据：① 失败文件隔离重跑（mcp-server 通过；preflight/tools 复现同样 2 项）；② 与父提交基线（`04dae37`，stash 掉本批次改动后）对比 —— `node --test test/preflight.test.mjs test/tools.test.mjs` 在基线上同样 38 tests, 2 fail（0600→666 + symlink EPERM），与本批次改动无关。核心门禁文件单独复跑：`test/issue-935-fix.test.mjs + structure.test.mjs + session-manager.test.mjs` = 117 tests 全过。

---

## 三、关键决策

1. **A1/A2 的可测性抽出**：deployNginx 与 exposeTunnel 均依赖沙箱 execOneShot（不可 mock 到单元级），故将判定逻辑抽为纯函数导出（`resolveNginxConfigPath` / `parseDeployNginxVerifyOutput` / `evaluateDeployNginxVerify` / `parseDevbridgeProbeSequence` / `formatTunnelReachabilityWarning`），脚本生成与解析与既有测试模式（buildXxxScript + parseXxxOutput）一致；exposeTunnel 的入参/出参结构未变（A2 约束）。
2. **A4 清洗点选在 `redactOutput`**：它是 runHcloud 所有收尾路径（成功/超时/spawn 错误）输出的统一清洗函数，单点接入即可全路径过滤；`stripKooCliUpdateBanner` 同时导出供单元测试。`hcloud update` + `更新至/update to` 双关键词匹配避免误删正常输出；check_cli/doctor 的一次性升级提示（`npx huaweicloud-devkit update`）不含该组合、verbatim 保留，软提示语义未变。
3. **A3 匹配机制**：沿用 `hwErrorPatterns` 既有 exact-match + `code.includes(errorCode)` 双通道；`Kps` 服务经 `kps`/`KPS` 别名归一，与 `ecs`→`Ecs` 模式一致。
4. **B1 参数格式实测**：`hcloud VPC UpdateSubnet --help` 确认 `--subnet.dnsList.[N]`（optional, body array），文档命令按 `--subnet.dnsList.1=value` 形式书写（符合 HELPFUL 分类：内网 DNS IP `--help` 无法揭示）。
5. **git 环境伪影处理**：core.autocrlf=true 使检出文件为 CRLF（i/lf），prettier/ESLint 的行尾告警以 `git ls-files --eol` 验证 index 侧 i/lf 判定为伪影；提交后 index 内容为 LF（已验证 i/lf）。PATH 污染以精简 PATH 前缀（nvm4w nodejs + System32）解决。
6. **分支来源**：原工作分支远落后于上游，按任务指令从 `upstream/dev`（`04dae37`）切出 `issue/935-1024-batch2`。

---

## 第二轮修复（E2E-B1）：explain_error errorCode-only 路由缺口

**根因**

`plugins/huaweicloud-core/src/tools.mjs` 的 `explainError()` 中 `patternKey = SERVICE_ALIASES[svc] || service`，而 MCP 链路下 `service` 缺省为 `'unknown'` → `patternKey = 'unknown'` → `hwErrorPatterns['unknown']` 为 undefined，任何点码都不命中。映射表本身是 service 表（键 `Ecs`、`Kps`、`APIGW` 等，条目键为完整点码如 `Ecs.0019`）；第一轮 A3 单测均显式传了 service，所以全部通过，errorCode-only 的真实 MCP 调用形态未被覆盖。

**MCP 探针证据**

E2E MCP stdio JSON-RPC 实测：`huaweicloud_explain_error` 仅传 `errorCode`（`Ecs.0019` / `Ecs.0319` / `Ecs.0067` / `KPS.9004`，不传 service）时返回 `"No known error-code pattern matched"`、`service: unknown`。

**修复形态**

`explainError()` 开头新增派生逻辑：当 `service` 为空或 `'unknown'` 且 `errorCode` 匹配点码形态（`/^[A-Za-z]+\.\w+/`）时，取点码前缀（如 `Ecs.0019` → `ecs`）经既有 `SERVICE_ALIASES` 归一化（`ecs`→`Ecs`、`kps`→`Kps`）得到 patternKey，使 errorCode-only 调用命中映射表；无别名的点码前缀（如 `APIC`）直接用大写前缀作 patternKey。显式传 service 的调用路径完全不变（`patternKey = SERVICE_ALIASES[svc] || service` 语义保留，仅把兜底值从原始 `service` 换成派生后的 `resolvedService`）。行 2345 的精确匹配 `hwErrorPatterns[patternKey][errorCode]`（原始点码）与后续 `svcPatterns` 兜底循环均按派生后的 patternKey 工作。

**测试结果**

`test/issue-935-fix.test.mjs` 追加 8 条用例（#935 E2E-B1 段）：errorCode-only 命中 `Ecs.0019` / `Ecs.0319` / `Ecs.0067` / `KPS.9004` / 既有 `Ecs.0707`（5 条）；`service: 'unknown'` + 点码等价命中（1 条）；显式 `service: 'ECS'` 行为回归不变（1 条）；无点码 `0019` 且无 service 维持 fallback（1 条）。

门禁（PowerShell 精简 PATH）：

- `node --test test/issue-935-fix.test.mjs` — 31/31 pass（含新增 8 条）。
- `npm run lint` — 0 errors；2 个 `import/no-cycle` warning 为既有伪影（hcloud-probe.mjs / preflight.mjs，与本次改动无关）。
- `npm test` — 747/764 pass；3 项失败均为已知本机环境伪影（preflight 0600 mode、tools symlink EPERM、mcp-server initialize 偶发超时），与本次改动无关；`issue-935-fix` 相关测试文件全过。
- `npm run validate` — 通过（29 skills，KooCLI pairing 7.3.12）。
- `npm run format` — 改动文件无格式抖动。

**Commit**

`ec20ae3` — `fix: explainError 从 errorCode 点码前缀推导 service（#935 E2E-B1 errorCode-only 路由缺口）`，已推送至 `origin issue/935-1024-batch2`（本节由后续 docs commit 回填 hash）。
