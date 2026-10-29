# Issue #1014 task checklist

- [x] 根因分析：user_hash null 的代码路径（enqueue 早于 userHash 加载 + 不回填）
- [x] telemetry.mjs：flushEvents 可 await、backfillIdentityFields、installId 惰性恢复
- [x] telemetry.mjs：flushAllEvents + SIGTERM/SIGINT 退出兜底（3s 有界）
- [x] tools.mjs：领券 case 补调 cacheUserHash
- [x] mcp-protocol.mjs：领券工具 callTool 完毕后 await flushEvents()
- [x] 单测：test/issue-1014-telemetry-flush.test.mjs
- [x] lint / test / validate
