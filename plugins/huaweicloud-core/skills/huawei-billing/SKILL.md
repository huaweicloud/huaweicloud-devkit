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

| Trap                                  | Why                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bills delayed ~24h                    | Yesterday's costs may not appear until the next day                                                                                                                                                                                                                                                                                                           |
| BSS Admin role needed                 | IAM user must have BSS Administrator or Finance role                                                                                                                                                                                                                                                                                                          |
| Currency conversion varies            | Cross-region costs use daily exchange rates                                                                                                                                                                                                                                                                                                                   |
| Region fixed to cn-north-1            | BSS operations only support `--cli-region=cn-north-1` in KooCLI. This is a KooCLI metadata limitation — the billing data itself covers all regions.                                                                                                                                                                                                           |
| English catalog missing BSS           | `Unsupported service: BSS` under the default `en` language is a KooCLI catalog gap, not a missing service. devkit detects it and advises the supported fix `hcloud configure set --cli-lang=cn` (switch is global-only; KooCLI has no per-command `--cli-lang` flag). Running with Chinese mode from the start (see Prerequisites) avoids the issue entirely. |
| Partner vs Customer-level APIs        | BSS splits operations by caller identity. Customer-level APIs (`ShowCustomerAccountBalances`, `ListCustomerBillsFeeRecords`, `ListCustomerCouponChangeRecords`) work with a normal IAM user. Partner-level APIs (`ListQuotaCoupons`, `ListSubCustomerCoupons`) require a partner/dealer identity.                                                             |
| APIGW.0301 is identity, not domain-id | `APIGW.0301: invalid x-security-token` on a BSS Partner-level API means the caller identity is not a partner — a customer credential is rejected. This is NOT a missing `cli-domain-id` and NOT invalid AK/SK. Switch to the Customer-level API below that matches the current identity.                                                                      |

## Common Workflows

| Task                       | Identity | Operation                                                              |
| -------------------------- | -------- | ---------------------------------------------------------------------- |
| List costs                 | Customer | `ListCosts --cli-region=cn-north-1 --project_id=<p>`                   |
| List customer bills        | Customer | `ListCustomerBillsFeeRecords --cli-region=cn-north-1 --project_id=<p>` |
| Show account balance       | Customer | `ShowCustomerAccountBalances --cli-region=cn-north-1`                  |
| List coupon change records | Customer | `ListCustomerCouponChangeRecords --cli-region=cn-north-1`              |
| List resource usage        | Customer | `ListResourceUsage --cli-region=cn-north-1 --project_id=<p>`           |
| List conversions           | Customer | `ListConversions --cli-region=cn-north-1 --project_id=<p>`             |
| List sub-customers         | Partner  | `ListConsumeSubCustomers --cli-region=cn-north-1 --project_id=<p>`     |
| List quota coupons         | Partner  | `ListQuotaCoupons --cli-region=cn-north-1` (APIGW.0301 for customers)  |

Discover exact parameters with `--help` before executing any command. All BSS operations are read-only.

## Troubleshooting

| Error                           | Fix                                                         |
| ------------------------------- | ----------------------------------------------------------- |
| Access denied                   | User needs BSS Administrator or Finance role                |
| No data returned                | Check time range (bills have ~24h delay). Verify project_id |
| Enterprise account restrictions | Some APIs require enterprise real-name authentication       |

## BSS Inquiry Capability Boundary

`hcloud BSS ListOnDemandResourceRatings` is the on-demand price inquiry API, but it does NOT cover every product. Wrong product codes fail with `CBC.6074` / `CBC.6006`; the metadata discovery path (`ListServiceTypes` / `ListResourceTypes` / `ListUsageTypes`) is unusable for filtering — `ListServiceTypes` returns 895 entries with no filter param, `ListResourceTypes` has no service filter. Degrade to official website prices as static estimates and label them **估算**.

| Product family                      | BSS inquiry usable?                                                                     | Error if not | Fallback                      |
| ----------------------------------- | --------------------------------------------------------------------------------------- | ------------ | ----------------------------- |
| ECS (compute)                       | ✅ Yes — `hws.service.type.ec2` + `hws.resource.type.vm` + spec `<flavor>.linux`/`.win` | —            | —                             |
| EIP (bandwidth)                     | ❌ No — `hws.service.type.vpc` + `19_bgp`                                               | `CBC.6074`   | Official website price (估算) |
| RDS (MySQL/PG/SQLServer)            | ❌ No (verified 2026-09-08)                                                             | `CBC.6074`   | Official website price (估算) |
| DCS (Redis/Memcached)               | ❌ No (verified 2026-09-08)                                                             | `CBC.6006`   | Official website price (估算) |
| GaussDB (for MySQL / for openGauss) | ❌ No — not in BSS metadata catalog                                                     | `CBC.6074`   | Official website price (估算) |
| Other services                      | Per-service — MUST look up via BSS metadata APIs or docs                                | `CBC.6074`   | Official website price (估算) |

> **Single source of truth**: `huawei-iac/references/resource-catalog.md` "Pricing and Balance" section. Keep this table in sync with it; never guess product codes — a wrong combination fails with `CBC.6074`.
>
> **Balance query may be permission-blocked**: `CBC.0151` = IAM user lacks `billing:balance:view` → degrade to "user self-checks balance" and continue (do not block; `Ecs.7000` at order time is recoverable). `domain_id` can be extracted from the error message `iam::<domain_id>:user:<name>`.

## Cross-Skill References

- **Resource lifecycle**: See `huawei-ecs`, `huawei-obs` for creating billable resources
- **Pricing fallback details**: See `huawei-iac/references/resource-catalog.md` "Pricing and Balance" section for verified product codes and the `ListOnDemandResourceRatings` template
- **GaussDB pricing**: See `huawei-cloud-gaussdb-instance-management` SKILL.md "BSS Inquiry Boundary" — GaussDB is NOT in the BSS inquiry catalog, always degrade to official website estimate
