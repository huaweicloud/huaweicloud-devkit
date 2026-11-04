---
name: huawei-openapi
version: 1
description: Huawei Cloud OpenAPI discovery and execution through the local open-mcp gateway tools. Use when the task needs an API that KooCLI does not expose, when hunting the right API across the 300+ product catalog by entity keywords, or when reading exact parameter schemas, x-constraint preconditions, request examples, and region endpoints before executing or hand-writing a call.
---

# Huawei Cloud OpenAPI (open-mcp gateway)

The KooCLI service catalog exposes ~70 services. The open-mcp gateway proxies the full OpenAPI catalog: 300+ products, 17,000+ APIs. When a task names an operation no `hcloud` command covers, or no product is named at all, route through these tools instead of falling back to web search.

## Discovery Chain

Every gateway tool is called through `huaweicloud_gateway_call` with `tool` + `toolArgs`; the discovery names take top-level named args (`toolArgs.query`, `toolArgs.limit`, ...):

1. `search_apis` — entity keywords when the product is unknown ("弹性云服务器", "database"). Returns candidate products with representative APIs and match evidence.
2. `list_apis` — the product's catalog with tag_groups for narrowing; paginate with search/limit/offset; include_sops adds full SOP texts per page.
3. `get_api` — the chosen API's full documentation: parameter requiredness/types/enums, x-constraint preconditions, response schema, region endpoint. Read this before any call.
4. `get_api_examples` — official request examples for parameter construction.

`list_products` and `get_product` cover the product dimension (category, is_global — global services use a different auth model; include_sops on get_product adds full SOP texts).

All discovery tools are read-only, need no credentials, and pass straight through.

## Delegated Approval Face

`huaweicloud_gateway_list_tools` shows the live gateway tool surface (names, schemas, drift from the devkit projection). `huaweicloud_gateway_call` calls any gateway tool with `tool` + `toolArgs`:

- **Authorization is delegated to the gateway's own policy engine.** The first call forwards immediately — no approval token, no consent round trip on the devkit side. When the engine refuses, its reason is the instruction: it names the exact grant options for the refused call.
- **The consent flow the refusal teaches**: confirm with the user in conversation (name the product, API, and arguments; a standing go-ahead for the task is not consent for a policy write — ask after the refusal, never assume an earlier instruction covers the grant), grant with `manage_policy` `add` using an ephemeral scope, retry the call. Grant shapes the engine enumerates: the minimal rule (`ECS:ListServers=allow`) with `scope=once` for exactly one retry or `scope=session` for the session, the product-wide rule (`ECS:*=allow`, session), or the read-only rule set (`ECS:*List*=allow` style, session). `line` accepts an array to grant several rules at once.
- **Permanent grants are an operator file edit**, never an agent action: the policy file hot-reloads, so the operator's edit takes effect without a restart. The refusal for a permanent-scope attempt carries the file path.
- **Denied outright, no grant path** (devkit floors, they fire before the forward): secret reads (`ShowSecretVersion`-class operations), file targets inside devkit state (`out.path`/`tables` paths into the protected tree, credential-file paths in SQL), `manage_policy` `add` with a non-canonical action or scope spelling, with `ttl_seconds`, or with a non-ephemeral scope, `manage_policy` `remove` with a scope or `ttl_seconds`, and tool names outside the devkit's static vocabulary.

Denial envelopes carry the fix in their text. Read the error before re-planning.

## Traps

| Trap                                          | Why                                                                                                                                                                                                                                                                                                                                                          |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `region` mismatch                             | `get_api`/`get_api_examples` default to cn-north-4. Pass the region you will execute in; endpoints differ per region.                                                                                                                                                                                                                                        |
| project-scoped APIs                           | APIs with `{project_id}` in the path need the target region's project_id supplied in params on cross-region calls.                                                                                                                                                                                                                                           |
| params layout                                 | For `execute_api`, path and query parameters flatten into `toolArgs.params`; the request body goes in `toolArgs.params.body`. Discovery tools take top-level named args (`toolArgs.query`, `toolArgs.limit`, ...). Top-level keys outside a gateway tool's signature are dropped silently — required path params then fail only after the call is forwarded. |
| Read the x-constraint                         | `get_api`'s x-constraint fields describe call preconditions (quota, dependency, state). Skipping them is the usual cause of a first-call failure.                                                                                                                                                                                                            |
| Data tools are not gated by the policy engine | `query_data`/`transform_data` proceed engine-side without a policy check; the devkit floors (protected tree, credential paths) are the entire gate, and they read and write local files.                                                                                                                                                                     |

## Cross-Skill References

- **API signing by hand**: See `huaweicloud-api-and-sdk` — prefer the gateway tools over manual HMAC signing.
- **CLI first when it covers the operation**: See `huaweicloud-cli-and-auth`; `hcloud` is simpler than the API face for the ~70 cataloged services.
