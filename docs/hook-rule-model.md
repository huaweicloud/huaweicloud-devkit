# Hook 规则模型

Huawei Cloud DevKit 安全模型由三层组成：**技能教学 → Hook 拦截 → MCP/CLI 包装执行**。Hook 是其中的拦截层，在实际执行前进行安全校验。

## 架构概览

```
Agent 生成命令/产物/部署计划
        │
        ├── PreToolUse Hook (Python)     ← 实时拦截 Bash/hcloud 命令
        │
        ├── huaweicloud_hook_check_*  ← MCP 工具，主动检查
        │   ├── command   → 检查计划执行的命令
        │   ├── artifacts → 检查生成的代码/IaC/配置
        │   └── deploy_plan → 检查部署计划的沙箱/暴露/IAM/成本风险
        │
        └── 共享规则库 (cloud-risk-rules.json) ← 所有层共用的风险规则
```

## 隐私边界

Hook 系统强制以下隐私边界，禁止以下数据进入 agent 上下文：

| 类别                 | 拦截内容                                               | 规则文件位置                                  |
| -------------------- | ------------------------------------------------------ | --------------------------------------------- |
| **凭证文件读取**     | `cat ~/.hcloud/config`、读取 `huaweicloud/credentials` | `policy.json` → `credentialFilePatterns`      |
| **环境变量泄露**     | `env                                                   | grep HUAWEICLOUD`、`printenv HWC_*`           | `policy.json` → `secretKeyNamePatterns` |
| **明文 Secret 检索** | `ShowSecretVersion`、`GetSecretValue`                  | `policy.json` → `blockedSecretOperations`     |
| **AK/SK 输出**       | `hcloud configure show`、`hcloud configure get`        | `policy.json` → `blockedConfigureSubcommands` |
| **未经审批的写操作** | `Create*`、`Delete*`、`Bind*` 等 hcloud 命令           | `policy.json` → `writeOperationPrefixes`      |

> **原则**：凭证、Token、密钥等敏感数据**不允许**以任何形式进入 agent 上下文。Agent 只能通过红act 后的工具输出获取必要信息。

## 三层 Hook 机制

### 第 1 层：PreToolUse 实时拦截

`hooks/huaweicloud-safety.py` 在每次 `Bash` 工具调用前执行，使用正则匹配拦截：

- **凭证文件**：匹配 `.hcloud`、`.huaweicloud`、`hcloud/config` 等路径模式
- **环境变量**：匹配 `env | HUAWEICLOUD` 等组合
- **Secret 读取**：匹配 `ShowSecretVersion`、`secret_string` 等
- **风险规则**：加载 `safety/rules/cloud-risk-rules.json`，对命令文本进行规则匹配

拦截时返回 `permissionDecision: "deny"`，并附带 `permissionDecisionReason`。

### 第 2 层：MCP 主动检查

Agent 在**执行前**应主动调用以下 MCP 工具进行风险检查：

#### `huaweicloud_hook_check_command`

检查即将执行的 shell 或 hcloud 命令：

```json
{ "command": "hcloud ECS DeleteServers --servers.1.id=xxx --delete_publicip=true" }
```

返回：`{ "decision": "deny" | "warn" | "allow", "findings": [...] }`

#### `huaweicloud_hook_check_artifacts`

检查生成的代码、IaC、配置文件：

```json
{
  "artifacts": [{ "path": "main.tf", "content": "resource \"huaweicloud_vpc\" ..." }]
}
```

适用于 Terraform、CloudFormation、自定义脚本等产物。

#### `huaweicloud_hook_check_deploy_plan`

检查部署计划的整体风险（沙箱、暴露、IAM、成本）：

```json
{
  "plan": {
    "sandbox": true,
    "resources": ["ECS", "EIP"],
    "cleanup": { "ttl": "2h" }
  }
}
```

### 第 3 层：共享规则引擎

`src/risk-rule-engine.mjs` 实现了规则匹配引擎，被多个组件复用：

- **MCP 工具**：`huaweicloud_hook_check_*` 调用 `evaluateCommandRisk` / `evaluateArtifacts` / `evaluateDeployPlan`
- **Python Hook**：`huaweicloud-safety.py` 独立加载 `cloud-risk-rules.json` 进行匹配
- **安全策略检查**：`src/safety-policy.mjs` 读取 `policy.json` 进行凭证/写操作分类

三者共享同一套规则定义，确保策略一致性。

## 规则结构

`cloud-risk-rules.json` 中每条规则包含：

```json
{
  "id": "hwc-command-credential-file",
  "title": "Credential file read",
  "category": "credential",
  "severity": "deny | warn | info",
  "stages": ["command" | "artifact" | "deploy_plan"],
  "match": {
    "all":  [{ "field": "text", "regex": "..." }],
    "any":  [{ "field": "text", "regex": "..." }],
    "none": [{ "field": "text", "regex": "..." }]
  },
  "message": "人类可读的风险描述",
  "remediation": "修复建议"
}
```

### 匹配逻辑

| 条件         | 语义                       |
| ------------ | -------------------------- |
| `match.all`  | **全部**正则必须匹配 → AND |
| `match.any`  | **至少一个**正则匹配 → OR  |
| `match.none` | **全部不能**匹配 → NOT AND |

### 严重级别

| 级别   | 含义             | 行为               |
| ------ | ---------------- | ------------------ |
| `deny` | 高风险，必须阻止 | 拒绝执行，返回建议 |
| `warn` | 中风险，需要关注 | 允许执行，附带警告 |
| `info` | 低风险，信息提示 | 允许执行，记录日志 |

### 检查阶段

| 阶段          | 适用场景                   | 对应工具                             |
| ------------- | -------------------------- | ------------------------------------ |
| `command`     | 检查 hcloud/shell 命令文本 | `huaweicloud_hook_check_command`     |
| `artifact`    | 检查 IaC/配置/代码文件     | `huaweicloud_hook_check_artifacts`   |
| `deploy_plan` | 检查部署计划描述           | `huaweicloud_hook_check_deploy_plan` |

## 当前风险规则

| 规则 ID                            | 类别            | 严重度 | 阶段                  | 说明                        |
| ---------------------------------- | --------------- | ------ | --------------------- | --------------------------- |
| `hwc-command-credential-file`      | credential      | deny   | command               | 禁止读取本地凭据文件        |
| `hwc-command-env-dump`             | credential      | deny   | command               | 禁止打印云凭据环境变量      |
| `hwc-command-secret-value-read`    | secret          | deny   | command               | 禁止检索明文 Secret         |
| `hwc-command-encoded-shell-exec`   | execution       | deny   | command               | 禁止 base64 解码后管道执行  |
| `hwc-network-public-admin-port`    | public_exposure | deny   | 全部                  | 禁止 0.0.0.0/0 开放管理端口 |
| `hwc-obs-anonymous-write`          | public_exposure | deny   | 全部                  | 禁止 OBS 匿名写入           |
| `hwc-functiongraph-public-no-auth` | public_exposure | warn   | 全部                  | 警告无认证的公网函数        |
| `hwc-iam-admin-policy`             | iam             | deny   | 全部                  | 禁止创建管理员权限策略      |
| `hwc-destructive-delete-force`     | destructive     | deny   | command               | 禁止强制递归删除            |
| `hwc-sandbox-missing-ttl`          | sandbox         | warn   | artifact, deploy_plan | 警告沙箱无清理计划          |
| `hwc-cost-unbounded-scale`         | cost            | warn   | 全部                  | 警告高成本/无边界扩容       |

## Agent 使用 Hook 的推荐流程

1. **命令执行前**：调用 `huaweicloud_hook_check_command` 检查命令文本
2. **文件写入前**：调用 `huaweicloud_hook_check_artifacts` 检查 IaC/配置
3. **资源创建前**：调用 `huaweicloud_hook_check_deploy_plan` 检查部署计划
4. **写操作**：始终通过 `huaweicloud_plan_cli_command` 规划 + `huaweicloud_run_approved_command` 审批
