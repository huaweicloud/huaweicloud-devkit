# HuaweiCloud DevKit

[![Discussions](https://img.shields.io/badge/Discussions-Join%20the%20discussion-blue)](https://github.com/huaweicloud/huaweicloud-devkit/discussions)
[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![CI](https://github.com/huaweicloud/huaweicloud-devkit/actions/workflows/ci.yml/badge.svg)](https://github.com/huaweicloud/huaweicloud-devkit/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/huaweicloud-devkit)](https://www.npmjs.com/package/huaweicloud-devkit)
[![Beta](https://img.shields.io/badge/beta-v1.1.3-orange)](https://github.com/huaweicloud/huaweicloud-devkit)

**中文 | [English](README.md)**

帮助 AI 编码助手安全、准确地使用华为云——一站式集成云知识、CLI 工具和安全护栏。

支持 OpenCode、Codex、码道（CodeArts Agent）、WorkBuddy、DeepSeek Harness（DSH）、OfficeAce、Hermes、OpenClaw、AtomCode。

## 前置条件

- Node.js >= 22

> **国内用户**：使用默认 npm 镜像时可能遇到下载缓慢或连接失败的问题，建议配置华为云 npm 镜像：
>
> ```bash
> npm config set registry https://mirrors.huaweicloud.com/repository/npm/
> ```
>
> 恢复默认镜像：`npm config delete registry`
>
> **镜像滞后**：npm 镜像（npmmirror、mirrors.huaweicloud.com）在新版本发布后可能滞后官方源数小时。若安装报 `ETARGET` 或拿到旧版本，改用官方源安装：
>
> ```bash
> npx --yes --registry=https://registry.npmjs.org huaweicloud-devkit install --target <target>
> ```

## 快速开始

> 省略 `--target` 时，安装器会自动检测机器上的 agent：
>
> - **未检测到**：交互终端会询问你如何继续（指定 target 安装 / 全部安装 / 接入通用 MCP agent）；非交互终端报错并列出支持列表。
> - **检测到单个**：直接安装到该 agent。
> - **检测到多个**：交互终端弹出多选；非交互终端报错并提示 `--target <agent>` 或 `--target all`。
>   需要一步全量安装时执行 `npx --yes huaweicloud-devkit install --target all`（Codex 缺少 CLI 时跳过）。

以下为全局命令（一次性作用于所有 agent）：

```bash
npx --yes huaweicloud-devkit version  # 查看 CLI 版本和各 agent 已安装的插件版本
npx --yes huaweicloud-devkit uninstall --target all --clean-global  # 一并删除 KooCLI 与 OBS 配置
```

### OpenCode

```bash
npx --yes huaweicloud-devkit install --target opencode
```

安装后**重启会话**。

```bash
npx --yes huaweicloud-devkit doctor --target opencode
npx --yes huaweicloud-devkit status --target opencode
npx --yes huaweicloud-devkit update --target opencode
npx --yes huaweicloud-devkit uninstall --target opencode
rm -rf ~/.npm/_npx/  # 仅 Linux/macOS；Windows：rmdir /s /q %LOCALAPPDATA%\npm-cache\_npx
```

### Codex

```bash
npx --yes huaweicloud-devkit install --target codex
```

安装后**重启 Codex 会话**。

```bash
codex plugin list  # 验证 huaweicloud-devkit@huaweicloud-devkit 已安装并启用
npx --yes huaweicloud-devkit doctor --target codex
npx --yes huaweicloud-devkit status --target codex
npx --yes huaweicloud-devkit update --target codex
npx --yes huaweicloud-devkit uninstall --target codex
```

随后在 Codex 中提及 `@huaweicloud-devkit`，或直接描述华为云任务。

> **需要 Codex CLI** — `codex` 命令必须在 PATH 中。若 Codex 通过 WindowsApps（Microsoft Store）安装，请使用 `--target codex-desktop` 替代。运行 `codex --version` 验证 CLI 可用性。

### Codex Desktop

当 Codex CLI 不可用，或 Windows 上通过 WindowsApps 安装 Codex 时，使用此目标。

```bash
npx --yes huaweicloud-devkit install --target codex-desktop
```

安装后**重启 Codex Desktop 会话**。

```bash
npx --yes huaweicloud-devkit doctor --target codex-desktop
npx --yes huaweicloud-devkit status --target codex-desktop
npx --yes huaweicloud-devkit update --target codex-desktop
npx --yes huaweicloud-devkit uninstall --target codex-desktop
```

随后在新的 Codex Desktop 任务中提及 `@huaweicloud-devkit`，或直接描述华为云任务。

### CodeArts Agent（码道）

```bash
npx --yes huaweicloud-devkit install --target codearts
```

安装后**重启会话**。

```bash
npx --yes huaweicloud-devkit doctor --target codearts
npx --yes huaweicloud-devkit status --target codearts
npx --yes huaweicloud-devkit update --target codearts
npx --yes huaweicloud-devkit uninstall --target codearts
```

> **沙箱模式**：码道默认沙箱模式会阻止 KooCLI 运行。`install-hcloud` 自动检测并给出指引——请在码道外终端安装使用 KooCLI，或在码道设置中关闭沙箱模式（设置 → 对话流 → 智能体 终端命令运行模式 → 自动运行）。

### CodeArts Work（码道工作空间）

```bash
npx --yes huaweicloud-devkit install --target codearts-work
```

安装后**重启会话**。

```bash
npx --yes huaweicloud-devkit doctor --target codearts-work
npx --yes huaweicloud-devkit status --target codearts-work
npx --yes huaweicloud-devkit update --target codearts-work
npx --yes huaweicloud-devkit uninstall --target codearts-work
```

> **CodeArts Work**（工作空间，appId: `com.codearts.work`）使用用户级配置 `%USERPROFILE%\.codeartswork\`，不创建项目级目录。

### WorkBuddy

```bash
npx --yes huaweicloud-devkit install --target workbuddy
```

安装后**重启会话**。

```bash
npx --yes huaweicloud-devkit doctor --target workbuddy
npx --yes huaweicloud-devkit status --target workbuddy
npx --yes huaweicloud-devkit update --target workbuddy
npx --yes huaweicloud-devkit uninstall --target workbuddy
```

### DeepSeek Harness（DSH）

```bash
npx --yes huaweicloud-devkit install --target dsh
```

安装后**重启 DSH 会话**。

```bash
npx --yes huaweicloud-devkit doctor --target dsh
npx --yes huaweicloud-devkit status --target dsh
npx --yes huaweicloud-devkit update --target dsh
npx --yes huaweicloud-devkit uninstall --target dsh
```

> DSH V1 通过 `@deepseek-ai/dsh-mcp-client` 复用现有 MCP Server。如果安装器提示客户端未检测到，请执行：`npx @deepseek-ai/dsh plugin --profile web add @deepseek-ai/dsh-mcp-client`。

### OfficeAce

```bash
npx --yes huaweicloud-devkit install --target officeace
```

安装后**重启 OfficeAce**。

```bash
npx --yes huaweicloud-devkit doctor --target officeace
npx --yes huaweicloud-devkit status --target officeace
npx --yes huaweicloud-devkit update --target officeace
npx --yes huaweicloud-devkit uninstall --target officeace
```

### Hermes

```bash
npx --yes huaweicloud-devkit install --target hermes
```

安装后**重启 Hermes 会话**。

```bash
npx --yes huaweicloud-devkit doctor --target hermes
npx --yes huaweicloud-devkit status --target hermes
npx --yes huaweicloud-devkit update --target hermes
npx --yes huaweicloud-devkit uninstall --target hermes
```

> **卸载说明**：Linux 上卸载后执行 `rm -rf ~/.npm/_npx/* && npm cache clean --force` 确保下次全新安装。Windows 上先关闭所有 Hermes 会话（释放文件锁），卸载后检查 `%LOCALAPPDATA%\hermes\config.yaml` 是否有 YAML 损坏，如有残留文件手动删除 `%LOCALAPPDATA%\hermes\huaweicloud-plugins`。
> **安全钩子（Safety hooks）**：安装器会在 `config.yaml` 中写入 shell hooks 配置（`hooks.pre_tool_call`），拦截不安全的终端命令，如读取凭据文件、导出环境变量、未审批的 `hcloud` 写操作。Hermes 首次使用时会弹出同意提示，可批准或设置 `hooks_auto_accept: true` 自动批准。
> **MCP Python SDK**：安装器会自动安装 Hermes 所需的 `mcp` Python 包。如果 doctor 显示 `[FAIL] Hermes MCP Python SDK`，手动执行 `pip3 install mcp`。
> **Windows**：参见 [docs/hermes-windows.md](docs/hermes-windows.md) 了解已知问题和解决方法。

### OpenClaw

```bash
# 推荐方式 (ClawHub)
openclaw plugins install clawhub:huaweicloud-devkit
openclaw plugins uninstall huaweicloud-devkit
openclaw plugins update huaweicloud-devkit
```

安装后**重启 OpenClaw**。如提示安全风险确认，加 `--acknowledge-clawhub-risk`。

```bash
# 或通过 npx
npx --yes huaweicloud-devkit install --target openclaw
npx --yes huaweicloud-devkit status --target openclaw
npx --yes huaweicloud-devkit update --target openclaw
npx --yes huaweicloud-devkit uninstall --target openclaw
rm -rf ~/.npm/_npx/  # 仅 Linux/macOS；Windows：rmdir /s /q %LOCALAPPDATA%\npm-cache\_npx
```

### AtomCode

```bash
npx --yes huaweicloud-devkit install --target atomcode
```

安装后**重启 AtomCode 会话**。

```bash
npx --yes huaweicloud-devkit doctor --target atomcode
npx --yes huaweicloud-devkit status --target atomcode
npx --yes huaweicloud-devkit update --target atomcode
npx --yes huaweicloud-devkit uninstall --target atomcode
```

### 其他 Agent

任何支持 MCP 协议的 Agent，直接使用标准 MCP 配置：

```json
{
  "mcpServers": {
    "huaweicloud-devkit": {
      "command": "npx",
      "args": ["-y", "-p", "huaweicloud-devkit", "huaweicloud-devkit-mcp"]
    }
  }
}
```

无需预安装 — `npx` 自动处理一切。

> 像上面这种手动 MCP 注册方式，请勿在配置里写凭据。`HW_ACCESS_KEY`/`HW_SECRET_KEY` 是保留给**平台/CI 注入**的账号用的（例如 DevSpace 托管的默认账号）——自己的账号统一通过 `npx huaweicloud-devkit auth init` 配置（唯一入口），会话内切换账号用 `huaweicloud_auth_init` / `huaweicloud_auth_switch` MCP 工具。完整凭据解析优先级见 `plugins/huaweicloud-core/skills/huaweicloud-cli-and-auth/SKILL.md`。

#### 通过 Remote（HTTP）连接

若 Agent 支持 `type: "remote"`（Streamable HTTP）而非 stdio，可在本地先启动 devkit 的远程 MCP 服务器：

```bash
npx --yes huaweicloud-devkit-mcp --transport remote
```

默认监听 `127.0.0.1:9528`。随后以远程方式连接（以 opencode 为例）：

```jsonc
{
  "mcp": {
    "huaweicloud-devkit": {
      "type": "remote",
      "url": "http://localhost:9528",
      "enabled": true,
    },
  },
}
```

> 端口被占用时用 `--port <端口>` 换端口，`url` 同步修改；需要局域网访问时加 `--host 0.0.0.0`。remote 服务器不内置鉴权，请勿匿名暴露到公网。

### 安装 KooCLI

```bash
npx --yes huaweicloud-devkit install-hcloud
```

### 配置凭据

```bash
npx --yes huaweicloud-devkit auth init
```

一步同步 AK/SK 到 KooCLI、OBS 和沙箱接口——这是**唯一入口**，切勿把 AK/SK 手写进 Agent 或 shell 配置。

**会话内切换账号**：使用 MCP 工具 `huaweicloud_auth_init`（内存态，优先级最高）或 `huaweicloud_auth_switch`（`temporary` / `persist` / `clear`）。在沙箱/DevSpace 环境中若默认账号经 `HW_ACCESS_KEY`/`HW_SECRET_KEY` 注入，单纯 `auth init` 无法覆盖——需 `huaweicloud_auth_switch action=persist` 让会话账号生效。

**凭据解析优先级**（从高到低）：

| #   | 来源                                          | 由谁设置                                                                      |
| --- | --------------------------------------------- | ----------------------------------------------------------------------------- |
| 1   | 运行时（会话）凭据                            | `huaweicloud_auth_init` / `huaweicloud_auth_switch action=temporary`          |
| 2   | 带 `configuredBySession: true` 的 S1 全局文件 | `huaweicloud_auth_switch action=persist`                                      |
| 3   | 环境变量（`HW_ACCESS_KEY`/`HW_SECRET_KEY`）   | 平台/DevSpace 注入的默认账号                                                  |
| 4   | CodeArts / CodeArts Work                      | `.codeartsdoer/mcp/mcp_settings.json` / `.codeartswork/mcp/mcp_settings.json` |
| 5   | S1 全局文件（无会话标记）                     | `auth init`                                                                   |
| 6   | KooCLI profile                                | `~/.hcloud/config.json`（仅 KooCLI 命令）                                     |

> **安全**：切勿把自己账号的 AK/SK 写入 MCP 配置的 `env` 字段——会以明文存储，配置文件提交 git 时即泄密；`env` 仅用于平台/CI 注入。

完整说明：`plugins/huaweicloud-core/skills/huaweicloud-cli-and-auth/SKILL.md`。

### 安装所有 Agent

```bash
npx --yes huaweicloud-devkit install --target all
```

### 更新所有 Agent

```bash
npx --yes huaweicloud-devkit@latest version
npx --yes huaweicloud-devkit@latest update --target all
```

`update` 是增量更新——只刷新已安装的文件，不动配置文件。请务必保留 `@latest`，确保 npm 获取最新版本而非本地缓存的旧版本。

## 功能特性

- **引导式云操作** — Agent 获得 20+ 常用华为云服务的分步操作指引（ECS、OBS、VPC、RDS、GaussDB、FunctionGraph、APIG、CCE 等）
- **安全优先执行** — 所有写操作需用户明确批准；凭证和密钥自动脱敏
- **执行前风险检查** — 公网暴露、凭证泄露、破坏性操作在执行前即被拦截
- **区域感知** — 自动发现可用区域，创建资源前检查服务可用性
- **沙箱（DevStation）** — 临时云端运行环境，部署 Web 应用并即刻获得公网预览地址

## 支持的服务

ECS、OBS、VPC、IAM、RDS、GaussDB、FunctionGraph、APIG、CCE、SMN/DMS、ModelArts、Cloud Eye、CTS、DEW、Billing、CBR、WAF/AAD、DDS/DCS、Deployment，以及入门指南。

> 以上为预置指引的服务列表；其余 200+ 华为云服务仍可通过 KooCLI / API / SDK 路由调用（见 capability-discovery 与 cli-and-auth 元技能）。

## 文档

- [架构](docs/architecture.md)
- [安全模型](docs/safety-model.md)
- [Hook 规则模型](docs/hook-rule-model.md)
- [DeepSeek Harness 集成](docs/dsh-integration.md)
- [变更记录](docs/CHANGELOG.md)
- [KooCLI 官方文档](https://support.huaweicloud.com/qs-hcli/hcli_02_003.html)

## 贡献者

<a href="https://github.com/huaweicloud/huaweicloud-devkit/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=huaweicloud/huaweicloud-devkit" />
</a>

## 许可证

本项目基于 Apache-2.0 许可证发布。详见 [LICENSE](LICENSE)。
