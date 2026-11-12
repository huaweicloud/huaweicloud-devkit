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
import { inspectAskPermissionRule } from '../lib/opencode-ask-rule.ts';
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
// posture is a PAIR: the client half (the permissions ask rule that makes
// opencode itself prompt on huaweicloud_run_approved_command) and the
// server half (DEVKIT_APPROVAL_MODE=ask in the mcp entry's env). A
// gate-off opencode is a SKIP — token mode is that install's legitimate
// posture — and so are configs the installer itself refuses to touch.
// Every mixed state is a FAIL because each lies in a known direction:
// the rule without the env double-gates (the client prompts AND the
// server still demands a token), the env without the rule fail-opens
// (the server trusts a prompt nobody shows), and an allow/deny rule
// destroys the ask contract outright ("always allow" stops prompting;
// deny bricks the write tool entirely).
export function opencodeDoctorAskRule(ctx: DoctorReporter): void {
  if (openCodeAskGate() === 'off') {
    ctx.skip('ASK approval posture (opencode not verifiably at or above 2.0)');
    return;
  }
  let cfg: Record<string, unknown> | null;
  try {
    cfg = asRecord(JSON.parse(readFileSync(opencodeConfigFile(), 'utf8')));
  } catch {
    cfg = null;
  }
  const posture = cfg !== null ? inspectAskPermissionRule(cfg) : null;
  if (cfg === null || posture === 'foreign') {
    ctx.skip(
      'ASK approval posture: opencode config unreadable or permissions not array-shaped — the installer keeps it untouched; add the ask rule and DEVKIT_APPROVAL_MODE manually (see README, Harness permission notes)',
    );
    return;
  }
  // The mcp entry carries the server half; a missing entry counts as no
  // env, so the halves are judged independently of entry presence.
  const env = asRecord(asRecord(asRecord(cfg.mcp)['huaweicloud-devkit']).environment);
  const envAsk = env.DEVKIT_APPROVAL_MODE === 'ask';
  const label = 'ASK approval posture (client prompt + server env)';
  if (posture === 'ask') {
    ctx.check(
      label,
      envAsk,
      envAsk
        ? ''
        : 'DEVKIT_APPROVAL_MODE=ask missing from the mcp entry — the client prompts AND the server still demands a token (re-run: npx huaweicloud-devkit install --target opencode)',
    );
    return;
  }
  if (posture === 'allow') {
    // FAIL, never a warn: with the env also ask this is fail-open (the
    // always-allow rule suppresses the prompt the server trusts); without
    // it the run degrades to the token gate. Either way the ask contract
    // is silently gone.
    ctx.check(
      label,
      false,
      'the permissions rule for the run tool is "allow" (always allow) — writes no longer prompt: fail-open when DEVKIT_APPROVAL_MODE=ask, a plain token gate otherwise. Delete that rule or set its effect to "ask" (see README, Harness permission notes)',
    );
    return;
  }
  if (posture === 'deny') {
    ctx.check(
      label,
      false,
      'the permissions rule for the run tool is "deny" — the write tool is blocked entirely. Delete that rule or set its effect to "ask" (see README, Harness permission notes)',
    );
    return;
  }
  if (envAsk) {
    // posture === 'absent': the fail-open direction.
    ctx.check(
      label,
      false,
      'DEVKIT_APPROVAL_MODE=ask is set but the permissions ask rule is missing — the server trusts a client prompt nobody shows (re-run: npx huaweicloud-devkit install --target opencode, or unset DEVKIT_APPROVAL_MODE in the mcp entry)',
    );
    return;
  }
  // Token mode is the legitimate default posture, not an error.
  ctx.check('ASK approval posture (token mode)', true, '');
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
