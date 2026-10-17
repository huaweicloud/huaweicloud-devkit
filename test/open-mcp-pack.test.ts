import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';

import { callTool } from '../plugins/huaweicloud-core/src/tools.ts';
import { redactSecrets } from '../plugins/huaweicloud-core/src/safety-policy.ts';
import { createDevkitMcpServer, createLinkedDevkitServers } from '../plugins/huaweicloud-core/src/mcp-protocol.ts';
import {
  callOpenMcpTool,
  resolveGatewayCommand,
  resolveGatewaySpawnArgs,
  _openMcpSidecarStats,
  _resetOpenMcpSidecar,
  type GatewayCommand,
} from '../plugins/huaweicloud-core/src/packs/huaweicloud-open-mcp/sidecar.ts';
import {
  classify,
  GATEWAY_TOOL_VOCABULARY,
  resolveApprovalMode,
} from '../plugins/huaweicloud-core/src/packs/huaweicloud-open-mcp/approval.ts';
import { fixtureDir } from './fixture-dir.ts';

// The five huaweicloud-open-mcp pack lifecycle invariants from the pack-system decision
// record, driven through the real dispatch surfaces with a fake gateway
// (test/fixtures/fake-open-mcp-sidecar.mjs). The Node suite never depends on
// Python or uv: OPENMCP_BIN points every spawn at the fixture.

const root = fileURLToPath(new URL('..', import.meta.url));
const fakeSidecar = join(root, 'test', 'fixtures', 'fake-open-mcp-sidecar.mjs');
process.env.OPENMCP_BIN = fakeSidecar;

// The sidecar's lazy spawn now provisions the policy base; pin the state
// home so tests never write into the real user config tree.
const stateHome = fixtureDir('openmcp-state-home-');
process.env.HUAWEICLOUD_HOME = stateHome;

const OPEN_MCP_TOOLS = new Set([
  'huaweicloud_gateway_list_tools',
  'huaweicloud_gateway_call',
  'huaweicloud_gateway_restart',
]);

// node --test runs each file in its own process; the try/finally keeps later
// tests in this file honest when a test pins DEVKIT_PACKS.
function withDevkitPacks(value: string, fn: () => Promise<void>) {
  return async () => {
    const previous = process.env.DEVKIT_PACKS;
    process.env.DEVKIT_PACKS = value;
    try {
      await fn();
    } finally {
      if (previous === undefined) delete process.env.DEVKIT_PACKS;
      else process.env.DEVKIT_PACKS = previous;
    }
  };
}

// The fake gateway reads its env at spawn time, so a test that needs a knob
// must reset the sidecar after setting it (and again after restoring) — the
// FAKE_FAIL_HANDSHAKE pattern, lifted into a helper for the policy/drift
// matrix below.
function withGatewayEnv(overrides: Record<string, string>, fn: () => Promise<void>) {
  return async () => {
    const saved: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(overrides)) {
      saved[key] = process.env[key];
      process.env[key] = value;
    }
    await _resetOpenMcpSidecar();
    try {
      await fn();
    } finally {
      for (const key of Object.keys(overrides)) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
      await _resetOpenMcpSidecar();
    }
  };
}

interface PackInfoResult {
  ok: boolean;
  enabled: boolean;
  tools: Array<{ name: string; description: unknown }>;
}

interface GatewayCallResult {
  ok: boolean;
  tool?: string;
  pid: number;
  arguments: { query?: unknown; limit?: unknown };
  requiresApproval?: unknown;
  classification?: string;
  error?: string;
  reason?: string;
  executed?: { product: string; api: string };
  rules: Array<{ line: string }>;
  policy?: unknown;
}

interface GatewayRestartResult {
  ok: boolean;
  spawns: number;
  pid: number | null;
}

interface GatewayListToolsResult {
  ok: boolean;
  tools: Array<{ name: unknown; inputSchema: unknown }>;
  drift: { missing: string[] };
}

// Invariant 1: a trimmed pack registers no tools AND never spawns the sidecar.
// The registry imports every pack's handler modules unconditionally, so the
// zero-spawn half is exactly what lazy spawning has to guarantee.
test(
  'DEVKIT_PACKS excluding huaweicloud-open-mcp registers no gateway tools and spawns nothing',
  withDevkitPacks('core', async () => {
    const { server, transport } = await createLinkedDevkitServers();
    const client = new Client({ name: 'open-mcp-trim-test', version: '0.0.0' });
    try {
      await client.connect(transport);
      const listed = await client.listTools();
      const names = listed.tools.map((tool) => tool.name);
      assert.equal(names.length, 11, 'core-only tools/list');
      for (const name of OPEN_MCP_TOOLS) {
        assert.ok(!names.includes(name), `${name} must not be registered when huaweicloud-open-mcp is trimmed`);
      }
      assert.equal(_openMcpSidecarStats().spawns, 0, 'a trimmed pack must never spawn the sidecar');
    } finally {
      await client.close();
      await server.close();
    }
  }),
);

test('pack meta discloses the huaweicloud-open-mcp pack with its three tools', async () => {
  const info = (await callTool('huaweicloud_pack_info', { pack: 'huaweicloud-open-mcp' })) as PackInfoResult;
  assert.equal(info.ok, true);
  assert.equal(info.enabled, true);
  assert.equal(info.tools.length, 3);
  for (const entry of info.tools) {
    assert.ok(OPEN_MCP_TOOLS.has(entry.name), `${entry.name} must be one of the pack's tools`);
    assert.equal(typeof entry.description, 'string');
  }
  assert.equal(_openMcpSidecarStats().spawns, 0, 'pack meta must not spawn the sidecar');
});

test('the generic call face round-trips discovery tools through the sidecar', async () => {
  const result = (await callTool('huaweicloud_gateway_call', {
    tool: 'search_apis',
    toolArgs: { query: 'ecs', limit: 5 },
  })) as GatewayCallResult;
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.tool, 'search_apis');
  assert.equal(result.arguments.query, 'ecs');
  assert.equal(result.arguments.limit, 5);
  assert.equal(typeof result.pid, 'number');
  assert.equal(_openMcpSidecarStats().spawns, 1, 'first call lazily spawns exactly once');
  assert.equal(_openMcpSidecarStats().alive, true);
});

// Invariant 2: the remote transport constructs and closes an McpServer per
// HTTP request; the sidecar is a process-scope singleton that must not
// notice.
test('remote-style per-request server construction does not touch the sidecar', async () => {
  const before = _openMcpSidecarStats();
  const first = createDevkitMcpServer({ sessionId: 'remote-1' });
  await first.close();
  const second = createDevkitMcpServer({ sessionId: 'remote-2' });
  await second.close();
  assert.equal(_openMcpSidecarStats().spawns, before.spawns, 'server construct/close must not spawn or kill');
  const result = (await callTool('huaweicloud_gateway_call', {
    tool: 'list_products',
    toolArgs: { keyword: 'ecs' },
  })) as GatewayCallResult;
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.tool, 'list_products');
  assert.equal(_openMcpSidecarStats().spawns, before.spawns, 'the existing singleton serves later calls');
});

test('a dead sidecar is respawned by the next call, not awaited forever', async () => {
  const first = (await callTool('huaweicloud_gateway_call', {
    tool: 'get_product',
    toolArgs: { product: 'ECS' },
  })) as GatewayCallResult;
  assert.equal(first.ok, true, JSON.stringify(first));
  const spawnsBefore = _openMcpSidecarStats().spawns;
  process.kill(first.pid, 'SIGKILL');
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(_openMcpSidecarStats().alive, false, 'the singleton must register the child death');
  const second = (await callTool('huaweicloud_gateway_call', {
    tool: 'get_product',
    toolArgs: { product: 'VPC' },
  })) as GatewayCallResult;
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.notEqual(second.pid, first.pid, 'the next call must be served by a fresh child');
  assert.equal(_openMcpSidecarStats().spawns, spawnsBefore + 1);
});

// All four normalization branches: the real gateway answers successful
// calls as structuredContent and refusals two different ways (isError for
// protocol-level rejections, {ok:false, reason} envelopes for policy ones).
test('normalization covers structuredContent, isError, envelope failures, and raw text', async () => {
  const echoed = await callOpenMcpTool('search_apis', { query: 'ecs' });
  assert.equal(echoed.ok, true, JSON.stringify(echoed));
  assert.equal((echoed.arguments as { query: unknown }).query, 'ecs');
  assert.equal(typeof echoed.pid, 'number');

  const failing = await callOpenMcpTool('failing_tool', {});
  assert.equal(failing.ok, false);
  assert.equal(failing.error, 'fake gateway tool failure');

  const envelope = await callOpenMcpTool('envelope_fail_tool', {});
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error, 'fake envelope failure', 'reason must map into the repo-standard error key');
  assert.equal(envelope.reason, 'fake envelope failure', 'reason is kept for gateway fidelity');

  const rawText = await callOpenMcpTool('raw_text_tool', {});
  assert.equal(rawText.ok, true);
  assert.equal(rawText.raw, 'not json at all');
});

// forwarded is the completed-round-trip fact: the eval harness's reached
// verdict reads it, so the three round-trip branches must carry it and the
// catch shapes must not. tool presence proves nothing here — the catch
// sets it too (third-round review: the tool-presence inference marked
// timeouts and mid-call child death as reached).
test('forwarded marks completed round trips and nothing else', async () => {
  // Round-trip shapes: success, protocol-level isError, policy envelope.
  const ok = await callOpenMcpTool('search_apis', { query: 'ecs' });
  assert.equal(ok.forwarded, true, 'a successful call is forwarded');
  const isError = await callOpenMcpTool('failing_tool', {});
  assert.equal(isError.forwarded, true, 'an isError answer completed the round trip');
  const envelope = await callOpenMcpTool('envelope_fail_tool', {});
  assert.equal(envelope.forwarded, true, 'a policy refusal envelope completed the round trip');

  // Timeout: the request never completed — no forwarded, tool still set.
  // FAKE_SLOW_MS makes the fixture's answer slower than the caller's
  // 200ms bound, so the rejection comes from sidecar.request's timer.
  await withGatewayEnv({ FAKE_SLOW_MS: '2000' }, async () => {
    const timedOut = await callOpenMcpTool('search_apis', { query: 'slow' }, 200);
    assert.equal(timedOut.ok, false, 'the timeout rejects');
    assert.match(String(timedOut.error), /timed out/);
    assert.equal(timedOut.tool, 'search_apis', 'the catch still names the tool');
    assert.notEqual(timedOut.forwarded, true, 'a timed-out call is NOT forwarded');
  });
});

// Regression for the EPIPE crash: a call whose write lands between the
// child's OS-level death and Node's 'exit' delivery used to raise an
// unhandled 'error' on the stdin socket and take down the whole server
// (reproduced by probe). The stdin error handler must turn it into a fast
// {ok:false} instead.
test('a call racing child death fails fast instead of crashing the server', async () => {
  const first = (await callTool('huaweicloud_gateway_call', {
    tool: 'get_product',
    toolArgs: { product: 'ECS' },
  })) as GatewayCallResult;
  assert.equal(first.ok, true, JSON.stringify(first));
  process.kill(first.pid, 'SIGKILL');
  // Block the event loop so 'exit' cannot be delivered yet: the write below
  // hits the kernel-broken pipe inside the exact EPIPE window.
  const blockedUntil = Date.now() + 50;
  while (Date.now() < blockedUntil) {
    /* spin */
  }
  const raced = await callOpenMcpTool('get_product', { product: 'VPC' }, 2000);
  assert.equal(raced.ok, false, 'the racing call must fail, not hang or crash');
  let cleared = false;
  for (let attempt = 0; attempt < 50; attempt++) {
    if (!_openMcpSidecarStats().alive) {
      cleared = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(cleared, 'the singleton must clear once the child death is delivered');
  const revived = (await callTool('huaweicloud_gateway_call', {
    tool: 'get_product',
    toolArgs: { product: 'RDS' },
  })) as GatewayCallResult;
  assert.equal(revived.ok, true, JSON.stringify(revived));
});

// Gateway resolution order, pinned deterministically: OPENMCP_BIN → a
// persistent install (~/.local/bin or PATH) → the uvx fallback, which runs
// the gateway with no persistent install at all.
test('gateway resolution prefers OPENMCP_BIN, then disk, then uvx', () => {
  const direct = resolveGatewayCommand({
    OPENMCP_BIN: fakeSidecar,
    HOME: '/nonexistent',
    PATH: '/usr/bin',
  }) as GatewayCommand;
  assert.equal(direct.command, fakeSidecar);
  assert.deepEqual(direct.argsPrefix, []);

  const home = fixtureDir('openmcp-res-home-');
  const binDir = fixtureDir('openmcp-res-bin-');
  const fakeUvx = join(binDir, 'uvx');
  writeFileSync(fakeUvx, `#!/bin/sh\nshift\nexec "${process.execPath}" "${fakeSidecar}" "$@"\n`, { mode: 0o755 });
  const envUvxOnly = { HOME: home, PATH: `/usr/bin:${binDir}` };
  const viaUvx = resolveGatewayCommand(envUvxOnly) as GatewayCommand;
  assert.equal(viaUvx.command, fakeUvx, 'with nothing on disk, uvx is the fallback');
  assert.deepEqual(viaUvx.argsPrefix, ['huaweicloud-open-mcp']);

  // A persistent install in ~/.local/bin outranks the uvx fallback.
  const localBin = join(home, '.local', 'bin');
  mkdirSync(localBin, { recursive: true });
  const installed = join(localBin, 'huaweicloud-open-mcp');
  writeFileSync(installed, `#!/bin/sh\nexec "${process.execPath}" "${fakeSidecar}" "$@"\n`, { mode: 0o755 });
  const viaDisk = resolveGatewayCommand(envUvxOnly) as GatewayCommand;
  assert.equal(viaDisk.command, installed);
  assert.deepEqual(viaDisk.argsPrefix, []);
});

// The uvx path end to end: with no gateway binary anywhere and only a fake
// uvx on PATH, a tool call must spawn through it (uvx <package> <args>)
// and complete the round trip.
test('a tool call runs end to end through the uvx fallback', { skip: process.platform === 'win32' }, async () => {
  const home = fixtureDir('openmcp-uvx-home-');
  const binDir = fixtureDir('openmcp-uvx-bin-');
  const fakeUvx = join(binDir, 'uvx');
  writeFileSync(fakeUvx, `#!/bin/sh\nshift\nexec "${process.execPath}" "${fakeSidecar}" "$@"\n`, { mode: 0o755 });

  const savedBin = process.env.OPENMCP_BIN;
  const savedHome = process.env.HOME;
  const savedPath = process.env.PATH;
  delete process.env.OPENMCP_BIN;
  process.env.HOME = home;
  process.env.PATH = `/usr/bin:${binDir}`;
  try {
    await _resetOpenMcpSidecar();
    const result = (await callTool('huaweicloud_gateway_call', {
      tool: 'search_apis',
      toolArgs: { query: 'via-uvx' },
    })) as GatewayCallResult;
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.arguments.query, 'via-uvx');
    assert.equal(typeof result.pid, 'number');
  } finally {
    if (savedBin === undefined) delete process.env.OPENMCP_BIN;
    else process.env.OPENMCP_BIN = savedBin;
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    process.env.PATH = savedPath;
    await _resetOpenMcpSidecar();
  }
});

// A failed handshake must kill the spawned child: the parent holds the
// child's stdin pipe open, so an un-killed orphan survives (and pins the
// event loop) for the process lifetime — one leak per retry.
test('a failed handshake kills the spawned child (no orphan)', async () => {
  await _resetOpenMcpSidecar();
  const previous = process.env.FAKE_FAIL_HANDSHAKE;
  process.env.FAKE_FAIL_HANDSHAKE = '1';
  try {
    const result = await callOpenMcpTool('search_apis', { query: 'boom' });
    assert.equal(result.ok, false);
    assert.match(String(result.error), /fake handshake failure/);
    assert.equal(_openMcpSidecarStats().alive, false, 'a failed spawn must clear the singleton');
    const pid = _openMcpSidecarStats().lastPid;
    assert.ok(Number.isSafeInteger(pid), 'stats must expose the spawned child pid');
    let gone = false;
    for (let attempt = 0; attempt < 50; attempt++) {
      try {
        process.kill(pid!, 0);
        await new Promise((resolve) => setTimeout(resolve, 100));
      } catch {
        gone = true;
        break;
      }
    }
    assert.ok(gone, 'the handshake-failed child must be killed, not orphaned');
  } finally {
    if (previous === undefined) delete process.env.FAKE_FAIL_HANDSHAKE;
    else process.env.FAKE_FAIL_HANDSHAKE = previous;
    await _resetOpenMcpSidecar();
  }
});

// Invariant 3: the child's lifetime is the parent's stdin pipe. The driver
// uses the real sidecar module, prints the child pid, then exits; the child
// must follow.
test('the sidecar dies with its parent process (stdin pipe EOF)', async () => {
  const driver = join(root, 'test', 'fixtures', 'open-mcp-sidecar-driver.mjs');
  const child = spawn(process.execPath, [driver], { stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    out += chunk;
  });
  await new Promise((resolve) => child.on('close', resolve));
  const pid = Number(out.trim());
  assert.ok(Number.isSafeInteger(pid), `driver must print the sidecar pid, got: ${out.trim()}`);
  let gone = false;
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      process.kill(pid, 0);
      await new Promise((resolve) => setTimeout(resolve, 100));
    } catch {
      gone = true;
      break;
    }
  }
  assert.ok(gone, 'the sidecar must exit after its parent process exits');
});

test('sidecar errors surface as ok:false results, never as throws', async () => {
  // A tool name the fake gateway does not implement answers JSON-RPC
  // -32602; the proxy must normalize that into {ok:false} the way the
  // obs/auth pack handlers do. The reset runs in finally so a failing
  // assertion fails cleanly instead of leaving the sidecar child's pipes
  // holding the event loop open.
  try {
    const result = await callOpenMcpTool('no_such_tool', {});
    assert.equal(result.ok, false);
    assert.equal(result.tool, 'no_such_tool');
    assert.ok(typeof result.error === 'string' && result.error.length > 0);
    assert.equal(_openMcpSidecarStats().spawns > 0, true, 'the cumulative spawn counter stays honest');
  } finally {
    await _resetOpenMcpSidecar();
    assert.equal(_openMcpSidecarStats().alive, false, 'reset clears the singleton');
  }
});

// The restart tool's contract, driven through the pack's real dispatch with
// the fake gateway: a live child recycles to a NEW pid, and with no prior
// spawn the restart is just one spawn (idempotent). stats.spawns is the
// module-level cumulative counter, so the assertions are deltas.
test('huaweicloud_gateway_restart recycles a live child and spawns fresh when none exists', async () => {
  await _resetOpenMcpSidecar();
  try {
    // No prior spawn: the restart is a single spawn.
    let before = _openMcpSidecarStats().spawns;
    let result = (await callTool('huaweicloud_gateway_restart', {})) as GatewayRestartResult;
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.spawns - before, 1, 'first restart with no live child is one spawn');
    const firstPid = result.pid;
    assert.ok(firstPid !== null, 'the new child must report a pid');

    // Live child: the restart stops it and spawns a replacement.
    before = _openMcpSidecarStats().spawns;
    result = (await callTool('huaweicloud_gateway_restart', {})) as GatewayRestartResult;
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.spawns - before, 1, 'a live child adds exactly one more spawn');
    assert.notEqual(result.pid, firstPid, 'the recycled child must be a new process');

    // The replacement actually serves proxy calls.
    const probe = (await callTool('huaweicloud_gateway_call', {
      tool: 'list_products',
      toolArgs: {},
    })) as GatewayCallResult;
    assert.equal(probe.ok, true, JSON.stringify(probe));
  } finally {
    await _resetOpenMcpSidecar();
    assert.equal(_openMcpSidecarStats().alive, false, 'reset clears the singleton');
  }
});

// ── Spawn-arg policy (pin-unless-env for mode/policy; audit never) ──
// resolveGatewaySpawnArgs is pure, so every branch pins without a spawn;
// the end-to-end tests below then drive the same decisions through the
// real sidecar and assert them from the fake gateway's argv/env echo.

test('resolveGatewaySpawnArgs pins openapi + the provisioned policy when gateway envs are unset', () => {
  const home = fixtureDir('openmcp-args-home-');
  const plan = resolveGatewaySpawnArgs({ HOME: home, HUAWEICLOUD_HOME: home });
  assert.deepEqual(
    plan.args.filter((arg) => arg.startsWith('--')),
    ['--elicitation', '--mode', '--policy', '--log-file'],
    'flag order and completeness',
  );
  assert.equal(plan.args[plan.args.indexOf('--mode') + 1], 'openapi');
  assert.ok(plan.provision, 'the devkit provisions the policy base when no operator path is set');
  assert.equal(plan.provision.dir, join(home, '.config', 'huaweicloud', 'packs', 'huaweicloud-open-mcp'));
  assert.equal(plan.provision.policyPath, join(plan.provision.dir, 'policy'));
  assert.equal(plan.args[plan.args.indexOf('--policy') + 1], plan.provision.policyPath);
});

test('resolveGatewaySpawnArgs defers to operator envs and never passes an audit arg', () => {
  const plan = resolveGatewaySpawnArgs({
    HOME: '/nonexistent',
    HUAWEICLOUD_MCP_MODE: 'data',
    HUAWEICLOUD_MCP_POLICY_FILE: '/opt/gw-policy',
    HUAWEICLOUD_MCP_AUDIT_FILE: '/opt/gw-audit.ndjson',
  });
  assert.ok(!plan.args.includes('--mode'), 'operator mode env wins; no --mode arg');
  assert.ok(!plan.args.includes('--policy'), 'operator policy env wins; no --policy arg');
  assert.equal(plan.provision, null, 'no devkit provisioning when the operator owns the path');
  assert.ok(!plan.args.some((arg) => arg.startsWith('--audit-file')), 'audit is opt-in only, never passed');
  assert.deepEqual(plan.args, ['--elicitation', 'off', '--log-file', join(tmpdir(), 'huaweicloud-open-mcp.log')]);
});

test('resolveGatewaySpawnArgs rejects discover and unknown modes with a devkit-authored error', () => {
  for (const bad of ['discover', 'openapi,discover', 'openapi,data,banana', ',']) {
    assert.throws(
      () => resolveGatewaySpawnArgs({ HOME: '/h', HUAWEICLOUD_MCP_MODE: bad }),
      /not supported by the devkit proxy/,
    );
  }
  // Blank trims to unset: the openapi pin applies.
  const pinned = resolveGatewaySpawnArgs({ HOME: '/h', HUAWEICLOUD_MCP_MODE: '  ' });
  assert.ok(pinned.args.includes('--mode'));
  // Combinable supported modes validate without an arg (the env wins).
  const combined = resolveGatewaySpawnArgs({ HOME: '/h', HUAWEICLOUD_MCP_MODE: 'openapi,data' });
  assert.ok(!combined.args.includes('--mode'));
});

test('spawn wires the pinned mode, the provisioned policy file, and the scratch cwd', async () => {
  await _resetOpenMcpSidecar();
  // Captured so the finally can pin the cleanup contract: the per-child
  // scratch cwd must not outlive the child that owned it.
  let scratchCwd: string | null = null;
  try {
    const result = await callOpenMcpTool('search_apis', { query: 'spawn-args' });
    assert.equal(result.ok, true, JSON.stringify(result));
    scratchCwd = String(result.cwd);
    const argv = result.argv as string[];
    assert.ok(Array.isArray(argv), 'the fake echoes its argv');
    const modeIndex = argv.indexOf('--mode');
    assert.ok(modeIndex >= 0, 'unset mode env: the openapi pin is passed');
    assert.equal(argv[modeIndex + 1], 'openapi');
    const policyIndex = argv.indexOf('--policy');
    assert.ok(policyIndex >= 0, 'unset policy env: the provisioned policy is passed');
    const policyPath = argv[policyIndex + 1];
    assert.equal(policyPath, join(stateHome, '.config', 'huaweicloud', 'packs', 'huaweicloud-open-mcp', 'policy'));
    assert.ok(existsSync(policyPath), 'provisioning precedes spawn: the file exists');
    assert.equal((result.env as Record<string, unknown>).HUAWEICLOUD_MCP_MODE, null, 'no mode env was inherited');
    // The child reports process.cwd() (kernel-canonicalized), while
    // tmpdir() is the raw env string — on macOS /tmp is a symlink to
    // /private/tmp, so both sides compare through realpath. The cwd is a
    // per-child mkdtemp directory under tmpdir, never the shared root.
    const cwdReal = realpathSync(String(result.cwd));
    const tmpReal = realpathSync(tmpdir());
    assert.ok(
      cwdReal.startsWith(tmpReal + '/') || cwdReal.startsWith(tmpReal + '\\'),
      `the child cwd must live under tmpdir (${cwdReal} vs ${tmpReal})`,
    );
    assert.notEqual(cwdReal, tmpReal, 'the cwd is a per-child scratch dir, not the shared tmpdir root');
    if (process.platform !== 'win32') {
      assert.equal(statSync(policyPath).mode & 0o777, 0o600, 'policy file is 0600');
      assert.equal(statSync(dirname(policyPath)).mode & 0o777, 0o700, 'state dir is 0700');
    }
  } finally {
    await _resetOpenMcpSidecar();
    // The reset kills the child and waits out its death; the close hook in
    // spawnSidecar must have removed the scratch cwd with it. Regression
    // pin for the per-spawn leak: before the fix every spawn left one
    // openmcp-gw-* dir behind (~23 per suite under an isolated TMPDIR),
    // and deleting the hook passed the whole suite green.
    if (scratchCwd !== null) {
      assert.equal(existsSync(scratchCwd), false, 'the scratch cwd is removed when the gateway child closes');
    }
  }
});

test('an operator mode env suppresses the pin and reaches the gateway child', async () => {
  await _resetOpenMcpSidecar();
  const saved = process.env.HUAWEICLOUD_MCP_MODE;
  process.env.HUAWEICLOUD_MCP_MODE = 'data';
  try {
    const result = await callOpenMcpTool('search_apis', { query: 'mode-env' });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.ok(!((result.argv as string[]) || []).includes('--mode'), 'env set: no --mode arg, the env wins');
    assert.equal((result.env as Record<string, unknown>).HUAWEICLOUD_MCP_MODE, 'data', 'the child saw the env');
  } finally {
    if (saved === undefined) delete process.env.HUAWEICLOUD_MCP_MODE;
    else process.env.HUAWEICLOUD_MCP_MODE = saved;
    await _resetOpenMcpSidecar();
  }
});

test('an operator policy env suppresses devkit provisioning', async () => {
  await _resetOpenMcpSidecar();
  const operatorPolicy = join(stateHome, 'operator-policy');
  writeFileSync(operatorPolicy, '', { mode: 0o600 });
  const saved = process.env.HUAWEICLOUD_MCP_POLICY_FILE;
  process.env.HUAWEICLOUD_MCP_POLICY_FILE = operatorPolicy;
  try {
    const result = await callOpenMcpTool('search_apis', { query: 'operator-policy' });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.ok(!((result.argv as string[]) || []).includes('--policy'), 'operator policy env wins: no --policy arg');
    assert.equal(
      (result.env as Record<string, unknown>).HUAWEICLOUD_MCP_POLICY_FILE,
      operatorPolicy,
      'the child saw the operator env',
    );
  } finally {
    if (saved === undefined) delete process.env.HUAWEICLOUD_MCP_POLICY_FILE;
    else process.env.HUAWEICLOUD_MCP_POLICY_FILE = saved;
    await _resetOpenMcpSidecar();
  }
});

// ── approval.ts unit surface (pure floor table; no gateway child) ──

test('classify: read-only discovery tools and manage_policy list forward', () => {
  for (const tool of ['search_apis', 'list_products', 'get_product', 'list_apis', 'get_api', 'get_api_examples']) {
    assert.deepEqual(classify(tool, {}), { verdict: 'forward' }, tool);
  }
  assert.deepEqual(classify('manage_policy', { action: 'list' }), { verdict: 'forward' });
});

test('classify: manage_policy add demands a canonical ephemeral scope', () => {
  for (const scope of ['once', 'session', 'temporary']) {
    assert.deepEqual(classify('manage_policy', { action: 'add', line: 'ECS:X=allow', scope }), {
      verdict: 'forward',
    });
  }
  // F1 spelling floor: v0.2.0a4 rejects non-canonical spellings at add
  // (未知 scope), so this deny is the devkit's actionable English floor
  // firing before a gateway rejection. The floor is fail-closed on its
  // own: a future gateway that relaxes its scope validation still meets
  // this floor first.
  for (const scope of [' ONCE ', 'Once', 'ONCE', 'session ', ' Temporary']) {
    const ruling = classify('manage_policy', { action: 'add', line: 'ECS:X=allow', scope });
    assert.equal(ruling.verdict, 'deny', `scope ${JSON.stringify(scope)} must deny`);
    assert.match(String(ruling.reason), /canonical spelling/);
  }
  // The ephemeral allow-list failure direction stays closed: unknown,
  // missing, and every persistent spelling deny, and non-string scopes
  // deny too — an array ['once'] stringifies to 'once' and must not slip
  // the gate. The gateway itself would accept scope=permanent and write
  // the rule into the operator's policy file; this floor is the barrier.
  for (const scope of ['permanent', 'forever', 'banana', '', undefined, ['once'], { once: 1 }, 42]) {
    const toolArgs: Record<string, unknown> = { action: 'add', line: 'ECS:X=allow' };
    if (scope !== undefined) toolArgs.scope = scope;
    const ruling = classify('manage_policy', toolArgs);
    assert.equal(ruling.verdict, 'deny', `scope ${JSON.stringify(scope)} must deny`);
    assert.match(String(ruling.reason), /ephemeral scopes|policy file/);
  }
  // Non-canonical persistent spellings ('PERMANENT', ' permanent ') hit
  // the F1 floor first — denied either way, with spelling guidance; the
  // canonical 'permanent' spelling is the one that reaches (and is
  // refused by) the ephemeral floor with the operator-file pointer.
  for (const scope of ['PERMANENT', ' permanent ']) {
    const ruling = classify('manage_policy', { action: 'add', line: 'ECS:X=allow', scope });
    assert.equal(ruling.verdict, 'deny', `scope ${JSON.stringify(scope)} must deny`);
    assert.match(String(ruling.reason), /canonical spelling/);
  }
});

test('classify: manage_policy add rejects ttl_seconds outright (F2)', () => {
  // The gateway honors ttl_seconds only with scope=temporary, where it
  // stretches an "ephemeral" grant into a long-lived one. The knob denies
  // on every scope spelling, including the gateway-legal combination.
  for (const scope of ['once', 'session', 'temporary']) {
    const ruling = classify('manage_policy', {
      action: 'add',
      line: 'ECS:X=allow',
      scope,
      ttl_seconds: 3600,
    });
    assert.equal(ruling.verdict, 'deny', `ttl_seconds with scope=${scope} must deny`);
    assert.match(String(ruling.reason), /ttl_seconds/);
    assert.match(String(ruling.reason), /policy file/, 'the denial points at the operator alternative');
  }
  // A null ttl is absent, the same reading the remove-scope floor gives a
  // null scope: only a value that reaches the gateway as a number can
  // stretch a grant.
  const nullTtl = classify('manage_policy', { action: 'add', line: 'ECS:X=allow', scope: 'once', ttl_seconds: null });
  assert.equal(nullTtl.verdict, 'forward', 'an explicit null ttl carries no value and forwards');
});

test('classify: manage_policy remove takes no scope or ttl_seconds; the action allowlist denies everything else', () => {
  assert.deepEqual(classify('manage_policy', { action: 'remove', line: 'ECS:X=allow' }), { verdict: 'forward' });
  for (const scope of ['once', 'permanent']) {
    const ruling = classify('manage_policy', { action: 'remove', line: 'ECS:X=allow', scope });
    assert.equal(ruling.verdict, 'deny', `remove with scope ${scope} denies before the forward`);
    assert.match(String(ruling.reason), /takes no scope/);
  }
  // F2 symmetry with the add branch: the gateway rejects remove carrying
  // ttl_seconds the same way as scope, and a null ttl passes as absent.
  const ttl = classify('manage_policy', { action: 'remove', line: 'ECS:X=allow', ttl_seconds: 3600 });
  assert.equal(ttl.verdict, 'deny', 'remove with ttl_seconds denies before the forward');
  assert.match(String(ttl.reason), /ttl_seconds/);
  const nullTtl = classify('manage_policy', { action: 'remove', line: 'ECS:X=allow', ttl_seconds: null });
  assert.equal(nullTtl.verdict, 'forward', 'an explicit null ttl carries no value and forwards');
  // F1: non-canonical action spellings deny as spelling, not as unknown
  // actions — the message must name the fix, not the allowlist.
  const upper = classify('manage_policy', { action: 'ADD', line: 'ECS:X=allow', scope: 'once' });
  assert.equal(upper.verdict, 'deny', "'ADD' is a non-canonical action spelling and denies with the spelling fix");
  assert.match(String(upper.reason), /canonical spelling/);
  for (const action of ['append', ['add'], 42, undefined]) {
    const toolArgs: Record<string, unknown> = { line: 'ECS:X=allow', scope: 'once' };
    if (action !== undefined) toolArgs.action = action;
    const ruling = classify('manage_policy', toolArgs);
    assert.equal(ruling.verdict, 'deny', `action ${JSON.stringify(action)} must deny`);
    assert.match(String(ruling.reason), /only list, add, and remove/);
  }
});

test('classify: execute_api secret reads deny; every other execute forwards', () => {
  const ruling = classify('execute_api', { product: 'DEW', api: 'ShowSecretVersion' });
  assert.equal(ruling.verdict, 'deny');
  assert.match(String(ruling.reason), /secret/i);
  assert.deepEqual(classify('execute_api', { product: 'ECS', api: 'ListServers' }), { verdict: 'forward' });
});

test('classify: unknown tool names deny against the static vocabulary', () => {
  // Fail-closed on ignorance, judged against the static table — the live
  // surface is never consulted. Every vocabulary name (readonly AND
  // routed) is known; anything else denies with the vocabulary reason.
  // Known names may still deny on their own floors (manage_policy with
  // empty args denies on the action allowlist), so the known-name check
  // asserts the absence of the vocabulary denial, not a forward verdict.
  for (const tool of [...GATEWAY_TOOL_VOCABULARY.readonly, ...GATEWAY_TOOL_VOCABULARY.routed]) {
    const ruling = classify(tool, {});
    assert.doesNotMatch(
      String(ruling.reason ?? ''),
      /not in the gateway tool vocabulary/,
      `${tool} is a known name and must not unknown-deny`,
    );
  }
  for (const tool of ['failing_tool', 'envelope_fail_tool', 'no_such_tool', 'ExecuteApi', 'manage-policy']) {
    const ruling = classify(tool, {});
    assert.equal(ruling.verdict, 'deny', `${tool} is outside the vocabulary and must deny`);
    assert.match(String(ruling.reason), /not in the gateway tool vocabulary/);
  }
});

test('classify: transform_data guards the protected tree; clean calls forward', () => {
  const inside = classify('transform_data', { out: { path: join(stateHome, '.config', 'huaweicloud', 'leak.csv') } });
  assert.equal(inside.verdict, 'deny');
  assert.match(String(inside.reason), /consent infrastructure|protected state tree/);
  assert.deepEqual(classify('transform_data', { out: { path: join(tmpdir(), 'plain.csv') } }), {
    verdict: 'forward',
  });
  assert.deepEqual(classify('transform_data', { sql: 'select 1' }), { verdict: 'forward' }, 'no out path: forward');
  assert.deepEqual(classify('query_data', { sql: 'select 1' }), { verdict: 'forward' });
});

test('classify: every structured file target and credential-shaped SQL is denied for the data tools', () => {
  const protectedPath = join(stateHome, '.config', 'huaweicloud', 'approvals.json');
  // out.path on transform_data (the write target).
  assert.equal(
    classify('transform_data', { out: { path: protectedPath } }).verdict,
    'deny',
    'out.path into the tree denies',
  );
  // tables.*.path on BOTH data tools (query_data reads, transform_data
  // resolves them too) — round-4: the guard covered out.path only.
  for (const tool of ['query_data', 'transform_data']) {
    assert.equal(
      classify(tool, { sql: 'select * from t', tables: { victim: { path: protectedPath } } }).verdict,
      'deny',
      `${tool} tables path into the tree denies`,
    );
    assert.equal(
      classify(tool, { sql: 'select * from t', tables: { fine: { path: join(tmpdir(), 'plain.csv') } } }).verdict,
      'forward',
      `${tool} tables path outside the tree forwards`,
    );
  }
  // Best-effort text scan: a credential file referenced only inside SQL
  // (read_csv) trips the CLI face's own credential patterns. The floors
  // are the entire gate for these tools — the gateway does not
  // policy-gate them at all.
  const sqlRead = classify('query_data', { sql: "select * from read_csv('/home/u/.hcloud/config.json')" });
  assert.equal(sqlRead.verdict, 'deny', 'SQL credential literal denies');
  assert.match(String(sqlRead.reason), /credential/i);
});

test('classify: the path scan survives Windows separators and ignores separator-free mentions', () => {
  // Raw values are walked, never JSON.stringify: serialization doubles
  // backslashes, and 'C:\hcloud\config' (dotless, single separator) then
  // defeated the credential patterns (round-5 probe).
  const windowsDotless = classify('query_data', { sql: "select * from read_csv('C:\\hcloud\\config')" });
  assert.equal(windowsDotless.verdict, 'deny', 'dotless Windows path in SQL denies');
  const windowsDotted = classify('query_data', {
    sql: "select * from read_csv('C:\\Users\\u\\.hcloud\\config.json')",
  });
  assert.equal(windowsDotted.verdict, 'deny', 'dotted Windows path in SQL denies');
  // False-positive direction closed: a '.hcloud' mention with no path
  // separator is prose, not a file reference.
  const benign = classify('query_data', { sql: "select 'see the .hcloud docs for details'" });
  assert.equal(benign.verdict, 'forward', 'separator-free mentions are not file references');
  // Circular input terminates instead of throwing: classify rules, never
  // rejects.
  const circular: Record<string, unknown> = { sql: 'select 1' };
  circular.self = circular;
  assert.doesNotThrow(() => classify('query_data', circular));
  assert.equal(classify('query_data', circular).verdict, 'forward');
  // A value that is itself a JSON string carries doubled separators in
  // memory (read_json('{"path":"C:\\\\hcloud\\\\config"}')); the collapsed
  // variant of each candidate restores the single separator the patterns
  // require (round-6).
  const jsonNested = classify('query_data', { sql: JSON.stringify({ path: 'C:\\hcloud\\config' }) });
  assert.equal(jsonNested.verdict, 'deny', 'JSON-nested doubled separators still deny');
});

test('redactString covers auth-header values, quoted AK/SK, and Bearer forms', () => {
  const redacted = redactSecrets('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig');
  assert.equal(redacted, 'Authorization: <redacted>', 'the multi-word bearer value redacts to end-of-line');
  const quotedAk = redactSecrets('pydinct error near {"AK":"AKIAXXXX","SK":"seCrEt"} trailing');
  assert.ok(!quotedAk.includes('AKIAXXXX'), 'quoted AK redacts');
  assert.ok(!quotedAk.includes('seCrEt'), 'quoted SK redacts');
  assert.match(quotedAk, /trailing/, 'surrounding prose survives');
  // Word boundary (round-7): 'task:', 'risk:', 'disk:' are NOT AK/SK keys.
  for (const prose of ['task: migrate the database', 'risk: high severity', 'disk: 100GB']) {
    const preserved = redactSecrets(prose);
    assert.equal(preserved, prose, `${prose} must survive verbatim`);
  }
  // The object walk and the string walk agree on input_value.
  assert.equal(
    (redactSecrets({ input_value: 'SECRET' }) as { input_value: unknown }).input_value,
    '<redacted>',
    'object keys redact',
  );
});

test('resolveApprovalMode: unset passes; any set value throws the retirement guard', () => {
  // HUAWEICLOUD_OPENMCP_APPROVAL died with the devkit/native split. An
  // operator who set it must not upgrade into a silent no-op: the guard
  // throws with the migration pointer and stays for at least one release.
  assert.doesNotThrow(() => resolveApprovalMode({}));
  assert.doesNotThrow(() => resolveApprovalMode({ HUAWEICLOUD_OPENMCP_APPROVAL: '' }));
  assert.doesNotThrow(() => resolveApprovalMode({ HUAWEICLOUD_OPENMCP_APPROVAL: '   ' }));
  for (const value of ['devkit', 'native', 'bogus']) {
    assert.throws(
      () => resolveApprovalMode({ HUAWEICLOUD_OPENMCP_APPROVAL: value }),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        return (
          message.includes('HUAWEICLOUD_OPENMCP_APPROVAL is retired') &&
          message.includes('policy engine') &&
          message.includes('docs/safety-model.md')
        );
      },
      `${value} must throw the retirement guidance`,
    );
  }
  // The guidance names the operator policy file: the devkit-provisioned
  // pack state path when no operator env is set, the operator's own path
  // when it is.
  const home = fixtureDir('openmcp-retire-home-');
  assert.throws(
    () => resolveApprovalMode({ HUAWEICLOUD_HOME: home, HUAWEICLOUD_OPENMCP_APPROVAL: 'devkit' }),
    (error: unknown) =>
      new RegExp(join('.config', 'huaweicloud', 'packs', 'huaweicloud-open-mcp', 'policy').replace(/\\/g, '\\\\')).test(
        error instanceof Error ? error.message : String(error),
      ),
    'the retirement error names the provisioned policy file path',
  );
  assert.throws(
    () =>
      resolveApprovalMode({ HUAWEICLOUD_MCP_POLICY_FILE: '/opt/gw-policy', HUAWEICLOUD_OPENMCP_APPROVAL: 'devkit' }),
    (error: unknown) => /\/opt\/gw-policy/.test(error instanceof Error ? error.message : String(error)),
    'the retirement error names the operator policy file when one is configured',
  );
});

// ── gateway_list_tools / gateway_call through the real dispatch ──

test('huaweicloud_gateway_list_tools reports the live surface and its drift', async () => {
  const result = (await callTool('huaweicloud_gateway_list_tools', {})) as GatewayListToolsResult;
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.ok(Array.isArray(result.tools) && result.tools.length > 0, 'tools/list is non-empty');
  assert.ok(result.tools.every((tool) => typeof tool.name === 'string' && tool.inputSchema));
  assert.ok(result.drift && Array.isArray(result.drift.missing), 'drift is always reported');
  assert.ok(
    result.drift.missing.includes('execute_api'),
    'the default fake exposes no policy tools, so execute_api is drift-missing',
  );
});

test('gateway_call passes read-only discovery tools straight through', async () => {
  const result = (await callTool('huaweicloud_gateway_call', {
    tool: 'search_apis',
    toolArgs: { query: 'ecs' },
  })) as GatewayCallResult;
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.tool, 'search_apis');
  assert.equal(result.arguments.query, 'ecs');
  assert.equal(result.requiresApproval, undefined, 'read-only tools never demand consent');
});

// ── the delegated approval face through the real dispatch ──
// First call forwards, every routed tool, no consent round trip: the
// gateway's own policy engine is the authority, and the fake mirrors its
// refusal envelope ({ok:false, reason}) for ungranted calls.

test(
  'gateway_call forwards each routed tool to the gateway on the first call',
  withGatewayEnv({ FAKE_POLICY: '1' }, async () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ['execute_api', { product: 'ECS', api: 'CreateServers' }],
      ['manage_policy', { action: 'list' }],
      ['manage_policy', { action: 'add', line: 'ECS:ListServers=allow', scope: 'once' }],
      ['manage_policy', { action: 'remove', line: 'ECS:ListServers=allow' }],
      ['query_data', { sql: 'select 1 as x' }],
      ['transform_data', { sql: 'select 1 as x', out: { path: join(tmpdir(), 'plain.csv') } }],
    ];
    for (const [tool, toolArgs] of cases) {
      const result = (await callTool('huaweicloud_gateway_call', { tool, toolArgs })) as GatewayCallResult;
      // Every gateway-served result carries the tool name; the mint path
      // never did. tool presence is the forwarding proof.
      assert.equal(result.tool, tool, `${tool} must be served by the gateway, not refused locally`);
      assert.equal(result.requiresApproval, undefined, 'the delegated face never demands consent');
      assert.equal(result.classification, undefined, 'no floor fired for these benign arguments');
    }
  }),
);

test(
  'an engine refusal returns the {ok:false} envelope with the reason preserved',
  withGatewayEnv({ FAKE_POLICY: '1' }, async () => {
    const result = (await callTool('huaweicloud_gateway_call', {
      tool: 'execute_api',
      toolArgs: { product: 'ECS', api: 'CreateServers' },
    })) as GatewayCallResult;
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.equal(result.requiresApproval, undefined, 'refusals are engine verdicts, not consent demands');
    assert.match(String(result.error), /safety policy/);
    assert.equal(result.reason, String(result.error), 'the engine refusal text is preserved verbatim');
    assert.match(String(result.error), /api_session=最小规则/, 'the consent-teaching tail names the session preset');
    assert.match(String(result.error), /readonly=产品级只读规则集/, 'the tail names the readonly preset too');
  }),
);

test(
  'the delegated consent round: refuse, grant with an ephemeral scope, retry, burn',
  withGatewayEnv({ FAKE_POLICY: '1' }, async () => {
    const execArgs = { product: 'ECS', api: 'CreateServers' };
    const refused = (await callTool('huaweicloud_gateway_call', {
      tool: 'execute_api',
      toolArgs: execArgs,
    })) as GatewayCallResult;
    assert.equal(refused.ok, false, 'the empty policy refuses the first execute');
    assert.match(String(refused.error), /safety policy/);

    const granted = (await callTool('huaweicloud_gateway_call', {
      tool: 'manage_policy',
      toolArgs: { action: 'add', line: 'ECS:CreateServers=allow', scope: 'once' },
    })) as GatewayCallResult;
    assert.equal(granted.ok, true, JSON.stringify(granted));

    const executed = (await callTool('huaweicloud_gateway_call', {
      tool: 'execute_api',
      toolArgs: execArgs,
    })) as GatewayCallResult;
    assert.equal(executed.ok, true, JSON.stringify(executed));
    assert.deepEqual(executed.executed, { product: 'ECS', api: 'CreateServers' });

    const listing = (await callTool('huaweicloud_gateway_call', {
      tool: 'manage_policy',
      toolArgs: { action: 'list' },
    })) as GatewayCallResult;
    assert.equal(listing.ok, true, JSON.stringify(listing));
    assert.ok(
      !listing.rules.some((rule) => rule.line === 'ECS:CreateServers=allow'),
      'the once-scope grant burned with the execute',
    );
  }),
);

test(
  'a once-burn removes the matched overlay rule, not the last one',
  withGatewayEnv({ FAKE_POLICY: '1' }, async () => {
    // Three once rules with the MIDDLE one executed: splice(-1) eats C,
    // splice(0) eats A, and indexOf on the spread copy is -1, so it eats
    // C too; every wrong shape fails an assertion. That the burn hits
    // the granting rule is inferred from documented once semantics, not
    // measured: executions against nonexistent APIs stop at catalog
    // resolution, so the real gateway never gets far enough to burn.
    for (const line of ['ECS:RuleA=allow', 'ECS:RuleB=allow', 'ECS:RuleC=allow']) {
      const added = (await callTool('huaweicloud_gateway_call', {
        tool: 'manage_policy',
        toolArgs: { action: 'add', line, scope: 'once' },
      })) as GatewayCallResult;
      assert.equal(added.ok, true, JSON.stringify(added));
    }

    const executed = (await callTool('huaweicloud_gateway_call', {
      tool: 'execute_api',
      toolArgs: { product: 'ECS', api: 'RuleB' },
    })) as GatewayCallResult;
    assert.equal(executed.ok, true, JSON.stringify(executed));

    const listing = (await callTool('huaweicloud_gateway_call', {
      tool: 'manage_policy',
      toolArgs: { action: 'list' },
    })) as GatewayCallResult;
    assert.equal(listing.ok, true, JSON.stringify(listing));
    const lines = new Set(listing.rules.map((rule) => rule.line));
    assert.ok(!lines.has('ECS:RuleB=allow'), 'the executed once rule burned');
    assert.ok(lines.has('ECS:RuleA=allow'), 'the untouched rule ahead of it survives');
    assert.ok(lines.has('ECS:RuleC=allow'), 'the untouched rule behind it survives');
  }),
);

test(
  "the fixture mirrors the gateway's exact-string manage_policy semantics",
  withGatewayEnv({ FAKE_POLICY: '1' }, async () => {
    // The devkit floor denies every non-canonical shape before the
    // forward, so these pin the fixture's own dispatch through
    // callOpenMcpTool directly, bypassing gateway_call. The policy file
    // is written before this test's spawn so both layers are populated
    // for the list-order and policy-echo pins below (provisioning is
    // exclusive-create, so the pre-written file survives untouched).
    const policyPath = join(stateHome, '.config', 'huaweicloud', 'packs', 'huaweicloud-open-mcp', 'policy');
    mkdirSync(dirname(policyPath), { recursive: true });
    writeFileSync(policyPath, '# operator-authored\nECS:FromFile=allow\n');
    try {
      const upper = await callOpenMcpTool('manage_policy', { action: 'ADD', line: 'ECS:X=allow', scope: 'once' });
      assert.equal(upper.ok, false, JSON.stringify(upper));
      assert.match(String(upper.error), /unsupported manage_policy action/);

      const bogus = await callOpenMcpTool('manage_policy', { action: 'add', line: 'ECS:X=allow', scope: 'bogus' });
      assert.equal(bogus.ok, false, JSON.stringify(bogus));
      assert.match(
        String(bogus.error),
        /未知 scope: bogus（可选 permanent\/temporary\/session\/once）/,
        'the probed vocabulary, in the probed order',
      );

      // v0.2.0a4 (re-probed 2026-10-11) rejects the verbatim ' ONCE '
      // spelling at add; round-5's accept-and-never-burn measurement was
      // the pre-a4 gateway. The rejection echoes the raw spelling, never
      // a normalized one.
      const spaced = await callOpenMcpTool('manage_policy', { action: 'add', line: 'ECS:X=allow', scope: ' ONCE ' });
      assert.equal(spaced.ok, false, JSON.stringify(spaced));
      assert.equal(
        String(spaced.error),
        '未知 scope:  ONCE （可选 permanent/temporary/session/once）',
        'the raw spelling crosses un-normalized, byte-faithful to the probe',
      );

      const ttlRemove = await callOpenMcpTool('manage_policy', {
        action: 'remove',
        line: 'ECS:X=allow',
        ttl_seconds: 3600,
      });
      assert.equal(ttlRemove.ok, false, JSON.stringify(ttlRemove));
      assert.match(String(ttlRemove.error), /remove 不接受 scope/);

      const added = await callOpenMcpTool('manage_policy', {
        action: 'add',
        line: 'ECS:OverlayRule=allow',
        scope: 'once',
      });
      assert.equal(added.ok, true, JSON.stringify(added));
      assert.ok(
        String(added.policy).includes('# operator-authored'),
        'the add success envelope echoes the raw file text, comment included',
      );

      const listed = await callOpenMcpTool('manage_policy', { action: 'list' });
      assert.equal(listed.ok, true, JSON.stringify(listed));
      const rules = listed.rules as Array<{ line: string }>;
      assert.equal(rules[0].line, 'ECS:OverlayRule=allow', 'overlay rules list before file rules');
      assert.ok(
        rules.some((rule) => rule.line === 'ECS:FromFile=allow'),
        'the file rule appears later in the listing',
      );

      const removed = await callOpenMcpTool('manage_policy', { action: 'remove', line: 'ECS:FromFile=allow' });
      assert.equal(removed.ok, true, JSON.stringify(removed));
      assert.ok(
        !String(removed.policy).includes('ECS:FromFile=allow'),
        'the remove envelope echoes the file after the rewrite, rule gone',
      );
    } finally {
      writeFileSync(policyPath, '');
    }
  }),
);

test(
  'the floor matrix denies end-to-end through the dispatch',
  withGatewayEnv({ FAKE_POLICY: '1' }, async () => {
    const protectedTree = join(stateHome, '.config', 'huaweicloud', 'leak.csv');
    const denies: Array<[string, Record<string, unknown>, RegExp]> = [
      ['execute_api', { product: 'DEW', api: 'ShowSecretVersion' }, /secret/i],
      [
        'transform_data',
        { sql: 'select 1', out: { path: protectedTree } },
        /protected state tree|consent infrastructure/,
      ],
      ['query_data', { sql: "select * from read_csv('/home/u/.hcloud/config.json')" }, /credential/i],
      ['manage_policy', { action: 'add', line: 'ECS:X=allow', scope: 'permanent' }, /ephemeral scopes/],
      ['manage_policy', { action: 'add', line: 'ECS:X=allow', scope: ' ONCE ' }, /canonical spelling/],
      ['manage_policy', { action: 'ADD', line: 'ECS:X=allow', scope: 'once' }, /canonical spelling/],
      ['manage_policy', { action: 'add', line: 'ECS:X=allow', scope: 'once', ttl_seconds: 3600 }, /ttl_seconds/],
      ['manage_policy', { action: 'remove', line: 'ECS:X=allow', scope: 'once' }, /takes no scope/],
      ['manage_policy', { action: 'remove', line: 'ECS:X=allow', ttl_seconds: 3600 }, /ttl_seconds/],
      ['no_such_tool', {}, /not in the gateway tool vocabulary/],
    ];
    for (const [tool, toolArgs, reasonPattern] of denies) {
      const result = (await callTool('huaweicloud_gateway_call', { tool, toolArgs })) as GatewayCallResult;
      assert.equal(result.ok, false, `${tool} ${JSON.stringify(toolArgs)} must deny`);
      assert.equal(result.classification, 'deny', 'the denial is a floor ruling');
      assert.equal(result.tool, undefined, 'a floor denial never reaches the gateway');
      assert.equal(result.requiresApproval, undefined, 'the delegated face never demands consent');
      assert.match(String(result.error), reasonPattern);
    }
  }),
);

test('floor denials do not spend a gateway spawn', async () => {
  await _resetOpenMcpSidecar();
  try {
    const before = _openMcpSidecarStats().spawns;
    const denied = (await callTool('huaweicloud_gateway_call', {
      tool: 'manage_policy',
      toolArgs: { action: 'add', line: 'ECS:X=allow', scope: 'permanent' },
    })) as GatewayCallResult;
    assert.equal(denied.ok, false);
    assert.equal(denied.classification, 'deny');
    assert.equal(_openMcpSidecarStats().spawns, before, 'floors rule on the arguments alone, before any sidecar');
  } finally {
    await _resetOpenMcpSidecar();
  }
});

test(
  'a set HUAWEICLOUD_OPENMCP_APPROVAL surfaces the retirement guidance as the tool error',
  withGatewayEnv({ HUAWEICLOUD_OPENMCP_APPROVAL: 'native' }, async () => {
    const result = (await callTool('huaweicloud_gateway_call', {
      tool: 'search_apis',
      toolArgs: { query: 'x' },
    })) as GatewayCallResult;
    assert.equal(result.ok, false);
    assert.match(String(result.error), /HUAWEICLOUD_OPENMCP_APPROVAL is retired/);
    assert.match(String(result.error), /docs\/safety-model\.md/);
  }),
);

test(
  'a known tool missing from the live surface is forwarded and fails at the gateway',
  withGatewayEnv({ FAKE_POLICY: '1', FAKE_HIDE_TOOLS: 'execute_api' }, async () => {
    const result = (await callTool('huaweicloud_gateway_call', {
      tool: 'execute_api',
      toolArgs: { product: 'ECS', api: 'CreateServers' },
    })) as GatewayCallResult;
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.equal(result.tool, 'execute_api', 'the call was forwarded, not pre-denied as drift');
    assert.match(String(result.error), /Unknown tool/);
  }),
);

test(
  'a CLI-trimmed configuration keeps the gateway write path alive through delegation; the operator policy file is the control plane',
  withGatewayEnv({ FAKE_POLICY: '1' }, () =>
    withDevkitPacks('core,huaweicloud-open-mcp', async () => {
      const execArgs = { product: 'ECS', api: 'CreateServers' };
      const forwarded = (await callTool('huaweicloud_gateway_call', {
        tool: 'execute_api',
        toolArgs: execArgs,
      })) as GatewayCallResult;
      assert.equal(forwarded.tool, 'execute_api', 'the write path forwards instead of demanding consent');
      assert.equal(forwarded.requiresApproval, undefined);
      assert.equal(forwarded.ok, false, 'the empty policy refuses it: the engine is the gate');

      const policyPath = join(stateHome, '.config', 'huaweicloud', 'packs', 'huaweicloud-open-mcp', 'policy');
      writeFileSync(policyPath, 'ECS:CreateServers=allow\n');
      try {
        const executed = (await callTool('huaweicloud_gateway_call', {
          tool: 'execute_api',
          toolArgs: execArgs,
        })) as GatewayCallResult;
        assert.equal(executed.ok, true, JSON.stringify(executed));
        assert.deepEqual(
          executed.executed,
          { product: 'ECS', api: 'CreateServers' },
          'an operator allow line in the policy file authorizes the call',
        );
      } finally {
        writeFileSync(policyPath, '');
      }
    })(),
  ),
);

test(
  'the operator policy file is the delegated control plane — a file-layer rule grants, and a cross-layer remove rewrites it',
  withGatewayEnv({ FAKE_POLICY: '1' }, async () => {
    // Written before the first gateway_call so the spawned child reads it
    // from --policy: provisioning is exclusive-create, so an
    // operator-authored file survives the spawn untouched. The remove half
    // pins AR1 (docs/safety-model.md) as concrete behavior: manage_policy
    // remove is cross-layer and rewrites the operator's file.
    const policyPath = join(stateHome, '.config', 'huaweicloud', 'packs', 'huaweicloud-open-mcp', 'policy');
    // The directory otherwise appears only with the first spawn's
    // provisioning; a standalone run must create it before writing.
    mkdirSync(dirname(policyPath), { recursive: true });
    writeFileSync(policyPath, 'ECS:ListServers=allow\n');
    try {
      const execArgs = { product: 'ECS', api: 'ListServers' };
      const granted = (await callTool('huaweicloud_gateway_call', {
        tool: 'execute_api',
        toolArgs: execArgs,
      })) as GatewayCallResult;
      assert.equal(granted.ok, true, JSON.stringify(granted));
      assert.deepEqual(
        granted.executed,
        { product: 'ECS', api: 'ListServers' },
        'a file-layer rule authorizes the call with no overlay grant',
      );

      const removed = (await callTool('huaweicloud_gateway_call', {
        tool: 'manage_policy',
        toolArgs: { action: 'remove', line: 'ECS:ListServers=allow' },
      })) as GatewayCallResult;
      assert.equal(removed.ok, true, JSON.stringify(removed));
      assert.ok(
        !String(removed.policy).includes('ECS:ListServers=allow'),
        'the remove envelope echoes the rewritten file: the rule is gone from the policy text',
      );

      const refused = (await callTool('huaweicloud_gateway_call', {
        tool: 'execute_api',
        toolArgs: execArgs,
      })) as GatewayCallResult;
      assert.equal(refused.ok, false, 'the cross-layer remove rewrote the policy file, so the rule is gone');
      assert.match(String(refused.error), /safety policy/);
    } finally {
      writeFileSync(policyPath, '');
    }
  }),
);

test('resolveGatewaySpawnArgs rejects relative operator policy/audit paths', () => {
  for (const key of ['HUAWEICLOUD_MCP_POLICY_FILE', 'HUAWEICLOUD_MCP_AUDIT_FILE']) {
    assert.throws(
      () => resolveGatewaySpawnArgs({ HOME: '/h', [key]: 'relative/policy' }),
      new RegExp(`${key} must be an absolute path`),
      `${key} relative is refused`,
    );
  }
  // Absolute values pass validation (the policy one still drives pin-unless-env).
  const plan = resolveGatewaySpawnArgs({ HOME: '/h', HUAWEICLOUD_MCP_POLICY_FILE: '/opt/gw-policy' });
  assert.ok(!plan.args.includes('--policy'));
});

test('error envelopes cross the normalization boundary redacted', async () => {
  // failing_tool echoes its arguments as key=value text inside an
  // isError:true envelope — the shape validation failures take when they
  // echo the offending input. The secret must not survive the boundary.
  const result = await callOpenMcpTool('failing_tool', { adminPass: 'Secret123', note: 'plain' });
  assert.equal(result.ok, false);
  assert.match(String(result.error), /adminPass=<redacted>/);
  assert.ok(!String(result.error).includes('Secret123'), 'the plaintext secret never crosses');
  assert.match(String(result.error), /note=plain/, 'non-secret content survives verbatim');
});

test('JSON-shaped error envelopes redact through the object walk', async () => {
  // json_error_tool echoes its arguments as JSON inside isError:true —
  // the strongest redaction shape, since the text parses and the key-name
  // walk applies instead of the string patterns.
  const result = await callOpenMcpTool('json_error_tool', { adminPass: 'Secret123', note: 'plain' });
  assert.equal(result.ok, false);
  const errorText = String(result.error);
  assert.match(errorText, /"adminPass":\s*"<redacted>"/);
  assert.ok(!errorText.includes('Secret123'), 'the plaintext secret never crosses in JSON form either');
  assert.match(errorText, /"note":\s*"plain"/, 'non-secret keys survive the walk');
});

test(
  'gateway_call rejects non-object toolArgs explicitly instead of coercing',
  withGatewayEnv({}, async () => {
    for (const bad of ['a string', 42, ['array'], null] as unknown[]) {
      const result = (await callTool('huaweicloud_gateway_call', {
        tool: 'search_apis',
        toolArgs: bad as Record<string, unknown>,
      })) as GatewayCallResult;
      assert.equal(result.ok, false);
      assert.match(String(result.error), /toolArgs must be an object/);
    }
    // undefined behaves as an empty object (the MCP optional-field case).
    const fine = (await callTool('huaweicloud_gateway_call', { tool: 'list_products' })) as GatewayCallResult;
    assert.equal(fine.ok, true, JSON.stringify(fine));
  }),
);

// Last in the file on purpose: withGatewayEnv resets the sidecar in its
// finally, so the suite does not exit with a live fake-gateway child
// holding the stdio pipes (node --test then never drains).
test('gatewayCallSchema no longer declares the retired consent fields', async () => {
  const { getToolSchema } = await import('../plugins/huaweicloud-core/src/tool-schemas.ts');
  const rendered = JSON.stringify(getToolSchema('huaweicloud_gateway_call').toJSONSchema());
  assert.ok(!rendered.includes('approvalToken'), 'approvalToken must be absent from the rendered schema');
  assert.ok(!rendered.includes('approvedByUser'), 'approvedByUser must be absent from the rendered schema');
  assert.match(rendered, /"tool"/, 'the tool field is still declared');
  assert.match(rendered, /"toolArgs"/, 'the toolArgs field is still declared');
});
