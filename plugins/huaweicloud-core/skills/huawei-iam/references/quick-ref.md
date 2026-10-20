# IAM Quick Reference

## Common Operations

```bash
hcloud IAM KeystoneListProjects                  # list projects
hcloud IAM KeystoneListUsers                     # list users
hcloud IAM KeystoneListGroups                    # list groups
hcloud IAM ListCustomPolicies                    # list custom policies
hcloud IAM ListAgencies --domain_id=<domain-id>  # list agencies
hcloud IAM KeystoneListAuthDomains               # list domains
hcloud IAM KeystoneShowUser                      # show user detail
```

> **Group lifecycle uses the V5 API, not Keystone.** `CreateGroupV5` / `AttachGroupPolicyV5` take `group_id`/`policy_id`; `KeystoneListGroups` is the older read API. The V5 group `description` forbids `@ # % & < > \ $ ^ *`.

```bash
hcloud IAM CreateGroupV5 --group_name=<name>
hcloud IAM AttachGroupPolicyV5 --group_id=<id> --policy_id=<id>
```

## Agencies & Temporary Credentials (STS)

An agency + `STS AssumeAgency` is the only safe way to mint temporary credentials (never store long-term AK/SK):

1. Create the delegation:

   ```bash
   hcloud IAM CreateAgency --agency.name=<name> --agency.domain_id=<domain-id> --agency.trust_domain_name=<trust-domain>
   ```

   `--agency.trust_domain_name` and `--agency.trust_domain_id` are two ways to name the entrusted account — provide at least one; when both are present, `trust_domain_name` wins validation.

2. Grant a role to the agency (optional):

   ```bash
   hcloud IAM AssociateAgencyWithDomainPermission --agency_id=<id> --role_id=<role-id>
   ```

3. Exchange for temporary credentials:

   ```bash
   hcloud STS AssumeAgency --agency_urn=<urn> --agency_session_name=<name> --duration_seconds=3600
   ```

   - `--agency_urn` is the agency **URN**, not its name or id — query it with `hcloud IAM ListAgencies --domain_id=<domain-id>` first.
   - `--duration_seconds` range is `[900, 43200]`; it must not exceed the agency's own session duration, and is capped at `3600` when `--X-Security-Token` is present.
   - The returned credential includes a `security_token` — pass it as `--X-Security-Token` for subsequent calls.

## Credential Management

```bash
hcloud IAM ListAccessKeysV5 --user_id=<id> # list AK/SK for user
hcloud IAM CreateLoginToken                # create login token
hcloud IAM GetAccountSummaryV5             # account summary
```

## Primary vs Sub-Account Judgment

**Rule (validated against 6 live credentials, zero misjudgment): `username == domainName` → primary account; otherwise IAM sub-user.**

The primary account's operator user is named after the domain, and an IAM user cannot occupy that name (account-unique), so the rule has no false positives.

Preferred path — one MCP call:

```
huaweicloud_check_account_type            # optional region param, defaults to configured cli-region
```

CLI fallback (two read-only calls, no identity-policy permission required; works for both primary and sub-user credentials):

```bash
hcloud STS GetCallerIdentity --cli-region=<region>
# -> principal_urn "iam::<account_id>:user:<username>" gives username; account_id gives domainId
hcloud IAM KeystoneListAuthDomains
# -> domains[0].name gives domainName (domains[0].id must equal account_id — consistency check)
```

Example: `principal_urn ...:user:dingchunlei` + domain name `es_hwcddbdt_OpenCapability_team` → names differ → IAM sub-user. `...:user:keco_1919aa` + domain name `keco_1919aa` → equal → primary account.

**Do NOT use these two tempting-but-wrong rules** (both disproved in live testing):

| Wrong rule                                    | Why it fails                                                                                         |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `ShowDomainPasswordPolicy` succeeds → primary | Permission-gated, not account-type-gated: a sub-user with IAM permissions also succeeds              |
| `principal_id == account_id` → primary        | False for primary accounts too (observed on three separate primary samples; IDs only share a prefix) |

Edge cases:

- Agency-session credentials (`principal_urn` starts with `sts::` or contains `assumed-agency`): the rule does not apply — report the identity only.
- `KeystoneValidateToken` looks like a one-call shortcut (its token payload has both names) but requires an existing token as `--X-Subject-Token`, which AK/SK signing does not provide.

## Security Best Practices

1. **NEVER create IAM users** — use IAM Identity Center or temporary STS tokens
2. **NEVER create long-term AK/SK** — use temporary credentials
3. **Least privilege by default** — start empty, add only needed actions
4. **Scope resources** — no `*` wildcards on Resource
5. **Use condition keys** — `g:RequestedRegion`, `g:ResourceTag`, `g:CurrentTime`
6. **Rotate AK/SK every 90 days** — or use agency delegation

## IAM vs AWS Comparison

| AWS                   | Huawei Cloud                         |
| --------------------- | ------------------------------------ |
| `iam:ListUsers`       | `iam:users:list` (lowercase + colon) |
| AWS Managed Policy    | System Policy (系统策略)             |
| Customer Managed      | Custom Policy (自定义策略)           |
| Resource-Based Policy | Project-Level Policy (项目级策略)    |
| IAM Role              | Agency (委托)                        |

> Huawei Cloud IAM action naming: `<service>:<resource>:<action>`. Always verify at https://support.huaweicloud.com/usermanual-iam/iam_01_0001.html

## Confused Deputy Protection

```json
{
  "Effect": "Allow",
  "Action": ["ecs:*"],
  "Resource": ["*"],
  "Condition": {
    "StringEquals": { "g:SourceAccount": "<account-id>" },
    "StringLike": { "g:SourceUrn": "urn:fss:*" }
  }
}
```
