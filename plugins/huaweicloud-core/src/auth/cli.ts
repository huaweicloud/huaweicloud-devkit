// The unified-auth CLI family, extracted from setup-cli.ts: the `auth`
// command dispatch and its sync/status/reconcile subcommands. The
// interactive init flow lives in auth/init-cli.ts; the KooCLI profile
// configure/verify helpers and the status printers in
// auth/hcloud-profile.ts.

import { getAuthStatus, syncAuth } from './service.ts';
import { readLineQuestion } from '../lib/cli-io.ts';
import { BANNER } from '../lib/banner.ts';
import { parseTarget } from '../install-plan.ts';
import { cmdAuthInit } from './init-cli.ts';
import { printAuthStatus } from './hcloud-profile.ts';

// Narrow the parsed vault shape at this boundary. The guard returns the same
// object reference, so callers that pass it back to writeObsConfig/writeGlobalCredentials
// behave exactly as before.
interface StoredCredentials {
  ak?: unknown;
  sk?: unknown;
  securityToken?: unknown;
  region?: unknown;
}

export function asStoredCredentials(value: unknown): StoredCredentials | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

export async function cmdAuthReconcile(): Promise<void> {
  console.log(BANNER);
  console.log('HuaweiCloud DevKit Credential Reconciliation\n');

  const { scanState } = await import('./reconcile.ts');
  const state = scanState();
  // A broken S1 vault link suppresses the drift fingerprints, so it would
  // otherwise read as "consistent" while every credential consumer throws.
  if (state.s1RefError) {
    console.error(`  \x1b[31mS1 holds a secret ref the vault cannot resolve: ${state.s1RefError}\x1b[0m`);
    console.error(
      '  Fix the vault (npx huaweicloud-devkit secret list; check the master key) or replace the refs in ~/.config/huaweicloud/credentials.json with plaintext.',
    );
    process.exitCode = 1;
    return;
  }
  if (state.inconsistencies.length === 0) {
    console.log('All credential files are consistent. ✓');
    return;
  }

  const interactive = process.stdin.isTTY && process.stdout.isTTY;
  if (!interactive) {
    console.error(
      '\x1b[31mNon-interactive session. Cannot run interactive reconciliation. Use "npx huaweicloud-devkit auth sync" or run reconciliation in a real terminal.\x1b[0m',
    );
    process.exitCode = 1;
    return;
  }

  for (const inc of state.inconsistencies) {
    console.log(
      `  [${inc.store}] fingerprint ${inc.fingerprint} differs from S1 ${state.stores.s1Fingerprint}${inc.manualModified ? ' (manual modified)' : ''}`,
    );
  }
  const ask = await readLineQuestion('以 S1 为准同步到不一致文件? (y/N) ');
  if (!['y', 'Y', 'yes'].includes(ask.trim())) {
    console.log('Aborted.');
    return;
  }
  // Propagation delegates to syncAuth — the same seam-tested fan-out (S1
  // refs resolved BEFORE writing ~/.obsutilconfig and the KooCLI profile,
  // .last_sync fingerprinted from resolved values). A hand-rolled copy here
  // once escaped the seam and wrote literal secret:// refs into both
  // mirrors. Result interpretation keeps reconcile's best-effort contract:
  // a mirror-partial sync (OBS written, KooCLI absent/failed) is a soft
  // outcome with detail, not a hard failure — the same exit code the
  // hand-rolled version produced.
  const result = syncAuth('all');
  if (result.ok) {
    console.log('Done. .last_sync refreshed.');
    return;
  }
  if (result.obs?.configured) {
    console.log('  OBS synced ✓.');
    console.log(`  KooCLI sync did not complete: ${result.error}`);
    if (result.nextStep) console.log(`  Next: ${result.nextStep}`);
    console.log('Done. .last_sync was not refreshed because KooCLI sync did not complete.');
    return;
  }
  console.error(`  \x1b[31m${result.error}\x1b[0m`);
  if (result.nextStep) console.error(`  Next: ${result.nextStep}`);
  process.exitCode = 1;
}

export async function cmdAuthSync(): Promise<void> {
  const target = parseTarget();
  console.log(BANNER);
  console.log('Synchronizing Huawei Cloud authentication...\n');

  // Defer to syncAuth's structured result instead of a local pre-check: the
  // pre-check read only the S1 file, so the CLI never reached the
  // HDKIT_SYNC_S1_MISSING_SESSION_ACTIVE outcome (S1 empty + session-scoped
  // runtime/env credentials active) and kept telling an authenticated session
  // "No global credentials found" (loop round 2, seat-4 probe).
  const result = syncAuth(target);
  if (result.ok) {
    // Print the honest sync message, not an unconditional success line: the
    // #920 purge outcomes (profile reset failed / project-id not restored)
    // ride in hcloud.message and must reach the CLI user.
    console.log(result.hcloud.message);
  } else if (result.code) {
    // Structured #900 shape (incl. HDKIT_SYNC_S1_MISSING_SESSION_ACTIVE):
    // the human verdict plus the executable action beats a generic string.
    console.error(`${result.messageZh ?? result.error}\nNext: ${result.action ?? result.nextStep ?? ''}`);
    process.exitCode = 1;
  } else {
    console.error(result.error + (result.nextStep ? `\nNext: ${result.nextStep}` : ''));
    process.exitCode = 1;
  }
}

export async function cmdAuthStatus(): Promise<void> {
  const target = parseTarget();
  console.log(BANNER);
  console.log('HuaweiCloud DevKit Authentication Status\n');
  printAuthStatus(getAuthStatus(target));
}

export async function cmdAuth(): Promise<void> {
  const sub = (process.argv[3] || 'status').toLowerCase();
  if (sub === 'init' || sub === 'setup') return cmdAuthInit();
  if (sub === 'sync' || sub === 'refresh') return cmdAuthSync();
  if (sub === 'reconcile') return cmdAuthReconcile();
  return cmdAuthStatus();
}
