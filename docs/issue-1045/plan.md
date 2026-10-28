# Issue #1045 方案设计（plan）

方案锚点：plans/20261028-sandbox-persistence-mode.md（来源 huaweicloud-mate/devkit-plans#3）

## 实现策略

### 1. Schema（tools.mjs TOOL_DEFINITIONS）

`huaweicloud_sandbox_connect` inputSchema 增加：

```js
persist_mode: {
  type: 'string',
  enum: ['ephemeral', 'persistent'],
  description: '...缺省 ephemeral（与现状一致）；persistent 保留数据盘跨会话复用；不传时不发送该字段...',
}
```

### 2. 透传（hdkitservice-api.mjs hdkitConnect）

条件展开，仅显式传入时写入：

```js
if (options.persist_mode !== undefined) body.persist_mode = options.persist_mode;
```

禁止无条件写入缺省值（否则破坏向后兼容验收 2）。

### 3. connect case（tools.mjs callTool）

- 入口校验：`persist_mode` 存在且不属于 enum → 抛参数错误，文案含合法取值（`Invalid params: persist_mode must be one of "ephemeral", "persistent" ...`）
- 结果透传：服务端返回 `sandbox_mode` 或 `persist_mode` 时，在返回值上补 `sandbox_mode` 元数据；未返回不硬编码

## 测试设计（test/issue-1045-sandbox-persist-mode.test.mjs）

mock `global.fetch` 捕获请求体，覆盖 4 条验收：

1. 显式 `persistent` / `ephemeral` → 请求体携带 `persist_mode`
2. 不传 → 请求体无 `persist_mode` 键（`Object.hasOwn` 断言为 false）
3. `callTool('huaweicloud_sandbox_connect', { persist_mode: 'bogus' })` → reject 且文案含合法取值，fetch 未被调用
4. TOOL_DEFINITIONS schema：enum 正确、description 同时说明两模式与缺省行为

补充：服务端返回模式元数据时结果带 `sandbox_mode`；未返回时不硬编码。

## 验证

`node --test test/issue-1045-sandbox-persist-mode.test.mjs` + `npm test` + `npm run lint` + `npm run validate`
