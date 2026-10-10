# Issue #866 缺陷修复 Spec

## 背景

每日测试（Hermes-GLM-5.2 Windows 2026-10-09，1.1.8-next.1/2）缺陷合并单，含 3 项待修复缺陷。

## 缺陷与方案

### #1【P0】D4-2 凭证环境变量检测盲区（Windows %VAR% 语法）

- 现状：`env | grep HW_SECRET` / Unix `$HW_*` 已拦截（历史 #770 修复）；`echo %HW_ACCESS_KEY%` 仍 allow。
- 方案：`plugins/huaweicloud-core/src/safety-policy.mjs` 凭证变量引用检查新增 Windows cmd `%VAR%` 分支，覆盖 `%(HUAWEICLOUD|HWC|HW|OS)_(SECRET_ACCESS_KEY|ACCESS_KEY|SECRET_KEY|SECURITY_TOKEN)%`。
- 验收：`echo %HW_ACCESS_KEY%`、`echo %HUAWEICLOUD_SECRET_ACCESS_KEY%` → deny；`echo %PATH%` 不误报；现有 Unix 拦截不受影响。

### #2【P1】EXP-E serviceCatalog 中文意图路由覆盖率 21.4% → ≥90%

- 现状：`plugins/huaweicloud-core/src/tools.mjs` `serviceCatalog` routeMap 中文同义词覆盖不足，日常自然语言意图（购买/多少钱/审计日志/消息队列/防攻击等）MISS。
- 方案：扩展 routeMap 各服务的中文同义词关键词（服务别名 + 场景动词短语），不改英文关键词与匹配算法（英文路由不受影响）；回归测试阈值 0.8 → 0.9 并补充中文用例。
- 验收：中文评测意图路由准确率 ≥90%；英文路由用例全部保持原结果。

### #3【security】D4-15 hook 绕过：ANSI-C 引号未解码

- 现状：`plugins/huaweicloud-core/src/risk-rule-engine.mjs` 纯文本正则匹配，`$'\x72m -\x72f /'` 等 ANSI-C 引号内 `\xNN`/`\uNNNN` 转义后的内层命令逃过规则匹配。
- 方案：规则匹配前增加 ANSI-C 引号解码预处理层——解析 `$'...'` 内转义（`\xNN`、`\uNNNN`、`\UNNNNNNNN`、八进制、`\cX`、C 简写转义），将解码结果追加到待匹配文本，再执行全部 hook 风险规则。
- 验收：D4-15 payload（如 `bash -c $'rm -\x72f /'`、`echo $'\x68cloud IAM DeleteUser'`）→ deny/warn 拦截；正常命令不误报（`echo $'hello'` → allow）。

## 测试计划

- `test/safety-policy.test.mjs`：新增 Windows `%VAR%` deny/不误报用例。
- `test/tools.test.mjs`：阈值升至 0.9，新增中文自然语言意图用例。
- `test/risk-rule-engine.test.mjs`：新增 ANSI-C 解码 deny 拦截 + 不误报用例。
