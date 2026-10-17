// Pre-release smoke: prove the packed tarball installs and runs for every
// supported agent target, from the installed (npx-equivalent) layout.
//
//   node scripts/smoke-agents.mjs
//
// Chain verified per target: npm pack → tarball install → bin/setup.cjs
// install → agent config written by the installer → the configured MCP server
// answers tools/list over stdio. OfficeAce has no real app on a plain Linux
// box; its install must degrade gracefully there — the documented
// "database not found" hint, payload landed, exit 0 (registration retries on
// a later update once OfficeAce has been launched; the hard-fail path is
// owner-missing, reachable only with a real connector DB).

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SUPPORTED_AGENT_TARGETS } from '../plugins/huaweicloud-core/src/auth/agent-registration.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const run = (command, args, opts = {}) =>
  spawnSync(command, args, {
    encoding: 'utf8',
    timeout: 240_000,
    ...opts,
    env: cleanEnv(opts.env),
  });

function cleanEnv(extra = {}) {
  // Clear ambient overrides BEFORE merging the caller's extra, so a caller
  // can re-pin what it needs (the officeace row sets OFFICE_CLAW_CONFIG_ROOT).
  const env = { ...process.env };
  // The installer honors these ambient overrides (XDG-aware opencode root,
  // CODEX_HOME cache cleanup, per-agent home dirs, devkit-owned state); an
  // ambient value would push fake-HOME installs into real state.
  for (const key of [
    'http_proxy',
    'https_proxy',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'all_proxy',
    'ALL_PROXY',
    'XDG_CONFIG_HOME',
    'CODEX_HOME',
    'HERMES_HOME',
    'DSH_HOME',
    'ATOMCODE_HOME',
    'HUAWEICLOUD_HOME',
    'OFFICE_CLAW_CONFIG_ROOT',
  ]) {
    delete env[key];
  }
  return { ...env, ...extra };
}

const results = [];
const record = (target, check, ok, detail) => {
  results.push({ target, check, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${target}: ${check}${detail ? ` — ${detail}` : ''}`);
};

const TOOLS_LIST_REQUEST = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
const TOOLS_LIST_FRAME = `Content-Length: ${Buffer.byteLength(TOOLS_LIST_REQUEST, 'utf8')}\r\n\r\n${TOOLS_LIST_REQUEST}`;

function mcpRoundtrip(serverPath) {
  const res = run(process.execPath, [serverPath], { input: TOOLS_LIST_FRAME, timeout: 30_000 });
  if (res.status !== 0) return { ok: false, detail: `exit ${res.status}: ${String(res.stderr).slice(0, 200)}` };
  if (!res.stdout.includes('"result"')) return { ok: false, detail: 'no JSON-RPC result in stdout' };
  if (!res.stdout.includes('huaweicloud_')) return { ok: false, detail: 'no huaweicloud_ tools in response' };
  return { ok: true, detail: `${(res.stdout.match(/"name":\s*"huaweicloud_[a-z_]+"/g) || []).length} tools` };
}

// Agent configs the installer writes. Anything else in HOME (dist copies,
// node_modules, skills) is not a consumer contract.
const CONFIG_EXTENSIONS = new Set(['.json', '.jsonc', '.yaml', '.yml', '.toml']);
function findConfiguredServerPaths(home) {
  const paths = new Set();
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'skills') continue;
        walk(join(dir, entry.name));
      } else if (CONFIG_EXTENSIONS.has(extensionOf(entry.name))) {
        const text = readFileSync(join(dir, entry.name), 'utf8');
        for (const match of text.matchAll(/[^\s"'`,]+huaweicloud[^\s"'`,]*mcp-server\.js/g)) {
          if (existsSync(match[0])) paths.add(match[0]);
        }
      }
    }
  };
  walk(home);
  return [...paths];
}

function extensionOf(name) {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot);
}

// ---- 1. pack + install the tarball (the npx-equivalent layout) ----
console.log('[smoke] packing tarball...');
const packed = JSON.parse(execFileSync(npm, ['pack', '--json'], { encoding: 'utf8', cwd: root, env: cleanEnv() }));
const tarball = join(root, packed[0].filename);
const prefix = mkdtempSync(join(tmpdir(), 'hwc-smoke-prefix-'));
execFileSync(npm, ['install', '--no-audit', '--no-fund', tarball], {
  encoding: 'utf8',
  cwd: prefix,
  env: cleanEnv(),
  stdio: 'ignore',
});
const installed = join(prefix, 'node_modules', 'huaweicloud-devkit');
const bin = join(installed, 'bin', 'setup.cjs');
if (!existsSync(bin)) {
  console.error(`[smoke] installed bin missing: ${bin}`);
  rmSync(prefix, { recursive: true, force: true });
  rmSync(tarball, { force: true });
  process.exit(1);
}

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const versionHome = mkdtempSync(join(tmpdir(), 'hwc-smoke-home-'));
const versionRun = run(process.execPath, [bin, 'version'], { env: { HOME: versionHome } });
record(
  'package',
  'installed bin version',
  versionRun.status === 0 && versionRun.stdout.includes(pkg.version),
  String(versionRun.stdout).split('\n')[0],
);
rmSync(versionHome, { recursive: true, force: true });

// ---- 2. per-target install → status → configured server roundtrip ----
for (const target of SUPPORTED_AGENT_TARGETS) {
  console.log(`[smoke] target: ${target}`);
  const home = mkdtempSync(join(tmpdir(), `hwc-smoke-${target}-`));
  // codearts resolves its PROJECT-level install dir from process.cwd(); give
  // every install a throwaway cwd so nothing lands in the repo checkout.
  const installCwd = mkdtempSync(join(tmpdir(), `hwc-smoke-cwd-${target}-`));
  // Cleanup rides finally so every exit path (failed install, codex early
  // continue) leaves TMPDIR as it found it — a red run's post-mortem is the
  // recorded FAIL detail, not a leaked sandbox.
  try {
    const env = { HOME: home };
    if (target === 'officeace') {
      const fakeRoot = join(home, '.office-claw');
      mkdirSync(fakeRoot, { recursive: true });
      writeFileSync(join(fakeRoot, 'capabilities.json'), '{}');
      env.OFFICE_CLAW_CONFIG_ROOT = fakeRoot;
    }

    const install = run(process.execPath, [bin, 'install', '--target', target], {
      env,
      cwd: installCwd,
      // The installer's internal undici npm ladder is 120s x up to 3
      // attempts plus sleeps (~368s worst case); the outer bound must
      // exceed it or the smoke kills the install first.
      timeout: 400_000,
    });
    if (target === 'officeace') {
      // The plain-Linux contract: no connector DB, so the install degrades
      // gracefully — the documented hint prints, the payload still lands,
      // and exit stays 0. (The old check demanded a non-zero exit, which
      // only ever held on a machine with a real OfficeAce DB hitting the
      // owner-missing throw; on Linux it could never pass.)
      const documented = /OfficeAce database not found/.test(install.stdout);
      const payloadLanded = existsSync(join(home, '.office-claw', 'huaweicloud-plugins', 'dist', 'mcp-server.js'));
      const ok = install.status === 0 && documented && payloadLanded;
      record(
        target,
        'install degrades gracefully with the documented OfficeAce hint',
        ok,
        ok ? 'no real OfficeAce on this host' : `exit=${install.status}, hint=${documented}, payload=${payloadLanded}`,
      );
    } else {
      record(target, 'install exits 0', install.status === 0, firstErrorLine(install));
      if (install.status !== 0) continue;

      // Non-TTY smoke stays network-free by contract, so the provisioning seam
      // must run end-to-end: the header is the stable marker that it did.
      const provisionHeader = (install.stdout.match(/Provisioning pack binaries \(enabled packs: \d+\)/) || [])[0];
      record(
        target,
        'install provisions pack binaries',
        Boolean(provisionHeader),
        provisionHeader || 'provisioning section missing from install output',
      );

      const status = run(process.execPath, [bin, 'status', '--target', target], { env, cwd: installCwd });
      const expected = target === 'codex' ? /Plugin:.*Installed/ : /MCP Server:.*Installed/;
      record(target, 'status reports the target installed', expected.test(status.stdout), firstErrorLine(status));

      if (target === 'codex') {
        // Codex manages the server through its marketplace; the consumer
        // contract is the registration in config.toml, not a direct path.
        const toml = readFileSync(join(home, '.codex', 'config.toml'), 'utf8');
        const registered = /plugins\."huaweicloud-devkit@/.test(toml);
        record(target, 'codex config.toml registers the plugin', registered, 'marketplace-managed server');
        continue;
      }

      const servers = findConfiguredServerPaths(home);
      if (servers.length === 0) {
        const copied = findCopiedServer(home);
        record(target, 'no agent-config reference; copied plugin server runs', copied.ok, copied.detail);
      } else {
        for (const server of servers) {
          const roundtrip = mcpRoundtrip(server);
          record(
            target,
            `configured server answers tools/list (${shortHome(server, home)})`,
            roundtrip.ok,
            roundtrip.detail,
          );
        }
      }
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(installCwd, { recursive: true, force: true });
  }
}

// ---- 3. hook from an installed plugin copy ----
console.log('[smoke] hook check...');
const hookHome = mkdtempSync(join(tmpdir(), 'hwc-smoke-hook-'));
const hookInstall = run(process.execPath, [bin, 'install', '--target', 'hermes'], {
  env: { HOME: hookHome },
  // Same ladder bound as the per-target installs above (cold-cache undici
  // fetch, ~368s worst case).
  timeout: 400_000,
});
record('hook', 'hook-check install exits 0', hookInstall.status === 0, firstErrorLine(hookInstall));
const hookPath = findFile(join(hookHome, '.hermes'), 'huaweicloud-safety.mjs');
if (!hookPath) {
  record('hook', 'installed hook wrapper found', false, 'hermes install did not copy hooks');
} else {
  const hookRun = run(process.execPath, [hookPath], {
    input: JSON.stringify({
      tool_name: 'Bash',
      tool_input: {
        command:
          'hcloud VPC CreateSecurityGroupRule --security_group_rule.port_range_min=22 --security_group_rule.remote_ip_prefix=0.0.0.0/0',
      },
    }),
  });
  const denied = hookRun.status === 0 && /"permissionDecision":"deny"/.test(hookRun.stdout);
  record('hook', 'installed PreToolUse hook denies a public write', denied, String(hookRun.stderr).slice(0, 200));
}
rmSync(hookHome, { recursive: true, force: true });

// ---- summary ----
rmSync(prefix, { recursive: true, force: true });
rmSync(tarball, { force: true });

const failed = results.filter((r) => !r.ok);
console.log(`\n[smoke] ${results.length - failed.length}/${results.length} checks passed.`);
if (failed.length > 0) {
  for (const f of failed) console.error(`  FAIL ${f.target}: ${f.check} — ${f.detail}`);
  process.exit(1);
}

function firstErrorLine(res) {
  if (res.status === 0) return '';
  return (
    String(res.stderr || res.stdout)
      .trim()
      .split('\n')[0] || ''
  ).slice(0, 160);
}

function shortHome(path, home) {
  return path.startsWith(home) ? path.slice(home.length) : path;
}

function findCopiedServer(home) {
  const server = findFile(home, 'mcp-server.js');
  if (!server || !server.split(sep).includes('dist')) return { ok: false, detail: 'no copied dist server found' };
  return mcpRoundtrip(server);
}

function findFile(dir, name) {
  if (!existsSync(dir)) return null;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      const hit = findFile(full, name);
      if (hit) return hit;
    } else if (entry.name === name) {
      return full;
    }
  }
  return null;
}
