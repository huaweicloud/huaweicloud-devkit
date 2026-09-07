# E2E 测试架构设计

## 1. 背景

### 1.1 为什么需要 E2E 测试

当前 DevKit 插件已适配 9 个 Agent（OpenCode、Codex、CodeArts、WorkBuddy、DSH、OfficeAce、Hermes、OpenClaw、AtomCode），但测试覆盖存在缺口：

| 测试层 | 现状 | 问题 |
|--------|------|------|
| 单元/集成测试 | 18 个 .test.mjs，CI 已跑 | 只测组件级，不测完整流程 |
| E2E 插件验证 | plugins-e2e.test.mjs（骨架） | 只测安装/卸载，不测 MCP 工具是否真正可用 |
| 场景回归 | nightly 回归 Skill（人工） | 依赖人工执行，无法在 CI 中自动跑 |

**核心问题**：插件安装成功 ≠ MCP 工具能用。现有测试验证了"文件复制到位"，但没有验证"MCP 服务器能启动、工具能调用、结果能返回"。

### 1.2 与 Issue #230 的关系

Issue #230（ChenyYin 提案）提出了完整的 E2E 测试框架方案，包含 pytest、DeepEval、YAML、GitHub Actions Matrix 等。经团队评估（zrr 反馈）：

- #230 作为**参考方案**，不直接照搬
- 需要团队**自己设计架构**，适配实际情况
- 各负责人**优化自己负责的测试用例**

本设计基于 #230 的思路，简化为现有 Node.js 体系可实现方案。

## 2. 设计目标

验证 DevKit 插件在真实环境中的**安装 → MCP 工具调用 → 卸载**全流程，不引入新依赖。

| 目标 | 说明 |
|------|------|
| 验证 MCP 工具可用 | 安装后启动 MCP 服务器，调用 tools/list，验证工具返回 |
| CI 可自动执行 | 在现有 ci.yml 中加一行，无需新增 CI 作业 |
| 无新依赖 | 不引入 Python、pytest、DeepEval、YAML |
| 覆盖多 Agent | OpenCode、Codex Desktop、WorkBuddy 三个 target |
| 环境隔离 | 每个测试用例使用独立临时目录，互不干扰 |

## 3. 架构分层

```
┌─────────────────────────────────────────────────┐
│  第三层：场景回归（人工/半自动）                    │
│  ├── nightly 回归 Skill                          │
│  │   ├── 买 ECS、部署 OBS 等复杂交互场景           │
│  │   └── 人工执行 + 记录缺口 + 迭代修复            │
│  └── 不追求全自动化（交互场景需多轮决策）            │
├─────────────────────────────────────────────────┤
│  第二层：E2E 插件验证（自动，CI 可跑）  ← 本次新增   │
│  ├── 安装插件 → 验证技能/配置/安全策略              │
│  ├── 启动 MCP 服务器 → 调用 tools/list → 验证返回  │
│  ├── 卸载插件 → 验证清理干净                       │
│  └── node --test 驱动，CI 自动执行                 │
├─────────────────────────────────────────────────┤
│  第一层：单元/集成测试（自动，CI 已跑）              │
│  ├── 18 个 .test.mjs 文件                         │
│  ├── 覆盖：安装、卸载、配置、安全策略、工具定义等    │
│  └── npm test 自动执行                            │
└─────────────────────────────────────────────────┘
```

## 4. 与 Issue #230 提案的区别

| 维度 | #230 提案 | 本架构 | 选择理由 |
|------|----------|--------|---------|
| 测试框架 | pytest（Python） | node --test（Node.js） | 与现有 18 个测试一致，无新依赖 |
| 语义评测 | DeepEval（LLM 裁判） | 确定性断言 | LLM 裁判非确定性，结果不可复现 |
| 测试用例格式 | YAML 配置 | .test.mjs 代码 | 不增加间接层，直接写代码更灵活 |
| Agent 适配层 | 统一 Adapter 接口 | 直接 spawn CLI | 3 个 target 不需要抽象层 |
| CI 集成 | GitHub Actions Matrix | 现有 ci.yml 加一行 | 复用现有 integration job |
| 外部依赖 | Python + DeepEval + YAML | 无新增 | 降低维护成本 |

**核心原则**：不引入新依赖，用现有 Node.js 体系把 E2E 补全。

## 5. E2E 测试生命周期

```
┌──────────────────────────────────┐
│  1. 创建临时环境                   │
│  ├── 临时 HOME 目录               │
│  └── 临时工作目录                  │
├──────────────────────────────────┤
│  2. 安装插件                       │
│  ├── 运行 setup.cjs install       │
│  └── 验证退出码 = 0               │
├──────────────────────────────────┤
│  3. 验证安装结果                   │
│  ├── 技能数 >= 6                  │
│  ├── MCP 服务器文件存在            │
│  ├── 安全策略文件存在              │
│  └── MCP 配置已注册                │
├──────────────────────────────────┤
│  4. 启动 MCP 服务器                │
│  ├── spawn node mcp-server.mjs    │
│  └── 发送 initialize 请求          │
│      → 验证 serverInfo.name 正确   │
├──────────────────────────────────┤
│  5. 调用 tools/list               │
│  ├── 验证工具数 > 0                │
│  └── 验证工具名以 huaweicloud_ 开头 │
├──────────────────────────────────┤
│  6. 卸载插件                       │
│  ├── 运行 setup.cjs uninstall     │
│  └── 验证文件已清除                │
├──────────────────────────────────┤
│  7. 清理环境                       │
│  └── rm -rf 临时目录               │
└──────────────────────────────────┘
```

## 6. MCP 工具调用方式

不启动完整 Agent CLI，直接通过 stdio 与 MCP 服务器通信：

```javascript
// 启动 MCP 服务器子进程
const child = spawn('node', [mcpServerPath], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: makeEnv(home, cwd),
});

// 发送 JSON-RPC initialize
child.stdin.write(JSON.stringify({
  jsonrpc: '2.0', method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'e2e-test', version: '1.0' }
  },
  id: 1
}) + '\n');

// 收到 initialize 响应后，发送 tools/list
child.stdin.write(JSON.stringify({
  jsonrpc: '2.0', method: 'tools/list', params: {}, id: 2
}) + '\n');

// 从 stdout 按行读取 JSON-RPC 响应
// 验证：serverInfo.name = "huaweicloud-devkit"
// 验证：tools 数组非空，所有工具名以 huaweicloud_ 开头
```

**为什么不调用具体工具（如 list_regions）**：具体工具需要华为云凭证和网络访问，在 CI 环境中不可用。tools/list 只需要 MCP 服务器启动，不需要外部依赖。

## 7. 测试覆盖的 Agent

| Agent | 安装测试 | MCP 工具调用 | 卸载测试 | 合计测试数 |
|-------|---------|-------------|---------|-----------|
| OpenCode | ✅ | ✅ | ✅ | 3 |
| Codex Desktop | ✅ | ✅ | ✅ | 3 |
| WorkBuddy | ✅ | ✅ | ✅ | 3 |
| **合计** | 3 | 3 | 3 | **9** |

## 8. CI 集成

在现有 `ci.yml` 的 `integration` job 中增加一行：

```yaml
  integration:
    needs: [test]
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: npm
      - run: npm ci
      # 现有
      - run: node --test test/agent-install.test.mjs test/cross-platform-*.test.mjs
      # 新增 ↓
      - run: node --test test/plugins-e2e.test.mjs
```

**不需要新增 CI 作业**，复用现有 integration job。

## 9. 各负责人优化方向

现有 18 个测试文件，各负责人按模块优化：

| 测试文件 | 大小 | 优化方向 |
|---------|------|---------|
| structure.test.mjs | 28KB | 补充 claude-code 集成的结构验证 |
| agent-install.test.mjs | 17KB | 增加 Claude Code target 的安装测试 |
| tools.test.mjs | 7.5KB | 验证工具标注（readOnlyHint / destructiveHint） |
| safety-policy.test.mjs | 7.5KB | 补充新安全规则的测试用例 |
| mcp-server.test.mjs | 6.0KB | 验证 MCP 服务器 initialize + tools/list 流程 |
| auth-credentials.test.mjs | 12KB | 补充 STS 临时凭证的测试 |
| codearts-adaptation.test.mjs | 13KB | CodeArts 负责人优化 |
| dsh-adaptation.test.mjs | 9.7KB | DSH 负责人优化 |
| officeace-adaptation.test.mjs | 3.2KB | OfficeAce 负责人优化 |
| 其他 9 个文件 | 1.3-13KB | 各模块负责人优化 |

## 10. 不做的事情

| 不做 | 原因 |
|------|------|
| 引入 pytest/Python | 增加维护成本，与现有体系不一致 |
| 引入 DeepEval | LLM 裁判非确定性，测试结果不可复现 |
| YAML 测试用例 | 增加间接层，不如直接写 .test.mjs |
| 真实云操作 E2E | 费用高、风险大、耗时长，留给 nightly 回归 |
| 多轮交互自动化 | 交互场景需根据中间结果决策，无法用单次 prompt 覆盖 |
| 调用具体 MCP 工具 | 需要凭证和网络，CI 环境不可用；tools/list 足够验证 MCP 服务器可用性 |

## 11. 预期收益

| 指标 | 现状 | 实施后 |
|------|------|--------|
| CI 中自动跑的 E2E 测试数 | 0 | 9（3 Agent × 3 场景） |
| MCP 工具可用性验证 | 人工 | 自动（CI 每次 PR 自动跑） |
| 测试文件总数 | 18 | 18（不新增文件，增强现有） |
| 新增外部依赖 | - | 0 |
| 安装→工具调用→卸载全流程 | 人工 | 自动 |

## 12. 工作量估算

| 任务 | 负责人 | 工作量 |
|------|--------|--------|
| 架构设计文档 | 已完成 | - |
| 补全 plugins-e2e.test.mjs | 已完成 | - |
| ci.yml 集成 | 维护者 | 5 分钟（加一行） |
| 各负责人优化测试用例 | 各负责人 | 每人 2-4 小时 |
| 评审会议 | 全体 | 30-60 分钟 |

## 13. 风险与应对

| 风险 | 概率 | 影响 | 应对 |
|------|------|------|------|
| MCP 服务器在 CI 环境启动失败 | 低 | E2E 测试报错 | CI 已有 Node.js 22+，MCP 服务器无外部依赖 |
| 临时目录清理不干净 | 低 | 磁盘占用 | 使用 finally 块确保清理 |
| 测试超时 | 低 | CI 卡住 | 设置 15 秒超时 + child.kill() |
| 新增 Agent 需要补充测试 | 中 | 覆盖不全 | targets 数组加一项即可，代码结构可扩展 |
