import { HCLOUD_ESCAPE_HATCH, installKooCli, printKooCliManualInstructions, uninstallHcloud } from './hcloud.ts';
import { GATEWAY_ESCAPE_HATCH, installGatewayTool, uninstallGateway } from './gateway.ts';
import { probeHcloud } from '../../hcloud-probe.ts';
import type {
  DepReceipt,
  DepUninstallResult,
  ManagedChildInstallResult,
  ResolvedUninstallContext,
} from '../receipts.ts';
import { DEPENDENCIES, type DependencyId } from '../../lib/dependency-model.ts';

// The dependency installer composition root: one installer object per
// installable dependency, keyed by id, kind-correlated to the dependency
// catalog by the InstallerFor conditional. The annotation (not satisfies)
// widens the table to its interface on purpose — every consumer
// (dep/provision.ts's policy loop and uninstall gate, setup-cli's dep
// command) wants CliDepInstaller / ManagedChildDepInstaller, not literal
// types.
//
// The table is the extension point: declaring a new dependency in
// lib/dependency-model.ts without a matching entry here is a compile error
// (the mapped annotation demands a key for every DependencyId), and a
// wrong-kind installer is rejected the same way. sandbox-resident entries
// carry null — an explicit declaration that the host never manages them.
//
// One module per installable dependency (installers/hcloud.ts,
// installers/gateway.ts, a future installers/<id>.ts); this file only
// composes. It must stay zod-free: it compiles into the unbundled
// dist/setup-cli.js graph, where only undici exists at runtime.

export type Log = (_line: string) => void;

/** Presence facts the policy loop needs from a cli-kind probe. */
export interface CliDepPresence {
  status: string;
  installed: boolean;
  installedVersion?: string | null;
}

/**
 * A per-call CLI dependency's host lifecycle (kind: 'cli' in the catalog).
 * Presence is probed, not resolved; install downloads and places; the
 * non-TTY auto path prints the installer's own manual instructions through
 * the loop's log seam (never the installer itself — the tested contract is
 * "non-TTY never starts a download").
 */
export interface CliDepInstaller {
  kind: 'cli';
  /** Presence probe; privacy_pending counts as present (terminal action). */
  probe(this: void): CliDepPresence;
  /** Download/extract/place. Downloads on non-TTY too — `dep install <id>` is the explicit CI path; only provisioning policy gates on tty. */
  install(this: void, _opts: { tty: boolean }): Promise<boolean>;
  /** The pinned manual commands printed when auto-install cannot run. */
  manualInstructions(this: void, _log: Log): void;
  /** The no-receipt refusal's escape-hatch sentence. */
  escapeHatch: string;
  /**
   * Receipt-gated removal. Receipts are untrusted input: escalate sudo -n
   * only onto this installer's own known landing sites (the catalog's
   * platform candidates ∪ the paths this installer places — precedent:
   * hcloudInstallLandingSites), and never delete an env-tier (user-override)
   * resolution. AGENTS.md's adding-a-dependency checklist repeats both.
   */
  uninstall(this: void, _receipt: DepReceipt, _dir: string, _ctx: ResolvedUninstallContext): DepUninstallResult;
}

/**
 * A managed child of the MCP server (kind: 'managed-child' in the catalog).
 * Presence is resolution-tier semantics (persistent tier = present, fallback
 * = absent), owned by the loop's shared resolve seam, so the installer has
 * no probe member. The install outcome is the shared
 * ManagedChildInstallResult (receipts.ts); the gateway installer refines
 * its tier to its own tool vocabulary.
 */
export interface ManagedChildDepInstaller {
  kind: 'managed-child';
  install(this: void): Promise<ManagedChildInstallResult>;
  /** The confirm-prompt suffix naming the concrete install tools. */
  confirmPromptSuffix: string;
  /** The no-receipt refusal's escape-hatch sentence. */
  escapeHatch: string;
  uninstall(this: void, _receipt: DepReceipt, _dir: string, _ctx: ResolvedUninstallContext): DepUninstallResult;
}

export type DepInstaller = CliDepInstaller | ManagedChildDepInstaller;

// kind-correlated installer typing: the catalog's kind for K decides the
// installer shape K must carry, sandbox-resident maps to null, and any
// future fourth kind maps to never — a compile error at the table that
// forces the decision instead of silently misclassifying it.
type InstallerFor<K extends DependencyId> = (typeof DEPENDENCIES)[K]['kind'] extends 'sandbox-resident'
  ? null
  : (typeof DEPENDENCIES)[K]['kind'] extends 'cli'
    ? CliDepInstaller
    : (typeof DEPENDENCIES)[K]['kind'] extends 'managed-child'
      ? ManagedChildDepInstaller
      : never;

export const DEP_INSTALLERS: { [K in DependencyId]: InstallerFor<K> } = {
  hcloud: {
    kind: 'cli',
    probe: () => probeHcloud(),
    install: installKooCli,
    manualInstructions: printKooCliManualInstructions,
    escapeHatch: HCLOUD_ESCAPE_HATCH,
    uninstall: uninstallHcloud,
  },
  'open-mcp-gateway': {
    kind: 'managed-child',
    install: installGatewayTool,
    confirmPromptSuffix: '(uv tool install / pipx / pip)',
    escapeHatch: GATEWAY_ESCAPE_HATCH,
    uninstall: uninstallGateway,
  },
  devbridge: null,
};

// The one lookup every dispatch site shares. Null exactly for
// sandbox-resident ids — the same fact the catalog's kind records, read
// through the table so callers never compare ids by hand.
export function installerFor(id: DependencyId): DepInstaller | null {
  return DEP_INSTALLERS[id];
}
