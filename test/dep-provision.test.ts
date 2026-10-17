import assert from 'node:assert/strict';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { DEPENDENCIES, DEPENDENCY_IDS } from '../plugins/huaweicloud-core/src/lib/dependency-model.ts';
import { lookupOnPath, resolveDependencyCommand } from '../plugins/huaweicloud-core/src/lib/dep-resolve.ts';
import type { PackId } from '../plugins/huaweicloud-core/src/lib/pack-types.ts';
import { installerFor } from '../plugins/huaweicloud-core/src/dep/installers/table.ts';
import { installGatewayTool } from '../plugins/huaweicloud-core/src/dep/installers/gateway.ts';
import {
  provisionDependencies,
  uninstallDependency,
  uninstallPlacedDependency,
  type DepUninstallTargets,
} from '../plugins/huaweicloud-core/src/dep/provision.ts';
import { readReceipt, writeReceipt, type DepReceipt } from '../plugins/huaweicloud-core/src/dep/receipts.ts';
import { findHcloudBin } from '../plugins/huaweicloud-core/src/hcloud-probe.ts';
import { fixtureDir } from './fixture-dir.ts';

// Unit 2 (provision half) and Unit 3 (uninstall half + receipts) contracts,
// driven through the public functions and the real CLI: the resolution
// chain's tier order, the provisioning policy loop (with the
// installer/probe/resolution seams faked — no network, no real installs),
// the receipt-gated uninstall decision, the dep CLI surface, and
// findHcloudBin's delegation.

const root = fileURLToPath(new URL('..', import.meta.url));
const setupCli = join(root, 'bin', 'setup.cjs');
const isWin = process.platform === 'win32';
const exeSuffix = isWin ? '.exe' : '';

const gatewayResolution = DEPENDENCIES['open-mcp-gateway'].resolution;

function tempHome(): string {
  return fixtureDir('dep-provision-home-');
}

function writeExecutable(path: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, isWin ? '@echo off\r\n' : '#!/bin/sh\n', 'utf8');
  if (!isWin) chmodSync(path, 0o755);
}

// eslint's no-control-regex flags the \x1b escape, but stripping ANSI color
// codes is exactly what this helper exists for.
const ANSI_COLOR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
const stripAnsi = (text: string): string => text.replace(ANSI_COLOR, '');

function collector(): { lines: string[]; text(): string; log(_line: string): void } {
  const lines: string[] = [];
  return {
    lines,
    log: (line: string) => lines.push(line),
    text: () => stripAnsi(lines.join('\n')),
  };
}

// ---- dep-resolve: the one resolution chain, tier order pinned ----

test('dep-resolve: OPENMCP_BIN pointing at an existing file wins (env tier)', () => {
  const home = tempHome();
  const fixture = join(home, `gateway${exeSuffix}`);
  writeExecutable(fixture);
  const resolved = resolveDependencyCommand(gatewayResolution, {
    OPENMCP_BIN: fixture,
    HOME: '/nonexistent',
    PATH: '/usr/bin',
  });
  assert.deepEqual(resolved, { command: fixture, argsPrefix: [], tier: 'env' });
});

test('dep-resolve: a missing envBin falls through to the platform candidates', () => {
  const home = tempHome();
  const candidate = join(home, '.local', 'bin', `huaweicloud-open-mcp${exeSuffix}`);
  writeExecutable(candidate);
  const resolved = resolveDependencyCommand(gatewayResolution, {
    OPENMCP_BIN: join(home, 'does-not-exist'),
    HOME: home,
    PATH: '/usr/bin',
  });
  assert.deepEqual(resolved, { command: candidate, argsPrefix: [], tier: 'candidate' });
});

test('dep-resolve: a persistent install under a fake HOME resolves as candidate', () => {
  const home = tempHome();
  const candidate = join(home, '.local', 'bin', `huaweicloud-open-mcp${exeSuffix}`);
  writeExecutable(candidate);
  const resolved = resolveDependencyCommand(gatewayResolution, { HOME: home, PATH: '/usr/bin' });
  assert.deepEqual(resolved, { command: candidate, argsPrefix: [], tier: 'candidate' });
});

test('dep-resolve: a PATH hit resolves as the path tier', { skip: isWin }, () => {
  const home = tempHome();
  const stubDir = fixtureDir('dep-provision-bin-');
  const stub = join(stubDir, 'huaweicloud-open-mcp');
  writeExecutable(stub);
  const resolved = resolveDependencyCommand(gatewayResolution, { HOME: home, PATH: `/usr/bin${delimiter}${stubDir}` });
  assert.deepEqual(resolved, { command: stub, argsPrefix: [], tier: 'path' });
});

test('dep-resolve: uvx resolves as the fallback tier with the package argsPrefix', { skip: isWin }, () => {
  const home = tempHome();
  const stubDir = fixtureDir('dep-provision-uvx-');
  const uvx = join(stubDir, 'uvx');
  writeExecutable(uvx);
  const resolved = resolveDependencyCommand(gatewayResolution, { HOME: home, PATH: `/usr/bin${delimiter}${stubDir}` });
  assert.deepEqual(resolved, { command: uvx, argsPrefix: ['huaweicloud-open-mcp'], tier: 'fallback' });
});

test('dep-resolve: the fallback command is probed in ~/.local/bin before PATH', () => {
  const home = tempHome();
  const localUvx = join(home, '.local', 'bin', `uvx${exeSuffix}`);
  writeExecutable(localUvx);
  const resolved = resolveDependencyCommand(gatewayResolution, { HOME: home, PATH: '/usr/bin' });
  assert.deepEqual(resolved, { command: localUvx, argsPrefix: ['huaweicloud-open-mcp'], tier: 'fallback' });
});

test('dep-resolve: nothing anywhere resolves to null', () => {
  const home = tempHome();
  const emptyPath = fixtureDir('dep-provision-empty-');
  const resolved = resolveDependencyCommand(gatewayResolution, { HOME: home, PATH: emptyPath });
  assert.equal(resolved, null);
});

// ---- provisionDependencies: the policy loop, seams faked ----

test('provisioning: hcloud absent in a non-TTY session prints the manual command, never installs', async () => {
  const out = collector();
  let installerCalls = 0;
  await provisionDependencies(['hcloud'], {
    tty: false,
    log: out.log,
    probeHcloud: () => ({ status: 'not_found', installed: false }),
    installKooCli: async () => {
      installerCalls += 1;
      return true;
    },
  });
  assert.equal(installerCalls, 0, 'non-TTY must not start a download');
  assert.match(out.text(), /hcloud: not found; auto-install needs an interactive session/);
  assert.match(
    out.text(),
    isWin
      ? /Manual: download .*huaweicloud-cli-windows-amd64\.zip/
      : /curl -LO ".*huaweicloud-cli-linux-(amd64|arm64)\.tar\.gz"/,
  );
});

test('provisioning: hcloud present skips with an INFO line, no installer call', async () => {
  const out = collector();
  let installerCalls = 0;
  await provisionDependencies(['hcloud'], {
    log: out.log,
    probeHcloud: () => ({ status: 'ok', installed: true, installedVersion: '7.2.12' }),
    installKooCli: async () => {
      installerCalls += 1;
      return true;
    },
  });
  assert.equal(installerCalls, 0);
  assert.match(out.text(), /hcloud: present \(7\.2\.12\), skipping install/);
});

test('provisioning: a version mismatch still counts as present (doctor owns that warning)', async () => {
  const out = collector();
  await provisionDependencies(['hcloud'], {
    log: out.log,
    probeHcloud: () => ({ status: 'version_mismatch', installed: true, installedVersion: '7.0.0' }),
  });
  assert.match(out.text(), /hcloud: present \(7\.0\.0\), skipping install/);
});

test('provisioning: a persistent gateway tier skips silently — no prompt fires', async () => {
  const out = collector();
  const calls = { confirm: 0, installGateway: 0 };
  await provisionDependencies(['open-mcp-gateway'], {
    log: out.log,
    resolveDependency: () => ({ command: '/opt/huaweicloud-open-mcp', argsPrefix: [], tier: 'path' }),
    confirm: async () => {
      calls.confirm += 1;
      return true;
    },
    installGateway: async () => {
      calls.installGateway += 1;
      return { ok: true, tier: 'uv' };
    },
  });
  assert.equal(calls.confirm, 0, 'a persistent install must not prompt');
  assert.equal(calls.installGateway, 0);
  assert.match(out.text(), /open-mcp-gateway: present \(path: \/opt\/huaweicloud-open-mcp\)/);
});

test('provisioning: a fallback-tier gateway in a non-TTY session prints the install hint', async () => {
  const out = collector();
  const calls = { confirm: 0, installGateway: 0 };
  await provisionDependencies(['open-mcp-gateway'], {
    tty: false,
    log: out.log,
    resolveDependency: () => ({ command: '/usr/bin/uvx', argsPrefix: ['huaweicloud-open-mcp'], tier: 'fallback' }),
    confirm: async () => {
      calls.confirm += 1;
      return true;
    },
    installGateway: async () => {
      calls.installGateway += 1;
      return { ok: true, tier: 'uv' };
    },
  });
  assert.equal(calls.confirm, 0);
  assert.equal(calls.installGateway, 0);
  assert.match(out.text(), /open-mcp-gateway: running via uvx \(no persistent install\)/);
  assert.match(out.text(), /dep install open-mcp-gateway/);
});

test('provisioning: an unresolvable gateway in a non-TTY session prints the install hint', async () => {
  const out = collector();
  await provisionDependencies(['open-mcp-gateway'], {
    tty: false,
    log: out.log,
    resolveDependency: () => null,
  });
  assert.match(out.text(), /open-mcp-gateway: not found\./);
  assert.match(out.text(), /dep install open-mcp-gateway/);
});

test('provisioning: a fallback-tier gateway in a TTY session prompts, then installs once on y', async () => {
  const out = collector();
  const calls = { installGateway: 0 };
  const prompts: string[] = [];
  await provisionDependencies(['open-mcp-gateway'], {
    tty: true,
    log: out.log,
    resolveDependency: () => ({ command: '/usr/bin/uvx', argsPrefix: ['huaweicloud-open-mcp'], tier: 'fallback' }),
    confirm: async (prompt) => {
      prompts.push(prompt);
      return true;
    },
    installGateway: async () => {
      calls.installGateway += 1;
      return { ok: true, tier: 'uv' };
    },
  });
  assert.equal(calls.installGateway, 1);
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /Install the Open MCP Gateway persistently \(uv tool install \/ pipx \/ pip\)\?/);
  assert.match(out.text(), /open-mcp-gateway: installed via uv/);
});

test('provisioning: a declined prompt leaves the pack usable and prints the hint', async () => {
  const out = collector();
  const calls = { installGateway: 0 };
  await provisionDependencies(['open-mcp-gateway'], {
    tty: true,
    log: out.log,
    resolveDependency: () => ({ command: '/usr/bin/uvx', argsPrefix: ['huaweicloud-open-mcp'], tier: 'fallback' }),
    confirm: async () => false,
    installGateway: async () => {
      calls.installGateway += 1;
      return { ok: true, tier: 'uv' };
    },
  });
  assert.equal(calls.installGateway, 0);
  assert.match(out.text(), /open-mcp-gateway: skipped\./);
  assert.match(out.text(), /uvx needs no install/);
});

test('provisioning: devbridge is one INFO line and invokes nothing', async () => {
  const out = collector();
  const calls = { probe: 0, installKooCli: 0, resolve: 0, installGateway: 0, confirm: 0 };
  await provisionDependencies(['devbridge'], {
    tty: true,
    log: out.log,
    probeHcloud: () => {
      calls.probe += 1;
      return { status: 'not_found', installed: false };
    },
    installKooCli: async () => {
      calls.installKooCli += 1;
      return true;
    },
    resolveDependency: () => {
      calls.resolve += 1;
      return null;
    },
    installGateway: async () => {
      calls.installGateway += 1;
      return { ok: true, tier: 'uv' };
    },
    confirm: async () => {
      calls.confirm += 1;
      return true;
    },
  });
  assert.deepEqual(calls, { probe: 0, installKooCli: 0, resolve: 0, installGateway: 0, confirm: 0 });
  assert.match(out.text(), /devbridge: sandbox-resident \(lives inside the cloud sandbox; the host never manages it\)/);
});

test('provisioning: hcloud absent in a TTY session auto-installs exactly once', async () => {
  const out = collector();
  let installerCalls = 0;
  await provisionDependencies(['hcloud'], {
    tty: true,
    log: out.log,
    probeHcloud: () => ({ status: 'not_found', installed: false }),
    installKooCli: async () => {
      installerCalls += 1;
      return true;
    },
  });
  assert.equal(installerCalls, 1, 'the TTY auto path must call the injected installer');
  assert.match(out.text(), /hcloud: installed/);
  assert.doesNotMatch(out.text(), /not found; auto-install needs an interactive session/);
});

test('provisioning: a failing dependency is isolated and reported, the loop continues', async () => {
  const out = collector();
  await provisionDependencies(['hcloud', 'devbridge'], {
    log: out.log,
    probeHcloud: () => {
      throw new Error('probe exploded');
    },
  });
  assert.match(out.text(), /hcloud: provisioning failed: probe exploded/);
  assert.match(out.text(), /devbridge: sandbox-resident/);
});

// ---- uninstallDependency: the receipt-gated decision, seams faked ----

function emptyPathEnv(home: string): Record<string, string> {
  const emptyPath = fixtureDir('dep-provision-empty-');
  return { HOME: home, PATH: emptyPath };
}

function hcloudReceiptAt(path: string): DepReceipt {
  return { binary: 'hcloud', provisioner: 'devkit', path, installedAt: '2026-10-08T00:00:00.000Z' };
}

function gatewayReceiptWithTier(tier: 'uv' | 'pipx' | 'pip3'): DepReceipt {
  return { binary: 'open-mcp-gateway', provisioner: 'devkit', tier, installedAt: '2026-10-08T00:00:00.000Z' };
}

const noTargets: DepUninstallTargets = { enabledPacks: new Set<PackId>(), carriers: [] };

test('uninstall: devbridge is refused, the host never manages it', () => {
  const result = uninstallDependency('devbridge', noTargets, { receiptsDir: fixtureDir('dep-') });
  assert.equal(result.ok, false);
  assert.match(result.message, /devbridge ships inside the cloud sandbox; the host never installs or removes it\./);
});

test('uninstall hcloud without a receipt refuses and points at --clean-kocli', () => {
  const dir = fixtureDir('dep-uninstall-');
  const result = uninstallDependency('hcloud', noTargets, { receiptsDir: dir, env: emptyPathEnv(dir) });
  assert.equal(result.ok, false);
  assert.match(result.message, /Refusing to uninstall hcloud: no devkit install receipt/);
  assert.match(result.message, /uninstall --target all --clean-kocli/);
});

test('uninstall open-mcp-gateway without a receipt refuses and points at the manual uninstalls', () => {
  const dir = fixtureDir('dep-uninstall-');
  const result = uninstallDependency('open-mcp-gateway', noTargets, { receiptsDir: dir, env: emptyPathEnv(dir) });
  assert.equal(result.ok, false);
  assert.match(result.message, /Refusing to uninstall open-mcp-gateway: no devkit install receipt/);
  assert.match(result.message, /uv tool uninstall huaweicloud-open-mcp/);
  assert.match(result.message, /pipx uninstall huaweicloud-open-mcp/);
  assert.match(result.message, /pip3 uninstall -y huaweicloud-open-mcp/);
  assert.doesNotMatch(result.message, /pip3 uninstall --user/, 'pip rejects --user on uninstall');
});

test('uninstall refuses while the effective pack union still requires the id', () => {
  const dir = fixtureDir('dep-uninstall-');
  writeReceipt(hcloudReceiptAt('/gone-anyway'), dir);
  const targets: DepUninstallTargets = {
    enabledPacks: new Set<PackId>(['core', 'huaweicloud-cli', 'auth']),
    carriers: [
      { label: 'OpenCode', packs: new Set<PackId>(['core', 'huaweicloud-cli', 'auth']) },
      { label: 'Codex CLI', packs: new Set<PackId>(['core', 'voucher']) },
    ],
  };
  const result = uninstallDependency('hcloud', targets, { receiptsDir: dir });
  assert.equal(result.ok, false);
  assert.match(result.message, /Refusing to uninstall hcloud: required by enabled pack\(s\) auth, huaweicloud-cli/);
  assert.match(result.message, /installed targets: OpenCode/);
  assert.doesNotMatch(result.message, /Codex CLI/, 'a target not carrying the requiring packs is not named');
  // The requirement refusal fires before the receipt gate: even a receipt
  // does not unlock removing a binary the enabled surface still needs.
  assert.ok(readReceipt('hcloud', dir), 'the receipt is kept untouched');
});

test('uninstall hcloud with a receipt deletes exactly the receipt path', () => {
  const home = tempHome();
  const dir = join(home, 'deps');
  const placed = join(home, '.local', 'bin', 'hcloud');
  const userOwned = join(home, 'usr-local', 'hcloud');
  writeExecutable(placed);
  writeExecutable(userOwned);
  writeReceipt(hcloudReceiptAt(placed), dir);
  const result = uninstallDependency(
    'hcloud',
    noTargets,
    // A second hcloud resolves elsewhere; the receipt's path is the only
    // file devkit may touch.
    { receiptsDir: dir, env: { ...emptyPathEnv(home), HCLOUD_BIN: userOwned } },
  );
  assert.equal(result.ok, true, result.message);
  assert.equal(existsSync(placed), false, 'the devkit-placed binary is removed');
  assert.equal(existsSync(userOwned), true, 'a binary outside the receipt path is untouched');
  assert.equal(readReceipt('hcloud', dir), null, 'the receipt is removed with the binary');
  assert.ok(result.message.includes(`Removed the devkit-installed hcloud binary: ${placed}`), result.message);
  assert.match(result.detail?.[0] ?? '', /~\/\.hcloud credentials and config were not touched/);
});

test('uninstall hcloud when the receipt path is already gone clears the stale receipt', () => {
  const home = tempHome();
  const dir = join(home, 'deps');
  writeReceipt(hcloudReceiptAt(join(home, '.local', 'bin', 'hcloud')), dir);
  const result = uninstallDependency('hcloud', noTargets, { receiptsDir: dir, env: emptyPathEnv(home) });
  assert.equal(result.ok, true);
  assert.match(result.message, /hcloud was already gone/);
  assert.match(result.message, /removed the stale receipt/);
  assert.equal(readReceipt('hcloud', dir), null);
});

// Root bypasses directory permissions, so EACCES cannot be staged as root.
const cannotStageEacces = isWin || (typeof process.getuid === 'function' && process.getuid() === 0);

test(
  'uninstall hcloud escalates to sudo -n rm through the runCommand seam when rmSync fails',
  { skip: cannotStageEacces },
  () => {
    const home = tempHome();
    const dir = join(home, 'deps');
    // The receipt path must be a known installer landing site before sudo is
    // allowed near it: ~/.local/bin/hcloud is the catalog's first unix
    // candidate. The directory is made non-writable so rmSync fails EACCES,
    // exactly how a permissions-restricted install location behaves.
    const placed = join(home, '.local', 'bin', 'hcloud');
    writeExecutable(placed);
    writeReceipt(hcloudReceiptAt(placed), dir);
    chmodSync(join(home, '.local', 'bin'), 0o555);
    try {
      const calls: Array<{ command: string; args: readonly string[] }> = [];
      const result = uninstallDependency('hcloud', noTargets, {
        receiptsDir: dir,
        env: emptyPathEnv(home),
        runCommand: (command, args) => {
          calls.push({ command, args });
          return { status: 0, stdout: '', stderr: '' };
        },
      });
      assert.equal(result.ok, true, result.message);
      assert.deepEqual(calls, [{ command: 'sudo', args: ['-n', 'rm', placed] }]);
      assert.ok(
        result.message.includes(`Removed the devkit-installed hcloud binary: ${placed} (via sudo -n rm)`),
        result.message,
      );
      assert.equal(readReceipt('hcloud', dir), null, 'the receipt is cleared once sudo withdraws the binary');
    } finally {
      chmodSync(join(home, '.local', 'bin'), 0o755);
    }
  },
);

test(
  'uninstall hcloud reports the manual sudo rm line when sudo -n cannot withdraw the binary',
  { skip: cannotStageEacces },
  () => {
    const home = tempHome();
    const dir = join(home, 'deps');
    const placed = join(home, '.local', 'bin', 'hcloud');
    writeExecutable(placed);
    writeReceipt(hcloudReceiptAt(placed), dir);
    chmodSync(join(home, '.local', 'bin'), 0o555);
    try {
      const result = uninstallDependency('hcloud', noTargets, {
        receiptsDir: dir,
        env: emptyPathEnv(home),
        runCommand: () => ({ status: 1, stdout: '', stderr: 'sudo: a password is required' }),
      });
      assert.equal(result.ok, false);
      assert.ok(result.message.includes(`Failed to remove ${placed}:`), result.message);
      assert.ok(
        result.message.includes(
          `Remove it manually (sudo rm ${placed}), then re-run dep uninstall hcloud to clear the receipt.`,
        ),
        result.message,
      );
      assert.equal(existsSync(placed), true, 'the binary is left in place');
      assert.ok(readReceipt('hcloud', dir), 'the receipt stays until the user resolves the standoff');
    } finally {
      chmodSync(join(home, '.local', 'bin'), 0o755);
    }
  },
);

test(
  'uninstall hcloud refuses sudo for a receipt path outside the known install locations',
  { skip: cannotStageEacces },
  () => {
    const home = tempHome();
    const dir = join(home, 'deps');
    // A forged receipt aiming sudo at an arbitrary file: present on disk,
    // EACCES-protected, but neither a platform candidate nor the installer's
    // computed binPath.
    const placed = join(home, 'usr-local', 'hcloud');
    writeExecutable(placed);
    writeReceipt(hcloudReceiptAt(placed), dir);
    chmodSync(join(home, 'usr-local'), 0o555);
    try {
      const calls: Array<{ command: string; args: readonly string[] }> = [];
      const result = uninstallDependency('hcloud', noTargets, {
        receiptsDir: dir,
        env: emptyPathEnv(home),
        runCommand: (command, args) => {
          calls.push({ command, args });
          return { status: 0, stdout: '', stderr: '' };
        },
      });
      assert.equal(result.ok, false, result.message);
      assert.deepEqual(calls, [], 'sudo is never spawned for an untrusted receipt path');
      assert.match(result.message, /receipt path is not a known devkit install location/);
      assert.equal(existsSync(placed), true, 'the binary is left in place');
      assert.ok(readReceipt('hcloud', dir), 'the receipt is kept');
    } finally {
      chmodSync(join(home, 'usr-local'), 0o755);
    }
  },
);

test('uninstall hcloud with a pathless receipt never deletes the user\u2019s HCLOUD_BIN override', () => {
  const dir = fixtureDir('dep-uninstall-');
  const userOwned = join(dir, 'my-hcloud');
  writeExecutable(userOwned);
  writeReceipt({ binary: 'hcloud', provisioner: 'devkit', installedAt: '2026-10-08T00:00:00.000Z' }, dir);
  const result = uninstallDependency('hcloud', noTargets, {
    receiptsDir: dir,
    env: { ...emptyPathEnv(dir), HCLOUD_BIN: userOwned },
  });
  assert.equal(result.ok, false);
  assert.match(result.message, /user's HCLOUD_BIN override/);
  assert.equal(existsSync(userOwned), true);
  assert.ok(readReceipt('hcloud', dir), 'the receipt stays until the user resolves the standoff');
});

for (const tier of ['uv', 'pipx', 'pip3'] as const) {
  test(`uninstall gateway with a ${tier} receipt dispatches ${tier}'s uninstall command`, () => {
    const home = tempHome();
    const dir = join(home, 'deps');
    writeReceipt(gatewayReceiptWithTier(tier), dir);
    const tool = join(home, '.local', 'bin', tier);
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

test('the forced uninstall shape skips the pack-requirement gate the gated shape enforces', () => {
  const home = tempHome();
  const dir = join(home, 'deps');
  writeReceipt(gatewayReceiptWithTier('uv'), dir);
  writeExecutable(join(home, '.local', 'bin', 'uv'));
  const requiring: DepUninstallTargets = {
    enabledPacks: new Set<PackId>(['huaweicloud-open-mcp']),
    carriers: [{ label: 'OpenCode', packs: new Set<PackId>(['huaweicloud-open-mcp']) }],
  };
  const gated = uninstallDependency('open-mcp-gateway', requiring, {
    receiptsDir: dir,
    env: emptyPathEnv(home),
    runCommand: () => ({ status: 0, stdout: '', stderr: '' }),
  });
  assert.equal(gated.ok, false);
  assert.match(gated.message, /required by enabled pack\(s\) huaweicloud-open-mcp/);
  assert.ok(readReceipt('open-mcp-gateway', dir), 'the gated refusal keeps the receipt');
  const forced = uninstallPlacedDependency('open-mcp-gateway', {
    receiptsDir: dir,
    env: emptyPathEnv(home),
    runCommand: () => ({ status: 0, stdout: '', stderr: '' }),
  });
  assert.equal(forced.ok, true, forced.message);
  assert.equal(readReceipt('open-mcp-gateway', dir), null, 'the forced shape clears the receipt');
});

test('uninstallPlacedDependency without a receipt refuses like the gated shape', () => {
  const dir = fixtureDir('dep-uninstall-');
  const result = uninstallPlacedDependency('open-mcp-gateway', { receiptsDir: dir, env: emptyPathEnv(dir) });
  assert.equal(result.ok, false);
  assert.match(result.message, /no devkit install receipt/);
  assert.match(result.message, /uv tool uninstall huaweicloud-open-mcp/);
});

test('uninstall gateway falls back to the resolved binary when the tier tool is gone', () => {
  const home = tempHome();
  const dir = join(home, 'deps');
  const gatewayBin = join(home, '.local', 'bin', `huaweicloud-open-mcp${exeSuffix}`);
  writeExecutable(gatewayBin);
  writeReceipt(gatewayReceiptWithTier('uv'), dir);
  let runnerCalls = 0;
  const result = uninstallDependency('open-mcp-gateway', noTargets, {
    receiptsDir: dir,
    env: emptyPathEnv(home),
    runCommand: () => {
      runnerCalls += 1;
      return { status: 0, stdout: '', stderr: '' };
    },
  });
  assert.equal(result.ok, true, result.message);
  assert.equal(runnerCalls, 0, 'no tier command runs when the tier tool is gone');
  assert.equal(existsSync(gatewayBin), false, 'the resolved candidate binary is removed directly');
  assert.match(result.message, /uv is no longer installed.*removed the gateway binary directly/);
  assert.equal(readReceipt('open-mcp-gateway', dir), null);
});

test('uninstall gateway treats a failed tier uninstall with no remaining binary as already gone', () => {
  const home = tempHome();
  const dir = join(home, 'deps');
  writeReceipt(gatewayReceiptWithTier('pipx'), dir);
  writeExecutable(join(home, '.local', 'bin', 'pipx'));
  const result = uninstallDependency('open-mcp-gateway', noTargets, {
    receiptsDir: dir,
    env: emptyPathEnv(home),
    runCommand: () => ({ status: 1, stdout: '', stderr: 'Nothing to uninstall' }),
  });
  assert.equal(result.ok, true);
  assert.match(result.message, /open-mcp-gateway was already gone/);
  assert.match(result.message, /pipx reported: Nothing to uninstall/);
  assert.equal(readReceipt('open-mcp-gateway', dir), null);
});

test('uninstall gateway keeps the receipt when the tier uninstall fails and a binary still resolves', () => {
  const home = tempHome();
  const dir = join(home, 'deps');
  const gatewayBin = join(home, '.local', 'bin', `huaweicloud-open-mcp${exeSuffix}`);
  writeExecutable(gatewayBin);
  writeReceipt(gatewayReceiptWithTier('pip3'), dir);
  writeExecutable(join(home, '.local', 'bin', 'pip3'));
  const result = uninstallDependency('open-mcp-gateway', noTargets, {
    receiptsDir: dir,
    env: emptyPathEnv(home),
    runCommand: () => ({ status: 2, stdout: '', stderr: 'pip error' }),
  });
  assert.equal(result.ok, false);
  assert.match(result.message, /pip3 uninstall failed \(exit 2\): pip error/);
  assert.ok(readReceipt('open-mcp-gateway', dir), 'the receipt is kept for the retry');
  assert.equal(existsSync(gatewayBin), true, 'the still-resolving binary is not deleted on a failed tier uninstall');
});

test('uninstall gateway with no tier tool and no resolvable binary clears the stale receipt', () => {
  const home = tempHome();
  const dir = join(home, 'deps');
  writeReceipt(
    { binary: 'open-mcp-gateway', provisioner: 'devkit', tier: 'uv', installedAt: '2026-10-08T00:00:00.000Z' },
    dir,
  );
  const result = uninstallDependency('open-mcp-gateway', noTargets, { receiptsDir: dir, env: emptyPathEnv(home) });
  assert.equal(result.ok, true);
  assert.match(result.message, /open-mcp-gateway was already gone \(no persistent install resolves\)/);
  assert.equal(readReceipt('open-mcp-gateway', dir), null);
});

// ---- installers: the composition table agrees with the catalog ----

test('installers: every installable dependency has a kind-matching installer, sandbox-resident none', () => {
  for (const id of DEPENDENCY_IDS) {
    const installer = installerFor(id);
    const kind = DEPENDENCIES[id].kind;
    if (kind === 'sandbox-resident') {
      assert.equal(installer, null, `${id} is sandbox-resident: the host never manages it`);
      continue;
    }
    assert.ok(installer, `${id} must have an installer in DEP_INSTALLERS`);
    assert.equal(installer.kind, kind, `${id}'s installer kind must match the catalog`);
    assert.ok(installer.escapeHatch.length > 0, `${id}'s no-receipt refusal names an escape hatch`);
  }
});

test('installers: a successful gateway install records its tier in a receipt', { skip: isWin }, async () => {
  const home = tempHome();
  const savedHome = process.env.HOME;
  const savedReceiptHome = process.env.HUAWEICLOUD_HOME;
  const savedPath = process.env.PATH;
  try {
    process.env.HOME = home;
    process.env.HUAWEICLOUD_HOME = home;
    writeExecutable(join(home, '.local', 'bin', 'uv'));
    process.env.PATH = `/usr/bin${delimiter}${join(home, '.local', 'bin')}`;
    const result = await installGatewayTool();
    assert.deepEqual(result, { ok: true, tier: 'uv' });
    const receipt = readReceipt('open-mcp-gateway');
    assert.equal(receipt?.binary, 'open-mcp-gateway');
    assert.equal(receipt?.provisioner, 'devkit');
    assert.equal(receipt?.tier, 'uv');
    assert.ok(!Number.isNaN(Date.parse(receipt?.installedAt ?? '')), 'installedAt is a real ISO timestamp');
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedReceiptHome === undefined) delete process.env.HUAWEICLOUD_HOME;
    else process.env.HUAWEICLOUD_HOME = savedReceiptHome;
    process.env.PATH = savedPath;
  }
});

test('installers: installKooCli writes an hcloud receipt after a verified install', { skip: isWin }, () => {
  const home = tempHome();
  const fakeBin = fixtureDir('dep-provision-fakebin-');
  // Fake curl writes the "tarball"; fake tar "extracts" an hcloud binary
  // into the scratch dir installKooCli passes via -C; the real mv then
  // places it under the fake HOME.
  writeFileSync(join(fakeBin, 'curl'), '#!/bin/sh\necho fake-tarball > "$4"\n');
  chmodSync(join(fakeBin, 'curl'), 0o755);
  writeFileSync(
    join(fakeBin, 'tar'),
    '#!/bin/sh\ndir="$4"\nmkdir -p "$dir"\nprintf \'#!/bin/sh\\n\' > "$dir/hcloud"\nchmod +x "$dir/hcloud"\n',
  );
  chmodSync(join(fakeBin, 'tar'), 0o755);
  const res = spawnSync(process.execPath, [setupCli, 'dep', 'install', 'hcloud'], {
    cwd: root,
    env: {
      ...process.env,
      HOME: home,
      HUAWEICLOUD_HOME: home,
      PATH: `${fakeBin}${delimiter}/usr/bin${delimiter}/bin`,
    },
    encoding: 'utf8',
    timeout: 120000,
  });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /Install complete/);
  const placed = join(home, '.local', 'bin', 'hcloud');
  assert.ok(existsSync(placed), 'the fake install placed the binary');
  const receipt = readReceipt('hcloud', join(home, '.config', 'huaweicloud', 'deps'));
  assert.ok(receipt, 'the verified install wrote a receipt');
  assert.equal(receipt?.path, placed);
  assert.equal(receipt?.provisioner, 'devkit');
});

test('installers: an already-present binary writes no receipt', async () => {
  const home = tempHome();
  const savedReceiptHome = process.env.HUAWEICLOUD_HOME;
  const out = collector();
  try {
    process.env.HUAWEICLOUD_HOME = home;
    await provisionDependencies(['hcloud'], {
      log: out.log,
      probeHcloud: () => ({ status: 'ok', installed: true, installedVersion: '7.2.12' }),
      installKooCli: async () => true,
    });
    assert.match(out.text(), /hcloud: present \(7\.2\.12\), skipping install/);
    // The skip path never reaches an installer, so no receipt can appear.
    assert.equal(readReceipt('hcloud'), null);
  } finally {
    if (savedReceiptHome === undefined) delete process.env.HUAWEICLOUD_HOME;
    else process.env.HUAWEICLOUD_HOME = savedReceiptHome;
  }
});

// ---- dep CLI: status/install parsing through the real bin ----

function runDep(args: string[], env: Record<string, string | undefined> = {}) {
  return spawnSync(process.execPath, [setupCli, 'dep', ...args], {
    cwd: root,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 60000,
  });
}

test('dep install with a bogus id errors and names the valid ids', () => {
  const res = runDep(['install', 'bogus']);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /Unknown dependency id: bogus/);
  assert.match(res.stderr, /Valid dependency ids: hcloud, open-mcp-gateway, devbridge/);
});

test('dep install without an id errors with the missing-id message', () => {
  const res = runDep(['install']);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /Unknown dependency id: \(missing\)/);
});

test('dep install devbridge refuses with the in-sandbox pointer', () => {
  const res = runDep(['install', 'devbridge']);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /devbridge ships inside the cloud sandbox; the host never installs or removes it\./);
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

// ---- install/update wiring through the real installer ----

function cliEnv(home: string, extra: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    HOMEDRIVE: home.slice(0, 2),
    HOMEPATH: home.slice(2),
    HUAWEICLOUD_DEVKIT_SKIP_OFFICEACE_DETECT: '1',
  };
  // These tests reach `install --target opencode` (the XDG-aware config
  // root) and `uninstall --target all` (uninstallCodex's CODEX_HOME-keyed
  // cache cleanup, uninstallHermes's HERMES_HOME-keyed payload removal)
  // with the ambient PATH; ambient home overrides would write/delete real
  // state on a dev machine.
  for (const key of [
    'ATOMCODE_HOME',
    'DSH_HOME',
    'HERMES_HOME',
    'HUAWEICLOUD_HOME',
    'OFFICE_CLAW_CONFIG_ROOT',
    'XDG_CONFIG_HOME',
    'CODEX_HOME',
  ]) {
    delete env[key];
  }
  return { ...env, ...extra };
}

function runSetupCli(
  args: string[],
  home: string,
  extra: Record<string, string | undefined> = {},
): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [setupCli, ...args], {
    cwd: fixtureDir('dep-provision-cwd-'),
    env: cliEnv(home, extra),
    encoding: 'utf8',
    // Install-bearing: cold fake-HOME undici fetch needs the 240s class.
    timeout: 240000,
  });
}

function runInstall(args: string[]): SpawnSyncReturns<string> {
  return runSetupCli(args, tempHome());
}

test('install provisions pack binaries after the per-target loop', () => {
  const res = runInstall(['install', '--target', 'opencode']);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /Provisioning pack binaries \(enabled packs: \d+\)/);
  assert.match(res.stdout, /devbridge: sandbox-resident/);
});

test('install --skip-binaries suppresses the provisioning pass', () => {
  const res = runInstall(['install', '--target', 'opencode', '--skip-binaries']);
  assert.equal(res.status, 0, res.stderr);
  assert.doesNotMatch(res.stdout, /Provisioning pack binaries/);
});

// ---- dep uninstall through the real CLI ----

test('dep uninstall with a bogus id errors and names the valid ids', () => {
  const res = runDep(['uninstall', 'bogus']);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /Unknown dependency id: bogus/);
  assert.match(res.stderr, /Valid dependency ids: hcloud, open-mcp-gateway, devbridge/);
});

test('dep uninstall devbridge refuses with the in-sandbox pointer', () => {
  const res = runDep(['uninstall', 'devbridge']);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /devbridge ships inside the cloud sandbox; the host never installs or removes it\./);
});

test('dep uninstall hcloud without a receipt refuses and points at --clean-kocli', () => {
  const home = tempHome();
  const emptyPath = fixtureDir('dep-provision-path-');
  const res = runSetupCli(['dep', 'uninstall', 'hcloud'], home, { PATH: emptyPath, HUAWEICLOUD_HOME: home });
  assert.equal(res.status, 1, res.stderr);
  assert.match(res.stderr, /Refusing to uninstall hcloud: no devkit install receipt/);
  assert.match(res.stderr, /uninstall --target all --clean-kocli/);
  const depsDir = join(home, '.config', 'huaweicloud', 'deps');
  assert.equal(existsSync(join(depsDir, 'hcloud.json')), false, 'a refusal writes no receipt');
  assert.equal(existsSync(join(depsDir, 'lock')), false, 'the decision lock is released on refusal');
});

test('dep uninstall hcloud with a receipt removes exactly the placed binary', () => {
  const home = tempHome();
  const emptyPath = fixtureDir('dep-provision-path-');
  const placed = join(home, '.local', 'bin', 'hcloud');
  writeExecutable(placed);
  writeReceipt(hcloudReceiptAt(placed), join(home, '.config', 'huaweicloud', 'deps'));
  const res = runSetupCli(['dep', 'uninstall', 'hcloud'], home, { PATH: emptyPath, HUAWEICLOUD_HOME: home });
  assert.equal(res.status, 0, res.stderr);
  assert.ok(res.stdout.includes(`Removed the devkit-installed hcloud binary: ${placed}`), res.stdout);
  assert.match(res.stdout, /~\/\.hcloud credentials and config were not touched/);
  assert.equal(existsSync(placed), false);
  assert.equal(readReceipt('hcloud', join(home, '.config', 'huaweicloud', 'deps')), null);
});

test('dep uninstall hcloud refuses while an installed target still requires it', () => {
  const home = tempHome();
  // Install with the real PATH (the installer needs npm); the uninstall run
  // then uses an empty PATH so codex detection cannot widen the union.
  const installRes = runSetupCli(['install', '--target', 'opencode', '--packs', 'huaweicloud-cli'], home);
  assert.equal(installRes.status, 0, installRes.stderr);
  const emptyPath = fixtureDir('dep-provision-path-');
  // A receipt exists — the refusal must still fire because the installed
  // target's pack surface requires hcloud.
  writeReceipt(hcloudReceiptAt(join(home, '.local', 'bin', 'hcloud')), join(home, '.config', 'huaweicloud', 'deps'));
  const res = runSetupCli(['dep', 'uninstall', 'hcloud'], home, { PATH: emptyPath, HUAWEICLOUD_HOME: home });
  assert.equal(res.status, 1, res.stderr);
  assert.match(res.stderr, /Refusing to uninstall hcloud: required by enabled pack\(s\) huaweicloud-cli/);
  assert.match(res.stderr, /installed targets: OpenCode/);
  assert.match(res.stderr, /Remove or trim those targets first/);
});

// ---- --clean-kocli through the real CLI ----

test('uninstall --clean-kocli clears the devkit hcloud receipt with the binary', () => {
  const home = tempHome();
  const emptyPath = fixtureDir('dep-provision-path-');
  const placed = join(home, '.local', 'bin', 'hcloud');
  writeExecutable(placed);
  const depsDir = join(home, '.config', 'huaweicloud', 'deps');
  writeReceipt(hcloudReceiptAt(placed), depsDir);
  const res = runSetupCli(['uninstall', '--target', 'all', '--clean-kocli'], home, {
    PATH: emptyPath,
    HUAWEICLOUD_HOME: home,
  });
  assert.equal(res.status, 0, res.stderr);
  assert.ok(res.stdout.includes(`KooCLI removed: ${placed}`), res.stdout);
  assert.ok(res.stdout.includes('Cleared the devkit hcloud install receipt.'), res.stdout);
  assert.equal(existsSync(placed), false, 'the binary is removed');
  assert.equal(readReceipt('hcloud', depsDir), null, 'the receipt does not outlive the binary');
});

test('uninstall --clean-kocli keeps the receipt when the attributed binary survives the pass', () => {
  const home = tempHome();
  const emptyPath = fixtureDir('dep-provision-path-');
  // The macOS shape: the receipt names /usr/local/bin/hcloud, which
  // removeKooCli never touches (it only removes ~/.local/bin/hcloud,
  // ~/hcloud/hcloud[.exe], and ~/.hcloud). Burning the receipt here would
  // defeat `dep uninstall hcloud` forever while the binary lives.
  const placed = join(home, 'usr-local', 'hcloud');
  writeExecutable(placed);
  const depsDir = join(home, '.config', 'huaweicloud', 'deps');
  writeReceipt(hcloudReceiptAt(placed), depsDir);
  const res = runSetupCli(['uninstall', '--target', 'all', '--clean-kocli'], home, {
    PATH: emptyPath,
    HUAWEICLOUD_HOME: home,
  });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(existsSync(placed), true, 'the binary outside removeKooCli\u2019s scope survives');
  assert.ok(readReceipt('hcloud', depsDir), 'the receipt survives with the binary');
  assert.ok(
    res.stdout.includes(`Kept the devkit hcloud install receipt: the recorded binary (${placed}) still exists`),
    res.stdout,
  );
  assert.ok(res.stdout.includes('`dep uninstall hcloud` can still remove it'), res.stdout);
  assert.ok(!res.stdout.includes('Cleared the devkit hcloud install receipt.'), res.stdout);
});

// ---- --clean-gateway through the real CLI ----

// A fake uv standing in for `uv tool uninstall`: it records its arguments
// and removes the gateway binary, which is what the real tool does to the
// symlink it placed.
function writeFakeUv(home: string): string {
  const log = join(home, 'uv-args.log');
  const uv = join(home, '.local', 'bin', 'uv');
  mkdirSync(join(uv, '..'), { recursive: true });
  writeFileSync(
    uv,
    `#!/bin/sh\necho "$@" >> "${log}"\nrm -f "${join(home, '.local', 'bin', `huaweicloud-open-mcp${exeSuffix}`)}"\n`,
    'utf8',
  );
  chmodSync(uv, 0o755);
  return log;
}

test(
  'uninstall --target all --clean-gateway removes the devkit-installed gateway via its tier',
  { skip: isWin },
  () => {
    const home = tempHome();
    const log = writeFakeUv(home);
    const gatewayBin = join(home, '.local', 'bin', `huaweicloud-open-mcp${exeSuffix}`);
    writeExecutable(gatewayBin);
    const depsDir = join(home, '.config', 'huaweicloud', 'deps');
    writeReceipt(gatewayReceiptWithTier('uv'), depsDir);
    const res = runSetupCli(['uninstall', '--target', 'all', '--clean-gateway'], home);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(readFileSync(log, 'utf8').trim(), 'tool uninstall huaweicloud-open-mcp');
    assert.equal(existsSync(gatewayBin), false, 'the gateway binary is removed');
    assert.equal(readReceipt('open-mcp-gateway', depsDir), null, 'the receipt is cleared');
  },
);

test('uninstall --target all --clean-gateway selects only the gateway', { skip: isWin }, () => {
  const home = tempHome();
  writeFakeUv(home);
  const gatewayBin = join(home, '.local', 'bin', `huaweicloud-open-mcp${exeSuffix}`);
  writeExecutable(gatewayBin);
  writeExecutable(join(home, '.local', 'bin', 'hcloud'));
  writeFileSync(join(home, '.obsutilconfig'), 'ak=x\nsk=y\n', 'utf8');
  const depsDir = join(home, '.config', 'huaweicloud', 'deps');
  writeReceipt(gatewayReceiptWithTier('uv'), depsDir);
  const res = runSetupCli(['uninstall', '--target', 'all', '--clean-gateway'], home);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(existsSync(gatewayBin), false, 'the gateway binary is removed');
  assert.ok(existsSync(join(home, '.local', 'bin', 'hcloud')), 'KooCLI is kept without its flag');
  assert.ok(existsSync(join(home, '.obsutilconfig')), 'OBS config is kept without its flag');
  assert.doesNotMatch(res.stdout, /已保留/, 'a partial selection prints no keep-all message');
});

test('uninstall --target all --clean-gateway with nothing devkit-placed is a calm no-op', () => {
  const home = tempHome();
  const emptyPath = fixtureDir('dep-provision-path-');
  const res = runSetupCli(['uninstall', '--target', 'all', '--clean-gateway'], home, { PATH: emptyPath });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /No devkit-managed Open MCP Gateway found \(nothing to remove\)\./);
  assert.doesNotMatch(res.stdout, /Refusing to uninstall open-mcp-gateway/);
});

test('uninstall --target all --clean-gateway with a user-managed binary warns and keeps it', () => {
  const home = tempHome();
  const gatewayBin = join(home, '.local', 'bin', `huaweicloud-open-mcp${exeSuffix}`);
  writeExecutable(gatewayBin);
  const res = runSetupCli(['uninstall', '--target', 'all', '--clean-gateway'], home);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /Refusing to uninstall open-mcp-gateway: no devkit install receipt/);
  assert.match(res.stdout, /uv tool uninstall huaweicloud-open-mcp/);
  assert.ok(existsSync(gatewayBin), 'a user-managed gateway is never removed');
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

test('dep uninstall open-mcp-gateway refuses while an installed target still requires it', () => {
  const home = tempHome();
  const installRes = runSetupCli(['install', '--target', 'opencode', '--packs', 'huaweicloud-open-mcp'], home);
  assert.equal(installRes.status, 0, installRes.stderr);
  const gatewayBin = join(home, '.local', 'bin', `huaweicloud-open-mcp${exeSuffix}`);
  writeExecutable(gatewayBin);
  const depsDir = join(home, '.config', 'huaweicloud', 'deps');
  writeReceipt(gatewayReceiptWithTier('uv'), depsDir);
  const emptyPath = fixtureDir('dep-provision-path-');
  const res = runSetupCli(['dep', 'uninstall', 'open-mcp-gateway'], home, { PATH: emptyPath, HUAWEICLOUD_HOME: home });
  assert.equal(res.status, 1, res.stderr);
  assert.match(
    res.stderr,
    /Refusing to uninstall open-mcp-gateway: required by enabled pack\(s\) huaweicloud-open-mcp/,
  );
  assert.match(res.stderr, /installed targets: OpenCode/);
  assert.ok(readReceipt('open-mcp-gateway', depsDir), 'the refusal keeps the receipt');
  assert.ok(existsSync(gatewayBin), 'the required gateway binary is kept');
});

test('uninstall --target all --clean-global is idempotent for the gateway', { skip: isWin }, () => {
  const home = tempHome();
  writeFakeUv(home);
  const gatewayBin = join(home, '.local', 'bin', `huaweicloud-open-mcp${exeSuffix}`);
  writeExecutable(gatewayBin);
  const depsDir = join(home, '.config', 'huaweicloud', 'deps');
  writeReceipt(gatewayReceiptWithTier('uv'), depsDir);
  // A near-empty PATH: the runner's PATH could carry an ambient
  // huaweicloud-open-mcp, which would make run 2 resolve persistent and
  // refuse instead of staying a no-op, while a fully empty PATH would leave
  // the fake uv without rm in run 1. /usr/bin and /bin split the difference.
  const stubPath = fixtureDir('dep-provision-path-');
  const envPath = `${stubPath}${delimiter}/usr/bin${delimiter}/bin`;
  const first = runSetupCli(['uninstall', '--target', 'all', '--clean-global'], home, { PATH: envPath });
  assert.equal(first.status, 0, first.stderr);
  assert.equal(existsSync(gatewayBin), false, 'the first run removes the gateway');
  const second = runSetupCli(['uninstall', '--target', 'all', '--clean-global'], home, { PATH: envPath });
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /No devkit-managed Open MCP Gateway found \(nothing to remove\)\./);
  assert.doesNotMatch(second.stdout, /Refusing to uninstall open-mcp-gateway/);
});

// ---- doctor's pack-binary section renders from the dependency model ----

test('doctor renders devbridge and PACK_USES warnings for a sandbox-only trim', () => {
  const home = tempHome();
  const installRes = runSetupCli(['install', '--target', 'opencode', '--packs', 'sandbox'], home);
  assert.equal(installRes.status, 0, installRes.stderr);
  // Empty PATH neutralizes codex detection (the neighboring dep-uninstall
  // test's precedent), so the union is exactly the installed target's trim.
  const emptyPath = fixtureDir('dep-provision-path-');
  const res = runSetupCli(['doctor'], home, { PATH: emptyPath, HUAWEICLOUD_HOME: home });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /devbridge: sandbox-resident, not probed host-side/);
  assert.match(res.stdout, /Pack sandbox uses discovery \(soft dependency\) but it is disabled/);
  assert.match(res.stdout, /Pack sandbox uses obs \(soft dependency\) but it is disabled/);
  assert.doesNotMatch(res.stdout, /open-mcp-gateway /, 'the gateway is outside this trim');
  assert.match(res.stdout, /hcloud CLI installed/, 'the dedicated hcloud block still renders');
});

test('doctor reports no pack dependencies for a core-only trim', () => {
  const home = tempHome();
  const installRes = runSetupCli(['install', '--target', 'opencode', '--packs', 'core'], home);
  assert.equal(installRes.status, 0, installRes.stderr);
  const emptyPath = fixtureDir('dep-provision-path-');
  const res = runSetupCli(['doctor'], home, { PATH: emptyPath, HUAWEICLOUD_HOME: home });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /Pack dependencies: none required/);
  assert.doesNotMatch(res.stdout, /devbridge: sandbox-resident/);
  assert.doesNotMatch(res.stdout, /Pack .* uses .* soft dependency/);
});

test('doctor undici check counts the atomcode payload dir', () => {
  const home = tempHome();
  // Only the atomcode plugin dir carries undici; every other target's
  // node_modules is absent, so the check passes only when atomcode is on
  // the doctor's undici list (installAtomCode runs installRuntimeDeps).
  mkdirSync(join(home, '.atomcode', 'huaweicloud-plugins', 'node_modules', 'undici'), { recursive: true });
  const emptyPath = fixtureDir('dep-provision-path-');
  const res = runSetupCli(['doctor'], home, { PATH: emptyPath, HUAWEICLOUD_HOME: home });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /\[PASS\].*Runtime deps \(undici\) installed/);
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
  const res = runSetupCli(['doctor'], home, { PATH: emptyPath, HUAWEICLOUD_HOME: home });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /\[PASS\].*MCP server installed/);
  assert.match(res.stdout, /MCP server can start \(OpenClaw\)/);
  assert.match(res.stdout, /\[PASS\].*Runtime deps \(undici\) installed/);
  assert.match(res.stdout, /\[PASS\].*Safety policy installed/);
  // The chain prints the target label only in its failure message; with
  // openclaw the only configured MCP surface present, a PASS here proves
  // the openclaw branch matched.
  assert.match(res.stdout, /\[PASS\].*MCP configured/);
  assert.match(res.stdout, /请重启 OpenClaw/);
});

// ---- the codex probe's fail-safe polarity at the uninstall safety gate ----

// A codex stub on PATH: --version answers like a real codex CLI (so the
// existence gate passes), and `plugin list --json` either emits a valid
// list without the devkit plugin ('clean') or fails with unparseable
// output ('broken' — the exit-1/timeout/garbage shape).
function writeCodexStub(behavior: 'clean' | 'broken'): string {
  const stubDir = fixtureDir('dep-provision-codex-');
  const list = behavior === 'clean' ? 'echo \'{"installed":[],"available":[]}\'; exit 0' : "echo 'not-json'; exit 1";
  writeFileSync(
    join(stubDir, 'codex'),
    `#!/bin/sh\ncase "$1" in --version) echo "codex-cli stub 0.0.0"; exit 0;; esac\nif [ "$1" = "plugin" ] && [ "$2" = "list" ]; then ${list}; fi\nexit 1\n`,
    'utf8',
  );
  chmodSync(join(stubDir, 'codex'), 0o755);
  return stubDir;
}

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
  const doc = runSetupCli(['doctor'], home, { PATH: stubPath, HUAWEICLOUD_HOME: home });
  assert.equal(doc.status, 0, doc.stderr);
  assert.match(doc.stdout, /Packs \(Codex CLI\): all — codex plugin list could not be read/);
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
  const res = runSetupCli(['doctor'], home, { PATH: emptyPath, HUAWEICLOUD_HOME: home });
  assert.equal(res.status, 0, res.stderr);
  const unknownLines = res.stdout.match(/unknown id\(s\) in DEVKIT_PACKS/g) ?? [];
  assert.equal(unknownLines.length, 1, `exactly one unknown-id WARN line:\n${res.stdout}`);
  assert.doesNotMatch(
    res.stdout,
    /provisioning the full surface/,
    'the provisioning-flavored line stays in provisioning',
  );
  const tally = /Results: (\d+) pass, (\d+) warn, (\d+) fail/.exec(res.stdout);
  assert.ok(tally, `the Results tally rendered:\n${res.stdout}`);
  const warnTags = res.stdout.match(/\[WARN\]/g) ?? [];
  assert.equal(Number(tally[2]), warnTags.length, `shown WARN lines must equal the counted warn tally:\n${res.stdout}`);
});

// ---- findHcloudBin: delegation equivalence, env-injected ----

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
