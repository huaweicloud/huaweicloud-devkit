import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import test from 'node:test';

// Deterministic-tier seam: disable the once-per-session first-assertion
// vendor challenge (HUAWEICLOUD_VENDOR_CHALLENGE=off, the installer-override
// pattern) so cold-attested calls in this file dispatch without the
// challenge bounce. The challenge itself is pinned where it is the subject
// (tools.test.ts's gate test drives the dance; the selfcheck drives it on
// the wire); the real-model e2e tier never sets this seam.
process.env.HUAWEICLOUD_VENDOR_CHALLENGE = 'off';

// Remote transport never preinstalls (by design); defensive anyway so a
// transport-selection regression cannot download from a test run.
process.env.HUAWEICLOUD_SKIP_HCLOUD_PREINSTALL = '1';

// fileURLToPath, not URL.pathname: on win32 pathname keeps its leading slash
// (/D:/a/...), and joining that back into pathToFileURL yields the
// double-drive-letter file URL (D:/D:/...) every import then fails on.
const root = fileURLToPath(new URL('..', import.meta.url));
const srcDir = join(root, 'plugins', 'huaweicloud-core', 'src');
const serverPath = join(srcDir, 'mcp-server.ts');

// Dual Accept is the SDK Streamable HTTP contract: POSTs whose Accept lacks
// either application/json or text/event-stream are rejected 406.
const DUAL_ACCEPT = 'application/json, text/event-stream';

type StartRemoteServer = typeof import('../plugins/huaweicloud-core/src/mcp-server-remote.ts').startRemoteServer;
type StartedRemote = Awaited<ReturnType<StartRemoteServer>>;

interface JsonRpcResult {
  serverInfo: { name: string; version: string };
  instructions?: string;
  protocolVersion: string;
  capabilities: unknown;
  tools: { name: string; description?: string }[];
  isError: boolean;
  content: { text: string }[];
}

interface JsonRpcResponse {
  result: JsonRpcResult;
  error: { code: number; message: string };
}

let server: Server | undefined;
let base: string;
let startRemoteServer: StartRemoteServer;

test.before(async () => {
  const mod = await import(pathToFileURL(join(srcDir, 'mcp-server-remote.ts')).href);
  startRemoteServer = mod.startRemoteServer;
  const started = await startRemoteServer({ port: 0 });
  server = started.server;
  base = `http://127.0.0.1:${started.port}`;
});

test.after(async () => {
  if (server) {
    await new Promise((resolve) => server!.close(resolve));
  }
});

async function rpc(
  method: string,
  params: Record<string, unknown> = {},
  extraHeaders: Record<string, string> = {},
  accept: string = DUAL_ACCEPT,
): Promise<{ status: number; contentType: string | null; body: JsonRpcResponse }> {
  const res = await fetch(`${base}/`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: accept,
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
  // The SDK high-level server advertises tools.listChanged on registration.
  assert.deepEqual(initialized.body.result.capabilities, { tools: { listChanged: true } });
  // Server instructions ride the initialize handshake (the shared factory
  // keys the form on the face): the remote form must stay honest for a
  // caller that can never read the server host's tree — it names the
  // catalog tool, states that skillRoot is withheld (so retrieve_skill is
  // the loader, framed as the fallback that applies to every skill here),
  // and never states a tree path.
  const instructions = initialized.body.result.instructions ?? '';
  assert.match(instructions, /huaweicloud_list_skills/, 'instructions must name the catalog tool');
  assert.match(instructions, /skillRoot is withheld/, 'instructions must state skillRoot is withheld on this face');
  assert.match(instructions, /fallback/, 'instructions must frame retrieve_skill as the fallback');
  assert.doesNotMatch(
    instructions,
    /the skills tree lives at/,
    'the remote face must not state a host tree path the caller cannot use',
  );
  assert.doesNotMatch(
    instructions,
    /huaweicloud_packs_configure/,
    'packs_configure is stdio-only and must not be taught here',
  );

  const listed = await rpc('tools/list');
  const toolNames = new Set(listed.body.result.tools.map((tool) => tool.name));
  assert.ok(toolNames.has('huaweicloud_plan_cli_command'));
  assert.ok(toolNames.has('huaweicloud_list_operations'));
  // The four auth mutators stay withheld on the unauthenticated remote
  // face (they write the user's LOCAL credential state — auth_init sets
  // cross-request runtime state, auth_sync/auth_switch/auth_confirm
  // decrypt S1 refs and write plaintext into ~/.obsutilconfig and the
  // KooCLI profile). PR-3b registers the pair on the approval chain;
  // registering must not surface them here.
  for (const withheld of [
    'huaweicloud_auth_sync',
    'huaweicloud_auth_init',
    'huaweicloud_auth_switch',
    'huaweicloud_auth_confirm',
  ]) {
    assert.equal(toolNames.has(withheld), false, `${withheld} must stay off the remote face`);
  }
  assert.ok(toolNames.has('huaweicloud_auth_status'), 'the read face stays reachable remotely');
  // The remote face never registers packs_configure, so no description it
  // serves may teach it either — the list_skills description scopes its
  // mention to stdio agent sessions, and this pin closes the side door for
  // every future description edit.
  for (const tool of listed.body.result.tools) {
    assert.doesNotMatch(
      tool.description ?? '',
      /huaweicloud_packs_configure/,
      `${tool.name} description must not teach the stdio-only packs_configure on the remote face`,
    );
  }
  // expose_tunnel is reachable remotely BY DESIGN (accepted residual, see
  // the remoteSurface comment in mcp-protocol.ts) — pin it so a future
  // withholding change is a deliberate edit, not an accident.
  assert.ok(toolNames.has('huaweicloud_sandbox_expose_tunnel'));

  const planned = await rpc('tools/call', {
    name: 'huaweicloud_plan_cli_command',
    arguments: { vendorConfirmed: 'test: vendor established by the harness', args: ['ECS', 'NovaListServers'] },
  });
  assert.equal(planned.body.result.isError, false);
  assert.match(planned.body.result.content[0].text, /NovaListServers/);
});

test('remote MCP server returns 202 for notifications/initialized', async () => {
  const res = await fetch(`${base}/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: DUAL_ACCEPT },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  });
  assert.equal(res.status, 202);
});

test('remote list_skills omits skillRoot (no host path on the unauthenticated face)', async () => {
  // The stateless remote builds servers without the onPacksChanged seam, so
  // listSkills withholds skillRoot: the list_skills payload on the CORS-*
  // unauthenticated face must not carry the server host's install path, and
  // remote callers cannot reach that filesystem anyway — retrieve_skill is
  // their load path.
  const called = await rpc('tools/call', {
    name: 'huaweicloud_list_skills',
    arguments: {},
  });
  assert.equal(called.status, 200);
  assert.equal(called.body.result.isError, false);
  const payload = JSON.parse(called.body.result.content[0].text) as { ok: boolean; skillRoot?: string };
  assert.equal(payload.ok, true);
  assert.equal('skillRoot' in payload, false, 'the stateless remote must not publish the server host install path');
});

test('remote MCP server returns 400 for invalid JSON body', async () => {
  const res = await fetch(`${base}/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: DUAL_ACCEPT },
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

test('remote MCP server keeps GET as 405 via the shell method filter', async () => {
  const res = await fetch(`${base}/`, { method: 'GET', headers: { Accept: 'text/event-stream' } });
  assert.equal(res.status, 405);
});

test('remote MCP server returns 406 when Accept lacks application/json (SDK semantics)', async () => {
  const res = await fetch(`${base}/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 8,
      method: 'tools/list',
      params: {},
    }),
  });
  assert.equal(res.status, 406);
});

test('remote MCP server returns 406 when Accept lacks text/event-stream (SDK semantics)', async () => {
  const res = await fetch(`${base}/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 9,
      method: 'tools/list',
      params: {},
    }),
  });
  assert.equal(res.status, 406);
});

test('remote MCP server responds JSON bodies for dual-Accept clients (enableJsonResponse)', async () => {
  const res = await fetch(`${base}/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: DUAL_ACCEPT },
    body: JSON.stringify({ jsonrpc: '2.0', id: 10, method: 'tools/list', params: {} }),
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /application\/json/);
  const body = await res.json();
  assert.ok(body.result.tools.length > 0);
});

test('remote MCP server defaults a missing Content-Type instead of 415 (legacy curl behavior)', async () => {
  const res = await fetch(`${base}/`, {
    method: 'POST',
    headers: { Accept: DUAL_ACCEPT },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 11,
      method: 'tools/call',
      params: { name: 'huaweicloud_explain_error', arguments: { service: 'ECS' } },
    }),
  });
  assert.equal(res.status, 200, `bare curl-style body must not 415: ${res.status}`);
  const body = await res.json();
  assert.equal(body.result.isError, false);
});

test('resources/list falls through to -32601 (capability never advertised)', async () => {
  // tools-only registration: the SDK registers no resource handlers, so the
  // old {resources: []} answer is gone. Declared wire change from the
  // migration plan.
  const res = await rpc('resources/list');
  assert.equal(res.status, 200);
  assert.equal(res.body.error.code, -32601);
});

test('exports DEFAULT_PORT 9528 to avoid IACMCPServer port 9527 conflict', async () => {
  const mod = await import(pathToFileURL(join(srcDir, 'mcp-server-remote.ts')).href);
  assert.equal(mod.DEFAULT_PORT, 9528);
});

test('startRemoteServer binds DEFAULT_PORT when no port passed', async () => {
  let started: StartedRemote | undefined;
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
    assert.equal((started.server.address() as AddressInfo).address, '0.0.0.0');
  } finally {
    await started.close();
  }
});

function spawnRemote(flags: string[]) {
  const child = spawn(process.execPath, [serverPath, '--transport', 'remote', ...flags], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const whenListening = new Promise<{ host: string; port: number }>((resolve, reject) => {
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

test('mcp-server.ts --transport remote honors --host and --port flags', async () => {
  const { child, whenListening } = spawnRemote(['--host', '0.0.0.0', '--port', '0']);
  try {
    const addr = await whenListening;
    assert.equal(addr.host, '0.0.0.0');
    const res = await fetch(`http://127.0.0.1:${addr.port}/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: DUAL_ACCEPT },
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
