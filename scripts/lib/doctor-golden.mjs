// The doctor golden harness, shared by scripts/doctor-golden.mjs (capture and
// regenerate) and test/doctor-golden.test.ts (the permanent byte-exact pin).
// It exists so both faces run doctor under the SAME deterministic
// environment: any drift between the capture env and the test env would make
// the committed goldens vacuous.
//
// Determinism contract (everything the doctor output can see is pinned):
//   HOME/USERPROFILE      fake home per fixture (doctorEnv pattern)
//   HCLOUD_BIN            node itself, with HCLOUD_BIN_ARGS_JSON pointing at
//                         test/fixtures/doctor-golden/fake-hcloud.mjs — the
//                         version probe runs the shim; the credentials check
//                         runs `node configure list` against this directory's
//                         extensionless `configure` entry (cwd is pinned here)
//   PATH                  this directory ONLY — python3 (Hermes SDK probe),
//                         codex (pack-union probe), and uvx (gateway
//                         fallback) all resolve to "not found", which pins
//                         the Hermes SDK FAIL, the absent Codex attribution,
//                         and the open-mcp-gateway not-found WARN on every
//                         machine, Windows included
//   HW_VAULT_MASTER_KEY   a fixed (fake, all-zero) 32-byte env-tier key: the
//                         custody resolver short-circuits on it and never
//                         probes the host keychain, so the vault check prints
//                         the deterministic PASS "(env custody, 0 secret(s))"
//   HUAWEICLOUD_OPENCODE_PERMISSION_SEAM=on for both install and doctor —
//                         the seam rules are written at install time and
//                         verified byte-stably at doctor time regardless of
//                         the host's opencode version
//
// Normalized volatile lines (the ONLY accepted golden diffs, see
// normalizeGoldenOutput): ANSI color escapes, the banner's version line, and
// the hcloud `Version:` line. A pkgVersion bump changes the banner padding,
// so the whole banner version line is canonicalized.

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
export const root = resolve(here, '..', '..');
export const setupCli = join(root, 'bin', 'setup.cjs');
export const goldenFixturesDir = join(root, 'test', 'fixtures', 'doctor-golden');
export const fakeHcloud = join(goldenFixturesDir, 'fake-hcloud.mjs');

// A fixed 32-byte base64 value (43 'A' chars + '='): valid for the env tier,
// never a real key, and nothing in the fake homes is encrypted under it.
const GOLDEN_VAULT_KEY = 'A'.repeat(43) + '=';

function baseEnv(home, extra) {
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    HOMEDRIVE: home.slice(0, 2),
    HOMEPATH: home.slice(2),
    // keep OfficeAce detection hermetic in automated environments (#654)
    HUAWEICLOUD_DEVKIT_SKIP_OFFICEACE_DETECT: '1',
    ...extra,
  };
  delete env.ATOMCODE_HOME;
  delete env.HUAWEICLOUD_HOME;
  delete env.HERMES_HOME;
  // XDG_CONFIG_HOME redirects the opencode config root; CODEX_HOME keys the
  // codex cache cleanup; DSH_HOME keys the dsh layout; OFFICE_CLAW_CONFIG_ROOT
  // keys the officeace root (fixture (c) passes it explicitly). Ambient values
  // would leak doctor's probes into real state.
  if (!('XDG_CONFIG_HOME' in extra)) delete env.XDG_CONFIG_HOME;
  delete env.CODEX_HOME;
  if (!('DSH_HOME' in extra)) delete env.DSH_HOME;
  if (!('OFFICE_CLAW_CONFIG_ROOT' in extra)) delete env.OFFICE_CLAW_CONFIG_ROOT;
  return env;
}

// The doctor-run env: the full determinism contract above.
export function doctorGoldenEnv(home, extra = {}) {
  const env = baseEnv(home, {
    HUAWEICLOUD_OPENCODE_PERMISSION_SEAM: 'on',
    HW_VAULT_MASTER_KEY: GOLDEN_VAULT_KEY,
    HCLOUD_BIN: process.execPath,
    HCLOUD_BIN_ARGS_JSON: JSON.stringify([fakeHcloud]),
    PATH: goldenFixturesDir,
    ...extra,
  });
  for (const name of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']) {
    if (!(name in extra)) env[name] = '';
  }
  return env;
}

// The install-run env for fixture (b): the seam override must be present at
// install time too (the rules are only written when the gate is on), but the
// install needs the real PATH (installRuntimeDeps spawns npm) and must not
// inherit the doctor-only pins — none of them affect the installed files.
// npm_config_cache pins the undici fetch's cache to one stable dir so the
// cold-registry fetch happens once per machine, not once per capture.
export function installGoldenEnv(home) {
  const env = baseEnv(home, { HUAWEICLOUD_OPENCODE_PERMISSION_SEAM: 'on' });
  env.npm_config_cache = join(tmpdir(), 'doctor-golden-npm-cache');
  return env;
}

export function runGoldenDoctor(home, extra = {}) {
  const run = spawnSync(process.execPath, [setupCli, 'doctor'], {
    encoding: 'utf8',
    env: doctorGoldenEnv(home, extra),
    // The credentials check resolves `configure` against the cwd.
    cwd: goldenFixturesDir,
    timeout: 60_000,
  });
  // exit 1 is the healthy "some check failed" path; only a crash or timeout
  // aborts the run.
  if (run.status !== 0 && run.status !== 1) {
    throw new Error(`golden doctor crashed (status ${run.status}): ${run.stderr}`);
  }
  return normalizeGoldenOutput(run.stdout ?? '');
}

export function runGoldenInstall(home) {
  const run = spawnSync(process.execPath, [setupCli, 'install', '--target', 'opencode'], {
    encoding: 'utf8',
    env: installGoldenEnv(home),
    timeout: 240_000,
  });
  if (run.status !== 0) {
    throw new Error(`golden install failed: ${run.stderr}\n${run.stdout}`);
  }
}

// Fixture (c): the hermes + officeace marker shape. The hermes config.yaml
// carries an mcp_servers block (the Hermes candidate and the Hermes SDK
// check both key on it). The officeace root carries capabilities.json with
// the devkit mcp capability (the OfficeAce candidate), a dist marker so the
// officeace payload row reads as installed (drives "MCP server can start
// (OfficeAce)" and the sqlite packs read), and the connector sqlite db with
// a pinned DEVKIT_PACKS row (the officeace sqlite-connector check).
export function stageHermesOfficeaceMarkers(home) {
  const hermesDir = join(home, '.hermes');
  mkdirSync(hermesDir, { recursive: true });
  writeFileSync(
    join(hermesDir, 'config.yaml'),
    ['mcp_servers:', '  huaweicloud-devkit:', '    command: "node"', ''].join('\n'),
    'utf8',
  );

  const officeaceRoot = join(home, 'officeace-root');
  const clawDir = join(officeaceRoot, '.office-claw');
  mkdirSync(join(clawDir, 'huaweicloud-plugins', 'dist'), { recursive: true });
  writeFileSync(
    join(clawDir, 'capabilities.json'),
    `${JSON.stringify({ capabilities: [{ id: 'huaweicloud-devkit', type: 'mcp' }] }, null, 2)}\n`,
    'utf8',
  );
  writeFileSync(join(clawDir, 'huaweicloud-plugins', 'dist', 'mcp-server.js'), 'x', 'utf8');

  const dataDir = join(officeaceRoot, 'data');
  mkdirSync(dataDir, { recursive: true });
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
  const db = new DatabaseSync(join(dataDir, 'mcp-connectors.sqlite'));
  db.exec(
    'CREATE TABLE IF NOT EXISTS mcp_connectors (id TEXT PRIMARY KEY, owner_user_id TEXT, type TEXT,' +
      ' name TEXT, normalized_name TEXT, transport TEXT, timeout_ms INTEGER, command TEXT, args_json TEXT,' +
      ' env_json TEXT, enabled INTEGER, status TEXT, created_at INTEGER, updated_at INTEGER, version INTEGER, seeded INTEGER)',
  );
  db.prepare(
    'INSERT OR REPLACE INTO mcp_connectors (id, name, command, args_json, env_json, enabled, status)' +
      " VALUES ('golden-fixture', 'huaweicloud-devkit', 'node', '[\"x\"]', ?, 1, 'disconnected')",
  ).run(JSON.stringify([{ key: 'DEVKIT_PACKS', value: 'core,huaweicloud-cli' }]));
  db.close();
  return { OFFICE_CLAW_CONFIG_ROOT: clawDir };
}

// The documented normalization list — the only golden diffs that are not
// defects. (1) ANSI color escapes (the fromCharCode idiom; eslint's
// no-control-regex rightly flags the literal). (2) The banner version line:
// pkgVersion changes width-dependent padding with it, so the version token
// AND the run of padding before the closing rule are collapsed — a
// width-preserving replacement kept each side's own padding and diverged on
// every version-width change (2.0.0 → 2.0.0-next.0; the first release that
// hit it). (3) The hcloud `Version:` line: the shim mirrors kooCliVersion,
// which bumps independently of doctor behavior.
const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
const BANNER_VERSION_RE = /^(\u2563\s+HuaweiCloud DevKit )v\S+\s*(\u2563)$/;
const Hcloud_VERSION_RE = /^(\s*Version: )\S+.*$/;

export function normalizeGoldenOutput(text) {
  return text
    .replace(ANSI_RE, '')
    .split('\n')
    .map((line) => line.replace(BANNER_VERSION_RE, '$1<version> $2').replace(Hcloud_VERSION_RE, '$1<hcloud-version>'))
    .join('\n');
}

export const goldenNames = {
  empty: 'golden-a-empty-home.txt',
  opencodeInstall: 'golden-b-opencode-install.txt',
  hermesOfficeace: 'golden-c-hermes-officeace.txt',
};

// Captures one fixture's doctor output into text (the shared body of both
// the capture CLI and the permanent test).
export function captureEmptyHome(home) {
  return runGoldenDoctor(home);
}

export function captureOpencodeInstall(home) {
  runGoldenInstall(home);
  return runGoldenDoctor(home);
}

export function captureHermesOfficeace(home) {
  const extra = stageHermesOfficeaceMarkers(home);
  return runGoldenDoctor(home, extra);
}
