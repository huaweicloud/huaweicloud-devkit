import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, platform } from 'node:os';
import { createInterface } from 'node:readline';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';

import { getAuthStatus, syncAuth } from './auth/service.mjs';
import { SUPPORTED_AGENT_TARGETS } from './auth/agent-registration.mjs';
import {
  globalCredentialsPath,
  readGlobalCredentials,
  writeGlobalCredentials,
  writeObsConfig,
} from './auth/credentials.mjs';
import {
  proxyConfigPath,
  readProxyConfig,
  writeProxyConfig,
  clearProxyConfig,
  getProxySettings,
} from './proxy/proxy-config.mjs';

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

function opencodeSkillsDir() {
  return join(configRoot('opencode'), 'skills');
}
function opencodeCommandsDir() {
  return join(configRoot('opencode'), 'commands');
}
function opencodePluginsDir() {
  return join(configRoot('opencode'), 'huaweicloud-plugins');
}
function opencodeConfigFile() {
  const jsonc = join(configRoot('opencode'), 'opencode.jsonc');
  if (existsSync(jsonc)) return jsonc;
  return join(configRoot('opencode'), 'opencode.json');
}

function codexDesktopSkillsDir() {
  return join(codexDesktopPluginsDir(), 'skills');
}
function codexDesktopPluginsDir() {
  return join(homedir(), 'plugins', 'huaweicloud-devkit');
}

// OpenClaw paths (separate from Codex Desktop)
function openclawSkillsDir() {
  return join(homedir(), '.agents', 'skills');
}
function openclawPluginsDir() {
  return join(homedir(), '.agents', 'huaweicloud-plugins');
}

function codeartsSkillsDir() {
  return join(homedir(), '.codeartsdoer', 'skills');
}
function codeartsMcpSettingsDir() {
  return join(homedir(), '.codeartsdoer', 'mcp');
}
function codeartsMcpSettingsFile() {
  return join(codeartsMcpSettingsDir(), 'mcp_settings.json');
}
function codeartsProjectDir() {
  return join(process.cwd(), '.codeartsdoer');
}
function codeartsProjectSkillsDir() {
  return join(codeartsProjectDir(), 'skills');
}
function codeartsProjectMcpSettingsFile() {
  return join(codeartsProjectDir(), 'mcp', 'mcp_settings.json');
}
function codeartsPluginsDir() {
  return join(homedir(), '.codeartsdoer', 'huaweicloud-plugins');
}

// CodeArts Work (CodeArts Space) — user-level only
function codeartsWorkSkillsDir() {
  return join(homedir(), '.codeartswork', 'skills');
}
function codeartsWorkMcpSettingsFile() {
  return join(homedir(), '.codeartswork', 'mcp', 'mcp_settings.json');
}
function codeartsWorkPluginsDir() {
  return join(homedir(), '.codeartswork', 'huaweicloud-plugins');
}

function workbuddySkillsDir() {
  return join(homedir(), '.workbuddy', 'skills');
}
function workbuddyMcpConfigFile() {
  return join(homedir(), '.workbuddy', 'mcp.json');
}
function workbuddyPluginsDir() {
  return join(homedir(), '.workbuddy', 'huaweicloud-plugins');
}

function atomcodeHome() {
  return process.env.ATOMCODE_HOME || join(homedir(), '.atomcode');
}
function atomcodeSkillsDir() {
  return join(atomcodeHome(), 'skills');
}
function atomcodeMcpConfigFile() {
  return join(atomcodeHome(), 'mcp.json');
}
function atomcodePluginsDir() {
  return join(atomcodeHome(), 'huaweicloud-plugins');
}

function dshRoot() {
  return process.env.DSH_HOME || join(homedir(), '.dsh');
}
function dshSkillsDir() {
  return join(dshRoot(), 'skills');
}
function dshProfileDir() {
  return join(dshRoot(), 'profiles', 'web');
}
function dshPatchFile() {
  return join(dshProfileDir(), 'cordis.patch.yml');
}
function dshPluginsDir() {
  return join(dshRoot(), 'huaweicloud-plugins');
}

function readOfficeaceRegistryInstallDir() {
  if (platform() !== 'win32') return null;
  try {
    const r = spawnSync('reg', ['query', 'HKCU\\SOFTWARE\\OfficeAce\\OfficeAce', '/v', 'InstallDir'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5000,
    });
    if (r.status === 0) {
      const m = r.stdout.match(/InstallDir\s+REG_SZ\s+(.+)/);
      if (m) return m[1].trim();
    }
  } catch {}
  return null;
}

function officeaceCapabilitiesDir() {
  const configRoot = process.env.OFFICE_CLAW_CONFIG_ROOT;
  if (configRoot && existsSync(join(configRoot, 'capabilities.json'))) return configRoot;
  const regDir = readOfficeaceRegistryInstallDir();
  if (regDir) {
    const dir = join(regDir, '.office-claw');
    if (existsSync(join(dir, 'capabilities.json'))) return dir;
  }
  if (platform() === 'win32') {
    const bases = [process.env.ProgramFiles, 'C:\\Program Files', 'D:\\Program Files'];
    if (process.env.LOCALAPPDATA) bases.push(join(process.env.LOCALAPPDATA, 'Programs'));
    for (const base of bases) {
      if (!base) continue;
      const dir = join(base, 'OfficeAce', '.office-claw');
      if (existsSync(join(dir, 'capabilities.json'))) return dir;
    }
  }
  return null;
}

function officeaceCapabilitiesDirSafe() {
  return officeaceCapabilitiesDir() || join(homedir(), '.office-claw');
}
function officeaceCapabilitiesFile() {
  return join(officeaceCapabilitiesDirSafe(), 'capabilities.json');
}
function officeaceSkillsDir() {
  return join(officeaceCapabilitiesDirSafe(), 'skills');
}
function officeacePluginsDir() {
  return join(officeaceCapabilitiesDirSafe(), 'huaweicloud-plugins');
}

function officeaceSqlitePath() {
  const capDir = officeaceCapabilitiesDirSafe();
  return join(resolve(capDir, '..'), 'data', 'mcp-connectors.sqlite');
}

function openOfficeaceDb() {
  return new Database(officeaceSqlitePath());
}

function officeaceGetOwnerUserId() {
  if (!existsSync(officeaceSqlitePath())) return null;
  try {
    const db = openOfficeaceDb();
    const row = db.prepare('SELECT owner_user_id FROM mcp_connectors WHERE owner_user_id IS NOT NULL LIMIT 1').get();
    db.close();
    return row?.owner_user_id || null;
  } catch {
    return null;
  }
}

function ensureOfficeaceMcpInSqlite() {
  const dbPath = officeaceSqlitePath();
  if (!existsSync(dbPath)) {
    console.log(`  \x1b[31mOfficeAce database not found: ${dbPath}\x1b[0m`);
    console.log(`  \x1b[33mPlease ensure OfficeAce is installed and has been launched at least once.\x1b[0m`);
    return false;
  }

  const mcpPath = join(officeacePluginsDir(), 'src', 'mcp-server.mjs').replace(/\\/g, '/');
  const env = [{ key: 'HUAWEICLOUD_AGENT_TOOLKIT_MODE', value: 'local', sensitive: false }];
  const hcloudBin = findHcloudBin();
  if (hcloudBin) env.push({ key: 'HCLOUD_BIN', value: hcloudBin.replace(/\\/g, '/'), sensitive: false });

  const now = Date.now();
  let db;
  try {
    db = openOfficeaceDb();

    const existing = db
      .prepare("SELECT id, command, args_json FROM mcp_connectors WHERE name = 'huaweicloud-devkit'")
      .get();

    const argsJson = JSON.stringify([mcpPath]);
    const envJson = JSON.stringify(env);

    if (existing) {
      if (existing.command === 'node' && existing.args_json === argsJson) {
        console.log(`  MCP config unchanged: ${dbPath}`);
        db.close();
        return true;
      }
      db.prepare(
        'UPDATE mcp_connectors SET command = ?, args_json = ?, env_json = ?, updated_at = ?, status = ?, enabled = 1 WHERE id = ?',
      ).run('node', argsJson, envJson, now, 'disconnected', existing.id);
      console.log(`  MCP config updated: ${dbPath}`);
    } else {
      const ownerUserId = officeaceGetOwnerUserId();
      if (!ownerUserId) {
        console.log(`  \x1b[31mCannot determine owner_user_id from database\x1b[0m`);
        db.close();
        return false;
      }
      db.prepare(
        `INSERT INTO mcp_connectors (id, owner_user_id, type, name, normalized_name, transport, timeout_ms, command, args_json, env_json, enabled, status, created_at, updated_at, version, seeded)
         VALUES (?, ?, 'custom', 'huaweicloud-devkit', 'huaweicloud-devkit', 'stdio', 60000, 'node', ?, ?, 1, 'disconnected', ?, ?, 1, 0)`,
      ).run(randomUUID(), ownerUserId, argsJson, envJson, now, now);
      console.log(`  MCP config created: ${dbPath}`);
    }
    db.close();
    return true;
  } catch (error) {
    if (db) {
      try {
        db.close();
      } catch {}
    }
    console.log(`  \x1b[31mFailed to write MCP config: ${error.message}\x1b[0m`);
    return false;
  }
}

function removeOfficeaceMcpFromSqlite() {
  const dbPath = officeaceSqlitePath();
  if (!existsSync(dbPath)) return;
  let db;
  try {
    db = openOfficeaceDb();
    db.prepare(
      "DELETE FROM mcp_connector_tools WHERE connector_id IN (SELECT id FROM mcp_connectors WHERE name = 'huaweicloud-devkit')",
    ).run();
    const result2 = db.prepare("DELETE FROM mcp_connectors WHERE name = 'huaweicloud-devkit'").run();
    if (result2.changes > 0) {
      console.log(`  MCP config removed: ${dbPath}`);
    }
    db.close();
  } catch (error) {
    if (db) {
      try {
        db.close();
      } catch {}
    }
    console.log(`  \x1b[31mFailed to remove MCP config: ${error.message}\x1b[0m`);
  }
}

function readCapabilitiesJson() {
  const capFile = officeaceCapabilitiesFile();
  if (!existsSync(capFile)) return { capabilities: [] };
  try {
    return JSON.parse(readFileSync(capFile, 'utf8'));
  } catch {
    return { capabilities: [] };
  }
}

function writeCapabilitiesJson(config) {
  mkdirSync(officeaceCapabilitiesDirSafe(), { recursive: true });
  writeFileSync(officeaceCapabilitiesFile(), JSON.stringify(config, null, 2));
}

function removeOfficeaceSkillCapabilities() {
  const capFile = officeaceCapabilitiesFile();
  if (!existsSync(capFile)) return;
  let config;
  try {
    config = JSON.parse(readFileSync(capFile, 'utf8'));
  } catch {
    return;
  }
  if (!Array.isArray(config.capabilities)) return;
  const origLen = config.capabilities.length;
  config.capabilities = config.capabilities.filter(
    (c) =>
      !(
        (c.id === 'huaweicloud-core' && c.type === 'skill') ||
        (c.source === 'custom' && c.id && c.id.startsWith('huawei'))
      ),
  );
  if (config.capabilities.length !== origLen) {
    writeCapabilitiesJson(config);
    console.log(`  Skill capabilities cleaned: ${capFile}`);
  }
}

function registerOfficeaceSkillEntries() {
  const skillsSrc = join(PLUGIN_ROOT, 'skills');
  if (!existsSync(skillsSrc)) return;
  const skillNames = readdirSync(skillsSrc, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.startsWith('huawei'))
    .map((d) => d.name);

  const config = readCapabilitiesJson();
  let changed = false;

  for (const name of skillNames) {
    const existingIdx = config.capabilities.findIndex((c) => c.id === name && c.type === 'skill');
    if (existingIdx >= 0) continue;
    config.capabilities.push({
      id: name,
      type: 'skill',
      enabled: true,
      source: 'custom',
      selfEvolution: 'suggest',
      followGlobalSelfEvolution: true,
    });
    changed = true;
  }

  if (!config.capabilities.some((c) => c.id === 'huaweicloud-core' && c.type === 'skill')) {
    config.capabilities.push({
      id: 'huaweicloud-core',
      type: 'skill',
      enabled: true,
      source: 'custom',
      selfEvolution: 'suggest',
      followGlobalSelfEvolution: true,
    });
    changed = true;
  }

  if (changed) {
    writeCapabilitiesJson(config);
    console.log(`  Skill entries registered: ${officeaceCapabilitiesFile()}`);
  }
}

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
    : [
        join(homedir(), '.local', 'bin', 'hcloud'),
        join(homedir(), 'hcloud', 'hcloud'),
        join(homedir(), 'hcloud', 'hcloud.exe'),
      ];
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
  console.log(`\x1b[31m  B. 在码道设置中关闭沙箱模式后重试 (设置 → 对话流 → 智能体 终端命令运行模式 → 自动运行)`);
  console.log(`\x1b[31m  关闭沙箱后重新运行: npx huaweicloud-devkit install-hcloud\x1b[0m`);
}

function checkNode() {
  const v = process.versions.node.split('.').map(Number);
  if (v[0] < 22) {
    console.error(`\x1b[31mNode.js >= 22 required (current: ${process.version})\x1b[0m`);
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

function installRuntimeDeps(pluginsDir) {
  const pkgJson = {
    name: 'huaweicloud-devkit',
    version: pkgVersion,
    type: 'module',
    dependencies: { undici: '^8.10.0' },
  };
  mkdirSync(pluginsDir, { recursive: true });
  writeFileSync(join(pluginsDir, 'package.json'), JSON.stringify(pkgJson, null, 2));
  const spawnOpts = {
    cwd: pluginsDir,
    shell: true,
    windowsHide: true,
    stdio: 'pipe',
    timeout: 120000,
  };
  let r = spawnSync('npm', ['install', '--omit=dev'], spawnOpts);
  const isRetryable = (res) => {
    const stderr = (res.stderr || '').toString();
    return res.error?.code === 'EPERM' || res.error?.code === 'EBUSY' || /EPERM|EBUSY/.test(stderr);
  };
  if (r.status !== 0 && isRetryable(r)) {
    console.log(`  \x1b[33m[WARN]\x1b[0m npm install hit file-lock error, retrying in 2s...`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000);
    r = spawnSync('npm', ['install', '--omit=dev'], spawnOpts);
  }
  const undiciDir = join(pluginsDir, 'node_modules', 'undici');
  if (r.status === 0 && existsSync(undiciDir)) {
    console.log(`  Runtime deps installed -> ${join(pluginsDir, 'node_modules')}`);
  } else {
    const errCode = r.error?.code;
    const err = (r.stderr || '').toString().trim().split(/\r?\n/).slice(-2).join(' ');
    const hint = errCode === 'ENOENT' ? ' (npm not found — ensure Node.js/npm is in PATH)' : '';
    console.log(`  \x1b[33m[WARN]\x1b[0m npm install failed in ${pluginsDir}${err ? `: ${err}` : ''}${hint}`);
    console.log('  Manual fix: cd %s && npm install', pluginsDir);
    if (!existsSync(undiciDir)) {
      console.log(`  \x1b[31m[ERROR]\x1b[0m undici is NOT installed. MCP server will fail to start.`);
      console.log(`  Run manually: cd "${pluginsDir}" && npm install undici@^8.10.0`);
    }
  }
}

function removeIfExists(p) {
  if (existsSync(p)) {
    try {
      rmSync(p, { recursive: true, force: true });
      return true;
    } catch (error) {
      console.log(`  \x1b[33m[WARN]\x1b[0m Could not remove ${p}: ${error.message}`);
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
    try {
      config = JSON.parse(readFileSync(configPath, 'utf8'));
    } catch {
      console.log(
        `  \x1b[33m[WARN]\x1b[0m Could not parse ${configPath} (jsonc comments?). Skipping MCP config write; ensure "mcp.huaweicloud-devkit" points to ${mcpPath}.`,
      );
      return;
    }
    const existing = config.mcp?.['huaweicloud-devkit'];
    if (
      existing &&
      existing.type === 'local' &&
      Array.isArray(existing.command) &&
      existing.command[0] === 'node' &&
      existing.command[1] === mcpPath &&
      existing.timeout === 300000
    ) {
      console.log(`  OpenCode MCP config unchanged: ${configPath}`);
      return;
    }
  }
  config.mcp = config.mcp || {};
  config.mcp['huaweicloud-devkit'] = {
    type: 'local',
    command: ['node', mcpPath],
    enabled: true,
    timeout: 300000,
  };
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  console.log(`  OpenCode MCP config updated: ${configPath}`);
}

function removeOpenCodeConfig() {
  const configPath = opencodeConfigFile();
  if (!existsSync(configPath)) return;
  let config;
  try {
    config = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch {
    return;
  }
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
  const bin = findHcloudBin() || process.env.HCLOUD_BIN || 'hcloud';
  if (!existsSync(bin)) return false;
  try {
    if (statSync(bin).size < 1024) return false;
  } catch {
    return false;
  }
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
    shell: true,
    windowsHide: true,
    stdio: 'pipe',
  });
  console.log(`  ${r1.stdout ? r1.stdout.toString().trim() : r1.stderr.toString().trim()}`);

  if (r1.status !== 0 && /Access is denied/i.test((r1.stderr || '').toString())) {
    console.log(`  \x1b[33mWindowsApps codex.exe permission denied.\x1b[0m`);
    console.log(`  \x1b[33mUse: npx huaweicloud-devkit install --target codex-desktop\x1b[0m`);
    return false;
  }

  console.log(`  Installing plugin: ${pluginName}@${marketplaceName}`);
  const r2 = spawnSync(`codex plugin add "${pluginName}@${marketplaceName}"`, [], {
    shell: true,
    windowsHide: true,
    stdio: 'pipe',
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
    shell: true,
    windowsHide: true,
    stdio: 'pipe',
  });
  console.log(`  ${r.stdout ? r.stdout.toString().trim() : r.stderr.toString().trim()}`);

  for (const name of new Set([marketplaceName, 'HuaweiCloud-Devkit'])) {
    console.log(`  Removing Codex marketplace: ${name}`);
    const r2 = spawnSync(`codex plugin marketplace remove "${name}"`, [], {
      shell: true,
      windowsHide: true,
      stdio: 'pipe',
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
  installRuntimeDeps(pluginDest);
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
  console.log(
    `  Commands updated -> ${opencodeCommandsDir()}${staleCommands > 0 ? ` (removed ${staleCommands} stale)` : ''}`,
  );
  copyDir(srcDir, join(pluginDest, 'src'));
  console.log(`  MCP Server updated -> ${join(pluginDest, 'src')}`);
  copyDir(safetyDir, join(pluginDest, 'safety'));
  console.log(`  Safety Policy updated -> ${join(pluginDest, 'safety')}`);
  updateOpenCodeConfig(pluginDest);
  mkdirSync(pluginDest, { recursive: true });
  writeFileSync(join(pluginDest, '.installed'), new Date().toISOString());
  installRuntimeDeps(pluginDest);
}

function codexMarketplacePath() {
  return join(homedir(), '.agents', 'plugins', 'marketplace.json');
}

function ensureCodexMarketplaceEntry() {
  const mpPath = codexMarketplacePath();
  const pluginName = 'huaweicloud-devkit';
  const entry = {
    name: pluginName,
    source: { source: 'local', path: './plugins/huaweicloud-devkit' },
    policy: { installation: 'INSTALLED_BY_DEFAULT', authentication: 'ON_INSTALL' },
    category: 'Cloud',
  };

  let marketplace;
  if (existsSync(mpPath)) {
    try {
      marketplace = JSON.parse(readFileSync(mpPath, 'utf8'));
    } catch {
      marketplace = null;
    }
  }

  if (!marketplace || !marketplace.name || !Array.isArray(marketplace.plugins)) {
    marketplace = {
      name: 'personal',
      interface: { displayName: 'Personal' },
      plugins: [],
    };
  }

  const existingIdx = marketplace.plugins.findIndex((p) => p.name === pluginName);
  let changed = false;
  if (existingIdx >= 0) {
    const existing = marketplace.plugins[existingIdx];
    if (
      existing.source?.path !== entry.source.path ||
      existing.policy?.installation !== entry.policy.installation ||
      existing.policy?.authentication !== entry.policy.authentication
    ) {
      marketplace.plugins[existingIdx] = entry;
      changed = true;
    }
  } else {
    marketplace.plugins.push(entry);
    changed = true;
  }

  if (changed) {
    mkdirSync(dirname(mpPath), { recursive: true });
    writeFileSync(mpPath, JSON.stringify(marketplace, null, 2) + '\n');
    console.log(`  Marketplace updated: ${mpPath}`);
  } else {
    console.log(`  Marketplace unchanged: ${mpPath}`);
  }
}

function removeCodexMarketplaceEntry() {
  const mpPath = codexMarketplacePath();
  if (!existsSync(mpPath)) return;
  let marketplace;
  try {
    marketplace = JSON.parse(readFileSync(mpPath, 'utf8'));
  } catch {
    return;
  }
  if (!marketplace.plugins) return;
  const before = marketplace.plugins.length;
  marketplace.plugins = marketplace.plugins.filter((p) => p.name !== 'huaweicloud-devkit');
  if (marketplace.plugins.length === before) return;
  writeFileSync(mpPath, JSON.stringify(marketplace, null, 2) + '\n');
  console.log('  Marketplace entry removed');
}

async function installOpenClaw() {
  const skillsSrc = join(PLUGIN_ROOT, 'skills');
  const commandsSrc = join(PACKAGE_ROOT, 'integrations', 'opencode', 'commands');
  const srcDir = join(PLUGIN_ROOT, 'src');
  const safetyDir = join(PLUGIN_ROOT, 'safety');
  const pluginDest = openclawPluginsDir();

  mkdirSync(pluginDest, { recursive: true });
  copyDir(skillsSrc, openclawSkillsDir());
  console.log(`  Skills -> ${openclawSkillsDir()}`);
  copyDir(commandsSrc, join(homedir(), '.agents', 'commands'));
  console.log(`  Commands -> ${join(homedir(), '.agents', 'commands')}`);
  copyDir(srcDir, join(pluginDest, 'src'));
  console.log(`  MCP Server -> ${join(pluginDest, 'src')}`);
  copyDir(safetyDir, join(pluginDest, 'safety'));
  console.log(`  Safety Policy -> ${join(pluginDest, 'safety')}`);

  const mcpServerAbsPath = join(pluginDest, 'src', 'mcp-server.mjs').replace(/\\/g, '/');
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
  console.log(`  MCP Config -> ${join(pluginDest, '.mcp.json')}`);

  const codexPluginSrc = join(PLUGIN_ROOT, '.codex-plugin');
  if (existsSync(codexPluginSrc)) {
    copyDir(codexPluginSrc, join(pluginDest, '.codex-plugin'));
    console.log(`  Plugin Manifest -> ${join(pluginDest, '.codex-plugin')}`);
  }

  writeFileSync(join(pluginDest, '.installed'), new Date().toISOString());
  installRuntimeDeps(pluginDest);
}

function uninstallOpenClaw() {
  const skillsDir = openclawSkillsDir();
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

  const cmdDir = join(homedir(), '.agents', 'commands');
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

  if (removeIfExists(openclawPluginsDir())) {
    console.log('  Removed MCP server and safety policy');
  }
}

async function updateOpenClaw() {
  const skillsSrc = join(PLUGIN_ROOT, 'skills');
  const commandsSrc = join(PACKAGE_ROOT, 'integrations', 'opencode', 'commands');
  const srcDir = join(PLUGIN_ROOT, 'src');
  const safetyDir = join(PLUGIN_ROOT, 'safety');
  const pluginDest = openclawPluginsDir();

  mkdirSync(pluginDest, { recursive: true });
  copyDir(skillsSrc, openclawSkillsDir());
  const staleSkills = pruneStale(openclawSkillsDir(), skillsSrc);
  console.log(`  Skills updated -> ${openclawSkillsDir()}${staleSkills > 0 ? ` (removed ${staleSkills} stale)` : ''}`);
  copyDir(commandsSrc, join(homedir(), '.agents', 'commands'));
  console.log(`  Commands updated -> ${join(homedir(), '.agents', 'commands')}`);
  copyDir(srcDir, join(pluginDest, 'src'));
  console.log(`  MCP Server updated -> ${join(pluginDest, 'src')}`);
  copyDir(safetyDir, join(pluginDest, 'safety'));
  console.log(`  Safety Policy updated -> ${join(pluginDest, 'safety')}`);

  const mcpServerAbsPath = join(pluginDest, 'src', 'mcp-server.mjs').replace(/\\/g, '/');
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

  writeFileSync(join(pluginDest, '.installed'), new Date().toISOString());
  installRuntimeDeps(pluginDest);
}

async function installCodexDesktop() {
  const skillsSrc = join(PLUGIN_ROOT, 'skills');
  const commandsSrc = join(PACKAGE_ROOT, 'integrations', 'opencode', 'commands');
  const srcDir = join(PLUGIN_ROOT, 'src');
  const safetyDir = join(PLUGIN_ROOT, 'safety');
  const pluginDest = codexDesktopPluginsDir();

  mkdirSync(pluginDest, { recursive: true });
  copyDir(skillsSrc, join(pluginDest, 'skills'));
  console.log(`  Skills -> ${join(pluginDest, 'skills')}`);
  copyDir(commandsSrc, join(pluginDest, 'commands'));
  console.log(`  Commands -> ${join(pluginDest, 'commands')}`);
  copyDir(srcDir, join(pluginDest, 'src'));
  console.log(`  MCP Server -> ${join(pluginDest, 'src')}`);
  copyDir(safetyDir, join(pluginDest, 'safety'));
  console.log(`  Safety Policy -> ${join(pluginDest, 'safety')}`);

  // Copy assets (icons, logos) for Codex Desktop plugin UI
  const codexAssetsSrc = join(PLUGIN_ROOT, 'assets');
  if (existsSync(codexAssetsSrc)) {
    copyDir(codexAssetsSrc, join(pluginDest, 'assets'));
    console.log(`  Assets -> ${join(pluginDest, 'assets')}`);
  }

  // Generate .mcp.json for Codex plugin MCP server discovery
  const mcpServerAbsPath = join(pluginDest, 'src', 'mcp-server.mjs').replace(/\\/g, '/');
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
  console.log(`  MCP Config -> ${join(pluginDest, '.mcp.json')}`);

  // Copy .codex-plugin manifest for Codex Desktop plugin registration
  const codexPluginSrc = join(PLUGIN_ROOT, '.codex-plugin');
  if (existsSync(codexPluginSrc)) {
    copyDir(codexPluginSrc, join(pluginDest, '.codex-plugin'));
    console.log(`  Plugin Manifest -> ${join(pluginDest, '.codex-plugin')}`);
  }

  // Register in personal marketplace (Codex discovers plugins from ~/.agents/plugins/marketplace.json)
  ensureCodexMarketplaceEntry();
  console.log('  \x1b[33m请到插件 → 个人 → HuaweiCloud Devkit → 安装\x1b[0m');

  // Clean up old install locations from pre-marketplace era
  removeIfExists(join(homedir(), '.agents', 'skills'));
  removeIfExists(join(homedir(), '.agents', 'commands'));
  const oldPluginsDir = join(homedir(), '.agents', 'huaweicloud-plugins');
  if (existsSync(oldPluginsDir)) {
    removeIfExists(oldPluginsDir);
    console.log('  Cleaned old install location');
  }

  installRuntimeDeps(pluginDest);
}

// Incremental update: overwrite copied files, prune stale ones, and only touch the config when necessary.
async function updateCodexDesktop() {
  const skillsSrc = join(PLUGIN_ROOT, 'skills');
  const commandsSrc = join(PACKAGE_ROOT, 'integrations', 'opencode', 'commands');
  const srcDir = join(PLUGIN_ROOT, 'src');
  const safetyDir = join(PLUGIN_ROOT, 'safety');
  const pluginDest = codexDesktopPluginsDir();

  mkdirSync(pluginDest, { recursive: true });
  copyDir(skillsSrc, join(pluginDest, 'skills'));
  const staleSkills = pruneStale(join(pluginDest, 'skills'), skillsSrc);
  console.log(
    `  Skills updated -> ${join(pluginDest, 'skills')}${staleSkills > 0 ? ` (removed ${staleSkills} stale)` : ''}`,
  );
  copyDir(commandsSrc, join(pluginDest, 'commands'));
  const staleCommands = pruneStale(join(pluginDest, 'commands'), commandsSrc);
  console.log(
    `  Commands updated -> ${join(pluginDest, 'commands')}${staleCommands > 0 ? ` (removed ${staleCommands} stale)` : ''}`,
  );
  copyDir(srcDir, join(pluginDest, 'src'));
  console.log(`  MCP Server updated -> ${join(pluginDest, 'src')}`);
  copyDir(safetyDir, join(pluginDest, 'safety'));
  console.log(`  Safety Policy updated -> ${join(pluginDest, 'safety')}`);

  // Copy assets (icons, logos) for Codex Desktop plugin UI
  const codexAssetsSrc = join(PLUGIN_ROOT, 'assets');
  if (existsSync(codexAssetsSrc)) {
    copyDir(codexAssetsSrc, join(pluginDest, 'assets'));
    console.log(`  Assets updated -> ${join(pluginDest, 'assets')}`);
  }

  const mcpServerAbsPath = join(pluginDest, 'src', 'mcp-server.mjs').replace(/\\/g, '/');
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

  ensureCodexMarketplaceEntry();
  writeFileSync(join(pluginDest, '.installed'), new Date().toISOString());
  installRuntimeDeps(pluginDest);
}

function uninstallCodexDesktop() {
  const pluginDest = codexDesktopPluginsDir();
  let removed = 0;
  const skillsDir = join(pluginDest, 'skills');
  if (existsSync(skillsDir)) {
    for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
      if (entry.name.startsWith('huawei')) {
        removeIfExists(join(skillsDir, entry.name));
        removed++;
      }
    }
    console.log(`  Removed ${removed} skills`);
  }

  const cmdDir = join(pluginDest, 'commands');
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

  if (removeIfExists(pluginDest)) {
    console.log('  Removed MCP server and safety policy');
  }
  removeCodexMarketplaceEntry();

  // Clean up Codex plugin cache
  const cacheDir = join(homedir(), '.codex', 'plugins', 'cache', 'personal', 'huaweicloud-devkit');
  if (removeIfExists(cacheDir)) {
    console.log('  Codex plugin cache cleaned');
  }

  // Clean up old config.toml section from pre-marketplace era
  const configPath = join(homedir(), '.codex', 'config.toml');
  if (existsSync(configPath)) {
    const lines = readFileSync(configPath, 'utf8').split(/\r?\n/);
    const out = [];
    let skip = false;
    for (const line of lines) {
      if (/^\[mcp_servers\.huaweicloud-devkit(\]|\.)/.test(line)) {
        skip = true;
        continue;
      }
      if (skip && line.startsWith('[')) skip = false;
      if (!skip) out.push(line);
    }
    while (out.length > 0 && out[out.length - 1].trim() === '') out.pop();
    writeFileSync(configPath, out.join('\n') + (out.length > 0 ? '\n' : ''));
  }
}

function registerCodeartsMcp(configPath) {
  const mcpPath = join(codeartsPluginsDir(), 'src', 'mcp-server.mjs').replace(/\\/g, '/');
  const env = { HUAWEICLOUD_AGENT_TOOLKIT_MODE: 'local' };
  const hcloudBin = findHcloudBin();
  if (hcloudBin) env.HCLOUD_BIN = hcloudBin.replace(/\\/g, '/');
  let config = {};
  if (existsSync(configPath)) {
    try {
      config = JSON.parse(readFileSync(configPath, 'utf8'));
    } catch {
      console.log(
        `  \x1b[33m[WARN]\x1b[0m Could not parse ${configPath}. Skipping MCP config write; ensure "mcpServers.huaweicloud-devkit" points to ${mcpPath}.`,
      );
      return;
    }
    const existing = config.mcpServers?.['huaweicloud-devkit'];
    if (
      existing &&
      existing.command === 'node' &&
      Array.isArray(existing.args) &&
      existing.args[0] === mcpPath &&
      existing.timeout === 300000
    ) {
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
    timeout: 300000,
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
  installRuntimeDeps(pluginDest);
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
  installRuntimeDeps(pluginDest);
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
    try {
      config = JSON.parse(readFileSync(configPath, 'utf8'));
    } catch {}
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
  console.log(
    `  MCP Server: ${existsSync(join(pluginDir, 'src', 'mcp-server.mjs')) ? '\x1b[32mInstalled\x1b[0m' : '\x1b[31mNot installed\x1b[0m'}`,
  );
  console.log(
    `  Safety Policy: ${existsSync(join(pluginDir, 'safety', 'policy.json')) ? '\x1b[32mInstalled\x1b[0m' : '\x1b[31mNot installed\x1b[0m'}`,
  );
  let skillCount = 0;
  if (existsSync(codeartsSkillsDir())) {
    skillCount = readdirSync(codeartsSkillsDir(), { withFileTypes: true }).filter(
      (d) => d.isDirectory() && d.name.startsWith('huawei'),
    ).length;
  }
  console.log(
    `  Skills: ${skillCount > 0 ? `\x1b[32m${skillCount} installed\x1b[0m` : '\x1b[31mNot installed\x1b[0m'}`,
  );
  if (existsSync(codeartsMcpSettingsFile())) {
    try {
      const config = JSON.parse(readFileSync(codeartsMcpSettingsFile(), 'utf8'));
      console.log(
        `  MCP config: ${config.mcpServers?.['huaweicloud-devkit'] ? '\x1b[32mConfigured\x1b[0m' : '\x1b[31mNot configured\x1b[0m'}`,
      );
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
    try {
      config = JSON.parse(readFileSync(configPath, 'utf8'));
    } catch {
      console.log(
        `  \x1b[33m[WARN]\x1b[0m Could not parse ${configPath}. Skipping MCP config write; ensure "mcpServers.huaweicloud-devkit" points to ${mcpPath}.`,
      );
      return;
    }
    const existing = config.mcpServers?.['huaweicloud-devkit'];
    if (
      existing &&
      existing.command === 'node' &&
      Array.isArray(existing.args) &&
      existing.args[0] === mcpPath &&
      existing.timeout === 300000
    ) {
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
    timeout: 300000,
  };
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
      if (entry.name.startsWith('huawei')) {
        removeIfExists(join(skillsDir, entry.name));
        removed++;
      }
    }
    if (removed > 0) console.log(`  Removed ${removed} skills`);
  }

  if (removeIfExists(codeartsWorkPluginsDir())) {
    console.log('  Removed MCP server and safety policy');
  }

  const configPath = codeartsWorkMcpSettingsFile();
  if (existsSync(configPath)) {
    let config = {};
    try {
      config = JSON.parse(readFileSync(configPath, 'utf8'));
    } catch {}
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
  console.log(
    `  MCP Server: ${existsSync(join(pluginDir, 'src', 'mcp-server.mjs')) ? '\x1b[32mInstalled\x1b[0m' : '\x1b[31mNot installed\x1b[0m'}`,
  );
  console.log(
    `  Safety Policy: ${existsSync(join(pluginDir, 'safety', 'policy.json')) ? '\x1b[32mInstalled\x1b[0m' : '\x1b[31mNot installed\x1b[0m'}`,
  );
  let skillCount = 0;
  if (existsSync(codeartsWorkSkillsDir())) {
    skillCount = readdirSync(codeartsWorkSkillsDir(), { withFileTypes: true }).filter(
      (d) => d.isDirectory() && d.name.startsWith('huawei'),
    ).length;
  }
  console.log(
    `  Skills: ${skillCount > 0 ? `\x1b[32m${skillCount} installed\x1b[0m` : '\x1b[31mNot installed\x1b[0m'}`,
  );
  if (existsSync(codeartsWorkMcpSettingsFile())) {
    try {
      const config = JSON.parse(readFileSync(codeartsWorkMcpSettingsFile(), 'utf8'));
      console.log(
        `  MCP config: ${config.mcpServers?.['huaweicloud-devkit'] ? '\x1b[32mConfigured\x1b[0m' : '\x1b[31mNot configured\x1b[0m'}`,
      );
    } catch {
      console.log(`  MCP config: \x1b[31mInvalid\x1b[0m`);
    }
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
    try {
      config = JSON.parse(readFileSync(configPath, 'utf8'));
    } catch {
      console.log(
        `  \x1b[33m[WARN]\x1b[0m Could not parse ${configPath}. Skipping MCP config write; ensure "mcpServers.huaweicloud-devkit" points to ${mcpPath}.`,
      );
      return false;
    }
    const existing = config.mcpServers?.['huaweicloud-devkit'];
    if (
      existing &&
      existing.command === 'node' &&
      Array.isArray(existing.args) &&
      existing.args[0] === mcpPath &&
      existing.timeout === 300000
    ) {
      console.log(`  MCP config unchanged: ${configPath}`);
      return false;
    }
  }
  config.mcpServers = config.mcpServers || {};
  config.mcpServers['huaweicloud-devkit'] = {
    command: 'node',
    args: [mcpPath],
    env,
    timeout: 300000,
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
  installRuntimeDeps(pluginDest);
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
  installRuntimeDeps(pluginDest);
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
    try {
      config = JSON.parse(readFileSync(configPath, 'utf8'));
    } catch {}
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
  console.log(
    `  MCP Server: ${existsSync(join(pluginDir, 'src', 'mcp-server.mjs')) ? '\x1b[32mInstalled\x1b[0m' : '\x1b[31mNot installed\x1b[0m'}`,
  );
  console.log(
    `  Safety Policy: ${existsSync(join(pluginDir, 'safety', 'policy.json')) ? '\x1b[32mInstalled\x1b[0m' : '\x1b[31mNot installed\x1b[0m'}`,
  );
  let skillCount = 0;
  if (existsSync(skillsDir)) {
    skillCount = readdirSync(skillsDir, { withFileTypes: true }).filter(
      (d) => d.isDirectory() && d.name.startsWith('huawei'),
    ).length;
  }
  console.log(
    `  Skills: ${skillCount > 0 ? `\x1b[32m${skillCount} installed\x1b[0m` : '\x1b[31mNot installed\x1b[0m'}`,
  );
  const configPath = workbuddyMcpConfigFile();
  if (existsSync(configPath)) {
    try {
      const config = JSON.parse(readFileSync(configPath, 'utf8'));
      console.log(
        `  MCP config: ${config.mcpServers?.['huaweicloud-devkit'] ? '\x1b[32mConfigured\x1b[0m' : '\x1b[31mNot configured\x1b[0m'}`,
      );
    } catch {
      console.log(`  MCP config: \x1b[31mInvalid\x1b[0m`);
    }
  }
}

function ensureAtomcodeMcpConfig() {
  const configPath = atomcodeMcpConfigFile();
  const mcpPath = join(atomcodePluginsDir(), 'src', 'mcp-server.mjs').replace(/\\/g, '/');
  const env = { HUAWEICLOUD_AGENT_TOOLKIT_MODE: 'local' };
  const hcloudBin = findHcloudBin();
  if (hcloudBin) env.HCLOUD_BIN = hcloudBin.replace(/\\/g, '/');
  let config = {};
  if (existsSync(configPath)) {
    try {
      config = JSON.parse(readFileSync(configPath, 'utf8'));
    } catch {
      console.log(
        `  \x1b[33m[WARN]\x1b[0m Could not parse ${configPath}. Skipping MCP config write; ensure "mcpServers.huaweicloud-devkit" points to ${mcpPath}.`,
      );
      return false;
    }
    const existing = config.mcpServers?.['huaweicloud-devkit'];
    if (
      existing &&
      existing.command === 'node' &&
      Array.isArray(existing.args) &&
      existing.args[0] === mcpPath &&
      existing.timeout === 300000
    ) {
      console.log(`  MCP config unchanged: ${configPath}`);
      return false;
    }
  }
  config.mcpServers = config.mcpServers || {};
  config.mcpServers['huaweicloud-devkit'] = {
    command: 'node',
    args: [mcpPath],
    env,
    timeout: 300000,
  };
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  console.log(`  MCP config updated: ${configPath}`);
  return true;
}

async function installAtomCode() {
  const skillsSrc = join(PLUGIN_ROOT, 'skills');
  const srcDir = join(PLUGIN_ROOT, 'src');
  const safetyDir = join(PLUGIN_ROOT, 'safety');
  const pluginDest = atomcodePluginsDir();

  copyDir(skillsSrc, atomcodeSkillsDir());
  console.log(`  Skills -> ${atomcodeSkillsDir()}`);

  copyDir(srcDir, join(pluginDest, 'src'));
  console.log(`  MCP Server -> ${join(pluginDest, 'src')}`);
  copyDir(safetyDir, join(pluginDest, 'safety'));
  console.log(`  Safety Policy -> ${join(pluginDest, 'safety')}`);

  ensureAtomcodeMcpConfig();
  installRuntimeDeps(pluginDest);
}

// Incremental update: overwrite copied files, prune stale ones, and only touch the config when necessary.
async function updateAtomCode() {
  const skillsSrc = join(PLUGIN_ROOT, 'skills');
  const srcDir = join(PLUGIN_ROOT, 'src');
  const safetyDir = join(PLUGIN_ROOT, 'safety');
  const pluginDest = atomcodePluginsDir();

  copyDir(skillsSrc, atomcodeSkillsDir());
  const stale = pruneStale(atomcodeSkillsDir(), skillsSrc);
  console.log(`  Skills updated -> ${atomcodeSkillsDir()}${stale > 0 ? ` (removed ${stale} stale)` : ''}`);
  copyDir(srcDir, join(pluginDest, 'src'));
  console.log(`  MCP Server updated -> ${join(pluginDest, 'src')}`);
  copyDir(safetyDir, join(pluginDest, 'safety'));
  console.log(`  Safety Policy updated -> ${join(pluginDest, 'safety')}`);
  ensureAtomcodeMcpConfig();
  mkdirSync(pluginDest, { recursive: true });
  writeFileSync(join(pluginDest, '.installed'), new Date().toISOString());
  installRuntimeDeps(pluginDest);
}

function uninstallAtomCode() {
  const skillsDir = atomcodeSkillsDir();
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

  if (removeIfExists(atomcodePluginsDir())) {
    console.log('  Removed MCP server and safety policy');
  }

  const configPath = atomcodeMcpConfigFile();
  if (existsSync(configPath)) {
    let config = {};
    try {
      config = JSON.parse(readFileSync(configPath, 'utf8'));
    } catch {}
    if (config.mcpServers?.['huaweicloud-devkit']) {
      delete config.mcpServers['huaweicloud-devkit'];
      if (Object.keys(config.mcpServers).length === 0) delete config.mcpServers;
      writeFileSync(configPath, JSON.stringify(config, null, 2));
      console.log(`  MCP config cleaned: ${configPath}`);
    }
  }
}

function atomcodeStatus() {
  const pluginDir = atomcodePluginsDir();
  const skillsDir = atomcodeSkillsDir();
  console.log(
    `  MCP Server: ${existsSync(join(pluginDir, 'src', 'mcp-server.mjs')) ? '\x1b[32mInstalled\x1b[0m' : '\x1b[31mNot installed\x1b[0m'}`,
  );
  console.log(
    `  Safety Policy: ${existsSync(join(pluginDir, 'safety', 'policy.json')) ? '\x1b[32mInstalled\x1b[0m' : '\x1b[31mNot installed\x1b[0m'}`,
  );
  let skillCount = 0;
  if (existsSync(skillsDir)) {
    skillCount = readdirSync(skillsDir, { withFileTypes: true }).filter(
      (d) => d.isDirectory() && d.name.startsWith('huawei'),
    ).length;
  }
  console.log(
    `  Skills: ${skillCount > 0 ? `\x1b[32m${skillCount} installed\x1b[0m` : '\x1b[31mNot installed\x1b[0m'}`,
  );
  const configPath = atomcodeMcpConfigFile();
  if (existsSync(configPath)) {
    try {
      const config = JSON.parse(readFileSync(configPath, 'utf8'));
      console.log(
        `  MCP config: ${config.mcpServers?.['huaweicloud-devkit'] ? '\x1b[32mConfigured\x1b[0m' : '\x1b[31mNot configured\x1b[0m'}`,
      );
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
  const envLines = ['          HUAWEICLOUD_AGENT_TOOLKIT_MODE: local', "          HDKITSERVICE_ENDPOINT: ''"];
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
  const pattern = new RegExp(
    `\\n?${escapeRegExp(DSH_MCP_PATCH_START)}[\\s\\S]*?${escapeRegExp(DSH_MCP_PATCH_END)}\\s*`,
    'g',
  );
  return String(content || '')
    .replace(pattern, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd();
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
  const next = dshPatchHasOnlyCommentsOrEmptyList(cleaned) ? `${prefix ? `${prefix}\n` : ''}[]\n` : `${cleaned}\n`;
  writeFileSync(patchFile, next);
  console.log(`  DSH patch cleaned: ${patchFile}`);
  return true;
}

function dshPatchConfigured() {
  const patchFile = dshPatchFile();
  if (!existsSync(patchFile)) return false;
  try {
    const patch = readFileSync(patchFile, 'utf8');
    return (
      patch.includes('id: mcp-huaweicloud') &&
      patch.includes('@deepseek-ai/dsh-mcp-client') &&
      patch.includes('serverName: huaweicloud')
    );
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
    return Boolean(
      pkg.dependencies?.['@deepseek-ai/dsh-mcp-client'] || pkg.devDependencies?.['@deepseek-ai/dsh-mcp-client'],
    );
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

  mkdirSync(pluginDest, { recursive: true });
  copyDir(skillsSrc, dshSkillsDir());
  console.log(`  Skills -> ${dshSkillsDir()}`);
  copyDir(srcDir, join(pluginDest, 'src'));
  console.log(`  MCP Server -> ${join(pluginDest, 'src')}`);
  copyDir(safetyDir, join(pluginDest, 'safety'));
  console.log(`  Safety Policy -> ${join(pluginDest, 'safety')}`);
  ensureDshMcpPatch();
  tryInstallDshMcpClient();
  installRuntimeDeps(pluginDest);
  writeFileSync(join(pluginDest, '.installed'), new Date().toISOString());
}

async function updateDsh() {
  const skillsSrc = join(PLUGIN_ROOT, 'skills');
  const srcDir = join(PLUGIN_ROOT, 'src');
  const safetyDir = join(PLUGIN_ROOT, 'safety');
  const pluginDest = dshPluginsDir();

  mkdirSync(pluginDest, { recursive: true });
  copyDir(skillsSrc, dshSkillsDir());
  const stale = pruneStale(dshSkillsDir(), skillsSrc);
  console.log(`  Skills updated -> ${dshSkillsDir()}${stale > 0 ? ` (removed ${stale} stale)` : ''}`);
  copyDir(srcDir, join(pluginDest, 'src'));
  console.log(`  MCP Server updated -> ${join(pluginDest, 'src')}`);
  copyDir(safetyDir, join(pluginDest, 'safety'));
  console.log(`  Safety Policy updated -> ${join(pluginDest, 'safety')}`);
  ensureDshMcpPatch();
  tryInstallDshMcpClient();
  installRuntimeDeps(pluginDest);
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
  console.log(
    `  MCP Server: ${existsSync(join(pluginDir, 'src', 'mcp-server.mjs')) ? '\x1b[32mInstalled\x1b[0m' : '\x1b[31mNot installed\x1b[0m'}`,
  );
  console.log(
    `  Safety Policy: ${existsSync(join(pluginDir, 'safety', 'policy.json')) ? '\x1b[32mInstalled\x1b[0m' : '\x1b[31mNot installed\x1b[0m'}`,
  );
  let skillCount = 0;
  if (existsSync(skillsDir)) {
    skillCount = readdirSync(skillsDir, { withFileTypes: true }).filter(
      (d) => d.isDirectory() && d.name.startsWith('huawei'),
    ).length;
  }
  console.log(
    `  Skills: ${skillCount > 0 ? `\x1b[32m${skillCount} installed\x1b[0m` : '\x1b[31mNot installed\x1b[0m'}`,
  );
  console.log(`  DSH patch: ${dshPatchConfigured() ? '\x1b[32mConfigured\x1b[0m' : '\x1b[31mNot configured\x1b[0m'}`);
  console.log(
    `  DSH MCP client package: ${dshMcpClientAvailable() ? '\x1b[32mDetected\x1b[0m' : '\x1b[33mCheck DSH profile\x1b[0m'}`,
  );
}

async function promptOfficeaceInstallDir() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise((resolve) => rl.question(q, resolve));
  while (true) {
    const path = (await ask('  Install directory: ')).trim();
    if (!path) {
      console.log('  \x1b[33mPath cannot be empty.\x1b[0m');
      continue;
    }
    const capFile = join(path, '.office-claw', 'capabilities.json');
    if (existsSync(capFile)) {
      rl.close();
      return path;
    }
    console.log(`  \x1b[33mcapabilities.json not found at: ${capFile}\x1b[0m`);
    console.log('  Please verify the path and try again.');
  }
}

async function installOfficeAce() {
  if (!officeaceCapabilitiesDir()) {
    if (process.stdin.isTTY) {
      console.log('  \x1b[33mOfficeAce install directory not found automatically.\x1b[0m');
      console.log('  Please enter the OfficeAce install directory.');
      const entered = await promptOfficeaceInstallDir();
      process.env.OFFICE_CLAW_CONFIG_ROOT = join(entered, '.office-claw');
    } else {
      console.log(
        '  \x1b[31mOfficeAce install directory not found. Please set OFFICE_CLAW_CONFIG_ROOT env var and retry.\x1b[0m',
      );
      return;
    }
  }
  const skillsSrc = join(PLUGIN_ROOT, 'skills');
  const srcDir = join(PLUGIN_ROOT, 'src');
  const safetyDir = join(PLUGIN_ROOT, 'safety');
  const pluginDest = officeacePluginsDir();

  copyDir(skillsSrc, officeaceSkillsDir());
  console.log(`  Skills -> ${officeaceSkillsDir()}`);

  copyDir(srcDir, join(pluginDest, 'src'));
  console.log(`  MCP Server -> ${join(pluginDest, 'src')}`);
  copyDir(safetyDir, join(pluginDest, 'safety'));
  console.log(`  Safety Policy -> ${join(pluginDest, 'safety')}`);

  installRuntimeDeps(pluginDest);
  ensureOfficeaceMcpInSqlite();
  registerOfficeaceSkillEntries();
}

async function updateOfficeAce() {
  const skillsSrc = join(PLUGIN_ROOT, 'skills');
  const srcDir = join(PLUGIN_ROOT, 'src');
  const safetyDir = join(PLUGIN_ROOT, 'safety');
  const pluginDest = officeacePluginsDir();

  copyDir(skillsSrc, officeaceSkillsDir());
  const stale = pruneStale(officeaceSkillsDir(), skillsSrc);
  console.log(`  Skills updated -> ${officeaceSkillsDir()}${stale > 0 ? ` (removed ${stale} stale)` : ''}`);
  copyDir(srcDir, join(pluginDest, 'src'));
  console.log(`  MCP Server updated -> ${join(pluginDest, 'src')}`);
  copyDir(safetyDir, join(pluginDest, 'safety'));
  console.log(`  Safety Policy updated -> ${join(pluginDest, 'safety')}`);
  installRuntimeDeps(pluginDest);
  ensureOfficeaceMcpInSqlite();
  registerOfficeaceSkillEntries();
  mkdirSync(pluginDest, { recursive: true });
  writeFileSync(join(pluginDest, '.installed'), new Date().toISOString());
}

function uninstallOfficeAce() {
  const skillsDir = officeaceSkillsDir();
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

  if (removeIfExists(officeacePluginsDir())) {
    console.log('  Removed MCP server and safety policy');
  }
  removeOfficeaceSkillCapabilities();
  removeOfficeaceMcpFromSqlite();
}

function officeaceStatus() {
  const pluginDir = officeacePluginsDir();
  const skillsDir = officeaceSkillsDir();
  console.log(
    `  MCP Server: ${existsSync(join(pluginDir, 'src', 'mcp-server.mjs')) ? '\x1b[32mInstalled\x1b[0m' : '\x1b[31mNot installed\x1b[0m'}`,
  );
  console.log(
    `  Safety Policy: ${existsSync(join(pluginDir, 'safety', 'policy.json')) ? '\x1b[32mInstalled\x1b[0m' : '\x1b[31mNot installed\x1b[0m'}`,
  );
  let skillCount = 0;
  if (existsSync(skillsDir)) {
    skillCount = readdirSync(skillsDir, { withFileTypes: true }).filter(
      (d) => d.isDirectory() && d.name.startsWith('huawei'),
    ).length;
  }
  console.log(
    `  Skills: ${skillCount > 0 ? `\x1b[32m${skillCount} installed\x1b[0m` : '\x1b[31mNot installed\x1b[0m'}`,
  );
  const dbPath = officeaceSqlitePath();
  if (existsSync(dbPath)) {
    try {
      const db = openOfficeaceDb();
      const row = db.prepare("SELECT enabled, status FROM mcp_connectors WHERE name = 'huaweicloud-devkit'").get();
      db.close();
      if (row) {
        const statusIcon = row.status === 'connected' ? '\x1b[32m' : '\x1b[33m';
        console.log(`  MCP config: ${statusIcon}${row.status}\x1b[0m (enabled: ${row.enabled ? 'yes' : 'no'})`);
      } else {
        console.log(`  MCP config: \x1b[31mNot configured\x1b[0m`);
      }
    } catch {
      console.log(`  MCP config: \x1b[31mInvalid\x1b[0m`);
    }
  } else {
    console.log(`  MCP config: \x1b[31mDatabase not found\x1b[0m`);
  }
}

// ── Hermes Agent ──

function hermesHomeDir() {
  if (process.env.HERMES_HOME) return process.env.HERMES_HOME;
  // Hermes on Windows stores under LOCALAPPDATA, not ~/.hermes
  if (platform() === 'win32' && process.env.LOCALAPPDATA) {
    return join(process.env.LOCALAPPDATA, 'hermes');
  }
  return join(homedir(), '.hermes');
}

function hermesSkillsDir() {
  return join(hermesHomeDir(), 'skills');
}

function hermesPluginsDir() {
  return join(hermesHomeDir(), 'huaweicloud-plugins');
}

function hermesConfigFile() {
  return join(hermesHomeDir(), 'config.yaml');
}

// Returns true when the config file was written, false when it was already correct.
function ensureHermesMcpConfig() {
  const configPath = hermesConfigFile();
  const mcpPath = join(hermesPluginsDir(), 'src', 'mcp-server.mjs').replace(/\\/g, '/');
  const hcloudBin = findHcloudBin();

  const blockLines = [
    'mcp_servers:',
    '  huaweicloud-devkit:',
    '    command: "node"',
    `    args: ["${mcpPath}"]`,
    '    env:',
    '      HUAWEICLOUD_AGENT_TOOLKIT_MODE: "local"',
  ];
  if (hcloudBin) {
    blockLines.push(`      HCLOUD_BIN: "${hcloudBin.replace(/\\/g, '/')}"`);
  }
  const block = blockLines.join('\n');

  let existing = '';
  if (existsSync(configPath)) {
    try {
      existing = readFileSync(configPath, 'utf8');
    } catch {}
    if (existing.includes('mcp_servers:') && existing.includes('huaweicloud-devkit')) {
      if (existing.includes(`args: ["${mcpPath}"]`)) {
        console.log(`  MCP config unchanged: ${configPath}`);
        return false;
      }
      removeHermesMcpConfigBlock();
      existing = '';
      if (existsSync(configPath)) {
        try {
          existing = readFileSync(configPath, 'utf8');
        } catch {}
      }
    }
  }
  mkdirSync(dirname(configPath), { recursive: true });
  const newContent = existing ? `${existing.trimEnd()}\n\n${block}\n` : `${block}\n`;
  writeFileSync(configPath, newContent);
  console.log(`  MCP config updated: ${configPath}`);
  return true;
}

function removeHermesMcpConfigBlock() {
  const configPath = hermesConfigFile();
  if (!existsSync(configPath)) return;
  const lines = readFileSync(configPath, 'utf8').split(/\r?\n/);
  const out = [];
  let skip = false;
  for (const line of lines) {
    if (/^\s*huaweicloud-devkit\s*:/.test(line)) {
      skip = true;
      continue;
    }
    if (skip) {
      // Continue skipping indented lines (the server config block)
      if (/^\s{2,}/.test(line) && line.trim() !== '') continue;
      // Stop skipping at a top-level key or empty line
      skip = false;
    }
    // If we just skipped the only server under mcp_servers, remove the key too
    if (line.trim() === 'mcp_servers:') {
      continue; // skip the mcp_servers key for now, re-add if other servers exist
    }
    out.push(line);
  }
  // Reconstruct: add mcp_servers back if there are other servers
  const cleaned = out.join('\n').trimEnd();
  writeFileSync(configPath, cleaned ? `${cleaned}\n` : '');
  console.log('  MCP config cleaned');
}

function ensureHermesHooksConfig() {
  const configPath = hermesConfigFile();
  const pluginDest = hermesPluginsDir();
  const hookScript = join(pluginDest, 'hooks', 'huaweicloud-safety.py').replace(/\\/g, '/');

  const blockLines = [
    'hooks:',
    '  pre_tool_call:',
    '    - matcher: "terminal"',
    `      command: "python3 ${hookScript}"`,
    '      timeout: 5',
  ];
  const block = blockLines.join('\n');

  let existing = '';
  if (existsSync(configPath)) {
    try {
      existing = readFileSync(configPath, 'utf8');
    } catch {}
    if (existing.includes('hooks:') && existing.includes('huaweicloud-safety.py')) {
      console.log(`  Hooks config unchanged: ${configPath}`);
      return false;
    }
  }
  mkdirSync(dirname(configPath), { recursive: true });
  const newContent = existing ? `${existing.trimEnd()}\n\n${block}\n` : `${block}\n`;
  writeFileSync(configPath, newContent);
  console.log(`  Hooks config updated: ${configPath}`);
  return true;
}

function removeHermesHooksConfigBlock() {
  const configPath = hermesConfigFile();
  if (!existsSync(configPath)) return;
  const lines = readFileSync(configPath, 'utf8').split(/\r?\n/);
  let inHooksBlock = false;
  const out = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === 'hooks:' && !inHooksBlock) {
      inHooksBlock = true;
      continue;
    }
    if (inHooksBlock) {
      if (trimmed === '' || line.startsWith(' ') || line.startsWith('\t')) {
        continue;
      }
      inHooksBlock = false;
    }
    out.push(line);
  }
  const cleaned = out.join('\n').trimEnd();
  writeFileSync(configPath, cleaned ? `${cleaned}\n` : '');
  console.log('  Hooks config cleaned');
}

function ensureHermesMcpSdk() {
  const pythonBin = process.platform === 'win32' ? 'python' : 'python3';
  try {
    const r = spawnSync(pythonBin, ['-c', 'import mcp; print("ok")'], { encoding: 'utf8', timeout: 5000 });
    if (r.status === 0 && r.stdout.trim() === 'ok') {
      console.log('  MCP Python SDK: \x1b[32mAlready installed\x1b[0m');
      return true;
    }
  } catch {}
  console.log('  Installing Hermes MCP Python SDK...');
  try {
    const pip = spawnSync(pythonBin, ['-m', 'pip', 'install', 'mcp', '--quiet'], { encoding: 'utf8', timeout: 60000 });
    if (pip.status === 0) {
      console.log('  MCP Python SDK: \x1b[32mInstalled\x1b[0m');
      return true;
    }
    console.log(`  MCP Python SDK: \x1b[33mInstall failed\x1b[0m`);
    console.log(`  \x1b[33m  Run manually: ${pythonBin} -m pip install mcp\x1b[0m`);
  } catch (error) {
    console.log(`  MCP Python SDK: \x1b[33m${error.message}\x1b[0m`);
    console.log(`  \x1b[33m  Run manually: ${pythonBin} -m pip install mcp\x1b[0m`);
  }
  return false;
}

function hermesMcpSdkOk() {
  const pythonBin = process.platform === 'win32' ? 'python' : 'python3';
  try {
    const r = spawnSync(pythonBin, ['-c', 'import mcp; print("ok")'], { encoding: 'utf8', timeout: 5000 });
    return r.status === 0 && r.stdout.trim() === 'ok';
  } catch {
    return false;
  }
}

async function installHermes() {
  const skillsSrc = join(PLUGIN_ROOT, 'skills');
  const srcDir = join(PLUGIN_ROOT, 'src');
  const safetyDir = join(PLUGIN_ROOT, 'safety');
  const hooksDir = join(PLUGIN_ROOT, 'hooks');
  const pluginDest = hermesPluginsDir();
  const skipMcp = process.argv.includes('--skip-mcp-server');

  copyDir(skillsSrc, hermesSkillsDir());
  console.log(`  Skills -> ${hermesSkillsDir()}`);

  if (!skipMcp) {
    copyDir(srcDir, join(pluginDest, 'src'));
    console.log(`  MCP Server -> ${join(pluginDest, 'src')}`);
  }
  copyDir(safetyDir, join(pluginDest, 'safety'));
  console.log(`  Safety Policy -> ${join(pluginDest, 'safety')}`);
  copyDir(hooksDir, join(pluginDest, 'hooks'));
  console.log(`  Safety Hooks -> ${join(pluginDest, 'hooks')}`);

  if (!skipMcp) ensureHermesMcpConfig();
  ensureHermesHooksConfig();
  if (!skipMcp) installRuntimeDeps(pluginDest);
  if (!skipMcp) ensureHermesMcpSdk();
}

async function updateHermes() {
  const skillsSrc = join(PLUGIN_ROOT, 'skills');
  const srcDir = join(PLUGIN_ROOT, 'src');
  const safetyDir = join(PLUGIN_ROOT, 'safety');
  const hooksDir = join(PLUGIN_ROOT, 'hooks');
  const pluginDest = hermesPluginsDir();

  copyDir(skillsSrc, hermesSkillsDir());
  const stale = pruneStale(hermesSkillsDir(), skillsSrc);
  console.log(`  Skills updated -> ${hermesSkillsDir()}${stale > 0 ? ` (removed ${stale} stale)` : ''}`);
  copyDir(srcDir, join(pluginDest, 'src'));
  console.log(`  MCP Server updated -> ${join(pluginDest, 'src')}`);
  copyDir(safetyDir, join(pluginDest, 'safety'));
  console.log(`  Safety Policy updated -> ${join(pluginDest, 'safety')}`);
  copyDir(hooksDir, join(pluginDest, 'hooks'));
  console.log(`  Safety Hooks updated -> ${join(pluginDest, 'hooks')}`);
  ensureHermesMcpConfig();
  ensureHermesHooksConfig();
  ensureHermesMcpSdk();
  mkdirSync(pluginDest, { recursive: true });
  writeFileSync(join(pluginDest, '.installed'), new Date().toISOString());
  installRuntimeDeps(pluginDest);
}

function uninstallHermes() {
  const skillsDir = hermesSkillsDir();
  let removed = 0;

  // 1. Remove hook config from config.yaml (before deleting script files)
  removeHermesHooksConfigBlock();
  console.log('  Hooks config removed');

  // 2. Clean shell-hooks-allowlist.json (remove approved hook references)
  const hermesHome = hermesHomeDir();
  const allowlistPath = join(hermesHome, 'shell-hooks-allowlist.json');
  if (existsSync(allowlistPath)) {
    try {
      const allowlist = JSON.parse(readFileSync(allowlistPath, 'utf8'));
      const before = (allowlist.approvals || []).length;
      allowlist.approvals = (allowlist.approvals || []).filter((a) =>
        typeof a === 'string' ? !a.includes('huaweicloud-safety.py') : true,
      );
      if (allowlist.approvals.length < before) {
        writeFileSync(allowlistPath, JSON.stringify(allowlist, null, 2));
        console.log(`  Removed ${before - allowlist.approvals.length} hook approvals from allowlist`);
      }
    } catch {
      removeIfExists(allowlistPath);
      console.log('  Removed hook allowlist file');
    }
  }

  // 3. Remove MCP config from config.yaml
  removeHermesMcpConfigBlock();
  console.log('  MCP config removed');

  // 4. Remove skills (file deletion comes after config cleanup)
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

  // 5. Remove plugin directory (hook script files deleted last)
  if (removeIfExists(hermesPluginsDir())) {
    console.log('  Removed MCP server, safety policy and hooks');
  }
}

function hermesStatus() {
  const pluginDir = hermesPluginsDir();
  const skillsDir = hermesSkillsDir();
  console.log(
    `  MCP Server: ${existsSync(join(pluginDir, 'src', 'mcp-server.mjs')) ? '\x1b[32mInstalled\x1b[0m' : '\x1b[31mNot installed\x1b[0m'}`,
  );
  console.log(
    `  Safety Policy: ${existsSync(join(pluginDir, 'safety', 'policy.json')) ? '\x1b[32mInstalled\x1b[0m' : '\x1b[31mNot installed\x1b[0m'}`,
  );
  console.log(
    `  Safety Hooks: ${existsSync(join(pluginDir, 'hooks', 'huaweicloud-safety.py')) ? '\x1b[32mInstalled\x1b[0m' : '\x1b[31mNot installed\x1b[0m'}`,
  );
  console.log(`  MCP Python SDK: ${hermesMcpSdkOk() ? '\x1b[32mReady\x1b[0m' : '\x1b[31mMissing\x1b[0m'}`);
  let skillCount = 0;
  if (existsSync(skillsDir)) {
    skillCount = readdirSync(skillsDir, { withFileTypes: true }).filter(
      (d) => d.isDirectory() && d.name.startsWith('huawei'),
    ).length;
  }
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

function opencodeStatus() {
  const pluginDir = opencodePluginsDir();
  const skillsDir = opencodeSkillsDir();
  console.log(
    `  MCP Server: ${existsSync(join(pluginDir, 'src', 'mcp-server.mjs')) ? '\x1b[32mInstalled\x1b[0m' : '\x1b[31mNot installed\x1b[0m'}`,
  );
  console.log(
    `  Safety Policy: ${existsSync(join(pluginDir, 'safety', 'policy.json')) ? '\x1b[32mInstalled\x1b[0m' : '\x1b[31mNot installed\x1b[0m'}`,
  );
  let skillCount = 0;
  if (existsSync(skillsDir)) {
    skillCount = readdirSync(skillsDir, { withFileTypes: true }).filter(
      (d) => d.isDirectory() && d.name.startsWith('huawei'),
    ).length;
  }
  console.log(
    `  Skills: ${skillCount > 0 ? `\x1b[32m${skillCount} installed\x1b[0m` : '\x1b[31mNot installed\x1b[0m'}`,
  );
  const configPath = opencodeConfigFile();
  if (existsSync(configPath)) {
    try {
      const config = JSON.parse(readFileSync(configPath, 'utf8'));
      console.log(
        `  MCP config: ${config.mcp?.['huaweicloud-devkit'] ? '\x1b[32mConfigured\x1b[0m' : '\x1b[31mNot configured\x1b[0m'}`,
      );
    } catch {
      console.log(`  MCP config: \x1b[31mInvalid\x1b[0m`);
    }
  }
}

function autoDetectTarget() {
  const checks = [
    ['opencode', () => existsSync(join(homedir(), '.config', 'opencode'))],
    ['codex-desktop', () => existsSync(join(homedir(), '.codex'))],
    ['codearts', () => existsSync(join(homedir(), '.codeartsdoer'))],
    ['codearts-work', () => existsSync(join(homedir(), '.codeartswork'))],
    ['workbuddy', () => existsSync(join(homedir(), '.workbuddy'))],
    [
      'dsh',
      () => {
        const dsh = process.env.DSH_HOME || join(homedir(), '.dsh');
        return existsSync(dsh);
      },
    ],
    ['officeace', () => existsSync(officeaceCapabilitiesDir())],
    ['hermes', () => existsSync(hermesHomeDir())],
    ['openclaw', () => existsSync(join(homedir(), '.openclaw'))],
    ['atomcode', () => existsSync(atomcodeHome())],
  ];
  const detected = checks.filter(([, check]) => check()).map(([name]) => name);
  if (detected.length === 0) {
    console.error('No supported agent detected.');
    console.error(`Supported: ${SUPPORTED_AGENT_TARGETS.join(', ')} (or "all")`);
    console.error('Use --target <agent> to specify.');
    process.exit(1);
  }
  if (detected.length === 1) return detected[0];
  return 'all';
}

function parseTarget() {
  const idx = process.argv.indexOf('--target');
  if (idx < 0) return autoDetectTarget();
  const val = (process.argv[idx + 1] || '').toLowerCase();
  if (val === 'all' || SUPPORTED_AGENT_TARGETS.includes(val)) return val;
  console.error(`Unknown target: ${val}`);
  console.error(`Supported: ${SUPPORTED_AGENT_TARGETS.join(', ')} (or "all")`);
  process.exit(1);
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
  if (target === 'officeace' || target === 'all') {
    console.log('\n[OfficeAce]');
    await installOfficeAce();
  }
  if (target === 'hermes' || target === 'all') {
    console.log('\n[Hermes Agent]');
    await installHermes();
  }
  if (target === 'openclaw' || target === 'all') {
    console.log('\n[OpenClaw]');
    await installOpenClaw();
  }
  if (target === 'atomcode' || target === 'all') {
    console.log('\n[AtomCode]');
    await installAtomCode();
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
  const appName =
    target === 'codearts'
      ? 'CodeArts'
      : target === 'codearts-work'
        ? 'CodeArts Work'
        : target === 'codex-desktop'
          ? 'Codex Desktop'
          : target === 'codex'
            ? 'Codex'
            : target === 'workbuddy'
              ? 'WorkBuddy'
              : target === 'dsh'
                ? 'DSH'
                : target === 'officeace'
                  ? 'OfficeAce'
                  : target === 'hermes'
                    ? 'Hermes Agent'
                    : target === 'openclaw'
                      ? 'OpenClaw'
                      : target === 'atomcode'
                        ? 'AtomCode'
                        : '当前 agent';
  const pad = ' '.repeat(24 - appName.length);
  if (target === 'officeace') {
    console.log(`\n\x1b[1m\x1b[33m╔══════════════════════════════════════════════════════════╗`);
    console.log(`\x1b[1m\x1b[33m║  打开连接器 → 我的连接器 → huaweicloud-devkit      �`);
    console.log(`\x1b[1m\x1b[33m║  → 连接 → 回到对话 → 输入框开启连接器                  �`);
    console.log(`\x1b[1m\x1b[33m╚══════════════════════════════════════════════════════╝\x1b[0m`);
  } else if (target === 'workbuddy') {
    console.log(`\n\x1b[1m\x1b[33m╔══════════════════════════════════════════════════════════╗`);
    console.log(`\x1b[1m\x1b[33m║  MCP 工具即时生效，无需重启会话                    �`);
    console.log(`\x1b[1m\x1b[33m║  前往连接器 → 自定义连接器，确认 huaweicloud-devkit    �`);
    console.log(`\x1b[1m\x1b[33m║  已添加信任并启用                                   �`);
    console.log(`\x1b[1m\x1b[33m╚══════════════════════════════════════════════════════╝\x1b[0m`);
  } else if (target === 'codex-desktop') {
    console.log(`\n\x1b[1m\x1b[33m╔══════════════════════════════════════════════════════╗`);
    console.log(`\x1b[1m\x1b[33m║  插件已安装到 Codex Desktop，新会话中生效              ║`);
    console.log(`\x1b[1m\x1b[33m║  如未自动加载，请到插件 → 个人 → 安装                 ║`);
    console.log(`\x1b[1m\x1b[33m╚══════════════════════════════════════════════════════╝\x1b[0m`);
  } else {
    console.log(`\n\x1b[1m\x1b[33m╔══════════════════════════════════════════════════════╗`);
    console.log(`\x1b[1m\x1b[33m║  MCP 工具在重启 ${appName} 会话后才生效${pad}║`);
    console.log(`\x1b[1m\x1b[33m║  关闭当前会话 → 重新打开，直接描述华为云任务即可      ║`);
    console.log(`\x1b[1m\x1b[33m║  重启前请勿执行 hcloud 命令，避免 AK/SK 泄露         ║`);
    console.log(`\x1b[1m\x1b[33m╚══════════════════════════════════════════════════════╝\x1b[0m`);
  }

  const hcloudOk = checkHcloud();
  if (!hcloudOk) {
    console.log(`\n\x1b[33mKooCLI (hcloud) is not installed.`);
    console.log(`  Run: npx huaweicloud-devkit install-hcloud\x1b[0m`);
  } else {
    console.log(`\nKooCLI (hcloud) detected.`);
  }

  console.log(`\n\x1b[1m下一步：\x1b[0m`);
  console.log(`  1. 配置统一凭据：npx huaweicloud-devkit auth init`);
  console.log(`  2. 配置代理（企业内网）：npx huaweicloud-devkit proxy init`);
  if (target === 'officeace') {
    console.log(`  3. 打开连接器 → 我的连接器 → huaweicloud-devkit → 连接 → 回到对话 → 输入框开启连接器`);
  } else if (target === 'workbuddy') {
    console.log(`  3. 前往连接器 → 自定义连接器，确认 huaweicloud-devkit 已添加信任并启用`);
  } else if (target === 'codex-desktop') {
    console.log('  3. 新会话中生效（如未自动加载，请到插件 → 个人 → 安装）');
  } else {
    console.log(`  3. 重启 ${appName} 会话（MCP 工具重启后生效）`);
  }
  console.log(`  4. 运行自检：npx huaweicloud-devkit doctor`);

  // Write install marker for doctor to detect
  const markerDir =
    target === 'dsh'
      ? dshPluginsDir()
      : target === 'codearts'
        ? codeartsPluginsDir()
        : target === 'codearts-work'
          ? codeartsWorkPluginsDir()
          : target === 'workbuddy'
            ? workbuddyPluginsDir()
            : target === 'officeace'
              ? officeacePluginsDir()
              : target === 'openclaw'
                ? codexDesktopPluginsDir()
                : target === 'atomcode'
                  ? atomcodePluginsDir()
                  : target === 'codex-desktop'
                    ? codexDesktopPluginsDir()
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
  if (target === 'officeace' || target === 'all') {
    console.log('Or describe your Huawei Cloud task in OfficeAce');
  }
  if (target === 'openclaw' || target === 'all') {
    console.log('Or describe your Huawei Cloud task in OpenClaw');
  }
  if (target === 'atomcode' || target === 'all') {
    console.log('Or describe your Huawei Cloud task in AtomCode');
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
  if (target === 'officeace' || target === 'all') {
    console.log('\n[OfficeAce]');
    uninstallOfficeAce();
  }
  if (target === 'hermes' || target === 'all') {
    console.log('\n[Hermes Agent]');
    uninstallHermes();
  }
  if (target === 'openclaw' || target === 'all') {
    console.log('\n[OpenClaw]');
    uninstallOpenClaw();
  }
  if (target === 'atomcode' || target === 'all') {
    console.log('\n[AtomCode]');
    uninstallAtomCode();
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
  if (target === 'officeace' || target === 'all') {
    console.log('\n[OfficeAce]');
    officeaceStatus();
  }
  if (target === 'hermes' || target === 'all') {
    console.log('\n[Hermes Agent]');
    hermesStatus();
  }
  if (target === 'openclaw' || target === 'all') {
    console.log('\n[OpenClaw]');
    const cdPluginDir = openclawPluginsDir();
    const cdSkillsDir = openclawSkillsDir();
    console.log(
      `  MCP Server: ${existsSync(join(cdPluginDir, 'src', 'mcp-server.mjs')) ? '\x1b[32mInstalled\x1b[0m' : '\x1b[31mNot installed\x1b[0m'}`,
    );
    console.log(
      `  Safety Policy: ${existsSync(join(cdPluginDir, 'safety', 'policy.json')) ? '\x1b[32mInstalled\x1b[0m' : '\x1b[31mNot installed\x1b[0m'}`,
    );
    let cdSkillCount = 0;
    if (existsSync(cdSkillsDir)) {
      cdSkillCount = readdirSync(cdSkillsDir, { withFileTypes: true }).filter(
        (d) => d.isDirectory() && d.name.startsWith('huawei'),
      ).length;
    }
    console.log(
      `  Skills: ${cdSkillCount > 0 ? `\x1b[32m${cdSkillCount} installed\x1b[0m` : '\x1b[31mNot installed\x1b[0m'}`,
    );
  }
  if (target === 'atomcode' || target === 'all') {
    console.log('\n[AtomCode]');
    atomcodeStatus();
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

  let pass = 0,
    warn = 0,
    fail = 0;

  function check(label, ok, msg) {
    if (ok) {
      console.log(`  \x1b[32m[PASS]\x1b[0m ${label}`);
      pass++;
    } else {
      console.log(`  \x1b[31m[FAIL]\x1b[0m ${label} — ${msg}`);
      fail++;
    }
  }

  // Node.js
  check('Node.js >= 22', process.versions.node.split('.')[0] >= 22, 'Run: nvm install 22 && nvm use 22');

  // MCP server — check OpenCode, Codex Desktop, CodeArts, WorkBuddy, and DSH paths
  const opencodePluginDir = opencodePluginsDir();
  const codexPluginDir = codexDesktopPluginsDir();
  const codeartsPluginDir = codeartsPluginsDir();
  const codeartsWorkPluginDir = codeartsWorkPluginsDir();
  const workbuddyPluginDir = workbuddyPluginsDir();
  const dshPluginDir = dshPluginsDir();
  const officeacePluginDir = officeacePluginsDir();
  const hermesPluginDir = hermesPluginsDir();
  const atomcodePluginDir = atomcodePluginsDir();
  const mcpOk =
    existsSync(join(opencodePluginDir, 'src', 'mcp-server.mjs')) ||
    existsSync(join(codexPluginDir, 'src', 'mcp-server.mjs')) ||
    existsSync(join(codeartsPluginDir, 'src', 'mcp-server.mjs')) ||
    existsSync(join(codeartsWorkPluginDir, 'src', 'mcp-server.mjs')) ||
    existsSync(join(workbuddyPluginDir, 'src', 'mcp-server.mjs')) ||
    existsSync(join(dshPluginDir, 'src', 'mcp-server.mjs')) ||
    existsSync(join(officeacePluginDir, 'src', 'mcp-server.mjs')) ||
    existsSync(join(hermesPluginDir, 'src', 'mcp-server.mjs')) ||
    existsSync(join(atomcodePluginDir, 'src', 'mcp-server.mjs'));
  const mcpTarget = existsSync(join(opencodePluginDir, 'src', 'mcp-server.mjs'))
    ? 'OpenCode'
    : existsSync(join(codexPluginDir, 'src', 'mcp-server.mjs'))
      ? 'Codex Desktop'
      : existsSync(join(codeartsPluginDir, 'src', 'mcp-server.mjs'))
        ? 'CodeArts'
        : existsSync(join(codeartsWorkPluginDir, 'src', 'mcp-server.mjs'))
          ? 'CodeArts Work'
          : existsSync(join(workbuddyPluginDir, 'src', 'mcp-server.mjs'))
            ? 'WorkBuddy'
            : existsSync(join(dshPluginDir, 'src', 'mcp-server.mjs'))
              ? 'DSH'
              : existsSync(join(officeacePluginDir, 'src', 'mcp-server.mjs'))
                ? 'OfficeAce'
                : existsSync(join(hermesPluginDir, 'src', 'mcp-server.mjs'))
                  ? 'Hermes Agent'
                  : existsSync(join(atomcodePluginDir, 'src', 'mcp-server.mjs'))
                    ? 'AtomCode'
                    : '';
  check('MCP server installed', mcpOk, 'Run: npx huaweicloud-devkit install');

  if (mcpOk) {
    check(`MCP server can start (${mcpTarget})`, true, '');
  }

  const undiciPluginDirs = [
    opencodePluginDir,
    codexPluginDir,
    codeartsPluginDir,
    codeartsWorkPluginDir,
    workbuddyPluginDir,
    dshPluginDir,
    officeacePluginDir,
    hermesPluginDir,
  ];
  const undiciOk = undiciPluginDirs.some((d) => existsSync(join(d, 'node_modules', 'undici')));
  check('Runtime deps (undici) installed', undiciOk, 'Run: npx huaweicloud-devkit install');

  const safetyOk =
    existsSync(join(opencodePluginDir, 'safety', 'policy.json')) ||
    existsSync(join(codexPluginDir, 'safety', 'policy.json')) ||
    existsSync(join(codeartsPluginDir, 'safety', 'policy.json')) ||
    existsSync(join(codeartsWorkPluginDir, 'safety', 'policy.json')) ||
    existsSync(join(workbuddyPluginDir, 'safety', 'policy.json')) ||
    existsSync(join(dshPluginDir, 'safety', 'policy.json')) ||
    existsSync(join(officeacePluginDir, 'safety', 'policy.json')) ||
    existsSync(join(hermesPluginDir, 'safety', 'policy.json')) ||
    existsSync(join(atomcodePluginDir, 'safety', 'policy.json'));
  check('Safety policy installed', safetyOk, 'Run: npx huaweicloud-devkit install');

  // MCP config — check OpenCode, Codex Desktop, CodeArts, WorkBuddy, and DSH
  let mcpConfigured = false;
  let mcpCfgTarget = '';
  const opencodeCfg = opencodeConfigFile();
  if (existsSync(opencodeCfg)) {
    try {
      const cfg = JSON.parse(readFileSync(opencodeCfg, 'utf8'));
      if (cfg.mcp && cfg.mcp['huaweicloud-devkit']) {
        mcpConfigured = true;
        mcpCfgTarget = 'OpenCode';
      }
    } catch {}
  }
  const mpPath = codexMarketplacePath();
  if (!mcpConfigured && existsSync(mpPath)) {
    try {
      const mp = JSON.parse(readFileSync(mpPath, 'utf8'));
      if (mp.plugins && mp.plugins.some((p) => p.name === 'huaweicloud-devkit')) {
        mcpConfigured = true;
        mcpCfgTarget = 'Codex Desktop';
      }
    } catch {}
  }
  const codeartsCfg = codeartsMcpSettingsFile();
  if (!mcpConfigured && existsSync(codeartsCfg)) {
    try {
      const cfg = JSON.parse(readFileSync(codeartsCfg, 'utf8'));
      if (cfg.mcpServers && cfg.mcpServers['huaweicloud-devkit']) {
        mcpConfigured = true;
        mcpCfgTarget = 'CodeArts';
      }
    } catch {}
  }
  const codeartsWorkCfg = codeartsWorkMcpSettingsFile();
  if (!mcpConfigured && existsSync(codeartsWorkCfg)) {
    try {
      const cfg = JSON.parse(readFileSync(codeartsWorkCfg, 'utf8'));
      if (cfg.mcpServers && cfg.mcpServers['huaweicloud-devkit']) {
        mcpConfigured = true;
        mcpCfgTarget = 'CodeArts Work';
      }
    } catch {}
  }
  const workbuddyCfg = workbuddyMcpConfigFile();
  if (!mcpConfigured && existsSync(workbuddyCfg)) {
    try {
      const cfg = JSON.parse(readFileSync(workbuddyCfg, 'utf8'));
      if (cfg.mcpServers && cfg.mcpServers['huaweicloud-devkit']) {
        mcpConfigured = true;
        mcpCfgTarget = 'WorkBuddy';
      }
    } catch {}
  }
  if (!mcpConfigured && dshPatchConfigured()) {
    mcpConfigured = true;
    mcpCfgTarget = 'DSH';
  }
  if (!mcpConfigured) {
    const officeaceCfg = officeaceCapabilitiesFile();
    if (existsSync(officeaceCfg)) {
      try {
        const cfg = JSON.parse(readFileSync(officeaceCfg, 'utf8'));
        if (
          Array.isArray(cfg.capabilities) &&
          cfg.capabilities.some((c) => c.id === 'huaweicloud-devkit' && c.type === 'mcp')
        ) {
          mcpConfigured = true;
          mcpCfgTarget = 'OfficeAce';
        }
      } catch {}
    }
  }
  if (!mcpConfigured) {
    const hermesCfg = hermesConfigFile();
    if (existsSync(hermesCfg)) {
      try {
        const cfg = readFileSync(hermesCfg, 'utf8');
        if (cfg.includes('mcp_servers:') && cfg.includes('huaweicloud-devkit')) {
          mcpConfigured = true;
          mcpCfgTarget = 'Hermes Agent';
        }
      } catch {}
    }
  }
  if (!mcpConfigured) {
    const atomcodeCfg = atomcodeMcpConfigFile();
    if (existsSync(atomcodeCfg)) {
      try {
        const cfg = JSON.parse(readFileSync(atomcodeCfg, 'utf8'));
        if (cfg.mcpServers && cfg.mcpServers['huaweicloud-devkit']) {
          mcpConfigured = true;
          mcpCfgTarget = 'AtomCode';
        }
      } catch {}
    }
  }
  check(
    'MCP configured',
    mcpConfigured,
    mcpCfgTarget ? `Found in ${mcpCfgTarget} config` : 'Run: npx huaweicloud-devkit install',
  );

  // Hermes MCP Python SDK (only checked when Hermes config is found)
  if (
    mcpCfgTarget === 'Hermes Agent' ||
    (existsSync(hermesConfigFile()) && readFileSync(hermesConfigFile(), 'utf8').includes('mcp_servers'))
  ) {
    check('Hermes MCP Python SDK', hermesMcpSdkOk(), 'Run: pip3 install mcp');
  }

  // hcloud CLI
  const hcloudBin = findHcloudBin() || process.env.HCLOUD_BIN || 'hcloud';
  const hcloudCheck = spawnSync(`"${hcloudBin}" version`, [], {
    shell: true,
    windowsHide: true,
    stdio: 'pipe',
    timeout: 5000,
  });
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
    const authCheck = spawnSync(`"${hcloudBin}" configure list`, [], {
      shell: true,
      windowsHide: true,
      stdio: 'pipe',
      timeout: 5000,
    });
    const hasAuth = authCheck.status === 0 && /access.?key/i.test(authCheck.stdout.toString());
    check('hcloud credentials configured', hasAuth, 'Run: npx huaweicloud-devkit auth init');
  }

  // Skills
  const skillsOptions = [
    opencodeSkillsDir(),
    codexDesktopSkillsDir(),
    codeartsSkillsDir(),
    codeartsWorkSkillsDir(),
    workbuddySkillsDir(),
    dshSkillsDir(),
    officeaceSkillsDir(),
    hermesSkillsDir(),
    atomcodeSkillsDir(),
  ];
  let skillCount = 0;
  const missingSkills = [];
  for (const dir of skillsOptions) {
    if (!existsSync(dir)) continue;
    const entries = readdirSync(dir, { withFileTypes: true }).filter(
      (d) => d.isDirectory() && d.name.startsWith('huawei'),
    );
    const count = entries.length;
    if (count > skillCount) {
      skillCount = count;
    }
    for (const d of entries) {
      if (!existsSync(join(dir, d.name, 'SKILL.md'))) missingSkills.push(d.name);
    }
  }
  const skillsOk = skillCount >= 6;
  check(`Skills installed (${skillCount})`, skillsOk, 'Run: npx huaweicloud-devkit install');
  if (missingSkills.length > 0) {
    console.log(
      `  \x1b[33m[WARN]\x1b[0m ${missingSkills.length} skill(s) missing SKILL.md: ${missingSkills.join(', ')} — Run: npx huaweicloud-devkit install`,
    );
    warn++;
  }

  const proxyConfig = readProxyConfig();
  const proxyEnv =
    process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
  if (proxyConfig || proxyEnv) {
    const source = proxyEnv ? 'env' : 'file';
    const proxyUrl = proxyEnv || proxyConfig.https_proxy || proxyConfig.http_proxy;
    console.log(`  \x1b[36m[INFO]\x1b[0m Proxy configured (${source}): ${proxyUrl}`);
  }

  console.log(`\nResults: ${pass} pass, ${warn} warn, ${fail} fail`);

  if (mcpConfigured && !hcloudOk) {
    console.log(
      '\n\x1b[33mMCP is configured but hcloud is not installed. Install hcloud then restart your session.\x1b[0m',
    );
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
    { path: join(officeacePluginsDir(), '.installed'), name: 'OfficeAce' },
    { path: join(atomcodePluginsDir(), '.installed'), name: 'AtomCode' },
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

  if (target === 'officeace') {
    if (!existsSync(join(officeacePluginsDir(), 'src', 'mcp-server.mjs'))) {
      console.log('\x1b[33mNot installed. Use "install" command first.\x1b[0m');
      return;
    }
    console.log('[OfficeAce]');
    await updateOfficeAce();
    console.log(`\n\x1b[32mUpdate complete.\x1b[0m`);
    console.log(`\x1b[33m打开连接器 → 我的连接器 → huaweicloud-devkit → 连接 → 回到对话 → 输入框开启连接器\x1b[0m`);
    return;
  }

  if (target === 'hermes') {
    if (!existsSync(join(hermesPluginsDir(), 'src', 'mcp-server.mjs'))) {
      console.log('\x1b[33mNot installed. Use "install" command first.\x1b[0m');
      return;
    }
    console.log('[Hermes Agent]');
    await updateHermes();
    console.log(`\n\x1b[32mUpdate complete.\x1b[0m`);
    console.log(`\x1b[33mRestart Hermes Agent for changes to take effect.\x1b[0m`);
    return;
  }

  if (target === 'openclaw') {
    if (!existsSync(join(codexDesktopPluginsDir(), 'src', 'mcp-server.mjs'))) {
      console.log('\x1b[33mNot installed. Use "install" command first.\x1b[0m');
      return;
    }
    console.log('[OpenClaw]');
    await updateOpenClaw();
    console.log(`\n\x1b[32mUpdate complete.\x1b[0m`);
    console.log(`\x1b[33mRestart OpenClaw for changes to take effect.\x1b[0m`);
    return;
  }

  if (target === 'atomcode') {
    if (!existsSync(join(atomcodePluginsDir(), 'src', 'mcp-server.mjs'))) {
      console.log('\x1b[33mNot installed. Use "install" command first.\x1b[0m');
      return;
    }
    console.log('[AtomCode]');
    await updateAtomCode();
    console.log(`\n\x1b[32mUpdate complete.\x1b[0m`);
    console.log(`\x1b[33mRestart the AtomCode session for changes to take effect.\x1b[0m`);
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
    if (existsSync(join(officeacePluginsDir(), 'src', 'mcp-server.mjs'))) {
      console.log('\n[OfficeAce]');
      await updateOfficeAce();
      updatedAny = true;
    }
    if (existsSync(join(hermesPluginsDir(), 'src', 'mcp-server.mjs'))) {
      console.log('\n[Hermes Agent]');
      await updateHermes();
      updatedAny = true;
    }
    if (existsSync(join(openclawPluginsDir(), 'src', 'mcp-server.mjs'))) {
      console.log('\n[OpenClaw]');
      await updateOpenClaw();
      updatedAny = true;
    }
    if (existsSync(join(atomcodePluginsDir(), 'src', 'mcp-server.mjs'))) {
      console.log('\n[AtomCode]');
      await updateAtomCode();
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
  const installDir = os === 'win32' ? join(homedir(), 'hcloud') : join(homedir(), '.local', 'bin');

  if (os === 'win32') {
    const url = `${baseUrl}/huaweicloud-cli-windows-amd64.zip`;
    const zipPath = join(installDir, 'hcloud.zip');

    console.log(`[Windows] Auto-installing to ${installDir}...`);

    try {
      mkdirSync(installDir, { recursive: true });

      // Download
      console.log(`  Downloading ${url}...`);
      const psCmd = `[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri '${url}' -OutFile '${zipPath}' -UseBasicParsing`;
      const dl = spawnSync('powershell', ['-NoProfile', '-Command', psCmd], {
        stdio: 'inherit',
        windowsHide: true,
        timeout: 180000,
      });
      if (dl.status !== 0) throw new Error(`下载失败 (PowerShell exit ${dl.status})`);

      // Extract
      console.log('  Extracting...');
      const ex = spawnSync(
        'powershell',
        ['-NoProfile', '-Command', `Expand-Archive -Path '${zipPath}' -DestinationPath '${installDir}' -Force`],
        { stdio: 'inherit', windowsHide: true, timeout: 60000 },
      );
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
      spawnSync('powershell', ['-NoProfile', '-Command', pathPs], {
        stdio: 'inherit',
        windowsHide: true,
        timeout: 30000,
      });

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
        const r = spawnSync(hcloudBin, ['version'], {
          input: 'y\n',
          encoding: 'utf8',
          timeout: 10000,
          windowsHide: true,
        });
        if (r.status === 0) {
          console.log('  \x1b[32mPrivacy agreement accepted. KooCLI ready.\x1b[0m');
        } else {
          console.log('  \x1b[33m无法写入配置目录。请在码道外终端运行: echo "y" | hcloud version\x1b[0m');
        }
      } else {
        console.log('  \x1b[33m请手动接受隐私协议：在终端运行 hcloud version 并按提示操作\x1b[0m');
      }

      console.log('  Or restart terminal and: hcloud version');
    } catch (error) {
      console.log(`\n\x1b[33mAuto-install failed: ${error.message}\x1b[0m`);
      console.log(`  Manual: download ${url}, unzip to ${installDir}, add to PATH`);
      console.log(`  Guide: https://support.huaweicloud.com/qs-hcli/hcli_02_003_01.html`);
      if (detectCodeartsSandbox() === 'sandbox') {
        printSandboxWarning('沙箱模式拦截了 KooCLI 自动安装（无法创建/写入安装目录）。');
      }
    }
  } else if (os === 'linux') {
    console.log('[Linux] One-liner install:');
    console.log(
      '  curl -sSL https://cn-north-4-hdn-koocli.obs.cn-north-4.myhuaweicloud.com/cli/latest/hcloud_install.sh -o ./hcloud_install.sh && bash ./hcloud_install.sh -y',
    );
    console.log(`\nOr manual: ${arch === 'arm64' ? 'ARM64' : 'AMD64'}`);
    const pkg = arch === 'arm64' ? 'linux-arm64' : 'linux-amd64';
    console.log(`  curl -LO "${baseUrl}/huaweicloud-cli-${pkg}.tar.gz"`);
    console.log(`  tar -zxvf huaweicloud-cli-${pkg}.tar.gz`);
    console.log(`  mv hcloud ~/.local/bin/`);
    console.log(`  hcloud version`);
    console.log(`\nFull guide: https://support.huaweicloud.com/qs-hcli/hcli_02_003_02.html`);
  } else if (os === 'darwin') {
    console.log('[macOS] One-liner install:');
    console.log(
      '  curl -sSL https://cn-north-4-hdn-koocli.obs.cn-north-4.myhuaweicloud.com/cli/latest/hcloud_install.sh -o ./hcloud_install.sh && bash ./hcloud_install.sh -y',
    );
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
      `Cannot read "${prompt.trim()}" securely in a non-interactive session. Set HW_ACCESS_KEY/HW_SECRET_KEY environment variables instead, or run "npx huaweicloud-devkit auth init" in a real terminal.`,
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
  const hcloudBin = findHcloudBin() || process.env.HCLOUD_BIN || 'hcloud';
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
    error: String(r.stderr || '')
      .trim()
      .slice(0, 240),
  };
}

function printAuthAgents(agents = {}) {
  for (const [agent, info] of Object.entries(agents)) {
    console.log(`  ${agent}: ${info.configured ? '[OK]' : '[MISSING]'}`);
  }
}

function printAuthStatus(status) {
  console.log(
    `Credentials vault: ${status.credentialsConfigured ? 'configured' : 'missing'} (${status.credentialsPath})`,
  );
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
    console.error(
      '\x1b[31mNon-interactive session detected. Provide credentials via environment variables instead:\x1b[0m',
    );
    console.error('  HW_ACCESS_KEY, HW_SECRET_KEY');
    console.error('  (Or run "npx huaweicloud-devkit auth init" in a real terminal.)');
    process.exitCode = 1;
    return;
  }

  if (!ak) ak = await readLineQuestion('Access Key ID (AK): ');
  if (!sk) sk = await readSecret('Secret Access Key (SK): ');
  if (interactive && !securityToken)
    securityToken = await readLineQuestion('Security Token (optional, press Enter to skip): ');
  if (!region) region = 'cn-north-4';

  if (!ak || !sk) {
    console.error('\nAK and SK are required.');
    process.exitCode = 1;
    return;
  }

  writeGlobalCredentials({ ak, sk, securityToken, region });

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
  const noProxy = await readLineQuestion(
    `NO_PROXY hosts [${existing.no_proxy || '127.0.0.1,localhost,.huawei.com'}]: `,
  );

  const config = {
    https_proxy: httpsProxy || existing.https_proxy || '',
    http_proxy: httpProxy || existing.http_proxy || '',
    no_proxy: noProxy || existing.no_proxy || '127.0.0.1,localhost,.huawei.com',
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
      console.log(
        'Usage: npx huaweicloud-devkit <command> [--target <opencode|codex|codearts|codearts-work|workbuddy|dsh|officeace|hermes|openclaw|atomcode|all>]\n',
      );
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
      console.log(
        '  --target     Target agent: opencode (default), codex, codearts, codearts-work, workbuddy, dsh, officeace, hermes, openclaw, atomcode, all',
      );
      console.log('\nExamples:');
      console.log('  npx huaweicloud-devkit install');
      console.log('  npx huaweicloud-devkit install --target codex');
      console.log('  npx huaweicloud-devkit install --target codearts');
      console.log('  npx huaweicloud-devkit install --target codearts-work');
      console.log('  npx huaweicloud-devkit install --target workbuddy');
      console.log('  npx huaweicloud-devkit install --target dsh');
      console.log('  npx huaweicloud-devkit install --target officeace');
      console.log('  npx huaweicloud-devkit install --target hermes');
      console.log('  npx huaweicloud-devkit install --target atomcode');
      console.log('  npx huaweicloud-devkit install --target all');
      console.log('  npx huaweicloud-devkit auth init');
      console.log('  npx huaweicloud-devkit auth sync --target all');
      console.log('  npx huaweicloud-devkit auth status --target all');
      console.log('  npx huaweicloud-devkit proxy init');
      console.log('  npx huaweicloud-devkit proxy show');
      break;
  }
}

main().catch((error) => {
  console.error(`\x1b[31mError: ${error.message}\x1b[0m`);
  process.exit(1);
});
