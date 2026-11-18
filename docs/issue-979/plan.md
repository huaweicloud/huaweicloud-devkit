# Issue #979 plan

## 方案

`serviceCatalog()`（`plugins/huaweicloud-core/src/tools.mjs`）：

1. **复合意图分解**：sandbox 路由新增 CJK 关键词（`web 应用`/`web应用`/`应用部署`/
   `部署应用`）使部署目标对中文复合意图可命中；当 `deploymentIntent` 且
   `matched.length > 1` 时输出 `compoundTargets`（所有命中路由的 services 展开去重）。
   既有的 deploymentIntent 重序逻辑保证部署 skill 排第一。
2. **RDS 创建前置链**：命中 RDS 且意图含 create/创建/新建/部署/deploy/搭建 时，输出
   `prerequisites`（order 1-3：VPC CreateVpc → CreateSubnet → CreateSecurityGroup，
   skill=huawei-vpc，各步带 `--help` 提示），并把 `huawei-vpc` 追加进 recommendedSkills。
   查询类 RDS 意图不输出 prerequisites。
3. 返回对象按条件附加 `compoundTargets` / `prerequisites` 字段，不破坏既有字段。

## 测试

`test/issue-979-fix.test.mjs`（node --test，5 个用例）：
复合意图分解（中/英）、纯部署单目标、RDS 创建前置链断言、查询类无前置、
单目标路由不回归。

## 验证

- `npm test`（799 pass）
- `npx eslint` / `prettier --check` 通过
- `npm run validate` 通过
