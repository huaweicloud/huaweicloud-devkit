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

| Trap                                           | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bills delayed ~24h                             | Yesterday's costs may not appear until the next day                                                                                                                                                                                                                                                                                                                                                                                                             |
| BSS Admin role needed                          | IAM user must have BSS Administrator or Finance role                                                                                                                                                                                                                                                                                                                                                                                                            |
| Currency conversion varies                     | Cross-region costs use daily exchange rates                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Region fixed to cn-north-1                     | BSS operations only support `--cli-region=cn-north-1` in KooCLI. This is a KooCLI metadata limitation — the billing data itself covers all regions.                                                                                                                                                                                                                                                                                                             |
| English catalog missing BSS                    | `Unsupported service: BSS` under the default `en` language is a KooCLI catalog gap, not a missing service. devkit detects it and advises the supported fix `hcloud configure set --cli-lang=cn` (switch is global-only; KooCLI has no per-command `--cli-lang` flag). Running with Chinese mode from the start avoids the issue entirely.                                                                                                                       |
| Partner vs Customer-level APIs                 | BSS splits operations by caller identity. Customer-level APIs (`ShowCustomerAccountBalances`, `ListCustomerBillsFeeRecords`, `ListCustomerCouponChangeRecords`) work with a normal IAM user. Partner-level APIs (`ListQuotaCoupons`, `ListSubCustomerCoupons`) require a partner/dealer identity.                                                                                                                                                               |
| APIGW.0301 is identity, not domain-id          | `APIGW.0301: invalid x-security-token` on a BSS Partner-level API means the caller identity is not a partner — a customer credential is rejected. This is NOT a missing `cli-domain-id` and NOT invalid AK/SK. Switch to the Customer-level API below that matches the current identity.                                                                                                                                                                        |
| `ShowCustomerAccountBalances` excludes coupons | The `account_type` array reports balances of multiple account types (余额/信用/奖励金/保证金, selected by `account_type`) — it does NOT include 代金券/优惠券 (vouchers/coupons). Coupons live in a separate ledger queried with `ListCustomerCouponChangeRecords`. Never read a `0` here as "no coupon balance". Note: pay-as-you-go ordering risk control only checks the **cash (余额)** balance — a coupon does not offset the `Ecs.7000`/`Ecs.0067` check. |
| `account_type` enum                            | Values and legacy notes: see `account_type Reference`. Never infer coupon balance from any `account_type` entry — query `ListCustomerCouponChangeRecords` (see Common Workflows).                                                                                                                                                                                                                                                                               |

## Common Workflows

| Task                       | Identity | Operation                                                                                                                                                               |
| -------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| List costs                 | Customer | `ListCosts --cli-region=cn-north-1 --project_id=<p>`                                                                                                                    |
| List customer bills        | Customer | `ListCustomerBillsFeeRecords --cli-region=cn-north-1 --project_id=<p>`                                                                                                  |
| Show account balance       | Customer | `ShowCustomerAccountBalances --cli-region=cn-north-1` (returns 余额/信用/奖励金/保证金 by `account_type`; never coupons)                                                |
| List coupon change records | Customer | `ListCustomerCouponChangeRecords --cli-region=cn-north-1`                                                                                                               |
| Show coupon balance        | Customer | `ListCustomerCouponChangeRecords --cli-region=cn-north-1 --balance_type=<balance_type> --trade_time_begin=<start> --trade_time_end=<end> --limit=100 --offset=<offset>` |
| List resource usage        | Customer | `ListResourceUsage --cli-region=cn-north-1 --project_id=<p>`                                                                                                            |
| List conversions           | Customer | `ListConversions --cli-region=cn-north-1 --project_id=<p>`                                                                                                              |
| List sub-customers         | Partner  | `ListConsumeSubCustomers --cli-region=cn-north-1 --project_id=<p>`                                                                                                      |
| List quota coupons         | Partner  | `ListQuotaCoupons --cli-region=cn-north-1` (APIGW.0301 for customers)                                                                                                   |

Discover exact parameters with `--help` before executing any command. All BSS operations are read-only.

For coupon balance, `--balance_type` is required and only accepts `BALANCE_TYPE_COUPON` (the coupon ledger). `balance_after_change` is the after-change balance of a single `coupon_id`, not the account total. Pass explicit `--trade_time_begin`/`--trade_time_end` with a window that covers the earliest coupon issue date (defaults span one year, and a query window may not exceed one year), page with `--limit=100` (max) + `--offset` until `total_count` is covered, then group by `coupon_id`, take `max(trade_time)` per coupon and sum. An empty page means "no coupon records in this window" — never report coupon balance `0` from it. Partner/reseller customers are rejected with `400 CBC.99000084` — use the Partner-level `ListQuotaCoupons` path instead.

## account_type Reference (ShowCustomerAccountBalances)

| Value      | Notes                                                                                              |
| ---------- | -------------------------------------------------------------------------------------------------- |
| `1:余额`   | Account balance (cash). This is what pay-as-you-go ordering risk control checks.                   |
| `2:信用`   | Credit balance.                                                                                    |
| `5:奖励金` | Legacy bonus balance (老商务模式). `BONUSCONVERT` in `ListCustomerAccountChangeRecords` covers it. |
| `7:保证金` | Official enum value (deposit); not commonly returned. Never a coupon/voucher balance.              |

Coupon/voucher balance is never any `account_type` — query `ListCustomerCouponChangeRecords` (see Common Workflows).

## Troubleshooting

| Error                           | Fix                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Access denied                   | User needs BSS Administrator or Finance role                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| No data returned                | Check time range (bills have ~24h delay). Verify project_id                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Enterprise account restrictions | Some APIs require enterprise real-name authentication                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Coupon balance misjudged as 0   | `ShowCustomerAccountBalances` never returns coupons. Query `ListCustomerCouponChangeRecords --cli-region=cn-north-1 --balance_type=<balance_type>` (`BALANCE_TYPE_COUPON` is the only value) with an explicit window covering the earliest coupon issue date, page via `--limit=100 --offset`, then group by `coupon_id` and sum `max(trade_time)` per coupon. An empty window means "no coupon records", not balance `0`; partners get `400 CBC.99000084` and should use `ListQuotaCoupons`. Do NOT derive coupon balance from any `account_type` entry (especially `account_type=5`). |

## Cross-Skill References

- **Resource lifecycle**: See `huawei-ecs`, `huawei-obs` for creating billable resources
