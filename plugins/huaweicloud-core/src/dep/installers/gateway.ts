import { spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  recordInstallReceipt,
  removeReceipt,
  type DepReceipt,
  type DepUninstallResult,
  type ResolvedUninstallContext,
} from '../receipts.ts';
import { lookupOnPath } from '../../lib/dep-resolve.ts';

// The open-mcp-gateway installer module: the package-manager tier chain
// (uv → pipx → pip3 --user), the tier receipts that make uninstall
// tier-aware, and the receipt-gated uninstall. One module per installable
// dependency; the composition table that dispatches to these lives in
// installers/table.ts, the policy loop and the uninstall decision core in
// ../provision.ts. This module must stay zod-free: it compiles into the
// unbundled dist/setup-cli.js graph, where only undici exists at runtime.

const WARN = '  \x1b[33m[WARN]\x1b[0m';

// Open MCP Gateway persistent installer. uv is preferred (fast, no PEP 668
// friction, installs into ~/.local/bin where the resolution chain looks),
// then pipx, then pip3 --user.

const GATEWAY_PACKAGE = 'huaweicloud-open-mcp';
const GATEWAY_INSTALL_TIMEOUT_MS = 300_000;

export type GatewayInstallTier = 'uv' | 'pipx' | 'pip3';

export interface GatewayInstallResult {
  ok: boolean;
  tier: GatewayInstallTier | null;
}

function findHostTool(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const exeSuffix = process.platform === 'win32' ? '.exe' : '';
  const home = process.platform === 'win32' ? homedir() : env.HOME || homedir();
  const local = join(home, '.local', 'bin', `${name}${exeSuffix}`);
  return existsSync(local) ? local : lookupOnPath(name, env);
}

function outputTail(text: string, maxLines = 4): string {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.slice(-maxLines).join('\n  ');
}

function reportInstallFailure(tool: string, status: number | null, stdout: string, stderr: string): void {
  console.log(`${WARN} ${tool} failed (exit ${status === null ? 'timeout/kill' : status})`);
  const tail = outputTail(`${stdout}\n${stderr}`);
  if (tail) console.log(`  ${tail}`);
}

export async function installGatewayTool(): Promise<GatewayInstallResult> {
  const uv = findHostTool('uv');
  if (uv) {
    console.log(`Installing ${GATEWAY_PACKAGE} via uv (${uv})...`);
    const r = spawnSync(uv, ['tool', 'install', GATEWAY_PACKAGE], {
      encoding: 'utf8',
      timeout: GATEWAY_INSTALL_TIMEOUT_MS,
      windowsHide: true,
    });
    if (r.status === 0) {
      recordInstallReceipt({
        binary: 'open-mcp-gateway',
        provisioner: 'devkit',
        tier: 'uv',
        installedAt: new Date().toISOString(),
      });
      return { ok: true, tier: 'uv' };
    }
    reportInstallFailure('uv tool install', r.status, String(r.stdout || ''), String(r.stderr || ''));
  }

  const pipx = findHostTool('pipx');
  if (pipx) {
    console.log(`Installing ${GATEWAY_PACKAGE} via pipx (${pipx})...`);
    const r = spawnSync(pipx, ['install', GATEWAY_PACKAGE], {
      encoding: 'utf8',
      timeout: GATEWAY_INSTALL_TIMEOUT_MS,
      windowsHide: true,
    });
    if (r.status === 0) {
      recordInstallReceipt({
        binary: 'open-mcp-gateway',
        provisioner: 'devkit',
        tier: 'pipx',
        installedAt: new Date().toISOString(),
      });
      return { ok: true, tier: 'pipx' };
    }
    reportInstallFailure('pipx install', r.status, String(r.stdout || ''), String(r.stderr || ''));
  }

  const pip3 = findHostTool('pip3');
  if (pip3) {
    console.log(`Installing ${GATEWAY_PACKAGE} via pip3 --user (${pip3})...`);
    const r = spawnSync(pip3, ['install', '--user', GATEWAY_PACKAGE], {
      encoding: 'utf8',
      timeout: GATEWAY_INSTALL_TIMEOUT_MS,
      windowsHide: true,
    });
    if (r.status === 0) {
      if (process.platform === 'win32') {
        console.log(`${WARN} pip --user puts the gateway in the Python Scripts dir, which may not be on PATH.`);
        console.log(`        Prefer uv/uvx (https://docs.astral.sh/uv/) so the gateway resolves everywhere.`);
      }
      recordInstallReceipt({
        binary: 'open-mcp-gateway',
        provisioner: 'devkit',
        tier: 'pip3',
        installedAt: new Date().toISOString(),
      });
      return { ok: true, tier: 'pip3' };
    }
    const out = `${r.stdout || ''}\n${r.stderr || ''}`;
    if (/externally-managed/i.test(out)) {
      console.log(`${WARN} pip3 refused the install (PEP 668 externally-managed environment).`);
      console.log(`        Use: uv tool install ${GATEWAY_PACKAGE}`);
    } else {
      reportInstallFailure('pip3 install --user', r.status, String(r.stdout || ''), String(r.stderr || ''));
    }
    return { ok: false, tier: 'pip3' };
  }

  console.log(`${WARN} No uv, pipx, or pip3 found. Install one first (recommended: uv — https://docs.astral.sh/uv/).`);
  return { ok: false, tier: null };
}

const GATEWAY_UNINSTALL_ARGS: Record<GatewayInstallTier, readonly string[]> = {
  uv: ['tool', 'uninstall', GATEWAY_PACKAGE],
  pipx: ['uninstall', GATEWAY_PACKAGE],
  // -y because dep uninstall runs where pip's confirmation prompt would hang
  // a non-TTY session (same discipline as obsutil's -f). No --user: pip
  // rejects it on uninstall (exit 2, verified on pip 24.0), and pip removes
  // from the user site when run as that user anyway.
  pip3: ['uninstall', '-y', GATEWAY_PACKAGE],
};

const GATEWAY_ESCAPE_HATCH =
  'Escape hatch: uv tool uninstall huaweicloud-open-mcp (or pipx uninstall huaweicloud-open-mcp / pip3 uninstall -y huaweicloud-open-mcp)';

export function uninstallGateway(receipt: DepReceipt, dir: string, ctx: ResolvedUninstallContext): DepUninstallResult {
  const env = ctx.env;
  const resolve = ctx.resolveDependency;
  const tier = receipt.tier;
  if (tier) {
    // Tier-aware: a bare rm would orphan uv/pipx tool metadata. The tier tool
    // that placed the gateway is the tool that knows how to withdraw it.
    const args = GATEWAY_UNINSTALL_ARGS[tier];
    const tool = findHostTool(tier, env);
    if (tool) {
      const r = ctx.runCommand(tool, args);
      if (r.status === 0) {
        removeReceipt('open-mcp-gateway', dir);
        return {
          ok: true,
          message: `Uninstalled the devkit-installed open-mcp-gateway via ${tier}: ${tool} ${args.join(' ')}`,
        };
      }
      const tail = outputTail(`${r.stdout}\n${r.stderr}`);
      const resolved = resolve('open-mcp-gateway', env);
      if (!resolved || resolved.tier === 'fallback') {
        // The tier tool refused because nothing is installed under it, and no
        // persistent binary resolves either: converged, receipt cleared.
        removeReceipt('open-mcp-gateway', dir);
        return {
          ok: true,
          message: `open-mcp-gateway was already gone (${tier} reported: ${tail || `exit ${r.status}`}); removed the receipt.`,
        };
      }
      return {
        ok: false,
        message: `${tier} uninstall failed (exit ${r.status ?? 'killed'}): ${tail || 'no output'}`,
        detail: [
          `A gateway binary still resolves at ${resolved.command}. Remove it manually (${GATEWAY_ESCAPE_HATCH}), then re-run dep uninstall open-mcp-gateway to clear the receipt.`,
        ],
      };
    }
  }
  // No usable tier, or the tier tool is gone: fall back to removing the
  // resolved binary directly, and say so. Candidate tier only — the env
  // override is the user's file, and a PATH hit is not provably devkit's.
  const resolved = resolve('open-mcp-gateway', env);
  if (resolved && resolved.tier === 'candidate') {
    try {
      rmSync(resolved.command);
    } catch (error) {
      return {
        ok: false,
        message: `Failed to remove ${resolved.command}: ${error instanceof Error ? error.message : String(error)}. Remove it manually, then re-run dep uninstall open-mcp-gateway to clear the receipt.`,
      };
    }
    removeReceipt('open-mcp-gateway', dir);
    return {
      ok: true,
      message: tier
        ? `${tier} is no longer installed, so its uninstall command cannot run; removed the gateway binary directly: ${resolved.command}`
        : `The receipt records no install tier; removed the gateway binary directly: ${resolved.command}`,
    };
  }
  removeReceipt('open-mcp-gateway', dir);
  return {
    ok: true,
    message: `open-mcp-gateway was already gone (no persistent install resolves); removed the stale receipt.`,
  };
}

export { GATEWAY_ESCAPE_HATCH };
