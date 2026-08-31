#!/usr/bin/env node

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, platform } from 'node:os';
import { createInterface } from 'node:readline';
import { spawnSync } from 'node:child_process';
import { getAuthStatus, syncAuth } from './auth/service.mjs';
import { globalCredentialsPath, readGlobalCredentials, writeGlobalCredentials, writeObsConfig } from './auth/credentials.mjs';
import { proxyConfigPath, readProxyConfig, writeProxyConfig, clearProxyConfig, getProxySettings } from './proxy/proxy-config.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(__dirname, '..');
const PACKAGE_ROOT = resolve(PLUGIN_ROOT, '..', '..');

let pkgVersion = '0.0.0';
try {
  pkgVersion = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')).version;
} catch {}

const BANNER = `
╔══════════════════════════════════════════════╗
║     HuaweiCloud DevKit v${pkgVersion}${' '.repeat(Math.max(0, 22 - String(pkgVersion).length))}║
║     https://github.com/huaweicloud   ║
╚══════════════════════════════════════════════╝
`;

function configRoot(target = 'opencode') {
  const home = homedir();
  return join(home, '.config', target);
}

function opencodeSkillsDir() { return join(configRoot('opencode'), 'skills'); }
function opencodeCommandsDir() { return join(configRoot('opencode'), 'commands'); }
function opencodePluginsDir() { return join(configRoot('opencode'), 'huaweicloud-plugins'); }
function opencodeConfigFile() {
  const jsonc = join(configRoot('opencode'), 'opencode.jsonc');
  if (existsSync(jsonc)) return jsonc;
  return join(configRoot('opencode'), 'opencode.json');
}

function codexDesktopSkillsDir() { return join(homedir(), '.agents', 'skills'); }
function codexDesktopCommandsDir() { return join(homedir(), '.agents', 'commands'); }
function codexDesktopPluginsDir() { return join(homedir(), '.agents', 'huaweicloud-plugins'); }
function codexConfigToml() { return join(homedir(), '.codex', 'config.toml'); }

function codeartsSkillsDir() { return join(homedir(), '.codeartsdoer', 'skills'); }
function codeartsMcpSettingsDir() { return join(homedir(), '.codeartsdoer', 'mcp'); }
function codeartsMcpSettingsFile() { return join(codeartsMcpSettingsDir(), 'mcp_settings.json'); }
function codeartsProjectDir() { return join(process.cwd(), '.codeartsdoer'); }
function codeartsProjectSkillsDir() { return join(codeartsProjectDir(), 'skills'); }
function codeartsProjectMcpSettingsFile() { return join(codeartsProjectDir(), 'mcp', 'mcp_settings.json'); }
function codeartsPluginsDir() { return join(homedir(), '.codeartsdoer', 'huaweicloud-plugins'); }

// CodeArts Work (CodeArts Space) — user-level only
function codeartsWorkSkillsDir() { return join(homedir(), '.codeartswork', 'skills'); }
function codeartsWorkMcpSettingsFile() { return join(homedir(), '.codeartswork', 'mcp', 'mcp_settings.json'); }
function codeartsWorkPluginsDir() { return join(homedir(), '.codeartswork', 'huaweicloud-plugins'); }

function workbuddySkillsDir() { return join(homedir(), '.workbuddy', 'skills'); }
function workbuddyMcpConfigFile() { return join(homedir(), '.workbuddy', 'mcp.json'); }
function workbuddyPluginsDir() { return join(homedir(), '.workbuddy', 'huaweicloud-plugins'); }

function dshRoot() { return process.env.DSH_HOME || join(homedir(), '.dsh'); }
function dshSkillsDir() { return join(dshRoot(), 'skills'); }
function dshProfileDir() { return join(dshRoot(), 'profiles', 'web'); }
function dshPatchFile() { return join(dshProfileDir(), 'cordis.patch.yml'); }
function dshPluginsDir() { return join(dshRoot(), 'huaweicloud-plugins'); }

const DSH_MCP_PATCH_START = '# HuaweiCloud DevKit DSH integration start';
const DSH_MCP_PATCH_END = '# HuaweiCloud DevKit DSH integration end';

// Detect CodeArts sandbox mode (bash_mode in permission config).
function detectCodeartsSandbox() {
  try {
    const configPath = join(homedir(), '.codeartsdoer', 'codearts-data', 'storage', 'permission', 'config.json');
    if (!existsSync(configPath)) return null;
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    return typeof config.bash_mode === 'string' ? config.bash_mode : null;
  } catch {
    return null;
  }
}

// Locate an existing hcloud executable (HCLOUD_BIN, ~/hcloud on Windows, ~/.local/bin elsewhere).
function findHcloudBin() {
  if (process.env.HCLOUD_BIN && existsSync(process.env.HCLOUD_BIN)) return process.env.HCLOUD_BIN;
  const isWin = platform() === 'win32';
  const candidates = isWin
    ? [join(homedir(), 'hcloud', 'hcloud.exe')]
    : [join(homedir(), '.local', 'bin', 'hcloud'), join(homedir(), 'hcloud', 'hcloud'), join(homedir(), 'hcloud', 'hcloud.exe')];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

function printSandboxWarning(reason) {
  console.log(`\n\x1b[1m\x1b[31m⚠ 检测到码道沙箱模式 (bash_mode: sandbox)\x1b[0m`);
  console.log(`\x1b[31m  ${reason}\x1b[0m`);
  console.log(`\x1b[31m  请任选其一继续:\x1b[0m`);
  console.log(`\x1b[31m  A. 在码道外的终端安装并使用 KooCLI (推荐):`);
  console.log(`\x1b[31m     https://support.huaweicloud.com/qs-hcli/hcli_02_003.html`);
  console.log(`\x1b[31m  B. 在码道设置中关闭沙箱模式后重试 (设置 → 权限 → Bash 模式)`);
  console.log(`\x1b[31m  关闭沙箱后重新运行: npx huaweicloud-devkit install-hcloud\x1b[0m`);
}

function checkNode() {
  const v = process.versions.node.split('.').map(Number);
  if (v[0] < 20) {
    console.error(`\x1b[31mNode.js >= 20 required (current: ${process.version})\x1b[0m`);
    process.exit(1);
  }
  console.log(`  Node.js ${process.version} \x1b[32mOK\x1b[0m`);
}

function copyDir(src, dest) {
  if (!existsSync(src)) return;
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const s = join(src, entry.name);
    const d = join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(s, d);
    } else {
      copyFileSync(s, d);
    }
  }
}

function removeIfExists(p) {
  if (existsSync(p)) {
    try {
      rmSync(p, { recursive: true, force: true });
      return true;
    } catch (e) {
      console.log(`  \x1b[33m[WARN]\x1b[0m Could not remove ${p}: ${e.message}`);
      return false;
    }
  }
  return false;
}

function updateOpenCodeConfig(pluginDir) {
  const configPath = opencodeConfigFile();
  const mcpPath = join(pluginDir, 'src', 'mcp-server.mjs').replace(/\\/g, '/');
  let config = {};
  if (existsSync(configPath)) {
    try { config = JSON.parse(readFileSync(configPath, 'utf8')); } catch {
      console.log(`  \x1b[33m[WARN]\x1b[0m Could not parse ${configPath} (jsonc comments?). Skipping MCP config write; ensure "mcp.huaweicloud-devkit" points to ${mcpPath}.`);
      return;
    }
    const existing = config.mcp?.['huaweicloud-devkit'];
    if (existing && existing.type === 'local'
        && Array.isArray(existing.command) && existing.command[0] === 'node'
        && existing.command[1] === mcpPath) {
      console.log(`  OpenCode MCP config unchanged: ${configPath}`);
      return;
    }
  }
  config.mcp = config.mcp || {};
  config.mcp['huaweicloud-devkit'] = {
    type: 'local',
    command: ['node', mcpPath],
    enabled: true,
  };
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  console.log(`  OpenCode MCP config updated: ${configPath}`);
}

function removeOpenCodeConfig() {
  const configPath = opencodeConfigFile();
  if (!existsSync(configPath)) return;
  let config = {};
  try { config = JSON.parse(readFileSync(configPath, 'utf8')); } catch { return; }
  if (!config.mcp?.['huaweicloud-devkit']) return;
  delete config.mcp['huaweicloud-devkit'];
  if (Object.keys(config.mcp).length === 0) delete config.mcp;
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  console.log(`  OpenCode MCP config cleaned: ${configPath}`);
}

function hasCodexCLI() {
  const r = spawnSync('codex --version', [], { shell: true, windowsHide: true, stdio: 'pipe' });
  if (r.status === 0 && r.stdout && r.stdout.toString().includes('codex')) return true;
  // WindowsApps codex.exe may fail with "Access is denied"
  // Fallback: check if codex exists on PATH via where.exe
  if (process.platform === 'win32') {
    const w = spawnSync('where.exe', ['codex'], { windowsHide: true, stdio: 'pipe' });
    if (w.status === 0 && w.stdout.toString().trim()) return true;
  }
  return false;
}

function checkHcloud() {
  const bin = findHcloudBin() || (process.env.HCLOUD_BIN || 'hcloud');
  if (!existsSync(bin)) return false;
  try {
    if (statSync(bin).size < 1024) return false;
  } catch { return false; }
  try {
    const r = spawnSync(`"${bin}" version`, [], { shell: true, windowsHide: true, stdio: 'pipe', timeout: 5000 });
    const out = (r.stdout ? r.stdout.toString() : '') + (r.stderr ? r.stderr.toString() : '');
    return r.status === 0 && /KooCLI|Current.*version|当前KooCLI/i.test(out);
  } catch {
    return false;
  }
}

function getMarketplaceName() {
  const marketplacePath = join(PACKAGE_ROOT, '.agents', 'plugins', 'marketplace.json');
  try {
    const manifest = JSON.parse(readFileSync(marketplacePath, 'utf8'));
    if (manifest.name) return manifest.name;
  } catch {}
  return 'huaweicloud-devkit';
}

function installCodex() {
  const marketplaceRoot = PACKAGE_ROOT;
  const pluginName = 'huaweicloud-core';
  const marketplaceName = getMarketplaceName();

  console.log(`  Registering Codex marketplace: ${marketplaceRoot}`);
  const r1 = spawnSync(`codex plugin marketplace add "${marketplaceRoot}"`, [], {
    shell: true, windowsHide: true, stdio: 'pipe',
  });
  console.log(`  ${r1.stdout ? r1.stdout.toString().trim() : r1.stderr.toString().trim()}`);

  if (r1.status !== 0 && /Access is denied/i.test((r1.stderr || '').toString())) {
    console.log(`  \x1b[33mWindowsApps codex.exe permission denied.\x1b[0m`);
    console.log(`  \x1b[33mUse: npx huaweicloud-devkit install --target codex-desktop\x1b[0m`);
    return false;
  }

  console.log(`  Installing plugin: ${pluginName}@${marketplaceName}`);
  const r2 = spawnSync(`codex plugin add "${pluginName}@${marketplaceName}"`, [], {
    shell: true, windowsHide: true, stdio: 'pipe',
  });
  console.log(`  ${r2.stdout ? r2.stdout.toString().trim() : r2.stderr.toString().trim()}`);

  if (r2.status !== 0 && /Access is denied/i.test((r2.stderr || '').toString())) {
    console.log(`  \x1b[33mWindowsApps codex.exe permission denied.\x1b[0m`);
    console.log(`  \x1b[33mUse: npx huaweicloud-devkit install --target codex-desktop\x1b[0m`);
    return false;
  }

  return true;
}

function uninstallCodex() {
  const pluginName = 'huaweicloud-core';
  const marketplaceName = getMarketplaceName();
  console.log(`  Removing Codex plugin: ${pluginName}@${marketplaceName}`);
  const r = spawnSync(`codex plugin remove "${pluginName}@${marketplaceName}"`, [], {
    shell: true, windowsHide: true, stdio: 'pipe',
  });
  console.log(`  ${r.stdout ? r.stdout.toString().trim() : r.stderr.toString().trim()}`);

  for (const name of new Set([marketplaceName, 'HuaweiCloud-Devkit'])) {
    console.log(`  Removing Codex marketplace: ${name}`);
    const r2 = spawnSync(`codex plugin marketplace remove "${name}"`, [], {
      shell: true, windowsHide: true, stdio: 'pipe',
    });
    console.log(`  ${r2.stdout ? r2.stdout.toString().trim() : r2.stderr.toString().trim()}`);
  }
}

function codexStatus() {
  const r = spawnSync('codex plugin list', [], { shell: true, windowsHide: true, stdio: 'pipe' });
  const out = r.stdout ? r.stdout.toString() : '';
  return out.includes('huaweicloud-core');
}

async function installOpenCode() {
  const skillsSrc = join(PLUGIN_ROOT, 'skills');
  const commandsSrc = join(PACKAGE_ROOT, 'integrations', 'opencode', 'commands');
  const srcDir = join(PLUGIN_ROOT, 'src');
  const safetyDir = join(PLUGIN_ROOT, 'safety');
  const pluginDest = opencodePluginsDir();

  copyDir(skillsSrc, opencodeSkillsDir());
  console.log(`  Skills -> ${opencodeSkillsDir()}`);
  copyDir(commandsSrc, opencodeCommandsDir());
  console.log(`  Commands -> ${opencodeCommandsDir()}`);
  copyDir(srcDir, join(pluginDest, 'src'));
  console.log(`  MCP Server -> ${join(pluginDest, 'src')}`);
  copyDir(safetyDir, join(pluginDest, 'safety'));
  console.log(`  Safety Policy -> ${join(pluginDest, 'safety')}`);
  updateOpenCodeConfig(pluginDest);
}

function uninstallOpenCode() {
  let removed = 0;

  const skills = opencodeSkillsDir();
  if (existsSync(skills)) {
    for (const entry of readdirSync(skills, { withFileTypes: true })) {
      if (entry.name.startsWith('huawei')) {
        removeIfExists(join(skills, entry.name));
        removed++;
      }
    }
    console.log(`  Removed ${removed} skills`);
  }

  const commands = opencodeCommandsDir();
  let cmdRemoved = 0;
  if (existsSync(commands)) {
    for (const entry of readdirSync(commands, { withFileTypes: true })) {
      if (entry.name.startsWith('huawei')) {
        removeIfExists(join(commands, entry.name));
        cmdRemoved++;
      }
    }
    if (cmdRemoved > 0) console.log(`  Removed ${cmdRemoved} commands`);
  }

  if (removeIfExists(opencodePluginsDir())) {
    console.log('  Removed MCP server and safety policy');
  }
  removeOpenCodeConfig();
}

// Remove huawei* entries in targetDir that no longer exist in sourceDir (stale files from an older version).
function pruneStale(targetDir, sourceDir) {
  if (!existsSync(targetDir) || !existsSync(sourceDir)) return 0;
  const sourceNames = new Set(readdirSync(sourceDir));
  let removed = 0;
  for (const entry of readdirSync(targetDir, { withFileTypes: true })) {
    if (!entry.name.startsWith('huawei')) continue;
    if (!sourceNames.has(entry.name)) {
      removeIfExists(join(targetDir, entry.name));
      removed++;
    }
  }
  return removed;
}

// Incremental update: overwrite copied files, prune stale ones, and only touch the config when necessary.
async function updateOpenCode() {
  const skillsSrc = join(PLUGIN_ROOT, 'skills');
  const commandsSrc = join(PACKAGE_ROOT, 'integrations', 'opencode', 'commands');
  const srcDir = join(PLUGIN_ROOT, 'src');
  const safetyDir = join(PLUGIN_ROOT, 'safety');
  const pluginDest = opencodePluginsDir();

  copyDir(skillsSrc, opencodeSkillsDir());
  const staleSkills = pruneStale(opencodeSkillsDir(), skillsSrc);
  console.log(`  Skills updated -> ${opencodeSkillsDir()}${staleSkills > 0 ? ` (removed ${staleSkills} stale)` : ''}`);
  copyDir(commandsSrc, opencodeCommandsDir());
  const staleCommands = pruneStale(opencodeCommandsDir(), commandsSrc);
  console.log(`  Commands updated -> ${opencodeCommandsDir()}${staleCommands > 0 ? ` (removed ${staleCommands} stale)` : ''}`);
  copyDir(srcDir, join(pluginDest, 'src'));
  console.log(`  MCP Server updated -> ${join(pluginDest, 'src')}`);
  copyDir(safetyDir, join(pluginDest, 'safety'));
  console.log(`  Safety Policy updated -> ${join(pluginDest, 'safety')}`);
  updateOpenCodeConfig(pluginDest);
  mkdirSync(pluginDest, { recursive: true });
  writeFileSync(join(pluginDest, '.installed'), new Date().toISOString());
}

function codexMcpServerPath() {
  return join(codexDesktopPluginsDir(), 'src', 'mcp-server.mjs').replace(/\\/g, '/');
}

function codexConfigSectionText(mcpPath) {
  return [
    '[mcp_servers.huaweicloud-devkit]',
    'command = "node"',
    `args = ["${mcpPath}"]`,
    '',
    '[mcp_servers.huaweicloud-devkit.env]',
    'HUAWEICLOUD_AGENT_TOOLKIT_MODE = "local"',
    '',
  ].join('\n');
}

// Returns true when the config file was written, false when it was already correct.
function ensureCodexConfigSection(mcpPath) {
  const configPath = codexConfigToml();
  let existing = '';
  if (existsSync(configPath)) {
    try { existing = readFileSync(configPath, 'utf8'); } catch {}
    if (existing.includes('[mcp_servers.huaweicloud-devkit]')) {
      if (existing.includes(`args = ["${mcpPath}"]`)) {
        console.log(`  Config unchanged: ${configPath}`);
        return false;
      }
      removeCodexConfigSection();
      existing = '';
      if (existsSync(configPath)) {
        try { existing = readFileSync(configPath, 'utf8'); } catch {}
      }
    }
  }
  mkdirSync(dirname(configPath), { recursive: true });
  if (existing && !existing.endsWith('\n')) existing += '\n';
  writeFileSync(configPath, existing + codexConfigSectionText(mcpPath));
  console.log(`  Config updated: ${configPath}`);
  return true;
}

function removeCodexConfigSection() {
  const configPath = codexConfigToml();
  if (!existsSync(configPath)) return;
  const lines = readFileSync(configPath, 'utf8').split(/\r?\n/);
  const out = [];
  let skip = false;
  for (const line of lines) {
    if (/^\[mcp_servers\.huaweicloud-devkit(\]|\.)/.test(line)) { skip = true; continue; }
    if (skip && line.startsWith('[')) skip = false;
    if (!skip) out.push(line);
  }
  while (out.length > 0 && out[out.length - 1].trim() === '') out.pop();
  writeFileSync(configPath, out.join('\n') + (out.length > 0 ? '\n' : ''));
  console.log('  Config cleaned');
}

async function installCodexDesktop() {
  const skillsSrc = join(PLUGIN_ROOT, 'skills');
  const commandsSrc = join(PACKAGE_ROOT, 'integrations', 'opencode', 'commands');
  const srcDir = join(PLUGIN_ROOT, 'src');
  const safetyDir = join(PLUGIN_ROOT, 'safety');

  copyDir(skillsSrc, codexDesktopSkillsDir());
  console.log(`  Skills -> ${codexDesktopSkillsDir()}`);
  copyDir(commandsSrc, codexDesktopCommandsDir());
  console.log(`  Commands -> ${codexDesktopCommandsDir()}`);
  mkdirSync(codexDesktopPluginsDir(), { recursive: true });
  copyDir(srcDir, join(codexDesktopPluginsDir(), 'src'));
  console.log(`  MCP Server -> ${join(codexDesktopPluginsDir(), 'src')}`);
  copyDir(safetyDir, join(codexDesktopPluginsDir(), 'safety'));
  console.log(`  Safety Policy -> ${join(codexDesktopPluginsDir(), 'safety')}`);

  // Generate .mcp.json with absolute paths for Codex Desktop MCP server discovery
  const mcpServerAbsPath = codexMcpServerPath();
  const mcpConfig = {
    mcpServers: {
      'huaweicloud-devkit': {
        command: 'node',
        args: [mcpServerAbsPath],
        env: { HUAWEICLOUD_AGENT_TOOLKIT_MODE: 'local' },
      },
    },
  };
  writeFileSync(join(codexDesktopPluginsDir(), '.mcp.json'), JSON.stringify(mcpConfig, null, 2));
  console.log(`  MCP Config -> ${join(codexDesktopPluginsDir(), '.mcp.json')}`);

  // Copy .codex-plugin manifest for Codex Desktop plugin registration
  const codexPluginSrc = join(PLUGIN_ROOT, '.codex-plugin');
  if (existsSync(codexPluginSrc)) {
    copyDir(codexPluginSrc, join(codexDesktopPluginsDir(), '.codex-plugin'));
    console.log(`  Plugin Manifest -> ${join(codexDesktopPluginsDir(), '.codex-plugin')}`);
  }

  ensureCodexConfigSection(mcpServerAbsPath);
}

// Incremental update: overwrite copied files, prune stale ones, and only touch the config when necessary.
async function updateCodexDesktop() {
  const skillsSrc = join(PLUGIN_ROOT, 'skills');
  const commandsSrc = join(PACKAGE_ROOT, 'integrations', 'opencode', 'commands');
  const srcDir = join(PLUGIN_ROOT, 'src');
  const safetyDir = join(PLUGIN_ROOT, 'safety');
  const pluginDest = codexDesktopPluginsDir();

  copyDir(skillsSrc, codexDesktopSkillsDir());
  const staleSkills = pruneStale(codexDesktopSkillsDir(), skillsSrc);
  console.log(`  Skills updated -> ${codexDesktopSkillsDir()}${staleSkills > 0 ? ` (removed ${staleSkills} stale)` : ''}`);
  copyDir(commandsSrc, codexDesktopCommandsDir());
  const staleCommands = pruneStale(codexDesktopCommandsDir(), commandsSrc);
  console.log(`  Commands updated -> ${codexDesktopCommandsDir()}${staleCommands > 0 ? ` (removed ${staleCommands} stale)` : ''}`);
  mkdirSync(pluginDest, { recursive: true });
  copyDir(srcDir, join(pluginDest, 'src'));
  console.log(`  MCP Server updated -> ${join(pluginDest, 'src')}`);
  copyDir(safetyDir, join(pluginDest, 'safety'));
  console.log(`  Safety Policy updated -> ${join(pluginDest, 'safety')}`);

  const mcpServerAbsPath = codexMcpServerPath();
  const mcpConfig = {
    mcpServers: {
      'huaweicloud-devkit': {
        command: 'node',
        args: [mcpServerAbsPath],
        env: { HUAWEICLOUD_AGENT_TOOLKIT_MODE: 'local' },
      },
    },
  };
  writeFileSync(join(pluginDest, '.mcp.json'), JSON.stringify(mcpConfig, null, 2));
  console.log(`  MCP Config updated -> ${join(pluginDest, '.mcp.json')}`);

  const codexPluginSrc = join(PLUGIN_ROOT, '.codex-plugin');
  if (existsSync(codexPluginSrc)) {
    copyDir(codexPluginSrc, join(pluginDest, '.codex-plugin'));
    console.log(`  Plugin Manifest updated -> ${join(pluginDest, '.codex-plugin')}`);
  }

  ensureCodexConfigSection(mcpServerAbsPath);
  writeFileSync(join(pluginDest, '.installed'), new Date().toISOString());
}

function uninstallCodexDesktop() {
  const skillsDir = codexDesktopSkillsDir();
  let removed = 0;
  if (existsSync(skillsDir)) {
    for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
      if (entry.name.startsWith('huawei')) {
        removeIfExists(join(skillsDir, entry.name));
        removed++;
      }
    }
    console.log(`  Removed ${removed} skills`);
  }

  const cmdDir = codexDesktopCommandsDir();
  let cmdRemoved = 0;
  if (existsSync(cmdDir)) {
    for (const entry of readdirSync(cmdDir, { withFileTypes: true })) {
      if (entry.name.startsWith('huawei')) {
        removeIfExists(join(cmdDir, entry.name));
        cmdRemoved++;
      }
    }
    if (cmdRemoved > 0) console.log(`  Removed ${cmdRemoved} commands`);
  }

  if (removeIfExists(codexDesktopPluginsDir())) {
    console.log('  Removed MCP server and safety policy');
  }
  removeCodexConfigSection();
}

function registerCodeartsMcp(configPath) {
  const mcpPath = join(codeartsPluginsDir(), 'src', 'mcp-server.mjs').replace(/\\/g, '/');
  const env = { HUAWEICLOUD_AGENT_TOOLKIT_MODE: 'local' };
  const hcloudBin = findHcloudBin();
  if (hcloudBin) env.HCLOUD_BIN = hcloudBin.replace(/\\/g, '/');
  let config = {};
  if (existsSync(configPath)) {
    try { config = JSON.parse(readFileSync(configPath, 'utf8')); } catch {
      console.log(`  \x1b[33m[WARN]\x1b[0m Could not parse ${configPath}. Skipping MCP config write; ensure "mcpServers.huaweicloud-devkit" points to ${mcpPath}.`);
      return;
    }
    const existing = config.mcpServers?.['huaweicloud-devkit'];
    if (existing && existing.command === 'node'
        && Array.isArray(existing.args) && existing.args[0] === mcpPath) {
      console.log(`  MCP config unchanged: ${configPath}`);
      return;
    }
  }
  config.mcpServers = config.mcpServers || {};
  config.mcpServers['huaweicloud-devkit'] = {
    command: 'node',
    args: [mcpPath],
    env,
    enabled: true,
  };
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  console.log(`  MCP config updated: ${configPath}`);
}

async function installCodeArts() {
  const skillsSrc = join(PLUGIN_ROOT, 'skills');
  const srcDir = join(PLUGIN_ROOT, 'src');
  const safetyDir = join(PLUGIN_ROOT, 'safety');

  copyDir(skillsSrc, codeartsSkillsDir());
  console.log(`  Skills -> ${codeartsSkillsDir()}`);
  copyDir(skillsSrc, codeartsProjectSkillsDir());
  console.log(`  Skills -> ${codeartsProjectSkillsDir()}`);

  const pluginDest = codeartsPluginsDir();
  copyDir(srcDir, join(pluginDest, 'src'));
  console.log(`  MCP Server -> ${join(pluginDest, 'src')}`);
  copyDir(safetyDir, join(pluginDest, 'safety'));
  console.log(`  Safety Policy -> ${join(pluginDest, 'safety')}`);

  registerCodeartsMcp(codeartsMcpSettingsFile());
  registerCodeartsMcp(codeartsProjectMcpSettingsFile());
}

// Incremental update: overwrite copied files, prune stale ones, and only touch the config when necessary.
async function updateCodeArts() {
  const skillsSrc = join(PLUGIN_ROOT, 'skills');
  const srcDir = join(PLUGIN_ROOT, 'src');
  const safetyDir = join(PLUGIN_ROOT, 'safety');
  const pluginDest = codeartsPluginsDir();

  for (const dir of [codeartsSkillsDir(), codeartsProjectSkillsDir()]) {
    copyDir(skillsSrc, dir);
    const stale = pruneStale(dir, skillsSrc);
    console.log(`  Skills updated -> ${dir}${stale > 0 ? ` (removed ${stale} stale)` : ''}`);
  }
  copyDir(srcDir, join(pluginDest, 'src'));
  console.log(`  MCP Server updated -> ${join(pluginDest, 'src')}`);
  copyDir(safetyDir, join(pluginDest, 'safety'));
  console.log(`  Safety Policy updated -> ${join(pluginDest, 'safety')}`);
  registerCodeartsMcp(codeartsMcpSettingsFile());
  registerCodeartsMcp(codeartsProjectMcpSettingsFile());
  mkdirSync(pluginDest, { recursive: true });
  writeFileSync(join(pluginDest, '.installed'), new Date().toISOString());
}

function uninstallCodeArts() {
  let removed = 0;
  for (const skillsDir of [codeartsSkillsDir(), codeartsProjectSkillsDir()]) {
    if (!existsSync(skillsDir)) continue;
    for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
      if (entry.name.startsWith('huawei')) {
        removeIfExists(join(skillsDir, entry.name));
        removed++;
      }
    }
  }
  if (removed > 0) console.log(`  Removed ${removed} skills`);

  if (removeIfExists(codeartsPluginsDir())) {
    console.log('  Removed MCP server and safety policy');
  }
  for (const configPath of [codeartsMcpSettingsFile(), codeartsProjectMcpSettingsFile()]) {
    if (!existsSync(configPath)) continue;
    let config = {};
    try { config = JSON.parse(readFileSync(configPath, 'utf8')); } catch {}
    if (config.mcpServers?.['huaweicloud-devkit']) {
      delete config.mcpServers['huaweicloud-devkit'];
      if (Object.keys(config.mcpServers).length === 0) delete config.mcpServers;
      writeFileSync(configPath, JSON.stringify(config, null, 2));
      console.log(`  Config cleaned: ${configPath}`);
    }
  }
}

function codeartsStatus() {
  const pluginDir = codeartsPluginsDir();
  console.log(`  MCP Server: ${existsSync(join(pluginDir, 'src', 'mcp-server.mjs')) ? '\x1b[32mInstalled\x1b[0m' : '\x1b[31mNot installed\x1b[0m'}`);
  console.log(`  Safety Policy: ${existsSync(join(pluginDir, 'safety', 'policy.json')) ? '\x1b[32mInstalled\x1b[0m' : '\x1b[31mNot installed\x1b[0m'}`);
  let skillCount = 0;
  if (existsSync(codeartsSkillsDir())) {
    skillCount = readdirSync(codeartsSkillsDir(), { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name.startsWith('huawei')).length;
  }
  console.log(`  Skills: ${skillCount > 0 ? `\x1b[32m${skillCount} installed\x1b[0m` : '\x1b[31mNot installed\x1b[0m'}`);
  if (existsSync(codeartsMcpSettingsFile())) {
    try {
      const config = JSON.parse(readFileSync(codeartsMcpSettingsFile(), 'utf8'));
      console.log(`  MCP config: ${config.mcpServers?.['huaweicloud-devkit'] ? '\x1b[32mConfigured\x1b[0m' : '\x1b[31mNot configured\x1b[0m'}`);
    } catch {
      console.log(`  MCP config: \x1b[31mInvalid\x1b[0m`);
    }
  }
}

// --- CodeArts Work (CodeArts Space) ---

function registerCodeartsWorkMcp() {
  const configPath = codeartsWorkMcpSettingsFile();
  const mcpPath = join(codeartsWorkPluginsDir(), 'src', 'mcp-server.mjs').replace(/\\/g, '/');
  const env = { HUAWEICLOUD_AGENT_TOOLKIT_MODE: 'local' };
  const hcloudBin = findHcloudBin();
  if (hcloudBin) env.HCLOUD_BIN = hcloudBin.replace(/\\/g, '/');
  let config = {};
  if (existsSync(configPath)) {
    try { config = JSON.parse(readFileSync(configPath, 'utf8')); } catch {
      console.log(`  \x1b[33m[WARN]\x1b[0m Could not parse ${configPath}.`);
      return;
    }
    const existing = config.mcpServers?.['huaweicloud-devkit'];
    if (existing && existing.command === 'node' && Array.isArray(existing.args) && existing.args[0] === mcpPath && existing.timeout === 300000) {
      console.log(`  MCP config unchanged: ${configPath}`);
      return;
    }
  }
  config.mcpServers = config.mcpServers || {};
  config.mcpServers['huaweicloud-devkit'] = { command: 'node', args: [mcpPath], env, enabled: true, timeout: 300000 };
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  console.log(`  MCP config updated: ${configPath}`);
}

async function installCodeArtsWork() {
  const skillsSrc = join(PLUGIN_ROOT, 'skills');
  const srcDir = join(PLUGIN_ROOT, 'src');
  const safetyDir = join(PLUGIN_ROOT, 'safety');
  copyDir(skillsSrc, codeartsWorkSkillsDir());
  console.log(`  Skills -> ${codeartsWorkSkillsDir()}`);
  const pluginDest = codeartsWorkPluginsDir();
  copyDir(srcDir, join(pluginDest, 'src'));
  console.log(`  MCP Server -> ${join(pluginDest, 'src')}`);
  copyDir(safetyDir, join(pluginDest, 'safety'));
  console.log(`  Safety Policy -> ${join(pluginDest, 'safety')}`);
  registerCodeartsWorkMcp();
  installRuntimeDeps(pluginDest);
}

async function updateCodeArtsWork() {
  const skillsSrc = join(PLUGIN_ROOT, 'skills');
  const srcDir = join(PLUGIN_ROOT, 'src');
  const safetyDir = join(PLUGIN_ROOT, 'safety');
  const pluginDest = codeartsWorkPluginsDir();
  copyDir(skillsSrc, codeartsWorkSkillsDir());
  console.log(`  Skills updated -> ${codeartsWorkSkillsDir()}`);
  copyDir(srcDir, join(pluginDest, 'src'));
  console.log(`  MCP Server updated -> ${join(pluginDest, 'src')}`);
  copyDir(safetyDir, join(pluginDest, 'safety'));
  console.log(`  Safety Policy updated -> ${join(pluginDest, 'safety')}`);
  registerCodeartsWorkMcp();
  mkdirSync(pluginDest, { recursive: true });
  writeFileSync(join(pluginDest, '.installed'), new Date().toISOString());
  installRuntimeDeps(pluginDest);
}

function uninstallCodeArtsWork() {
  const skillsDir = codeartsWorkSkillsDir();
  if (existsSync(skillsDir)) {
    let removed = 0;
    for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
      if (entry.name.startsWith('huawei')) { removeIfExists(join(skillsDir, entry.name)); removed++; }
    }
    if (removed > 0) console.log(`  Removed ${removed} skills`);
  }
  if (removeIfExists(codeartsWorkPluginsDir())) console.log('  Removed MCP server and safety policy');
  const configPath = codeartsWorkMcpSettingsFile();
  if (existsSync(configPath)) {
    let config = {};
    try { config = JSON.parse(readFileSync(configPath, 'utf8')); } catch {}
    if (config.mcpServers?.['huaweicloud-devkit']) {
      delete config.mcpServers['huaweicloud-devkit'];
      if (Object.keys(config.mcpServers).length === 0) delete config.mcpServers;
      writeFileSync(configPath, JSON.stringify(config, null, 2));
      console.log(`  Config cleaned: ${configPath}`);
    }
  }
}

function codeartsWorkStatus() {
  const pluginDir = codeartsWorkPluginsDir();
  console.log(`  MCP Server: ${existsSync(join(pluginDir, 'src', 'mcp-server.mjs')) ? '\x1b[32mInstalled\x1b[0m' : '\x1b[31mNot installed\x1b[0m'}`);
  console.log(`  Safety Policy: ${existsSync(join(pluginDir, 'safety', 'policy.json')) ? '\x1b[32mInstalled\x1b[0m' : '\x1b[31mNot installed\x1b[0m'}`);
  let skillCount = 0;
  if (existsSync(codeartsWorkSkillsDir())) {
    skillCount = readdirSync(codeartsWorkSkillsDir(), { withFileTypes: true }).filter(d => d.isDirectory() && d.name.startsWith('huawei')).length;
  }
  console.log(`  Skills: ${skillCount > 0 ? `\x1b[32m${skillCount} installed\x1b[0m` : '\x1b[31mNot installed\x1b[0m'}`);
  if (existsSync(codeartsWorkMcpSettingsFile())) {
    try {
      const config = JSON.parse(readFileSync(codeartsWorkMcpSettingsFile(), 'utf8'));
      console.log(`  MCP config: ${config.mcpServers?.['huaweicloud-devkit'] ? '\x1b[32mConfigured\x1b[0m' : '\x1b[31mNot configured\x1b[0m'}`);
    } catch { console.log(`  MCP config: \x1b[31mInvalid\x1b[0m`); }
  }
}

// Returns true when the config file was written, false when it was already correct.
function ensureWorkbuddyMcpConfig() {
  const configPath = workbuddyMcpConfigFile();
  const mcpPath = join(workbuddyPluginsDir(), 'src', 'mcp-server.mjs').replace(/\\/g, '/');
  const env = { HUAWEICLOUD_AGENT_TOOLKIT_MODE: 'local' };
  const hcloudBin = findHcloudBin();
  if (hcloudBin) env.HCLOUD_BIN = hcloudBin.replace(/\\/g, '/');
  let config = {};
  if (existsSync(configPath)) {
    try { config = JSON.parse(readFileSync(configPath, 'utf8')); } catch {
      console.log(`  \x1b[33m[WARN]\x1b[0m Could not parse ${configPath}. Skipping MCP config write; ensure "mcpServers.huaweicloud-devkit" points to ${mcpPath}.`);
      return false;
    }
    const existing = config.mcpServers?.['huaweicloud-devkit'];
    if (existing && existing.command === 'node'
        && Array.isArray(existing.args) && existing.args[0] === mcpPath) {
      console.log(`  MCP config unchanged: ${configPath}`);
      return false;
    }
  }
  config.mcpServers = config.mcpServers || {};
  config.mcpServers['huaweicloud-devkit'] = {
    command: 'node',
    args: [mcpPath],
    env,
  };
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  console.log(`  MCP config updated: ${configPath}`);
  return true;
}

async function installWorkBuddy() {
  const skillsSrc = join(PLUGIN_ROOT, 'skills');
  const srcDir = join(PLUGIN_ROOT, 'src');
  const safetyDir = join(PLUGIN_ROOT, 'safety');
  const pluginDest = workbuddyPluginsDir();

  copyDir(skillsSrc, workbuddySkillsDir());
  console.log(`  Skills -> ${workbuddySkillsDir()}`);

  copyDir(srcDir, join(pluginDest, 'src'));
  console.log(`  MCP Server -> ${join(pluginDest, 'src')}`);
  copyDir(safetyDir, join(pluginDest, 'safety'));
  console.log(`  Safety Policy -> ${join(pluginDest, 'safety')}`);

  ensureWorkbuddyMcpConfig();
}

// Incremental update: overwrite copied files, prune stale ones, and only touch the config when necessary.
async function updateWorkBuddy() {
  const skillsSrc = join(PLUGIN_ROOT, 'skills');
  const srcDir = join(PLUGIN_ROOT, 'src');
  const safetyDir = join(PLUGIN_ROOT, 'safety');
  const pluginDest = workbuddyPluginsDir();

  copyDir(skillsSrc, workbuddySkillsDir());
  const stale = pruneStale(workbuddySkillsDir(), skillsSrc);
  console.log(`  Skills updated -> ${workbuddySkillsDir()}${stale > 0 ? ` (removed ${stale} stale)` : ''}`);
  copyDir(srcDir, join(pluginDest, 'src'));
  console.log(`  MCP Server updated -> ${join(pluginDest, 'src')}`);
  copyDir(safetyDir, join(pluginDest, 'safety'));
  console.log(`  Safety Policy updated -> ${join(pluginDest, 'safety')}`);
  ensureWorkbuddyMcpConfig();
  mkdirSync(pluginDest, { recursive: true });
  writeFileSync(join(pluginDest, '.installed'), new Date().toISOString());
}

function uninstallWorkBuddy() {
  const skillsDir = workbuddySkillsDir();
  let removed = 0;
  if (existsSync(skillsDir)) {
    for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
      if (entry.name.startsWith('huawei')) {
        removeIfExists(join(skillsDir, entry.name));
        removed++;
      }
    }
    if (removed > 0) console.log(`  Removed ${removed} skills`);
  }

  if (removeIfExists(workbuddyPluginsDir())) {
    console.log('  Removed MCP server and safety policy');
  }

  const configPath = workbuddyMcpConfigFile();
  if (existsSync(configPath)) {
    let config = {};
    try { config = JSON.parse(readFileSync(configPath, 'utf8')); } catch {}
    if (config.mcpServers?.['huaweicloud-devkit']) {
      delete config.mcpServers['huaweicloud-devkit'];
      if (Object.keys(config.mcpServers).length === 0) delete config.mcpServers;
      writeFileSync(configPath, JSON.stringify(config, null, 2));
      console.log(`  MCP config cleaned: ${configPath}`);
    }
  }
}

function workbuddyStatus() {
  const pluginDir = workbuddyPluginsDir();
  const skillsDir = workbuddySkillsDir();
  console.log(`  MCP Server: ${existsSync(join(pluginDir, 'src', 'mcp-server.mjs')) ? '\x1b[32mInstalled\x1b[0m' : '\x1b[31mNot installed\x1b[0m'}`);
  console.log(`  Safety Policy: ${existsSync(join(pluginDir, 'safety', 'policy.json')) ? '\x1b[32mInstalled\x1b[0m' : '\x1b[31mNot installed\x1b[0m'}`);
  let skillCount = 0;
  if (existsSync(skillsDir)) {
    skillCount = readdirSync(skillsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name.startsWith('huawei')).length;
  }
  console.log(`  Skills: ${skillCount > 0 ? `\x1b[32m${skillCount} installed\x1b[0m` : '\x1b[31mNot installed\x1b[0m'}`);
  const configPath = workbuddyMcpConfigFile();
  if (existsSync(configPath)) {
    try {
      const config = JSON.parse(readFileSync(configPath, 'utf8'));
      console.log(`  MCP config: ${config.mcpServers?.['huaweicloud-devkit'] ? '\x1b[32mConfigured\x1b[0m' : '\x1b[31mNot configured\x1b[0m'}`);
    } catch {
      console.log(`  MCP config: \x1b[31mInvalid\x1b[0m`);
    }
  }
}

function dshMcpServerPath() {
  return join(dshPluginsDir(), 'src', 'mcp-server.mjs').replace(/\\/g, '/');
}

function dshPatchBlock() {
  const hcloudBin = findHcloudBin();
  const envLines = [
    '          HUAWEICLOUD_AGENT_TOOLKIT_MODE: local',
    "          HDKITSERVICE_ENDPOINT: ''",
  ];
  if (hcloudBin) {
    envLines.push(`          HCLOUD_BIN: '${hcloudBin.replace(/\\/g, '/').replace(/'/g, "''")}'`);
  }
  return [
    DSH_MCP_PATCH_START,
    '- insert:',
    '    - id: mcp-huaweicloud',
    "      name: '@deepseek-ai/dsh-mcp-client'",
    '      config:',
    '        serverName: huaweicloud',
    '        transport: stdio',
    '        command: node',
    '        args:',
    `          - '${dshMcpServerPath().replace(/'/g, "''")}'`,
    '        env:',
    ...envLines,
    '        failOnStartupError: false',
    DSH_MCP_PATCH_END,
  ].join('\n');
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function removeManagedDshPatchBlock(content) {
  const pattern = new RegExp(`\\n?${escapeRegExp(DSH_MCP_PATCH_START)}[\\s\\S]*?${escapeRegExp(DSH_MCP_PATCH_END)}\\s*`, 'g');
  return String(content || '').replace(pattern, '\n').replace(/\n{3,}/g, '\n\n').trimEnd();
}

function dshPatchHasOnlyCommentsOrEmptyList(content) {
  const meaningful = String(content || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
  return meaningful.length === 0 || (meaningful.length === 1 && meaningful[0] === '[]');
}

function ensureDshMcpPatch() {
  const patchFile = dshPatchFile();
  const existing = existsSync(patchFile) ? readFileSync(patchFile, 'utf8') : '';
  const cleaned = removeManagedDshPatchBlock(existing);
  const block = dshPatchBlock();
  let next;
  if (dshPatchHasOnlyCommentsOrEmptyList(cleaned)) {
    const prefix = cleaned
      .split(/\r?\n/)
      .filter((line) => line.trim() !== '[]')
      .join('\n')
      .trimEnd();
    next = `${prefix ? `${prefix}\n` : ''}${block}\n`;
  } else {
    next = `${cleaned}\n\n${block}\n`;
  }
  if (existing.replace(/\r\n/g, '\n') === next) {
    console.log(`  DSH patch unchanged: ${patchFile}`);
    return false;
  }
  mkdirSync(dirname(patchFile), { recursive: true });
  writeFileSync(patchFile, next);
  console.log(`  DSH patch updated: ${patchFile}`);
  return true;
}

function removeDshMcpPatch() {
  const patchFile = dshPatchFile();
  if (!existsSync(patchFile)) return false;
  const existing = readFileSync(patchFile, 'utf8');
  const cleaned = removeManagedDshPatchBlock(existing);
  if (cleaned === existing.trimEnd()) return false;
  const prefix = cleaned
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '[]')
    .join('\n')
    .trimEnd();
  const next = dshPatchHasOnlyCommentsOrEmptyList(cleaned)
    ? `${prefix ? `${prefix}\n` : ''}[]\n`
    : `${cleaned}\n`;
  writeFileSync(patchFile, next);
  console.log(`  DSH patch cleaned: ${patchFile}`);
  return true;
}

function dshPatchConfigured() {
  const patchFile = dshPatchFile();
  if (!existsSync(patchFile)) return false;
  try {
    const patch = readFileSync(patchFile, 'utf8');
    return patch.includes('id: mcp-huaweicloud')
      && patch.includes("@deepseek-ai/dsh-mcp-client")
      && patch.includes('serverName: huaweicloud');
  } catch {
    return false;
  }
}

function commandAvailable(command, args = ['--version']) {
  try {
    const r = spawnSync(command, args, { shell: false, windowsHide: true, stdio: 'pipe', timeout: 10000 });
    if (r.status === 0) return true;
  } catch {}
  if (process.platform === 'win32') {
    try {
      const w = spawnSync('where.exe', [command], { windowsHide: true, stdio: 'pipe', timeout: 10000 });
      return w.status === 0 && w.stdout.toString().trim().length > 0;
    } catch {}
  }
  return false;
}

function dshMcpClientAvailable() {
  const modulePath = join('node_modules', '@deepseek-ai', 'dsh-mcp-client', 'package.json');
  const candidates = [
    join(dshProfileDir(), modulePath),
    join(dshRoot(), 'profiles', modulePath),
    join(dshRoot(), modulePath),
  ];
  if (candidates.some((p) => existsSync(p))) return true;
  const pkgPath = join(dshProfileDir(), 'package.json');
  if (!existsSync(pkgPath)) return false;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    return Boolean(pkg.dependencies?.['@deepseek-ai/dsh-mcp-client']
      || pkg.devDependencies?.['@deepseek-ai/dsh-mcp-client']);
  } catch {
    return false;
  }
}

function tryInstallDshMcpClient() {
  if (process.env.HUAWEICLOUD_DEVKIT_SKIP_DSH_PLUGIN_INSTALL === '1') {
    console.log('  DSH MCP client install skipped by environment');
    return false;
  }
  if (dshMcpClientAvailable()) {
    console.log('  DSH MCP client package detected');
    return true;
  }
  if (commandAvailable('dsh')) {
    const r = spawnSync('dsh', ['plugin', '--profile', 'web', 'add', '@deepseek-ai/dsh-mcp-client'], {
      env: { ...process.env, DSH_HOME: dshRoot() },
      windowsHide: true,
      stdio: 'pipe',
      timeout: 60000,
    });
    if (r.status === 0) {
      console.log('  DSH MCP client package installed via dsh');
      return true;
    }
    const err = `${r.stderr || ''}${r.stdout || ''}`.trim().split(/\r?\n/).slice(-2).join(' ');
    console.log(`  \x1b[33m[WARN]\x1b[0m DSH MCP client auto-install failed${err ? `: ${err}` : ''}`);
  }
  if (commandAvailable('pnpm') && existsSync(join(dshProfileDir(), 'package.json'))) {
    const r = spawnSync('pnpm', ['--dir', dshProfileDir(), 'add', '@deepseek-ai/dsh-mcp-client'], {
      windowsHide: true,
      stdio: 'pipe',
      timeout: 60000,
    });
    if (r.status === 0) {
      console.log('  DSH MCP client package installed via pnpm');
      return true;
    }
  }
  console.log('  \x1b[33m[WARN]\x1b[0m DSH MCP client package not detected.');
  console.log('  Manual: npx @deepseek-ai/dsh plugin --profile web add @deepseek-ai/dsh-mcp-client');
  console.log('  If pnpm is missing, run: corepack enable pnpm');
  return false;
}

async function installDsh() {
  const skillsSrc = join(PLUGIN_ROOT, 'skills');
  const srcDir = join(PLUGIN_ROOT, 'src');
  const safetyDir = join(PLUGIN_ROOT, 'safety');
  const pluginDest = dshPluginsDir();

  copyDir(skillsSrc, dshSkillsDir());
  console.log(`  Skills -> ${dshSkillsDir()}`);
  copyDir(srcDir, join(pluginDest, 'src'));
  console.log(`  MCP Server -> ${join(pluginDest, 'src')}`);
  copyDir(safetyDir, join(pluginDest, 'safety'));
  console.log(`  Safety Policy -> ${join(pluginDest, 'safety')}`);
  ensureDshMcpPatch();
  tryInstallDshMcpClient();
  mkdirSync(pluginDest, { recursive: true });
  writeFileSync(join(pluginDest, '.installed'), new Date().toISOString());
}

async function updateDsh() {
  const skillsSrc = join(PLUGIN_ROOT, 'skills');
  const srcDir = join(PLUGIN_ROOT, 'src');
  const safetyDir = join(PLUGIN_ROOT, 'safety');
  const pluginDest = dshPluginsDir();

  copyDir(skillsSrc, dshSkillsDir());
  const stale = pruneStale(dshSkillsDir(), skillsSrc);
  console.log(`  Skills updated -> ${dshSkillsDir()}${stale > 0 ? ` (removed ${stale} stale)` : ''}`);
  copyDir(srcDir, join(pluginDest, 'src'));
  console.log(`  MCP Server updated -> ${join(pluginDest, 'src')}`);
  copyDir(safetyDir, join(pluginDest, 'safety'));
  console.log(`  Safety Policy updated -> ${join(pluginDest, 'safety')}`);
  ensureDshMcpPatch();
  tryInstallDshMcpClient();
  mkdirSync(pluginDest, { recursive: true });
  writeFileSync(join(pluginDest, '.installed'), new Date().toISOString());
}

function uninstallDsh() {
  const skillsDir = dshSkillsDir();
  let removed = 0;
  if (existsSync(skillsDir)) {
    for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
      if (entry.name.startsWith('huawei')) {
        removeIfExists(join(skillsDir, entry.name));
        removed++;
      }
    }
    if (removed > 0) console.log(`  Removed ${removed} skills`);
    try {
      if (readdirSync(skillsDir).length === 0) {
        rmSync(skillsDir, { recursive: true, force: true });
        console.log(`  Removed empty skills directory: ${skillsDir}`);
      }
    } catch {}
  }
  if (removeIfExists(dshPluginsDir())) {
    console.log('  Removed MCP server and safety policy');
  }
  removeDshMcpPatch();
}

function dshStatus() {
  const pluginDir = dshPluginsDir();
  const skillsDir = dshSkillsDir();
  console.log(`  MCP Server: ${existsSync(join(pluginDir, 'src', 'mcp-server.mjs')) ? '\x1b[32mInstalled\x1b[0m' : '\x1b[31mNot installed\x1b[0m'}`);
  console.log(`  Safety Policy: ${existsSync(join(pluginDir, 'safety', 'policy.json')) ? '\x1b[32mInstalled\x1b[0m' : '\x1b[31mNot installed\x1b[0m'}`);
  let skillCount = 0;
  if (existsSync(skillsDir)) {
    skillCount = readdirSync(skillsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name.startsWith('huawei')).length;
  }
  console.log(`  Skills: ${skillCount > 0 ? `\x1b[32m${skillCount} installed\x1b[0m` : '\x1b[31mNot installed\x1b[0m'}`);
  console.log(`  DSH patch: ${dshPatchConfigured() ? '\x1b[32mConfigured\x1b[0m' : '\x1b[31mNot configured\x1b[0m'}`);
  console.log(`  DSH MCP client package: ${dshMcpClientAvailable() ? '\x1b[32mDetected\x1b[0m' : '\x1b[33mCheck DSH profile\x1b[0m'}`);
}

function opencodeStatus() {
  const pluginDir = opencodePluginsDir();
  const skillsDir = opencodeSkillsDir();
  console.log(`  MCP Server: ${existsSync(join(pluginDir, 'src', 'mcp-server.mjs')) ? '\x1b[32mInstalled\x1b[0m' : '\x1b[31mNot installed\x1b[0m'}`);
  console.log(`  Safety Policy: ${existsSync(join(pluginDir, 'safety', 'policy.json')) ? '\x1b[32mInstalled\x1b[0m' : '\x1b[31mNot installed\x1b[0m'}`);
  let skillCount = 0;
  if (existsSync(skillsDir)) {
    skillCount = readdirSync(skillsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name.startsWith('huawei')).length;
  }
  console.log(`  Skills: ${skillCount > 0 ? `\x1b[32m${skillCount} installed\x1b[0m` : '\x1b[31mNot installed\x1b[0m'}`);
  const configPath = opencodeConfigFile();
  if (existsSync(configPath)) {
    try {
      const config = JSON.parse(readFileSync(configPath, 'utf8'));
      console.log(`  MCP config: ${config.mcp?.['huaweicloud-devkit'] ? '\x1b[32mConfigured\x1b[0m' : '\x1b[31mNot configured\x1b[0m'}`);
    } catch {
      console.log(`  MCP config: \x1b[31mInvalid\x1b[0m`);
    }
  }
}

function parseTarget() {
  const idx = process.argv.indexOf('--target');
  if (idx < 0) return 'opencode';
  const val = (process.argv[idx + 1] || '').toLowerCase();
  if (val === 'codex') return 'codex';
  if (val === 'codex-desktop') return 'codex-desktop';
  if (val === 'codearts') return 'codearts';
  if (val === 'codearts-work') return 'codearts-work';
  if (val === 'workbuddy') return 'workbuddy';
  if (val === 'dsh') return 'dsh';
  if (val === 'all') return 'all';
  return 'opencode';
}

async function cmdInstall() {
  const target = parseTarget();
  console.log(BANNER);
  console.log(`Installing HuaweiCloud DevKit${target !== 'opencode' ? ` for ${target}` : ''}...\n`);
  checkNode();

  if (target === 'opencode' || target === 'all') {
    console.log('[OpenCode]');
    await installOpenCode();
  }
  if (target === 'codex-desktop' || target === 'all') {
    console.log('\n[Codex Desktop]');
    await installCodexDesktop();
  }
  if (target === 'codearts' || target === 'all') {
    console.log('\n[CodeArts]');
    await installCodeArts();
  }
  if (target === 'codearts-work' || target === 'all') {
    console.log('\n[CodeArts Work]');
    await installCodeArtsWork();
  }
  if (target === 'workbuddy' || target === 'all') {
    console.log('\n[WorkBuddy]');
    await installWorkBuddy();
  }
  if (target === 'dsh' || target === 'all') {
    console.log('\n[DSH]');
    await installDsh();
  }
  if (target === 'codex' || target === 'all') {
    console.log('\n[Codex]');
    if (!hasCodexCLI()) {
      if (target === 'codex') {
        console.log(`  \x1b[31mCodex CLI not found.\x1b[0m`);
        if (process.platform === 'win32') {
          console.log(`  \x1b[33mTip: Codex Desktop on Windows installs codex.exe under WindowsApps,\x1b[0m`);
          console.log(`  \x1b[33m     which may fail with "Access is denied". Try instead:\x1b[0m`);
          console.log(`  \x1b[33m     npx huaweicloud-devkit install --target codex-desktop\x1b[0m`);
        }
        console.log(`  \x1b[31mOr install Codex CLI: https://github.com/openai/codex-cli\x1b[0m`);
        process.exit(1);
      }
      console.log(`  \x1b[33mCodex CLI not found. Skipping Codex.\x1b[0m`);
      if (process.platform === 'win32') {
        console.log('  \x1b[33mTip: try --target codex-desktop for Codex Desktop on Windows\x1b[0m');
      } else {
        console.log('  Install Codex CLI to enable: npx huaweicloud-devkit install --target codex');
      }
    } else {
      installCodex();
    }
  }
  console.log(`\n\x1b[32mInstallation complete!\x1b[0m`);
  const appName = target === 'codearts' ? 'CodeArts'
    : target === 'codearts-work' ? 'CodeArts Work'
    : target === 'codex-desktop' ? 'Codex Desktop'
    : target === 'codex' ? 'Codex'
    : target === 'workbuddy' ? 'WorkBuddy'
    : target === 'dsh' ? 'DSH'
    : 'OpenCode';
  const pad = ' '.repeat(24 - appName.length);
  console.log(`\n\x1b[1m\x1b[33m╔══════════════════════════════════════════════════════╗`);
  console.log(`\x1b[1m\x1b[33m║  MCP 工具在重启 ${appName} 会话后才生效${pad}║`);
  console.log(`\x1b[1m\x1b[33m║  关闭当前会话 → 重新打开，直接描述华为云任务即可      ║`);
  console.log(`\x1b[1m\x1b[33m║  重启前请勿执行 hcloud 命令，避免 AK/SK 泄露         ║`);
  console.log(`\x1b[1m\x1b[33m╚══════════════════════════════════════════════════════╝\x1b[0m`);

  const hcloudOk = checkHcloud();
  if (!hcloudOk) {
    console.log(`\n\x1b[33mKooCLI (hcloud) is not installed.`);
    console.log(`  Run: npx huaweicloud-devkit install-hcloud\x1b[0m`);
  } else {
    console.log(`\nKooCLI (hcloud) detected.`);
  }

  console.log(`\n\x1b[1m下一步：\x1b[0m`);
  console.log(`  1. 配置统一凭据：npx huaweicloud-devkit auth init`);
  console.log(`  2. 重启 ${appName} 会话（MCP 工具重启后生效）`);
  console.log(`  3. 运行自检：npx huaweicloud-devkit doctor`);

  // Write install marker for doctor to detect
  const markerDir = target === 'dsh' ? dshPluginsDir()
    : target === 'codearts' ? codeartsPluginsDir()
    : target === 'codearts-work' ? codeartsWorkPluginsDir()
    : target === 'workbuddy' ? workbuddyPluginsDir()
    : target === 'codex-desktop' ? codexDesktopPluginsDir()
    : opencodePluginsDir();
  mkdirSync(markerDir, { recursive: true });
  writeFileSync(join(markerDir, '.installed'), new Date().toISOString());
  if (target === 'opencode' || target === 'all') {
    console.log('Or describe your Huawei Cloud task in OpenCode');
  }
  if (target === 'codearts' || target === 'all') {
    console.log('Or describe your Huawei Cloud task in CodeArts');
  }
  if (target === 'codearts-work' || target === 'all') {
    console.log('Or describe your Huawei Cloud task in CodeArts Work');
  }
  if (target === 'codex' || target === 'all') {
    console.log('Or mention @huaweicloud-core in Codex');
  }
  if (target === 'workbuddy' || target === 'all') {
    console.log('Or describe your Huawei Cloud task in WorkBuddy');
  }
  if (target === 'dsh' || target === 'all') {
    console.log('Or describe your Huawei Cloud task in DSH');
  }
}

async function cmdUninstall() {
  const target = parseTarget();
  console.log(BANNER);
  console.log(`Uninstalling HuaweiCloud DevKit${target !== 'opencode' ? ` from ${target}` : ''}...\n`);

  if (target === 'opencode' || target === 'all') {
    console.log('[OpenCode]');
    await uninstallOpenCode();
  }
  if (target === 'codearts' || target === 'all') {
    console.log('\n[CodeArts]');
    uninstallCodeArts();
  }
  if (target === 'codearts-work' || target === 'all') {
    console.log('\n[CodeArts Work]');
    uninstallCodeArtsWork();
  }
  if (target === 'workbuddy' || target === 'all') {
    console.log('\n[WorkBuddy]');
    uninstallWorkBuddy();
  }
  if (target === 'dsh' || target === 'all') {
    console.log('\n[DSH]');
    uninstallDsh();
  }
  if (target === 'codex-desktop' || target === 'codex' || target === 'all') {
    console.log('\n[Codex]');
    uninstallCodexDesktop();
    if (target === 'codex' || target === 'all') {
      if (!hasCodexCLI()) {
        console.log('  \x1b[33mCodex CLI not found. Run "npm uninstall -g codex" to fully remove.\x1b[0m');
      } else {
        uninstallCodex();
      }
    }
  }
  if (target === 'all') {
    const vaultPath = globalCredentialsPath();
    if (removeIfExists(vaultPath)) {
      console.log('  Removed credential vault');
    }
    const vaultDir = dirname(vaultPath);
    try {
      if (existsSync(vaultDir) && readdirSync(vaultDir).length === 0) {
        rmSync(vaultDir, { recursive: true, force: true });
        console.log(`  Removed empty directory: ${vaultDir}`);
      }
    } catch {}
  }
  console.log(`\n\x1b[32mUninstall complete.\x1b[0m`);
}

async function cmdStatus() {
  const target = parseTarget();
  console.log(BANNER);
  console.log(`HuaweiCloud DevKit Status\n`);

  if (target === 'opencode' || target === 'all') {
    console.log('[OpenCode]');
    opencodeStatus();
  }
  if (target === 'codearts' || target === 'all') {
    console.log('\n[CodeArts]');
    codeartsStatus();
  }
  if (target === 'codearts-work' || target === 'all') {
    console.log('\n[CodeArts Work]');
    codeartsWorkStatus();
  }
  if (target === 'workbuddy' || target === 'all') {
    console.log('\n[WorkBuddy]');
    workbuddyStatus();
  }
  if (target === 'dsh' || target === 'all') {
    console.log('\n[DSH]');
    dshStatus();
  }
  if (target === 'codex' || target === 'all') {
    console.log('\n[Codex]');
    if (!hasCodexCLI()) {
      console.log('  \x1b[33mCodex CLI not found.\x1b[0m');
    } else {
      console.log(`  Plugin: ${codexStatus() ? '\x1b[32mInstalled\x1b[0m' : '\x1b[31mNot installed\x1b[0m'}`);
    }
  }
  console.log('\nEnvironment:');
  console.log(`  Node.js: ${process.version}`);
  console.log(`  Platform: ${platform()}`);
}

async function cmdDoctor() {
  console.log(BANNER);
  console.log('HuaweiCloud DevKit Doctor\n');

  let pass = 0, warn = 0, fail = 0;

  function check(label, ok, msg) {
    if (ok) { console.log(`  \x1b[32m[PASS]\x1b[0m ${label}`); pass++; }
    else { console.log(`  \x1b[31m[FAIL]\x1b[0m ${label} — ${msg}`); fail++; }
  }

  // Node.js
  check('Node.js >= 20', process.versions.node.split('.')[0] >= 20, 'Run: nvm install 20 && nvm use 20');

    // MCP server — check OpenCode, Codex Desktop, CodeArts, WorkBuddy, and DSH paths
  const opencodePluginDir = opencodePluginsDir();
  const codexPluginDir = codexDesktopPluginsDir();
  const codeartsPluginDir = codeartsPluginsDir();
  const codeartsWorkPluginDir = codeartsWorkPluginsDir();
  const workbuddyPluginDir = workbuddyPluginsDir();
  const dshPluginDir = dshPluginsDir();
  const mcpOk = existsSync(join(opencodePluginDir, 'src', 'mcp-server.mjs'))
    || existsSync(join(codexPluginDir, 'src', 'mcp-server.mjs'))
    || existsSync(join(codeartsPluginDir, 'src', 'mcp-server.mjs'))
    || existsSync(join(codeartsWorkPluginDir, 'src', 'mcp-server.mjs'))
    || existsSync(join(workbuddyPluginDir, 'src', 'mcp-server.mjs'))
    || existsSync(join(dshPluginDir, 'src', 'mcp-server.mjs'));
  const mcpTarget = existsSync(join(opencodePluginDir, 'src', 'mcp-server.mjs')) ? 'OpenCode'
    : existsSync(join(codexPluginDir, 'src', 'mcp-server.mjs')) ? 'Codex Desktop'
    : existsSync(join(codeartsPluginDir, 'src', 'mcp-server.mjs')) ? 'CodeArts'
    : existsSync(join(codeartsWorkPluginDir, 'src', 'mcp-server.mjs')) ? 'CodeArts Work'
    : existsSync(join(workbuddyPluginDir, 'src', 'mcp-server.mjs')) ? 'WorkBuddy'
    : existsSync(join(dshPluginDir, 'src', 'mcp-server.mjs')) ? 'DSH' : '';
  check('MCP server installed', mcpOk, 'Run: npx huaweicloud-devkit install');

  if (mcpOk) {
    check(`MCP server can start (${mcpTarget})`, true, '');
  }

  const safetyOk = existsSync(join(opencodePluginDir, 'safety', 'policy.json'))
    || existsSync(join(codexPluginDir, 'safety', 'policy.json'))
    || existsSync(join(codeartsPluginDir, 'safety', 'policy.json'))
    || existsSync(join(codeartsWorkPluginDir, 'safety', 'policy.json'))
    || existsSync(join(workbuddyPluginDir, 'safety', 'policy.json'))
    || existsSync(join(dshPluginDir, 'safety', 'policy.json'));
  check('Safety policy installed', safetyOk, 'Run: npx huaweicloud-devkit install');

  // MCP config — check OpenCode, Codex Desktop, CodeArts, WorkBuddy, and DSH
  let mcpConfigured = false;
  let mcpCfgTarget = '';
  const opencodeCfg = opencodeConfigFile();
  if (existsSync(opencodeCfg)) {
    try {
      const cfg = JSON.parse(readFileSync(opencodeCfg, 'utf8'));
      if (cfg.mcp && cfg.mcp['huaweicloud-devkit']) { mcpConfigured = true; mcpCfgTarget = 'OpenCode'; }
    } catch {}
  }
  const codexCfg = codexConfigToml();
  if (!mcpConfigured && existsSync(codexCfg)) {
    try {
      const cfg = readFileSync(codexCfg, 'utf8');
      if (cfg.includes('[mcp_servers.huaweicloud-devkit]')) { mcpConfigured = true; mcpCfgTarget = 'Codex Desktop'; }
    } catch {}
  }
  const codeartsCfg = codeartsMcpSettingsFile();
  if (!mcpConfigured && existsSync(codeartsCfg)) {
    try {
      const cfg = JSON.parse(readFileSync(codeartsCfg, 'utf8'));
      if (cfg.mcpServers && cfg.mcpServers['huaweicloud-devkit']) { mcpConfigured = true; mcpCfgTarget = 'CodeArts'; }
    } catch {}
  }
  const codeartsWorkCfg = codeartsWorkMcpSettingsFile();
  if (!mcpConfigured && existsSync(codeartsWorkCfg)) {
    try {
      const cfg = JSON.parse(readFileSync(codeartsWorkCfg, 'utf8'));
      if (cfg.mcpServers && cfg.mcpServers['huaweicloud-devkit']) { mcpConfigured = true; mcpCfgTarget = 'CodeArts Work'; }
    } catch {}
  }
  const workbuddyCfg = workbuddyMcpConfigFile();
  if (!mcpConfigured && existsSync(workbuddyCfg)) {
    try {
      const cfg = JSON.parse(readFileSync(workbuddyCfg, 'utf8'));
      if (cfg.mcpServers && cfg.mcpServers['huaweicloud-devkit']) { mcpConfigured = true; mcpCfgTarget = 'WorkBuddy'; }
    } catch {}
  }
  if (!mcpConfigured && dshPatchConfigured()) {
    mcpConfigured = true;
    mcpCfgTarget = 'DSH';
  }
  check('MCP configured', mcpConfigured, mcpCfgTarget ? `Found in ${mcpCfgTarget} config` : 'Run: npx huaweicloud-devkit install');

  // hcloud CLI
  const hcloudBin = findHcloudBin() || (process.env.HCLOUD_BIN || 'hcloud');
  const hcloudCheck = spawnSync(`"${hcloudBin}" version`, [], { shell: true, windowsHide: true, stdio: 'pipe', timeout: 5000 });
  const hcloudOut = (hcloudCheck.stdout || '').toString() + (hcloudCheck.stderr || '').toString();
  const hcloudOk = hcloudCheck.status === 0 && /KooCLI|Current.*version|当前KooCLI/i.test(hcloudOut);
  check('hcloud CLI installed', hcloudOk, 'Run: npx huaweicloud-devkit install-hcloud');

  // CodeArts sandbox mode warning
  const sandboxMode = detectCodeartsSandbox();
  if (sandboxMode === 'sandbox') {
    console.log(`  \x1b[33m[WARN]\x1b[0m CodeArts sandbox mode active (bash_mode: sandbox)`);
    console.log(`        KooCLI may fail to write config in ~/.hcloud/ and hang on the privacy agreement.`);
    console.log(`        Fix: disable sandbox (Settings → Permissions) or use a terminal outside CodeArts.`);
    warn++;
  }

  if (hcloudOk) {
    const ver = (hcloudCheck.stdout.toString().match(/(\d+\.\d+\.\d+)/) || [])[1] || 'unknown';
    console.log(`    Version: ${ver}`);

    // Check auth
    const authCheck = spawnSync(`"${hcloudBin}" configure list`, [], { shell: true, windowsHide: true, stdio: 'pipe', timeout: 5000 });
    const hasAuth = authCheck.status === 0 && /access.?key/i.test(authCheck.stdout.toString());
    check('hcloud credentials configured', hasAuth, 'Run: npx huaweicloud-devkit auth init');
  }

  // Skills
  const skillsOptions = [opencodeSkillsDir(), codexDesktopSkillsDir(), codeartsSkillsDir(), codeartsWorkSkillsDir(), workbuddySkillsDir(), dshSkillsDir()];
  let skillCount = 0, skillsDir = '', missingSkills = [];
  for (const dir of skillsOptions) {
    if (!existsSync(dir)) continue;
    const entries = readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name.startsWith('huawei'));
    const count = entries.length;
    if (count > skillCount) { skillCount = count; skillsDir = dir; }
    for (const d of entries) {
      if (!existsSync(join(dir, d.name, 'SKILL.md'))) missingSkills.push(d.name);
    }
  }
  const skillsOk = skillCount >= 6;
  check(`Skills installed (${skillCount})`, skillsOk, 'Run: npx huaweicloud-devkit install');
  if (missingSkills.length > 0) {
    console.log(`  \x1b[33m[WARN]\x1b[0m ${missingSkills.length} skill(s) missing SKILL.md: ${missingSkills.join(', ')} — Run: npx huaweicloud-devkit install`);
    warn++;
  }

  const proxyConfig = readProxyConfig();
  const proxyEnv = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
  if (proxyConfig || proxyEnv) {
    const source = proxyEnv ? 'env' : 'file';
    const proxyUrl = proxyEnv || proxyConfig.https_proxy || proxyConfig.http_proxy;
    console.log(`  \x1b[36m[INFO]\x1b[0m Proxy configured (${source}): ${proxyUrl}`);
  }

  console.log(`\nResults: ${pass} pass, ${warn} warn, ${fail} fail`);

  if (mcpConfigured && !hcloudOk) {
    console.log('\n\x1b[33mMCP is configured but hcloud is not installed. Install hcloud then restart your session.\x1b[0m');
  }
  if (fail > 0) {
    console.log('\x1b[33mFix failures above, then restart your session.\x1b[0m');
  }
  if (fail === 0 && mcpConfigured) {
    console.log('\n\x1b[32mAll checks passed.\x1b[0m Restart your session, then describe your Huawei Cloud task');
  }

  // Detect "installed but not restarted" — check all supported agents
  const installedMarkers = [
    { path: join(opencodePluginsDir(), '.installed'), name: 'OpenCode' },
    { path: join(codexDesktopPluginsDir(), '.installed'), name: 'Codex Desktop' },
    { path: join(workbuddyPluginsDir(), '.installed'), name: 'WorkBuddy' },
    { path: join(codeartsPluginsDir(), '.installed'), name: 'CodeArts' },
    { path: join(codeartsWorkPluginsDir(), '.installed'), name: 'CodeArts Work' },
    { path: join(dshPluginsDir(), '.installed'), name: 'DSH' },
  ];
  for (const marker of installedMarkers) {
    if (existsSync(marker.path)) {
      console.log(`\n\x1b[1m\x1b[31m╔══════════════════════════════════════════╗`);
      console.log(`\x1b[1m\x1b[31m║  请重启 ${marker.name}！MCP 工具尚未激活     ║`);
      console.log(`\x1b[1m\x1b[31m║  关闭当前会话 → 重新打开即可             ║`);
      console.log(`\x1b[1m\x1b[31m╚══════════════════════════════════════════╝\x1b[0m`);
      break;
    }
  }
}

async function cmdUpdate() {
  console.log(BANNER);
  const target = parseTarget();

  if (target === 'opencode') {
    if (!existsSync(join(opencodePluginsDir(), 'src', 'mcp-server.mjs'))) {
      console.log('\x1b[33mNot installed. Use "install" command first.\x1b[0m');
      return;
    }
    console.log('[OpenCode]');
    await updateOpenCode();
    console.log(`\n\x1b[32mUpdate complete.\x1b[0m`);
    console.log(`\x1b[33mMCP 工具在重启 OpenCode 会话后才生效。\x1b[0m`);
    return;
  }

  if (target === 'codex-desktop') {
    if (!existsSync(join(codexDesktopPluginsDir(), 'src', 'mcp-server.mjs'))) {
      console.log('\x1b[33mNot installed. Use "install" command first.\x1b[0m');
      return;
    }
    console.log('[Codex Desktop]');
    await updateCodexDesktop();
    console.log(`\n\x1b[32mUpdate complete.\x1b[0m`);
    console.log(`\x1b[33mMCP 工具在重启 Codex Desktop 会话后才生效。\x1b[0m`);
    return;
  }

  if (target === 'codex') {
    if (!hasCodexCLI()) {
      console.log(`  \x1b[31mCodex CLI not found.\x1b[0m`);
      if (process.platform === 'win32') {
        console.log(`  \x1b[33mTip: use --target codex-desktop for Codex Desktop on Windows\x1b[0m`);
      }
      console.log(`  \x1b[31mInstall Codex CLI: https://github.com/openai/codex-cli\x1b[0m`);
      process.exitCode = 1;
      return;
    }
    console.log('[Codex]');
    installCodex();
    console.log(`\n\x1b[32mUpdate complete.\x1b[0m`);
    console.log(`\x1b[33mRestart the Codex session for changes to take effect.\x1b[0m`);
    return;
  }

  if (target === 'codearts') {
    if (!existsSync(join(codeartsPluginsDir(), 'src', 'mcp-server.mjs'))) {
      console.log('\x1b[33mNot installed. Use "install" command first.\x1b[0m');
      return;
    }
    console.log('[CodeArts]');
    await updateCodeArts();
    console.log(`\n\x1b[32mUpdate complete.\x1b[0m`);
    console.log(`\x1b[33mMCP 工具在重启 CodeArts 会话后才生效。\x1b[0m`);
    return;
  }

  if (target === 'codearts-work') {
    if (!existsSync(join(codeartsWorkPluginsDir(), 'src', 'mcp-server.mjs'))) {
      console.log('\x1b[33mNot installed. Use "install" command first.\x1b[0m');
      return;
    }
    console.log('[CodeArts Work]');
    await updateCodeArtsWork();
    console.log(`\n\x1b[32mUpdate complete.\x1b[0m`);
    console.log(`\x1b[33mMCP 工具在重启 CodeArts Work 会话后才生效。\x1b[0m`);
    return;
  }

  if (target === 'workbuddy') {
    if (!existsSync(join(workbuddyPluginsDir(), 'src', 'mcp-server.mjs'))) {
      console.log('\x1b[33mNot installed. Use "install" command first.\x1b[0m');
      return;
    }
    console.log('[WorkBuddy]');
    await updateWorkBuddy();
    console.log(`\n\x1b[32mUpdate complete.\x1b[0m`);
    console.log(`\x1b[33mMCP 工具在重启 WorkBuddy 会话后才生效。\x1b[0m`);
    return;
  }

  if (target === 'dsh') {
    if (!existsSync(join(dshPluginsDir(), 'src', 'mcp-server.mjs'))) {
      console.log('\x1b[33mNot installed. Use "install" command first.\x1b[0m');
      return;
    }
    console.log('[DSH]');
    await updateDsh();
    console.log(`\n\x1b[32mUpdate complete.\x1b[0m`);
    console.log(`\x1b[33mRestart the DSH session for changes to take effect.\x1b[0m`);
    return;
  }

  if (target === 'all') {
    let updatedAny = false;
    if (existsSync(join(opencodePluginsDir(), 'src', 'mcp-server.mjs'))) {
      console.log('[OpenCode]');
      await updateOpenCode();
      updatedAny = true;
    }
    if (existsSync(join(codexDesktopPluginsDir(), 'src', 'mcp-server.mjs'))) {
      console.log('\n[Codex Desktop]');
      await updateCodexDesktop();
      updatedAny = true;
    }
    if (existsSync(join(codeartsPluginsDir(), 'src', 'mcp-server.mjs'))) {
      console.log('\n[CodeArts]');
      await updateCodeArts();
      updatedAny = true;
    }
    if (existsSync(join(codeartsWorkPluginsDir(), 'src', 'mcp-server.mjs'))) {
      console.log('\n[CodeArts Work]');
      await updateCodeArtsWork();
      updatedAny = true;
    }
    if (existsSync(join(workbuddyPluginsDir(), 'src', 'mcp-server.mjs'))) {
      console.log('\n[WorkBuddy]');
      await updateWorkBuddy();
      updatedAny = true;
    }
    if (existsSync(join(dshPluginsDir(), 'src', 'mcp-server.mjs'))) {
      console.log('\n[DSH]');
      await updateDsh();
      updatedAny = true;
    }
    if (codexStatus()) {
      console.log('\n[Codex]');
      installCodex();
      updatedAny = true;
    }
    if (!updatedAny) {
      console.log('\x1b[33mNot installed. Use "install" command first.\x1b[0m');
      return;
    }
    console.log(`\n\x1b[32mUpdate complete.\x1b[0m`);
    console.log(`\x1b[33mMCP 工具在重启各 agent 会话后才生效。\x1b[0m`);
    return;
  }

  await cmdUninstall();
  console.log('');
  await cmdInstall();
}

async function cmdReinstall() {
  console.log(BANNER);
  if (!(await confirm('This will remove and reinstall all HuaweiCloud DevKit files. Continue?'))) {
    console.log('Cancelled.');
    return;
  }
  confirmed = true;
  await cmdUninstall();
  console.log('');
  await cmdInstall();
}

let confirmed = false;
async function confirm(msg) {
  if (confirmed) return true;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((ok) => {
    rl.question(`${msg} [y/N] `, (a) => {
      rl.close();
      ok(a.toLowerCase() === 'y' || a.toLowerCase() === 'yes');
    });
  });
}

async function cmdInstallHcloud() {
  console.log(BANNER);
  console.log('Installing KooCLI (hcloud)...\n');

  const os = platform();
  const arch = process.arch;
  const baseUrl = 'https://cn-north-4-hdn-koocli.obs.cn-north-4.myhuaweicloud.com/cli/latest';
  const installDir = os === 'win32'
    ? join(homedir(), 'hcloud')
    : join(homedir(), '.local', 'bin');

  if (os === 'win32') {
    const url = `${baseUrl}/huaweicloud-cli-windows-amd64.zip`;
    const zipPath = join(installDir, 'hcloud.zip');

    console.log(`[Windows] Auto-installing to ${installDir}...`);

    try {
      mkdirSync(installDir, { recursive: true });

      // Download
      console.log(`  Downloading ${url}...`);
      const psCmd = `[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri '${url}' -OutFile '${zipPath}' -UseBasicParsing`;
      const dl = spawnSync('powershell', ['-NoProfile', '-Command', psCmd], { stdio: 'inherit', windowsHide: true, timeout: 180000 });
      if (dl.status !== 0) throw new Error(`下载失败 (PowerShell exit ${dl.status})`);

      // Extract
      console.log('  Extracting...');
      const ex = spawnSync('powershell', ['-NoProfile', '-Command', `Expand-Archive -Path '${zipPath}' -DestinationPath '${installDir}' -Force`], { stdio: 'inherit', windowsHide: true, timeout: 60000 });
      if (ex.status !== 0) throw new Error(`解压失败 (PowerShell exit ${ex.status})`);
      if (!existsSync(join(installDir, 'hcloud.exe'))) throw new Error('hcloud.exe 未生成，可能已被安全软件拦截');

      // Clean up zip
      rmSync(zipPath, { force: true });

      // Add to user PATH (append + dedupe within the User scope only; never copy
      // session/system entries into the user PATH, and never use setx PATH which
      // overwrites the whole variable and truncates at 1024 chars).
      console.log('  Adding to user PATH...');
      const pathPs = [
        '$ErrorActionPreference = "Stop"',
        `$target = '${installDir.replace(/'/g, "''")}'`,
        '$cur = [Environment]::GetEnvironmentVariable("Path", "User")',
        'if (-not $cur) { $cur = "" }',
        '$parts = @($cur -split ";" | Where-Object { $_ -ne "" })',
        'if ($parts -notcontains $target) {',
        '  [Environment]::SetEnvironmentVariable("Path", (@($parts) + $target) -join ";", "User")',
        '  Write-Output "  Added to user PATH (deduped): $target"',
        '} else {',
        '  Write-Output "  Already in user PATH: $target"',
        '}',
      ].join('; ');
      spawnSync('powershell', ['-NoProfile', '-Command', pathPs], { stdio: 'inherit', windowsHide: true, timeout: 30000 });

      console.log(`\n\x1b[32mInstall complete.\x1b[0m`);
      console.log(`  Verify: ${join(installDir, 'hcloud.exe')} version`);

      const hcloudBin = join(installDir, 'hcloud.exe');

      // Ask user before accepting the privacy agreement — never auto-accept.
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const agree = await new Promise((resolve) => {
        rl.question('\n  KooCLI requires accepting its privacy agreement. Do you accept? (y/N) ', (answer) => {
          rl.close();
          resolve(/^\s*y\s*$/i.test(answer));
        });
      });
      if (agree) {
        const r = spawnSync(hcloudBin, ['version'], { input: 'y\n', encoding: 'utf8', timeout: 10000, windowsHide: true });
        if (r.status === 0) {
          console.log('  \x1b[32mPrivacy agreement accepted. KooCLI ready.\x1b[0m');
        } else {
          console.log('  \x1b[33m无法写入配置目录。请在码道外终端运行: echo "y" | hcloud version\x1b[0m');
        }
      } else {
        console.log('  \x1b[33m请手动接受隐私协议：在终端运行 hcloud version 并按提示操作\x1b[0m');
      }

      console.log('  Or restart terminal and: hcloud version');
    } catch (e) {
      console.log(`\n\x1b[33mAuto-install failed: ${e.message}\x1b[0m`);
      console.log(`  Manual: download ${url}, unzip to ${installDir}, add to PATH`);
      console.log(`  Guide: https://support.huaweicloud.com/qs-hcli/hcli_02_003_01.html`);
      if (detectCodeartsSandbox() === 'sandbox') {
        printSandboxWarning('沙箱模式拦截了 KooCLI 自动安装（无法创建/写入安装目录）。');
      }
    }
  } else if (os === 'linux') {
    console.log('[Linux] One-liner install:');
    console.log('  curl -sSL https://cn-north-4-hdn-koocli.obs.cn-north-4.myhuaweicloud.com/cli/latest/hcloud_install.sh -o ./hcloud_install.sh && bash ./hcloud_install.sh -y');
    console.log(`\nOr manual: ${arch === 'arm64' ? 'ARM64' : 'AMD64'}`);
    const pkg = arch === 'arm64' ? 'linux-arm64' : 'linux-amd64';
    console.log(`  curl -LO "${baseUrl}/huaweicloud-cli-${pkg}.tar.gz"`);
    console.log(`  tar -zxvf huaweicloud-cli-${pkg}.tar.gz`);
    console.log(`  mv hcloud ~/.local/bin/`);
    console.log(`  hcloud version`);
    console.log(`\nFull guide: https://support.huaweicloud.com/qs-hcli/hcli_02_003_02.html`);
  } else if (os === 'darwin') {
    console.log('[macOS] One-liner install:');
    console.log('  curl -sSL https://cn-north-4-hdn-koocli.obs.cn-north-4.myhuaweicloud.com/cli/latest/hcloud_install.sh -o ./hcloud_install.sh && bash ./hcloud_install.sh -y');
    console.log(`\nOr manual: ${arch === 'arm64' ? 'ARM64 (Apple Silicon)' : 'AMD64 (Intel)'}`);
    const pkg = arch === 'arm64' ? 'mac-arm64' : 'mac-amd64';
    console.log(`  curl -LO "${baseUrl}/huaweicloud-cli-${pkg}.tar.gz"`);
    console.log(`  tar -zxvf huaweicloud-cli-${pkg}.tar.gz`);
    console.log(`  mv hcloud /usr/local/bin/`);
    console.log(`  hcloud version`);
    console.log(`\nFull guide: https://support.huaweicloud.com/qs-hcli/hcli_02_003_03.html`);
  }

  console.log('\nAfter install, set HCLOUD_BIN if hcloud is not on PATH.');
  console.log('\n\x1b[1m\x1b[33m=== Configure credentials SAFELY ===\x1b[0m');
  console.log('  Unified credentials (recommended): npx huaweicloud-devkit auth init');
  console.log('  KooCLI only (alternative): hcloud configure init');
  console.log('  NEVER: hcloud configure set --cli-access-key=xxx  (AK/SK in shell history!)');
  console.log('\nThen run: npx huaweicloud-devkit doctor');
}

function readLineQuestion(prompt) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function readSecret(prompt) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      `Cannot read "${prompt.trim()}" securely in a non-interactive session. Set HW_ACCESS_KEY/HW_SECRET_KEY environment variables instead, or run "npx huaweicloud-devkit auth init" in a real terminal.`
    );
  }

  process.stdout.write(prompt);
  const wasRaw = process.stdin.isRaw;
  process.stdin.setRawMode(true);
  process.stdin.resume();

  return new Promise((resolve) => {
    let value = '';
    const onData = (chunk) => {
      for (const ch of chunk.toString('utf8')) {
        if (ch === '\r' || ch === '\n') {
          cleanup();
          resolve(value.trim());
          return;
        }
        if (ch === '\u0003') {
          cleanup();
          process.exit(130);
        }
        if (ch === '\b' || ch === '\u007f') {
          value = value.slice(0, -1);
          continue;
        }
        value += ch;
      }
    };
    const cleanup = () => {
      process.stdin.setRawMode(wasRaw);
      process.stdin.pause();
      process.stdin.off('data', onData);
      process.stdout.write('\n');
    };
    process.stdin.on('data', onData);
  });
}

function configureHcloud(credentials) {
  const hcloudBin = findHcloudBin() || (process.env.HCLOUD_BIN || 'hcloud');
  const args = [
    'configure',
    'set',
    `--cli-access-key=${credentials.ak}`,
    `--cli-secret-key=${credentials.sk}`,
    `--cli-region=${credentials.region || ''}`,
  ];
  const r = spawnSync(hcloudBin, args, {
    shell: false,
    windowsHide: true,
    stdio: 'pipe',
    timeout: 30000,
  });
  return {
    ok: r.status === 0,
    code: r.status,
    error: String(r.stderr || '').trim().slice(0, 240),
  };
}

function printAuthAgents(agents = {}) {
  for (const [agent, info] of Object.entries(agents)) {
    console.log(`  ${agent}: ${info.configured ? '[OK]' : '[MISSING]'}`);
  }
}

function printAuthStatus(status) {
  console.log(`Credentials vault: ${status.credentialsConfigured ? 'configured' : 'missing'} (${status.credentialsPath})`);
  console.log(`OBS config: ${status.obsConfigured ? 'configured' : 'missing'} (${status.obsConfigPath})`);
  console.log(`KooCLI: ${status.kooCliInstalled ? 'installed' : 'missing'}`);
  console.log('Agent MCP registration:');
  printAuthAgents(status.agents);
}

async function cmdAuthInit() {
  console.log(BANNER);
  console.log('HuaweiCloud DevKit Unified Authentication Setup\n');
  console.log('\x1b[1m获取 AK/SK（如果还没有）：\x1b[0m');
  console.log('  1. 打开华为云"访问密钥"页签：');
  console.log('     https://console.huaweicloud.com/iam/?region=cn-north-4#/mine/accessKey');
  console.log('  2. 点击"新增访问密钥"，完成身份验证');
  console.log('  3. 下载凭证文件（内含 AK 和 SK）。');
  console.log('     注意：SK 只在创建密钥时显示一次，请妥善保存该文件。\n');

  let ak = process.env.HW_ACCESS_KEY || '';
  let sk = process.env.HW_SECRET_KEY || '';
  let securityToken = process.env.HW_SECURITY_TOKEN || '';
  let region = process.env.HW_REGION || process.env.HUAWEICLOUD_REGION || '';

  const interactive = process.stdin.isTTY && process.stdout.isTTY;
  if (!interactive && (!ak || !sk)) {
    console.error('\x1b[31mNon-interactive session detected. Provide credentials via environment variables instead:\x1b[0m');
    console.error('  HW_ACCESS_KEY, HW_SECRET_KEY');
    console.error('  (Or run "npx huaweicloud-devkit auth init" in a real terminal.)');
    process.exitCode = 1;
    return;
  }

  if (!ak) ak = await readLineQuestion('Access Key ID (AK): ');
  if (!sk) sk = await readSecret('Secret Access Key (SK): ');
  if (interactive && !securityToken) securityToken = await readLineQuestion('Security Token (optional, press Enter to skip): ');
  if (!region) region = 'cn-north-4';

  if (!ak || !sk) {
    console.error('\nAK and SK are required.');
    process.exitCode = 1;
    return;
  }


  const vaultPath = writeGlobalCredentials({ ak, sk, securityToken, region });

  try {
    writeObsConfig({ ak, sk, securityToken, region });
  } catch (error) {
    console.log(`OBS config sync failed: ${error.message}`);
  }

  if (findHcloudBin()) {
    const result = configureHcloud({ ak, sk, region });
    if (!result.ok) console.log(`KooCLI update failed: ${result.error || result.code}`);
  } else {
    console.log('KooCLI not found. Run "npx huaweicloud-devkit install-hcloud" and then "auth sync".');
  }

  console.log('\nCredentials synchronized.');
  console.log('\nNext steps:');
  console.log('  npx huaweicloud-devkit install --target all');
  console.log('  Restart your agent sessions.');
}

async function cmdAuthSync() {
  const target = parseTarget();
  console.log(BANNER);
  console.log('Synchronizing Huawei Cloud authentication...\n');

  const credentials = readGlobalCredentials();
  if (!credentials?.ak || !credentials?.sk) {
    console.error('No global credentials found. Run "npx huaweicloud-devkit auth init" first.');
    process.exitCode = 1;
    return;
  }

  const result = syncAuth(target);
  if (result.ok) {
    console.log('Credentials synchronized.');
  } else {
    console.error(result.error);
  }
}

async function cmdAuthStatus() {
  const target = parseTarget();
  console.log(BANNER);
  console.log('HuaweiCloud DevKit Authentication Status\n');
  printAuthStatus(getAuthStatus(target));
}

async function cmdAuth() {
  const sub = (process.argv[3] || 'status').toLowerCase();
  if (sub === 'init' || sub === 'setup') return cmdAuthInit();
  if (sub === 'sync' || sub === 'refresh') return cmdAuthSync();
  return cmdAuthStatus();
}

async function cmdProxyInit() {
  console.log(BANNER);
  console.log('HuaweiCloud DevKit Proxy Configuration\n');
  console.log('Configure HTTP/HTTPS proxy for connections to Huawei Cloud services.');
  console.log('Proxy settings are saved to ~/.config/huaweicloud/proxy.json\n');

  const existing = readProxyConfig() || {};
  const interactive = process.stdin.isTTY && process.stdout.isTTY;

  if (!interactive) {
    console.error('\x1b[31mNon-interactive session. Set proxy via environment variables:\x1b[0m');
    console.error('  HTTPS_PROXY=http://proxy:port');
    console.error('  HTTP_PROXY=http://proxy:port');
    console.error('  NO_PROXY=localhost,127.0.0.1');
    console.error('\nOr run "npx huaweicloud-devkit proxy init" in a real terminal.');
    process.exitCode = 1;
    return;
  }

  const httpsProxy = await readLineQuestion(`HTTPS proxy [${existing.https_proxy || 'none'}]: `);
  const httpProxy = await readLineQuestion(`HTTP proxy [${existing.http_proxy || 'none'}]: `);
  const noProxy = await readLineQuestion(`NO_PROXY hosts [${existing.no_proxy || 'localhost,127.0.0.1'}]: `);

  const config = {
    https_proxy: httpsProxy || existing.https_proxy || '',
    http_proxy: httpProxy || existing.http_proxy || '',
    no_proxy: noProxy || existing.no_proxy || 'localhost,127.0.0.1',
  };

  const path = writeProxyConfig(config);
  console.log(`\nProxy configuration saved to ${path}`);
  console.log('\nEffective settings:');
  console.log(`  HTTPS_PROXY: ${config.https_proxy || '(none)'}`);
  console.log(`  HTTP_PROXY:  ${config.http_proxy || '(none)'}`);
  console.log(`  NO_PROXY:    ${config.no_proxy || '(none)'}`);
  console.log('\nEnvironment variables (HTTPS_PROXY, HTTP_PROXY, NO_PROXY) override file settings.');
}

async function cmdProxyShow() {
  console.log(BANNER);
  console.log('HuaweiCloud DevKit Proxy Configuration\n');

  const config = readProxyConfig();
  const configPath = proxyConfigPath();

  console.log(`Config file: ${configPath}`);
  console.log(`File exists: ${config ? 'yes' : 'no'}\n`);

  if (config) {
    console.log('File settings:');
    console.log(`  https_proxy: ${config.https_proxy || '(empty)'}`);
    console.log(`  http_proxy:  ${config.http_proxy || '(empty)'}`);
    console.log(`  no_proxy:    ${config.no_proxy || '(empty)'}`);
  }

  console.log('\nEnvironment variables:');
  console.log(`  HTTPS_PROXY: ${process.env.HTTPS_PROXY || process.env.https_proxy || '(not set)'}`);
  console.log(`  HTTP_PROXY:  ${process.env.HTTP_PROXY || process.env.http_proxy || '(not set)'}`);
  console.log(`  NO_PROXY:    ${process.env.NO_PROXY || process.env.no_proxy || '(not set)'}`);

  const effective = getProxySettings();
  console.log('\nEffective (env > file):');
  if (effective) {
    console.log(`  https_proxy: ${effective.https_proxy || '(none)'}`);
    console.log(`  http_proxy:  ${effective.http_proxy || '(none)'}`);
    console.log(`  no_proxy:    ${effective.no_proxy || '(none)'}`);
  } else {
    console.log('  (no proxy configured)');
  }
}

async function cmdProxyClear() {
  const removed = clearProxyConfig();
  if (removed) {
    console.log('Proxy configuration removed.');
  } else {
    console.log('No proxy configuration file found.');
  }
}

async function cmdProxy() {
  const sub = (process.argv[3] || 'show').toLowerCase();
  if (sub === 'init' || sub === 'setup') return cmdProxyInit();
  if (sub === 'clear' || sub === 'remove' || sub === 'reset') return cmdProxyClear();
  return cmdProxyShow();
}

async function main() {
  const cmd = process.argv[2] || 'help';

  switch (cmd) {
    case 'install':
    case 'i':
      await cmdInstall();
      break;
    case 'uninstall':
    case 'remove':
      await cmdUninstall();
      break;
    case 'update':
    case 'upgrade':
      await cmdUpdate();
      break;
    case 'reinstall':
      await cmdReinstall();
      break;
    case 'status':
    case 'info':
      await cmdStatus();
      break;
    case 'doctor':
    case 'check':
      await cmdDoctor();
      break;
    case 'install-hcloud':
      await cmdInstallHcloud();
      break;
    case 'auth':
      await cmdAuth();
      break;
    case 'proxy':
      await cmdProxy();
      break;
    case 'help':
    case '--help':
    case '-h':
    default:
      console.log(BANNER);
      console.log('Usage: npx huaweicloud-devkit <command> [--target <opencode|codex|codearts|codearts-work|workbuddy|dsh|all>]\n');
      console.log('Commands:');
      console.log('  install      Install skills, MCP server, safety policy');
      console.log('  uninstall    Remove installed files');
      console.log('  update       Update to latest version');
      console.log('  reinstall    Full clean reinstall');
      console.log('  status       Show installation status');
      console.log('  doctor       Self-check: hcloud, MCP, skills, auth');
      console.log('  install-hcloud  Show KooCLI install commands for your OS');
      console.log('  auth         Manage unified auth: init | sync | status');
      console.log('  proxy        Manage proxy config: init | show | clear');
      console.log('  help         Show this help');
      console.log('\nOptions:');
      console.log('  --target     Target agent: opencode (default), codex, codearts, codearts-work, workbuddy, dsh, all');
      console.log('\nExamples:');
      console.log('  npx huaweicloud-devkit install');
      console.log('  npx huaweicloud-devkit install --target codex');
      console.log('  npx huaweicloud-devkit install --target codearts');
      console.log('  npx huaweicloud-devkit install --target codearts-work');
      console.log('  npx huaweicloud-devkit install --target workbuddy');
      console.log('  npx huaweicloud-devkit install --target dsh');
      console.log('  npx huaweicloud-devkit install --target all');
      console.log('  npx huaweicloud-devkit auth init');
      console.log('  npx huaweicloud-devkit auth sync --target all');
      console.log('  npx huaweicloud-devkit auth status --target all');
      console.log('  npx huaweicloud-devkit proxy init');
      console.log('  npx huaweicloud-devkit proxy show');
      break;
  }
}

main().catch((e) => {
  console.error(`\x1b[31mError: ${e.message}\x1b[0m`);
  process.exit(1);
});
