// The OpenCode config-writer family, split out of agents/opencode.ts for the
// complex-file bar: the jsonc-tolerant mcp config writer (with the
// skills-tree permission seam as its third change source), the config
// remover (seam cleanup included), and the seam's version gate + glob set.
// The pure seam merge/cleanup logic lives in lib/opencode-permission-seam.ts
// (deliberately fs/spawn-free); the deploy/uninstall/status lifecycle and
// the doctor sections stay in agents/opencode.ts.

import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';

import { opencodeConfigFile, opencodePluginsDir, opencodeSkillsDir } from '../targets.ts';
import { applyPacksToEntry } from '../packs-policy.ts';
import { mergeCommandStyle, extractUserDelta, applyUserDelta } from '../mcp-config-merge.ts';
import { saveAgentDelta, takeAgentDelta } from '../mcp-config-backup.ts';
import { readJsonRecord, writeMcpSettingsFile } from '../mcp-config-io.ts';
import {
  applySkillTreePermissionSeam,
  opencodeSeamVersionSupported,
  removeSkillTreePermissionSeam,
  skillTreePermissionGlobs,
} from '../lib/opencode-permission-seam.ts';
import {
  ASK_RULE_ACTION,
  applyAskPermissionRule,
  opencodeAskRuleVersionSupported,
  removeAskPermissionRule,
} from '../lib/opencode-ask-rule.ts';
import { asRecord } from '../lib/as-record.ts';
import { devkitOwnedSkillNames, tryCoreSkillNames } from '../install-payload.ts';

// The seam's version gate. HUAWEICLOUD_OPENCODE_PERMISSION_SEAM=on|off is
// the deterministic override for the installer test suite (e2e strips it —
// the runner's install relies on the natural probe, and the e2e driver's
// own probe gate demands a floor-eligible opencode anyway); unset runs the
// probe. Unknown polarity is skip: a below-floor, absent, or unparsable
// opencode gets no key writes and a README pointer, never a paste snippet —
// an older version may reject the keys outright. A later update heals the
// skip: the seam is a third change source in updateOpenCodeConfig, so an
// unchanged mcp config no longer short-circuits.
function probeOpencodeVersion(): string | null {
  // The probe runs the agent's own binary, which initializes its config
  // root on every run — so the probe must pin that root to a throwaway
  // mkdtemp directory instead of inheriting the caller's XDG/HOME: a
  // relative XDG_CONFIG_HOME makes opencode materialize dirs against its
  // cwd (the known 1.19.0 divergence cross-platform-install.test.ts
  // pins), and an inherited HOME would create legacy ~/.config/opencode
  // roots in fake-home installs. A fixed shared name would be clippable
  // on multi-user machines, so the root is per-run and best-effort
  // cleaned. The version string never depends on the config root. The
  // win32 retries cover npm-global .cmd shims (spawn cannot execute them
  // without a shell — the hasCodexCLI precedent; the shell string is a
  // fixed literal, no interpolation surface).
  let probeRoot: string;
  try {
    probeRoot = mkdtempSync(join(tmpdir(), 'devkit-opencode-probe-'));
  } catch {
    return null;
  }
  const probeEnv = { ...process.env, XDG_CONFIG_HOME: probeRoot };
  const run = (cmd: string, shell: boolean): string | null => {
    try {
      // Args ride the command string whenever shell is true: an args array
      // under shell is DEP0190 on Node 24+ (and would double the --version
      // the win32 fallback string already carries). Without a shell the
      // array stays — spawn needs the separated argument there.
      const r = spawnSync(cmd, shell ? undefined : ['--version'], {
        shell,
        windowsHide: true,
        stdio: 'pipe',
        timeout: 10000,
        cwd: tmpdir(),
        env: probeEnv,
      });
      if (r.status === 0 && r.stdout) return r.stdout.toString();
    } catch {
      // not on PATH in this spelling — fall through to the next attempt
    }
    return null;
  };
  let out = run('opencode', false);
  if (out === null && process.platform === 'win32') {
    out = run('opencode.exe', false) ?? run('opencode --version', true);
  }
  try {
    rmSync(probeRoot, { recursive: true, force: true });
  } catch {
    // best-effort: a leftover probe dir is inert
  }
  return out !== null ? (/v?\d+\.\d+\.\d+/.exec(out)?.[0] ?? null) : null;
}

export function openCodeSeamGate(): 'on' | 'off' {
  const forced = process.env.HUAWEICLOUD_OPENCODE_PERMISSION_SEAM;
  if (forced === 'on' || forced === 'off') return forced;
  return opencodeSeamVersionSupported(probeOpencodeVersion()) ? 'on' : 'off';
}

// The ask rule's version gate, same doctrine as the seam's:
// HUAWEICLOUD_OPENCODE_ASK_RULE=on|off is the deterministic override for
// the installer test suite (e2e strips it — the runner's install relies on
// the natural probe); unset runs the probe. Unknown polarity is off: the
// `permissions` array is the V2 shape measured on 2.2.7 only, so a
// below-2.0, absent, or unparsable opencode writes NEITHER half of the
// posture — the client rule without the server env double-gates, the env
// without the rule fail-opens, and the pair must move together.
export function openCodeAskGate(): 'on' | 'off' {
  const forced = process.env.HUAWEICLOUD_OPENCODE_ASK_RULE;
  if (forced === 'on' || forced === 'off') return forced;
  return opencodeAskRuleVersionSupported(probeOpencodeVersion()) ? 'on' : 'off';
}

// The server half of the ask posture: DEVKIT_APPROVAL_MODE=ask in the mcp
// entry's environment (the field OpenCode reads — the applyPacksToEntry
// 'environment' precedent). Add-only-if-absent with the packs-write
// doctrine: a user-set value other than 'ask' is theirs and wins with a
// one-line WARN; 'ask' already present needs no write. An absent or empty
// environment object is created. No delete path: uninstall removes the
// whole mcp entry wholesale. Runs ONLY under the ask gate — see
// openCodeAskGate for why the halves must move together.
function applyApprovalModeToEntry(entry: Record<string, unknown>): boolean {
  const env = asRecord(entry.environment);
  const current = env.DEVKIT_APPROVAL_MODE;
  if (current === 'ask') return false;
  if (current !== undefined) {
    const shown = typeof current === 'string' ? current : JSON.stringify(current);
    console.log(
      `  \x1b[33m[WARN]\x1b[0m OpenCode mcp entry already sets DEVKIT_APPROVAL_MODE=${shown} — keeping the user's value; it may not match the permissions ask rule (see README, Harness permission notes).`,
    );
    return false;
  }
  entry.environment = { ...env, DEVKIT_APPROVAL_MODE: 'ask' };
  return true;
}

// The glob set the seam covers: the plugin-dir tree actually deployed by
// this run plus per-skill globs for the native core meta-skill copies
// (under the XDG opencode skills dir). An unusable manifest degrades to the
// tree listing (devkitOwnedSkillNames, readdir) rather than dropping the
// native globs: uninstall removes the native copies by that same
// listing, so the seam cleanup must not leave per-skill allows behind
// over directories the uninstall just deleted.
export function openCodeSeamGlobs(pluginDir: string): string[] {
  const core = tryCoreSkillNames() ?? devkitOwnedSkillNames();
  return skillTreePermissionGlobs(join(pluginDir, 'skills'), opencodeSkillsDir(), [...core]);
}

export function updateOpenCodeConfig(pluginDir: string): void {
  const configPath = opencodeConfigFile();
  const mcpPath = join(pluginDir, 'dist', 'mcp-server.js').replace(/\\/g, '/');
  const read = readJsonRecord(configPath);
  if (read.status === 'invalid') {
    console.log(
      `  \x1b[33m[WARN]\x1b[0m Could not parse ${configPath} (jsonc comments?). Skipping MCP config write; ensure "mcp.huaweicloud-devkit" points to ${mcpPath}, and add the skills-tree permission rules manually (see README, Harness permission notes).`,
    );
    return;
  }
  const config: Record<string, unknown> = read.status === 'ok' ? read.value : {};
  // The skills-tree permission seam is a THIRD change source, computed
  // before the unchanged short-circuit below: a reinstall whose mcp entry
  // and packs value are identical is the dominant update shape, and every
  // install made before this seam existed is exactly the population it
  // must heal — an early "config unchanged" return would skip the write
  // forever. Parse-fail above stays the only skip path. The seam mutates
  // config in place (add-only-if-absent per section; ownership rules in
  // lib/opencode-permission-seam.ts), so the single write below carries it.
  let permChanged = false;
  if (openCodeSeamGate() === 'on') {
    const seam = applySkillTreePermissionSeam(config, openCodeSeamGlobs(pluginDir));
    permChanged = seam.changed;
    for (const section of seam.skipped) {
      console.log(
        `  \x1b[33m[WARN]\x1b[0m opencode permission${section === 'permission' ? '' : `.${section}`} is not object-shaped — keeping the user's value; add the skills-tree rules manually (see README, Harness permission notes).`,
      );
    }
    if (permChanged) {
      console.log(`  Skills-tree permission (external_directory allow + edit deny) -> ${configPath}`);
    }
  } else {
    console.log(
      '  \x1b[33m[INFO]\x1b[0m opencode not verifiably at or above the measured permission floor — skipping the skills-tree permission write; see README (Harness permission notes) if direct skill reads prompt for approval.',
    );
  }
  const askOn = openCodeAskGate() === 'on';
  // The ask rule is a FOURTH change source, computed before the unchanged
  // short-circuit for the same reason as the seam: an unchanged mcp entry
  // is the dominant update shape, and every install made before the ask
  // posture existed is exactly the population this must heal. The rule
  // mutates config in place (ownership rules in lib/opencode-ask-rule.ts),
  // so the single write below carries it.
  let askRuleChanged = false;
  if (askOn) {
    const applied = applyAskPermissionRule(config);
    askRuleChanged = applied.changed;
    if (applied.skipped) {
      console.log(
        `  \x1b[33m[WARN]\x1b[0m opencode permissions already has an entry for ${ASK_RULE_ACTION} — keeping it as the user's (the posture follows its effect; see README, Harness permission notes).`,
      );
    }
  } else {
    console.log(
      '  \x1b[33m[INFO]\x1b[0m opencode not verifiably at or above 2.0 — keeping the terminal token approval gate; no permissions ask rule or DEVKIT_APPROVAL_MODE is written.',
    );
  }
  const existing: unknown = asRecord(config.mcp)['huaweicloud-devkit'];
  if (existing) {
    const { entry, changed } = mergeCommandStyle(existing, { mcpPath });
    const packsChanged = applyPacksToEntry(entry, 'environment', 'OpenCode');
    const askEnvChanged = askOn && applyApprovalModeToEntry(entry);
    if (!changed && !packsChanged && !permChanged && !askRuleChanged && !askEnvChanged) {
      console.log(`  OpenCode MCP config unchanged: ${configPath}`);
      return;
    }
    const mcpMap = asRecord(config.mcp);
    mcpMap['huaweicloud-devkit'] = entry;
    config.mcp = mcpMap;
    writeMcpSettingsFile(configPath, config);
    console.log(`  OpenCode MCP config merged (user fields preserved): ${configPath}`);
    if (askRuleChanged || askEnvChanged) {
      console.log(`  ASK approval (permissions ask rule + DEVKIT_APPROVAL_MODE) -> ${configPath}`);
    }
    return;
  }
  const mcpMap: Record<string, unknown> = asRecord(config.mcp);
  let entry = mergeCommandStyle(undefined, { mcpPath }).entry;
  // Restore user fields saved by a previous uninstall (issue #615) before the
  // packs write so a delta-carried DEVKIT_PACKS counts as the current value.
  const delta = takeAgentDelta('opencode');
  if (delta) entry = asRecord(applyUserDelta(entry, delta, 'command'));
  applyPacksToEntry(entry, 'environment', 'OpenCode');
  const askEnvChanged = askOn && applyApprovalModeToEntry(entry);
  mcpMap['huaweicloud-devkit'] = entry;
  config.mcp = mcpMap;
  writeMcpSettingsFile(configPath, config);
  console.log(`  OpenCode config updated: ${configPath}`);
  if (askRuleChanged || askEnvChanged) {
    console.log(`  ASK approval (permissions ask rule + DEVKIT_APPROVAL_MODE) -> ${configPath}`);
  }
}

export function removeOpenCodeConfig(): void {
  const configPath = opencodeConfigFile();
  const read = readJsonRecord(configPath);
  if (read.status !== 'ok') return;
  const config = read.value;
  const mcpMap = asRecord(config.mcp);
  const hadEntry = Boolean(mcpMap['huaweicloud-devkit']);
  if (hadEntry) {
    // Back up user-customized fields before removal so a later reinstall can restore them (issue #615).
    const delta = extractUserDelta(mcpMap['huaweicloud-devkit'], 'command');
    if (delta) saveAgentDelta('opencode', delta);
    delete mcpMap['huaweicloud-devkit'];
    config.mcp = mcpMap;
    if (Object.keys(mcpMap).length === 0) delete config.mcp;
  }
  // The seam cleanup runs independently of the mcp entry: a config may
  // carry the seam from an install whose mcp entry was later removed by
  // hand. Globs derive from the stable XDG paths (the plugin dir may
  // already be gone) and the running package's own manifest;
  // value-exact deletion keeps user-modified rules (the ownership contract
  // lives in lib/opencode-permission-seam.ts).
  const permCleaned = removeSkillTreePermissionSeam(config, openCodeSeamGlobs(opencodePluginsDir()));
  // The ask-rule cleanup also runs unconditionally of the version gate: an
  // uninstall must remove what any past install wrote — the opencode that
  // gated the write may since have been upgraded, downgraded, or removed
  // from PATH. Value-exact deletion keeps user-modified entries (the
  // ownership contract lives in lib/opencode-ask-rule.ts); the mcp entry
  // (and its DEVKIT_APPROVAL_MODE env) is already gone wholesale above.
  const askCleaned = removeAskPermissionRule(config);
  if (!hadEntry && !permCleaned && !askCleaned) return;
  writeMcpSettingsFile(configPath, config);
  if (hadEntry) console.log(`  OpenCode MCP config cleaned: ${configPath}`);
  if (permCleaned) console.log(`  Skills-tree permission rules removed: ${configPath}`);
  if (askCleaned) console.log(`  ASK permission rule removed: ${configPath}`);
}
