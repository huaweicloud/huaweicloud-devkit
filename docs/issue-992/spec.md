# Issue #992 — huawei-obs 浏览器直传避坑与 CORS 配置指引（需求文档）

## 背景

Issue #992（type/bug · priority/critical · area/api）：开发者使用 OBS BrowserJS SDK 3.25.6 做浏览器直传时踩到的 6 类已知陷阱，`plugins/huaweicloud-core/skills/huawei-obs/` skill 完全未覆盖：

1. CORS AllowedMethod 缺 HEAD → SDK 探测请求被拒，浏览器只显示 Network Error
2. `signature:'v4'` 被 initFactory 静默忽略（降级 v2）
3. 预签名 URL 的 token 参数大小写陷阱（`X-Amz-security-token` vs `x-amz-security-token`）
4. V4 头部签名在浏览器端不可用
5. OBS 错误响应缺 CORS 头 → 浏览器吞掉错误体
6. KooCLI OBS 包装层无 `cors` 子命令，skill 未给出 CORS 配置替代路径

## 目标

在 `plugins/huaweicloud-core/skills/huawei-obs/` 内（且仅在此范围内）：

1. `references/common-pitfalls.md` 新增「浏览器直传（BrowserJS SDK）」章节，覆盖需求 1–5
2. 扩充「CORS 配置」小节覆盖需求 6：KooCLI 缺口说明 + REST API `PUT /?cors` + esdk-obs-python `setBucketCors` 两条可复制替代路径
3. 章节内附可直接复制的最小修复片段
4. `SKILL.md` description 补充浏览器直传触发词
5. 通过 `npm run lint` 门禁

## 范围边界

- 不改写 `common-pitfalls.md` 及其他 references 文件的既有章节内容
- 不动 `plugins/` 下除 `huaweicloud-core/skills/huawei-obs/` 外的内容、`rules/`、`bin/`、`scripts/`
- 不新增任何 MCP 工具
- 范围外事项（KooCLI 上游收录 cors 子命令、p03 文档修正、自动预检 hook）已由 Issue 显式排除

## 验收标准（7 条，可机器判定）

| #   | 判定命令                                            | 通过标准                                                                      |
| --- | --------------------------------------------------- | ----------------------------------------------------------------------------- |
| 1   | `grep -c 'x-amz-security-token' common-pitfalls.md` | ≥ 1，且同文件含 `is_signature_negotiation`、`signatureContext`、`?apiversion` |
| 2   | CORS 示例 AllowedMethod                             | 同时含 GET、PUT、POST、DELETE、HEAD                                           |
| 3   | OPTIONS 预检诊断命令                                | 含 `Access-Control-Request-Method` 字样                                       |
| 4   | CORS 替代路径                                       | `grep setBucketCors` ≥ 1，且含 `PUT /?cors`                                   |
| 5   | KooCLI 缺口说明                                     | grep `cors` 命中该说明                                                        |
| 6   | `grep -c '浏览器直传' SKILL.md`                     | ≥ 1                                                                           |
| 7   | `npm run lint`                                      | 退出码 0                                                                      |

## 兼容性约束

- `test/structure.test.mjs` 中对 huawei-obs SKILL.md 的既有断言（Routing Guard 段、④选项顺序等）不得破坏
- 新增内容须符合 markdownlint-cli2 配置（MD024 siblings_only 等）与 Prettier 格式
