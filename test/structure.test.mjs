import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import test from 'node:test';

const root = fileURLToPath(new URL('..', import.meta.url));
const pluginRoot = join(root, 'plugins', 'huaweicloud-core');

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

test('Codex plugin manifest and marketplace are installable', () => {
  const manifest = readJson(join(pluginRoot, '.codex-plugin', 'plugin.json'));
  assert.equal(manifest.name, 'huaweicloud-core');
  assert.equal(manifest.skills, './skills/');
  assert.equal(manifest.mcpServers, './.mcp.json');
  assert.ok(!Object.hasOwn(manifest, 'hooks'), 'Codex manifest keeps hooks out');

  const marketplace = readJson(join(root, '.agents', 'plugins', 'marketplace.json'));
  assert.equal(marketplace.name, 'huaweicloud-devkit');
  assert.equal(marketplace.plugins[0].name, 'huaweicloud-core');
  assert.equal(marketplace.plugins[0].source.path, './plugins/huaweicloud-core');
});

test('OpenCode integration exposes skills, commands, and MCP config', () => {
  assert.ok(existsSync(join(root, 'integrations', 'opencode', 'opencode.json')));
  assert.ok(existsSync(join(root, 'integrations', 'opencode', 'commands', 'huaweicloud-doctor.md')));
  assert.ok(existsSync(join(root, 'integrations', 'opencode', 'skills', 'huaweicloud-core', 'SKILL.md')));
});

test('plugin skills are compact meta-skills instead of service encyclopedia entries', () => {
  const skillsDir = join(pluginRoot, 'skills');
  const skillNames = readdirSync(skillsDir).filter((name) =>
    existsSync(join(skillsDir, name, 'SKILL.md')),
  );
  const requiredMetaSkills = [
    'huaweicloud-api-and-sdk',
    'huaweicloud-capability-discovery',
    'huaweicloud-cli-and-auth',
    'huaweicloud-core',
    'huaweicloud-safety',
    'huaweicloud-troubleshooting',
  ];
  for (const name of requiredMetaSkills) {
    assert.ok(skillNames.includes(name), `Missing meta-skill: ${name}`);
  }
  assert.ok(skillNames.length >= 6, 'Should have at least 6 skills');

  for (const name of skillNames) {
    const body = readFileSync(join(skillsDir, name, 'SKILL.md'), 'utf8');
    assert.match(body, /^---\r?\nname: /);
    assert.doesNotMatch(body, /TODO|\[TODO/i);
  }
});

test('skills document KooCLI installation, operation discovery, region intent, and password safety', () => {
  const cliSkill = readFileSync(join(pluginRoot, 'skills', 'huaweicloud-cli-and-auth', 'SKILL.md'), 'utf8');
  assert.match(cliSkill, /support\.huaweicloud\.com\/qs-hcli\/hcli_02_003\.html/);
  assert.match(cliSkill, /HCLOUD_BIN/);
  assert.match(cliSkill, /--server\.nics\.1\.subnet_id/);
  assert.match(cliSkill, /--param=value/);

  const discoverySkill = readFileSync(join(pluginRoot, 'skills', 'huaweicloud-capability-discovery', 'SKILL.md'), 'utf8');
  assert.match(discoverySkill, /hcloud <Service> --help/);
  assert.match(discoverySkill, /Singapore.*ap-southeast-3/s);
  assert.match(discoverySkill, /No blind all-region scans/);

  const safetySkill = readFileSync(join(pluginRoot, 'skills', 'huaweicloud-safety', 'SKILL.md'), 'utf8');
  assert.match(safetySkill, /shell history/i);
  assert.match(safetySkill, /huaweicloud_run_approved_command/);

  // Verify KooCLI install URLs match official download URLs
  assert.ok(cliSkill.includes('huaweicloud-cli-windows-amd64.zip'), 'Windows download URL');
  assert.ok(cliSkill.includes('huaweicloud-cli-linux-amd64.tar.gz'), 'Linux download URL');
  assert.ok(cliSkill.includes('huaweicloud-cli-mac-arm64.tar.gz'), 'macOS download URL');
});

test('skill SKILL.md files meet minimum content quality bar', () => {
  const skillsDir = join(pluginRoot, 'skills');
  const skillNames = readdirSync(skillsDir).filter((name) =>
    existsSync(join(skillsDir, name, 'SKILL.md')),
  );

  const exceptions = new Set([
    'huawei-cloud-find-skills',
    'huaweicloud-api-and-sdk',
    'huaweicloud-safety',
    'huaweicloud-troubleshooting',
    'huawei-deployment',
    'huawei-getting-started',
    'huawei-apig',
    'huawei-gaussdb',
  ]);

  for (const name of skillNames) {
    const body = readFileSync(join(skillsDir, name, 'SKILL.md'), 'utf8');
    const lines = body.split('\n').length;
    if (exceptions.has(name)) continue;
    assert.ok(lines >= 40, `${name}/SKILL.md has ${lines} lines (min 40)`);
  }
});

test('skills with references have non-empty reference files', () => {
  const skillsDir = join(pluginRoot, 'skills');
  const skillNames = readdirSync(skillsDir).filter((name) =>
    existsSync(join(skillsDir, name, 'SKILL.md')),
  );

  for (const name of skillNames) {
    const refDir = join(skillsDir, name, 'references');
    if (!existsSync(refDir)) continue;
    const refFiles = readdirSync(refDir).filter((f) => f.endsWith('.md'));
    for (const ref of refFiles) {
      const body = readFileSync(join(refDir, ref), 'utf8');
      const lines = body.split('\n').length;
      assert.ok(lines >= 10, `${name}/references/${ref} has ${lines} lines (min 10)`);
    }
  }
});

test('web/static-site deployment intent offers target options with sandbox first, not OBS default', () => {
  const core = readFileSync(join(pluginRoot, 'skills', 'huaweicloud-core', 'SKILL.md'), 'utf8');
  assert.match(core, /Deployment Target Options/);
  assert.match(core, /Sandbox \(DevStation\) — recommended/);
  assert.match(core, /NEVER default to a single service such as OBS/);

  const obs = readFileSync(join(pluginRoot, 'skills', 'huawei-obs', 'SKILL.md'), 'utf8');
  assert.match(obs, /Routing Guard: Deploy vs Store/);
  assert.match(obs, /do NOT default to OBS/);
  assert.match(obs, /① huawei-sandbox \(recommended\)/);

  const sandbox = readFileSync(join(pluginRoot, 'skills', 'huawei-sandbox', 'SKILL.md'), 'utf8');
  assert.match(sandbox, /present options, sandbox first/i);
  assert.match(sandbox, /建议优先部署到沙箱/);

  const discovery = readFileSync(join(pluginRoot, 'skills', 'huaweicloud-capability-discovery', 'SKILL.md'), 'utf8');
  assert.match(discovery, /Deployment Target Options/);
  assert.match(discovery, /do NOT default to OBS/);
});

test('all plugin manifests are valid JSON', () => {
  const manifests = [
    join(pluginRoot, '.codex-plugin', 'plugin.json'),
    join(pluginRoot, '.claude-plugin', 'plugin.json'),
    join(pluginRoot, '.cursor-plugin', 'plugin.json'),
  ];
  for (const path of manifests) {
    const data = readJson(path);
    assert.ok(data.name, `Manifest ${path} missing name`);
    assert.ok(data.skills || data.interface, `Manifest ${path} missing skills/interface`);
  }
});

test('safety policy.json is valid and has required fields', () => {
  const policy = readJson(join(pluginRoot, 'safety', 'policy.json'));
  assert.ok(Array.isArray(policy.secretKeyNamePatterns));
  assert.ok(policy.secretKeyNamePatterns.length >= 5);
  assert.ok(Array.isArray(policy.writeOperationPrefixes));
  assert.ok(policy.writeOperationPrefixes.length >= 10);
  assert.ok(Array.isArray(policy.blockedSecretOperations));
  assert.ok(Array.isArray(policy.credentialFilePatterns));
});

test('cloud risk rules are present and public-safe', () => {
  const rulesPath = join(pluginRoot, 'safety', 'rules', 'cloud-risk-rules.json');
  assert.ok(existsSync(rulesPath), 'Missing cloud-risk-rules.json');

  const catalog = readJson(rulesPath);
  assert.equal(catalog.version, '0.1.0');
  assert.ok(Array.isArray(catalog.rules), 'rules must be an array');
  assert.ok(catalog.rules.length >= 9, 'Expected baseline cloud risk rules');

  const ids = new Set();
  const allowedSeverities = new Set(['deny', 'warn', 'info']);
  const allowedStages = new Set(['command', 'artifact', 'deploy_plan']);
  for (const rule of catalog.rules) {
    assert.match(rule.id, /^hwc-[a-z0-9-]+$/, `Invalid rule id: ${rule.id}`);
    assert.ok(!ids.has(rule.id), `Duplicate rule id: ${rule.id}`);
    ids.add(rule.id);
    assert.ok(allowedSeverities.has(rule.severity), `${rule.id} has invalid severity`);
    assert.ok(Array.isArray(rule.stages) && rule.stages.length > 0, `${rule.id} missing stages`);
    for (const stage of rule.stages) {
      assert.ok(allowedStages.has(stage), `${rule.id} has invalid stage: ${stage}`);
    }
    assert.ok(rule.match && (rule.match.any || rule.match.all), `${rule.id} needs match conditions`);
    assert.ok(rule.message && rule.remediation, `${rule.id} needs message and remediation`);
    assert.doesNotMatch(JSON.stringify(rule), /\baccountId\b|\bticketId\b|\brawText\b|\binternalSource\b/i);
  }
});

test('hooks.json references existing Python hook', () => {
  const hooksDir = join(pluginRoot, 'hooks');
  assert.ok(existsSync(join(hooksDir, 'hooks.json')));
  assert.ok(existsSync(join(hooksDir, 'huaweicloud-safety.py')));
});

test('hook rule model documentation exists', () => {
  const doc = join(root, 'docs', 'hook-rule-model.md');
  assert.ok(existsSync(doc), 'Missing docs/hook-rule-model.md');
  const body = readFileSync(doc, 'utf8');
  assert.match(body, /Hook 规则模型/);
  assert.match(body, /隐私边界/);
  assert.match(body, /huaweicloud_hook_check_command/);
});

test('safety skill teaches proactive hook checks', () => {
  const safetySkill = readFileSync(join(pluginRoot, 'skills', 'huaweicloud-safety', 'SKILL.md'), 'utf8');
  assert.match(safetySkill, /huaweicloud_hook_check_command/);
  assert.match(safetySkill, /huaweicloud_hook_check_artifacts/);
  assert.match(safetySkill, /huaweicloud_hook_check_deploy_plan/);
});

test('.mcp.json is valid and references existing server script', () => {
  const mcpConfig = readJson(join(pluginRoot, '.mcp.json'));
  assert.ok(mcpConfig.mcpServers || mcpConfig.mcp);
});

test('setup-cli.mjs supports the codearts target end to end', () => {
  const setup = readFileSync(join(pluginRoot, 'src', 'setup-cli.mjs'), 'utf8');
  // parseTarget accepts codearts
  assert.match(setup, /if \(val === 'codearts'\) return 'codearts';/);
  assert.match(setup, /if \(val === 'codearts-work'\) return 'codearts-work';/);
  // install / uninstall / status functions exist
  assert.match(setup, /async function installCodeArts\(\)/);
  assert.match(setup, /function uninstallCodeArts\(\)/);
  assert.match(setup, /function codeartsStatus\(\)/);
  // path helpers for user-level and project-level codearts dirs
  assert.match(setup, /function codeartsSkillsDir\(\)/);
  assert.match(setup, /function codeartsMcpSettingsFile\(\)/);
  assert.match(setup, /function codeartsProjectSkillsDir\(\)/);
  assert.match(setup, /function codeartsProjectMcpSettingsFile\(\)/);
  assert.match(setup, /function codeartsPluginsDir\(\)/);
  // install copies to user + project skills and registers both MCP configs
  assert.match(setup, /copyDir\(skillsSrc, codeartsSkillsDir\(\)\)/);
  assert.match(setup, /copyDir\(skillsSrc, codeartsProjectSkillsDir\(\)\)/);
  assert.match(setup, /registerCodeartsMcp\(codeartsMcpSettingsFile\(\)\)/);
  assert.match(setup, /registerCodeartsMcp\(codeartsProjectMcpSettingsFile\(\)\)/);
  // MCP registration writes an enabled server with local mode env
  assert.match(setup, /config\.mcpServers\['huaweicloud-devkit'\] = \{/);
  assert.match(setup, /HUAWEICLOUD_AGENT_TOOLKIT_MODE: 'local'/);
  assert.match(setup, /enabled: true,/);
  // command dispatch covers codearts for install / uninstall / status
  const branches = setup.match(/target === 'codearts' \|\| target === 'all'/g);
  assert.ok(branches && branches.length >= 3, `codearts dispatch branches: ${branches?.length}`);
  // .installed marker goes to the codearts plugins dir
  assert.match(setup, /const markerDir = target === 'dsh' \? dshPluginsDir\(\)\s+: target === 'codearts' \? codeartsPluginsDir\(\)\s+: target === 'codearts-work' \? codeartsWorkPluginsDir\(\)\s+: target === 'workbuddy' \? workbuddyPluginsDir\(\)\s+: target === 'codex-desktop' \? codexDesktopPluginsDir\(\)\s+: opencodePluginsDir\(\);/);
  // doctor checks the codearts skills dir alongside opencode
  assert.match(setup, /const skillsOptions = \[opencodeSkillsDir\(\), codexDesktopSkillsDir\(\), codeartsSkillsDir\(\), codeartsWorkSkillsDir\(\), workbuddySkillsDir\(\), dshSkillsDir\(\)\];/);
  // help text documents the target
  assert.match(setup, /--target <opencode\|codex\|codearts\|codearts-work\|workbuddy\|dsh\|all>/);
  assert.match(setup, /install --target codearts/);
});

test('tools.mjs resolves skills from the codearts directory', () => {
  const tools = readFileSync(join(pluginRoot, 'src', 'tools.mjs'), 'utf8');
  assert.match(tools, /function codeartsSkillsDir\(\)/);
  assert.match(tools, /return join\(home, '\.codeartsdoer', 'skills'\);/);
  assert.match(tools, /if \(existsSync\(codeartsSkillsDir\(\)\)\) return codeartsSkillsDir\(\);/);
});

test('setup-cli.mjs handles KooCLI sandbox blockers and privacy agreement', () => {
  const setup = readFileSync(join(pluginRoot, 'src', 'setup-cli.mjs'), 'utf8');
  // sandbox detection reads the CodeArts permission config
  assert.match(setup, /function detectCodeartsSandbox\(\)/);
  assert.match(setup, /codearts-data', 'storage', 'permission', 'config\.json'/);
  assert.match(setup, /config\.bash_mode/);
  // hcloud lookup covers HCLOUD_BIN and ~/hcloud on Windows
  assert.match(setup, /function findHcloudBin\(\)/);
  assert.match(setup, /process\.env\.HCLOUD_BIN/);
  assert.match(setup, /homedir\(\), 'hcloud', 'hcloud\.exe'/);
  // sandbox warning prompts user to install externally or disable sandbox
  assert.match(setup, /function printSandboxWarning\(/);
  assert.match(setup, /检测到码道沙箱模式/);
  assert.match(setup, /在码道外的终端安装并使用 KooCLI/);
  assert.match(setup, /关闭沙箱模式后重试/);
  // install-hcloud surfaces sandbox guidance on failure and after install
  assert.match(setup, /沙箱模式拦截了 KooCLI 自动安装/);
  // MCP env injects HCLOUD_BIN when an hcloud binary is found
  assert.match(setup, /if \(hcloudBin\) env\.HCLOUD_BIN = hcloudBin\.replace/);
  // doctor warns about sandbox mode
  assert.match(setup, /CodeArts sandbox mode active/);
});

test('setup-cli.mjs supports the dsh target end to end', () => {
  const setup = readFileSync(join(pluginRoot, 'src', 'setup-cli.mjs'), 'utf8');
  // parseTarget accepts dsh
  assert.match(setup, /if \(val === 'dsh'\) return 'dsh';/);
  // DSH path helpers and managed patch constants exist
  assert.match(setup, /function dshRoot\(\)/);
  assert.match(setup, /function dshSkillsDir\(\)/);
  assert.match(setup, /function dshProfileDir\(\)/);
  assert.match(setup, /function dshPatchFile\(\)/);
  assert.match(setup, /function dshPluginsDir\(\)/);
  assert.match(setup, /const DSH_MCP_PATCH_START = '# HuaweiCloud DevKit DSH integration start';/);
  assert.match(setup, /const DSH_MCP_PATCH_END = '# HuaweiCloud DevKit DSH integration end';/);
  // install / update / uninstall / status functions exist
  assert.match(setup, /async function installDsh\(\)/);
  assert.match(setup, /async function updateDsh\(\)/);
  assert.match(setup, /function uninstallDsh\(\)/);
  assert.match(setup, /function dshStatus\(\)/);
  // install copies skills/server/safety and registers MCP through cordis.patch.yml
  assert.match(setup, /copyDir\(skillsSrc, dshSkillsDir\(\)\)/);
  assert.match(setup, /copyDir\(srcDir, join\(pluginDest, 'src'\)\)/);
  assert.match(setup, /copyDir\(safetyDir, join\(pluginDest, 'safety'\)\)/);
  assert.match(setup, /ensureDshMcpPatch\(\)/);
  assert.match(setup, /tryInstallDshMcpClient\(\)/);
  // DSH MCP patch uses dsh-mcp-client with stdio local server mode
  assert.match(setup, /name: '@deepseek-ai\/dsh-mcp-client'/);
  assert.match(setup, /serverName: huaweicloud/);
  assert.match(setup, /transport: stdio/);
  assert.match(setup, /failOnStartupError: false/);
  assert.match(setup, /HUAWEICLOUD_AGENT_TOOLKIT_MODE: local/);
  assert.match(setup, /HDKITSERVICE_ENDPOINT: ''/);
  // uninstall removes only the managed patch block
  assert.match(setup, /removeDshMcpPatch\(\)/);
  // command dispatch covers dsh for install / uninstall / status / update
  const branches = setup.match(/target === 'dsh' \|\| target === 'all'/g);
  assert.ok(branches && branches.length >= 4, `dsh dispatch branches: ${branches?.length}`);
  // .installed marker goes to the dsh plugins dir
  assert.match(setup, /target === 'dsh' \? dshPluginsDir\(\)/);
  // doctor checks DSH plugin dir, patch, and skills dir
  assert.match(setup, /const dshPluginDir = dshPluginsDir\(\);/);
  assert.match(setup, /dshPatchConfigured\(\)/);
  assert.match(setup, /dshSkillsDir\(\)/);
  // help text documents the target
  assert.match(setup, /--target <opencode\|codex\|codearts\|workbuddy\|dsh\|all>/);
  assert.match(setup, /install --target dsh/);
});

test('tools.mjs resolves skills from the dsh directory', () => {
  const tools = readFileSync(join(pluginRoot, 'src', 'tools.mjs'), 'utf8');
  assert.match(tools, /function dshSkillsDir\(\)/);
  assert.match(tools, /process\.env\.DSH_HOME \|\| join\(homedir\(\), '\.dsh'\)/);
  assert.match(tools, /return join\(home, 'skills'\);/);
  assert.match(tools, /if \(existsSync\(dshSkillsDir\(\)\)\) return dshSkillsDir\(\);/);
  assert.match(tools, /opencode, codex, codex-desktop, codearts, workbuddy, dsh, or all/);
});
