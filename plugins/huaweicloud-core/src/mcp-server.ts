#!/usr/bin/env node
import { stdin, stdout } from 'node:process';
import { rmSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { platform } from 'node:os';
import { fileURLToPath } from 'node:url';

import { dispatch } from './mcp-protocol.ts';
import { DEFAULT_PORT, DEFAULT_HOST } from './mcp-server-remote.ts';
import { getCachedUpdateInfo, readInstalledVersion } from './update-check.ts';
import { detectAgent } from './telemetry/agent-detect.ts';

const transportIdx = process.argv.indexOf('--transport');
const transport = transportIdx > -1 && process.argv[transportIdx + 1] ? process.argv[transportIdx + 1] : 'stdio';
const portIdx = process.argv.indexOf('--port');
const remotePort = portIdx > -1 ? Number(process.argv[portIdx + 1]) : DEFAULT_PORT;
const hostIdx = process.argv.indexOf('--host');
const remoteHost = hostIdx > -1 && process.argv[hostIdx + 1] ? process.argv[hostIdx + 1] : DEFAULT_HOST;

const projectDirIdx = process.argv.indexOf('--codearts-project-dir');
if (projectDirIdx > -1 && process.argv[projectDirIdx + 1]) {
  process.env.CODEARTS_PROJECT_DIR = process.argv[projectDirIdx + 1];
}

const endpointIdx = process.argv.indexOf('--hdkitservice-endpoint');
if (endpointIdx > -1 && process.argv[endpointIdx + 1]) {
  process.env.HDKITSERVICE_ENDPOINT = process.argv[endpointIdx + 1];
}

const telemetryEndpointIdx = process.argv.indexOf('--telemetry-endpoint');
if (telemetryEndpointIdx > -1 && process.argv[telemetryEndpointIdx + 1]) {
  process.env.HUAWEICLOUD_DEVKIT_TELEMETRY_ENDPOINT = process.argv[telemetryEndpointIdx + 1];
}

try {
  const { readProxyConfig } = await import('./proxy/proxy-config.ts');
  const proxyConfig = readProxyConfig();
  if (proxyConfig) {
    if (proxyConfig.https_proxy || proxyConfig.HTTPS_PROXY) {
      process.env.HTTPS_PROXY = process.env.HTTPS_PROXY || proxyConfig.https_proxy || proxyConfig.HTTPS_PROXY;
    }
    if (proxyConfig.http_proxy || proxyConfig.HTTP_PROXY) {
      process.env.HTTP_PROXY = process.env.HTTP_PROXY || proxyConfig.http_proxy || proxyConfig.HTTP_PROXY;
    }
  }
} catch {}

// The MCP server is now loaded by a live agent session. Clear the install marker
// in this plugin dir so `doctor` no longer reports "restart needed".
try {
  const pluginDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const marker = resolve(pluginDir, '.installed');
  if (existsSync(marker)) rmSync(marker, { force: true });
} catch {}

if (transport === 'remote') {
  const { startRemoteServer } = await import('./mcp-server-remote.ts');
  startRemoteServer({ port: remotePort, host: remoteHost }).catch((error) => {
    process.stderr.write(`Failed to start MCP remote server: ${error.message}\n`);
    process.exit(1);
  });
} else {
  runStdioServer();
}

type JsonRpcRequest = { id?: unknown; method?: string; params?: unknown };
type JsonRpcResponse = {
  jsonrpc: '2.0';
  id: unknown;
  result?: unknown;
  error?: { code: number; message: string };
};

// JSON-RPC errors carry a numeric code; anything thrown may not. This reads the
// code off unknown without pretending the whole value is a shaped error.
function jsonRpcErrorFrom(error: unknown): { code: number; message: string } {
  const code = (error as { code?: unknown }).code;
  return {
    code: Number.isSafeInteger(code) ? (code as number) : -32603,
    message: error instanceof Error ? error.message : String(error),
  };
}

function runStdioServer() {
  const updatePrewarm = () => {
    getCachedUpdateInfo(readInstalledVersion() || '0.0.0').catch(() => {});
  };

  let buffer = Buffer.alloc(0);
  let useContentLengthFraming = true;

  // Keep the event loop alive after stdin is closed (Windows Hermes workaround).
  // Node.js exits when no active handles remain; the stdin 'data' listener is
  // the only handle. On Windows, Hermes may close the stdin pipe after the
  // initial handshake, causing the process to exit silently (exit 0).
  //
  // For Hermes on Windows: start a keepalive timer on stdin close, and only exit
  // when stdout also closes.
  // For all other agents (OfficeAce, WorkBuddy, etc.): stdin close is the
  // shutdown signal — exit cleanly so the host does not see CLOSE_TIMEOUT.
  const { harness } = detectAgent();
  const NEEDS_KEEPALIVE = harness === 'hermes' && platform() === 'win32';

  // 版本升级检测预热：异步、非阻塞；失败静默（离线/超时不影响会话）。
  process.nextTick(updatePrewarm);

  let keepAlive: NodeJS.Timeout | null = null;
  function onStdinClose() {
    if (keepAlive) return;
    if (NEEDS_KEEPALIVE) {
      keepAlive = setInterval(() => {}, 60000);
    } else {
      process.exit(0);
    }
  }
  function onStdoutClose() {
    if (keepAlive) {
      clearInterval(keepAlive);
      keepAlive = null;
    }
    process.exitCode = 0;
  }
  stdin.on('close', onStdinClose);
  stdin.on('end', onStdinClose);
  stdout.on('close', onStdoutClose);

  stdin.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    readFrames();
  });

  function readFrames() {
    while (true) {
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd !== -1) {
        useContentLengthFraming = true;
        const consumed = parseContentLengthFrame(headerEnd);
        if (!consumed) return;
        continue;
      }

      const lf = buffer.indexOf('\n');
      if (lf !== -1) {
        useContentLengthFraming = false;
        const line = buffer.subarray(0, lf).toString('utf8').trim();
        buffer = buffer.subarray(lf + 1);
        if (line) {
          try {
            void handleMessage(JSON.parse(line));
          } catch {
            writeParseError();
          }
        }
        continue;
      }

      return;
    }
  }

  function parseContentLengthFrame(headerEnd: number): boolean {
    const header = buffer.subarray(0, headerEnd).toString('utf8');
    const match = header.match(/Content-Length:\s*(\d+)/i);
    if (!match) {
      buffer = Buffer.alloc(0);
      return true;
    }
    const length = Number(match[1]);
    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + length;
    if (buffer.length < bodyEnd) return false;
    const body = buffer.subarray(bodyStart, bodyEnd).toString('utf8');
    buffer = buffer.subarray(bodyEnd);
    try {
      void handleMessage(JSON.parse(body));
    } catch {
      writeParseError();
    }
    return true;
  }

  async function handleMessage(raw: unknown) {
    // Valid JSON that is not an object (null / array / string) is an invalid
    // request per JSON-RPC 2.0 — reply -32600 rather than silently dropping it.
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      writeJsonRpcError(-32600, 'Invalid Request');
      return;
    }
    const message = raw as JsonRpcRequest;
    if (!Object.hasOwn(message, 'id')) {
      if (message.method === 'notifications/initialized') return;
      return;
    }
    try {
      const result = await dispatch(message.method ?? '', message.params || {}, { sessionId: 'stdin' });
      writeMessage({ jsonrpc: '2.0', id: message.id, result });
    } catch (error) {
      writeMessage({
        jsonrpc: '2.0',
        id: message.id,
        error: jsonRpcErrorFrom(error),
      });
    }
  }

  function writeMessage(message: JsonRpcResponse) {
    const json = JSON.stringify(message);
    if (useContentLengthFraming) {
      stdout.write(`Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n${json}`);
    } else {
      stdout.write(json + '\n');
    }
  }

  function writeJsonRpcError(code: number, message: string) {
    writeMessage({
      jsonrpc: '2.0',
      id: null,
      error: { code, message },
    });
  }

  function writeParseError() {
    writeJsonRpcError(-32700, 'Parse error');
  }
}
