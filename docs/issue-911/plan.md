# Issue #911 方案设计（Plan）

## 现状缺陷定位（update-check.mjs:236-254）

```js
export function queryDistTagsFetch({ timeoutMs = 15000 } = {}) {
  ...
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetchWithProxy(`${registry}/-/package/huaweicloud-devkit/dist-tags`)  // ← 未传 signal
    .then(...)
    .catch((error) => {
      debugLog(`queryDistTagsFetch: ${error?.message || error}`);               // ← [object Object] 风险
      return null;
    });
}
```

`fetchWithProxy(url, options = {})`（proxy-agent.mjs:40）直接把 `options` 透传给 `fetch`/`undiciFetch`，因此传 `{ signal }` 即可生效，代理与直连两条路径都被同一个 signal 覆盖。

## 改动方案

1. **传 AbortSignal**：`fetchWithProxy(url, { signal: controller.signal })`。abort 时 fetch 以 `AbortError` reject，落入现有 `.catch` 分支返回 `null`，天然无未捕获异常。
2. **默认超时收敛**：`timeoutMs = 15000 → 5000`。
3. **错误日志安全字符串化**：新增局部 helper：
   ```js
   function errorText(error) {
     if (error?.message) return error.message;
     try {
       return JSON.stringify(error);
     } catch {
       return String(error);
     }
   }
   ```
   catch 中改用 `debugLog` 拼接 `errorText(error)` 的返回值。JSON.stringify 对普通对象输出结构化文本（非 [object Object]）；循环引用兜底 String(error)。

## 测试方案（test/update-check.test.mjs 新增）

- 本地 `node:http` 慢服务器（收到请求不响应，保持连接挂起）作为自定义 registry。
- 用例 A：默认参数（不传 `timeoutMs`）→ 断言 elapsed ≤ ~5300ms 且结果 `null`（5s 边界收敛）。
- 用例 B：自定义 `timeoutMs: 300` → 断言 elapsed < 2000 且结果 `null`（signal 真正中断 in-flight fetch，否则挂到 15s/连接超时）。
- 用例 C：DEBUG=1 下捕获 `console.error`，断言日志含 `queryDistTagsFetch` 且不含 `[object Object]`。
- 保留现有两条 `queryDistTagsFetch` 用例（成功形状 + registry 覆盖降级）。

## 风险与回滚

- 单函数改动，行为兼容：调用方（`getCachedUpdateInfo` 默认 `doQuery = queryDistTags` 不变；`tools.mjs` 侧 `queryDistTagsFetch` 显式传 timeoutMs 的调用不受默认值变化影响——需走查确认）。
- 回滚：revert 单 commit 即可。
