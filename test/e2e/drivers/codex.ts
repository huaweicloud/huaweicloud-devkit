import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { getCodexPluginName, getMarketplaceName } from '../../../plugins/huaweicloud-core/src/codex-probe.ts';
import { startGatewayProxy } from './gateway-proxy.ts';
import { MCP_ENV_LOADER_SOURCE, requiredModelEnv, runHeadlessAgent, verifyLegWire } from './shared.ts';
import type { AgentDriver, DriverContext, DriverProbe, RunRequest, RunResult } from './types.ts';

// codex adapter, spike-validated on codex-cli 0.162.1 (2026-10-21):
// - An enabled plugin's .mcp.json server loads BESIDE any mcp_servers entry
//   (two namespaces, nondeterministic same-name dispatch — measured), so the
//   driver disables the plugin registration in config.toml and declares the
//   installed plugin-cache server itself (mcp_servers.hwc): the payload
//   under test stays the tarball-installed one, and the one instrumented
//   server carries the full seam env.
// - codex strips the environment of MCP children down to login vars plus the
//   server's config env block, so the runner-owned session env is delivered
//   through a loader the server command wraps (mcp-env.json, written per
//   attempt from the merged case env).
// - The gateway shaping proxy sits on the model wire; see gateway-proxy.ts.
// - exec refuses non-git workdirs without --skip-git-repo-check, reads
//   stdin when it is an open pipe (the shared spawn ignores stdin), and
//   needs -s danger-full-access (the sandboxed postures are unusable on a
//   custom gateway — see the runPrompt rationale) plus
//   shell_environment_policy.inherit=all so the PATH hcloud shim reaches
//   shell children.
// - No permission-seam floor: that doctrine is opencode-only; the version is
//   parsed and reported so drift against the CI pin stays visible.

const MODEL_PROVIDER_ID = 'e2e-codex';
// Placeholder rewritten by runPrompt once the shaping proxy's ephemeral
// port is known; port 1 never listens, so a missed rewrite fails loudly.
const PROXY_BASE_PLACEHOLDER = 'http://127.0.0.1:1/v1';
// A closed local port for https_proxy: codex's startup sync of the OpenAI
// curated-plugins catalog (github.com/openai/plugins, ~100MB cold clone per
// fresh home) and every other codex https egress die instantly against it,
// while the model wire rides the local http proxy (NO_PROXY for localhost
// is a fixed posture) and the devkit server's fake endpoints are local
// http too. Spike-measured: the catalog sync fails fast and codex proceeds.
const EGRESS_BLOCK_PROXY = 'http://127.0.0.1:9';

// The loader script itself is the shared MCP_ENV_LOADER_SOURCE (two
// env-filtering legs now ship the identical mechanism).

// TOML string escaping for values interpolated from the model env config.
export function tomlString(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function codexVersion(): { found: boolean; version: string | null; detail: string } {
  // codex resolves its whole home from CODEX_HOME and never creates it, so
  // the probe pins a throwaway root — the spawn must not touch the
  // developer's real ~/.codex (the opencode probe's XDG pin precedent).
  // One pinned --version spawn answers both existence and version.
  let probeRoot: string;
  try {
    probeRoot = mkdtempSync(join(tmpdir(), 'devkit-e2e-codex-'));
  } catch {
    return { found: false, version: null, detail: 'could not create a probe temp dir' };
  }
  try {
    const r = spawnSync('codex', ['--version'], {
      encoding: 'utf8',
      timeout: 10_000,
      env: { ...process.env, CODEX_HOME: probeRoot },
    });
    if (r.error) {
      return { found: false, version: null, detail: 'codex binary not found on PATH' };
    }
    const out = r.stdout?.toString() ?? '';
    const version = /(\d+\.\d+\.\d+)/.exec(out)?.[0] ?? null;
    return {
      found: true,
      version,
      detail: version ? `codex-cli ${version}` : `unparsable version output: ${out.trim().slice(0, 80)}`,
    };
  } finally {
    try {
      rmSync(probeRoot, { recursive: true, force: true });
    } catch {
      // best-effort: a leftover probe dir is inert
    }
  }
}

// The plugin cache copy the installer populated: CODEX_HOME/plugins/cache/
// <marketplace>/<plugin>/<version>/dist/mcp-server.js. Derived, never
// hardwired, so version bumps ride along. Filtered by the server file:
// pre-resolvePluginDir devkit payloads wrote a sibling telemetry/ directory
// into this parent on first server boot, and codex's version-dir scan can
// resolve that stray as the version — the filter keeps the resolution honest
// against any stale cache layout.
function resolveServerJs(home: string): string {
  const cacheRoot = join(home, '.codex', 'plugins', 'cache', getMarketplaceName(), getCodexPluginName());
  if (!existsSync(cacheRoot)) {
    throw new Error(`codex plugin cache missing: ${cacheRoot} — did install --target codex run?`);
  }
  const versions = readdirSync(cacheRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(cacheRoot, entry.name, 'dist', 'mcp-server.js')))
    .map((entry) => entry.name);
  if (versions.length !== 1) {
    throw new Error(
      `expected exactly one plugin version under ${cacheRoot}, found: ${versions.join(', ') || '(none)'}`,
    );
  }
  return join(cacheRoot, versions[0]!, 'dist', 'mcp-server.js');
}

// Driver-scoped paths from the latest prepare() call; the runner is
// single-threaded and prepares before every runPrompt.
let homeDir: string | null = null;
let envFile: string | null = null;
let finalFile: string | null = null;

function mergeConfigToml(home: string, serverJs: string): void {
  const configPath = join(home, '.codex', 'config.toml');
  const existing = existsSync(configPath) ? readFileSync(configPath, 'utf8') : '';
  const model = process.env.E2E_MODEL!;
  // The installer leaves the plugin enabled, and an enabled plugin's
  // .mcp.json server loads BESIDE ours (measured: two namespaces in the
  // model request, mcp__<plugin> and mcp__hwc). Same-named tool calls then
  // dispatch nondeterministically to the plugin copy — spawned bare from
  // its .mcp.json with no loader, so no trace, no toolsListChanged
  // disclosure, and no fake-boundary env reach it: recordings silently
  // vanish while results look green. Disabling the plugin registration
  // keeps the cache (the payload under test) and leaves mcp_servers.hwc
  // as the only server.
  const pluginHeader = `[plugins."${getCodexPluginName()}@${getMarketplaceName()}"]`;
  let content = existing;
  const lines = content.split('\n');
  const headerAt = lines.findIndex((line) => line.trim() === pluginHeader);
  const anyPluginsTable = lines.some((line) => line.trim().startsWith('[plugins.'));
  if (headerAt >= 0) {
    let disabled = false;
    for (let i = headerAt + 1; i < lines.length; i++) {
      const line = lines[i]!;
      if (line.trim().startsWith('[')) break;
      if (line.trim() === 'enabled = false') {
        disabled = true;
        break;
      }
      if (line.trim() === 'enabled = true') {
        lines[i] = line.replace('enabled = true', 'enabled = false');
        disabled = true;
        break;
      }
    }
    // A present-but-unflipped plugin table means the installer's output
    // shape drifted — silently keeping the plugin enabled would reintroduce
    // the nondeterministic double registration this surgery exists to kill.
    if (!disabled) {
      throw new Error(`could not disable the plugin registration under ${pluginHeader} — installer output drift?`);
    }
    content = lines.join('\n');
  } else if (anyPluginsTable) {
    // Header-shape drift (re-quoted, re-serialized, renamed table): the
    // plugin is registered under a spelling this surgery cannot find, which
    // is the same silent double-registration failure mode as above.
    throw new Error(
      `a [plugins.] table exists but the expected header ${pluginHeader} was not found — installer output drift?`,
    );
  }
  // Top-level keys must precede every table header, so they are prepended;
  // our own tables are appended after the installer's marketplace/plugin
  // entries (a fresh throwaway home per attempt guarantees no prior merge).
  const head = [
    `model = ${tomlString(model)}`,
    `model_provider = ${tomlString(MODEL_PROVIDER_ID)}`,
    // The hosted web_search tool is rejected by the responses gateway; the
    // only suppressing mode is "disabled" (create_web_search_tool source).
    'web_search = "disabled"',
    // Keep the agent from phoning the update endpoint on startup.
    'check_for_update_on_startup = false',
    '',
  ].join('\n');
  // The MCP child env is stripped to login vars, so the command must be an
  // absolute binary — the same node that runs the suite (>= 22.19 floor).
  const nodeBin = process.execPath;
  const tail = [
    '',
    `[model_providers.${MODEL_PROVIDER_ID}]`,
    `name = ${tomlString(MODEL_PROVIDER_ID)}`,
    `base_url = ${tomlString(PROXY_BASE_PLACEHOLDER)}`,
    'env_key = "E2E_APIKEY"',
    'wire_api = "responses"',
    '',
    '[mcp_servers.hwc]',
    `command = ${tomlString(nodeBin)}`,
    `args = [${tomlString(join(home, 'mcp-env-loader.mjs'))}, ${tomlString(serverJs)}]`,
    'env = { HUAWEICLOUD_AGENT_TOOLKIT_MODE = "local" }',
    '',
  ].join('\n');
  writeFileSync(configPath, `${head}${content.trimEnd()}\n${tail}`, 'utf8');
}

export const codexDriver: AgentDriver = {
  id: 'codex',
  installTarget: 'codex',
  modelWire: 'responses',
  supportsInstallPacks: false,

  prepareHome(home: string): NodeJS.ProcessEnv {
    // codex refuses to resolve a CODEX_HOME that does not exist, and the
    // install-time `codex plugin` spawns need it before prepare ever runs.
    mkdirSync(join(home, '.codex'), { recursive: true });
    // The install spawns also run codex startup (curated-plugins catalog
    // sync included), so the egress block must ride the install env too.
    return { https_proxy: EGRESS_BLOCK_PROXY, HTTPS_PROXY: EGRESS_BLOCK_PROXY };
  },

  async probe(): Promise<DriverProbe> {
    const { found, version, detail } = codexVersion();
    if (!found) {
      return { ok: false, detail, command: null, version: null };
    }
    const { missing, apiKeyVar } = requiredModelEnv();
    if (missing.length > 0) {
      return {
        ok: false,
        command: 'codex',
        version,
        detail: `missing environment: ${missing.join(', ')}. Set a dedicated E2E key (never the real auth file) plus provider/model pins.`,
      };
    }
    // codex 0.162.1 is responses-only: verify that exact wire (route + key
    // + model) before the suite spends its budget on a dead gateway.
    const wire = await verifyLegWire('responses');
    if (!wire.ok) {
      return { ok: false, command: 'codex', version, detail: wire.detail };
    }
    return { ok: true, command: 'codex', version, detail: `${detail}; ${wire.detail} (auth via ${apiKeyVar})` };
  },

  prepare(ctx: DriverContext): NodeJS.ProcessEnv {
    homeDir = ctx.home;
    envFile = join(ctx.home, 'mcp-env.json');
    finalFile = join(ctx.home, 'codex-final-message.txt');
    mkdirSync(join(ctx.home, '.codex'), { recursive: true });
    const serverJs = resolveServerJs(ctx.home);
    writeFileSync(join(ctx.home, 'mcp-env-loader.mjs'), MCP_ENV_LOADER_SOURCE, 'utf8');
    mergeConfigToml(ctx.home, serverJs);
    // The TOML env_key names exactly one variable: bridge the alternate
    // spelling so a local run configured with only E2E_TEST_API_KEY does
    // not pass the probe and then fail every model call. The https_proxy
    // pair blocks codex's https egress (curated-plugins catalog clone,
    // telemetry endpoints) — see EGRESS_BLOCK_PROXY.
    const driverVars: NodeJS.ProcessEnv = {
      https_proxy: EGRESS_BLOCK_PROXY,
      HTTPS_PROXY: EGRESS_BLOCK_PROXY,
    };
    if (!process.env.E2E_APIKEY && process.env.E2E_TEST_API_KEY) {
      driverVars.E2E_APIKEY = process.env.E2E_TEST_API_KEY;
    }
    return driverVars;
  },

  async runPrompt(req: RunRequest): Promise<RunResult> {
    if (!homeDir || !envFile || !finalFile) {
      throw new Error('codex driver runPrompt before prepare');
    }
    // The full merged case env is what the MCP child must see (parity with
    // opencode children): seams, case env, fixed posture, shim-first PATH.
    writeFileSync(envFile, JSON.stringify(req.env, null, 2), { mode: 0o600, encoding: 'utf8' });
    const base = new URL(process.env.E2E_PROVIDER_BASEURL!);
    const proxy = await startGatewayProxy(base.origin);
    let run: Awaited<ReturnType<typeof runHeadlessAgent>>;
    try {
      // The local base mirrors the real base's pathname, so codex requests
      // <pathname>/responses and the proxy's origin + req.url reconstructs
      // the real endpoint — a gateway mounted under a path prefix works. A
      // path-less base yields no trailing slash (a // route would 404), and
      // trailing slashes on the configured base are stripped for the same
      // reason.
      const configPath = join(homeDir, '.codex', 'config.toml');
      const configured = readFileSync(configPath, 'utf8');
      const pathname = base.pathname === '/' ? '' : base.pathname.replace(/\/+$/, '');
      const withProxy = configured.replaceAll(PROXY_BASE_PLACEHOLDER, `http://127.0.0.1:${proxy.port}${pathname}`);
      writeFileSync(configPath, withProxy, 'utf8');
      run = await runHeadlessAgent(
        'codex',
        [
          'exec',
          '--skip-git-repo-check',
          // danger-full-access is the working posture on a custom gateway:
          // the sandboxed postures are not usable here — plain workspace-write
          // denies every MCP tool call under exec's never-approval (measured),
          // and --approve-for-me routes approvals through a guardian model
          // call that dials an OpenAI model slug the gateway 404s (measured;
          // mutually exclusive with -s besides). The trust level matches the
          // opencode leg, whose headless runs are equally unsandboxed. The
          // env-level egress block and the PATH shim are cooperation-level
          // defenses; the measured escape route (a model that unsets the
          // proxy vars and calls the host's real hcloud by absolute path)
          // exists only on machines that have a real hcloud — CI runners
          // install none, so the escape target is absent there. Local runs on
          // such machines carry that documented residual.
          //
          // non_prefixed_mcp_tool_names stays OFF: the measured
          // amplification (loading the plugin-declared server beside ours,
          // with the recording-loss consequences above) predates the
          // plugin-disable fix — the flag is a second rail behind the
          // disabled registration, not an independently measured hazard in
          // the current posture.
          '-s',
          'danger-full-access',
          '-c',
          'shell_environment_policy.inherit=all',
          '-o',
          finalFile,
          req.prompt,
        ],
        req,
      );
    } finally {
      await proxy.close();
    }
    // The -o file is the clean final message. No stdout fallback: the
    // transcript carries prompts, commands, and reasoning, so a keyword
    // match against it would pass cases the model turn never completed —
    // an absent or empty file yields null and the soft channel honestly
    // records nothing. Diagnostics still ride the recorded stdout.
    const finalText = existsSync(finalFile) ? readFileSync(finalFile, 'utf8').trim() || null : null;
    return { ...run, finalText };
  },
};
