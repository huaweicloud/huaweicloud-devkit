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
| `缺少必填参数 cli-domain-id` / APIGW.0301      | Invalid credentials — KooCLI can't resolve the account-id                                                                                                                                                                                                                                                                                                     | Re-run `npx huaweicloud-devkit auth init` |
| `ShowCustomerAccountBalances` excludes coupons | The `account_type` array only reports **cash** account balances — it does NOT include代金券/优惠券. Coupons live in a separate ledger queried via `ListCustomerCouponChangeRecords`. Treating a `0` balance here as "no coupon" causes false balance-shortage conclusions (e.g. mis-blaming Ecs.7000).                                                        |
| `account_type` enum partially documented       | Official docs only define some values. Known: `account_type=1` → 现金账户 (cash). `account_type=5` → 含义待确认 (meaning unconfirmed as of 2026-09; do NOT assume it means coupon). Never infer coupon balance from any `account_type` entry — query `ListCustomerCouponChangeRecords` instead.                                                               |

## Common Workflows

| Task                 | Operation                                                                                                                                                           |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| List costs           | `ListCosts --cli-region=cn-north-1 --project_id=<p>`                                                                                                                |
| List customer bills  | `ListCustomerBillsFeeRecords --cli-region=cn-north-1 --project_id=<p>`                                                                                              |
| List resource usage  | `ListResourceUsage --cli-region=cn-north-1 --project_id=<p>`                                                                                                        |
| List sub-customers   | `ListConsumeSubCustomers --cli-region=cn-north-1 --project_id=<p>`                                                                                                  |
| Show account balance | `ShowCustomerAccountBalances --cli-region=cn-north-1` (cash only — see warning above)                                                                               |
| List conversions     | `ListConversions --cli-region=cn-north-1 --project_id=<p>`                                                                                                          |
| Show coupon balance  | `ListCustomerCouponChangeRecords --cli-region=cn-north-1 --balance_type=BALANCE_TYPE_COUPON` (take the latest `balance_after_change` as the current coupon balance) |

Discover exact parameters with `--help` before executing any command. All BSS operations are read-only.

## account_type Reference (ShowCustomerAccountBalances)

| Value | Meaning                          | Notes                                                                                                                                   |
| ----- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `1`   | 现金账户 (cash account)          | Confirmed by official docs                                                                                                              |
| `5`   | 含义待确认 (meaning unconfirmed) | Official docs give no definition as of 2026-09; do NOT interpret as coupon. Query `ListCustomerCouponChangeRecords` for coupon balance. |

Other numeric values may appear — run `hcloud BSS ShowCustomerAccountBalances --help` and consult `support.huaweicloud.com` for the latest enum. When a value is undocumented, treat it as unconfirmed rather than guessing.

## Troubleshooting

| Error                           | Fix                                                                                                                                                                                                                                                             |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Access denied                   | User needs BSS Administrator or Finance role                                                                                                                                                                                                                    |
| No data returned                | Check time range (bills have ~24h delay). Verify project_id                                                                                                                                                                                                     |
| Enterprise account restrictions | Some APIs require enterprise real-name authentication                                                                                                                                                                                                           |
| Coupon balance misjudged as `0` | `ShowCustomerAccountBalances` does not return coupons. Query `ListCustomerCouponChangeRecords --balance_type=BALANCE_TYPE_COUPON` and read the latest `balance_after_change`. Do NOT infer coupon amount from any `account_type` entry (esp. `account_type=5`). |

## Cross-Skill References

- **Resource lifecycle**: See `huawei-ecs`, `huawei-obs` for creating billable resources
