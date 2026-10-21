# Issue #932 Spec — huawei-gaussdb skill「购买前选型与询价」能力

## 背景

`huawei-cloud-gaussdb-instance-management` skill 只覆盖实例生命周期（建/删/备份/参数/只读节点/分片）。
购买 GaussDB 之前的「选型 + 询价」无归属：`huawei-iac` 偏通用 IaaS 编排；`huawei-billing` 只做账单/余额。
来源提案 #924；前序 #925 已关闭未实施。

## 目标（对齐 Issue 验收标准）

1. SKILL.md 新增「购买前选型与询价」section，四步流程：
   - 收集决策输入（用途/数据规模与增长/并发 QPS/可用性/预算/region）——缺失即问、不猜
   - 拿规格与形态：复用现有 R3 查询能力（flavor 查询 `ShowGaussMySqlFlavors` / `ListFlavors`、实例选项发现）
   - 询价与预算：BSS `ListOnDemandResourceRatings`（按需）/ `ListRateOnPeriodDetail`（包年包月）/ `ShowCustomerAccountBalances`（余额），BSS region 固定 `cn-north-1`
   - 分档建议：开发测试→single 单副本；一般生产→triset 1主2备；大容量大并发→distributed
2. 扩展 frontmatter description 触发词：选型/询价/买库/预算（含英文 sizing/pricing/budget）——只增不改
3. 详细教学内容放 `references/pre-purchase-sizing-and-pricing.md`（SKILL.md 保持路由层）
4. 文档标注 BSS 询价适用范围：openGauss 可用（实测 `gaussdb.bs.kc1.xlarge.arm4.ha` 按需 ¥2.5/时与账单一致）；RDS `CBC.6074` / DCS `CBC.6006` 不可用需官网价估算（标注「估算」）
5. 边界：询价只读（R3）可自动执行；下单属计费写操作必须走 `huawei-iac` 审批
6. 无新增工具/action——全部复用现有 hcloud 命令与 BSS 命令；提醒 openGauss 起购规格偏大（4C16G ≈ ¥1825/月按需），纯小项目可能 RDS 更省

## 三 skill 分工（避免重复）

- `huawei-gaussdb`（本 skill）= 选型询价 + 实例生命周期
- `huawei-billing` = 账单/余额/询价 API 细节
- `huawei-iac` = 下单/成本门槛/审批/有序销毁

## 非目标

- 不新增 huawei_* action、不新增 MCP 工具
- 不改动现有 12 action 的行为（只增不改）
- 不覆盖 RDS/DCS 选型（超出 GaussDB 范围，仅在边界提示中对比）

## 验收

见 Issue #932 验收标准 6 项；测试上在 `test/structure.test.mjs` 增加守卫断言（section 存在、触发词存在、边界声明存在）。
