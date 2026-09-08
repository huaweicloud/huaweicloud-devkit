import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import test from 'node:test';

const root = fileURLToPath(new URL('..', import.meta.url));
const srcDir = join(root, 'plugins', 'huaweicloud-core', 'src');
const serverPath = join(srcDir, 'mcp-server.mjs');

let server;
let base;
let startRemoteServer;

test.before(async () => {
  const mod = await import(join(srcDir, 'mcp-server-remote.mjs'));
  startRemoteServer = mod.startRemoteServer;
  const started = await startRemoteServer({ port: 0 });
  server = started.server;
  base = `http://127.0.0.1:${started.port}`;
});

test.after(async () => {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
});

async function rpc(method, params = {}, extraHeaders = {}) {
  const res = await fetch(`${base}/`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...extraHeaders,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return { status: res.status, contentType: res.headers.get('content-type'), body: await res.json() };
}

test('remote MCP server initializes, lists tools, and plans CLI commands', async () => {
  const initialized = await rpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'test-client', version: '0.0.0' },
  });
  assert.equal(initialized.status, 200);
  assert.equal(initialized.body.result.serverInfo.name, 'huaweicloud-devkit');
  assert.equal(initialized.body.result.protocolVersion, '2024-11-05');
  assert.deepEqual(initialized.body.result.capabilities, { tools: {} });

  const listed = await rpc('tools/list');
  const toolNames = new Set(listed.body.result.tools.map((tool) => tool.name));
  assert.ok(toolNames.has('huaweicloud_plan_cli_command'));
  assert.ok(toolNames.has('huaweicloud_list_operations'));

  const planned = await rpc('tools/call', {
    name: 'huaweicloud_plan_cli_command',
    arguments: { args: ['ECS', 'NovaListServers'] },
  });
  assert.equal(planned.body.result.isError, false);
  assert.match(planned.body.result.content[0].text, /NovaListServers/);
});

test('remote MCP server returns 202 for notifications/initialized', async () => {
  const res = await fetch(`${base}/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  });
  assert.equal(res.status, 202);
});

test('remote MCP server returns 400 for invalid JSON body', async () => {
  const res = await fetch(`${base}/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{not-json]',
  });
  assert.equal(res.status, 400);
});

test('remote MCP server answers OPTIONS preflight with CORS headers', async () => {
  const res = await fetch(`${base}/`, { method: 'OPTIONS' });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  assert.match(res.headers.get('access-control-allow-headers') || '', /MCP-Protocol-Version/i);
});

test('remote MCP server rejects GET with 405', async () => {
  const res = await fetch(`${base}/`, { method: 'GET' });
  assert.equal(res.status, 405);
});

test('remote MCP server falls back to SSE when client only accepts text/event-stream', async () => {
  const res = await fetch(`${base}/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'resources/list', params: {} }),
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /text\/event-stream/);
  const text = await res.text();
  assert.match(text, /event: message/);
  assert.match(text, /"resources":/);
});

test('exports DEFAULT_PORT 9528 to avoid IACMCPServer port 9527 conflict', async () => {
  const mod = await import(`${srcDir}/mcp-server-remote.mjs`);
  assert.equal(mod.DEFAULT_PORT, 9528);
});

test('startRemoteServer binds DEFAULT_PORT when no port passed', async () => {
  let started;
  try {
    started = await startRemoteServer({});
    assert.equal(started.port, 9528);
  } finally {
    if (started) {
      await started.close();
    }
  }
});

test('startRemoteServer supports binding non-loopback host via host option', async () => {
  const started = await startRemoteServer({ port: 0, host: '0.0.0.0' });
  try {
    assert.equal(started.server.address().address, '0.0.0.0');
  } finally {
    await started.close();
  }
});

function spawnRemote(flags) {
  const child = spawn(process.execPath, [serverPath, '--transport', 'remote', ...flags], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const whenListening = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not report listening address:\n${output}`)), 10000);
    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
      const match = output.match(/listening on ([0-9.:]+):(\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve({ host: match[1], port: Number(match[2]) });
      }
    });
    child.once('error', reject);
  });
  return { child, whenListening };
}

test('mcp-server.mjs --transport remote honors --host and --port flags', async () => {
  const { child, whenListening } = spawnRemote(['--host', '0.0.0.0', '--port', '0']);
  try {
    const addr = await whenListening;
    assert.equal(addr.host, '0.0.0.0');
    const res = await fetch(`http://127.0.0.1:${addr.port}/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'spawn-test', version: '0.0.0' },
        },
      }),
    });
    const body = await res.json();
    assert.equal(body.result.serverInfo.name, 'huaweicloud-devkit');
  } finally {
    child.kill();
  }
});
