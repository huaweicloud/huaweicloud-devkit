# Hook 规则模型

Huawei Cloud DevKit 安全模型由三层组成：**技能教学 → Hook 拦截 → MCP/CLI 包装执行**。Hook 是其中的拦截层，在实际执行前进行安全校验。

## 架构概览

```
Agent 生成命令/产物/部署计划
        │
        ├── 阻断面（per-harness）← 实时拦截 Bash/hcloud 命令
        │     PreToolUse Hook：Claude Code/Codex/Cursor（Node .mjs）、Hermes（Python .py）
        │     OpenCode ≥ 2.0：in-process permission.evaluate 适配器（safety-gate.js）
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

| 类别                 | 拦截内容                                                              | 规则文件位置                                  |
| -------------------- | --------------------------------------------------------------------- | --------------------------------------------- |
| **凭证文件读取**     | `cat ~/.hcloud/config`、读取 `huaweicloud/credentials`                | `policy.json` → `credentialFilePatterns`      |
| **环境变量泄露**     | `env                                                                  | grep HUAWEICLOUD`、`printenv HWC_*`           | `policy.json` → `secretKeyNamePatterns` |
| **明文 Secret 检索** | `ShowSecret`、`ShowSecretVersion`、`DownloadSecret`、`GetSecretValue` | `policy.json` → `blockedSecretOperations`     |
| **AK/SK 输出**       | `hcloud configure show`、`hcloud configure get`                       | `policy.json` → `blockedConfigureSubcommands` |
| **未经审批的写操作** | `Create*`、`Delete*`、`Bind*` 等 hcloud 命令                          | `policy.json` → `writeOperationPrefixes`      |

> **原则**：凭证、Token、密钥等敏感数据**不允许**以任何形式进入 agent 上下文。Agent 只能通过脱敏后的工具输出获取必要信息。

## 三层 Hook 机制

### 第 1 层：PreToolUse 实时拦截

PreToolUse 拦截面按 harness 区分：

| Harness                      | 阻断面                                                                                                     | 载体                                                                                                                                                               |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Claude Code / Codex / Cursor | PreToolUse（Bash matcher + `huaweicloud_*` MCP matcher，hooks.json，5s 超时）                              | `hooks/huaweicloud-safety.mjs`（Node，避免 Windows 环境依赖 `python3`；载入期形状/行为金丝雀三查，败者 fail-closed deny）                                          |
| Hermes                       | PreToolUse（Python hook）                                                                                  | `hooks/huaweicloud-safety.py`（保留给 Hermes/Python hook 场景和既有兼容路径）                                                                                      |
| OpenCode ≥ 2.0               | `permission.hook("evaluate")`，in-process，`"shell"` action（宿主无超时：import 3s 竞速界 + 每段 8KiB 帽） | installer 部署的 `~/.config/opencode/plugins/safety-gate.js` 适配器（逐段分类，任一段 deny 即整体 deny；import 后同三查金丝雀；源 `integrations/opencode/hooks/`） |
| OpenCode 1.x                 | 无 hook 面                                                                                                 | MCP/CLI 包装层兜底；审批残留上 TTY 检查是唯一屏障（见 approvals.md 披露）                                                                                          |

`.mjs` 与 `.py` 拦截时返回 `permissionDecision: "deny"`，并附带 `permissionDecisionReason`；OpenCode 适配器的对应拒绝通道是 `event.effect = "deny"` + `event.message`（message 即模型可见的拒绝原因），且逐段评估——宿主 scanner 把 compound 命令拆成多个 `resources` 元素，任一段 deny 即整体 deny（宿主自身 per-resource 语义的忠实移植）。三层共用 `dist/safety-policy.js`（源码 `src/safety-policy.ts`）的同一套分类逻辑：

- **凭证文件**：匹配 `.hcloud`、`.huaweicloud`、`hcloud/config` 等路径模式
- **环境变量**：匹配 `env | HUAWEICLOUD` 等组合
- **Secret 读取**：匹配 `ShowSecret`、`ShowSecretVersion`、`secret_string` 等
- **风险规则**：加载 `safety/rules/cloud-risk-rules.json`，对 `hcloud` 命令和通用 shell 命令文本进行规则匹配
- **部署 payload 路径写**：匹配 `policy.json` 的 `protectedPayloadPathMarkers`（`huaweicloud-plugins/`、`huaweicloud-core/dist/`、`huaweicloud-core/safety/`）——写形命令（重定向、`tee`、`cp`/`mv`/`rsync`/`install` 目标、`dd of=`、`sed -i`、`patch`）指向部署路径即 deny（risk `invalid`，豁免不可跳）；读形引用不拦（技能读取、直接检查合法）。TS/py 双面消费同一词表（`src/safety/protected-payload.ts` + py `load_policy`/`evaluate`，hook-parity 电池钉判定一致）

分类器完整性三道防线（把「经 bash 改写部署分类器」从完全开放抬到多层设防，天花板如实）：**分类器路径写拒绝**（上表词表）→ **载入期行为自检**（适配器与 `.mjs` 在 import 成功后、信任模块前跑三条金丝雀：导出形状、典型写向量必须 deny、良性读必须 allow，任一不过 deny fail-closed，reason 指向重装）→ **doctor 漂移检查**（安装/更新时 `copyServerPayload` 写部署侧分类器文件的 sha256 清单 `.safety-integrity.json`，doctor 逐行比对：漂移 FAIL + 重装修复；无 receipt（旧安装升级）WARN 不是 FAIL）。对任意用户权限 bash **无本地完全闭合**（本地一切文件皆可写，receipt 本身也可被改写——doctor 是检出不是证明；完全闭合需带外校验：只读安装位置、签名 payload 或 agent 写不到的进程做校验），crafted 模块（通过金丝雀的伪造分类器）与引号/变量拼写的路径残余如实披露在 approvals.md。

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

`src/risk-rule-engine.ts`（编译为 `dist/risk-rule-engine.js`）实现了规则匹配引擎，被多个组件复用：

- **MCP 工具**：`huaweicloud_hook_check_*` 调用 `evaluateCommandRisk` / `evaluateArtifacts` / `evaluateDeployPlan`
- **Node Hook**：`huaweicloud-safety.mjs` 通过 `dist/safety-policy.js`（源码 `src/safety-policy.ts`）复用 `dist/risk-rule-engine.js`，供 Claude Code/Codex/Cursor 的 PreToolUse 拦截，并为 OpenCode ≥ 2.0 的 evaluate 适配器共用（同一模块，同一 deny 前缀与 fail-closed 原因文案）
- **Python Hook**：`huaweicloud-safety.py` 独立加载 `cloud-risk-rules.json`，供 Hermes/Python hook 场景使用
- **安全策略检查**：`src/safety-policy.ts` 读取 `policy.json` 进行凭证/写操作分类

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

| 规则 ID                            | 类别            | 严重度 | 阶段                  | 说明                                                                                                                                                                                                                                 |
| ---------------------------------- | --------------- | ------ | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `hwc-command-credential-file`      | credential      | deny   | command               | 禁止读取本地凭据文件                                                                                                                                                                                                                 |
| `hwc-command-env-dump`             | credential      | deny   | command               | 禁止打印云凭据环境变量                                                                                                                                                                                                               |
| `hwc-command-secret-value-read`    | secret          | deny   | command               | 禁止检索明文 Secret                                                                                                                                                                                                                  |
| `hwc-command-adminpass-exposure`   | secret          | warn   | artifact, deploy_plan | 警告明文 adminPass 参数                                                                                                                                                                                                              |
| `hwc-command-sts-credential`       | credential      | warn   | command               | 警告临时凭据暴露                                                                                                                                                                                                                     |
| `hwc-command-encoded-shell-exec`   | execution       | deny   | command               | 禁止 base64 解码后管道执行                                                                                                                                                                                                           |
| `hwc-network-public-admin-port`    | public_exposure | deny   | 全部                  | 禁止 0.0.0.0/0 开放管理端口                                                                                                                                                                                                          |
| `hwc-obs-anonymous-write`          | public_exposure | deny   | 全部                  | 禁止 OBS 匿名写入                                                                                                                                                                                                                    |
| `hwc-functiongraph-public-no-auth` | public_exposure | warn   | 全部                  | 警告无认证的公网函数                                                                                                                                                                                                                 |
| `hwc-iam-admin-policy`             | iam             | deny   | 全部                  | 禁止创建管理员权限策略                                                                                                                                                                                                               |
| `hwc-iam-highrisk-write`           | iam             | warn   | command               | 警告 IAM 主体高危写操作                                                                                                                                                                                                              |
| `hwc-destructive-delete-force`     | destructive     | deny   | command               | 禁止强制递归删除                                                                                                                                                                                                                     |
| `hwc-destructive-delete-operation` | destructive     | warn   | command               | 警告云资源删除/解绑操作                                                                                                                                                                                                              |
| `hwc-destructive-reset-operation`  | destructive     | warn   | command               | 警告资源重置操作                                                                                                                                                                                                                     |
| `hwc-destructive-delete-cascade`   | destructive     | warn   | command               | 警告级联删除（EIP/卷）                                                                                                                                                                                                               |
| `hwc-command-secret-in-arg`        | secret          | warn   | command               | 警告命令行明文密码/密钥参数                                                                                                                                                                                                          |
| `hwc-sandbox-missing-ttl`          | sandbox         | warn   | artifact, deploy_plan | 警告沙箱无清理计划                                                                                                                                                                                                                   |
| `hwc-cost-unbounded-scale`         | cost            | warn   | 全部                  | 警告高成本/无边界扩容                                                                                                                                                                                                                |
| `hwc-sandbox-destructive-command`  | destructive     | deny   | command               | 禁止毁灭性终端命令：`rm -rf /`、`dd if=`、fork bomb（有界线性形态）、命令位锚定的 shutdown/reboot/init/mkfs/fdisk（提及形文本与 `--reboot.*` 参数名不再误伤；两条刻意保留的过度拒绝：sudo 无位置臂、`dd if=` 子串，均有 battery 钉） |

## Agent 使用 Hook 的推荐流程

1. **命令执行前**：调用 `huaweicloud_hook_check_command` 检查命令文本
2. **文件写入前**：调用 `huaweicloud_hook_check_artifacts` 检查 IaC/配置
3. **资源创建前**：调用 `huaweicloud_hook_check_deploy_plan` 检查部署计划
4. **写操作**：始终通过 `huaweicloud_plan_cli_command` 规划 + `huaweicloud_run_approved_command` 审批
