---
name: huaweicloud-cli-and-auth
description: Safe Huawei Cloud KooCLI usage and authentication guidance. Use when working with hcloud, KooCLI, profiles, AK/SK, regions, projects, endpoints, CLI output, credential errors, or local Huawei Cloud account context.
---

# Huawei Cloud CLI And Auth

**STOP - Do not answer from general knowledge.** Follow the procedure below.

Use KooCLI `hcloud` for local inspection and reviewed operations. Never ask the user to paste AK/SK, SK, tokens, passwords, or credential files into chat.

## Install KooCLI

Official guide: `https://support.huaweicloud.com/qs-hcli/hcli_02_003.html`.

> **Version pairing**: this plugin is paired with **KooCLI v7.2.12** (`kooCliVersion` in `package.json`). Prefer the pinned download below. The one-liner script `hcloud_install.sh` always installs the `latest` version and cannot be pinned — if you use it, `check_cli`/`doctor` will warn when the installed version does not match v7.2.12.

### Windows

1. Download and unzip: `https://cn-north-4-hdn-koocli.obs.cn-north-4.myhuaweicloud.com/cli/7.2.12/huaweicloud-cli-windows-amd64.zip`
2. Extract to `%USERPROFILE%\hcloud`, add to user `PATH`
3. Verify: `hcloud version`

### Linux (amd64 / arm64)

Fixed download (recommended):

```bash
# amd64
curl -LO "https://cn-north-4-hdn-koocli.obs.cn-north-4.myhuaweicloud.com/cli/7.2.12/huaweicloud-cli-linux-amd64.tar.gz"
tar -zxvf huaweicloud-cli-linux-amd64.tar.gz
# arm64
curl -LO "https://cn-north-4-hdn-koocli.obs.cn-north-4.myhuaweicloud.com/cli/7.2.12/huaweicloud-cli-linux-arm64.tar.gz"
tar -zxvf huaweicloud-cli-linux-arm64.tar.gz
```

Move to PATH: `mv $(pwd)/hcloud ~/.local/bin/`
Verify: `hcloud version`

One-liner (installs `latest`, may drift from v7.2.12):

```bash
curl -sSL https://cn-north-4-hdn-koocli.obs.cn-north-4.myhuaweicloud.com/cli/latest/hcloud_install.sh -o ./hcloud_install.sh && bash ./hcloud_install.sh -y
```

### macOS (amd64 / arm64)

Fixed download (recommended):

```bash
# amd64
curl -LO "https://cn-north-4-hdn-koocli.obs.cn-north-4.myhuaweicloud.com/cli/7.2.12/huaweicloud-cli-mac-amd64.tar.gz"
tar -zxvf huaweicloud-cli-mac-amd64.tar.gz
# arm64 (Apple Silicon)
curl -LO "https://cn-north-4-hdn-koocli.obs.cn-north-4.myhuaweicloud.com/cli/7.2.12/huaweicloud-cli-mac-arm64.tar.gz"
tar -zxvf huaweicloud-cli-mac-arm64.tar.gz
```

Move to PATH: `mv $(pwd)/hcloud /usr/local/bin/`
Verify: `hcloud version`

One-liner (installs `latest`, may drift from v7.2.12):

```bash
curl -sSL https://cn-north-4-hdn-koocli.obs.cn-north-4.myhuaweicloud.com/cli/latest/hcloud_install.sh -o ./hcloud_install.sh && bash ./hcloud_install.sh -y
```

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

## Language / Service Catalog Trap

- KooCLI loads the service list from a per-language catalog: `~/.hcloud/metaRepo/services_{cn,en}.json`. The **English catalog is incomplete** (149 services vs 220 in Chinese; ~70 services — BSS, DevStar, CloudTable, FRS, ASM, ... — are missing). A command against a service that only exists in the Chinese catalog fails with a misleading `Unsupported service: X`.
- `huaweicloud-devkit` auto-injects `--cli-lang=cn` (proactive when the catalog shows `X ∈ cn ∧ X ∉ en`, reactive once if `Unsupported service` still appears) for read and write commands; approved write commands keep their approved argument list (injection happens inside the runner).
- Manual fallback (do not rely on the auto path alone): append `--cli-lang=cn` to the failing command, or set globally with `hcloud configure set --cli-lang=cn` (this changes ALL CLI output language).
- Distinguish from **region** metadata limits (e.g., BSS only supports `cn-north-1`): a region error is NOT solved by switching language.

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

| Priority | Source                                          | When active                                                                                | Persistence                 |
| -------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------ | --------------------------- |
| 1        | Runtime (session) credentials                   | `huaweicloud_auth_init` / `huaweicloud_auth_switch action=temporary` set them              | Memory (MCP restart clears) |
| 2        | S1 global file with `configuredBySession: true` | set by `huaweicloud_auth_switch action=persist` (session-configured account wins over env) | Permanent (S1)              |
| 3        | Environment variables                           | `HW_ACCESS_KEY` / `HW_SECRET_KEY` (platform/devspace-injected default account)             | MCP process lifetime        |
| 4        | CodeArts / CodeArts Work                        | `.codeartsdoer/mcp/mcp_settings.json` / `.codeartswork/mcp/mcp_settings.json`              | File                        |
| 5        | S1 global file (no session flag)                | `auth init` permanent credentials                                                          | Permanent (S1)              |
| 6        | KooCLI profile                                  | `~/.hcloud/config.json` (KooCLI commands only)                                             | Permanent                   |

When switching accounts within the same Agent session, use `huaweicloud_auth_init` to set runtime credentials (overrides all sources for the current MCP process), or `huaweicloud_auth_switch action=persist`, which writes S1 with `configuredBySession: true` so the session-configured account outranks `HW_ACCESS_KEY` / `HW_SECRET_KEY`. Note: running `auth init` clears the configuredBySession flag.

## Global Services & domain-id

KooCLI resolves the account/domain-id automatically from a valid AK/SK, so global services (BSS, IAM, CDN) normally do **not** need an explicit `--cli-domain-id`.

If a command fails with `[USE_ERROR]...缺少必填参数 cli-domain-id`, the real cause is almost always **invalid or expired credentials** (`APIGW.0301 Incorrect IAM authentication information`): KooCLI's internal account-id lookup failed and it misreports that as a missing domain-id. Fix the credentials instead (`npx huaweicloud-devkit auth init`).

Some IAM operations take a genuine business parameter for the account-id (e.g. `--domain_id`, `--agency.domain_id`, `--agency.trust_domain_id`, `--agency_urn`). Discover those with `--help`; get the account-id value with:

```bash
hcloud STS GetCallerIdentity --cli-region=<region>   # account_id = the account/domain-id
```

- `<region>` is the profile's current region. STS is not deployed in `cn-north-1` — use another region if needed.
- Temporary credentials (AK/SK + security token) work too: add `--cli-security-token=<token>`.

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
