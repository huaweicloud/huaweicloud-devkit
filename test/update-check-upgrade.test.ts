import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
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

async function withEnv(vars: Record<string, string | undefined>, run: () => Promise<void>): Promise<void> {
  const saved = new Map(Object.keys(vars).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    await run();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function childEnv(): Promise<NodeJS.ProcessEnv> {
  let captured: NodeJS.ProcessEnv | null = null;
  const spawnFn: UpgradeSpawnFn = (_cmd, _args, opts) => {
    captured = opts.env as NodeJS.ProcessEnv;
    return { status: 0 };
  };
  const r = await upgradePackage({ target: 'opencode' }, { doQuery: stubQuery, spawnFn });
  assert.equal(r.success, true);
  assert.ok(captured);
  return captured;
}

const NO_REGISTRY = {
  HUAWEICLOUD_NPM_REGISTRY: undefined,
  npm_config_registry: undefined,
  NPM_CONFIG_REGISTRY: undefined,
};

function registrySpellings(env: NodeJS.ProcessEnv): string[] {
  return Object.keys(env).filter((key) => key.toUpperCase() === 'NPM_CONFIG_REGISTRY');
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

test('upgradePackage 失败原因: 单行安装失败保留子进程原因, 只剪掉日志指针尾巴', async () => {
  const reason = await reasonFor(failureStderr('install-failed.err'));
  assert.match(reason, /npm install failed in/);
  assert.match(reason, /404 tarball, folder, http url, or git url/);
  assert.doesNotMatch(reason, /-debug-\d+\.log/);
  assert.doesNotMatch(reason, /^exit /);
});

test('upgradePackage 失败原因: 第二条单行安装失败同样保留代理诊断', async () => {
  const reason = await reasonFor(failureStderr('install-failed-proxy.err'));
  assert.match(reason, /npm install failed in/);
  assert.match(reason, /proxy/);
  assert.doesNotMatch(reason, /-debug-\d+\.log/);
});

test('upgradePackage 失败原因: ENOENT 跳过 path 元数据, 取 enoent 人读行', async () => {
  const reason = await reasonFor(failureStderr('enoent.err'));
  assert.match(reason, /ENOENT/);
  assert.match(reason, /unknown git error occurred/);
  assert.doesNotMatch(reason, /path git|A complete log/);
});

test('upgradePackage 失败原因: 安装脚本失败取 command 行, 不取 path 元数据', async () => {
  const reason = await reasonFor(failureStderr('command-failed.err'));
  assert.match(reason, /code 1/);
  assert.match(reason, /sh -c node -e/);
  assert.doesNotMatch(reason, /path \/tmp|A complete log/);
});

test('upgradePackage 失败原因: EACCES 取缓存说明, 不取缓存路径', async () => {
  const reason = await reasonFor(failureStderr('eacces.err'));
  assert.match(reason, /EACCES/);
  assert.match(reason, /root-owned files|permission denied/);
  assert.doesNotMatch(reason, /path \/tmp/);
});

test('upgradePackage 失败原因: 退出码 7 的安装块保留 fatal 原因行', async () => {
  const reason = await reasonFor(failureStderr('code-7.err'));
  assert.match(reason, /code 7/);
  assert.match(reason, /fatal: native build failed: missing libfoo/);
  assert.doesNotMatch(reason, /path \/tmp|A complete log/);
});

test('upgradePackage 失败原因: pty 里的 spinner 字形不挡住 npm error 行', async () => {
  const reason = await reasonFor(failureStderr('tty-e404.err'));
  assert.match(reason, /code E404/);
  assert.match(reason, /404 Not Found - GET/);
  assert.ok(!reason.includes(String.fromCharCode(0x2826)), 'no spinner glyph survives');
});

test('upgradePackage 失败原因: spinner 字形加空格后的 npm error 行仍被识别', async () => {
  const stderr = [
    '\u2826 npm error code E404',
    'npm error 404 Not Found - GET https://registry.example/x - Not found',
  ].join('\n');
  const reason = await reasonFor(stderr);
  assert.match(reason, /code E404/);
  assert.match(reason, /404 Not Found - GET/);
});

test('upgradePackage 失败原因: 字形加 show-cursor 转义再加空格也不挡 token', async () => {
  const cursor = `\u2826 \u001b[?25h `;
  const stderr = [
    `${cursor}npm error code E404`,
    'npm error 404 Not Found - GET https://registry.example/x - Not found',
  ].join('\n');
  const reason = await reasonFor(stderr);
  assert.match(reason, /code E404/);
  assert.match(reason, /404 Not Found - GET/);
});

test('upgradePackage 失败原因: 两行指针里的带空格 profile 路径不进原因', async () => {
  const stderr = [
    'npm error code E404',
    'npm error A complete log of this run can be found in:',
    'npm error     /Users/John Doe/.npm/_logs/2026-01-01T00_00_00_000Z-debug-0.log',
  ].join('\n');
  const reason = await reasonFor(stderr);
  assert.equal(reason, 'npm error code E404');
});

test('upgradePackage 失败原因: 无 code 行的 CLI stderr 优先取失败诊断行, 不取首行', async () => {
  const reason = await reasonFor(failureStderr('binfail.err'));
  assert.match(reason, /不支持的升级目标/);
  assert.doesNotMatch(reason, /^AUDIT/);
});

test('upgradePackage 失败原因: 无 code 行的 EACCES 行盖过前置审计行', async () => {
  const reason = await reasonFor(failureStderr('b1-audit-eacces.err'));
  assert.match(reason, /EACCES: permission denied/);
  assert.doesNotMatch(reason, /^AUDIT/);
});

test('upgradePackage 失败原因: 强标记行盖过前置带提示词的审计行', async () => {
  const reason = await reasonFor(failureStderr('b2-audit-hint-then-install.err'));
  assert.match(reason, /npm install failed in/);
  assert.doesNotMatch(reason, /^AUDIT/);
});

test('upgradePackage 失败原因: 进度行之后的裸 EACCES 仍然被选中', async () => {
  const reason = await reasonFor(failureStderr('b4-progress-eacces.err'));
  assert.match(reason, /EACCES: permission denied/);
  assert.doesNotMatch(reason, /^Resolving package metadata/);
});

test('upgradePackage 失败原因: 审计提示行不压过其后的 Error 行', async () => {
  const reason = await reasonFor(failureStderr('b6-audit-hint-then-error.err'));
  assert.match(reason, /EACCES: permission denied/);
  assert.doesNotMatch(reason, /^AUDIT/);
});

test('upgradePackage 失败原因: 重试提示行不压过其前的 ENOTFOUND 行', async () => {
  const reason = await reasonFor(failureStderr('enotfound-retry.err'));
  assert.match(reason, /ENOTFOUND registry\.internal\.corp/);
  assert.doesNotMatch(reason, /checkout failed/);
});

test('upgradePackage 失败原因: 可选步骤警告不压过其前的 ENOTFOUND 行', async () => {
  const reason = await reasonFor(failureStderr('enotfound-warning.err'));
  assert.match(reason, /ENOTFOUND registry\.internal\.corp/);
  assert.doesNotMatch(reason, /warning/);
});

test('upgradePackage 失败原因: 同层命中取靠后的那行', async () => {
  const stderr = [
    'cleanup failed, ignored',
    'npm install failed in /home/op/x: 404 tarball, folder, http url, or git url',
  ].join('\n');
  const reason = await reasonFor(stderr);
  assert.match(reason, /npm install failed in/);
  assert.doesNotMatch(reason, /cleanup failed/);
});

test('upgradePackage 失败原因: 无强标记时提示词行压过其前的无关行', async () => {
  const stderr = [
    'settings restored from backup',
    'warning: could not restore previous settings; user config left failed',
  ].join('\n');
  const reason = await reasonFor(stderr);
  assert.match(reason, /could not restore previous settings/);
  assert.doesNotMatch(reason, /^settings restored/);
});

test('upgradePackage 失败原因: Node loader 崩溃取 Error 行, 不取帧头', async () => {
  const reason = await reasonFor(failureStderr('crash-loader.err'));
  assert.match(reason, /Error: Cannot find module/);
  assert.doesNotMatch(reason, /^node:internal/);
});

test('upgradePackage 失败原因: npm error 块内 Error 行压过进度行', async () => {
  const reason = await reasonFor(failureStderr('npm-info-before-error.err'));
  assert.match(reason, /prebuilt binary download failed/);
  assert.doesNotMatch(reason, /Downloading|verifying/);
});

test('upgradePackage 失败原因: 数字 E-code 也是强标记', async () => {
  const reason = await reasonFor(failureStderr('p1-e404-behind-audit.err'));
  assert.match(reason, /E404: package huaweicloud-devkit not present/);
  assert.doesNotMatch(reason, /^AUDIT/);
});

test('upgradePackage 失败原因: 下划线 E-code 也是强标记', async () => {
  const reason = await reasonFor(failureStderr('p2-eai-again-vs-audit.err'));
  assert.match(reason, /EAI_AGAIN: Temporary failure/);
  assert.doesNotMatch(reason, /^AUDIT/);
});

test('upgradePackage 失败原因: 尾部 EXIT 大写词不是强标记', async () => {
  const reason = await reasonFor(failureStderr('q1-trailing-exit-status.err'));
  assert.match(reason, /EACCES: permission denied/);
  assert.doesNotMatch(reason, /EXIT code/);
});

test('upgradePackage 失败原因: 尾部 EXTRACT 大写词不是强标记', async () => {
  const reason = await reasonFor(failureStderr('q2-trailing-extract-progress.err'));
  assert.match(reason, /EACCES: permission denied/);
  assert.doesNotMatch(reason, /EXTRACT cleanup/);
});

test('upgradePackage 失败原因: ENABLED 赋值行不是强标记', async () => {
  const reason = await reasonFor(failureStderr('q3-enabled-audit.err'));
  assert.match(reason, /EACCES: permission denied/);
  assert.doesNotMatch(reason, /ENABLED/);
});

test('upgradePackage 失败原因: EXPORTED 行不压过其前的 Error 行', async () => {
  const reason = await reasonFor(failureStderr('d2-exported-last.err'));
  assert.match(reason, /Error: npm install failed in/);
  assert.doesNotMatch(reason, /EXPORTED/);
});

test('upgradePackage 失败原因: ESBUILD_ 行不压过其前的 Error 行', async () => {
  const reason = await reasonFor(failureStderr('d3-esbuild-last.err'));
  assert.match(reason, /native build failed/);
  assert.doesNotMatch(reason, /ESBUILD/);
});

test('upgradePackage 失败原因: EXEC 行不压过其后的 Error 行', async () => {
  const reason = await reasonFor(failureStderr('d4-exec-first.err'));
  assert.match(reason, /npm install failed in/);
  assert.doesNotMatch(reason, /^EXEC/);
});

test('upgradePackage 失败原因: E404 行压过其后带提示词的 warning 行', async () => {
  const reason = await reasonFor(failureStderr('e404-vs-hint.err'));
  assert.match(reason, /E404 fetching tarball/);
  assert.doesNotMatch(reason, /warning: retry/);
});

test('upgradePackage 失败原因: 位置层取最后一条无标记行', async () => {
  const reason = await reasonFor(failureStderr('f-position-cp.err'));
  assert.match(reason, /cp: cannot create regular file/);
  assert.doesNotMatch(reason, /step 1\/4/);
});

test('upgradePackage 失败原因: TypeError 也是错误名起始', async () => {
  const reason = await reasonFor(failureStderr('crash-typeerror.err'));
  assert.match(reason, /TypeError: Cannot read properties/);
});

test('upgradePackage 失败原因: 方括号 dump 头取 TypeError 行, 不取 code 片段', async () => {
  const reason = await reasonFor(failureStderr('crash-fetch-dump.err'));
  assert.match(reason, /\[TypeError: fetch failed\]/);
  assert.doesNotMatch(reason, /^code:/);
});

test('upgradePackage 失败原因: 以 at least 开头的人读行不被栈帧规则吃掉', async () => {
  const reason = await reasonFor(failureStderr('info-at-least-one.err'));
  assert.match(reason, /at least one dependency failed to install/);
});

test('upgradePackage 失败原因: 以 debug 日志结尾的人读行保留内容', async () => {
  const reason = await reasonFor(failureStderr('info-ends-with-log.err'));
  assert.match(reason, /install failed: see .*debug-0\.log/);
});

test('upgradePackage 失败原因: 无 code 的 debug 日志结尾人读行同样保留', async () => {
  const reason = await reasonFor(failureStderr('info-codeless-ends-with-log.err'));
  assert.match(reason, /Error: package install failed/);
});

test('upgradePackage 失败原因: 无 code 的 at least 行不被栈帧规则吃掉', async () => {
  const reason = await reasonFor(failureStderr('info-codeless-at-least-one.err'));
  assert.match(reason, /at least one runtime dependency failed/);
});

test('upgradePackage 失败原因: 只含路径的行才算指针行', async () => {
  const stderr = ['npm error code EACCES', 'npm error cannot write /home/op/x-debug.log'].join('\n');
  const reason = await reasonFor(stderr);
  assert.match(reason, /code EACCES/);
  assert.match(reason, /cannot write/);
});

test('upgradePackage 失败原因: 无 code 的诊断行带日志路径时仍被选中', async () => {
  const stderr = ['EACCES: permission denied, open /home/op/x-debug.log', 'progress 1/3'].join('\n');
  const reason = await reasonFor(stderr);
  assert.match(reason, /EACCES: permission denied/);
  assert.doesNotMatch(reason, /progress 1\/3/);
});

test('upgradePackage 失败原因: npm 9 pty 行里的 ERR! token 可移位', async () => {
  const reason = await reasonFor(failureStderr('legacy-pty-npm9.err'));
  assert.match(reason, /code ETARGET/);
  assert.match(reason, /No matching version found/);
});

test('upgradePackage 失败: 信号致死不报 exit null', async () => {
  const killed = { status: null, signal: 'SIGKILL', stdout: '', stderr: '' };
  const r = await upgradePackage({ target: 'opencode' }, { doQuery: stubQuery, spawnFn: () => killed });
  assert.equal(r.success, false);
  assert.match(r.error ?? '', /SIGKILL/);
  assert.doesNotMatch(r.error ?? '', /exit null/);
});

test('upgradePackage 升级子进程: 凭据谓词剥掉凭据, 保留子图配置与镜像 pin', async () => {
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
  // Non-credential namespace members the upgrade child's own update graph reads,
  // grouped by the behaviour they carry.
  const preserveGroups = {
    hcloudBinary: 'HCLOUD_BIN HCLOUD_BIN_ARGS_JSON HCLOUD_CONFIG_PATH HCLOUD_META_DIR HCLOUD_OBS_CONFIG_PATH',
    stateRoot: 'HUAWEICLOUD_HOME HUAWEICLOUD_DEVKIT_HOME HUAWEICLOUD_DEVKIT_DEBUG',
    registry: 'HUAWEICLOUD_NPM_REGISTRY',
    installSkips:
      'HUAWEICLOUD_DEVKIT_SKIP_DSH_PLUGIN_INSTALL HUAWEICLOUD_DEVKIT_SKIP_OFFICEACE_DETECT HUAWEICLOUD_DEVKIT_SKIP_UPDATE',
    telemetry: 'HUAWEICLOUD_DEVKIT_TELEMETRY HUAWEICLOUD_DEVKIT_TELEMETRY_ENDPOINT',
    surface:
      'HUAWEICLOUD_ICONS_OFFLINE HUAWEICLOUD_OPENCODE_PERMISSION_SEAM HUAWEICLOUD_REGION HUAWEICLOUD_VENDOR_CHALLENGE',
    endpoints: 'HUAWEICLOUD_INJECT_STS_CMD HUAWEICLOUD_MCP_POLICY_FILE HW_IAM_ENDPOINT HW_REGION HW_WORKSPACE_ID',
    sandbox: 'HW_POOL_TEMPLATE_EPHEMERAL HW_POOL_TEMPLATE_PERSISTENT HW_SANDBOX_POOL_CACHE_PATH HW_STS_EXPIRES_AT',
  };
  const preserveKeys = Object.values(preserveGroups).join(' ').split(' ');
  for (const key of [...credentialKeys, ...preserveKeys]) {
    assert.equal(isCredentialEnvVarName(key), true, `${key} sits in the predicate namespace`);
  }
  const prefixes = [...new Set(preserveKeys.map((key) => `${key.split('_')[0]}_`))];
  const unlistedKeys = prefixes.map((prefix) => `${prefix}UNLISTED_CREDENTIAL_PROBE`);
  assert.equal(unlistedKeys.filter((key) => isCredentialEnvVarName(key)).length, prefixes.length);
  const marker = 'DEVKIT_UPGRADE_ENV_MARKER';
  assert.equal(isCredentialEnvVarName(marker), false, 'the control must be predicate-negative');
  const mirror = 'http://127.0.0.1:4873';
  const touched = [...credentialKeys, ...extraKeys, ...preserveKeys, ...unlistedKeys, marker];
  const saved = new Map(touched.map((key) => [key, process.env[key]]));
  const savedRegistry = process.env.HUAWEICLOUD_NPM_REGISTRY;
  for (const key of touched) process.env[key] = `fixture-${key}`;
  process.env.HUAWEICLOUD_NPM_REGISTRY = mirror;
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
    for (const key of [...credentialKeys, ...extraKeys, ...unlistedKeys]) {
      assert.equal(env[key], undefined, `${key} must not reach npx`);
    }
    for (const key of preserveKeys) {
      if (key === 'HUAWEICLOUD_NPM_REGISTRY') continue;
      assert.equal(env[key], `fixture-${key}`, `${key} must reach npx`);
    }
    assert.equal(env.HUAWEICLOUD_NPM_REGISTRY, mirror);
    assert.equal(env[marker], `fixture-${marker}`);
    assert.equal(env.PATH, process.env.PATH);
    assert.equal(env.HOME, process.env.HOME);
    assert.deepEqual(registrySpellings(env), ['npm_config_registry'], 'one registry spelling reaches npx');
    assert.equal(env.npm_config_registry, mirror, 'the child npm config follows the operator mirror');
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (savedRegistry === undefined) delete process.env.HUAWEICLOUD_NPM_REGISTRY;
    else process.env.HUAWEICLOUD_NPM_REGISTRY = savedRegistry;
  }
});

test('upgradePackage 升级子进程: devkit 镜像未设时保留操作者的 npm_config_registry', async () => {
  const mirror = 'http://127.0.0.1:4873';
  await withEnv({ ...NO_REGISTRY, npm_config_registry: mirror }, async () => {
    const env = await childEnv();
    assert.equal(env.npm_config_registry, mirror, 'the operator registry reaches the child');
    assert.deepEqual(registrySpellings(env), ['npm_config_registry'], 'no second spelling appears');
  });
});

test('upgradePackage 升级子进程: devkit 镜像未设时不注入 registry, .npmrc 仍然生效', async () => {
  await withEnv(NO_REGISTRY, async () => {
    const env = await childEnv();
    assert.deepEqual(registrySpellings(env), [], 'npm keeps its own config channels');
  });
});

test('upgradePackage 升级子进程: devkit 镜像设了时两种拼写都收敛到 pin', async () => {
  const pin = 'http://devkit-mirror.corp.local:4873';
  await withEnv(
    {
      HUAWEICLOUD_NPM_REGISTRY: pin,
      npm_config_registry: 'http://operator-mirror.corp.local:4873',
      NPM_CONFIG_REGISTRY: 'http://operator-upper.corp.local:4873',
    },
    async () => {
      const env = await childEnv();
      assert.deepEqual(registrySpellings(env), ['npm_config_registry'], 'one spelling survives');
      assert.equal(env.npm_config_registry, pin, 'the devkit pin wins deterministically');
      assert.equal(env.HUAWEICLOUD_NPM_REGISTRY, pin, 'the devkit override reaches the child');
    },
  );
});

test('upgradePackage 升级子进程: devkit 镜像的大小写拼写收敛到一个通道', async () => {
  const upper = 'http://upper-mirror.corp.local:4873';
  const lower = 'http://lower-mirror.corp.local:4873';
  await withEnv(
    {
      HUAWEICLOUD_NPM_REGISTRY: upper,
      huaweicloud_npm_registry: lower,
      npm_config_registry: undefined,
      NPM_CONFIG_REGISTRY: undefined,
    },
    async () => {
      const env = await childEnv();
      assert.deepEqual(
        Object.keys(env).filter((key) => key.toUpperCase() === 'HUAWEICLOUD_NPM_REGISTRY'),
        ['HUAWEICLOUD_NPM_REGISTRY'],
        'one canonical devkit spelling reaches the child',
      );
      assert.equal(env.HUAWEICLOUD_NPM_REGISTRY, upper, 'the exact-case spelling wins');
      assert.equal(env.npm_config_registry, env.HUAWEICLOUD_NPM_REGISTRY, 'both channels agree');
    },
  );
});

test('upgradePackage 升级子进程: 全空时由 npm 自己的公共默认决定', async () => {
  await withEnv(NO_REGISTRY, async () => {
    const env = await childEnv();
    assert.equal(env.npm_config_registry, undefined);
    assert.deepEqual(registrySpellings(env), []);
  });
});

test('fixtures: no update failure capture embeds a scratch or operator path', () => {
  const dir = fileURLToPath(FAILURE_FIXTURES);
  const offenders = readdirSync(dir)
    .filter((name) => name.endsWith('.err'))
    .filter((name) => {
      const text = readFileSync(join(dir, name), 'utf8');
      return text.includes('/tmp') || text.includes('/home/yanchengyu');
    });
  assert.deepEqual(offenders, []);
});
