import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { AgentDriver, DriverContext, DriverProbe, RunRequest, RunResult } from './types.ts';
import { MCP_ENV_LOADER_SOURCE, requiredModelEnv, runHeadlessAgent, verifyLegWire } from './shared.ts';

// hermes adapter, spike-validated on Hermes Agent v0.22.5 (2026-10-27,
// commit bf0203a794a0) — every mechanism here is measured, see
// docs/e2e-testing-design.md "The hermes driver":
// - `hermes -z "<prompt>"` is the one-shot wire: stdout is the final reply,
//   exit 0 turn completed / 2 failed-or-never-ran / 130 interrupted.
// - The first -z in a home auto-starts a GATEWAY that owns the MCP server
//   child and the terminal env; -z is only a WebSocket client. Killing the
//   -z process group does not reach the gateway, so runPrompt tears it down
//   via <home>/.hermes/gateway.pid (600s idle-exit is the backstop).
// - A throwaway HERMES_HOME is a "borrowing launch": by default hermes
//   network-syncs a full venv into it (minutes, and killed runs leave uv
//   cache locks). The driver templates the owner's committed installs/
//   tree instead (rsync-minus-locks + facts.json path rewrite) so
//   venv_is_current passes and no network is touched.
// - MCP children get only the config env block + a safe baseline, so the
//   session env rides the shared mcp-env loader (the codex mechanism).
// - The providers: map (NOT the legacy custom_providers list) carries the
//   model config; key_env E2E_APIKEY with the E2E_TEST_API_KEY bridge.
// - tools.tool_search.enabled "off" pins the eager tool listing: hermes's
//   default progressive disclosure would hide the 56 devkit tools behind
//   tool_search/tool_describe/tool_call bridges, a posture the cases'
//   prompts do not model.

// The machine-scoped hermes install: the checkout hermes runs from, the
// committed dependency state the driver templates, and the install stamp
// the version probe reads. On CI this is the pinned CLI-install step's
// ~/.hermes; locally, the developer's real one. HERMES_HOME-independent by
// design — the throwaway homes borrow this checkout.
function hermesOwnerRoot(): string {
  return join(homedir(), '.hermes');
}

function hermesInstallStampVersion(): string | null {
  // displayVersion without a process spawn: `hermes --version` runs a
  // 60s-timeout git ls-remote against the checkout's origin first
  // (measured stall on flaky networks) and only then prints the local
  // answer. The stamp carries the same identity with no spawn at all.
  try {
    const stamp = JSON.parse(readFileSync(join(hermesOwnerRoot(), 'hermes-agent', 'install-stamp.json'), 'utf8')) as {
      displayVersion?: unknown;
    };
    return typeof stamp.displayVersion === 'string' && stamp.displayVersion ? stamp.displayVersion : null;
  } catch {
    return null;
  }
}

// Resolve the hermes launcher absolutely — never a `hermes --version`
// spawn (the shared resolveCommand helper: hermes's --version dials the
// checkout's origin with a 60s timeout before falling back to the local
// answer, so a PATH probe via --version dead-ends on flaky networks).
// runPrompt then spawns the absolute path: the leg does not depend on the
// session PATH finding hermes at all (the PATH shim stays first for the
// fake hcloud, which is what PATH-resolution is FOR on this leg).
function resolveHermesCommand(): string | null {
  const which = spawnSync('sh', ['-c', 'command -v hermes'], { encoding: 'utf8', timeout: 5_000 });
  const onPath = which.stdout?.toString().trim() ?? '';
  if (onPath) return onPath;
  for (const fallback of [
    join(homedir(), '.local', 'bin', 'hermes'),
    join(hermesOwnerRoot(), 'hermes-agent', '.hermes', 'bin', 'hermes'),
  ]) {
    if (existsSync(fallback)) return fallback;
  }
  return null;
}

// The committed dependency state hermes resolves for the machine checkout:
// <owner>/installs/<install_key(project_root)>/. The key is derived from the
// checkout (stable across homes on this machine), so exactly one directory
// is expected; zero or many means the owner home is not a usable template
// source and the leg refuses before any case spends budget.
function ownerInstallsKey(): string {
  const installsRoot = join(hermesOwnerRoot(), 'installs');
  const key = existsSync(installsRoot)
    ? readdirSync(installsRoot, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
    : [];
  if (key.length !== 1) {
    throw new Error(
      `expected exactly one hermes install key under ${installsRoot}, found: ${key.join(', ') || '(none)'} — is the pinned hermes CLI installed (hermes-agent.nousresearch.com/install.sh)?`,
    );
  }
  return key[0]!;
}

// Rewrite every path VALUE inside a facts.json document from the owner
// root to the borrower root. JSON-semantic on purpose: a raw text
// replaceAll misses on Windows, where JSON serialization escapes every
// backslash in the file while the in-memory roots carry single ones (the
// hermes install's own machine shape) — parse, rewrite the string values
// recursively, re-serialize, and both platform spellings rewrite.
export function rewriteFactsPaths(factsText: string, fromRoot: string, toRoot: string): string {
  const rewrite = (node: unknown): unknown => {
    if (typeof node === 'string') return node.replaceAll(fromRoot, toRoot);
    if (Array.isArray(node)) return node.map((item) => rewrite(item));
    if (node && typeof node === 'object') {
      return Object.fromEntries(Object.entries(node).map(([key, value]) => [key, rewrite(value)]));
    }
    return node;
  };
  return JSON.stringify(rewrite(JSON.parse(factsText)), null, 2);
}

// Template the borrowed-launch dependency state into a throwaway home:
// copy the owner's committed installs/ tree minus lock files (a killed
// prepare leaves stale uv locks otherwise; the owner's own locks are
// runtime state, never template material), then rewrite the absolute
// paths inside facts.json so venv_is_current resolves the COPIED venv —
// an unrewritten fact points back at the owner's path, reads as stale,
// and the next -z falls into the network-bound uv sync this copy exists
// to skip. The venv is relocatable (pyvenv.cfg) with its interpreter
// under the owner's tools/, so the copy runs as-is.
function templateHermesInstalls(home: string): void {
  const key = ownerInstallsKey();
  const src = join(hermesOwnerRoot(), 'installs', key);
  const dst = join(home, '.hermes', 'installs', key);
  mkdirSync(join(home, '.hermes'), { recursive: true });
  cpSync(src, dst, {
    recursive: true,
    filter: (from) => !from.endsWith('.lock'),
  });
  const factsPath = join(dst, 'facts.json');
  const ownerRoot = hermesOwnerRoot();
  const borrowerRoot = join(home, '.hermes');
  writeFileSync(factsPath, rewriteFactsPaths(readFileSync(factsPath, 'utf8'), ownerRoot, borrowerRoot), 'utf8');
}

// Fail-loud config surgery over the installer-written config.yaml. The
// installer's mcp_servers block shape is pinned (writeHermesMcpConfig);
// a miss here is installer-output drift, never something to run around.
function rewriteHermesMcpArgs(home: string): void {
  const configPath = join(home, '.hermes', 'config.yaml');
  const serverJs = join(home, '.hermes', 'huaweicloud-plugins', 'dist', 'mcp-server.js').replaceAll('\\', '/');
  if (!existsSync(serverJs)) {
    throw new Error(`hermes plugin payload missing: ${serverJs} — did install --target hermes run?`);
  }
  const existing = readFileSync(configPath, 'utf8');
  // DEVKIT_PACKS (installPacks posture) and HCLOUD_BIN lines inside the
  // block survive untouched: the loader's mcp-env.json extra overrides
  // HCLOUD_BIN per attempt, while DEVKIT_PACKS rides the block alone (the
  // env policy strips it from the process env by design).
  const installerArgs = `args: ["${serverJs}"]`;
  const loaderArgs = `args: ["${join(home, 'mcp-env-loader.mjs').replaceAll('\\', '/')}", "${serverJs}"]`;
  if (!existing.includes(installerArgs)) {
    throw new Error(
      `expected the installer-written mcp_servers args line ${installerArgs} in ${configPath} — installer output drift?`,
    );
  }
  let content = existing.replace(installerArgs, loaderArgs);
  // The MCP child env is filtered, so the command must be an absolute
  // binary — the same node that runs the suite (the codex precedent).
  content = content.replace('command: "node"', `command: ${JSON.stringify(process.execPath)}`);
  // Eager tool listing: hermes's default progressive disclosure hides MCP
  // tools behind tool_search/tool_describe/tool_call bridges; the cases'
  // prompts assume the devkit tools are model-visible like the other legs.
  if (!/^tools:\n {2}tool_search:\n {4}enabled: "off"$/m.test(content)) {
    content = `${content.trimEnd()}\n\ntools:\n  tool_search:\n    enabled: "off"\n`;
  }
  // The model config: the providers: map (v0.22.5 does not resolve the
  // legacy custom_providers list — measured). Appended as a fresh
  // top-level block; the installer never writes these keys.
  const model = process.env.E2E_MODEL!;
  const baseURL = process.env.E2E_PROVIDER_BASEURL!;
  content = `${content.trimEnd()}\n\nmodel:\n  provider: "e2e-hermes"\n  default: ${JSON.stringify(model)}\nproviders:\n  e2e-hermes:\n    base_url: ${JSON.stringify(baseURL)}\n    key_env: "E2E_APIKEY"\n    api_mode: "chat_completions"\n    model: ${JSON.stringify(model)}\n`;
  writeFileSync(configPath, content, 'utf8');
}

// Gateway teardown: the -z client's process-group kill cannot reach the
// auto-started gateway (it outlives every client by design, 600s idle-exit
// backstop), and the gateway owns the MCP server child — a leaked gateway
// would hold the loader env of a finished attempt open against the next
// one's recordings. gateway.pid is the hermes-written handle (JSON with a
// pid field); SIGTERM its process group, escalate once, best-effort.
function terminateHermesGateway(home: string): void {
  const pidFile = join(home, '.hermes', 'gateway.pid');
  let pid: unknown;
  try {
    pid = (JSON.parse(readFileSync(pidFile, 'utf8')) as { pid?: unknown }).pid;
  } catch {
    return; // no gateway booted (or already gone) — nothing to tear down
  }
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid)) return;
  for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
    try {
      process.kill(pid, signal);
    } catch {
      return; // already dead
    }
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      try {
        process.kill(pid, 0);
      } catch {
        return;
      }
      spawnSync('sleep', ['0.1'], { timeout: 500 });
    }
  }
}

// Driver-scoped state from the latest prepare() call; the runner is
// single-threaded and prepares before every runPrompt (the codex pattern).
let homeDir: string | null = null;
// The absolute hermes launcher probe() resolved; runPrompt spawns it.
let hermesCommand: string | null = null;

export const hermesDriver: AgentDriver = {
  id: 'hermes',
  installTarget: 'hermes',
  modelWire: 'chat',
  supportsInstallPacks: true,

  prepareHome(home: string): NodeJS.ProcessEnv {
    // The devkit installer resolves the hermes home from HERMES_HOME
    // (targets.ts), so the throwaway root must be pinned before install;
    // the ambient spelling is stripped by the env policy (host state never
    // leaks into case sessions) and re-set deliberately here.
    mkdirSync(join(home, '.hermes'), { recursive: true });
    return { HERMES_HOME: join(home, '.hermes') };
  },

  async probe(): Promise<DriverProbe> {
    const command = resolveHermesCommand();
    if (!command) {
      return {
        ok: false,
        detail:
          'hermes launcher not found (PATH, ~/.local/bin, or the checkout) — install it from hermes-agent.nousresearch.com/install.sh (the suite templates its committed dependency state per attempt)',
        command: null,
        version: null,
      };
    }
    hermesCommand = command;
    const version = hermesInstallStampVersion();
    if (!version) {
      return {
        ok: false,
        command,
        version: null,
        detail: `no hermes install stamp under ${hermesOwnerRoot()}/hermes-agent — the pinned CLI install step must run before the leg`,
      };
    }
    try {
      ownerInstallsKey();
    } catch (error) {
      return { ok: false, command, version, detail: (error as Error).message };
    }
    const { missing, apiKeyVar } = requiredModelEnv();
    if (missing.length > 0) {
      return {
        ok: false,
        command,
        version,
        detail: `missing environment: ${missing.join(', ')}. Set a dedicated E2E key (never the real auth file) plus provider/model pins.`,
      };
    }
    // The leg rides chat/completions: verify that exact wire before the
    // suite spends its budget on a dead gateway.
    const wire = await verifyLegWire('chat');
    if (!wire.ok) {
      return { ok: false, command, version, detail: wire.detail };
    }
    return {
      ok: true,
      command,
      version,
      detail: `hermes ${version} (borrowed-launch template from ${hermesOwnerRoot()}); ${wire.detail} (auth via ${apiKeyVar})`,
    };
  },

  prepare(ctx: DriverContext): NodeJS.ProcessEnv {
    homeDir = ctx.home;
    // The borrowed-launch template must land before any hermes process
    // boots in this home — runPrompt's -z is the first spawn, and the
    // gateway it starts reads the dependency state at boot.
    templateHermesInstalls(ctx.home);
    writeFileSync(join(ctx.home, 'mcp-env-loader.mjs'), MCP_ENV_LOADER_SOURCE, 'utf8');
    rewriteHermesMcpArgs(ctx.home);
    // key_env names exactly one spelling: bridge the alternate so a local
    // run configured with only E2E_TEST_API_KEY does not pass the probe
    // and then fail every model call (the codex bridge precedent).
    const driverVars: NodeJS.ProcessEnv = { HERMES_HOME: join(ctx.home, '.hermes') };
    if (!process.env.E2E_APIKEY && process.env.E2E_TEST_API_KEY) {
      driverVars.E2E_APIKEY = process.env.E2E_TEST_API_KEY;
    }
    return driverVars;
  },

  async runPrompt(req: RunRequest): Promise<RunResult> {
    if (!homeDir || !hermesCommand) {
      throw new Error('hermes driver runPrompt before prepare');
    }
    // The full merged case env is what the MCP child must see (parity with
    // the other legs): the gateway boots on this -z, spawns the server via
    // the loader, and the loader reads this file at spawn.
    writeFileSync(join(homeDir, 'mcp-env.json'), JSON.stringify(req.env, null, 2), { mode: 0o600, encoding: 'utf8' });
    try {
      const run = await runHeadlessAgent(hermesCommand, ['-z', req.prompt], req);
      // -z stdout IS the final reply on a completed turn; a failed turn can
      // carry a provider warning line first (measured) — finalText stays a
      // soft channel and the exit code drives liveness, so no file dance.
      return { ...run, finalText: run.stdout.trim() || null };
    } finally {
      // The gateway outlives the -z client (and owns the MCP server child
      // plus this attempt's loader env) — always tear it down, including
      // the timeout/abort paths where the shared helper already killed
      // the client's own process group.
      terminateHermesGateway(homeDir);
    }
  },
};

// Exported for the unit guards: the surgery and template functions are the
// leg's fail-loud surface (installer-output drift, owner-state drift).
export { rewriteHermesMcpArgs, templateHermesInstalls, hermesInstallStampVersion, ownerInstallsKey, hermesOwnerRoot };
