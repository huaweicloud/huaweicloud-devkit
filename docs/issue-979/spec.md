# Issue #979 spec — D3-S7 serviceCatalog 复合意图分解 + RDS 创建前置

## 背景

1.1.10 测试缺陷 D3-S7（证据 `evidence/D3-S7/stdout.txt`）：`serviceCatalog`
（`plugins/huaweicloud-core/src/tools.mjs`）对复合意图「部署 Web 应用 + RDS」只命中
RDS 单目标，未分解出部署目标；RDS 创建意图也未提示 VPC/子网/安全组前置。

## 需求

1. 复合 Web 应用部署类意图（如「部署 Web 应用 + RDS」）命中多个 service 目标
   （RDS + 部署 Sandbox/DevStation），部署 skill 排序第一。
2. RDS 创建意图返回 `prerequisites` 前置链：VPC → 子网 → 安全组
   （复用 huawei-vpc skill 的创建链路）。
3. 现有单目标意图路由行为不回归（纯 OBS/ECS/查询类意图不变）。

## 验收标准

见 Issue #979（5 条）：复合意图多目标命中、RDS 前置完整、单目标不回归、
测试覆盖、测试报告断言通过。

## 非目标

- 不修改 `routeMap` 既有路由条目的 services/skills 语义（仅新增关键词）。
- 不改动 hcloud 命令执行层。
