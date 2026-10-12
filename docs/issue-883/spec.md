# Issue #883 — D3-C14: 沙箱 HDKit 凭证回退风险修复（spec）

## 问题

`plugins/huaweicloud-core/src/auth/credentials.mjs` 中 `clearRuntimeCredentials()` 仅将 `runtimeCredentials` 置 null；
`resolveCredentialsWithRuntime()` 在 runtime 为空时无条件 `return resolveCredentials(options)`，静默回退到
env / CodeArts / S1 文件凭证。D3-C14 探针（隔离 HOME + 清空 env + 存在 S1 文件凭证）执行
`clearRuntimeCredentials()` → `resolveCredentialsWithRuntime({})`，期望抛 `HDKIT_CRED_MISSING`，实际返回了
文件凭证（凭证泄漏风险：clear 后使用了调用方并未同意使用的另一账号）。

## 目标语义

1. `runtimeCredentials` 非空 → 返回 runtime 凭证（不变）。
2. `runtimeCredentials` 为空且本进程内发生过主动 clear（`runtimeCleared=true`）→ 不回退 env/CodeArts/S1：
   - `allowMissing` 时返回 `null`；
   - 否则抛 `code=HDKIT_CRED_MISSING` 的错误（复用 `resolveCredentials` 现有错误构造与 onboarding 提示）。
3. 进程初始状态（从未 set/clear）→ 保持现状，env/CodeArts/S1 正常解析（MCP 冷启动不受影响）。
4. `setRuntimeCredentials()` 重新置 `runtimeCleared=false`，恢复 runtime 通道。

## 影响面（已核实调用方）

`tools.mjs`（status 面板 / STS 检查 / OBS）、`sandbox/hwlink-api.mjs getCredentials`、`auth/reconcile.mjs scanState`、
`hcloud-cli.mjs`（allowMissing + try/catch 容错）、`auth/service.mjs computeStsExpiry`（allowMissing）。
所有调用点均有 try/catch 或 allowMissing 容错，clear 后抛 `HDKIT_CRED_MISSING` 不会产生未捕获崩溃；
`syncAuth` 主流程直接读 S1 文件，不经 runtime 解析器，不受影响。

## 验收标准

- 隔离 HOME + 空 env + 存在 S1 文件凭证时，clear 后 `resolveCredentialsWithRuntime()` 必须抛
  `HDKIT_CRED_MISSING`（不得返回文件凭证 ak）。
- set 后返回注入值（不变）；进程初始状态行为不变。
- 全量单测通过（含归口后的 auth-credentials 用例）。
