import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import test from 'node:test';

import { fixtureDir } from './fixture-dir.ts';
import type { JscpdBaseline, JscpdConfig, JscpdReport, PackageJson, PackageLock } from './structure-helpers.ts';
import { readJson, readSource, root } from './structure-helpers.ts';

test('sandbox timeout defaults stay single-sourced (no raw numeric fallbacks)', () => {
  // Since the sandbox pack's family split the handlers live in
  // src/packs/sandbox/handlers-*.ts with tools.ts as the re-export face, so
  // the guard scans every TypeScript module in the pack directory —
  // strictly stronger than the old single-file read: no sibling can smuggle
  // a raw numeric fallback (or drop a table-based one) unnoticed.
  const packDir = join(root, 'plugins', 'huaweicloud-core', 'src', 'packs', 'sandbox');
  const family = readdirSync(packDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => readSource(join('src', 'packs', 'sandbox', entry.name)));
  assert.ok(family.length >= 3, 'sandbox pack family modules expected');
  let fallbacks = 0;
  for (const src of family) {
    assert.doesNotMatch(src, /args\.timeout_ms \|\| \d/, 'handler fallbacks must read SANDBOX_TIMEOUT_MS');
    fallbacks += src.match(/args\.timeout_ms \|\| SANDBOX_TIMEOUT_MS\.\w+/g)?.length ?? 0;
  }
  assert.equal(fallbacks, 9, 'nine tool handlers apply the shared defaults');
});

test('agent-registration reports openclaw registration status', () => {
  const registration = readSource(join('src', 'auth', 'agent-registration.ts'));
  assert.match(registration, /function openclawRegistered\(\)/);
  assert.match(registration, /agent === 'openclaw'/);
  assert.match(registration, /'\.agents', 'huaweicloud-plugins', '\.mcp\.json'/);
});

test('node:sqlite is required inside functions, never at module scope', () => {
  // 2026-11-10: the 2.0.0 tarball install printed "(node:xxxx)
  // ExperimentalWarning: SQLite is an experimental feature" on Node 22.x
  // (the CLI's declared floor) because the OfficeAce connector family
  // required node:sqlite at module scope — every CLI boot, install
  // included, paid the warning (and a hard error below Node 22.5) though
  // only the officeace packs/doctor paths ever open the connector db.
  // agent-registration.ts kept the correct shape all along: its require
  // sits inside officeaceRegistered(). This scan pins that shape for every
  // src module — a require of node:sqlite must never start a line at
  // column 0, the textual signature of a module-scope load. The behavioral
  // half of the guard is test/cli-boot-warnings.test.ts spawning the real
  // CLI and asserting its stderr carries no Node warning lines (that half
  // only has teeth on Node 22.x, where the builtin still warns).
  const srcDir = join(root, 'plugins', 'huaweicloud-core', 'src');
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const entryPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(entryPath);
      } else if (entry.name.endsWith('.ts')) {
        for (const [idx, line] of readFileSync(entryPath, 'utf8').split('\n').entries()) {
          if (/^(const|let|var)\b.*\(\s*['"]node:sqlite['"]\s*\)/.test(line)) {
            offenders.push(`${relative(srcDir, entryPath)}:${idx + 1}`);
          }
        }
      }
    }
  };
  walk(srcDir);
  assert.deepEqual(
    offenders,
    [],
    'node:sqlite requires must sit inside functions (lazy), never at module scope',
  );
});

test('test fixtures: raw mkdtempSync is denied by default across the suite', () => {
  // 2026-10-09: TMPDIR=$HOME verification runs leaked 614 unremoved
  // mkdtemp fixture dirs into $HOME (plus a stray node-compile-cache) —
  // invisible on tmpfs /tmp, where reboots hide the leak. Deny-by-default:
  // every test/*.test.ts that still writes mkdtempSync must either route
  // its fixtures through the shared registry (test/fixture-dir.ts:
  // registry-created dirs are removed at process exit, so a partially
  // migrated file fails too) or appear on the per-test-cleaner allowlist
  // below — every entry there removes its own fixtures in finally blocks,
  // verified by the isolated-TMPDIR full-suite residue check. This file is
  // exempt from its own scan: its mkdtempSync occurrences are assertion
  // regexes, never fixture creation. A new fixture-heavy test file either
  // adopts fixtureDir or joins the allowlist with cleanup of its own;
  // nothing passes silently by default.
  const perTestCleaners = new Set([
    'agent-install-agents.test.ts',
    'agent-install-codex.test.ts',
    'agent-install-misc.test.ts',
    'agent-install-native.test.ts',
    'agent-install-opencode.test.ts',
    'auth-agent-registration.test.ts',
    'auth-credentials.test.ts',
    'codearts-adaptation.test.ts',
    'cred-reconcile-e2e.test.ts',
    'cross-platform-install.test.ts',
    'dep-receipts.test.ts',
    'dsh-adaptation.test.ts',
    'hdkitservice-api.test.ts',
    'hook-node.test.ts',
    'issue-443-fix.test.ts',
    'mcp-server-tools.test.ts',
    'officeace-adaptation.test.ts',
    'packs-command.test.ts',
    'plugins-e2e-catalog.test.ts',
    'plugins-e2e.test.ts',
    'proxy-agent.test.ts',
    'reconcile.test.ts',
    'safety-hcloud-args.test.ts',
    'safety-redact.test.ts',
    'safety-secret-gates.test.ts',
    'safety-policy.test.ts',
    'safety-text-command.test.ts',
    'safety-vocabulary.test.ts',
    'setup-packs.test.ts',
    'telemetry.test.ts',
    'uninstall-cleanup.test.ts',
    'update-check.test.ts',
    'upgrade-session.test.ts',
  ]);
  const testDir = join(root, 'test');
  for (const entry of readdirSync(testDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.test.ts')) continue;
    // The guard file itself, plus the one sibling part whose mkdtempSync
    // occurrences are assertion regexes over dep/installers/hcloud.ts source
    // text (never fixture creation) — same exemption class as below.
    if (entry.name === 'structure.test.ts' || entry.name === 'structure-installer-cmds.test.ts') continue;
    const source = readFileSync(join(testDir, entry.name), 'utf8');
    if (!source.includes('mkdtempSync')) continue;
    if (source.includes("from './fixture-dir.ts'")) {
      assert.ok(
        !source.includes('mkdtempSync('),
        `${entry.name} imports the fixtureDir registry but still creates a raw mkdtemp fixture (partial migration)`,
      );
      continue;
    }
    assert.ok(
      perTestCleaners.has(entry.name),
      `${entry.name} creates mkdtemp fixtures without the fixtureDir registry and is not on the per-test-cleaner allowlist; adopt fixtureDir() or clean per-test and join the list`,
    );
  }
});

// jscpd duplication gate. The committed .jscpd-baseline.json fingerprints the
// legacy clones (generated from the v2 tree), so the gate fails only on
// duplication the baseline has never seen — no branch-ref comparison, no
// total-percentage threshold. These guards keep that contract honest: the
// config must restrict formats and ignore the noisy trees (asserted on the
// file AND on the binary's actual behavior — jscpd degrades an unknown
// config key to defaults with one warning line), the pin must be exact
// (ratchet flags are documented only in --help, so version drift silently
// changes gate behavior), and the working tree must stay in sync with the
// baseline.
function jscpdRunner(): string {
  return join(root, 'node_modules', 'jscpd', 'run-jscpd.js');
}

function lintDupRoots(): string[] {
  const pkg = readJson(join(root, 'package.json')) as PackageJson;
  const script = pkg.scripts['lint:dup'] ?? '';
  assert.ok(script.startsWith('jscpd '), 'package.json must define lint:dup as a jscpd invocation');
  return script.split(' ').slice(1);
}

test('jscpd scan config: formats exclude markdown, ignores pinned, no threshold', () => {
  const config = readJson(join(root, '.jscpd.json')) as JscpdConfig;
  assert.deepEqual(config.formats, ['typescript', 'javascript']);
  assert.ok(
    !Object.hasOwn(config, 'threshold'),
    'total-percentage thresholds fail builds on legacy duplication and are the documented top reason teams disable copy/paste gates',
  );
  for (const pattern of ['**/dist/**', '**/*.d.mts', 'test/fixtures/**', 'test/huaweicloud-*/**']) {
    assert.ok(config.ignore.includes(pattern), `.jscpd.json must keep ignore pattern ${pattern}`);
  }
  assert.ok(config.reporters.includes('console'), 'local lint:dup runs need the console reporter');
});

test('jscpd devDependency is exact-pinned and lint:dup roots exclude the skills trees', () => {
  const pkg = readJson(join(root, 'package.json')) as PackageJson;
  assert.match(
    pkg.devDependencies.jscpd ?? '',
    /^\d+\.\d+\.\d+$/,
    'jscpd must be exact-pinned (no ^ or ~): the baseline ratchet flags are documented only in --help, version drift changes gate behavior',
  );
  const script = pkg.scripts['lint:dup'] ?? '';
  assert.doesNotMatch(
    script,
    /skills/,
    'the script must not mention a skills path at all (a root would scan a skills tree, an ignore glob would silently mask one); the src/packs/*/skills/ markdown sources live inside the scanned src root and are excluded only by the formats restriction (pinned by the config and behavioral tests in this suite)',
  );
  assert.ok(
    script.includes('eslint.config.mjs'),
    'eslint.config.mjs is hand-written JavaScript and belongs in the scan roots',
  );
});

test('jscpd binary honors the config: ts twins clone, markdown stays excluded', () => {
  const runner = jscpdRunner();
  assert.ok(existsSync(runner), 'jscpd is not installed; run npm install');
  const dir = fixtureDir('jscpd-config-honored-');
  const tsTwin = [
    'export function formatLabelParts(input: string): string {',
    '  const trimmed = input.trim();',
    '  const lowered = trimmed.toLowerCase();',
    '  const parts = lowered.split(/[,\\s]+/).filter((part) => part.length > 0);',
    '  const unique = [...new Set(parts)];',
    '  const joined = unique.join("-");',
    '  const wrapped = `[${joined}]`;',
    '  return wrapped;',
    '}',
    '',
  ].join('\n');
  const mdTwin = [
    '# Twin Document',
    '',
    ...Array.from({ length: 12 }, (_, i) => `Shared planning note line ${i + 1} kept identical across both files.`),
    '',
  ].join('\n');
  writeFileSync(join(dir, 'ts-twin-a.ts'), tsTwin);
  writeFileSync(join(dir, 'ts-twin-b.ts'), tsTwin);
  // The markdown twins exist to be missed: if formats ever degrade (typo'd
  // config key, jscpd upgrade renaming one), markdown enters the scan and
  // this pair becomes a clone the assertion below rejects.
  writeFileSync(join(dir, 'md-twin-a.md'), mdTwin);
  writeFileSync(join(dir, 'md-twin-b.md'), mdTwin);
  const outDir = join(dir, 'out');
  const run = spawnSync(process.execPath, [runner, dir, '--reporters', 'json', '--output', outDir, '--no-colors'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 60_000,
  });
  assert.equal(run.status, 0, `jscpd fixture scan failed: ${run.stdout}\n${run.stderr}`);
  const report = JSON.parse(readFileSync(join(outDir, 'jscpd-report.json'), 'utf8')) as JscpdReport;
  assert.equal(
    report.duplicates.length,
    1,
    `expected exactly the ts twin pair, got: ${report.duplicates.map((dup) => `${dup.format}:${dup.firstFile.name}`).join(', ')}`,
  );
  assert.equal(report.duplicates[0]?.format, 'typescript');
  assert.match(report.duplicates[0]?.firstFile.name ?? '', /^ts-twin-/);
  assert.match(report.duplicates[0]?.secondFile.name ?? '', /^ts-twin-/);
});

test('jscpd baseline is in sync: zero new clones against the committed fingerprints', () => {
  const runner = jscpdRunner();
  assert.ok(existsSync(runner), 'jscpd is not installed; run npm install');
  const baselinePath = join(root, '.jscpd-baseline.json');
  assert.ok(existsSync(baselinePath), '.jscpd-baseline.json must be committed with the gate');
  const baseline = readJson(baselinePath) as JscpdBaseline;
  assert.equal(typeof baseline.version, 'number');
  assert.ok(
    Object.keys(baseline.fingerprints).length > 0,
    'baseline fingerprints must be non-empty (regenerate with --update-baseline)',
  );
  const run = spawnSync(
    process.execPath,
    [
      runner,
      ...lintDupRoots(),
      '--reporters',
      'silent',
      '--baseline',
      '.jscpd-baseline.json',
      '--fail-on-new-clones',
      '0',
      '--fail-on-empty',
      '--no-colors',
    ],
    { cwd: root, encoding: 'utf8', timeout: 120_000 },
  );
  assert.equal(
    run.status,
    0,
    `new duplication (or a broken gate config) detected:\n${run.stdout}\n${run.stderr}\n` +
      'run `npm run lint:dup -- --baseline .jscpd-baseline.json --fail-on-new-clones 0` for the clone list; ' +
      'if the new duplication is intentional (moved-not-deleted, edits inside a baselined region, or deliberate ' +
      'test repetition), run `npm run format` first (fingerprints are whitespace-sensitive), then regenerate with ' +
      '`npm run lint:dup -- --baseline .jscpd-baseline.json --update-baseline` and commit the file',
  );
});

test('package-lock.json fetch origins are registry.npmjs.org only', () => {
  // A developer-local npm registry (e.g. the Huawei mirror the README
  // suggests) leaks into committed lockfiles: installs record the mirror's
  // URLs in `resolved`, and every CI `npm ci` then fetches from whatever
  // the lockfile names — silently, with nothing red. The jscpd install
  // captured 9 mirror URLs that way; this guard turns any re-capture into
  // a failing test instead of a latent third-party fetch dependency.
  const lock = readJson(join(root, 'package-lock.json')) as PackageLock;
  const resolved: Array<{ path: string; url: string }> = [];
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (typeof entry.resolved === 'string') resolved.push({ path, url: entry.resolved });
  }
  assert.ok(resolved.length > 0, 'package-lock.json must record resolved URLs');
  for (const { path, url } of resolved) {
    assert.match(
      url,
      /^https:\/\/registry\.npmjs\.org\//,
      `${path} resolves from ${url} — a mirror-configured npm captured its own origin into the lockfile; ` +
        're-resolve with `npm install --package-lock-only --registry=https://registry.npmjs.org/ <pkg>` and commit',
    );
  }
});

test('no conflict-marker residue survives in tracked text files (prettier-laundered forms included)', () => {
  // A rebase resolution once left a `>>>>>>> <hash>` marker in docs/CHANGELOG.md;
  // the subsequent format pass rewrote it into a 7-deep nested blockquote
  // ("> > > > > > > <hash>"), so markdownlint, format:check, and every bare
  // `grep '<<<<<<<'` sweep went blind on it. This guard scans all tracked
  // text files for BOTH shapes: raw git markers and the formatter-normalized
  // blockquote spelling (stacked quote markers followed by a commit-hash-
  // shaped token — legitimate prose never stacks 3+ nested quotes).
  const tracked = spawnSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' })
    .stdout!.split('\n')
    .filter(Boolean)
    .filter((f) => /\.(ts|mjs|cjs|js|json|md|py|yml|yaml|sh|txt)$/.test(f));
  const rawMarker = /^(<{7}|={7}|>{7})( |$)/;
  const launderedMarker = /^(?:>\s?){3,}[0-9a-f]{7,}(\s|$)/;
  const offenders: string[] = [];
  for (const file of tracked) {
    const path = join(root, file);
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      if (rawMarker.test(line) || launderedMarker.test(line)) {
        offenders.push(`${file}: ${line.slice(0, 60)}`);
        break;
      }
    }
  }
  assert.deepEqual(offenders, [], 'conflict-marker residue found');
});
