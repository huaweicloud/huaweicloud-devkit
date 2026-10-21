# Issue #911 需求文档（Spec）

## 背景

v1.1.8 版本全量测试发现 `queryDistTagsFetch`（plugins/huaweicloud-core/src/update-check.mjs）存在 3 项缺陷：

1. **AbortController signal 未传递**：创建了 `controller` 与超时 `timer`，但调用 `fetchWithProxy(url)` 时未传 `{ signal: controller.signal }`，超时 abort 无法中断 in-flight fetch，慢响应场景查询不会被 5s/15s 超时截断。
2. **默认超时 15000ms 过长**：验收标准要求收敛至 5000ms 边界。
3. **错误日志输出 `[object Object]`**：`debugLog(\`${error?.message || error}\`)`当 error 无`message`属性时模板字符串化输出`[object Object]`。

## 目标

- 慢响应场景查询在 5000ms 边界内返回（timeout-bounded ≤5000ms + 合理误差）。
- 超时后返回 `null`，无未捕获异常。
- 超时日志输出明确错误信息，不再输出 `[object Object]`。
- 自定义 registry（`HUAWEICLOUD_NPM_REGISTRY`）场景同样 5s 收敛。

## 范围

- In：`queryDistTagsFetch` 函数（传 signal、默认 5000、错误日志安全字符串化）；`test/update-check.test.mjs` 新增超时边界测试。
- Out：`queryDistTagsSync` / `queryDistTags` / 缓存与升级逻辑（不在本 Issue 范围）。
