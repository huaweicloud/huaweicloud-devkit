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

| 项                 | 决策                                                                                                                                                                           |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| token 注入字段     | `HW_X_AUTH_TOKEN`（环境变量 + CodeArts `server.environment.HW_X_AUTH_TOKEN`），由华为云内部 agent 注入；env 注入且**进程长驻** → `process.env` 为启动快照，进程内 token 值不变 |
| token 过期时间字段 | `HW_X_AUTH_TOKEN_EXPIRES_AT`（ISO8601 或 epoch 秒，**可选**）；缺省时 devkit 从 token 字符串自解析过期时间（CMS 内嵌 JSON `token.expires_at`），active 告警无需注入方显式提供 |
| 优先级             | **AK/SK 优先**——有可用 AK/SK 直接走现有路径；无 AK/SK 时才用 token                                                                                                             |
| `duration_seconds` | **900（15min）**——临时凭证先于 token 过期，每次重换都真实校验 token，无错位，最小权限                                                                                          |
| IAM 端点           | 全局端点 `iam.myhuaweicloud.com`（可被 `HW_TOKEN_IAM_ENDPOINT` 环境变量覆盖，供测试/翻墙场景）                                                                                 |
| 换取时机/缓存      | **惰性换取 + 内存缓存到 `expires_at`**（提前 60s grace 视为过期则重换）；并发换取走 **single-flight**                                                                          |
| token 失效         | env 快照下**无法自动轮换**；主动感知到期 → `TOKEN_EXPIRED`（提示重启进程重新注入）；换取返回 401/403 → `TOKEN_INVALID`                                                         |
| 临时凭证过期       | **token 有效时自动续期**（重换，每次校验 token）；token 也失效时 → 报错提示重启（复用 `CREDENTIAL_EXPIRED` 语义）                                                              |

## 兼容性不变量（回归红线）

本次改动是**纯增量**——token 认证只在「AK/SK 完全缺失」时接管，现有认证路径行为必须逐位保持不变：

1. **永久 AK/SK**（有 `ak`+`sk`、无 `securityToken`）：仍走 hcloud profile，不经 token 分支。
2. **临时 AK/SK + STS**（`ak`+`sk`+`securityToken` 三元组）：现有 `--cli-access-key/--cli-secret-key/--cli-security-token` 注入，完全不变。
3. **STS 过期检测**：`isTemporaryStsExpired` / `parseStsExpiry` / `HW_STS_EXPIRES_AT` 全链路不变。
4. **`resolveCredentials` 优先级链**（env → CodeArts env → vault S1 → `configuredBySession` 覆盖）不变；`resolveCredentials`/`resolveCredentialsWithRuntime` 的函数签名与返回结构不变。
5. **触发 token 分支的唯一条件**：`!ak || !sk`（AK/SK 完全缺失）**且** `HW_X_AUTH_TOKEN` 存在。只要任一 AK/SK 存在（永久或临时），一律不走 token。

回归门禁：改动后 `auth-credentials.test.mjs`、`cred-reconcile-e2e.test.mjs`、`hcloud-cli.test.mjs`、`safety-policy.test.mjs` 等现有测试**原样全绿**；新增 token 用例只覆盖「无 AK/SK + 有 token」分支，不与现有用例重叠或改判定。

## 架构组件

### 1. `src/auth/token-exchange.mjs`（新增）

- `exchangeTokenForCredentials(token, { durationSeconds, iamEndpoint })`：HTTP 调 IAM，返回 `{ ak, sk, securityToken, expiresAt }`（默认 `durationSeconds=900`）。
- `getTokenCredentials(token, options)`：内存缓存封装。缓存未过期直接返回；否则换取并缓存。
- **single-flight**：并发调用期间共享同一个换取 Promise，避免重复调 IAM。
- 缓存为模块级变量、进程内有效；进程重启后随 env token 自然重取。
- 注：token 经 env 注入且进程长驻，`process.env` 为启动快照、进程内不变，故**无需 token 轮换感知逻辑**。

### 2. `src/auth/credentials.mjs`（小改）

- 新增 `resolveXAuthToken()`：从 `process.env.HW_X_AUTH_TOKEN` 和 CodeArts `mcp_settings.json` env 读取 token（复用 `present()` 占位符判定），返回 token 或 `null`。
- 新增 `resolveXAuthTokenExpiry()`：优先读 `HW_X_AUTH_TOKEN_EXPIRES_AT`（ISO8601/epoch 解析语义）；**缺省时 fallback 到 token 自解析**——base64 解码 CMS SignedData 并提取内嵌 JSON 的 `token.expires_at`；返回过期 epoch ms 或 `null`。
- `resolveCredentials` 保持不变（token 不是 AK/SK 三元组的一部分，不混入）。

### 3. `src/hcloud-cli.mjs`（小改）

- `resolveStsInjectArgs` 改为 **async**：现有逻辑不变；当「无 AK/SK（`!creds.ak || !creds.sk`，即既无永久也无临时 AK/SK）」且 `resolveXAuthToken()` 返回非空时，`await getTokenCredentials(token)`，用换取的临时 AK/SK/securitytoken 拼注入参数。
- 保留现有「有完整三元组(ak+sk+securitytoken)才注入 STS」与「仅永久 AK/SK 时走 hcloud profile」两条既有行为，仅在 `!ak || !sk` 时追加 token 分支。
- 换取失败：抛 `TOKEN_INVALID`（结构化错误），`runHcloud` 捕获并返回 `ok:false`。

### 4. 脱敏加固

- `redactSecrets` / `redactEvidence`（`safety-policy.mjs`、`risk-rule-engine.mjs`）扩展识别 `X_AUTH_TOKEN` / `x-auth-token` 字段，避免 token 落入日志、命令回显、process list。

## 续期机制

```
进程启动：env 注入 HW_X_AUTH_TOKEN（进程内快照，值不变）
         │
         ├─ 换取临时 AK/SK（duration 15min）缓存
         │
         ├─ 临时凭证过期（15min）→ getTokenCredentials 自动重换
         │     └─ 每次重换都真实调 IAM，token 有效→成功，token 失效→401
         │
         └─ token 过期（HW_X_AUTH_TOKEN_EXPIRES_AT 主动感知，或 401 兜底）
              → TOKEN_EXPIRED，提示「重启进程重新注入」（env 快照无法热轮换）
```

- **临时 AK/SK 自动续期（token 有效期内）**：临时凭证每 15min 过期 → `getTokenCredentials` 自动重换，会话不中断；每次重换即校验 token。
- **不做 token 轮换感知**：token 经 env 注入且进程长驻，`process.env` 是启动快照，注入方轮换 env 后 devkit 进程读不到新值，故「值变化强制重换」不成立。
- **token 过期（方案 A）**：
  - 优先读 `HW_X_AUTH_TOKEN_EXPIRES_AT` 主动判断；**未注入该字段时从 token 字符串自解析过期时间**（CMS 内嵌 JSON `token.expires_at`）——到期前告警 `TOKEN_EXPIRED`（提示用户/运维重启进程，注入方重新注入凭证）。
  - 自解析也失败（非 CMS/无内嵌 JSON）时，兜底靠临时凭证重换取 401（`The token must be updated`）判定 token 失效。
  - 失效恢复 = **重启进程重新注入**（与现有 STS `CREDENTIAL_EXPIRED` 语义一致），devkit 不尝试自动轮换。
- 账密登录/重新获取新 token **由注入方负责**（devkit 不持有 username/password）。

## 数据流（token 模式的单次 hcloud 调用）

1. agent 调用 `huaweicloud_run_readonly_command` / `run_approved_command`。
2. `runHcloud`（async）→ `planHcloudCommand`（分类/审批，token 不参与）→ `resolveStsInjectArgs`（async）。
3. `resolveStsInjectArgs`：`resolveCredentialsWithRuntime` 无 AK/SK（`!ak || !sk`）→ `resolveXAuthToken()` 命中 `HW_X_AUTH_TOKEN`。
4. `getTokenCredentials(token)`：缓存未过期 → 直接返回；否则 `exchangeTokenForCredentials` 调 IAM。
5. 返回 `['--cli-access-key=…', '--cli-secret-key=…', '--cli-security-token=…']`，追加到执行 args。
6. 现有 STS 注入后置逻辑（过期检查 `isTemporaryStsExpired`、`HUAWEICLOUD_INJECT_STS_CMD` 开关）照旧生效。

## 错误处理

| 场景                                                | 行为                                            |
| --------------------------------------------------- | ----------------------------------------------- |
| 无 AK/SK 且无 token                                 | 现有 `HDKIT_CRED_MISSING` onboarding（不变）    |
| token 换取 401/403                                  | `TOKEN_INVALID`，提示重新登录/重启重新注入      |
| token 过期（主动感知 `HW_X_AUTH_TOKEN_EXPIRES_AT`） | `TOKEN_EXPIRED`，提示重启进程重新注入           |
| token 换取网络失败                                  | 不静默降级，返回结构化错误（复用 retry 策略）   |
| 临时 AK/SK 过期（token 仍有效）                     | 自动续期（重换），不报错                        |
| 临时 AK/SK 过期（token 也失效）                     | `CREDENTIAL_EXPIRED` 语义，提示重启（复用现有） |
| token 为占位符/masked                               | `present()` 判空，视为未配置                    |

## 测试策略

- 单元：`token-exchange.mjs` —— mock IAM HTTP，覆盖换取成功、缓存命中/过期重取、401 报 `TOKEN_INVALID`、`duration_seconds=900` 传参、single-flight 并发。
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
- 不支持 token 热轮换（env 快照 + 长驻进程下无法感知，token 过期需重启重新注入）。
- 不支持通过 `auth_init`/`auth_switch` 交互设置 token。
- 不为 token 模式新增 HTTP 直连调用层（复用 hcloud）。
