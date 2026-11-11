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

test('upgradePackage 失败原因: 无前缀崩溃行压过 npm 块的 command 回声', async () => {
  const reason = await reasonFor(failureStderr('crash-before-block-typeerror.err'));
  assert.match(reason, /TypeError: Cannot read properties/);
  assert.doesNotMatch(reason, /command sh -c/);
});

test('upgradePackage 失败原因: 无前缀 Error 崩溃行同样压过 command 回声', async () => {
  const reason = await reasonFor(failureStderr('crash-before-block-error.err'));
  assert.match(reason, /Error: ENOENT: no such file or directory/);
  assert.doesNotMatch(reason, /command sh -c/);
});

test('upgradePackage 失败原因: 第二份崩溃捕获也走同一竞争规则', async () => {
  const reason = await reasonFor(failureStderr('crash-before-block-typeerror-r2.err'));
  assert.match(reason, /TypeError: Cannot read properties/);
  assert.doesNotMatch(reason, /command sh -c/);
});

test('upgradePackage 失败原因: 无前缀 Error 行压过 npm 块的进度回声', async () => {
  const reason = await reasonFor(failureStderr('progress-before-block.err'));
  assert.match(reason, /prebuilt binary download failed/);
  assert.doesNotMatch(reason, /command sh -c/);
});

test('upgradePackage 失败原因: phase 冒号后的 EXTRACT 不是强标记', async () => {
  const reason = await reasonFor(failureStderr('n1a-phase-exec.err'));
  assert.match(reason, /EACCES: permission denied/);
  assert.doesNotMatch(reason, /phase: EXTRACT/);
});

test('upgradePackage 失败原因: 块内的 phase EXTRACT 也不压过 Error 行', async () => {
  const reason = await reasonFor(failureStderr('n1b-block-phase-exec.err'));
  assert.match(reason, /Error: npm install failed/);
  assert.doesNotMatch(reason, /phase: EXTRACT/);
});

test('upgradePackage 失败原因: status 冒号后的 EXIT 不是强标记', async () => {
  const reason = await reasonFor(failureStderr('n1c-status-exit.err'));
  assert.match(reason, /EACCES: permission denied/);
  assert.doesNotMatch(reason, /status: EXIT/);
});

test('upgradePackage 失败原因: mode 冒号后的 ENABLED 不是强标记', async () => {
  const reason = await reasonFor(failureStderr('n1d-mode-enabled.err'));
  assert.match(reason, /EACCES: permission denied/);
  assert.doesNotMatch(reason, /mode: ENABLED/);
});

test('upgradePackage 失败原因: trace 冒号后的 EXPORTED 不是强标记', async () => {
  const reason = await reasonFor(failureStderr('n1e-trace-exported.err'));
  assert.match(reason, /EACCES: permission denied/);
  assert.doesNotMatch(reason, /trace: EXPORTED/);
});

test('upgradePackage 失败原因: hint 冒号后的 ESBUILD 不是强标记', async () => {
  const reason = await reasonFor(failureStderr('n1f-hint-esbuild.err'));
  assert.match(reason, /Error: npm install failed/);
  assert.doesNotMatch(reason, /ESBUILD/);
});

test('upgradePackage 失败原因: log 冒号后的 EVENTS 不是强标记', async () => {
  const reason = await reasonFor(failureStderr('n1g-log-events.err'));
  assert.match(reason, /ECONNREFUSED 127\.0\.0\.1:9/);
  assert.doesNotMatch(reason, /EVENTS/);
});

test('upgradePackage 失败原因: EXPORTED 的屈折形也排除', async () => {
  const reason = await reasonFor(failureStderr('exported-inflected.err'));
  assert.match(reason, /Error: npm install failed/);
  assert.doesNotMatch(reason, /EXTRACTED/);
});

test('upgradePackage 失败原因: EVALUATING 的屈折形也排除', async () => {
  const reason = await reasonFor(failureStderr('evaluating-block.err'));
  assert.match(reason, /EACCES: permission denied/);
  assert.doesNotMatch(reason, /EVALUATING/);
});

test('upgradePackage 失败原因: 同层强标记取靠后的致命行', async () => {
  const reason = await reasonFor(failureStderr('retry-then-fatal.err'));
  assert.match(reason, /EACCES: permission denied/);
  assert.doesNotMatch(reason, /retrying/);
});

test('upgradePackage 失败原因: 块内同层强标记同样取靠后的行', async () => {
  const reason = await reasonFor(failureStderr('marker-both-sides.err'));
  assert.match(reason, /code 1/);
  assert.match(reason, /EACCES: permission denied/);
  assert.doesNotMatch(reason, /retrying/);
});

test('upgradePackage 失败原因: 同层提示词取靠前的真实失败行', async () => {
  const reason = await reasonFor(failureStderr('cleanup-after-cause.err'));
  assert.match(reason, /install failed: could not reach registry/);
  assert.doesNotMatch(reason, /cleanup failed/);
});

test('upgradePackage 失败原因: 块内同层提示词同样取靠前的行', async () => {
  const reason = await reasonFor(failureStderr('cleanup-after-cause-block.err'));
  assert.match(reason, /install failed: could not reach registry/);
  assert.doesNotMatch(reason, /cleanup failed/);
});

test('upgradePackage 失败原因: 中文提示词同层取靠前的失败行', async () => {
  const reason = await reasonFor(failureStderr('cleanup-after-cause-zh.err'));
  assert.match(reason, /升级失败/);
  assert.doesNotMatch(reason, /清理失败/);
});

test('upgradePackage 失败原因: 行中 error 词仍可作提示', async () => {
  const reason = await reasonFor(failureStderr('mid-error-name.err'));
  assert.match(reason, /Cannot install: TypeError/);
  assert.doesNotMatch(reason, /Downloading/);
});

test('upgradePackage 失败原因: 块内行中 error 词也作提示', async () => {
  const reason = await reasonFor(failureStderr('mid-error-name-block.err'));
  assert.match(reason, /Cannot install: TypeError/);
  assert.doesNotMatch(reason, /Downloading/);
});

test('upgradePackage 失败原因: 块内 at least 行不被栈帧规则吃掉', async () => {
  const reason = await reasonFor(failureStderr('at-least-block.err'));
  assert.match(reason, /at least one dependency failed/);
});

test('upgradePackage 失败原因: 数组形元数据片段不压过人读行', async () => {
  const reason = await reasonFor(failureStderr('metadata-array-fragment.err'));
  assert.match(reason, /installing native addon/);
  assert.doesNotMatch(reason, /requireStack/);
});

test('upgradePackage 失败原因: 只有路径的一行仍是指针行', async () => {
  const reason = await reasonFor(failureStderr('pointer-last-codeless.err'));
  assert.match(reason, /install failed while unpacking payload/);
  assert.doesNotMatch(reason, /debug-0\.log/);
});

test('upgradePackage 失败原因: 相对路径指针行也被丢掉', async () => {
  const reason = await reasonFor(failureStderr('relative-pointer-codeless.err'));
  assert.match(reason, /install failed while unpacking payload/);
  assert.doesNotMatch(reason, /npm-debug\.log/);
});

test('upgradePackage 失败原因: 标签加日志路径的行按指针行处理', async () => {
  const stderr = [
    'log: /home/op/logs/2026-debug-0.log',
    "cp: cannot create regular file 'ro/hostname': Permission denied",
  ].join('\n');
  const reason = await reasonFor(stderr);
  assert.match(reason, /cp: cannot create regular file/);
  assert.doesNotMatch(reason, /debug-0\.log/);
});

test('upgradePackage 失败原因: at new Promise 形状的帧被丢掉', async () => {
  const stderr = [
    'at new Promise (<anonymous>)',
    "cp: cannot create regular file 'ro/hostname': Permission denied",
  ].join('\n');
  const reason = await reasonFor(stderr);
  assert.match(reason, /cp: cannot create regular file/);
  assert.doesNotMatch(reason, /at new Promise/);
});

test('upgradePackage 失败原因: 文件 URI 与 node 帧被丢掉', async () => {
  const stderr = ['    at file:///home/op/x.js:1:1', '    at node:internal/main:1:1', 'payload copy stopped'].join(
    '\n',
  );
  const reason = await reasonFor(stderr);
  assert.match(reason, /payload copy stopped/);
  assert.doesNotMatch(reason, /file:\/\/|node:internal/);
});

test('upgradePackage 失败原因: 大写 E 进度词无论词表都不冒充 errno', async () => {
  const masqueraders = [
    'EVICTED',
    'EXCLUDED',
    'ENQUEUED',
    'EXPIRED',
    'EXISTS',
    'EVAL',
    'ECHO',
    'ESCAPED',
    'EXPECTED',
    'ERASED',
    'ERRORS',
    'ENCODING',
    'ENTERING',
    'EXPANDING',
    'ESTIMATING',
  ];
  const cause = 'install failed: could not reach registry';
  for (const token of masqueraders) {
    const reason = await reasonFor([`${token} 12 entries, continuing`, cause].join('\n'));
    assert.equal(reason, cause, `${token} must not outrank the cause`);
  }
});

test('upgradePackage 失败原因: 真 errno 在行首与冒号两种位置仍被识别', async () => {
  const cases: [string, string][] = [
    ['EACCES: permission denied, open /home/op/x', 'EACCES'],
    ['ENOTFOUND registry.internal.corp', 'ENOTFOUND'],
    ['E404 fetching tarball', 'E404'],
    ['EAI_AGAIN: Temporary failure', 'EAI_AGAIN'],
  ];
  for (const [cause, code] of cases) {
    const reason = await reasonFor([cause, 'cleanup finished'].join('\n'));
    assert.match(reason, new RegExp(code), `${cause} keeps its code`);
  }
});

test('upgradePackage 失败原因: 真实 lifecycle 进度行不压过失败行', async () => {
  const reason = await reasonFor(failureStderr('mask-evicted-lifecycle.err'));
  assert.match(reason, /install failed: could not reach registry/);
  assert.doesNotMatch(reason, /EVICTED/);
});

test('upgradePackage 失败原因: 中文指针短语行不进原因', async () => {
  const reason = await reasonFor(failureStderr('zh-pointer-phrase-2line.err'));
  assert.match(reason, /cp: cannot create regular file/);
  assert.doesNotMatch(reason, /完整的运行日志|debug-0\.log/);
});

test('upgradePackage 失败原因: 中文标签指针行不进原因', async () => {
  const reason = await reasonFor(failureStderr('zh-label-pointer.err'));
  assert.match(reason, /cp: cannot create regular file/);
  assert.doesNotMatch(reason, /日志|debug-0\.log/);
});

test('upgradePackage 失败原因: 中文全角标签指针行不进原因', async () => {
  const reason = await reasonFor(failureStderr('zh-fullcolon-pointer.err'));
  assert.match(reason, /cp: cannot create regular file/);
  assert.doesNotMatch(reason, /日志|debug-0\.log/);
});

test('upgradePackage 失败原因: 块内中文指针行不进原因', async () => {
  const stderr = [
    'npm error code 1',
    'npm error install failed: could not reach registry',
    'npm error 完整的运行日志可在以下位置找到: /home/op/logs/2026-debug-0.log',
  ].join('\n');
  const reason = await reasonFor(stderr);
  assert.match(reason, /install failed: could not reach registry/);
  assert.doesNotMatch(reason, /完整的运行日志|debug-0\.log/);
});

test('upgradePackage 失败原因: npm 6 遗留指针短语不进原因', async () => {
  const reason = await reasonFor(failureStderr('legacy-pointer-phrase.err'));
  assert.match(reason, /code ELIFECYCLE/);
  assert.doesNotMatch(reason, /Please include the following file|debug-0\.log/);
});

test('upgradePackage 失败原因: 真实 V8 的 [as alias] 帧被丢掉', async () => {
  const stderr = [
    "cp: cannot create regular file 'ro/hostname': Permission denied",
    '    at Module.executeUserEntryPoint [as runMain] (node:internal/modules/run_main:171:5)',
  ].join('\n');
  const reason = await reasonFor(stderr);
  assert.match(reason, /cp: cannot create regular file/);
  assert.doesNotMatch(reason, /runMain|at Module/);
});

test('upgradePackage 失败原因: 真实崩溃捕获的 [as alias] 帧不进原因', async () => {
  const reason = await reasonFor(failureStderr('crash-aliased-frame.err'));
  assert.match(reason, /TypeError: Cannot read properties/);
  assert.doesNotMatch(reason, /runMain|at Module/);
});

test('upgradePackage 失败原因: 无位置帧与 wasm 帧被丢掉', async () => {
  for (const fixture of ['frame-anon.err', 'frame-wasm.err']) {
    const reason = await reasonFor(failureStderr(fixture));
    assert.match(reason, /payload copy stopped/);
    assert.doesNotMatch(reason, /wasm|<anonymous>/);
  }
});

test('upgradePackage 失败原因: 只有代码行的块把代码前缀粘到弱 codeless 行', async () => {
  const stderr = ['npm error code E404', 'progress 1/2'].join('\n');
  const reason = await reasonFor(stderr);
  assert.match(reason, /npm error code E404/);
  assert.match(reason, /progress 1\/2/);
});

test('upgradePackage 失败原因: 只有代码行的块把代码前缀粘到元数据行', async () => {
  const stderr = ['npm error code E404', 'errno: -2'].join('\n');
  const reason = await reasonFor(stderr);
  assert.match(reason, /npm error code E404/);
  assert.match(reason, /errno: -2/);
});

test('upgradePackage 失败原因: cp 失败行压过其后的 cleanup 行', async () => {
  const stderr = [
    "cp: cannot create regular file 'assets/policy.json': Permission denied",
    'cleanup: removed 3 stale staging dirs',
  ].join('\n');
  const reason = await reasonFor(stderr);
  assert.match(reason, /cp: cannot create regular file/);
  assert.doesNotMatch(reason, /cleanup: removed/);
});

test('upgradePackage 失败原因: 块内进度前缀不压过其后的 cp 失败行', async () => {
  const stderr = [
    'npm error code 1',
    'npm error huaweicloud-devkit update: step 2/5 syncing payload',
    "npm error cp: cannot create regular file 'assets/policy.json': Permission denied",
  ].join('\n');
  const reason = await reasonFor(stderr);
  assert.match(reason, /cp: cannot create regular file/);
  assert.doesNotMatch(reason, /step 2\/5/);
});

test('upgradePackage 失败原因: 裸相对指针行被丢掉', async () => {
  const stderr = ['npm error code 1', 'npm error ./npm-debug.log', 'npm error tarball unpack aborted'].join('\n');
  const reason = await reasonFor(stderr);
  assert.match(reason, /tarball unpack aborted/);
  assert.doesNotMatch(reason, /npm-debug\.log/);
});

test('upgradePackage 失败原因: 带括号的 at 句子不被当成帧', async () => {
  const stderr = ['at startup (retry 1) the payload copy failed with EACCES writing /opt/devkit'].join('\n');
  const reason = await reasonFor(stderr);
  assert.match(reason, /at startup \(retry 1\)/);
});

test('upgradePackage 失败原因: 块内位置层取靠前的行', async () => {
  const stderr = ['npm error code 1', 'npm error staging payload (1/2)', 'npm error finalizing payload (2/2)'].join(
    '\n',
  );
  const reason = await reasonFor(stderr);
  assert.match(reason, /staging payload \(1\/2\)/);
  assert.doesNotMatch(reason, /finalizing payload/);
});

test('upgradePackage 失败原因: 无 code 的位置层取最后的行', async () => {
  const stderr = ['progress 1/2', 'progress 2/2'].join('\n');
  const reason = await reasonFor(stderr);
  assert.match(reason, /progress 2\/2/);
  assert.doesNotMatch(reason, /progress 1\/2/);
});

test('upgradePackage 失败原因: 中文标签指针行在没有提示词竞争时也被剥掉', async () => {
  const stderr = ['payload copy stopped', '日志: /home/op/logs/2026-debug-0.log'].join('\n');
  const reason = await reasonFor(stderr);
  assert.equal(reason, 'payload copy stopped');
});

test('upgradePackage 失败原因: 中文全角标签指针行同样被剥掉', async () => {
  const stderr = ['payload copy stopped', '日志：/home/op/logs/2026-debug-0.log'].join('\n');
  const reason = await reasonFor(stderr);
  assert.equal(reason, 'payload copy stopped');
});

test('upgradePackage 失败原因: 块内中文标签指针行不进原因', async () => {
  const stderr = [
    'npm error code 1',
    'npm error 日志: /home/op/logs/2026-debug-0.log',
    'npm error payload copy stopped',
  ].join('\n');
  const reason = await reasonFor(stderr);
  assert.match(reason, /npm error code 1/);
  assert.match(reason, /payload copy stopped/);
  assert.doesNotMatch(reason, /日志|debug-0\.log/);
});

test('upgradePackage 失败原因: cleanup aborted 不压过其后的 cp 失败行', async () => {
  const stderr = [
    'cleanup aborted: 3 stale locks removed',
    "cp: cannot create regular file 'assets/policy.json': Permission denied",
  ].join('\n');
  const reason = await reasonFor(stderr);
  assert.match(reason, /cp: cannot create regular file/);
  assert.doesNotMatch(reason, /cleanup aborted/);
});

test('upgradePackage 失败原因: EINTEGRITY 在封闭词表内', async () => {
  const reason = await reasonFor(
    ['EINTEGRITY: sha512 mismatch', 'install failed: could not reach registry'].join('\n'),
  );
  assert.match(reason, /EINTEGRITY: sha512 mismatch/);
});

test('upgradePackage 失败原因: EUSAGE 在封闭词表内', async () => {
  const reason = await reasonFor(
    ['EUSAGE: invalid config value', 'install failed: could not reach registry'].join('\n'),
  );
  assert.match(reason, /EUSAGE: invalid config value/);
});

test('upgradePackage 失败原因: 冒号位置的真 errno 也被识别', async () => {
  const reason = await reasonFor(['pipelines: E404 not present', 'cleanup failed later'].join('\n'));
  assert.match(reason, /E404 not present/);
  assert.doesNotMatch(reason, /cleanup failed later/);
});

test('upgradePackage 失败原因: 裸 EACCES 行在行首也被识别', async () => {
  const reason = await reasonFor(['EACCES', 'install failed: could not reach registry'].join('\n'));
  assert.equal(reason, 'EACCES');
});

test('upgradePackage 失败原因: 括号里带冒号的散文不是帧', async () => {
  const reason = await reasonFor('at startup (step 2: syncing payload)');
  assert.match(reason, /at startup \(step 2: syncing payload\)/);
});

test('upgradePackage 失败原因: 中文短语的另一种措辞也被剥掉', async () => {
  const stderr = [
    "cp: cannot create regular file '/home/op/x': Permission denied",
    '本次运行的完整日志可在以下位置找到: /home/op/logs/2026-debug-0.log',
  ].join('\n');
  const reason = await reasonFor(stderr);
  assert.match(reason, /cp: cannot create regular file/);
  assert.doesNotMatch(reason, /运行日志|debug-0\.log/);
});

test('upgradePackage 失败原因: 冒号位置的大写进度词同样不冒充', async () => {
  const masqueraders = ['EVICTED', 'ENQUEUED', 'EXPIRED', 'EXISTS', 'EVAL', 'ECHO', 'ESCAPED', 'EXPECTED', 'ERASED'];
  const cause = 'install failed: could not reach registry';
  for (const token of masqueraders) {
    const reason = await reasonFor([`cache: ${token} 12 entries`, cause].join('\n'));
    assert.equal(reason, cause, `${token} after a colon must not outrank the cause`);
  }
});

test('upgradePackage 失败原因: command 回显里的子进程诊断词不抢子进程自己的行', async () => {
  const reason = await reasonFor(failureStderr('command-echo-tie.err'));
  assert.match(reason, /native build failed: missing libfoo. rebuild aborted/);
  assert.doesNotMatch(reason, /command sh -c|code 7/);
});

test('upgradePackage 失败原因: 没有子进程文本时 command 回显仍是诚实兜底', async () => {
  const stderr = [
    'npm error code 1',
    'npm error path /home/op/x',
    'npm error command failed',
    'npm error command sh -c npm test',
    'npm error A complete log of this run can be found in: /home/op/logs/2026-debug-0.log',
  ].join('\n');
  const reason = await reasonFor(stderr);
  assert.match(reason, /code 1/);
  assert.match(reason, /command sh -c npm test/);
});

test('upgradePackage 失败原因: 冒号前带空格的中文标签指针行也剥掉', async () => {
  const stderr = ['payload copy stopped', '日志 : /home/op/logs/2026-debug-0.log'].join('\n');
  const reason = await reasonFor(stderr);
  assert.equal(reason, 'payload copy stopped');
});

test('upgradePackage 失败原因: 真实 eval 嵌套帧全部丢掉', async () => {
  const reason = await reasonFor(failureStderr('crash-eval-nested.err'));
  assert.match(reason, /Error: payload copy stopped/);
  assert.doesNotMatch(reason, /at eval|eval at <anonymous>/);
});

test('upgradePackage 失败原因: 嵌套 eval 帧不压过弱位置层行', async () => {
  const stderr = [
    'payload copy stopped',
    '    at eval (eval at <anonymous> (eval at <anonymous> ([eval]:1:1)), <anonymous>:1:7)',
  ].join('\n');
  const reason = await reasonFor(stderr);
  assert.equal(reason, 'payload copy stopped');
});

test('upgradePackage 失败原因: EINVALIDPACKAGENAME 在封闭词表内', async () => {
  const reason = await reasonFor(['EINVALIDPACKAGENAME: name contains uppercase letters', 'progress 1/2'].join('\n'));
  assert.match(reason, /EINVALIDPACKAGENAME/);
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

test('upgradePackage 升级子进程: 空的 exact-case 值让位给非空变体', async () => {
  const lower = 'http://lower-mirror.corp.local:4873';
  await withEnv(
    {
      HUAWEICLOUD_NPM_REGISTRY: '',
      huaweicloud_npm_registry: lower,
      npm_config_registry: undefined,
      NPM_CONFIG_REGISTRY: undefined,
    },
    async () => {
      const env = await childEnv();
      assert.equal(env.HUAWEICLOUD_NPM_REGISTRY, lower, 'the non-empty variant wins');
      assert.equal(env.npm_config_registry, lower, 'both channels agree');
      assert.deepEqual(
        Object.keys(env).filter((key) => key.toUpperCase() === 'HUAWEICLOUD_NPM_REGISTRY'),
        ['HUAWEICLOUD_NPM_REGISTRY'],
      );
    },
  );
});

test('upgradePackage 升级子进程: 纯空白的 exact-case 值按未设处理', async () => {
  await withEnv(
    { HUAWEICLOUD_NPM_REGISTRY: '   ', npm_config_registry: 'http://operator-keep:1', NPM_CONFIG_REGISTRY: undefined },
    async () => {
      const env = await childEnv();
      assert.equal(env.HUAWEICLOUD_NPM_REGISTRY, undefined, 'the whitespace key never reaches the child');
      assert.equal(env.npm_config_registry, 'http://operator-keep:1', 'the operator channel is untouched');
    },
  );
});

test('upgradePackage 升级子进程: exact-case 优先于插入顺序', async () => {
  const upper = 'http://upper-mirror.corp.local:4873';
  const lower = 'http://lower-mirror.corp.local:4873';
  await withEnv(
    {
      huaweicloud_npm_registry: lower,
      HUAWEICLOUD_NPM_REGISTRY: upper,
      npm_config_registry: undefined,
      NPM_CONFIG_REGISTRY: undefined,
    },
    async () => {
      const env = await childEnv();
      assert.equal(env.HUAWEICLOUD_NPM_REGISTRY, upper, 'exact case wins regardless of order');
      assert.equal(env.npm_config_registry, upper);
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

function pathOffenders(texts: Record<string, string>): string[] {
  return Object.entries(texts)
    .filter(([, text]) => {
      const normalized = text.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
      return (
        normalized.includes('/tmp') || normalized.includes('/home/yanchengyu') || normalized.includes('yanchengyu')
      );
    })
    .map(([name]) => name);
}

test('fixtures: no update failure capture embeds a scratch or operator path', () => {
  const dir = fileURLToPath(FAILURE_FIXTURES);
  const fixtures = Object.fromEntries(
    readdirSync(dir)
      .filter((name) => name.endsWith('.err'))
      .map((name) => [name, readFileSync(join(dir, name), 'utf8')]),
  );
  assert.deepEqual(pathOffenders(fixtures), []);
});

test('fixtures guard: windows and double-slash spellings are caught', () => {
  const bypasses = {
    'windows.err': 'C:\\Users\\yanchengyu\\.npm\\_logs\\2026-debug-0.log',
    'doubleslash.err': '/home//yanchengyu/.npm/_logs/2026-debug-0.log',
    'username-only.err': 'home of yanchengyu',
  };
  assert.deepEqual(
    pathOffenders(bypasses).sort((a, b) => a.localeCompare(b)),
    ['doubleslash.err', 'username-only.err', 'windows.err'],
  );
});
