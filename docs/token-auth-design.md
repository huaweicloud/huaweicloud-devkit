# Token 认证支持设计（X-Auth-Token）

日期：2026-10-19
状态：已确认，待评审

## 背景

devkit 目前只支持两种华为云认证：永久/临时 **AK/SK** 和 **STS security token**（`--cli-security-token`，必须与临时 AK/SK 同用）。华为云还有第三种认证方式 —— **Token 认证**（IAM token，`X-Auth-Token`）。在华为云内部 agent 注入凭证的场景下，某些时候只注入 token、不注入 AK/SK，devkit 需要识别并支持这种场景。

## 现状（已探索确认）

- 凭据模型：`{ ak, sk, securityToken, region }`（`plugins/huaweicloud-core/src/auth/credentials.mjs`）。
- 注入方式：环境变量 `HW_ACCESS_KEY` / `HW_SECRET_KEY` / `HW_SECURITY_TOKEN` / `HW_REGION`；CodeArts `mcp_settings.json` 的 `server.environment.HW_*`；全局 vault S1（`~/.config/huaweicloud/credentials.json`）和会话 runtime。
- 所有华为云服务调用走 **hcloud CLI**。hcloud（KooCLI 7.2.12）认证参数只有 `--cli-access-key` / `--cli-secret-key` / `--cli-security-token`，`--cli-mode` 为 `AKSK|ecsAgency|SSO|AssumeRole`，**不支持 `X-Auth-Token`**。
- `resolveCredentials` 是**同步**函数；`runHcloud` 是 **async**；`resolveStsInjectArgs` 当前是**同步**函数，负责拼 `--cli-access-key/--cli-secret-key/--cli-security-token` 注入参数。

## 技术路径

token 不能直接喂给 hcloud，但可以通过 IAM 的 **`CreateTemporaryAccessKeyByToken`** 接口（`POST /v3.0/OS-CREDENTIAL/securitytokens`）把 token 换成**临时 AK/SK + securitytoken**，临时凭证走现有 hcloud STS 注入通道：

```
注入 HW_X_AUTH_TOKEN ──► 识别 token 模式（AK/SK 优先）
                            │ 无 AK/SK 且 token 存在
                            ▼
                         IAM POST /v3.0/OS-CREDENTIAL/securitytokens
                         { auth: { identity: { methods: ["token"], token: { id, duration_seconds } } } }
                            ▼
                         临时 { access, secret, securitytoken, expires_at }
                            │ 内存缓存到 expires_at（提前 60s 判过期）
                            ▼
                         hcloud 现有 STS 注入（--cli-access-key / --cli-secret-key / --cli-security-token）
```

参考接口（IAM `CreateTemporaryAccessKeyByToken`）：
- URI：`POST https://iam.myhuaweicloud.com/v3.0/OS-CREDENTIAL/securitytokens`（支持全局端点，也支持各区域端点）
- 请求头：`Content-Type: application/json;charset=utf8`；认证可选 `X-Auth-Token` 或 body `auth.identity.token.id`
- 响应：`{ credential: { access, secret, securitytoken, expires_at } }`，`expires_at` 为 UTC

## 关键决策

| 项 | 决策 |
|---|---|
| token 注入字段 | `HW_X_AUTH_TOKEN`（环境变量 + CodeArts `server.environment.HW_X_AUTH_TOKEN`），由华为云内部 agent 注入 |
| token 过期时间字段 | `HW_X_AUTH_TOKEN_EXPIRES_AT`（ISO8601 或 epoch 秒，可选），注入方提供；devkit 主动读，到期前告警/续期（方案 A） |
| 优先级 | **AK/SK 优先**——有可用 AK/SK 直接走现有路径；无 AK/SK 时才用 token |
| `duration_seconds` | **86400（24h，最大值）**，跟随 X-Auth-Token 生命周期，几乎不重换 |
| IAM 端点 | 全局端点 `iam.myhuaweicloud.com`（可被 `HW_TOKEN_IAM_ENDPOINT` 环境变量覆盖，供测试/翻墙场景） |
| 换取时机/缓存 | **惰性换取 + 内存缓存到 `expires_at`**（提前 60s grace 视为过期则重换）；并发换取走 **single-flight** |
| token 失效 | 主动感知（`HW_X_AUTH_TOKEN_EXPIRES_AT` 到期）→ `TOKEN_EXPIRED`；换取返回 401/403 → `TOKEN_INVALID`（提示注入方轮换 token） |
| 临时凭证过期 | **token 有效时自动续期**（重换）；token 也失效时 → `CREDENTIAL_EXPIRED` |

## 架构组件

### 1. `src/auth/token-exchange.mjs`（新增）

- `exchangeTokenForCredentials(token, { durationSeconds, iamEndpoint })`：HTTP 调 IAM，返回 `{ ak, sk, securityToken, expiresAt }`。
- `getTokenCredentials(token, options)`：内存缓存封装。缓存未过期直接返回；否则换取并缓存。
- **single-flight**：并发调用期间共享同一个换取 Promise，避免重复调 IAM。
- 缓存为模块级变量，**同时记录换取时所用的 token 值**；`resolveXAuthToken()` 读到的 token 与缓存记录不一致时，判定为注入方轮换了 token，强制重换。
- 进程重启后随 env token 自然重取。

### 2. `src/auth/credentials.mjs`（小改）

- 新增 `resolveXAuthToken()`：从 `process.env.HW_X_AUTH_TOKEN` 和 CodeArts `mcp_settings.json` env 读取 token（复用 `present()` 占位符判定），返回 token 或 `null`。
- 新增 `resolveXAuthTokenExpiry()`：读 `HW_X_AUTH_TOKEN_EXPIRES_AT`（复用 `parseStsExpiry` 的 ISO8601/epoch 解析语义），返回过期 epoch ms 或 `null`。
- `resolveCredentials` 保持不变（token 不是 AK/SK 三元组的一部分，不混入）。

### 3. `src/hcloud-cli.mjs`（小改）

- `resolveStsInjectArgs` 改为 **async**：现有逻辑不变；当「无 AK/SK（`!creds.ak || !creds.sk`，即既无永久也无临时 AK/SK）」且 `resolveXAuthToken()` 返回非空时，`await getTokenCredentials(token)`，用换取的临时 AK/SK/securitytoken 拼注入参数。
- 保留现有「有完整三元组(ak+sk+securitytoken)才注入 STS」与「仅永久 AK/SK 时走 hcloud profile」两条既有行为，仅在 `!ak || !sk` 时追加 token 分支。
- 换取失败：抛 `TOKEN_INVALID`（结构化错误），`runHcloud` 捕获并返回 `ok:false`。

### 4. 脱敏加固

- `redactSecrets` / `redactEvidence`（`safety-policy.mjs`、`risk-rule-engine.mjs`）扩展识别 `X_AUTH_TOKEN` / `x-auth-token` 字段，避免 token 落入日志、命令回显、process list。

## 续期机制

```
时间轴（token 通过 HW_X_AUTH_TOKEN 注入，有效期固定 24h）
──────────────────────────────────────────────────────────────►
        ▲ 注入 token                              ▲ 注入方轮换新 token
        │                                         │
  临时 AK/SK(24h) ──过期──► getTokenCredentials   │
                           自动重换（single-flight）│
                                                    │
  主动感知 HW_X_AUTH_TOKEN_EXPIRES_AT 到期 ────────► 告警 TOKEN_EXPIRED
  （注入方轮换新 token 后，devkit 检测值变化自动重换临时凭证，恢复）
```

- **临时 AK/SK 自动续期**：token 有效期内，临时凭证过期 → `getTokenCredentials` 自动重换（不中断会话）。
- **token 轮换感知**：`HW_X_AUTH_TOKEN` 值变化（注入方轮换）→ 缓存失配强制重换临时凭证。
- **token 过期感知（方案 A）**：
  - 优先读 `HW_X_AUTH_TOKEN_EXPIRES_AT` 主动判断，到期前告警 `TOKEN_EXPIRED`（提示注入方轮换）。
  - 未提供 `HW_X_AUTH_TOKEN_EXPIRES_AT` 时，兜底靠换取返回 401（`The token must be updated`）判定 token 失效。
  - token 失效期间调用 → 返回结构化错误；注入方轮换新 token 后，下一次调用自动恢复。
- 账密登录/重新获取新 token **由注入方负责**（devkit 不持有 username/password）。

## 数据流（token 模式的单次 hcloud 调用）

1. agent 调用 `huaweicloud_run_readonly_command` / `run_approved_command`。
2. `runHcloud`（async）→ `planHcloudCommand`（分类/审批，token 不参与）→ `resolveStsInjectArgs`（async）。
3. `resolveStsInjectArgs`：`resolveCredentialsWithRuntime` 无 AK/SK（`!ak || !sk`）→ `resolveXAuthToken()` 命中 `HW_X_AUTH_TOKEN`。
4. `getTokenCredentials(token)`：缓存未过期 → 直接返回；否则 `exchangeTokenForCredentials` 调 IAM。
5. 返回 `['--cli-access-key=…', '--cli-secret-key=…', '--cli-security-token=…']`，追加到执行 args。
6. 现有 STS 注入后置逻辑（过期检查 `isTemporaryStsExpired`、`HUAWEICLOUD_INJECT_STS_CMD` 开关）照旧生效。

## 错误处理

| 场景 | 行为 |
|---|---|
| 无 AK/SK 且无 token | 现有 `HDKIT_CRED_MISSING` onboarding（不变） |
| token 换取 401/403 | `TOKEN_INVALID`，提示重新登录/注入方轮换 token |
| token 过期（主动感知 `HW_X_AUTH_TOKEN_EXPIRES_AT`） | `TOKEN_EXPIRED`，提示注入方轮换；轮换后自动恢复 |
| token 换取网络失败 | 不静默降级，返回结构化错误（复用 retry 策略） |
| 临时 AK/SK 过期（token 仍有效） | 自动续期（重换），不报错 |
| 临时 AK/SK 过期（token 也失效） | `CREDENTIAL_EXPIRED`（复用现有） |
| token 为占位符/masked | `present()` 判空，视为未配置 |

## 测试策略

- 单元：`token-exchange.mjs` —— mock IAM HTTP，覆盖换取成功、缓存命中/过期重取、401 报 `TOKEN_INVALID`、`duration_seconds` 传参、single-flight 并发、token 值变化强制重换。
- 单元：`credentials.mjs` —— `resolveXAuthToken()` 读 env / CodeArts env、占位符过滤；`resolveXAuthTokenExpiry()` 解析 ISO8601 / epoch。
- 单元：`hcloud-cli.mjs` —— `resolveStsInjectArgs` token 分支注入临时凭证、AK/SK 优先、换取失败与 token 过期错误形状。
- 单测：脱敏规则覆盖 `X_AUTH_TOKEN`。
- E2E（ECS 真机）：注入真实 `HW_X_AUTH_TOKEN`，跑一次只读命令（如 `ECS ListServersDetails`）验证 token→临时 AK/SK→hcloud 全链路。

## 安全约束

- token、临时 AK/SK/securitytoken 不写磁盘、不落日志、不进 process list（沿用 `HUAWEICLOUD_INJECT_STS_CMD=0` 的关闭位）。
- token 缓存仅在内存，无持久化。
- 脱敏规则同步覆盖 token 字段。

## 范围外（YAGNI）

- 不支持 devkit 自己用账号密码获取/续期 token（token 及过期时间只来自注入，轮换由注入方负责）。
- 不支持「token 换 token」续期。
- 不支持通过 `auth_init`/`auth_switch` 交互设置 token。
- 不为 token 模式新增 HTTP 直连调用层（复用 hcloud）。