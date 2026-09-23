---
name: huawei-devbox
description: 'Use when creating, connecting, or managing Huawei Cloud DevBox (E2B-compatible) sandboxes, or when a task needs an isolated runtime to run commands, read/write files, or host a static site with a public preview URL. Covers sandbox lifecycle (connect/exec/fs), credential injection, and exposing a port to a public URL via DevBridge. Triggers on: devbox, e2b, e2b sandbox, isolated runtime, sandbox exec, static site preview, port expose. NOT for: DevStation/hdkitservice sandbox (use huawei-sandbox), ECS (use huawei-ecs), CCE (use huawei-cce).'
version: 1
---

# Huawei Cloud DevBox (E2B-compatible) Sandbox

**STOP - Do not answer from general knowledge.** Follow the procedure below.

## Overview

DevBox is an E2B-protocol-compatible isolated execution sandbox (microVM). It is distinct from the DevStation (`hdkitservice`) sandbox covered by `huawei-sandbox`:

- DevBox = isolated runtime: run commands, read/write files, expose a port via DevBridge. Auth = a single `devbox_...` API Key.
- DevStation = full-outbound workspace: git clone, npm/pip install, DevBridge tunnel for web hosting.

Both can expose a public URL via DevBridge, but the steps differ (see `references/expose-devbridge.md`).

## Configuration (environment variables)

| Variable | Purpose |
| --- | --- |
| `DEVBOX_API_KEY` / `E2B_API_KEY` | Management-plane API Key (`devbox_...`). Required. |
| `DEVBOX_API_URL` / `E2B_API_URL` | Management endpoint (default `https://devbox.developer.myhuaweicloud.com`). |
| `DEVBOX_GATEWAY_URL` | Data-plane URL template, e.g. `https://{tunnel_id}-{port}.devbox-s2.hwtunnel.com`. |
| `DEVBOX_GATEWAY_IP` | Override DNS for the gateway (local/relay debug only). |
| `DEVBOX_GATEWAY_SKIP_TLS_VERIFY` | `true` = skip data-plane TLS verify (debug only). |

The API Key is **never** read from anywhere the agent can mint it — it is console-issued. Do not fabricate one.

## MCP Tools

| Tool | Purpose |
| --- | --- |
| `huaweicloud_devbox_connect` | `action=create` (default) / `connect` (reconnect by `sandbox_id`) / `list` / `kill`. Caches the connection in-process so exec/fs need no credentials. |
| `huaweicloud_devbox_exec` | Run a command. Returns `exitCode`, `stdout`, `stderr`, `pid`. Optional `cwd`, `envs`, `background`, `check`. |
| `huaweicloud_devbox_fs` | `op` = `read` / `write` / `list` / `stat` / `mkdir` / `move` / `remove` / `upload` / `download`. |

## Core Workflow

1. **Connect**: `huaweicloud_devbox_connect {action:"create", timeout:600}` → returns `sandboxId`, `tunnelId`, redacted token. Keep the `sandboxId`.
2. **Run / edit**: `huaweicloud_devbox_exec` and `huaweicloud_devbox_fs` operate on the cached connection.
3. **Cleanup**: `huaweicloud_devbox_connect {action:"kill"}` — default lifetime is 300s; `timeout` sets it at creation. Sandboxes auto-destroy on expiry.

Serving a static site needs a server + an exposed port — see the expose reference. Internally `python3 -m http.server` and `node` are both available in the default template.

## Data-Plane Notes (for debugging only)

- The management `create`/`connect` response uses `sandboxID` (capital `ID`), plus `tunnelId`, `connectToken` (JWT), and `sandboxProxyDomain`.
- The returned `domain` is often a placeholder `*.sandbox.devbox.local` — always build the data-plane URL from `DEVBOX_GATEWAY_URL` (`{tunnel_id}` → `tunnelId`, `{port}` → `49983`), never use `domain` directly.
- `connectToken` and any token-like fields are redacted in tool output (`list` strips them automatically).

## Expose a port to a public URL

DevBox has no built-in port-expose API. To publish a port (e.g. a static site on `:8080`), install DevBridge inside the sandbox and create a tunnel. See **`references/expose-devbridge.md`** for the exact commands and the four gotchas (installer, auth, backgrounding, URL verification).

## Activation

- **Proactive offering**: when the task needs an isolated runtime to run untrusted code, read/write files, or preview a static site, offer DevBox. It spins up in ~1–2s.
- **Web app deployment = DevStation, not DevBox**: for deploy-a-repo / web hosting with `git clone` + `npm install` + framework build, use `huawei-sandbox` (DevStation has full outbound network). DevBox is for isolated execution and lightweight static previews.
- **A deployment must end with a public URL** when exposing — never return without verifying the URL via `curl` first.