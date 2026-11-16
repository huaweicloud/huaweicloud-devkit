import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import test from 'node:test';

import { findHcloudBin } from '../plugins/huaweicloud-core/src/hcloud-probe.ts';
import { fixtureDir } from './fixture-dir.ts';
import { uninstallDependency, uninstallPlacedDependency } from '../plugins/huaweicloud-core/src/dep/provision.ts';
import { lookupOnPath } from '../plugins/huaweicloud-core/src/lib/dep-resolve.ts';
import {
  emptyPathEnv,
  exeSuffix,
  gatewayReceiptWithTier,
  isWin,
  noTargets,
  runDep,
  runSetupCli,
  tempHome,
  writeCodexStub,
  writeExecutable,
  writeFakeUv,
} from './dep-provision-harness.ts';
import { readReceipt, writeReceipt } from '../plugins/huaweicloud-core/src/dep/receipts.ts';

// The doctor probes below share one runner: exit 1 is the healthy "some
// check failed" path (the fixture PATH carries no hcloud), so doctor gates
// on its FAIL lines, never on a zero exit.
function doctorProbe(home: string, env: Record<string, string | undefined>): string {
  const res = runSetupCli(['doctor'], home, env);
  assert.ok(res.status === 0 || res.status === 1, `doctor crashed: ${res.stderr}`);
  return res.stdout;
}

test('uninstall: devbridge is refused, the host never manages it', () => {
  const result = uninstallDependency('devbridge', noTargets, { receiptsDir: fixtureDir('dep-') });
  assert.equal(result.ok, false);
  assert.match(result.message, /devbridge ships inside the cloud sandbox; the host never installs or removes it\./);
});

test('uninstallPlacedDependency without a receipt refuses like the gated shape', () => {
  const dir = fixtureDir('dep-uninstall-');
  const result = uninstallPlacedDependency('open-mcp-gateway', { receiptsDir: dir, env: emptyPathEnv(dir) });
  assert.equal(result.ok, false);
  assert.match(result.message, /no devkit install receipt/);
  assert.match(result.message, /uv tool uninstall huaweicloud-open-mcp/);
});

test('dep without a subcommand prints usage', () => {
  const res = runDep([]);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /Usage: npx huaweicloud-devkit dep <status \| install <id> \| uninstall <id>>/);
});

test('dep status with nothing installed requires no binaries', () => {
  const home = tempHome();
  const emptyPath = fixtureDir('dep-provision-path-');
  const res = runDep(['status'], {
    HOME: home,
    USERPROFILE: home,
    HOMEDRIVE: home.slice(0, 2),
    HOMEPATH: home.slice(2),
    PATH: emptyPath,
  });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /Dependency status \(effective packs: 0\)/);
  assert.match(res.stdout, /No pack binaries required\./);
});

test(
  'the --clean-gateway flag path bypasses the pack-requirement gate that blocks dep uninstall',
  { skip: isWin },
  () => {
    const home = tempHome();
    writeFakeUv(home);
    const gatewayBin = join(home, '.local', 'bin', `huaweicloud-open-mcp${exeSuffix}`);
    writeExecutable(gatewayBin);
    const depsDir = join(home, '.config', 'huaweicloud', 'deps');
    writeReceipt(gatewayReceiptWithTier('uv'), depsDir);
    const stubDir = writeCodexStub('broken');
    const stubPath = `${stubDir}${delimiter}/usr/bin${delimiter}/bin`;
    const gated = runSetupCli(['dep', 'uninstall', 'open-mcp-gateway'], home, { PATH: stubPath });
    assert.equal(gated.status, 1, gated.stderr);
    assert.match(gated.stderr, /Refusing to uninstall open-mcp-gateway: required by enabled pack\(s\)/);
    assert.match(gated.stderr, /installed targets: Codex CLI/);
    assert.ok(readReceipt('open-mcp-gateway', depsDir), 'the gated refusal keeps the receipt');
    const res = runSetupCli(['uninstall', '--target', 'all', '--clean-gateway'], home, { PATH: stubPath });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(existsSync(gatewayBin), false, 'the flag path removes the gateway anyway');
    assert.equal(readReceipt('open-mcp-gateway', depsDir), null, 'the receipt is cleared');
  },
);

test('doctor renders devbridge and PACK_USES warnings for a sandbox-only trim', () => {
  const home = tempHome();
  const installRes = runSetupCli(['install', '--target', 'opencode', '--packs', 'sandbox'], home);
  assert.equal(installRes.status, 0, installRes.stderr);
  // Empty PATH neutralizes codex detection (the neighboring dep-uninstall
  // test's precedent), so the union is exactly the installed target's trim.
  const emptyPath = fixtureDir('dep-provision-path-');
  const stdout = doctorProbe(home, { PATH: emptyPath, HUAWEICLOUD_HOME: home });
  assert.match(stdout, /devbridge: sandbox-resident, not probed host-side/);
  assert.match(stdout, /Pack sandbox uses discovery \(soft dependency\) but it is disabled/);
  assert.match(stdout, /Pack sandbox uses obs \(soft dependency\) but it is disabled/);
  assert.doesNotMatch(stdout, /open-mcp-gateway /, 'the gateway is outside this trim');
  assert.match(stdout, /hcloud CLI installed/, 'the dedicated hcloud block still renders');
});

test('doctor reports no pack dependencies for a core-only trim', () => {
  const home = tempHome();
  const installRes = runSetupCli(['install', '--target', 'opencode', '--packs', 'core'], home);
  assert.equal(installRes.status, 0, installRes.stderr);
  const emptyPath = fixtureDir('dep-provision-path-');
  const stdout = doctorProbe(home, { PATH: emptyPath, HUAWEICLOUD_HOME: home });
  assert.match(stdout, /Pack dependencies: none required/);
  assert.doesNotMatch(stdout, /devbridge: sandbox-resident/);
  assert.doesNotMatch(stdout, /Pack .* uses .* soft dependency/);
});

test('doctor undici check counts the atomcode payload dir', () => {
  const home = tempHome();
  // Only the atomcode plugin dir carries undici; every other target's
  // node_modules is absent, so the check passes only when atomcode is on
  // the doctor's undici list (installAtomCode runs installRuntimeDeps).
  mkdirSync(join(home, '.atomcode', 'huaweicloud-plugins', 'node_modules', 'undici'), { recursive: true });
  const emptyPath = fixtureDir('dep-provision-path-');
  const stdout = doctorProbe(home, { PATH: emptyPath, HUAWEICLOUD_HOME: home });
  assert.match(stdout, /\[PASS\].*Runtime deps \(undici\) installed/);
});

test('doctor payload checks cover an openclaw-only install', () => {
  const home = tempHome();
  // installOpenClaw ships the full payload (server, safety, undici, the
  // .mcp.json config, and the restart marker); an openclaw-only machine
  // must read as installed by every doctor payload check.
  const dest = join(home, '.agents', 'huaweicloud-plugins');
  mkdirSync(join(dest, 'dist'), { recursive: true });
  writeFileSync(join(dest, 'dist', 'mcp-server.js'), '// fake server\n', 'utf8');
  mkdirSync(join(dest, 'safety'), { recursive: true });
  writeFileSync(join(dest, 'safety', 'policy.json'), '{}\n', 'utf8');
  mkdirSync(join(dest, 'node_modules', 'undici'), { recursive: true });
  writeFileSync(join(dest, '.installed'), '2026-10-13T00:00:00Z\n', 'utf8');
  writeFileSync(
    join(dest, '.mcp.json'),
    JSON.stringify({ mcpServers: { 'huaweicloud-devkit': { command: 'node', args: ['/fake/mcp-server.js'] } } }),
    'utf8',
  );
  const emptyPath = fixtureDir('dep-provision-path-');
  const stdout = doctorProbe(home, { PATH: emptyPath, HUAWEICLOUD_HOME: home });
  assert.match(stdout, /\[PASS\].*MCP server installed/);
  assert.match(stdout, /MCP server can start \(OpenClaw\)/);
  assert.match(stdout, /\[PASS\].*Runtime deps \(undici\) installed/);
  assert.match(stdout, /\[PASS\].*Safety policy installed/);
  // The chain prints the target label only in its failure message; with
  // openclaw the only configured MCP surface present, a PASS here proves
  // the openclaw branch matched.
  assert.match(stdout, /\[PASS\].*MCP configured/);
  assert.match(stdout, /请重启 OpenClaw/);
});

test(
  'dep status: a parsed codex plugin list without the devkit plugin does not widen the union',
  { skip: isWin },
  () => {
    const home = tempHome();
    const installRes = runSetupCli(['install', '--target', 'opencode', '--packs', 'core'], home);
    assert.equal(installRes.status, 0, installRes.stderr);
    const stubDir = writeCodexStub('clean');
    const res = runSetupCli(['dep', 'status'], home, { PATH: `${stubDir}${delimiter}/usr/bin${delimiter}/bin` });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Dependency status \(effective packs: 1\)/);
  },
);

test('dep status: a failed codex plugin probe widens the union (fail-safe)', { skip: isWin }, () => {
  const home = tempHome();
  const installRes = runSetupCli(['install', '--target', 'opencode', '--packs', 'core'], home);
  assert.equal(installRes.status, 0, installRes.stderr);
  const stubDir = writeCodexStub('broken');
  const stubPath = `${stubDir}${delimiter}/usr/bin${delimiter}/bin`;
  const res = runSetupCli(['dep', 'status'], home, { PATH: stubPath });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /Dependency status \(effective packs: 10\)/);
  // Doctor names the codex contribution: a widened union with no explaining
  // line reads as a phantom.
  const docOut = doctorProbe(home, { PATH: stubPath, HUAWEICLOUD_HOME: home });
  assert.match(docOut, /Packs \(Codex CLI\): all — codex plugin list could not be read/);
});

test('doctor warns exactly once for an unknown DEVKIT_PACKS id', () => {
  const home = tempHome();
  const installRes = runSetupCli(['install', '--target', 'opencode', '--packs', 'core'], home);
  assert.equal(installRes.status, 0, installRes.stderr);
  // Corrupt the installed target's DEVKIT_PACKS with an unknown id.
  const cfgPath = join(home, '.config', 'opencode', 'opencode.json');
  assert.ok(existsSync(cfgPath), 'the install wrote the OpenCode MCP config');
  const cfg: Record<string, unknown> = JSON.parse(readFileSync(cfgPath, 'utf8'));
  const entry = (cfg.mcp as Record<string, Record<string, Record<string, unknown>>>)['huaweicloud-devkit'];
  const envMap = entry.environment ?? entry.env;
  envMap.DEVKIT_PACKS = 'bogus,core';
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');
  const emptyPath = fixtureDir('dep-provision-path-');
  const stdout = doctorProbe(home, { PATH: emptyPath, HUAWEICLOUD_HOME: home });
  const unknownLines = stdout.match(/unknown id\(s\) in DEVKIT_PACKS/g) ?? [];
  assert.equal(unknownLines.length, 1, `exactly one unknown-id WARN line:\n${stdout}`);
  assert.doesNotMatch(stdout, /provisioning the full surface/, 'the provisioning-flavored line stays in provisioning');
  const tally = /Results: (\d+) pass, (\d+) warn, (\d+) fail/.exec(stdout);
  assert.ok(tally, `the Results tally rendered:\n${stdout}`);
  const warnTags = stdout.match(/\[WARN\]/g) ?? [];
  assert.equal(Number(tally[2]), warnTags.length, `shown WARN lines must equal the counted warn tally:\n${stdout}`);
});

test('findHcloudBin returns the HCLOUD_BIN fixture when the file exists', () => {
  const fixture = join(tempHome(), `hcloud${exeSuffix}`);
  writeExecutable(fixture);
  const saved = process.env.HCLOUD_BIN;
  process.env.HCLOUD_BIN = fixture;
  try {
    assert.equal(findHcloudBin(), fixture);
  } finally {
    if (saved === undefined) delete process.env.HCLOUD_BIN;
    else process.env.HCLOUD_BIN = saved;
  }
});

test(
  'findHcloudBin returns null when nothing resolves',
  {
    // /usr/local/bin/hcloud is a legal candidate and cannot be faked via env:
    // a machine with a system-wide install would fail the null expectation.
    skip: isWin || existsSync('/usr/local/bin/hcloud'),
  },
  () => {
    const home = tempHome();
    const emptyPath = fixtureDir('dep-provision-path-');
    const savedBin = process.env.HCLOUD_BIN;
    const savedHome = process.env.HOME;
    const savedPath = process.env.PATH;
    delete process.env.HCLOUD_BIN;
    process.env.HOME = home;
    process.env.PATH = emptyPath;
    try {
      assert.equal(findHcloudBin(), null);
    } finally {
      if (savedBin === undefined) delete process.env.HCLOUD_BIN;
      else process.env.HCLOUD_BIN = savedBin;
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
      process.env.PATH = savedPath;
    }
  },
);

test('lookupOnPath passes the name as an argument, never interpolated into the shell script', { skip: isWin }, () => {
  // If the name reached sh -c by string interpolation, the touch would
  // EXECUTE and leave the sentinel behind. The positional $1 pass makes
  // that impossible: the metacharacters are data, not script.
  const emptyPath = fixtureDir('dep-provision-nopath-');
  const sentinel = join(tmpdir(), `dep-probe-sentinel-${process.pid}`);
  rmSync(sentinel, { force: true });
  try {
    const evil = `no-such-bin; touch ${sentinel}`;
    const resolved = lookupOnPath(evil, { PATH: emptyPath });
    assert.equal(resolved, null, 'the metacharacter name resolves to nothing');
    assert.equal(existsSync(sentinel), false, 'the name must never execute as shell script');
  } finally {
    rmSync(sentinel, { force: true });
    rmSync(emptyPath, { recursive: true, force: true });
  }
});

for (const tier of ['uv', 'pipx', 'pip3'] as const) {
  test(`uninstall gateway with a ${tier} receipt dispatches ${tier}'s uninstall command`, () => {
    const home = tempHome();
    const dir = join(home, 'deps');
    writeReceipt(gatewayReceiptWithTier(tier), dir);
    const tool = join(home, '.local', 'bin', `${tier}${exeSuffix}`);
    writeExecutable(tool);
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    const result = uninstallDependency('open-mcp-gateway', noTargets, {
      receiptsDir: dir,
      env: emptyPathEnv(home),
      runCommand: (command, args) => {
        calls.push({ command, args });
        // The contract, not the literal: pip has no --user option on
        // uninstall (exit 2), so a regression back to --user must fail here.
        if (args.includes('uninstall') && args.includes('--user')) {
          return { status: 2, stdout: '', stderr: 'no such option: --user' };
        }
        return { status: 0, stdout: '', stderr: '' };
      },
    });
    assert.equal(result.ok, true, result.message);
    assert.equal(calls.length, 1);
    const expectedArgs =
      tier === 'uv'
        ? ['tool', 'uninstall', 'huaweicloud-open-mcp']
        : tier === 'pipx'
          ? ['uninstall', 'huaweicloud-open-mcp']
          : ['uninstall', '-y', 'huaweicloud-open-mcp'];
    assert.deepEqual(calls[0], { command: tool, args: expectedArgs });
    assert.ok(
      result.message.includes(`Uninstalled the devkit-installed open-mcp-gateway via ${tier}:`),
      result.message,
    );
    assert.equal(readReceipt('open-mcp-gateway', dir), null);
  });
}
