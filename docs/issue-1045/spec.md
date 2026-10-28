# Issue #1045 需求文档（spec）

## 目标

`huaweicloud_sandbox_connect` 暴露 `persist_mode` 参数（enum: `ephemeral` | `persistent`），缺省行为与现状完全一致（向后兼容）。

## 语义

- `ephemeral`（缺省）：会话结束后沙箱与数据盘销毁——与现状完全一致
- `persistent`：沙箱数据盘跨会话保留复用
- 不传时：请求体不携带 `persist_mode` 字段，服务端按现状处理，老版本升级零行为变化

## 改动点

1. `plugins/huaweicloud-core/src/tools.mjs` — `huaweicloud_sandbox_connect` inputSchema 增加 `persist_mode`（enum + description 说明两模式语义差异与缺省行为）
2. `plugins/huaweicloud-core/src/sandbox/hdkitservice-api.mjs` — `hdkitConnect` 仅在显式传入时向 connect 请求体写入 `persist_mode`
3. `plugins/huaweicloud-core/src/tools.mjs` connect case — 非法值直接报参数错误（文案含合法取值）；连接结果透传 `sandbox_mode` 元数据（服务端未返回时不硬编码，为 #1047 做准备）

## 约束与边界

- 缺省不发送 `persist_mode` 字段（禁止无条件写入缺省值）
- 非法值不静默回退，直接报错
- 不实现 #1046（session-manager 生命周期分流）、#1047（返回值文案提示）
- 不臆造 hdkitservice 服务端接口

## 验收标准

1. 显式传 `persist_mode=persistent/ephemeral` 时请求体携带该字段
2. 不传时请求体与旧版完全一致（`persist_mode` 键不存在）
3. 非法值返回明确参数错误（文案含合法取值）
4. 工具 schema 描述两模式语义清晰
