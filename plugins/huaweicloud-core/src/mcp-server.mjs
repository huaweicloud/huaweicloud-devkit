#!/usr/bin/env node
import { stdin, stdout } from 'node:process';
import { rmSync, existsSync, readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { platform } from 'node:os';
import { fileURLToPath } from 'node:url';

import { TOOL_DEFINITIONS, callTool } from './tools.mjs';
import { getCachedUpdateInfo, readInstalledVersion, peekCachedUpdateInfo, applyUpdateHint } from './update-check.mjs';
import { initTelemetry } from './telemetry/telemetry.mjs';
import { detectAgent } from './telemetry/agent-detect.mjs';

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
  const { readProxyConfig } = await import('./proxy/proxy-config.mjs');
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

const __dirname = dirname(fileURLToPath(import.meta.url));
const pluginRoot = resolve(__dirname, '..');
const packageRoot = resolve(pluginRoot, '..', '..');
let pkgVersion = '0.0.0';
for (const base of [pluginRoot, packageRoot]) {
  try {
    const version = JSON.parse(readFileSync(join(base, 'package.json'), 'utf8')).version;
    if (version) {
      pkgVersion = version;
      break;
    }
  } catch {}
}

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
process.nextTick(() => {
  getCachedUpdateInfo(readInstalledVersion() || '0.0.0').catch(() => {});
});

// 会话内首个非 check/upgrade 工具调用附加 _updateInfo，只消费一次。
let hintConsumed = false;
function decorateResult(name, result) {
  if (hintConsumed) return result;
  try {
    const hint = peekCachedUpdateInfo();
    if (!hint) return result;
    const decorated = applyUpdateHint(result, name, hint);
    if (decorated !== result) hintConsumed = true;
    return decorated;
  } catch {
    return result; // 兜底装饰失败绝不影响工具调用
  }
}

let keepAlive = null;
function onStdinClose() {
  if (keepAlive) return;
  if (NEEDS_KEEPALIVE) {
    keepAlive = setInterval(() => {}, 60000);
  } else {
    // eslint-disable-next-line n/no-process-exit -- stdin close is the shutdown signal; exit now without waiting for stdout
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
      if (line) void handleMessage(JSON.parse(line));
      continue;
    }

    return;
  }
}

function parseContentLengthFrame(headerEnd) {
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
  void handleMessage(JSON.parse(body));
  return true;
}

async function handleMessage(message) {
  if (!Object.hasOwn(message, 'id')) {
    if (message.method === 'notifications/initialized') return;
    return;
  }
  try {
    const result = await dispatch(message.method, message.params || {});
    writeMessage({ jsonrpc: '2.0', id: message.id, result });
  } catch (error) {
    writeMessage({
      jsonrpc: '2.0',
      id: message.id,
      error: {
        code: -32603,
        message: error.message,
      },
    });
  }
}

async function dispatch(method, params) {
  if (method === 'initialize') {
    const ci = params.clientInfo || {};

    try {
      const { hdkitGenerateUserHash } = await import('./sandbox/hdkitservice-api.mjs');
      await Promise.race([
        hdkitGenerateUserHash(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000)),
      ]);
    } catch {}

    const agent = detectAgent(ci);
    initTelemetry({ harness: agent.harness, version: agent.version });
    return {
      protocolVersion: params.protocolVersion || '2024-11-05',
      capabilities: {
        tools: {},
      },
      serverInfo: {
        name: 'huaweicloud-devkit',
        version: pkgVersion,
      },
    };
  }

  if (method === 'tools/list') {
    return { tools: TOOL_DEFINITIONS };
  }

  if (method === 'tools/call') {
    const result = await callTool(params.name, params.arguments || {});
    const decorated = decorateResult(params.name, result);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(decorated, null, 2),
        },
      ],
      isError: false,
    };
  }

  if (method === 'resources/list') {
    return { resources: [] };
  }

  throw new Error(`Unsupported method: ${method}`);
}

function writeMessage(message) {
  const json = JSON.stringify(message);
  if (useContentLengthFraming) {
    stdout.write(`Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n${json}`);
  } else {
    stdout.write(json + '\n');
  }
}
