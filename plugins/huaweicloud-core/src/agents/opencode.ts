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
} from './opencode-config.ts';
import { inspectAskPermissionRule, inspectAskPermissionRuleV1 } from '../lib/opencode-ask-rule.ts';
import { scanSavedAllowRows } from '../lib/opencode-saved-perms.ts';
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
// posture is a PAIR the installer writes together: the client half (the ask
// rule on huaweicloud_run_approved_command — a `permissions` array entry on
// 2.0+, a `permission` object key on 1.19–1.x, both naming the same action)
// and the server half (DEVKIT_APPROVAL_MODE=ask in the mcp entry's env). The
// confirmation itself runs on the SERVER (the gate raises the elicitation
// form, or the T3 chat round-trip on a client that cannot render one), so a
// missing or altered half is config DRIFT from what this installer writes,
// not a fail-open: no client rule can make the gate skip its own
// confirmation. A gate-off opencode is a SKIP — token mode is that install's
// legitimate posture — and so are configs the installer itself refuses to
// touch. The verdict matrix stays FAIL for every drifted state (PR-2 flips
// the posture's meaning): the rule without the env leaves the server in token
// mode (a write then needs both the client rule and a terminal token), the
// env without the rule has nothing for the installer's pair contract to
// verify, and an allow/deny rule both depart from the written pair (deny
// additionally bricks the write tool outright).
export function opencodeDoctorAskRule(ctx: DoctorReporter): void {
  const gate = openCodeAskGate();
  if (gate === 'off') {
    ctx.skip('ASK approval posture (opencode not verifiably at or above 1.19.0)');
    return;
  }
  askPostureCheck(ctx, gate);
  savedAllowStoreCheck(ctx);
}

// The posture verdict (the client rule / server env pair). PR-2 flips this
// pair's meaning; PR-1.5 keeps its current evaluation and no longer feeds the
// verdict to the saved-row check (the server gate makes the row inert).
function askPostureCheck(ctx: DoctorReporter, gate: 'v2-array' | 'v1-object'): 'ask' | 'other' {
  let cfg: Record<string, unknown> | null;
  try {
    cfg = asRecord(JSON.parse(readFileSync(opencodeConfigFile(), 'utf8')));
  } catch {
    cfg = null;
  }
  const posture =
    cfg === null ? null : gate === 'v1-object' ? inspectAskPermissionRuleV1(cfg) : inspectAskPermissionRule(cfg);
  if (cfg === null || posture === 'foreign') {
    ctx.skip(
      gate === 'v1-object'
        ? 'ASK approval posture: opencode config unreadable or the run-tool permission key is not a bare ask/allow/deny string — the installer keeps it untouched; add the ask key and DEVKIT_APPROVAL_MODE manually (see README, Harness permission notes)'
        : 'ASK approval posture: opencode config unreadable or permissions not array-shaped — the installer keeps it untouched; add the ask rule and DEVKIT_APPROVAL_MODE manually (see README, Harness permission notes)',
    );
    return 'other';
  }
  // The mcp entry carries the server half; a missing entry counts as no
  // env, so the halves are judged independently of entry presence.
  const env = asRecord(asRecord(asRecord(cfg.mcp)['huaweicloud-devkit']).environment);
  const envAsk = env.DEVKIT_APPROVAL_MODE === 'ask';
  const label = 'ASK approval posture (client rule + server gate)';
  if (posture === 'ask') {
    ctx.check(
      label,
      envAsk,
      envAsk
        ? ''
        : 'the client rule is present but DEVKIT_APPROVAL_MODE=ask is missing from the mcp entry — the pair has drifted from what this installer writes, so the server runs the token gate while the client rule also fires (re-run: npx huaweicloud-devkit install --target opencode)',
    );
    return envAsk ? 'ask' : 'other';
  }
  if (posture === 'allow') {
    // FAIL, never a warn: the rule departs from the pair this installer
    // writes (effect ask). It is drift, not a fail-open — the server gate
    // raises the confirmation regardless of what the client rule says — and
    // the verdict stays so PR-2's posture migration has a direction to fail.
    ctx.check(
      label,
      false,
      gate === 'v1-object'
        ? 'the permission value for the run tool is "allow" — it has drifted from the "ask" pair this installer writes (the server still raises the confirmation itself). Delete that key or set its value to "ask" (see README, Harness permission notes)'
        : 'the permissions rule for the run tool is "allow" — it has drifted from the "ask" pair this installer writes (the server still raises the confirmation itself). Delete that rule or set its effect to "ask" (see README, Harness permission notes)',
    );
    return envAsk ? 'ask' : 'other';
  }
  if (posture === 'deny') {
    ctx.check(
      label,
      false,
      gate === 'v1-object'
        ? 'the permission value for the run tool is "deny" — the write tool is blocked entirely. Delete that key or set its value to "ask" (see README, Harness permission notes)'
        : 'the permissions rule for the run tool is "deny" — the write tool is blocked entirely. Delete that rule or set its effect to "ask" (see README, Harness permission notes)',
    );
    return envAsk ? 'ask' : 'other';
  }
  if (envAsk) {
    // posture === 'absent': the pair is half-written. The server gate still
    // confirms every roster call, so this is drift from the installer's
    // contract, not an open gate.
    ctx.check(
      label,
      false,
      gate === 'v1-object'
        ? 'DEVKIT_APPROVAL_MODE=ask is set but the permission ask key is missing — the pair has drifted from what this installer writes (re-run: npx huaweicloud-devkit install --target opencode, or unset DEVKIT_APPROVAL_MODE in the mcp entry)'
        : 'DEVKIT_APPROVAL_MODE=ask is set but the permissions ask rule is missing — the pair has drifted from what this installer writes (re-run: npx huaweicloud-devkit install --target opencode, or unset DEVKIT_APPROVAL_MODE in the mcp entry)',
    );
    return 'other';
  }
  // Token mode is the legitimate default posture, not an error.
  ctx.check('ASK approval posture (token mode)', true, '');
  return 'other';
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
// that harness). Verifies the two keys and their values, honoring the
// ownership contract: a user-owned value on a devkit glob is reported as
// kept, not broken; a below-floor or absent opencode is a SKIP, never a
// FAIL.
export function opencodeDoctorSeam(ctx: DoctorReporter): void {
  if (openCodeSeamGate() === 'off') {
    ctx.skip('Skills-tree permission seam (opencode not verifiably at or above the measured permission floor)');
    return;
  }
  // Per-glob evaluation, matching the installer's per-section/per-glob
  // contract exactly: user-owned globs (any non-devkit value) are reported
  // as kept, missing globs as healable — one user-owned glob must never
  // mask a missing edit deny. Configs the installer itself refuses to
  // touch (scalar-shaped permission, unparseable file — the parse-fail
  // skip is the install path's ONLY skip) get a SKIP with the manual
  // pointer, never a FAIL whose re-run-install remediation cannot succeed.
  const globs = openCodeSeamGlobs(opencodePluginsDir());
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
  const kept = globs.filter((g) => (g in ext && ext[g] !== 'allow') || (g in editRules && editRules[g] !== 'deny'));
  const missing = globs.filter((g) => ext[g] !== 'allow' || editRules[g] !== 'deny');
  if (missing.length === 0) {
    ctx.check('Skills-tree permission seam (allow + edit deny)', true, '');
  } else if (kept.length === 0) {
    ctx.check(
      'Skills-tree permission seam (allow + edit deny)',
      false,
      'Run: npx huaweicloud-devkit install (writes the missing skills-tree rules; see README, Harness permission notes)',
    );
  } else {
    ctx.check(
      'Skills-tree permission seam (allow + edit deny)',
      false,
      `${missing.length} rule(s) missing (re-run: npx huaweicloud-devkit install); ${kept.length} user-owned glob(s) kept as-is (see README, Harness permission notes)`,
    );
  }
}

export async function deployOpenCode(mode: DeployMode): Promise<void> {
  const commandsSrc = join(PACKAGE_ROOT, 'integrations', 'opencode', 'commands');
  const pluginSrc = join(PACKAGE_ROOT, 'integrations', 'opencode', 'hooks', 'skill-tracker.js');
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

  if (removeIfExists(opencodePluginsDir())) {
    console.log('  Removed MCP server and safety policy');
  }
  removeOpenCodeConfig();
}

export function opencodeStatus(): void {
  payloadStatusLines(opencodePluginsDir());
  printMcpConfigStatus(opencodeConfigFile(), 'mcp');
}
