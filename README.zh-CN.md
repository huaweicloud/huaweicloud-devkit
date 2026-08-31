# HuaweiCloud DevKit

[![参与讨论](https://img.shields.io/badge/参与讨论-Join%20the%20discussion-blue)](https://github.com/huaweicloud/huaweicloud-devkit/discussions)
[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![CI](https://github.com/huaweicloud/huaweicloud-devkit/actions/workflows/ci.yml/badge.svg)](https://github.com/huaweicloud/huaweicloud-devkit/actions/workflows/ci.yml)

**中文 | [English](README.md)**

帮助 AI 编码助手安全、准确地使用华为云——一站式集成云知识、CLI 工具和安全护栏。

支持 OpenCode、Codex、码道（CodeArts Agent）、WorkBuddy、DeepSeek Harness（DSH）、OfficeAce、Hermes、OpenClaw、AtomCode。

## 前置条件

- Node.js >= 22

## 快速开始

> 省略 `--target` 时，安装器会自动检测机器上的 agent，检测到多个时**全部安装**。建议始终指定 `--target` 以明确安装目标。

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
rm -rf ~/.npm/_npx/  # 仅 Linux/macOS；Windows 路径待确认
```

### Codex

```bash
npx --yes huaweicloud-devkit install --target codex
```

安装后**重启 Codex 会话**。

```bash
npx --yes huaweicloud-devkit doctor --target codex
npx --yes huaweicloud-devkit status --target codex
npx --yes huaweicloud-devkit update --target codex
npx --yes huaweicloud-devkit uninstall --target codex
```

> **需要 Codex CLI** — `codex` 命令必须在 PATH 中。若 Codex 通过 WindowsApps（Microsoft Store）安装，请使用 `--target codex-desktop` 替代。运行 `codex --version` 验证 CLI 可用性。

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
rm -rf ~/.npm/_npx/  # 仅 Linux/macOS；Windows 路径待确认
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

> 项目级 AK/SK 可通过 MCP 配置的 `env` 字段设置 `HW_ACCESS_KEY`/`HW_SECRET_KEY`。

### 安装 KooCLI

```bash
npx --yes huaweicloud-devkit install-hcloud
```

### 配置凭据

```bash
npx --yes huaweicloud-devkit auth init
```

一步同步 AK/SK 到 KooCLI、OBS 和沙箱接口。

### 安装所有 Agent

```bash
npx --yes huaweicloud-devkit install --target all
```

### 更新所有 Agent

```bash
npx --yes huaweicloud-devkit update --target all
```

`update` 是增量更新——只刷新已安装的文件，不动配置文件。

## 功能特性

- **引导式云操作** — Agent 获得 20+ 华为云服务的分步操作指引（ECS、OBS、VPC、RDS、GaussDB、FunctionGraph、APIG、CCE 等）
- **安全优先执行** — 所有写操作需用户明确批准；凭证和密钥自动脱敏
- **执行前风险检查** — 公网暴露、凭证泄露、破坏性操作在执行前即被拦截
- **区域感知** — 自动发现可用区域，创建资源前检查服务可用性
- **沙箱（DevStation）** — 临时云端运行环境，部署 Web 应用并即刻获得公网预览地址

## 支持的服务

ECS、OBS、VPC、IAM、RDS、GaussDB、FunctionGraph、APIG、CCE、SMN/DMS、ModelArts、Cloud Eye、CTS、DEW、Billing、CBR、WAF/AAD、DDS/DCS、Deployment，以及入门指南。

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
