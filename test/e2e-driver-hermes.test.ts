import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  hermesDriver,
  hermesOwnerRoot,
  rewriteFactsPaths,
  rewriteHermesMcpArgs,
  templateHermesInstalls,
} from './e2e/drivers/hermes.ts';
import type { DriverContext } from './e2e/drivers/types.ts';
import { fixtureDir } from './fixture-dir.ts';

// The hermes driver's config surgery and borrowed-launch template, pinned
// without the LLM: the mcp_servers args must move to the loader form with
// the DEVKIT_PACKS posture line preserved, the providers: map (not the
// legacy custom_providers list) must carry the model config, and the
// installs template must exclude lock files and rewrite facts.json paths —
// an unrewritten fact reads as stale and the next -z falls into the
// network-bound uv sync the template exists to skip.

const ENV_KEYS = ['E2E_PROVIDER_ID', 'E2E_PROVIDER_BASEURL', 'E2E_MODEL', 'E2E_APIKEY', 'E2E_TEST_API_KEY'] as const;

function withModelEnv<T>(fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  const merged: Record<string, string> = {
    E2E_PROVIDER_ID: 'opengw',
    E2E_PROVIDER_BASEURL: 'https://example.invalid/v1',
    E2E_MODEL: 'glm-5.2',
    E2E_APIKEY: 'test-key',
  };
  for (const [key, value] of Object.entries(merged)) process.env[key] = value;
  delete process.env.E2E_TEST_API_KEY;
  try {
    return fn();
  } finally {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

// The installer-shaped config.yaml a real `install --target hermes` writes
// (writeHermesMcpConfig + ensureHermesHooksConfig spike ground truth),
// optionally carrying the DEVKIT_PACKS posture line installPacks adds.
function fakeHermesHome(packs?: string): { home: string; serverJs: string; configPath: string } {
  const home = fixtureDir('hwc-e2e-hermes-driver-');
  const serverJs = join(home, '.hermes', 'huaweicloud-plugins', 'dist', 'mcp-server.js');
  mkdirSync(join(serverJs, '..'), { recursive: true });
  writeFileSync(serverJs, '// fake server for the surgery test\n', 'utf8');
  const block = [
    'mcp_servers:',
    '  huaweicloud-devkit:',
    '    command: "node"',
    `    args: ["${serverJs.replaceAll('\\', '/')}"]`,
    '    env:',
    '      HUAWEICLOUD_AGENT_TOOLKIT_MODE: "local"',
    ...(packs ? [`      DEVKIT_PACKS: "${packs}"`] : []),
    'hooks:',
    '  pre_tool_call:',
    '    - matcher: "terminal"',
    `      command: "python3 ${join(home, '.hermes', 'huaweicloud-plugins', 'hooks', 'huaweicloud-safety.py').replaceAll('\\', '/')}"`,
    '      timeout: 5',
    '      fail_closed: true',
    '',
  ].join('\n');
  const configPath = join(home, '.hermes', 'config.yaml');
  writeFileSync(configPath, block, 'utf8');
  return { home, serverJs, configPath };
}

// The prepare-path test exercises the machine-scoped owner install (the
// committed dependency state the e2e-nightly hermes leg's pinned install
// step — or a dev machine with hermes — provides). Where that state is
// absent the test would only measure templateHermesInstalls' own refusal,
// so it skips with the real venues named. Install-state-keyed on purpose,
// never the real-agents ciSkip env-demand clause: the owner tree IS the
// precondition under test, and the nightly guard step (which runs right
// after the pinned install) is where the skip must stay silent.
function hermesOwnerInstallSkip(): string | false {
  const installsRoot = join(homedir(), '.hermes', 'installs');
  let keys: string[];
  try {
    keys = readdirSync(installsRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    keys = [];
  }
  if (keys.length !== 1) {
    return (
      `no single hermes install key under ${installsRoot} (found: ${keys.join(', ') || '(none)'}) — ` +
      'this guard runs where the pinned hermes CLI is installed: the e2e-nightly hermes leg ' +
      '(dispatch-only until the nightly cron is registered on main) or a dev machine with hermes'
    );
  }
  return false;
}

// os.homedir honors $HOME on posix and USERPROFILE on win32 — fake both so
// the owner root reaches the production resolver on every platform (the
// Windows CI failure named the real runner profile through the gap).
function withFakeOwnerHome<T>(owner: string, fn: () => T): T {
  const savedHome = process.env.HOME;
  const savedProfile = process.env.USERPROFILE;
  process.env.HOME = owner;
  process.env.USERPROFILE = owner;
  try {
    return fn();
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedProfile;
  }
}

test(
  'hermes prepare rewrites mcp_servers args to the loader form and appends the providers map',
  { skip: hermesOwnerInstallSkip() },
  () => {
    const { home, configPath } = fakeHermesHome();
    const ctx: DriverContext = { home, workdir: home, platform: process.platform };
    withModelEnv(() => hermesDriver.prepare(ctx));
    const content = readFileSync(configPath, 'utf8');
    // The loader sits in front of the server in the args array, the command
    // is the absolute node binary (hermes filters MCP child env, so PATH
    // resolution cannot be trusted there — the codex precedent).
    assert.ok(
      content.includes(`args: ["${join(home, 'mcp-env-loader.mjs').replaceAll('\\', '/')}", `),
      'args must lead with the loader',
    );
    assert.ok(
      content.includes(`command: ${JSON.stringify(process.execPath)}`),
      'command must be the absolute node binary',
    );
    assert.ok(!content.includes('command: "node"'), 'the bare node command must be gone');
    // The model config rides the providers: map with key_env E2E_APIKEY —
    // the legacy custom_providers list does not resolve on v0.22.5.
    assert.ok(
      content.includes('model:\n  provider: "e2e-hermes"'),
      'model.provider must select the e2e-hermes provider',
    );
    assert.ok(
      content.includes('providers:\n  e2e-hermes:\n    base_url: "https://example.invalid/v1"'),
      'the providers map must carry the base URL',
    );
    assert.ok(content.includes('key_env: "E2E_APIKEY"'), 'key_env must name E2E_APIKEY');
    assert.ok(content.includes('api_mode: "chat_completions"'), 'api_mode must pin the chat wire');
    assert.ok(!content.includes('custom_providers'), 'the legacy provider list must not appear');
    // Eager tool listing: progressive disclosure would hide the devkit tools
    // behind tool_search bridges the cases' prompts do not model.
    assert.ok(content.includes('tools:\n  tool_search:\n    enabled: "off"'), 'tool_search must be off');
    // The loader script itself is the shared source.
    assert.ok(existsSync(join(home, 'mcp-env-loader.mjs')), 'prepare must write the env loader');
    assert.ok(
      readFileSync(join(home, 'mcp-env-loader.mjs'), 'utf8').includes('mcp-env.json'),
      'the loader must read mcp-env.json',
    );
    // The installer's hooks block survives the surgery untouched.
    assert.ok(content.includes('fail_closed: true'), 'the installer hooks block must survive');
  },
);

test('hermes surgery preserves the DEVKIT_PACKS posture line from install --packs', () => {
  const { home, configPath } = fakeHermesHome('voucher');
  withModelEnv(() => rewriteHermesMcpArgs(home));
  const content = readFileSync(configPath, 'utf8');
  assert.ok(content.includes('DEVKIT_PACKS: "voucher"'), 'the posture line must survive the args rewrite');
  // The surgery is a once-per-attempt operation over the installer-shaped
  // config (fresh home per attempt, the codex contract): a second pass must
  // refuse loudly rather than run beside its own loader form.
  assert.throws(() => rewriteHermesMcpArgs(home), /installer output drift/);
});

test('hermes surgery fails loud on installer-output drift', () => {
  const { home, configPath } = fakeHermesHome();
  // Simulate writeHermesMcpConfig changing its args rendering: the surgery
  // must refuse instead of running beside an uninstrumented server.
  writeFileSync(
    configPath,
    readFileSync(configPath, 'utf8').replace(/^ {4}args: \[.*\]\n/m, '    args: [rendered-differently]\n'),
    'utf8',
  );
  assert.throws(() => rewriteHermesMcpArgs(home), /installer output drift/);
});

test('hermes template copies the owner installs minus locks and rewrites facts paths', () => {
  const owner = fixtureDir('hwc-e2e-hermes-owner-');
  const key = '63c6cdbedcde73a9';
  const ownerInstalls = join(owner, '.hermes', 'installs', key);
  mkdirSync(join(ownerInstalls, 'environments', 'abc', 'venv'), { recursive: true });
  mkdirSync(join(ownerInstalls, 'pm-runtime'), { recursive: true });
  writeFileSync(
    join(ownerInstalls, 'environments', 'abc', 'venv', 'pyvenv.cfg'),
    'home = /tools/python\nrelocatable = true\n',
    'utf8',
  );
  writeFileSync(join(ownerInstalls, '.install.lock'), 'stale', 'utf8');
  writeFileSync(join(ownerInstalls, 'pm-runtime', '.prepare.lock'), 'stale', 'utf8');
  const facts = {
    packages: {
      venv: {
        environment: join(ownerInstalls, 'environments', 'abc', 'venv'),
        resolved_lock: join(ownerInstalls, 'environments', 'abc', 'workspace', 'uv.lock'),
        extras: ['all'],
        stamp: 'deadbeef',
      },
    },
    schema: 1,
  };
  writeFileSync(join(ownerInstalls, 'facts.json'), JSON.stringify(facts, null, 2), 'utf8');

  const borrower = fixtureDir('hwc-e2e-hermes-borrower-');
  withFakeOwnerHome(owner, () => templateHermesInstalls(borrower));

  const copiedFactsPath = join(borrower, '.hermes', 'installs', key, 'facts.json');
  const copiedFacts = JSON.parse(readFileSync(copiedFactsPath, 'utf8')) as {
    packages: { venv: { environment: string } };
  };
  assert.ok(
    copiedFacts.packages.venv.environment.startsWith(join(borrower, '.hermes')),
    'facts.json paths must point into the borrower root (venv_is_current resolves the copy)',
  );
  assert.ok(
    !readFileSync(copiedFactsPath, 'utf8').includes(owner),
    'no owner path may survive in facts.json (an owner path reads as stale and triggers the network sync)',
  );
  assert.ok(!existsSync(join(borrower, '.hermes', 'installs', key, '.install.lock')), 'lock files must not template');
  assert.ok(
    !existsSync(join(borrower, '.hermes', 'installs', key, 'pm-runtime', '.prepare.lock')),
    'runtime locks must not template',
  );
  assert.ok(
    existsSync(join(borrower, '.hermes', 'installs', key, 'environments', 'abc', 'venv', 'pyvenv.cfg')),
    'the venv must template',
  );
});

test('rewriteFactsPaths rewrites both platform path spellings', () => {
  // The Windows CI catch: a raw text replaceAll over facts.json never
  // matches there, because JSON serialization escapes every backslash in
  // the file while the in-memory roots carry single ones. The rewrite is
  // JSON-semantic, so both spellings must come out rewritten — pinned
  // here on Linux because the pure function needs no platform to prove
  // it.
  const posixFacts = JSON.stringify(
    { packages: { venv: { environment: '/owner/.hermes/installs/k/venv', stamp: 'deadbeef' } }, schema: 1 },
    null,
    2,
  );
  const posixOut = rewriteFactsPaths(posixFacts, '/owner/.hermes', '/borrower/.hermes');
  assert.equal(
    JSON.parse(posixOut).packages.venv.environment,
    '/borrower/.hermes/installs/k/venv',
    'posix-shaped paths must rewrite',
  );
  const winOwner = 'C:\\Users\\dev\\.hermes';
  const winBorrower = 'D:\\run\\.hermes';
  const winFacts = JSON.stringify(
    {
      packages: {
        venv: {
          environment: `${winOwner}\\installs\\k\\environments\\abc\\venv`,
          resolved_lock: `${winOwner}\\installs\\k\\environments\\abc\\workspace\\uv.lock`,
          extras: ['all'],
        },
      },
      schema: 1,
    },
    null,
    2,
  );
  const winOut = rewriteFactsPaths(winFacts, winOwner, winBorrower);
  const parsed = JSON.parse(winOut) as { packages: { venv: { environment: string; resolved_lock: string } } };
  assert.equal(
    parsed.packages.venv.environment,
    `${winBorrower}\\installs\\k\\environments\\abc\\venv`,
    'backslash-shaped paths must rewrite through the JSON escaping (the Windows CI failure)',
  );
  assert.equal(
    parsed.packages.venv.resolved_lock,
    `${winBorrower}\\installs\\k\\environments\\abc\\workspace\\uv.lock`,
  );
  assert.ok(
    !winOut.includes(winOwner),
    'no owner root may survive (the exact predicate the template test pins on posix)',
  );
});

test('hermes driver surface: id, wire, installPacks support', () => {
  assert.equal(hermesDriver.id, 'hermes');
  assert.equal(hermesDriver.installTarget, 'hermes');
  assert.equal(hermesDriver.modelWire, 'chat');
  assert.equal(hermesDriver.supportsInstallPacks, true);
  // The owner-root helper is the template source the probe names in its
  // refusal detail — it must resolve under $HOME, never the throwaway.
  assert.ok(hermesOwnerRoot().endsWith(join('.hermes')));
});
