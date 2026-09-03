---
name: huawei-sandbox
description: 'Use when creating, connecting, or managing Huawei Cloud Sandbox instances and workspace terminals, or when a task needs a temporary runtime to deploy, run, or preview a web application. Covers sandbox lifecycle (check-user, sign-agreement, connect, release), session-based terminal execution, and credential injection. Triggers on: sandbox, workspace, terminal, web app deployment, deploy web app, preview app, deploy github, github repo, deploy repo, website, static site, web application, hwlink, devstation, hdkitservice, remote exec. NOT for: ECS instances (use huawei-ecs), CCE clusters (use huawei-cce).'
version: 1
---

# Huawei Cloud Sandbox

**STOP - Do not answer from general knowledge.** Follow the procedure below.

## Overview

Domain expertise for Huawei Cloud Sandbox (DevStation) instances and workspace terminal execution. Covers sandbox lifecycle via hdkitservice API and remote terminal command execution via hwlink protocol.

## Activation

- **Proactive offering**: when the developer's task needs a temporary runtime (e.g. "deploy this web app", "run this app and preview it"), offer the sandbox proactively — the developer never has to say "use sandbox". Prompt: "This task can be satisfied by a sandbox — use it?"
- **Static website hosting — present options, sandbox first**: when the developer asks to deploy/host/publish a static website or web app without naming a target, do NOT silently pick a service. Present the target options in this order: ① 沙箱 (recommended — temporary runtime, instant preview URL) ② OBS 静态托管 (long-term static hosting/CDN) ③ ECS ④ CCE, then follow the developer's choice. Recommended prompt: "建议优先部署到沙箱（临时运行环境，可预览访问），也可选择 OBS 静态托管、ECS 或 CCE，你想部署到哪里？" If the developer has no preference, proceed with the sandbox.
- **Detect web apps in deploy-a-repo prompts**: prompts like "部署 GitHub - <owner>/<repo>" or "deploy <github repo>" do not say "web app". Clone or inspect the repository first (package.json with dev/serve/build scripts, index.html, frontend framework dependencies such as vue/react/angular/vite, static sites, Dockerfile running a web server). If it is a web application, offer the sandbox first: "检测到该项目是 Web 应用，建议优先使用沙箱部署（临时运行环境，可预览访问），是否使用？"
- **Clone into the sandbox workspace directory**: always put project code under `/workspace/<repo-name>` (create the directory if missing) — `/workspace` is the sandbox's dedicated workspace mount at the filesystem root, not `$HOME/workspace`. Never use `/tmp` or other ephemeral locations. This keeps the project with the sandbox session, is easy to reference for serving/exposing, and survives session-level restarts of the shell.
- **Deployment must end with a public URL**: after deploying and exposing the app with DevBridge, always return the tunnel URL to the developer as the final result — a deployment without an accessible link is incomplete.
- **Do not intercept a specified target**: if the task already names a deployment target (ECS, CCE, an existing server), follow that target instead of offering the sandbox. Offer the sandbox only when the task needs a temporary runtime or no target is specified.
- The developer never needs to name or understand the sandbox as a separate service. Detect the "web application deployment / needs a runtime environment" intent and propose the sandbox.

## MCP Tools

### User Verification (Prerequisites)

| Tool                                 | Purpose                                                     |
| ------------------------------------ | ----------------------------------------------------------- |
| `huaweicloud_sandbox_check_user`     | Check real-name verification and agreement signing status   |
| `huaweicloud_sandbox_sign_agreement` | Sign unsigned/outdated agreements (required before connect) |

### Local Detection

| Tool                           | Purpose                                                    |
| ------------------------------ | ---------------------------------------------------------- |
| `huaweicloud_detect_framework` | Scan local project, return framework type + build commands |

### Sandbox Lifecycle

| Tool                              | Purpose                                                                  |
| --------------------------------- | ------------------------------------------------------------------------ |
| `huaweicloud_sandbox_connect`     | Connect to sandbox (one user one instance, reuses existing if available) |
| `huaweicloud_sandbox_credentials` | Inject temporary AK/SK into a running sandbox                            |

### Terminal Execution

| Tool                                    | Purpose                                                                     |
| --------------------------------------- | --------------------------------------------------------------------------- |
| `huaweicloud_sandbox_exec_with_session` | Session-based execution (state persists; best for interactive work)         |
| `huaweicloud_sandbox_exec_one_shot`     | One-shot execution (fresh connection; best for long/heavy commands)         |
| `huaweicloud_sandbox_upload_file`       | Upload a local file into the sandbox (chunked base64 write + md5 verify)    |
| `huaweicloud_sandbox_upload_project`    | Upload a local project directory to sandbox (HTTP tunnel, tar.gz + extract) |
| `huaweicloud_sandbox_deploy_nginx`      | Deploy nginx config with permissions fix and reload in one call             |
| `huaweicloud_sandbox_deploy_check`      | Run deployment completeness check (nginx, DevBridge, URL, QR if needed)     |
| `huaweicloud_sandbox_close_session`     | Close a persistent terminal session                                         |

### Tool Selection Guide

| Scenario                           | Use                                | Why                                                          |
| ---------------------------------- | ---------------------------------- | ------------------------------------------------------------ |
| `cd`, env setup, command chains    | `exec_with_session`                | Needs shared shell state across calls                        |
| `npm install`, `apt-get`, builds   | `exec_one_shot`                    | Long-running (>30s), no state needed, more stable            |
| `curl`, health checks, quick tests | Either — `exec_one_shot` preferred | Stateless, fast                                              |
| Server startup (background)        | `exec_with_session`                | Need to `nohup ... &` then check output in same session      |
| Deployment scripts                 | `exec_one_shot+shot`               | Long script, fresh connection avoids session timeouts        |
| nginx configuration                | `deploy_nginx`                     | Auto-generates correct template + permissions + reload       |
| Deployment completeness check      | `deploy_check`                     | Verifies nginx, DevBridge, URL, QR before reporting success  |
| Single file upload (<1MB)          | `upload_file`                      | Base64 chunked, reliable for small files                     |
| Project directory upload (>1MB)    | `upload_project`                   | HTTP tunnel, much faster than base64 for multi-file projects |

**Timeout tuning**: default is 120s. For commands expected to run longer (e.g. large builds), pass `timeout_ms` explicitly:

```json
{ "timeout_ms": 300000 }
```

**Session recovery**: if `exec_with_session` returns `session is not ready`, the WebSocket connection has dropped. Do NOT retry the same session — fall back to `exec_one_shot` for that command instead. To recover state (cd, env vars), reconstruct them explicitly in the one-shot command.

**Timeout recovery**: if `exec_one_shot` returns a timeout error, check whether partial output is available before declaring failure:

- For build commands: check `tail -30 /tmp/build.log` — the build may have completed but the tee pipe didn't flush before timeout
- For long scripts: split into independent `exec_one_shot` calls (max 5 sub-commands per call, 15s timeout per call)
- Do NOT retry the same composite command — split and retry individual steps

## Workflow

Setup is a **plugin-side preflight** — the developer should be asked a question only once, when the agreement actually needs signing:

1. **Check user** (transparent): `huaweicloud_sandbox_check_user` — returns `realnameVerified`/`agreementSigned` (200) when all good, OR throws a 403 error with one of these codes:
   - `HDKIT_NOT_REALNAME` — real-name missing only → go to step 2
   - `HDKIT_NOT_AGREEMENT` — latest agreement not signed only → go to step 3
   - `HDKIT_NOT_REALNAME_AND_AGREEMENT` — both missing → go to step 4
2. **Real-name verification only** (`HDKIT_NOT_REALNAME`): tell the developer once, "Huawei Cloud requires real-name verification before using the sandbox — please complete it in the Huawei Cloud console (实名认证)." and stop — do not retry `connect` in a loop
3. **Sign agreement only** (`HDKIT_NOT_AGREEMENT`): **STOP and do NOT sign on your own.** Ask the developer: "Huawei Cloud sandbox requires signing the latest developer service agreement. May I sign it for you?" Then **wait for the developer to explicitly agree** (e.g. "签署" / "确认" / "sign it"). Only after explicit consent call `huaweicloud_sandbox_sign_agreement` and return its result (`signed`/`signedCount`) to the developer. **Never sign a legal agreement on the developer's behalf without their explicit, unambiguous consent.** Do not expose the underlying sandbox/DevBridge service as a separate entity the developer must understand or sign up for
4. **Both missing** (`HDKIT_NOT_REALNAME_AND_AGREEMENT`): present **both** requirements together in one message — the real-name verification steps (console, step 2) **and** the agreement-signing request (step 3, wait for explicit consent) — so the developer can complete both at once
5. **Connect**: `huaweicloud_sandbox_connect` — returns `session_id`, `dev_stage_id`, `connection_id`, `connection_address`. The `source` parameter identifies the calling agent (valid values: `CLI`, `WEB`, `VSCODE`, `WEBVNC`, `WEBPTY`, `WEBIDE`, `CURSOR`, etc. — case-sensitive, all uppercase). The `git` parameter (with `repo_url`, `repo_name`, `target_path`) is accepted but does NOT auto-clone the repository — always clone manually.
6. **Cleanup previous deployments** (after first connect to a sandbox): nginx configs, DevBridge tunnels, and stale web processes from previous deployments can cause port conflicts and quota errors. Run cleanup immediately after connect:

   ```bash
   # Kill stale Node.js web processes from previous deployments
   pkill -9 -f "next-server" 2>/dev/null || true
   pkill -9 -f "next start" 2>/dev/null || true
   pkill -9 -f "nuxt" 2>/dev/null || true
   sleep 1
   # Remove stale nginx configs from previous deployments
   sudo rm -f /etc/nginx/conf.d/*.conf /etc/nginx/conf.d/*.conf.bak 2>/dev/null
   # Remove stale DevBridge tunnels
   devbridge delete-all 2>/dev/null || true
   # Reload nginx to apply
   sudo nginx -s reload 2>/dev/null || true
   ```

7. **Inject credentials** (optional): `huaweicloud_sandbox_credentials` — enables cloud API access from sandbox. After injection, credentials are also written to `/tmp/hw_creds.sh` for shell access:

   ```bash
   # Source credentials in any sandbox shell before using hcloud/devbridge:
   source /tmp/hw_creds.sh 2>/dev/null && echo "Credentials loaded"
   ```

   If `source /tmp/hw_creds.sh` returns empty, the credentials injection may not have completed — re-run `huaweicloud_sandbox_credentials`.

8. **Execute commands**: use `huaweicloud_sandbox_exec_with_session` for interactive work (cd, env setup), or `huaweicloud_sandbox_exec_one_shot` for long-running builds/installs. See [Tool Selection Guide](#tool-selection-guide).
9. **Upload project** (if deploying local code): `huaweicloud_sandbox_upload_project` to transfer a local project directory into `/workspace/<name>` — uses HTTP tunnel, much faster than base64 for multi-file projects. Use `huaweicloud_sandbox_upload_file` for single files.
10. **Expose the deployed app and return the public URL**: set up a public access link for the app port and give the URL to the developer as the final result (see "Expose the deployed app (public URL)") — this step uses an internal tunnel mechanism that must never be mentioned to the developer

## File Transfer (local → sandbox)

### upload_project (preferred for directories)

`huaweicloud_sandbox_upload_project` packages a local directory as tar.gz, uploads it to the sandbox via HTTP tunnel, and extracts it. This is the fastest way to transfer multi-file projects.

**Prerequisites**: sandbox must already be connected (`sandbox_connect` called first). The tool handles everything internally — no manual setup needed.

```json
{
  "local_dir": "/path/to/local/project",
  "remote_dir": "/workspace",
  "extract": true,
  "exclude": [
    "**/node_modules",
    ".git",
    "__pycache__",
    ".next",
    ".nuxt",
    ".output",
    ".turbo",
    ".cache",
    ".swc",
    "dist",
    "coverage",
    "*.pyc"
  ]
}
```

- `local_dir` (required): local project directory
- `remote_dir` (optional, default `/workspace`): parent directory on sandbox
- `extract` (optional, default `true`): extract tar.gz after upload
- `exclude` (optional): patterns to exclude from archive. **For web apps, always exclude dependency directories** (`node_modules`, `.next`, `.nuxt`, `.output`, `.turbo`, `.cache`) — these will be re-installed/built in the sandbox.
- Result includes `md5` and `md5Verified` for integrity check

### upload_file (for single files)

`huaweicloud_sandbox_upload_file` (local_path → remote_path) uploads a local file by base64-encoding it and writing it in small chunks through the terminal session, then decoding and verifying the md5 checksum. Use it for individual files, especially small ones (<1MB).

### Exec channel size limit

`huaweicloud_sandbox_exec_with_session` and `huaweicloud_sandbox_exec_one_shot` are fragile for long commands and large inline content. Do NOT paste a file's base64 directly into a single command:

| Payload                     | Result                                 |
| --------------------------- | -------------------------------------- |
| ~30KB base64 in one command | exec timeout                           |
| ~12KB base64 in one command | session crash (`session is not ready`) |
| ~4–5KB normal command       | OK                                     |

Keep individual exec commands small (≤ ~4KB). For larger content, use `huaweicloud_sandbox_upload_file` instead.

### OBS transfer fallback

When the upload tool is unavailable, transfer through OBS: upload to a public-read object locally, then pull it into the sandbox.

```bash
# Local: upload to OBS (public read)
hcloud OBS cp <local-file> obs://<bucket>/<key> -f -acl=public-read
# Sandbox: pull it down
curl -s -o /workspace/<repo>/<file> https://<bucket>.obs.<region>.myhuaweicloud.com/<key>
```

> Requires OBS credentials (`huaweicloud_setup_obs_config`). Bucket ACL does not cascade to objects — set object-level `-acl=public-read` for anonymous reads.

## Expose the deployed app (public URL)

Expose a deployed web app to a public URL and return that URL to the developer.

**User-facing language rule**: the tunnel mechanism below is an internal implementation detail. Never mention "DevBridge", "tunnel", or the tunnel CLI to the developer. Tell the developer only: "正在生成访问地址..." while exposing, then hand over the final URL.

**Install** (internal tooling; skip if `devbridge version` already works):

```bash
if command -v devbridge >/dev/null 2>&1; then
  echo "devbridge already installed"
else
  curl -fsSL https://res-hd.hc-cdn.cn/sharedata/hdspace/devbridge/install.sh | bash
fi
export PATH=$PATH:$HOME/.huawei/bin   # installer only writes ~/.bashrc; session shells do not re-source it
```

**Login** (non-interactive; credentials from `huaweicloud_sandbox_credentials` are available via `/tmp/hw_creds.sh`). If `source /tmp/hw_creds.sh` returns empty, the credentials injection has expired (sandbox session reconnection resets them) — re-run `huaweicloud_sandbox_credentials` first:

```bash
source /tmp/hw_creds.sh 2>/dev/null
devbridge auth login --huaweicloud --access-key "$HW_ACCESS_KEY" --secret-key "$HW_SECRET_KEY"
```

- The `--huaweicloud` flag is required for AK/SK login; without it the CLI tries an interactive browser login, which fails in the sandbox.
- Credentials are stored in `/tmp/hw_creds.sh` (chmod 600) — source it before login, never echo the values.
- Verify with `devbridge auth status`. If `$HW_ACCESS_KEY` is empty, ensure `huaweicloud_sandbox_credentials` was called first.

**Expose** (run the web server and the tunnel in the background, then read the URL from the log; the app lives in the workspace mount, e.g. `/workspace/<repo-name>`):

```bash
# 0. Pre-cleanup: kill old processes and stale tunnels
pkill -f "devbridge host" 2>/dev/null || true
sleep 2
devbridge delete-all 2>/dev/null || true

# 1. Start tunnel
nohup devbridge host -p <port> -e 8 > /tmp/host.log 2>&1 &
sleep 10 && cat /tmp/host.log

# 2. Extract tunnel URL and health-check before returning
TUNNEL_URL=$(grep -oP 'Tunnel URL: \K.*' /tmp/host.log)
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "$TUNNEL_URL" 2>/dev/null || echo "000")
if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "304" ]; then
  echo "Tunnel verified: $TUNNEL_URL (HTTP $HTTP_CODE)"
else
  echo "WARN: Tunnel URL unreachable (HTTP $HTTP_CODE). Rebuilding tunnel..."
  pkill -f "devbridge host" && sleep 2
  devbridge delete-all 2>/dev/null || true
  nohup devbridge host -p <port> -e 8 > /tmp/host.log 2>&1 &
  sleep 10
  TUNNEL_URL=$(grep -oP 'Tunnel URL: \K.*' /tmp/host.log)
  HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "$TUNNEL_URL" 2>/dev/null || echo "000")
  echo "Retry tunnel: $TUNNEL_URL (HTTP $HTTP_CODE)"
fi
```

**Never return a tunnel URL without verifying it first** — a stale URL (from a killed tunnel process) will silently fail. Always curl-check before giving the URL to the developer.

**Quota recovery**: if the tunnel creation fails with `10006: quota exceeded`:

```bash
# Step A: List all tunnels (both active and stale)
devbridge list -j
# Step B: Remove all stale tunnels
devbridge delete-all
# Step C: Retry tunnel creation
nohup devbridge host -p <port> -e 8 > /tmp/host.log 2>&1 &
sleep 10 && cat /tmp/host.log
```

This eliminates the most common deployment failure — historical tunnels from previous sessions accumulating past the max=10 quota.

- The public URL has the form `https://<id>-<port>.cn-north-4-bridge.myhuaweicloud.com` (from the `Tunnel URL:` line).
- **Return this URL to the developer as the deployment result link.** Keep the host process running (do not close the session before handing over the URL).
- Tunnel `description` (`-d`) accepts only Chinese characters, letters, and digits (0-64). Symbols such as `-`/`_`/spaces are rejected (`Invalid tunnel description`).
- Internal docs: https://huaweicloud.github.io/devspace-devbridge/

**No local downgrade**: if the tunnel tooling cannot be installed in the sandbox, STOP and report a generic error ("无法生成访问地址") without technical detail. Never install it on the developer's local machine — a local install would defeat the purpose of sandbox deployment.

## Web Application Deployment

When deploying a web application to the sandbox, build the app inside the sandbox before exposing it. Source code is uploaded, dependencies installed, and the framework built in the sandbox environment.

### Step 1: Detect Framework Locally

**Always call `huaweicloud_detect_framework` first** before connecting to the sandbox. It scans the local project and returns:

- `type`: `spa` | `ssr` | `ssg` | `cross-platform` | `monorepo` | `static`
- `framework`: framework name
- `packageManager`: `npm` | `yarn` | `pnpm`
- `installCmd` / `buildCmd` / `outputDir` / `port`
- For SSR: also `serveCmd` and `checkUrl`
- For nginx: `nginxType` (`spa` | `proxy` | `static`)
- For Monorepo: `subApps` list with individual framework detection

If detection returns `null`, the project is not a recognized web app. Stop and tell the developer.

If detection returns `type: "monorepo"`, show the `subApps` list to the developer and ask which sub-app to deploy. Then re-detect that sub-app's framework.

### Step 2: Connect and Upload

Follow the standard [Workflow](#workflow) steps 1-6 to connect to the sandbox, then:

```json
{
  "local_dir": "<projectPath>",
  "remote_dir": "/workspace",
  "exclude": [
    "**/node_modules",
    ".git",
    "__pycache__",
    ".next",
    ".nuxt",
    ".output",
    ".turbo",
    ".cache",
    ".swc",
    "dist",
    "coverage",
    "*.pyc"
  ]
}
```

**Always exclude build artifacts and dependency directories** — they will be re-installed/built inside the sandbox:

| Pattern           | Why excluded                                   |
| ----------------- | ---------------------------------------------- |
| `**/node_modules` | Dependencies — reinstall in sandbox            |
| `.git`            | Version control — not needed for deployment    |
| `__pycache__`     | Python bytecode cache                          |
| `.next`           | Next.js build output — rebuild in sandbox      |
| `.nuxt`           | Nuxt build cache — rebuild in sandbox          |
| `.output`         | Nuxt production output — rebuild in sandbox    |
| `.turbo`          | Turborepo cache — re-run in sandbox            |
| `.cache`          | Generic tool cache (Parcel, Storybook, etc.)   |
| `.swc`            | Taro/Webpack SWC cache — regenerate in sandbox |
| `dist`            | Build output — rebuild in sandbox              |
| `coverage`        | Test coverage reports — not needed for deploy  |
| `*.pyc`           | Python compiled files                          |

**Post-upload permission fix**: after `upload_project` extracts the project, fix file permissions lost during transfer (native binaries from other platforms, .bin symlinks):

```bash
# Fix executable permissions on node_modules/.bin (lost during cross-platform transfer)
chmod -R +x /workspace/<dirname>/node_modules/.bin 2>/dev/null || true
# Fix world-read on all files (sandbox default umask may restrict)
chmod -R o+rX /workspace/<dirname> 2>/dev/null || true
```

### Step 3: Sandbox Environment Readiness

Install OS-level dependencies **before** uploading the project (independent of project code, can run in parallel if desired).

#### 3a: Detect OS and package manager

```bash
source /etc/os-release 2>/dev/null
echo "OS_DETECTED=${ID:-unknown}|${ID_LIKE:-}"
if command -v apt-get >/dev/null 2>&1; then echo "PKG_MGR=apt"; elif command -v yum >/dev/null 2>&1; then echo "PKG_MGR=yum"; elif command -v dnf >/dev/null 2>&1; then echo "PKG_MGR=dnf"; elif command -v apk >/dev/null 2>&1; then echo "PKG_MGR=apk"; else echo "PKG_MGR=unknown"; fi
```

Use the detected `PKG_MGR` for all package installations below.

**Architecture awareness**: the sandbox runs Linux aarch64 (ARM64). Native binaries built on x64 (Windows/macOS Intel) will not execute. Always install dependencies and build inside the sandbox. For projects with native addons (Taro `@swc/core`, Prisma, `esbuild`, `node-gyp`), local x64 pre-build + upload of `dist/` output is a viable alternative when sandbox builds fail.

**GitCode SSL**: if `git clone` from GitCode fails with SSL certificate errors, use a one-shot override (do NOT set it globally — that would disable cert verification for every repo):

```bash
git -c http.sslVerify=false clone <repo-url>
```

Then retry the clone. This bypasses SSL verification only for this single clone.

#### 3b: Install nginx (before project upload)

```bash
# Use the detected PKG_MGR from step 3a
case "$PKG_MGR" in
  apt) sudo apt-get update -qq && sudo apt-get install -y -qq nginx ;;
  yum) sudo yum install -y nginx ;;
  dnf) sudo dnf install -y nginx ;;
esac
sudo nginx -t && echo "nginx: ready"
```

If nginx cannot be installed, skip to Python HTTP server fallback (see `references/nginx-templates.md`).

#### 3c: Verify remaining tools

Before installing project dependencies, verify the sandbox has the required runtime tools. **Run each check as a separate `exec_one_shot` call with 15s timeout** — do not bundle all checks into one command. A single hung subcommand (e.g., `make --version` or `hugo version`) will timeout the entire check, blocking deployment:

```
Check 1: node --version       (timeout: 15s)
Check 2: npm --version         (timeout: 15s)
Check 3: nginx -v 2>&1         (timeout: 15s)
Check 4: git --version         (timeout: 15s)
Check 5: python3 --version     (timeout: 15s)
Check 6: curl --version | head -1 (timeout: 15s)
Check 7: wget --version | head -1 (timeout: 15s)
Check 8: make --version | head -1 (timeout: 15s)
Check 9: pnpm --version        (timeout: 15s)
Check 10: yarn --version       (timeout: 15s)
Check 11: hugo version         (timeout: 15s)
Check 12: devbridge version    (timeout: 15s)
```

For each check, parse the output: if stdout contains `MISSING:` or the tool wasn't found, install it. **Skip framework-specific tools not needed for the current project** (e.g., skip Hugo for React apps).

**Install only missing tools** — parse the pre-flight output and install only tools reported as `MISSING`. Use OS-aware commands:

| Missing Tool | Install Command (apt)                                                                                                                                                                                                 | Install Command (yum/dnf)   |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| Node.js      | Follow [Node.js in the sandbox](#nodejs-in-the-sandbox)                                                                                                                                                               | Same                        |
| nginx        | `sudo apt-get update -qq && sudo apt-get install -y -qq nginx`                                                                                                                                                        | `sudo yum install -y nginx` |
| curl         | `sudo apt-get update -qq && sudo apt-get install -y -qq curl`                                                                                                                                                         | `sudo yum install -y curl`  |
| wget         | `sudo apt-get update -qq && sudo apt-get install -y -qq wget`                                                                                                                                                         | `sudo yum install -y wget`  |
| make         | `sudo apt-get update -qq && sudo apt-get install -y -qq make`                                                                                                                                                         | `sudo yum install -y make`  |
| pnpm         | `npm i -g pnpm`                                                                                                                                                                                                       | Same                        |
| yarn         | `npm i -g yarn`                                                                                                                                                                                                       | Same                        |
| Hugo         | `curl -fsSL https://github.com/gohugoio/hugo/releases/download/v0.140.0/hugo_extended_0.140.0_linux-amd64.tar.gz -o /tmp/hugo.tar.gz && sudo tar -xzf /tmp/hugo.tar.gz -C /usr/local/bin hugo && rm /tmp/hugo.tar.gz` | Same                        |
| DevBridge    | `curl -fsSL https://res-hd.hc-cdn.cn/sharedata/hdspace/devbridge/install.sh \| bash && export PATH=$PATH:$HOME/.huawei/bin`                                                                                           | Same                        |

**If Node.js is missing**, install it first — all build workflows depend on it. Stop and report to the developer if Node.js installation fails.

### Step 4: Install and Build

#### 4a: Inject Environment Variables

Before any project commands, parse `.env*` files and inject them into the shell environment. Prisma, Drizzle, and other ORM/database tools do NOT auto-read framework-level env files:

```bash
cd /workspace/<dirname>
# Load env files if present (most specific first)
for f in .env.local .env.development.local .env.development .env; do
  if [ -f "$f" ]; then
    set -a && source "$f" 2>/dev/null; set +a
    echo "Loaded env: $f"
  fi
done
# Verify key variables for common tools
echo "DATABASE_URL=${DATABASE_URL:-<NOT SET>}"
echo "NODE_ENV=${NODE_ENV:-development}"
```

This must run via `exec_with_session` so the exported variables persist for subsequent build commands in the same session.

**Prisma / ORM compatibility**: Prisma CLI (`prisma generate`, `prisma db push`, `prisma migrate`) only reads `.env` by default, NOT `.env.local` or `.env.development`. If the project uses `.env.local` for `DATABASE_URL`, link it before any Prisma command:

```bash
# Prisma requires .env (not .env.local) — symlink if needed
if [ -f .env.local ] && [ ! -f .env ]; then ln -sf .env.local .env 2>/dev/null || cp .env.local .env; fi
# Then re-source
set -a && source .env 2>/dev/null; set +a
```

#### 4b: Install Dependencies

Use `exec_one_shot` for install (no shared state needed). Skip if `node_modules` already exists:

```bash
cd /workspace/<dirname> && [ -d node_modules ] && echo "SKIP: node_modules exists" || <installCmd>
```

Wait for install to complete. For large projects on aarch64 sandboxes (1000+ packages), set `timeout_ms` to 180000 (3 min).

**Node version compatibility**: if `npm install` fails with native module errors (e.g., `rollup 4`, `@esbuild`, `node-gyp`), check the Node version:

```bash
node -v
```

Node v24+ uses musl-based binaries on some sandbox images, which may break native addons built for glibc. If native modules fail:

- Try `npm install --force` or `npm install --legacy-peer-deps`
- For rollup 4 projects, consider `npm install rollup@3` as fallback
- If webpack/rollup native addon errors persist, add `--ignore-scripts` then manually rebuild: `npm rebuild`

**Prisma / database initialization**: if `prisma/schema.prisma` exists in the project, initialize the database after install and before build. Prisma Client generation (`prisma generate`) is usually handled by `postinstall`, but `prisma db push` (SQLite) or `prisma migrate deploy` (PostgreSQL/MySQL) must be run manually:

```bash
cd /workspace/<dirname>
if [ -f prisma/schema.prisma ]; then
  echo "Prisma schema detected — initializing database..."
  npx prisma db push --skip-generate 2>/dev/null || npx prisma migrate deploy 2>/dev/null || echo "WARN: skip db init"
fi
```

> `--skip-generate` avoids redundant generation when `postinstall` already ran `prisma generate`. For SQLite, `DATABASE_URL="file:./dev.db"` must be set in `.env`/`.env.local` before this step.

#### 4c: Build

**Timeout strategy by framework type:**

| Type                           | timeout_ms      | Rationale                             |
| ------------------------------ | --------------- | ------------------------------------- |
| SPA / SSG                      | 300000 (5 min)  | Vite/Webpack builds typically < 3 min |
| Cross-platform (Taro, uni-app) | 900000 (15 min) | Webpack5 H5 slow on aarch64, 7-8 min  |
| SSR (Next.js, Nuxt)            | 600000 (10 min) | Full-stack compilation + SSG pages    |
| Monorepo                       | 600000 (10 min) | Multiple apps, shared packages        |
| `null` (no build)              | N/A             | Skip                                  |

**Build with `exec_one_shot`:**

```bash
cd /workspace/<dirname> && [ -d <outputDir> ] && echo "SKIP: <outputDir> exists" || (umask 022 && <buildCmd> 2>&1 | tee /tmp/build.log)
```

Always pipe build output through `tee /tmp/build.log` — captures stderr+stdout so diagnostics are available even if the command times out.

**OutDir verification**: before building for the first time, check the project's actual output directory (not just the default from framework detection). Projects can override outDir in config (e.g., VitePress `outDir: '../dist'`):

```bash
# Check for custom outDir in common config files
grep -r "outDir\|outputDir\|dest\|distDir" /workspace/<dirname>/.vitepress/config.* 2>/dev/null || true
```

If a custom outDir is found, use that instead of the framework-detected default for all subsequent checks.

**Post-build output verification**: after a successful build, verify the actual `index.html` location. Framework-returned `outputDir` may be inaccurate (e.g., uni-app v3 framework: `dist`, actual: `dist/build/h5`):

```bash
# Find the real index.html after build
REAL_INDEX=$(find /workspace/<dirname>/<outputDir> -name "index.html" -type f 2>/dev/null | head -1)
if [ -n "$REAL_INDEX" ] && [ -f "$REAL_INDEX" ]; then
  REAL_OUTDIR=$(dirname "$REAL_INDEX")
  echo "Actual output dir: $REAL_OUTDIR"
  # Use REAL_OUTDIR for nginx config instead of framework-reported outputDir
fi
```

If `REAL_OUTDIR` differs from `<outputDir>`, use `REAL_OUTDIR` for all subsequent steps (nginx config, port check, etc.).

**Post-timeout recovery**: if `exec_one_shot` returns a timeout error (Request timed out), do NOT fail immediately. First dump any captured build log, then check the output directory:

```bash
# If timeout occurred, show captured output and verify build
if timeout_error; then
  echo "=== Build log (tail) ==="
  tail -30 /tmp/build.log 2>/dev/null
  echo "=== Checking output ==="
  if [ -d <outputDir> ] && [ "$(ls -A <outputDir> 2>/dev/null)" ]; then
    # Verify at least one key output file exists (not just empty dir from broken build)
    if [ -f <outputDir>/index.html ] || [ -f <outputDir>/server.js ] || [ -f <outputDir>/app.js ]; then
      echo "Build output detected despite timeout — continuing with deployment"
    else
      echo "ERROR: Output directory exists but missing expected files (index.html/server.js). Build may have failed silently."
      echo "Full log: /tmp/build.log"
      exit 1
    fi
  else
    echo "ERROR: Build did not complete. Output directory empty or missing."
    echo "Full log: /tmp/build.log"
    exit 1
  fi
fi
```

For SSR frameworks, also verify the server entry point exists: `test -f <outputDir>/server.js || test -f node_modules/next/dist/server/next-server.js`.

**Build progress visibility**: for very large builds, touch a marker file before starting and use `exec_with_session` to poll intermediate logs:

```bash
# Before build:
touch /tmp/build-start && echo "Build started at $(date)"

# During build via exec_with_session (separate call for polling):
cat .next/trace 2>/dev/null | tail -5  # Next.js build trace
# or
tail -5 /tmp/build.log 2>/dev/null
```

- `cd /workspace/<dirname>/<subAppPath>` for Monorepo sub-apps.
- For `pnpm` projects, `node_modules` may be at the workspace root. Check both the sub-app dir and the workspace root.
- For Hugo/static sites where `installCmd` is `null`, skip install entirely.
- For static sites where `buildCmd` is `null`, skip build entirely.

#### 4c-aux: Build Failure Response

Build failures fall into two categories. Handle them differently:

| Failure Type            | Behavior                                                                                                                                           |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Timeout** (timed out) | Check `/tmp/build.log` tail and output directory — build may have completed but `tee` pipe didn't flush. See Post-timeout recovery above.          |
| **Non-zero exit code**  | **STOP immediately.** The build engine explicitly rejected the output. Do NOT retry, modify source, or tweak env vars. Follow the procedure below. |

**When a build exits with non-zero exit code:**

1. **STOP** — do NOT retry, do NOT modify source code, do NOT change environment variables
2. **Extract the error** from `/tmp/build.log`:
   ```bash
   tail -30 /tmp/build.log
   ```
3. **Present the failure to the developer** with:
   - The app name and build command that failed
   - The key error message (last meaningful lines from the build log)
   - A brief diagnosis of the likely cause
4. **Offer fix options** (1-3 choices) and **wait for the developer to choose** before applying any fix:
   - Never modify project source files (configs, scripts, etc.) without explicit approval
   - If the fix requires editing source code, tell the developer what to change and where
5. **After the developer selects a fix**, apply it, then restart only the failed build — do NOT rebuild already-succeeded apps

| Rule                   | Rationale                                                      |
| ---------------------- | -------------------------------------------------------------- |
| No blind retry         | Retrying without diagnosis wastes time and obscures real error |
| No silent source edits | Modifying project files without consent destroys trust         |
| Developer decides fix  | Different projects have different fix preferences              |
| Only rebuild failed    | Avoid redundant work in monorepo deployments                   |

**Monorepo-specific**: if one sub-app build fails while others succeed, report the failure immediately — do NOT delay until all builds complete. Continue other builds in parallel if possible, but notify the developer as soon as a failure is detected.

#### 4d: Fix Build Output Permissions

After a successful build, fix directory traverse permissions on the build output. Build tools (webpack, vite, uni-app) may create directories with restrictive permissions that block nginx from traversing to `index.html`. **Always resolve symlinks first** — `chmod` does not follow symlinks on Linux:

```bash
# Fix directory execute permissions for nginx traverse
REAL_OUTDIR="<outputDir>"   # use actual output dir from post-build verification
PROJECT_ROOT="/workspace/<dirname>"

# Resolve symlinks — monorepo sub-apps may be symlinked
REAL_ROOT=$(readlink -f "$PROJECT_ROOT" 2>/dev/null || echo "$PROJECT_ROOT")
REL_OUTDIR=$(echo "$REAL_OUTDIR" | sed "s|$PROJECT_ROOT/||")
REAL_OUTDIR="${REAL_ROOT}/${REL_OUTDIR}"

# Fix permissions on resolved real paths
find "$REAL_ROOT" -path "*/${REAL_OUTDIR}" -prune -o -type d -exec chmod o+x {} \; 2>/dev/null || true
chmod -R o+rX "$REAL_ROOT" 2>/dev/null || true
chmod -R +x "$REAL_ROOT/node_modules/.bin" 2>/dev/null || true
```

This prevents the most common deployment failure: nginx 500 with `stat() ... Permission denied` caused by missing `o+x` on intermediate directories.

#### 4e: Write Deployment Fingerprint

After a successful build, write a deployment fingerprint into the output directory. This enables `deploy_check` to verify the nginx-served content belongs to the current deployment (not a stale process from an earlier session):

```bash
echo "deployed-$(date +%s)-<dirname>" > /workspace/<dirname>/<outputDir>/.deploy_fingerprint
chmod o+r /workspace/<dirname>/<outputDir>/.deploy_fingerprint 2>/dev/null || true
```

> For SSR proxy type, nginx does not serve static files from `.next` — the fingerprint check will gracefully SKIP in `deploy_check`. The fingerprint is still written as a deployment marker for debugging.

### Step 5: Port Availability Check

**Before configuring nginx or starting the app**, verify the target ports are free. Port conflicts from previous deployments cause silent failures:

```bash
# Check ports from framework detection
check_port() {
  PORT=$1
  # Prefer lsof (most portable), fallback to netstat, then ss
  if command -v lsof >/dev/null 2>&1; then
    PID=$(lsof -ti :$PORT 2>/dev/null)
    if [ -n "$PID" ]; then
      echo "PORT_IN_USE:$PORT (PID=$PID)"
      kill -9 $PID 2>/dev/null && echo "Killed PID $PID on port $PORT"
    else
      echo "PORT_FREE:$PORT"
    fi
  elif command -v netstat >/dev/null 2>&1; then
    PID=$(netstat -tlnp 2>/dev/null | grep ":$PORT " | awk '{print $NF}' | sed 's|/.*||')
    if [ -n "$PID" ] && [ "$PID" != "-" ]; then
      echo "PORT_IN_USE:$PORT (PID=$PID)"
      kill -9 $PID 2>/dev/null && echo "Killed PID $PID on port $PORT"
    else
      echo "PORT_FREE:$PORT"
    fi
  else
    # Last resort: ss (iproute2)
    PID=$(ss -tlnp 2>/dev/null | grep ":$PORT " | sed -n 's/.*pid=\([0-9]*\).*/\1/p' | head -1)
    if [ -n "$PID" ]; then
      echo "PORT_IN_USE:$PORT (PID=$PID)"
      kill -9 $PID 2>/dev/null && echo "Killed PID $PID on port $PORT"
    else
      echo "PORT_FREE:$PORT"
    fi
  fi
}
check_port <port>
# For SSR, also check the Node port
check_port <nodePort>
```

| Scenario               | Port                                 | Action if occupied                     |
| ---------------------- | ------------------------------------ | -------------------------------------- |
| SPA/SSG/Cross-platform | nginx port (from `framework.detect`) | Kill old process, then configure nginx |
| SSR                    | nginx public port + Node app port    | Kill old processes on both ports       |

If the port cannot be freed (different user/process), increment to the next available port: `<port>+1`, update all subsequent nginx config and DevBridge references accordingly.

#### Configure Nginx

Use `huaweicloud_sandbox_deploy_nginx` to write the correct template, fix directory permissions, and reload nginx — all in one call:

```json
{
  "nginx_type": "<nginxType>",
  "port": <port>,
  "project": "<dirname>",
  "output_dir": "<outputDir>",
  "node_port": <nodePort>,
  "public_port": <publicPort>
}
```

- `nginx_type` — `spa` (SPA/SSG/cross-platform), `proxy` (SSR), or `static` (Hugo/Hexo) from `detect_framework`
- `port` — listen port from framework detection
- `project` — project dir name under `/workspace`
- `output_dir` — build output dir relative to `/workspace/<project>`
- `node_port` — Node.js app port for SSR proxy. Defaults to `<port> + 1` if omitted, and the result includes `nodePort` so you know which port to bind the Node process to.
- `public_port` — public listen port for SSR proxy (optional, defaults to `port`)

The tool automatically handles:

- Writing the correct nginx template (SPA try_files, SSR reverse proxy, or static)
- Fixing `o+x` directory traverse permissions on the project path
- Reloading nginx

If the tool returns `ok: false`, nginx may not be installed — fall back to Python HTTP server (see `references/nginx-templates.md`).

**Verify nginx is serving** — curl-check the app before proceeding to DevBridge:

```bash
curl -s -o /dev/null -w "nginx status: %{http_code}\n" http://localhost:<port>
```

If the status code is not 2xx/3xx:

- **403** — run `chmod -R o+rX /workspace/<project>/<outputDir>` and re-test
- **000 (connection refused)** — nginx not listening: check `sudo nginx -t` for config errors
- **Other** — check nginx error log: `sudo tail -20 /var/log/nginx/error.log`

> If `curl` is unavailable, check port via `lsof -i :<port>` or `netstat -tlnp | grep :<port>`

### Step 6: Start the App [REQUIRED]

- **Static (SPA/SSG/cross-platform)**: nginx is already serving. Skip.
- **SSR**: `PORT=<nodePort>` prefix is REQUIRED before `<serveCmd>`. nginx `proxy_pass` targets `<nodePort>`, not `<port>` — the two must differ. `deployNginx` returns `nodePort` in its result (defaults to `<port> + 1` for proxy type).

  **Runtime environment variables**: SSR apps often need `DATABASE_URL`, `NEXTAUTH_URL`, `NEXTAUTH_SECRET`, etc. at runtime. Before starting, verify env vars from Step 4a are still loaded, and re-source `.env` if the shell session was reset:

  ```bash
  cd /workspace/<dirname>
  # Re-load env vars (SSR apps need them at runtime, not just build time)
  if [ -f .env ]; then set -a && source .env 2>/dev/null; set +a; echo "Loaded .env"; fi
  if [ -f .env.local ]; then set -a && source .env.local 2>/dev/null; set +a; echo "Loaded .env.local"; fi
  # Verify critical vars
  echo "DATABASE_URL=${DATABASE_URL:-<NOT SET>}"
  echo "NEXTAUTH_URL=${NEXTAUTH_URL:-<NOT SET>}"
  ```

  Then start with `PORT=<nodePort> <serveCmd>` via `exec_with_session` to run the Node process in background.

### Step 7: Expose via DevBridge [REQUIRED — deployment incomplete without this]

Follow the standard [Expose the deployed app](#expose-the-deployed-app-public-url) procedure. The app is already running on the detected port — only DevBridge tunnel setup is needed.

Use `exec_with_session` to background DevBridge. For SSR, DevBridge tunnels the nginx public port (not the Node port directly).

**Pre-flight**: always run `devbridge delete-all` before creating a new tunnel to prevent `10006: quota exceeded` from accumulated stale tunnels. If you still get quota error, list tunnels with `devbridge list -j`, delete stale ones, and retry.

Extract the tunnel URL from DevBridge output. The public URL has the form `https://<id>-<port>.cn-north-4-bridge.myhuaweicloud.com`. **Return this URL to the developer as the deployment result.**

#### Cross-platform H5 QR code

**If `detect_framework` returned `type: "cross-platform"` (Taro, uni-app)**, after exposing the tunnel, generate a QR code for mobile scanning:

```bash
TUNNEL_URL="<extracted-tunnel-url>"

# Generate QR inside nginx-served output directory so it is accessible via the tunnel URL
curl -s "https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=$(python3 -c "import urllib.parse, sys; print(urllib.parse.quote(sys.argv[1]))" "$TUNNEL_URL")" -o /workspace/<dirname>/<outputDir>/qr.png
chmod o+r /workspace/<dirname>/<outputDir>/qr.png
echo "QR code URL: ${TUNNEL_URL}/qr.png"
echo "Desktop URL: $TUNNEL_URL"
```

**Do NOT use `qrencode -t ANSI256`** — terminal ANSI/ASCII QR codes have low precision and phone cameras cannot scan them. Also, never save the QR image outside the nginx root (e.g., `/workspace/qr.png`) — it must be inside the output directory so it is served by nginx alongside the app.

**After generating the QR code**, return both URLs to the developer:

```
桌面访问: <tunnel-url>
手机扫码: <tunnel-url>/qr.png
```

#### Deployment Completion Check [REQUIRED]

**Before reporting success, call `huaweicloud_sandbox_deploy_check`** to verify the deployment is complete:

```json
{
  "port": <port>,
  "project": "<dirname>",
  "output_dir": "<outputDir>",
  "framework_type": "<type>"
}
```

The tool checks:

- **nginx_serving** — nginx responds with 2xx/3xx on the app port
- **output_dir** — build output directory exists and is non-empty
- **devbridge_tunnel** — DevBridge tunnel is active
- **tunnel_url_accessible** — tunnel URL returns 200/304
- **qr_code** (cross-platform only) — QR image exists in output dir

Returns `complete: true/false`, `score`, and `nextStep` to fix missing items.

**If `complete` is false, follow `nextStep` to resolve before reporting success.** Do not return a deployment URL until `complete: true`.

| Framework Type              | Must Return               |
| --------------------------- | ------------------------- |
| `cross-platform`            | Desktop URL + QR code URL |
| `spa` / `ssg` / `static`    | Desktop URL               |
| `ssr`                       | Desktop URL               |
| `monorepo` (cross-platform) | Desktop URL + QR code URL |

**If the framework is cross-platform and the QR code was not generated, the deployment is incomplete — go back and generate it before reporting success.**

## References

- [Framework Commands](references/framework-commands.md) — command mapping for all supported frameworks
- [Nginx Templates](references/nginx-templates.md) — nginx configuration templates and fallback

## Critical Warnings

| Trap                                 | Why                                                                                                                                                                                                                                     |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agreement required first             | `sandbox_connect` fails if the agreement isn't signed; the `sandbox_check_user` preflight detects this, so surface it to the developer only when signing is needed                                                                      |
| Real-name required                   | `sandbox_connect` fails if `realnameVerified=false`; tell the developer once and stop, don't loop on connect                                                                                                                            |
| Never expose tunnel details          | Do not mention "DevBridge"/"tunnel"/"devbridge" to the developer — say "正在生成访问地址..." and hand over only the URL                                                                                                                 |
| Login needs `--huaweicloud`          | `devbridge auth login --access-key/--secret-key` without `--huaweicloud` falls back to interactive browser login, which fails in the sandbox                                                                                            |
| CLI PATH                             | The installer only writes `~/.bashrc`; run `export PATH=$PATH:$HOME/.huawei/bin` in the session before using `devbridge`                                                                                                                |
| Never install tunnel tooling locally | If the sandbox cannot install it, report a generic error and stop — installing on the developer's machine defeats sandbox deployment                                                                                                    |
| Return the deployment URL            | Always hand the public URL from the host log to the developer as the final result                                                                                                                                                       |
| Deploy is not just nginx             | Configuring nginx does NOT complete the deployment. Steps 7 (DevBridge expose) and deploy_check are REQUIRED — `deploy_nginx` returns `nextStep: expose_via_devbridge` as a reminder. Do not stop after nginx.                          |
| Call deploy_check before success     | Always call `huaweicloud_sandbox_deploy_check` before reporting deployment success. A green nginx status does not mean the tunnel is accessible — verify end-to-end with the tool.                                                      |
| Session state persists               | `exec_with_session` preserves `cd`, env vars, aliases between calls                                                                                                                                                                     |
| Long commands prefer one-shot        | `exec_one_shot` creates a fresh connection per call — more stable for builds, installs, and scripts >30s. See [Tool Selection Guide](#tool-selection-guide).                                                                            |
| SSR nginx/Node ports must differ     | nginx `proxy_pass` targets `<nodePort>`, not `<port>`. `deploy_nginx` auto-defaults `nodePort` to `<port>+1` — always start the Node process with `PORT=<nodePort>` to match. Same-port = EADDRINUSE.                                   |
| HTTP 200 ≠ correct content           | A green HTTP check does not guarantee the right project is serving — old processes from a previous session bound to the same port will still return 200. `deploy_check` verifies the deployment fingerprint to catch this.              |
| Destructive commands blocked         | `rm -rf /`, `mkfs`, `dd if=`, fork bombs are denied by safety policy                                                                                                                                                                    |
| Workspace ID = dev_stage_id          | Use `dev_stage_id` from `sandbox_connect` as `workspace_id` for terminal exec                                                                                                                                                           |
| Projects live in `/workspace`        | Clone/install project code under `/workspace/<repo-name>` (filesystem-root workspace mount, not `$HOME/workspace`), never in `/tmp` — ephemeral locations lose the project when the sandbox session restarts                            |
| Upload project for local code        | Use `sandbox_upload_project` to transfer local projects — packages as tar.gz, uploads via HTTP tunnel, extracts on sandbox. Much faster than base64 for multi-file projects                                                             |
| Upload file for single files         | Use `sandbox_upload_file` for individual files — base64 chunked, reliable for small files (<1MB)                                                                                                                                        |
| Node.js >= 22 required               | Sandbox terminal uses built-in WebSocket (globalThis.WebSocket); if Node.js is missing, install it from the Huawei Cloud mirror (see "Node.js in the sandbox")                                                                          |
| Sandbox restart kills processes      | After sandbox restarts, all user processes (nginx, Node.js, Python servers) are stopped. Re-run startup commands and verify ports are listening before proceeding.                                                                      |
| Cross-platform binaries incompatible | The sandbox runs Linux. Native binaries built on Windows/macOS (e.g., Prisma client, `node_modules/.prisma/`, platform-specific native addons) will not execute. Always install and build dependencies inside the sandbox, not locally. |
| Cross-platform needs QR code         | When `detect_framework` returns `type: "cross-platform"` (Taro, uni-app), generating a QR code image is **mandatory** — the deployment is incomplete without it. Check the Deployment Completion Check table in Step 7.                 |
| Build fails do NOT auto-fix          | When a build exits with non-zero exit code, STOP and present the error + fix options to the developer. Do not silently retry, modify configs, or change source files without explicit approval. See 4c-aux.                             |

## Node.js in the sandbox

If the sandbox has no Node.js, download it from the Huawei Cloud mirror. Pick the tarball matching the sandbox arch (`uname -m`: `aarch64` -> arm64, `x86_64` -> x64):

```bash
# aarch64 sandbox:
curl -fsSL https://mirrors.huaweicloud.com/nodejs/v24.19.0/node-v24.19.0-linux-arm64.tar.gz -o node.tar.gz
# x86_64 sandbox:
curl -fsSL https://mirrors.huaweicloud.com/nodejs/v24.19.0/node-v24.19.0-linux-x64.tar.gz -o node.tar.gz
sudo tar -xzf node.tar.gz -C /usr/local --strip-components=1
node --version
```

## Environment Variables

| Variable                | Required | Description                                                     |
| ----------------------- | -------- | --------------------------------------------------------------- |
| `HW_ACCESS_KEY`         | Yes      | Huawei Cloud AK                                                 |
| `HW_SECRET_KEY`         | Yes      | Huawei Cloud SK                                                 |
| `HW_SECURITY_TOKEN`     | No       | STS security token                                              |
| `HW_WORKSPACE_ID`       | No       | Default workspace ID                                            |
| `HDKITSERVICE_ENDPOINT` | No       | hdkitservice API endpoint (default: devkit.huaweicloud.com)     |
| `HWLINK_ENDPOINT`       | No       | DevStation API endpoint (default: devstation.myhuaweicloud.com) |
