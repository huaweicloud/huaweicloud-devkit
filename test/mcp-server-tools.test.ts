import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import test from 'node:test';

import { createClient, root } from './mcp-server-client.ts';

test('MCP server initializes, lists tools, and plans CLI commands', async () => {
  const client = createClient();
  try {
    const initialized = await client.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '0.0.0' },
    });
    assert.equal(initialized.result.serverInfo.name, 'huaweicloud-devkit');
    // The stdio instruction form states the tree's location outright (no
    // catalog detour), keeps the enablement caveat ahead of the read
    // invitation (a path never implies "on disk == usable"), and names the
    // session-toggle tool this face actually registers. The path is
    // runtime-resolved, so pin it against the generated tree this file
    // already requires — same "must locate the catalogued tree" pin
    // pack-meta-tools holds for the list_skills payload.
    const instructions = initialized.result.instructions ?? '';
    assert.match(instructions, /the skills tree lives at /, 'stdio instructions must state the tree location');
    const marker = 'the skills tree lives at ';
    const suffix = ' (stdio session)';
    const at = instructions.indexOf(marker);
    const end = instructions.indexOf(suffix, at + marker.length);
    const stated = at >= 0 && end > at + marker.length ? instructions.slice(at + marker.length, end) : undefined;
    assert.ok(stated && isAbsolute(stated), 'the stated tree location must be an absolute path');
    assert.ok(
      existsSync(join(stated!, 'huawei-vpc', 'SKILL.md')),
      'the stated tree location must locate the catalogued tree',
    );
    assert.match(instructions, /pack-gated/, 'stdio instructions must carry the enablement caveat');
    assert.match(instructions, /huaweicloud_packs_configure/, 'stdio instructions must name the session-toggle tool');
    assert.match(
      instructions,
      /To load a skill, attempt the direct read first/,
      'stdio instructions must lead the load procedure with the attempt-first imperative',
    );
    assert.doesNotMatch(
      instructions,
      /When your file tools reach the tree/,
      'stdio instructions must not carry the evaluative reachability conditional',
    );
    assert.match(
      instructions,
      /If a direct read of the tree fails or is denied, load the skill with huaweicloud_retrieve_skill instead/,
      'stdio instructions must teach the reactive fallback sentence',
    );

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
    assert.ok(Object.hasOwn(runReadonly!.inputSchema.properties, 'timeoutMs'));

    const planned = await client.request('tools/call', {
      name: 'huaweicloud_plan_cli_command',
      arguments: { vendorConfirmed: 'test: vendor established by the harness', args: ['ECS', 'NovaListServers'] },
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
    cpSync(join(root, 'plugins', 'huaweicloud-core', 'dist'), join(pluginRoot, 'dist'), { recursive: true });
    cpSync(join(root, 'plugins', 'huaweicloud-core', 'safety'), join(pluginRoot, 'safety'), { recursive: true });
    // The server fail-fasts on a missing skills tree (verifySkillTree), so
    // a bootable fixture models the full payload a real install ships.
    cpSync(join(root, 'plugins', 'huaweicloud-core', 'skills'), join(pluginRoot, 'skills'), { recursive: true });
    writeFileSync(
      join(pluginRoot, 'package.json'),
      JSON.stringify({ name: 'huaweicloud-plugins', version: '9.9.9-test' }),
    );
    const client = createClient(join(pluginRoot, 'dist', 'mcp-server.js'));
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

// The codex marketplace cache layout the codex-side tests boot from:
// <dir>/<marketplace>/<plugin>/<version>/ carrying the full payload a real
// install ships. Codex marketplace installs are plain file copies with no
// package.json anywhere in the version-resolution candidate paths (issue
// #576) — the version must come from the plugin manifest, so the fixture
// writes it there. The server fail-fasts on a missing skills tree
// (verifySkillTree), so a bootable fixture models the full payload.
function makeCodexCacheLayout(dir: string, version: string): { marketplace: string; versionDir: string } {
  const marketplace = join(dir, 'huaweicloud-devkit', 'huaweicloud-devkit');
  const versionDir = join(marketplace, version);
  mkdirSync(versionDir, { recursive: true });
  cpSync(join(root, 'plugins', 'huaweicloud-core', 'dist'), join(versionDir, 'dist'), { recursive: true });
  cpSync(join(root, 'plugins', 'huaweicloud-core', 'safety'), join(versionDir, 'safety'), { recursive: true });
  cpSync(join(root, 'plugins', 'huaweicloud-core', 'skills'), join(versionDir, 'skills'), { recursive: true });
  mkdirSync(join(versionDir, '.codex-plugin'), { recursive: true });
  writeFileSync(
    join(versionDir, '.codex-plugin', 'plugin.json'),
    JSON.stringify({ name: 'huaweicloud-devkit', version }),
  );
  return { marketplace, versionDir };
}

test('MCP server reports version from plugin manifest in Codex cache layout (#576)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hwc-codex-'));
  try {
    const { versionDir: codexRoot } = makeCodexCacheLayout(dir, '1.1.5-codex');
    const client = createClient(join(codexRoot, 'dist', 'mcp-server.js'));
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

test('telemetry ON in Codex cache layout: stamps land inside the version dir, never the parent (bundle wiring)', async () => {
  // The wiring pin for the telemetry-sibling incident: the bug was never in
  // resolvePluginDir's join logic (telemetry-plugin-dir.test.ts pins that
  // pure function) — it was WHICH startDir the esbuild bundle implicitly
  // passes (import.meta.url flattened to dist/mcp-server.js, __dirname =
  // dist/). Only booting the real built bundle in the codex-cache layout
  // executes that wiring. The #576 test above boots the same layout but
  // pins telemetry off — which is exactly why the sibling writes stayed
  // invisible to the suite while the bug shipped. Here telemetry is ON
  // (the stamp-writing path), the endpoint stays pinned to the closed port
  // (hermetic), and the global telemetry root is redirected into the
  // fixture so nothing touches the real home.
  const dir = mkdtempSync(join(tmpdir(), 'hwc-codex-tel-'));
  try {
    const { marketplace, versionDir: codexRoot } = makeCodexCacheLayout(dir, '2.0.0-test');
    const client = createClient(join(codexRoot, 'dist', 'mcp-server.js'), {
      HUAWEICLOUD_DEVKIT_TELEMETRY: undefined,
      HUAWEICLOUD_DEVKIT_TELEMETRY_ENDPOINT: 'http://127.0.0.1:1/',
      HUAWEICLOUD_DEVKIT_HOME: join(dir, 'devkit-home'),
    });
    try {
      const initialized = await client.request('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'codex', version: '0.162.1' },
      });
      assert.equal(initialized.result.serverInfo.version, '2.0.0-test');
    } finally {
      client.close();
    }
    // The incident assertion pair: the telemetry dir (initTelemetry ->
    // trackInstall writes install-counter) must exist INSIDE the version
    // dir, and the version PARENT — the directory codex scans for version
    // dirs — must carry no 'telemetry' sibling. A depth regression in the
    // bundle flips exactly this pair.
    assert.ok(existsSync(join(codexRoot, 'telemetry')), 'telemetry dir must land inside the version dir');
    assert.ok(
      existsSync(join(codexRoot, 'telemetry', 'install-counter')),
      'initTelemetry must have written its install counter inside the version dir',
    );
    assert.ok(
      !existsSync(join(marketplace, 'telemetry')),
      'no telemetry sibling in the version parent — codex resolves that stray as the plugin version and stops loading the plugin',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('tools/call accepts string numerics and passes unknown keys through (#530 leniency)', async () => {
  const client = createClient();
  try {
    await client.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '0.0.0' },
    });
    // timeoutMs as a string must reach normalizeNumericArgs, which owns the
    // accept/reject decision — the zod boundary declares the leniency. A bad
    // string is still rejected by the tool itself with its #530 message.
    const ok = await client.request('tools/call', {
      name: 'huaweicloud_list_operations',
      arguments: {
        vendorConfirmed: 'test: vendor established by the harness',
        service: 'ECS',
        timeoutMs: '9999',
        unknownExtra: 'kept',
      },
    });
    assert.equal(ok.result.isError, false, 'the acceptance arm must observe a successful dispatch');
    assert.ok(ok.result, `expected a result: ${JSON.stringify(ok).slice(0, 300)}`);

    const bad = await client.request('tools/call', {
      name: 'huaweicloud_list_operations',
      arguments: { service: 'ECS', timeoutMs: 'not-a-number' },
    });
    assert.ok(bad.result, 'bad numeric string must produce a tool result');
    assert.equal(bad.result.isError, true, 'normalizeNumericArgs still rejects garbage strings');
    assert.match(bad.result.content[0].text, /timeoutMs/);

    // Unknown keys survive the passthrough boundary and reach callTool: the
    // plan tool echoes the full command back.
    const planned = await client.request('tools/call', {
      name: 'huaweicloud_plan_cli_command',
      arguments: {
        vendorConfirmed: 'test: vendor established by the harness',
        args: ['ECS', 'NovaListServers'],
        unknownExtra: 'kept',
      },
    });
    assert.ok(planned.result, `expected a plan result: ${JSON.stringify(planned).slice(0, 300)}`);
    assert.equal(planned.result.isError, false);
    assert.match(planned.result.content[0].text, /NovaListServers/);
  } finally {
    client.close();
  }
});

test('tools/call accepts the model-wire double-encoded args and string booleans (CLI execution family)', async () => {
  const client = createClient();
  try {
    await client.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '0.0.0' },
    });
    // The 2026-11-03 e2e-nightly codex leg (PR-1, runs 41730851595/41739397204):
    // every huaweicloud_run_approved_command retry arrived with args as a
    // JSON-encoded STRING and approvedByUser as the string "true" (glm-3's
    // wire form, dump-measured) — the SDK-boundary zod rejected them before
    // dispatch and the model never self-corrected within the attempt budget.
    // stringArrayArg/booleanArg now convert both forms at the parse boundary;
    // tools/list keeps teaching the canonical shapes (the preprocess is
    // transparent in z.toJSONSchema). Plan arm: the coerced array plans.
    const planned = await client.request('tools/call', {
      name: 'huaweicloud_plan_cli_command',
      arguments: {
        vendorConfirmed: 'test: vendor established by the harness',
        args: '["VPC", "CreateSecurityGroup", "--name=e2e-test-sg-01"]',
        allowWrites: 'true',
      },
    });
    assert.ok(planned.result, `expected a plan result: ${JSON.stringify(planned).slice(0, 300)}`);
    assert.equal(planned.result.isError, false, 'the double-encoded args must plan (stringArrayArg coercion)');
    assert.match(planned.result.content[0].text, /CreateSecurityGroup/);

    // Approval arm: a never-minted token keeps the call hermetic (no hcloud
    // spawn) while proving BOTH coercions landed — approvedByUser "true" past
    // the handler's boolean check, the coerced args past the zod boundary.
    // Before the fix this shape died as a protocol-level zod reject.
    const approved = await client.request('tools/call', {
      name: 'huaweicloud_run_approved_command',
      arguments: {
        vendorConfirmed: 'test: vendor established by the harness',
        approvalToken: 'never-minted-test-token',
        args: '["VPC", "CreateSecurityGroup", "--name=e2e-test-sg-01"]',
        approvedByUser: 'true',
      },
    });
    assert.ok(approved.result, 'the wire-shaped approval call must answer as a tool result, not a protocol error');
    assert.match(
      approved.result.content[0].text,
      /CONFIRM_TOKEN_NOT_FOUND/,
      'the wire forms must reach the token inspection (past the type boundary)',
    );

    // Garbage arm: a string that does not parse to a string array is still
    // rejected — the inner z.array check owns the reject, never a silent
    // accept of arbitrary strings.
    const garbage = await client.request('tools/call', {
      name: 'huaweicloud_plan_cli_command',
      arguments: {
        vendorConfirmed: 'test: vendor established by the harness',
        args: 'not json at all',
      },
    });
    assert.ok(
      garbage.error || garbage.result?.isError === true,
      'a non-JSON args string must not dispatch successfully',
    );
  } finally {
    client.close();
  }
});

test('tools/call works with arguments omitted entirely', async () => {
  const client = createClient();
  try {
    await client.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '0.0.0' },
    });
    // A non-gated no-arg tool carries the omitted-arguments contract (the
    // zod layer must accept a missing arguments object); the gated sibling
    // below carries the vendor-gate contract on the same wire shape.
    const response = await client.request('tools/call', {
      name: 'huaweicloud_list_skills',
    });
    assert.ok(response.result, 'omitted arguments must not fail validation');
    assert.equal(response.result.isError, false);
    // The vendor gate on the same omitted-arguments shape: a proper tool
    // result (never a protocol error) carrying the teaching rejection.
    const gated = await client.request('tools/call', {
      name: 'huaweicloud_list_regions',
    });
    assert.ok(gated.result, 'the gate must answer as a tool result, not a protocol error');
    assert.equal(gated.result.isError, true);
    assert.match(gated.result.content[0].text, /Vendor gate: this tool operates on Huawei Cloud/);
  } finally {
    client.close();
  }
});
