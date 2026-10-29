# Issue #980 方案设计（plan）

## 修复方案

### D8-9 · telemetry sanitizeValue

- 在 `sanitizeValue` 中新增 `redactSensitiveText()`：复用 `safety-policy.mjs` `redactString` 的三类模式（opaque blob / 敏感键名 / AK-SK），全部加 `gi` 标志覆盖大小写变体。
- **脱敏先于换行折叠**：opaque-blob 规则的 `.*` 不跨行，若折叠后再脱敏会把整值吞掉；先脱敏再折叠保持与 redactString 一致的行内语义。
- 顺序：`redactSensitiveText` → 控制字符折叠 → trim → 超长截断。无法结构化解析的值维持现有清理行为，不引入异常。

### D2-4 · safety-policy redactString / isSecretKeyName

- `(AK|SK)` 正则捕获组扩展为包含分隔符并加 `i` 标志：`((?:AK|SK)\s*[:=]\s*)…/gi`，小写 `ak=`/`sk=` 命中，输出保留原分隔符（`ak=<redacted>`）。
- `isSecretKeyName` 归一化正则增加 `^(ak|sk)$`，对象键路径的裸 `ak`/`sk` 键值替换为 `<redacted>`。

## 测试方案

- `test/telemetry.test.mjs`：新增 4 个用例（大小写 AK/SK 变体、token/password/adminPass 键、控制字符混合、脱敏先于截断）。
- `test/safety-policy.test.mjs`：新增 2 个用例（字符串路径小写/混合大小写变体、对象键路径裸 ak/sk）。

## 回归风险

- AK/SK 输出格式由 `AK=<redacted>`（固定补 `=`）改为保留原分隔符（`ak:` → `ak:<redacted>`）：现有测试均为 `<redacted>` 正则断言，已验证兼容。
- 遥测值包含 `token=`/`password=` 等键名的正常文案会被脱敏——过度脱敏是安全正向偏置，符合 Issue 期望行为。
