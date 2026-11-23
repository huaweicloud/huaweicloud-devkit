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
| `ShowCustomerAccountBalances` excludes coupons | The `account_type` array reports **cash** balances only — it does NOT include 代金券/优惠券 (vouchers/coupons). Coupons live in a separate ledger that must be queried with `ListCustomerCouponChangeRecords`. Reading a `0` here as "no coupon balance" is wrong and leads to false balance-shortage conclusions.                                            |
| `account_type` enum partially documented       | Official docs define only part of the enum. Known: `account_type=1` → 现金账户 (cash). `account_type=5` → 含义待确认 (meaning unconfirmed; do NOT assume it means coupon/voucher). Never infer coupon balance from any `account_type` entry — query `ListCustomerCouponChangeRecords` instead (see `account_type Reference`).                                 |

## Common Workflows

| Task                       | Identity | Operation                                                                                                                                                                      |
| -------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| List costs                 | Customer | `ListCosts --cli-region=cn-north-1 --project_id=<p>`                                                                                                                           |
| List customer bills        | Customer | `ListCustomerBillsFeeRecords --cli-region=cn-north-1 --project_id=<p>`                                                                                                         |
| Show account balance       | Customer | `ShowCustomerAccountBalances --cli-region=cn-north-1` (cash only — see warning above)                                                                                          |
| List coupon change records | Customer | `ListCustomerCouponChangeRecords --cli-region=cn-north-1`                                                                                                                      |
| Show coupon balance        | Customer | `ListCustomerCouponChangeRecords --cli-region=cn-north-1 --balance_type=BALANCE_TYPE_COUPON` — take the latest record's `balance_after_change` as the available coupon balance |
| List resource usage        | Customer | `ListResourceUsage --cli-region=cn-north-1 --project_id=<p>`                                                                                                                   |
| List conversions           | Customer | `ListConversions --cli-region=cn-north-1 --project_id=<p>`                                                                                                                     |
| List sub-customers         | Partner  | `ListConsumeSubCustomers --cli-region=cn-north-1 --project_id=<p>`                                                                                                             |
| List quota coupons         | Partner  | `ListQuotaCoupons --cli-region=cn-north-1` (APIGW.0301 for customers)                                                                                                          |

Discover exact parameters with `--help` before executing any command. All BSS operations are read-only.

## account_type Reference (ShowCustomerAccountBalances)

| Value | Meaning                          | Source / guidance                                                                                                                        |
| ----- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `1`   | 现金账户 (cash account)          | Confirmed — defined in the official `ShowCustomerAccountBalances` documentation                                                          |
| `5`   | 含义待确认 (meaning unconfirmed) | Undocumented. Official docs give no definition for this value, so its meaning is unconfirmed — do NOT treat it as coupon/voucher balance |

The official documentation does not enumerate every `account_type` value, so the table above is a partial mapping rather than a complete enum. Other numeric values may appear: treat any undocumented value as 含义待确认 rather than guessing, run `hcloud BSS ShowCustomerAccountBalances --help`, and consult `support.huaweicloud.com` for the latest definition. Coupon/voucher balance never comes from this API — use `ListCustomerCouponChangeRecords` (see Common Workflows).

## Troubleshooting

| Error                           | Fix                                                                                                                                                                                                                                                                                           |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Access denied                   | User needs BSS Administrator or Finance role                                                                                                                                                                                                                                                  |
| No data returned                | Check time range (bills have ~24h delay). Verify project_id                                                                                                                                                                                                                                   |
| Enterprise account restrictions | Some APIs require enterprise real-name authentication                                                                                                                                                                                                                                         |
| Coupon balance misjudged as 0   | `ShowCustomerAccountBalances` never returns coupons. Query `ListCustomerCouponChangeRecords --cli-region=cn-north-1 --balance_type=BALANCE_TYPE_COUPON` and read the latest `balance_after_change`. Do NOT derive coupon balance from any `account_type` entry (especially `account_type=5`). |

## Cross-Skill References

- **Resource lifecycle**: See `huawei-ecs`, `huawei-obs` for creating billable resources
