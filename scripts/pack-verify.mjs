import assert from 'node:assert/strict';
import { execSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const quote = (arg) => `"${arg.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const runNpm = (args, options) =>
  execSync([npm, ...args.map((arg) => quote(arg))].join(' '), { stdio: 'ignore', ...options });

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

// The built runtime must ship. Candidates cover the .mjs/.js emit extension
// used before and after the TypeScript migration.
const distServer = [...paths].find((p) => /^plugins\/huaweicloud-core\/dist\/mcp-server\.(?:mjs|js)$/.test(p));
assert.ok(distServer, 'Tarball is missing the built MCP server under plugins/huaweicloud-core/dist/');
for (const asset of [
  'plugins/huaweicloud-core/dist/data/icons-manifest.v1.json',
  'plugins/huaweicloud-core/dist/sandbox/sandbox-file-server.py',
]) {
  assert.ok(paths.has(asset), `Tarball is missing built asset ${asset}`);
}

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const dshPatch = pkg.dsh?.bundle?.patch;
if (dshPatch) {
  const patchFile = dshPatch.replace(/^\.\//, '');
  assert.ok(
    paths.has(patchFile),
    `Tarball is missing dsh.bundle.patch (${dshPatch}) — add it to the package.json "files" whitelist`,
  );
  assert.ok(
    Array.isArray(pkg.files) && pkg.files.some((entry) => patchFile === entry || patchFile.startsWith(`${entry}/`)),
    `dsh.bundle.patch (${dshPatch}) is not covered by the package.json "files" whitelist`,
  );
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

  // File existence is not enough: the shipped entry points must actually run.
  const versionRun = spawnSync(process.execPath, [join(installed, 'bin', 'setup.cjs'), 'version'], {
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.equal(versionRun.status, 0, `bin/setup.cjs version failed: ${versionRun.stderr}`);
  assert.ok(
    versionRun.stdout.includes(pkg.version),
    `bin/setup.cjs version did not report ${pkg.version}: ${versionRun.stdout}`,
  );

  const request = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
  const framed = `Content-Length: ${Buffer.byteLength(request, 'utf8')}\r\n\r\n${request}`;
  const serverRun = spawnSync(process.execPath, [join(installed, distServer)], {
    input: framed,
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.ok(
    serverRun.stdout.includes('"result"'),
    `Installed MCP server did not answer tools/list: ${serverRun.stdout}${serverRun.stderr}`,
  );
  assert.ok(
    serverRun.stdout.includes('huaweicloud_'),
    'Installed MCP server tools/list returned no Huawei Cloud tools',
  );

  // Agent harnesses launch whatever .mcp.json declares, not what the tarball
  // contains — so the declared server must run from the installed layout.
  const installedMcpJson = JSON.parse(
    readFileSync(join(installed, 'plugins', 'huaweicloud-core', '.mcp.json'), 'utf8'),
  );
  for (const server of Object.values(installedMcpJson.mcpServers ?? {})) {
    const declared = join(installed, 'plugins', 'huaweicloud-core', ...(server.args ?? []));
    const declaredRun = spawnSync(process.execPath, [declared], {
      input: framed,
      encoding: 'utf8',
      timeout: 30_000,
    });
    assert.ok(
      declaredRun.stdout.includes('"result"'),
      `.mcp.json server ${JSON.stringify(server.args)} did not answer tools/list: ${declaredRun.stderr}`,
    );
  }
  if (dshPatch) {
    assert.ok(
      existsSync(join(installed, dshPatch.replace(/^\.\//, ''))),
      `Installed package is missing dsh.bundle.patch (${dshPatch})`,
    );
  }
} finally {
  rmSync(installDir, { recursive: true, force: true });
  rmSync(tarballPath, { force: true });
}

console.log(`Verified pack of ${filename}: ${files.length} files, install OK.`);
