// The Hermes agent module, split for the complex-file bar: this file keeps
// the deploy/uninstall/status lifecycle and the MCP Python SDK provisioning;
// the config.yaml mcp_servers block family lives in agents/hermes-config.ts,
// and the hooks block / allowlist / Python safety-hook plugin family lives in
// agents/hermes-hooks.ts.

import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { hermesConfigFile, hermesHomeDir, hermesPluginsDir, hermesSkillsDir } from '../targets.ts';
import { saveAgentDelta } from '../mcp-config-backup.ts';
import { asRecord } from '../lib/as-record.ts';
import {
  PLUGIN_ROOT,
  copyDir,
  copyServerPayload,
  deployWord,
  installRuntimeDeps,
  mcpServerInstalled,
  removeIfExists,
  removeSkillsDirIfEmpty,
  serverSkillCount,
  type DeployMode,
} from '../install-payload.ts';
import {
  ensureHermesMcpConfig,
  removeHermesMcpConfigBlock,
  devkitChildArgsLine,
  parseArgsElements,
} from './hermes-config.ts';
import {
  ensureHermesHookAllowlist,
  ensureHermesHooksConfig,
  hermesHookAllowlisted,
  removeHermesHooksConfigBlock,
} from './hermes-hooks.ts';
import { ensureHermesHookPlugin, hermesHookPluginInstalled, removeHermesHookPlugin } from './hermes-hook-plugin.ts';
import { ensureHermesMcpSdk, hermesMcpSdkOk } from './hermes-sdk.ts';

// ── Hermes Agent ──

// Doctor: the Hermes MCP-configured candidate — config.yaml carrying an
// mcp_servers block that names huaweicloud-devkit.
export function hermesDoctorMcpConfigured(): string | null {
  const hermesCfg = hermesConfigFile();
  if (!existsSync(hermesCfg)) return null;
  try {
    const cfg = readFileSync(hermesCfg, 'utf8');
    if (cfg.includes('mcp_servers:') && cfg.includes('huaweicloud-devkit')) return 'Hermes Agent';
  } catch {
    // unreadable Hermes config skips this candidate — the probe continues
  }
  return null;
}
// Hermes deploy: safety + telemetry hooks, the config.yaml MCP block, and
// the runtime deps. --skip-mcp-server (clone-based installs) is honored in
// install mode only — update always ships the full server. The deps/sdk
// tail follows install's order (deps first); the old update body ran the
// sdk first, an ordering drift with no green-path effect.
export async function deployHermes(mode: DeployMode): Promise<void> {
  const hooksDir = join(PLUGIN_ROOT, 'hooks');
  const integrationsHooksDir = resolve(PLUGIN_ROOT, '..', '..', 'integrations', 'hermes', 'hooks');
  const pluginDest = hermesPluginsDir();
  const skipMcp = mode === 'install' && process.argv.includes('--skip-mcp-server');

  // Skills are server data and always travel with the plugin dir; only the
  // bundled server itself is optional (--skip-mcp-server runs from a clone).
  copyServerPayload(pluginDest, { skipDist: skipMcp });
  copyDir(hooksDir, join(pluginDest, 'hooks'));
  console.log(`  Safety Hooks${deployWord(mode)} -> ${join(pluginDest, 'hooks')}`);
  // Telemetry hook lives in integrations/hermes/hooks/ (platform-specific adapter)
  copyFileSync(
    join(integrationsHooksDir, 'huaweicloud-telemetry.py'),
    join(pluginDest, 'hooks', 'huaweicloud-telemetry.py'),
  );

  if (!skipMcp) ensureHermesMcpConfig();
  ensureHermesHooksConfig();
  ensureHermesHookAllowlist();
  ensureHermesHookPlugin();

  if (!skipMcp) installRuntimeDeps(pluginDest);
  if (!skipMcp) ensureHermesMcpSdk();
}

export function uninstallHermes(removeOwnedSkills: (dir: string) => number): void {
  const skillsDir = hermesSkillsDir();

  // 1. Remove hook config from config.yaml (before deleting script files)
  removeHermesHooksConfigBlock();
  console.log('  Hooks config removed');

  // 1b. Remove the Python safety hook plugin (v0.9.0+ enforcement path)
  removeHermesHookPlugin();

  // 2. Clean shell-hooks-allowlist.json (remove approved hook references)
  const hermesHome = hermesHomeDir();
  const allowlistPath = join(hermesHome, 'shell-hooks-allowlist.json');
  if (existsSync(allowlistPath)) {
    try {
      const allowlist = asRecord(JSON.parse(readFileSync(allowlistPath, 'utf8')));
      const approvals: unknown[] = Array.isArray(allowlist.approvals) ? allowlist.approvals : [];
      const before = approvals.length;
      const filtered = approvals.filter((a) => {
        const cmd = typeof a === 'string' ? a : asRecord(a).command;
        return !(typeof cmd === 'string' && cmd.includes('huaweicloud-safety.py'));
      });
      allowlist.approvals = filtered;
      if (filtered.length < before) {
        writeFileSync(allowlistPath, JSON.stringify(allowlist, null, 2));
        console.log(`  Removed ${before - filtered.length} hook approvals from allowlist`);
      }
    } catch {
      removeIfExists(allowlistPath);
      console.log('  Removed hook allowlist file');
    }
  }

  // 3. Remove MCP config from config.yaml (back up user args first, issue #615).
  // The args line is scoped to the devkit child's own body and parsed with
  // the same quote-aware parser the writer uses: a merged config's first
  // `args:` line belongs to a user server and must not become the devkit
  // delta, and args containing quotes or brackets must survive.
  const hermesConfig = hermesConfigFile();
  if (existsSync(hermesConfig)) {
    try {
      const text = readFileSync(hermesConfig, 'utf8');
      const argsLine = devkitChildArgsLine(text);
      const elements = argsLine ? parseArgsElements(argsLine) : null;
      if (elements && elements.length > 1) {
        saveAgentDelta('hermes', { argsExtra: elements.slice(1) });
      }
    } catch {
      // best-effort backup: no delta means reinstall uses default args
    }
  }
  removeHermesMcpConfigBlock();
  console.log('  MCP config removed');

  // 4. Remove skills (file deletion comes after config cleanup)
  const removed = removeOwnedSkills(skillsDir);
  if (removed > 0) console.log(`  Removed ${removed} skills`);
  removeSkillsDirIfEmpty(skillsDir, removed);

  // 5. Remove plugin directory (hook script files deleted last)
  if (removeIfExists(hermesPluginsDir())) {
    console.log('  Removed MCP server, safety policy and hooks');
  }
}

export function hermesStatus(): void {
  const pluginDir = hermesPluginsDir();
  console.log(
    `  MCP Server: ${mcpServerInstalled(pluginDir) ? '\x1b[32mInstalled\x1b[0m' : '\x1b[31mNot installed\x1b[0m'}`,
  );
  console.log(
    `  Safety Policy: ${existsSync(join(pluginDir, 'safety', 'policy.json')) ? '\x1b[32mInstalled\x1b[0m' : '\x1b[31mNot installed\x1b[0m'}`,
  );
  console.log(
    `  Safety Hooks: ${existsSync(join(pluginDir, 'hooks', 'huaweicloud-safety.py')) ? '\x1b[32mInstalled\x1b[0m' : '\x1b[31mNot installed\x1b[0m'}`,
  );
  console.log(
    `  Telemetry Hook: ${existsSync(join(pluginDir, 'hooks', 'huaweicloud-telemetry.py')) ? '\x1b[32mInstalled\x1b[0m' : '\x1b[31mNot installed\x1b[0m'}`,
  );
  console.log(
    `  Hook allowlist: ${hermesHookAllowlisted() ? '\x1b[32mApproved\x1b[0m' : '\x1b[31mNot allowlisted\x1b[0m'}`,
  );
  console.log(
    `  Hook plugin: ${hermesHookPluginInstalled() ? '\x1b[32mInstalled\x1b[0m' : '\x1b[31mNot installed\x1b[0m'}`,
  );
  console.log(`  MCP Python SDK: ${hermesMcpSdkOk() ? '\x1b[32mReady\x1b[0m' : '\x1b[31mMissing\x1b[0m'}`);
  const skillCount = serverSkillCount(pluginDir);
  console.log(
    `  Skills: ${skillCount > 0 ? `\x1b[32m${skillCount} installed\x1b[0m` : '\x1b[31mNot installed\x1b[0m'}`,
  );
  const configPath = hermesConfigFile();
  if (existsSync(configPath)) {
    try {
      const config = readFileSync(configPath, 'utf8');
      const mcpConfigured = config.includes('mcp_servers:') && config.includes('huaweicloud-devkit');
      const hooksConfigured = config.includes('hooks:') && config.includes('huaweicloud-safety.py');
      console.log(`  MCP config: ${mcpConfigured ? '\x1b[32mConfigured\x1b[0m' : '\x1b[31mNot configured\x1b[0m'}`);
      console.log(`  Hooks config: ${hooksConfigured ? '\x1b[32mConfigured\x1b[0m' : '\x1b[31mNot configured\x1b[0m'}`);
    } catch {
      console.log(`  MCP config: \x1b[31mInvalid\x1b[0m`);
      console.log(`  Hooks config: \x1b[31mInvalid\x1b[0m`);
    }
  } else {
    console.log(`  MCP config: \x1b[31mNot found\x1b[0m`);
    console.log(`  Hooks config: \x1b[31mNot found\x1b[0m`);
  }
}
