---
name: huawei-deployment
description: 'Use when creating, managing, or running deployment tasks and pipelines on Huawei Cloud CloudDeploy. Triggers: CloudDeploy, deployment, CI/CD, pipeline, release, artifact deployment, deploy task. NOT for: CodeArts Build (build pipeline), SWR container registry.'
version: 1
---

# Huawei Cloud CloudDeploy

**STOP - Do not answer from general knowledge.** Follow the procedure below.

Always run `hcloud <Service> <Operation> --help` before constructing commands to discover exact parameter names and requirements.

## Overview

Domain expertise for Huawei Cloud CloudDeploy. Covers application creation, deployment task management, pipeline execution, and artifact configuration.

## Critical Warnings

| Trap                                                  | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Service name is `CodeArtsDeploy`                      | `hcloud CloudDeploy` returns `[USE_ERROR]不支持的服务名称`. The KooCLI service name is **CodeArtsDeploy** (product name CloudDeploy). Run `hcloud --help` to verify.                                                                                                                                                                                                                                                                                                                                                                                      |
| Wrong operation names fail                            | The per-action names historically assumed (Start/List/Create/Delete + `Task`/`Tasks`) do NOT exist — KooCLI returns `[USE_ERROR]不支持的operation`. Use the verified names in Common Workflows.                                                                                                                                                                                                                                                                                                                                                           |
| `project_id` is the CodeArts project ID               | Not the IAM project. If CodeArts is not enabled for the account, calls fail with `Deploy.00016902 项目不存在`.                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **Flyway SQL dialect mismatch (H2 dev → MySQL prod)** | Spring Boot apps commonly develop with H2 in-memory DB, then deploy to RDS MySQL. Flyway migrations using H2-specific syntax (e.g. `DATEADD`, `CHARACTER_LENGTH`, `BOOLEAN`) silently succeed on H2 but fail on MySQL. Before deploying, audit `V*__*.sql` migration files: replace `DATEADD` with `DATE_ADD`, `BOOLEAN` with `TINYINT(1)`, remove `characterEncoding=utf8mb4` from Spring Boot datasource URL (KooCLI RDS CreateInstance sets charset at the instance level). Use `Flyway.validate-on-migrate=true` in CI to catch dialect issues early. |
| Deployment hosts need agent                           | Install CloudDeploy agent on target hosts first                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Task must reference application first                 | Create application before task                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Artifact source defaults to OBS                       | Most deployment tasks pull artifacts from OBS. Ensure bucket and object exist                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Parallel deployments may conflict                     | Lock resources or use deployment groups                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

## Common Workflows

| Task                   | Operation（省略参数用 `<placeholder>`，参数以 `hcloud CodeArtsDeploy <Op> --help` 为准）                                                          |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| List applications      | `ListAllApp --cli-region=<r> --project_id=<id> --page=1 --size=10`（`ListDeployTasks` 已由云侧于 2024-09-30 弃用，推荐本接口）                    |
| Show app detail        | `ShowAppDetailById --cli-region=<r> --app_id=<id>`                                                                                                |
| Create application     | `CreateApp --cli-region=<r> --name=<n> --create_type=template --project_id=<id> --is_draft=false`（`--create_type` 仅有 `template` 一个值）       |
| Create deployment task | `CreateDeployTaskByTemplate --cli-region=<r> --template_id=<id> --task_name=<n>`（deprecated since 2024-09-30 — `--help` recommends `CreateApp`） |
| Start deployment       | `StartDeployTask --cli-region=<r> --task_id=<id>`                                                                                                 |
| Delete task            | `DeleteDeployTask --cli-region=<r> --task_id=<id>`（deprecated since 2024-09-30 — `--help` recommends `DeleteApplication --app_id=<id>`）         |

## Troubleshooting

| Error                                                 | Fix                                                                                                                                                    |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Agent offline                                         | Check agent service on target host, network connectivity, firewall rules                                                                               |
| Deployment timeout                                    | Check artifact size, increase task timeout, verify target host resources                                                                               |
| Artifact not found                                    | Verify OBS bucket and object path, check artifact permissions                                                                                          |
| Permission denied                                     | Verify IAM roles for deployment: `CodeArtsDeploy FullAccess` or custom policy                                                                          |
| `Deploy.00016902` 项目不存在                          | CodeArts not enabled or wrong project type: use the **CodeArts project ID** (found in CodeArts console), not the IAM project ID; enable CodeArts first |
| `APIGW.0301` Incorrect IAM authentication information | Credentials lack CodeArtsDeploy access — use AK/SK with CodeArtsDeploy permissions (STS scoped credentials may be rejected)                            |

## Security

- MUST use IAM roles for deployment permissions
- MUST verify artifact integrity before deployment
- MUST not store credentials in deployment scripts

## Cross-Skill References

- **OBS artifact storage**: See `huawei-obs`
- **ECS deployment target**: See `huawei-ecs`
- **IAM permissions**: See `huawei-iam`
