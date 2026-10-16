# Pre-Purchase Sizing and Pricing (购买前选型与询价)

> Guidance-only capability: help the user pick the right GaussDB product form and
> flavor, and produce a price + budget estimate, **before any instance is created**.
> All commands here are read-only (R3, auto-execute). Ordering/purchasing is a
> billing write operation and MUST go through the `huawei-iac` skill approval flow.

## Scope and division of labor (avoid duplication)

| Skill          | Owns                                                                      |
| -------------- | ------------------------------------------------------------------------- |
| this skill     | GaussDB 选型询价（sizing + pricing guidance）+ instance lifecycle         |
| huawei-billing | bills / balance / BSS inquiry API details (`ShowCustomerAccountBalances`) |
| huawei-iac     | ordering, cost + balance gate, approval, ordered teardown                 |

## BSS pricing applicability (verified)

| Product               | BSS on-demand inquiry | Notes                                                                                        |
| --------------------- | --------------------- | -------------------------------------------------------------------------------------------- |
| GaussDB for openGauss | ✅ usable             | Verified: 4C16G `gaussdb.bs.kc1.xlarge.arm4.ha` on-demand ¥2.5/hour, matches the actual bill |
| RDS                   | ❌ `CBC.6074`         | codes not usable — use official website prices, label the result 估算                        |
| DCS                   | ❌ `CBC.6006`         | codes not usable — use official website prices, label the result 估算                        |

Pricing code lookup rules (service/resource type combos are per-product; a wrong
combination fails with `CBC.6074`): see `huawei-iac/references/resource-catalog.md`
§ Pricing — never guess codes; verify via BSS metadata APIs
(`ListServiceTypes` / `ListResourceTypes` / `ListUsageTypes`) or docs.

## Step 1 — Collect decision inputs (ask, never guess)

| Input                   | Why it matters                                                |
| ----------------------- | ------------------------------------------------------------- |
| 用途 (dev/test vs prod) | decides HA/SLA tier → deployment form                         |
| 数据规模与增长          | volume size + whether horizontal scaling will be needed later |
| 并发 / QPS              | vCPU / flavor sizing; read-heavy → readonly nodes             |
| 可用性 (HA / RPO / RTO) | single vs triset vs distributed                               |
| 预算上限                | on-demand vs yearly/monthly subscription; flavor ceiling      |
| region / 网络           | availability and cross-region latency                         |

Missing any input → ask the user first; do not assume.

## Step 2 — Discover flavors and deployment forms (read-only)

```bash
# openGauss flavors (deployment forms: single / triset / logger / distributed via ha_mode & flavor)
hcloud gaussdbforopengauss ListFlavors --cli-region={region}

# MySQL-compatible flavors (engine + AZ mode required)
hcloud GaussDB ShowGaussMySqlFlavors --cli-region={region} --availability_zone_mode={single|multi} --database_name=gaussdb-mysql
```

Re-use the existing R3 query actions (`huawei_list_gaussdb_flavors`) — no new tools.
Pick `flavor_ref` / `spec_code` + deployment form from the response
(`recommended_configuration` / `ha_mode` fields when present).

## Step 3 — Price and budget (BSS, region fixed to cn-north-1)

```bash
# On-demand price (usage_measure_id=4 hour, usage_value=730 ≈ one month)
hcloud BSS ListOnDemandResourceRatings --cli-region=cn-north-1 \
  --product_infos.1.id={label} \
  --product_infos.1.cloud_service_type={verified_service_type} \
  --product_infos.1.resource_type={verified_resource_type} \
  --product_infos.1.region={resource_region} \
  --product_infos.1.resource_spec={spec_code} \
  --product_infos.1.subscription_num=1 \
  --product_infos.1.usage_factor=Duration \
  --product_infos.1.usage_measure_id=4 \
  --product_infos.1.usage_value=730 \
  --cli-domain-id={domain_id}

# Yearly/monthly subscription price
hcloud BSS ListRateOnPeriodDetail --cli-region=cn-north-1 --help   # discover exact params first

# Account balance (may be permission-blocked: CBC.0151 → tell the user to self-check)
hcloud BSS ShowCustomerAccountBalances --cli-region=cn-north-1 --cli-domain-id={domain_id}
```

- `hcloud BSS <Operation> --help` before first use — KooCLI is the source of truth
  for parameter spelling.
- BSS only supports `--cli-region=cn-north-1` (KooCLI metadata limitation); the
  pricing data itself covers all regions.
- Balance `CBC.0151` (IAM user lacks `billing:balance:view`) → degrade to
  "user self-checks balance", do not block.
- Cross-check: the estimate should be compared against actual bills via
  `huawei-billing` when the user has running resources (verified reference point:
  openGauss 4C16G on-demand ¥2.5/hour == bill).

## Step 4 — Tiered recommendation

| Scenario                      | Recommendation       | Rationale                             |
| ----------------------------- | -------------------- | ------------------------------------- |
| 开发/测试 (dev/test)          | `single` 单副本      | no HA/SLA, cheapest, delete when done |
| 一般生产 (typical production) | `triset` 1主2备      | strong-consistency HA                 |
| 大容量/大并发 (large scale)   | `distributed` 分布式 | horizontal scaling via shards         |

> openGauss starts large: the smallest centralized single replica is ~4C16G ≈
> ¥1825/month on-demand. For tiny projects RDS (smallest 2C4G ≈ ¥150/month) may be
> cheaper — but RDS is out of scope here (Critical Warning #3: separate products);
> route RDS sizing/purchase to `huawei-rds` / `huawei-iac`.

## Boundary (hard rule)

- 询价/pricing = read-only R3 → auto-execute freely.
- 下单/购买 = billing write → MUST go through `huawei-iac` cost + balance gate and
  approval (`huaweicloud_run_approved_command`); never order from this skill.

## Verification

| Claim                   | How to verify                                                 |
| ----------------------- | ------------------------------------------------------------- |
| flavor exists in region | `ListFlavors` / `ShowGaussMySqlFlavors` returns the spec_code |
| price matches bill      | compare BSS `amount` with `huawei-billing` bill records       |
| deployment form valid   | flavor `ha_mode` / `recommended_configuration` fields         |
