// The WorkBuddy agent module, extracted from setup-cli.ts: mcp.json
// registration, the managed-Python PostToolUse telemetry tracker, and the
// plugin safety hooks.

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

import { workbuddyMcpConfigFile, workbuddyPluginsDir, workbuddySkillsDir } from '../targets.ts';
import { findHcloudBin } from '../hcloud-probe.ts';
import { ensureMcpServersConfig, printMcpConfigStatus, removeMcpServerEntry } from '../mcp-config-io.ts';
import { asRecord } from '../lib/as-record.ts';
import { globalTelemetryDir } from '../telemetry/telemetry.ts';
import {
  PACKAGE_ROOT,
  PLUGIN_ROOT,
  copyDir,
  copyServerPayload,
  installRuntimeDeps,
  payloadStatusLines,
  removeIfExists,
  type DeployMode,
} from '../install-payload.ts';

// Doctor: the WorkBuddy MCP-configured candidate — mcp.json's
// mcpServers.huaweicloud-devkit entry.
export function workbuddyDoctorMcpConfigured(): string | null {
  const workbuddyCfg = workbuddyMcpConfigFile();
  if (!existsSync(workbuddyCfg)) return null;
  try {
    const cfg = asRecord(JSON.parse(readFileSync(workbuddyCfg, 'utf8')));
    if (cfg.mcpServers && asRecord(cfg.mcpServers)['huaweicloud-devkit']) return 'WorkBuddy';
  } catch {
    // corrupt WorkBuddy config skips this candidate — the probe continues
  }
  return null;
}

function ensureWorkbuddyMcpConfig(): boolean {
  const env: Record<string, string> = { HUAWEICLOUD_AGENT_TOOLKIT_MODE: 'local' };
  const hcloudBin = findHcloudBin();
  if (hcloudBin) env.HCLOUD_BIN = hcloudBin.replace(/\\/g, '/');
  return ensureMcpServersConfig({
    configPath: workbuddyMcpConfigFile(),
    mcpPath: join(workbuddyPluginsDir(), 'dist', 'mcp-server.js').replace(/\\/g, '/'),
    agentKey: 'workbuddy',
    label: 'WorkBuddy',
    env,
  });
}

// Resolve WorkBuddy's managed Python binary to run the hook tracker.
// Falls back to a version-specific path if "current" symlink doesn't exist.
function resolveWorkBuddyPython(): string | null {
  const versionsDir = join(homedir(), '.workbuddy', 'binaries', 'python', 'versions');
  const candidates = [
    join(versionsDir, 'current', 'python.exe'),
    join(versionsDir, '3.13.12', 'python.exe'),
    join(versionsDir, '3.11.15', 'python.exe'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p.replace(/\\/g, '/');
  }
  console.log('  \x1b[33m[WARN]\x1b[0m No WorkBuddy managed Python found; PostToolUse telemetry hook not installed.');
  return null;
}

// Deploy hook-based telemetry (PostToolUse tracker) and plugin safety hooks
// for WorkBuddy. Idempotent — safe to run on install and update.
function deployWorkBuddyHooks(): void {
  const pythonBin = resolveWorkBuddyPython();
  if (!pythonBin) return;

  // 1. Deploy telemetry-tracker.py → ~/.codebuddy/hooks/
  const codebuddyHooksDir = join(homedir(), '.codebuddy', 'hooks');
  const trackerSrc = join(PACKAGE_ROOT, 'integrations', 'workbuddy', 'hooks', 'telemetry-tracker.py');
  if (existsSync(trackerSrc)) {
    mkdirSync(codebuddyHooksDir, { recursive: true });
    copyFileSync(trackerSrc, join(codebuddyHooksDir, 'telemetry-tracker.py'));
    console.log(`  Hook tracker -> ${join(codebuddyHooksDir, 'telemetry-tracker.py')}`);
  }

  // 2. Deploy plugin hooks (hooks.json + huaweicloud-safety.py) → plugins/hooks/
  const hooksSrcDir = join(PLUGIN_ROOT, 'hooks');
  if (existsSync(hooksSrcDir)) {
    const hooksDestDir = join(workbuddyPluginsDir(), 'hooks');
    copyDir(hooksSrcDir, hooksDestDir);
    console.log(`  Plugin hooks -> ${hooksDestDir}`);
  }

  // 3. Merge PostToolUse hook into ~/.workbuddy/settings.json
  const settingsPath = join(homedir(), '.workbuddy', 'settings.json');
  const trackerCmd = `${pythonBin} "${join(codebuddyHooksDir, 'telemetry-tracker.py').replace(/\\/g, '/')}"`;
  const newEntry = {
    matcher: '*',
    hooks: [{ type: 'command', command: trackerCmd, timeout: 3 }],
  };

  let settings: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    try {
      settings = asRecord(JSON.parse(readFileSync(settingsPath, 'utf8')));
    } catch {
      console.log(`  \x1b[33m[WARN]\x1b[0m Could not parse ${settingsPath}; hook config not merged.`);
      settings = {};
    }
  }

  const hooksMap: Record<string, unknown> = asRecord(settings.hooks);
  settings.hooks = hooksMap;
  const postToolUse: unknown[] = Array.isArray(hooksMap.PostToolUse) ? hooksMap.PostToolUse : [];
  if (postToolUse.length === 0) {
    hooksMap.PostToolUse = [newEntry];
  } else {
    // Avoid duplicate: only add if our matcher isn't already present
    const matchers: unknown[] = postToolUse.map((e) => asRecord(e).matcher || '');
    if (!matchers.includes('*')) {
      postToolUse.push(newEntry);
    }
  }

  mkdirSync(join(homedir(), '.workbuddy'), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(settings, null, 4) + '\n');
  console.log(`  PostToolUse hook -> ${settingsPath}`);

  // 4. Ensure telemetry output directories exist
  mkdirSync(join(workbuddyPluginsDir(), 'telemetry'), { recursive: true });
  // The GLOBAL dir rides the telemetry face's derivation so an overridden
  // HUAWEICLOUD_DEVKIT_HOME gets the dir the server actually writes
  // (port-v2defects: the bare homedir() join left an orphan under the real
  // home while the server wrote under the override).
  mkdirSync(globalTelemetryDir(), { recursive: true });
}

export async function deployWorkBuddy(_mode: DeployMode): Promise<void> {
  const pluginDest = workbuddyPluginsDir();

  copyServerPayload(pluginDest);
  ensureWorkbuddyMcpConfig();

  installRuntimeDeps(pluginDest);

  // Deploy hook-based telemetry and safety hooks
  deployWorkBuddyHooks();
}

export function uninstallWorkBuddy(removeOwnedSkills: (dir: string) => number): void {
  const removed = removeOwnedSkills(workbuddySkillsDir());
  if (removed > 0) console.log(`  Removed ${removed} skills`);

  if (removeIfExists(workbuddyPluginsDir())) {
    console.log('  Removed MCP server and safety policy');
  }

  removeMcpServerEntry(workbuddyMcpConfigFile(), 'mcpServers', 'args', 'workbuddy');

  // Clean up hook-based telemetry artifacts
  const settingsPath = join(homedir(), '.workbuddy', 'settings.json');
  if (existsSync(settingsPath)) {
    let settings: Record<string, unknown> = {};
    try {
      settings = asRecord(JSON.parse(readFileSync(settingsPath, 'utf8')));
    } catch {
      // corrupt settings leave no hooks map — nothing to remove
    }
    const hooksMap = asRecord(settings.hooks);
    if (hooksMap.PostToolUse) {
      const postToolUse: unknown[] = Array.isArray(hooksMap.PostToolUse) ? hooksMap.PostToolUse : [];
      const before = postToolUse.length;
      hooksMap.PostToolUse = postToolUse.filter((e) => asRecord(e).matcher !== '*');
      const after: unknown[] = Array.isArray(hooksMap.PostToolUse) ? hooksMap.PostToolUse : [];
      if (after.length === 0) delete hooksMap.PostToolUse;
      settings.hooks = hooksMap;
      if (Object.keys(hooksMap).length === 0) delete settings.hooks;
      if (before !== after.length) {
        writeFileSync(settingsPath, JSON.stringify(settings, null, 4) + '\n');
        console.log(`  PostToolUse hook removed from ${settingsPath}`);
      }
    }
  }

  const trackerPath = join(homedir(), '.codebuddy', 'hooks', 'telemetry-tracker.py');
  if (existsSync(trackerPath)) {
    rmSync(trackerPath);
    console.log(`  Removed hook tracker: ${trackerPath}`);
  }

  // The same face-derived global dir the install created — the uninstall
  // must remove the directory the SERVER writes (under the override when
  // HUAWEICLOUD_DEVKIT_HOME is set), not the bare-home twin.
  const devkitTelemetryDir = globalTelemetryDir();
  if (existsSync(devkitTelemetryDir)) {
    rmSync(devkitTelemetryDir, { recursive: true, force: true });
    console.log(`  Removed telemetry cache: ${devkitTelemetryDir}`);
  }
}

export function workbuddyStatus(): void {
  payloadStatusLines(workbuddyPluginsDir());
  printMcpConfigStatus(workbuddyMcpConfigFile());
  const settingsPath = join(homedir(), '.workbuddy', 'settings.json');
  let hookConfigured = false;
  if (existsSync(settingsPath)) {
    try {
      const s = asRecord(JSON.parse(readFileSync(settingsPath, 'utf8')));
      const postToolUse: unknown = asRecord(s.hooks).PostToolUse;
      hookConfigured = Array.isArray(postToolUse) && postToolUse.some((e) => asRecord(e).matcher === '*');
    } catch {
      // corrupt settings count as hook not installed
    }
  }
  const hookTrackerInstalled = existsSync(join(homedir(), '.codebuddy', 'hooks', 'telemetry-tracker.py'));
  console.log(
    `  Telemetry Hook: ${hookConfigured && hookTrackerInstalled ? '\x1b[32mInstalled\x1b[0m' : '\x1b[31mNot installed\x1b[0m'}`,
  );
}
