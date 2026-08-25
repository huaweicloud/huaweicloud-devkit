import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import test from 'node:test';

const root = fileURLToPath(new URL('..', import.meta.url));
const serverPath = join(root, 'plugins', 'huaweicloud-core', 'src', 'mcp-server.mjs');

function frame(message) {
  const json = JSON.stringify(message);
  return `Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n${json}`;
}

function createClient(server = serverPath) {
  const child = spawn(process.execPath, [server], {
    cwd: root,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buffer = Buffer.alloc(0);
  const pending = new Map();

  child.stdout.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;
      const header = buffer.subarray(0, headerEnd).toString('utf8');
      const match = header.match(/Content-Length:\s*(\d+)/i);
      if (!match) throw new Error(`Missing Content-Length header: ${header}`);
      const length = Number(match[1]);
      const bodyStart = headerEnd + 4;
      const bodyEnd = bodyStart + length;
      if (buffer.length < bodyEnd) return;
      const payload = JSON.parse(buffer.subarray(bodyStart, bodyEnd).toString('utf8'));
      buffer = buffer.subarray(bodyEnd);
      pending.get(payload.id)?.(payload);
    }
  });

  return {
    request(method, params = {}) {
      const id = Math.floor(Math.random() * 1_000_000);
      child.stdin.write(frame({ jsonrpc: '2.0', id, method, params }));
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${method}`)), 2000);
        pending.set(id, (payload) => {
          clearTimeout(timer);
          pending.delete(id);
          resolve(payload);
        });
      });
    },
    requestInChunks(method, params = {}, bodyBytesInFirstChunk = 1) {
      const id = Math.floor(Math.random() * 1_000_000);
      const payload = frame({ jsonrpc: '2.0', id, method, params });
      const bodyStart = payload.indexOf('\r\n\r\n') + 4;
      const splitAt = bodyStart + bodyBytesInFirstChunk;
      const first = payload.slice(0, splitAt);
      const second = payload.slice(splitAt);
      child.stdin.write(first);
      setTimeout(() => child.stdin.write(second), 50);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timed out waiting for split ${method}`)), 2000);
        pending.set(id, (message) => {
          clearTimeout(timer);
          pending.delete(id);
          resolve(message);
        });
      });
    },
    close() {
      child.kill();
    },
  };
}

test('MCP server initializes, lists tools, and plans CLI commands', async () => {
  const client = createClient();
  try {
    const initialized = await client.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '0.0.0' },
    });
    assert.equal(initialized.result.serverInfo.name, 'huaweicloud-devkit');

    const listed = await client.request('tools/list');
    const toolNames = listed.result.tools.map((tool) => tool.name);
    assert.ok(toolNames.includes('huaweicloud_plan_cli_command'));
    assert.ok(toolNames.includes('huaweicloud_list_operations'));
    assert.ok(toolNames.includes('huaweicloud_run_approved_command'));
    assert.ok(toolNames.includes('huaweicloud_show_profile_redacted'));
    assert.ok(toolNames.includes('huaweicloud_auth_status'));
    assert.ok(toolNames.includes('huaweicloud_auth_sync'));
    assert.ok(toolNames.includes('huaweicloud_sandbox_check_user'));
    assert.ok(toolNames.includes('huaweicloud_sandbox_connect'));

    const runReadonly = listed.result.tools.find((tool) => tool.name === 'huaweicloud_run_readonly_command');
    assert.ok(Object.hasOwn(runReadonly.inputSchema.properties, 'timeoutMs'));

    const planned = await client.request('tools/call', {
      name: 'huaweicloud_plan_cli_command',
      arguments: { args: ['ECS', 'NovaListServers'] },
    });
    assert.equal(planned.result.isError, false);
    assert.match(planned.result.content[0].text, /NovaListServers/);
  } finally {
    client.close();
  }
});

test('MCP server reports version from plugin package.json in installed layout', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hwc-version-'));
  try {
    const pluginRoot = join(dir, 'huaweicloud-plugins');
    cpSync(join(root, 'plugins', 'huaweicloud-core', 'src'), join(pluginRoot, 'src'), { recursive: true });
    cpSync(join(root, 'plugins', 'huaweicloud-core', 'safety'), join(pluginRoot, 'safety'), { recursive: true });
    writeFileSync(
      join(pluginRoot, 'package.json'),
      JSON.stringify({ name: 'huaweicloud-plugins', version: '9.9.9-test' }),
    );
    const client = createClient(join(pluginRoot, 'src', 'mcp-server.mjs'));
    try {
      const initialized = await client.request('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test-client', version: '0.0.0' },
      });
      assert.equal(initialized.result.serverInfo.version, '9.9.9-test');
    } finally {
      client.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('MCP server waits for incomplete Content-Length frames instead of spinning', async () => {
  const client = createClient();
  try {
    const payload = {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'split-client', version: '0.0.0' },
    };

    const initialized = await client.requestInChunks('initialize', payload, 8);

    assert.equal(initialized.result.serverInfo.name, 'huaweicloud-devkit');
  } finally {
    client.close();
  }
});
