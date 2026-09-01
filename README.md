# HuaweiCloud DevKit

[![Discussions](https://img.shields.io/badge/Discussions-Join%20the%20discussion-blue)](https://github.com/huaweicloud/huaweicloud-devkit/discussions)
[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![CI](https://github.com/huaweicloud/huaweicloud-devkit/actions/workflows/ci.yml/badge.svg)](https://github.com/huaweicloud/huaweicloud-devkit/actions/workflows/ci.yml)
[![Beta](https://img.shields.io/badge/beta-v1.1-orange)](https://github.com/huaweicloud/huaweicloud-devkit)

**[中文](README.zh-CN.md) | English**

Help AI coding agents use Huawei Cloud safely and accurately — a single integration that gives agents cloud knowledge, CLI tooling, and safety guardrails.

Supports OpenCode, Codex, CodeArts Agent, WorkBuddy, DeepSeek Harness (DSH), OfficeAce, Hermes, OpenClaw, and AtomCode.

## Prerequisites

- Node.js >= 22

> **China mainland users**: If you experience slow downloads or connection issues with the default npm registry, configure the Huawei Cloud npm mirror:
>
> ```bash
> npm config set registry https://mirrors.huaweicloud.com/repository/npm/
> ```
>
> Restore the default registry: `npm config delete registry`

## Quick Start

> If `--target` is omitted, the installer auto-detects agents on your machine. When multiple agents are detected, **all of them** will be installed. Specify `--target` to control which agent receives the install.

### OpenCode

```bash
npx --yes huaweicloud-devkit install --target opencode
```

**Restart the session** after installation.

```bash
npx --yes huaweicloud-devkit doctor --target opencode
npx --yes huaweicloud-devkit status --target opencode
npx --yes huaweicloud-devkit update --target opencode
npx --yes huaweicloud-devkit uninstall --target opencode
rm -rf ~/.npm/_npx/  # Linux/macOS only; Windows path TBD
```

### Codex

```bash
npx --yes huaweicloud-devkit install --target codex
```

**Restart the Codex session** after installation.

```bash
npx --yes huaweicloud-devkit doctor --target codex
npx --yes huaweicloud-devkit status --target codex
npx --yes huaweicloud-devkit update --target codex
npx --yes huaweicloud-devkit uninstall --target codex
```

> **Requires Codex CLI** — the `codex` command must be in PATH. If Codex is installed via WindowsApps (Microsoft Store), use `--target codex-desktop` instead. Run `codex --version` to verify CLI availability.

### CodeArts Agent

```bash
npx --yes huaweicloud-devkit install --target codearts
```

**Restart the session** after installation.

```bash
npx --yes huaweicloud-devkit doctor --target codearts
npx --yes huaweicloud-devkit status --target codearts
npx --yes huaweicloud-devkit update --target codearts
npx --yes huaweicloud-devkit uninstall --target codearts
```

> **Sandbox mode**: CodeArts defaults to sandbox mode which blocks KooCLI. `install-hcloud` detects this and shows how to resolve it — install KooCLI outside the sandbox terminal, or disable sandbox mode in CodeArts settings (Settings → Chats → Agents Terminal Command Running Mode → Auto Running).

### CodeArts Work

```bash
npx --yes huaweicloud-devkit install --target codearts-work
```

**Restart the session** after installation.

```bash
npx --yes huaweicloud-devkit doctor --target codearts-work
npx --yes huaweicloud-devkit status --target codearts-work
npx --yes huaweicloud-devkit update --target codearts-work
npx --yes huaweicloud-devkit uninstall --target codearts-work
```

> **CodeArts Work** (CodeArts Space, appId: `com.codearts.work`) uses user-level config at `%USERPROFILE%\.codeartswork\`. No project-level `.codeartswork` directory is created.

### WorkBuddy

```bash
npx --yes huaweicloud-devkit install --target workbuddy
```

**Restart the session** after installation.

```bash
npx --yes huaweicloud-devkit doctor --target workbuddy
npx --yes huaweicloud-devkit status --target workbuddy
npx --yes huaweicloud-devkit update --target workbuddy
npx --yes huaweicloud-devkit uninstall --target workbuddy
```

### DeepSeek Harness (DSH)

```bash
npx --yes huaweicloud-devkit install --target dsh
```

**Restart the DSH session** after installation.

```bash
npx --yes huaweicloud-devkit doctor --target dsh
npx --yes huaweicloud-devkit status --target dsh
npx --yes huaweicloud-devkit update --target dsh
npx --yes huaweicloud-devkit uninstall --target dsh
```

> DSH V1 reuses the existing MCP server through `@deepseek-ai/dsh-mcp-client`. If the installer reports that the client is not detected, run: `npx @deepseek-ai/dsh plugin --profile web add @deepseek-ai/dsh-mcp-client`.

### OfficeAce

```bash
npx --yes huaweicloud-devkit install --target officeace
```

**Restart OfficeAce** after installation.

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

**Restart the Hermes session** after installation.

```bash
npx --yes huaweicloud-devkit doctor --target hermes
npx --yes huaweicloud-devkit status --target hermes
npx --yes huaweicloud-devkit update --target hermes
npx --yes huaweicloud-devkit uninstall --target hermes
```

> **Uninstall notes**: On Linux, run `rm -rf ~/.npm/_npx/* && npm cache clean --force` after uninstall to ensure a clean slate. On Windows, close all Hermes sessions first to release file locks, then after uninstall check `%LOCALAPPDATA%\hermes\config.yaml` for YAML corruption and manually remove `%LOCALAPPDATA%\hermes\huaweicloud-plugins` if any files remain.
> **Safety hooks**: The installer configures Hermes shell hooks (`config.yaml` → `hooks.pre_tool_call`) to intercept unsafe terminal commands such as credential file reads, environment variable dumps, and unapproved `hcloud` write operations. Hermes shows a consent prompt the first time; approve it or set `hooks_auto_accept: true` in `config.yaml` to auto-accept.
> **MCP Python SDK**: The installer automatically installs the `mcp` Python package required by Hermes for MCP tool discovery. If you see `[FAIL] Hermes MCP Python SDK` in `doctor`, run `pip3 install mcp` manually.
> **Windows**: See [docs/hermes-windows.md](docs/hermes-windows.md) for known issues and workarounds.

### OpenClaw

```bash
# Recommended (ClawHub)
openclaw plugins install clawhub:huaweicloud-devkit
openclaw plugins uninstall huaweicloud-devkit
openclaw plugins update huaweicloud-devkit
```

**Restart OpenClaw** after installation. If prompted for security risk acknowledgment, add `--acknowledge-clawhub-risk`.

```bash
# Or via npx
npx --yes huaweicloud-devkit install --target openclaw
npx --yes huaweicloud-devkit status --target openclaw
npx --yes huaweicloud-devkit update --target openclaw
npx --yes huaweicloud-devkit uninstall --target openclaw
rm -rf ~/.npm/_npx/  # Linux/macOS only; Windows path TBD
```

### AtomCode

```bash
npx --yes huaweicloud-devkit install --target atomcode
```

**Restart the AtomCode session** after installation.

```bash
npx --yes huaweicloud-devkit doctor --target atomcode
npx --yes huaweicloud-devkit status --target atomcode
npx --yes huaweicloud-devkit update --target atomcode
npx --yes huaweicloud-devkit uninstall --target atomcode
```

### Other Agents

Any agent that supports MCP can use the standard config:

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

No installation required — `npx` handles everything.

> Set `HW_ACCESS_KEY`/`HW_SECRET_KEY` in the MCP config `env` field for project-level credentials.

### Install KooCLI

```bash
npx --yes huaweicloud-devkit install-hcloud
```

### Configure Credentials

```bash
npx --yes huaweicloud-devkit auth init
```

Synchronizes AK/SK to KooCLI, OBS, and sandbox APIs in one step.

### Install All Agents

```bash
npx --yes huaweicloud-devkit install --target all
```

### Update All Agents

```bash
npx --yes huaweicloud-devkit update --target all
```

`update` is incremental — it refreshes installed files without touching your config.

## What It Does

- **Guided cloud operations** — agents get step-by-step guidance for 20+ Huawei Cloud services (ECS, OBS, VPC, RDS, GaussDB, FunctionGraph, APIG, CCE, and more)
- **Safety-first execution** — all write operations require explicit user approval; credentials and secrets are automatically redacted from output
- **Pre-execution risk checks** — public exposure, credential leaks, and destructive operations are caught before they run
- **Regional awareness** — auto-discovers available regions and checks service availability before creating resources
- **Sandbox (DevStation)** — temporary cloud runtime for web app deployment with instant public URL preview

## Supported Services

ECS, OBS, VPC, IAM, RDS, GaussDB, FunctionGraph, APIG, CCE, SMN/DMS, ModelArts, Cloud Eye, CTS, DEW, Billing, CBR, WAF/AAD, DDS/DCS, Deployment, and Getting Started guides.

## Documentation

- [Architecture](docs/architecture.md)
- [Safety Model](docs/safety-model.md)
- [Hook Rule Model](docs/hook-rule-model.md)
- [DeepSeek Harness Integration](docs/dsh-integration.md)
- [Changelog](docs/CHANGELOG.md)
- [KooCLI official docs](https://support.huaweicloud.com/qs-hcli/hcli_02_003.html)

## Contributors

<a href="https://github.com/huaweicloud/huaweicloud-devkit/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=huaweicloud/huaweicloud-devkit" />
</a>

## License

This project is licensed under the Apache-2.0 License. See [LICENSE](LICENSE).
