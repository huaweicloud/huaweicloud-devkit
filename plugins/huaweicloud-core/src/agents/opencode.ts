// The OpenCode agent module, split for the complex-file bar: this file
// keeps the command/plugin deployment, the install/update/uninstall/status
// lifecycle, and the doctor sections (the MCP-configured candidate and the
// skills-tree permission seam check arrive with the doctor refactor). The
// jsonc-tolerant config writers and the seam's version gate + glob set live
// in agents/opencode-config.ts.

import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  configRoot,
  opencodeCommandsDir,
  opencodeConfigFile,
  opencodePluginsDir,
  opencodeSkillsDir,
} from '../targets.ts';
import { printMcpConfigStatus } from '../mcp-config-io.ts';
import {
  PACKAGE_ROOT,
  copyDir,
  copyServerPayload,
  deployWord,
  installRuntimeDeps,
  payloadStatusLines,
  pruneStale,
  removeHuaweiCommandsFrom,
  removeIfExists,
  type DeployMode,
} from '../install-payload.ts';
import {
  removeOpenCodeConfig,
  updateOpenCodeConfig,
  openCodeSeamGate,
  openCodeSeamGlobs,
  openCodeAskGate,
  openCodeSafetyGate,
} from './opencode-config.ts';
import { readPermissionRules, readPermissionRulesV1, type RosterRuleState } from '../lib/opencode-ask-rule.ts';
import { scanSavedAllowRows } from '../lib/opencode-saved-perms.ts';
import { payloadEditDenyGlobs } from '../lib/opencode-permission-seam.ts';
import type { DoctorReporter } from '../doctor-report.ts';
import { asRecord } from '../lib/as-record.ts';

// Doctor: the OpenCode MCP-configured candidate — the opencode config's
// mcp.huaweicloud-devkit entry.
export function opencodeDoctorMcpConfigured(): string | null {
  const opencodeCfg = opencodeConfigFile();
  if (!existsSync(opencodeCfg)) return null;
  try {
    const cfg = asRecord(JSON.parse(readFileSync(opencodeCfg, 'utf8')));
    if (cfg.mcp && asRecord(cfg.mcp)['huaweicloud-devkit']) return 'OpenCode';
  } catch {
    // corrupt OpenCode config skips this candidate — the probe continues
  }
  return null;
}

// Doctor: the ASK approval posture check — OpenCode installs only. The
// posture is a PAIR the installer writes together: the client half (one exact
// allow rule per roster tool — a `permissions` array entry on 2.0+, a
// `permission` object key on 1.19–1.x, both naming the same actions) and the
// server half (DEVKIT_APPROVAL_MODE=ask in the mcp entry's env). Ask mode now
// means the SERVER-RUN gate: the confirmation is raised inside the tool call
// (elicitation form, or the T3 chat round-trip), so the client rules are
// yield-only — they suppress the redundant client popup — and a client allow
// rule can no longer fail anything open. The directions that survive the flip:
//   - a deny rule bricks the call in the client, so it stays a FAIL;
//   - a devkit-written ask rule is migration residue: FAIL, re-run install;
//   - missing client coverage while the server gate is on is drift: FAIL;
//   - allow rules without the server gate are the mixed state: WARN;
//   - an unreadable shape with the gate on is a WARN, never silent (the
//     verification's B2 invariant — the gate still holds server-side, so a
//     WARN is honest, not a FAIL);
//   - a user-owned rule on a roster action is surfaced by name with the skip
//     recorded, never silently dropped.
// A gate-off opencode is a SKIP — token mode is that install's legitimate
// posture, and the migration still removes the legacy ask rules.
export function opencodeDoctorAskRule(ctx: DoctorReporter): void {
  const gate = openCodeAskGate();
  if (gate === 'off') {
    ctx.skip('ASK approval posture (opencode not verifiably at or above 1.19.0)');
    return;
  }
  askPostureCheck(ctx, gate);
  savedAllowStoreCheck(ctx);
}

const ASK_POSTURE_LABEL = 'ASK approval posture (client allow rules + server gate)';

function askPostureCheck(ctx: DoctorReporter, gate: 'v2-array' | 'v1-object'): void {
  const v1 = gate === 'v1-object';
  let cfg: Record<string, unknown> | null;
  try {
    cfg = asRecord(JSON.parse(readFileSync(opencodeConfigFile(), 'utf8')));
  } catch {
    cfg = null;
  }
  if (cfg === null) {
    ctx.warn(
      `${ASK_POSTURE_LABEL}: the opencode config is unreadable, so the client half cannot be verified — the server gate still confirms every roster call; fix the file and re-run: npx huaweicloud-devkit install --target opencode`,
    );
    return;
  }
  const reading = v1 ? readPermissionRulesV1(cfg) : readPermissionRules(cfg);
  if (reading.sectionUnreadable) {
    ctx.warn(
      `${ASK_POSTURE_LABEL}: opencode ${v1 ? 'permission is not object-shaped' : 'permissions is not array-shaped'}, so the client half cannot be verified — the server gate still confirms every roster call; fix the shape and re-run: npx huaweicloud-devkit install --target opencode`,
    );
    return;
  }
  // The mcp entry carries the server half; a missing entry counts as no env.
  const env = asRecord(asRecord(asRecord(cfg.mcp)['huaweicloud-devkit']).environment);
  const gateOn = env.DEVKIT_APPROVAL_MODE === 'ask';
  const actionsIn = (state: RosterRuleState): string[] =>
    reading.rules.filter((rule) => rule.state === state).map((rule) => rule.action);
  const allow = actionsIn('allow');
  const absent = actionsIn('absent');
  const deny = actionsIn('deny');
  const foreign = actionsIn('foreign');
  const userOther = actionsIn('user-other');
  const residue = reading.rules.filter((rule) => rule.askResidue).map((rule) => rule.action);

  // Token mode with no client rules at all is the legitimate default posture.
  if (!gateOn && absent.length === reading.rules.length) {
    ctx.check('ASK approval posture (token mode)', true, '');
    return;
  }

  const fails: string[] = [];
  const warns: string[] = [];
  if (deny.length > 0) {
    fails.push(
      v1
        ? `the permission value on ${deny.join(', ')} is "deny" — the write tool is blocked outright in the client; delete that key`
        : `a permissions rule on ${deny.join(', ')} is "deny" — the write tool is blocked outright in the client; delete that rule`,
    );
  }
  if (residue.length > 0) {
    fails.push(
      `the devkit-written ask ${v1 ? 'value' : 'rule'} is still present on ${residue.join(', ')} — the posture migration missed it (re-run: npx huaweicloud-devkit install --target opencode)`,
    );
  }
  if (gateOn && absent.length > 0) {
    fails.push(
      `the client allow ${v1 ? 'value' : 'rule'} is missing on ${absent.join(', ')} while DEVKIT_APPROVAL_MODE=ask is set — the pair has drifted from what this installer writes (re-run: npx huaweicloud-devkit install --target opencode)`,
    );
  }
  if (!gateOn && allow.length > 0) {
    warns.push(
      `client allow ${v1 ? 'values' : 'rules'} on ${allow.join(', ')} are present but DEVKIT_APPROVAL_MODE=ask is missing from the mcp entry — the mixed state suppresses the client prompt while the server runs the token gate (re-run: npx huaweicloud-devkit install --target opencode)`,
    );
  }
  if (userOther.length > 0) {
    warns.push(
      `a user-owned ${v1 ? 'permission value' : 'rule'} on ${userOther.join(', ')} covers a different resource, so the installer keeps it (skip recorded) and no exact "*" allow rule is written there (see README, Harness permission notes)`,
    );
  }
  if (foreign.length > 0) {
    warns.push(
      `the ${v1 ? 'permission value' : 'permissions rule'} on ${foreign.join(', ')} is not a readable effect, so the client half cannot be verified there`,
    );
  }
  if (fails.length > 0) {
    ctx.check(ASK_POSTURE_LABEL, false, [...fails, ...warns].join(' '));
  } else if (warns.length > 0) {
    ctx.warn(`${ASK_POSTURE_LABEL}: ${warns.join(' ')}`);
  } else {
    ctx.check(ASK_POSTURE_LABEL, true, '');
  }
}

// Doctor: the opencode saved-permission store, the client-side twin of the
// ask rule. One "Always allow" click on the client prompt persists an allow
// row that opencode evaluates AFTER the configured rules (findLast), so it
// silently converts every future call on the action into an unprompted
// execution of opencode's own permission layer. That no longer gates anything
// the devkit relies on: the confirmation runs on the server (the gate raises
// the form, or the T3 chat round-trip), inside the tool call and outside
// opencode's evaluation. The row is therefore a stale grant, reported as a
// WARN with the probe-measured removal commands, not a failing gate. Zero rows
// prints nothing at all (the healthy fresh state), so a clean install's
// doctor output stays byte-identical.
function savedAllowStoreCheck(ctx: DoctorReporter): void {
  const scan = scanSavedAllowRows({ scope: 'all' });
  if (scan.status === 'absent') return;
  if (scan.status === 'unreadable') {
    ctx.warn(
      `ASK approval hygiene: opencode saved-permission store unreadable (${scan.dbPath}): ${scan.detail} — saved "always allow" rows cannot be listed`,
    );
    return;
  }
  if (scan.rows.length === 0) return;
  // WARN, not FAIL (PR-1.5 demotion): the confirmation runs server-side, so a
  // saved client-side allow row can no longer suppress it (the form is raised
  // inside the tool call and never routes through opencode's permission
  // evaluation). The row is a stale grant worth cleaning up, not a gate.
  const actions = [...new Set(scan.rows.map((row) => row.action))].join(', ');
  ctx.warn(
    `ASK approval hygiene: opencode's permission store holds a saved "always allow" rule for ${actions} — the server-run confirmation ignores it, so calls are not fail-open; the row is still a stale grant. List them: opencode api GET /api/permission/saved. Remove one: opencode api DELETE /api/permission/saved/<id>. It lives in ${scan.dbPath}, table "permission".`,
  );
  for (const row of scan.rows) {
    ctx.raw(`        ${row.id} → ${row.projectWorktree ?? row.projectId} (action ${row.action})`);
  }
}

// Doctor: the skills-tree permission seam check — OpenCode installs only
// (the seam is the installer's zero-prompt path for direct skill reads on
// that harness). Verifies the keys and their values over BOTH glob classes,
// honoring the ownership contract: a user-owned value on a devkit glob is
// reported as kept, not broken; a below-floor or absent opencode is a SKIP,
// never a FAIL.
export function opencodeDoctorSeam(ctx: DoctorReporter): void {
  if (openCodeSeamGate() === 'off') {
    ctx.skip('Skills-tree permission seam (opencode not verifiably at or above the measured permission floor)');
    return;
  }
  // Per-glob, two-class evaluation, matching the installer's per-section
  // contract exactly: user-owned globs (any non-devkit value) are reported
  // as kept, missing globs as healable — one user-owned glob must never
  // mask a healable gap. The edit-only class (the payload root — the
  // classifier the in-process gate imports) requires just the edit deny:
  // the external allow is deliberately absent there, so requiring it would
  // fail every healthy install. Configs the installer itself refuses to
  // touch (scalar-shaped permission, unparseable file — the parse-fail
  // skip is the install path's ONLY skip) get a SKIP with the manual
  // pointer, never a FAIL whose re-run-install remediation cannot succeed.
  const globs = openCodeSeamGlobs(opencodePluginsDir());
  const editOnlyGlobs = payloadEditDenyGlobs(opencodePluginsDir());
  let cfg: Record<string, unknown> | null;
  try {
    cfg = asRecord(JSON.parse(readFileSync(opencodeConfigFile(), 'utf8')));
  } catch {
    cfg = null;
  }
  const permission = cfg !== null ? cfg.permission : undefined;
  if (
    cfg === null ||
    (permission !== undefined && (typeof permission !== 'object' || permission === null || Array.isArray(permission)))
  ) {
    ctx.skip(
      'Skills-tree permission seam: opencode config unreadable or scalar-shaped — the installer keeps it untouched; add the rules manually (see README, Harness permission notes)',
    );
    return;
  }
  const permRecord = asRecord(permission);
  const ext = asRecord(permRecord.external_directory);
  const editRules = asRecord(permRecord.edit);
  const kept =
    globs.filter((g) => (g in ext && ext[g] !== 'allow') || (g in editRules && editRules[g] !== 'deny')).length +
    editOnlyGlobs.filter((g) => g in editRules && editRules[g] !== 'deny').length;
  const missing =
    globs.filter((g) => ext[g] !== 'allow' || editRules[g] !== 'deny').length +
    editOnlyGlobs.filter((g) => editRules[g] !== 'deny').length;
  const LABEL = 'Skills-tree permission seam (allow + edit deny; payload edit deny)';
  if (missing === 0) {
    ctx.check(LABEL, true, '');
  } else if (kept === 0) {
    ctx.check(
      LABEL,
      false,
      'Run: npx huaweicloud-devkit install (writes the missing seam rules; see README, Harness permission notes)',
    );
  } else {
    ctx.check(
      LABEL,
      false,
      `${missing} rule(s) missing (re-run: npx huaweicloud-devkit install); ${kept} user-owned glob(s) kept as-is (see README, Harness permission notes)`,
    );
  }
}

// Doctor: the shell safety gate — OpenCode installs only (the evaluate-hook
// adapter is the opencode ≥ 2.0 in-process deny face for shell commands).
// A below-floor, absent, or unparsable opencode is a SKIP, never a FAIL
// (the adapter has no surface to register on there); a verifiably ≥ 2.0
// opencode with a missing adapter file is the FAIL install heals.
export function opencodeDoctorSafetyGate(ctx: DoctorReporter): void {
  if (openCodeSafetyGate() === 'off') {
    ctx.skip('Shell safety gate (opencode not verifiably at or above 2.0.0)');
    return;
  }
  const gateFile = join(configRoot('opencode'), 'plugins', 'safety-gate.js');
  ctx.check(
    'Shell safety gate (evaluate-hook adapter)',
    existsSync(gateFile),
    'Run: npx huaweicloud-devkit install --target opencode',
  );
}

export async function deployOpenCode(mode: DeployMode): Promise<void> {
  const commandsSrc = join(PACKAGE_ROOT, 'integrations', 'opencode', 'commands');
  const pluginSrc = join(PACKAGE_ROOT, 'integrations', 'opencode', 'hooks', 'skill-tracker.js');
  const gateSrc = join(PACKAGE_ROOT, 'integrations', 'opencode', 'hooks', 'safety-gate.js');
  const pluginDest = opencodePluginsDir();

  copyDir(commandsSrc, opencodeCommandsDir());
  const staleCommands = mode === 'update' ? pruneStale(opencodeCommandsDir(), commandsSrc) : 0;
  console.log(
    `  Commands${deployWord(mode)} -> ${opencodeCommandsDir()}${staleCommands > 0 ? ` (removed ${staleCommands} stale)` : ''}`,
  );
  copyServerPayload(pluginDest);
  const opcPlugins = join(configRoot('opencode'), 'plugins');
  mkdirSync(opcPlugins, { recursive: true });
  copyFileSync(pluginSrc, join(opcPlugins, 'skill-tracker.js'));
  console.log(`  Plugin${deployWord(mode)} -> ${opcPlugins}`);
  const gateFile = join(opcPlugins, 'safety-gate.js');
  if (openCodeSafetyGate() === 'on') {
    copyFileSync(gateSrc, gateFile);
    console.log(`  Safety gate${deployWord(mode)} -> ${opcPlugins}`);
  } else {
    // Drift heal, same doctrine as the ask-rule migration: an opencode that
    // downgraded or vanished since the last install must not keep the file
    // (a below-floor host has no evaluate hook to run it on).
    removeIfExists(gateFile);
    console.log(
      '  \x1b[33m[INFO]\x1b[0m opencode not verifiably at or above 2.0.0 — skipping the shell safety-gate plugin; a below-floor host has no evaluate hook to gate the Bash face on.',
    );
  }
  updateOpenCodeConfig(pluginDest);

  installRuntimeDeps(pluginDest);
}

export function uninstallOpenCode(removeOwnedSkills: (dir: string) => number): void {
  const removed = removeOwnedSkills(opencodeSkillsDir());
  if (removed > 0) console.log(`  Removed ${removed} skills`);

  const cmdRemoved = removeHuaweiCommandsFrom(opencodeCommandsDir());
  if (cmdRemoved > 0) console.log(`  Removed ${cmdRemoved} commands`);

  const pluginFile = join(configRoot('opencode'), 'plugins', 'skill-tracker.js');
  if (existsSync(pluginFile)) {
    removeIfExists(pluginFile);
    console.log('  Removed plugin');
  }

  const gateFile = join(configRoot('opencode'), 'plugins', 'safety-gate.js');
  if (existsSync(gateFile)) {
    removeIfExists(gateFile);
    console.log('  Removed safety-gate plugin');
  }

  if (removeIfExists(opencodePluginsDir())) {
    console.log('  Removed MCP server and safety policy');
  }
  removeOpenCodeConfig();
}

export function opencodeStatus(): void {
  payloadStatusLines(opencodePluginsDir());
  const gateInstalled = existsSync(join(configRoot('opencode'), 'plugins', 'safety-gate.js'));
  console.log(`  Shell safety gate: ${gateInstalled ? '\x1b[32mInstalled\x1b[0m' : '\x1b[31mNot installed\x1b[0m'}`);
  printMcpConfigStatus(opencodeConfigFile(), 'mcp');
}
