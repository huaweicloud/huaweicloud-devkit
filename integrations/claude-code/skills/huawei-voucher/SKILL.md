---
name: huawei-voucher
description: '查询和领取华为云激励代金券（一人一次）。当用户询问插件能力、首次使用，或提到"领券/代金券/优惠券/激励金/领取"等话题时，先查询领取状态：未领取（claimed=false）则主动提示可领取，已领取（claimed=true）则不打扰。Triggers: voucher, coupon, incentive, 领券, 代金券, 优惠券, 激励金, 领取. NOT for: 账单/费用查询（用 huawei-billing）。'
version: 1
---

# 华为云激励代金券

## 主动提示准则（核心）

此能力仅在用户尚未领取时才有价值，需避免已领取用户被反复打扰：

1. 当用户**询问插件能力 / 首次使用 / 提到福利领取类话题**时，先调用 `huaweicloud_voucher_status` 查询领取状态。
2. 若 `claimed=false` → 主动告知"可领取华为云代金券（一人一次）"，并询问是否现在领取。
3. 若 `claimed=true` → 静默处理，不再提及代金券，不打扰用户。

## 流程

### 1. 查询状态

调用 `huaweicloud_voucher_status`（生产环境无需 `domain_id`，测试环境需传 `domain_id`）。

返回 `{ claimed, message }`：

- `claimed=true` + `message="已领取"` → 已领取，告知结果即可，不再引导
- `claimed=false` + `message="未领取"` → 未领取，可引导领取

### 2. 领取代金券

调用 `huaweicloud_voucher_claim`（生产环境无需 `domain_id`）。

返回 `{ claimed, voucherId, amount, message }`。

### 3. 结果解读（错误码 UX）

| 返回 message 关键特征                        | 含义                        | 对用户表述           |
| -------------------------------------------- | --------------------------- | -------------------- |
| `领取成功`                                   | 发券成功                    | 告知券已到账         |
| `已领取过` / `已领取`                        | 该账号已领过                | 告知已领取，不打扰   |
| `本月代金券总额度已用完，所有账号均无法领取` | 全局额度用尽（HD.60630042） | 告知下月再试         |
| `请先完成实名认证`                           | 账号未实名（HD.60630022）   | 引导去控制台实名认证 |
| `发券失败: <原文>`                           | 其他错误                    | 原样转达，不展开     |

## 环境注意

- 生产环境：`voucher_status` / `voucher_claim` 无需传 `domain_id`，后端从 IAM 自动解析账号。
- 测试环境：需传 `domain_id`（华为云账号 ID）；未传时返回 `测试环境需提供 domain_id`，此时可用 `hcloud IAM KeystoneListAuthDomains` 查询账号 ID 后补传。

## 注意事项

- 每个账号（domain_id）仅可领取一次，重复调用返回已领取。
- 领取结果以激励服务返回为准，不要凭本地认知猜测。
