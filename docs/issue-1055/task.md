# Issue #1055 任务清单（task）

- [x] P0 D4-16 sh -c 包裹 env 打印 → deny（规则正则扩展）
- [x] P0 D4-3 KMS DecryptData 拦截（规则 + blockedSecretOperations）
- [x] P0 D4-21 HCL broad IAM 制品拦截（规则 HCL 分支）
- [x] P0 D2-4 小写 ak=/sk= 脱敏（gi + lookbehind 防误伤）
- [x] P0 D9-12 MCP initialize 时序门禁（-32002，按 session 隔离）
- [x] P1 D4-17 命令替换管道入 shell → deny（新规则）
- [x] P1 D3-S7 复合意图保留部署目标（deploymentIntent 并入 sandbox 路由）
- [x] P1 D2-10 KooCLI 报错精确串（error 字段契约化）
- [x] P1 EXP-E01 「云主机」命中 ECS
- [x] P2 D8-9 telemetry sanitizeValue 脱敏（redactSecrets 前置）
- [x] P2 D3-C14 沙箱无凭证精确串 credentials not configured
- [x] P2 D1-68 region 优先级 HUAWEICLOUD_REGION > HW_REGION
- [x] 回归测试 test/issue-1055-defects.test.mjs（12/12 通过）
- [x] 全量测试 / lint:js / validate / pack:verify
