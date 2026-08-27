import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const version = process.argv[2];
const branch = process.argv[3];

function run(cmd, opts) {
  return execSync(cmd, { cwd: root, stdio: 'inherit', ...opts });
}

function readJson(p) {
  return JSON.parse(readFileSync(join(root, p), 'utf8'));
}

function writeJson(p, obj) {
  writeFileSync(join(root, p), `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
}

const manifest = readJson('.release-please-manifest.json');
const previousVersion = manifest['.'];
manifest['.'] = version;
writeJson('.release-please-manifest.json', manifest);

const pkg = readJson('package.json');
pkg.version = version;
writeJson('package.json', pkg);

const lock = readJson('package-lock.json');
lock.version = version;
if (lock.packages && lock.packages['']) {
  lock.packages[''].version = version;
}
writeJson('package-lock.json', lock);

const pluginRoot = 'plugins/huaweicloud-core';
['.codex-plugin', '.claude-plugin', '.cursor-plugin', '.workbuddy-plugin', '.hermes-plugin'].forEach((dir) => {
  const p = join(pluginRoot, dir, 'plugin.json');
  const m = readJson(p);
  m.version = version;
  writeJson(p, m);
});

{
  const p = join(pluginRoot, 'openclaw.plugin.json');
  const m = readJson(p);
  m.version = version;
  writeJson(p, m);
}

let commits;
try {
  commits = execSync(`git log "v${previousVersion}"..HEAD --no-merges --format="- %s"`, {
    encoding: 'utf8',
    cwd: root,
  }).trim();
} catch {
  commits = execSync(`git log --no-merges --format="- %s"`, { encoding: 'utf8', cwd: root }).trim();
}

const date = new Date().toISOString().split('T')[0];
const changelogPath = 'docs/CHANGELOG.md';
let changelog;
try {
  changelog = readFileSync(join(root, changelogPath), 'utf8');
} catch {
  changelog = '# Changelog\n';
}
const marker = changelog.indexOf('\n');
const insertAt = marker >= 0 ? marker + 1 : 0;
const entry = `\n## ${version} (${date})\n\n${commits || '- Release'}\n`;
changelog = changelog.slice(0, insertAt) + entry + changelog.slice(insertAt);
writeFileSync(join(root, changelogPath), changelog, 'utf8');

const changedFiles = [
  '.release-please-manifest.json',
  'package.json',
  'package-lock.json',
  changelogPath,
  `${pluginRoot}/.codex-plugin/plugin.json`,
  `${pluginRoot}/.claude-plugin/plugin.json`,
  `${pluginRoot}/.cursor-plugin/plugin.json`,
  `${pluginRoot}/.workbuddy-plugin/plugin.json`,
  `${pluginRoot}/.hermes-plugin/plugin.json`,
  `${pluginRoot}/openclaw.plugin.json`,
];
execSync(`npx prettier --write ${changedFiles.join(' ')}`, { cwd: root, stdio: 'inherit' });

const isPrerelease = version.includes('-');
const prBranch = isPrerelease ? `release-${branch}-${version}` : `release-${version}`;
run(`git checkout -b ${prBranch}`);
run('git add .release-please-manifest.json package.json package-lock.json docs/CHANGELOG.md');
run(`git add ${pluginRoot}/.codex-plugin/plugin.json`);
run(`git add ${pluginRoot}/.claude-plugin/plugin.json`);
run(`git add ${pluginRoot}/.cursor-plugin/plugin.json`);
run(`git add ${pluginRoot}/.workbuddy-plugin/plugin.json`);
run(`git add ${pluginRoot}/.hermes-plugin/plugin.json`);
run(`git add ${pluginRoot}/openclaw.plugin.json`);

run(`git commit -m "chore(release): ${version}"`);

const token = process.env.RELEASE_PLEASE_TOKEN || process.env.GITHUB_TOKEN;
run(`git push origin ${prBranch}`, { env: { ...process.env, GITHUB_TOKEN: token } });

const tmp = mkdtempSync(join(tmpdir(), 'pr-body-'));
const bodyPath = join(tmp, 'body.md');
const bodyLines = [
  '## Changes',
  '',
  ...(commits ? commits.split('\n') : ['- Release']),
  '',
  `Merge to bump the version to \`${version}\`.`,
  'After merging, dispatch `Publish npm` from the created tag.',
];
writeFileSync(bodyPath, bodyLines.join('\n'), 'utf8');

run(`gh pr create --base ${branch} --head ${prBranch} --title "chore(release): ${version}" --body-file "${bodyPath}"`, {
  env: { ...process.env, GITHUB_TOKEN: token },
});

rmSync(tmp, { recursive: true, force: true });
