// #1040 (port of dev e1ac2aa2 + eff624d1): agent-identity fallback
// convergence. detectAgent/detectAgentHarness return 'unknown' instead of
// passing clientInfo.name through or concatenating the install segment
// into the harness (the '|' pollution of the agent-distribution
// dashboard); AGENT_HARNESS is trusted only when it hits the AGENTS
// whitelist. installSegment rides telemetry events as its own field, and
// every outbound request (hdkitservice + telemetry flush) carries
// X-HW-Agent. This file lands the port's battery RED first; the
// implementation commits flip it green.
import assert from 'node:assert/strict';
import test, { after } from 'node:test';

import { AGENTS, installSegment } from '../plugins/huaweicloud-core/src/telemetry/agent-registry.ts';
import { detectAgent, detectAgentHarness } from '../plugins/huaweicloud-core/src/telemetry/agent-detect.ts';
import { sanitizeValue, toTelemetryEvent } from '../plugins/huaweicloud-core/src/telemetry/telemetry-values.ts';
import { fixtureDir } from './fixture-dir.ts';

// Both fetch stubs below ride fetchWithProxy's no-proxy branch (direct
// global.fetch), so every proxy source the resolver reads must be neutral
// for the whole file: the env spellings AND a developer's proxy.json
// (whose path derives from HUAWEICLOUD_HOME).
const PROXY_ENV_KEYS = ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy'] as const;
const savedProxyEnv: Record<string, string | undefined> = {};
for (const key of PROXY_ENV_KEYS) {
  savedProxyEnv[key] = process.env[key];
  delete process.env[key];
}

// The hermetic home also pins the canonical telemetry face's
// module-scope GLOBAL_TELEMETRY_DIR before the hdkitservice-api import
// below can load it, so its stamps never touch the developer's real home.
const FILE_HOME = fixtureDir('hwdk-1040-home-');
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
});

// Loaded after the hermetic env so the telemetry face the API module
// caches evaluates under FILE_HOME.
const { hdkitVoucherStatus } = await import('../plugins/huaweicloud-core/src/lib/hdkit/hdkitservice-api.ts');
const { clearRuntimeCredentials } = await import('../plugins/huaweicloud-core/src/auth/credentials.ts');

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

type TelemetryFace = typeof import('../plugins/huaweicloud-core/src/telemetry/telemetry.ts');

// The established isolation pattern (telemetry.test.ts): a fresh face
// instance via query-string import under a redirected home; siblings
// resolve to their cached instances by design. The fixture home rides the
// shared registry, so no per-test rmSync is needed.
async function withIsolatedTelemetry(fn: (telemetry: TelemetryFace) => Promise<void>): Promise<void> {
  const home = fixtureDir('hwdk-1040-tel-');
  const prevHome = process.env.HUAWEICLOUD_DEVKIT_HOME;
  process.env.HUAWEICLOUD_DEVKIT_HOME = home;
  try {
    const telemetry = await import(`../plugins/huaweicloud-core/src/telemetry/telemetry.ts?iso1040=${Date.now()}`);
    await fn(telemetry);
  } finally {
    if (prevHome === undefined) delete process.env.HUAWEICLOUD_DEVKIT_HOME;
    else process.env.HUAWEICLOUD_DEVKIT_HOME = prevHome;
  }
}

test('#1040 detectAgent fallback harness is unknown, no | pollution', () => {
  withNoAgentEnv(() => {
    for (const ci of [
      {},
      { name: 'startup' },
      { name: 'test-client' },
      { name: 'voucher-claim-probe' },
      { name: 'startup', version: '1.0.0' },
    ]) {
      const { harness, version } = detectAgent(ci);
      assert.equal(harness, 'unknown', `clientInfo=${JSON.stringify(ci)}`);
      assert.ok(!harness.includes('|'), 'harness must not contain the install-segment separator');
      assert.equal(version, ci.version || '0.0.0');
    }
  });
});

test('#1040 detectAgentHarness fallback is unknown for probe-like client names', () => {
  withNoAgentEnv(() => {
    assert.equal(detectAgentHarness({ name: 'startup' }), 'unknown');
    assert.equal(detectAgentHarness({ name: 'test' }), 'unknown');
    assert.equal(detectAgentHarness({ name: 'voucher-claim-xyz' }), 'unknown');
    assert.equal(detectAgentHarness(), 'unknown');
  });
});

test('#1040 AGENT_HARNESS outside the whitelist is ignored and falls back to unknown', () => {
  withNoAgentEnv(() => {
    process.env.AGENT_HARNESS = 'not-a-known-agent|with-pollution';
    try {
      assert.equal(detectAgentHarness(), 'unknown');
      assert.equal(detectAgent().harness, 'unknown');
    } finally {
      delete process.env.AGENT_HARNESS;
    }
  });
});

test('#1040 whitelisted AGENT_HARNESS still wins', () => {
  withNoAgentEnv(() => {
    process.env.AGENT_HARNESS = 'opencode';
    try {
      assert.equal(detectAgentHarness(), 'opencode');
      assert.equal(detectAgent().harness, 'opencode');
    } finally {
      delete process.env.AGENT_HARNESS;
    }
  });
});

test('#1040 known agents still match by env and client name (regression)', () => {
  withNoAgentEnv(() => {
    assert.equal(detectAgentHarness({ name: 'codex-mcp-client' }), 'codex');
    process.env.OPENCODE_SESSION_ID = 's1';
    try {
      assert.equal(detectAgentHarness({ name: 'startup' }), 'opencode');
    } finally {
      delete process.env.OPENCODE_SESSION_ID;
    }
  });
});

test('#1040 hdkitRequest sends the X-HW-Agent header', async () => {
  const prevAk = process.env.HW_ACCESS_KEY;
  const prevSk = process.env.HW_SECRET_KEY;
  const prevEndpoint = process.env.HDKITSERVICE_ENDPOINT;
  process.env.HW_ACCESS_KEY = 'TESTAK';
  process.env.HW_SECRET_KEY = 'TESTSK';
  process.env.HDKITSERVICE_ENDPOINT = 'https://example.test/hdkitservice/';
  clearRuntimeCredentials();

  const originalFetch = global.fetch;
  let capturedHeaders: Record<string, string> | null = null;
  global.fetch = (async (_url: RequestInfo | URL, opts?: RequestInit) => {
    capturedHeaders = (opts?.headers ?? {}) as Record<string, string>;
    return new Response(JSON.stringify({ claimed: false }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
  // Manual detection-env isolation: the window must span the await, so the
  // sync withNoAgentEnv helper does not apply.
  const prevDetection = Object.fromEntries(DETECTION_ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of DETECTION_ENV_KEYS) delete process.env[key];
  try {
    process.env.AGENT_HARNESS = 'opencode';
    await hdkitVoucherStatus();
    assert.equal(
      capturedHeaders!['X-HW-Agent'],
      'opencode',
      'hdkitservice requests must carry X-HW-Agent = detectAgent().harness',
    );
  } finally {
    for (const [key, value] of Object.entries(prevDetection)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    global.fetch = originalFetch;
    if (prevAk === undefined) delete process.env.HW_ACCESS_KEY;
    else process.env.HW_ACCESS_KEY = prevAk;
    if (prevSk === undefined) delete process.env.HW_SECRET_KEY;
    else process.env.HW_SECRET_KEY = prevSk;
    if (prevEndpoint === undefined) delete process.env.HDKITSERVICE_ENDPOINT;
    else process.env.HDKITSERVICE_ENDPOINT = prevEndpoint;
    clearRuntimeCredentials();
  }
});

const TELEMETRY_URL = 'https://telemetry-stub-1040.test/events';

test('#1040 telemetry flush sends the X-HW-Agent header and installSegment as its own field', async () => {
  await withIsolatedTelemetry(async (telemetry) => {
    const prevEndpoint = process.env.HUAWEICLOUD_DEVKIT_TELEMETRY_ENDPOINT;
    process.env.HUAWEICLOUD_DEVKIT_TELEMETRY_ENDPOINT = TELEMETRY_URL;
    const originalFetch = global.fetch;
    const telemetryHeaders: Record<string, string>[] = [];
    const telemetryBodies: Record<string, unknown>[][] = [];
    global.fetch = (async (input: RequestInfo | URL, opts?: RequestInit) => {
      if (input.toString() === TELEMETRY_URL) {
        telemetryHeaders.push((opts?.headers ?? {}) as Record<string, string>);
        telemetryBodies.push(JSON.parse(String(opts?.body ?? '[]')) as Record<string, unknown>[]);
      }
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;
    try {
      const prevDetection = Object.fromEntries(DETECTION_ENV_KEYS.map((key) => [key, process.env[key]]));
      for (const key of DETECTION_ENV_KEYS) delete process.env[key];
      try {
        process.env.AGENT_HARNESS = 'dsh';
        telemetry.initTelemetry({ harness: 'dsh', version: '1.2.3' });
        telemetry.trackToolInvoke('huaweicloud_check_cli');
        await telemetry.flushTelemetryEvents();
      } finally {
        for (const [key, value] of Object.entries(prevDetection)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }

      assert.ok(telemetryHeaders.length > 0, 'at least one telemetry POST must have been flushed');
      for (const headers of telemetryHeaders) {
        assert.equal(headers['X-HW-Agent'], 'dsh', 'every telemetry POST must carry X-HW-Agent');
      }

      const events = telemetryBodies.flat();
      const toolEvents = events.filter((event) => event.key === 'tool:huaweicloud_check_cli');
      assert.ok(
        toolEvents.length > 0,
        // Forensics (the 2026-10-29 windows-CI reds, runs 40841747815 /
        // 40849117055): the tool event missed the flush round's
        // splice(0, BATCH_SIZE=100) because enqueueTrackedEvent had
        // ingested a suite-shared agent-dir hook spool ahead of it — the
        // hook battery tests spawned the real py hook without gating its
        // record_cli_event writes. Batches-without-the-tool-event below
        // means exactly that: an ingest-flooded queue, not a pipeline
        // defect. The spawn sites now gate telemetry off; a stale local
        // spool file (pre-fix runs) still poisons once — delete
        // plugins/huaweicloud-core/telemetry/hook-events.jsonl*.
        `the tracked tool event must be in a flushed batch — batches=[${telemetryBodies
          .map((batch) => batch.map((event) => String(event.key)).join(','))
          .join(' || ')}] posts=${telemetryHeaders.length}`,
      );
      const expectedSegment = installSegment();
      for (const event of events) {
        assert.ok(!String(event.harness).includes('|'), 'no event harness may carry the install-segment separator');
        if (expectedSegment !== null) {
          assert.equal(
            event.installSegment,
            sanitizeValue(expectedSegment),
            'every event carries installSegment as its own sanitized field',
          );
        } else {
          assert.ok(!('installSegment' in event), 'no installSegment field when the segment is null');
        }
      }
    } finally {
      global.fetch = originalFetch;
      if (prevEndpoint === undefined) delete process.env.HUAWEICLOUD_DEVKIT_TELEMETRY_ENDPOINT;
      else process.env.HUAWEICLOUD_DEVKIT_TELEMETRY_ENDPOINT = prevEndpoint;
    }
  });
});

// The exit-spool round trip (v2-specific surface dev's port does not have):
// spooled lines are FULL events kept verbatim, so installSegment must
// survive the strict narrow exactly as the exiting session stamped it.
test('#1040 exit-spool full events keep installSegment verbatim through toTelemetryEvent', () => {
  const full = {
    key: 'tool:probe',
    value: '1',
    installId: 'install-id',
    userHash: null,
    version: '1.0.0',
    harness: 'dsh',
    agentVersion: '1.2.3',
    os: 'Linux',
    osVersion: '6.1',
    installSegment: '.herdr/worktrees/repo',
  };
  const kept = toTelemetryEvent(full);
  assert.ok(kept, 'a full valid event must narrow');
  assert.equal(kept.installSegment, '.herdr/worktrees/repo');

  const absent = { ...full } as Partial<typeof full>;
  delete absent.installSegment;
  const narrowedAbsent = toTelemetryEvent(absent);
  assert.ok(narrowedAbsent, 'a full valid event without the field must still narrow');
  assert.ok(!('installSegment' in narrowedAbsent), 'no installSegment when the spooled line carried none');

  const malformed = { ...full, installSegment: 123 };
  const narrowedMalformed = toTelemetryEvent(malformed);
  assert.ok(narrowedMalformed, 'a non-string installSegment must not drop the whole line');
  assert.ok(!('installSegment' in narrowedMalformed), 'a non-string installSegment is dropped, not passed through');
});
