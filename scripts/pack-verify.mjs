import assert from 'node:assert/strict';
import { execSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Same parser doctor reads (src/lib/skill-manifest.ts, pure and zod-free);
// the loud shape assert below is pack verification's own addition.
import { parseSkillManifest } from '../plugins/huaweicloud-core/src/lib/skill-manifest.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const quote = (arg) => `"${arg.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const runNpm = (args, options) =>
  execSync([npm, ...args.map((arg) => quote(arg))].join(' '), { stdio: 'ignore', ...options });

// Synthetic runtime state: a fresh checkout has no telemetry/, __pycache__,
// or staging dirs, so the exclusion assertions below would be vacuous in CI
// — the files-array negations could silently break and only a developer's
// dirty worktree would notice. Stage probe files that match the excluded
// patterns before packing and clean them up afterwards. Probe names are not
// real stamp names, so live telemetry state is never touched. dist.new is
// deliberately NOT probed: prepack's build removes it before npm collects
// the file list, so a probe there is dead by construction — see the
// runtime-state assertion below.
const probeFiles = [
  join(root, 'plugins', 'huaweicloud-core', 'telemetry', 'pack-verify-probe'),
  join(root, 'plugins', 'huaweicloud-core', 'hooks', '__pycache__', 'pack-verify-probe.pyc'),
  join(root, 'plugins', 'huaweicloud-core', 'skills.new-probe', 'SKILL.md'),
];
const createdProbes = probeFiles.filter((probe) => !existsSync(probe));
const createdProbeDirs = [...new Set(probeFiles.map((probe) => dirname(probe)))].filter((dir) => !existsSync(dir));
for (const dir of createdProbeDirs) mkdirSync(dir, { recursive: true });
for (const probe of createdProbes) writeFileSync(probe, 'pack-verify probe');

try {
  const packed = JSON.parse(
    runNpm(['pack', '--json'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }),
  );
  assert.equal(packed.length, 1, 'npm pack should produce exactly one tarball');
  const { filename, files } = packed[0];
  const paths = new Set(files.map((f) => f.path.replace(/^package\//, '')));

  // Probe liveness: every probe must still exist on disk after npm collected
  // the file list. A probe that vanished mid-pack (a prepack step deleting
  // it — the sweep taking a >1h-old leftover, a build removing a staging
  // name) means its exclusion was never exercised THIS run; asserting
  // absence against a listing that cannot contain the probe would be
  // vacuous, the exact dead-by-construction class this mechanism exists to
  // kill. This check catches that mechanically, no reachability analysis
  // required.
  for (const probe of probeFiles) {
    assert.ok(existsSync(probe), `probe vanished before file collection — its exclusion was not exercised: ${probe}`);
  }

  const requiredFiles = [
    'package.json',
    'bin/setup.cjs',
    'bin/dsh-postinstall.cjs',
    '.agents/plugins/marketplace.json',
    'integrations/opencode/opencode.json',
    'plugins/huaweicloud-core/.mcp.json',
    'plugins/huaweicloud-core/.codex-plugin/plugin.json',
    'plugins/huaweicloud-core/.claude-plugin/plugin.json',
    'plugins/huaweicloud-core/.cursor-plugin/plugin.json',
    'plugins/huaweicloud-core/.workbuddy-plugin/plugin.json',
    'plugins/huaweicloud-core/hooks/hooks.json',
    'plugins/huaweicloud-core/dist/lib/native-receipt.js',
    'plugins/huaweicloud-core/dist/lib/skill-manifest.js',
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

  // The skills tree ships as a generated artifact: gitignored, produced by
  // prepack's build step. npm pack includes on-disk files under the
  // whitelisted plugin dir (the same mechanism that ships the gitignored
  // dist/), so the tree must be present at pack time — and the manifest it
  // carries is the roster the tarball has to match, file by file. Parsed
  // through the shared parseSkillManifest (the same parser doctor reads);
  // the loud shape assert on top is pack verification's own — a malformed
  // or empty roster must fail here, not silently ship.
  const manifestEntry = 'plugins/huaweicloud-core/skills/.manifest.json';
  assert.ok(paths.has(manifestEntry), 'Tarball is missing the skills manifest (did prepack run the build?)');
  const manifestSkills = parseSkillManifest(readFileSync(join(root, manifestEntry), 'utf8'));
  assert.ok(manifestSkills.length > 0, 'skills manifest is malformed');
  for (const skill of manifestSkills) {
    assert.ok(
      paths.has(`plugins/huaweicloud-core/skills/${skill}/SKILL.md`),
      `Tarball is missing skill ${skill} declared by the manifest`,
    );
  }

  // The authoritative sources under src/packs/*/skills are excluded from the
  // tarball (the generated tree is the only copy that ships, keeping the
  // artifact from carrying every skill twice). Pin the negation: a files-array
  // typo or an npm glob-behavior change would silently re-ship them.
  const sourceSkill = [...paths].find((p) => /^plugins\/huaweicloud-core\/src\/packs\/[^/]+\/skills\//.test(p));
  assert.ok(!sourceSkill, `Tarball must not ship authoritative skill sources (found ${sourceSkill})`);

  // Runtime state, host bytecode, and skills staging dirs must never ship.
  // `files` disables npm's .gitignore handling, so gitignored artifacts under
  // the whitelisted plugin dir pack unless negated explicitly — a shipped
  // first-use-stamp suppresses the plugin:first_use telemetry event for every
  // consumer of the tarball. The staged probes make this assertion live even
  // on a fresh CI checkout. dist.new is structurally excluded rather than
  // asserted: prepack's build always removes it before npm collects the file
  // list, so no listing can ever contain it; the `!.../dist.new` files entry
  // remains only as defense for a hypothetical `npm pack --ignore-scripts`
  // of a crashed worktree.
  const runtimeState = [...paths].find(
    (p) =>
      /^plugins\/huaweicloud-core\/telemetry\//.test(p) ||
      /^plugins\/huaweicloud-core\/skills\.new-/.test(p) ||
      p.includes('__pycache__') ||
      p.endsWith('.pyc'),
  );
  assert.ok(
    !runtimeState,
    `Tarball must not ship runtime state, bytecode caches, or staging dirs (found ${runtimeState})`,
  );

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
} finally {
  // All probe files are ours by naming (pack-verify-probe*), including
  // litter from a crashed previous run; dirs are removed only when this
  // run created them (a pre-existing dir may hold live state).
  for (const probe of probeFiles) rmSync(probe, { force: true });
  for (const dir of createdProbeDirs) rmSync(dir, { recursive: true, force: true });
}
