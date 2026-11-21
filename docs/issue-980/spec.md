# Issue #980 需求文档（spec）

## 目标

修复安装 ID 遥测链路敏感值脱敏缺失（D8-9）与凭证脱敏大小写缺口（D2-4）：

1. `sanitizeValue`（`plugins/huaweicloud-core/src/telemetry/telemetry.mjs`）仅做控制字符清理与超长截断，AK/SK/token 等敏感值可原样进入遥测负载（v1.1.9 → v1.1.10 连续复现）。
2. `redactString`（`plugins/huaweicloud-core/src/safety-policy.mjs`）的 `(AK|SK)` 正则无 `i` 标志，小写 `ak=`/`sk=` 明文残留；`isSecretKeyName` 键名归一化未含 `ak`/`sk` 简写。

## 范围

- 仅 D8-9 与 D2-4（均归口 #980）。D4-21/D4-6/D4-26 归口 #752/#712/#857，不在本单范围。

## 验收标准（对齐 Issue body）

- [x] 含 AK/SK/token（含小写 `ak=`/`sk=` 变体）的遥测负载经 `sanitizeValue` 后敏感值为 `<redacted>`，无明文残留
- [x] 单元测试覆盖：大小写键名变体、token 键、控制字符+敏感值混合输入、截断与脱敏叠加
- [x] 现有遥测/清理/脱敏相关测试全部通过（无功能回归，810/810）
