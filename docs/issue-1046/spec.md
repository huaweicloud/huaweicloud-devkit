# Issue #1046 spec：session-manager 按 persist_mode 分流生命周期

## 背景

当前沙箱生命周期不区分模式：`huaweicloud_sandbox_close_session` 只做
`sessions.delete(key) + session.close()`（终端连接断开），无论用户意图如何，
数据盘与实例生命周期策略一致。`exposeTunnel` 对所有会话一律 AUTO-ENROLL
keepalive watchdog，临时沙箱也会产生长期隧道。

需要按 `persist_mode` 分流：

- **ephemeral**（默认，向后兼容）：会话结束即回收（含 /workspace 数据盘清理）。
- **persistent**：仅关闭终端会话，数据盘与实例保留，重连可复用
  （不影响 one-user-one-instance 复用语义）。

## 依赖与边界

- 依赖 #1045（persist_mode 参数入口与连接元数据）。#1045 尚未合入 dev——
  本Issue 在 `huaweicloud_sandbox_connect` 工具入参上直接补齐
  `persist_mode`（带 `ephemeral` 默认值），使本Issue 独立可用且与 #1045 语义一致；
  #1045 的「参数入口规范化」后续可在此基础上收敛，不冲突。
- 下游 #1047（返回值提示与 TTL 播报）不在本Issue 范围。
- **不臆造接口**：盘点 `hdkitservice-api.mjs` 现有端点
  （check-user / generatorUserIDHash / sign-agreement / connect / credentials /
  voucher/status / voucher/claim / competition/voucher/claim）——
  **服务端当前没有提供 sandbox delete/release 端点**，hwlink open-api 仅有
  connections 的创建/查询。因此回收动作采用 Issue 允许的替代方案：
  **连接状态标记 + 提示代替真实回收接口调用**，封装在
  `hdkitservice-api.mjs` 中（`hdkitReleaseSession`），端点出现后只需替换
  该封装内部实现。

## 需求（改动点）

1. `plugins/huaweicloud-core/src/sandbox/session-manager.mjs`
   - `getSession()`：连接时把 `persist_mode` 写入会话元数据
     （`sessionMeta` Map，与 `sessions` 平行维护），未传/非法值归一化为
     `ephemeral`（向后兼容）。
   - `closeSession()`：按模式分流——
     - ephemeral：标记 `released`（幂等保护），调用
       `hdkitReleaseSession(devStageId, { persistMode })` 触发回收流程，
       并清理 watchdog（停止临时沙箱的长期隧道保活）；
     - persistent：仅断终端会话，保留数据盘与实例，
       **不清理 watchdog**（数据盘保留期间隧道保活有意义）。
   - `setWorkspaceId()` / 连接路径：记录当前工作区的 persist_mode。
   - 回收幂等：`releasedWorkspaces` Set —— 重复 close/断连不重复回收；
     persistent 重连（one-user-one-instance 复用）后重新可回收。
2. `plugins/huaweicloud-core/src/sandbox/hdkitservice-api.mjs`
   - 新增 `hdkitReleaseSession(devStageId, { persistMode })`：
     当前服务端无 delete/release 端点 → 返回
     `{ ok: true, mode: 'mark-only', released: true, devStageId, persistMode }`
     （连接状态标记 + 提示代替，不臆造接口）；服务端提供端点后在此处透传。
3. keepalive watchdog 分流
   - `exposeTunnel` AUTO-ENROLL 前查询当前会话 persist_mode：
     仅 persistent 模式自动 enrol；ephemeral 不自动保活
     （`keepalive.enrolled=false, reason='ephemeral_session'`），
     显式 `keepalive:true` 仍可强制 enrol（用户明确管理）。
   - `installKeepaliveWatchdog` 本身不感知模式（保持通用工具语义）。
4. `plugins/huaweicloud-core/src/tools.mjs`
   - `huaweicloud_sandbox_connect` inputSchema 增加 `persist_mode`
     （enum: ephemeral|persistent，默认 ephemeral），透传给 hdkitConnect body
     与 setWorkspaceId 元数据。
   - `huaweicloud_sandbox_close_session` 返回值增加分流信息
     （`persistMode` / `recycled` / `watchdogStopped`——#1047 的完整提示在此基础上扩展）。

## 约束

- **幂等保护**：重复 close / 断连不重复回收（releasedWorkspaces 集合）。
- **one-user-one-instance 复用语义**：persistent close 不影响重连复用已有实例；
  ephemeral 回收后下次 connect 走服务端新建（服务端语义）。
- 未传 `persist_mode` 走 ephemeral 分支（向后兼容，验收 4）。

## 验收标准（对应 Issue 4 条）

1. ephemeral 模式 close 后沙箱进入回收流程且幂等
   （hdkitReleaseSession 被调用且仅一次；重复 close 不再触发）。
2. persistent 模式 close 仅断终端会话（不调用回收、不停 watchdog），
   重连后 /workspace 数据仍在（one-user-one-instance 复用，
   sessions 元数据在重连 getSession 时重建）。
3. watchdog 分流正确：ephemeral 会话 exposeTunnel 不自动 enrol
   （enrolled=false + reason）；persistent 会话默认自动 enrol。
4. 未传 persist_mode 时走 ephemeral 分支（默认归一化）。
