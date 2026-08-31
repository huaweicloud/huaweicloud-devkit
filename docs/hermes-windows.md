# Hermes for Windows — Known Issues and Workarounds

## Issue 1: MCP Server Silent Exit

**Symptom**: MCP tools (`mcp__huaweicloud_devkit__*`) do not appear in Hermes. `mcp-stderr.log` shows repeated `starting MCP server` lines with exponential backoff and no error output.

**Root cause**: Hermes' Python `mcp` SDK v2.0.0 uses `asyncio` stdio transport on Windows. After the initial MCP handshake, the stdio pipe may close abnormally, causing the Node.js MCP server process to exit silently (exit code 0). The server code itself is correct — the issue is in the Python SDK's Windows stdio lifecycle management.

**Status**: The devkit includes a keepalive timer (setInterval) in the MCP server to prevent Node.js event loop exit, but this does not fix the Hermes-side pipe closure. This is a Hermes bug, not a devkit bug.

## Issue 2: `--no-deprecation` Flag Removed After Install

**Symptom**: On Node.js v24, `[DEP0187]` deprecation warnings may crash the MCP server.

**Root cause**: The installer rewrites `config.yaml` → `mcp_servers.huaweicloud-devkit.args` during `install` and `update`, silently removing any custom arguments including `--no-deprecation`.

**Workaround**: After every install or update, re-apply the flag:

```bash
hermes config set mcp_servers.huaweicloud-devkit.args '["--no-deprecation", "<server-path>"]'
```

Run `hermes config get mcp_servers.huaweicloud-devkit` to verify.

The server path is printed by `doctor --target hermes` (typically `%LOCALAPPDATA%\hermes\huaweicloud-plugins\src\mcp-server.mjs`).

## Issue 3: Manual MCP Server Workaround (When Stdio Fails)

If the MCP server keeps dying despite all fixes (`doctor` passes, `--no-deprecation` in place), the tools can still be used by spawning the server directly and communicating via JSON-RPC over stdio:

```python
import subprocess, json

proc = subprocess.Popen(
    ["node", "--no-deprecation", "mcp-server.mjs"],
    stdin=subprocess.PIPE, stdout=subprocess.PIPE,
    env={"HW_ACCESS_KEY": ak, "HW_SECRET_KEY": sk}
)

def call_tool(name, args):
    payload = {
        "jsonrpc": "2.0", "id": "1", "method": "tools/call",
        "params": {"name": name, "arguments": args}
    }
    body = json.dumps(payload)
    frame = f"Content-Length: {len(body)}\r\n\r\n{body}"
    proc.stdin.write(frame.encode())
    proc.stdin.flush()
    # Read response (Content-Length framed)
    ...

# Example: check sandbox user
result = call_tool("huaweicloud_sandbox_check_user", {})
```

This bypasses the Hermes MCP transport layer entirely and calls the devkit's MCP server directly. All 35 tools are available through this method.

## Report

Report Windows stdio issues to: https://github.com/NousResearch/Hermes-Agent/issues
