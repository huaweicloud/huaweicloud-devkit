# Sandbox Upload File - Design Document

## 1. Background

### 1.1 Current Implementation

huaweicloud-devkit sandbox upload (`uploadFileWithSession`) uses base64 chunking through the terminal exec channel:

1. Read local file → base64 encode → compute MD5
2. Split base64 into 3072-byte chunks
3. For each chunk: `printf '%s' '<chunk>' >> "<tmpFile>"`
4. `base64 -d "<tmpFile>" > "<remotePath>" && rm -f "<tmpFile>"`
5. Verify: `md5sum "<remotePath>"`

### 1.2 Current Limitations

| Issue         | Detail                                                           |
| ------------- | ---------------------------------------------------------------- |
| Size overhead | base64 encoding causes 33% volume expansion                      |
| Fragility     | Single commands > ~4KB are fragile (timeout or session crash)    |
| Large file    | >1MB extremely slow, >12KB base64 in one command → session crash |
| No progress   | No way to report upload progress                                 |
| No streaming  | Entire file must be base64-encoded in memory first               |

### 1.3 Goal

Add an `uploadProject` feature to the sandbox tool that can package a local project directory into a tar.gz archive and upload it to the sandbox efficiently via HTTP + tunnel.

## 2. Architecture

### 2.1 Overview

```
┌──────────────────┐         ┌──────────────────┐
│   Local Client    │  HTTP   │  Sandbox HTTP    │
│                  │ ──POST──> │  File Server     │
│  1. Package dir  │         │                  │
│  2. Push archive │         │  1. Listen port  │
└──────────────────┘         │  2. Receive file │
        │                    │  3. Write to disk │
        │  Tunnel            │  4. Return result │
        └──── tunnel ───────>└──────────────────┘
       localhost:9999            sandbox:8888
```

### 2.2 Flow

1. Package local project directory as tar.gz archive
2. Deploy and start HTTP file receiver server on sandbox (port 8888) via terminal exec
3. Establish WebSocket connection + local-to-remote tunnel: localhost:9999 → sandbox:8888
4. POST the tar.gz archive to http://localhost:9999/upload
5. Sandbox HTTP server receives the file, writes to disk, returns JSON result (with md5)
6. Verify upload result (compare md5)
7. Extract tar.gz archive on sandbox and remove the archive file
8. Cleanup: stop HTTP server on sandbox, close tunnel

### 2.3 Why This Approach

| Aspect            | Reason                                                             |
| ----------------- | ------------------------------------------------------------------ |
| Push model        | Client controls when and what to upload, more natural for "upload" |
| Sandbox as server | Sandbox controls where files are written, more secure              |
| Binary transfer   | No base64 overhead, raw binary over HTTP                           |
| HTTP semantics    | Built-in Content-Length for progress, status codes for errors      |
| Tunnel reuse      | Leverages existing hwlink WebSocket multiplexer infrastructure     |

## 3. Project Structure Changes

```
plugins/huaweicloud-core/src/
├── ws-exec/
│   ├── hwlink-tunnel-channel.mjs  ← NEW: TCP tunnel channel (local→remote forward)
│   └── index.js                   ← MODIFY: export tunnel channel
├── sandbox/
│   ├── session-manager.mjs        ← MODIFY: add uploadProjectWithSession()
│   └── sandbox-file-server.py     ← NEW: embedded HTTP file receiver (deployed to sandbox)
└── tools.mjs                      ← MODIFY: add huaweicloud_sandbox_upload_project tool
```

## 4. Module Design

### 4.1 HwlinkTunnelChannel (`hwlink-tunnel-channel.mjs`)

TCP tunnel channel implementing the `ChannelHandler` interface, registered on the `HwlinkWebSocketMultiplexer`.

#### Protocol: Local-to-Remote (Forward) Tunnel

```
Local                          WebSocket                       Remote
  │                               │                              │
  │  TCP connect localhost:9999   │                              │
  │──────────────────────────────>│                              │
  │                               │  OpCreateTcpTunnel           │
  │                               │  srcPort=9999 dstPort=8888   │
  │                               │─────────────────────────────>│
  │                               │                              │
  │                               │  OpTunnelSuccess             │
  │                               │<─────────────────────────────│
  │                               │                              │
  │  data                         │  OpTcpTunnelData             │
  │──────────────────────────────>│─────────────────────────────>│
  │                               │                              │
  │                               │  OpTcpTunnelData             │
  │                               │<─────────────────────────────│
  │  data                         │                              │
  │<──────────────────────────────│                              │
```

#### Class Interface

```js
class HwlinkTunnelChannel {
  constructor({ localPort, remotePort, identifier, onReady, onClose })

  // ChannelHandler interface (used by HwlinkWebSocketMultiplexer)
  get identifier
  onopen()
  onmessage(packet)
  onerror(error)
  onclose(event)

  // Tunnel-specific
  get ready()        // Promise, resolves when OpTunnelSuccess received
  get localServer()  // net.Server listening on localPort
  close()            // Close local server and all sub-connections
}
```

#### Sub-Connection Management

Each TCP connection from the local client maps to a sub-channel identified by `identifier`. Multiple concurrent HTTP connections (e.g., for retry) are supported:

```
HwlinkTunnelChannel
├── localServer (net.Server on localPort)
├── subConnections: Map<socket, { identifier, buffer }>
├── onIncomingConnection(socket)
│   ├── allocate identifier via nextIdentifier()
│   ├── send OpCreateTcpTunnel(srcPort=localPort, dstPort=remotePort, identifier)
│   └── pipe socket data → OpTcpTunnelData packets
└── onTunnelData(packet)
    ├── find subConnection by packet.identifier
    └── write packet.data to subConnection.socket
```

#### Backpressure

- Uses the existing `FairQueue` via `mux.sendFairly(ch, data)`
- TCP socket `pause()`/`resume()` when `FairQueue` applies backpressure
- Max chunk size: `MAX_SEND_CHUNK_SIZE - FIXED_HEADER_LEN` = 8180 bytes per packet

#### OpCode Handling

| Received OpCode                              | Action                                                |
| -------------------------------------------- | ----------------------------------------------------- |
| `OpTunnelSuccess` (with matching identifier) | Mark sub-connection as ready, resolve pending promise |
| `OpTcpTunnelData`                            | Write payload data to the corresponding local socket  |
| `OpDisconnect`                               | Close the corresponding local socket                  |
| `ErrTcpTunnel`                               | Close the corresponding local socket, emit error      |
| `OpSubStreamPing`                            | Respond with `OpSubStreamPong`                        |

### 4.2 Sandbox HTTP File Server (`sandbox-file-server.py`)

A lightweight Python 3 HTTP server deployed to the sandbox via terminal exec. Chosen over Node.js because Python 3 is available by default on DevStation sandbox instances.

#### Server Script (embedded as string in JS)

```python
#!/usr/bin/env python3
"""Sandbox file receiver server for huaweicloud-devkit upload."""
import hashlib
import http.server
import json
import os
import sys

class UploadHandler(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path != '/upload':
            self.send_error(404)
            return

        if self.server.upload_token:
            token = self.headers.get('X-Upload-Token', '')
            if token != self.server.upload_token:
                self.send_error(403, 'Invalid upload token')
                return

        target_path = self.headers.get('X-Target-Path', '/workspace/upload.tar.gz')
        content_length = int(self.headers.get('Content-Length', 0))

        os.makedirs(os.path.dirname(target_path), exist_ok=True)

        md5 = hashlib.md5()
        bytes_written = 0
        with open(target_path, 'wb') as f:
            remaining = content_length
            while remaining > 0:
                chunk = self.rfile.read(min(remaining, 65536))
                if not chunk:
                    break
                f.write(chunk)
                md5.update(chunk)
                bytes_written += len(chunk)
                remaining -= len(chunk)

        result = json.dumps({
            'ok': True,
            'path': target_path,
            'bytes': bytes_written,
            'md5': md5.hexdigest()
        })
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(result.encode())

    def do_GET(self):
        if self.path == '/health':
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b'ok')
        else:
            self.send_error(404)

    def log_message(self, format, *args):
        pass  # Suppress logging

if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8888
    token = sys.argv[2] if len(sys.argv) > 2 else ''
    server = http.server.HTTPServer(('127.0.0.1', port), UploadHandler)
    server.upload_token = token
    server.serve_forever()
```

#### Deployment Strategy

The Python script is embedded as a string constant in `session-manager.mjs` and written to the sandbox via terminal exec:

```js
const SANDBOX_FILE_SERVER_SCRIPT = `#!/usr/bin/env python3\n...`;

function generateUploadToken() {
  // Session-scoped token: valid for the entire lifetime of the HTTP server.
  // Allows retry within the same upload session (e.g., network interruption).
  // Automatically invalidated when the server is stopped after upload completes.
  return randomBytes(16).toString('hex');
}

async function deployFileServer(workspaceId, username, port = 8888, token = '') {
  const scriptPath = '/tmp/sandbox-file-server.py';
  const pidFile = '/tmp/sandbox-file-server.pid';
  // Write script to sandbox using base64 (small script, acceptable overhead)
  const b64 = Buffer.from(SANDBOX_FILE_SERVER_SCRIPT).toString('base64');
  await execWithSession(workspaceId, `echo '${b64}' | base64 -d > ${scriptPath}`, username);
  // Start server in background, save PID
  const cmd = token
    ? `python3 ${scriptPath} ${port} ${token} & echo $! > ${pidFile}`
    : `python3 ${scriptPath} ${port} & echo $! > ${pidFile}`;
  await execWithSession(workspaceId, cmd, username);
}

async function waitForServerReady(localPort, maxRetries = 30, intervalMs = 1000) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const r = await fetch(`http://localhost:${localPort}/health`, {
        signal: AbortSignal.timeout(2000),
      });
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`sandbox file server not ready after ${maxRetries * intervalMs}ms`);
}

async function cleanupFileServer(workspaceId, username) {
  const pidFile = '/tmp/sandbox-file-server.pid';
  const scriptPath = '/tmp/sandbox-file-server.py';
  await execWithSession(workspaceId, `kill $(cat ${pidFile}) 2>/dev/null; rm -f ${pidFile} ${scriptPath}`, username);
}
```

### 4.3 uploadProjectWithSession (`session-manager.mjs`)

#### Function Signature

```js
async function uploadProjectWithSession(
  workspaceId,       // Workspace ID (defaults to HW_WORKSPACE_ID env var)
  localDir,          // Local project directory path
  remoteDir,         // Remote parent directory where project will be extracted
                     //   Final layout: <remoteDir>/<dirname>/  (default: /workspace/<dirname>)
  username = 'root',
  timeoutMs = 120000,
  options = {}
)
```

#### Options

```js
{
  exclude: ['.git', 'node_modules', '__pycache__', '.venv'],  // Patterns to exclude from tar
  sandboxPort: 8888,     // HTTP server port on sandbox
  localPort: 0,          // Local tunnel port (0 = auto-assign)
  verify: true,          // Verify md5 after upload
  extract: true,         // Extract tar.gz on sandbox after upload
}
```

#### Implementation Steps

```js
const TUNNEL_READY_TIMEOUT_MS = 15000;

async function uploadProjectWithSession(workspaceId, localDir, remoteDir, username, timeoutMs, options) {
  const sandboxPort = options.sandboxPort || 8888;
  const projectName = basename(localDir);
  const targetParentDir = remoteDir || '/workspace';
  const archiveRemotePath = `${targetParentDir}/${projectName}.tar.gz`;

  // Step 1: Create tar.gz archive of local project
  const archivePath = await createTarGz(localDir, options.exclude);
  const archiveSize = statSync(archivePath).size;
  const expectedMd5 = await computeMd5(archivePath);

  // Step 2: Deploy and start HTTP file server on sandbox
  const uploadToken = generateUploadToken();
  await deployFileServer(workspaceId, username, sandboxPort, uploadToken);

  // Step 3: Establish WebSocket connection + tunnel
  const session = await getSession(workspaceId, username);
  const localPort = options.localPort || findFreePort();
  const tunnel = new HwlinkTunnelChannel({
    localPort,
    remotePort: sandboxPort,
    identifier: nextIdentifier(),
  });
  session.mux.register(tunnel);
  await Promise.race([
    tunnel.ready,
    new Promise((_, reject) => setTimeout(() => reject(new Error('tunnel ready timeout')), TUNNEL_READY_TIMEOUT_MS)),
  ]);

  // Step 3.5: Wait for server to be ready via tunnel health check
  await waitForServerReady(localPort);

  // Step 4: POST archive to sandbox via tunnel (streaming, no full-buffer)
  const resp = await fetch(`http://localhost:${localPort}/upload`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(archiveSize),
      'X-Target-Path': archiveRemotePath,
      'X-Upload-Token': uploadToken,
    },
    body: createReadStream(archivePath),
    duplex: 'half',
    signal: AbortSignal.timeout(timeoutMs),
  });

  // Step 5: Verify result
  const result = await resp.json();
  if (options.verify !== false && result.md5 !== expectedMd5) {
    throw new Error(`md5 mismatch: expected ${expectedMd5}, got ${result.md5}`);
  }

  // Step 6: Extract archive on sandbox
  if (options.extract !== false) {
    await execWithSession(
      workspaceId,
      `mkdir -p "${targetParentDir}" && tar -xzf "${archiveRemotePath}" -C "${targetParentDir}" && rm -f "${archiveRemotePath}"`,
      username,
    );
  }

  // Step 7: Cleanup
  await cleanupFileServer(workspaceId, username);
  tunnel.close();
  cleanupLocalArchive(archivePath);

  return {
    ok: true,
    localDir,
    remotePath: options.extract !== false ? `${targetParentDir}/${projectName}` : archiveRemotePath,
    bytes: result.bytes,
    md5: result.md5,
    md5Verified: result.md5 === expectedMd5,
    extracted: options.extract !== false,
  };
}
```

### 4.4 Local Archive Creation

```js
import { execFile } from 'node:child_process/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, basename, dirname } from 'node:path';
import { mkdirSync } from 'node:fs';

async function createTarGz(localDir, exclude = []) {
  const archiveName = `${basename(localDir)}.tar.gz`;
  const archivePath = join(tmpdir(), `sandbox-upload-${Date.now()}`, archiveName);
  mkdirSync(dirname(archivePath), { recursive: true });

  const args = [
    ...exclude.flatMap((p) => ['--exclude', p]),
    '-czf',
    archivePath,
    '-C',
    dirname(localDir),
    basename(localDir),
  ];
  await execFile('tar', args);

  return archivePath;
}

async function computeMd5(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('md5');
    createReadStream(filePath)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject);
  });
}
```

### 4.5 MCP Tool Definition

Add to `tools.mjs`:

```js
{
  name: 'huaweicloud_sandbox_upload_project',
  description: 'Package a local project directory and upload it to a sandbox workspace via HTTP tunnel. Falls back to base64 chunking if tunnel fails.',
  inputSchema: {
    type: 'object',
    properties: {
      workspace_id: {
        type: 'string',
        description: 'Workspace ID (defaults to HW_WORKSPACE_ID env var)',
      },
      local_dir: {
        type: 'string',
        description: 'Local project directory to upload',
      },
      remote_dir: {
        type: 'string',
        description: 'Remote parent directory where project will be extracted (default: /workspace). Final layout: <remote_dir>/<dirname>/',
      },
      username: {
        type: 'string',
        default: 'root',
      },
      exclude: {
        type: 'array',
        items: { type: 'string' },
        default: ['.git', 'node_modules', '__pycache__', '.venv'],
        description: 'Patterns to exclude from archive',
      },
      extract: {
        type: 'boolean',
        default: true,
        description: 'Extract tar.gz on sandbox after upload (if false, only the archive file is uploaded)',
      },
      timeout_ms: {
        type: 'number',
        default: 120000,
      },
    },
    required: ['local_dir'],
  },
}

// In dispatch: workspace_id defaults to process.env.HW_WORKSPACE_ID || DEFAULT_WORKSPACE_ID
```

## 5. Comparison with Existing Base64 Approach

| Dimension                 | Base64 Chunking (Current)            | HTTP + Tunnel (New)                 |
| ------------------------- | ------------------------------------ | ----------------------------------- |
| Transfer efficiency       | 33% overhead (base64)                | Raw binary, no overhead             |
| Large file support        | Poor (>1MB extremely slow)           | Good (streaming HTTP)               |
| Reliability               | Fragile (large chunks crash session) | Stable (HTTP semantics)             |
| Progress reporting        | None                                 | Content-Length based                |
| Integrity check           | md5sum (extra exec command)          | md5 in HTTP response                |
| Connection overhead       | Reuses terminal session              | Requires tunnel setup               |
| Implementation complexity | Low                                  | Medium (tunnel channel)             |
| Dependencies              | None                                 | Tunnel channel + Python3 on sandbox |

## 6. Risk Analysis

| Risk                               | Impact                              | Mitigation                                                                                                                                     |
| ---------------------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Python3 not available on sandbox   | HTTP server cannot start            | Fallback to base64 chunking; detect Python availability before attempting                                                                      |
| Tunnel port conflict               | Tunnel fails to establish           | Use port 0 (auto-assign) for local port; check sandbox port availability before deploying server                                               |
| Sandbox HTTP server crash          | Upload fails mid-transfer           | Health check polling before upload; retry logic; fallback to base64                                                                            |
| Tunnel channel implementation bugs | Data corruption or hang             | Thorough testing with various file sizes; checksum verification                                                                                |
| Large archive OOM                  | Local memory pressure               | Stream file via `fs.createReadStream` for POST body; streaming MD5 hash                                                                        |
| Cleanup failure                    | Orphaned processes on sandbox       | PID tracking + kill on cleanup; timeout-based self-termination for HTTP server                                                                 |
| Proxy environment                  | Tunnel may not work through proxy   | Respect existing proxy config from `proxy-agent.mjs`                                                                                           |
| Unauthorized upload                | Any sandbox process writes via HTTP | Bind server to 127.0.0.1; session-scoped token auth via `X-Upload-Token` (valid for server lifetime, allows retry; invalidated on server stop) |
| Tunnel ready timeout               | Upload hangs indefinitely           | 15s timeout on `tunnel.ready` promise with `Promise.race`                                                                                      |
| Sandbox port 8888 occupied         | HTTP server fails to start          | Pre-check with `ss -tlnp \| grep :8888`; use alternative port if occupied                                                                      |

## 7. Fallback Strategy

If the HTTP + tunnel approach fails at any step, fall back to the existing base64 chunking. The archive is created once and reused in both paths:

```js
async function uploadProjectWithSession(workspaceId, localDir, remoteDir, username, timeoutMs, options) {
  const projectName = basename(localDir);
  const targetParentDir = remoteDir || '/workspace';
  const archiveRemotePath = `${targetParentDir}/${projectName}.tar.gz`;

  // Step 1: Create archive once (shared by both paths)
  const archivePath = await createTarGz(localDir, options.exclude);

  try {
    return await uploadViaHttpTunnel(workspaceId, archivePath, archiveRemotePath, username, timeoutMs, options);
  } catch (error) {
    console.error(`HTTP tunnel upload failed: ${error.message}, falling back to base64 chunking`);
    // Fallback: upload archive via base64, then extract
    await uploadFileWithSession(workspaceId, archivePath, archiveRemotePath, username, timeoutMs);
  }

  // Extract on sandbox (both paths)
  if (options.extract !== false) {
    await execWithSession(
      workspaceId,
      `mkdir -p "${targetParentDir}" && tar -xzf "${archiveRemotePath}" -C "${targetParentDir}" && rm -f "${archiveRemotePath}"`,
      username,
    );
  }

  return {
    ok: true,
    localDir,
    remotePath: options.extract !== false ? `${targetParentDir}/${projectName}` : archiveRemotePath,
    extracted: options.extract !== false,
  };
}
```

## 8. Future Enhancements

- **Resumable upload**: Support Range headers for resuming interrupted uploads
- **Compression negotiation**: Skip tar.gz if uploading already-compressed files
- **Directory sync**: Incremental upload (only changed files) using rsync-like diff
- **Progress callback**: Report upload progress percentage to the MCP caller (Content-Length based)
- **Multi-file upload**: Support uploading multiple files/directories in one call
