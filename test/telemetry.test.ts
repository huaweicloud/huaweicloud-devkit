import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { PassThrough } from 'node:stream';

import { AGENTS } from '../plugins/huaweicloud-core/src/telemetry/agent-registry.ts';
import { detectAgentHarness } from '../plugins/huaweicloud-core/src/telemetry/agent-detect.ts';

const DETECTION_ENV_KEYS = ['AGENT_HARNESS', ...new Set(AGENTS.flatMap((agent) => agent.envVars || []))];

function withNoAgentEnv(fn: () => void) {
  const prev = Object.fromEntries(DETECTION_ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of DETECTION_ENV_KEYS) delete process.env[key];
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

type TelemetryModule = typeof import('../plugins/huaweicloud-core/src/telemetry/telemetry.ts');

// 隔离 telemetry face 的模块级目录常量（GLOBAL_TELEMETRY_DIR 在 import 时固定）：
// 临时 HUAWEICLOUD_DEVKIT_HOME + 带 query 的 import 强制新模块实例，用完恢复并清理。
// fn also receives the home so tests can locate the global-dir artifacts
// (installation-id, the exit spool) the isolated instance writes there.
async function withIsolatedTelemetry(fn: (telemetry: TelemetryModule, home: string) => unknown) {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hwdk-telemetry-'));
  const prevHome = process.env.HUAWEICLOUD_DEVKIT_HOME;
  process.env.HUAWEICLOUD_DEVKIT_HOME = tmp;
  try {
    const telemetry = await import(`../plugins/huaweicloud-core/src/telemetry/telemetry.ts?iso=${Date.now()}`);
    return await fn(telemetry, tmp);
  } finally {
    if (prevHome === undefined) delete process.env.HUAWEICLOUD_DEVKIT_HOME;
    else process.env.HUAWEICLOUD_DEVKIT_HOME = prevHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// The exit-spool file location for a given home (the face's
// GLOBAL_TELEMETRY_DIR derivation, mirrored for assertions).
function exitSpoolPath(home: string): string {
  return path.join(home, '.huaweicloud-devkit', 'telemetry', 'exit-events.jsonl');
}

// ---- flush-behavior test infrastructure ----
//
// The flush path rides fetchWithProxy, which dispatches to global.fetch
// when no proxy is configured (the hdkitservice-api.test.ts stubbing
// precedent). "No proxy" must be established from every source the
// resolver reads: the proxy env spellings AND a developer's proxy.json
// (whose path derives from HUAWEICLOUD_HOME), so the file-scope hermetic
// home below redirects that config too.
//
// The hermetic home ALSO pins the CANONICAL face instance's module-scope
// paths (the query-less import the pack handlers and the stdio transport
// resolve): its GLOBAL_TELEMETRY_DIR is derived at first load, so the env
// must be in place before any test triggers that load — hence file scope,
// not per-test. withIsolatedTelemetry overrides it per-test and restores
// back to this value.
const PROXY_ENV_KEYS = ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy'] as const;
const savedProxyEnv: Record<string, string | undefined> = {};
for (const key of PROXY_ENV_KEYS) {
  savedProxyEnv[key] = process.env[key];
  delete process.env[key];
}
const fs = await import('node:fs');
const os = await import('node:os');
const path = await import('node:path');
const FILE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'hwdk-telemetry-file-'));
const prevDevkitHome = process.env.HUAWEICLOUD_DEVKIT_HOME;
const prevHwHome = process.env.HUAWEICLOUD_HOME;
process.env.HUAWEICLOUD_DEVKIT_HOME = FILE_HOME;
process.env.HUAWEICLOUD_HOME = FILE_HOME;

after(() => {
  for (const key of PROXY_ENV_KEYS) {
    if (savedProxyEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedProxyEnv[key];
  }
  if (prevDevkitHome === undefined) delete process.env.HUAWEICLOUD_DEVKIT_HOME;
  else process.env.HUAWEICLOUD_DEVKIT_HOME = prevDevkitHome;
  if (prevHwHome === undefined) delete process.env.HUAWEICLOUD_HOME;
  else process.env.HUAWEICLOUD_HOME = prevHwHome;
  fs.rmSync(FILE_HOME, { recursive: true, force: true });
});

const TELEMETRY_URL = 'https://telemetry-stub.test/events';

interface CapturedCall {
  url: string;
  body?: string;
}

// Stub global.fetch; the returned restore puts the original back. The
// handler receives the flat (url, init) the pipeline passes on.
function stubFetch(handler: (url: string, init: RequestInit) => Promise<Response>): () => void {
  const original = global.fetch;
  global.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    handler(input.toString(), init ?? {})) as typeof fetch;
  return () => {
    global.fetch = original;
  };
}

function okTelemetryResponse(): Response {
  return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

// The telemetry POSTs out of a captured call log, bodies parsed.
function telemetryPostBodies(calls: CapturedCall[]): Record<string, unknown>[][] {
  return calls
    .filter((call) => call.url === TELEMETRY_URL)
    .map((call) => JSON.parse(call.body ?? '[]') as Record<string, unknown>[]);
}

async function withEnv(vars: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
  const prev: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) {
    prev[key] = process.env[key];
    const value = vars[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    await fn();
  } finally {
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

// DAU warm-up: the agent-dir stamps (install-stamp / dau-stamp /
// first-use-stamp) live in the SHARED plugin telemetry dir, so whether
// the boot enqueues already consumed the day's dau:active_today depends
// on machine state (first run of the UTC day vs any later run — the
// stamp is only touched by a SUCCESSFUL flush). Tests that deepEqual
// exact scenario shapes drain one warm-up enqueue first, so checkDauPing
// has fired and the stamp is touched before their scenario begins —
// machine-state-independent either way.
async function drainDauPing(telemetry: TelemetryModule): Promise<void> {
  telemetry.trackToolInvoke('dau_warmup');
  await telemetry.flushTelemetryEvents();
}

test('detectAgentHarness returns known when no env set', () => {
  const result = detectAgentHarness();
  assert.ok(result === null || (typeof result === 'string' && result.length > 0));
});

test('detectAgentHarness respects AGENT_HARNESS env', () => {
  const prev = process.env.AGENT_HARNESS;
  process.env.AGENT_HARNESS = 'opencode';
  try {
    assert.equal(detectAgentHarness(), 'opencode');
  } finally {
    if (prev) process.env.AGENT_HARNESS = prev;
    else delete process.env.AGENT_HARNESS;
  }
});

test('detectAgentHarness detects opencode from env', () => {
  const prev = process.env.OPENCODE_SESSION_ID;
  process.env.OPENCODE_SESSION_ID = 'test-session';
  try {
    assert.equal(detectAgentHarness(), 'opencode');
  } finally {
    if (prev) process.env.OPENCODE_SESSION_ID = prev;
    else delete process.env.OPENCODE_SESSION_ID;
  }
});

test('detectAgentHarness returns unknown when nothing matches', () => {
  withNoAgentEnv(() => {
    // #1040: the fallback converged to 'unknown' — no clientInfo.name
    // passthrough (probe clients like 'startup'), no installSegment '|'
    // concatenation, never null.
    assert.equal(detectAgentHarness(), 'unknown');
  });
});

test('detectAgentHarness classifies MCP client names to canonical harness', () => {
  const nameBackedAgents = AGENTS.filter((a) => a.clientNames?.length);
  const idNameAgents = AGENTS.filter((a) => a.envVars?.length);
  const cases = [
    ...nameBackedAgents.flatMap((a) => (a.clientNames ?? []).map((n) => [n, a.id])),
    ...idNameAgents.map((a) => [a.id, a.id]),
  ];
  withNoAgentEnv(() => {
    for (const [name, expected] of cases) {
      assert.equal(detectAgentHarness({ name }), expected, `name=${name}`);
    }
  });
});

test('detectAgentHarness prefers real host env over clientInfo.name', () => {
  const hostBackedAgents = AGENTS.filter((a) => a.envVars?.length);
  withNoAgentEnv(() => {
    for (const agent of hostBackedAgents) {
      process.env[agent.envVars![0]] = 'simulated';
      assert.equal(
        detectAgentHarness({ name: 'unknown-mcp-client-probe' }),
        agent.id,
        `env ${agent.envVars![0]} should win over name for ${agent.id}`,
      );
      delete process.env[agent.envVars![0]];
    }
  });
});

// The registry's path patterns are matched against the spawned server's own
// module path. opencode resolves its config root from XDG_CONFIG_HOME (and
// the installer follows, xdgConfigHome), so the opencode marker must survive
// a non-default root — the plugin dir segment, not the ~/.config prefix.
test('opencode path pattern matches payload paths under any XDG root', () => {
  const opencode = AGENTS.find((a) => a.id === 'opencode');
  assert.ok(opencode?.pathPatterns?.length, 'opencode must carry path patterns');
  const marker = opencode.pathPatterns![0]!;
  const payloadPaths = [
    '/home/u/.config/opencode/huaweicloud-plugins/dist/mcp-server.js',
    '/home/u/xdg/opencode/huaweicloud-plugins/dist/mcp-server.js',
    '/home/u/.config/opencode/huaweicloud-plugins/src/mcp-server.mjs',
  ];
  for (const serverPath of payloadPaths) {
    assert.ok(serverPath.includes(marker), `marker ${marker} must match ${serverPath}`);
  }
  // matchAgent is substring + first-match over AGENTS order, so the real
  // no-collision property is non-containment: a future broad pattern (e.g.
  // /huaweicloud-plugins/) on any agent would shadow or be shadowed by the
  // opencode marker while passing an exact-equality check.
  for (const agent of AGENTS.filter((a) => a.id !== 'opencode')) {
    for (const pattern of agent.pathPatterns ?? []) {
      assert.ok(
        !pattern.includes(marker) && !marker.includes(pattern),
        `agent ${agent.id} pattern ${pattern} must neither contain nor be contained by the opencode marker ${marker}`,
      );
    }
  }
  // And no agent listed BEFORE opencode may match an opencode payload path
  // (first-match order would attribute the spawn to that agent instead).
  const opencodeIdx = AGENTS.findIndex((a) => a.id === 'opencode');
  for (const agent of AGENTS.slice(0, opencodeIdx)) {
    for (const pattern of agent.pathPatterns ?? []) {
      for (const serverPath of payloadPaths) {
        assert.ok(
          !serverPath.includes(pattern),
          `earlier agent ${agent.id} pattern ${pattern} must not match an opencode payload path`,
        );
      }
    }
  }
});

test('generateOrRecoverInstallId returns consistent string', async () => {
  await withIsolatedTelemetry(async ({ generateOrRecoverInstallId }) => {
    const id1 = generateOrRecoverInstallId();
    const id2 = generateOrRecoverInstallId();
    assert.equal(typeof id1, 'string');
    assert.equal(id1, id2);
  });
});

test('isTelemetryEnabled defaults to true', async () => {
  const { isTelemetryEnabled } = await import('../plugins/huaweicloud-core/src/telemetry/telemetry.ts');
  assert.equal(isTelemetryEnabled(), true);
});

test('isTelemetryEnabled returns false when env set to off', async () => {
  const prev = process.env.HUAWEICLOUD_DEVKIT_TELEMETRY;
  process.env.HUAWEICLOUD_DEVKIT_TELEMETRY = 'off';
  try {
    const { isTelemetryEnabled } = await import('../plugins/huaweicloud-core/src/telemetry/telemetry.ts');
    assert.equal(isTelemetryEnabled(), false);
  } finally {
    if (prev) process.env.HUAWEICLOUD_DEVKIT_TELEMETRY = prev;
    else delete process.env.HUAWEICLOUD_DEVKIT_TELEMETRY;
  }
});

test('initTelemetry and trackToolInvoke do not throw', async () => {
  await withIsolatedTelemetry(async ({ initTelemetry, trackToolInvoke, trackSkillRetrieve }) => {
    initTelemetry({ harness: 'test', version: '1.0.0' });
    assert.doesNotThrow(() => trackToolInvoke('test_tool_name'));
    assert.doesNotThrow(() => trackSkillRetrieve('test_skill_name'));
  });
});

test('trackSandboxConnect and trackSandboxDisconnect do not throw', async () => {
  await withIsolatedTelemetry(async ({ initTelemetry, trackSandboxConnect, trackSandboxDisconnect }) => {
    initTelemetry({ harness: 'test', version: '1.0.0' });
    assert.doesNotThrow(() => trackSandboxConnect());
    assert.doesNotThrow(() => trackSandboxDisconnect());
  });
});

test('sanitizeValue truncates long values to 255', async () => {
  const { sanitizeValue } = await import('../plugins/huaweicloud-core/src/telemetry/telemetry.ts');
  const out = sanitizeValue('x'.repeat(500));
  assert.equal(out.length, 255);
  assert.ok(out.endsWith('...'));
});

test('sanitizeValue replaces newlines and tabs with spaces', async () => {
  const { sanitizeValue } = await import('../plugins/huaweicloud-core/src/telemetry/telemetry.ts');
  assert.equal(sanitizeValue('a\nb\tc'), 'a b c');
});

test('sanitizeValue keeps short values intact', async () => {
  const { sanitizeValue } = await import('../plugins/huaweicloud-core/src/telemetry/telemetry.ts');
  assert.equal(sanitizeValue('hcloud version'), 'hcloud version');
});

test('sanitizeValue coerces non-strings and nulls safely', async () => {
  const { sanitizeValue } = await import('../plugins/huaweicloud-core/src/telemetry/telemetry.ts');
  assert.equal(sanitizeValue(null), '');
  assert.equal(sanitizeValue(undefined), '');
  assert.equal(sanitizeValue(123), '123');
});

test('cacheUserHash writes to filesystem', async () => {
  await withIsolatedTelemetry(async ({ cacheUserHash }) => {
    assert.doesNotThrow(() => cacheUserHash('sha256hash1234'));
  });
});

test('ingestHookEvents handles empty or missing file', async () => {
  await withIsolatedTelemetry(async ({ initTelemetry, ingestHookEvents }) => {
    initTelemetry({ harness: 'test', version: '1.0.0' });
    assert.doesNotThrow(() => ingestHookEvents());
  });
});

// ---- awaitable flush (E4a) ----
//
// initTelemetry enqueues boot events (plugin:install / first_use / the DAU
// ping, depending on stamp state) and schedules its own setImmediate
// flush; every test below first awaits one flush so the boot round and
// that chain have settled, leaving a deterministic empty queue.

test('flushTelemetryEvents resolves without a POST when the queue is empty', async () => {
  await withIsolatedTelemetry(async (telemetry) => {
    const calls: CapturedCall[] = [];
    const restore = stubFetch(async (url, init) => {
      calls.push({ url, body: typeof init.body === 'string' ? init.body : undefined });
      return okTelemetryResponse();
    });
    try {
      await withEnv({ HUAWEICLOUD_DEVKIT_TELEMETRY_ENDPOINT: TELEMETRY_URL }, async () => {
        telemetry.initTelemetry({ harness: 'test', version: '1.0.0' });
        await telemetry.flushTelemetryEvents();
        const postsBefore = telemetryPostBodies(calls).length;
        await telemetry.flushTelemetryEvents();
        assert.equal(telemetryPostBodies(calls).length, postsBefore);
      });
    } finally {
      restore();
    }
  });
});

test('flushTelemetryEvents sends queued events with their literal keys', async () => {
  await withIsolatedTelemetry(async (telemetry) => {
    const calls: CapturedCall[] = [];
    const restore = stubFetch(async (url, init) => {
      calls.push({ url, body: typeof init.body === 'string' ? init.body : undefined });
      return okTelemetryResponse();
    });
    try {
      await withEnv({ HUAWEICLOUD_DEVKIT_TELEMETRY_ENDPOINT: TELEMETRY_URL }, async () => {
        telemetry.initTelemetry({ harness: 'test', version: '1.0.0' });
        await telemetry.flushTelemetryEvents();
        await drainDauPing(telemetry);
        telemetry.trackToolInvoke('flush_send_probe');
        telemetry.trackSkillRetrieve('flush-skill-probe');
        await telemetry.flushTelemetryEvents();
        const posts = telemetryPostBodies(calls);
        const last = posts[posts.length - 1]!;
        assert.deepEqual(
          last.map((event) => event.key),
          ['tool:flush_send_probe', 'skill:retrieve'],
        );
        // events carry the session identity they were built with
        assert.equal(last[0]!.harness, 'test');
        assert.equal(typeof last[0]!.installId, 'string');
        assert.ok((last[0]!.installId as string).length > 0);
      });
    } finally {
      restore();
    }
  });
});

test('a flush arriving mid-round chains onto it and flushes late-enqueued events', async () => {
  await withIsolatedTelemetry(async (telemetry) => {
    const calls: CapturedCall[] = [];
    // The gate holds exactly the NEXT telemetry POST until released, so
    // round 1 stays in flight while the test enqueues behind its splice.
    let holdNext = false;
    let release: () => void = () => {};
    let gate: Promise<void> = Promise.resolve();
    const restore = stubFetch(async (url, init) => {
      calls.push({ url, body: typeof init.body === 'string' ? init.body : undefined });
      if (holdNext && url === TELEMETRY_URL) {
        holdNext = false;
        await gate;
      }
      return okTelemetryResponse();
    });
    try {
      await withEnv({ HUAWEICLOUD_DEVKIT_TELEMETRY_ENDPOINT: TELEMETRY_URL }, async () => {
        telemetry.initTelemetry({ harness: 'test', version: '1.0.0' });
        await telemetry.flushTelemetryEvents();
        await drainDauPing(telemetry);

        telemetry.trackToolInvoke('inflight_first');
        holdNext = true;
        gate = new Promise<void>((resolveGate) => {
          release = resolveGate;
        });
        // Round 1 splices inflight_first synchronously, then suspends on
        // the gated fetch.
        const p1 = telemetry.flushTelemetryEvents();
        telemetry.trackToolInvoke('inflight_second');
        // Arrives mid-round: chains onto round 1 plus one follow-up round.
        const p2 = telemetry.flushTelemetryEvents();
        release();
        await p1;
        await p2;

        const posts = telemetryPostBodies(calls);
        const tail = posts.slice(-2);
        assert.deepEqual(
          tail[0]!.map((event) => event.key),
          ['tool:inflight_first'],
        );
        assert.deepEqual(
          tail[1]!.map((event) => event.key),
          ['tool:inflight_second'],
        );
      });
    } finally {
      restore();
    }
  });
});

test('flushTelemetryEvents resolves on server failure and requeues for the next flush', async () => {
  await withIsolatedTelemetry(async (telemetry) => {
    const calls: CapturedCall[] = [];
    let failTelemetry = true;
    const restore = stubFetch(async (url, init) => {
      calls.push({ url, body: typeof init.body === 'string' ? init.body : undefined });
      if (url === TELEMETRY_URL && failTelemetry) {
        return new Response(JSON.stringify({}), { status: 503, headers: { 'Content-Type': 'application/json' } });
      }
      return okTelemetryResponse();
    });
    try {
      await withEnv({ HUAWEICLOUD_DEVKIT_TELEMETRY_ENDPOINT: TELEMETRY_URL }, async () => {
        telemetry.initTelemetry({ harness: 'test', version: '1.0.0' });
        telemetry.trackToolInvoke('retry_probe');
        // 503 -> requeue; the promise resolves, never rejects (the P0
        // await contract).
        await assert.doesNotReject(telemetry.flushTelemetryEvents());
        const failedRounds = telemetryPostBodies(calls).length;
        failTelemetry = false;
        await telemetry.flushTelemetryEvents();
        const posts = telemetryPostBodies(calls);
        assert.ok(posts.length > failedRounds, 'the requeued events must be re-sent by a later flush');
        const keys = posts
          .slice(failedRounds)
          .flat()
          .map((event) => event.key);
        assert.ok(keys.includes('tool:retry_probe'));
      });
    } finally {
      restore();
    }
  });
});

// ---- exit-time synchronous disk spool (E4b) ----

test('spoolTelemetryEvents is a no-op when the queue is empty', async () => {
  await withIsolatedTelemetry(async (telemetry, home) => {
    const restore = stubFetch(async () => okTelemetryResponse());
    try {
      await withEnv({ HUAWEICLOUD_DEVKIT_TELEMETRY_ENDPOINT: TELEMETRY_URL }, async () => {
        telemetry.initTelemetry({ harness: 'test', version: '1.0.0' });
        await telemetry.flushTelemetryEvents();
        telemetry.spoolTelemetryEvents();
        assert.ok(!fs.existsSync(exitSpoolPath(home)), 'an empty queue must not create a spool file');
      });
    } finally {
      restore();
    }
  });
});

test('spoolTelemetryEvents writes full-event JSONL and hands the queue over', async () => {
  await withIsolatedTelemetry(async (telemetry, home) => {
    const calls: CapturedCall[] = [];
    const restore = stubFetch(async (url, init) => {
      calls.push({ url, body: typeof init.body === 'string' ? init.body : undefined });
      return okTelemetryResponse();
    });
    try {
      await withEnv({ HUAWEICLOUD_DEVKIT_TELEMETRY_ENDPOINT: TELEMETRY_URL }, async () => {
        telemetry.initTelemetry({ harness: 'test', version: '1.0.0' });
        await telemetry.flushTelemetryEvents();
        await drainDauPing(telemetry);
        const spool = exitSpoolPath(home);

        telemetry.trackToolInvoke('exit_spool_probe');
        telemetry.spoolTelemetryEvents();
        assert.ok(fs.existsSync(spool));
        const lines = fs.readFileSync(spool, 'utf8').trim().split('\n').filter(Boolean);
        assert.equal(lines.length, 1);
        const event = JSON.parse(lines[0]!) as Record<string, unknown>;
        assert.equal(event.key, 'tool:exit_spool_probe');
        // full-event shape (the exiting session's identity rides along),
        // not the hook-spool input shape
        assert.equal(event.harness, 'test');
        assert.equal(typeof event.installId, 'string');

        // the in-memory queue handed over: a second spool appends nothing
        // (double-write convergence), and a flush after the handover has
        // nothing to send
        const postsBefore = telemetryPostBodies(calls).length;
        telemetry.spoolTelemetryEvents();
        assert.equal(fs.readFileSync(spool, 'utf8').trim().split('\n').filter(Boolean).length, 1);
        await telemetry.flushTelemetryEvents();
        assert.equal(telemetryPostBodies(calls).length, postsBefore);
      });
    } finally {
      restore();
    }
  });
});

test('the exit spool round-trips: the next boot ingests and flushes the recovered events', async () => {
  // Twin query-string face instances under ONE home stand in for two
  // process lifetimes: boot 1 loses its flush (failing endpoint), exit-
  // spools, "dies"; boot 2 boots against the same home, ingests the spool
  // through the boot seam, and flushes the recovered events.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hwdk-telemetry-boot-'));
  const prevHome = process.env.HUAWEICLOUD_DEVKIT_HOME;
  process.env.HUAWEICLOUD_DEVKIT_HOME = home;
  const calls: CapturedCall[] = [];
  let endpointHealthy = false;
  const restore = stubFetch(async (url, init) => {
    calls.push({ url, body: typeof init.body === 'string' ? init.body : undefined });
    if (url === TELEMETRY_URL && !endpointHealthy) {
      return new Response(JSON.stringify({}), { status: 503, headers: { 'Content-Type': 'application/json' } });
    }
    return okTelemetryResponse();
  });
  try {
    await withEnv({ HUAWEICLOUD_DEVKIT_TELEMETRY_ENDPOINT: TELEMETRY_URL }, async () => {
      // ---- boot 1: events stay queued (503 requeue), then the exit handover ----
      const boot1 = (await import(
        `../plugins/huaweicloud-core/src/telemetry/telemetry.ts?iso=boot1-${Date.now()}`
      )) as TelemetryModule;
      boot1.initTelemetry({ harness: 'boot1', version: '1.0.0' });
      boot1.trackToolInvoke('recovered_by_next_boot');
      await boot1.flushTelemetryEvents();
      boot1.spoolTelemetryEvents();
      const spool = exitSpoolPath(home);
      assert.ok(fs.existsSync(spool), 'the exit handover must write the spool');
      assert.ok(fs.readFileSync(spool, 'utf8').includes('"key":"tool:recovered_by_next_boot"'));

      // ---- boot 2 (same home): the spool rides the boot ingest seam ----
      endpointHealthy = true;
      const boot2 = (await import(
        `../plugins/huaweicloud-core/src/telemetry/telemetry.ts?iso=boot2-${Date.now()}`
      )) as TelemetryModule;
      boot2.initTelemetry({ harness: 'boot2', version: '1.0.0' });
      // The ingest depth during initTelemetry depends on shared stamp
      // state (how many boot events enqueue); drive the public ingest seam
      // explicitly so the test is deterministic on every machine.
      boot2.ingestHookEvents();
      await boot2.flushTelemetryEvents();

      const keys = telemetryPostBodies(calls)
        .flat()
        .map((event) => event.key);
      assert.ok(keys.includes('tool:recovered_by_next_boot'), 'the recovered event must reach the endpoint');
      // the recovered event keeps the EXITING session's identity
      const recovered = telemetryPostBodies(calls)
        .flat()
        .find((event) => event.key === 'tool:recovered_by_next_boot')!;
      assert.equal(recovered.harness, 'boot1');
      // the spool is fully consumed (live renamed, .processing read + unlinked)
      assert.ok(!fs.existsSync(spool));
      assert.ok(!fs.existsSync(`${spool}.processing`));
    });
  } finally {
    restore();
    if (prevHome === undefined) delete process.env.HUAWEICLOUD_DEVKIT_HOME;
    else process.env.HUAWEICLOUD_DEVKIT_HOME = prevHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('exit-spool ingest drops malformed lines and recovers a crashed .processing leftover', async () => {
  await withIsolatedTelemetry(async (telemetry, home) => {
    const calls: CapturedCall[] = [];
    const restore = stubFetch(async (url, init) => {
      calls.push({ url, body: typeof init.body === 'string' ? init.body : undefined });
      return okTelemetryResponse();
    });
    try {
      await withEnv({ HUAWEICLOUD_DEVKIT_TELEMETRY_ENDPOINT: TELEMETRY_URL }, async () => {
        const fullEvent = (key: string): Record<string, unknown> => ({
          key,
          value: '1',
          installId: 'recover-install-id',
          userHash: null,
          version: '0.0.0',
          harness: 'crashed-boot',
          agentVersion: '1.0.0',
          os: 'A',
          osVersion: '1',
        });
        const spool = exitSpoolPath(home);
        fs.mkdirSync(path.dirname(spool), { recursive: true });
        // a crashed PREVIOUS ingest left a .processing leftover; the live
        // file carries one good line, one non-JSON line, and one
        // well-formed-but-wrong-shape line
        fs.writeFileSync(`${spool}.processing`, `${JSON.stringify(fullEvent('tool:leftover_probe'))}\n`, 'utf8');
        fs.writeFileSync(
          spool,
          `not-json-at-all\n${JSON.stringify({ key: 'shapeless_probe', value: '1' })}\n${JSON.stringify(
            fullEvent('tool:live_probe'),
          )}\n`,
          'utf8',
        );

        telemetry.initTelemetry({ harness: 'test', version: '1.0.0' });
        // two ingest passes converge any depth: leftover read + live
        // rename in the first, renamed read + unlink in the second
        telemetry.ingestHookEvents();
        telemetry.ingestHookEvents();
        await telemetry.flushTelemetryEvents();

        const keys = new Set(
          telemetryPostBodies(calls)
            .flat()
            .map((event) => event.key),
        );
        assert.ok(keys.has('tool:leftover_probe'), 'the crashed leftover must be recovered');
        assert.ok(keys.has('tool:live_probe'), 'the live spool line must be recovered');
        assert.ok(!keys.has('shapeless_probe'), 'a wrong-shape line must be dropped');
        assert.ok(!fs.existsSync(spool));
        assert.ok(!fs.existsSync(`${spool}.processing`));
      });
    } finally {
      restore();
    }
  });
});

// The real exit paths, driven through the transport's own stream wiring:
// a PassThrough pair rides the injectable `streams` seam (the
// initializeSideEffects precedent — binding the REAL process streams under
// a test harness corrupts the harness's own stream state), emitted
// 'close' events fire the transport's handlers, and a patched process.exit
// records the hard exit instead of taking it. The spool's side effects
// (file written, queue handed over) are asserted directly, and the patch
// ALSO captures whether the spool file existed at the moment exit was
// called, which pins the spool-BEFORE-exit ordering.
test('the stdio transport exit paths spool the queue before exiting', async () => {
  const calls: CapturedCall[] = [];
  const restore = stubFetch(async (url, init) => {
    calls.push({ url, body: typeof init.body === 'string' ? init.body : undefined });
    return okTelemetryResponse();
  });
  const spool = exitSpoolPath(FILE_HOME);
  const exitCalls: { code: number; spoolExists: boolean }[] = [];
  const originalExit = process.exit;
  process.exit = ((code?: number) => {
    exitCalls.push({ code: code ?? 0, spoolExists: fs.existsSync(spool) });
  }) as typeof process.exit;
  try {
    await withEnv({ HUAWEICLOUD_DEVKIT_TELEMETRY_ENDPOINT: TELEMETRY_URL }, async () => {
      // The CANONICAL face instance (the one the transport's import
      // resolves) — its module-scope paths derive from the file-scope home.
      const telemetry = (await import('../plugins/huaweicloud-core/src/telemetry/telemetry.ts')) as TelemetryModule;
      telemetry.initTelemetry({ harness: 'transport-test', version: '1.0.0' });
      await telemetry.flushTelemetryEvents();
      await drainDauPing(telemetry);
      const { DevkitStdioTransport } = await import('../plugins/huaweicloud-core/src/mcp-stdio-transport.ts');
      const fakeStdin = new PassThrough();
      const fakeStdout = new PassThrough();
      const transport = new DevkitStdioTransport({ streams: { stdin: fakeStdin, stdout: fakeStdout } });
      await transport.start();

      // ---- phase 1: the normal shutdown order (stdin close → hard exit) ----
      telemetry.trackToolInvoke('exit_via_stdin_close');
      fakeStdin.emit('close');
      assert.equal(exitCalls.length, 1);
      assert.equal(exitCalls[0]!.code, 0);
      assert.equal(exitCalls[0]!.spoolExists, true, 'the spool must exist BEFORE process.exit takes effect');
      assert.deepEqual(
        fs
          .readFileSync(spool, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => (JSON.parse(line) as Record<string, unknown>).key),
        ['tool:exit_via_stdin_close'],
      );

      // Model the next boot's consumption of the spool (the ingest claim —
      // an enqueue-side ingestSpools renames the live file to .processing
      // and a later pass reads + unlinks it), flushing what it recovered,
      // so phase 2 starts from a clean slate. The two phases each model
      // one process lifetime for determinism; the real both-spool window
      // is stdout-close-then-stdin-close on a non-keepalive transport
      // (stdout close does not exit; the later stdin close spools the
      // delta enqueued in between, then hard-exits — exactly the
      // append+clear convergence spoolEventsForExit documents).
      telemetry.ingestHookEvents();
      telemetry.ingestHookEvents();
      await telemetry.flushTelemetryEvents();
      fs.rmSync(spool, { force: true });
      fs.rmSync(`${spool}.processing`, { force: true });

      // ---- phase 2: the rarer order (stdout close → natural drain) ----
      telemetry.trackToolInvoke('exit_via_stdout_close');
      fakeStdout.emit('close');
      assert.equal(exitCalls.length, 1, 'the stdout-close path must not hard-exit');
      assert.ok(fs.existsSync(spool), 'the stdout-close path must spool the queue');
      assert.deepEqual(
        fs
          .readFileSync(spool, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => (JSON.parse(line) as Record<string, unknown>).key),
        ['tool:exit_via_stdout_close'],
      );
      // NO destroy() on the fake streams: destroy() emits a SECOND 'close'
      // asynchronously — by then the finally has restored the real
      // process.exit, so the transport's handler would execute the
      // production hard exit inside the test process (measured: it
      // collapses the whole file into one racy opaque gate unit). A
      // PassThrough pair is in-memory — no handles to release.
    });
  } finally {
    process.exit = originalExit;
    restore();
    fs.rmSync(spool, { force: true });
  }
});

test('exit-spool ingest respects the queue cap, keeping the newest events', async () => {
  await withIsolatedTelemetry(async (telemetry, home) => {
    const calls: CapturedCall[] = [];
    const restore = stubFetch(async (url, init) => {
      calls.push({ url, body: typeof init.body === 'string' ? init.body : undefined });
      return okTelemetryResponse();
    });
    try {
      await withEnv({ HUAWEICLOUD_DEVKIT_TELEMETRY_ENDPOINT: TELEMETRY_URL }, async () => {
        const fullEvent = (key: string): Record<string, unknown> => ({
          key,
          value: '1',
          installId: 'cap-install-id',
          userHash: null,
          version: '0.0.0',
          harness: 'cap-boot',
          agentVersion: '1.0.0',
          os: 'A',
          osVersion: '1',
        });
        const spool = exitSpoolPath(home);
        fs.mkdirSync(path.dirname(spool), { recursive: true });
        // 600 built events — more than the pipeline's 500-event queue cap
        const lines = Array.from({ length: 600 }, (_, i) =>
          JSON.stringify(fullEvent(`tool:cap_probe_${String(i + 1).padStart(4, '0')}`)),
        );
        fs.writeFileSync(spool, `${lines.join('\n')}\n`, 'utf8');

        telemetry.initTelemetry({ harness: 'test', version: '1.0.0' });
        telemetry.ingestHookEvents();
        telemetry.ingestHookEvents();
        // drain whatever the queue holds (boot events + the clamped
        // recovery), one round per await, until a round sends nothing
        let prevPosts = -1;
        for (let i = 0; i < 20 && telemetryPostBodies(calls).length !== prevPosts; i++) {
          prevPosts = telemetryPostBodies(calls).length;
          await telemetry.flushTelemetryEvents();
        }
        const capProbes = telemetryPostBodies(calls)
          .flat()
          .map((event) => String(event.key))
          .filter((key) => key.startsWith('tool:cap_probe_'));
        assert.equal(capProbes.length, 500, 'the ingested queue must clamp to the cap');
        assert.ok(!capProbes.includes('tool:cap_probe_0001'), 'the oldest overflow is dropped');
        assert.ok(capProbes.includes('tool:cap_probe_0600'), 'the newest events are kept');
      });
    } finally {
      restore();
    }
  });
});

test('a persistently failing endpoint drops events after the retry budget', async () => {
  await withIsolatedTelemetry(async (telemetry) => {
    const calls: CapturedCall[] = [];
    let failTelemetry = true;
    const restore = stubFetch(async (url, init) => {
      calls.push({ url, body: typeof init.body === 'string' ? init.body : undefined });
      if (url === TELEMETRY_URL && failTelemetry) {
        return new Response(JSON.stringify({}), { status: 503, headers: { 'Content-Type': 'application/json' } });
      }
      return okTelemetryResponse();
    });
    try {
      await withEnv({ HUAWEICLOUD_DEVKIT_TELEMETRY_ENDPOINT: TELEMETRY_URL }, async () => {
        telemetry.initTelemetry({ harness: 'test', version: '1.0.0' });
        telemetry.trackToolInvoke('drop_probe');
        // four failing rounds exhaust the three-retry budget for every
        // event that rode them (chained setImmediate rounds only add
        // failures); every await resolves — the never-reject contract
        for (let i = 0; i < 4; i++) {
          await assert.doesNotReject(telemetry.flushTelemetryEvents());
        }
        failTelemetry = false;
        const failedRounds = telemetryPostBodies(calls).length;
        await telemetry.flushTelemetryEvents();
        await telemetry.flushTelemetryEvents();
        // the failed rounds' POST bodies naturally contain the probe (it
        // was being retried); only what is sent AFTER the budget is
        // exhausted proves the drop
        const keys = telemetryPostBodies(calls)
          .slice(failedRounds)
          .flat()
          .map((event) => event.key);
        assert.ok(!keys.includes('tool:drop_probe'), 'the probe must be dropped after exhausting the retry budget');
      });
    } finally {
      restore();
    }
  });
});

// ---- voucher P0 sync flush (E4c) ----
//
// The end-to-end seam: callTool dispatches the voucher pack handler, which
// awaits the telemetry flush after the claim result arrives and before
// returning. Driven through the REAL canonical instances (the pack handler
// resolves the same query-less face the transport does — pinned by the
// home canary below), with both HTTP legs stubbed: the hdkit voucher
// endpoint answers a successful claim, the telemetry endpoint captures the
// flush POST. The order log pins the contract.
test('voucher claim flushes telemetry before the tool result returns', async () => {
  const order: string[] = [];
  const calls: CapturedCall[] = [];
  const restore = stubFetch(async (url, init) => {
    if (url.includes('/voucher/claim')) {
      order.push('voucher-claim');
      return new Response(JSON.stringify({ claimed: true, userHash: 'p0-flush-hash' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    calls.push({ url, body: typeof init.body === 'string' ? init.body : undefined });
    if (url === TELEMETRY_URL) order.push('telemetry-flush');
    return okTelemetryResponse();
  });
  try {
    await withEnv(
      {
        HUAWEICLOUD_DEVKIT_TELEMETRY_ENDPOINT: TELEMETRY_URL,
        HDKITSERVICE_ENDPOINT: 'https://hdkit-stub.test/hdkitservice/',
        HW_ACCESS_KEY: 'TESTAK',
        HW_SECRET_KEY: 'TESTSK',
        HUAWEICLOUD_VENDOR_CHALLENGE: 'off',
      },
      async () => {
        const telemetry = (await import('../plugins/huaweicloud-core/src/telemetry/telemetry.ts')) as TelemetryModule;
        telemetry.initTelemetry({ harness: 'p0-test', version: '1.0.0' });
        // canary: the canonical instance took the file-scope home (a
        // module-load-order regression here would silently point the
        // assertions at the real home)
        assert.ok(
          fs.existsSync(path.join(FILE_HOME, '.huaweicloud-devkit', 'telemetry', 'installation-id')),
          'the canonical face must derive its paths from the file-scope home',
        );
        await telemetry.flushTelemetryEvents();

        const { callTool } = await import('../plugins/huaweicloud-core/src/tools.ts');
        const result = (await callTool('huaweicloud_voucher_claim', {
          vendorConfirmed: '用户明确要求领取华为云代金券',
        })) as Record<string, unknown>;
        order.push('tool-returned');
        assert.equal(result.claimed, true);
        assert.deepEqual(
          order.slice(-3),
          ['voucher-claim', 'telemetry-flush', 'tool-returned'],
          'the flush must sit strictly between the claim response and the tool result',
        );
        const keys = telemetryPostBodies(calls)
          .flat()
          .map((event) => event.key);
        assert.ok(keys.includes('tool:huaweicloud_voucher_claim'));
      },
    );
  } finally {
    restore();
  }
});
