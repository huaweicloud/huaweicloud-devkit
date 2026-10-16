# Issue #932 Plan — 实现方案

## 变更范围（全部为文档/测试，无代码运行时变更）

| #   | 文件                                                                                                                             | 变更                                                                                                                                     |
| --- | -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `plugins/huaweicloud-core/skills/huawei-cloud-gaussdb-instance-management/SKILL.md`                                              | description 触发词追加（选型/询价/买库/预算 + 英文）；新增「Pre-Purchase Sizing and Pricing」section（路由层，四步流程 + 分档表 + 边界） |
| 2   | `plugins/huaweicloud-core/skills/huawei-cloud-gaussdb-instance-management/references/pre-purchase-sizing-and-pricing.md`（新增） | 教学层：决策输入清单、规格/形态发现命令、BSS 询价模板（按需/包周期/余额）、BSS 适用范围标注、分档建议、与 iac/billing 的分工边界         |
| 3   | `test/structure.test.mjs`                                                                                                        | 新增守卫测试：section 存在、触发词存在、CBC 错误码标注存在、下单走 iac 边界存在、无新增 action（仍为 12 个）                             |

## 设计要点

- SKILL.md 是路由层：只放四步流程概览 + 分档表 + 边界声明，细节进 references（符合 AGENTS.md ~80 行路由层原则；本 SKILL.md 历史上已超长，新增内容压缩到最小）
- 询价命令模板与 `huawei-iac/references/resource-catalog.md` §Pricing 保持一致（同一验证过的 BSS 模板），定价编码查证规则一致（错误组合报 CBC.6074，禁止猜测）
- 跨 skill 引用不得是死胡同：huawei-billing 覆盖余额查询、huawei-iac 覆盖 ListOnDemandResourceRatings 模板——引用处直接点名其文件/section
- 参数三分类：实测过的 spec code（`gaussdb.bs.kc1.xlarge.arm4.ha`、¥2.5/时）属 HELPFY 保留；service/resource type 编码未实测 → 用占位符 + 查证指引
- 分档建议表：开发测试→single（无 HA/SLA）；一般生产→triset 1主2备（强一致 HA）；大容量大并发→distributed（水平扩展）
- 起购提醒：openGauss 集中式最小单副本约 4C16G ≈ ¥1825/月按需；RDS 最小 2C4G ≈ ¥150/月——纯小项目可能 RDS 更省（但购买 RDS 走 huawei-rds/huawei-iac）

## 提交策略（原子提交）

1. `feat: #932 add pre-purchase sizing and pricing section to gaussdb skill`（SKILL.md + references + spec/plan/task 文档）
2. `test: #932 guard gaussdb pre-purchase section in structure tests`（structure.test.mjs）

## 验证

- `npm run lint:md`（docs/ 被 lint 排除，skill/references 必须过）
- `npm test`（structure.test.mjs 新守卫通过，既有测试不回归）
- `npm run validate`
- `npm run format:check`（必要时 format）

## 风险

- 网络不稳定（clone 已重试成功）；push/PR 走 grape CLI
- 未实测 BSS service/resource type 编码 → 文档用占位符 + 查证指引，不伪造
