import assert from 'node:assert/strict';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';

import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEPENDENCIES } from '../plugins/huaweicloud-core/src/lib/dependency-model.ts';

import type { PackId } from '../plugins/huaweicloud-core/src/lib/pack-types.ts';

import { type DepUninstallTargets } from '../plugins/huaweicloud-core/src/dep/provision.ts';
import { type DepReceipt } from '../plugins/huaweicloud-core/src/dep/receipts.ts';

import { fixtureDir } from './fixture-dir.ts';
import { npmCacheEnv } from './npm-cache.ts';

// Unit 2 (provision half) and Unit 3 (uninstall half + receipts) contracts,
// driven through the public functions and the real CLI: the resolution
// chain's tier order, the provisioning policy loop (with the
// installer/probe/resolution seams faked — no network, no real installs),
// the receipt-gated uninstall decision, the dep CLI surface, and
// findHcloudBin's delegation.

export const root = fileURLToPath(new URL('..', import.meta.url));
export const setupCli = join(root, 'bin', 'setup.cjs');
export const isWin = process.platform === 'win32';
export const exeSuffix = isWin ? '.exe' : '';

export const gatewayResolution = DEPENDENCIES['open-mcp-gateway'].resolution;

export function tempHome(): string {
  return fixtureDir('dep-provision-home-');
}

export function writeExecutable(path: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, isWin ? '@echo off\r\n' : '#!/bin/sh\n', 'utf8');
  if (!isWin) chmodSync(path, 0o755);
}

// eslint's no-control-regex flags the \x1b escape, but stripping ANSI color
// codes is exactly what this helper exists for.
export const ANSI_COLOR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
export const stripAnsi = (text: string): string => text.replace(ANSI_COLOR, '');

export function collector(): { lines: string[]; text(): string; log(_line: string): void } {
  const lines: string[] = [];
  return {
    lines,
    log: (line: string) => lines.push(line),
    text: () => stripAnsi(lines.join('\n')),
  };
}

// ---- dep-resolve: the one resolution chain, tier order pinned ----

// ---- provisionDependencies: the policy loop, seams faked ----

// ---- uninstallDependency: the receipt-gated decision, seams faked ----

export function emptyPathEnv(home: string): Record<string, string> {
  const emptyPath = fixtureDir('dep-provision-empty-');
  // USERPROFILE carries the hermetic home on win32 (platformHome reads it
  // there, HOME on unix); setting both keeps one helper platform-neutral.
  return { HOME: home, USERPROFILE: home, PATH: emptyPath };
}

export function hcloudReceiptAt(path: string): DepReceipt {
  return { binary: 'hcloud', provisioner: 'devkit', path, installedAt: '2026-10-08T00:00:00.000Z' };
}

export function gatewayReceiptWithTier(tier: 'uv' | 'pipx' | 'pip3'): DepReceipt {
  return { binary: 'open-mcp-gateway', provisioner: 'devkit', tier, installedAt: '2026-10-08T00:00:00.000Z' };
}

export const noTargets: DepUninstallTargets = { enabledPacks: new Set<PackId>(), carriers: [] };

// Root bypasses directory permissions, so EACCES cannot be staged as root.
export const cannotStageEacces = isWin || (typeof process.getuid === 'function' && process.getuid() === 0);

// ---- installers: the composition table agrees with the catalog ----

// ---- dep CLI: status/install parsing through the real bin ----

export function runDep(args: string[], env: Record<string, string | undefined> = {}) {
  return spawnSync(process.execPath, [setupCli, 'dep', ...args], {
    cwd: root,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 60000,
  });
}

// ---- install/update wiring through the real installer ----

export function cliEnv(
  home: string,
  extra: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    HOMEDRIVE: home.slice(0, 2),
    HOMEPATH: home.slice(2),
    HUAWEICLOUD_DEVKIT_SKIP_OFFICEACE_DETECT: '1',
    ...npmCacheEnv(),
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

export function runSetupCli(
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

export function runInstall(args: string[]): SpawnSyncReturns<string> {
  return runSetupCli(args, tempHome());
}

// ---- dep uninstall through the real CLI ----

// ---- --clean-kocli through the real CLI ----

// ---- --clean-gateway through the real CLI ----

// A fake uv standing in for `uv tool uninstall`: it records its arguments
// and removes the gateway binary, which is what the real tool does to the
// symlink it placed.
export function writeFakeUv(home: string): string {
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

// ---- doctor's pack-binary section renders from the dependency model ----

// ---- the codex probe's fail-safe polarity at the uninstall safety gate ----

// A codex stub on PATH: --version answers like a real codex CLI (so the
// existence gate passes), and `plugin list --json` either emits a valid
// list without the devkit plugin ('clean') or fails with unparseable
// output ('broken' — the exit-1/timeout/garbage shape).
export function writeCodexStub(behavior: 'clean' | 'broken'): string {
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

// ---- findHcloudBin: delegation equivalence, env-injected ----
