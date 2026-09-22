import https from 'node:https';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const DEFAULT_API_URL = 'https://devbox.developer.myhuaweicloud.com';
const GATEWAY_PORT = '49983';
const PROCESS = '/process.Process';
const FILESYSTEM = '/filesystem.Filesystem';

let activeConnection = null;

function readApiKey() {
  return (process.env.DEVBOX_API_KEY || process.env.E2B_API_KEY || '').trim();
}

function readApiUrl() {
  return (process.env.DEVBOX_API_URL || process.env.E2B_API_URL || DEFAULT_API_URL).replace(/\/$/, '');
}

function readGatewayTemplate() {
  return (process.env.DEVBOX_GATEWAY_URL || '').trim();
}

function readGatewayIp() {
  return (process.env.DEVBOX_GATEWAY_IP || '').trim();
}

function readSkipTls() {
  const value = (process.env.DEVBOX_GATEWAY_SKIP_TLS_VERIFY || '').trim().toLowerCase();
  return ['true', '1', 'yes', 'on'].includes(value);
}

export function setActiveConnection(connection) {
  activeConnection = connection;
}

export function getActiveConnection() {
  return activeConnection;
}

export function clearActiveConnection() {
  activeConnection = null;
}

function httpsRequest(method, url, { headers = {}, body, dnsIp, skipTls = false, timeoutMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const options = {
      method,
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: parsed.pathname + parsed.search,
      headers: { ...headers },
      servername: parsed.hostname,
      timeout: timeoutMs,
    };
    if (dnsIp) {
      options.lookup = (hostname, opts, cb) => cb(null, [{ address: dnsIp, family: 4 }]);
    }
    if (skipTls) options.rejectUnauthorized = false;

    const req = https.request(options, (res) => {
      const buffers = [];
      res.on('data', (chunk) => buffers.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, body: Buffer.concat(buffers) }));
    });
    req.on('timeout', () => req.destroy(new Error(`request timed out after ${timeoutMs}ms`)));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function mgmtRequest(method, path, { body, headers = {}, apiKey, apiUrl } = {}) {
  const key = apiKey || readApiKey();
  if (!key) {
    throw new Error('DEVBOX_API_KEY / E2B_API_KEY is required — provide it via env or the api_key argument.');
  }
  const base = apiUrl || readApiUrl();
  return httpsRequest(method, `${base}${path}`, {
    headers: { 'X-API-Key': key, 'Content-Type': 'application/json', ...headers },
    body,
  });
}

function dataPlaneRequest(connection, method, path, { headers = {}, body, timeoutMs } = {}) {
  return httpsRequest(method, `${connection.gatewayUrl}${path}`, {
    headers: {
      Cookie: `relay_token=${connection.connectToken}`,
      'E2B-Sandbox-Id': connection.sandboxId,
      'E2B-Sandbox-Port': GATEWAY_PORT,
      ...headers,
    },
    body,
    dnsIp: connection.gatewayIp || undefined,
    skipTls: connection.skipTls,
    timeoutMs,
  });
}

export function connectFrame(value) {
  const json = Buffer.from(JSON.stringify(value));
  const frame = Buffer.alloc(5 + json.length);
  frame[0] = 0;
  frame.writeUInt32BE(json.length, 1);
  json.copy(frame, 5);
  return frame;
}

export function decodeFrames(buffer) {
  const events = [];
  let offset = 0;
  while (offset + 5 <= buffer.length) {
    const size = buffer.readUInt32BE(offset + 1);
    if (buffer.length < offset + 5 + size) break;
    const payload = buffer.slice(offset + 5, offset + 5 + size);
    offset += 5 + size;
    let value;
    try {
      value = JSON.parse(payload.toString());
    } catch {
      value = { raw: payload.toString('base64') };
    }
    events.push(value);
  }
  return events;
}

function parseJson(response, context) {
  try {
    return JSON.parse(response.body.toString());
  } catch {
    throw new Error(`${context}: non-JSON response (HTTP ${response.status})`);
  }
}

function throwForError(response, context) {
  if (response.status >= 200 && response.status < 300) return response;
  let detail = '';
  try {
    detail = response.body.toString().slice(0, 400);
  } catch {}
  const error = new Error(`${context} failed (HTTP ${response.status}): ${detail}`);
  error.status = response.status;
  throw error;
}

export function buildGatewayUrl(connection, template, tunnelId) {
  const resolved = template || connection.domain || '';
  if (!resolved) throw new Error('DevBox returned no data-plane endpoint');
  if (!template && /\.sandbox\.devbox\.local$/.test(resolved.replace(/^https:\/\//, ''))) {
    throw new Error(
      'DevBox returned a placeholder EnvD endpoint (*.sandbox.devbox.local). Set DEVBOX_GATEWAY_URL to a {tunnel_id}/{port} template.',
    );
  }
  return resolved.replaceAll('{tunnel_id}', tunnelId).replaceAll('{port}', GATEWAY_PORT);
}

function connectionFrom(payload, { gatewayUrl } = {}) {
  const sandboxId = payload.sandboxID ?? payload.sandboxId ?? payload.id;
  const tunnelId = payload.tunnelId ?? '';
  const connectToken = payload.connectToken ?? '';
  if (!sandboxId) throw new Error('DevBox response did not include a sandbox id');
  if (!connectToken) throw new Error('DevBox response did not include a connectToken');
  const gateway = buildGatewayUrl(
    { domain: payload.domain, connectToken },
    gatewayUrl || readGatewayTemplate(),
    tunnelId,
  );
  return {
    sandboxId,
    tunnelId,
    connectToken,
    domain: payload.domain ?? '',
    gatewayUrl: gateway,
    gatewayIp: readGatewayIp(),
    skipTls: readSkipTls(),
    envdVersion: payload.envdVersion ?? '',
    info: {
      sandboxId,
      templateId: payload.templateID ?? '',
      state: payload.running ?? payload.state ?? 'running',
      envdVersion: payload.envdVersion ?? '',
    },
  };
}

export async function devboxCreate(options = {}) {
  const body = JSON.stringify({
    templateID: options.template || 'default',
    timeout: options.timeout ?? 300,
    secure: options.secure ?? true,
    metadata: options.metadata || {},
    envVars: options.envs || {},
    volumeMounts: [],
  });
  const response = throwForError(
    await mgmtRequest('POST', '/sandboxes', {
      body,
      apiKey: options.apiKey,
      apiUrl: options.apiUrl,
      headers: { 'Idempotency-Key': options.idempotencyKey || randomUUID() },
    }),
    'create sandbox',
  );
  return connectionFrom(parseJson(response, 'create sandbox'), options);
}

export async function devboxConnect(sandboxId, options = {}) {
  const response = throwForError(
    await mgmtRequest('POST', `/sandboxes/${encodeURIComponent(sandboxId)}/connect`, {
      body: JSON.stringify({ timeout: options.timeout ?? 300 }),
      apiKey: options.apiKey,
      apiUrl: options.apiUrl,
    }),
    'connect sandbox',
  );
  return connectionFrom(parseJson(response, 'connect sandbox'), options);
}

export async function devboxKill(sandboxId, options = {}) {
  const response = await mgmtRequest('DELETE', `/sandboxes/${encodeURIComponent(sandboxId)}`, {
    apiKey: options.apiKey,
    apiUrl: options.apiUrl,
  });
  return { deleted: response.status >= 200 && response.status < 300, status: response.status };
}

export async function devboxGet(sandboxId, options = {}) {
  const response = throwForError(
    await mgmtRequest('GET', `/sandboxes/${encodeURIComponent(sandboxId)}`, {
      apiKey: options.apiKey,
      apiUrl: options.apiUrl,
    }),
    'get sandbox',
  );
  return parseJson(response, 'get sandbox');
}

export async function devboxList(options = {}) {
  const response = throwForError(
    await mgmtRequest('GET', '/v2/sandboxes', { apiKey: options.apiKey, apiUrl: options.apiUrl }),
    'list sandboxes',
  );
  const payload = parseJson(response, 'list sandboxes');
  const items = Array.isArray(payload) ? payload : (payload?.items ?? payload?.sandboxes ?? []);
  return {
    items: items.map((item) => sanitizeSecrets(item)),
    total: payload?.total,
    nextToken: payload?.nextToken,
  };
}

export async function runCommand(connection, command, options = {}) {
  if (!command || !String(command).trim()) throw new Error('command must not be blank');
  const request = {
    process: {
      cmd: '/bin/bash',
      args: ['-l', '-c', String(command)],
      envs: options.envs || {},
    },
    stdin: options.stdin ?? false,
  };
  if (options.cwd) request.process.cwd = options.cwd;

  const response = throwForError(
    await dataPlaneRequest(connection, 'POST', `${PROCESS}/Start`, {
      headers: { 'Connect-Protocol-Version': '1', 'Content-Type': 'application/connect+json' },
      body: connectFrame(request),
      timeoutMs: options.timeoutMs,
    }),
    'run command',
  );

  let pid;
  let stdout = '';
  let stderr = '';
  let exit;
  const base64ToText = (value) => (value ? Buffer.from(value, 'base64').toString('utf8') : '');

  for (const frame of decodeFrames(response.body)) {
    const event = frame.event;
    if (!event || typeof event !== 'object') continue;
    if (event.start?.pid) pid = event.start.pid;
    if (event.data?.stdout) stdout += base64ToText(event.data.stdout);
    if (event.data?.stderr) stderr += base64ToText(event.data.stderr);
    if (event.end) exit = event.end;
  }

  const result = { pid, stdout, stderr, exitCode: typeof exit?.exitCode === 'number' ? exit.exitCode : undefined };
  if (options.background) return { pid, ...result };
  if (options.check === false) return result;
  if (result.exitCode !== undefined && result.exitCode !== 0) {
    const error = new Error(`command exited with code ${result.exitCode}: ${command}`);
    error.result = result;
    error.exitCode = result.exitCode;
    throw error;
  }
  return result;
}

export async function writeFile(connection, path, data, options = {}) {
  const body = typeof data === 'string' ? Buffer.from(data, options.encoding || 'utf8') : data;
  const response = throwForError(
    await dataPlaneRequest(connection, 'POST', `/files?path=${encodeURIComponent(path)}`, {
      headers: { 'Content-Type': 'application/octet-stream' },
      body,
    }),
    'write file',
  );
  return parseJson(response, 'write file');
}

export async function readFile(connection, path, options = {}) {
  const response = throwForError(
    await dataPlaneRequest(connection, 'GET', `/files?path=${encodeURIComponent(path)}`),
    'read file',
  );
  if (options.encoding === false) return response.body;
  return response.body.toString(options.encoding || 'utf8');
}

async function fsUnary(connection, method, json) {
  const response = throwForError(
    await dataPlaneRequest(connection, 'POST', `${FILESYSTEM}/${method}`, {
      headers: { 'Connect-Protocol-Version': '1', 'Content-Type': 'application/json' },
      body: JSON.stringify(json),
    }),
    `filesystem ${method}`,
  );
  return parseJson(response, `filesystem ${method}`);
}

export const devboxFs = {
  listDir: (connection, path, depth = 1) => fsUnary(connection, 'ListDir', { path, depth }),
  stat: (connection, path) => fsUnary(connection, 'Stat', { path }),
  makeDir: (connection, path) => fsUnary(connection, 'MakeDir', { path }),
  move: (connection, source, destination) => fsUnary(connection, 'Move', { source, destination }),
  remove: (connection, path) => fsUnary(connection, 'Remove', { path }),
};

export async function uploadFile(connection, localPath, remotePath) {
  const data = readFileSync(localPath);
  return writeFile(connection, remotePath, data);
}

export async function downloadFile(connection, remotePath, localPath) {
  const data = await readFile(connection, remotePath, { encoding: false });
  writeFileSync(localPath, data);
  return localPath;
}

export async function listProcesses(connection) {
  const response = throwForError(
    await dataPlaneRequest(connection, 'POST', `${PROCESS}/List`, {
      headers: { 'Connect-Protocol-Version': '1', 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }),
    'list processes',
  );
  return parseJson(response, 'list processes');
}

export function redactedConnection(connection) {
  if (!connection) return null;
  const token = connection.connectToken || '';
  return {
    sandboxId: connection.sandboxId,
    tunnelId: connection.tunnelId,
    gatewayUrl: connection.gatewayUrl,
    envdVersion: connection.envdVersion,
    connectToken: token ? `${token.slice(0, 8)}…(${token.length})` : null,
  };
}

const SECRET_KEY = /token|secret|api[-_]?key|password|credential/i;
const JWT_PATTERN = /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/;

export function sanitizeSecrets(value) {
  if (Array.isArray(value)) return value.map((item) => sanitizeSecrets(item));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, entry] of Object.entries(value)) {
      if (SECRET_KEY.test(key)) {
        out[key] = redactSecret(entry);
        continue;
      }
      out[key] = sanitizeSecrets(entry);
    }
    return out;
  }
  if (typeof value === 'string' && JWT_PATTERN.test(value)) return redactSecret(value);
  return value;
}

function redactSecret(value) {
  if (typeof value !== 'string') return undefined;
  return value.length <= 12 ? '[redacted]' : `${value.slice(0, 6)}…(${value.length})`;
}
