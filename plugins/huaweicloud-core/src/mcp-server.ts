#!/usr/bin/env node
import { rmSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DevkitStdioTransport } from './mcp-stdio-transport.ts';
import { createDevkitMcpServer } from './mcp-protocol.ts';
import { DEFAULT_PORT, DEFAULT_HOST } from './mcp-server-remote.ts';
import { getCachedUpdateInfo, readInstalledVersion } from './update-check.ts';

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
} catch {
  // best-effort: unreadable proxy config means no proxy env; the server still starts
}

// The MCP server is now loaded by a live agent session. Clear the install marker
// in this plugin dir so `doctor` no longer reports "restart needed".
try {
  const pluginDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const marker = resolve(pluginDir, '.installed');
  if (existsSync(marker)) rmSync(marker, { force: true });
} catch {
  // best-effort: a leftover marker only costs doctor a spurious restart hint
}

if (transport === 'remote') {
  const { startRemoteServer } = await import('./mcp-server-remote.ts');
  startRemoteServer({ port: remotePort, host: remoteHost }).catch((error: unknown) => {
    process.stderr.write(
      `Failed to start MCP remote server: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  });
} else {
  void runStdioServer();
}

async function runStdioServer() {
  // 版本升级检测预热：异步、非阻塞；失败静默（离线/超时不影响会话）。
  getCachedUpdateInfo(readInstalledVersion() || '0.0.0').catch(() => {});

  const server = createDevkitMcpServer({ sessionId: 'stdin', runtimePacks: true });
  const transport = new DevkitStdioTransport();
  await server.connect(transport);
}
