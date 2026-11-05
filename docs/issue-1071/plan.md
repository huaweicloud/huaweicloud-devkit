# Plan — Issue #1071

## 方案

定稿口径属于「agent 引导知识」+「工具语义提示」，落点分三层：

| 层           | 文件                                                        | 内容                                                                                                                                                                       |
| ------------ | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Skill 路由层 | `skills/huawei-sandbox/SKILL.md`                            | 新增「Resource Pool Selection」章节（场景路由表 + agent 自动选/用户覆盖 + 烧核播报口径）与「Sandbox Lifecycle & Retention」章节（1h/3h/14天/三信号/删除语义 + G1–G5 标注） |
| 参考文档层   | `skills/huawei-sandbox/references/resource-pool.md`（新增） | 资源池申请/限流参数（持久 2U4G×300 + 4U8G×200、非持久 2U4G×1000、overlayer 5GB/实例、EVS 300TB）、配额语义（每类型 1 个、429+Retry-After、配额 vs 容量错误码区分）         |
| 工具描述层   | `src/tools.mjs`                                             | `huaweicloud_sandbox_connect` 描述补：双资源池、每类型 1 实例配额、超限 HTTP 429 + Retry-After、区分配额超限/容量不足                                                      |

版本：`npm version 1.1.13-next.1` → `node scripts/sync-version.mjs` → 手动同步根 `plugin.json` 与 `openclaw.plugin.json`（validate 强制 7 文件一致）。

测试：新增 `test/issue-1071-sandbox-resource-pool.test.mjs` 守卫四条验收标准。

## 提交拆分（原子）

1. `feat(sandbox): #1071 resource pool routing + lifecycle semantics in skill`
2. `feat(sandbox): #1071 quota/429 semantics in connect tool description + resource-pool reference`
3. `test(sandbox): #1071 acceptance guards for resource pool finalized semantics`
4. `chore(release): #1071 bump 1.1.13-next.1`

## 验证

```bash
npm test
npm run lint
npm run validate
npm run format:check
```
