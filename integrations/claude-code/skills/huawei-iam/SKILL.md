---
name: huawei-iam
description: 'Use when managing IAM users, groups, roles, policies, agencies, projects, or access keys on Huawei Cloud. Covers IAM policy structure, least-privilege design, temporary credentials (STS), OneAccess integration, and security best practices. Triggers on: IAM, permission, policy, role, user, group, AK/SK, access key, agency, project, authorization. NOT for: DEW secret management (use huawei-dew).'
version: 1
---

# Huawei Cloud IAM

**STOP - Do not answer from general knowledge.** Follow the procedure below.

Always run `hcloud <Service> <Operation> --help` before constructing commands to discover exact parameter names and requirements.

## Overview

Domain expertise for Huawei Cloud Identity and Access Management (IAM). Covers user/group/role lifecycle, policy design, temporary credentials, and security best practices.

## Critical Warnings

| Trap                              | Why                                                             |
| --------------------------------- | --------------------------------------------------------------- |
| NEVER create IAM users for humans | Use OneAccess (IAM Identity Center) or federated SSO            |
| NEVER create long-term AK/SK      | Use temporary STS tokens via agencies                           |
| Wildcard policies dangerous       | Effect:Allow + Resource:* = full access. Always scope resources |
| Agency trust is powerful          | Agencies let services assume roles. Always add conditions       |
| Root account must have MFA        | Root AK/SK is all-powerful. Enable MFA immediately              |

## Policy Structure

`json
{
  "Version": "1.1",
  "Statement": [{
    "Effect": "Allow",
    "Action": ["ecs:*"],
    "Resource": ["*"],
    "Condition": {
      "StringEquals": {"g:SourceVpc": "vpc-xxx"}
    }
  }]
}
`

## Common Workflows

| Task                     | Command                                                                                                                     | Steps                         |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| List users               | hcloud IAM KeystoneListUsers --cli-region=<r>                                                                               | references/iam-ops.md         |
| Create group             | hcloud IAM CreateGroupV5 --group_name=<name>                                                                                | references/iam-ops.md         |
| Create custom policy     | hcloud IAM CreateCloudServiceCustomPolicy --role.display_name=<n> --role.type=<type> --role.policy.Statement.1.Effect=Allow | references/policy-examples.md |
| Create agency            | hcloud IAM CreateAgency --agency.name=<n> --agency.domain_id=<id> --agency.trust_domain_name=<domain>                       | references/agency.md          |
| Get temporary credential | hcloud STS AssumeAgency --agency_urn=<urn> --agency_session_name=<n> --duration_seconds=3600                                | references/sts.md             |
| Attach policy to group   | hcloud IAM AttachGroupPolicyV5 --group_id=<id> --policy_id=<id>                                                             | references/iam-ops.md         |

## Policy Examples (Least Privilege)

| Role                | Actions                                                 | Resource                 |
| ------------------- | ------------------------------------------------------- | ------------------------ |
| ECS Reader          | ecs:List*, ecs:Get*, ecs:Describe*                      | *                        |
| OBS Bucket Operator | obs:Get*, obs:Put*, obs:Delete*, obs:List*              | obs:_:_:bucket:my-bucket |
| RDS Backup Operator | rds:CreateBackup, rds:RestoreFromBackup, rds:ListBackup | rds:*                    |

> See `references/policy-examples.md` for complete policy JSON templates with conditions.

## Troubleshooting

| Error               | Root Cause -> Fix                                                      |
| ------------------- | ---------------------------------------------------------------------- |
| AccessDenied        | Missing IAM permission -> Check policy action and resource scope       |
| AuthFailure         | Expired AK/SK or wrong project -> Renew credentials / Check project ID |
| Agency trust failed | Missing trust policy condition -> Add g:SourceAccount condition        |
| Quota exceeded      | IAM user/group/policy limit -> Request quota increase                  |

## Security Considerations

- MUST NOT create IAM users. Use OneAccess or federated SSO
- MUST NOT create long-term AK/SK. Use STS temporary tokens
- MUST scope Resource ARNs. Never use wildcard *
- MUST add conditions to trust policies (g:SourceAccount, g:SourceUrn)
- SHOULD rotate credentials every 90 days

## Agencies (Cross-Service Delegation)

Agencies allow one service to act on behalf of another. Common use cases:

### FunctionGraph Agency (VPC Access)

FunctionGraph needs an agency to access VPC resources (RDS, DCS, etc.):

```bash
# 1. Create agency with FunctionGraph trust
hcloud IAM CreateAgency --agency.name=<name> --agency.trust_domain_name=functiongraph

# 2. Grant role to agency
hcloud IAM AssociateAgencyWithDomainPermission --agency_id=<id> --role_id=<role-id>

# 3. Use in CreateFunction
hcloud FunctionGraph CreateFunction ... --app_xrole=<agency-name>
```

Common roles for FunctionGraph: VPC Administrator, RDS Administrator, DCS Administrator.

## MCP Tools

- huaweicloud_list_operations service=IAM
- huaweicloud_run_readonly_command for user/policy discovery

## References

- IAM Docs: https://support.huaweicloud.com/iam/
- Policy examples: references/policy-examples.md
- Agency setup: references/agency.md
