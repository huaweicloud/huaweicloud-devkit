# E2E 测试架构设计

## 1. 设计目标

验证华为云 DevKit 插件在真实 Code Agent 环境中的安装、加载、工具调用和卸载全流程，不依赖外部框架（无 pytest、无 DeepEval、无 YAML），基于现有 Node.js 体系构建。

## 2. 架构分层

```
第三层：场景回归（人工/半自动）
  ├── nightly 回归 Skill（买 ECS、部署 OBS 等复杂交互场景）
  ├── 人工执行 + 记录缺口 + 迭代修复
  └── 不追求全自动化（交互场景需多轮决策）

第二层：E2E 插件验证（自动，CI 可跑）
  ├── 安装插件 → 验证技能/配置/安全策略
  ├── 启动 MCP 服务器 → 调用只读工具 → 验证返回结果
  ├── 卸载插件 → 验证清理干净
  └── node --test 驱动，CI 自动执行

第一层：单元/集成测试（自动，CI 已跑）
  ├── 18 个 .test.mjs 文件
  ├── 覆盖：安装、卸载、配置、安全策略、工具定义、风险引擎等
  └── npm test 自动执行
```

## 3. 与 Issue #230 提案的区别

| 维度 | #230 提案 | 本架构 |
|------|----------|--------|
| 测试框架 | pytest（Python） | node --test（Node.js） |
| 语义评测 | DeepEval（LLM 裁判） | 确定性断言（不需要 LLM） |
| 测试用例格式 | YAML 配置 | .test.mjs 代码 |
| Agent 适配层 | 统一 Adapter 接口 | 直接 spawn CLI |
| 外部依赖 | Python + DeepEval + YAML | 无新增依赖 |
| CI 集成 | GitHub Actions Matrix | 现有 ci.yml 加一行 |

**核心原则**：不引入新依赖，用现有 Node.js 体系把 E2E 补全。

## 4. E2E 测试生命周期

```
┌──────────────────────────┐
│  1. 创建临时环境           │
│  ├── 临时 HOME 目录       │
│  └── 临时工作目录          │
├──────────────────────────┤
│  2. 安装插件               │
│  ├── 运行 setup.cjs install│
│  └── 验证退出码 = 0        │
├──────────────────────────┤
│  3. 验证安装结果           │
│  ├── 技能数 >= 6          │
│  ├── MCP 服务器文件存在    │
│  ├── 安全策略文件存在      │
│  └── MCP 配置已注册        │
├──────────────────────────┤
│  4. 启动 MCP 服务器        │
│  ├── spawn node mcp-server│
│  └── 发送 initialize 请求  │
├──────────────────────────┤
│  5. 调用只读 MCP 工具      │
│  ├── tools/list           │
│  ├── 验证工具数 > 0        │
│  └── 验证工具名前缀正确     │
├──────────────────────────┤
│  6. 卸载插件               │
│  ├── 运行 setup.cjs uninstall│
│  └── 验证文件已清除        │
├──────────────────────────┤
│  7. 清理环境               │
│  └── rm -rf 临时目录       │
└──────────────────────────┘
```

## 5. MCP 工具调用方式

不启动完整 Agent CLI，直接通过 stdio 与 MCP 服务器通信：

```javascript
// 启动 MCP 服务器子进程
const child = spawn('node', [mcpServerPath], { stdio: ['pipe', 'pipe', 'pipe'] });

// 发送 JSON-RPC initialize
child.stdin.write(JSON.stringify({
  jsonrpc: '2.0', method: 'initialize',
  params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'e2e-test', version: '1.0' } },
  id: 1
}) + '\n');

// 发送 tools/list
child.stdin.write(JSON.stringify({
  jsonrpc: '2.0', method: 'tools/list', params: {}, id: 2
}) + '\n');

// 从 stdout 读取响应（按行解析 JSON）
```

## 6. 测试覆盖的 Agent

| Agent | 安装测试 | MCP 工具调用 | 卸载测试 |
|-------|---------|-------------|---------|
| OpenCode | ✅ | ✅ | ✅ |
| Codex Desktop | ✅ | ✅ | ✅ |
| WorkBuddy | ✅ | ✅ | ✅ |

## 7. CI 集成

在现有 `ci.yml` 中增加 E2E 测试步骤：

```yaml
- name: Run E2E tests
  run: node --test test/plugins-e2e.test.mjs
```

## 8. 各负责人优化方向

| 测试文件 | 优化方向 |
|---------|---------|
| structure.test.mjs | 补充新增组件（claude-code 集成）的结构验证 |
| agent-install.test.mjs | 增加 Claude Code target 的安装测试 |
| tools.test.mjs | 验证工具标注（readOnlyHint / destructiveHint） |
| safety-policy.test.mjs | 补充新安全规则的测试用例 |
| mcp-server.test.mjs | 验证 MCP 服务器 initialize + tools/list 流程 |
| auth-credentials.test.mjs | 补充 STS 临时凭证的测试 |
| 其他适配测试 | 各 Agent 负责人补充对应适配测试 |

## 9. 不做的事情

| 不做 | 原因 |
|------|------|
| 引入 pytest/Python | 增加维护成本，与现有体系不一致 |
| 引入 DeepEval | LLM 裁判非确定性，测试结果不可复现 |
| YAML 测试用例 | 增加间接层，不如直接写 .test.mjs |
| 真实云操作 E2E | 费用高、风险大、耗时长，留给 nightly 回归 |
| 多轮交互自动化 | 交互场景需根据中间结果决策，无法用单次 prompt 覆盖 |
