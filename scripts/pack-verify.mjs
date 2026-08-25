import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const quote = (arg) => `"${arg.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const runNpm = (args, options) => execSync([npm, ...args.map(quote)].join(' '), { stdio: 'ignore', ...options });

const packed = JSON.parse(
  runNpm(['pack', '--json'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }),
);
assert.equal(packed.length, 1, 'npm pack should produce exactly one tarball');
const { filename, files } = packed[0];
const paths = new Set(files.map((f) => f.path.replace(/^package\//, '')));

const requiredFiles = [
  'package.json',
  'bin/setup.cjs',
  '.agents/plugins/marketplace.json',
  'integrations/opencode/opencode.json',
  'plugins/huaweicloud-core/.mcp.json',
  'plugins/huaweicloud-core/.codex-plugin/plugin.json',
  'plugins/huaweicloud-core/.claude-plugin/plugin.json',
  'plugins/huaweicloud-core/.cursor-plugin/plugin.json',
  'plugins/huaweicloud-core/.workbuddy-plugin/plugin.json',
  'plugins/huaweicloud-core/hooks/hooks.json',
  'plugins/huaweicloud-core/hooks/huaweicloud-safety.py',
  'plugins/huaweicloud-core/safety/policy.json',
  'plugins/huaweicloud-core/safety/rules/cloud-risk-rules.json',
  'plugins/huaweicloud-core/skills/huaweicloud-core/SKILL.md',
];
for (const file of requiredFiles) {
  assert.ok(paths.has(file), `Tarball is missing ${file}`);
}

const tarballPath = join(root, filename);
assert.ok(existsSync(tarballPath), 'Tarball was not created');

const installDir = mkdtempSync(join(tmpdir(), 'hwc-pack-verify-'));
try {
  runNpm(['init', '-y'], { cwd: installDir });
  runNpm(['install', tarballPath], { cwd: installDir });
  const installed = join(installDir, 'node_modules', 'huaweicloud-devkit');
  assert.ok(existsSync(join(installed, 'bin', 'setup.cjs')), 'Installed package is missing bin/setup.cjs');
  assert.ok(
    existsSync(join(installed, 'plugins', 'huaweicloud-core', 'skills', 'huaweicloud-core', 'SKILL.md')),
    'Installed package is missing the core skill',
  );
} finally {
  rmSync(installDir, { recursive: true, force: true });
  rmSync(tarballPath, { force: true });
}

console.log(`Verified pack of ${filename}: ${files.length} files, install OK.`);
