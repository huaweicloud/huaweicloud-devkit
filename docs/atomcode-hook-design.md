# AtomCode 遥测 Hook 设计方案

## 1. 背景

Huawei Cloud DevKit 已集成 4 个 Agent 平台的遥测 Hook：

| 平台      | 实现文件                                             | 语言               |
| --------- | ---------------------------------------------------- | ------------------ |
| DSH       | `integrations/dsh/hook-plugin.mjs`                   | JS (Cordis Plugin) |
| Hermes    | `integrations/hermes/hooks/huaweicloud-telemetry.py` | Python             |
| OpenCode  | `integrations/opencode/hooks/skill-tracker.js`       | JS                 |
| WorkBuddy | `integrations/workbuddy/hooks/telemetry-tracker.py`  | Python             |

**AtomCode 尚未集成**。本方案补齐这一缺口。

## 2. 目标

为 AtomCode 平台实现遥测 Hook，对齐现有平台能力，保留两项核心功能（Skill 跟踪已随五平台 doctrine 移除，见 5.2）：

- **CLI 分类**：解析 bash 中的 `hcloud` 命令，分类为 `cli:read` / `cli:write` / `cli:invoke`
- **MCP 跟踪**：记录 `mcp__huaweicloud*` 工具调用

## 3. 文件规划

```
integrations/atomcode/
├── hooks.json                         # AtomCode hook 配置文件
└── hooks/
    └── huaweicloud-telemetry.js       # Hook 实现（Node.js，约 100 行）
```

无其他文件，不修改任何现有代码。

## 4. Hook 事件选择

AtomCode 提供 4 个生命周期事件：

| 事件            | 遥测场景适用 | 说明                                           |
| --------------- | :----------: | ---------------------------------------------- |
| `pre_tool_use`  |      ✅      | 工具执行前拦截，信息完整，其他平台均采用此阶段 |
| `post_tool_use` |      ❌      | 执行后，无法获取更丰富信息                     |
| `session_start` |      ❌      | 无工具信息                                     |
| `session_end`   |      ❌      | 无工具信息                                     |

**选择 `pre_tool_use`**，与其他平台保持一致。

## 5. 拦截逻辑

### 5.1 总体流程

```
ATOMCODE_TOOL_NAME + ATOMCODE_HOOK_CONTEXT (stdin JSON)
  │
  ├── tool === "bash"  ──────────────────────→ 5.3 CLI 分类
  └── tool.startsWith("mcp__huaweicloud") ───→ 5.4 MCP 跟踪
```

### 5.2 Skill 跟踪（已移除）

Skill-tool 分类已移除：service skills 的 retrieval 遥测走 server 端 `trackSkillRetrieve`，核心元技能的原生加载与 skillRoot 文件直读按设计不产生遥测（与五平台 hooks 的 doctrine 一致，structure 守卫钉住）。

### 5.3 CLI 分类

匹配工具名 `bash` 或 `pwsh`，提取 `command` 参数：

```javascript
if (toolName === 'bash' || toolName === 'pwsh') {
  const command = toolInput?.command || '';
  const result = classifyHcloud(command); // → cli:read | cli:write | cli:invoke | null
  if (result) {
    writeEvent(result.key, result.value, { capability: 'cli' });
  }
}
```

**分类规则（与其他平台完全一致）**：

| 分类         | 匹配动词                                                                                                                                                                                                                                                                                                                                                            |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cli:read`   | List, Show, Get, Describe, NovaList, NovaShow                                                                                                                                                                                                                                                                                                                       |
| `cli:write`  | Create, Delete, Update, Modify, Remove, Revoke, Grant, Attach, Detach, Enable, Disable, Set, Add, Bind, Unbind, Reset, Change, Activate, Deactivate, Register, Unregister, Import, Export, Download, Upload, Copy, Move, Convert, Migrate, Run, Execute, Invoke, Trigger, Deploy, Push, Start, Stop, Restart, Reboot, Suspend, Resume, Terminate, Release, Allocate |
| `cli:invoke` | 其他（纯写操作匹配失败时回退）                                                                                                                                                                                                                                                                                                                                      |

### 5.4 MCP 跟踪

匹配工具名以 `mcp__huaweicloud` 开头：

```javascript
if (toolName.startsWith('mcp__huaweicloud')) {
  writeEvent(`tool:${toolName}`, '1', { capability: 'mcp' });
}
```

## 6. 数据输出

### 6.1 输出目标

与其他平台共用 `hook-events.jsonl`：

```
<plugin_dir>/telemetry/hook-events.jsonl
```

由 `src/telemetry/telemetry.mjs` 的 `ingestHookEvents()` 统一消费上报。

### 6.2 事件格式

```json
{"key": "cli:read",           "value": "hcloud ECS ListServersDetails", "capability": "cli"}
{"key": "cli:write",          "value": "hcloud ECS CreateServers",     "capability": "cli"}
{"key": "cli:invoke",         "value": "hcloud OBS mb",                "capability": "cli"}
{"key": "tool:mcp__huaweicloud-devkit__huaweicloud_run_readonly_command", "value": "1", "capability": "mcp"}
```

## 7. 配置

### 7.1 hooks.json

部署到 `~/.atomcode/hooks.json`（或合并到已有文件）：

```json
{
  "hooks": {
    "hw-telemetry": {
      "event": "pre_tool_use",
      "command": "node <plugin_dir>/hooks/huaweicloud-telemetry.js",
      "timeout_ms": 2000
    }
  }
}
```

### 7.2 环境变量

Hook 进程运行时，AtomCode 注入以下环境变量：

| 变量                    | 说明                                 |
| ----------------------- | ------------------------------------ |
| `ATOMCODE_TOOL_NAME`    | 工具名，如 `bash`、`skill`、`mcp__*` |
| `ATOMCODE_HOOK_EVENT`   | 事件类型，值为 `pre_tool_use`        |
| `ATOMCODE_HOOK_CONTEXT` | stdin JSON，包含工具参数             |

## 8. 实现约束

| 约束             | 说明                                                                     |
| ---------------- | ------------------------------------------------------------------------ |
| **不阻塞**       | 全部走 `exit(0)`，异常静默吞掉，遥测不影响主流程                         |
| **复用基础设施** | 正则表达式 `HCLOUD_RE`、`READ_VERBS`、`WRITE_VERBS` 与现有四平台严格一致 |
| **兼容占位 CLI** | `hcloud` 可能在 PATH 也可能是 `hcloud.exe`，正则同时匹配                 |
| **Node.js 实现** | 无需额外依赖，复用 `fs.appendFileSync` 写文件                            |
| **DEBUG 开关**   | `HUAWEICLOUD_DEVKIT_DEBUG=true` 时输出调试日志                           |

## 9. 与其他平台对比总结

| 能力         | DSH | Hermes | OpenCode | WorkBuddy | **AtomCode** |
| ------------ | :-: | :----: | :------: | :-------: | :----------: |
| Skill 跟踪   |  —  |   —    |    —     |     —     |      —       |
| CLI 分类     | ✅  |   ✅   |    ✅    |    ✅     |      ✅      |
| MCP 跟踪     | ✅  |   ✅   |    —     |    ✅     |      ✅      |
| 流式消息解析 |  —  |   —    |    ✅    |     —     |      —       |
| 安全拦截     |  —  |   —    |    —     |     —     |      —       |
| 实现语言     | JS  | Python |    JS    |  Python   |    **JS**    |
| 代码行数     | 147 |  226   |   113    |    226    |   **~100**   |

## 10. 后续实现步骤

1. **实现** `integrations/atomcode/hooks/huaweicloud-telemetry.js`
2. **创建** `integrations/atomcode/hooks.json` 配置模板
3. **测试** 模拟三种工具调用，验证事件写入
4. **安装脚本更新** 将 atomcode hooks.json 合并逻辑加入 `bin/setup.cjs`
5. **文档更新** `INSTALL.md` 增加 AtomCode 安装说明
