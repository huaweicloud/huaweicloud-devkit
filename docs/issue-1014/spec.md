# Issue #1014 spec：遥测分级上报（P0 同步 flush + 身份字段兜底）

## 问题

- 近 48h `telemetry_event` 约 49% 的 `user_hash` 为 null。
- 根因（代码路径，`plugins/huaweicloud-core/src/telemetry/telemetry.mjs`）：

1. `enqueueEvent` 在 `initialize` 阶段 `hdkitGenerateUserHash()`（3s 超时竞速）
   完成前入队的事件，`buildEvent` 捕获的模块级 `userHash` 为 null，
   且 flush 时不会回填。
2. `enqueueEvent` 中 `if (!installId) return;` —— 未调用 `initialize`
   （如直接 `tools/call`）时事件被整体丢弃，造成 `telemetry_event` 缺记录。
3. 领券类工具（`huaweicloud_voucher_claim` /
   `huaweicloud_competition_voucher_claim`）执行后仅入队，
   依赖 60s 定时 flush；进程提前退出时事件丢失。
4. 无 SIGTERM/SIGINT 退出兜底 flush。

## 需求（用户 @lithinkit 确认的分级方案）

- **P0**：领券类工具在 `callTool` 执行完毕后 `await flushEvents()` 同步上报。
- **P0**：领券成功后补调 `cacheUserHash`（响应携带 userHash 时）；
  flush 前兜底 `loadUserHash()` / `generateOrRecoverInstallId()`
  补齐队列中缺失的 `user_hash` / `install_id` 字段。
- **P1**：非重要工具维持 60s 批量 flush，
  新增 SIGTERM/SIGINT 退出兜底 flush。

## 验收

- 队列中 userHash 为 null 的事件在 flush 前被回填
  （cacheUserHash 或 user-hash 文件存在时）。
- installId 缺失时事件不再被丢弃（惰性恢复）。
- 领券工具调用后事件同步送达（可 await）。
- 退出信号触发兜底 flush（有界超时，不阻塞退出）。
- 单元测试覆盖上述行为。
