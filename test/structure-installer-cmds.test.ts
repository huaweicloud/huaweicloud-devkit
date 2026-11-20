import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join, sep } from 'node:path';
import test from 'node:test';

import { DEPENDENCIES } from '../plugins/huaweicloud-core/src/lib/dependency-model.ts';
import { pluginRoot, readSource } from './structure-helpers.ts';

test('KooCLI sandbox blockers and privacy agreement live in their extracted modules', () => {
  const setup = readSource(join('src', 'setup-cli.ts'));
  const hcloudProbe = readSource(join('src', 'hcloud-probe.ts'));
  const codeartsSandbox = readSource(join('src', 'codearts-sandbox.ts'));
  const depHcloud = readSource(join('src', 'dep', 'installers', 'hcloud.ts'));
  // sandbox detection reads the CodeArts permission config (codearts-sandbox.ts,
  // shared by doctor and the KooCLI installer; no leftover local copy in setup-cli)
  assert.match(codeartsSandbox, /function detectCodeartsSandbox\(\)/);
  assert.match(codeartsSandbox, /codearts-data', 'storage', 'permission', 'config\.json'/);
  assert.match(codeartsSandbox, /\.\s*bash_mode/);
  // sandbox warning prompts user to install externally or disable sandbox
  assert.match(codeartsSandbox, /function printSandboxWarning\(/);
  assert.match(codeartsSandbox, /检测到码道沙箱模式/);
  assert.match(codeartsSandbox, /在码道外的终端安装并使用 KooCLI/);
  assert.match(codeartsSandbox, /关闭沙箱模式后重试/);
  assert.match(setup, /from '\.\/codearts-sandbox\.(?:mjs|ts)'/);
  assert.doesNotMatch(setup, /function detectCodeartsSandbox\(\)/, 'detection must not be duplicated in setup-cli');
  // hcloud lookup delegates to the shared resolution chain; the HCLOUD_BIN
  // override is a property of the dependency catalog (envBin), not a literal
  // in this module — the old process.env.HCLOUD_BIN regex here passed only
  // because HCLOUD_BIN_ARGS_JSON prefixes it.
  assert.match(setup, /from '\.\/hcloud-probe\.(?:mjs|ts)'/);
  assert.match(hcloudProbe, /function findHcloudBin\(\)/);
  assert.equal(DEPENDENCIES.hcloud.resolution.envBin, 'HCLOUD_BIN');
  assert.match(hcloudProbe, /resolveDependencyCommand\(DEPENDENCIES\.hcloud\.resolution\)/);
  assert.match(hcloudProbe, /sandbox_home_failure/);
  // install-hcloud surfaces sandbox guidance on failure (caller moved with the installer)
  assert.match(depHcloud, /沙箱模式拦截了 KooCLI 自动安装/);
  // privacy agreement is gated on the tty flag on BOTH platforms (the Windows
  // branch used to lack the gate and hang non-interactive sessions)
  assert.match(depHcloud, /await offerPrivacyAcceptance\(join\(installDir, 'hcloud\.exe'\), opts\.tty\)/);
  assert.match(depHcloud, /await offerPrivacyAcceptance\(binPath, opts\.tty\)/);
  assert.match(depHcloud, /非交互会话：请稍后在终端运行 hcloud version/);
  // the caller computes the gate; the installer stays testable
  assert.match(setup, /process\.stdin\.isTTY === true && process\.stdout\.isTTY === true/);
  // MCP env injects HCLOUD_BIN when an hcloud binary is found (the agent
  // registration modules own the env assembly now)
  assert.match(
    readSource(join('src', 'agents', 'codearts.ts')),
    /if \(hcloudBin\) env\.HCLOUD_BIN = hcloudBin\.replace/,
  );
  // doctor warns about sandbox mode with the accurate settings path (#261)
  assert.match(setup, /KooCLI 可能无法写入 ~/);
  assert.match(setup, /设置 → 对话流 → 智能体 终端命令运行模式 → 自动运行/);
});

test('hermes restart hints, unix auto-install in dep/installers/hcloud, grouped status (#280)', () => {
  const setup = readSource(join('src', 'setup-cli.ts'));
  const depHcloud = readSource(join('src', 'dep', 'installers', 'hcloud.ts'));
  // Hermes .installed marker is read for restart hints (#280-4): hermes is
  // a row of the payload-target table the marker loop and the update
  // dispatch derive from.
  assert.match(setup, /id: 'hermes',\s+label: 'Hermes Agent',\s+dir: hermesPluginsDir,/);
  assert.match(setup, /update: \(\) => deployHermes\('update'\),/);
  assert.match(setup, /join\(target\.dir\(\), '\.installed'\)/);
  // Unix install-hcloud executes for real: download → extract → install → verify
  // (#280-3); the body moved to dep-provision.ts when provisioning absorbed
  // it, on to dep-hcloud.ts when the per-dependency installers split, and
  // into dep/installers/ when the subsystem organized by abstraction level.
  assert.match(depHcloud, /Auto-installing to \$\{binDir\}/);
  assert.match(depHcloud, /spawnSync\('curl', \['-fL', url, '-o', tmpTar\]/);
  assert.match(depHcloud, /spawnSync\('tar', \['-xzf', tmpTar, '-C', scratch\]/);
  // download/extract scratch is per-run (mkdtemp) and cleaned up in finally:
  // the fixed tmpdir()/huaweicloud-cli-<pkg>.tar.gz path collided across
  // concurrent installs, and auto-provisioning made concurrent installs normal.
  assert.match(depHcloud, /mkdtempSync\(join\(tmpdir\(\), 'huaweicloud-devkit-'\)\)/);
  assert.match(depHcloud, /rmSync\(scratch, \{ recursive: true, force: true \}\)/);
  // status groups sections by install state, installed first (#280-9)
  assert.match(setup, /stateOrder: Record<InstallState, number> = \{ installed: 0, partial: 1, unknown: 2, not: 3 \}/);
  assert.match(setup, /已安装: /);
});

test('dependency provisioning: new modules stay unbundled; setup-cli delegates', () => {
  const setup = readSource(join('src', 'setup-cli.ts'));
  const codeartsSandbox = readSource(join('src', 'codearts-sandbox.ts'));
  const depResolve = readSource(join('src', 'lib', 'dep-resolve.ts'));
  const targetsModule = readSource(join('src', 'targets.ts'));
  const installPayload = readSource(join('src', 'install-payload.ts'));
  const packsPolicy = readSource(join('src', 'packs-policy.ts'));
  // The dep module tree is walked, not enumerated: every .ts file under
  // src/dep/ — including one a future dependency adds, at any depth — joins
  // the guard automatically, so the zod-free import graph cannot regress by
  // forgetting a list entry.
  const depModules = (readdirSync(join(pluginRoot, 'src', 'dep'), { recursive: true }) as string[])
    .filter((name) => name.endsWith('.ts'))
    .sort((a, b) => a.localeCompare(b));
  assert.ok(depModules.length >= 5, `expected the dep module family, found: ${depModules.join(', ')}`);
  // Same walk for the secret vault: every .ts file under
  // src/lib/secret-vault/ joins the zod-free guard automatically.
  const vaultModules = (readdirSync(join(pluginRoot, 'src', 'lib', 'secret-vault'), { recursive: true }) as string[])
    .filter((name) => name.endsWith('.ts'))
    .sort((a, b) => a.localeCompare(b));
  assert.ok(vaultModules.length >= 3, `expected the secret-vault module family, found: ${vaultModules.join(', ')}`);
  // And for the auth subsystem (#900 error-table port): src/auth/* is kept
  // zod-free BY POLICY — every module but one compiles into the unbundled
  // setup-cli graph (setup-cli.ts reaches the family through the
  // credentials.ts face and the auth command modules), and the one exception
  // (credential-validator) is reachable only from the bundled mcp-server
  // graph, where zod exists but the subsystem stays uniform with the rest.
  // Walking the whole tree keeps either graph safe.
  const authModules = (readdirSync(join(pluginRoot, 'src', 'auth'), { recursive: true }) as string[])
    .filter((name) => name.endsWith('.ts'))
    .sort((a, b) => a.localeCompare(b));
  assert.ok(authModules.length >= 7, `expected the auth module family, found: ${authModules.join(', ')}`);
  // Same walk for the agent lifecycle modules: every .ts file under
  // src/agents/ joins the zod-free guard automatically — they compile into
  // the unbundled dist/setup-cli.js graph.
  const agentModules = (readdirSync(join(pluginRoot, 'src', 'agents'), { recursive: true }) as string[])
    .filter((name) => name.endsWith('.ts'))
    .sort((a, b) => a.localeCompare(b));
  assert.ok(agentModules.length >= 2, `expected the agents module family, found: ${agentModules.join(', ')}`);
  // And for the safety family: the internal split of safety-policy.ts. The
  // family feeds BOTH graphs — the hook's Node require path (unbundled
  // dist/safety-policy.js) and the bundled mcp-server — so every module
  // stays zod-free and SDK-free exactly like the face it was split from.
  const safetyModules = (readdirSync(join(pluginRoot, 'src', 'safety'), { recursive: true }) as string[])
    .filter((name) => name.endsWith('.ts'))
    .sort((a, b) => a.localeCompare(b));
  assert.ok(safetyModules.length >= 5, `expected the safety module family, found: ${safetyModules.join(', ')}`);
  // And the packs-cli family (the slot table, writers, union, doctor face,
  // and command bodies — all in the unbundled setup-cli graph).
  const packsCliModules = (readdirSync(join(pluginRoot, 'src', 'packs-cli'), { recursive: true }) as string[])
    .filter((name) => name.endsWith('.ts'))
    .sort((a, b) => a.localeCompare(b));
  assert.ok(packsCliModules.length >= 5, `expected the packs-cli module family, found: ${packsCliModules.join(', ')}`);
  // And the proxy family (the config module + the CLI — the CLI joined the
  // unbundled graph with the proxy command extraction).
  const proxyModules = (readdirSync(join(pluginRoot, 'src', 'proxy'), { recursive: true }) as string[])
    .filter((name) => name.endsWith('.ts'))
    .sort((a, b) => a.localeCompare(b));
  assert.ok(proxyModules.length >= 2, `expected the proxy module family, found: ${proxyModules.join(', ')}`);
  // These compile into the unbundled dist/setup-cli.js graph, where only
  // undici exists at runtime: no zod, no SDK, ever.
  const guarded = [
    ...depModules.map((name) => [`src/dep/${name}`, readSource(join('src', 'dep', name))] as const),
    ...vaultModules.map(
      (name) => [`src/lib/secret-vault/${name}`, readSource(join('src', 'lib', 'secret-vault', name))] as const,
    ),
    ...authModules.map((name) => [`src/auth/${name}`, readSource(join('src', 'auth', name))] as const),
    ...agentModules.map((name) => [`src/agents/${name}`, readSource(join('src', 'agents', name))] as const),
    ...safetyModules.map((name) => [`src/safety/${name}`, readSource(join('src', 'safety', name))] as const),
    ...packsCliModules.map((name) => [`src/packs-cli/${name}`, readSource(join('src', 'packs-cli', name))] as const),
    ...proxyModules.map((name) => [`src/proxy/${name}`, readSource(join('src', 'proxy', name))] as const),
    ['src/codearts-sandbox.ts', codeartsSandbox] as const,
    ['src/lib/dep-resolve.ts', depResolve] as const,
    ['src/targets.ts', targetsModule] as const,
    ['src/install-payload.ts', installPayload] as const,
    // The payload family internals (the install-payload.ts split): they
    // compile into the unbundled setup-cli graph through the face, so they
    // join the zod-free guard alongside it — one entry per sibling, added
    // in the same commit as the module.
    ['src/payload-utils.ts', readSource(join('src', 'payload-utils.ts'))] as const,
    ['src/payload-files.ts', readSource(join('src', 'payload-files.ts'))] as const,
    ['src/payload-placement.ts', readSource(join('src', 'payload-placement.ts'))] as const,
    ['src/payload-roster.ts', readSource(join('src', 'payload-roster.ts'))] as const,
    ['src/payload-native-sync.ts', readSource(join('src', 'payload-native-sync.ts'))] as const,
    ['src/payload-native-clean.ts', readSource(join('src', 'payload-native-clean.ts'))] as const,
    ['src/payload-runtime-deps.ts', readSource(join('src', 'payload-runtime-deps.ts'))] as const,
    ['src/payload-status.ts', readSource(join('src', 'payload-status.ts'))] as const,
    ['src/packs-policy.ts', packsPolicy] as const,
    ['src/mcp-config-io.ts', readSource(join('src', 'mcp-config-io.ts'))] as const,
    ['src/lib/cli-io.ts', readSource(join('src', 'lib', 'cli-io.ts'))] as const,
    ['src/officeace-paths.ts', readSource(join('src', 'officeace-paths.ts'))] as const,
    // The doctor section modules compile into the unbundled setup-cli graph
    // (the table binds them), so they join the zod-free guard. So do the
    // banner leaf and the install-planning family.
    ['src/doctor-report.ts', readSource(join('src', 'doctor-report.ts'))] as const,
    ['src/doctor-payload.ts', readSource(join('src', 'doctor-payload.ts'))] as const,
    ['src/doctor-native.ts', readSource(join('src', 'doctor-native.ts'))] as const,
    // The integrity receipt module: written at the placement seam and read
    // by the doctor sections — both members of this unbundled graph, so it
    // joins the zod-free guard the same way (node builtins only).
    ['src/safety-integrity.ts', readSource(join('src', 'safety-integrity.ts'))] as const,
    ['src/lib/banner.ts', readSource(join('src', 'lib', 'banner.ts'))] as const,
    // The opencode saved-permission reader is a zod-free leaf serving the
    // unbundled doctor (hygiene only since the server-run gate took over the
    // confirmation), and it joins the guard by hand: src/lib/*.ts has no
    // automatic walk.
    ['src/lib/opencode-saved-perms.ts', readSource(join('src', 'lib', 'opencode-saved-perms.ts'))] as const,
    // The consent ledger joins the same graph with PR-3a's doctor listing
    // of session standing consents (readConsentEvents is read-only there);
    // it is zod-free by contract (its only imports are node builtins, the
    // dep lock, and type-only edges), and it joins the guard by hand for
    // the same reason: src/*.ts has no automatic walk.
    ['src/approval-ledger.ts', readSource(join('src', 'approval-ledger.ts'))] as const,
    ['src/install-plan.ts', readSource(join('src', 'install-plan.ts'))] as const,
    ['src/install-prompts.ts', readSource(join('src', 'install-prompts.ts'))] as const,
    ['src/mcp-agent-config.ts', readSource(join('src', 'mcp-agent-config.ts'))] as const,
  ];
  for (const [name, source] of guarded) {
    assert.doesNotMatch(source, /from 'zod'/, `${name} must not import zod`);
    assert.doesNotMatch(source, /@modelcontextprotocol/, `${name} must not import the SDK`);
  }
  // lib/dep-resolve keeps the src/lib contract: runtime imports are node:*
  // builtins only; the dependency-model edge is type-only.
  const importLines = depResolve.split('\n').filter((line) => line.startsWith('import '));
  assert.ok(importLines.length >= 5, 'dep-resolve should import node builtins');
  for (const line of importLines) {
    assert.ok(
      line.includes("from 'node:") || line.startsWith('import type '),
      `lib/dep-resolve.ts runtime import must be node:* or type-only: ${line}`,
    );
  }
  // The installer body is absorbed, not duplicated: setup-cli owns the CLI
  // wrapper only.
  assert.doesNotMatch(setup, /spawnSync\('curl'/, 'the KooCLI installer body lives in dep/installers/hcloud.ts');
  assert.match(
    setup,
    /await installKooCli\(\{ tty: process\.stdin\.isTTY === true && process\.stdout\.isTTY === true \}\)/,
    'cmdInstallHcloud is the thin wrapper',
  );
  // Install and update both provision after payload placement, gated on the
  // flag. The provisioning body moved with the packs family
  // (packs-cli/report.ts); setup-cli keeps the call sites.
  assert.match(
    readSource(join('src', 'packs-cli', 'report.ts')),
    /Provisioning pack binaries \(enabled packs: \$\{union\.size\}\)/,
  );
  assert.match(setup, /await provisionPackBinaries\(\)/);
  assert.match(setup, /hasCliFlag\('--skip-binaries'\)/);
  assert.match(setup, /const updated = await dispatchUpdateTarget\(target\);/);
  assert.match(setup, /--skip-binaries {3}\(with: install\/update\) skip provisioning host binaries/);
});

test('src subdir modules never climb __dirname more than one level (bundle depth trap)', () => {
  // The esbuild server bundle collapses every inlined module's
  // import.meta.url to the bundle file (<plugin>/dist/mcp-server.js), so a
  // module under src/<subdir>/ has a DIFFERENT __dirname depth in the bundle
  // than in the tsc/source tree: join(__dirname, '..', '..') resolves to the
  // plugin root in the tsc tree and to the plugin root's PARENT in the
  // bundle. That off-by-one wrote the telemetry dir into the codex plugin
  // cache's version parent, where codex's version-dir scan resolved the
  // stray 'telemetry' sibling as the version and stopped loading the plugin
  // (fixed by resolvePluginDir in telemetry.ts; behavior pinned in
  // telemetry-plugin-dir.test.ts). src ROOT modules are exempt: src/ and
  // dist/ are siblings under the plugin root, so any N-up join from a root
  // module resolves identically in both shapes (koocli-version.ts).
  const srcRoot = join(pluginRoot, 'src');
  const subdirModules = (readdirSync(srcRoot, { recursive: true }) as string[])
    .filter((name) => name.endsWith('.ts') && name.includes(sep))
    .sort((a, b) => a.localeCompare(b));
  assert.ok(subdirModules.length >= 10, `expected the src subdir module family, found: ${subdirModules.length}`);
  for (const name of subdirModules) {
    const source = readSource(join('src', name));
    for (const match of source.matchAll(/(?:join|resolve)\(\s*__dirname\b([^)]*)\)/g)) {
      const climbs = (match[1]!.match(/'\.\.'/g) ?? []).length;
      assert.ok(
        climbs <= 1,
        `src/${name}: __dirname-anchored join climbs ${climbs} levels — the bundle shape resolves one too high; derive layout-dependent dirs by marker (resolvePluginDir in telemetry.ts)`,
      );
    }
  }
});

test('setup-cli.ts supports the dsh target end to end', () => {
  const setup = readSource(join('src', 'setup-cli.ts'));
  const targets = readSource(join('src', 'targets.ts'));
  // The dsh module family: the lifecycle + mcp-client package detection live
  // in dsh.ts, the cordis.patch.yml managed-block family in dsh-patch.ts
  // (the complex-file split).
  const dsh = readSource(join('src', 'agents', 'dsh.ts'));
  const dshPatch = readSource(join('src', 'agents', 'dsh-patch.ts'));
  // SUPPORTED_AGENT_TARGETS includes dsh and parseTarget uses it
  assert.match(setup, /'dsh'/);
  // DSH path helpers and managed patch constants exist
  assert.match(targets, /function dshRoot\(\)/);
  assert.match(targets, /function dshSkillsDir\(\)/);
  assert.match(targets, /function dshProfileDir\(\)/);
  assert.match(targets, /function dshPatchFile\(\)/);
  assert.match(targets, /function dshPluginsDir\(\)/);
  assert.match(dshPatch, /const DSH_MCP_PATCH_START = '# HuaweiCloud DevKit DSH integration start';/);
  assert.match(dshPatch, /const DSH_MCP_PATCH_END = '# HuaweiCloud DevKit DSH integration end';/);
  // deploy (install+update) / uninstall / status functions exist
  assert.match(dsh, /async function deployDsh\(mode: DeployMode\)/);
  assert.match(dsh, /function uninstallDsh\(removeOwnedSkills: \(dir: string\) => number\)/);
  assert.match(dsh, /function dshStatus\(\)/);
  // install ships the server payload and registers MCP through cordis.patch.yml
  assert.match(dsh, /copyServerPayload\(pluginDest\)/);
  // No wholesale native copy ever returns: only core-pack names sync natively
  // (syncNativeCoreSkills), so DSH's dir can never carry service skills. The
  // sync moved to src/payload-native-sync.ts in the install-payload split;
  // the pin follows the canonical home.
  assert.match(readSource(join('src', 'payload-native-sync.ts')), /function syncNativeCoreSkills\(dir: string\)/);
  assert.doesNotMatch(
    setup,
    /copyDir\(skillsSrc, (?:dsh|opencode|hermes|workbuddy|atomcode|openclaw|codearts|codeartsWork)SkillsDir\(\)\)/,
    'no wholesale native copy; only core-pack names sync natively',
  );
  assert.match(setup, /nativeSkills: \(\) => \[dshSkillsDir\(\)\]/, 'DSH row declares its native dir');
  assert.match(dsh, /ensureDshMcpPatch\(\)/);
  assert.match(dsh, /tryInstallDshMcpClient\(\)/);
  // DSH MCP patch uses dsh-mcp-client with stdio local server mode
  assert.match(dshPatch, /name: '@deepseek-ai\/dsh-mcp-client'/);
  assert.match(dshPatch, /serverName: huaweicloud/);
  assert.match(dshPatch, /transport: stdio/);
  assert.match(dshPatch, /failOnStartupError: false/);
  assert.match(dshPatch, /HUAWEICLOUD_AGENT_TOOLKIT_MODE: local/);
  // uninstall removes only the managed patch block
  assert.match(dsh, /removeDshMcpPatch\(\)/);
  // command dispatch covers dsh for install / uninstall / status / update
  const branches = setup.match(/target === 'dsh' \|\| target === 'all'/g);
  const installDispatch = setup.match(/shouldInstall\('dsh'\)/g);
  assert.ok(
    (branches?.length ?? 0) + (installDispatch?.length ?? 0) >= 4,
    `dsh dispatch branches: ${(branches?.length ?? 0) + (installDispatch?.length ?? 0)}`,
  );
  // .installed marker goes to the dsh plugins dir: the table row's dir field
  // (installMarkerDirForTarget is a lookup over the table — pinned in its own test)
  // doctor and the update dispatch reach DSH through the payload-target table
  assert.match(setup, /id: 'dsh',\s+label: 'DSH',\s+dir: dshPluginsDir,/);
  assert.match(setup, /update: \(\) => deployDsh\('update'\),/);
  assert.match(dshPatch, /function dshPatchConfigured\(\)/);
  // help text documents the target
  assert.match(
    setup,
    /--target <opencode\|codex\|codearts\|codearts-work\|workbuddy\|dsh\|officeace\|hermes\|openclaw\|atomcode\|all>/,
  );
  assert.match(setup, /install --target dsh/);
});

test('setup-cli.ts supports the version command', () => {
  const setup = readSource(join('src', 'setup-cli.ts'));
  assert.match(setup, /function cmdVersion\(\)/);
  assert.match(setup, /function readInstalledVersion\(/);
  assert.match(setup, /case '--version'/);
  assert.match(setup, /case 'version'/);
});

test('setup-cli.ts wires the auth reconcile subcommand', () => {
  const setup = readSource(join('src', 'setup-cli.ts'));
  const authCli = readSource(join('src', 'auth', 'cli.ts'));
  assert.match(setup, /case 'auth':\s*\n\s*await cmdAuth\(\)/, 'the shell dispatches to the auth CLI module');
  assert.match(authCli, /function cmdAuthReconcile\(\)/);
  assert.match(authCli, /sub === 'reconcile'/);
  assert.match(authCli, /return cmdAuthReconcile\(\)/);
});

test('setup-cli.ts resolves the active KooCLI profile for configureHcloud', () => {
  const hcloudProfile = readSource(join('src', 'auth', 'hcloud-profile.ts'));
  assert.match(hcloudProfile, /function configuredProfileName\(\)/);
  assert.match(hcloudProfile, /resolveManagedProfile\(\)/);
  assert.match(hcloudProfile, /return name \|\| 'default'/);
  assert.match(hcloudProfile, /--cli-profile=\$\{configuredProfileName\(\)\}/);
  assert.doesNotMatch(hcloudProfile, /hcloud configure init/);
});

test('setup-cli.ts checks for updates on install/update via shared query', () => {
  const setup = readSource(join('src', 'setup-cli.ts'));
  assert.match(setup, /async function checkForUpdate\(\)/);
  assert.match(setup, /queryDistTagsFetch\(/);
  assert.match(setup, /semverCompare\(/);
  const calls = setup.match(/^\s+await checkForUpdate\(\);$/gm);
  assert.ok(calls && calls.length >= 2, 'checkForUpdate should be awaited in both cmdInstall and cmdUpdate');
});

test('cmdUpdate has no trailing unreachable reinstall; cmdReinstall keeps it', () => {
  const setup = readSource(join('src', 'setup-cli.ts'));
  // cmdUpdate（'update'/'upgrade' 入口）本身不得做"卸载+重装"；各 target 分支均 return。
  const cmdUpdateBody = setup.slice(
    setup.indexOf('async function cmdUpdate()'),
    setup.indexOf('async function cmdReinstall()'),
  );
  assert.doesNotMatch(cmdUpdateBody, /await cmdUninstall\(/);
  assert.doesNotMatch(cmdUpdateBody, /await cmdInstall\(/);
  // cmdReinstall 是专职重装：卸载+重装逻辑必须保留。
  const cmdReinstallBody = setup.slice(
    setup.indexOf('async function cmdReinstall()'),
    setup.indexOf('async function cmdInstallHcloud()'),
  );
  assert.match(cmdReinstallBody, /await cmdUninstall\(\{ fromReinstall: true \}\)/);
  assert.match(cmdReinstallBody, /await cmdInstall\(\)/);
});

test('doctor success message does not demand a restart', () => {
  const setupCli = readSource(join('src', 'setup-cli.ts'));
  assert.match(setupCli, /You can now describe your Huawei Cloud task/);
  assert.doesNotMatch(setupCli, /Restart your session, then describe/);
});
