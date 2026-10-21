import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createConnection as netConnect } from 'node:net';
import {
  existsSync,
  readFileSync,
  statSync,
  mkdirSync,
  rmSync,
  createReadStream,
  appendFileSync,
  unlinkSync,
} from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { join, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createConnection, getCredentials } from './hwlink-api.mjs';
import { getWebSocketImpl } from '../proxy/proxy-agent.mjs';
import { trackSandboxConnect, trackSandboxDisconnect } from '../telemetry/telemetry.mjs';

const execFileAsync = promisify(execFile);

// Public tunnel URL domain for the DevBridge s2 gateway. The pre-migration Huawei Cloud
// bridge domain was retired in Sep 2026 and now serves a 「服务已迁移」 placeholder page with
// HTTP 200 — never construct tunnel URLs from it.
const DEVBRIDGE_TUNNEL_DOMAIN = 'devbridge-s2.hwtunnel.com';
// Migration placeholder page marker — a tunnel URL returning this body must be treated as unreachable.
const DEVBRIDGE_MIGRATION_MARKER = '服务已迁移';
// Gateway-level tunnel error markers (verified against the live s2 gateway, Oct 2026).
// The gateway answers with exact text/plain bodies:
//   404 "tunnel not found"    — no live host session on the gateway (host process dead or
//                               tunnel deleted); the tunnel RECORD may still exist in `list`
//   404 "port not configured" — the URL's port is not registered on the tunnel
//   502 "bad gateway"         — host session alive, but the registered port has no local service
// A bare status check cannot distinguish these from app-generated 404/502 responses, so the
// checks below match the exact body AND gate on the HTTP status code.
const DEVBRIDGE_TUNNEL_NOT_FOUND_MARKER = 'tunnel not found';
const DEVBRIDGE_PORT_NOT_CONFIGURED_MARKER = 'port not configured';
const DEVBRIDGE_BAD_GATEWAY_MARKER = 'bad gateway';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const WS_EXEC_INDEX_URL = pathToFileURL(join(__dirname, '..', 'ws-exec', 'index.js')).href;

export const TUNNEL_URL_PATTERN = /TUNNEL_URL:(https:\/\/[A-Za-z0-9_-]+-\d+\.devbridge-s2\.hwtunnel\.com)/;

let currentWorkspaceId = process.env.HW_WORKSPACE_ID || null;

function getCurrentWorkspaceId() {
  return currentWorkspaceId;
}

function setWorkspaceId(id) {
  if (id && id !== currentWorkspaceId) {
    trackSandboxConnect();
  }
  currentWorkspaceId = id;
  process.env.HW_WORKSPACE_ID = id;
}

function resolveEnv() {
  const env = { ...process.env };
  env.PATH = `${env.HOME || '/root'}/.huawei/bin:${env.PATH || ''}`;
  return env;
}

async function runNodeExec(args, timeoutMs = 30000) {
  const env = resolveEnv();
  return new Promise((resolve) => {
    const proc = spawn('node', args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    proc.stderr.on('data', (d) => {
      stderr += d.toString();
    });

    const timer = setTimeout(() => {
      proc.kill();
      resolve({ error: 'timed out', exitCode: 124 });
    }, timeoutMs);

    proc.on('close', (code) => {
      clearTimeout(timer);
      const out = stdout.trim();
      if (out) {
        try {
          resolve({ ...JSON.parse(out), exitCode: code || 0 });
          return;
        } catch {}
      }
      if (code && code !== 0 && !out) {
        resolve({ error: stderr.trim() || `exit code ${code}`, exitCode: code });
        return;
      }
      resolve({ data: out, exitCode: code || 0 });
    });
  });
}

const sessions = new Map();

async function getSession(workspaceId, username, timeoutMs) {
  const key = `${workspaceId}:${username}`;
  if (sessions.has(key)) return sessions.get(key);

  const { ak, sk, securitytoken } = getCredentials();
  const { wsUrl, source } = await createConnection(workspaceId, ak, sk, securitytoken);

  const WebSocketImpl = await getWebSocketImpl(wsUrl);

  const { connectHwlinkTerminalSession } = await import(WS_EXEC_INDEX_URL);
  const session = await connectHwlinkTerminalSession({
    url: wsUrl,
    source,
    username,
    timeoutMs,
    WebSocketImpl,
  });

  sessions.set(key, session);
  return session;
}

async function createTunnelSession(workspaceId, username, timeoutMs = 30000) {
  const { ak, sk, securitytoken } = getCredentials();
  const { wsUrl, source } = await createConnection(workspaceId, ak, sk, securitytoken);
  const WebSocketImpl = await getWebSocketImpl(wsUrl);

  const { HwlinkWebSocketMultiplexer } = await import(WS_EXEC_INDEX_URL);
  const mux = new HwlinkWebSocketMultiplexer(wsUrl, source, { WebSocketImpl, protocol: 'devenv' });

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      clearInterval(interval);
      reject(new Error('tunnel session WebSocket open timeout'));
    }, timeoutMs);
    const interval = setInterval(() => {
      if (mux.readyState === 1) {
        clearTimeout(timer);
        clearInterval(interval);
        resolve();
      } else if (mux.readyState === 3) {
        clearTimeout(timer);
        clearInterval(interval);
        reject(new Error('tunnel session WebSocket closed'));
      }
    }, 100);
    mux.onClose = () => {
      clearTimeout(timer);
      clearInterval(interval);
      reject(new Error('tunnel session WebSocket closed'));
    };
    mux.onError = (err) => {
      clearTimeout(timer);
      clearInterval(interval);
      reject(err);
    };
  });

  return { mux, close: () => mux.close() };
}

export async function execOneShot(workspaceId, command, username, timeoutMs) {
  const { ak, sk, securitytoken } = getCredentials();
  const { wsUrl, source } = await createConnection(workspaceId, ak, sk, securitytoken);

  const WebSocketImpl = await getWebSocketImpl(wsUrl);

  const { executeHwlinkCommand } = await import(WS_EXEC_INDEX_URL);
  return await executeHwlinkCommand({
    url: wsUrl,
    source,
    username,
    command,
    timeoutMs,
    WebSocketImpl,
  });
}

export async function execWithSession(workspaceId, command, username, timeoutMs) {
  const session = await getSession(workspaceId, username, timeoutMs);
  return await session.exec(command, { timeoutMs });
}

export const UPLOAD_CHUNK_SIZE = 30000;

export const UPLOAD_BATCH_SIZE = 2;

export const UPLOAD_MAX_RETRIES = 3;

export function splitBase64Chunks(base64, chunkSize = UPLOAD_CHUNK_SIZE) {
  const chunks = [];
  for (let offset = 0; offset < base64.length; offset += chunkSize) {
    chunks.push(base64.slice(offset, offset + chunkSize));
  }
  return chunks;
}

export function formatPortConflictWarning(basePort, targetPort) {
  return targetPort !== basePort ? `Port ${basePort} is in use — auto-assigned port ${targetPort}` : undefined;
}

export function formatPortDriftWarning(basePort, targetPort) {
  if (targetPort === basePort) return undefined;
  return `Port ${basePort} was occupied — nginx now listens on port ${targetPort}. Any DevBridge tunnel bound to port ${basePort} is detached: run "devbridge port create <tunnelId> -p ${targetPort} --protocol http -a" and restart "devbridge host" for the new port.`;
}

export async function resolveProxyNodePort(nodePort, nginxListenPort, isPortInUse) {
  const baseCandidate = nodePort && nodePort !== nginxListenPort ? nodePort : nginxListenPort + 1;
  let candidate = baseCandidate;
  for (
    let attempt = 0;
    attempt < 10 && (candidate === nginxListenPort || (await isPortInUse(candidate)));
    attempt += 1
  ) {
    candidate += 1;
  }
  return candidate;
}

export function buildExposeRemediation(port) {
  return `In the sandbox: source /tmp/hw_creds.sh; source /tmp/hw_api_key 2>/dev/null; devbridge delete-all; devbridge create <name>; devbridge port create <tunnelId> -p ${port} --protocol http -a; nohup devbridge host <tunnelId> -p ${port} > /tmp/host.log 2>&1 & If deploy_nginx reported a different (auto-incremented) port in its "port" field, use THAT port instead of the one shown here. Full procedure in huawei-sandbox skill, Step 7 (Expose via DevBridge).`;
}

// #953: classify a local upload path BEFORE touching the file, so the error names
// the real problem instead of a misleading "not found" when an entire parent
// directory is missing (agent-side paths often do not exist at all).
// kind: 'file' (uploadFileWithSession) | 'directory' (uploadProjectWithSession).
// Returns null when the path exists with the expected type; otherwise an Error
// whose message distinguishes missing-path from missing-parent, with a copy-to-tmp
// hint that names the actual OS temp dir.
export function classifyLocalUploadPath(localPath, kind = 'file') {
  const expected = kind === 'directory' ? 'directory' : 'regular file';
  const prefix = kind === 'directory' ? 'sandbox upload project' : 'sandbox upload';
  if (existsSync(localPath)) {
    const stat = statSync(localPath);
    const matches = kind === 'directory' ? stat.isDirectory() : stat.isFile();
    if (!matches) {
      return new Error(`${prefix}: path is not a ${expected}: ${localPath}`);
    }
    return null;
  }
  const parent = dirname(localPath);
  if (!existsSync(parent)) {
    return new Error(
      `${prefix}: directory not found: ${parent}. The DevKit MCP server reads files from ` +
        `the machine it runs on. Verify the path, or first copy the ${expected} to the local ` +
        `temp directory (${tmpdir()}) and upload from there.`,
    );
  }
  return new Error(`${prefix}: local ${expected} not found: ${localPath}`);
}

// #953: reset command for uploadFileWithSession. mkdir -p the remote parent BEFORE any
// chunk writes — the `printf >>` appends land in "${remotePath}.b64tmp" next to the
// target, so an absent directory (e.g. /workspace/game2048/) would fail the very first
// batch. This aligns base64-path behavior with upload_project's file server (which
// already makedirs). Both paths are quoted; "path with spaces" is covered by tests.
export function buildUploadResetCommand(remotePath, tmpPath) {
  return `mkdir -p "$(dirname "${remotePath}")" && rm -f "${tmpPath}"`;
}

export async function uploadFileWithSession(workspaceId, localPath, remotePath, username = 'root', timeoutMs = 30000) {
  const localError = classifyLocalUploadPath(localPath, 'file');
  if (localError) {
    throw localError;
  }
  const content = readFileSync(localPath);
  const base64 = content.toString('base64');
  const expectedMd5 = createHash('md5').update(content).digest('hex');
  const chunks = splitBase64Chunks(base64);
  const tmp = `${remotePath}.b64tmp`;

  const reset = await execWithSession(workspaceId, buildUploadResetCommand(remotePath, tmp), username, timeoutMs);
  if (reset.exitCode !== 0) {
    throw new Error(`sandbox upload: failed to reset temp file: ${reset.stdout || reset.error || reset.exitCode}`);
  }

  for (let batchStart = 0; batchStart < chunks.length; batchStart += UPLOAD_BATCH_SIZE) {
    const batch = chunks.slice(batchStart, batchStart + UPLOAD_BATCH_SIZE);
    const combinedChunk = batch.join('');
    const batchNum = Math.floor(batchStart / UPLOAD_BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(chunks.length / UPLOAD_BATCH_SIZE);
    const cmd = `printf '%s' '${combinedChunk}' >> "${tmp}"`;

    let batchOk = false;
    let lastError;
    for (let retry = 0; retry < UPLOAD_MAX_RETRIES; retry++) {
      const res = await execWithSession(workspaceId, cmd, username, timeoutMs);
      if (res.exitCode === 0) {
        batchOk = true;
        break;
      }
      lastError = res.stdout || res.error || res.exitCode;
      console.error(`  upload retry ${retry + 1}/${UPLOAD_MAX_RETRIES} for batch ${batchNum}/${totalBatches}`);
      await new Promise((r) => setTimeout(r, 2000));
    }
    if (!batchOk) {
      throw new Error(`sandbox upload: failed writing batch ${batchNum}/${totalBatches}: ${lastError}`);
    }
    if (batchNum % 10 === 0 || batchNum === totalBatches) {
      console.error(`  upload progress: batch ${batchNum}/${totalBatches}`);
    }
  }

  const decode = await execWithSession(
    workspaceId,
    `base64 -d "${tmp}" > "${remotePath}" && rm -f "${tmp}"`,
    username,
    timeoutMs,
  );
  if (decode.exitCode !== 0) {
    throw new Error(
      `sandbox upload: failed decoding to ${remotePath}: ${decode.stdout || decode.error || decode.exitCode}`,
    );
  }

  const verify = await execWithSession(workspaceId, `md5sum "${remotePath}"`, username, timeoutMs);
  let md5Verified = false;
  if (verify.exitCode === 0) {
    const remoteMd5 = String(verify.stdout || '')
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\][^\x07]*\x07/g, '')
      .trim()
      .split(/\s+/)[0];
    md5Verified = remoteMd5 === expectedMd5;
    if (!md5Verified) {
      throw new Error(
        `sandbox upload: md5 mismatch for ${remotePath} (expected ${expectedMd5}, got ${remoteMd5 || 'none'})`,
      );
    }
  }

  return {
    ok: true,
    localPath,
    remotePath,
    bytes: content.length,
    chunks: chunks.length,
    md5: expectedMd5,
    md5Verified,
  };
}

const SANDBOX_FILE_SERVER_SCRIPT = readFileSync(join(__dirname, 'sandbox-file-server.py'), 'utf8');

const TUNNEL_READY_TIMEOUT_MS = 30000;
const SERVER_HEALTH_MAX_RETRIES = 30;
const SERVER_HEALTH_INTERVAL_MS = 1000;
const UPLOAD_LOG_PATH = join(tmpdir(), 'sandbox-upload.log');

function uploadLog(message) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${message}\n`;
  console.error(line.trimEnd());
  try {
    appendFileSync(UPLOAD_LOG_PATH, line);
  } catch {}
}

function rotateUploadLog(maxBytes = 100 * 1024) {
  try {
    if (existsSync(UPLOAD_LOG_PATH)) {
      const stat = statSync(UPLOAD_LOG_PATH);
      if (stat.size > maxBytes) {
        unlinkSync(UPLOAD_LOG_PATH);
      }
    }
  } catch {}
}

function generateUploadToken() {
  return randomBytes(16).toString('hex');
}

async function createTarGz(localDir, exclude = []) {
  const archiveName = `${basename(localDir)}.tar.gz`;
  const archiveDir = join(tmpdir(), `sandbox-upload-${Date.now()}`);
  mkdirSync(archiveDir, { recursive: true });
  const archivePath = join(archiveDir, archiveName);

  const hasGit = existsSync(join(localDir, '.git'));
  if (hasGit) {
    await execFileAsync('git', [
      '-C',
      localDir,
      'archive',
      '--format=tar.gz',
      `--prefix=${basename(localDir)}/`,
      `--output=${archivePath}`,
      'HEAD',
    ]);
  } else {
    const args = [];
    for (const pattern of exclude) {
      if (pattern.startsWith('**/')) {
        const base = pattern.slice(3);
        for (let depth = 0; depth <= 4; depth++) {
          const prefix = depth === 0 ? '' : '*/'.repeat(depth);
          args.push('--exclude', `${prefix}${base}`);
        }
      } else {
        args.push('--exclude', pattern);
      }
    }
    args.push('-czf', archivePath, '-C', dirname(localDir), basename(localDir));
    await execFileAsync('tar', args);
  }

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

function cleanupLocalArchive(archivePath) {
  try {
    rmSync(dirname(archivePath), { recursive: true, force: true });
  } catch {}
}

async function deployFileServer(workspaceId, username, port = 8888, token = '') {
  const scriptPath = '/tmp/sandbox-file-server.py';
  const pidFile = '/tmp/sandbox-file-server.pid';
  uploadLog(`deployFileServer: killing old server (pidFile=${pidFile})`);
  await execWithSession(workspaceId, `kill $(cat ${pidFile} 2>/dev/null) 2>/dev/null; rm -f ${pidFile}`, username);
  const b64 = Buffer.from(SANDBOX_FILE_SERVER_SCRIPT).toString('base64');
  uploadLog(`deployFileServer: writing script (${b64.length} b64 chars)`);
  await execWithSession(workspaceId, `echo '${b64}' | base64 -d > ${scriptPath}`, username);
  const cmd = token
    ? `python3 ${scriptPath} ${port} ${token} & echo $! > ${pidFile}`
    : `python3 ${scriptPath} ${port} & echo $! > ${pidFile}`;
  uploadLog(`deployFileServer: starting server on port ${port}`);
  const startResult = await execWithSession(workspaceId, cmd, username);
  uploadLog(
    `deployFileServer: start result exitCode=${startResult.exitCode} stdout=${JSON.stringify(startResult.stdout?.slice(0, 200))}`,
  );
  return startResult;
}

async function uploadViaTunnel(localPort, archivePath, archiveSize, archiveRemotePath, uploadToken, timeoutMs) {
  const archiveBuffer = readFileSync(archivePath);
  const headers = [
    'POST /upload HTTP/1.1',
    'Host: localhost',
    'Content-Type: application/octet-stream',
    `Content-Length: ${archiveSize}`,
    `X-Target-Path: ${archiveRemotePath}`,
    `X-Upload-Token: ${uploadToken}`,
    'Connection: close',
    '',
    '',
  ].join('\r\n');
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        sock.destroy();
        fn();
      }
    };
    const timer = setTimeout(() => done(() => reject(new Error(`upload timeout after ${timeoutMs}ms`))), timeoutMs);
    const sock = netConnect({ host: '127.0.0.1', port: localPort }, () => {
      sock.write(headers);
      sock.write(archiveBuffer);
    });
    let respBuf = Buffer.alloc(0);
    let contentLength = -1;
    let headerEnd = -1;
    sock.on('data', (chunk) => {
      respBuf = Buffer.concat([respBuf, chunk]);
      if (contentLength < 0) {
        const resp = respBuf.toString();
        headerEnd = resp.indexOf('\r\n\r\n');
        if (headerEnd > 0) {
          const headerBlock = resp.slice(0, headerEnd);
          const clMatch = headerBlock.match(/Content-Length:\s*(\d+)/i);
          if (clMatch) contentLength = parseInt(clMatch[1], 10);
        }
      }
      if (contentLength >= 0 && headerEnd > 0) {
        const bodyReceived = respBuf.length - (headerEnd + 4);
        if (bodyReceived >= contentLength) {
          done(() => {
            const resp = respBuf.toString();
            const statusLine = resp.split('\r\n')[0] || '';
            const statusCode = parseInt(statusLine.split(' ')[1], 10);
            const body = resp.slice(headerEnd + 4, headerEnd + 4 + contentLength);
            if (!statusCode || statusCode < 200 || statusCode >= 300) {
              uploadLog(`uploadViaTunnel: POST failed with HTTP ${statusCode}: ${body.slice(0, 200)}`);
              reject(new Error(`upload HTTP ${statusCode}: ${body}`));
              return;
            }
            try {
              resolve(JSON.parse(body));
            } catch (error) {
              reject(new Error(`invalid JSON response: ${body.slice(0, 200)}`));
            }
          });
        }
      }
    });
    sock.on('close', () => {
      done(() => {
        const resp = respBuf.toString();
        const statusLine = resp.split('\r\n')[0] || '';
        const statusCode = parseInt(statusLine.split(' ')[1], 10);
        const he = resp.indexOf('\r\n\r\n');
        const body = he > 0 ? resp.slice(he + 4) : '';
        if (!statusCode || statusCode < 200 || statusCode >= 300) {
          uploadLog(`uploadViaTunnel: POST failed with HTTP ${statusCode}: ${body.slice(0, 200)}`);
          reject(new Error(`upload HTTP ${statusCode}: ${body}`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(new Error(`invalid JSON response: ${body.slice(0, 200)}`));
        }
      });
    });
    sock.on('error', (err) => {
      done(() => {
        uploadLog(`uploadViaTunnel: socket error: ${err.message}`);
        reject(err);
      });
    });
  });
}

async function waitForServerReady(localPort) {
  for (let i = 0; i < SERVER_HEALTH_MAX_RETRIES; i++) {
    try {
      uploadLog(`waitForServerReady: attempt ${i + 1}, checking http://localhost:${localPort}/health`);
      const ok = await new Promise((resolve) => {
        let settled = false;
        const done = (val) => {
          if (!settled) {
            settled = true;
            sock.destroy();
            resolve(val);
          }
        };
        const sock = netConnect({ host: '127.0.0.1', port: localPort }, () => {
          sock.write('GET /health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n');
        });
        let resp = '';
        sock.on('data', (c) => {
          resp += c.toString();
          if (resp.includes('200 OK')) done(true);
        });
        sock.on('close', () => done(resp.includes('200 OK')));
        sock.on('error', () => done(false));
        setTimeout(() => done(false), 3000);
      });
      if (ok) {
        uploadLog(`waitForServerReady: server ready on port ${localPort} after ${i} retries`);
        return;
      }
      uploadLog(`waitForServerReady: health check returned non-200 (retry ${i + 1})`);
    } catch (error) {
      uploadLog(`waitForServerReady: health check failed: ${error.message} (retry ${i + 1})`);
    }
    await new Promise((r) => setTimeout(r, SERVER_HEALTH_INTERVAL_MS));
  }
  throw new Error(
    `sandbox file server not ready after ${SERVER_HEALTH_MAX_RETRIES * SERVER_HEALTH_INTERVAL_MS}ms (log: ${UPLOAD_LOG_PATH})`,
  );
}

async function cleanupFileServer(workspaceId, username) {
  const pidFile = '/tmp/sandbox-file-server.pid';
  const scriptPath = '/tmp/sandbox-file-server.py';
  await execWithSession(workspaceId, `kill $(cat ${pidFile}) 2>/dev/null; rm -f ${pidFile} ${scriptPath}`, username);
}

async function uploadViaHttpTunnel(workspaceId, archivePath, archiveRemotePath, username, timeoutMs, options) {
  const sandboxPort = options.sandboxPort || 8888;
  const uploadToken = generateUploadToken();
  const archiveSize = statSync(archivePath).size;

  uploadLog(
    `uploadViaHttpTunnel: start (archive=${archivePath}, size=${archiveSize}, remotePath=${archiveRemotePath})`,
  );

  uploadLog(`uploadViaHttpTunnel: deploying file server on sandbox port ${sandboxPort}`);
  await deployFileServer(workspaceId, username, sandboxPort, uploadToken);

  uploadLog(`uploadViaHttpTunnel: creating dedicated tunnel session`);
  const tunnelSession = await createTunnelSession(workspaceId, username);

  uploadLog(`uploadViaHttpTunnel: creating tunnel channel (localPort=0, remotePort=${sandboxPort})`);
  const { HwlinkTunnelChannel } = await import(WS_EXEC_INDEX_URL);
  const tunnel = new HwlinkTunnelChannel({
    localPort: 0,
    remotePort: sandboxPort,
  });
  tunnel.attach(tunnelSession.mux);

  uploadLog(`uploadViaHttpTunnel: waiting for tunnel ready (timeout=${TUNNEL_READY_TIMEOUT_MS}ms)`);
  try {
    await Promise.race([
      tunnel.ready,
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error(`tunnel ready timeout after ${TUNNEL_READY_TIMEOUT_MS}ms`)),
          TUNNEL_READY_TIMEOUT_MS,
        ),
      ),
    ]);
    uploadLog(`uploadViaHttpTunnel: tunnel ready, localPort=${tunnel.localPort}`);
  } catch (tunnelReadyError) {
    uploadLog(`uploadViaHttpTunnel: TUNNEL READY FAILED: ${tunnelReadyError.message}`);
    tunnel.close();
    throw new Error(
      `HTTP tunnel failed to establish: ${tunnelReadyError.message}. ` +
        `This means the WebSocket port-forwarding channel to sandbox port ${sandboxPort} could not be opened. ` +
        `Common causes: (1) Python file server not running on sandbox, (2) sandbox port ${sandboxPort} blocked, ` +
        `(3) hwlink multiplexer channel rejected. ` +
        `Diagnostic log: ${UPLOAD_LOG_PATH}`,
      { cause: tunnelReadyError },
    );
  }

  try {
    uploadLog(`uploadViaHttpTunnel: waiting for server health on localhost:${tunnel.localPort}`);
    await waitForServerReady(tunnel.localPort);

    uploadLog(`uploadViaHttpTunnel: sending POST with ${archiveSize} bytes`);
    const result = await uploadViaTunnel(
      tunnel.localPort,
      archivePath,
      archiveSize,
      archiveRemotePath,
      uploadToken,
      timeoutMs,
    );
    uploadLog(`uploadViaHttpTunnel: upload complete (bytes=${result.bytes}, md5=${result.md5})`);
    return result;
  } catch (uploadError) {
    uploadLog(`uploadViaHttpTunnel: UPLOAD FAILED: ${uploadError.message}`);
    throw uploadError;
  } finally {
    tunnel.close();
    tunnelSession.close();
  }
}

export async function uploadProjectWithSession(
  workspaceId,
  localDir,
  remoteDir,
  username = 'root',
  timeoutMs = 300000,
  options = {},
) {
  if (!workspaceId) {
    throw new Error(
      'sandbox upload project: workspace_id is required. ' +
        'Set HW_WORKSPACE_ID env var or ensure huaweicloud_sandbox_connect was called first.',
    );
  }
  const localError = classifyLocalUploadPath(localDir, 'directory');
  if (localError) {
    throw localError;
  }

  rotateUploadLog();

  const projectName = basename(localDir);
  const targetParentDir = remoteDir || '/workspace';
  const archiveRemotePath = `${targetParentDir}/${projectName}.tar.gz`;

  const archivePath = await createTarGz(localDir, options.exclude);
  const archiveSize = statSync(archivePath).size;
  const expectedMd5 = await computeMd5(archivePath);

  uploadLog(`uploadProject: ${localDir} -> ${archiveRemotePath} (archive=${archiveSize} bytes, md5=${expectedMd5})`);

  const SIZE_50MB = 50 * 1024 * 1024;
  if (archiveSize > SIZE_50MB) {
    uploadLog(
      `uploadProject: archive size ${(archiveSize / (1024 * 1024)).toFixed(1)}MB exceeds 50MB. ` +
        `Dependencies or platform binaries may have been included. ` +
        `Ensure exclude list contains "**/node_modules" to match all nesting levels.`,
    );
  }

  let result;
  let tunnelError;
  for (let attempt = 0; attempt < UPLOAD_MAX_RETRIES; attempt++) {
    try {
      await cleanupFileServer(workspaceId, username).catch(() => {});
      result = await uploadViaHttpTunnel(workspaceId, archivePath, archiveRemotePath, username, timeoutMs, options);
      tunnelError = null;
      break;
    } catch (error) {
      tunnelError = error;
      const errorType = error.code || error.name || 'unknown';
      uploadLog(`uploadProject: attempt ${attempt + 1}/${UPLOAD_MAX_RETRIES} failed [${errorType}]: ${error.message}`);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  if (tunnelError) {
    uploadLog(`uploadProject: all ${UPLOAD_MAX_RETRIES} attempts failed: ${tunnelError.message}`);
    uploadLog(`uploadProject: NOT falling back to base64 (removed). Rethrowing with diagnostics.`);
    cleanupLocalArchive(archivePath);
    throw new Error(
      `sandbox upload failed after ${UPLOAD_MAX_RETRIES} attempts: HTTP tunnel could not transfer the project archive. ` +
        `Archive size: ${(archiveSize / 1024).toFixed(1)}KB. ` +
        `Root cause: ${tunnelError.message}. ` +
        `Diagnostic log: ${UPLOAD_LOG_PATH}`,
      { cause: tunnelError },
    );
  }

  if (options.verify !== false && result.md5 && result.md5 !== expectedMd5) {
    throw new Error(`md5 mismatch: expected ${expectedMd5}, got ${result.md5}`);
  }

  if (options.extract !== false) {
    await execWithSession(
      workspaceId,
      `mkdir -p "${targetParentDir}" && tar -xzf "${archiveRemotePath}" -C "${targetParentDir}" && rm -f "${archiveRemotePath}"`,
      username,
      timeoutMs,
    );
    try {
      await execWithSession(
        workspaceId,
        [
          `REAL_PATH=$(readlink -f "${targetParentDir}/${projectName}" 2>/dev/null || echo "${targetParentDir}/${projectName}")`,
          `if [ ! -d "$REAL_PATH" ] && [ -d "${targetParentDir}" ]; then`,
          `  REAL_PATH="${targetParentDir}/${projectName}"`,
          `fi`,
          `chmod -R o+rX "$REAL_PATH" 2>/dev/null || true`,
          `find "$REAL_PATH" -type d -exec chmod o+x {} \\; 2>/dev/null || true`,
          `find "$REAL_PATH" -type f -path "*/node_modules/.bin/*" -exec chmod +x {} \\; 2>/dev/null || true`,
        ].join('\n'),
        username,
        15000,
      );
    } catch {}
  }

  try {
    await cleanupFileServer(workspaceId, username);
  } catch {}
  cleanupLocalArchive(archivePath);

  return {
    ok: true,
    localDir,
    remotePath: options.extract !== false ? `${targetParentDir}/${projectName}` : archiveRemotePath,
    bytes: result.bytes || 0,
    md5: result.md5 || expectedMd5,
    md5Verified: result.md5 ? result.md5 === expectedMd5 : true,
    extracted: options.extract !== false,
  };
}

// A1 (#935): normalize the deploy_nginx configName to a bare filename. A value
// carrying path separators (e.g. `/root/hc-activity.conf`, `./x/y.conf`) used to
// be spliced verbatim into `/etc/nginx/conf.d/${configName}.conf`, producing the
// broken path `/etc/nginx/conf.d//root/hc-activity.conf` (nginx never serves it,
// the tunnel answers 502). Only the basename is kept and the `.conf` suffix is
// stripped before the path is rebuilt as `/etc/nginx/conf.d/<name>.conf`. A
// pure filename (no separators) keeps the previous behavior unchanged.
export function resolveNginxConfigPath(configName, project) {
  const raw = String(configName || project || '');
  const base = raw.split(/[\\/]/).filter(Boolean).pop() || '';
  const name = base.replace(/\.conf$/i, '') || 'default';
  return `/etc/nginx/conf.d/${name}.conf`;
}

// A1 (#935): parse the write-verification block appended to the deploy_nginx
// script. The old flow returned ok:true whenever the deploy script exited 0,
// even when the tee write silently failed — the config file never existed and
// the tunnel answered 502. The verification block emits explicit markers:
//   DB_NGINX_CONFIG_MISSING=1  — the target config file does not exist
//   DB_NGINX_T=PASS|FAIL       — nginx -t verdict, with failure output echoed
//                                as `DB_NGINX_T_OUTPUT: ...` lines
export function parseDeployNginxVerifyOutput(stdout) {
  const text = String(stdout || '');
  const configMissing = /DB_NGINX_CONFIG_MISSING=1/.test(text);
  const nginxTest = (text.match(/^DB_NGINX_T=(\w+)$/m) || [])[1] || '';
  const nginxTestOutput = (text.match(/^DB_NGINX_T_OUTPUT: .*$/gm) || [])
    .map((line) => line.replace(/^DB_NGINX_T_OUTPUT: /, ''))
    .join('\n');
  return { configMissing, nginxTest, nginxTestOutput };
}

// A1 (#935): the deploy verdict. A deploy script exit of 0 alone is NOT proof
// of success — the tee write can fail silently (broken pipe) and nginx -t can
// reject the config. Returns ok:false with an explicit, actionable error for
// any verification failure; a pure function so the verdict is unit-testable.
export function evaluateDeployNginxVerify(result, verify, configPath) {
  const exitCode = result?.exitCode;
  const writeVerified = exitCode === 0 && !verify.configMissing && verify.nginxTest === 'PASS';
  if (writeVerified) return { ok: true };
  const problems = [];
  if (exitCode !== 0) problems.push(`deploy script exited with code ${exitCode}`);
  if (verify.configMissing) problems.push(`nginx config file ${configPath} was not created (tee write failed)`);
  if (verify.nginxTest !== 'PASS')
    problems.push(`nginx -t did not pass${verify.nginxTestOutput ? ` — ${verify.nginxTestOutput}` : ''}`);
  return {
    ok: false,
    error: `sandbox deploy nginx: configuration write verification failed — ${problems.join('; ')}.`,
  };
}

export async function deployNginx(
  workspaceId,
  { nginxType, port, project, outputDir, nodePort, publicPort, configName },
  username = 'root',
  timeoutMs = 60000,
) {
  if (!workspaceId) {
    throw new Error('sandbox deploy nginx: workspace_id is required.');
  }
  if (!nginxType || !port || !project || !outputDir) {
    throw new Error('sandbox deploy nginx: nginxType, port, project, and outputDir are required.');
  }

  const nginxCheck = await execOneShot(
    workspaceId,
    'command -v nginx >/dev/null 2>&1 && echo "INSTALLED" || echo "MISSING"',
    username,
    10000,
  );
  if (!String(nginxCheck.stdout || '').includes('INSTALLED')) {
    throw new Error(
      'sandbox deploy nginx: nginx is not installed. Install it first:\n' +
        '  Detect OS: source /etc/os-release && echo $ID\n' +
        '  apt: sudo apt-get update -qq && sudo apt-get install -y -qq nginx\n' +
        '  yum: sudo yum install -y nginx\n' +
        '  dnf: sudo dnf install -y nginx\n' +
        'Alternatively, skip nginx and use Python HTTP server (see nginx-templates.md).',
    );
  }

  const listenPort = publicPort || port;
  const basePort = nginxType === 'proxy' ? listenPort : port;

  let targetPort = basePort;
  const maxPortAttempts = 10;
  for (let offset = 0; offset < maxPortAttempts; offset += 1) {
    targetPort = basePort + offset;
    try {
      const portCheck = await execOneShot(
        workspaceId,
        `ss -tlnp 2>/dev/null | grep -q ":${targetPort} " && echo "IN_USE" || echo "FREE"`,
        username,
        10000,
      );
      if (!String(portCheck.stdout || '').includes('IN_USE')) break;
    } catch {}
    if (offset === maxPortAttempts - 1) {
      throw new Error(
        `sandbox deploy nginx: all ports ${basePort}-${basePort + maxPortAttempts - 1} are in use. Free a port and try again.`,
      );
    }
  }

  const effectiveNodePort =
    nginxType === 'proxy'
      ? await resolveProxyNodePort(nodePort, targetPort, async (candidate) => {
          const portCheck = await execOneShot(
            workspaceId,
            `ss -tlnp 2>/dev/null | grep -q ":${candidate} " && echo "IN_USE" || echo "FREE"`,
            username,
            10000,
          );
          return String(portCheck.stdout || '').includes('IN_USE');
        })
      : undefined;

  const projectPath = `/workspace/${project}`;
  const outputPath = outputDir.startsWith('/') ? outputDir : `${projectPath}/${outputDir}`;

  const resolveScript = `REAL_PROJECT=$(readlink -f "${projectPath}" 2>/dev/null || echo "${projectPath}")
REAL_OUTPUT="${outputPath}"
if [ "\${REAL_PROJECT}" != "${projectPath}" ]; then
  REL_OUTPUT=$(echo "${outputDir}" | sed "s|${projectPath}/||")
  REAL_OUTPUT="\${REAL_PROJECT}/\${REL_OUTPUT}"
fi`;

  const templates = {
    spa: `server {
    listen ${targetPort};
    root ${outputPath};
    index index.html;

    location / {
        try_files $uri /index.html;
    }

    location ~* \\.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot)$ {
        expires 1h;
        add_header Cache-Control "public, immutable";
    }
}`,
    proxy: `server {
    listen ${targetPort};
    server_name _;
    large_client_header_buffers 4 32k;

    location / {
        proxy_pass http://127.0.0.1:${effectiveNodePort};
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
        proxy_read_timeout 60s;
        proxy_buffer_size 128k;
        proxy_buffers 4 256k;
        proxy_busy_buffers_size 256k;
    }
}`,
    static: `server {
    listen ${targetPort};
    root ${outputPath};
    index index.html;

    location / {
        try_files $uri $uri.html $uri/ =404;
        autoindex off;
    }

    location ~* \\.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot)$ {
        expires 1h;
        add_header Cache-Control "public, immutable";
    }
}`,
  };

  const config = templates[nginxType];
  if (!config) {
    throw new Error(`sandbox deploy nginx: unknown nginxType "${nginxType}". Must be one of: spa, proxy, static`);
  }

  // A1 (#935): configName is normalized to a bare filename so a path-shaped
  // value can never produce `/etc/nginx/conf.d//root/xxx.conf` again.
  const configPath = resolveNginxConfigPath(configName, project);

  const cmd = [
    resolveScript,
    `sudo mkdir -p /etc/nginx/conf.d`,
    `sudo tee ${configPath} > /dev/null << 'NGINX_EOF'`,
    config,
    `NGINX_EOF`,
    `# Resolve symlinks for chmod (chmod does not follow symlinks on Linux)`,
    `chmod -R o+rX "$REAL_PROJECT" 2>/dev/null || true`,
    `find "$REAL_PROJECT" -type d -exec chmod o+x {} \\; 2>/dev/null || true`,
    `find "$REAL_PROJECT" -type f -path "*/node_modules/.bin/*" -exec chmod +x {} \\; 2>/dev/null || true`,
    `if pgrep -x nginx > /dev/null 2>&1; then sudo killall -9 nginx 2>/dev/null; sleep 1; fi
    sudo nginx`,
    `# A1 (#935): verify the config write took effect before reporting success`,
    `NGINX_CONFIG_PATH=${configPath}`,
    `if [ ! -f "$NGINX_CONFIG_PATH" ]; then echo "DB_NGINX_CONFIG_MISSING=1"; fi`,
    `NGINX_T_OUTPUT=$(sudo nginx -t 2>&1 || true)`,
    `if echo "$NGINX_T_OUTPUT" | grep -Eq "syntax is ok|test is successful"; then echo "DB_NGINX_T=PASS"; else echo "DB_NGINX_T=FAIL"; echo "$NGINX_T_OUTPUT" | sed "s/^/DB_NGINX_T_OUTPUT: /"; fi`,
  ].join('\n');

  const result = await execOneShot(workspaceId, cmd, username, timeoutMs);

  let tunnelActive = false;
  try {
    // Version-aware: devbridge 0.1.x exposes JSON via `list -j`; 0.2.x removed -j and
    // prints a table whose data rows start with the 8-char base32 tunnel ID.
    const tunnelCheck = await execOneShot(
      workspaceId,
      '(devbridge list -j 2>/dev/null | grep -q \'"tunnelId"\' || devbridge list 2>/dev/null | grep -Eq \'^[a-z2-7]{8}[[:space:]]\') && echo "ACTIVE" || echo "INACTIVE"',
      username,
      10000,
    );
    tunnelActive = String(tunnelCheck.stdout || '').includes('ACTIVE');
  } catch {}

  const warnings = [];
  if (!tunnelActive) {
    warnings.push('No active DevBridge tunnel — deployment is incomplete. Proceed to Step 7 to expose the app.');
  }
  const conflictWarning = formatPortConflictWarning(basePort, targetPort);
  if (conflictWarning) warnings.push(conflictWarning);
  const driftWarning = tunnelActive ? formatPortDriftWarning(basePort, targetPort) : undefined;
  if (driftWarning) warnings.push(driftWarning);

  // A1 (#935): verify the config write before reporting success. Any
  // verification failure returns ok:false with an explicit, actionable error.
  const verify = parseDeployNginxVerifyOutput(result.stdout);
  const verdict = evaluateDeployNginxVerify(result, verify, configPath);
  if (!verdict.ok) {
    return {
      ok: false,
      error: verdict.error,
      nginxType,
      port: targetPort,
      nodePort: effectiveNodePort || undefined,
      outputPath,
      projectPath,
      configPath,
      exitCode: result.exitCode,
      stdout: result.stdout,
      nextStep: 'fix_and_retry',
      warning: warnings.length > 0 ? warnings.join(' | ') : undefined,
    };
  }

  return {
    ok: true,
    nginxType,
    port: targetPort,
    nodePort: effectiveNodePort || undefined,
    outputPath,
    projectPath,
    configPath,
    verification: { configPath, nginxTest: verify.nginxTest },
    exitCode: result.exitCode,
    stdout: result.stdout,
    nextStep: 'expose_via_devbridge',
    warning: warnings.length > 0 ? warnings.join(' | ') : undefined,
  };
}

export async function deployCheck(
  workspaceId,
  { port, project, outputDir, frameworkType },
  username = 'root',
  timeoutMs = 30000,
) {
  if (!workspaceId) {
    throw new Error('sandbox deploy check: workspace_id is required.');
  }

  const projectPath = `/workspace/${project}`;
  const outputPath = outputDir.startsWith('/') ? outputDir : `${projectPath}/${outputDir}`;
  const isCrossPlatform = frameworkType === 'cross-platform';

  const checkScript = buildDeployCheckScript({ port, project, outputPath, isCrossPlatform });
  const result = await execOneShot(workspaceId, checkScript, username, timeoutMs);
  const stdout = String(result.stdout || '');
  return parseDeployCheckOutput(stdout, { port, isCrossPlatform });
}

export function buildDeployCheckScript({ port, project, outputPath, isCrossPlatform: _isCrossPlatform }) {
  return [
    `echo "=== DEPLOY CHECK ==="`,
    `PASS=0`,
    `TOTAL=0`,
    ``,
    `TOTAL=$((TOTAL+1))`,
    `HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:${port} 2>/dev/null)`,
    `if [ -n "$HTTP_CODE" ] && [ "$HTTP_CODE" != "000" ]; then`,
    `  echo "nginx_serving:PASS (port ${port}, HTTP \${HTTP_CODE})"`,
    `  PASS=$((PASS+1))`,
    `else`,
    `  echo "nginx_serving:FAIL (port ${port}, no HTTP response)"`,
    `fi`,
    ``,
    `TOTAL=$((TOTAL+1))`,
    `if [ -d "${outputPath}" ] && ls -A "${outputPath}" 2>/dev/null | grep -q .; then`,
    `  echo "output_dir:PASS (${outputPath})"`,
    `  PASS=$((PASS+1))`,
    `else`,
    `  echo "output_dir:FAIL (${outputPath} empty or missing)"`,
    `fi`,
    ``,
    `TOTAL=$((TOTAL+1))`,
    `FINGERPRINT_FILE="${outputPath}/.deploy_fingerprint"`,
    `FINGERPRINT_EXPECTED=$(cat "$FINGERPRINT_FILE" 2>/dev/null)`,
    `if [ -n "$FINGERPRINT_EXPECTED" ]; then`,
    `  FINGERPRINT_ACTUAL=$(curl -s http://localhost:${port}/.deploy_fingerprint 2>/dev/null)`,
    `  if [ "$FINGERPRINT_EXPECTED" = "$FINGERPRINT_ACTUAL" ]; then`,
    `    echo "content_verified:PASS"`,
    `    PASS=$((PASS+1))`,
    `  else`,
    `    echo "content_verified:FAIL (fingerprint mismatch — nginx may be serving stale content from a previous deployment)"`,
    `  fi`,
    `else`,
    `  echo "content_verified:SKIP (no fingerprint file)"`,
    `  TOTAL=$((TOTAL-1))`,
    `fi`,
    ``,
    `TOTAL=$((TOTAL+1))`,
    `DB_TUNNEL_ACTIVE=0`,
    `if devbridge list -j 2>/dev/null | grep -q '"tunnelId"'; then`,
    `  DB_TUNNEL_ACTIVE=1`,
    `elif devbridge list 2>/dev/null | grep -Eq '^[a-z2-7]{8}[[:space:]]'; then`,
    `  DB_TUNNEL_ACTIVE=1`,
    `fi`,
    `if [ "$DB_TUNNEL_ACTIVE" = "1" ]; then`,
    `  echo "devbridge_tunnel:PASS"`,
    `  PASS=$((PASS+1))`,
    `else`,
    `  echo "devbridge_tunnel:FAIL"`,
    `fi`,
    ``,
    `TOTAL=$((TOTAL+1))`,
    `TUNNEL_IDS=$(devbridge list -j 2>/dev/null | grep -oP '"tunnelId":\\s*"\\K[^"]+' | head -5)`,
    `if [ -z "$TUNNEL_IDS" ]; then`,
    `  TUNNEL_IDS=$(devbridge list 2>/dev/null | grep -E '^[a-z2-7]{8}[[:space:]]' | awk '{print $1}' | head -5)`,
    `fi`,
    `# Gateway-level tunnel errors have exact text/plain bodies (verified on the s2`,
    `# gateway): 404 "tunnel not found" = no live host session (the tunnel RECORD may`,
    `# still be in \`list\`); 404 "port not configured" = URL port not registered; 502`,
    `# "bad gateway" = tunnel alive, local service down. grep -x (exact-line match) +`,
    `# status gating avoids flagging app-generated 404/502 pages.`,
    `probe_tunnel() {`,
    `  local url="$1" code`,
    `  code=$(curl -s -o /tmp/.dc_tunnel_body -w "%{http_code}" --max-time 5 "$url" 2>/dev/null)`,
    `  PROBE_FAIL_REASON=""`,
    `  if [ "$code" = "000" ]; then PROBE_FAIL_REASON="unreachable"; rm -f /tmp/.dc_tunnel_body; return 1; fi`,
    `  if grep -q "${DEVBRIDGE_MIGRATION_MARKER}" /tmp/.dc_tunnel_body 2>/dev/null; then PROBE_FAIL_REASON="migration placeholder page"; rm -f /tmp/.dc_tunnel_body; return 1; fi`,
    `  if [ "$code" = "404" ] && grep -qx "${DEVBRIDGE_TUNNEL_NOT_FOUND_MARKER}" /tmp/.dc_tunnel_body 2>/dev/null; then PROBE_FAIL_REASON="tunnel not found (no live host session on the gateway)"; rm -f /tmp/.dc_tunnel_body; return 1; fi`,
    `  if [ "$code" = "404" ] && grep -qx "${DEVBRIDGE_PORT_NOT_CONFIGURED_MARKER}" /tmp/.dc_tunnel_body 2>/dev/null; then PROBE_FAIL_REASON="port not configured (URL port not registered on the tunnel)"; rm -f /tmp/.dc_tunnel_body; return 1; fi`,
    `  if [ "$code" = "502" ] && grep -qx "${DEVBRIDGE_BAD_GATEWAY_MARKER}" /tmp/.dc_tunnel_body 2>/dev/null; then PROBE_FAIL_REASON="bad gateway (tunnel alive, local service not serving)"; rm -f /tmp/.dc_tunnel_body; return 1; fi`,
    `  rm -f /tmp/.dc_tunnel_body`,
    `  return 0`,
    `}`,
    `# Probe each listed tunnel (bounded to 5) and select the first one that actually`,
    `# serves this port — \`devbridge list\` order is arbitrary, so a stale tunnel listed`,
    `# first must not shadow the live one.`,
    `SELECTED_URL=""`,
    `FIRST_ID=""`,
    `for CAND in $TUNNEL_IDS; do`,
    `  if [ -z "$FIRST_ID" ]; then FIRST_ID="$CAND"; fi`,
    `  CAND_URL="https://\${CAND}-${port}.${DEVBRIDGE_TUNNEL_DOMAIN}"`,
    `  if probe_tunnel "$CAND_URL"; then`,
    `    SELECTED_URL="$CAND_URL"`,
    `    break`,
    `  fi`,
    `done`,
    `TUNNEL_URL="$SELECTED_URL"`,
    `if [ -n "$SELECTED_URL" ]; then`,
    `  echo "tunnel_url_accessible:PASS ($SELECTED_URL)"`,
    `  PASS=$((PASS+1))`,
    `elif [ -n "$FIRST_ID" ]; then`,
    `  echo "tunnel_url_accessible:FAIL (https://\${FIRST_ID}-${port}.${DEVBRIDGE_TUNNEL_DOMAIN} -> $PROBE_FAIL_REASON)"`,
    `else`,
    `  echo "tunnel_url_accessible:FAIL (no tunnel)"`,
    `fi`,
    ``,
    `${`
TOTAL=$((TOTAL+1))
if [ -f "${outputPath}/qr.png" ]; then
  echo "qr_code:PASS"
  PASS=$((PASS+1))
else
  # Auto-detect cross-platform from project files (more reliable than frameworkType param)
  PROJ_DIR="/workspace/${project}"
  IS_CROSS=0
  if [ -f "$PROJ_DIR/manifest.json" ] || grep -qE '"@tarojs/taro"|"@dcloudio/uni-app"' "$PROJ_DIR/package.json" 2>/dev/null; then
    IS_CROSS=1
  fi
  if [ $IS_CROSS -eq 0 ] && ( [ -f "$PROJ_DIR/app.config.ts" ] || [ -f "$PROJ_DIR/app.config.js" ] ) && grep -qE "pages|tabBar" "$PROJ_DIR/app.config."* 2>/dev/null; then
    IS_CROSS=1
  fi

  if [ $IS_CROSS -eq 1 ]; then
    if [ -n "$TUNNEL_URL" ]; then
      curl -s "https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=$(python3 -c "import urllib.parse, sys; print(urllib.parse.quote(sys.argv[1]))" "$TUNNEL_URL" 2>/dev/null)" -o "${outputPath}/qr.png" 2>/dev/null
      chmod o+r "${outputPath}/qr.png" 2>/dev/null || true
      if [ -f "${outputPath}/qr.png" ] && [ -s "${outputPath}/qr.png" ]; then
        echo "qr_code:PASS (auto-generated)"
        PASS=$((PASS+1))
      else
        echo "qr_code:FAIL (QR generation failed)"
      fi
    else
      echo "qr_code:FAIL (no tunnel URL for QR generation)"
    fi
  else
    echo "qr_code:SKIP (not a cross-platform project)"
    TOTAL=$((TOTAL-1))
  fi
fi
`}`,
    `echo "SCORE:\${PASS}/\${TOTAL}"`,
    `echo "TUNNEL_URL:\${TUNNEL_URL:-}"`,
    `[ "\${PASS}" = "\${TOTAL}" ] && echo "VERDICT:COMPLETE" || echo "VERDICT:INCOMPLETE"`,
  ]
    .filter(Boolean)
    .join('\n');
}

// Strip terminal escape sequences from sandbox command output (#946): CSI
// color/cursor codes and OSC shell-integration markers (shells with integration
// enabled wrap EVERY line in \x1b]133;C\x07, which blinds anchored ^DB_...=
// parsers), then normalize \r\n / \r line endings to \n.
// Use new RegExp to avoid ESLint no-control-regex on literal control chars.
export function stripTerminalEscapes(text) {
  const ESC = '\x1b';
  const csiRe = new RegExp(ESC + '\\[[0-9;]*[a-zA-Z]', 'g');
  const oscRe = new RegExp(ESC + '\\][^' + ESC + '\x07]*(?:\x07|' + ESC + '\\\\)', 'g');
  return String(text || '')
    .replace(csiRe, '')
    .replace(oscRe, '')
    .replace(/\r\n|\r/g, '\n');
}

export function parseDeployCheckOutput(stdout, { port, isCrossPlatform } = {}) {
  // Strip ANSI escape sequences (CSI color/cursor codes and OSC shell-integration markers)
  // and split on any line-ending style (\r\n, \r, or \n) to handle all terminal outputs.
  const cleanStdout = stripTerminalEscapes(stdout);
  const checks = {};
  const lines = cleanStdout.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    const m = trimmed.match(/^(\w+):(PASS|FAIL|SKIP)\b(.*)/);
    if (m) checks[m[1]] = { status: m[2], detail: (m[3] || '').trim() };
  }
  const scoreMatch = cleanStdout.match(/SCORE:(\d+)\/(\d+)/);
  const tunnelMatch = cleanStdout.match(TUNNEL_URL_PATTERN);
  const complete = /VERDICT:COMPLETE/.test(cleanStdout);

  const missing = [];
  if (!complete) {
    for (const [key, val] of Object.entries(checks)) {
      if (val.status === 'FAIL') missing.push(key);
    }
  }

  // If checks is empty but score was found, parsing failed — return raw output for debugging
  const parseWarning =
    Object.keys(checks).length === 0 && scoreMatch
      ? 'Check output parsing failed — individual check results could not be extracted. See rawOutput for details.'
      : undefined;

  const nextStepValue = !complete
    ? missing.includes('devbridge_tunnel') || missing.includes('tunnel_url_accessible')
      ? 'expose_via_devbridge'
      : missing.includes('nginx_serving')
        ? 'configure_nginx'
        : missing.includes('qr_code')
          ? 'generate_qr_code'
          : parseWarning
            ? 'review_raw_output'
            : 'review_checks'
    : 'complete';

  return {
    ok: true,
    complete,
    checkType: isCrossPlatform ? 'cross-platform' : 'standard',
    checks,
    score: scoreMatch ? { pass: parseInt(scoreMatch[1], 10), total: parseInt(scoreMatch[2], 10) } : null,
    publicUrl: tunnelMatch ? tunnelMatch[1] : undefined,
    missingSteps: missing.length > 0 ? missing.join(', ') : undefined,
    parseWarning,
    rawOutput: parseWarning ? String(stdout || '').trim() : undefined,
    nextStep: nextStepValue,
    remediation: nextStepValue === 'expose_via_devbridge' ? buildExposeRemediation(port) : undefined,
  };
}

export async function closeSession(workspaceId, username) {
  const key = `${workspaceId}:${username}`;
  const session = sessions.get(key);
  if (!session) return false;
  sessions.delete(key);
  try {
    session.close();
  } catch {}
  trackSandboxDisconnect();
  return true;
}

// Build a shell snippet that authenticates devbridge via a verified waterfall:
//   Tier 1  keyring API Key  — hwcloud keyring get HW_DEVBRIDGE_API_KEY (platform-injected
//           on hd-space-ai-shell images; the value goes to STDERR so 2>&1 is mandatory and
//           the devbridge_ prefix filters "(not found)" / error text). A light revive step
//           (restart the D-Bus session bus + re-unlock the keyring daemon, no dnf) retries
//           once when the first read fails. Preferred: devbridge is deprecating AK/SK auth.
//   Tier 2  AK/SK            — image builds keep --access-key/--secret-key; STS credentials
//           from /tmp/hw_creds.sh need --security-token or the gateway rejects with 401
//           APIGW.0301; 0.1.x binaries additionally advertise --huaweicloud in help.
//   Tier 3  /tmp/hw_api_key  — release builds accept only --api-key; the file is written by
//           huaweicloud_sandbox_credentials from HW_API_KEY / the api_key param.
// Every tier performs a real `devbridge auth login` and verifies with `auth status`
// (must print "Logged in"); on failure the waterfall falls through to the next tier.
// DB_ATTEMPT_* lines are non-sensitive diagnostics for support escalation.
export function buildDevbridgeAuthProbe() {
  return [
    `export PATH="$HOME/.huawei/bin:$PATH"`,
    `export HOME="\${HOME:-/root}"`,
    `DB_OK=0`,
    `db_login_ok() { devbridge auth status 2>/dev/null | grep -q "Logged in"; }`,
    `db_diag() { echo "DB_ATTEMPT_$1=$2"; }`,
    ``,
    `# ---- Tier 1: API Key from the sandbox keyring (platform auto-injection) ----`,
    `HW_DB_KEY=""`,
    `if command -v hwcloud >/dev/null 2>&1; then`,
    `  export DBUS_SESSION_BUS_ADDRESS="\${DBUS_SESSION_BUS_ADDRESS:-unix:path=/run/dbus-session}"`,
    `  HW_DB_KEY=$(hwcloud keyring get HW_DEVBRIDGE_API_KEY 2>&1 || true)`,
    `  case "$HW_DB_KEY" in`,
    `    "devbridge_"*) : ;;`,
    `    *)`,
    `      # Light revive: bus down or a locked/absent keyring daemon — restart both, retry once.`,
    `      if ! pgrep -x dbus-daemon >/dev/null 2>&1 && command -v dbus-daemon >/dev/null 2>&1; then`,
    `        dbus-daemon --session --address="$DBUS_SESSION_BUS_ADDRESS" --fork --nopidfile >/dev/null 2>&1 || true`,
    `        sleep 1`,
    `      fi`,
    `      if command -v gnome-keyring-daemon >/dev/null 2>&1; then`,
    `        pkill -f gnome-keyring-daemon 2>/dev/null || true`,
    `        sleep 1`,
    `        printf '\\n' | gnome-keyring-daemon --unlock >/dev/null 2>&1 || true`,
    `        sleep 1`,
    `        HW_DB_KEY=$(hwcloud keyring get HW_DEVBRIDGE_API_KEY 2>&1 || true)`,
    `      fi`,
    `      case "$HW_DB_KEY" in "devbridge_"*) : ;; *) HW_DB_KEY="";; esac`,
    `      ;;`,
    `  esac`,
    `else`,
    `  db_diag KEYRING "hwcloud-not-installed"`,
    `fi`,
    `if [ -n "$HW_DB_KEY" ]; then`,
    `  devbridge auth login --api-key "$HW_DB_KEY" >/tmp/db_auth.log 2>&1`,
    `  if db_login_ok; then`,
    `    echo "DB_AUTH_MODE=API_KEY_KEYRING"`,
    `    DB_OK=1`,
    `  else`,
    `    db_diag KEYRING "login-failed"`,
    `  fi`,
    `else`,
    `  db_diag KEYRING "no-valid-key"`,
    `fi`,
    ``,
    `# ---- Tier 2: AK/SK from /tmp/hw_creds.sh (image builds; STS needs --security-token) ----`,
    `if [ "$DB_OK" -eq 0 ]; then`,
    `  source /tmp/hw_creds.sh 2>/dev/null`,
    `  if devbridge auth login --help 2>&1 | grep -q -- '--access-key' && [ -n "$HW_ACCESS_KEY" ]; then`,
    `    DB_TOKEN_ARGS=""`,
    `    [ -n "$HW_SECURITY_TOKEN" ] && DB_TOKEN_ARGS="--security-token \\"$HW_SECURITY_TOKEN\\""`,
    `    if devbridge auth login --help 2>&1 | grep -q -- '--huaweicloud'; then`,
    `      devbridge auth login --huaweicloud --access-key "$HW_ACCESS_KEY" --secret-key "$HW_SECRET_KEY" $DB_TOKEN_ARGS >/tmp/db_auth.log 2>&1`,
    `    else`,
    `      devbridge auth login --access-key "$HW_ACCESS_KEY" --secret-key "$HW_SECRET_KEY" $DB_TOKEN_ARGS >/tmp/db_auth.log 2>&1`,
    `    fi`,
    `    if db_login_ok; then`,
    `      echo "DB_AUTH_MODE=AKSK_SUPPORTED"`,
    `      DB_OK=1`,
    `    else`,
    `      db_diag AKSK "login-failed"`,
    `    fi`,
    `  else`,
    `    db_diag AKSK "binary-or-creds-unavailable"`,
    `  fi`,
    `fi`,
    ``,
    `# ---- Tier 3: API Key from /tmp/hw_api_key (release builds, user-provided) ----`,
    `if [ "$DB_OK" -eq 0 ]; then`,
    `  source /tmp/hw_api_key 2>/dev/null`,
    `  if [ -n "$HW_API_KEY" ]; then`,
    `    devbridge auth login --api-key "$HW_API_KEY" >/tmp/db_auth.log 2>&1`,
    `    if db_login_ok; then`,
    `      echo "DB_AUTH_MODE=API_KEY_FILE"`,
    `      DB_OK=1`,
    `    else`,
    `      db_diag APIKEY_FILE "login-failed"`,
    `    fi`,
    `  else`,
    `    db_diag APIKEY_FILE "no-file"`,
    `  fi`,
    `fi`,
    ``,
    `if [ "$DB_OK" -eq 0 ]; then`,
    `  echo "DB_AUTH_MODE=NO_CREDENTIAL"`,
    `fi`,
    `unset HW_DB_KEY HW_API_KEY DB_TOKEN_ARGS 2>/dev/null`,
    `devbridge auth status > /tmp/db_status.log 2>&1 || true`,
  ].join('\n');
}

// Parse the raw stdout of buildDevbridgeAuthProbe into { authMode, attempts }.
// authMode is the LAST DB_AUTH_MODE line; attempts collects the non-sensitive
// DB_ATTEMPT_* diagnostics emitted by tiers that failed and fell through.
export function parseDevbridgeAuthOutput(stdout) {
  // #946: OSC 133 markers precede every line on integration-enabled shells; the
  // anchored ^DB_ATTEMPT_ regexes are blind to them without stripping first.
  const text = stripTerminalEscapes(stdout);
  const modes = text.match(/DB_AUTH_MODE=([A-Z_]+)/g) || [];
  const authMode = modes.length > 0 ? modes[modes.length - 1].split('=')[1] : '';
  const attempts = {};
  for (const m of text.matchAll(/^DB_ATTEMPT_([A-Z_]+)=(\S+)$/gm)) {
    attempts[m[1]] = m[2];
  }
  return { authMode, attempts };
}

// Tunnel lifetime for expose-created hosts, in hours. The report that motivated
// #919 uses -e 72 so the shared link survives long after the deploying session
// ends; the value is surfaced to callers via exposeTunnel's expiresAt field.
export const DEVBRIDGE_HOST_EXPIRY_HOURS = 72;

// Start (or replace) a devbridge host bound to a single port, extract the public
// URL, and health-check it. Mirrors the huaweicloud-sandbox skill's Expose flow:
// pre-clean stale tunnels (quota 10006), start host in background, read
// "Tunnel URL: ..." from /tmp/host.log, curl-check, retry once on unreachable.
// The host MUST survive the exec session that started it (#919): setsid detaches
// it from the session's process group, `< /dev/null` drops the controlling tty
// stdin, and `disown` removes it from the shell's job table — without all three
// the host is reaped when the one-shot session ends and the tunnel dies
// immediately after a green in-session health check (the "假成功" bug).
export function buildDevbridgeExposeScript(port, expiryHours = DEVBRIDGE_HOST_EXPIRY_HOURS) {
  const hostLog = '/tmp/host.log';
  return [
    `pkill -f "devbridge host" 2>/dev/null || true`,
    `sleep 2`,
    `devbridge delete-all > /dev/null 2>&1 || true`,
    // #922 (S8): setsid is unavailable on some sandbox images — fall back to a
    // bare nohup launch so the host still starts; persistence is then judged by
    // the independent re-verify below, which emits the 请勿分享 warning in the
    // non-persistent case. disown is guarded: shells without the builtin must
    // not abort the script.
    `if command -v setsid > /dev/null 2>&1; then setsid nohup devbridge host -p ${port} -e ${expiryHours} > ${hostLog} 2>&1 < /dev/null & else nohup devbridge host -p ${port} -e ${expiryHours} > ${hostLog} 2>&1 < /dev/null & fi`,
    `disown 2>/dev/null || true`,
    `sleep 6`,
    // Port-anchored extraction (#943): a multi-port host prints one "Tunnel URL:" line per
    // port, so a port-blind `sed | tail -1` can pick another port's URL.
    `TUNNEL_URL=$(grep -oE "https://[A-Za-z0-9_-]+-${port}\\.devbridge-s2\\.hwtunnel\\.com" ${hostLog} | head -1)`,
    // A2 (#935): probe with retries + backoff — 502/000 before the gateway is
    // ready is not a failure; the LAST probe decides reachability. The body is
    // captured every probe so DB_TUNNEL_BODY reflects the final one (#943).
    `HTTP_CODE="000"`,
    `if [ -n "$TUNNEL_URL" ]; then`,
    `  for i in 1 2 3 4; do`,
    `    HTTP_CODE=$(curl -s -o /tmp/.db_probe_body -w "%{http_code}" --max-time 10 "$TUNNEL_URL" 2>/dev/null || echo "000")`,
    `    echo "DB_PROBE_$i=$HTTP_CODE"`,
    `    if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "304" ]; then break; fi`,
    `    if [ "$i" != "4" ]; then sleep 5; fi`,
    `  done`,
    `fi`,
    `echo "DB_HOST_LOG="`,
    `tail -n 5 ${hostLog}`,
    `echo "DB_TUNNEL_URL=$TUNNEL_URL"`,
    `echo "DB_HTTP_CODE=$HTTP_CODE"`,
    `echo "DB_EXPIRY_HOURS=${expiryHours}"`,
    // First 64 bytes of the probe body (non-sensitive) so gateway-error markers
    // like "tunnel not found" can be distinguished from app-generated 404/502 pages.
    `echo "DB_TUNNEL_BODY=$(head -c 64 /tmp/.db_probe_body 2>/dev/null)"`,
    `rm -f /tmp/.db_probe_body`,
    `echo "DB_QUOTA_ERROR=$(grep -c '10006' ${hostLog} 2>/dev/null || echo 0)"`,
  ].join('\n');
}

// Build the script for the SECOND, independent exec session that re-verifies the
// tunnel with a real GET (#919): the in-session health check inside
// buildDevbridgeExposeScript cannot prove the host survived session teardown —
// a GET from a fresh session can. #922 (B2): the response body is kept and
// checked for the native false-success form — a 200 whose body is "tunnel not
// found" — and the verdict is emitted as DB_VERIFY_NOT_FOUND so
// parseDevbridgeVerifyOutput can catch it. The URL is validated (https,
// URL-safe chars only) before being spliced into the shell command.
export function buildDevbridgeVerifyScript(tunnelUrl) {
  const url = String(tunnelUrl || '');
  if (!/^https:\/\/[A-Za-z0-9:._/-]+$/.test(url)) {
    throw new Error(
      `sandbox expose tunnel: invalid tunnel URL ${JSON.stringify(url.slice(0, 80))}. Expected an https:// URL with URL-safe characters (from the expose script's DB_TUNNEL_URL output).`,
    );
  }
  const bodyFile = '/tmp/devbridge_verify_body';
  return [
    `VERIFY_CODE=$(curl -s -o ${bodyFile} -w "%{http_code}" --max-time 10 "${url}" 2>/dev/null || echo "000")`,
    `VERIFY_NOT_FOUND=$(grep -ci 'tunnel not found' ${bodyFile} 2>/dev/null || true)`,
    `if [ -z "$VERIFY_NOT_FOUND" ]; then VERIFY_NOT_FOUND=0; fi`,
    `rm -f ${bodyFile} 2>/dev/null || true`,
    `echo "DB_VERIFY_HTTP_CODE=$VERIFY_CODE"`,
    `echo "DB_VERIFY_NOT_FOUND=$VERIFY_NOT_FOUND"`,
  ].join('\n');
}

// A2 (#935): parse the probe sequence emitted by buildDevbridgeExposeScript.
// Each probe echo is `DB_PROBE_<n>=<code>`; reachability is decided by the
// LAST probe — intermediate 502/000 probes are gateway-not-ready noise, not
// failures, so they must not leak into the tool's verdict.
export function parseDevbridgeProbeSequence(stdout) {
  const text = String(stdout || '');
  const probes = [];
  for (const m of text.matchAll(/^DB_PROBE_(\d+)=(\S*)$/gm)) {
    probes.push({ attempt: Number(m[1]), httpCode: m[2] });
  }
  const finalHttpCode = probes.length > 0 ? probes[probes.length - 1].httpCode : '';
  return { probes, finalHttpCode };
}

// A2 (#935): the reachability warning must come from the LAST probe's HTTP
// status, not from a single early curl — the old single-shot check warned
// "Tunnel reachable check returned HTTP (expected 200/304)" while the same
// log showed DB_HTTP_CODE=200. 200/304 = no warning; anything else surfaces
// as-is.
export function formatTunnelReachabilityWarning(httpCode) {
  if (httpCode === '200' || httpCode === '304') return undefined;
  return `Tunnel reachable check returned HTTP ${httpCode || '000'} (expected 200/304). The URL may not be serving yet — the final probe decides.`;
}

// Parse the raw stdout of buildDevbridgeExposeScript into structured fields.
// `gatewayTunnelError` marks a URL the s2 gateway itself reports as dead
// (404 "tunnel not found" / "port not configured") — it can never serve content
// regardless of the app. `badGateway` (502 "bad gateway") means the tunnel is
// alive but the local service on the exposed port is not serving.
export function parseDevbridgeExposeOutput(stdout) {
  // #946: strip OSC/CSI escapes + \r BEFORE the anchored ^DB_ lookups — otherwise
  // every field is lost on integration-enabled shells and a perfectly good tunnel
  // comes back as ok:true with publicUrl missing (and pointlessly re-built once).
  const text = stripTerminalEscapes(stdout);
  const getField = (key) => {
    const m = text.match(new RegExp(`^${key}=(.*)$`, 'm'));
    return m ? m[1].trim() : '';
  };
  const tunnelUrl = getField('DB_TUNNEL_URL') || (text.match(/TUNNEL_URL:(https:\/\/[^\s]+)/) || [])[1] || '';
  const httpCode = getField('DB_HTTP_CODE');
  const body = getField('DB_TUNNEL_BODY');
  const quotaError = getField('DB_QUOTA_ERROR') === '1' || /10006/.test(text);
  const tunnelId = (tunnelUrl.match(/^https:\/\/([A-Za-z0-9_-]+)-\d+\./) || [])[1] || '';
  const expiryHours = Number(getField('DB_EXPIRY_HOURS')) || undefined;
  // Exact-body match gated on the status code: an app's own 404/502 page is never misjudged.
  const gatewayTunnelError =
    httpCode === '404' && (body === DEVBRIDGE_TUNNEL_NOT_FOUND_MARKER || body === DEVBRIDGE_PORT_NOT_CONFIGURED_MARKER);
  const badGateway = httpCode === '502' && body === DEVBRIDGE_BAD_GATEWAY_MARKER;
  return { tunnelUrl, httpCode, quotaError, tunnelId, expiryHours, gatewayTunnelError, badGateway };
}

// Parse the raw stdout of buildDevbridgeVerifyScript into structured fields.
// Dedicated parser (#922 B1): the verify script emits DB_VERIFY_HTTP_CODE /
// DB_VERIFY_NOT_FOUND keys — the anchored ^DB_HTTP_CODE= lookup in
// parseDevbridgeExposeOutput never matches them, which used to leave
// verifyHttpCode empty and persistent always false.
export function parseDevbridgeVerifyOutput(stdout) {
  // #946: strip OSC/CSI escapes + \r — the anchored DB_VERIFY_* lookups are blind
  // to them, leaving verifyHttpCode empty and persistent permanently false.
  const text = stripTerminalEscapes(stdout);
  const getField = (key) => {
    const m = text.match(new RegExp(`^${key}=(.*)$`, 'm'));
    return m ? m[1].trim() : '';
  };
  const httpCode = getField('DB_VERIFY_HTTP_CODE');
  const notFoundCount = Number(getField('DB_VERIFY_NOT_FOUND')) || 0;
  const notFound = notFoundCount > 0;
  return { httpCode, notFound };
}

// Parse and validate a TCP port number destined for shell interpolation. Returns
// the integer when 1..65535; throws otherwise. Guards the `-p ${port}` shell
// splice in buildDevbridgeExposeScript against non-numeric / out-of-range input.
export function validateTunnelPort(port) {
  const n = Number(port);
  if (!Number.isSafeInteger(n) || n < 1 || n > 65535) {
    throw new Error(
      `sandbox expose tunnel: invalid port ${JSON.stringify(port)}. Expected an integer between 1 and 65535 (use the "port" value returned by sandbox_deploy_nginx).`,
    );
  }
  return n;
}

// Upper bound of devbridge's -e expiry, in hours (measured 2026-10: `-e 720` is
// accepted and sets expiration = now + 2592001s; larger values are rejected).
export const DEVBRIDGE_MAX_EXPIRY_HOURS = 720;

// Default renewal horizon for renewTunnel / the keepalive watchdog: 720h gives a
// 29-day window of tolerance if renewal ever stops firing.
export const DEVBRIDGE_RENEW_HOURS = 720;

// Validate and clamp a -e expiry value destined for shell interpolation in
// `devbridge host -p <port> -e <hours>` / `devbridge update <id> -e <hours>`.
// devbridge accepts 1..720 (30 days); anything else is rejected or clipped by
// the gateway, so fail fast here instead of surfacing a misleading expiry.
export function validateExpiryHours(hours) {
  const n = Number(hours);
  if (!Number.isSafeInteger(n) || n < 1 || n > DEVBRIDGE_MAX_EXPIRY_HOURS) {
    throw new Error(
      `sandbox tunnel expiry: invalid expiry_hours ${JSON.stringify(hours)}. Expected an integer between 1 and ${DEVBRIDGE_MAX_EXPIRY_HOURS} (720 = the devbridge 30-day maximum).`,
    );
  }
  return n;
}

// Validate a DevBridge tunnel ID destined for shell interpolation in
// `devbridge update <id>` / `devbridge host <id>` / pgrep patterns. IDs are
// short lowercase base36 tokens (e.g. nv2dvv6w, kag7rozs); the strict charset
// keeps shell metacharacters out of the splice.
export function validateTunnelId(tunnelId) {
  const id = String(tunnelId || '');
  if (!/^[A-Za-z0-9_-]{4,32}$/.test(id)) {
    throw new Error(
      `sandbox tunnel: invalid tunnel_id ${JSON.stringify(id.slice(0, 40))}. Expected the short ID from huaweicloud_sandbox_expose_tunnel's "tunnelId" field (URL-safe characters only).`,
    );
  }
  return id;
}

// Build the script that renews a tunnel's lifetime: `devbridge update <id> -e
// <hours>`. The expiry is a ROLLING WINDOW (measured 2026-10: renewal sets
// expiration = now + hours regardless of remaining time, so renewing before
// expiry keeps the same URL alive indefinitely). The absolute expiration
// (tunnelExpiration, Unix seconds) is surfaced via show -v so callers get a
// verifiable timestamp instead of a bare exit code.
export function buildDevbridgeRenewScript(tunnelId, expiryHours = DEVBRIDGE_RENEW_HOURS) {
  const id = validateTunnelId(tunnelId);
  const hours = validateExpiryHours(expiryHours);
  return [
    `export PATH="$HOME/.huawei/bin:$PATH"`,
    `devbridge update ${id} -e ${hours} > /tmp/db-renew-update.log 2>&1`,
    `DB_RENEW_EXIT=$?`,
    `DB_RENEW_ERROR=$(head -1 /tmp/db-renew-update.log 2>/dev/null)`,
    `rm -f /tmp/db-renew-update.log`,
    `DB_EXPIRATION=$(devbridge show ${id} -v 2>&1 | grep -oE 'tunnelExpiration[^0-9]+[0-9]+' | grep -oE '[0-9]+' | head -1)`,
    `echo "DB_RENEW_EXIT=$DB_RENEW_EXIT"`,
    `echo "DB_RENEW_ID=${id}"`,
    `echo "DB_RENEW_HOURS=${hours}"`,
    `echo "DB_EXPIRATION=$DB_EXPIRATION"`,
    `echo "DB_RENEW_ERROR=$DB_RENEW_ERROR"`,
  ].join('\n');
}

// Parse the raw stdout of buildDevbridgeRenewScript into structured fields.
// A renewal is ok only when the update exit code is 0 AND show -v reports the
// absolute tunnelExpiration — the management plane can lose a tunnel's record
// (10002 "tunnel not found") while the data plane keeps serving, which a bare
// exit-code check would misread as success on the old process alone.
export function parseDevbridgeRenewOutput(stdout) {
  const text = stripTerminalEscapes(stdout);
  const getField = (key) => {
    const m = text.match(new RegExp(`^${key}=(.*)$`, 'm'));
    return m ? m[1].trim() : '';
  };
  const renewExit = getField('DB_RENEW_EXIT');
  const expirationUnix = Number(getField('DB_EXPIRATION')) || undefined;
  const ok = renewExit === '0' && expirationUnix !== undefined;
  const expiration = expirationUnix !== undefined ? new Date(expirationUnix * 1000).toISOString() : undefined;
  return {
    ok,
    tunnelId: getField('DB_RENEW_ID'),
    renewedForHours: Number(getField('DB_RENEW_HOURS')) || undefined,
    expirationUnix,
    expiresAt: expiration,
    error: ok ? undefined : getField('DB_RENEW_ERROR') || `renewal failed (exit ${renewExit || 'unknown'})`,
  };
}

// Renew a tunnel's lifetime via `devbridge update <id> -e <hours>`. Returns ok,
// tunnelId, expiresAt (absolute ISO timestamp), renewedForHours. The URL does
// not change — renewal only extends the lifetime of the existing tunnel ID.
export async function renewTunnel(workspaceId, { tunnelId, expiryHours }, username = 'root', timeoutMs = 60000) {
  if (!workspaceId) {
    throw new Error('sandbox renew tunnel: workspace_id is required.');
  }
  const script = buildDevbridgeRenewScript(tunnelId, expiryHours);
  const result = await execOneShot(workspaceId, script, username, timeoutMs);
  const parsed = parseDevbridgeRenewOutput(result.stdout);
  return parsed;
}

// Build the keepalive watchdog script for a set of known tunnels (the
// three-layer pattern proven in the 2026-10 tunnel-persistence test):
//   1. host watchdog — re-attach with `devbridge host <id>` when the host
//      process dies; the URL is bound to the tunnel ID, so it never changes
//   2. daily renewal — `devbridge update <id> -e 720` (29-day failure tolerance)
//   3. health check — curl each URL every 5 minutes, log on non-200/304
// URLs are HARDCODED per tunnel (tunnel IDs never change), NOT derived from
// `devbridge port list` — that table's lines are wrapped in OSC escapes on
// integration-enabled shells, so anchored greps silently fail and the
// constructed health URL 404s (measured 2026-10).
export function buildDevbridgeKeepaliveScript(tunnels) {
  if (!Array.isArray(tunnels) || tunnels.length === 0) {
    throw new Error('sandbox keepalive: tunnels must be a non-empty array of {tunnelId, url}.');
  }
  const entries = tunnels
    .map((t) => `${validateTunnelId(t?.tunnelId)}:${String(t?.url || '')}`)
    .map((entry) => {
      const url = entry.slice(entry.indexOf(':') + 1);
      if (!/^https:\/\/[A-Za-z0-9:._/-]+$/.test(url)) {
        throw new Error(
          `sandbox keepalive: invalid tunnel URL ${JSON.stringify(url.slice(0, 80))} for the keepalive health check. Expected an https:// URL with URL-safe characters (from huaweicloud_sandbox_expose_tunnel's publicUrl).`,
        );
      }
      return entry;
    })
    .join(' ');
  // Heredoc is single-quoted ('DB_KEEPALIVE_EOF') so the writer shell expands
  // nothing; all ${...} expansion happens inside the watchdog at runtime.
  const body = [
    `#!/bin/bash`,
    `export PATH="$HOME/.huawei/bin:$PATH"`,
    `# entries: tunnelId:url (URLs are stable — tunnel IDs never change)`,
    `TUNNELS="${entries}"`,
    `declare -A LAST_RENEW`,
    `while true; do`,
    `  NOW=$(date -u +%s)`,
    `  TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)`,
    `  for entry in $TUNNELS; do`,
    `    ID="\${entry%%:*}"; URL="\${entry#*:}"`,
    `    if ! pgrep -f "devbridge host $ID" > /dev/null 2>&1; then`,
    `      if command -v setsid > /dev/null 2>&1; then setsid nohup devbridge host "$ID" > "/tmp/host-$ID.log" 2>&1 < /dev/null & else nohup devbridge host "$ID" > "/tmp/host-$ID.log" 2>&1 < /dev/null & fi`,
    `      echo "$TS host $ID restarted (same tunnel, URL unchanged)" >> /tmp/tunnel-keepalive.log`,
    `      sleep 8`,
    `    fi`,
    `    if [ $((\${LAST_RENEW[$ID]:-0})) -eq 0 ] || [ $((NOW - \${LAST_RENEW[$ID]})) -ge 86400 ]; then`,
    `      if devbridge update "$ID" -e ${DEVBRIDGE_RENEW_HOURS} > /tmp/keepalive-last-update.log 2>&1; then`,
    `        echo "$TS renew $ID ok (${DEVBRIDGE_RENEW_HOURS}h)" >> /tmp/tunnel-keepalive.log`,
    `      else`,
    `        echo "$TS renew $ID FAILED: $(head -1 /tmp/keepalive-last-update.log)" >> /tmp/tunnel-keepalive.log`,
    `      fi`,
    `      LAST_RENEW[$ID]=$NOW`,
    `    fi`,
    `    HC=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "$URL/" 2>/dev/null || echo "000")`,
    `    if [ "$HC" != "200" ] && [ "$HC" != "304" ]; then`,
    `      echo "$TS health $ID WARN http=$HC" >> /tmp/tunnel-keepalive.log`,
    `    fi`,
    `  done`,
    `  sleep 300`,
    `done`,
  ].join('\n');
  return [
    `export PATH="$HOME/.huawei/bin:$PATH"`,
    `pkill -f "tunnel-keepalive.sh" 2>/dev/null || true`,
    `sleep 1`,
    `cat > /tmp/tunnel-keepalive.sh << 'DB_KEEPALIVE_EOF'`,
    body,
    `DB_KEEPALIVE_EOF`,
    `chmod +x /tmp/tunnel-keepalive.sh`,
    `bash -n /tmp/tunnel-keepalive.sh > /dev/null 2>&1`,
    `echo "DB_KEEPALIVE_SYNTAX=$?"`,
    `if command -v setsid > /dev/null 2>&1; then setsid nohup /tmp/tunnel-keepalive.sh > /dev/null 2>&1 < /dev/null & else nohup /tmp/tunnel-keepalive.sh > /dev/null 2>&1 < /dev/null & fi`,
    `disown 2>/dev/null || true`,
    `sleep 3`,
    `echo "DB_KEEPALIVE_PID=$(pgrep -f 'tunnel-keepalive.sh' | head -1)"`,
    `echo "DB_KEEPALIVE_LOG=/tmp/tunnel-keepalive.log"`,
  ].join('\n');
}

// Read the tunnel list of the INSTALLED watchdog (if any). The TUNNELS line in
// /tmp/tunnel-keepalive.sh is the single source of truth for what is currently
// protected; expose_tunnel reads it before installing so the new tunnel is
// MERGED into the existing protection instead of replacing it.
export function buildKeepaliveTunnelsReadScript() {
  return [
    `LINE=$(grep -m1 '^TUNNELS=' /tmp/tunnel-keepalive.sh 2>/dev/null | sed 's/^TUNNELS=//; s/^"//; s/"$//')`,
    `echo "DB_KEEPALIVE_TUNNELS=$LINE"`,
  ].join('\n');
}

// Parse the raw stdout of buildKeepaliveTunnelsReadScript. Empty output (no
// watchdog installed yet) yields [].
export function parseKeepaliveTunnelsOutput(stdout) {
  const text = stripTerminalEscapes(stdout);
  const m = text.match(/^DB_KEEPALIVE_TUNNELS=(.*)$/m);
  const line = m ? m[1].trim() : '';
  if (!line) return [];
  return line
    .split(/\s+/)
    .map((entry) => {
      const i = entry.indexOf(':');
      return i > 0 ? { tunnelId: entry.slice(0, i), url: entry.slice(i + 1) } : null;
    })
    .filter(Boolean);
}

// Merge the current watchdog tunnels with the incoming ones: dedupe by
// tunnelId, incoming wins (same tunnel re-exposed refreshes its URL), existing
// order preserved, new tunnels appended.
export function mergeKeepaliveTunnels(existing, incoming) {
  const byId = new Map();
  for (const t of existing || []) {
    if (t?.tunnelId && t?.url) byId.set(t.tunnelId, { tunnelId: t.tunnelId, url: t.url });
  }
  for (const t of incoming || []) {
    if (t?.tunnelId && t?.url) byId.set(t.tunnelId, { tunnelId: t.tunnelId, url: t.url });
  }
  return [...byId.values()];
}

// Install the keepalive watchdog in the sandbox. Validates every tunnel ID and
// URL before splicing, aborts on a bash syntax error (DB_KEEPALIVE_SYNTAX != 0),
// and reports the watchdog PID. Replacing the watchdog (re-running the tool)
// kills the old loop first so two loops never double-renew.
export async function installKeepaliveWatchdog(workspaceId, { tunnels }, username = 'root', timeoutMs = 60000) {
  if (!workspaceId) {
    throw new Error('sandbox keepalive: workspace_id is required.');
  }
  const script = buildDevbridgeKeepaliveScript(tunnels);
  const result = await execOneShot(workspaceId, script, username, timeoutMs);
  const text = stripTerminalEscapes(result.stdout);
  const getField = (key) => {
    const m = text.match(new RegExp(`^${key}=(.*)$`, 'm'));
    return m ? m[1].trim() : '';
  };
  const syntax = getField('DB_KEEPALIVE_SYNTAX');
  if (syntax !== '0') {
    return {
      ok: false,
      error: `keepalive watchdog script failed the bash -n syntax check (exit ${syntax || 'unknown'}).`,
    };
  }
  return {
    ok: true,
    scriptPath: '/tmp/tunnel-keepalive.sh',
    logPath: getField('DB_KEEPALIVE_LOG') || '/tmp/tunnel-keepalive.log',
    watchdogPid: getField('DB_KEEPALIVE_PID') || undefined,
    tunnels: (tunnels || []).map((t) => ({ tunnelId: t.tunnelId, url: t.url })),
  };
}

// Expose a sandbox port to a public DevBridge tunnel URL. `port` MUST be the
// ACTUAL port reported by deployNginx (deploy_nginx auto-increments on conflict),
// otherwise the tunnel is bound to a dead port. Returns ok, publicUrl, port,
// tunnelId, auth mode, expiresAt (tunnel lifetime from -e), and warnings; the
// tunnel is re-verified from a second independent exec session (#919) and the
// result carries verifyHttpCode + persistent so callers can tell a
// session-surviving URL from one that dies with the deploying session.
export async function exposeTunnel(
  workspaceId,
  { port, expiryHours, keepalive },
  username = 'root',
  timeoutMs = 90000,
) {
  if (!workspaceId) {
    throw new Error('sandbox expose tunnel: workspace_id is required.');
  }
  const validatedPort = validateTunnelPort(port);
  const validatedExpiryHours = validateExpiryHours(expiryHours ?? DEVBRIDGE_HOST_EXPIRY_HOURS);

  const authScript = buildDevbridgeAuthProbe();
  const authResult = await execOneShot(workspaceId, authScript, username, 30000);
  const { authMode, attempts } = parseDevbridgeAuthOutput(authResult.stdout);

  if (authMode !== 'API_KEY_KEYRING' && authMode !== 'AKSK_SUPPORTED' && authMode !== 'API_KEY_FILE') {
    const loginOutput = String(authResult.stdout || '') + String(authResult.stderr || '');
    return {
      ok: false,
      error: 'DevBridge authentication failed: no usable credential in the sandbox.',
      authMode: authMode || 'UNKNOWN',
      attempts,
      hint:
        'No DevBridge credential is available in this sandbox. Suggested next steps:\n' +
        '1) Re-run huaweicloud_sandbox_credentials once, then retry huaweicloud_sandbox_expose_tunnel — ' +
        'this refreshes the temporary AK/SK (most common quick fix when they simply expired) and rewrites /tmp/hw_creds.sh.\n' +
        '2) If it still fails, this sandbox was created on an older image and cannot auto-acquire an API Key ' +
        '(the image cannot be upgraded in place). One-time manual fallback: create an API Key at ' +
        'https://devstation.connect.huaweicloud.com/space/devbridge/apikey, run `export HW_API_KEY=<key>` locally, ' +
        're-run huaweicloud_sandbox_credentials, then retry.\n' +
        '3) The "attempts" field shows which tiers were tried and why they failed — include it when escalating to the platform team.',
      loginOutput,
    };
  }

  let result = null;
  let attempt = 0;
  const maxAttempts = 2;
  while (attempt < maxAttempts) {
    attempt += 1;
    const exposeScript = buildDevbridgeExposeScript(validatedPort, validatedExpiryHours);
    result = await execOneShot(workspaceId, exposeScript, username, timeoutMs);
    const parsed = parseDevbridgeExposeOutput(result.stdout);

    // 10006 quota exceeded: clean up stale tunnels and retry.
    if (parsed.quotaError && attempt < maxAttempts) {
      continue;
    }
    // Unreachable (000), migrated-gateway placeholder, or gateway-level tunnel errors
    // (404 "tunnel not found" / "port not configured"): one cleanup + rebuild retry.
    // 502 "bad gateway" (host alive, local service down) also gets one retry to cover
    // slow app starts.
    const unreachable = parsed.httpCode === '000' || parsed.httpCode === '';
    const migration = /服务已迁移/.test(String(result.stdout || ''));
    const gatewayTunnelError = parsed.gatewayTunnelError === true;
    const backendDown = parsed.badGateway === true;
    if (unreachable || migration || gatewayTunnelError || backendDown) {
      if (attempt === 1) {
        try {
          await execOneShot(
            workspaceId,
            `pkill -f "devbridge host" 2>/dev/null || true; sleep 2; devbridge delete-all > /dev/null 2>&1 || true`,
            username,
            20000,
          );
        } catch {}
        continue;
      }
      // Retry exhausted: a URL the gateway itself reports as dead (or one pointing at
      // the retired pre-migration gateway) must NOT be handed over as a working
      // deployment link — previously this returned ok:true with a soft warning.
      if (gatewayTunnelError || migration) {
        return {
          ok: false,
          error: gatewayTunnelError
            ? 'DevBridge gateway reports the fresh tunnel URL as dead (404 "tunnel not found" / "port not configured") — the host session is not registered on the gateway. A rebuild was already attempted.'
            : 'DevBridge gateway serves a migration placeholder page (服务已迁移) — the URL points at the retired pre-migration gateway and cannot work.',
          authMode,
          httpCode: parsed.httpCode,
          hostLog: String(result.stdout || '').slice(0, 400),
        };
      }
    }

    const warnings = [];
    if (parsed.quotaError)
      warnings.push('DevBridge tunnel quota (10006) hit — stale tunnels were cleaned up and the host was retried.');

    // #919: re-verify with a real GET from a SECOND, independent exec session.
    // The in-session health check above cannot prove the host survived session
    // teardown (setsid/nohup/disown make that likely, not certain). When the
    // fresh-session GET fails, the URL will die with the deploying session —
    // say so explicitly instead of returning a link the visitor cannot open.
    let verifyHttpCode = '';
    let verifyNotFound = false;
    let persistent = undefined;
    if (parsed.tunnelUrl) {
      try {
        const verifyResult = await execOneShot(
          workspaceId,
          buildDevbridgeVerifyScript(parsed.tunnelUrl),
          username,
          30000,
        );
        // #922 (B1): parse with the dedicated verify parser — the
        // DB_VERIFY_HTTP_CODE key is not visible to parseDevbridgeExposeOutput.
        const verify = parseDevbridgeVerifyOutput(verifyResult.stdout);
        verifyHttpCode = verify.httpCode || '';
        // #922 (B2): a native false-success form answers HTTP 200 with a
        // "tunnel not found" body — treat it as non-persistent.
        verifyNotFound = verify.notFound;
      } catch {}
      // 000 = the fresh session could not reach the tunnel (host already dead
      // or gateway not serving); 200 with a "tunnel not found" body = the
      // gateway answered but the tunnel is gone; anything non-200/304 is
      // surfaced as-is below.
      persistent = verifyHttpCode !== '' && verifyHttpCode !== '000' && !verifyNotFound;
      if (!persistent) {
        if (verifyNotFound) {
          warnings.push(
            '复测返回 HTTP 200 但 body 为 "tunnel not found"（原生假成功形态），隧道实际未生效，请勿分享 (the recheck answered HTTP 200 with a "tunnel not found" body — the tunnel is NOT serving; do NOT share this URL).',
          );
        } else {
          warnings.push(
            '隧道将在会话结束后失效，请勿分享 (the tunnel did NOT survive an independent exec-session recheck — do NOT share this URL; the host process is not persistent).',
          );
        }
      }
    }

    // A2 (#935): the reachability warning uses the FINAL probe's HTTP status —
    // intermediate 502/000 probes (gateway not ready yet) must not leak into
    // the verdict, and a sequence of 502/000 → 200 must NOT warn.
    if (parsed.badGateway)
      warnings.push(
        'Tunnel reachable but the gateway reports "bad gateway" — the local service on the exposed port is not serving.',
      );
    const reachabilityWarning = formatTunnelReachabilityWarning(parsed.httpCode);
    if (reachabilityWarning) warnings.push(reachabilityWarning);
    const expiresAt =
      parsed.expiryHours !== undefined
        ? new Date(Date.now() + parsed.expiryHours * 3_600_000).toISOString()
        : undefined;

    // AUTO-ENROLL: every tunnel exposed through this tool is enrolled into the
    // keepalive watchdog by default (user requirement: all devbridge tunnels
    // deployed to the sandbox must be keepalive-protected — unattended renewal
    // + host re-attach + health check). The new tunnel is MERGED into the
    // existing watchdog tunnel list, never replacing other tunnels' coverage.
    // keepalive:false opts out. Non-fatal: an enrollment failure is surfaced
    // as a warning, not a failed expose — the tunnel itself is working.
    let keepaliveEnrollment = undefined;
    if (keepalive !== false && parsed.tunnelUrl && parsed.tunnelId) {
      try {
        const readResult = await execOneShot(workspaceId, buildKeepaliveTunnelsReadScript(), username, 20000);
        const existing = parseKeepaliveTunnelsOutput(readResult.stdout);
        const merged = mergeKeepaliveTunnels(existing, [{ tunnelId: parsed.tunnelId, url: parsed.tunnelUrl }]);
        keepaliveEnrollment = await installKeepaliveWatchdog(workspaceId, { tunnels: merged }, username, 30000);
        if (!keepaliveEnrollment.ok) {
          warnings.push(
            `Keepalive watchdog enrollment failed: ${keepaliveEnrollment.error || 'unknown error'} — the tunnel works but will NOT be auto-renewed. Retry with huaweicloud_sandbox_keepalive_watchdog.`,
          );
        }
      } catch (error) {
        warnings.push(
          `Keepalive watchdog enrollment failed (${error?.message || 'unknown error'}) — the tunnel works but will NOT be auto-renewed. Retry with huaweicloud_sandbox_keepalive_watchdog.`,
        );
      }
    }

    return {
      ok: true,
      publicUrl: parsed.tunnelUrl || undefined,
      port: validatedPort,
      tunnelId: parsed.tunnelId || undefined,
      authMode,
      httpCode: parsed.httpCode,
      verifyHttpCode: verifyHttpCode || undefined,
      verifyNotFound: verifyNotFound || undefined,
      persistent,
      expiresAt,
      expiresInHours: parsed.expiryHours,
      keepalive: keepaliveEnrollment
        ? {
            enrolled: keepaliveEnrollment.ok === true,
            tunnelCount: keepaliveEnrollment.ok ? (keepaliveEnrollment.tunnels || []).length : undefined,
            watchdogPid: keepaliveEnrollment.watchdogPid,
            logPath: keepaliveEnrollment.logPath,
            error: keepaliveEnrollment.ok ? undefined : keepaliveEnrollment.error,
          }
        : undefined,
      warnings: warnings.length > 0 ? warnings.join(' ') : undefined,
      hostLog: String(result.stdout || '').slice(0, 400),
    };
  }

  return {
    ok: false,
    error: 'Failed to expose a working DevBridge tunnel after retries.',
    authMode,
    hostLog: String(result?.stdout || '').slice(0, 400),
  };
}

export async function closeAllSessions() {
  for (const [key, session] of sessions) {
    sessions.delete(key);
    try {
      session.close();
    } catch {}
  }
}

export { getCurrentWorkspaceId, setWorkspaceId, runNodeExec };
