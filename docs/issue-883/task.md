# Issue #883 — 任务拆解（task）

- [x] 根因确认：`clearRuntimeCredentials` 仅置 null，`resolveCredentialsWithRuntime` 无条件回退（D3-C14 泄漏路径）
- [x] `credentials.mjs`：抽取 `missingCredentialsError()`；新增 `runtimeCleared` 哨兵并归口 `resolveCredentialsWithRuntime` 三分支语义
- [x] `tools.mjs`：clear 返回文案不再承诺 env/file 回退（L1191/L1204 两处）
- [x] `test/auth-credentials.test.mjs`：两用例按新语义归口 + 新增 D3-C14 探针语义用例
- [x] `test/hdkitservice-api.test.mjs`：CRED_MISSING 用例移至文件末尾（进程级 clear 语义）
- [x] D3-C14 探针等价验证（隔离 HOME + 空 env + S1 文件 → clear 后抛 HDKIT_CRED_MISSING）
- [x] 全量 `npm test`（701/702 通过；1 项 proxy 失败为 dev 基线既有、与本改动无关）
- [x] `npm run validate`（validate-package 通过）
- [x] 建 PR（base=dev，Fixes #883）
