---
name: huawei-billing
description: 'Use when querying bills, costs, resource usage, or billing details on Huawei Cloud (BSS). Triggers: billing, BSS, cost, bill, expense, usage report, resource usage, budget. NOT for: resource management (use huawei-ecs etc.), creating resources.'
version: 1
---

# Huawei Cloud Billing (BSS)

**STOP - Do not answer from general knowledge.** Follow the procedure below.

Always run `hcloud BSS <Operation> --help --cli-region=cn-north-1` before constructing commands to discover exact parameter names and requirements.

## Overview

Domain expertise for billing queries (BSS). Covers cost tracking, bill details, and budget management. Read-only — no resource modifications.

## Critical Warnings

| Trap                                           | Why                                                                                                                                                                                                                                                                                                                                                           |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bills delayed ~24h                             | Yesterday's costs may not appear until the next day                                                                                                                                                                                                                                                                                                           |
| BSS Admin role needed                          | IAM user must have BSS Administrator or Finance role                                                                                                                                                                                                                                                                                                          |
| Currency conversion varies                     | Cross-region costs use daily exchange rates                                                                                                                                                                                                                                                                                                                   |
| Region fixed to cn-north-1                     | BSS operations only support `--cli-region=cn-north-1` in KooCLI. This is a KooCLI metadata limitation — the billing data itself covers all regions.                                                                                                                                                                                                           |
| English catalog missing BSS                    | `Unsupported service: BSS` under the default `en` language is a KooCLI catalog gap, not a missing service. devkit detects it and advises the supported fix `hcloud configure set --cli-lang=cn` (switch is global-only; KooCLI has no per-command `--cli-lang` flag). Running with Chinese mode from the start (see Prerequisites) avoids the issue entirely. |
| Partner vs Customer-level APIs                 | BSS splits operations by caller identity. Customer-level APIs (`ShowCustomerAccountBalances`, `ListCustomerBillsFeeRecords`, `ListCustomerCouponChangeRecords`) work with a normal IAM user. Partner-level APIs (`ListQuotaCoupons`, `ListSubCustomerCoupons`) require a partner/dealer identity.                                                             |
| APIGW.0301 is identity, not domain-id          | `APIGW.0301: invalid x-security-token` on a BSS Partner-level API means the caller identity is not a partner — a customer credential is rejected. This is NOT a missing `cli-domain-id` and NOT invalid AK/SK. Switch to the Customer-level API below that matches the current identity.                                                                      |
| `ShowCustomerAccountBalances` excludes coupons | The `account_type` array reports only account balances — it does NOT include 代金券/优惠券. Coupons live in a separate ledger queried via `ListCustomerCouponChangeRecords`; treating a `0` here as "no coupon" causes false balance-shortage conclusions (e.g. mis-blaming Ecs.7000).                                                                        |
| `account_type` enum                            | `1:余额 2:信用 5:奖励金 7:保证金`. `5` (奖励金) and `7` (保证金) are legacy commercial-mode values — no such account exists today and they are normally always `0` (see `BONUSCONVERT` in `ListCustomerAccountChangeRecords`). Never infer coupon balance from any `account_type`.                                                                            |

## Common Workflows

| Task                       | Identity | Operation                                                                                                                                                               |
| -------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| List costs                 | Customer | `ListCosts --cli-region=cn-north-1 --project_id=<p>`                                                                                                                    |
| List customer bills        | Customer | `ListCustomerBillsFeeRecords --cli-region=cn-north-1 --project_id=<p>`                                                                                                  |
| Show account balance       | Customer | `ShowCustomerAccountBalances --cli-region=cn-north-1` (cash only)                                                                                                       |
| List coupon change records | Customer | `ListCustomerCouponChangeRecords --cli-region=cn-north-1`                                                                                                               |
| List resource usage        | Customer | `ListResourceUsage --cli-region=cn-north-1 --project_id=<p>`                                                                                                            |
| List conversions           | Customer | `ListConversions --cli-region=cn-north-1 --project_id=<p>`                                                                                                              |
| List sub-customers         | Partner  | `ListConsumeSubCustomers --cli-region=cn-north-1 --project_id=<p>`                                                                                                      |
| List quota coupons         | Partner  | `ListQuotaCoupons --cli-region=cn-north-1` (APIGW.0301 for customers)                                                                                                   |
| Show coupon balance        | Customer | `ListCustomerCouponChangeRecords --cli-region=cn-north-1 --balance_type=BALANCE_TYPE_COUPON --trade_time_begin=<start> --trade_time_end=<end> --limit=100 --offset=<n>` |

For coupon balance, `balance_after_change` is the after-change balance of ONE coupon (`coupon_id`), not the account total. Pass explicit `trade_time_begin`/`trade_time_end` (defaults: one year ago..today), page with `limit=100` (max) + `offset`, then group by `coupon_id`, take `max(trade_time)` per coupon and sum. Partner/reseller customers are rejected with `400 CBC.99000084` — use the Partner-level `ListQuotaCoupons` path instead.

Discover exact parameters with `--help` before executing any command. All BSS operations are read-only.

## account_type Reference (ShowCustomerAccountBalances)

| Value | Meaning | Notes                                                                     |
| ----- | ------- | ------------------------------------------------------------------------- |
| `1`   | 余额    | Account balance (cash).                                                   |
| `2`   | 信用    | Credit balance.                                                           |
| `5`   | 奖励金  | Legacy bonus balance (老商务模式); no such account today, normally `0`.   |
| `7`   | 保证金  | Legacy deposit balance (老商务模式); no such account today, normally `0`. |

Coupon balance is not any `account_type` — query `ListCustomerCouponChangeRecords`.

## Troubleshooting

| Error                           | Fix                                                                                                                                                                              |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Access denied                   | User needs BSS Administrator or Finance role                                                                                                                                     |
| No data returned                | Check time range (bills have ~24h delay). Verify project_id                                                                                                                      |
| Enterprise account restrictions | Some APIs require enterprise real-name authentication                                                                                                                            |
| Coupon balance misjudged as `0` | `ShowCustomerAccountBalances` does not return coupons. Query `ListCustomerCouponChangeRecords` (see Show coupon balance) and do NOT infer coupon amount from any `account_type`. |

## Cross-Skill References

- **Resource lifecycle**: See `huawei-ecs`, `huawei-obs` for creating billable resources
