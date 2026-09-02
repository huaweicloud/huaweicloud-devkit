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

const execFileAsync = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));
export const WS_EXEC_INDEX_URL = pathToFileURL(join(__dirname, '..', 'ws-exec', 'index.js')).href;

let currentWorkspaceId = process.env.HW_WORKSPACE_ID || null;

function getCurrentWorkspaceId() {
  return currentWorkspaceId;
}

function setWorkspaceId(id) {
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

export async function uploadFileWithSession(workspaceId, localPath, remotePath, username = 'root', timeoutMs = 30000) {
  if (!existsSync(localPath)) {
    throw new Error(`sandbox upload: local file not found: ${localPath}`);
  }
  if (!statSync(localPath).isFile()) {
    throw new Error(`sandbox upload: path is not a regular file: ${localPath}`);
  }
  const content = readFileSync(localPath);
  const base64 = content.toString('base64');
  const expectedMd5 = createHash('md5').update(content).digest('hex');
  const chunks = splitBase64Chunks(base64);
  const tmp = `${remotePath}.b64tmp`;

  const reset = await execWithSession(workspaceId, `rm -f "${tmp}"`, username, timeoutMs);
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
  if (!existsSync(localDir)) {
    throw new Error(`sandbox upload project: local directory not found: ${localDir}`);
  }
  if (!statSync(localDir).isDirectory()) {
    throw new Error(`sandbox upload project: path is not a directory: ${localDir}`);
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
  let portWarning;
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
      if (offset === 0) {
        portWarning = `Port ${basePort} is in use — auto-assigned port ${targetPort}`;
      }
    } catch {}
    if (offset === maxPortAttempts - 1) {
      throw new Error(
        `sandbox deploy nginx: all ports ${basePort}-${basePort + maxPortAttempts - 1} are in use. Free a port and try again.`,
      );
    }
  }

  const effectiveNodePort =
    nginxType === 'proxy' ? (nodePort && nodePort !== listenPort ? nodePort : listenPort + 1) : undefined;

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
    listen ${listenPort};
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

  const cmd = [
    resolveScript,
    `sudo mkdir -p /etc/nginx/conf.d`,
    `sudo tee /etc/nginx/conf.d/${configName || project}.conf > /dev/null << 'NGINX_EOF'`,
    config,
    `NGINX_EOF`,
    `# Resolve symlinks for chmod (chmod does not follow symlinks on Linux)`,
    `chmod -R o+rX "$REAL_PROJECT" 2>/dev/null || true`,
    `find "$REAL_PROJECT" -type d -exec chmod o+x {} \\; 2>/dev/null || true`,
    `find "$REAL_PROJECT" -type f -path "*/node_modules/.bin/*" -exec chmod +x {} \\; 2>/dev/null || true`,
    `if pgrep -x nginx > /dev/null 2>&1; then sudo killall -9 nginx 2>/dev/null; sleep 1; fi
    sudo nginx`,
  ].join('\n');

  const result = await execOneShot(workspaceId, cmd, username, timeoutMs);

  let tunnelActive = false;
  try {
    const tunnelCheck = await execOneShot(
      workspaceId,
      'devbridge list -j 2>/dev/null | grep -q \'"tunnelId"\' && echo "ACTIVE" || echo "INACTIVE"',
      username,
      10000,
    );
    tunnelActive = String(tunnelCheck.stdout || '').includes('ACTIVE');
  } catch {}

  return {
    ok: result.exitCode === 0,
    nginxType,
    port: targetPort,
    nodePort: effectiveNodePort || undefined,
    outputPath,
    projectPath,
    exitCode: result.exitCode,
    stdout: result.stdout,
    nextStep: 'expose_via_devbridge',
    warning:
      (!tunnelActive
        ? 'No active DevBridge tunnel — deployment is incomplete. Proceed to Step 7 to expose the app.'
        : portWarning) || undefined,
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

  const checkScript = [
    `echo "=== DEPLOY CHECK ==="`,
    `PASS=0`,
    `TOTAL=0`,
    ``,
    `TOTAL=$((TOTAL+1))`,
    `if curl -s -o /dev/null -w "%{http_code}" http://localhost:${port} 2>/dev/null | grep -qE "^(2|3)"; then`,
    `  echo "nginx_serving:PASS (port ${port})"`,
    `  PASS=$((PASS+1))`,
    `else`,
    `  echo "nginx_serving:FAIL"`,
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
    `if devbridge list -j 2>/dev/null | grep -q '"tunnelId"'; then`,
    `  echo "devbridge_tunnel:PASS"`,
    `  PASS=$((PASS+1))`,
    `else`,
    `  echo "devbridge_tunnel:FAIL"`,
    `fi`,
    ``,
    `TOTAL=$((TOTAL+1))`,
    `TUNNEL_ID=$(devbridge list -j 2>/dev/null | grep -oP '"tunnelId":\\s*"\\K[^"]+' | head -1)`,
    `TUNNEL_URL="https://\${TUNNEL_ID}-${port}.cn-north-4-bridge.myhuaweicloud.com"`,
    `if [ -n "$TUNNEL_ID" ] && [ -n "$TUNNEL_URL" ]; then`,
    `  HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "$TUNNEL_URL" 2>/dev/null || echo "000")`,
    `  if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "304" ]; then`,
    `    echo "tunnel_url_accessible:PASS ($TUNNEL_URL -> $HTTP_CODE)"`,
    `    PASS=$((PASS+1))`,
    `  else`,
    `    echo "tunnel_url_accessible:FAIL ($TUNNEL_URL -> HTTP $HTTP_CODE)"`,
    `  fi`,
    `else`,
    `  echo "tunnel_url_accessible:FAIL (no tunnel URL)"`,
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

  const result = await execOneShot(workspaceId, checkScript, username, timeoutMs);
  const stdout = String(result.stdout || '');
  const checks = {};
  const lines = stdout.split('\n');
  for (const line of lines) {
    const m = line.match(/^(\w+):(\w+)\b(.*)/);
    if (m) checks[m[1]] = { status: m[2], detail: (m[3] || '').trim() };
  }
  const scoreMatch = stdout.match(/SCORE:(\d+)\/(\d+)/);
  const tunnelMatch = stdout.match(/TUNNEL_URL:(https:\/\/[^\s]+)/);
  const complete = /VERDICT:COMPLETE/.test(stdout);

  const missing = [];
  if (!complete) {
    for (const [key, val] of Object.entries(checks)) {
      if (val.status === 'FAIL') missing.push(key);
    }
  }

  return {
    ok: true,
    complete,
    checkType: isCrossPlatform ? 'cross-platform' : 'standard',
    checks,
    score: scoreMatch ? { pass: parseInt(scoreMatch[1], 10), total: parseInt(scoreMatch[2], 10) } : null,
    publicUrl: tunnelMatch ? tunnelMatch[1] : undefined,
    missingSteps: missing.length > 0 ? missing.join(', ') : undefined,
    nextStep: !complete
      ? missing.includes('devbridge_tunnel') || missing.includes('tunnel_url_accessible')
        ? 'expose_via_devbridge'
        : missing.includes('nginx_serving')
          ? 'configure_nginx'
          : missing.includes('qr_code')
            ? 'generate_qr_code'
            : 'review_checks'
      : 'complete',
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
  return true;
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
