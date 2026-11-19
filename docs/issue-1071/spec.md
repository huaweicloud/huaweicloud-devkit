# Issue #1071 — 沙箱资源池定稿口径落码（1.1.13-next.1）

## 背景

沙箱接入新专用资源池：**非持久化（ephemeral）** 与 **持久化（persistent）** 两类沙箱实例。资源池上线评审五问已定稿，本需求把定稿口径写入插件（agent 引导层与工具描述），随 1.1.13-next.1 发版生效。

## 需求（定稿口径）

1. **场景路由**（SKILL.md）
   - 非持久化：预览/试用/一次性任务/敏感内容（即焚），固定 3h
   - 持久化：开发工作台/带数据库项目/跨日评审展示，挂 EVS 32G
   - agent 按意图自动选 + 用户可覆盖；烧核时播报（赠送+活动赚取口径）
2. **生命周期**（SKILL.md 生命周期章节）
   - 持久化：1h 闲置关机（当前平台 10min 需放宽）+ 三信号活性（connect/进程/预览流量）+ 关机前用户侧提醒
   - 非持久化：固定 3h（CreateTime 判定）
   - 保留期 14 天（业务定稿）→ 资源组闲置删除策略回收（不开放删除 API 给 devkit）
   - 删除：用户主动删（devkit 提供二次删除确认）+ 资源组策略回收 + devkit 不做延后代删
3. **配额**（工具描述）
   - 每类型各 1 个（可同时持有 1 非持久 + 1 持久，同类复用）
   - 超限：HTTP 429 + Retry-After + 错误码（区分配额超限/容量不足）
4. **限流/资源参数**（参考文档 references/resource-pool.md）
   - 申请：持久 2U4G×300 + 4U8G×200、非持久 2U4G×1000、overlayer 5GB/实例、EVS 300TB
5. **关键依赖（G 清单，SKILL.md 标注）**
   - G1 闲置删除策略配置 / G2 活性三信号 / G3 状态查询 API / G4 销户开机处置 / G5 销户实例回收

## 变更范围

- `plugins/huaweicloud-core/skills/huawei-sandbox/SKILL.md`（主要：资源池路由 + 生命周期章节 + G 清单）
- `plugins/huaweicloud-core/skills/huawei-sandbox/references/resource-pool.md`（新增：资源/限流参数）
- `plugins/huaweicloud-core/src/tools.mjs`（`huaweicloud_sandbox_connect` 工具描述补配额/429 语义）
- `test/issue-1071-sandbox-resource-pool.test.mjs`（新增验收守卫）
- 版本号 1.1.13-next.0 → 1.1.13-next.1（package.json + 7 个清单文件同步）

## 验收标准（来自 Issue）

1. SKILL.md 路由表含两沙箱场景与选择规则
2. 生命周期口径（1h/3h/14天/三信号）在 SKILL.md 可查
3. 429+Retry-After 语义在工具描述中
4. `node --test` 全绿

## 非目标

- G1–G5 为平台侧（hdkitservice）外部依赖，devkit 仅在 SKILL.md 标注，不实现
- 不改动其他服务域的 skill/工具
- 不切新版本基线（走 next 线）
