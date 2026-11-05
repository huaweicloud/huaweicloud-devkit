# Issue #1040 task checklist

- [x] A1 agent-detect 兜底收敛 unknown（去掉 installSegment 拼接与 name 透传）
- [x] A2 installSegment 改为 telemetry 事件独立字段（安装位置）
- [x] A3 hdkitRequest / performFlush 携带 X-HW-Agent 头
- [x] A4 单测：test/issue-1040-agent-unknown.test.mjs + telemetry.test.mjs 更新
- [x] npm test / lint / validate 通过
- [x] 建 PR（base=dev），描述引用 hdkitservice 关联 PR
