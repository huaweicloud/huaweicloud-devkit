# Issue #992 — 实现方案

## 改动清单（全部位于 plugins/huaweicloud-core/skills/huawei-obs/）

| 文件                            | 改动                                                                                                            | 对应需求    |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------- | ----------- |
| `references/common-pitfalls.md` | 文件末尾追加两个新章节：`## 浏览器直传（BrowserJS SDK）` + `## CORS 配置（浏览器直传前置条件）`；既有章节零改动 | 1–6         |
| `SKILL.md`                      | 仅改 description 一行，追加浏览器直传触发词；新增 References 行指向 common-pitfalls.md                          | 4（触发词） |

## 章节设计（common-pitfalls.md 追加内容）

### 章节一：浏览器直传（BrowserJS SDK）

按 Issue 6 条需求组织为「现象 → 根因 → 修复片段」三元组：

1. **CORS AllowedMethod 必须含 HEAD**：SDK 3.25.6 默认 `isSignatureNegotiation=!0`，listObjects 前先发 `HEAD ?apiversion` 探测；HEAD 不在 AllowedMethod → 预检 403 `AccessForbidden` 且无 CORS 头 → 浏览器只显示 Network Error
2. **signature:'v4' 被静默忽略**：3.25.6 `initFactory` 忽略该配置并降级 v2；V4 预签名须手动注入 `signatureContext = { signature:'v4', headerPrefix:'X-Amz-', headerMetaPrefix:'X-Amz-Meta-', authPrefix:'AWS4-HMAC-SHA256' }`
3. **token 参数大小写陷阱**：SDK 拼出混合大小写 `X-Amz-security-token` → OBS 大小写敏感 → 403 `AccessDenied`；必须以小写 `x-amz-security-token` 作为 QueryParams 传入
4. **V4 头部签名浏览器端不可用**：列表/删除等 HTTP 头鉴权用 V2 头部签名客户端（`is_signature_negotiation:false` 关闭协商），展示/上传走 V4 预签名 URL
5. **浏览器吞错诊断**：curl 实测 OPTIONS 预检（带 Origin + Access-Control-Request-Method/Headers）看真实状态码与错误体；或 Node 无 CORS 环境复现同一请求

### 章节二：CORS 配置（浏览器直传前置条件）

- 明确说明：KooCLI OBS 包装层未暴露 obsutil 的 `cors` 子命令（`hcloud OBS cors` → No such command）
- 替代路径 ①：REST API `PUT /?cors` + CORS XML 模板（含 AWS4 签名说明）
- 替代路径 ②：esdk-obs-python `setBucketCors` 最小示例（含凭证读取）
- CORS 示例 AllowedMethod 必须为 GET/PUT/POST/DELETE/HEAD

## SKILL.md description 改动

在 Triggers on 列表追加：`浏览器直传, browser direct upload, 预签名上传, 直传 OBS`（不动其他句子，structure.test.mjs 断言不受影响）。

## 验证方案

```bash
grep -c 'x-amz-security-token' plugins/huaweicloud-core/skills/huawei-obs/references/common-pitfalls.md   # ≥1
grep -c 'is_signature_negotiation\|signatureContext\|?apiversion' ...
grep -c '浏览器直传' plugins/huaweicloud-core/skills/huawei-obs/SKILL.md                                  # ≥1
npm run lint        # markdownlint + eslint，退出码 0
npm test            # structure.test.mjs 既有断言不回归
npm run format      # prettier --write（保证 format:check 过）
npm run validate    # 包结构校验
```

## 风险与约束

- 追加式改动，不触碰既有章节 → 对既有阅读路径零风险
- markdownlint MD024（siblings_only）允许不同父标题下的同名子标题；新章节用全新标题规避
- `?apiversion` 等特殊字符在 markdown 表格中需用反引号包裹（防止管道符/问号解析问题）
