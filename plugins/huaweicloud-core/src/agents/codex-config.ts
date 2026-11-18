// The codex client approval yield: per-tool `approval_mode` config for the
// devkit's MCP server — the codex half of the approval-chain yield (PR-5).
//
// Under codex's default approvalPolicy ("on-request") codex fires its OWN
// approval gate ahead of every MCP tool call, so a roster call is a double
// interaction: the codex dialog first, the devkit server's confirmation
// second (measured on codex-cli 0.167.2, probe home
// /tmp/opencode/probe-non-elicit-dlg — the same geometry PR-2 removed on
// opencode). The yield is the per-tool value the codex config understands,
// measured live on the same build: `approve` runs the call straight through
// with no codex dialog, so the devkit's own confirmation is the single
// surface. `prompt` shows an Allow/Cancel dialog with the tool name and up
// to 3 truncated argument lines (no persistence options); `auto` keeps
// codex's 4-option gate with persistence options. Neither fails anything
// open — the server gate confirms every roster call regardless of the
// client value — so the doctor treats every non-approve value as a WARN
// naming its direction, never a FAIL: a wrong value degrades UX (double
// interaction) or fails closed, and WARN is the honest ceiling. `prompt` is
// the taught fallback for the policy-off branch only, never a written value.
//
// WHERE the yield lives, settled by live measurement against codex 0.167.2
// plus the upstream source (core mcp_tool_call.rs,
// resolve_user_configured_approval_mode): codex reads per-tool
// approval_mode from TWO places, in order — the config layer stack's
// mcp_servers.<server>.tools.<tool> (the user's config.toml), then the
// PLUGIN-provided server definition (plugin.mcp_servers.<server>.tools.<tool>).
// The devkit server is plugin-provided on every current install (the CLI
// marketplace flow copies plugins/huaweicloud-core — including .mcp.json —
// into codex's cache; Codex Desktop reads the plugin dir), so the yield
// belongs in the devkit-owned .mcp.json. Writing config.toml instead is
// actively harmful: a tools table under [mcp_servers.huaweicloud-devkit]
// implies a config-declared server, and with no command/url codex refuses
// to load the whole config ("Error: failed to load bootstrap configuration
// — Caused by: invalid transport in `mcp_servers.huaweicloud-devkit`",
// measured live; the probe's config.toml always carried a transport for
// its probe server, which is why the plan's original config.toml dialect
// never met this shape). The installer therefore never touches the user's
// config.toml; a user's own per-tool value there WINS over the payload
// (the source's precedence), and the doctor surfaces it as a WARN.
//
// Ownership contracts: the payload .mcp.json is devkit-owned end to end —
// regenerated on every deploy, removed with the plugin dir / cache on
// uninstall — so the yield needs no add-only-if-absent or value-exact
// machinery. The user's config.toml is never written, so its values are
// user-owned by construction; the doctor reports them by name.
//
// Policy directions the doctor names, both measured on 0.167.2: codex's
// granular `mcp_elicitations = false` auto-declines every server form and
// substitutes codex's built-in gate, so every roster call fails CLOSED at
// the devkit gate until the policy is on — the remediation names the flip.
// A top-level `approval_policy = "never"` blocks MCP tool calls outright,
// ahead of the devkit gate.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { APPROVAL_MCP_SERVER, APPROVAL_TOOLS } from '../approval-roster.ts';
import { codexPluginProbe, getCodexPluginName, getMarketplaceName } from '../codex-probe.ts';
import { codexDesktopPluginsDir } from '../targets.ts';
import { asRecord } from '../lib/as-record.ts';
import type { DoctorReporter } from '../doctor-report.ts';

// The yield value the devkit owns. Never "prompt" or "auto": those are
// remediation shapes for the policy-off branch, taught by the doctor only.
export const CODEX_APPROVAL_MODE = 'approve';

// The ask-mode env the payload .mcp.json carries beside the yield: codex
// passes the plugin-provided server entry's env to the MCP child (live-
// measured on codex-cli 0.167.2 — a roster call returned ELICITATION_DECLINED,
// the headless auto-decline of the server-raised form, proving both the
// passthrough and the capable-client ladder). The payload is the devkit-owned
// channel: there is no codex-side override for plugin-provided env, so an
// operator wanting token mode on codex edits their cached copy (and re-runs
// the install to restore it) — the doctor flags the drift.
export const CODEX_APPROVAL_MODE_ENV = 'ask';

// The `tools` map the payload .mcp.json carries inside the devkit's server
// entry — one per-tool block per roster tool, roster-driven so a
// registration PR widens the yield with the roster, not by hand. JSON
// object key order matches the roster order; callers that deep-compare
// should compare structurally, not by serialization.
export function codexApprovalToolsBlock(): Record<string, { approval_mode: string }> {
  return Object.fromEntries(APPROVAL_TOOLS.map((tool) => [tool, { approval_mode: CODEX_APPROVAL_MODE }]));
}

// The ask-mode env half of the payload posture, as a record for entry writes
// (writeMcpServersFile merges it under the same `agentKey !== 'openclaw'`
// condition as the tools block, with the same wholesale drift healing).
export function codexApprovalEnv(): Record<string, string> {
  return { DEVKIT_APPROVAL_MODE: CODEX_APPROVAL_MODE_ENV };
}

// ── Reading the yield ──

// The effective state of one roster tool's approval_mode.
//   approve  the yield value — the call runs straight through
//   prompt   an Allow/Cancel dialog fires ahead of the server's confirmation
//   auto     codex's 4-option gate (with persistence) fires ahead of it
//   foreign  any other value (e.g. "writes"), or no approval_mode key
//   absent   no entry for the tool
export type CodexApprovalState = 'approve' | 'prompt' | 'auto' | 'foreign' | 'absent';

function classifyMode(mode: string | undefined): CodexApprovalState {
  if (mode === 'approve' || mode === 'prompt' || mode === 'auto') return mode;
  return mode === undefined ? 'absent' : 'foreign';
}

// The per-tool states from a parsed .mcp.json (the payload shape codex's
// plugin loader reads): mcpServers.<server>.tools.<tool>.approval_mode. A
// file without our server entry reads as all-absent (a foreign server map
// never leaks in — asRecord drops nothing, the server key is exact).
export function readMcpJsonApprovalStates(
  config: Record<string, unknown>,
  tools: readonly string[] = APPROVAL_TOOLS,
): CodexApprovalState[] {
  const server = asRecord(asRecord(config.mcpServers)[APPROVAL_MCP_SERVER]);
  const blocks = asRecord(server.tools);
  return tools.map((tool) => {
    const mode = asRecord(blocks[tool]).approval_mode;
    return classifyMode(typeof mode === 'string' ? mode : undefined);
  });
}

// Any mcp_servers tool table header in config.toml: the server segment is
// captured so the reader can pin the devkit's own server name instead of a
// regex that would silently accept a lookalike server. Trailing comments
// are tolerated (valid TOML) so a commented header still reads as the block
// it is, not as absence.
const BLOCK_HEADER_RE = /^\s*\[mcp_servers\.([A-Za-z0-9_-]+)\.tools\.([A-Za-z0-9_-]+)\]\s*(?:#.*)?$/;
const APPROVAL_MODE_LINE_RE = /^\s*approval_mode\s*=\s*"([^"]*)"\s*(?:#.*)?$/;
const ANY_TABLE_RE = /^\s*\[/;

// Reads every roster tool's per-tool state from the USER's config.toml
// text — the config-layer override channel, which the upstream source
// resolves BEFORE the plugin payload, so a value here wins over our yield.
// A block runs from its header to the next table header (or EOF); the FIRST
// approval_mode assignment in the body decides. Blocks under a different
// server name, or on a non-roster tool, are the user's own config and never
// read.
export function readCodexApprovalBlocks(text: string, tools: readonly string[] = APPROVAL_TOOLS): CodexApprovalState[] {
  const wanted = new Set(tools);
  const state = new Map<string, CodexApprovalState>(tools.map((tool) => [tool, 'absent' as const]));
  let inBlock: string | null = null;
  let mode: string | undefined;
  const closeBlock = (): void => {
    if (inBlock !== null) state.set(inBlock, classifyMode(mode));
    inBlock = null;
    mode = undefined;
  };
  for (const line of text.split(/\r?\n/)) {
    const header = BLOCK_HEADER_RE.exec(line);
    if (header) {
      closeBlock();
      if (header[1] === APPROVAL_MCP_SERVER && wanted.has(header[2]!)) inBlock = header[2]!;
      continue;
    }
    if (inBlock === null || mode !== undefined) continue;
    const assignment = APPROVAL_MODE_LINE_RE.exec(line);
    if (assignment) mode = assignment[1];
  }
  closeBlock();
  return tools.map((tool) => state.get(tool)!);
}

// codex's granular approval policy, measured on 0.167.2: with
// `mcp_elicitations = false` codex auto-declines every server form and
// substitutes its built-in gate, so every roster call fails CLOSED at the
// devkit gate until the policy is on. codex accepts TWO spellings of the
// value (both live-measured): the [approval_policy.granular] table and
// the inline table `approval_policy = { granular = { mcp_elicitations =
// false, … } }` — the inline spelling is exactly the machine the
// remediation-naming contract exists for, so the detector is a whole-file
// match on the false spelling. The negative lookbehind keeps lookalike
// keys (`allow_mcp_elicitations = false`) from tripping it; `true` is the
// healthy granular spelling and never does.
export function codexElicitPolicyOff(text: string): boolean {
  return /(?<![A-Za-z_])mcp_elicitations\s*=\s*false\b/.test(text);
}

// A top-level `approval_policy = "never"` blocks MCP tool calls outright,
// ahead of the devkit gate. TOML pins top-level keys before the first table
// header, so the scan stops at the first header — a [projects.*]-scoped
// spelling must not be misread as the machine's posture.
export function codexApprovalPolicyNever(text: string): boolean {
  for (const line of text.split(/\r?\n/)) {
    if (ANY_TABLE_RE.test(line)) return false;
    if (/^\s*approval_policy\s*=\s*"never"\s*(#.*)?$/.test(line)) return true;
  }
  return false;
}

// The user-override spellings codex honors that this doctor cannot parse
// (a full TOML parser is deliberately out of scope): dotted keys
// (mcp_servers.<server>.tools.<tool>.approval_mode = "…") and inline
// tables (tools = { <tool> = { approval_mode = "…" } } inside our server's
// section). Both live-verified to win over the payload, so a value in
// either shape must never read as absence — the doctor reports the
// dialect instead, the same honesty as the unreadable-config WARN.
export function codexOverridesUnparseableDialect(text: string): boolean {
  let inOurServer = false;
  for (const line of text.split(/\r?\n/)) {
    const header = /^\s*\[mcp_servers\.([A-Za-z0-9_-]+)[.\]]/.exec(line);
    if (header) {
      inOurServer = header[1] === APPROVAL_MCP_SERVER;
      continue;
    }
    if (ANY_TABLE_RE.test(line)) {
      inOurServer = false;
      continue;
    }
    const dotted = /^\s*mcp_servers\.([A-Za-z0-9_-]+)\.tools\./.exec(line);
    if (dotted && dotted[1] === APPROVAL_MCP_SERVER) return true;
    if (inOurServer && /^\s*tools\s*=\s*\{/.test(line)) return true;
  }
  return false;
}

// ── The payload candidates (what codex actually loads) ──

// The devkit plugin's cache dir under CODEX_HOME — the CLI marketplace
// flow's payload home. CODEX_HOME mirrors the resolution codex.ts's cache
// cleanup uses; codex resolves its whole home from this override.
export function codexPluginCacheDir(): string {
  return join(
    process.env.CODEX_HOME || join(homedir(), '.codex'),
    'plugins',
    'cache',
    getMarketplaceName(),
    getCodexPluginName(),
  );
}

// Every .mcp.json under the cache dir (one per version dir). Every copy is
// verified, not just the newest: which version codex loads is codex's
// call, and a stale copy missing the yield changes that machine's posture.
// A missing cache dir reads as no candidates (not installed that way).
export function codexCacheMcpJsonPaths(): string[] {
  const cacheDir = codexPluginCacheDir();
  if (!existsSync(cacheDir)) return [];
  let entries: string[];
  try {
    entries = readdirSync(cacheDir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of entries) {
    const path = join(cacheDir, name, '.mcp.json');
    try {
      if (statSync(path).isFile()) out.push(path);
    } catch {
      // unreadable or not a file — not a candidate
    }
  }
  return out;
}

// The Codex Desktop payload's .mcp.json (the desktop deploy's plugin dir).
export function codexDesktopMcpJsonPath(): string {
  return join(codexDesktopPluginsDir(), '.mcp.json');
}

// The doctor's shared reading: which roster tools sit in each non-approve
// state. Both channels (payload .mcp.json, config.toml overrides) ask the
// same question, so the derivation has one home.
function toolsInStates(
  states: readonly CodexApprovalState[],
): Record<'prompt' | 'auto' | 'foreign' | 'absent', string> {
  const names = (wanted: CodexApprovalState): string =>
    APPROVAL_TOOLS.filter((_tool, index) => states[index] === wanted).join(', ');
  return {
    prompt: names('prompt'),
    auto: names('auto'),
    foreign: names('foreign'),
    absent: names('absent'),
  };
}

// The payload half of the doctor row: every cached copy that carries our
// server must carry the full yield; a stale or hand-stripped copy is
// drift, healable by re-running the install (the payload is regenerated
// wholesale). A relevant machine with NO payload file at all gets a WARN,
// never a vacuous pass — the yield cannot be verified without the file
// codex reads it from.
function payloadDriftWarns(payloadPaths: readonly string[]): string[] {
  const warns: string[] = [];
  if (payloadPaths.length === 0) {
    warns.push(
      `no devkit payload .mcp.json was found in the codex plugin cache or the Codex Desktop plugin dir, so the yield cannot be verified (${RERUN})`,
    );
    return warns;
  }
  for (const path of payloadPaths) {
    let config: Record<string, unknown>;
    let states: CodexApprovalState[];
    try {
      config = asRecord(JSON.parse(readFileSync(path, 'utf8')));
      states = readMcpJsonApprovalStates(config);
    } catch {
      warns.push(`${path} is unparseable, so its yield cannot be verified (${RERUN})`);
      continue;
    }
    // The env half: a copy that carries our server entry but not the ask env
    // runs the devkit in token mode (a stale pre-ask payload) — drift,
    // healable by the same re-run.
    if (
      asRecord(asRecord(asRecord(config.mcpServers)[APPROVAL_MCP_SERVER]).env).DEVKIT_APPROVAL_MODE !==
      CODEX_APPROVAL_MODE_ENV
    ) {
      warns.push(
        `${path} does not set DEVKIT_APPROVAL_MODE="${CODEX_APPROVAL_MODE_ENV}" in the server env, so the devkit runs its default token mode under codex (${RERUN})`,
      );
    }
    if (states.every((state) => state === 'approve')) continue;
    const { prompt, auto, foreign, absent } = toolsInStates(states);
    if (prompt) warns.push(`approval_mode "prompt" on ${prompt} in ${path} (double interaction) (${RERUN})`);
    if (auto)
      warns.push(
        `approval_mode "auto" on ${auto} in ${path} keeps codex's own gate ahead of the devkit's confirmation (${RERUN})`,
      );
    if (foreign)
      warns.push(
        `approval_mode on ${foreign} in ${path} is not "approve", so codex's own approval gate may fire ahead of the devkit's confirmation (${RERUN})`,
      );
    if (absent) warns.push(`the approve block is missing for ${absent} in ${path} (${RERUN})`);
  }
  return warns;
}

// ── The doctor row ──

const CODEX_POSTURE_LABEL = 'Codex approval posture';
const RERUN = 're-run: npx huaweicloud-devkit install --target codex (or update)';

// Verifies the yield where codex reads it. Self-gating, silent on machines
// the devkit has no codex relationship with: no payload .mcp.json (cache or
// desktop), no codex plugin answering installed, no desktop marketplace
// registration. `desktopRegistered` is passed in by the doctor shell
// (codexDesktopDoctorMcpConfigured already runs there as an MCP-configured
// candidate).
export function codexDoctorApprovalRow(ctx: DoctorReporter, desktopRegistered: boolean): void {
  const payloadPaths = [...codexCacheMcpJsonPaths(), codexDesktopMcpJsonPath()].filter((p) => existsSync(p));

  // The user override + policy channel. An absent config.toml is the
  // healthy no-overrides default (nothing to warn about); a present but
  // unreadable one cannot be verified, which earns a WARN below when the
  // machine has a devkit payload.
  const configPath = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'config.toml');
  let configText: string | null = null;
  let configUnreadable = false;
  try {
    configText = readFileSync(configPath, 'utf8');
  } catch (error) {
    configUnreadable = (error as NodeJS.ErrnoException).code !== 'ENOENT';
  }

  let relevant = payloadPaths.length > 0 || desktopRegistered;
  if (!relevant) {
    const probe = codexPluginProbe();
    relevant = probe.ok && probe.installed;
  }
  if (!relevant) return;

  // 1. The payload half — every copy that carries our server must carry
  //    the full yield; a stale or hand-stripped copy is drift, healable by
  //    re-running the install (the payload is regenerated wholesale).
  const payloadWarns = payloadDriftWarns(payloadPaths);

  // 2. The user override half (config.toml) — a value here WINS over the
  //    payload (the config layer resolves first, upstream source), so it
  //    decides the machine's actual posture; WARN, never FAIL: no client
  //    value fails anything open. Overrides in a dialect this doctor cannot
  //    parse (dotted keys, inline tables) get the dialect WARN, never
  //    silence — reading them as absence would hide the winning value.
  const overrideWarns: string[] = [];
  if (configText !== null) {
    if (codexOverridesUnparseableDialect(configText)) {
      overrideWarns.push(
        `the user's config.toml carries per-tool overrides in a dialect this doctor cannot parse (dotted keys or inline tables), so the winning values cannot be verified — codex's own approval gate may fire ahead of the devkit's confirmation`,
      );
    }
    const { prompt, auto, foreign } = toolsInStates(readCodexApprovalBlocks(configText));
    if (prompt) {
      overrideWarns.push(
        `the user's config.toml sets approval_mode "prompt" on ${prompt}, which wins over the payload and shows codex's own Allow/Cancel dialog ahead of the devkit's confirmation (double interaction)`,
      );
    }
    if (auto) {
      overrideWarns.push(
        `the user's config.toml sets approval_mode "auto" on ${auto}, which wins over the payload and keeps codex's own approval gate (with persistence options) ahead of the devkit's confirmation`,
      );
    }
    if (foreign) {
      overrideWarns.push(
        `the user's config.toml sets approval_mode on ${foreign}, which wins over the payload — codex's own approval gate may fire ahead of the devkit's confirmation`,
      );
    }
  }

  // 3. The policy directions, both config.toml-borne.
  const policyWarns: string[] = [];
  if (configText !== null) {
    if (codexElicitPolicyOff(configText)) {
      policyWarns.push(
        `codex's granular policy sets mcp_elicitations = false, so codex auto-declines every devkit confirmation form and every roster call fails closed at the devkit gate until the policy is on — flip it: set mcp_elicitations = true (or drop the granular approval_policy) in ${configPath}`,
      );
    }
    if (codexApprovalPolicyNever(configText)) {
      policyWarns.push(
        `approval_policy = "never" blocks MCP tool calls outright, ahead of the devkit gate — choose a policy that can ask, e.g. approval_policy = "on-request"`,
      );
    }
  } else if (configUnreadable) {
    // A devkit payload exists but the override channel is unreadable, so
    // user per-tool overrides and the approval policy cannot be verified.
    overrideWarns.push(
      `the codex config at ${configPath} is unreadable, so user per-tool overrides and the approval policy cannot be verified`,
    );
  }

  const warns = [...payloadWarns, ...overrideWarns, ...policyWarns];
  if (warns.length === 0) {
    ctx.check(
      `${CODEX_POSTURE_LABEL} (${APPROVAL_TOOLS.length} per-tool approve blocks + DEVKIT_APPROVAL_MODE="${CODEX_APPROVAL_MODE_ENV}" in the devkit payload)`,
      true,
      '',
    );
  } else {
    ctx.warn(`${CODEX_POSTURE_LABEL}: ${warns.join(' ')}`);
  }
}
