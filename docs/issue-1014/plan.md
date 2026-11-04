# Issue #1014 plan

## 改动文件

（`src/` 前缀均相对 `plugins/huaweicloud-core/`。）

| 文件                                       | 改动                                                  |
| ------------------------------------------ | ----------------------------------------------------- |
| `src/telemetry/telemetry.mjs`              | 见下方拆解                                            |
| `src/tools.mjs`                            | 领券 case 成功后补调 `cacheUserHash(result.userHash)` |
| `src/mcp-protocol.mjs`                     | `tools/call` 领券工具完毕后 `await flushEvents()`     |
| `test/issue-1014-telemetry-flush.test.mjs` | 新增单测（8 例）                                      |

telemetry.mjs 拆解：

- flush 重构为可 await 的 `flushEvents()`（in-flight promise 去重）
- 新增 `backfillIdentityFields()`：flush 前回填 userHash/installId
- `enqueueEvent`：installId 惰性恢复，不再丢弃事件
- 新增 `flushAllEvents()`：排空多批队列（退出兜底用）
- 新增 `registerExitFlush()`：SIGTERM/SIGINT 退出兜底（3s 有界）
- `initTelemetry`：注册退出兜底 handler

单测覆盖：backfill 回填（内存 + 文件两条路径）、installId 惰性恢复、
多批 drain、并发 flush 去重、领券 dispatch 同步 flush e2e、
退出注册幂等/可移除。

## 提交拆分

1. `feat: #1014 telemetry flush 可 await + 身份字段兜底 + 退出兜底 flush`
2. `feat: #1014 领券类工具 P0 同步 flush + cacheUserHash`
3. `test: #1014 遥测分级上报单测`
