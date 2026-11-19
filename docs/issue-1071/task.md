# Task — Issue #1071

- [x] T1 SKILL.md：新增 Resource Pool Selection（两沙箱场景路由表 + 自动选择/用户覆盖 + 烧核播报）
- [x] T2 SKILL.md：新增 Sandbox Lifecycle & Retention（1h 闲置关机 + 三信号 + 关机提醒 / 非持久 3h / 保留 14 天 / 删除语义）+ G1–G5 标注 + References 链接
- [x] T3 references/resource-pool.md：新建（限流/资源申请参数 + 配额/429 语义）
- [x] T4 src/tools.mjs：`huaweicloud_sandbox_connect` 描述补配额 429+Retry-After 语义
- [x] T5 test/issue-1071-sandbox-resource-pool.test.mjs：验收守卫（路由表/生命周期/429 语义/参数）
- [x] T6 版本 1.1.13-next.1：package.json + 7 清单同步
- [x] T7 验证：npm test / lint / validate / format:check 全绿
- [x] T8 建 PR（base dev）+ Issue 评论 + A2A QA
