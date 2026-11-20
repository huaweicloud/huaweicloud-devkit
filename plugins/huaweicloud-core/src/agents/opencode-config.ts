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
  payloadEditDenyGlobs,
  removeSkillTreePermissionSeam,
  skillTreePermissionGlobs,
} from '../lib/opencode-permission-seam.ts';
import {
  applyAllowPermissionRules,
  applyAllowPermissionRulesV1,
  askRuleShapeFor,
  removeAllowPermissionRules,
  removeAllowPermissionRulesV1,
  removeAskPermissionRules,
  removeAskPermissionRulesV1,
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
// Spawned at most once per process: the seam gate, the ask gate, and the
// ask-shape probe under the 'on' override all ask the same question, and
// a second spawn in one process can only return the same answer.
function probeOpencodeVersion(): string | null {
  return probedVersion === undefined ? (probedVersion = probeOpencodeVersionUncached()) : probedVersion;
}

let probedVersion: string | null | undefined;

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
function probeOpencodeVersionUncached(): string | null {
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

// The ask gate's version gate, same doctrine as the seam's:
// HUAWEICLOUD_OPENCODE_ASK_RULE is the deterministic override for the
// installer test suite (e2e strips it — the runner's install relies on
// the natural probe); unset runs the probe. Polarity:
//   'off'      — neither half of the posture is written (token mode stays);
//                the legacy ask rules are still migrated away.
//   'v1'/'v2'  — force the rule SHAPE (the deterministic test matrix; the
//                env halves are identical across shapes).
//   'on'       — the probe decides the shape; an absent/unparsable
//                opencode falls back to the documented V2 array — the
//                override's contract since the posture landed.
// Unset with an unsupported opencode is 'off': the V2 array is measured on
// 2.2.7 and the V1 permission key is source-verified on 1.19.0, so a
// below-floor, absent, or unparsable opencode writes NEITHER half — the pair
// must move together.
export type OpenCodeAskGate = 'off' | 'v2-array' | 'v1-object';

export function openCodeAskGate(): OpenCodeAskGate {
  const forced = process.env.HUAWEICLOUD_OPENCODE_ASK_RULE;
  if (forced === 'off') return 'off';
  if (forced === 'v2') return 'v2-array';
  if (forced === 'v1') return 'v1-object';
  const shape = askRuleShapeFor(probeOpencodeVersion());
  if (shape !== 'unsupported') return shape;
  return forced === 'on' ? 'v2-array' : 'off';
}

// The safety gate's floor check: permission.hook("evaluate") is a V2
// surface (G1 measured the event shape, the "shell" action naming, and the
// deny semantics on 2.2.7; V1 named the action "bash" and had no evaluate
// hook), so the floor is the 2.0 major. Unparsable or absent stays
// unsupported — the caller's polarity is skip, never a guess.
export function opencodeSafetyGateVersionSupported(version: string | null): boolean {
  if (version === null) return false;
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  return match !== null && Number(match[1]) >= 2;
}

// The safety gate's version gate, same doctrine as the seam's:
// HUAWEICLOUD_OPENCODE_SAFETY_GATE=on|off is the deterministic override for
// the installer test suite (e2e strips it — the runner's install relies on
// the natural probe); unset runs the probe against the 2.0 floor. A
// below-floor, absent, or unparsable opencode gets no adapter file and a
// doctor SKIP, never a FAIL — 1.x has no evaluate hook to register on, and a
// later update heals the skip by deploying the file.
export function openCodeSafetyGate(): 'on' | 'off' {
  const forced = process.env.HUAWEICLOUD_OPENCODE_SAFETY_GATE;
  if (forced === 'on' || forced === 'off') return forced;
  return opencodeSafetyGateVersionSupported(probeOpencodeVersion()) ? 'on' : 'off';
}

// The server half of the ask posture: DEVKIT_APPROVAL_MODE=ask in the mcp
// entry's environment (the field OpenCode reads — the applyPacksToEntry
// 'environment' precedent). Ask mode now means the SERVER-RUN gate: the
// confirmation is raised inside the tool call (elicit-first, the T3 chat
// round-trip on a client that cannot render a form), and the client allow
// rules only suppress the redundant client popup ahead of it. Add-only-if-
// absent with the packs-write doctrine: a user-set value other than 'ask' is
// theirs and wins with a one-line WARN — and then NO client rules are
// written, because their posture stays mechanical. 'ask' already present
// needs no write. An absent or empty environment object is created. No delete
// path: uninstall removes the whole mcp entry wholesale.
type ApprovalModeOutcome = 'established' | 'present' | 'user';

function applyApprovalModeToEntry(entry: Record<string, unknown>): ApprovalModeOutcome {
  const env = asRecord(entry.environment);
  const current = env.DEVKIT_APPROVAL_MODE;
  if (current === 'ask') return 'present';
  if (current !== undefined) {
    const shown = typeof current === 'string' ? current : JSON.stringify(current);
    console.log(
      `  \x1b[33m[WARN]\x1b[0m OpenCode mcp entry already sets DEVKIT_APPROVAL_MODE=${shown} — keeping the user's value, so no client allow rules are kept (devkit-written ones are removed; see README, Harness permission notes).`,
    );
    return 'user';
  }
  entry.environment = { ...env, DEVKIT_APPROVAL_MODE: 'ask' };
  return 'established';
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
    const seam = applySkillTreePermissionSeam(config, openCodeSeamGlobs(pluginDir), payloadEditDenyGlobs(pluginDir));
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
  const askGate = openCodeAskGate();
  const askOn = askGate !== 'off';
  // The posture migration runs on EVERY path that touches the config, gate or
  // no gate: the abandoned ask rules from any earlier install are removed
  // value-exact in both generations, so the old posture never survives an
  // install or update. Both shapes are attempted independently (a config can
  // carry both, and the first removal must not short-circuit the second).
  const migratedV2 = removeAskPermissionRules(config);
  const migratedV1 = removeAskPermissionRulesV1(config);
  const migrated = migratedV2 || migratedV1;

  // The mcp entry's server half is resolved BEFORE the client rules: the
  // allow set is written only when the server gate is established this run or
  // already present, and a user-set mode value wins with no client rules.
  const existing: unknown = asRecord(config.mcp)['huaweicloud-devkit'];
  let entry: Record<string, unknown>;
  let entryChanged = false;
  let rebuilt = false;
  let approvalMode: ApprovalModeOutcome | 'off' = 'off';
  if (existing) {
    const merged = mergeCommandStyle(existing, { mcpPath });
    entry = merged.entry;
    entryChanged = merged.changed;
    if (applyPacksToEntry(entry, 'environment', 'OpenCode')) entryChanged = true;
    if (askOn) {
      approvalMode = applyApprovalModeToEntry(entry);
      if (approvalMode === 'established') entryChanged = true;
    }
  } else {
    entry = mergeCommandStyle(undefined, { mcpPath }).entry;
    // Restore user fields saved by a previous uninstall (issue #615) before the
    // packs write so a delta-carried DEVKIT_PACKS counts as the current value.
    const delta = takeAgentDelta('opencode');
    if (delta) entry = asRecord(applyUserDelta(entry, delta, 'command'));
    applyPacksToEntry(entry, 'environment', 'OpenCode');
    if (askOn) approvalMode = applyApprovalModeToEntry(entry);
    rebuilt = true;
  }

  // The client half — one exact allow rule per roster tool, no wildcard. Its
  // SHAPE rides the probed generation: the V2 permissions array on 2.0+, the
  // V1 permission object on 1.19–1.x (the roster action is byte-identical
  // across shapes, and the mcp env half is shared). It is a FOURTH change
  // source, computed before the unchanged short-circuit for the same reason
  // as the seam: an unchanged mcp entry is the dominant update shape, and
  // every install made before the posture existed is the population this
  // must heal.
  let clientChanged = false;
  let clientRemoved = false;
  if (askOn && approvalMode === 'user') {
    // The server half left the pair (the user's own mode value governs the
    // posture), so the client half leaves with it: any allow rules a past
    // install wrote are removed value-exact, both shapes independently (a
    // config can carry both). Without this, the doctor's mixed-state WARN
    // could never heal — re-running install would reproduce it forever.
    // After the removal the user's posture (token mode) is fully mechanical.
    const removedV2 = removeAllowPermissionRules(config);
    const removedV1 = removeAllowPermissionRulesV1(config);
    clientRemoved = removedV2 || removedV1;
  } else if (askOn) {
    const applied = askGate === 'v1-object' ? applyAllowPermissionRulesV1(config) : applyAllowPermissionRules(config);
    clientChanged = applied.changed;
    for (const action of applied.skipped) {
      console.log(
        askGate === 'v1-object'
          ? `  \x1b[33m[WARN]\x1b[0m opencode permission already has the ${action} key — keeping it as the user's, so no allow rule is written for it (see README, Harness permission notes).`
          : `  \x1b[33m[WARN]\x1b[0m opencode permissions already has an entry for ${action} — keeping it as the user's, so no allow rule is written for it (see README, Harness permission notes).`,
      );
    }
    if (applied.shapeUnreadable) {
      console.log(
        askGate === 'v1-object'
          ? `  \x1b[33m[WARN]\x1b[0m opencode permission is not object-shaped — keeping the user's global posture; add the client allow rules manually (see README, Harness permission notes).`
          : `  \x1b[33m[WARN]\x1b[0m opencode permissions is not array-shaped — keeping the user's value; add the client allow rules manually (see README, Harness permission notes).`,
      );
    }
  } else if (!askOn) {
    console.log(
      '  \x1b[33m[INFO]\x1b[0m opencode not verifiably at or above 1.19.0 — keeping the terminal token approval gate; no client allow rules or DEVKIT_APPROVAL_MODE is written.',
    );
  }
  if (rebuilt || entryChanged) {
    const mcpMap = asRecord(config.mcp);
    mcpMap['huaweicloud-devkit'] = entry;
    config.mcp = mcpMap;
  }
  if (!rebuilt && !entryChanged && !permChanged && !clientChanged && !migrated && !clientRemoved) {
    console.log(`  OpenCode MCP config unchanged: ${configPath}`);
    return;
  }
  writeMcpSettingsFile(configPath, config);
  console.log(
    rebuilt
      ? `  OpenCode config updated: ${configPath}`
      : `  OpenCode MCP config merged (user fields preserved): ${configPath}`,
  );
  if (migrated) {
    console.log(`  ASK posture migrated (legacy ask rules removed) -> ${configPath}`);
  }
  if (clientRemoved) {
    console.log(`  ASK client allow rules removed (DEVKIT_APPROVAL_MODE is the user's own) -> ${configPath}`);
  }
  if (clientChanged) {
    console.log(`  ASK approval (client allow rules + DEVKIT_APPROVAL_MODE server gate) -> ${configPath}`);
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
  // lives in lib/opencode-permission-seam.ts). The edit-only payload
  // class is removed under the same value-exact rule.
  const permCleaned = removeSkillTreePermissionSeam(
    config,
    openCodeSeamGlobs(opencodePluginsDir()),
    payloadEditDenyGlobs(opencodePluginsDir()),
  );
  // The client-rule cleanup also runs unconditionally of the version gate: an
  // uninstall must remove what any past install wrote — the opencode that
  // gated the write may since have been upgraded, downgraded, or removed from
  // PATH, and the rule's shape rode the generation that was current then. All
  // four shape/effect pairs are attempted independently (a config can carry
  // both generations, and the legacy ask rules as well as the allow set), each
  // value-exact so a user-modified rule survives — the ownership contract
  // lives in lib/opencode-ask-rule.ts. The mcp entry (and its
  // DEVKIT_APPROVAL_MODE env) is already gone wholesale above.
  const allowCleanedV2 = removeAllowPermissionRules(config);
  const allowCleanedV1 = removeAllowPermissionRulesV1(config);
  const askCleanedV2 = removeAskPermissionRules(config);
  const askCleanedV1 = removeAskPermissionRulesV1(config);
  const allowCleaned = allowCleanedV2 || allowCleanedV1;
  const askCleaned = askCleanedV2 || askCleanedV1;
  if (!hadEntry && !permCleaned && !allowCleaned && !askCleaned) return;
  writeMcpSettingsFile(configPath, config);
  if (hadEntry) console.log(`  OpenCode MCP config cleaned: ${configPath}`);
  if (permCleaned) console.log(`  Skills-tree permission rules removed: ${configPath}`);
  if (allowCleaned || askCleaned) console.log(`  ASK client permission rules removed: ${configPath}`);
}
