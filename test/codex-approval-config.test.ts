import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { APPROVAL_MCP_SERVER, APPROVAL_TOOLS } from '../plugins/huaweicloud-core/src/approval-roster.ts';
import {
  CODEX_APPROVAL_MODE,
  codexApprovalToolsBlock,
  codexApprovalPolicyNever,
  codexCacheMcpJsonPaths,
  codexDoctorApprovalRow,
  codexElicitPolicyOff,
  codexOverridesUnparseableDialect,
  codexPluginCacheDir,
  readCodexApprovalBlocks,
  readMcpJsonApprovalStates,
} from '../plugins/huaweicloud-core/src/agents/codex-config.ts';
import type { DoctorReporter } from '../plugins/huaweicloud-core/src/doctor-report.ts';
import { fixtureDir } from './fixture-dir.ts';
import { fakeCodexEnv, run } from './agent-install-harness.ts';
import { runDoctor } from './doctor-helpers.ts';

// The codex client yield (PR-5): per-tool approval_mode = "approve" blocks
// inside the devkit-owned payload .mcp.json — the file codex reads per-tool
// approval from for a plugin-provided server (source-verified
// resolve_user_configured_approval_mode, the plugin fallback branch; the
// config.toml route bricks codex's config load with "invalid transport"
// when the implied server has no command/url — live-measured on
// codex-cli 0.167.2). The user's config.toml is never written: a per-tool
// value there WINS over the payload (config layer first), so the doctor
// reads it as the override channel. The measured dialect and the WARN
// ceiling (no client value fails anything open; a wrong value degrades UX
// or fails closed) come from the codex-cli 0.167.2 probe
// (/tmp/opencode/probe-non-elicit-dlg/FINDINGS.md).

const TOOL = APPROVAL_TOOLS[0]!;
const CONFIG_PATH = join('plugins', 'huaweicloud-core', '.mcp.json');

// ── The payload block, the reader, and the source-file guard ──

test('the tools block is roster-driven: one approve entry per roster tool', () => {
  const block = codexApprovalToolsBlock();
  assert.deepEqual(Object.keys(block), [...APPROVAL_TOOLS], 'the roster drives the block, in roster order');
  assert.equal(APPROVAL_TOOLS.length, 16, 'the codex yield covers the full PR-3c roster');
  for (const tool of APPROVAL_TOOLS) {
    assert.deepEqual(block[tool], { approval_mode: CODEX_APPROVAL_MODE });
  }
});

test('the committed repo .mcp.json carries exactly the roster tools block', () => {
  // The codex CLI marketplace flow copies this file into codex's cache, so
  // it is the CLI install's source of truth for the yield. The guard keeps
  // a roster change from silently outgrowing it.
  const cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as Record<string, unknown>;
  const entry = (cfg.mcpServers as Record<string, Record<string, unknown>>)[APPROVAL_MCP_SERVER]!;
  assert.deepEqual(entry.tools, codexApprovalToolsBlock(), 'the committed tools map mirrors the roster block');
  assert.deepEqual(
    readMcpJsonApprovalStates(cfg),
    APPROVAL_TOOLS.map(() => 'approve'),
  );
});

test('readMcpJsonApprovalStates classifies the measured values, foreign spellings, and absence', () => {
  const statesOf = (tools: Record<string, unknown>): string[] => {
    const cfg = { mcpServers: { [APPROVAL_MCP_SERVER]: { tools } } };
    return readMcpJsonApprovalStates(cfg);
  };
  const block: Record<string, unknown> = { ...codexApprovalToolsBlock() };
  block['huaweicloud_sandbox_connect'] = { approval_mode: 'prompt' };
  block['huaweicloud_upgrade'] = { approval_mode: 'auto' };
  block['huaweicloud_secret_delete'] = { approval_mode: 'writes' };
  block['huaweicloud_packs_configure'] = { output_token_limit: 4096 };
  delete block['huaweicloud_obs_set_cors'];
  const states = statesOf(block);
  const at = (tool: (typeof APPROVAL_TOOLS)[number]): string => states[APPROVAL_TOOLS.indexOf(tool)]!;
  assert.equal(at(TOOL), 'approve');
  assert.equal(at('huaweicloud_sandbox_connect'), 'prompt');
  assert.equal(at('huaweicloud_upgrade'), 'auto');
  assert.equal(at('huaweicloud_secret_delete'), 'foreign', 'writes is unmeasured, never the yield');
  assert.equal(at('huaweicloud_packs_configure'), 'absent', 'an entry with no approval_mode key reads absent');
  assert.equal(at('huaweicloud_obs_set_cors'), 'absent');
  // A foreign server map never leaks in; a config without our server reads all-absent.
  assert.equal(
    readMcpJsonApprovalStates({
      mcpServers: { 'other-server': { tools: { [TOOL]: { approval_mode: 'prompt' } } } },
    })[0],
    'absent',
  );
  assert.equal(readMcpJsonApprovalStates({})[0], 'absent');
});

// ── The config.toml override reader and the policy detectors ──

test('readCodexApprovalBlocks reads the user override channel, pinned to our server name', () => {
  const text = [
    `[mcp_servers.${APPROVAL_MCP_SERVER}.tools.${TOOL}]`,
    'approval_mode = "prompt" # double confirm',
    `[mcp_servers.${APPROVAL_MCP_SERVER}.tools.huaweicloud_upgrade]`,
    'approval_mode = "auto"',
    `[mcp_servers.other-server.tools.huaweicloud_secret_delete]`,
    'approval_mode = "prompt"',
    `[mcp_servers.${APPROVAL_MCP_SERVER}.tools.huaweicloud_search_docs]`,
    'approval_mode = "approve"',
  ].join('\n');
  const states = readCodexApprovalBlocks(text);
  const at = (tool: (typeof APPROVAL_TOOLS)[number]): string => states[APPROVAL_TOOLS.indexOf(tool)]!;
  assert.equal(at(TOOL), 'prompt', 'a commented approval_mode line still reads');
  assert.equal(at('huaweicloud_upgrade'), 'auto');
  assert.equal(at('huaweicloud_secret_delete'), 'absent', 'a foreign server never wins the tool name');
  assert.equal(at('huaweicloud_obs_set_cors'), 'absent');
  // A non-roster tool under our server is user territory, never read.
  assert.equal(states.length, APPROVAL_TOOLS.length);
});

test('the elicit-policy detector matches both accepted spellings of the false granular key', () => {
  assert.equal(codexElicitPolicyOff('[approval_policy.granular]\nmcp_elicitations = false\n'), true);
  // The inline-table spelling is the machine the line-anchored detector
  // missed (root-reproduced): doctor PASS with zero WARN while every
  // roster call fails closed.
  assert.equal(
    codexElicitPolicyOff(
      'approval_policy = { granular = { mcp_elicitations = false, sandbox_approval = false, rules = false } }\n',
    ),
    true,
  );
  assert.equal(codexElicitPolicyOff('mcp_elicitations = true\n'), false);
  assert.equal(codexElicitPolicyOff('approval_policy = { granular = { mcp_elicitations = true } }\n'), false);
  assert.equal(codexElicitPolicyOff('model = "gpt"\n'), false);
  assert.equal(codexElicitPolicyOff('allow_mcp_elicitations = false\n'), false, 'lookalike keys never trip it');
});

test('the override-dialect detector flags the dotted-key and inline-table spellings codex honors', () => {
  const dotted = `mcp_servers.${APPROVAL_MCP_SERVER}.tools.huaweicloud_upgrade.approval_mode = "prompt"\n`;
  const inline = `[mcp_servers.${APPROVAL_MCP_SERVER}]\ntools = { huaweicloud_upgrade = { approval_mode = "prompt" } }\n`;
  assert.equal(codexOverridesUnparseableDialect(dotted), true, 'dotted keys win over the payload (live-verified)');
  assert.equal(codexOverridesUnparseableDialect(inline), true, 'inline tables win over the payload');
  assert.equal(codexOverridesUnparseableDialect('model = "gpt"\n'), false);
  assert.equal(
    codexOverridesUnparseableDialect(
      `[mcp_servers.${APPROVAL_MCP_SERVER}.tools.huaweicloud_upgrade]\napproval_mode = "prompt"\n`,
    ),
    false,
    'the header form is parsed by readCodexApprovalBlocks, never flagged',
  );
  assert.equal(
    codexOverridesUnparseableDialect('mcp_servers.other-server.tools.x.approval_mode = "prompt"\n'),
    false,
    'a foreign server is user territory',
  );
  assert.equal(
    codexOverridesUnparseableDialect('[mcp_servers.other-server]\ntools = { x = { approval_mode = "prompt" } }\n'),
    false,
  );
});

test('the never detector reads top-level keys only, before the first table header', () => {
  assert.equal(codexApprovalPolicyNever('approval_policy = "never"\n\n[projects."/tmp"]\n'), true);
  assert.equal(codexApprovalPolicyNever('approval_policy = "never" # strict\n'), true);
  assert.equal(codexApprovalPolicyNever('approval_policy = "on-request"\n'), false);
  assert.equal(
    codexApprovalPolicyNever('[projects."/tmp"]\napproval_policy = "never"\n'),
    false,
    'project-scoped never is not the machine posture',
  );
});

// ── The doctor row (unit: a captured reporter, a pinned CODEX_HOME) ──

function rowReporter(): { lines: string[]; ctx: DoctorReporter } {
  const lines: string[] = [];
  return {
    lines,
    ctx: {
      check: (label, ok, msg) => lines.push(`${ok ? 'PASS' : 'FAIL'} ${label}${msg ? ` — ${msg}` : ''}`),
      pass: (line) => lines.push(`PASS ${line}`),
      warn: (line) => lines.push(`WARN ${line}`),
      info: (line) => lines.push(`INFO ${line}`),
      skip: (line) => lines.push(`SKIP ${line}`),
      raw: (line) => lines.push(line),
      countWarn: () => {},
    },
  };
}

function withCodexHome(home: string, fn: () => void): void {
  const prev = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prev;
  }
}

// Seeds a cache-version .mcp.json carrying the payload yield, the way a
// real `codex plugin add` copies the repo payload into its cache.
function seedCachePayload(home: string, tools: Record<string, unknown> = codexApprovalToolsBlock()): string {
  const versionDir = join(codexPluginCacheDir(), '2.0.0-next.3');
  mkdirSync(versionDir, { recursive: true });
  const path = join(versionDir, '.mcp.json');
  writeFileSync(path, JSON.stringify({ mcpServers: { [APPROVAL_MCP_SERVER]: { command: 'node', tools } } }), 'utf8');
  return versionDir;
}

function rowOver(
  seed: (home: string) => void,
  opts: { desktopRegistered?: boolean; configToml?: string | null } = {},
): string[] {
  const home = fixtureDir('codex-row-home-');
  // A non-null configToml pins the user override channel: a string is
  // written as config.toml (the '' spelling is for tests that seed the
  // unreadable shape themselves), null leaves it absent.
  if (typeof opts.configToml === 'string' && opts.configToml !== '') {
    writeFileSync(join(home, 'config.toml'), opts.configToml, 'utf8');
  }
  const capture = rowReporter();
  const prevPath = process.env.PATH;
  if (opts.configToml !== undefined) process.env.PATH = '';
  try {
    withCodexHome(home, () => {
      seed(home);
      codexDoctorApprovalRow(capture.ctx, opts.desktopRegistered ?? false);
    });
  } finally {
    process.env.PATH = prevPath;
  }
  return capture.lines;
}

test('doctor row passes on the healthy payload and names the block count', () => {
  const lines = rowOver((home) => seedCachePayload(home));
  assert.deepEqual(lines, [
    `PASS Codex approval posture (${APPROVAL_TOOLS.length} per-tool approve blocks in the devkit payload)`,
  ]);
});

test('doctor row verifies every cached copy, not just the newest', () => {
  const lines = rowOver((home) => {
    seedCachePayload(home);
    // A second, stale version dir missing the yield — which copy codex
    // loads is codex's call, so every copy must carry it.
    const stale = join(codexPluginCacheDir(), '1.0.0');
    mkdirSync(stale, { recursive: true });
    writeFileSync(
      join(stale, '.mcp.json'),
      JSON.stringify({ mcpServers: { [APPROVAL_MCP_SERVER]: { command: 'node' } } }),
      'utf8',
    );
  });
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /WARN/);
  assert.match(lines[0]!, /1\.0\.0/);
  assert.match(lines[0]!, /the approve block is missing for /);
});

test('doctor row warns on a wrong payload value with the direction and the re-run', () => {
  const block = codexApprovalToolsBlock();
  block['huaweicloud_upgrade'] = { approval_mode: 'prompt' };
  const lines = rowOver((home) => seedCachePayload(home, block));
  assert.match(lines[0]!, /WARN/);
  assert.match(lines[0]!, /approval_mode "prompt" on huaweicloud_upgrade/);
  assert.match(lines[0]!, /re-run: npx huaweicloud-devkit install --target codex/);
});

test('doctor row warns on a user config.toml override, which wins over the payload', () => {
  const config = [
    `[mcp_servers.${APPROVAL_MCP_SERVER}.tools.huaweicloud_sandbox_connect]`,
    'approval_mode = "auto"',
  ].join('\n');
  const lines = rowOver((home) => seedCachePayload(home), { configToml: config });
  assert.match(lines[0]!, /the user's config\.toml sets approval_mode "auto" on huaweicloud_sandbox_connect/);
  assert.match(lines[0]!, /wins over the payload/);
  assert.ok(
    lines.every((line) => !line.startsWith('FAIL')),
    'WARN is the ceiling — no FAIL direction exists',
  );
});

test('doctor row names the policy flip on the elicit-off machine even with a healthy payload', () => {
  // Both accepted spellings: the [approval_policy.granular] table and the
  // inline table the line-anchored detector missed (root-reproduced).
  const configs = [
    '[approval_policy.granular]\nmcp_elicitations = false\n',
    'approval_policy = { granular = { mcp_elicitations = false, sandbox_approval = false, rules = false } }\n',
  ];
  for (const config of configs) {
    const lines = rowOver((home) => seedCachePayload(home), { configToml: config });
    assert.equal(lines.length, 1, config);
    assert.match(lines[0]!, /mcp_elicitations = false/);
    assert.match(lines[0]!, /fails closed at the devkit gate until the policy is on/);
    assert.match(lines[0]!, /set mcp_elicitations = true/);
  }
});

test('doctor row warns on override spellings it cannot parse, never reading them as absence', () => {
  const dotted = `mcp_servers.${APPROVAL_MCP_SERVER}.tools.huaweicloud_upgrade.approval_mode = "prompt"\n`;
  const inline = `[mcp_servers.${APPROVAL_MCP_SERVER}]\ntools = { huaweicloud_upgrade = { approval_mode = "prompt" } }\n`;
  for (const [label, config] of [
    ['dotted key', dotted],
    ['inline table', inline],
  ] as const) {
    const lines = rowOver((home) => seedCachePayload(home), { configToml: config });
    assert.equal(lines.length, 1, label);
    assert.match(lines[0]!, /dialect this doctor cannot parse/);
    assert.match(lines[0]!, /winning values cannot be verified/);
    assert.ok(!lines[0]!.includes('[FAIL'), 'WARN is the ceiling');
  }
});

test('doctor row names the never direction', () => {
  const lines = rowOver((home) => seedCachePayload(home), { configToml: 'approval_policy = "never"\n' });
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /blocks MCP tool calls outright/);
});

test('doctor row warns on an unreadable config.toml when a payload exists, and stays quiet when absent', () => {
  // A directory named config.toml: readFileSync throws EISDIR on every
  // platform, no chmod-000 portability gap (the PR-2.5 lesson).
  const lines = rowOver(
    (home) => {
      seedCachePayload(home);
      mkdirSync(join(home, 'config.toml'), { recursive: true });
    },
    { configToml: '' },
  );
  assert.match(lines[0]!, /unreadable, so user per-tool overrides and the approval policy cannot be verified/);
  // An absent config.toml is the healthy no-overrides default, never a WARN.
  const absent = rowOver((home) => seedCachePayload(home), { configToml: null });
  assert.match(absent[0]!, /^PASS/);
});

test('doctor row is silent without a codex relationship', () => {
  assert.deepEqual(
    rowOver(() => {}),
    [],
  );
  // A config.toml with no devkit footprint and no payload/plugin/registration.
  assert.deepEqual(
    rowOver((home) => mkdirSync(join(home, 'config.toml'), { recursive: true }), { configToml: null }),
    [],
  );
});

test('a relevant machine with no payload file WARNs, never passes vacuously', () => {
  const lines = rowOver(() => {}, { desktopRegistered: true });
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /WARN/);
  assert.match(lines[0]!, /no devkit payload \.mcp\.json was found/);
  assert.match(lines[0]!, /yield cannot be verified/);
});

test('cache candidates resolve from CODEX_HOME and stop at files named .mcp.json', () => {
  const home = fixtureDir('codex-cache-home-');
  withCodexHome(home, () => {
    seedCachePayload(home);
    const paths = codexCacheMcpJsonPaths();
    assert.equal(paths.length, 1, 'one version dir, one candidate');
    assert.match(paths[0]!, /plugins\/cache\/huaweicloud-devkit\/huaweicloud-devkit\/2\.0\.0-next\.3\/\.mcp\.json$/);
  });
});

// ── The deploy writer and the real doctor ──

test('codex-desktop install writes the tools block into its payload .mcp.json', () => {
  const home = fixtureDir('codex-approval-desktop-');
  const cwd = fixtureDir('codex-approval-cwd-');
  assert.equal(run('codex-desktop', home, cwd, 'install').status, 0);
  const path = join(home, 'plugins', 'huaweicloud-devkit', '.mcp.json');
  assert.ok(existsSync(path), 'the desktop deploy writes .mcp.json');
  const states = readMcpJsonApprovalStates(JSON.parse(readFileSync(path, 'utf8')));
  assert.ok(
    states.every((state) => state === 'approve'),
    'the desktop payload carries the full yield',
  );
  // An update over a hand-stripped tools map heals it (the drift counts as
  // a change, same as the packs write).
  const cfg = JSON.parse(readFileSync(path, 'utf8'));
  delete (cfg.mcpServers[APPROVAL_MCP_SERVER] as Record<string, unknown>).tools;
  writeFileSync(path, JSON.stringify(cfg, null, 2), 'utf8');
  assert.equal(run('codex-desktop', home, cwd, 'update').status, 0);
  const healed = readMcpJsonApprovalStates(JSON.parse(readFileSync(path, 'utf8')));
  assert.ok(
    healed.every((state) => state === 'approve'),
    'update restores the stripped tools map',
  );
});

test('the openclaw deploy shares the writer but never gets the codex blocks', () => {
  const home = fixtureDir('codex-approval-openclaw-');
  const cwd = fixtureDir('codex-approval-cwd-');
  assert.equal(run('openclaw', home, cwd, 'install').status, 0);
  const path = join(home, '.agents', 'huaweicloud-plugins', '.mcp.json');
  const entry = (JSON.parse(readFileSync(path, 'utf8')).mcpServers as Record<string, Record<string, unknown>>)[
    APPROVAL_MCP_SERVER
  ]!;
  assert.equal(entry.tools, undefined, 'openclaw is not codex — its .mcp.json stays block-free');
});

test('codex install leaves the user config.toml byte-identical (the yield never lands there)', () => {
  const home = fixtureDir('codex-approval-install-');
  const cwd = fixtureDir('codex-approval-cwd-');
  const env = fakeCodexEnv(cwd);
  const configDir = join(home, '.codex');
  mkdirSync(configDir, { recursive: true });
  const before = '[projects."/tmp"]\ntrust_level = "trusted"\n';
  writeFileSync(join(configDir, 'config.toml'), before, 'utf8');
  const res = run('codex', home, cwd, 'install', env);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(readFileSync(join(configDir, 'config.toml'), 'utf8'), before, 'config.toml untouched by install');
  const u = run('codex', home, cwd, 'uninstall', env);
  assert.equal(u.status, 0, u.stderr);
  assert.equal(readFileSync(join(configDir, 'config.toml'), 'utf8'), before, 'config.toml untouched by uninstall');
  // The marketplace-source payload is the committed repo file — asserted by
  // the source-file guard above; the CLI flow's cache copy is the live lane's
  // assertion (the fake-codex test flow never materializes a cache).
});

test('the real doctor passes the healthy payload and warns on every direction, never fails', () => {
  const home = fixtureDir('codex-approval-doctor-');
  const cwd = fixtureDir('codex-approval-cwd-');
  const env = fakeCodexEnv(cwd);
  assert.equal(run('codex-desktop', home, cwd, 'install').status, 0);
  const configDir = join(home, '.codex');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, 'config.toml'), '# user codex config\n', 'utf8');
  const out = runDoctor(home, env);
  assert.match(out, /\[PASS\] Codex approval posture \(16 per-tool approve blocks in the devkit payload\)/);

  // A user override in config.toml: the doctor WARNs the winning value.
  const override = [`[mcp_servers.${APPROVAL_MCP_SERVER}.tools.huaweicloud_upgrade]`, 'approval_mode = "prompt"'].join(
    '\n',
  );
  writeFileSync(join(configDir, 'config.toml'), `${override}\n`, 'utf8');
  const warned = runDoctor(home, env);
  assert.match(warned, /\[WARN\] Codex approval posture: /);
  assert.match(warned, /double interaction/);
  assert.ok(!/\[FAIL\] Codex approval posture/.test(warned), 'no FAIL direction exists');

  // A hand-stripped payload is drift with the re-run remediation.
  const payloadPath = join(home, 'plugins', 'huaweicloud-devkit', '.mcp.json');
  const cfg = JSON.parse(readFileSync(payloadPath, 'utf8'));
  const tools = cfg.mcpServers[APPROVAL_MCP_SERVER]!.tools as Record<string, unknown>;
  delete tools['huaweicloud_secret_delete'];
  writeFileSync(payloadPath, JSON.stringify(cfg, null, 2), 'utf8');
  writeFileSync(join(configDir, 'config.toml'), '# user codex config\n', 'utf8');
  const drift = runDoctor(home, env);
  assert.match(drift, /\[WARN\] Codex approval posture: .*the approve block is missing for huaweicloud_secret_delete/);
});

test('the real doctor stays silent on a codex config with no devkit footprint', () => {
  const home = fixtureDir('codex-approval-silent-');
  mkdirSync(join(home, '.codex'), { recursive: true });
  writeFileSync(join(home, '.codex', 'config.toml'), 'model = "gpt-5"\n', 'utf8');
  // PATH stripped: a real codex on the lane host answering `plugin list`
  // from its own home would make the probe relevant on a machine the
  // devkit has no codex relationship with.
  const out = runDoctor(home, { PATH: '' });
  assert.ok(!out.includes('Codex approval posture'), 'no codex relationship means no row');
});

// The three doctor-shape drives, through the real CLI (a real codex-desktop
// install seeds the payload; the config.toml carries the policy spelling):
// inline-table → WARN, header → WARN, clean → PASS. The inline spelling is
// the one the line-anchored detector missed (root-reproduced).
test('the real doctor: inline-table policy WARNs, header policy WARNs, clean passes', () => {
  const home = fixtureDir('codex-approval-policy-');
  const cwd = fixtureDir('codex-approval-cwd-');
  const env = fakeCodexEnv(cwd);
  assert.equal(run('codex-desktop', home, cwd, 'install').status, 0);
  const configToml = join(home, '.codex', 'config.toml');
  mkdirSync(join(home, '.codex'), { recursive: true });

  writeFileSync(
    configToml,
    'approval_policy = { granular = { mcp_elicitations = false, sandbox_approval = false, rules = false } }\n',
    'utf8',
  );
  const inlineOut = runDoctor(home, env);
  assert.match(inlineOut, /\[WARN\] Codex approval posture: /);
  assert.match(inlineOut, /mcp_elicitations = false/);
  assert.match(inlineOut, /fails closed at the devkit gate until the policy is on/);
  assert.match(inlineOut, /set mcp_elicitations = true/);

  writeFileSync(configToml, '[approval_policy.granular]\nmcp_elicitations = false\n', 'utf8');
  const headerOut = runDoctor(home, env);
  assert.match(headerOut, /\[WARN\] Codex approval posture: /);
  assert.match(headerOut, /set mcp_elicitations = true/);

  writeFileSync(configToml, '# user codex config\n', 'utf8');
  const cleanOut = runDoctor(home, env);
  assert.match(cleanOut, /\[PASS\] Codex approval posture \(16 per-tool approve blocks in the devkit payload\)/);
  assert.ok(!/\[WARN\] Codex approval posture/.test(cleanOut));
});
