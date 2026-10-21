# Spec — Issue #985: GaussDB Agent 友好型联调 P0/P1/P2 问题汇总

## Objective

消化 GaussDB Agent 友好型联调（`gausstestproject`，cn-north-4，全生命周期 8 场景）发现的 P0/P1/P2 问题，在本仓库能力范围内落地改进，并跟踪上游数据面修复。

## Scope

| 优先级 | 问题                                                   | 归属                                         | 本仓库动作                                                                                                                                                                       |
| ------ | ------------------------------------------------------ | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0     | 数据面驱动 `verify-ca` 未真正校验 CA                   | 上游 `plafaithing/huawei-gaussdb-data-mcp#1` | 仅跟踪上游进展，不开分支不修码                                                                                                                                                   |
| P1     | 数据面驱动 Windows pyodbc 中文需 `ansi=False`          | 上游 `plafaithing/huawei-gaussdb-data-mcp#1` | 仅跟踪上游进展                                                                                                                                                                   |
| P1     | 公网入口（EIP）会被回收，链路不可自愈                  | 本仓库（运维指引缺失）                       | 在 `huawei-cloud-gaussdb-instance-management/SKILL.md` 补充 EIP 生命周期与重绑操作指引                                                                                           |
| P2     | RDS/DCS 商品走 BSS 询价不可用（`CBC.6074`/`CBC.6006`） | 本仓库（skill 未显式标注）                   | 在 `huawei-billing/SKILL.md` 与 `huawei-cloud-gaussdb-instance-management/SKILL.md` 增加「BSS 询价能力边界」section，口径与 `huawei-iac/references/resource-catalog.md` 备案一致 |

## Technical Approach

1. **P2 询价边界标注**：
   - `huawei-billing/SKILL.md`：新增「询价能力边界」section，列出可用产品（ECS）与不可用产品（EIP/RDS/DCS）及降级策略；
   - `huawei-cloud-gaussdb-instance-management/SKILL.md`：在「Critical Warnings」或新增 section 中标注 GaussDB 实例询价走官网价估算（BSS 元数据未覆盖 GaussDB for MySQL / openGauss 分布式）；
   - 口径与 `huawei-iac/references/resource-catalog.md` 行 97-99 一致；与 #924/#932 协同但不重复。

2. **P1(EIP) 重绑指引**：
   - 在 `huawei-cloud-gaussdb-instance-management/SKILL.md` 新增「EIP 回收与重绑自愈」section，含诊断步骤（`ShowInstanceEip` 查绑定状态）+ `hcloud EIP` 命令示例（`CreatePublicip` + `AssociatePublicips` 重绑）；
   - 性质为已知行为说明，非缺陷修复。

3. **P0/P1 上游跟踪**：
   - 在 `huawei-cloud-gaussdb-instance-management/SKILL.md` 末尾「Upstream Tracking」section 镜像上游 issue 链接与状态；
   - 不开分支不修码，待上游修复后回归 `verify-ca` 行为一致性。

4. **测试守卫**：
   - `test/structure.test.mjs` 增加断言：`huawei-billing/SKILL.md` 含「询价能力边界」section；`huawei-cloud-gaussdb-instance-management/SKILL.md` 含 EIP 重绑与上游跟踪引用。

## Acceptance Criteria

1. `huawei-billing` 与 `huawei-cloud-gaussdb-instance-management` SKILL.md 均含 BSS 询价边界标注，口径与 `huawei-iac/references/resource-catalog.md` 一致；
2. `huawei-cloud-gaussdb-instance-management` 含 EIP 回收说明与重绑操作指引；
3. 上游 issue `plafaithing/huawei-gaussdb-data-mcp#1` 状态在本 Issue / skill 有镜像跟踪；
4. 上述改动通过仓库 CI（`npm run lint` / `npm test` / `npm run validate` / `npm run format:check`）。

## Out of Scope

- 数据面 MCP（`drivers.py`）代码修复——属上游仓库，已提交 `plafaithing/huawei-gaussdb-data-mcp#1`；
- BSS 询价能力本身的修复（需 Huawei Cloud 后端支持）——仅文档降级标注；
- 新增 service skill 或重构现有 skill 结构。
