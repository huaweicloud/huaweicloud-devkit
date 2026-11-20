import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import type { HooksConfig, McpConfig, PackageJson } from './structure-helpers.ts';
import { pluginRoot, readJson, readSource, root } from './structure-helpers.ts';

test('skill-tracker carries the V1/V2 dual export (#758 follow-up)', () => {
  const tracker = readFileSync(join(root, 'integrations', 'opencode', 'hooks', 'skill-tracker.js'), 'utf8');
  // OpenCode 2.x reads id + setup(ctx) and registers hooks on the context
  // domains; V1 reads server(). One default object serves both loaders.
  assert.match(tracker, /async function setupV2\(ctx\)/);
  assert.match(tracker, /ctx\.tool\.hook\('execute\.before'/);
  assert.match(tracker, /async server\(\)/);
  assert.match(tracker, /Plugin\.define\(/);
  // The lazy define keeps a V1 host without @opencode/plugin loadable.
  assert.match(tracker, /let Plugin = \{ define: \(def\) => def \};/);
  // Doctrine (guarded above): setupV2 registers ONLY the bash classifier —
  // no ctx.event.subscribe skill-read channel.
  assert.match(tracker, /event\?\.tool !== 'bash'/);
  assert.match(tracker, /trackBashCommand\(/);
  assert.doesNotMatch(tracker, /ctx\.event\.subscribe/);
});

test('telemetry hooks never classify skill-tool loads', () => {
  // Doctrine guard: the telemetry hooks shed skill-load classification
  // deliberately (native loads produce no telemetry by design, and the
  // huawei* prefix match misattributes user skills). Two review rounds
  // caught drift in this family one file at a time; this sweep pins every
  // hook-events.jsonl emitter together — the five platform hooks plus the
  // plugin-dir safety hook — and the opencode shell deny adapter
  // (safety-gate.js, a non-emitter bound by the same server-data doctrine:
  // it classifies shell text only), so a bad merge cannot quietly re-add
  // the branch anywhere.
  const integrations = join(root, 'integrations');
  const hookFiles = [
    join(integrations, 'opencode', 'hooks', 'skill-tracker.js'),
    join(integrations, 'opencode', 'hooks', 'safety-gate.js'),
    join(integrations, 'workbuddy', 'hooks', 'telemetry-tracker.py'),
    join(integrations, 'hermes', 'hooks', 'huaweicloud-telemetry.py'),
    join(integrations, 'atomcode', 'hooks', 'huaweicloud-telemetry.js'),
    join(integrations, 'dsh', 'hook-plugin.mjs'),
    join(pluginRoot, 'hooks', 'huaweicloud-safety.py'),
  ];
  for (const file of hookFiles) {
    assert.ok(existsSync(file), `hook file ${file} must exist`);
    const body = readFileSync(file, 'utf8');
    assert.doesNotMatch(
      body,
      /skill:retrieve|isHuaweiCloudSkill|extractSkillName/,
      `${file} must not classify skill-tool loads (server data doctrine)`,
    );
  }
});

// The five telemetry hooks are deliberately self-contained single files —
// each agent dir ships exactly one hook file, so a shared import has no
// deployment path and the classification surface lives five times. What
// must not drift is the shared semantics: the read/write verb lists, the
// hcloud capture bounds per documented family, the telemetry opt-out gate,
// and the 3-token value trim. This guard pins those in lockstep: a verb
// added to one hook and not the others fails here instead of silently
// misclassifying writes on one platform.

test('telemetry hooks keep the shared classification surface in lockstep', () => {
  const integrations = join(root, 'integrations');
  const readHook = (...rel: string[]): string => readFileSync(join(integrations, ...rel), 'utf8');
  const jsHooks: Array<[string, string]> = [
    ['opencode', readHook('opencode', 'hooks', 'skill-tracker.js')],
    ['dsh', readHook('dsh', 'hook-plugin.mjs')],
    ['atomcode', readHook('atomcode', 'hooks', 'huaweicloud-telemetry.js')],
  ];
  const pyHooks: Array<[string, string]> = [
    ['workbuddy', readHook('workbuddy', 'hooks', 'telemetry-tracker.py')],
    ['hermes', readHook('hermes', 'hooks', 'huaweicloud-telemetry.py')],
  ];
  const allHooks = [...jsHooks, ...pyHooks];

  // The READ/WRITE verb alternation, extracted across the three source
  // forms (JS regex literal, JS new RegExp concat, Python re.compile
  // concat) and normalized to the bare verb list.
  const verbList = (hookName: string, source: string, kind: 'READ_VERBS' | 'WRITE_VERBS'): string[] => {
    const literal = source.match(new RegExp(`${kind}\\s*=\\s*/(.*)/i`));
    let pattern = literal?.[1];
    if (pattern === undefined) {
      const decl = source.match(
        new RegExp(`${kind} = (?:new RegExp\\(|re\\.compile\\()([\\s\\S]*?)(?:,\\s*'i'|, re\\.IGNORECASE)`),
      );
      assert.ok(decl, `${hookName}: ${kind} declaration not found`);
      pattern = (decl[1]!.match(/'([^']*)'/g) ?? []).map((s) => s.slice(1, -1)).join('');
    }
    assert.ok(pattern, `${hookName}: ${kind} pattern not extracted`);
    return pattern
      .replace(/\\+b/g, '')
      .replace(/[()]/g, '')
      .replace(/\\+w\*/g, '')
      .split('|')
      .map((v) => v.trim())
      .filter((v) => v.length > 0);
  };

  const referenceRead = verbList('opencode', jsHooks[0]![1], 'READ_VERBS');
  const referenceWrite = verbList('opencode', jsHooks[0]![1], 'WRITE_VERBS');
  assert.ok(referenceRead.length >= 5, 'read verb list extracted');
  assert.ok(referenceWrite.length >= 30, 'write verb list extracted');
  for (const [hookName, source] of allHooks) {
    assert.deepEqual(
      verbList(hookName, source, 'READ_VERBS'),
      referenceRead,
      `${hookName} READ_VERBS drifted from the shared list`,
    );
    assert.deepEqual(
      verbList(hookName, source, 'WRITE_VERBS'),
      referenceWrite,
      `${hookName} WRITE_VERBS drifted from the shared list`,
    );
    // The opt-out gate, polarity pinned: the JS hooks skip the spool on
    // === 'off', the Python hooks on os.environ.get(...) == "off" — a hook
    // that inverted the comparison (spooling only when the user opted OUT)
    // must fail here, not pass on a polarity-agnostic substring.
    const jsOptOut = source.match(/HUAWEICLOUD_DEVKIT_TELEMETRY === 'off'/);
    const pyOptOut = source.match(/HUAWEICLOUD_DEVKIT_TELEMETRY"\) == "off"/);
    assert.ok(
      jsOptOut || pyOptOut,
      `${hookName} must gate the local spool on the telemetry opt-out (skip-when-off only)`,
    );
  }

  // The capture shapes: the bounded 4-token capture and the unbounded tail
  // are the two known-good shapes. The guard pins family structure — every
  // hook's HCLOUD_RE is one of the two shapes, at most two distinct shapes
  // exist, and the deliberately-synced opencode+dsh pair stays identical —
  // but deliberately NOT the direction: converging the unbounded family to
  // the bounded capture is a privacy improvement this guard must allow
  // (updating this test's family table is the only change it should need).
  const hcloudPattern = (hookName: string, source: string): string => {
    const js = source.match(/HCLOUD_RE\s*=\s*\/(.*)\/i/);
    if (js) return js[1]!;
    const py = source.match(/HCLOUD_RE\s*=\s*re\.compile\(\s*r'(.*)'/);
    assert.ok(py, `${hookName}: HCLOUD_RE declaration not found`);
    return py[1]!;
  };
  const BOUNDED_CAPTURE = String.raw`(?:^|[;&|]\s*)hcloud(?:\.exe)?\s+([^\s;&|"<>]+(?:\s+[^\s;&|"<>]+){0,3})`;
  const UNBOUNDED_CAPTURE = String.raw`(?:^|[;&|]\s*)hcloud(?:\.exe)?\s+(.+)`;
  for (const [hookName, source] of allHooks) {
    const pattern = hcloudPattern(hookName, source);
    assert.ok(
      pattern === BOUNDED_CAPTURE || pattern === UNBOUNDED_CAPTURE,
      `${hookName}: HCLOUD_RE is neither of the two known capture shapes (bounded 4-token or unbounded tail)`,
    );
  }
  const distinct = new Set(allHooks.map(([name, source]) => hcloudPattern(name, source)));
  assert.ok(distinct.size <= 2, 'at most two capture families exist; a third shape means drift');
  assert.equal(
    hcloudPattern('dsh', jsHooks[1]![1]),
    hcloudPattern('opencode', jsHooks[0]![1]),
    'the deliberately-synced opencode+dsh capture pair drifted apart',
  );

  // The 3-token value trim: every hook's spool path bounds cli:* values to
  // the Service+Operation prefix — exactly three tokens, pinned in both
  // languages.
  for (const [hookName, source] of allHooks) {
    const jsTrim = source.match(/value\.split\([^)]*\)\.slice\(0, 3\)/);
    const pyTrim = source.match(/value\.split\(\)\[:3\]/);
    assert.ok(jsTrim || pyTrim, `${hookName} must trim cli:* values to exactly the 3-token command prefix`);
  }
});

test('stdio server warms update cache; shared protocol decorates first tool call', () => {
  const server = readSource(join('src', 'mcp-server.ts'));
  assert.match(server, /getCachedUpdateInfo\(readInstalledVersion\(\)/);
  const protocol = readSource(join('src', 'mcp-protocol.ts'));
  assert.match(protocol, /applyUpdateHint\(/);
  assert.match(protocol, /peekCachedUpdateInfo\(\)/);
});

test('hdkitservice-api sends X-HW-Client-Version; SKILL session-start wording', () => {
  const api = readSource(join('src', 'lib', 'hdkit', 'hdkitservice-api.ts'));
  assert.match(api, /X-HW-Client-Version/);
  assert.match(api, /readInstalledVersion\(\)/);
  const skill = readFileSync(join(pluginRoot, 'skills', 'huaweicloud-core', 'SKILL.md'), 'utf8');
  assert.match(skill, /先调用 `huaweicloud_check_update` 检查插件版本/);
  assert.match(skill, /若未先行检查，插件会在使用中收到服务端升级提示/);
});

test('READMEs recommend @latest for updates', () => {
  const en = readFileSync(join(root, 'README.md'), 'utf8');
  assert.match(en, /huaweicloud-devkit@latest update --target all/);
  const zh = readFileSync(join(root, 'README.zh-CN.md'), 'utf8');
  assert.match(zh, /huaweicloud-devkit@latest update --target all/);
});

test('shipped runtime entry points point at built dist JavaScript', () => {
  const pkg = readJson(join(root, 'package.json')) as PackageJson;
  for (const [name, target] of Object.entries(pkg.bin ?? {})) {
    assert.doesNotMatch(target, /\.ts$/, `bin ${name} must not point at a TypeScript file`);
    assert.ok(!target.includes('/src/'), `bin ${name} must not reference src/`);
  }

  const mcp = readJson(join(pluginRoot, '.mcp.json')) as McpConfig;
  for (const server of Object.values(mcp.mcpServers ?? {})) {
    for (const arg of server.args ?? []) {
      assert.doesNotMatch(arg, /\.ts$/, `.mcp.json arg ${arg} must not point at a TypeScript file`);
      assert.ok(!arg.includes('/src/') && !arg.startsWith('./src/'), `.mcp.json arg ${arg} must not reference src/`);
    }
  }

  const hooks = readJson(join(pluginRoot, 'hooks', 'hooks.json')) as HooksConfig;
  for (const entries of Object.values(hooks.hooks ?? {})) {
    for (const entry of entries) {
      for (const hook of entry.hooks ?? []) {
        assert.doesNotMatch(hook.command ?? '', /\.ts\b/, `hook must not run TypeScript: ${hook.command}`);
      }
    }
  }

  const hookWrapper = readFileSync(join(pluginRoot, 'hooks', 'huaweicloud-safety.mjs'), 'utf8');
  assert.match(hookWrapper, /dist\/safety-policy\.js/, 'hook wrapper must prefer the built dist module');
  assert.doesNotMatch(hookWrapper, /from '\.\.\/src\//, 'hook wrapper must not statically import src');

  // A raw git or marketplace copy of the plugin has no dist; the wrapper must
  // still run the safety gate from the TypeScript source in that layout.
  const hookFallback = /existsSync\([^)]*dist[^)]*safety-policy\.js[\s\S]*import\('\.\.\/src\/safety-policy\.ts'\)/;
  assert.match(hookWrapper, hookFallback, 'hook wrapper needs a src fallback for unbuilt copies');

  const cordis = readFileSync(join(root, 'cordis.patch.yml'), 'utf8');
  assert.doesNotMatch(cordis, /\.ts\b/, 'cordis.patch.yml must not reference TypeScript files');
  assert.doesNotMatch(cordis, /plugins\/huaweicloud-core\/src\//, 'cordis.patch.yml must not reference src/');

  const hermesManifest = readFileSync(join(root, 'integrations', 'hermes', 'manifest.yaml'), 'utf8');
  assert.doesNotMatch(hermesManifest, /plugins\/huaweicloud-core\/src\//, 'hermes manifest must not reference src/');

  const setupCli = readSource(join('src', 'setup-cli.ts'));
  assert.doesNotMatch(
    setupCli,
    /'src', 'mcp-server\.js'/,
    'setup-cli must not point at a src mcp-server.js (built output lives in dist)',
  );
  assert.doesNotMatch(setupCli, /join\(PLUGIN_ROOT, 'src'\)/, 'setup-cli must copy dist, not src');
});

test('plugin src tree is TypeScript only', () => {
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)],
    );
  const scripts = walk(join(pluginRoot, 'src')).filter((file) => /\.(mjs|cjs|js)$/.test(file));
  assert.deepEqual(
    scripts,
    [],
    `src must hold only TypeScript scripts plus data assets; found JavaScript: ${scripts.join(', ')}`,
  );
});
