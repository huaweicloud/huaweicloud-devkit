// Real code-agent lifecycle layer: drives the REAL opencode / codex CLIs (not
// fakes, not protocol simulation) through install -> agent-visible state ->
// uninstall, entirely inside sandboxed config dirs. Layer separation with the
// rest of the suite: agent-install.test.ts pins file-level contracts,
// plugins-e2e.test.ts pins protocol-level roundtrips, this file pins only the
// AGENT's own parsed view of the devkit (opencode `mcp list` / `debug config`
// / `debug skill`, codex `plugin list --json` / `marketplace list`).
//
// Runs only where a real agent binary is on PATH (skip-if-absent), never on
// win32, and never in CI unless DEVKIT_REAL_AGENT_TESTS=1. Network: the
// installer's undici install reaches the npm registry from a cold sandbox
// cache (same prerequisite as agent-install.test.ts); every background path
// the devkit can phone home on is switched off via the env below.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import type { SpawnSyncReturns } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, type Stats } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { getCodexPluginName, getMarketplaceName } from '../plugins/huaweicloud-core/src/codex-probe.ts';
import { parseCoreSkillNames } from '../plugins/huaweicloud-core/src/lib/skill-manifest.ts';
import { fixtureDir } from './fixture-dir.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const setupCli = join(root, 'bin', 'setup.cjs');

// The devkit-side identity, composed once from the canonical marketplace.json
// readers — never spelled as a literal here (the plugin name and the
// marketplace name are two independent canonical values).
const codexPluginId = `${getCodexPluginName()}@${getMarketplaceName()}`;

// The installer's timeout budget for the embedded undici npm install is
// 120s x up to 3 attempts plus retry sleeps (~368s worst case); the outer
// spawn timeout must exceed it or the test kills the install first and
// truncates the diagnostics.
const INSTALL_TIMEOUT_MS = 400_000;
// opencode spawns every enabled MCP server on EVERY startup (debug commands
// included) and waits for the handshake. A cold sandbox pays ~60s of CPU on
// the first such startup (agent + server bundle init), ~2-3s once warm —
// measured, not guessed. 300s leaves headroom for slower machines.
// Note: opencode passes the FULL parent env to MCP child processes
// (probe-verified on 1.19.0 — 40+ vars survive, no whitelist), so the kill
// switches in sandboxEnv DO reach the agent-spawned server and are the
// actual phone-home boundary for this test.
const AGENT_TIMEOUT_MS = 300_000;

// Env for a sandboxed agent run. HOME must point at the sandbox (the
// installer resolves most agent dirs from os.homedir()), and the XDG ladder
// (opencode resolves config from XDG_CONFIG_HOME; the installer's configRoot
// follows the same variable via xdgConfigHome) must point onto the SAME
// sandbox tree — pinning XDG_CONFIG_HOME to HOME/.config keeps installer and
// agent on one root and exercises the installer's XDG path for real.
// CODEX_HOME must stay directly under HOME because uninstallCodexDesktop()
// rewrites homedir()/.codex/config.toml.
function sandboxEnv(home: string, extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  mkdirSync(join(home, '.codex'), { recursive: true });
  const env: Record<string, string | undefined> = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local', 'share'),
    XDG_STATE_HOME: join(home, '.local', 'state'),
    XDG_CACHE_HOME: join(home, '.cache'),
    CODEX_HOME: join(home, '.codex'),
    NO_COLOR: '1',
    // Keep the repo checkout's own opencode.json out of the agent view.
    OPENCODE_DISABLE_PROJECT_CONFIG: '1',
    HUAWEICLOUD_DEVKIT_SKIP_OFFICEACE_DETECT: '1',
    // The installer's update check has no skip switch of its own; a closed
    // local port makes it fail fast instead of hanging on the registry.
    HUAWEICLOUD_NPM_REGISTRY: 'http://127.0.0.1:9',
    // The spawned MCP server's npm-view update warmup.
    HUAWEICLOUD_DEVKIT_SKIP_UPDATE: '1',
    // First-spawn telemetry would POST to the Huawei endpoint otherwise.
    HUAWEICLOUD_DEVKIT_TELEMETRY: 'off',
    // The server's initialize side effect (hdkitservice user-hash) would hit
    // the real endpoint — with ambient AK/SK exported it would be a
    // credentialed request. Same closed-port trick as the registry redirect.
    HDKITSERVICE_ENDPOINT: 'http://127.0.0.1:9',
  };
  // Ambient overrides on a devkit developer's machine would redirect the
  // spawned server / installer into real global state (or send real
  // credentials); proxies too, so the closed-port pins below fail fast
  // instead of detouring through a corporate proxy.
  for (const key of [
    'ATOMCODE_HOME',
    'DSH_HOME',
    'HERMES_HOME',
    'HUAWEICLOUD_HOME',
    'HUAWEICLOUD_DEVKIT_HOME',
    'OFFICE_CLAW_CONFIG_ROOT',
    'OPENCODE_CONFIG_DIR',
    'OPENCODE_CONFIG',
    'OPENCODE_TEST_HOME',
    'HW_ACCESS_KEY',
    'HW_SECRET_KEY',
    'HW_SECURITY_TOKEN',
    'http_proxy',
    'https_proxy',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'all_proxy',
    'ALL_PROXY',
  ]) {
    delete env[key];
  }
  return { ...env, ...extra };
}

type ProbeState = 'ok' | 'absent' | 'broken';

// A `--version` probe run inside a throwaway HOME (opencode --version writes
// its directory tree into whatever HOME it sees). Polarity follows
// codex-probe.ts discipline: ENOENT is the one definitive absence; anything
// else that fails is "broken" and must fail the test with stderr, not skip.
function probeAgentBinary(cmd: string): { state: ProbeState; stderr: string } {
  const probeHome = fixtureDir(`hwc-real-probe-${cmd}-`);
  const r = spawnSync(cmd, ['--version'], {
    env: sandboxEnv(probeHome),
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (r.error) {
    const code = (r.error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { state: 'absent', stderr: '' };
    return { state: 'broken', stderr: r.error.message };
  }
  if (r.status === 0) return { state: 'ok', stderr: r.stderr ?? '' };
  return { state: 'broken', stderr: r.stderr ?? String(r.status) };
}

const platformSkip = process.platform === 'win32' ? 'win32 is out of scope for the real-agent layer' : '';
const ciSkip =
  process.env.CI && process.env.DEVKIT_REAL_AGENT_TESTS !== '1'
    ? 'CI runner: set DEVKIT_REAL_AGENT_TESTS=1 to enable real-agent lifecycle tests'
    : '';
const probeEnabled = !platformSkip && !ciSkip;
const opencodeProbe = probeEnabled ? probeAgentBinary('opencode') : undefined;
const codexProbe = probeEnabled ? probeAgentBinary('codex') : undefined;

function agentSkip(probe: { state: ProbeState; stderr: string } | undefined, cmd: string): string | false {
  if (platformSkip) return platformSkip;
  if (ciSkip) return ciSkip;
  // DEVKIT_REAL_AGENT_TESTS=1 is the operator's explicit demand for this
  // layer: a missing binary must turn the run red (the in-test assert), not
  // silently skip the whole lane green.
  if (probe?.state === 'absent' && process.env.DEVKIT_REAL_AGENT_TESTS !== '1') return `${cmd} is not on PATH`;
  return false;
}

function runSetup(args: string[], env: NodeJS.ProcessEnv, cwd: string, timeout = 120_000) {
  return spawnSync(process.execPath, [setupCli, ...args], { cwd, env, encoding: 'utf8', timeout });
}

function runAgent(cmd: string, args: string[], env: NodeJS.ProcessEnv, cwd: string, timeout = AGENT_TIMEOUT_MS) {
  return spawnSync(cmd, args, { cwd, env, encoding: 'utf8', timeout });
}

function assertSpawnOk(r: SpawnSyncReturns<string>, label: string) {
  assert.ok(r.error === undefined, `${label} failed to spawn: ${r.error?.message ?? ''}`);
  assert.notEqual(r.status, null, `${label} timed out or was killed`);
}

function obj(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

// Agent stdout must be parseable JSON; if it is not, the agent's output
// contract changed and that fact deserves a red test with the payload.
function parseJsonOut(label: string, out: string): unknown {
  try {
    return JSON.parse(out);
  } catch {
    return assert.fail(
      `${label} stdout is not parseable JSON (agent output contract changed?):\n${out.slice(0, 2000)}`,
    );
  }
}

// The real-HOME canary: the most dangerous failure mode of this layer is a
// sandbox leak writing into the developer's real agent configs. Snapshot
// before, assert byte-equality after — the check runs inside the test, so
// the worst failure mode is a red test, not a manual post-run inspection.
// Ambient XDG_CONFIG_HOME (when absolute) redirects the installer's opencode
// root, so its real location is watched too. Besides the config files, the
// highest-volume write surfaces are watched as recursive listings (payload
// dir, native skills, openclaw payload, codex plugin cache) — a config-file
// canary alone is blind to a payload-dir leak.
function dirSnapshot(dir: string): string | null {
  if (!existsSync(dir)) return null;
  const entries: string[] = [];
  const walk = (d: string, prefix: string) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      // Runtime-mutable state is not installer-authored payload: the
      // developer's own live session appends to telemetry/ (skill-tracker
      // hook) and any concurrent server spawn clears .installed — watching
      // them makes the canary fire on normal session activity, not leaks.
      if (entry.name === 'telemetry' || entry.name === '.installed') continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      // statSync (not lstat semantics): a symlinked subdir must be followed
      // and recursed, or a leak routed through it is invisible. An entry
      // vanishing between readdir and stat (concurrent host activity on
      // the real HOME) must not crash the canary itself — record a
      // tombstone instead; anything other than ENOENT stays fatal. The
      // guarantee covers the stat path only: a vanishing DIRECTORY or a
      // symlink cycle still throws (ELOOP / ENOENT from readdir) —
      // fail-loud, and pathological for these devkit-owned trees. The
      // name-based skip also blinds the canary to dist/telemetry/ payload
      // module code — accepted: no realistic leak writes only that, a
      // payload leak always includes visible dist/safety/skills files.
      let st: Stats;
      try {
        st = statSync(join(d, entry.name));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          entries.push(`${rel}:<vanished>`);
          continue;
        }
        throw error;
      }
      if (st.isDirectory()) walk(join(d, entry.name), rel);
      else entries.push(`${rel}:${st.size}`);
    }
  };
  walk(dir, '');
  return entries.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).join('\n');
}

function realHomeSnapshot(): Array<[string, 'file' | 'dir', string | null]> {
  const home = process.env.HOME;
  assert.ok(home, 'HOME must be set for the real-HOME canary');
  const watchedFiles = [
    join(home, '.config', 'opencode', 'opencode.json'),
    join(home, '.config', 'opencode', 'opencode.jsonc'),
    join(home, '.codex', 'config.toml'),
    join(home, '.agents', 'plugins', 'marketplace.json'),
  ];
  const watchedDirs = [
    join(home, '.config', 'opencode', 'huaweicloud-plugins'),
    join(home, '.config', 'opencode', 'skills'),
    join(home, '.agents', 'huaweicloud-plugins'),
    join(home, '.codex', 'plugins', 'cache'),
  ];
  const ambientXdg = process.env.XDG_CONFIG_HOME;
  if (ambientXdg && isAbsolute(ambientXdg)) {
    watchedFiles.push(join(ambientXdg, 'opencode', 'opencode.json'), join(ambientXdg, 'opencode', 'opencode.jsonc'));
    watchedDirs.push(join(ambientXdg, 'opencode', 'huaweicloud-plugins'), join(ambientXdg, 'opencode', 'skills'));
  }
  const snapshot: Array<[string, 'file' | 'dir', string | null]> = watchedFiles.map((p) => [
    p,
    'file',
    existsSync(p) ? readFileSync(p, 'utf8') : null,
  ]);
  for (const dir of watchedDirs) snapshot.push([dir, 'dir', dirSnapshot(dir)]);
  return snapshot;
}

function assertRealHomeUnchanged(snapshot: Array<[string, 'file' | 'dir', string | null]>) {
  for (const [path, kind, before] of snapshot) {
    const now = kind === 'file' ? (existsSync(path) ? readFileSync(path, 'utf8') : null) : dirSnapshot(path);
    assert.equal(now, before, `real HOME location changed during the test: ${path}`);
  }
}

// The core meta-skill roster from the same shipped manifest the CLI parses.
function coreRoster(): Set<string> {
  const parsed = parseCoreSkillNames(
    readFileSync(join(root, 'plugins', 'huaweicloud-core', 'skills', '.manifest.json'), 'utf8'),
  );
  assert.ok(parsed, 'skills/.manifest.json core roster must parse (run: npm run build)');
  return parsed;
}

// Native skill names the agent discloses from the sandbox config dir
// (prefix + location filter keeps foreign skill sources out of the set).
// The native root derives from the XDG root the sandbox env actually set —
// the same value the installer's configRoot reads (xdgConfigHome).
function disclosedSkillNames(debugSkillJson: unknown, nativeRoot: string): Set<string> {
  const skills = Array.isArray(debugSkillJson) ? debugSkillJson : [];
  return new Set(
    skills
      .map((s) => obj(s))
      .filter(
        (s) =>
          typeof s.name === 'string' &&
          s.name.startsWith('huawei') &&
          typeof s.location === 'string' &&
          s.location.startsWith(nativeRoot),
      )
      .map((s) => s.name as string),
  );
}

test('real opencode: install -> agent view -> uninstall', { skip: agentSkip(opencodeProbe, 'opencode') }, async (t) => {
  assert.notEqual(
    opencodeProbe?.state,
    'broken',
    `opencode is on PATH but --version fails — treat as broken, not absent:\n${opencodeProbe?.stderr}`,
  );
  assert.notEqual(
    opencodeProbe?.state,
    'absent',
    'DEVKIT_REAL_AGENT_TESTS=1 demands the real opencode CLI on PATH (probe reported absent)',
  );

  const home = fixtureDir('hwc-real-opencode-');
  const cwd = fixtureDir('hwc-real-opencode-cwd-');
  const env = sandboxEnv(home);
  const canary = realHomeSnapshot();
  // Devkit-internal observability seam (mcp-server.ts clears .installed at
  // module load): marker gone proves the agent spawned the server process;
  // the "connected" line from `mcp list` is the handshake evidence.
  const marker = join(home, '.config', 'opencode', 'huaweicloud-plugins', '.installed');

  await t.test('baseline: fresh sandbox holds no devkit', () => {
    for (const args of [
      ['mcp', 'list'],
      ['debug', 'config'],
    ]) {
      const r = runAgent('opencode', args, env, cwd);
      assertSpawnOk(r, `opencode ${args.join(' ')}`);
      assert.ok(
        !r.stdout.includes('huawei'),
        `fresh sandbox already discloses huawei* (env leak?):\n${r.stdout.slice(0, 2000)}`,
      );
    }
  });

  await t.test('install exits 0', () => {
    const r = runSetup(['install', '--target', 'opencode'], env, cwd, INSTALL_TIMEOUT_MS);
    assert.equal(r.status, 0, `install --target opencode failed:\n${r.stdout}\n${r.stderr}`);
  });

  await t.test('agent view: live MCP handshake, config, skills', () => {
    // Devkit-internal observability seam (mcp-server.ts clears .installed
    // at module load): still present before any agent run, gone after the
    // first one — the agent spawned the server process. The "connected"
    // line from `mcp list` below is the handshake evidence.
    assert.ok(existsSync(marker), '.installed marker must be present right after install');

    // `mcp list` spawns the configured server and completes a real MCP
    // handshake. Exit codes are useless here (a broken server also exits
    // 0) — the rendered status is the signal.
    const mcpRun = runAgent('opencode', ['mcp', 'list'], env, cwd);
    assertSpawnOk(mcpRun, 'opencode mcp list');
    assert.ok(
      (mcpRun.stdout ?? '').includes('huaweicloud-devkit') && (mcpRun.stdout ?? '').includes('connected'),
      `mcp list must show huaweicloud-devkit connected, got:\n${(mcpRun.stdout ?? '').slice(0, 2000)}`,
    );
    assert.ok(!existsSync(marker), 'the spawned server must have cleared .installed');

    const cfgRun = runAgent('opencode', ['debug', 'config'], env, cwd);
    assertSpawnOk(cfgRun, 'opencode debug config');
    const cfg = obj(parseJsonOut('opencode debug config', cfgRun.stdout ?? ''));
    const devkitMcp = obj(obj(cfg.mcp)['huaweicloud-devkit']);
    const command = devkitMcp.command;
    assert.ok(Array.isArray(command), 'debug config mcp["huaweicloud-devkit"] must carry a command array');
    const server = command[1];
    assert.ok(
      typeof server === 'string' &&
        server.startsWith(home) &&
        server.endsWith('dist/mcp-server.js') &&
        existsSync(server),
      `mcp command must point at the sandbox server, got: ${String(server)}`,
    );
    assert.ok(obj(cfg.command)['huaweicloud-doctor'], 'doctor command must be disclosed');
    assert.ok(
      Array.isArray(cfg.plugin) && cfg.plugin.some((p) => typeof p === 'string' && p.includes('skill-tracker.js')),
      'skill-tracker plugin must be disclosed',
    );

    const skillsRun = runAgent('opencode', ['debug', 'skill'], env, cwd);
    assertSpawnOk(skillsRun, 'opencode debug skill');
    // The native root derives from the XDG root the sandbox env set — the
    // same value the installer's configRoot honored during install.
    const nativeRoot = join(String(env.XDG_CONFIG_HOME), 'opencode', 'skills');
    assert.deepEqual(
      disclosedSkillNames(parseJsonOut('opencode debug skill', skillsRun.stdout ?? ''), nativeRoot),
      coreRoster(),
      'the agent must disclose exactly the core meta-skill roster from the sandbox skills dir',
    );
  });

  await t.test('uninstall: agent view goes clean, real HOME untouched', () => {
    const r = runSetup(['uninstall', '--target', 'opencode'], env, cwd);
    assert.equal(r.status, 0, `uninstall --target opencode failed:\n${r.stdout}\n${r.stderr}`);

    for (const args of [
      ['mcp', 'list'],
      ['debug', 'config'],
      ['debug', 'skill'],
    ]) {
      const check = runAgent('opencode', args, env, cwd);
      assertSpawnOk(check, `opencode ${args.join(' ')} (post-uninstall)`);
      assert.ok(
        !check.stdout.includes('huawei'),
        `post-uninstall ${args.join(' ')} still discloses huawei*:\n${(check.stdout ?? '').slice(0, 2000)}`,
      );
    }
    assertRealHomeUnchanged(canary);
  });
});

test('real codex: install -> agent view -> uninstall', { skip: agentSkip(codexProbe, 'codex') }, async (t) => {
  assert.notEqual(
    codexProbe?.state,
    'broken',
    `codex is on PATH but --version fails — treat as broken, not absent:\n${codexProbe?.stderr}`,
  );
  assert.notEqual(
    codexProbe?.state,
    'absent',
    'DEVKIT_REAL_AGENT_TESTS=1 demands the real codex CLI on PATH (probe reported absent)',
  );

  const home = fixtureDir('hwc-real-codex-');
  const cwd = fixtureDir('hwc-real-codex-cwd-');
  const env = sandboxEnv(home);
  const canary = realHomeSnapshot();

  const pluginList = () => {
    const r = runAgent('codex', ['plugin', 'list', '--json'], env, cwd);
    assertSpawnOk(r, 'codex plugin list --json');
    return obj(parseJsonOut('codex plugin list --json', r.stdout ?? ''));
  };
  const installedDevkitNames = () => {
    const data = pluginList();
    const installed = Array.isArray(data.installed) ? data.installed : [];
    return installed
      .map((p) => obj(p))
      .filter((p) => p.pluginId === codexPluginId || p.name === getCodexPluginName())
      .map((p) => String(p.pluginId ?? p.name));
  };
  const marketplaceHasDevkit = () => {
    const r = runAgent('codex', ['plugin', 'marketplace', 'list', '--json'], env, cwd);
    assertSpawnOk(r, 'codex plugin marketplace list --json');
    const data = obj(parseJsonOut('codex plugin marketplace list --json', r.stdout ?? ''));
    const marketplaces = Array.isArray(data.marketplaces) ? data.marketplaces : [];
    return marketplaces.map((m) => obj(m).name).includes(getMarketplaceName());
  };

  await t.test('baseline: fresh sandbox holds no devkit', () => {
    assert.deepEqual(installedDevkitNames(), [], 'fresh CODEX_HOME must hold no devkit plugin');
    assert.ok(!marketplaceHasDevkit(), 'fresh CODEX_HOME must hold no devkit marketplace');
  });

  await t.test('install exits 0', () => {
    const r = runSetup(['install', '--target', 'codex'], env, cwd, INSTALL_TIMEOUT_MS);
    assert.equal(r.status, 0, `install --target codex failed:\n${r.stdout}\n${r.stderr}`);
  });

  await t.test('agent view: plugin, marketplace, resolved MCP config', () => {
    // Exact pluginId match: the human table embeds SOURCE paths that also
    // contain the plugin name, so substring matching false-positives.
    assert.deepEqual(installedDevkitNames(), [codexPluginId], 'plugin list must report exactly the devkit pluginId');
    assert.ok(marketplaceHasDevkit(), 'marketplace list must report the devkit marketplace');

    // `codex mcp list` shows the plugin-declared server with its resolved
    // cache cwd — configuration-resolution evidence only (the Status
    // column is a config echo, not spawn evidence; the codex side has no
    // cheap equivalent of opencode's live handshake).
    const r = runAgent('codex', ['mcp', 'list'], env, cwd);
    assertSpawnOk(r, 'codex mcp list');
    assert.ok(
      (r.stdout ?? '').includes('huaweicloud-devkit') && (r.stdout ?? '').includes('plugins/cache/'),
      `codex mcp list must show the devkit server resolved under the sandbox cache, got:\n${(r.stdout ?? '').slice(0, 2000)}`,
    );
  });

  await t.test('uninstall: agent view goes clean, real HOME untouched', () => {
    const r = runSetup(['uninstall', '--target', 'codex'], env, cwd);
    assert.equal(r.status, 0, `uninstall --target codex failed:\n${r.stdout}\n${r.stderr}`);
    assert.deepEqual(installedDevkitNames(), [], 'plugin list must be back to no devkit');
    assert.ok(!marketplaceHasDevkit(), 'marketplace list must be back to no devkit');
    // `codex plugin remove` strips the version subtrees but leaves the
    // marketplace-keyed cache shell; uninstallCodex removes it — the
    // uninstall-completeness contract this layer owns.
    assert.ok(
      !existsSync(join(home, '.codex', 'plugins', 'cache', getMarketplaceName())),
      'the marketplace-keyed plugin cache dir must be removed on uninstall',
    );
    assertRealHomeUnchanged(canary);
  });
});
