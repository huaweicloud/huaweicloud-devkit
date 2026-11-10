import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  AUTO_UPGRADE_COOLDOWN_MS,
  acquireAutoUpgradeLock,
  autoUpgradePaths,
  autoUpgradeSuppressionReason,
  decideAutoUpgrade,
  getAutoUpgradeNotice,
  isAutoUpgradeLockActive,
  maybeAutoUpgrade,
  readAutoUpgradeState,
  releaseAutoUpgradeLock,
  runAutoUpgrade,
  writeAutoUpgradeState,
} from '../plugins/huaweicloud-core/src/update-auto.mjs';

const NOW = Date.parse('2026-11-10T00:00:00.000Z');

function tempEnv() {
  const home = mkdtempSync(join(tmpdir(), 'hwdk-auto-'));
  return { home, env: { HUAWEICLOUD_HOME: home } };
}

function setupPlugin(home) {
  const root = join(home, 'plugin');
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'mcp-server.mjs'), '');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '1.1.13' }));
  return root;
}

function installedReader(root) {
  return () => {
    try {
      return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
    } catch {
      return null;
    }
  };
}

test('decideAutoUpgrade: normal path honours the 24h cooldown', () => {
  const base = { trigger: 'startup_normal', current: '1.1.13', target: '1.1.14', now: NOW };
  assert.equal(
    decideAutoUpgrade({ ...base, publishTimeMs: NOW - AUTO_UPGRADE_COOLDOWN_MS + 60_000 }).reason,
    'cooldown',
  );
  assert.equal(
    decideAutoUpgrade({ ...base, publishTimeMs: NOW - AUTO_UPGRADE_COOLDOWN_MS - 60_000 }).action,
    'upgrade',
  );
  assert.equal(decideAutoUpgrade({ ...base, publishTimeMs: null }).reason, 'publish_time_unknown');
});

test('decideAutoUpgrade: forced trigger bypasses cooldown and enforces minVersion', () => {
  assert.equal(
    decideAutoUpgrade({
      trigger: 'startup_forced',
      current: '1.1.13',
      target: '1.1.14',
      publishTimeMs: NOW,
      minVersion: '1.1.14',
      now: NOW,
    }).action,
    'upgrade',
  );
  assert.equal(
    decideAutoUpgrade({
      trigger: 'version_gate',
      current: '1.1.13',
      target: '1.1.13',
      minVersion: '1.1.14',
      now: NOW,
    }).reason,
    'registry_behind_min_version',
  );
  assert.equal(
    decideAutoUpgrade({ trigger: 'version_gate', current: '1.1.14', target: '1.1.14', now: NOW }).reason,
    'up_to_date',
  );
});

test('decideAutoUpgrade: disk already upgraded and failure throttle', () => {
  assert.equal(
    decideAutoUpgrade({
      trigger: 'startup_normal',
      current: '1.1.13',
      target: '1.1.14',
      diskVersion: '1.1.14',
      publishTimeMs: NOW - AUTO_UPGRADE_COOLDOWN_MS - 1,
      now: NOW,
    }).reason,
    'already_upgraded',
  );
  const failed = {
    lastResult: 'failed',
    targetVersion: '1.1.14',
    finishedAt: new Date(NOW - 30 * 60 * 1000).toISOString(),
  };
  assert.equal(
    decideAutoUpgrade({
      trigger: 'startup_normal',
      current: '1.1.13',
      target: '1.1.14',
      publishTimeMs: NOW - AUTO_UPGRADE_COOLDOWN_MS - 1,
      now: NOW,
      state: failed,
    }).reason,
    'throttled',
  );
  assert.equal(
    decideAutoUpgrade({
      trigger: 'version_gate',
      current: '1.1.13',
      target: '1.1.14',
      minVersion: '1.1.14',
      now: NOW,
      state: { ...failed, finishedAt: new Date(NOW - 2 * 60 * 60 * 1000).toISOString() },
    }).action,
    'upgrade',
  );
});

test('autoUpgradeSuppressionReason: SKIP_UPDATE / CI / git checkout', () => {
  assert.equal(
    autoUpgradeSuppressionReason({ env: { HUAWEICLOUD_DEVKIT_SKIP_UPDATE: '1' }, gitCheckout: false }),
    'skip_update',
  );
  assert.equal(autoUpgradeSuppressionReason({ env: { CI: 'true' }, gitCheckout: false }), 'ci');
  assert.equal(autoUpgradeSuppressionReason({ env: { CI: 'false' }, gitCheckout: false }), null);
  assert.equal(autoUpgradeSuppressionReason({ env: {}, gitCheckout: true }), 'git_checkout');
  assert.equal(autoUpgradeSuppressionReason({ env: {}, gitCheckout: false }), null);
});

test('lock: exclusive acquire, stale takeover, owner release', () => {
  const { home, env } = tempEnv();
  const paths = autoUpgradePaths(env);
  try {
    assert.equal(acquireAutoUpgradeLock({ lockPath: paths.lock, now: NOW }), true);
    assert.equal(acquireAutoUpgradeLock({ lockPath: paths.lock, now: NOW }), false);
    assert.equal(isAutoUpgradeLockActive(paths.lock, NOW), true);
    assert.equal(releaseAutoUpgradeLock({ lockPath: paths.lock }), true);
    assert.equal(isAutoUpgradeLockActive(paths.lock, NOW), false);

    mkdirSync(paths.dir, { recursive: true });
    writeFileSync(paths.lock, JSON.stringify({ pid: -1, startedAt: new Date(NOW - 60 * 60 * 1000).toISOString() }));
    assert.equal(acquireAutoUpgradeLock({ lockPath: paths.lock, now: NOW }), true);
    releaseAutoUpgradeLock({ lockPath: paths.lock });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('maybeAutoUpgrade: spawns a detached runner when eligible', () => {
  const { home, env } = tempEnv();
  const paths = autoUpgradePaths(env);
  let spawned = null;
  try {
    const result = maybeAutoUpgrade({
      trigger: 'startup_forced',
      minVersion: '1.1.14',
      env,
      now: NOW,
      runtimeVersion: '1.1.13',
      gitCheckout: false,
      paths,
      state: null,
      readInstalled: () => '1.1.13',
      spawnFn: (command, args, options) => {
        spawned = { command, args, options };
        return { pid: 1234, unref() {} };
      },
    });
    assert.equal(result.status, 'started');
    assert.equal(spawned.command, process.execPath);
    assert.ok(spawned.args.some((arg) => arg.endsWith('auto-upgrade-runner.mjs')));
    assert.deepEqual(spawned.args.slice(1, 7), [
      '--trigger',
      'startup_forced',
      '--min-version',
      '1.1.14',
      '--current-version',
      '1.1.13',
    ]);
    assert.equal(spawned.options.detached, true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('maybeAutoUpgrade: already upgraded / locked / disabled', () => {
  const { home, env } = tempEnv();
  const paths = autoUpgradePaths(env);
  try {
    assert.equal(
      maybeAutoUpgrade({
        env,
        paths,
        gitCheckout: false,
        runtimeVersion: '1.1.13',
        readInstalled: () => '1.1.14',
        state: { lastResult: 'succeeded', installedVersion: '1.1.14' },
        spawnFn: () => {
          throw new Error('must not spawn');
        },
      }).status,
      'already_upgraded',
    );

    acquireAutoUpgradeLock({ lockPath: paths.lock, now: NOW });
    assert.equal(
      maybeAutoUpgrade({
        env,
        paths,
        now: NOW,
        gitCheckout: false,
        runtimeVersion: '1.1.13',
        readInstalled: () => '1.1.13',
        state: null,
        spawnFn: () => {
          throw new Error('must not spawn');
        },
      }).status,
      'already_running',
    );
    releaseAutoUpgradeLock({ lockPath: paths.lock });

    assert.equal(
      maybeAutoUpgrade({
        env: { ...env, HUAWEICLOUD_DEVKIT_SKIP_UPDATE: '1' },
        paths,
        gitCheckout: false,
        runtimeVersion: '1.1.13',
        state: null,
        spawnFn: () => {
          throw new Error('must not spawn');
        },
      }).status,
      'disabled',
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('runAutoUpgrade: normal success writes succeeded and installs the new payload', async () => {
  const { home, env } = tempEnv();
  const root = setupPlugin(home);
  const paths = autoUpgradePaths(env);
  const readInstalled = installedReader(root);
  try {
    const state = await runAutoUpgrade({
      trigger: 'startup_normal',
      currentVersion: '1.1.13',
      pluginRoot: root,
      env,
      paths,
      now: () => NOW,
      gitCheckout: false,
      readInstalled,
      doQuery: async () => ({ latest: '1.1.14', next: null }),
      doPublishTime: async () => NOW - AUTO_UPGRADE_COOLDOWN_MS - 60_000,
      spawnFn: (_command, args) => {
        assert.deepEqual(args, ['--yes', 'huaweicloud-devkit@latest', 'update', '--target', 'all']);
        writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '1.1.14' }));
        writeFileSync(join(root, '.installed'), new Date(NOW).toISOString());
        return { status: 0, stdout: '', stderr: '' };
      },
    });
    assert.equal(state.lastResult, 'succeeded');
    assert.equal(state.installedVersion, '1.1.14');
    assert.equal(readInstalled(), '1.1.14');
    assert.equal(isAutoUpgradeLockActive(paths.lock, NOW), false);
    const persisted = readAutoUpgradeState(paths.state);
    assert.equal(persisted.lastResult, 'succeeded');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('runAutoUpgrade: cooldown and registry lag skip without spawning', async () => {
  const { home, env } = tempEnv();
  const root = setupPlugin(home);
  const paths = autoUpgradePaths(env);
  const readInstalled = installedReader(root);
  try {
    let spawned = 0;
    const cooldown = await runAutoUpgrade({
      trigger: 'startup_normal',
      currentVersion: '1.1.13',
      pluginRoot: root,
      env,
      paths,
      now: () => NOW,
      gitCheckout: false,
      readInstalled,
      doQuery: async () => ({ latest: '1.1.14', next: null }),
      doPublishTime: async () => NOW - 60 * 60 * 1000,
      spawnFn: () => {
        spawned += 1;
        return { status: 0 };
      },
    });
    assert.equal(cooldown.lastResult, 'skipped');
    assert.equal(cooldown.reason, 'cooldown');

    const lag = await runAutoUpgrade({
      trigger: 'version_gate',
      minVersion: '1.1.15',
      currentVersion: '1.1.13',
      pluginRoot: root,
      env,
      paths,
      now: () => NOW,
      gitCheckout: false,
      readInstalled,
      doQuery: async () => ({ latest: '1.1.14', next: null }),
      doPublishTime: async () => NOW,
      spawnFn: () => {
        spawned += 1;
        return { status: 0 };
      },
    });
    assert.equal(lag.lastResult, 'skipped');
    assert.equal(lag.reason, 'registry_behind_min_version');
    assert.equal(spawned, 0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('runAutoUpgrade: forced path ignores cooldown', async () => {
  const { home, env } = tempEnv();
  const root = setupPlugin(home);
  const paths = autoUpgradePaths(env);
  const readInstalled = installedReader(root);
  try {
    const state = await runAutoUpgrade({
      trigger: 'startup_forced',
      minVersion: '1.1.14',
      currentVersion: '1.1.13',
      pluginRoot: root,
      env,
      paths,
      now: () => NOW,
      gitCheckout: false,
      readInstalled,
      doQuery: async () => ({ latest: '1.1.14', next: null }),
      doPublishTime: async () => {
        throw new Error('forced path must not query publish time');
      },
      spawnFn: () => {
        writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '1.1.14' }));
        writeFileSync(join(root, '.installed'), new Date(NOW).toISOString());
        return { status: 0 };
      },
    });
    assert.equal(state.lastResult, 'succeeded');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('runAutoUpgrade: verification failure restores the running payload', async () => {
  const { home, env } = tempEnv();
  const root = setupPlugin(home);
  const paths = autoUpgradePaths(env);
  const readInstalled = installedReader(root);
  try {
    const state = await runAutoUpgrade({
      trigger: 'version_gate',
      minVersion: '1.1.14',
      currentVersion: '1.1.13',
      pluginRoot: root,
      env,
      paths,
      now: () => NOW,
      gitCheckout: false,
      readInstalled,
      doQuery: async () => ({ latest: '1.1.14', next: null }),
      spawnFn: () => {
        writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '1.1.14' }));
        return { status: 1, stdout: '', stderr: 'boom' };
      },
    });
    assert.equal(state.lastResult, 'failed');
    assert.match(state.error, /boom/);
    assert.equal(readInstalled(), '1.1.13');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('getAutoUpgradeNotice: succeeded only until the process restarts', () => {
  const { home, env } = tempEnv();
  const paths = autoUpgradePaths(env);
  try {
    writeAutoUpgradeState(
      {
        lastResult: 'succeeded',
        installedVersion: '1.1.14',
        finishedAt: new Date(NOW).toISOString(),
      },
      { statePath: paths.state },
    );
    const notice = getAutoUpgradeNotice({ statePath: paths.state, runtimeVersion: '1.1.13', now: NOW });
    assert.deepEqual(notice, { status: 'succeeded', installedVersion: '1.1.14', requiresRestart: true });
    assert.equal(getAutoUpgradeNotice({ statePath: paths.state, runtimeVersion: '1.1.14', now: NOW }), null);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
