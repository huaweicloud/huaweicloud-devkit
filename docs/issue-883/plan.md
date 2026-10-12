# Issue #883 — 实现方案（plan）

## 改动点

| # | 文件 | 改动 |
|---|------|------|
| 1 | `plugins/huaweicloud-core/src/auth/credentials.mjs` | 抽取 `missingCredentialsError()`（复用原 `resolveCredentials` 的 HDKIT_CRED_MISSING 构造）；新增模块级 `runtimeCleared` 哨兵：`setRuntimeCredentials` 置 false、`clearRuntimeCredentials` 置 true；`resolveCredentialsWithRuntime` 归口三分支语义 |
| 2 | `plugins/huaweicloud-core/src/tools.mjs` | `auth_init clear` / `auth_switch action=clear` 返回文案改为不承诺 env/file 回退 |
| 3 | `test/auth-credentials.test.mjs` | 'prioritizes runtime > env > vault' 重排（env/vault 段不再位于 clear 之后，结尾 clear 清理 runtime）；'set and clear workflow' 改为断言 clear 后抛 `HDKIT_CRED_MISSING` + `allowMissing→null` + 重新 set 生效；新增 'clear blocks env/vault fallback (D3-C14 probe semantics)' 用例 |
| 4 | `test/hdkitservice-api.test.mjs` | 'voucher status returns CRED_MISSING' 用例移至文件末尾（其 clear 会锁定本进程 runtime 语义，需置于依赖 env 凭证的 mock fetch 用例之后） |

## 不改动

- `tools.test.mjs` 'auth_switch clear resets runtime'、`cred-reconcile-e2e.test.mjs` 测试 11 已断言 clear 后抛错，与目标语义一致，保持通过。
- 与 PR #838（STS expired fallback to S1，改 `resolveCredentials` 内 env 层）正交：本次改动未触碰 `resolveCredentials` 的解析优先级，#838 相关 resolveCredentials 用例无回归（全量单测确认）。

## 验证

1. D3-C14 探针等价脚本：隔离 HOME + 清空 env + S1 文件存在 → initial 解析 S1、set 返回注入值、clear 后抛 `HDKIT_CRED_MISSING`、`allowMissing→null`。
2. `npm test` 全量通过（702 项，仅 1 项与本改动无关的 proxy 环境性失败，dev 基线同样失败）。
3. `node ./scripts/validate-package.mjs` 通过。
