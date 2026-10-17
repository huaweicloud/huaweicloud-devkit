import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';

import {
  readReceipt,
  receiptDir,
  withDepLock,
  type DepUninstallResult,
  type ManagedChildInstallResult,
  type ResolvedUninstallContext,
} from './receipts.ts';
import { DEP_INSTALLERS, installerFor, type CliDepPresence, type Log } from './installers/table.ts';
import { resolveDependencyCommand, type ResolvedDependency } from '../lib/dep-resolve.ts';
import {
  DEPENDENCIES,
  PACK_DEPENDENCIES,
  requiredDependencies,
  type DependencyId,
  type DependencySpec,
} from '../lib/dependency-model.ts';
import type { PackId } from '../lib/pack-types.ts';

// The dep subsystem's decision core, the half that is dependency-agnostic
// on purpose: the provisioning policy loop (presence → policy → install,
// kind-branched because kind is the process model and therefore the policy
// shape) and the receipt-gated uninstall decision (pack-requirement gate →
// receipt gate → per-dependency uninstaller, under the receipt lock).
// Per-dependency behavior lives in installers/hcloud.ts and
// installers/gateway.ts, composed by the DEP_INSTALLERS table in
// installers/table.ts; every dispatch resolves per-id through installerFor
// and every action default comes from the table entry, so a second member
// of an existing kind provisions through its own installer out of the box.
// Node builtins plus the zod-free lib/ and dep/receipts modules only — this
// module compiles into the unbundled dist/setup-cli.js graph, where only
// undici exists at runtime.
//
// The seams, kept injectable for hermetic tests (test/dep-provision.test.ts):
// the policy loop's probe/install/resolve/confirm seams and the uninstall
// side's receiptsDir/env/resolveDependency/runCommand seams. The three
// action seams (probeHcloud, installKooCli, installGateway) are named for
// the one member of their kind that exists today and capture ONLY that
// dependency's iteration (identity comparison against the table entry); any
// other member of the same kind runs its own installer. Collapsing the
// names into per-id overrides is a cosmetic rename for the day a second
// member lands. Everything else (policy, output, ordering, refusal
// wording) is the contract under test.

const INFO = '  \x1b[36m[INFO]\x1b[0m';
const WARN = '  \x1b[33m[WARN]\x1b[0m';

// ---------------------------------------------------------------------------
// Provisioning: the policy loop over requiredDependencies output.
// ---------------------------------------------------------------------------

/** Optional overrides; each defaults to the real implementation. */
export interface ProvisionOptions {
  tty?: boolean;
  env?: NodeJS.ProcessEnv;
  log?: Log;
  probeHcloud?: () => CliDepPresence;
  installKooCli?: (_opts: { tty: boolean }) => Promise<boolean>;
  resolveDependency?: (_id: DependencyId, _env: NodeJS.ProcessEnv) => ResolvedDependency | null;
  installGateway?: () => Promise<ManagedChildInstallResult>;
  confirm?: (_prompt: string) => Promise<boolean>;
}

async function defaultConfirm(prompt: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise<boolean>((ok) => {
    rl.question(`${prompt} [y/N] `, (answer) => {
      rl.close();
      const normalized = answer.trim().toLowerCase();
      ok(normalized === 'y' || normalized === 'yes');
    });
  });
}

// The shared default for the resolve seam: the single resolution chain over
// the catalog's data. Provisioning and uninstall inject the same thing.
function defaultResolveDependency(id: DependencyId, env: NodeJS.ProcessEnv): ResolvedDependency | null {
  const entry = DEPENDENCIES[id];
  return entry && 'resolution' in entry ? resolveDependencyCommand(entry.resolution, env) : null;
}

export async function provisionDependencies(ids: Iterable<DependencyId>, opts: ProvisionOptions = {}): Promise<void> {
  const tty = opts.tty === true;
  const env = opts.env ?? process.env;
  const log = opts.log ?? console.log;
  const resolve = opts.resolveDependency ?? defaultResolveDependency;
  const confirm = opts.confirm ?? defaultConfirm;

  for (const id of ids) {
    // The loop reasons over the DependencySpec interface, not the catalog's
    // const literals: policy code must handle any legal spec, and the
    // literal types would narrow installPolicy to today's values.
    const spec: DependencySpec | undefined = DEPENDENCIES[id];
    if (!spec) continue;
    try {
      if (spec.kind === 'sandbox-resident') {
        log(`${INFO} ${id}: sandbox-resident (lives inside the cloud sandbox; the host never manages it)`);
        continue;
      }
      const installer = installerFor(id);
      if (installer === null) {
        // InstallerFor makes this unreachable in compiled code; fail loudly
        // rather than silently skipping a required binary.
        log(`${WARN} ${id}: no installer in DEP_INSTALLERS; skipping provisioning`);
        continue;
      }

      if (installer.kind === 'cli') {
        // The probeHcloud/installKooCli overrides are named for hcloud, the
        // one cli-kind member today: they capture only hcloud's iteration.
        // Every other cli-kind dependency probes and installs through its
        // own table entry.
        const probe = installer === DEP_INSTALLERS.hcloud ? (opts.probeHcloud ?? installer.probe) : installer.probe;
        const installCli =
          installer === DEP_INSTALLERS.hcloud ? (opts.installKooCli ?? installer.install) : installer.install;
        // Presence is the question; a version mismatch stays doctor's
        // warning territory. privacy_pending also counts as present: the
        // binary exists, acceptance is a terminal action.
        const presence = probe();
        if (presence.installed) {
          const version = presence.installedVersion ? ` (${presence.installedVersion})` : '';
          log(`${INFO} ${id}: present${version}, skipping install`);
          continue;
        }
        if (spec.installPolicy === 'auto') {
          if (tty) {
            const ok = await installCli({ tty });
            log(
              ok ? `${INFO} ${id}: installed` : `${WARN} ${id}: install incomplete; see the manual instructions above`,
            );
          } else {
            // Network-free non-interactive contract: print the pinned
            // manual command, never start a download. The instructions are
            // the dependency's own — through the installer, never hardcoded
            // here.
            log(`${WARN} ${id}: not found; auto-install needs an interactive session`);
            installer.manualInstructions(log);
          }
          continue;
        }
        log(`${INFO} ${id}: not found. ${spec.installHint}`);
        continue;
      }

      if (installer.kind === 'managed-child') {
        // The installGateway override is named for the gateway, the one
        // managed-child member today: it captures only the gateway's
        // iteration.
        const installManagedChild =
          installer === DEP_INSTALLERS['open-mcp-gateway']
            ? (opts.installGateway ?? installer.install)
            : installer.install;
        const resolved = resolve(id, env);
        // Only a PERSISTENT tier (env/candidate/path) counts as present; a
        // fallback-tier resolution does not, so policy 'prompt' still
        // offers the persistent install and the default install never
        // prompts everyone.
        if (resolved && resolved.tier !== 'fallback') {
          log(`${INFO} ${id}: present (${resolved.tier}: ${resolved.command})`);
          continue;
        }
        const hint = spec.installHint;
        // The fallback's command name (uvx) is catalog data, not installer
        // text: it derives from the resolution model so a future
        // managed-child dependency renders its own fallback correctly.
        const fallbackCommand = spec.resolution.fallback?.command;
        if (!tty) {
          log(
            resolved && fallbackCommand
              ? `${INFO} ${id}: running via ${fallbackCommand} (no persistent install). ${hint}`
              : `${INFO} ${id}: not found. ${hint}`,
          );
          continue;
        }
        const yes = await confirm(`Install the ${spec.title} persistently ${installer.confirmPromptSuffix}?`);
        if (!yes) {
          log(`${INFO} ${id}: skipped. ${hint}`);
          continue;
        }
        const result = await installManagedChild();
        log(
          result.ok
            ? `${INFO} ${id}: installed via ${result.tier}`
            : fallbackCommand
              ? `${WARN} ${id}: install failed; the ${fallbackCommand} fallback still applies. ${hint}`
              : `${WARN} ${id}: install failed. ${hint}`,
        );
        continue;
      }

      // Exhaustiveness: a third installer kind must fail to compile at the
      // never assignment in installers/table.ts's InstallerFor, and this
      // arm keeps the loop honest if one ever slips through.
      const exhaustive: never = installer;
      log(`${WARN} ${id}: unsupported installer kind ${String(exhaustive)}`);
    } catch (error) {
      log(`${WARN} ${id}: provisioning failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Receipt-gated uninstall, two call shapes over one decision core. The gated
// shape (`dep uninstall <id>`) derives the decision from the same model the
// installer used: the caller passes the effective pack union (setup-cli's
// packUnionReport — no second derivation exists), and uninstall refuses
// while any enabled pack requires the id. The forced shape
// (`uninstall --clean-*` flags) has no union to consult: the flag is the
// user's explicit answer, so the receipt gate alone decides. Either way the
// receipt gates deletion: devkit removes only what it placed and can prove
// it placed. Deletion scope is binary-only — ~/.hcloud credentials and
// config stay untouched (that broader cleanup belongs to the documented
// ungated escape hatch `uninstall --clean-kocli`).
// ---------------------------------------------------------------------------

export interface DepUninstallTargets {
  /** Effective pack union across installed targets (setup-cli's effectivePackUnion). */
  enabledPacks: ReadonlySet<PackId>;
  /** Per-target enabled packs, for refusal attribution (labels from packStatusReaders). */
  carriers: ReadonlyArray<{ label: string; packs: ReadonlySet<PackId> }>;
}

export interface DepUninstallOptions {
  env?: NodeJS.ProcessEnv;
  /** Receipt directory; defaults to the shared ~/.config/huaweicloud/deps convention. */
  receiptsDir?: string;
  resolveDependency?: (_id: DependencyId, _env: NodeJS.ProcessEnv) => ResolvedDependency | null;
  runCommand?: (
    _command: string,
    _args: readonly string[],
  ) => { status: number | null; stdout: string; stderr: string };
}

function defaultRunCommand(
  command: string,
  args: readonly string[],
): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(command, [...args], { encoding: 'utf8', timeout: 60_000, windowsHide: true });
  return { status: r.status ?? null, stdout: String(r.stdout || ''), stderr: String(r.stderr || '') };
}

// The shared refusal sentence for sandbox-resident ids — one wording
// consumed by both the spec gate and the table-agreement guard below.
function sandboxResidentRefusal(id: DependencyId): DepUninstallResult {
  return { ok: false, message: `${id} ships inside the cloud sandbox; the host never installs or removes it.` };
}

function requiringPacks(id: DependencyId, enabledPacks: ReadonlySet<PackId>): PackId[] {
  // The naming half of the refusal: the decision itself went through
  // requiredDependencies over the same edge table; this inverse lookup only
  // produces the pack names the refusal lists. Sorted so the line is
  // deterministic regardless of set order.
  return [...enabledPacks]
    .filter((pack) => (PACK_DEPENDENCIES[pack] as readonly DependencyId[]).includes(id))
    .sort((a, b) => a.localeCompare(b));
}

function specRefusal(id: DependencyId): DepUninstallResult | null {
  const spec = DEPENDENCIES[id];
  if (!spec) return { ok: false, message: `Unknown dependency id: ${id}` };
  if (spec.kind === 'sandbox-resident') {
    return sandboxResidentRefusal(id);
  }
  return null;
}

// The decision core both call shapes share: the receipt gate, the
// seam-normalized context, and the dispatch to the per-dependency
// uninstaller. No pack-requirement check lives here.
function placedUninstall(id: DependencyId, dir: string, opts: DepUninstallOptions): DepUninstallResult {
  const installer = installerFor(id);
  if (installer === null) {
    // specRefusal already refused sandbox-resident ids before this gate;
    // this arm is the table-agreement guard — same wording, one source.
    return sandboxResidentRefusal(id);
  }
  const receipt = readReceipt(id, dir);
  if (!receipt) {
    return {
      ok: false,
      message: `Refusing to uninstall ${id}: no devkit install receipt, so this devkit did not place it and will not remove it. ${installer.escapeHatch}`,
    };
  }
  // The seam defaults are applied exactly once, at the gate: installers
  // receive a fully-resolved context and never re-derive defaults
  // themselves. Injected overrides keep their precedence.
  const ctx: ResolvedUninstallContext = {
    env: opts.env ?? process.env,
    resolveDependency: opts.resolveDependency ?? defaultResolveDependency,
    runCommand: opts.runCommand ?? defaultRunCommand,
  };
  return installer.uninstall(receipt, dir, ctx);
}

export function uninstallDependency(
  id: DependencyId,
  targets: DepUninstallTargets,
  opts: DepUninstallOptions = {},
): DepUninstallResult {
  const refusal = specRefusal(id);
  if (refusal) return refusal;
  const dir = opts.receiptsDir ?? receiptDir();
  // The whole decision — requirement check, receipt read, deletion, receipt
  // removal — serializes against concurrent installs under the receipt lock.
  return withDepLock(() => {
    // The same derivation the installer used, never a second one: the
    // effective union's required-dependency set decides; requiringPacks only
    // names the packs for the refusal line.
    if (requiredDependencies(targets.enabledPacks).has(id)) {
      const requiring = requiringPacks(id, targets.enabledPacks);
      const carrierLabels = targets.carriers
        .filter((target) => [...target.packs].some((pack) => requiring.includes(pack)))
        .map((target) => target.label);
      const carriers = carrierLabels.length > 0 ? ` (installed targets: ${carrierLabels.join(', ')})` : '';
      return {
        ok: false,
        message: `Refusing to uninstall ${id}: required by enabled pack(s) ${requiring.join(', ')}${carriers}. Remove or trim those targets first: npx huaweicloud-devkit uninstall --target <agent>, or reinstall with --packs`,
      };
    }
    return placedUninstall(id, dir, opts);
  }, dir);
}

// The forced shape for the uninstall --clean-* flags: the user already
// answered "remove account-level tools", so no pack-requirement refusal
// applies. There is no union to consult — the receipt gate alone decides.
export function uninstallPlacedDependency(id: DependencyId, opts: DepUninstallOptions = {}): DepUninstallResult {
  const refusal = specRefusal(id);
  if (refusal) return refusal;
  const dir = opts.receiptsDir ?? receiptDir();
  return withDepLock(() => placedUninstall(id, dir, opts), dir);
}
