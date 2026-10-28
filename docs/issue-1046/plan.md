# Issue #1046 plan

1. `plugins/huaweicloud-core/src/sandbox/session-manager.mjs`
   - 模块级新增：`sessionMeta` Map（key 同 sessions：`workspaceId:username`，
     值 `{ persistMode }`）、`releasedWorkspaces` Set（幂等回收标记）、
     `getCurrentPersistMode(workspaceId, username)` / `setSessionPersistMode()`
     纯函数 + `normalizePersistMode()`（非法/未传 → `'ephemeral'`）。
   - `getSession(workspaceId, username, timeoutMs)` 不改签名：内部读取
     已记录的 meta（由 setWorkspaceId/connect 路径预置），缺省 ephemeral。
   - `closeSession(workspaceId, username)` 分流：
     - ephemeral：`releasedWorkspaces.has(key)` 则跳过回收（幂等）；
       否则调用 `hdkitReleaseSession` + 清理 sandbox 内 watchdog
       （`pkill -f "tunnel-keepalive.sh"`，临时沙箱不留长期隧道）+
       `releasedWorkspaces.add(key)`。
     - persistent：仅 `session.close()`，watchdog 保留。
     - 返回值从 boolean 扩展为 `{ closed, persistMode, recycled,
recycleSkipped?, watchdogStopped }`（tools.mjs 适配）。
   - `setWorkspaceId(id, persistMode)`：第二参数记录
     `currentPersistMode`（模块级），供 exposeTunnel 分流查询。
   - `exposeTunnel`：AUTO-ENROLL 分支改为
     `keepalive !== false && persistMode === 'persistent'`；
     ephemeral 时在返回 `keepalive` 字段中给出
     `{ enrolled: false, reason: 'ephemeral_session' }`（显式
     `keepalive:true` 仍强制 enrol）。
   - `closeAllSessions()`：对 ephemeral 会话走同一回收分流。
2. `plugins/huaweicloud-core/src/sandbox/hdkitservice-api.mjs`
   - 新增 `hdkitReleaseSession(devStageId, { persistMode = 'ephemeral' } = {})`：
     服务端无 delete/release 端点（已盘点 8 个现有端点）→ 返回
     `{ ok: true, released: true, mode: 'mark-only', devStageId, persistMode,
note: '...' }`；后续端点可用时在 `hdkitRequest('POST', 'release', ...)`
     处替换，调用方无需改动。
3. `plugins/huaweicloud-core/src/tools.mjs`
   - `huaweicloud_sandbox_connect`：schema 增 `persist_mode`
     （enum，默认 ephemeral，description 说明两模式语义与 watchdog 影响）；
     `hdkitConnect(args)` 已透传 body 字段（hdkitConnect 内
     `if (options.persist_mode) body.persist_mode = ...`）；
     `setWorkspaceId(devStageId, persistMode)`。
   - `huaweicloud_sandbox_close_session`：返回值改为结构化对象
     （closed/persistMode/recycled/watchdogStopped），保持
     `not_connected` 语义向后兼容（closed=false 时仍可返回字符串）。
     —— 注意 #1047 下游会在此基础上做完整提示，此处只给最小结构化字段。
4. 测试 `test/issue-1046-persist-mode.test.mjs`（新增，node --test）
   - 纯函数：`normalizePersistMode`（未传/非法→ephemeral、persistent 透传）。
   - `hdkitReleaseSession`：mark-only 返回结构（不真实发请求——
     mock 不了就直接断言导出函数存在 + 返回字段，见实现）。
   - `closeSession` 分流（mock sessions Map 无法直接注入——通过导出的
     测试辅助 `__setSessionForTest` 或以 structure 断言为主，见实现取舍）。
   - watchdog 分流：`exposeTunnel` 的 enrol 条件改为结构断言
     （`persistMode === 'persistent'` 出现在 AUTO-ENROLL 守卫中）+
     structure.test.mjs 补 guard。
   - `test/structure.test.mjs`：新增 guard——session-manager 必须包含
     `normalizePersistMode`、`hdkitReleaseSession` 调用、
     `releasedWorkspaces` 幂等标记、exposeTunnel 的 persistent 守卫。
5. 验证：`npm test`、`npm run lint`、`npm run validate`、`npm run format`。
