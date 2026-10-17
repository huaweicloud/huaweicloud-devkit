import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import test from 'node:test';

// The post-install `packs` command family through the real installer
// (bin/setup.cjs): status mirrors doctor's pack block, enable/disable do set
// math on the stored DEVKIT_PACKS seed (the one write path allowed to
// overwrite a user-set value — install refuses, per the keptUserValue
// contract), `all` is the reset hatch, and argument validation fails with
// zero writes.

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');

const root = fileURLToPath(new URL('..', import.meta.url));
const setupCli = join(root, 'bin', 'setup.cjs');

function makeEnv(home: string) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    USERPROFILE: home,
    HOME: home,
    HOMEDRIVE: home.slice(0, 2),
    HOMEPATH: home.slice(2),
    HERMES_HOME: join(home, '.hermes'),
    DSH_HOME: join(home, '.dsh'),
    // Fail the installer's own update check instantly against a closed port.
    HUAWEICLOUD_NPM_REGISTRY: 'http://127.0.0.1:9',
    // OfficeAce detection probes the real Windows registry / Program Files,
    // which would leak a real install into these fake-HOME tests (#654).
    HUAWEICLOUD_DEVKIT_SKIP_OFFICEACE_DETECT: '1',
  };
  // Clear agent home overrides so installs land in the temp home, not the real one.
  // XDG_CONFIG_HOME redirects the opencode config root (xdgConfigHome);
  // CODEX_HOME keys the uninstaller's codex cache cleanup.
  // HW_VAULT_MASTER_KEY becomes an INVALID sentinel rather than being
  // deleted: the custody order is env → OS keychain → keyfile, so a bare
  // delete would let a real keychain-tier entry (macOS Keychain / Secret
  // Service — machine state HOME-faking cannot isolate) flip the INFO
  // announcement to a WARN. An invalid value throws in the env tier BEFORE
  // any keychain probe, and the note's try/catch reads that as
  // not-initialized — deterministic on every platform. The vault-carrying
  // test variant overrides the sentinel with a valid key.
  for (const key of [
    'ATOMCODE_HOME',
    'HUAWEICLOUD_HOME',
    'OFFICE_CLAW_CONFIG_ROOT',
    'DEVKIT_PACKS',
    'XDG_CONFIG_HOME',
    'CODEX_HOME',
  ]) {
    delete env[key];
  }
  env.HW_VAULT_MASTER_KEY = 'not-a-valid-master-key-sentinel';
  return env;
}

function runCli(home: string, args: string[]) {
  return spawnSync(process.execPath, [setupCli, ...args], {
    cwd: root,
    env: makeEnv(home),
    encoding: 'utf8',
    timeout: 240000,
  });
}

function opencodeConfigPath(home: string) {
  return join(home, '.config', 'opencode', 'opencode.json');
}

interface OpencodeMcpEntry {
  command: string[];
  type: string;
  environment?: Record<string, string>;
}

function readEntry(home: string): OpencodeMcpEntry {
  const cfg = JSON.parse(readFileSync(opencodeConfigPath(home), 'utf8')) as {
    mcp: Record<string, OpencodeMcpEntry>;
  };
  return cfg.mcp['huaweicloud-devkit'];
}

function readPacks(home: string) {
  return readEntry(home).environment?.DEVKIT_PACKS;
}

// Overwrite the OpenCode entry's DEVKIT_PACKS the way an operator would have
// typed it — the state install refuses to change (keptUserValue) and the
// packs command owns.
function seedUserPacks(home: string, value: string) {
  const cfgPath = opencodeConfigPath(home);
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as { mcp: Record<string, OpencodeMcpEntry> };
  const entry = cfg.mcp['huaweicloud-devkit'];
  entry.environment = { ...(entry.environment ?? {}), DEVKIT_PACKS: value };
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
}

test('bare packs prints usage to stderr and exits non-zero', () => {
  const home = mkdtempSync(join(tmpdir(), 'devkit-packs-bare-'));
  try {
    const res = runCli(home, ['packs']);
    assert.equal(res.status, 1, res.stdout);
    assert.match(res.stderr, /Usage: npx huaweicloud-devkit packs/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('packs status mirrors doctor for a fresh install', () => {
  const home = mkdtempSync(join(tmpdir(), 'devkit-packs-status-'));
  try {
    assert.equal(runCli(home, ['install', '--target', 'opencode']).status, 0);
    const res = runCli(home, ['packs', 'status']);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Packs \(OpenCode\): all — DEVKIT_PACKS not set/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('enable on an unset config is a noop (the full surface already includes every pack)', () => {
  const home = mkdtempSync(join(tmpdir(), 'devkit-packs-unset-'));
  try {
    assert.equal(runCli(home, ['install', '--target', 'opencode']).status, 0);
    const res = runCli(home, ['packs', 'enable', 'sandbox']);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(readPacks(home), undefined, 'no key may be written by an enable on the full surface');
    assert.match(res.stdout, /Packs \(OpenCode\): already the full surface/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('disable from an unset config writes the complement (all minus the ids)', () => {
  const home = mkdtempSync(join(tmpdir(), 'devkit-packs-comp-'));
  try {
    assert.equal(runCli(home, ['install', '--target', 'opencode']).status, 0);
    const res = runCli(home, ['packs', 'disable', 'obs']);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(
      readPacks(home),
      'core,huaweicloud-cli,sandbox,auth,voucher,update,discovery,huaweicloud-open-mcp,secrets',
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('enable/disable/all lifecycle on the stored seed', () => {
  const home = mkdtempSync(join(tmpdir(), 'devkit-packs-life-'));
  try {
    assert.equal(runCli(home, ['install', '--target', 'opencode', '--packs', 'core']).status, 0);
    assert.equal(readPacks(home), 'core');

    let res = runCli(home, ['packs', 'enable', 'sandbox']);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(readPacks(home), 'core,sandbox');
    const entry = readEntry(home);
    assert.equal(entry.command[0], 'node', 'the entry itself must stay intact');
    assert.equal(entry.type, 'local');
    assert.match(runCli(home, ['packs', 'status']).stdout, /Packs \(OpenCode\): core, sandbox/);

    res = runCli(home, ['packs', 'enable', 'obs,auth']);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(readPacks(home), 'core,sandbox,auth,obs', 'joined ids must follow PACK_IDS order');

    res = runCli(home, ['packs', 'disable', 'auth']);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(readPacks(home), 'core,sandbox,obs');

    res = runCli(home, ['packs', 'disable', 'sandbox,obs']);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(readPacks(home), 'core', 'the irreducible floor, never a blank value');

    res = runCli(home, ['packs', 'all']);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(readPacks(home), undefined, 'all removes the key');
    assert.match(runCli(home, ['packs', 'status']).stdout, /Packs \(OpenCode\): all — DEVKIT_PACKS not set/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('enable that covers the full surface removes the key', () => {
  const home = mkdtempSync(join(tmpdir(), 'devkit-packs-cover-'));
  try {
    assert.equal(runCli(home, ['install', '--target', 'opencode', '--packs', 'core']).status, 0);
    const res = runCli(home, [
      'packs',
      'enable',
      'huaweicloud-cli,sandbox,auth,obs,voucher,update,discovery,huaweicloud-open-mcp,secrets',
    ]);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(readPacks(home), undefined, 'a seed covering every pack is stored as the unset full surface');
    assert.match(res.stdout, /Packs \(OpenCode\): DEVKIT_PACKS "core" → all \(key removed\)/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('enable overwrites a user-set value (install would have refused)', () => {
  const home = mkdtempSync(join(tmpdir(), 'devkit-packs-user-'));
  try {
    assert.equal(runCli(home, ['install', '--target', 'opencode']).status, 0);
    seedUserPacks(home, 'obs');
    const res = runCli(home, ['packs', 'enable', 'sandbox']);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(readPacks(home), 'sandbox,obs', 'the union joined in PACK_IDS order');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('enable refuses a stored value with unknown ids and writes nothing', () => {
  const home = mkdtempSync(join(tmpdir(), 'devkit-packs-unknown-'));
  try {
    assert.equal(runCli(home, ['install', '--target', 'opencode']).status, 0);
    seedUserPacks(home, 'bogus,core');
    const before = readFileSync(opencodeConfigPath(home), 'utf8');
    const res = runCli(home, ['packs', 'enable', 'sandbox']);
    assert.equal(res.status, 1, res.stdout);
    assert.match(res.stdout, /Packs \(OpenCode\): unknown id\(s\) in DEVKIT_PACKS="bogus,core": bogus/);
    assert.match(res.stdout, /Clear it: npx huaweicloud-devkit packs all --target <agent>/);
    assert.equal(readFileSync(opencodeConfigPath(home), 'utf8'), before, 'operator-typed values are never destroyed');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('packs all clears even a value with unknown ids (the fix hint points here)', () => {
  const home = mkdtempSync(join(tmpdir(), 'devkit-packs-clear-'));
  try {
    assert.equal(runCli(home, ['install', '--target', 'opencode']).status, 0);
    seedUserPacks(home, 'bogus,core');
    const res = runCli(home, ['packs', 'all']);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(readPacks(home), undefined);
    assert.match(runCli(home, ['packs', 'status']).stdout, /Packs \(OpenCode\): all — DEVKIT_PACKS not set/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('bogus pack ids fail non-zero with zero writes', () => {
  const home = mkdtempSync(join(tmpdir(), 'devkit-packs-bogus-'));
  try {
    assert.equal(runCli(home, ['install', '--target', 'opencode', '--packs', 'core']).status, 0);
    const before = readFileSync(opencodeConfigPath(home), 'utf8');
    const res = runCli(home, ['packs', 'enable', 'bogus']);
    assert.equal(res.status, 1, res.stdout);
    assert.match(res.stderr, /Unknown pack id\(s\): bogus/);
    assert.match(res.stderr, /Valid pack ids: .*\bsandbox\b/);
    assert.equal(readFileSync(opencodeConfigPath(home), 'utf8'), before);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('missing id list prints usage and exits non-zero', () => {
  const home = mkdtempSync(join(tmpdir(), 'devkit-packs-noid-'));
  try {
    const res = runCli(home, ['packs', 'enable']);
    assert.equal(res.status, 1, res.stdout);
    assert.match(res.stderr, /Usage: npx huaweicloud-devkit packs/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('disable core refuses with the force-include message', () => {
  const home = mkdtempSync(join(tmpdir(), 'devkit-packs-core-'));
  try {
    assert.equal(runCli(home, ['install', '--target', 'opencode', '--packs', 'core']).status, 0);
    const before = readFileSync(opencodeConfigPath(home), 'utf8');
    const res = runCli(home, ['packs', 'disable', 'core']);
    assert.equal(res.status, 1, res.stdout);
    assert.match(res.stderr, /core is always enabled .* and cannot be disabled/);
    assert.equal(readFileSync(opencodeConfigPath(home), 'utf8'), before);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a named but uninstalled target fails with the install hint', () => {
  const home = mkdtempSync(join(tmpdir(), 'devkit-packs-tgt-'));
  try {
    assert.equal(runCli(home, ['install', '--target', 'opencode']).status, 0);
    const res = runCli(home, ['packs', 'status', '--target', 'workbuddy']);
    assert.equal(res.status, 1, res.stdout);
    assert.match(res.stderr, /workbuddy not installed — run install first/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('the codex target answers with the manual-config pointer', () => {
  const home = mkdtempSync(join(tmpdir(), 'devkit-packs-codex-'));
  try {
    const res = runCli(home, ['packs', 'status', '--target', 'codex']);
    assert.equal(res.status, 1, res.stdout);
    assert.match(res.stderr, /codex target is managed by codex CLI; set DEVKIT_PACKS in its MCP config manually/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('pure noop runs exit 0', () => {
  const home = mkdtempSync(join(tmpdir(), 'devkit-packs-noop-'));
  try {
    assert.equal(runCli(home, ['install', '--target', 'opencode']).status, 0);
    assert.equal(runCli(home, ['packs', 'all']).status, 0);
    assert.equal(runCli(home, ['packs', 'enable', 'sandbox']).status, 0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('refused-everywhere runs exit 1', () => {
  const home = mkdtempSync(join(tmpdir(), 'devkit-packs-refuse-'));
  try {
    assert.equal(runCli(home, ['install', '--target', 'opencode', '--packs', 'core']).status, 0);
    assert.equal(runCli(home, ['install', '--target', 'hermes', '--packs', 'core']).status, 0);
    seedUserPacks(home, 'bogus,core');
    const hermesCfg = join(home, '.hermes', 'config.yaml');
    writeFileSync(
      hermesCfg,
      readFileSync(hermesCfg, 'utf8').replace('DEVKIT_PACKS: "core"', 'DEVKIT_PACKS: "bogus,core"'),
    );
    const res = runCli(home, ['packs', 'enable', 'sandbox']);
    assert.equal(res.status, 1, res.stdout);
    assert.match(res.stdout, /Packs \(OpenCode\): unknown id\(s\) in DEVKIT_PACKS="bogus,core": bogus/);
    assert.match(res.stdout, /Packs \(Hermes Agent\): unknown id\(s\) in DEVKIT_PACKS="bogus,core": bogus/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('hermes: the managed block carries, floors, and drops the DEVKIT_PACKS line; user args survive', () => {
  const home = mkdtempSync(join(tmpdir(), 'devkit-packs-hermes-'));
  try {
    assert.equal(runCli(home, ['install', '--target', 'hermes', '--packs', 'core']).status, 0);
    const cfgPath = join(home, '.hermes', 'config.yaml');
    assert.match(readFileSync(cfgPath, 'utf8'), /DEVKIT_PACKS: "core"/);

    // A user-added arg inside the block must survive every packs rewrite.
    writeFileSync(cfgPath, readFileSync(cfgPath, 'utf8').replace(/(args: \["[^"]+")(])/, '$1, "--user-flag"$2'));

    let res = runCli(home, ['packs', 'enable', 'sandbox']);
    assert.equal(res.status, 0, res.stderr);
    let cfg = readFileSync(cfgPath, 'utf8');
    assert.match(cfg, /DEVKIT_PACKS: "core,sandbox"/);
    assert.match(cfg, /, "--user-flag"\]/);

    res = runCli(home, ['packs', 'disable', 'sandbox']);
    assert.equal(res.status, 0, res.stderr);
    cfg = readFileSync(cfgPath, 'utf8');
    assert.match(cfg, /DEVKIT_PACKS: "core"/);
    assert.match(cfg, /, "--user-flag"\]/);

    res = runCli(home, ['packs', 'all']);
    assert.equal(res.status, 0, res.stderr);
    cfg = readFileSync(cfgPath, 'utf8');
    assert.doesNotMatch(cfg, /DEVKIT_PACKS/);
    assert.match(cfg, /, "--user-flag"\]/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('dsh: the managed patch block carries and drops DEVKIT_PACKS', () => {
  const home = mkdtempSync(join(tmpdir(), 'devkit-packs-dsh-'));
  try {
    assert.equal(runCli(home, ['install', '--target', 'dsh', '--packs', 'core']).status, 0);
    const patchPath = join(home, '.dsh', 'profiles', 'web', 'cordis.patch.yml');
    assert.match(readFileSync(patchPath, 'utf8'), /DEVKIT_PACKS: 'core'/);

    let res = runCli(home, ['packs', 'enable', 'sandbox']);
    assert.equal(res.status, 0, res.stderr);
    let patch = readFileSync(patchPath, 'utf8');
    assert.match(patch, /DEVKIT_PACKS: 'core,sandbox'/);
    assert.match(patch, /# HuaweiCloud DevKit DSH integration start/);

    res = runCli(home, ['packs', 'all']);
    assert.equal(res.status, 0, res.stderr);
    patch = readFileSync(patchPath, 'utf8');
    assert.doesNotMatch(patch, /DEVKIT_PACKS/);
    assert.match(patch, /# HuaweiCloud DevKit DSH integration start/, 'the managed block itself survives');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('dsh refuses when the bundled patch provides the config', () => {
  const home = mkdtempSync(join(tmpdir(), 'devkit-packs-dshb-'));
  try {
    assert.equal(runCli(home, ['install', '--target', 'dsh', '--packs', 'core']).status, 0);
    const patchPath = join(home, '.dsh', 'profiles', 'web', 'cordis.patch.yml');
    writeFileSync(
      patchPath,
      [
        '- id: huaweicloud-devkit',
        "  name: '@deepseek-ai/dsh-mcp-client'",
        '  config:',
        '    serverName: huaweicloud',
        '',
      ].join('\n'),
    );
    const res = runCli(home, ['packs', 'disable', 'obs']);
    assert.equal(res.status, 1, res.stdout);
    assert.match(res.stdout, /Packs \(DSH\): the bundled DSH patch provides the MCP config/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('officeace: enable rewrites the DEVKIT_PACKS env_json row surgically', () => {
  const home = mkdtempSync(join(tmpdir(), 'devkit-packs-oa-'));
  try {
    const pluginDist = join(home, '.office-claw', 'huaweicloud-plugins', 'dist');
    mkdirSync(pluginDist, { recursive: true });
    writeFileSync(join(pluginDist, 'mcp-server.js'), '// seeded\n');
    const dbDir = join(home, 'data');
    mkdirSync(dbDir, { recursive: true });
    const db = new DatabaseSync(join(dbDir, 'mcp-connectors.sqlite'));
    db.exec('CREATE TABLE mcp_connectors (id TEXT PRIMARY KEY, name TEXT, env_json TEXT, updated_at INTEGER)');
    db.prepare("INSERT INTO mcp_connectors (id, name, env_json) VALUES ('c1', 'huaweicloud-devkit', ?)").run(
      JSON.stringify([
        { key: 'HUAWEICLOUD_AGENT_TOOLKIT_MODE', value: 'local', sensitive: false },
        { key: 'DEVKIT_PACKS', value: 'core', sensitive: false },
      ]),
    );
    db.close();

    const res = runCli(home, ['packs', 'enable', 'sandbox']);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Packs \(OfficeAce\): DEVKIT_PACKS "core" → "core,sandbox"/);

    const db2 = new DatabaseSync(join(dbDir, 'mcp-connectors.sqlite'));
    const row = db2.prepare("SELECT env_json FROM mcp_connectors WHERE name = 'huaweicloud-devkit'").get() as {
      env_json: string;
    };
    db2.close();
    assert.deepEqual(JSON.parse(String(row.env_json)), [
      { key: 'HUAWEICLOUD_AGENT_TOOLKIT_MODE', value: 'local', sensitive: false },
      { key: 'DEVKIT_PACKS', value: 'core,sandbox', sensitive: false },
    ]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('packs status announces the secrets pack on pinned seeds, warns when the vault is in use', () => {
  const home = mkdtempSync(join(tmpdir(), 'devkit-packs-secnote-'));
  const vaultHome = mkdtempSync(join(tmpdir(), 'devkit-packs-secvault-'));
  const masterKey = Buffer.alloc(32, 0x6b).toString('base64');
  // The vault-carrying variant: the fake home is swapped for a second fake
  // home holding an initialized env-tier vault, so the WARN shape probes
  // that vault and the INFO shape (plain runCli) probes the vault-less one.
  const withVault = (command: string[]) =>
    spawnSync(process.execPath, [setupCli, ...command], {
      cwd: root,
      env: { ...makeEnv(home), HUAWEICLOUD_HOME: vaultHome, HW_VAULT_MASTER_KEY: masterKey },
      encoding: 'utf8',
      timeout: 120000,
    });
  try {
    // Pinned seed without the secrets pack, vault not initialized: the
    // one-line INFO announcement, not a WARN.
    assert.equal(runCli(home, ['install', '--target', 'opencode', '--packs', 'core']).status, 0);
    seedUserPacks(home, 'core,huaweicloud-cli');
    const announce = runCli(home, ['packs', 'status']);
    assert.equal(announce.status, 0, announce.stderr);
    assert.match(announce.stdout, /new pack available — secrets/);
    assert.doesNotMatch(announce.stdout, /secrets pack is trimmed/);

    // Vault in use while the pack is trimmed: the real-mismatch WARN with
    // the fix command.
    const init = withVault(['secret', 'set', 'secret://user/hw-ak', '--value', 'AKNOTE-1']);
    assert.equal(init.status, 0, init.stderr);
    const mismatch = withVault(['packs', 'status']);
    assert.equal(mismatch.status, 0, mismatch.stderr);
    assert.match(mismatch.stdout, /the secret vault is initialized but the secrets pack is trimmed/);
    assert.match(mismatch.stdout, /packs enable secrets/);

    // The doctor face renders the same WARN (its consumer wiring is the
    // warn-counter increment next to the codex attribution line).
    const doctorRun = withVault(['doctor']);
    assert.match(doctorRun.stdout, /the secret vault is initialized but the secrets pack is trimmed/);
    assert.match(doctorRun.stdout, /packs enable secrets/);

    // Full surface (unset seed) prints nothing for either shape; an
    // already-included seed stays silent too.
    assert.equal(runCli(home, ['packs', 'all']).status, 0);
    const unset = withVault(['packs', 'status']);
    assert.equal(unset.status, 0, unset.stderr);
    assert.doesNotMatch(unset.stdout, /new pack available — secrets/);
    assert.doesNotMatch(unset.stdout, /secrets pack is trimmed/);
    seedUserPacks(home, 'core,secrets');
    const included = runCli(home, ['packs', 'status']);
    assert.equal(included.status, 0, included.stderr);
    assert.doesNotMatch(included.stdout, /new pack available — secrets/);
    assert.doesNotMatch(included.stdout, /secrets pack is trimmed/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(vaultHome, { recursive: true, force: true });
  }
});
