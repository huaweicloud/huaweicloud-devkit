import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import assert from 'node:assert/strict';

// Shared harness for the ledger lock's cross-process worker tests: the
// worker modes live inside test/approval-ledger.test.ts (a worker re-execs
// that file with a mode env and exits before any test registers), and the
// wedge/over-cap/contention tests in both battery files spawn them against
// one isolated HUAWEICLOUD_HOME. One place for the spawn shape and the
// claim wait, so the battery files do not grow clone copies of it.
export function spawnLedgerWorker(
  home: string,
  workerEnv: Record<string, string>,
  extraNodeArgs: string[] = [],
): ChildProcess {
  return spawn(process.execPath, ['--experimental-strip-types', ...extraNodeArgs, 'test/approval-ledger.test.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ...workerEnv,
      HUAWEICLOUD_HOME: home,
      NODE_TEST_CONTEXT: undefined,
      NODE_TEST_WORKER_ID: undefined,
    },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
}

// The ledger lock's claim pid file: withDepLock claims <root>/lock (the
// LOCK_DIR_NAME directory) with the pid inside it — the liveness signal the
// tests wait on before contending.
export function ledgerClaimPidFile(home: string): string {
  return join(home, '.config', 'huaweicloud', 'approval-consents-lock', 'lock', 'pid');
}

// Wait until the worker's lock claim is live (the pid file exists).
export async function waitForLedgerClaim(home: string, label: string, timeoutMs = 30_000): Promise<void> {
  const pidFile = ledgerClaimPidFile(home);
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(pidFile)) {
    assert.ok(Date.now() < deadline, `the ${label} never claimed the lock`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

// One contention child performing a single appendConsentEvent (the plain
// LEDGER_WORKER mode with PER_WORKER=1) — resolves on its clean exit.
export function contendOneAppend(home: string, tag: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawnLedgerWorker(home, { LEDGER_WORKER: tag, LEDGER_PER_WORKER: '1' });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`contender ${tag} exit ${code}`))));
    child.on('error', reject);
  });
}
