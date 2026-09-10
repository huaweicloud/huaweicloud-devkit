import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const pluginRoot = join(root, 'plugins', 'huaweicloud-core');

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function assertExists(path) {
  assert.ok(existsSync(path), `Missing required file: ${path}`);
}

assertExists(join(root, '.agents', 'plugins', 'marketplace.json'));
assertExists(join(pluginRoot, '.codex-plugin', 'plugin.json'));
assertExists(join(pluginRoot, '.mcp.json'));
assertExists(join(pluginRoot, 'hooks', 'hooks.json'));
assertExists(join(pluginRoot, 'hooks', 'huaweicloud-safety.py'));
assertExists(join(pluginRoot, 'safety', 'policy.json'));
assertExists(join(pluginRoot, 'safety', 'rules', 'cloud-risk-rules.json'));
assertExists(join(root, 'integrations', 'opencode', 'opencode.json'));

const manifest = readJson(join(pluginRoot, '.codex-plugin', 'plugin.json'));
assert.equal(manifest.name, 'huaweicloud-devkit');
assert.equal(manifest.skills, './skills/');
assert.equal(manifest.mcpServers, './.mcp.json');
assert.ok(!Object.hasOwn(manifest, 'hooks'), 'Codex manifest should not include hooks until supported by validator');

const workbuddyManifest = readJson(join(pluginRoot, '.workbuddy-plugin', 'plugin.json'));
assert.ok(
  !Object.hasOwn(workbuddyManifest, 'hooks'),
  'WorkBuddy manifest should not include hooks — hooks are Claude-specific and trigger manual trust prompts in WorkBuddy',
);

const pkg = readJson(join(root, 'package.json'));
const pluginManifests = [
  join(root, 'plugin.json'),
  join(pluginRoot, '.codex-plugin', 'plugin.json'),
  join(pluginRoot, '.claude-plugin', 'plugin.json'),
  join(pluginRoot, '.cursor-plugin', 'plugin.json'),
  join(pluginRoot, '.workbuddy-plugin', 'plugin.json'),
  join(pluginRoot, '.hermes-plugin', 'plugin.json'),
  join(pluginRoot, 'openclaw.plugin.json'),
];
for (const path of pluginManifests) {
  const manifest = readJson(path);
  assert.equal(pkg.version, manifest.version, `package.json version must match ${path}`);
}

const dshPatch = pkg.dsh?.bundle?.patch;
if (dshPatch) {
  const patchPath = join(root, dshPatch);
  assert.ok(existsSync(patchPath), `dsh.bundle.patch points to a missing file: ${dshPatch}`);
  const files = Array.isArray(pkg.files) ? pkg.files : [];
  const covered = files.some(
    (entry) =>
      entry === dshPatch.replace(/^\.\//, '') || dshPatch.startsWith(`./${entry}/`) || dshPatch === `./${entry}`,
  );
  assert.ok(
    covered,
    `dsh.bundle.patch (${dshPatch}) is not covered by the package.json "files" whitelist and will be stripped from the published tarball`,
  );
}

const skills = readdirSync(join(pluginRoot, 'skills')).filter((name) =>
  existsSync(join(pluginRoot, 'skills', name, 'SKILL.md')),
);
assert.ok(skills.length >= 5, 'Expected compact meta-skills');

for (const name of skills) {
  const skill = readFileSync(join(pluginRoot, 'skills', name, 'SKILL.md'), 'utf8');
  assert.match(skill, /^---\r?\nname: [a-z0-9-]+/);
  assert.match(skill, /\ndescription: /);
  assert.doesNotMatch(skill, /TODO|\[TODO/i);
}

const riskCatalog = readJson(join(pluginRoot, 'safety', 'rules', 'cloud-risk-rules.json'));
assert.equal(riskCatalog.version, '0.1.0');
assert.ok(Array.isArray(riskCatalog.rules));
assert.ok(riskCatalog.rules.length >= 8);

const privateMarkers = String(process.env.HUAWEICLOUD_DEVKIT_PRIVATE_MARKERS || '')
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean);
const publicRuleText = JSON.stringify(riskCatalog);
for (const marker of privateMarkers) {
  assert.ok(!publicRuleText.includes(marker), `Public risk rules contain private marker: ${marker}`);
}

const ruleIds = new Set();
const allowedSeverities = new Set(['deny', 'warn', 'info']);
const allowedStages = new Set(['command', 'artifact', 'deploy_plan']);
for (const rule of riskCatalog.rules) {
  assert.match(rule.id, /^hwc-[a-z0-9-]+$/);
  assert.ok(!ruleIds.has(rule.id), `Duplicate risk rule id: ${rule.id}`);
  ruleIds.add(rule.id);
  assert.ok(allowedSeverities.has(rule.severity), `${rule.id} has invalid severity`);
  assert.ok(Array.isArray(rule.stages) && rule.stages.length > 0, `${rule.id} has no stages`);
  for (const stage of rule.stages) {
    assert.ok(allowedStages.has(stage), `${rule.id} has invalid stage: ${stage}`);
  }
  assert.ok(rule.match && (rule.match.any || rule.match.all), `${rule.id} has no match block`);
  assert.ok(rule.message && rule.remediation, `${rule.id} has no user guidance`);
  assert.doesNotMatch(JSON.stringify(rule), /\baccountId\b|\bticketId\b|\brawText\b|\binternalSource\b/i);
}

console.log(`Validated HuaweiCloud DevKit with ${skills.length} skills.`);

// KooCLI version pairing: package.json declares the paired version, and every
// fixed download URL in skills + source must target cli/<kooCliVersion>.
const kooCliVersion = pkg.kooCliVersion;
assert.match(
  kooCliVersion ?? '',
  /^\d+\.\d+\.\d+$/,
  'package.json must declare a "kooCliVersion" semver (e.g. "7.2.12")',
);

function walk(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, acc);
    else if (/\.(md|mjs|cjs)$/.test(entry.name)) acc.push(full);
  }
  return acc;
}

for (const file of walk(join(pluginRoot, 'skills')).concat(walk(join(pluginRoot, 'src')))) {
  const text = readFileSync(file, 'utf8');
  for (const line of text.split('\n')) {
    if (line.includes('cli/latest') && !line.includes('hcloud_install.sh')) {
      assert.fail(`${file}: fixed download URL must not use cli/latest`);
    }
    const m = line.match(/cli\/(\d+\.\d+\.\d+)/);
    if (m && m[1] !== kooCliVersion) {
      assert.fail(`${file}: download URL pins cli/${m[1]}, expected cli/${kooCliVersion}`);
    }
    assert.doesNotMatch(line, /hwcloudcli\.obs\.cn-north-1/, `${file}: stale hwcloudcli endpoint`);
  }
}
console.log(`Validated KooCLI version pairing: ${kooCliVersion}.`);

const readmePaths = [join(root, 'README.md'), join(root, 'README.zh-CN.md')];

readmePaths.forEach((path) => {
  assert.ok(existsSync(path), `Missing README: ${path}`);
});

const readmes = readmePaths.map((p) => ({ path: p, text: readFileSync(p, 'utf8') }));

readmes.forEach(({ path, text }) => {
  if (!/huaweicloud-devkit-mcp/.test(text)) {
    console.warn(`\x1b[33m[README]\x1b[0m ${path}: missing standard MCP npx config`);
  }
  if (!/Sandbox|DevStation/i.test(text)) {
    console.warn(`\x1b[33m[README]\x1b[0m ${path}: missing sandbox/DevStation feature`);
  }
});
