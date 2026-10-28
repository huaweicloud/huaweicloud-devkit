# Issue #1046 task checklist

- [x] T1 `normalizePersistMode` + `sessionMeta`/`releasedWorkspaces` 元数据（session-manager.mjs）
- [x] T2 `hdkitReleaseSession` 封装（hdkitservice-api.mjs，mark-only 不臆造接口）
- [x] T3 `closeSession` 按 persist_mode 分流（ephemeral 回收幂等 / persistent 仅断终端）
- [x] T4 `setWorkspaceId` 记录 persist_mode；`closeAllSessions` 走同一分流
- [x] T5 `exposeTunnel` AUTO-ENROLL 仅 persistent（ephemeral 不自动保活）
- [x] T6 `tools.mjs`：connect 入参 persist_mode + close_session 结构化返回
- [x] T7 测试：test/issue-1046-persist-mode.test.mjs + structure.test.mjs guard
- [x] T8 npm test / lint / validate / format 全通过
- [x] T9 建 PR（base=dev）
