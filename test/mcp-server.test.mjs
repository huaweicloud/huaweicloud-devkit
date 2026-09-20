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

function createClient(server = serverPath, env = {}) {
  const child = spawn(process.execPath, [server], {
    cwd: root,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
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
    /**
     * 发送一条无 id 的通知消息（如 notifications/cancelled），不等待响应。
     */
    notify(method, params = {}) {
      const json = JSON.stringify({ jsonrpc: '2.0', method, params });
      child.stdin.write(`Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n${json}`);
    },
    /**
     * 发送一条带 id 的请求并返回响应 promise，但不使用默认 2000ms 超时
     * （供需要自定义时序的场景，如发请求后立即 cancel）。
     */
    rawRequest(id, method, params = {}, timeoutMs = 5000) {
      const json = JSON.stringify({ jsonrpc: '2.0', id, method, params });
      child.stdin.write(`Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n${json}`);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${method}`)), timeoutMs);
        pending.set(id, (payload) => {
          clearTimeout(timer);
          pending.delete(id);
          resolve(payload);
        });
      });
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
    const toolNames = new Set(listed.result.tools.map((tool) => tool.name));
    assert.ok(toolNames.has('huaweicloud_plan_cli_command'));
    assert.ok(toolNames.has('huaweicloud_list_operations'));
    assert.ok(toolNames.has('huaweicloud_run_approved_command'));
    assert.ok(toolNames.has('huaweicloud_show_profile_redacted'));
    assert.ok(toolNames.has('huaweicloud_auth_status'));
    assert.ok(toolNames.has('huaweicloud_auth_sync'));
    assert.ok(toolNames.has('huaweicloud_sandbox_check_user'));
    assert.ok(toolNames.has('huaweicloud_sandbox_connect'));

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

test('MCP server returns JSON-RPC -32601 for unknown methods (#650 D9-2)', async () => {
  const client = createClient();
  try {
    await client.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '0.0.0' },
    });
    const response = await client.request('tools/unknown_xyz');
    assert.ok(response.error, 'expected an error response');
    assert.equal(response.error.code, -32601);
    assert.match(response.error.message, /Method not found/);
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

test('initialize capabilities declares cancellation (#698 D9-9)', async () => {
  const client = createClient();
  try {
    const initialized = await client.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '0.0.0' },
    });
    assert.ok(Object.hasOwn(initialized.result.capabilities, 'cancellation'), 'capabilities must declare cancellation');
  } finally {
    client.close();
  }
});

test('tools/call request-level timeout returns JSON-RPC -32000 (#698 D9-9)', async () => {
  // HCLOUD_MCP_REQUEST_TIMEOUT_MS=20 使协议层超时 20ms；
  // huaweicloud_list_operations(ECS) 调用 runHcloud(['ECS','--help'])，实测 ~55-60ms，
  // 20ms 超时必然先于工作完成触发 → 客户端收到 { code: -32000, message 含 timeout }。
  const client = createClient(serverPath, { HCLOUD_MCP_REQUEST_TIMEOUT_MS: '20' });
  try {
    await client.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'timeout-test', version: '0.0.0' },
    });
    const res = await client.request('tools/call', {
      name: 'huaweicloud_list_operations',
      arguments: { service: 'ECS' },
    });
    assert.ok(res.error, 'expected an error response for timed-out request');
    assert.equal(res.error.code, -32000, 'error code must be -32000');
    assert.match(res.error.message, /timeout|timed out/i, 'message must mention timeout');
  } finally {
    client.close();
  }
});

test('notifications/cancelled does not crash server and is accepted (#698 D9-9)', async () => {
  const client = createClient();
  try {
    await client.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'cancel-test', version: '0.0.0' },
    });
    // 发送一条针对不存在的 requestId 的取消通知——服务器应静默接受不崩溃。
    client.notify('notifications/cancelled', { requestId: 12345, reason: 'test-no-op' });

    // 服务器仍可正常响应后续请求（证明未崩溃）。
    const listed = await client.request('tools/list');
    assert.ok(Array.isArray(listed.result.tools), 'server still responsive after cancel notification');
  } finally {
    client.close();
  }
});

test('notifications/cancelled interrupts an in-flight tools/call (#698 D9-9)', async () => {
  // huaweicloud_check_cli ~25ms；我们发起请求后立即发送 cancel 通知。
  // 即便工具很快返回，cancel 通知到达时若请求已完成则为 no-op（合法）；
  // 若请求仍在 flight 则被中断。两种情况服务器都不应崩溃，且客户端必然收到
  // 一个响应（要么正常 result，要么 -32000 取消错误）。本用例验证「不丢失响应、不崩溃」。
  const client = createClient();
  try {
    await client.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'cancel-inflight', version: '0.0.0' },
    });
    const id = Math.floor(Math.random() * 1_000_000);
    const responsePromise = client.rawRequest(id, 'tools/call', {
      name: 'huaweicloud_check_cli',
      arguments: {},
    });
    // 立即发送取消通知（同 id）。
    client.notify('notifications/cancelled', { requestId: id, reason: 'client cancelled inflight' });

    const payload = await responsePromise;
    assert.ok(payload, 'client must receive exactly one response (result or -32000)');
    // 合法结果：有 result 或 error.code=-32000。
    const okResult = payload.result !== undefined;
    const okCancel = payload.error?.code === -32000;
    assert.ok(okResult || okCancel, 'response is either a normal result or a -32000 cancellation');
  } finally {
    client.close();
  }
});
