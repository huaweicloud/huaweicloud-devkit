import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SpawnSyncOptions } from 'node:child_process';

import {
  getCachedUpdateInfo,
  peekCachedUpdateInfo,
  invalidateUpdateCache,
  applyUpdateHint,
  upgradePackage,
} from '../plugins/huaweicloud-core/src/update-check.ts';
import type { UpgradeOptions } from '../plugins/huaweicloud-core/src/update-check.ts';

type UpgradeSpawnFn = NonNullable<UpgradeOptions['spawnFn']>;

test('must-notify: 节流过期后重查成功 → 立即补提 hint', async () => {
  invalidateUpdateCache();
  let calls = 0;
  const failThenSucceed = async () => {
    calls++;
    return calls === 1 ? null : { latest: '1.1.1', next: null };
  };
  const t0 = 1_000_000_000; // 大基数：failedAt 初始 0 时 now-0 必须 > throttle 才触发首查
  const r1 = await getCachedUpdateInfo('1.0.2', { doQuery: failThenSucceed, now: t0 });
  assert.equal(r1.result, 'check_failed'); // 首次失败，记 failedAt=t0
  assert.equal(peekCachedUpdateInfo(), null); // 失败→无提示（不漏但不刷警告）

  // 同会话节流期内（t0+1ms）：不重查，仍 check_failed
  const r2 = await getCachedUpdateInfo('1.0.2', { doQuery: failThenSucceed, now: t0 + 1 });
  assert.equal(r2.result, 'check_failed');
  assert.equal(calls, 1); // 节流内未触发新查询

  // 节流过期后（t0 + FAIL_THROTTLE*2）：重查成功 → 立即补提（迟到但不漏）
  const late = 6 * 60 * 1000; // > FAIL_THROTTLE_MS(5min)
  const r3 = await getCachedUpdateInfo('1.0.2', { doQuery: failThenSucceed, now: t0 + late });
  assert.equal(r3.result, 'update_available');
  assert.equal(r3.targetVersion, '1.1.1');
  assert.equal(calls, 2);
  invalidateUpdateCache();
});

test('peekCachedUpdateInfo 返回已就绪 hint | null', async () => {
  invalidateUpdateCache();
  assert.equal(peekCachedUpdateInfo(), null);
  const fakeQuery = async () => ({ latest: '1.1.0', next: null });
  await getCachedUpdateInfo('1.0.2', { doQuery: fakeQuery });
  const hint = peekCachedUpdateInfo();
  assert.ok(hint && hint.updateAvailable === true);
  assert.equal(hint.currentVersion, '1.0.2');
  assert.equal(hint.targetVersion, '1.1.0');
  invalidateUpdateCache();
});

interface UpdateHintAttached {
  _updateInfo: { currentVersion?: string; latestVersion: string };
}

test('applyUpdateHint 附加/跳过规则', () => {
  const base = { ok: true };
  const hint = { updateAvailable: true, currentVersion: '1.0.2', targetVersion: '1.1.0' };
  assert.equal(
    (applyUpdateHint(base, 'huaweicloud_check_cli', hint) as UpdateHintAttached)._updateInfo.latestVersion,
    '1.1.0',
  );
  assert.equal(applyUpdateHint(base, 'huaweicloud_check_update', hint), base); // 自身不加
  assert.equal(applyUpdateHint(base, 'huaweicloud_upgrade', hint), base);
  assert.equal(applyUpdateHint(base, 'huaweicloud_check_cli', null), base); // 无 hint 不加
  assert.equal(applyUpdateHint(base, 'huaweicloud_check_cli', { updateAvailable: false }), base);
  assert.equal(applyUpdateHint(base, 'huaweicloud_check_cli', { updateAvailable: true }), base); // 无 targetVersion 不加
  assert.equal(
    applyUpdateHint(base, 'huaweicloud_check_cli', { updateAvailable: true, currentVersion: '1.0.2' }),
    base,
  );
  assert.deepEqual((applyUpdateHint(base, 'huaweicloud_check_cli', hint) as UpdateHintAttached)._updateInfo, {
    currentVersion: '1.0.2',
    latestVersion: '1.1.0',
  });
});

test('upgradePackage 参数校验: version 仅支持 latest', async () => {
  const r = await upgradePackage({ target: 'opencode', version: '1.0.0' }, { spawnFn: () => ({ status: 0 }) });
  assert.equal(r.success, false);
  assert.match(r.error ?? '', /version 参数仅支持 latest/);
});

test('upgradePackage 成功路径: 目标版本/重启/文案/缓存失效', async () => {
  invalidateUpdateCache();
  let spawned: { cmd: string; args: readonly string[]; opts: SpawnSyncOptions } | null = null;
  const spawnFn: UpgradeSpawnFn = (cmd, args, opts) => {
    spawned = { cmd, args, opts };
    return { status: 0, stdout: '', stderr: '' };
  };
  const doQuery = async () => ({ latest: '1.1.1', next: null });
  const r = await upgradePackage({ target: 'opencode', version: 'latest' }, { doQuery, spawnFn });
  assert.equal(r.success, true);
  const repoPkg = JSON.parse(
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'),
  ) as { version: string };
  assert.equal(r.previousVersion, repoPkg.version); // 与仓库 package.json 当前版本动态一致
  assert.equal(r.installedVersion, '1.1.1');
  assert.equal(r.requiresRestart, true);
  assert.match(r.message, /重启当前会话/);
  assert.equal(spawned!.cmd, process.platform === 'win32' ? 'npx.cmd' : 'npx');
  assert.deepEqual(spawned!.args, ['--yes', 'huaweicloud-devkit@latest', 'update', '--target', 'opencode']);
  assert.equal(spawned!.opts.timeout, 300000);
  // 升级后缓存失效 → 下一次检测重新查询（此处不 fetch，只验证 invalidate 生效）
  invalidateUpdateCache();
});

test('upgradePackage next 目标: 用 next tag', async () => {
  let spawned: readonly string[] | null = null;
  const spawnFn: UpgradeSpawnFn = (cmd, args) => {
    spawned = args;
    return { status: 0 };
  };
  const doQuery = async () => ({ latest: '1.1.0', next: '1.1.1-next.15' });
  // currentVersion 显式注入：包版本在 prerelease/stable 之间切换（如 release 分支 bump 成稳定版）
  // 不应改变升级 tag 的判定逻辑
  await upgradePackage({ target: 'opencode' }, { doQuery, spawnFn, currentVersion: '1.1.0-next.1' });
  assert.ok(spawned!.some((a) => a === 'huaweicloud-devkit@next'));
});

test('upgradePackage officeace 专属重连文案', async () => {
  const spawnFn = () => ({ status: 0 });
  const doQuery = async () => ({ latest: '1.1.1', next: null });
  const r = await upgradePackage({ target: 'officeace' }, { doQuery, spawnFn });
  assert.match(r.message ?? '', /连接器/);
});

test('upgradePackage 失败: 返回手动命令', async () => {
  const spawnFn = () => ({ status: 1, stdout: '', stderr: 'EPERM: permission denied' });
  const doQuery = async () => ({ latest: '1.1.1', next: null });
  const r = await upgradePackage({ target: 'opencode' }, { doQuery, spawnFn });
  assert.equal(r.success, false);
  assert.match(r.manual ?? '', /npx --yes huaweicloud-devkit@latest update --target opencode/);
  assert.match(r.error ?? '', /EPERM/);
});

test('upgradePackage 失败: spawn 不存在时报可读错误而非 exit null', async () => {
  const spawnFn = () => ({
    status: null,
    stdout: '',
    stderr: '',
    error: new Error('spawn npx ENOENT'),
  });
  const doQuery = async () => ({ latest: '1.1.1', next: null });
  const r = await upgradePackage({ target: 'opencode' }, { doQuery, spawnFn });
  assert.equal(r.success, false);
  assert.match(r.error ?? '', /ENOENT/);
  assert.doesNotMatch(r.error ?? '', /exit null/);
});

test('upgradePackage 无目标版本: distTags 有效但无候选时不 spawn 并返回无需升级', async () => {
  let spawned = false;
  const spawnFn = () => {
    spawned = true;
    return { status: 0 };
  };
  const doQuery = async () => ({ latest: null, next: null });
  const r = await upgradePackage({ target: 'opencode' }, { doQuery, spawnFn });
  assert.equal(spawned, false);
  assert.equal(r.success, false);
  assert.equal(r.requiresRestart, false);
  assert.match(r.message, /已是最新版本，无需升级。/);
});

test('upgradePackage 查询失败: 不 spawn 并给手动提示', async () => {
  let spawned = false;
  const spawnFn = () => {
    spawned = true;
    return { status: 0 };
  };
  const r = await upgradePackage({ target: 'opencode' }, { doQuery: async () => null, spawnFn });
  assert.equal(r.success, false);
  assert.equal(spawned, false);
  assert.match(r.manual ?? '', /huaweicloud-devkit@latest update/);
});

test('upgradePackage 失败原因: 取 npm error 行, 不把 npm warn 噪声当原因', async () => {
  const stderr = [
    'npm error code ELIFECYCLE',
    'npm error Command failed with exit code 1',
    'npm warn EBADENGINE Unsupported engine',
    'npm warn EBADENGINE current: {"node":"v22.14.0"}',
  ].join('\n');
  const spawnFn = () => ({ status: 1, stdout: '', stderr });
  const doQuery = async () => ({ latest: '1.1.1', next: null });
  const r = await upgradePackage({ target: 'opencode' }, { doQuery, spawnFn });
  assert.equal(r.success, false);
  assert.match(r.error ?? '', /ELIFECYCLE/);
  assert.match(r.error ?? '', /exit code 1/);
  assert.doesNotMatch(r.error ?? '', /EBADENGINE|Unsupported engine/);
});

test('upgradePackage 失败原因: 只有噪声时退到退出码', async () => {
  const spawnFn = () => ({
    status: 1,
    stdout: '',
    stderr: ['npm warn deprecated foo@1.0.0', 'npm warn EBADENGINE Unsupported engine'].join('\n'),
  });
  const doQuery = async () => ({ latest: '1.1.1', next: null });
  const r = await upgradePackage({ target: 'opencode' }, { doQuery, spawnFn });
  assert.equal(r.error, 'exit 1');
});

test('upgradePackage 失败原因: Node 弃用警告行同样不算原因', async () => {
  const stderr = [
    '(node:12345) [DEP0190] DeprecationWarning: Passing args to a child process with shell option true',
    '(Use `node --trace-deprecation ...` to show where the warning was created)',
  ].join('\n');
  const spawnFn = () => ({ status: 1, stdout: '', stderr });
  const doQuery = async () => ({ latest: '1.1.1', next: null });
  const r = await upgradePackage({ target: 'opencode' }, { doQuery, spawnFn });
  assert.equal(r.error, 'exit 1');
});

test('upgradePackage 升级子进程: 剥掉凭证环境变量, 保留其余环境', async () => {
  const saved = {
    accessKey: process.env.HW_ACCESS_KEY,
    secretKey: process.env.HUAWEICLOUD_SECRET_KEY,
    marker: process.env.DEVKIT_UPGRADE_ENV_MARKER,
  };
  process.env.HW_ACCESS_KEY = 'fixture-ak';
  process.env.HUAWEICLOUD_SECRET_KEY = 'fixture-sk';
  process.env.DEVKIT_UPGRADE_ENV_MARKER = 'kept';
  try {
    let spawned: { args: readonly string[]; opts: SpawnSyncOptions } | null = null;
    const spawnFn: UpgradeSpawnFn = (_cmd, args, opts) => {
      spawned = { args, opts };
      return { status: 0 };
    };
    const doQuery = async () => ({ latest: '1.1.1', next: null });
    const r = await upgradePackage({ target: 'opencode' }, { doQuery, spawnFn });
    assert.equal(r.success, true);
    assert.deepEqual(spawned!.args, ['--yes', 'huaweicloud-devkit@latest', 'update', '--target', 'opencode']);
    const env = spawned!.opts.env as NodeJS.ProcessEnv;
    assert.equal(env.HW_ACCESS_KEY, undefined);
    assert.equal(env.HUAWEICLOUD_SECRET_KEY, undefined);
    assert.equal(env.DEVKIT_UPGRADE_ENV_MARKER, 'kept');
  } finally {
    for (const [key, value] of Object.entries({
      HW_ACCESS_KEY: saved.accessKey,
      HUAWEICLOUD_SECRET_KEY: saved.secretKey,
      DEVKIT_UPGRADE_ENV_MARKER: saved.marker,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('upgradePackage 升级子进程: 完整凭证键族（含 AWS 与 STS）都不进环境', async () => {
  const keys = [
    'HW_SECURITY_TOKEN',
    'HUAWEICLOUD_ACCESS_KEY',
    'HUAWEICLOUD_SECURITY_TOKEN',
    'HUAWEICLOUD_SECRET_ACCESS_KEY',
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_SESSION_TOKEN',
  ];
  for (const key of keys) process.env[key] = `fixture-${key}`;
  try {
    let captured: NodeJS.ProcessEnv | null = null;
    const spawnFn: UpgradeSpawnFn = (_cmd, _args, opts) => {
      captured = opts.env as NodeJS.ProcessEnv;
      return { status: 0 };
    };
    const doQuery = async () => ({ latest: '1.1.1', next: null });
    await upgradePackage({ target: 'opencode' }, { doQuery, spawnFn });
    for (const key of keys) assert.equal(captured![key], undefined, `${key} must not reach npx`);
  } finally {
    for (const key of keys) delete process.env[key];
  }
});
