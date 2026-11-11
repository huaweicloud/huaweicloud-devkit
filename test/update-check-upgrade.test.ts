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
import { isCredentialEnvVarName } from '../plugins/huaweicloud-core/src/lib/secret-vault/refs.ts';

type UpgradeSpawnFn = NonNullable<UpgradeOptions['spawnFn']>;

const FAILURE_FIXTURES = new URL('./fixtures/update-npm-failure/', import.meta.url);
const failureStderr = (name: string) => readFileSync(new URL(name, FAILURE_FIXTURES), 'utf8');

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

const stubQuery = async () => ({ latest: '1.1.1', next: null });

function failingSpawn(stderr: string, status = 1): UpgradeSpawnFn {
  return () => ({ status, stdout: '', stderr });
}

async function reasonFor(stderr: string, status = 1): Promise<string> {
  const r = await upgradePackage({ target: 'opencode' }, { doQuery: stubQuery, spawnFn: failingSpawn(stderr, status) });
  assert.equal(r.success, false);
  return r.error ?? '';
}

test('upgradePackage 失败原因: 取 npm error 行, 不把 npm warn 噪声当原因', async () => {
  const stderr = [
    'npm error code ELIFECYCLE',
    'npm error Command failed with exit code 1',
    'npm warn EBADENGINE Unsupported engine',
    'npm warn EBADENGINE current: {"node":"v22.14.0"}',
  ].join('\n');
  const r = await upgradePackage({ target: 'opencode' }, { doQuery: stubQuery, spawnFn: failingSpawn(stderr) });
  assert.equal(r.success, false);
  assert.match(r.error ?? '', /ELIFECYCLE/);
  assert.match(r.error ?? '', /exit code 1/);
  assert.doesNotMatch(r.error ?? '', /EBADENGINE|Unsupported engine/);
});

test('upgradePackage 失败原因: 只有噪声时退到退出码', async () => {
  const stderr = ['npm warn deprecated foo@1.0.0', 'npm warn EBADENGINE Unsupported engine'].join('\n');
  const r = await upgradePackage({ target: 'opencode' }, { doQuery: stubQuery, spawnFn: failingSpawn(stderr) });
  assert.equal(r.error, 'exit 1');
});

test('upgradePackage 失败原因: Node 弃用警告行同样不算原因', async () => {
  const stderr = [
    '(node:12345) [DEP0190] DeprecationWarning: Passing args to a child process with shell option true',
    '(Use `node --trace-deprecation ...` to show where the warning was created)',
  ].join('\n');
  const r = await upgradePackage({ target: 'opencode' }, { doQuery: stubQuery, spawnFn: failingSpawn(stderr) });
  assert.equal(r.error, 'exit 1');
});

test('upgradePackage 失败原因: E404 保留 code 行与首条诊断, 丢掉日志指针', async () => {
  const reason = await reasonFor(failureStderr('e404.err'));
  assert.match(reason, /E404/);
  assert.match(reason, /404 Not Found - GET/);
  assert.doesNotMatch(reason, /A complete log of this run|For a full report see/);
});

test('upgradePackage 失败原因: ECONNREFUSED 保留网络诊断, 丢掉栈帧与日志指针', async () => {
  const reason = await reasonFor(failureStderr('econnrefused.err'));
  assert.match(reason, /ECONNREFUSED/);
  assert.match(reason, /FetchError: request to http:.*reason: connect ECONNREFUSED/);
  assert.doesNotMatch(reason, /A complete log of this run|^\s*at |\bat ClientRequest/);
});

test('upgradePackage 失败原因: ETARGET 保留 code 行与 notarget 诊断', async () => {
  const reason = await reasonFor(failureStderr('etarget.err'));
  assert.match(reason, /ETARGET/);
  assert.match(reason, /No matching version found for huaweicloud-devkit@999\.999\.999/);
  assert.doesNotMatch(reason, /A complete log of this run/);
});

test('upgradePackage 失败原因: npm 9 的 npm ERR! 前缀同样识别', async () => {
  const reason = await reasonFor(failureStderr('legacy-etarget.err'));
  assert.match(reason, /ETARGET/);
  assert.match(reason, /No matching version found/);
});

test('upgradePackage 失败原因: ERESOLVE 丢掉报告指针行', async () => {
  const reason = await reasonFor(failureStderr('eresolve.err'));
  assert.match(reason, /ERESOLVE unable to resolve dependency tree/);
  assert.doesNotMatch(reason, /For a full report see|eresolve-report\.txt|A complete log/);
});

test('upgradePackage 失败原因: color=always 的 ANSI 行先归一化再取原因', async () => {
  const reason = await reasonFor(failureStderr('eresolve-ansi.err'));
  assert.match(reason, /ERESOLVE unable to resolve dependency tree/);
  assert.ok(!reason.includes(String.fromCharCode(27)), 'no ANSI escape survives');
  assert.doesNotMatch(reason, /For a full report see|A complete log/);
});

test('upgradePackage 失败原因: npm ERR! 尾部 npm notice 升级提示不进原因', async () => {
  const reason = await reasonFor(failureStderr('legacy-notice-eresolve.err'));
  assert.match(reason, /ERESOLVE unable to resolve dependency tree/);
  assert.doesNotMatch(reason, /npm notice|New major version|A complete log/);
});

test('upgradePackage 失败原因: 真实 lifecycle 块取 code 行与失败脚本行, 不取通用建议', async () => {
  const reason = await reasonFor(failureStderr('lifecycle-warn-tail.err'));
  assert.match(reason, /ELIFECYCLE/);
  assert.match(reason, /huaweicloud-devkit@2\.0\.1 update/);
  assert.doesNotMatch(reason, /This is probably not a problem|A complete log|EBADENGINE/);
});

test('upgradePackage 失败: 信号致死不报 exit null', async () => {
  const killed = { status: null, signal: 'SIGKILL', stdout: '', stderr: '' };
  const r = await upgradePackage({ target: 'opencode' }, { doQuery: stubQuery, spawnFn: () => killed });
  assert.equal(r.success, false);
  assert.match(r.error ?? '', /SIGKILL/);
  assert.doesNotMatch(r.error ?? '', /exit null/);
});

test('upgradePackage 升级子进程: 凭据谓词命中的环境变量全部剥掉, 其余环境与 argv 保留', async () => {
  const candidates = [
    'HW_ACCESS_KEY',
    'hw_access_key',
    'HW_SECURITY_TOKEN',
    'HUAWEICLOUD_SDK_SECURITY_TOKEN',
    'HUAWEICLOUD_SDK_AK',
    'HUAWEICLOUD_SDK_SK',
    'HWC_ACCESS_KEY',
    'HWC_SECRET_KEY',
    'HWC_SECRET_ACCESS_KEY',
    'HCLOUD_SECRET_KEY',
    'OS_SECRET_KEY',
  ];
  const credentialKeys = candidates.filter((name) => isCredentialEnvVarName(name));
  assert.equal(credentialKeys.length, candidates.length, 'every candidate must be predicate-positive');
  // Dev 4890d78c's AWS keys and KooCLI's HUAWEI_* aliases: the vault predicate
  // does not claim these spellings.
  const extraKeys = [
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_SESSION_TOKEN',
    'HUAWEI_ACCESS_KEY',
    'HUAWEI_SECRET_KEY',
  ];
  const marker = 'DEVKIT_UPGRADE_ENV_MARKER';
  assert.equal(isCredentialEnvVarName(marker), false, 'the control must be predicate-negative');
  const touched = [...credentialKeys, ...extraKeys, marker];
  const saved = new Map(touched.map((key) => [key, process.env[key]]));
  for (const key of touched) process.env[key] = `fixture-${key}`;
  try {
    let spawned: { args: readonly string[]; opts: SpawnSyncOptions } | null = null;
    const spawnFn: UpgradeSpawnFn = (_cmd, args, opts) => {
      spawned = { args, opts };
      return { status: 0 };
    };
    const r = await upgradePackage({ target: 'opencode' }, { doQuery: stubQuery, spawnFn });
    assert.equal(r.success, true);
    assert.deepEqual(spawned!.args, ['--yes', 'huaweicloud-devkit@latest', 'update', '--target', 'opencode']);
    const env = spawned!.opts.env as NodeJS.ProcessEnv;
    for (const key of [...credentialKeys, ...extraKeys]) {
      assert.equal(env[key], undefined, `${key} must not reach npx`);
    }
    assert.equal(env[marker], `fixture-${marker}`);
    assert.equal(env.PATH, process.env.PATH);
    assert.equal(env.HOME, process.env.HOME);
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
