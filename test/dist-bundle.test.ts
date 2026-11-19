import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// The spawned bundle must not kick off a REAL background KooCLI install
// from inside a test run.
process.env.HUAWEICLOUD_SKIP_HCLOUD_PREINSTALL = '1';

const root = fileURLToPath(new URL('..', import.meta.url));
const distDir = join(root, 'plugins', 'huaweicloud-core', 'dist');
const distServer = join(distDir, 'mcp-server.js');

// #1158 D9-12: the stdio transport serves business requests only after the
// initialize handshake, so the bundle probes frame the handshake first.
function frame(message: unknown): string {
  const json = JSON.stringify(message);
  return `Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n${json}`;
}
const initializeFrame = frame({
  jsonrpc: '2.0',
  id: 0,
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'dist-bundle-test', version: '0.0.0' },
  },
});

// Both bundle probes frame the handshake plus one request, spawn the bundle
// and report the same diagnostics. Sharing the helper keeps the two cases
// from re-cloning that block (the jscpd baseline gate fails on new clones).
function probe(request: unknown) {
  const json = JSON.stringify(request);
  const framed = `Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n${json}`;
  const run = spawnSync(process.execPath, [distServer], {
    input: initializeFrame + framed,
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.equal(run.status, 0, `bundle exited ${run.status}: ${run.stderr}`);
  return run;
}

test('dist bundle answers framed tools/list with clean stdout', () => {
  assert.ok(existsSync(distServer), 'dist bundle missing — run npm run build');
  const run = probe({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
  // The response must itself be Content-Length framed: the release smoke
  // gate and the Hermes-on-Windows workaround speak LSP frames. The SDK
  // serializes `result` before `jsonrpc`/`id`; the frame is what matters.
  assert.match(run.stdout, /^Content-Length: \d+\r\n\r\n\{"result":/, 'response is not framed');
  assert.match(run.stdout, /"result"/, 'no JSON-RPC result in stdout');
  assert.match(run.stdout, /huaweicloud_/, 'no huaweicloud_ tools in response');
  assert.doesNotMatch(run.stdout, /listening on/, 'bundle stdout polluted with non-protocol output');
});

test('dist bundle parses tool arguments through the inlined zod path', () => {
  // Exercises the bundled validation chain: normalizeToolCallParams fills
  // the omitted arguments, the inlined zod schema parses them, and the tool
  // executes. A broken zod inlining fails here even though tools/list
  // (no parsing) still works.
  const run = probe({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'huaweicloud_explain_error', arguments: { service: 'ECS' } },
  });
  assert.match(run.stdout, /"isError":\s*false/, 'tool call through the bundle must succeed');
  assert.match(run.stdout, /ECS/, 'tool result must echo the parsed argument');
});

test('dist bundle inlines server modules and ships a sourcemap', () => {
  const bundle = readFileSync(distServer, 'utf8');
  assert.doesNotMatch(bundle, /import\s+[^;]+from\s+['"]\.\//, 'relative import left unbundled');
  assert.doesNotMatch(bundle, /import\(\s*['"]\.\//, 'relative dynamic import left unbundled');
  assert.ok(existsSync(`${distServer}.map`), 'bundle sourcemap missing');
  assert.ok(!existsSync(join(distDir, 'mcp-server-remote.js')), 'remote entry must ship only inside the bundle');
});

test('dist bundle serves --transport remote', async () => {
  const child = spawn(process.execPath, [distServer, '--transport', 'remote', '--port', '0'], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    const address = await new Promise<{ host: string; port: number }>((resolvePromise, rejectPromise) => {
      let out = '';
      const timer = setTimeout(
        () => rejectPromise(new Error(`remote bundle never reported listening: ${out}`)),
        10_000,
      );
      child.stdout.on('data', (chunk) => {
        out += chunk.toString();
        const match = out.match(/listening on ([0-9.]+):(\d+)/);
        if (match) {
          clearTimeout(timer);
          resolvePromise({ host: match[1], port: Number(match[2]) });
        }
      });
      child.once('error', rejectPromise);
    });
    const res = await fetch(`http://${address.host}:${address.port}/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'dist-bundle-test', version: '0.0.0' },
        },
      }),
    });
    const body = await res.json();
    assert.equal(body.result.serverInfo.name, 'huaweicloud-devkit');

    // One tools/call with real arguments through the bundled remote: the
    // inlined zod parse path must work over HTTP too, and a bare curl-style
    // request (no Content-Type) must keep working via the shell default.
    const bare = await fetch(`http://${address.host}:${address.port}/`, {
      method: 'POST',
      headers: { Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'huaweicloud_explain_error', arguments: { service: 'ECS' } },
      }),
    });
    assert.equal(bare.status, 200, `no-Content-Type tools/call must not 415: ${bare.status}`);
    const bareBody = await bare.json();
    assert.equal(bareBody.result.isError, false, 'bundled remote tool call must succeed');
  } finally {
    child.kill();
  }
});
