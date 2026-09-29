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

import { createConnection, getCredentials } from './hwlink-api.ts';
import { getWebSocketImpl } from '../proxy/proxy-agent.ts';
import { trackSandboxConnect, trackSandboxDisconnect } from '../telemetry/telemetry.ts';

const execFileAsync = promisify(execFile);

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

// Thrown values cross the JS boundary as `unknown` under strict mode; only a
// non-empty message string is surfaced (same pattern as update-check.ts).
function errorMessage(error: unknown): string | undefined {
  if (error instanceof Error && error.message) return error.message;
  if (error && typeof error === 'object' && !Array.isArray(error)) {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === 'string' && message) return message;
  }
  return undefined;
}

// Mirrors the original `error.code || error.name || 'unknown'` fallback.
function errorLabel(error: unknown): string {
  if (error && typeof error === 'object' && !Array.isArray(error)) {
    const record = error as Record<string, unknown>;
    if (typeof record.code === 'string' && record.code) return record.code;
    if (typeof record.name === 'string' && record.name) return record.name;
  }
  if (error instanceof Error && error.name) return error.name;
  return 'unknown';
}

// Result shape returned by ws-exec's exec / executeHwlinkCommand. `error` is
// never set by ws-exec (failures reject), but the existing fallbacks read it.
interface HwlinkExecResult {
  stdout: string;
  exitCode: number;
  url?: string;
  source?: number;
  username?: string;
  command?: string;
  error?: string;
}

interface HwlinkTerminalSession {
  exec(_command: string, _options?: { timeoutMs?: number }): Promise<HwlinkExecResult>;
  close(): void;
}

interface HwlinkMultiplexer {
  readyState: number;
  onClose?: () => void;
  onError?: (_error: unknown) => void;
  close(): void;
}

interface HwlinkTunnelChannel {
  localPort: number;
  ready: Promise<unknown>;
  attach(_mux: HwlinkMultiplexer): void;
  close(): void;
}

// Structural surface of the untyped ws-exec barrel resolved by
// resolveWsExecIndexUrl() (index.js in dist, index.ts in-repo). Only the members
// this module calls are modeled; the dynamic import is cast to this shape (same
// pattern as proxy-agent.ts's UndiciModule cast). The cast is honest because the
// target is our own bundled module, not parsed/untrusted data.
interface WsExecModule {
  connectHwlinkTerminalSession(_options: {
    url: string;
    source: unknown;
    username: string;
    timeoutMs?: number;
    WebSocketImpl: unknown;
  }): Promise<HwlinkTerminalSession>;
  executeHwlinkCommand(_options: {
    url: string;
    source: unknown;
    username: string;
    command: string;
    timeoutMs: number;
    WebSocketImpl: unknown;
  }): Promise<HwlinkExecResult>;
  HwlinkWebSocketMultiplexer: new (
    _url: string,
    _source: unknown,
    _options: { WebSocketImpl: unknown; protocol: string },
  ) => HwlinkMultiplexer;
  HwlinkTunnelChannel: new (_options: { localPort: number; remotePort: number }) => HwlinkTunnelChannel;
}

interface TunnelSession {
  mux: HwlinkMultiplexer;
  close: () => void;
}

interface NodeExecResult {
  error?: string;
  data?: string;
  exitCode: number;
  [key: string]: unknown;
}

interface UploadTunnelResponse {
  bytes?: number;
  md5?: string;
  [key: string]: unknown;
}

interface UploadFileResult {
  ok: boolean;
  localPath: string;
  remotePath: string;
  bytes: number;
  chunks: number;
  md5: string;
  md5Verified: boolean;
}

interface UploadProjectOptions {
  exclude?: string[];
  sandboxPort?: number;
  verify?: boolean;
  extract?: boolean;
}

interface UploadProjectResult {
  ok: boolean;
  localDir: string;
  remotePath: string;
  bytes: number;
  md5: string;
  md5Verified: boolean;
  extracted: boolean;
}

interface DeployNginxOptions {
  nginxType?: string;
  port?: number;
  project?: string;
  outputDir?: string;
  nodePort?: number;
  publicPort?: number;
  configName?: string;
}

interface DeployNginxResult {
  ok: boolean;
  nginxType: string;
  port: number;
  nodePort: number | undefined;
  outputPath: string;
  projectPath: string;
  exitCode: number;
  stdout: string;
  nextStep: string;
  warning: string | undefined;
}

interface DeployCheckOptions {
  port: number;
  project: string;
  outputDir: string;
  frameworkType?: string;
}

interface DeployCheckEntry {
  status: string;
  detail: string;
}

interface DeployCheckResult {
  ok: boolean;
  complete: boolean;
  checkType: string;
  checks: Record<string, DeployCheckEntry>;
  score: { pass: number; total: number } | null;
  publicUrl: string | undefined;
  missingSteps: string | undefined;
  parseWarning: string | undefined;
  rawOutput: string | undefined;
  nextStep: string;
  remediation: string | undefined;
}

// Public tunnel URL domain for the DevBridge s2 gateway. The pre-migration Huawei Cloud
// bridge domain was retired in Sep 2026 and now serves a 「服务已迁移」 placeholder page with
// HTTP 200 — never construct tunnel URLs from it.
const DEVBRIDGE_TUNNEL_DOMAIN = 'devbridge-s2.hwtunnel.com';
// Migration placeholder page marker — a tunnel URL returning this body must be treated as unreachable.
const DEVBRIDGE_MIGRATION_MARKER = '服务已迁移';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ws-exec's sources are TypeScript now, but runtime entry points read the
// compiled dist bundle. Prefer the compiled barrel when it exists (dist/sandbox
// -> dist/ws-exec/index.js) and fall back to the source barrel for in-repo runs
// (src/sandbox -> src/ws-exec/index.ts, stripped by Node outside node_modules).
export function resolveWsExecIndexUrl(): string {
  const compiled = pathToFileURL(join(__dirname, '..', 'ws-exec', 'index.js'));
  if (existsSync(compiled)) return compiled.href;
  return pathToFileURL(join(__dirname, '..', 'ws-exec', 'index.ts')).href;
}

export const TUNNEL_URL_PATTERN = /TUNNEL_URL:(https:\/\/[A-Za-z0-9_-]+-\d+\.devbridge-s2\.hwtunnel\.com)/;

async function loadWsExec(): Promise<WsExecModule> {
  return (await import(resolveWsExecIndexUrl())) as WsExecModule;
}

let currentWorkspaceId: string | null = process.env.HW_WORKSPACE_ID || null;

function getCurrentWorkspaceId(): string | null {
  return currentWorkspaceId;
}

function setWorkspaceId(id: string | null): void {
  if (id && id !== currentWorkspaceId) {
    trackSandboxConnect();
  }
  currentWorkspaceId = id;
  // Node coerces env assignments to strings (`null` -> "null"); String() keeps
  // that behavior while satisfying the typed ProcessEnv setter.
  process.env.HW_WORKSPACE_ID = String(id);
}

function resolveEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  env.PATH = `${env.HOME || '/root'}/.huawei/bin:${env.PATH || ''}`;
  return env;
}

async function runNodeExec(args: string[], timeoutMs = 30000): Promise<NodeExecResult> {
  const env = resolveEnv();
  return new Promise<NodeExecResult>((resolve) => {
    const proc = spawn('node', args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    proc.stderr.on('data', (d: Buffer) => {
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
          const parsed: unknown = JSON.parse(out);
          resolve({ ...asRecord(parsed), exitCode: code || 0 });
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

const sessions = new Map<string, HwlinkTerminalSession>();

async function getSession(workspaceId: string, username: string, timeoutMs?: number): Promise<HwlinkTerminalSession> {
  const key = `${workspaceId}:${username}`;
  const existing = sessions.get(key);
  if (existing) return existing;

  const { ak, sk, securitytoken } = getCredentials();
  const { wsUrl, source } = await createConnection(workspaceId, ak, sk, securitytoken);

  const WebSocketImpl = await getWebSocketImpl(wsUrl);

  const wsExec = await loadWsExec();
  const session = await wsExec.connectHwlinkTerminalSession({
    url: wsUrl,
    source,
    username,
    timeoutMs,
    WebSocketImpl,
  });

  sessions.set(key, session);
  return session;
}

async function createTunnelSession(workspaceId: string, username: string, timeoutMs = 30000): Promise<TunnelSession> {
  const { ak, sk, securitytoken } = getCredentials();
  const { wsUrl, source } = await createConnection(workspaceId, ak, sk, securitytoken);
  const WebSocketImpl = await getWebSocketImpl(wsUrl);

  const wsExec = await loadWsExec();
  const mux = new wsExec.HwlinkWebSocketMultiplexer(wsUrl, source, { WebSocketImpl, protocol: 'devenv' });

  await new Promise<void>((resolve, reject) => {
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

export async function execOneShot(
  workspaceId: string,
  command: string,
  username: string,
  timeoutMs: number,
): Promise<HwlinkExecResult> {
  const { ak, sk, securitytoken } = getCredentials();
  const { wsUrl, source } = await createConnection(workspaceId, ak, sk, securitytoken);

  const WebSocketImpl = await getWebSocketImpl(wsUrl);

  const wsExec = await loadWsExec();
  return await wsExec.executeHwlinkCommand({
    url: wsUrl,
    source,
    username,
    command,
    timeoutMs,
    WebSocketImpl,
  });
}

export async function execWithSession(
  workspaceId: string,
  command: string,
  username: string,
  timeoutMs?: number,
): Promise<HwlinkExecResult> {
  const session = await getSession(workspaceId, username, timeoutMs);
  return await session.exec(command, { timeoutMs });
}

export const UPLOAD_CHUNK_SIZE = 30000;

export const UPLOAD_BATCH_SIZE = 2;

export const UPLOAD_MAX_RETRIES = 3;

export function splitBase64Chunks(base64: string, chunkSize = UPLOAD_CHUNK_SIZE): string[] {
  const chunks: string[] = [];
  for (let offset = 0; offset < base64.length; offset += chunkSize) {
    chunks.push(base64.slice(offset, offset + chunkSize));
  }
  return chunks;
}

export function formatPortConflictWarning(basePort: number, targetPort: number): string | undefined {
  return targetPort !== basePort ? `Port ${basePort} is in use — auto-assigned port ${targetPort}` : undefined;
}

export function formatPortDriftWarning(basePort: number, targetPort: number): string | undefined {
  if (targetPort === basePort) return undefined;
  return `Port ${basePort} was occupied — nginx now listens on port ${targetPort}. Any DevBridge tunnel bound to port ${basePort} is detached: run "devbridge port create <tunnelId> -p ${targetPort} --protocol http -a" and restart "devbridge host" for the new port.`;
}

export function formatProxyPortWarning(basePort: number, targetPort: number): string | undefined {
  if (targetPort === basePort) return undefined;
  return `Port ${basePort} is in use — the proxy template still listens on port ${basePort}: auto-increment does not apply to proxy configs, so nginx may fail to bind. Free the port or deploy a static/spa build instead.`;
}

export function buildExposeRemediation(port: number): string {
  return `In the sandbox: source /tmp/hw_creds.sh; source /tmp/hw_api_key 2>/dev/null; devbridge delete-all; devbridge create <name>; devbridge port create <tunnelId> -p ${port} --protocol http -a; nohup devbridge host <tunnelId> -p ${port} > /tmp/host.log 2>&1 & If deploy_nginx reported a different (auto-incremented) port in its "port" field, use THAT port instead of the one shown here. Full procedure in huawei-sandbox skill, Step 7 (Expose via DevBridge).`;
}

export async function uploadFileWithSession(
  workspaceId: string,
  localPath: string,
  remotePath: string,
  username = 'root',
  timeoutMs = 30000,
): Promise<UploadFileResult> {
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
    let lastError: string | number | undefined;
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

function uploadLog(message: string): void {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${message}\n`;
  console.error(line.trimEnd());
  try {
    appendFileSync(UPLOAD_LOG_PATH, line);
  } catch {}
}

function rotateUploadLog(maxBytes = 100 * 1024): void {
  try {
    if (existsSync(UPLOAD_LOG_PATH)) {
      const stat = statSync(UPLOAD_LOG_PATH);
      if (stat.size > maxBytes) {
        unlinkSync(UPLOAD_LOG_PATH);
      }
    }
  } catch {}
}

function generateUploadToken(): string {
  return randomBytes(16).toString('hex');
}

async function createTarGz(localDir: string, exclude: string[] = []): Promise<string> {
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
    const args: string[] = [];
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

async function computeMd5(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('md5');
    createReadStream(filePath)
      .on('data', (chunk: string | Buffer) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject);
  });
}

function cleanupLocalArchive(archivePath: string): void {
  try {
    rmSync(dirname(archivePath), { recursive: true, force: true });
  } catch {}
}

async function deployFileServer(
  workspaceId: string,
  username: string,
  port = 8888,
  token = '',
): Promise<HwlinkExecResult> {
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

async function uploadViaTunnel(
  localPort: number,
  archivePath: string,
  archiveSize: number,
  archiveRemotePath: string,
  uploadToken: string,
  timeoutMs: number,
): Promise<UploadTunnelResponse> {
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
  return new Promise<UploadTunnelResponse>((resolve, reject) => {
    let settled = false;
    const done = (fn: () => void): void => {
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
              const parsed: unknown = JSON.parse(body);
              resolve(asRecord(parsed));
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
          const parsed: unknown = JSON.parse(body);
          resolve(asRecord(parsed));
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

async function waitForServerReady(localPort: number): Promise<void> {
  for (let i = 0; i < SERVER_HEALTH_MAX_RETRIES; i++) {
    try {
      uploadLog(`waitForServerReady: attempt ${i + 1}, checking http://localhost:${localPort}/health`);
      const ok = await new Promise<boolean>((resolve) => {
        let settled = false;
        const done = (val: boolean): void => {
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
      uploadLog(`waitForServerReady: health check failed: ${errorMessage(error)} (retry ${i + 1})`);
    }
    await new Promise((r) => setTimeout(r, SERVER_HEALTH_INTERVAL_MS));
  }
  throw new Error(
    `sandbox file server not ready after ${SERVER_HEALTH_MAX_RETRIES * SERVER_HEALTH_INTERVAL_MS}ms (log: ${UPLOAD_LOG_PATH})`,
  );
}

async function cleanupFileServer(workspaceId: string, username: string): Promise<void> {
  const pidFile = '/tmp/sandbox-file-server.pid';
  const scriptPath = '/tmp/sandbox-file-server.py';
  await execWithSession(workspaceId, `kill $(cat ${pidFile}) 2>/dev/null; rm -f ${pidFile} ${scriptPath}`, username);
}

async function uploadViaHttpTunnel(
  workspaceId: string,
  archivePath: string,
  archiveRemotePath: string,
  username: string,
  timeoutMs: number,
  options: UploadProjectOptions,
): Promise<UploadTunnelResponse> {
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
  const wsExec = await loadWsExec();
  const tunnel = new wsExec.HwlinkTunnelChannel({
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
    uploadLog(`uploadViaHttpTunnel: TUNNEL READY FAILED: ${errorMessage(tunnelReadyError)}`);
    tunnel.close();
    throw new Error(
      `HTTP tunnel failed to establish: ${errorMessage(tunnelReadyError)}. ` +
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
    uploadLog(`uploadViaHttpTunnel: UPLOAD FAILED: ${errorMessage(uploadError)}`);
    throw uploadError;
  } finally {
    tunnel.close();
    tunnelSession.close();
  }
}

export async function uploadProjectWithSession(
  workspaceId: string,
  localDir: string,
  remoteDir: string | undefined,
  username = 'root',
  timeoutMs = 300000,
  options: UploadProjectOptions = {},
): Promise<UploadProjectResult> {
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

  let result: UploadTunnelResponse = {};
  let tunnelError: unknown;
  for (let attempt = 0; attempt < UPLOAD_MAX_RETRIES; attempt++) {
    try {
      await cleanupFileServer(workspaceId, username).catch(() => {});
      result = await uploadViaHttpTunnel(workspaceId, archivePath, archiveRemotePath, username, timeoutMs, options);
      tunnelError = null;
      break;
    } catch (error) {
      tunnelError = error;
      const errorType = errorLabel(error);
      uploadLog(
        `uploadProject: attempt ${attempt + 1}/${UPLOAD_MAX_RETRIES} failed [${errorType}]: ${errorMessage(error)}`,
      );
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  if (tunnelError) {
    uploadLog(`uploadProject: all ${UPLOAD_MAX_RETRIES} attempts failed: ${errorMessage(tunnelError)}`);
    uploadLog(`uploadProject: NOT falling back to base64 (removed). Rethrowing with diagnostics.`);
    cleanupLocalArchive(archivePath);
    throw new Error(
      `sandbox upload failed after ${UPLOAD_MAX_RETRIES} attempts: HTTP tunnel could not transfer the project archive. ` +
        `Archive size: ${(archiveSize / 1024).toFixed(1)}KB. ` +
        `Root cause: ${errorMessage(tunnelError)}. ` +
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
  workspaceId: string,
  { nginxType, port, project, outputDir, nodePort, publicPort, configName }: DeployNginxOptions,
  username = 'root',
  timeoutMs = 60000,
): Promise<DeployNginxResult> {
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
    nginxType === 'proxy' ? (nodePort && nodePort !== listenPort ? nodePort : listenPort + 1) : undefined;

  const projectPath = `/workspace/${project}`;
  const outputPath = outputDir.startsWith('/') ? outputDir : `${projectPath}/${outputDir}`;

  const resolveScript = `REAL_PROJECT=$(readlink -f "${projectPath}" 2>/dev/null || echo "${projectPath}")
REAL_OUTPUT="${outputPath}"
if [ "\${REAL_PROJECT}" != "${projectPath}" ]; then
  REL_OUTPUT=$(echo "${outputDir}" | sed "s|${projectPath}/||")
  REAL_OUTPUT="\${REAL_PROJECT}/\${REL_OUTPUT}"
fi`;

  const templates: Record<string, string> = {
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
      [
        !tunnelActive
          ? 'No active DevBridge tunnel — deployment is incomplete. Proceed to Step 7 to expose the app.'
          : undefined,
        nginxType === 'proxy'
          ? formatProxyPortWarning(basePort, targetPort)
          : formatPortConflictWarning(basePort, targetPort),
        tunnelActive && nginxType !== 'proxy' ? formatPortDriftWarning(basePort, targetPort) : undefined,
      ]
        .filter(Boolean)
        .join(' ') || undefined,
  };
}

export async function deployCheck(
  workspaceId: string,
  { port, project, outputDir, frameworkType }: DeployCheckOptions,
  username = 'root',
  timeoutMs = 30000,
): Promise<DeployCheckResult> {
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
    `TUNNEL_ID=$(devbridge list -j 2>/dev/null | grep -oP '"tunnelId":\\s*"\\K[^"]+' | head -1)`,
    `if [ -z "$TUNNEL_ID" ]; then`,
    `  TUNNEL_ID=$(devbridge list 2>/dev/null | grep -E '^[a-z2-7]{8}[[:space:]]' | awk '{print $1}' | head -1)`,
    `fi`,
    `TUNNEL_URL="https://\${TUNNEL_ID}-${port}.${DEVBRIDGE_TUNNEL_DOMAIN}"`,
    `probe_tunnel() {`,
    `  local url="$1" code`,
    `  code=$(curl -s -o /tmp/.dc_tunnel_body -w "%{http_code}" --max-time 10 "$url" 2>/dev/null || echo "000")`,
    `  [ "$code" = "000" ] && return 1`,
    `  # A migrated gateway serves a placeholder page with HTTP 200 — treat it as unreachable.`,
    `  if grep -q "${DEVBRIDGE_MIGRATION_MARKER}" /tmp/.dc_tunnel_body 2>/dev/null; then return 1; fi`,
    `  rm -f /tmp/.dc_tunnel_body`,
    `  [ "$code" = "200" ] || [ "$code" = "304" ] || return 1`,
    `  return 0`,
    `}`,
    `if [ -n "$TUNNEL_ID" ] && probe_tunnel "$TUNNEL_URL"; then`,
    `  echo "tunnel_url_accessible:PASS ($TUNNEL_URL)"`,
    `  PASS=$((PASS+1))`,
    `elif [ -n "$TUNNEL_ID" ]; then`,
    `  echo "tunnel_url_accessible:FAIL ($TUNNEL_URL -> unreachable, tunnel not found, or migration placeholder page)"`,
    `else`,
    `  echo "tunnel_url_accessible:FAIL (no tunnel)"`,
    `fi`,
    `rm -f /tmp/.dc_tunnel_body 2>/dev/null || true`,
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
  // Strip ANSI escape sequences (CSI color/cursor codes and OSC shell-integration markers)
  // and split on any line-ending style (\r\n, \r, or \n) to handle all terminal outputs.
  // Use new RegExp to avoid ESLint no-control-regex on literal control chars in regex.
  const ESC = '\x1b';
  const csiRe = new RegExp(ESC + '\\[[0-9;]*[a-zA-Z]', 'g');
  const oscRe = new RegExp(ESC + '\\][^' + ESC + '\x07]*(?:\x07|' + ESC + '\\\\)', 'g');
  const cleanStdout = stdout.replace(csiRe, '').replace(oscRe, '');
  const checks: Record<string, DeployCheckEntry> = {};
  const lines = cleanStdout.split(new RegExp('\\r\\n|\\r|\\n'));
  for (const line of lines) {
    const trimmed = line.trim();
    const m = trimmed.match(/^(\w+):(PASS|FAIL|SKIP)\b(.*)/);
    if (m) checks[m[1]] = { status: m[2], detail: (m[3] || '').trim() };
  }
  const scoreMatch = cleanStdout.match(/SCORE:(\d+)\/(\d+)/);
  const tunnelMatch = cleanStdout.match(TUNNEL_URL_PATTERN);
  const complete = /VERDICT:COMPLETE/.test(cleanStdout);

  const missing: string[] = [];
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
    rawOutput: parseWarning ? stdout.trim() : undefined,
    nextStep: nextStepValue,
    remediation: nextStepValue === 'expose_via_devbridge' ? buildExposeRemediation(port) : undefined,
  };
}

export async function closeSession(workspaceId: string, username: string): Promise<boolean> {
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

export async function closeAllSessions(): Promise<void> {
  for (const [key, session] of sessions) {
    sessions.delete(key);
    try {
      session.close();
    } catch {}
  }
}

export { getCurrentWorkspaceId, setWorkspaceId, runNodeExec };
