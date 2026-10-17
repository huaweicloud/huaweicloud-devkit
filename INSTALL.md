# HuaweiCloud DevKit 安装指南

## 前置条件

- Node.js >= 22.18
- 华为云账号
- KooCLI (hcloud) 已安装并配置

## 安装 KooCLI

参考官方文档：https://support.huaweicloud.com/qs-hcli/hcli_02_003.html

```bash
hcloud version  # 验证安装
hcloud configure init  # 配置 AK/SK 和区域
```

## 安装插件 (Codex)

```powershell
.\scripts\install-codex-local.ps1
```

新建 Codex 会话，输入 `@HuaweiCloud-Devkit` 加载插件。

## 安装插件 (OpenCode)

从仓库检出安装（先构建产物 `dist/` 与 `skills/`，二者均不随 git 提交）：

```powershell
npm install
npm run build
node .\bin\setup.cjs install --target opencode
```

或直接使用已发布的安装器：

```powershell
npx --yes huaweicloud-devkit install --target opencode
```

安装器将 `integrations/opencode/opencode.json` 中的 MCP 配置合并到你的 OpenCode 配置中。

## 安装插件 (DeepSeek Harness)

```bash
npx --yes huaweicloud-devkit install --target dsh
```

安装器会写入：

- `$DSH_HOME/huaweicloud-plugins`：MCP Server、安全策略和 Skills（服务器数据，服务类技能经 MCP 的 `huaweicloud_list_packs` / `huaweicloud_list_skills` / `huaweicloud_retrieve_skill` 披露；stdio 会话的 `huaweicloud_list_skills` 载荷另携带 `skillRoot` 技能树位置，同机 agent 可直读技能文件）。
- `$DSH_HOME/skills`：六个核心元技能（`huaweicloud-*` 路由层）的原生副本，用于系统提示级披露；由安装/更新和 npm postinstall 幂等刷新。
- `$DSH_HOME/profiles/web/cordis.patch.yml`：DSH MCP 注册补丁。

如果没有设置 `DSH_HOME`，默认使用 `~/.dsh`。安装后重启 DSH 会话。

常用命令：

```bash
npx --yes huaweicloud-devkit status --target dsh
npx --yes huaweicloud-devkit update --target dsh
npx --yes huaweicloud-devkit uninstall --target dsh
```

如提示 DSH MCP 客户端未检测到，请执行：

```bash
npx @deepseek-ai/dsh plugin --profile web add @deepseek-ai/dsh-mcp-client
```

## 安装插件 (AtomCode)

```bash
npx --yes huaweicloud-devkit install --target atomcode
```

安装器会写入：

- `$ATOMCODE_HOME/skills`：华为云 Skills。
- `$ATOMCODE_HOME/huaweicloud-plugins`：MCP Server、安全策略、Hook。
- `$ATOMCODE_HOME/mcp.json`：MCP 服务器注册。
- `$ATOMCODE_HOME/hooks.json`：pre_tool_use 遥测 Hook。

如果没有设置 `ATOMCODE_HOME`，默认使用 `~/.atomcode`。安装后重启 AtomCode 会话。

常用命令：

```bash
npx --yes huaweicloud-devkit status --target atomcode
npx --yes huaweicloud-devkit update --target atomcode
npx --yes huaweicloud-devkit uninstall --target atomcode
```

## 验证

```bash
npm test
npm run validate
```

预期输出：

- 测试全部通过
- "Validated HuaweiCloud DevKit with 30 skills."

## 开发环境

```bash
npm install    # 项目零 npm 运行时依赖，此步仅安装 dev 依赖
npm test       # 运行测试套件
npm run validate  # 校验插件包结构
```

## 目录结构

```
huaweicloud-devkit/
├── .agents/plugins/marketplace.json    # Codex 市场清单
├── plugins/huaweicloud-core/           # 插件主体
│   ├── .codex-plugin/plugin.json
│   ├── .claude-plugin/plugin.json
│   ├── .cursor-plugin/plugin.json
│   ├── .mcp.json                       # MCP 服务器配置
│   ├── hooks/                          # 安全钩子
│   ├── safety/policy.json              # 安全策略
│   ├── skills/                         # 生成产物（30 个技能 + .manifest.json），由 npm run build 再生，不随 git 提交
│   └── src/                            # MCP 服务器源码（技能权威源在 src/packs/<id>/skills/）
├── integrations/opencode/              # OpenCode 集成
├── scripts/                            # 安装与校验脚本
├── test/                               # 测试套件
└── docs/                               # 设计文档，含 DSH 集成说明
```
