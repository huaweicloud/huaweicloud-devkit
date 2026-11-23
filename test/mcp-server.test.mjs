import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import test from 'node:test';

// Never trigger a real background KooCLI preinstall or auto-upgrade from
// spawned servers here (both hooks run at mcp-server.mjs import time).
process.env.HUAWEICLOUD_SKIP_HCLOUD_PREINSTALL = '1';
process.env.HUAWEICLOUD_DEVKIT_SKIP_UPDATE = '1';

const root = fileURLToPath(new URL('..', import.meta.url));
const serverPath = join(root, 'plugins', 'huaweicloud-core', 'src', 'mcp-server.mjs');

// D9-9: replace the real hcloud binary with a deterministic "hangs forever"
// fixture so timeout/cancel tests do not depend on whether KooCLI is installed
// or how fast it runs on a given machine.
function createHangingHcloudFixture(dir) {
  const fixture = join(dir, 'fake-hcloud.mjs');
  const pidFile = join(dir, 'fake-hcloud.pid');
  writeFileSync(
    fixture,
    [
      "import { writeFileSync } from 'node:fs';",
      "import { setTimeout as sleep } from 'node:timers/promises';",
      'writeFileSync(process.env.FAKE_HCLOUD_PID_FILE, String(process.pid));',
      'await sleep(Number(process.env.FAKE_HCLOUD_SLEEP_MS || 30000));',
      "process.stdout.write('fake hcloud done\\n');",
      '',
    ].join('\n'),
  );
  return {
    fixture,
    pidFile,
    env: {
      HCLOUD_BIN: process.execPath,
      HCLOUD_BIN_ARGS_JSON: JSON.stringify([fixture]),
      FAKE_HCLOUD_PID_FILE: pidFile,
    },
  };
}

async function waitForFile(path, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return readFileSync(path, 'utf8').trim();
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return null;
}

async function waitForProcessExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}

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
  const frames = [];

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
      frames.push(payload);
      pending.get(payload.id)?.(payload);
    }
  });

  return {
    raw(data) {
      child.stdin.write(data);
    },
    frames() {
      return frames;
    },
    isAlive() {
      return child.exitCode === null;
    },
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
    assert.ok(toolNames.has('huaweicloud_plan_manifest'));
    assert.ok(toolNames.has('huaweicloud_run_approved_manifest'));
    assert.ok(toolNames.has('huaweicloud_show_profile_redacted'));
    assert.ok(toolNames.has('huaweicloud_auth_status'));
    assert.ok(toolNames.has('huaweicloud_auth_sync'));
    assert.ok(toolNames.has('huaweicloud_sandbox_check_user'));
    assert.ok(toolNames.has('huaweicloud_sandbox_connect'));
    assert.ok(toolNames.has('huaweicloud_sandbox_shutdown'));

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

test('MCP server returns -32700 and keeps serving after a malformed frame (#643)', async () => {
  const client = createClient();
  try {
    await client.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '0.0.0' },
    });
    client.raw('Content-Length: 5\r\n\r\n{bad!');

    const deadline = Date.now() + 3000;
    let parseError;
    while (Date.now() < deadline) {
      parseError = client.frames().find((p) => p.error && p.error.code === -32700);
      if (parseError) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(parseError, 'expected a -32700 Parse error frame');
    assert.equal(parseError.error.code, -32700);
    assert.equal(parseError.id, null, 'parse error has null id');

    const listed = await client.request('tools/list');
    assert.ok(Array.isArray(listed.result.tools), 'server still serves valid requests after a parse error');
    assert.equal(client.isAlive(), true, 'malformed frame must not kill the process');
  } finally {
    client.close();
  }
});

test('MCP server returns -32700 for a malformed newline-delimited frame (#643)', async () => {
  const child = spawn(process.execPath, [serverPath], { stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    out += chunk;
  });
  try {
    child.stdin.write('{bad!\n');
    const deadline = Date.now() + 3000;
    let line = '';
    while (Date.now() < deadline) {
      line = out.split('\n').find((l) => l.includes('-32700')) || '';
      if (line) break;
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    assert.ok(line, 'expected a newline-delimited -32700 frame');
    const payload = JSON.parse(line);
    assert.equal(payload.error.code, -32700);
    assert.equal(payload.id, null);
    assert.equal(child.exitCode, null, 'malformed newline frame must not kill the process');
  } finally {
    child.kill();
  }
});

test('MCP server returns JSON-RPC -32602 for tools/call missing required params (#704)', async () => {
  const client = createClient();
  try {
    await client.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '0.0.0' },
    });
    const single = await client.request('tools/call', { name: 'huaweicloud_plan_cli_command', arguments: {} });
    assert.ok(single.error, 'missing required param must be an error');
    assert.equal(single.error.code, -32602);
    assert.match(single.error.message, /missing required field/);
    assert.match(single.error.message, /"args"/);

    const multi = await client.request('tools/call', { name: 'huaweicloud_run_approved_command', arguments: {} });
    assert.ok(multi.error);
    assert.equal(multi.error.code, -32602);
    assert.match(multi.error.message, /"args"/);
    assert.match(multi.error.message, /"approvalToken"/);
    assert.match(multi.error.message, /"approvedByUser"/);
  } finally {
    client.close();
  }
});

test('MCP server returns JSON-RPC -32602 for tools/call with unknown tool name (#704)', async () => {
  const client = createClient();
  try {
    await client.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '0.0.0' },
    });
    const response = await client.request('tools/call', { name: 'huaweicloud_nonexistent', arguments: {} });
    assert.ok(response.error, 'unknown tool must be an error');
    assert.equal(response.error.code, -32602);
    assert.match(response.error.message, /Unknown tool/);
  } finally {
    client.close();
  }
});

test('MCP server does not require params for tools without required fields (#704)', async () => {
  const client = createClient();
  try {
    await client.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '0.0.0' },
    });
    // explain_error has no required fields and must still return a result.
    const response = await client.request('tools/call', { name: 'huaweicloud_explain_error', arguments: {} });
    assert.ok(response.result, 'expected a result, not an error');
    assert.equal(response.result.isError, false);
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

test('MCP server reports version from plugin manifest in Codex cache layout (#576)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hwc-codex-'));
  try {
    // Codex marketplace layout: plugin dir only, no package.json anywhere in
    // the candidate paths — the version must come from the plugin manifest.
    const codexRoot = join(dir, 'huaweicloud-devkit', 'huaweicloud-devkit', '1.1.5');
    mkdirSync(codexRoot, { recursive: true });
    cpSync(join(root, 'plugins', 'huaweicloud-core', 'src'), join(codexRoot, 'src'), { recursive: true });
    cpSync(join(root, 'plugins', 'huaweicloud-core', 'safety'), join(codexRoot, 'safety'), { recursive: true });
    mkdirSync(join(codexRoot, '.codex-plugin'), { recursive: true });
    writeFileSync(
      join(codexRoot, '.codex-plugin', 'plugin.json'),
      JSON.stringify({ name: 'huaweicloud-devkit', version: '1.1.5-codex' }),
    );
    const client = createClient(join(codexRoot, 'src', 'mcp-server.mjs'));
    try {
      const initialized = await client.request('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'codex', version: '0.153.4' },
      });
      assert.equal(initialized.result.serverInfo.version, '1.1.5-codex');
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

test('tools/call request-level timeout returns JSON-RPC -32000 and stops the command (#698 D9-9)', async () => {
  // 用挂起的 fake hcloud（30s）对 1s 协议超时，结果与机器是否安装 KooCLI、
  // 二进制快慢完全无关：工作必然先超时，且底层命令必须被终止。
  const dir = mkdtempSync(join(tmpdir(), 'hwc-mcp-timeout-'));
  const { env, pidFile } = createHangingHcloudFixture(dir);
  const client = createClient(serverPath, { ...env, HCLOUD_MCP_REQUEST_TIMEOUT_MS: '1000' });
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

    const pid = await waitForFile(pidFile, 2000);
    assert.ok(pid, 'fake hcloud should have started');
    assert.equal(
      await waitForProcessExit(Number(pid), 2000),
      true,
      'timed-out request must stop the underlying command',
    );
  } finally {
    client.close();
    rmSync(dir, { recursive: true, force: true });
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

test('notifications/cancelled interrupts an in-flight tools/call and stops the command (#698 D9-9)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hwc-mcp-cancel-'));
  const { env, pidFile } = createHangingHcloudFixture(dir);
  const client = createClient(serverPath, env);
  try {
    await client.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'cancel-inflight', version: '0.0.0' },
    });
    const id = 424242;
    const responsePromise = client.rawRequest(id, 'tools/call', {
      name: 'huaweicloud_list_operations',
      arguments: { service: 'ECS' },
    });
    // 等 fake hcloud 真正启动后再取消，确保测的是「进行中的底层命令被终止」。
    const pid = await waitForFile(pidFile, 2000);
    assert.ok(pid, 'fake hcloud should have started');
    client.notify('notifications/cancelled', { requestId: id, reason: 'client cancelled inflight' });

    const payload = await responsePromise;
    assert.ok(payload.error, 'cancelled request must return an error');
    assert.equal(payload.error.code, -32000, 'cancelled request must return -32000');
    assert.match(payload.error.message, /cancel/i, 'message must mention cancellation');
    assert.equal(
      await waitForProcessExit(Number(pid), 2000),
      true,
      'cancelled request must stop the underlying command within 2s',
    );

    // 服务端仍可正常处理后续请求（cancel 不破坏会话）。
    const listed = await client.request('tools/list');
    assert.ok(Array.isArray(listed.result.tools), 'server still responsive after cancelling an in-flight call');
  } finally {
    client.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
