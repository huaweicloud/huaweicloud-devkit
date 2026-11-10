import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  AUTO_UPGRADE_COOLDOWN_MS,
  acquireAutoUpgradeLock,
  autoUpgradePaths,
  autoUpgradeSuppressionReason,
  checkUpgradableInstall,
  decideAutoUpgrade,
  getAutoUpgradeNotice,
  isAutoUpgradeLockActive,
  maybeAutoUpgrade,
  readAutoUpgradeState,
  releaseAutoUpgradeLock,
  resolveUpgradeWriteRoots,
  runAutoUpgrade,
  writeAutoUpgradeState,
} from '../plugins/huaweicloud-core/src/update-auto.mjs';

const NOW = Date.parse('2026-11-10T00:00:00.000Z');

function tempEnv() {
  const home = mkdtempSync(join(tmpdir(), 'hwdk-auto-'));
  return { home, env: { HUAWEICLOUD_HOME: home } };
}

// The runner only upgrades installs inside the `update --target all` write
// set (R2), so fixtures must live in a write-set dir.
const WRITE_SET_PLUGIN = join('.config', 'opencode', 'huaweicloud-plugins');

function setupPlugin(home) {
  const root = join(home, WRITE_SET_PLUGIN);
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
      pluginRoot: join(home, WRITE_SET_PLUGIN),
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
        pluginRoot: join(home, WRITE_SET_PLUGIN),
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
  let spawnedOptions = null;
  try {
    const state = await runAutoUpgrade({
      trigger: 'startup_normal',
      currentVersion: '1.1.13',
      pluginRoot: root,
      env: { ...env, HW_ACCESS_KEY: 'secret-ak', HW_SECRET_KEY: 'secret-sk' },
      paths,
      now: () => NOW,
      gitCheckout: false,
      readInstalled,
      doQuery: async () => ({ latest: '1.1.14', next: null }),
      doPublishTime: async () => NOW - AUTO_UPGRADE_COOLDOWN_MS - 60_000,
      spawnFn: (_command, args, options) => {
        assert.deepEqual(args, ['--yes', 'huaweicloud-devkit@latest', 'update', '--target', 'all']);
        spawnedOptions = options;
        writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '1.1.14' }));
        writeFileSync(join(root, '.installed'), new Date(NOW).toISOString());
        return { status: 0, stdout: '', stderr: '' };
      },
    });
    assert.equal(state.lastResult, 'succeeded');
    assert.equal(state.installedVersion, '1.1.14');
    assert.equal(readInstalled(), '1.1.14');
    assert.equal(isAutoUpgradeLockActive(paths.lock, NOW), false);
    assert.equal(spawnedOptions.env.HW_ACCESS_KEY, undefined);
    assert.equal(spawnedOptions.env.HW_SECRET_KEY, undefined);
    assert.equal(spawnedOptions.env.npm_config_registry, 'https://registry.npmjs.org');
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

// ── R2: 安装位置必须属于 update --target all 的写入集合 ──

test('resolveUpgradeWriteRoots: mirrors the per-agent plugin dirs and env overrides', () => {
  const { home, env } = tempEnv();
  try {
    const roots = resolveUpgradeWriteRoots({ env, home });
    assert.ok(roots.includes(join(home, '.config', 'opencode', 'huaweicloud-plugins')));
    assert.ok(roots.includes(join(home, 'plugins', 'huaweicloud-devkit')));
    assert.ok(roots.includes(join(home, '.codeartsdoer', 'huaweicloud-plugins')));
    assert.ok(roots.includes(join(home, '.codeartswork', 'huaweicloud-plugins')));
    assert.ok(roots.includes(join(home, '.workbuddy', 'huaweicloud-plugins')));
    assert.ok(roots.includes(join(home, '.agents', 'huaweicloud-plugins')));
    const withOverrides = resolveUpgradeWriteRoots({
      env: { ...env, DSH_HOME: join(home, 'dsh-custom'), HERMES_HOME: join(home, 'hermes-custom') },
      home,
    });
    assert.ok(withOverrides.includes(join(home, 'dsh-custom', 'huaweicloud-plugins')));
    assert.ok(withOverrides.includes(join(home, 'hermes-custom', 'huaweicloud-plugins')));
    // Codex CLI marketplace cache and Claude Code installs are NOT in the write set.
    assert.ok(!withOverrides.some((root) => root.includes(join(home, '.codex'))));
    assert.ok(!withOverrides.some((root) => root.includes(join(home, '.claude'))));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('checkUpgradableInstall: write-set dirs pass, others fail with a manual hint', () => {
  const { home, env } = tempEnv();
  try {
    assert.equal(checkUpgradableInstall({ pluginRoot: join(home, WRITE_SET_PLUGIN), env, home }), null);
    assert.equal(checkUpgradableInstall({ pluginRoot: join(home, 'plugins', 'huaweicloud-devkit'), env, home }), null);

    const claude = checkUpgradableInstall({
      pluginRoot: join(home, '.claude', 'plugins', 'marketplaces', 'huawei', 'plugins', 'huaweicloud-core'),
      env,
      home,
    });
    assert.equal(claude.reason, 'unsupported_install');
    assert.match(claude.manual, /\/plugin/);

    const codex = checkUpgradableInstall({
      pluginRoot: join(home, '.codex', 'plugins', 'cache', 'huaweicloud-devkit', 'plugins', 'huaweicloud-core'),
      env,
      home,
    });
    assert.equal(codex.reason, 'unsupported_install');
    assert.match(codex.manual, /update --target codex/);

    const generic = checkUpgradableInstall({
      pluginRoot: join(home, 'tarball', 'plugins', 'huaweicloud-core'),
      env,
      home,
    });
    assert.equal(generic.reason, 'unsupported_install');
    assert.match(generic.manual, /update --target <agent>/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('maybeAutoUpgrade: unsupported install never spawns a runner', () => {
  const { home, env } = tempEnv();
  const paths = autoUpgradePaths(env);
  try {
    const result = maybeAutoUpgrade({
      trigger: 'version_gate',
      minVersion: '1.1.14',
      env,
      now: NOW,
      runtimeVersion: '1.1.13',
      gitCheckout: false,
      paths,
      state: null,
      readInstalled: () => '1.1.13',
      pluginRoot: join(home, '.claude', 'plugins', 'marketplaces', 'x', 'plugins', 'huaweicloud-core'),
      spawnFn: () => {
        throw new Error('must not spawn for unsupported installs');
      },
    });
    assert.equal(result.status, 'unsupported_install');
    assert.match(result.manual, /\/plugin/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('runAutoUpgrade: unsupported install skips without spawning or writing state', async () => {
  const { home, env } = tempEnv();
  const root = join(home, 'tarball', 'plugins', 'huaweicloud-core');
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'mcp-server.mjs'), '');
  const paths = autoUpgradePaths(env);
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
      readInstalled: () => '1.1.13',
      doQuery: async () => ({ latest: '1.1.14', next: null }),
      spawnFn: () => {
        throw new Error('must not spawn for unsupported installs');
      },
    });
    assert.equal(state.lastResult, 'skipped');
    assert.equal(state.reason, 'unsupported_install');
    assert.match(state.manual, /update --target <agent>/);
    assert.equal(readAutoUpgradeState(paths.state), null, 'unsupported skips must not clobber state');
    assert.equal(isAutoUpgradeLockActive(paths.lock, NOW), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ── R3: 备份/回滚必须覆盖版本 manifest；校验必须证明目录真的被重写 ──

function setupManifestPlugin(home) {
  // codex-desktop / openclaw 形态：无 package.json，版本在 .codex-plugin/plugin.json
  const root = join(home, WRITE_SET_PLUGIN);
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'mcp-server.mjs'), 'v1-code');
  mkdirSync(join(root, '.codex-plugin'), { recursive: true });
  writeFileSync(join(root, '.codex-plugin', 'plugin.json'), JSON.stringify({ version: '1.1.13' }));
  return root;
}

function manifestReader(root) {
  return () => {
    try {
      return JSON.parse(readFileSync(join(root, '.codex-plugin', 'plugin.json'), 'utf8')).version;
    } catch {
      return null;
    }
  };
}

test('runAutoUpgrade: mid-state failure rolls manifests back and removes created files', async () => {
  const { home, env } = tempEnv();
  const root = setupManifestPlugin(home);
  const paths = autoUpgradePaths(env);
  const readInstalled = manifestReader(root);
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
        // 模拟“manifest 已落盘、src/package.json 未完成”的中间态失败：
        // update 已写新 manifest 与新 package.json，随后失败退出。
        writeFileSync(join(root, '.codex-plugin', 'plugin.json'), JSON.stringify({ version: '1.1.14' }));
        writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '1.1.14' }));
        return { status: 1, stdout: '', stderr: 'installRuntimeDeps failed' };
      },
    });
    assert.equal(state.lastResult, 'failed');
    assert.equal(state.restored, true, 'manifest drift must trigger a real rollback');
    assert.equal(readInstalled(), '1.1.13', 'version manifest must be rolled back');
    assert.equal(existsSync(join(root, 'package.json')), false, 'files created by the failed update are removed');
    assert.equal(readFileSync(join(root, 'src', 'mcp-server.mjs'), 'utf8'), 'v1-code');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('runAutoUpgrade: status 0 but untouched dir fails verification and records restored:false', async () => {
  const { home, env } = tempEnv();
  const root = setupManifestPlugin(home);
  const paths = autoUpgradePaths(env);
  let reportedVersion = '1.1.13';
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
      // update 后版本号谎报 target（如父目录 package.json），但本目录未被重写：
      // 校验必须抓住“版本号变了、目录没变”的不一致。
      readInstalled: () => reportedVersion,
      doQuery: async () => ({ latest: '1.1.14', next: null }),
      spawnFn: () => {
        reportedVersion = '1.1.14';
        return { status: 0, stdout: '', stderr: '' };
      },
    });
    assert.equal(state.lastResult, 'failed');
    assert.equal(state.restored, false, 'nothing changed, so nothing was restored');
    assert.equal(readFileSync(join(root, 'src', 'mcp-server.mjs'), 'utf8'), 'v1-code');
    assert.equal(manifestReader(root)(), '1.1.13');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('runAutoUpgrade: success path rewrites both package.json and manifests consistently', async () => {
  const { home, env } = tempEnv();
  const root = setupManifestPlugin(home);
  const paths = autoUpgradePaths(env);
  const readInstalled = manifestReader(root);
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
      spawnFn: () => {
        writeFileSync(join(root, 'src', 'mcp-server.mjs'), 'v2-code');
        writeFileSync(join(root, '.codex-plugin', 'plugin.json'), JSON.stringify({ version: '1.1.14' }));
        writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '1.1.14' }));
        return { status: 0, stdout: '', stderr: '' };
      },
    });
    assert.equal(state.lastResult, 'succeeded');
    assert.equal(readInstalled(), '1.1.14');
    assert.equal(readFileSync(join(root, 'src', 'mcp-server.mjs'), 'utf8'), 'v2-code');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('lock: two real processes racing acquire produce exactly one winner', async () => {
  const { home, env } = tempEnv();
  const paths = autoUpgradePaths(env);
  mkdirSync(paths.dir, { recursive: true });
  const moduleUrl = new URL('../plugins/huaweicloud-core/src/update-auto.mjs', import.meta.url).href;
  // The winner must stay alive while the loser checks, otherwise the loser's
  // dead-pid takeover heals the stale lock and both report WIN.
  const script = `
    const { acquireAutoUpgradeLock, releaseAutoUpgradeLock, isAutoUpgradeLockActive } =
      await import(${JSON.stringify(moduleUrl)});
    const won = acquireAutoUpgradeLock({ lockPath: process.argv[1], now: Date.now() });
    process.stdout.write(won ? 'WIN' : 'LOSE');
    if (won) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      releaseAutoUpgradeLock({ lockPath: process.argv[1] });
    }
  `;
  const { spawn } = await import('node:child_process');
  const runChild = () =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', script, paths.lock], {
        stdio: ['ignore', 'pipe', 'inherit'],
      });
      let out = '';
      child.stdout.on('data', (d) => {
        out += String(d);
      });
      child.on('error', reject);
      child.on('close', () => resolve(out.trim()));
    });
  try {
    const children = [runChild(), runChild()];
    await new Promise((resolve) => setTimeout(resolve, 800)); // 让胜者持锁、败者完成判定
    const [a, b] = await Promise.all(children);
    assert.ok(['WIN', 'LOSE'].includes(a), `child A said: ${a}`);
    assert.ok(['WIN', 'LOSE'].includes(b), `child B said: ${b}`);
    const wins = [a, b].filter((r) => r === 'WIN').length;
    assert.equal(wins, 1, `exactly one process must hold the exclusive lock (got ${a}/${b})`);
    // 胜者主动释放 → 锁文件被清理，后续进程可重新获取
    assert.equal(existsSync(paths.lock), false);
    assert.equal(acquireAutoUpgradeLock({ lockPath: paths.lock, now: Date.now() }), true);
  } finally {
    releaseAutoUpgradeLock({ lockPath: paths.lock });
    rmSync(home, { recursive: true, force: true });
  }
});
