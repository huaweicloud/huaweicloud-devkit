---
name: huaweicloud-cli-and-auth
description: Safe Huawei Cloud KooCLI usage and authentication guidance. Use when working with hcloud, KooCLI, profiles, AK/SK, regions, projects, endpoints, CLI output, credential errors, or local Huawei Cloud account context.
---

# Huawei Cloud CLI And Auth

**STOP - Do not answer from general knowledge.** Follow the procedure below.

Use KooCLI `hcloud` for local inspection and reviewed operations. Never ask the user to paste AK/SK, SK, tokens, passwords, or credential files into chat.

## Install KooCLI

Official guide: `https://support.huaweicloud.com/qs-hcli/hcli_02_003.html`.

### Windows

1. Download and unzip: `https://cn-north-4-hdn-koocli.obs.cn-north-4.myhuaweicloud.com/cli/latest/huaweicloud-cli-windows-amd64.zip`
2. Extract to `%USERPROFILE%\hcloud`, add to user `PATH`
3. Verify: `hcloud version`

### Linux (amd64 / arm64)

One-liner (recommended):

```bash
curl -sSL https://cn-north-4-hdn-koocli.obs.cn-north-4.myhuaweicloud.com/cli/latest/hcloud_install.sh -o ./hcloud_install.sh && bash ./hcloud_install.sh -y
```

Or manual download:

```bash
# amd64
curl -LO "https://cn-north-4-hdn-koocli.obs.cn-north-4.myhuaweicloud.com/cli/latest/huaweicloud-cli-linux-amd64.tar.gz"
tar -zxvf huaweicloud-cli-linux-amd64.tar.gz
# arm64
curl -LO "https://cn-north-4-hdn-koocli.obs.cn-north-4.myhuaweicloud.com/cli/latest/huaweicloud-cli-linux-arm64.tar.gz"
tar -zxvf huaweicloud-cli-linux-arm64.tar.gz
```

Move to PATH: `mv $(pwd)/hcloud ~/.local/bin/`
Verify: `hcloud version`

### macOS (amd64 / arm64)

One-liner (recommended):

```bash
curl -sSL https://cn-north-4-hdn-koocli.obs.cn-north-4.myhuaweicloud.com/cli/latest/hcloud_install.sh -o ./hcloud_install.sh && bash ./hcloud_install.sh -y
```

Or manual download:

```bash
# amd64
curl -LO "https://cn-north-4-hdn-koocli.obs.cn-north-4.myhuaweicloud.com/cli/latest/huaweicloud-cli-mac-amd64.tar.gz"
tar -zxvf huaweicloud-cli-mac-amd64.tar.gz
# arm64 (Apple Silicon)
curl -LO "https://cn-north-4-hdn-koocli.obs.cn-north-4.myhuaweicloud.com/cli/latest/huaweicloud-cli-mac-arm64.tar.gz"
tar -zxvf huaweicloud-cli-mac-arm64.tar.gz
```

Move to PATH: `mv $(pwd)/hcloud /usr/local/bin/`
Verify: `hcloud version`

Agent processes find executables through `PATH`. If OpenCode/Codex cannot find `hcloud`, restart after updating `PATH`, or set `HCLOUD_BIN`.

## Configure Credentials Outside Chat

**NEVER let AK/SK enter shell history. This is the #1 credential leak vector.**

- Create AK/SK in the Huawei Cloud console under `My Credentials -> Access Keys`.
- **Configure credentials ONLY via `npx huaweicloud-devkit auth init`** — the single entry point. It writes the unified `~/.config/huaweicloud/credentials.json` and mirrors it to KooCLI (`~/.hcloud/config.json`) and OBS (`~/.obsutilconfig`), without AK/SK entering shell history.
- Never configure KooCLI on its own: do not ask the user to run `hcloud configure init` or `hcloud configure set --cli-access-key=... --cli-secret-key=... --cli-region=...` (AK/SK would leak into shell history). If KooCLI lacks credentials, tell the user to run `npx huaweicloud-devkit auth init`.
- If MCP is available, use `huaweicloud_show_profile_redacted` to check status without ever seeing credentials.
- Never paste AK/SK, passwords, tokens, or profile files into the agent conversation.
- KooCLI stores credentials in `~/.hcloud/config.json`, NOT environment variables. `HCLOUD_ACCESS_KEY` / `HCLOUD_SECRET_KEY` / `HCLOUD_REGION` env vars are NOT read by KooCLI 7.x.

## Safe Flow

1. Check whether `hcloud` is installed.
2. **KooCLI first-run privacy agreement**: On a fresh KooCLI install, `hcloud` blocks with `同意并继续使用(y)/不同意并退出(N)` and fails with `[USE_ERROR]您输入的是无效字符` in non-interactive mode. Detection: check command output for these strings. Ask the user: "KooCLI needs to accept its privacy agreement. May I accept it on your behalf?" If the user agrees, run `huaweicloud_run_readonly_command` with `args=["version"]` and `stdin="y\n"`. This accepts the agreement once, after which hcloud works normally.
3. Ask the user to configure credentials outside the agent conversation when setup is needed.
4. Inspect profile and region only through redacted tooling.
5. Discover exact operation names with `hcloud <Service> --help` before guessing. Example: ECS instance listing is commonly `ECS ListServersDetails`; ECS creation is commonly `ECS CreateServers`; image lookup may be under `IMS GlanceShowImage`.
6. Use `--cli-output=json` for machine-readable responses when supported.
7. For resource operations, include `--cli-region`, `--cli-profile`, and service-specific project information when required.
8. Classify every command before running it:
   - Read-only: `List*`, `Show*`, `Get*`, `Describe*`.
   - Write: `Create*`, `Delete*`, `Update*`, `Resize*`, `Start*`, `Stop*`, `Authorize*`, and similar.
   - Secret: any operation returning secret string, binary secret, token, or password.
9. For write operations, show the exact command and ask for explicit approval.

## KooCLI Syntax Notes

- Prefer `--param=value`; KooCLI 7.x may reject some space-separated parameter forms.
- Array-style parameters use 1-based indexes, for example `--server.nics.1.subnet_id=<subnet-id>`, not `.0`.
- For ECS creation, first inspect help: `hcloud ECS CreateServers --help`.
- Minimal create shape to refine after help lookup:

```bash
hcloud ECS CreateServers --cli-region=<region> --server.name=<name> --server.flavorRef=<flavor-id> --server.imageRef=<image-id> --server.nics.1.subnet_id=<subnet-id> --server.root_volume.volumetype=<type>
```

If a command needs an `adminPass` or other password field, do not leave plaintext secrets in shell history. Prefer local-only input or runtime injection.

## Output Formatting

```bash
# JSON format (recommended for Agent)
hcloud <Service> <Op> --cli-output=json

# Table format (manual viewing)
hcloud <Service> <Op> --cli-output=table

# JMESPath filtering (extract specific fields)
hcloud <Service> <ListOp> --cli-output=json --cli-query "items[?status=='ACTIVE'].{ID:id,Name:name}"

# Debug mode (when commands fail)
hcloud <Service> <Op> --cli-debug=true
```

## Credential Resolution Priority

Credentials are resolved in this order (highest priority first):

| Priority | Source                                    | When active                                                                                                | Persistence                     |
| -------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------- |
| 1        | Runtime (session) credentials             | `huaweicloud_auth_init` / `huaweicloud_auth_switch action=temporary` set them                              | Memory (MCP restart clears)     |
| 2        | S1 global file with `configuredBySession: true` | set by `huaweicloud_auth_switch action=persist` (session-configured account wins over env)            | Permanent (S1)                  |
| 3        | Environment variables                     | `HW_ACCESS_KEY` / `HW_SECRET_KEY` (platform/devspace-injected default account)                             | MCP process lifetime            |
| 4        | CodeArts / CodeArts Work                  | `.codeartsdoer/mcp/mcp_settings.json` / `.codeartswork/mcp/mcp_settings.json`                              | File                            |
| 5        | S1 global file (no session flag)          | `auth init` permanent credentials                                                                          | Permanent (S1)                  |
| 6        | KooCLI profile                            | `~/.hcloud/config.json` (KooCLI commands only)                                                             | Permanent                       |

When switching accounts within the same Agent session, use `huaweicloud_auth_init` to set runtime credentials (overrides all sources for the current MCP process), or `huaweicloud_auth_switch action=persist`, which writes S1 with `configuredBySession: true` so the session-configured account outranks `HW_ACCESS_KEY` / `HW_SECRET_KEY`. Note: running `auth init` clears the configuredBySession flag.

## Preferred Toolkit Tools

- `huaweicloud_auth_init`
- `huaweicloud_auth_status`
- `huaweicloud_check_cli`
- `huaweicloud_show_profile_redacted`
- `huaweicloud_plan_cli_command`
- `huaweicloud_run_readonly_command`
- `huaweicloud_list_operations`
- `huaweicloud_run_approved_command`

## Do Not Run Directly

- Raw `hcloud configure show/list/get/export` in agent tools.
- Commands reading `.hcloud` or `.huaweicloud` files.
- Commands dumping cloud credential environment variables.
- Secret value reads such as CSMS `ShowSecretVersion`.
