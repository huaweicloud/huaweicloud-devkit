import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { autoUpgradePaths, runAutoUpgrade, writeAutoUpgradeState } from './update-auto.mjs';

function arg(name, fallback = '') {
  const idx = process.argv.indexOf(name);
  return idx > -1 && process.argv[idx + 1] !== undefined ? process.argv[idx + 1] : fallback;
}

async function track(key, value) {
  try {
    const { enqueueEvent, flushEvents } = await import('./telemetry/telemetry.mjs');
    enqueueEvent({ key, value });
    await flushEvents();
  } catch {}
}

const trigger = arg('--trigger', 'startup_normal');
const minVersion = arg('--min-version', '');
const currentVersion = arg('--current-version', '');

try {
  await track('upgrade:auto_started', trigger);
  const state = await runAutoUpgrade({
    trigger,
    minVersion,
    ...(currentVersion ? { currentVersion } : {}),
  });
  process.exitCode = state?.lastResult === 'failed' ? 1 : 0;
  if (state?.lastResult === 'succeeded') {
    await track('upgrade:auto_succeeded', state.targetVersion || trigger);
  } else if (state?.lastResult === 'failed') {
    await track('upgrade:auto_failed', state.error || state.targetVersion || trigger);
  }
} catch (error) {
  const paths = autoUpgradePaths();
  try {
    mkdirSync(dirname(paths.log), { recursive: true, mode: 0o700 });
    appendFileSync(paths.log, `[${new Date().toISOString()}] fatal ${error?.message || String(error)}\n`, {
      mode: 0o600,
    });
  } catch {}
  try {
    writeAutoUpgradeState(
      {
        lastResult: 'failed',
        trigger,
        fromVersion: currentVersion || null,
        error: error?.message || String(error),
        finishedAt: new Date().toISOString(),
      },
      { statePath: paths.state },
    );
  } catch {}
  await track('upgrade:auto_failed', error?.message || String(error));
  process.exitCode = 1;
}
