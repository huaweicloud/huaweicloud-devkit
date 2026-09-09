# HuaweiCloud DevKit

[![Discussions](https://img.shields.io/badge/Discussions-Join%20the%20discussion-blue)](https://github.com/huaweicloud/huaweicloud-devkit/discussions)
[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![CI](https://github.com/huaweicloud/huaweicloud-devkit/actions/workflows/ci.yml/badge.svg)](https://github.com/huaweicloud/huaweicloud-devkit/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/huaweicloud-devkit)](https://www.npmjs.com/package/huaweicloud-devkit)
[![Beta](https://img.shields.io/badge/beta-v1.1.3-orange)](https://github.com/huaweicloud/huaweicloud-devkit)

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
>
> **Mirror lag**: npm mirrors (npmmirror, mirrors.huaweicloud.com) may lag behind the official registry for hours after a new release. If install fails with `ETARGET` or you get an older version, install via the official registry instead:
>
> ```bash
> npx --yes --registry=https://registry.npmjs.org huaweicloud-devkit install --target <target>
> ```

## Quick Start

> If `--target` is omitted, the installer auto-detects agents on your machine:
>
> - **None detected**: interactive terminals ask what you want (install to one
>   explicit target / install to all / wire up a generic MCP agent);
>   non-interactive shells error out with the supported target list.
> - **One detected**: installs directly to it.
> - **Multiple detected**: interactive terminals show a multi-select chooser;
>   non-interactive shells error and point at `--target <agent>` / `--target all`.
>   For a one-shot full setup, run `npx --yes huaweicloud-devkit install --target all`
>   (Codex is skipped when its CLI is missing).

The commands below are global (they act on every agent):

```bash
npx --yes huaweicloud-devkit version  # print CLI version and installed plugin versions per agent
npx --yes huaweicloud-devkit uninstall --target all --clean-global  # also remove KooCLI + OBS config
```

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
rm -rf ~/.npm/_npx/  # Linux/macOS; Windows: rmdir /s /q %LOCALAPPDATA%\npm-cache\_npx
```

### Codex

```bash
npx --yes huaweicloud-devkit install --target codex
```

**Restart the Codex session** after installation.

```bash
codex plugin list  # verify huaweicloud-devkit@huaweicloud-devkit is installed and enabled
npx --yes huaweicloud-devkit doctor --target codex
npx --yes huaweicloud-devkit status --target codex
npx --yes huaweicloud-devkit update --target codex
npx --yes huaweicloud-devkit uninstall --target codex
```

Then mention `@huaweicloud-devkit` in Codex or describe your Huawei Cloud task directly.

> **Requires Codex CLI** — the `codex` command must be in PATH. If Codex is installed via WindowsApps (Microsoft Store), use `--target codex-desktop` instead. Run `codex --version` to verify CLI availability.

### Codex Desktop

Use this target when the Codex CLI is unavailable or when Codex is installed through WindowsApps on Windows.

```bash
npx --yes huaweicloud-devkit install --target codex-desktop
```

**Restart the Codex Desktop session** after installation.

```bash
npx --yes huaweicloud-devkit doctor --target codex-desktop
npx --yes huaweicloud-devkit status --target codex-desktop
npx --yes huaweicloud-devkit update --target codex-desktop
npx --yes huaweicloud-devkit uninstall --target codex-desktop
```

Then mention `@huaweicloud-devkit` in a new Codex Desktop task or describe your Huawei Cloud task directly.

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
rm -rf ~/.npm/_npx/  # Linux/macOS; Windows: rmdir /s /q %LOCALAPPDATA%\npm-cache\_npx
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

> For manual MCP registrations like this, do not put credentials in the config. `HW_ACCESS_KEY`/`HW_SECRET_KEY` are reserved for **platform/CI-injected** accounts (e.g. a DevSpace-managed default account) — configure your own account via `npx huaweicloud-devkit auth init` (the single entry point), and switch accounts at runtime with the `huaweicloud_auth_init` / `huaweicloud_auth_switch` MCP tools. See `plugins/huaweicloud-core/skills/huaweicloud-cli-and-auth/SKILL.md` for the full credential-resolution priority.

#### Connecting over Remote (HTTP)

If your agent supports `type: "remote"` (Streamable HTTP) instead of stdio, start the devkit remote MCP server locally first:

```bash
npx --yes huaweicloud-devkit-mcp --transport remote
```

It listens on `127.0.0.1:9528` by default. Then connect with a remote config (opencode example):

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

> Use `--port <port>` if 9528 is taken and update `url` accordingly; add `--host 0.0.0.0` for LAN access. The remote server has no built-in auth — do not expose it anonymously to the public internet.

### Install KooCLI

```bash
npx --yes huaweicloud-devkit install-hcloud
```

### Configure Credentials

```bash
npx --yes huaweicloud-devkit auth init
```

Synchronizes AK/SK to KooCLI, OBS, and sandbox APIs in one step — this is the **single entry point**. Never hard-code AK/SK into agent or shell config.

**Account switching at runtime** (within an agent session): use the MCP tools `huaweicloud_auth_init` (in-memory, highest priority) or `huaweicloud_auth_switch` (actions: `temporary` / `persist` / `clear`). In sandbox/DevSpace environments where a default account is injected via `HW_ACCESS_KEY`/`HW_SECRET_KEY`, a plain `auth init` will not override it — use `huaweicloud_auth_switch action=persist` to make the session account win.

**Credential resolution priority** (highest first):

| #   | Source                                                  | Set by                                                                        |
| --- | ------------------------------------------------------- | ----------------------------------------------------------------------------- |
| 1   | Runtime (session) credentials                           | `huaweicloud_auth_init` / `huaweicloud_auth_switch action=temporary`          |
| 2   | S1 global file with `configuredBySession: true`         | `huaweicloud_auth_switch action=persist`                                      |
| 3   | Environment variables (`HW_ACCESS_KEY`/`HW_SECRET_KEY`) | platform/DevSpace-injected default account                                    |
| 4   | CodeArts / CodeArts Work                                | `.codeartsdoer/mcp/mcp_settings.json` / `.codeartswork/mcp/mcp_settings.json` |
| 5   | S1 global file (no session flag)                        | `auth init`                                                                   |
| 6   | KooCLI profile                                          | `~/.hcloud/config.json` (KooCLI commands only)                                |

> **Security**: never put your own AK/SK into the MCP config `env` field — they'd be stored in plaintext and could leak if the config file is committed to git. `env` is for platform/CI injection only.

Full details: `plugins/huaweicloud-core/skills/huaweicloud-cli-and-auth/SKILL.md`.

### Install All Agents

```bash
npx --yes huaweicloud-devkit install --target all
```

### Update All Agents

```bash
npx --yes huaweicloud-devkit@latest version
npx --yes huaweicloud-devkit@latest update --target all
```

`update` is incremental — it refreshes installed files without touching your
config. Always keep `@latest` so npm fetches the newest version instead of a
locally cached older one.

## What It Does

- **Guided cloud operations** — agents get step-by-step guidance for 20+ commonly used Huawei Cloud services (ECS, OBS, VPC, RDS, GaussDB, FunctionGraph, APIG, CCE, and more)
- **Safety-first execution** — all write operations require explicit user approval; credentials and secrets are automatically redacted from output
- **Pre-execution risk checks** — public exposure, credential leaks, and destructive operations are caught before they run
- **Regional awareness** — auto-discovers available regions and checks service availability before creating resources
- **Sandbox (DevStation)** — temporary cloud runtime for web app deployment with instant public URL preview

## Supported Services

ECS, OBS, VPC, IAM, RDS, GaussDB, FunctionGraph, APIG, CCE, SMN/DMS, ModelArts, Cloud Eye, CTS, DEW, Billing, CBR, WAF/AAD, DDS/DCS, Deployment, and Getting Started guides.

> Above is the pre-wired guidance list; the remaining 200+ Huawei Cloud services
> are still reachable via KooCLI / API / SDK routing (see capability-discovery
> and cli-and-auth meta-skills).

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
