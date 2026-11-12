import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
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
import { fixtureDir } from './fixture-dir.ts';

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
  assert.deepEqual(spawned!.args, [
    '--yes',
    '--foreground-scripts',
    'huaweicloud-devkit@latest',
    'update',
    '--target',
    'opencode',
  ]);
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
  const spawnFn = () => ({ status: 1, stdout: '', stderr: 'npm error code 1\nEPERM: permission denied' });
  const doQuery = async () => ({ latest: '1.1.1', next: null });
  const r = await upgradePackage({ target: 'opencode' }, { doQuery, spawnFn });
  assert.equal(r.success, false);
  assert.match(r.manual ?? '', /npx --yes --foreground-scripts huaweicloud-devkit@latest update --target opencode/);
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

async function errorForSpawn(result: {
  status?: number | null;
  signal?: string | null;
  stderr?: string;
  error?: Error;
}): Promise<string> {
  const r = await upgradePackage(
    { target: 'opencode' },
    { doQuery: stubQuery, spawnFn: () => ({ stdout: '', ...result }) },
  );
  assert.equal(r.success, false);
  return r.error ?? '';
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

type TokenRegistryStub = {
  registry: string;
  port: number;
  seen: Array<string | undefined>;
  requested: string[];
};

// A token-guarded local dist-tags stub shared by the pre-flight tests: one
// server lifecycle and one env save/restore, so the request shapes stay the
// subject of each case.
async function withTokenRegistry(
  token: string | string[],
  options: { latest?: string },
  run: (stub: TokenRegistryStub) => Promise<void>,
): Promise<void> {
  const accepted = (Array.isArray(token) ? token : [token]).filter(Boolean).map((value) => `Bearer ${value}`);
  const seen: Array<string | undefined> = [];
  const requested: string[] = [];
  const server = createServer((req, res) => {
    seen.push(req.headers.authorization);
    requested.push(req.url ?? '');
    if (accepted.length && !accepted.includes(req.headers.authorization ?? '')) {
      res.statusCode = 401;
      res.end('unauthorized');
      return;
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ latest: options.latest ?? '9.9.9', next: null }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  try {
    await run({ registry: `http://127.0.0.1:${address.port}`, port: address.port, seen, requested });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function withSavedEnv(keys: string[], run: () => Promise<void>): Promise<void> {
  const saved = new Map(keys.map((key) => [key, process.env[key]] as const));
  try {
    await run();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
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
  const reason = await reasonFor(['npm error code 1', failureStderr('install-failed.err').trim()].join('\n'));
  assert.match(reason, /npm install failed in/);
  assert.match(reason, /404 tarball, folder, http url, or git url/);
  assert.doesNotMatch(reason, /-debug-\d+\.log/);
  assert.doesNotMatch(reason, /^exit /);
});

test('upgradePackage 失败原因: 第二条单行安装失败同样保留代理诊断', async () => {
  const reason = await reasonFor(['npm error code 1', failureStderr('install-failed-proxy.err').trim()].join('\n'));
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
  const reason = await reasonFor(['npm error code 1', failureStderr('binfail.err').trim()].join('\n'));
  assert.match(reason, /不支持的升级目标/);
  assert.doesNotMatch(reason, /^AUDIT/);
});

test('upgradePackage 失败原因: 无 code 行的 EACCES 行盖过前置审计行', async () => {
  const reason = await reasonFor(['npm error code 1', failureStderr('b1-audit-eacces.err').trim()].join('\n'));
  assert.match(reason, /EACCES: permission denied/);
  assert.doesNotMatch(reason, /^AUDIT/);
});

test('upgradePackage 失败原因: 强标记行盖过前置带提示词的审计行', async () => {
  const reason = await reasonFor(
    ['npm error code 1', failureStderr('b2-audit-hint-then-install.err').trim()].join('\n'),
  );
  assert.match(reason, /npm install failed in/);
  assert.doesNotMatch(reason, /^AUDIT/);
});

test('upgradePackage 失败原因: 进度行之后的裸 EACCES 仍然被选中', async () => {
  const reason = await reasonFor(['npm error code 1', failureStderr('b4-progress-eacces.err').trim()].join('\n'));
  assert.match(reason, /EACCES: permission denied/);
  assert.doesNotMatch(reason, /^Resolving package metadata/);
});

test('upgradePackage 失败原因: 审计提示行不压过其后的 Error 行', async () => {
  const reason = await reasonFor(['npm error code 1', failureStderr('b6-audit-hint-then-error.err').trim()].join('\n'));
  assert.match(reason, /EACCES: permission denied/);
  assert.doesNotMatch(reason, /^AUDIT/);
});

test('upgradePackage 失败原因: 重试提示行不压过其前的 ENOTFOUND 行', async () => {
  const reason = await reasonFor(['npm error code 1', failureStderr('enotfound-retry.err').trim()].join('\n'));
  assert.match(reason, /ENOTFOUND registry\.internal\.corp/);
  assert.doesNotMatch(reason, /checkout failed/);
});

test('upgradePackage 失败原因: 可选步骤警告不压过其前的 ENOTFOUND 行', async () => {
  const reason = await reasonFor(['npm error code 1', failureStderr('enotfound-warning.err').trim()].join('\n'));
  assert.match(reason, /ENOTFOUND registry\.internal\.corp/);
  assert.doesNotMatch(reason, /warning/);
});

test('upgradePackage 失败原因: 无强标记时提示词行压过其前的无关行', async () => {
  const stderr = [
    'npm error code 1',
    'settings restored from backup',
    'warning: could not restore previous settings; user config left failed',
  ].join('\n');
  const reason = await reasonFor(stderr);
  assert.match(reason, /could not restore previous settings/);
  assert.doesNotMatch(reason, /^settings restored/);
});

test('upgradePackage 失败原因: Node loader 崩溃取 Error 行, 不取帧头', async () => {
  const reason = await reasonFor(['npm error code 1', failureStderr('crash-loader.err').trim()].join('\n'));
  assert.match(reason, /Error: Cannot find module/);
  assert.doesNotMatch(reason, /^node:internal/);
});

test('upgradePackage 失败原因: npm error 块内 Error 行压过进度行', async () => {
  const reason = await reasonFor(failureStderr('npm-info-before-error.err'));
  assert.match(reason, /prebuilt binary download failed/);
  assert.doesNotMatch(reason, /Downloading|verifying/);
});

test('upgradePackage 失败原因: 数字 E-code 也是强标记', async () => {
  const reason = await reasonFor(['npm error code 1', failureStderr('p1-e404-behind-audit.err').trim()].join('\n'));
  assert.match(reason, /E404: package huaweicloud-devkit not present/);
  assert.doesNotMatch(reason, /^AUDIT/);
});

test('upgradePackage 失败原因: 下划线 E-code 也是强标记', async () => {
  const reason = await reasonFor(['npm error code 1', failureStderr('p2-eai-again-vs-audit.err').trim()].join('\n'));
  assert.match(reason, /EAI_AGAIN: Temporary failure/);
  assert.doesNotMatch(reason, /^AUDIT/);
});

test('upgradePackage 失败原因: 尾部 EXIT 大写词不是强标记', async () => {
  const reason = await reasonFor(['npm error code 1', failureStderr('q1-trailing-exit-status.err').trim()].join('\n'));
  assert.match(reason, /EACCES: permission denied/);
  assert.doesNotMatch(reason, /EXIT code/);
});

test('upgradePackage 失败原因: 尾部 EXTRACT 大写词不是强标记', async () => {
  const reason = await reasonFor(
    ['npm error code 1', failureStderr('q2-trailing-extract-progress.err').trim()].join('\n'),
  );
  assert.match(reason, /EACCES: permission denied/);
  assert.doesNotMatch(reason, /EXTRACT cleanup/);
});

test('upgradePackage 失败原因: ENABLED 赋值行不是强标记', async () => {
  const reason = await reasonFor(['npm error code 1', failureStderr('q3-enabled-audit.err').trim()].join('\n'));
  assert.match(reason, /EACCES: permission denied/);
  assert.doesNotMatch(reason, /ENABLED/);
});

test('upgradePackage 失败原因: EXPORTED 行不压过其前的 Error 行', async () => {
  const reason = await reasonFor(['npm error code 1', failureStderr('d2-exported-last.err').trim()].join('\n'));
  assert.match(reason, /Error: npm install failed in/);
  assert.doesNotMatch(reason, /EXPORTED/);
});

test('upgradePackage 失败原因: ESBUILD_ 行不压过其前的 Error 行', async () => {
  const reason = await reasonFor(['npm error code 1', failureStderr('d3-esbuild-last.err').trim()].join('\n'));
  assert.match(reason, /native build failed/);
  assert.doesNotMatch(reason, /ESBUILD/);
});

test('upgradePackage 失败原因: EXEC 行不压过其后的 Error 行', async () => {
  const reason = await reasonFor(['npm error code 1', failureStderr('d4-exec-first.err').trim()].join('\n'));
  assert.match(reason, /npm install failed in/);
  assert.doesNotMatch(reason, /^EXEC/);
});

test('upgradePackage 失败原因: E404 行压过其后带提示词的 warning 行', async () => {
  const reason = await reasonFor(['npm error code 1', failureStderr('e404-vs-hint.err').trim()].join('\n'));
  assert.match(reason, /E404 fetching tarball/);
  assert.doesNotMatch(reason, /warning: retry/);
});

test('upgradePackage 失败原因: 位置层取最后一条无标记行', async () => {
  const reason = await reasonFor(['npm error code 1', failureStderr('f-position-cp.err').trim()].join('\n'));
  assert.match(reason, /cp: cannot create regular file/);
  assert.doesNotMatch(reason, /step 1\/4/);
});

test('upgradePackage 失败原因: TypeError 也是错误名起始', async () => {
  const reason = await reasonFor(['npm error code 1', failureStderr('crash-typeerror.err').trim()].join('\n'));
  assert.match(reason, /TypeError: Cannot read properties/);
});

test('upgradePackage 失败原因: 方括号 dump 头取 TypeError 行, 不取 code 片段', async () => {
  const reason = await reasonFor(['npm error code 1', failureStderr('crash-fetch-dump.err').trim()].join('\n'));
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
  const reason = await reasonFor(
    ['npm error code 1', failureStderr('info-codeless-ends-with-log.err').trim()].join('\n'),
  );
  assert.match(reason, /Error: package install failed/);
});

test('upgradePackage 失败原因: 无 code 的 at least 行不被栈帧规则吃掉', async () => {
  const reason = await reasonFor(
    ['npm error code 1', failureStderr('info-codeless-at-least-one.err').trim()].join('\n'),
  );
  assert.match(reason, /at least one runtime dependency failed/);
});

test('upgradePackage 失败原因: 只含路径的行才算指针行', async () => {
  const stderr = ['npm error code EACCES', 'npm error cannot write /home/op/x-debug.log'].join('\n');
  const reason = await reasonFor(stderr);
  assert.match(reason, /code EACCES/);
  assert.match(reason, /cannot write/);
});

test('upgradePackage 失败原因: 无 code 的诊断行带日志路径时仍被选中', async () => {
  const stderr = ['npm error code 1', 'EACCES: permission denied, open /home/op/x-debug.log', 'progress 1/3'].join(
    '\n',
  );
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
  const reason = await reasonFor(['npm error code 1', failureStderr('n1a-phase-exec.err').trim()].join('\n'));
  assert.match(reason, /EACCES: permission denied/);
  assert.doesNotMatch(reason, /phase: EXTRACT/);
});

test('upgradePackage 失败原因: 块内的 phase EXTRACT 也不压过 Error 行', async () => {
  const reason = await reasonFor(failureStderr('n1b-block-phase-exec.err'));
  assert.match(reason, /Error: npm install failed/);
  assert.doesNotMatch(reason, /phase: EXTRACT/);
});

test('upgradePackage 失败原因: status 冒号后的 EXIT 不是强标记', async () => {
  const reason = await reasonFor(['npm error code 1', failureStderr('n1c-status-exit.err').trim()].join('\n'));
  assert.match(reason, /EACCES: permission denied/);
  assert.doesNotMatch(reason, /status: EXIT/);
});

test('upgradePackage 失败原因: mode 冒号后的 ENABLED 不是强标记', async () => {
  const reason = await reasonFor(['npm error code 1', failureStderr('n1d-mode-enabled.err').trim()].join('\n'));
  assert.match(reason, /EACCES: permission denied/);
  assert.doesNotMatch(reason, /mode: ENABLED/);
});

test('upgradePackage 失败原因: trace 冒号后的 EXPORTED 不是强标记', async () => {
  const reason = await reasonFor(['npm error code 1', failureStderr('n1e-trace-exported.err').trim()].join('\n'));
  assert.match(reason, /EACCES: permission denied/);
  assert.doesNotMatch(reason, /trace: EXPORTED/);
});

test('upgradePackage 失败原因: hint 冒号后的 ESBUILD 不是强标记', async () => {
  const reason = await reasonFor(['npm error code 1', failureStderr('n1f-hint-esbuild.err').trim()].join('\n'));
  assert.match(reason, /Error: npm install failed/);
  assert.doesNotMatch(reason, /ESBUILD/);
});

test('upgradePackage 失败原因: log 冒号后的 EVENTS 不是强标记', async () => {
  const reason = await reasonFor(['npm error code 1', failureStderr('n1g-log-events.err').trim()].join('\n'));
  assert.match(reason, /ECONNREFUSED 127\.0\.0\.1:9/);
  assert.doesNotMatch(reason, /EVENTS/);
});

test('upgradePackage 失败原因: EXPORTED 的屈折形也排除', async () => {
  const reason = await reasonFor(['npm error code 1', failureStderr('exported-inflected.err').trim()].join('\n'));
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
  const reason = await reasonFor(['npm error code 1', failureStderr('cleanup-after-cause.err').trim()].join('\n'));
  assert.match(reason, /install failed: could not reach registry/);
  assert.doesNotMatch(reason, /cleanup failed/);
});

test('upgradePackage 失败原因: 块内同层提示词同样取靠前的行', async () => {
  const reason = await reasonFor(failureStderr('cleanup-after-cause-block.err'));
  assert.match(reason, /install failed: could not reach registry/);
  assert.doesNotMatch(reason, /cleanup failed/);
});

test('upgradePackage 失败原因: 中文提示词同层取靠前的失败行', async () => {
  const reason = await reasonFor(['npm error code 1', failureStderr('cleanup-after-cause-zh.err').trim()].join('\n'));
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
  const reason = await reasonFor(['npm error code 1', failureStderr('metadata-array-fragment.err').trim()].join('\n'));
  assert.match(reason, /installing native addon/);
  assert.doesNotMatch(reason, /requireStack/);
});

test('upgradePackage 失败原因: 只有路径的一行仍是指针行', async () => {
  const reason = await reasonFor(['npm error code 1', failureStderr('pointer-last-codeless.err').trim()].join('\n'));
  assert.match(reason, /install failed while unpacking payload/);
  assert.doesNotMatch(reason, /debug-0\.log/);
});

test('upgradePackage 失败原因: 相对路径指针行也被丢掉', async () => {
  const reason = await reasonFor(
    ['npm error code 1', failureStderr('relative-pointer-codeless.err').trim()].join('\n'),
  );
  assert.match(reason, /install failed while unpacking payload/);
  assert.doesNotMatch(reason, /npm-debug\.log/);
});

test('upgradePackage 失败原因: 标签加日志路径的行按指针行处理', async () => {
  const stderr = [
    'npm error code 1',
    'log: /home/op/logs/2026-debug-0.log',
    "cp: cannot create regular file 'ro/hostname': Permission denied",
  ].join('\n');
  const reason = await reasonFor(stderr);
  assert.match(reason, /cp: cannot create regular file/);
  assert.doesNotMatch(reason, /debug-0\.log/);
});

test('upgradePackage 失败原因: at new Promise 形状的帧被丢掉', async () => {
  const stderr = [
    'npm error code 1',
    'at new Promise (<anonymous>)',
    "cp: cannot create regular file 'ro/hostname': Permission denied",
  ].join('\n');
  const reason = await reasonFor(stderr);
  assert.match(reason, /cp: cannot create regular file/);
  assert.doesNotMatch(reason, /at new Promise/);
});

test('upgradePackage 失败原因: 文件 URI 与 node 帧被丢掉', async () => {
  const stderr = [
    'npm error code 1',
    '    at file:///home/op/x.js:1:1',
    '    at node:internal/main:1:1',
    'payload copy stopped',
  ].join('\n');
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
    const reason = await reasonFor(['npm error code 1', `${token} 12 entries, continuing`, cause].join('\n'));
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
    const reason = await reasonFor(['npm error code 1', cause, 'cleanup finished'].join('\n'));
    assert.match(reason, new RegExp(code), `${cause} keeps its code`);
  }
});

test('upgradePackage 失败原因: 真实 lifecycle 进度行不压过失败行', async () => {
  const reason = await reasonFor(['npm error code 1', failureStderr('mask-evicted-lifecycle.err').trim()].join('\n'));
  assert.match(reason, /install failed: could not reach registry/);
  assert.doesNotMatch(reason, /EVICTED/);
});

test('upgradePackage 失败原因: 中文指针短语行不进原因', async () => {
  const reason = await reasonFor(['npm error code 1', failureStderr('zh-pointer-phrase-2line.err').trim()].join('\n'));
  assert.match(reason, /cp: cannot create regular file/);
  assert.doesNotMatch(reason, /完整的运行日志|debug-0\.log/);
});

test('upgradePackage 失败原因: 中文标签指针行不进原因', async () => {
  const reason = await reasonFor(['npm error code 1', failureStderr('zh-label-pointer.err').trim()].join('\n'));
  assert.match(reason, /cp: cannot create regular file/);
  assert.doesNotMatch(reason, /日志|debug-0\.log/);
});

test('upgradePackage 失败原因: 中文全角标签指针行不进原因', async () => {
  const reason = await reasonFor(['npm error code 1', failureStderr('zh-fullcolon-pointer.err').trim()].join('\n'));
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
    'npm error code 1',
    "cp: cannot create regular file 'ro/hostname': Permission denied",
    '    at Module.executeUserEntryPoint [as runMain] (node:internal/modules/run_main:171:5)',
  ].join('\n');
  const reason = await reasonFor(stderr);
  assert.match(reason, /cp: cannot create regular file/);
  assert.doesNotMatch(reason, /runMain|at Module/);
});

test('upgradePackage 失败原因: 真实崩溃捕获的 [as alias] 帧不进原因', async () => {
  const reason = await reasonFor(['npm error code 1', failureStderr('crash-aliased-frame.err').trim()].join('\n'));
  assert.match(reason, /TypeError: Cannot read properties/);
  assert.doesNotMatch(reason, /runMain|at Module/);
});

test('upgradePackage 失败原因: 无位置帧与 wasm 帧被丢掉', async () => {
  for (const fixture of ['frame-anon.err', 'frame-wasm.err']) {
    const reason = await reasonFor(['npm error code 1', failureStderr(fixture).trim()].join('\n'));
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
    'npm error code 1',
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
  const stderr = [
    'npm error code 1',
    'at startup (retry 1) the payload copy failed with EACCES writing /opt/devkit',
  ].join('\n');
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
  const stderr = ['npm error code 1', 'progress 1/2', 'progress 2/2'].join('\n');
  const reason = await reasonFor(stderr);
  assert.match(reason, /progress 2\/2/);
  assert.doesNotMatch(reason, /progress 1\/2/);
});

test('upgradePackage 失败原因: 中文标签指针行在没有提示词竞争时也被剥掉', async () => {
  const stderr = ['npm error code 1', 'payload copy stopped', '日志: /home/op/logs/2026-debug-0.log'].join('\n');
  const reason = await reasonFor(stderr);
  assert.match(reason, /payload copy stopped/);
});

test('upgradePackage 失败原因: 中文全角标签指针行同样被剥掉', async () => {
  const stderr = ['npm error code 1', 'payload copy stopped', '日志：/home/op/logs/2026-debug-0.log'].join('\n');
  const reason = await reasonFor(stderr);
  assert.match(reason, /payload copy stopped/);
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
    'npm error code 1',
    'cleanup aborted: 3 stale locks removed',
    "cp: cannot create regular file 'assets/policy.json': Permission denied",
  ].join('\n');
  const reason = await reasonFor(stderr);
  assert.match(reason, /cp: cannot create regular file/);
  assert.doesNotMatch(reason, /cleanup aborted/);
});

test('upgradePackage 失败原因: EINTEGRITY 在封闭词表内', async () => {
  const reason = await reasonFor(
    ['npm error code 1', 'EINTEGRITY: sha512 mismatch', 'install failed: could not reach registry'].join('\n'),
  );
  assert.match(reason, /EINTEGRITY: sha512 mismatch/);
});

test('upgradePackage 失败原因: EUSAGE 在封闭词表内', async () => {
  const reason = await reasonFor(
    ['npm error code 1', 'EUSAGE: invalid config value', 'install failed: could not reach registry'].join('\n'),
  );
  assert.match(reason, /EUSAGE: invalid config value/);
});

test('upgradePackage 失败原因: 冒号位置的真 errno 也被识别', async () => {
  const reason = await reasonFor(
    ['npm error code 1', 'pipelines: E404 not present', 'cleanup failed later'].join('\n'),
  );
  assert.match(reason, /E404 not present/);
  assert.doesNotMatch(reason, /cleanup failed later/);
});

test('upgradePackage 失败原因: 裸 EACCES 行在行首也被识别', async () => {
  const reason = await reasonFor(['npm error code 1', 'EACCES', 'install failed: could not reach registry'].join('\n'));
  assert.equal(reason, 'EACCES');
});

test('upgradePackage 失败原因: 括号里带冒号的散文不是帧', async () => {
  const reason = await reasonFor(['npm error code 1', 'at startup (step 2: syncing payload)'].join('\n'));
  assert.match(reason, /at startup \(step 2: syncing payload\)/);
});

test('upgradePackage 失败原因: 中文短语的另一种措辞也被剥掉', async () => {
  const stderr = [
    'npm error code 1',
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
    const reason = await reasonFor(['npm error code 1', `cache: ${token} 12 entries`, cause].join('\n'));
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
  const stderr = ['npm error code 1', 'payload copy stopped', '日志 : /home/op/logs/2026-debug-0.log'].join('\n');
  const reason = await reasonFor(stderr);
  assert.match(reason, /payload copy stopped/);
});

test('upgradePackage 失败原因: 真实 eval 嵌套帧全部丢掉', async () => {
  const reason = await reasonFor(['npm error code 1', failureStderr('crash-eval-nested.err').trim()].join('\n'));
  assert.match(reason, /Error: payload copy stopped/);
  assert.doesNotMatch(reason, /at eval|eval at <anonymous>/);
});

test('upgradePackage 失败原因: 嵌套 eval 帧不压过弱位置层行', async () => {
  const stderr = [
    'npm error code 1',
    'payload copy stopped',
    '    at eval (eval at <anonymous> (eval at <anonymous> ([eval]:1:1)), <anonymous>:1:7)',
  ].join('\n');
  const reason = await reasonFor(stderr);
  assert.match(reason, /payload copy stopped/);
});

test('upgradePackage 失败原因: EINVALIDPACKAGENAME 在封闭词表内', async () => {
  const reason = await reasonFor(
    ['npm error code 1', 'EINVALIDPACKAGENAME: name contains uppercase letters', 'progress 1/2'].join('\n'),
  );
  assert.match(reason, /EINVALIDPACKAGENAME/);
});

test('upgradePackage 失败原因: 静默子进程的 pty 只余字形时回到 command 兜底', async () => {
  const reason = await reasonFor(failureStderr('pty-silent-lifecycle.err'));
  assert.match(reason, /code 7/);
  assert.match(reason, /command sh -c node .\/silent\.mjs/);
  assert.ok(!/[\u2800-\u28ff]/.test(reason), 'no spinner glyph survives');
});

test('upgradePackage 失败原因: 字形粘连的 npm warn 行进入噪声类', async () => {
  const reason = await reasonFor(['npm error code 1', failureStderr('pty-warn-lifecycle.err').trim()].join('\n'));
  assert.match(reason, /code (?:1|7)/);
  assert.match(reason, /command sh -c/);
  assert.doesNotMatch(reason, /npm warn|deprecated/);
  assert.ok(!/[\u2800-\u28ff]/.test(reason), 'no spinner glyph survives');
});

test('upgradePackage 失败原因: 日志标签在句中时整行保留', async () => {
  const stderr = ['npm error code 1', 'copying payload files', '详细日志：/home/op/logs/run.log 以及 EACCES 细节'].join(
    '\n',
  );
  const reason = await reasonFor(stderr);
  assert.match(reason, /EACCES 细节/);
  assert.match(reason, /run\.log/);
});

test('upgradePackage 失败原因: 英文句子里的日志标签不被截断', async () => {
  const stderr = [
    'npm error code 1',
    'copying payload files',
    'For details see 日志 : /home/op/logs/run.log and EACCES info',
  ].join('\n');
  const reason = await reasonFor(stderr);
  assert.match(reason, /EACCES info/);
});

test('upgradePackage 失败原因: npm info run 回显不抢子进程自己的行', async () => {
  const reason = await reasonFor(failureStderr('npx-info-run-verbose.err'));
  assert.match(reason, /native build failed: missing libfoo/);
  assert.doesNotMatch(reason, /npm info run|sh -c/);
});

test('upgradePackage 升级命令: 带 --foreground-scripts 让安装脚本输出可见', async () => {
  let spawned: readonly string[] | null = null;
  const spawnFn: UpgradeSpawnFn = (_cmd, args) => {
    spawned = args;
    return { status: 0 };
  };
  await upgradePackage({ target: 'opencode' }, { doQuery: stubQuery, spawnFn });
  assert.deepEqual(spawned, [
    '--yes',
    '--foreground-scripts',
    'huaweicloud-devkit@latest',
    'update',
    '--target',
    'opencode',
  ]);
});

test('upgradePackage 失败原因: 打开前景脚本后子进程文本成为原因', async () => {
  const reason = await reasonFor(['npm error code 1', failureStderr('npx-foreground-scripts.err').trim()].join('\n'));
  assert.match(reason, /native build failed: missing libfoo/);
});

test('upgradePackage 失败原因: verbose 配置下子进程自己的行仍胜出', async () => {
  const reason = await reasonFor(failureStderr('verbose-loud-child.err'));
  assert.match(reason, /native build failed: missing libfoo/);
  assert.doesNotMatch(reason, /shrinkwrap|npm verbose|npm verb/);
});

test('upgradePackage 失败原因: verbose 静默子进程回落到失败脚本的 echo', async () => {
  const reason = await reasonFor(failureStderr('verbose-silent-child.err'));
  assert.match(reason, /postinstall/);
  assert.match(reason, /node .\/build\.js/);
  assert.doesNotMatch(reason, /shrinkwrap|npm verbose|npm verb/);
});

test('upgradePackage 失败原因: echo 层选中与 { code: 7 } 相邻的 postinstall', async () => {
  const reason = await reasonFor(failureStderr('verbose-multi-script.err'));
  assert.match(reason, /postinstall/);
  assert.doesNotMatch(reason, /preinstall|npm verbose/);
});

test('upgradePackage 失败原因: 只有 echo 行时同样选中失败脚本', async () => {
  const reason = await reasonFor(failureStderr('verbose-echolines-only.err'));
  assert.match(reason, /postinstall/);
  assert.doesNotMatch(reason, /preinstall/);
});

test('upgradePackage 失败原因: npxreg 的 verbose 噪声不压过块内错误行', async () => {
  const reason = await reasonFor(failureStderr('verbose-npxreg.err'));
  assert.match(reason, /could not determine executable to run/);
  assert.doesNotMatch(reason, /shrinkwrap|npm verbose|npm verb/);
});

test('upgradePackage 失败原因: 混合标签指针行也被剥掉', async () => {
  for (const label of ['日志 2:', '运行-日志:']) {
    const stderr = ['npm error code 1', 'payload copy stopped', `${label} /home/op/logs/2026-debug-0.log`].join('\n');
    const reason = await reasonFor(stderr);
    assert.match(reason, /payload copy stopped/, `${label} must drop`);
  }
});

test('upgradePackage 失败原因: npm 自有的新 errno 拼写被承认', async () => {
  for (const code of ['EUNKNOWNCOMMAND', 'ENOVERSIONS']) {
    const reason = await reasonFor(['npm error code 1', `${code}: probe`, 'progress 1/2'].join('\n'));
    assert.match(reason, new RegExp(code));
  }
});

test('upgradePackage 升级命令: 手动兜底命令同样带 --foreground-scripts', async () => {
  const r = await upgradePackage({ target: 'opencode' }, { doQuery: async () => null, spawnFn: () => ({ status: 0 }) });
  assert.match(r.manual ?? '', /npx --yes --foreground-scripts huaweicloud-devkit@latest update --target opencode/);
});

test('upgradePackage 失败原因: http 频道行不压过静默子进程的 echo', async () => {
  const reason = await reasonFor(failureStderr('npm-http-silent.err'));
  assert.match(reason, /postinstall/);
  assert.match(reason, /node .\/build\.js/);
  assert.doesNotMatch(reason, /npm http|fetch/);
});

test('upgradePackage 失败原因: silly 频道里的 error 词不压过子进程自己的行', async () => {
  const reason = await reasonFor(failureStderr('npm-silly-loud.err'));
  assert.match(reason, /native build failed: missing libfoo/);
  assert.doesNotMatch(reason, /npm silly|audit error/);
});

test('upgradePackage 失败原因: 只有 timing 页脚时不留频道行', async () => {
  const reason = await reasonFor(failureStderr('npm-timing-only.err'));
  assert.doesNotMatch(reason, /npm timing|Completed in/);
});

test('upgradePackage 失败原因: 真实 registry 静默捕获也落在 echo 上', async () => {
  const reason = await reasonFor(failureStderr('npm-http-registry-silent.err'));
  assert.match(reason, /postinstall/);
  assert.match(reason, /node .\/build\.js/);
  assert.doesNotMatch(reason, /npm http/);
});

test('upgradePackage 失败原因: ASCII spinner 帧前缀被剥掉', async () => {
  const frameEscape = `-${String.fromCharCode(27)}[1G${String.fromCharCode(27)}[0K`;
  const stderr = [
    'npm error code 1',
    `${frameEscape}npm error code E404`,
    'npm error 404 Not Found - GET https://registry.example/x',
  ].join('\n');
  const reason = await reasonFor(stderr);
  assert.match(reason, /404 Not Found/);
  assert.doesNotMatch(reason, /npm verbose|npm code E404/);
});

test('upgradePackage 失败原因: 无数字结果行的 echo 仍指向失败脚本', async () => {
  const stderr = [
    'npm info run pkg@1.0.0 postinstall node ./build.js',
    "npm info run pkg@1.0.0 postinstall { code: null, signal: 'SIGKILL' }",
  ].join('\n');
  const reason = await reasonFor(stderr);
  assert.match(reason, /postinstall/);
  assert.match(reason, /node .\/build\.js/);
});

test('upgradePackage 失败原因: 信号失败的结果行把 echo 对到后一个脚本', async () => {
  const stderr = [
    'npm info run pkg@1.0.0 preinstall node ./pre.js',
    'npm info run pkg@1.0.0 preinstall { code: 0, signal: null }',
    'npm info run pkg@1.0.0 postinstall node ./build.js',
    "npm info run pkg@1.0.0 postinstall { code: null, signal: 'SIGKILL' }",
  ].join('\n');
  const reason = await reasonFor(stderr);
  assert.match(reason, /postinstall/);
  assert.doesNotMatch(reason, /preinstall/);
});

test('upgradePackage 失败原因: EMAXREDIRECT 也在封闭词表内', async () => {
  const reason = await reasonFor(['npm error code 1', 'EMAXREDIRECT: too many redirects', 'progress 1/2'].join('\n'));
  assert.match(reason, /EMAXREDIRECT/);
});

test('upgradePackage 升级命令: spawn 选项给出 16 MiB 的缓冲上限', async () => {
  let opts: SpawnSyncOptions | null = null;
  const spawnFn: UpgradeSpawnFn = (_cmd, _args, options) => {
    opts = options;
    return { status: 0 };
  };
  await upgradePackage({ target: 'opencode' }, { doQuery: stubQuery, spawnFn });
  assert.equal(opts!.maxBuffer, 16 * 1024 * 1024);
});

test('upgradePackage 失败原因: 有 stderr 时 spawn 的 ENOBUFS 不冒充原因', async () => {
  const stderr = ['npm error code 7', 'npm error fatal: native build failed: missing libfoo'].join('\n');
  const r = await upgradePackage(
    { target: 'opencode' },
    {
      doQuery: stubQuery,
      spawnFn: () => ({ status: null, stdout: '', stderr, error: new Error('spawnSync /bin/sh ENOBUFS') }),
    },
  );
  assert.equal(r.success, false);
  assert.match(r.error ?? '', /missing libfoo/);
  assert.doesNotMatch(r.error ?? '', /ENOBUFS/);
});

test('upgradePackage 失败原因: 子进程以 npm 开头的诊断行不被频道规则吞掉', async () => {
  const reason = await reasonFor(
    ['npm error code 1', 'npm install failed: could not reach registry', 'progress 1/2'].join('\n'),
  );
  assert.match(reason, /npm install failed: could not reach registry/);
});

test('upgradePackage 失败原因: 成功 preinstall 的输出不顶替失败 postinstall 的 echo', async () => {
  const reason = await reasonFor(failureStderr('twoscript-preinstall.err'));
  assert.match(reason, /postinstall/);
  assert.match(reason, /post\.js/);
  assert.doesNotMatch(reason, /preparing workspace|preinstall node_modules/);
});

test('upgradePackage 失败原因: 已恢复的 gyp 错误不顶替失败 postinstall 的 echo', async () => {
  const reason = await reasonFor(failureStderr('twoscript-recovered-gyp.err'));
  assert.match(reason, /postinstall/);
  assert.doesNotMatch(reason, /gyp ERR|EACCES/);
});

test('upgradePackage 失败原因: 单行无标记聊天仍走地板', async () => {
  const reason = await reasonFor(failureStderr('nc-silent-preinstall.err'));
  assert.equal(reason, 'exit 1');
});

test('upgradePackage 失败原因: 斜杠与短横的 ASCII spinner 帧也被剥掉', async () => {
  for (const frame of ['/', '-']) {
    const stderr = [
      `${frame} npm verbose code 7`,
      'npm error code E404',
      'npm error 404 Not Found - GET https://registry.example/x',
    ].join('\n');
    const reason = await reasonFor(stderr);
    assert.match(reason, /code E404/, `${frame} frame strips`);
    assert.doesNotMatch(reason, /npm verbose/);
  }
});

test('upgradePackage 失败原因: npm 9 的 sill 频道行不冒充原因', async () => {
  const reason = await reasonFor(failureStderr('npm9-sill-lines.err'), 7);
  assert.match(reason, /code 7/);
  assert.match(reason, /command sh -c node .\/build\.js/);
  assert.doesNotMatch(reason, /npm sill|<html>|audit bulk/);
});

test('upgradePackage 失败原因: 单行无标记 chatter 在有块时不冒充', async () => {
  const reason = await reasonFor(failureStderr('default-chatty-preinstall.err'), 7);
  assert.equal(reason, 'exit 7');
});

test('upgradePackage 失败原因: pty 字形粘连的子进程行被剥帧', async () => {
  const reason = await reasonFor(['npm error code 1', failureStderr('pty-braille-child.err').trim()].join('\n'));
  assert.match(reason, /native build failed: missing libfoo/);
  assert.ok(!/[\u2800-\u28ff]/.test(reason), 'no glyph survives');
});

test('upgradePackage 失败原因: 有 echo 对时 Terminated 外壳词让位给失败脚本', async () => {
  const stderr = [
    'npm info run pkg@1.0.0 postinstall node ./b.js',
    'npm info run pkg@1.0.0 postinstall { code: 137, signal: null }',
    'Terminated',
  ].join('\n');
  const reason = await reasonFor(stderr);
  assert.match(reason, /postinstall/);
  assert.doesNotMatch(reason, /Terminated/);
});

test('upgradePackage 失败原因: 没有 echo 时 Terminated 就是诚实原因', async () => {
  const reason = await reasonFor('Terminated');
  assert.equal(reason, 'Terminated');
});

test('upgradePackage 失败原因: 成功 echo 对之后的 Terminated 不报成功脚本', async () => {
  const stderr = [
    'npm info run pkg@1.0.0 preinstall node ./pre.js',
    'npm info run pkg@1.0.0 preinstall { code: 0, signal: null }',
    'Terminated',
  ].join('\n');
  const reason = await reasonFor(stderr, 143);
  assert.doesNotMatch(reason, /preinstall|pre\.js/);
  assert.match(reason, /Terminated|exit 143/);
});

test('upgradePackage 失败原因: 孤立 echo 不关闭退出码地板', async () => {
  const stderr = ['npm info run pkg@1.0.0 postinstall node ./build.js', 'progress 1/2'].join('\n');
  const reason = await reasonFor(stderr, 7);
  assert.equal(reason, 'exit 7');
});

test('upgradePackage 失败原因: 恢复的 gyp 聊天行退到退出码', async () => {
  const reason = await reasonFor(failureStderr('chatty-gyp-preinstall.err'), 7);
  assert.equal(reason, 'exit 7');
});

test('upgradePackage 失败原因: 重试聊天行退到退出码', async () => {
  const reason = await reasonFor(failureStderr('chatty-retry-preinstall.err'), 7);
  assert.equal(reason, 'exit 7');
});

test('upgradePackage 失败原因: 元数据聊天行退到退出码', async () => {
  const reason = await reasonFor(failureStderr('chatty-metadata-stderr.err'), 7);
  assert.equal(reason, 'exit 7');
});

test('upgradePackage 失败原因: 成功 preinstall 聊天行在无失败对时退出码', async () => {
  const reason = await reasonFor(failureStderr('chatty-success-preinstall.err'), 7);
  assert.equal(reason, 'exit 7');
});

test('upgradePackage 失败原因: ASCII 帧加转义后的子进程行被剥帧', async () => {
  const frameEscape = `-${String.fromCharCode(27)}[1G${String.fromCharCode(27)}[0K`;
  const reason = await reasonFor(['npm error code 7', `${frameEscape}native build failed: missing libfoo`].join('\n'));
  assert.match(reason, /native build failed: missing libfoo/);
  assert.doesNotMatch(reason, /\[1G/);
});

test('upgradePackage 失败原因: 单个前导短横的合法诊断行保留首字符', async () => {
  const reason = await reasonFor(['npm error code 7', '- build failed: missing libfoo'].join('\n'));
  assert.match(reason, /- build failed: missing libfoo/);
});

test('upgradePackage 失败原因: 超时 kill 报 spawn 工件而不是中途进度', async () => {
  const error = await errorForSpawn({
    status: null,
    signal: 'SIGTERM',
    stderr: ['reify: copying payload files', 'reify: copying payload files', 'progress 2/10'].join('\n'),
    error: new Error('spawnSync /bin/sh ETIMEDOUT'),
  });
  assert.equal(error, 'spawnSync /bin/sh ETIMEDOUT');
});

test('upgradePackage 失败原因: 超限 kill 报 ENOBUFS 工件而不是填充文本', async () => {
  const filler = Array.from({ length: 40 }, () => 'truncated filler line from a talkative child').join('\n');
  const error = await errorForSpawn({
    status: null,
    signal: null,
    stderr: filler,
    error: new Error('spawnSync /bin/sh ENOBUFS'),
  });
  assert.equal(error, 'spawnSync /bin/sh ENOBUFS');
});

test('upgradePackage 失败原因: 只有一行真实原因时保留它', async () => {
  const reason = await reasonFor('native build failed: missing libfoo. rebuild aborted.', 7);
  assert.match(reason, /native build failed: missing libfoo/);
});

test('upgradePackage 失败原因: 单行超时 kill 报 ETIMEDOUT', async () => {
  const error = await errorForSpawn({
    status: null,
    signal: 'SIGTERM',
    stderr: 'reify: copying payload files',
    error: new Error('spawnSync /bin/sh ETIMEDOUT'),
  });
  assert.equal(error, 'spawnSync /bin/sh ETIMEDOUT');
});

test('upgradePackage 失败原因: 单行超限 kill 报 ENOBUFS', async () => {
  const filler = 'truncated filler '.repeat(4000);
  const error = await errorForSpawn({
    status: null,
    signal: null,
    stderr: filler,
    error: new Error('spawnSync /bin/sh ENOBUFS'),
  });
  assert.equal(error, 'spawnSync /bin/sh ENOBUFS');
});

test('upgradePackage 失败原因: kill 时的孤立 echo 退到信号', async () => {
  const error = await errorForSpawn({
    status: null,
    signal: 'SIGKILL',
    stderr: 'npm info run pkg@1.0.0 postinstall node ./b.js',
  });
  assert.equal(error, 'signal SIGKILL');
});

test('upgradePackage 失败原因: 带信号的单行进度行退到信号', async () => {
  const error = await errorForSpawn({ status: null, signal: 'SIGKILL', stderr: 'progress 1/2' });
  assert.equal(error, 'signal SIGKILL');
});

test('upgradePackage 失败原因: 噪声行加聊天行不算单行豁免', async () => {
  const stderr = ['npm warn deprecated foo@1.0.0', 'progress 1/2'].join('\n');
  const reason = await reasonFor(stderr, 7);
  assert.equal(reason, 'exit 7');
});

test('upgradePackage 失败原因: 孤立 gyp info ok 不是临终遗言', async () => {
  const reason = await reasonFor('gyp info ok', 7);
  assert.equal(reason, 'exit 7');
});

test('upgradePackage 失败原因: 孤立成功结果行不是临终遗言', async () => {
  const reason = await reasonFor('npm info run pkg@1.0.0 postinstall { code: 0, signal: null }', 7);
  assert.equal(reason, 'exit 7');
});

test('upgradePackage 失败原因: 原因行加指针行时保留原因', async () => {
  const stderr = [
    'native build failed: missing libfoo. rebuild aborted.',
    '/home/op/.npm/_logs/2026-11-11T00_00_00_000Z-debug-0.log',
  ].join('\n');
  const reason = await reasonFor(stderr, 7);
  assert.match(reason, /native build failed: missing libfoo/);
});

test('upgradePackage 失败原因: TypeError 加栈帧时保留原因', async () => {
  const stderr = [
    "TypeError: Cannot read properties of null (reading 'x')",
    '    at Object.<anonymous> (/home/op/x.js:1:1)',
    '    at Module._compile (node:internal/modules/cjs/loader:1:1)',
  ].join('\n');
  const reason = await reasonFor(stderr, 7);
  assert.match(reason, /TypeError: Cannot read properties of null/);
});

test('upgradePackage 失败原因: frame-anon 语料形状保留唯一原因行', async () => {
  const reason = await reasonFor(failureStderr('frame-anon.err'), 7);
  assert.match(reason, /payload copy stopped/);
});

test('upgradePackage 失败原因: zh-label-pointer 语料形状保留唯一原因行', async () => {
  const reason = await reasonFor(failureStderr('zh-label-pointer.err'), 7);
  assert.match(reason, /cp: cannot create regular file/);
});

test('upgradePackage 失败原因: 子进程的 command: 行不是 npm 回显', async () => {
  const stderr = ['npm error code 1', 'progress 1/2', 'command: node-gyp rebuild'].join('\n');
  const reason = await reasonFor(stderr);
  assert.match(reason, /command: node-gyp rebuild/);
});

test('upgradePackage 失败原因: 子进程的 info run: 行不是 npm 回显', async () => {
  const stderr = ['npm error code 1', 'progress 1/2', 'info run: child says the payload is broken'].join('\n');
  const reason = await reasonFor(stderr);
  assert.match(reason, /info run: child says the payload is broken/);
});

test('upgradePackage 失败原因: 回显里的 errno 词不与子进程诊断并列', async () => {
  const stderr = [
    'EACCES: permission denied, open /home/op/x',
    'npm error code 1',
    `npm error command sh -c node -e "console.error('failed: EACCES permission denied')"`,
  ].join('\n');
  const reason = await reasonFor(stderr);
  assert.match(reason, /EACCES: permission denied, open \/home\/op\/x/);
  assert.doesNotMatch(reason, /command sh -c/);
});

test('upgradePackage 失败原因: bash 脚本外壳的回显仍被识别', async () => {
  const stderr = [
    'native build failed: missing libfoo. rebuild aborted.',
    'npm error code 7',
    `npm error command /bin/bash -c "node build.js --msg 'native build failed'"`,
  ].join('\n');
  const reason = await reasonFor(stderr);
  assert.match(reason, /native build failed: missing libfoo\. rebuild aborted/);
  assert.doesNotMatch(reason, /command \/bin\/bash/);
});

test('upgradePackage 失败原因: cmd.exe 的回显仍被识别', async () => {
  const stderr = [
    'native build failed: missing libfoo. rebuild aborted.',
    'npm error code 7',
    `npm error command cmd.exe /d /s /c "node build.js --msg 'native build failed'"`,
  ].join('\n');
  const reason = await reasonFor(stderr);
  assert.match(reason, /native build failed: missing libfoo\. rebuild aborted/);
  assert.doesNotMatch(reason, /cmd\.exe/);
});

test('upgradePackage 失败原因: 真实崩溃的头部正文与页脚不阻塞唯一原因', async () => {
  const reason = await reasonFor(failureStderr('crash-preamble-real.err'), 1);
  assert.match(reason, /TypeError: Cannot read properties/);
});

test('upgradePackage 失败原因: 无语料块的崩溃也用唯一原因行', async () => {
  const reason = await reasonFor(failureStderr('crash-no-block-corpus.err'), 1);
  assert.match(reason, /Error: ENOENT/);
});

test('upgradePackage 失败原因: 原因加 echo 对时仍保留原因', async () => {
  const stderr = [
    'native build failed: missing libfoo. rebuild aborted.',
    'npm info run pkg@1.0.0 postinstall node ./b.js',
    'npm info run pkg@1.0.0 postinstall { code: 7, signal: null }',
  ].join('\n');
  const reason = await reasonFor(stderr, 7);
  assert.match(reason, /native build failed: missing libfoo/);
});

test('upgradePackage 失败原因: failure 词提升会压过其后的详情行（已记账）', async () => {
  const stderr = ['npm error code 1', 'payload copy stopped', '详细日志：/home/op/logs/run.log 以及 EACCES 细节'].join(
    '\n',
  );
  const reason = await reasonFor(stderr);
  assert.match(reason, /payload copy stopped/);
});

test('upgradePackage 失败原因: gyp 先成功后失败的同一脚本保留原因', async () => {
  const reason = await reasonFor(failureStderr('gyp-ok-then-fail.err'), 7);
  assert.match(reason, /native build failed: missing libfoo/);
});

test('upgradePackage 失败原因: 子进程的 command sh -c 句子不当回显', async () => {
  const reason = await reasonFor(failureStderr('child-command-shc-diagnostic.err'), 7);
  assert.match(reason, /command sh -c exited with 127/);
  assert.doesNotMatch(reason, /progress 1\/2/);
});

test('upgradePackage 失败原因: 真实异步崩溃保留 TypeError', async () => {
  const reason = await reasonFor(failureStderr('crash-async-real.err'), 1);
  assert.match(reason, /TypeError: Cannot read properties of null/);
  assert.doesNotMatch(reason, /Promise\.all|Node\.js/);
});

test('upgradePackage 失败原因: Require stack 条目不再阻塞原因', async () => {
  const reason = await reasonFor(failureStderr('crash-loader.err'), 1);
  assert.match(reason, /Error: Cannot find module/);
  assert.doesNotMatch(reason, /Require stack|- \/home/);
});

test('upgradePackage 失败原因: echo 伴随时 TypeError 仍是原因', async () => {
  const reason = await reasonFor(failureStderr('echo-plus-typeerror.err'), 1);
  assert.match(reason, /TypeError: Cannot read properties of null/);
});

test('upgradePackage 失败原因: echo 伴随时 EPERM 仍是原因', async () => {
  const reason = await reasonFor(failureStderr('echo-plus-eperm.err'), 1);
  assert.match(reason, /EPERM: operation not permitted/);
});

test('upgradePackage 失败原因: 已恢复的 gyp 错误在有块时让位给命令回显', async () => {
  const stderr = [
    "gyp ERR! stack Error: EACCES: permission denied, mkdir '/usr/lib/node_modules/.cache'",
    'gyp info ok',
    'npm error code 7',
    'npm error path /home/op/x',
    'npm error command failed',
    'npm error command sh -c node post.js',
  ].join('\n');
  const reason = await reasonFor(stderr);
  assert.match(reason, /code 7/);
  assert.match(reason, /command sh -c node post\.js/);
  assert.doesNotMatch(reason, /gyp ERR|EACCES/);
});

test('upgradePackage 失败原因: 子进程的路径项目符号行不被 Require-stack 规则吞掉', async () => {
  const reason = await reasonFor(
    ['npm error code 1', '- /opt/app/config could not be written by the preinstall step'].join('\n'),
  );
  assert.match(reason, /- \/opt\/app\/config could not be written/);
});

test('upgradePackage 失败原因: 只有路径项目符号行的诊断保留', async () => {
  const reason = await reasonFor('- /opt/app/config write failed during preinstall', 1);
  assert.match(reason, /- \/opt\/app\/config write failed/);
});

test('upgradePackage 失败原因: 闭合方括号的元数据行会被降级但诊断行保留', async () => {
  const reason = await reasonFor('missing: [libfoo, libbar] native libraries failed to link', 1);
  assert.match(reason, /missing: \[libfoo, libbar\] native libraries failed to link/);
});

test('upgradePackage 失败原因: command failed 留在元数据层, 脚本名仍可见', async () => {
  const stderr = ['npm error code 1', 'npm error command failed', 'npm error command sh -c node ./b.js'].join('\n');
  const reason = await reasonFor(stderr);
  assert.match(reason, /code 1/);
  assert.match(reason, /command sh -c node .\/b\.js/);
});

test('upgradePackage 失败原因: gyp 启动行不否决唯一原因', async () => {
  const stderr = [
    'native build failed: missing libfoo. rebuild aborted.',
    "gyp info spawn args [ 'build', '-v', 'rebuild' ]",
  ].join('\n');
  const reason = await reasonFor(stderr, 7);
  assert.match(reason, /native build failed: missing libfoo/);
});

test('upgradePackage 失败原因: 崩溃的 throw 片段与数组元数据不阻塞原因', async () => {
  const stderr = [
    'node:internal/modules/cjs/loader:1607',
    '  throw err;',
    '  ^',
    "Error: Cannot find module 'x'",
    '    at Module._resolveFilename (node:internal/modules/cjs/loader:1603:15) {',
    "  code: 'MODULE_NOT_FOUND',",
    '  requireStack: [',
    "    '/home/op/x.js'",
  ].join('\n');
  const reason = await reasonFor(stderr, 1);
  assert.match(reason, /Error: Cannot find module 'x'/);
});

test('upgradePackage 失败原因: 真实异步帧不再阻塞原因', async () => {
  const stderr = ["TypeError: Cannot read properties of null (reading 'x')", '    at async Promise.all (index 0)'].join(
    '\n',
  );
  const reason = await reasonFor(stderr, 1);
  assert.match(reason, /TypeError: Cannot read properties of null/);
});

test('upgradePackage 失败原因: bash 回显夹具下子进程的 command: 行保留', async () => {
  const reason = await reasonFor(failureStderr('bash-echo-child.err'), 7);
  assert.match(reason, /command: node-gyp rebuild/);
});

test('upgradePackage 升级子进程: npm 认证通道通过, GitHub、Docker 与供应商令牌被剥', async () => {
  const passThrough = ['NPM_TOKEN', 'NODE_AUTH_TOKEN'];
  const stripped = [
    'GITHUB_TOKEN',
    'GH_TOKEN',
    'DOCKER_PASSWORD',
    'GITHUB_ENTERPRISE_TOKEN',
    'GH_ENTERPRISE_TOKEN',
    'GITLAB_TOKEN',
    'GITLAB_CI_JOB_TOKEN',
    'BITBUCKET_TOKEN',
    'AZURE_DEVOPS_EXT_PAT',
    'DOCKER_AUTH_CONFIG',
    'NPM_AUTH_TOKEN',
    'YARN_NPM_AUTH_TOKEN',
    'NUGET_API_KEY',
    'GOOGLE_APPLICATION_CREDENTIALS',
    'VAULT_TOKEN',
    'TERRAFORM_CLOUD_TOKEN',
    'HEROKU_API_KEY',
    'SLACK_TOKEN',
    'PYPI_TOKEN',
    'TWINE_PASSWORD',
    'HUAWEI_DOMAIN_TOKEN',
    'HUAWEI_SECURITY_TOKEN',
  ];
  const keys = [...passThrough, ...stripped];
  const saved = new Map(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) process.env[key] = `fixture-${key}`;
  try {
    const env = await childEnv();
    for (const key of passThrough) assert.equal(env[key], `fixture-${key}`, `${key} passes through for the mirror`);
    for (const key of stripped) assert.equal(env[key], undefined, `${key} must not reach npx`);
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('upgradePackage 失败原因: 成功缺口里的后段失败对胜过早段原因', async () => {
  const stderr = [
    'native build failed: missing libfoo. rebuild aborted.',
    'gyp info ok',
    'npm info run pkg@1.0.0 postinstall node ./post.js',
    'npm info run pkg@1.0.0 postinstall { code: 7, signal: null }',
  ].join('\n');
  const reason = await reasonFor(stderr, 7);
  assert.match(reason, /postinstall/);
  assert.doesNotMatch(reason, /native build failed/);
});

test('upgradePackage 失败原因: 噪声行平移不影响成功缺口规则', async () => {
  const stderr = [
    'npm warn deprecated foo@1.0.0',
    'native build failed: missing libfoo. rebuild aborted.',
    'gyp info ok',
    'npm info run pkg@1.0.0 postinstall node ./post.js',
    'npm info run pkg@1.0.0 postinstall { code: 7, signal: null }',
  ].join('\n');
  const reason = await reasonFor(stderr, 7);
  assert.match(reason, /postinstall/);
  assert.doesNotMatch(reason, /native build failed/);
});

test('upgradePackage 失败原因: 内层恢复块的 code 不粘到外层失败回显', async () => {
  const stderr = [
    'npm error code 1',
    'npm error path /home/op/inner',
    'npm error command failed',
    'npm error command sh -c node one.js',
    'npm error code 7',
    'npm error path /home/op/outer',
    'npm error command failed',
    'npm error command sh -c node two.js',
  ].join('\n');
  const reason = await reasonFor(stderr);
  assert.match(reason, /code 7/);
  assert.match(reason, /node two\.js/);
  assert.doesNotMatch(reason, /code 1|one\.js/);
});

test('upgradePackage 失败原因: 恢复步的回显不冒充失败步的命令', async () => {
  const stderr = [
    'npm error code 1',
    'npm error gyp ERR! stack Error: EACCES: permission denied',
    'npm error gyp info ok',
    'npm error command sh -c node one.js',
    'npm error path /home/op/outer',
  ].join('\n');
  const reason = await reasonFor(stderr);
  assert.match(reason, /code 1/);
  assert.doesNotMatch(reason, /node one\.js/);
});

test('upgradePackage 失败原因: [cause] 行降级而非删除, TypeError 仍是原因', async () => {
  const stderr = ['[TypeError: fetch failed] {', '  [cause]: Error: bad port', "  code: 'ERR_BAD_PORT'"].join('\n');
  const reason = await reasonFor(stderr, 1);
  assert.match(reason, /\[TypeError: fetch failed\]/);
  assert.doesNotMatch(reason, /\[cause\]/);
});

test('upgradePackage 失败原因: 未闭合的 requireStack 数组保留元数据降级', async () => {
  const stderr = ['npm error code 1', 'npm error requireStack: [', "npm error   '/home/op/x.js'"].join('\n');
  const reason = await reasonFor(stderr);
  assert.match(reason, /code 1/);
  assert.doesNotMatch(reason, /requireStack|\/home\/op\/x\.js/);
});

test('upgradePackage 失败原因: 真实恢复后失败取外层 code 与失败回显', async () => {
  const reason = await reasonFor(failureStderr('real-recovered-then-fail.err'), 7);
  assert.match(reason, /postinstall/);
  assert.match(reason, /node post\.js/);
  assert.doesNotMatch(reason, /EACCES/);
});

test('upgradePackage 失败原因: 第二份真实恢复捕获同样取外层块', async () => {
  const reason = await reasonFor(failureStderr('real-recovered-then-fail2.err'), 7);
  assert.match(reason, /postinstall/);
  assert.doesNotMatch(reason, /ENOENT/);
});

test('upgradePackage 失败原因: 三段块内层代码不粘到外层回显', async () => {
  const reason = await reasonFor(failureStderr('seam-codepair-inner.err'));
  assert.match(reason, /code 7/);
  assert.match(reason, /node two\.js/);
  assert.doesNotMatch(reason, /code 1|inner\.js/);
});

test('upgradePackage 失败原因: 三段交错块取最后一段', async () => {
  const reason = await reasonFor(failureStderr('seam-3block.err'));
  assert.match(reason, /code 7/);
  assert.match(reason, /node three\.js/);
});

test('upgradePackage 失败原因: 文本相同的回显取失败步的那一次', async () => {
  const reason = await reasonFor(failureStderr('seam-dup-echo.err'));
  assert.match(reason, /code 7/);
  assert.match(reason, /command sh -c node one\.js/);
});

test('upgradePackage 失败原因: 带 errno 的 [cause] 行仍降级', async () => {
  const reason = await reasonFor(failureStderr('cause-errno-twist.err'), 1);
  assert.match(reason, /\[TypeError: fetch failed\]/);
  assert.doesNotMatch(reason, /\[cause\]|EACCES/);
});

test('upgradePackage 失败原因: 重复的 code 文本取失败步自己的那一段', async () => {
  const reason = await reasonFor(failureStderr('dup-code-text.err'));
  assert.match(reason, /code 1/);
  assert.match(reason, /command sh -c node two\.js/);
  assert.doesNotMatch(reason, /node one\.js/);
});

test('upgradePackage 失败原因: 真实重复 EACCES 块取后段 code 与失败回显', async () => {
  const reason = await reasonFor(failureStderr('real-dup-code-recovered.err'), 7);
  assert.match(reason, /code EACCES/);
  assert.match(reason, /postinstall/);
  assert.match(reason, /node post\.js/);
});

test('upgradePackage 失败原因: 重复诊断文本不给失败步扣恢复帽', async () => {
  const reason = await reasonFor(failureStderr('dup-diag.err'));
  assert.match(reason, /code EACCES/);
  assert.match(reason, /EACCES: permission denied, mkdir '\/ro'/);
  assert.doesNotMatch(reason, /node d\.js/);
});

test('upgradePackage 失败原因: 四块混合真实捕获取最后失败块', async () => {
  const reason = await reasonFor(failureStderr('real-four-block-mixed.err'), 7);
  assert.match(reason, /code EACCES/);
  assert.match(reason, /postinstall/);
  assert.doesNotMatch(reason, /ENOENT/);
});

test('upgradePackage 失败原因: 同一步的 gyp ok 不触发恢复交换', async () => {
  const reason = await reasonFor(failureStderr('rank2-sameturn-recover.err'), 7);
  assert.match(reason, /code 7/);
  assert.match(reason, /postinstall output: cache locked/);
  assert.doesNotMatch(reason, /command sh -c/);
});

test('upgradePackage 失败原因: rank-1 同一步形状同样不交换', async () => {
  const reason = await reasonFor(failureStderr('rank1-sameturn-recover.err'), 7);
  assert.match(reason, /code 7/);
  assert.match(reason, /postinstall output: build failed/);
  assert.doesNotMatch(reason, /command sh -c/);
});

test('upgradePackage 失败原因: 默认 loglevel 的安装对取外层 code 与回显', async () => {
  const reason = await reasonFor(failureStderr('real-install-default-loglevel.err'), 7);
  assert.match(reason, /code 7/);
  assert.match(reason, /command sh -c node post\.js/);
  assert.doesNotMatch(reason, /EACCES|root-owned/);
});

test('upgradePackage 失败原因: 默认 loglevel 的孤立嵌套块退回退出码', async () => {
  const reason = await reasonFor(failureStderr('real-nested-default-loglevel.err'), 7);
  assert.equal(reason, 'exit 7');
});

test('upgradePackage 失败原因: 默认 loglevel 的块外垂死行成为原因', async () => {
  const reason = await reasonFor(failureStderr('real-neutral-default-loglevel.err'), 7);
  assert.equal(reason, 'runtime dependency refresh skipped');
});

test('upgradePackage 失败原因: 唯一的 [cause] 行仍作为原因', async () => {
  const reason = await reasonFor(failureStderr('cause-plain.err'));
  assert.equal(reason, '[cause]: Error: EACCES: permission denied');
});

test('upgradePackage 失败原因: 元数据块只回 code 行', async () => {
  const reason = await reasonFor(failureStderr('metadata-only-block.err'));
  assert.equal(reason, 'npm error code E404');
});

test('upgradePackage 失败原因: 恢复步的回显不抢元数据外层块', async () => {
  const stderr = [
    'npm error command sh -c node pre-recover.js',
    '{ code: 0, signal: null }',
    'npm error code 7',
    'npm error path /home/op/final',
    'npm error syscall open',
  ].join('\n');
  const reason = await reasonFor(stderr, 7);
  assert.equal(reason, 'npm error code 7');
});

test('upgradePackage 失败原因: 共享 code 文本的嵌套块仍取外层失败块', async () => {
  const reason = await reasonFor(failureStderr('real-dup-block-shared-code.err'), 7);
  assert.match(reason, /code 7/);
  assert.match(reason, /command sh -c node post\.js/);
  assert.doesNotMatch(reason, /child dependency build failed|fail\.js/);
});

test('upgradePackage 失败原因: 三块共享 code 文本同样取最后失败块', async () => {
  const reason = await reasonFor(failureStderr('real-three-block-shared-code.err'), 7);
  assert.match(reason, /code 7/);
  assert.match(reason, /command sh -c node post\.js/);
  assert.doesNotMatch(reason, /child dependency build failed|E404/);
});

test('upgradePackage 失败原因: code 不同的对照仍取外层块', async () => {
  const reason = await reasonFor(failureStderr('real-dup-block-distinct-code.err'), 7);
  assert.match(reason, /code 8/);
  assert.match(reason, /command sh -c node post\.js/);
});

test('upgradePackage 失败原因: verbose 下尾部失败块拥有失败结果', async () => {
  const reason = await reasonFor(failureStderr('real-verbose-sameturn.err'), 7);
  assert.match(reason, /code 7/);
  assert.match(reason, /command sh -c node post\.js/);
  assert.doesNotMatch(reason, /E404|404 Not Found/);
});

test('upgradePackage 失败原因: 长 verbose 捕获取失败步自己的垂死行, 尾部块不再覆盖', async () => {
  const reason = await reasonFor(failureStderr('real-verbose-sameturn-long.err'), 7);
  assert.match(reason, /postinstall: link step aborted after a successful build/);
  assert.doesNotMatch(reason, /E404|404 Not Found|command sh -c/);
});

test('upgradePackage 失败原因: 去掉嵌套块的 verbose 对照不变', async () => {
  const reason = await reasonFor(failureStderr('real-verbose-no-nested.err'), 7);
  assert.match(reason, /code 7/);
  assert.match(reason, /command sh -c node post\.js/);
});

test('upgradePackage 失败原因: 默认 loglevel 的两块对照仍取外层块', async () => {
  const reason = await reasonFor(failureStderr('real-two-block-default.err'), 7);
  assert.match(reason, /code 7/);
  assert.match(reason, /command sh -c node post\.js/);
  assert.doesNotMatch(reason, /E404|404 Not Found/);
});

test('upgradePackage 失败原因: 两个恢复的异码嵌套块不抢垂死行', async () => {
  const reason = await reasonFor(failureStderr('real-two-nested-default.err'), 7);
  assert.equal(reason, 'runtime dependency refresh skipped');
});

test('upgradePackage 失败原因: 一个恢复的嵌套块对照仍是垂死行', async () => {
  const reason = await reasonFor(failureStderr('real-one-nested-default.err'), 7);
  assert.equal(reason, 'runtime dependency refresh skipped');
});

test('upgradePackage 失败原因: 崩溃片段重复垂死行文本仍按自己的位置判定', async () => {
  const reason = await reasonFor(failureStderr('seam-survivor-dup-text.err'), 7);
  assert.equal(reason, 'exit 7');
});

test('upgradePackage 失败原因: 崩溃片段不重复文本的对照同样退出码', async () => {
  const reason = await reasonFor(failureStderr('seam-survivor-dup-text-control.err'), 7);
  assert.equal(reason, 'exit 7');
});

test('upgradePackage 失败原因: 对内的成功不夺走失败步的垂死行', async () => {
  const reason = await reasonFor(failureStderr('seam-inpair-success.err'), 7);
  assert.equal(reason, 'build failed hard, cache locked');
});

test('upgradePackage 失败原因: 真实 sameturn 形状仍取失败步的垂死行', async () => {
  const reason = await reasonFor(failureStderr('seam-sameturn-inforun.err'), 7);
  assert.equal(reason, 'build failed hard, cache locked');
});

test('upgradePackage 失败原因: 块内同层强标记取靠后行, 前置异码块不改变答案', async () => {
  const stderr = [
    'npm error code 9',
    'npm error Error: earlier distinct failure',
    'npm error command sh -c node earlier.js',
    'npm error code 1',
    'npm error Error: lockfile is corrupt, retrying with cache',
    'npm error command sh -c node fail.js',
    "npm error EACCES: permission denied, open '/home/op/.npm/_cacache'",
  ].join('\n');
  const reason = await reasonFor(stderr);
  assert.match(reason, /code 1/);
  assert.match(reason, /EACCES: permission denied/);
  assert.doesNotMatch(reason, /lockfile is corrupt|earlier distinct/);
});

test('upgradePackage 失败原因: 块前回显不给元数据块当原因', async () => {
  const stderr = ['sh -c one.js', 'npm error code 7', 'npm error path /home/op/pkg', 'npm error syscall open'].join(
    '\n',
  );
  const reason = await reasonFor(stderr, 7);
  assert.equal(reason, 'npm error code 7');
});

test('upgradePackage 失败原因: 末尾裸 code 块只回 code 行', async () => {
  const stderr = ['npm error code 1', 'npm error syscall mkdir', 'npm error code 7'].join('\n');
  const reason = await reasonFor(stderr, 7);
  assert.equal(reason, 'npm error code 7');
});

test('upgradePackage 失败原因: 元数据孤块在非 1 退出时退回退出码', async () => {
  const stderr = [
    'npm error code EACCES',
    'npm error syscall mkdir',
    'npm error path /home/op/ro-cache/_cacache',
    'npm error errno EACCES',
  ].join('\n');
  const reason = await reasonFor(stderr, 7);
  assert.equal(reason, 'exit 7');
});

test('upgradePackage 失败原因: 元数据孤块在退出 1 时仍回 code 行', async () => {
  const reason = await reasonFor(failureStderr('metadata-only-block.err'));
  assert.equal(reason, 'npm error code E404');
});

test('upgradePackage 失败原因: 两块静默嵌套块不把恢复步的正文当原因', async () => {
  const reason = await reasonFor(failureStderr('real-two-nested-silent.err'), 7);
  assert.equal(reason, 'exit 7');
});

test('upgradePackage 失败原因: 三块混合静默嵌套同样退回退出码', async () => {
  const reason = await reasonFor(failureStderr('real-three-nested-silent.err'), 7);
  assert.equal(reason, 'exit 7');
});

test('upgradePackage 失败原因: 四块静默对照仍是退出码', async () => {
  const reason = await reasonFor(failureStderr('real-four-nested-silent.err'), 7);
  assert.equal(reason, 'exit 7');
});

test('upgradePackage 失败原因: 最后嵌套块之前的恢复行不是垂死行', async () => {
  const reason = await reasonFor(failureStderr('real-recovered-then-fail-line.err'), 7);
  assert.equal(reason, 'exit 7');
});

test('upgradePackage 失败原因: 块内重复文本不改写嵌套块的退出码底线', async () => {
  const stderr = [
    'child failed (exit 3)',
    '{ code: 0, signal: null }',
    'npm error code EACCES',
    'npm error syscall mkdir',
    'npm error path /home/op/ro-cache/_cacache',
    'npm error child failed (exit 3)',
  ].join('\n');
  const reason = await reasonFor(stderr, 7);
  assert.equal(reason, 'exit 7');
});

test('upgradePackage 失败原因: 多块捕获的块前前导行不作垂死行, 块内重复不改变答案', async () => {
  const reason = await reasonFor(failureStderr('seam-survivor-in-block.err'), 7);
  assert.equal(reason, 'exit 7');
});

test('upgradePackage 失败原因: 去掉块内重复的对照同样退出码', async () => {
  const stderr = [
    'child failed (exit 3)',
    '{ code: 0, signal: null }',
    'npm error code EACCES',
    'npm error syscall mkdir',
    'npm error path /home/op/ro-cache/_cacache',
  ].join('\n');
  const reason = await reasonFor(stderr, 7);
  assert.equal(reason, 'exit 7');
});

test('upgradePackage 失败原因: 兄弟步成功后的杂音不冒充失败步', async () => {
  const reason = await reasonFor(failureStderr('seam-silent-child-inpair-success.err'), 7);
  assert.equal(reason, 'npm info run probe-root@1.0.0 postinstall node_modules/probe-root node build.js');
});

test('upgradePackage 失败原因: 成功结果在对回显之前时仍取失败对回显', async () => {
  const reason = await reasonFor(failureStderr('seam-silent-child-before-echo.err'), 7);
  assert.equal(reason, 'npm info run probe-root@1.0.0 postinstall node_modules/probe-root node build.js');
});

test('upgradePackage 失败原因: info 级真实捕获取失败 postinstall 的回显', async () => {
  const reason = await reasonFor(failureStderr('real-loud-success-info.err'), 7);
  assert.match(reason, /postinstall node_modules\/huaweicloud-devkit node post\.js/);
  assert.doesNotMatch(reason, /inner-ok/);
});

test('upgradePackage 失败原因: 去掉嵌套成功安装的对照不变', async () => {
  const reason = await reasonFor(failureStderr('real-loud-fail-only-info.err'), 7);
  assert.match(reason, /postinstall node_modules\/huaweicloud-devkit node post\.js/);
});

test('upgradePackage 失败原因: 回显重复文本按回显自己的位置判定', async () => {
  const reason = await reasonFor(failureStderr('seam-cause-dup-echo.err'), 7);
  assert.equal(reason, '[cause]: Error: probe dependency crashed');
});

test('upgradePackage 失败原因: 去掉重复回显的 [cause] 对照仍保留', async () => {
  const stderr = [
    '[cause]: Error: probe dependency crashed',
    "sh -c 'node helper.js'",
    '{ code: 7, signal: null }',
    '{ code: 0, signal: null }',
  ].join('\n');
  const reason = await reasonFor(stderr, 7);
  assert.equal(reason, '[cause]: Error: probe dependency crashed');
});

test('upgradePackage 失败原因: 三块数字代码都不等于退出码时退回退出码', async () => {
  const reason = await reasonFor(failureStderr('real-mixed-nested-numeric.err'), 7);
  assert.equal(reason, 'exit 7');
});

test('upgradePackage 失败原因: 末块为 errno 的三块对照同样退出码', async () => {
  const reason = await reasonFor(failureStderr('real-mixed-nested-errno-last.err'), 7);
  assert.equal(reason, 'exit 7');
});

test('upgradePackage 失败原因: 失败对内嵌套兄弟的成功窗口不冒充失败步', async () => {
  const reason = await reasonFor(failureStderr('real-inwin-success-sibling.err'), 7);
  assert.equal(
    reason,
    'npm info run huaweicloud-devkit@9.9.9 postinstall node_modules/huaweicloud-devkit node postinstall.js',
  );
});

test('upgradePackage 失败原因: 同名包内嵌套的成功运行不冒充外层失败步', async () => {
  const reason = await reasonFor(failureStderr('real-samepkg-nested-recovered.err'), 7);
  assert.equal(
    reason,
    'npm info run huaweicloud-devkit@9.9.9 postinstall node_modules/huaweicloud-devkit node postinstall.js',
  );
});

test('upgradePackage 失败原因: 三块共享 code 的嵌套块不声称退出码语义', async () => {
  const reason = await reasonFor(failureStderr('real-numeric-shared-nested.err'), 7);
  assert.equal(reason, 'exit 7');
});

test('upgradePackage 失败原因: 末块 code 不同的对照仍是退出码', async () => {
  const reason = await reasonFor(failureStderr('real-numeric-shared-control.err'), 7);
  assert.equal(reason, 'exit 7');
});

test('upgradePackage 失败原因: 多个失败对内嵌套成功窗口全部排除', async () => {
  const reason = await reasonFor(failureStderr('real-plural-recovered-windows.err'), 7);
  assert.equal(
    reason,
    'npm info run huaweicloud-devkit@1.0.0 postinstall node_modules/huaweicloud-devkit node post.js',
  );
});

test('upgradePackage 失败原因: 单个失败对内嵌套成功窗口同样排除', async () => {
  const reason = await reasonFor(failureStderr('real-nested-recovered-window.err'), 7);
  assert.equal(
    reason,
    'npm info run huaweicloud-devkit@1.0.0 postinstall node_modules/huaweicloud-devkit node post.js',
  );
});

test('upgradePackage 失败原因: 同名嵌套恢复运行后失败步自己的垂死行保留', async () => {
  const reason = await reasonFor(failureStderr('real-same-name-nested.err'), 7);
  assert.equal(reason, 'build failed hard, cache locked');
});

test('upgradePackage 失败原因: 失败对内的同包恢复运行不顶替垂死行', async () => {
  const reason = await reasonFor(failureStderr('real-inpair-success-nested.err'), 7);
  assert.equal(reason, 'build failed hard, cache locked');
});

test('upgradePackage 失败原因: 首个嵌套块之前的前导垂死行保留', async () => {
  const reason = await reasonFor(failureStderr('real-preamble-before-block.err'), 7);
  assert.equal(reason, 'probe postinstall: build failed, giving up');
});

test('upgradePackage 失败原因: 两嵌套块之间的恢复聊天仍不作垂死行', async () => {
  const reason = await reasonFor(failureStderr('real-chatter-between-blocks.err'), 7);
  assert.equal(reason, 'exit 7');
});

test('upgradePackage 失败原因: 回显层按失败结果的包与脚本身份配对', async () => {
  const stderr = [
    'npm info run huaweicloud-devkit@9.9.9 postinstall node_modules/huaweicloud-devkit node post.js',
    'npm info run inner-ok@1.0.0 postinstall node_modules/inner-ok node ok.js',
    'npm info run inner-ok@1.0.0 postinstall { code: 0, signal: null }',
    'npm info run huaweicloud-devkit@9.9.9 postinstall { code: 7, signal: null }',
  ].join('\n');
  const reason = await reasonFor(stderr, 7);
  assert.equal(
    reason,
    'npm info run huaweicloud-devkit@9.9.9 postinstall node_modules/huaweicloud-devkit node post.js',
  );
});

test('upgradePackage 失败原因: 首个代码块之前的 npm 错误正文不作垂死行', async () => {
  const stderr = [
    'npm error FetchError: probe recovered fetch failed',
    'npm error code EACCES',
    'npm error syscall mkdir',
    'npm error errno EACCES',
  ].join('\n');
  const reason = await reasonFor(stderr, 7);
  assert.equal(reason, 'exit 7');
});

test('upgradePackage 失败原因: 块体内插入的垂死行不越过块边界', async () => {
  const stderr = [
    'npm error code EACCES',
    'child failed, continuing',
    'npm error path /home/op/ro-cache/_cacache',
    'npm error errno EACCES',
  ].join('\n');
  const reason = await reasonFor(stderr, 7);
  assert.equal(reason, 'exit 7');
});

test('upgradePackage 失败原因: 块体结束后的垂死行仍保留', async () => {
  const stderr = [
    'npm error code EACCES',
    'npm error path /home/op/ro-cache/_cacache',
    'npm error errno EACCES',
    'child failed, giving up',
  ].join('\n');
  const reason = await reasonFor(stderr, 7);
  assert.equal(reason, 'child failed, giving up');
});

test('upgradePackage 失败原因: 四块恢复的嵌套块静默失败退回退出码', async () => {
  const reason = await reasonFor(failureStderr('real-four-nested-recovered.err'), 7);
  assert.equal(reason, 'exit 7');
});

test('upgradePackage 失败原因: 并发同身份兄弟的成功窗口各归各的位置', async () => {
  const reason = await reasonFor(failureStderr('real-concurrent-siblings.err'), 7);
  assert.equal(reason, 'outer probe failed hard, giving up');
});

test('upgradePackage 失败原因: 并发兄弟的垂死行落在后段回显之后时对照仍取外层垂死行', async () => {
  const reason = await reasonFor(failureStderr('real-concurrent-siblings-late.err'), 7);
  assert.equal(reason, 'outer probe failed hard, giving up');
});

test('upgradePackage 失败原因: 同身份唯一回显属于恢复运行时退回退出码', async () => {
  const reason = await reasonFor(failureStderr('seam-sameident-only-echo.err'), 7);
  assert.equal(reason, 'exit 7');
});

test('upgradePackage 失败原因: 同身份唯一回显的强诊断同样不冒充失败步', async () => {
  const reason = await reasonFor(failureStderr('seam-sameident-only-echo-error.err'), 7);
  assert.equal(reason, 'exit 7');
});

test('upgradePackage 失败原因: 异身份唯一回显只属于恢复运行', async () => {
  const reason = await reasonFor(failureStderr('seam-sameident-only-echo-otherident.err'), 7);
  assert.equal(reason, 'exit 7');
});

test('upgradePackage 失败原因: 回显层排除恢复窗口自己的回显', async () => {
  const reason = await reasonFor(failureStderr('seam-window-echo-identity.err'), 7);
  assert.equal(reason, 'npm info run pkg@1.0.0 postinstall node_modules/pkg node post.js');
});

test('upgradePackage 失败原因: 裸结果无自身回显时取失败步的体内垂死行', async () => {
  const reason = await reasonFor(failureStderr('seam-bare-result-recovered-echo.err'), 7);
  assert.equal(reason, 'build failed hard, cache locked');
});

test('upgradePackage 失败原因: 未裁剪的真实安装捕获保留尾部块之后的垂死行', async () => {
  const reason = await reasonFor(failureStderr('real-trailing-block-dying-words.err'), 7);
  assert.equal(reason, 'build failed hard, cache locked');
});

test('upgradePackage 失败原因: 语料内的失败对加尾部块同样保留垂死行', async () => {
  const reason = await reasonFor(failureStderr('real-trailing-block-corpus.err'), 7);
  assert.equal(reason, 'build failed hard, cache locked');
});

test('upgradePackage 失败原因: 有体块后的无体重复 code 行保留有体块的 echo', async () => {
  const stderr = [
    'npm error code ECONNREFUSED',
    'npm error syscall connect',
    'npm error errno ECONNREFUSED',
    'npm error FetchError: request failed',
    'npm error code 7',
    'npm error path /pkg',
    'npm error command failed',
    'npm error command sh -c node postinstall.js',
    'npm error code 7',
  ].join('\n');
  const reason = await reasonFor(stderr, 7);
  assert.match(reason, /code 7/);
  assert.match(reason, /command sh -c node postinstall\.js/);
});

test('upgradePackage 失败原因: 块后的 [cause] 行仍作为原因', async () => {
  const stderr = [
    'npm error code EACCES',
    'npm error syscall mkdir',
    'npm error errno EACCES',
    '[cause]: Error: late cause after the block',
  ].join('\n');
  const reason = await reasonFor(stderr, 7);
  assert.equal(reason, '[cause]: Error: late cause after the block');
});

test('upgradePackage 失败原因: 回显即恢复窗口起点时退回退出码', async () => {
  const stderr = [
    'npm info run huaweicloud-devkit@1.0.0 postinstall node_modules/huaweicloud-devkit node post.js',
    'probe failed once, recovered',
    'npm info run huaweicloud-devkit@1.0.0 postinstall { code: 0, signal: null }',
    'npm info run huaweicloud-devkit@1.0.0 postinstall { code: 7, signal: null }',
  ].join('\n');
  const reason = await reasonFor(stderr, 7);
  assert.equal(reason, 'exit 7');
});

test('upgradePackage 失败原因: 失败回显之前的恢复窗口不吞掉失败步的垂死行', async () => {
  const reason = await reasonFor(failureStderr('real-window-before-pair-sibling.err'), 7);
  assert.equal(reason, 'outer probe failed hard, giving up');
});

test('upgradePackage 失败原因: 恢复窗口在失败回显之前且杂音更早时对照不变', async () => {
  const reason = await reasonFor(failureStderr('real-window-before-pair-control.err'), 7);
  assert.equal(reason, 'outer probe failed hard, giving up');
});

test('upgradePackage 失败原因: 两个 code-0 结果共用一个回显时后者不吞失败步的垂死行', async () => {
  const reason = await reasonFor(failureStderr('seam-two-results-one-echo.err'), 7);
  assert.equal(reason, 'outer probe failed hard, giving up');
});

test('upgradePackage 失败原因: 两个结果各有回显的对照同样取失败步垂死行', async () => {
  const reason = await reasonFor(failureStderr('seam-two-results-two-echoes.err'), 7);
  assert.equal(reason, 'outer probe failed hard, giving up');
});

test('upgradePackage 失败原因: 窗口正好覆盖失败对内部时取失败对回显', async () => {
  const reason = await reasonFor(failureStderr('seam-window-touches-pair.err'), 7);
  assert.equal(reason, 'npm info run outer@1.0.0 postinstall node_modules/outer node fail.js');
});

test('upgradePackage 失败原因: 窗口末端贴住失败结果时仍取失败步垂死行', async () => {
  const reason = await reasonFor(failureStderr('seam-window-end-touches-result.err'), 7);
  assert.equal(reason, 'outer probe failed hard, giving up');
});

test('upgradePackage 失败原因: 嵌套结果紧邻失败结果时取失败对回显', async () => {
  const reason = await reasonFor(failureStderr('seam-nested-result-adjacent.err'), 7);
  assert.equal(reason, 'npm info run outer@1.0.0 postinstall node_modules/outer node fail.js');
});

test('upgradePackage 失败原因: 汇总后的孤儿结果不让非贴合块顶掉贴合块', async () => {
  const reason = await reasonFor(failureStderr('real-orphan-after-summary.err'), 7);
  assert.match(reason, /code 7/);
  assert.match(reason, /command sh -c node post\.js/);
  assert.doesNotMatch(reason, /node z\.js|code 3/);
});

test('upgradePackage 失败原因: 尾部块不再覆盖 rank-2 的失败步垂死行', async () => {
  const reason = await reasonFor(failureStderr('real-trailing-block-rank2-words.err'), 7);
  assert.equal(reason, 'OUTER-POSTINSTALL: cache locked');
});

test('upgradePackage 失败原因: 失败对的回显落在更早窗口内时取失败步自己的行', async () => {
  const stderr = [
    'npm info run pkg@1.0.0 postinstall node_modules/pkg node post.js',
    'npm info run inner@1.0.0 postinstall node_modules/inner node inner.js',
    'inner failed once, recovered',
    'npm info run pkg@1.0.0 postinstall { code: 0, signal: null }',
    'npm info run inner@1.0.0 postinstall { code: 7, signal: null }',
  ].join('\n');
  const reason = await reasonFor(stderr, 7);
  assert.equal(reason, 'npm info run inner@1.0.0 postinstall node_modules/inner node inner.js');
});

test('upgradePackage 失败原因: 无可认领回显的第二个结果的聊天不作原因', async () => {
  const stderr = [
    'npm info run pkg@1.0.0 postinstall node_modules/pkg node post.js',
    'first run failed once, recovered',
    'npm info run pkg@1.0.0 postinstall node_modules/pkg node post.js',
    'npm info run pkg@1.0.0 postinstall { code: 0, signal: null }',
    'npm info run pkg@1.0.0 postinstall { code: 0, signal: null }',
    'npm info run pkg@1.0.0 postinstall { code: 7, signal: null }',
  ].join('\n');
  const reason = await reasonFor(stderr, 7);
  assert.equal(reason, 'exit 7');
});

test('upgradePackage 失败原因: 每个 code-0 结果认领各自最近未占用回显', async () => {
  const stderr = [
    'npm info run outer@1.0.0 postinstall node_modules/outer node post.js',
    'outer probe failed hard, giving up',
    'npm info run pkg@1.0.0 postinstall node_modules/pkg node a.js',
    'pkg a: cache locked, continuing anyway',
    'npm info run pkg@1.0.0 postinstall node_modules/pkg node b.js',
    'pkg b: cache locked, continuing anyway',
    'npm info run pkg@1.0.0 postinstall { code: 0, signal: null }',
    'npm info run pkg@1.0.0 postinstall { code: 0, signal: null }',
    'npm info run outer@1.0.0 postinstall { code: 7, signal: null }',
  ].join('\n');
  const reason = await reasonFor(stderr, 7);
  assert.equal(reason, 'outer probe failed hard, giving up');
});

test('upgradePackage 失败原因: 块后垂死行之后的成功断言否决它', async () => {
  const stderr = [
    'npm error code EACCES',
    'npm error syscall mkdir',
    'npm error errno EACCES',
    'child failed, giving up',
    'gyp info ok',
  ].join('\n');
  const reason = await reasonFor(stderr, 7);
  assert.equal(reason, 'exit 7');
});

test('upgradePackage 失败原因: 失败步的 FATAL recover 词不被当作恢复公告', async () => {
  const reason = await reasonFor(failureStderr('real-recover-words-fatal.err'), 7);
  assert.equal(reason, 'FATAL: failed to recover session keystore from vault');
});

test('upgradePackage 失败原因: 同捕获的 restore 控制同样保留垂死行', async () => {
  const reason = await reasonFor(failureStderr('real-recover-words-control.err'), 7);
  assert.equal(reason, 'FATAL: failed to restore session keystore from vault');
});

test('upgradePackage 失败原因: 交错捕获里失败步自己的 recover 词保留', async () => {
  const reason = await reasonFor(failureStderr('real-recover-words-interleaved.err'), 7);
  assert.equal(reason, 'outer probe could not recover, giving up');
});

test('upgradePackage 失败原因: 交错捕获的普通垂死行对照不变', async () => {
  const reason = await reasonFor(failureStderr('real-recover-words-interleaved-control.err'), 7);
  assert.equal(reason, 'outer probe failed hard, giving up');
});

test('upgradePackage 失败原因: 并发锁争夺时失败步自己的 FATAL 词语不被嵌套成功窗口吞掉', async () => {
  const reason = await reasonFor(failureStderr('real-concurrent-lock-race.err'), 7);
  assert.equal(reason, 'FATAL: build lock held by concurrent run');
});

test('upgradePackage 失败原因: 并发锁争夺的对照同样保留垂死行', async () => {
  const reason = await reasonFor(failureStderr('real-concurrent-lock-race-control.err'), 7);
  assert.equal(reason, 'FATAL: build lock held by concurrent run');
});

test('upgradePackage 失败原因: recovery 名词形式的公告也排除', async () => {
  const stderr = [
    'npm info run pkg@1.0.0 postinstall node_modules/pkg node post.js',
    'pkg cache recovery complete, continuing anyway',
    'npm info run pkg@1.0.0 postinstall { code: 7, signal: null }',
  ].join('\n');
  const reason = await reasonFor(stderr, 7);
  assert.equal(reason, 'npm info run pkg@1.0.0 postinstall node_modules/pkg node post.js');
});

test('upgradePackage 失败原因: 错误块体内的恢复公告不参与块行竞争', async () => {
  const stderr = [
    'npm error code 7',
    'npm error path /pkg',
    'npm error probe recovered, continuing',
    'npm error command failed',
    'npm error command sh -c node post.js',
  ].join('\n');
  const reason = await reasonFor(stderr, 7);
  assert.equal(reason, 'npm error code 7 npm error command sh -c node post.js');
});

test('upgradePackage 失败原因: 块体边界在后续 lifecycle 行处结束', async () => {
  const stderr = [
    'npm info run outer postinstall node_modules/outer node fail.js',
    'npm info run outer postinstall { code: 7, signal: null }',
    'npm error code 7',
    'npm error path /pkg',
    'npm info run pkg@1.0.0 postinstall node_modules/pkg node one.js',
    'npm error command failed',
    'npm error command sh -c node two.js',
  ].join('\n');
  const reason = await reasonFor(stderr, 7);
  assert.equal(reason, 'npm error code 7');
});

test('upgradePackage 失败原因: 无失败对时窗口整体排除', async () => {
  const stderr = [
    'npm info run pkg postinstall node_modules/pkg node post.js',
    'child failed hard, giving up',
    'npm info run pkg postinstall { code: 0, signal: null }',
    'npm error code EACCES',
    'npm error syscall mkdir',
    'npm error errno EACCES',
  ].join('\n');
  const reason = await reasonFor(stderr, 7);
  assert.equal(reason, 'exit 7');
});

test('upgradePackage 失败原因: 有失败对时无体重复块保留有体孪生行', async () => {
  const stderr = [
    'npm info run outer postinstall node_modules/outer node post.js',
    'outer probe failed hard, giving up',
    'npm info run outer postinstall { code: 7, signal: null }',
    'npm error code 7',
    'npm error path /pkg',
    'npm error command failed',
    'npm error command sh -c node post.js',
    'npm error code 7',
  ].join('\n');
  const reason = await reasonFor(stderr, 7);
  assert.equal(reason, 'outer probe failed hard, giving up');
});

test('upgradePackage 失败原因: 并发成功先落地时失败步仍取得自己的回显锚点', async () => {
  const reason = await reasonFor(failureStderr('real-concurrent-lock-race-mirror.err'), 7);
  assert.equal(reason, 'FATAL: build lock held by concurrent run');
});

test('upgradePackage 失败原因: 并发失败先落地时同样取失败步自己的回显锚点', async () => {
  const reason = await reasonFor(failureStderr('real-concurrent-lock-race-start-first.err'), 7);
  assert.equal(reason, 'FATAL: build lock held by concurrent run');
});

test('upgradePackage 失败原因: 恢复步的 falling back 公告让位给真实失败行', async () => {
  const reason = await reasonFor(failureStderr('real-fallback-announcement-default.err'), 1);
  assert.equal(reason, "cannot find module './build-config'");
});

test('upgradePackage 失败原因: 恢复步的 retrying from 公告让位给真实失败行', async () => {
  const reason = await reasonFor(failureStderr('real-retry-announcement-default.err'), 1);
  assert.equal(reason, "cannot find module './build-config'");
});

test('upgradePackage 失败原因: 句末的 failed to recover 仍是诊断而非公告', async () => {
  const reason = await reasonFor(failureStderr('real-recover-sentence-final-default.err'), 1);
  assert.equal(reason, 'FATAL: failed to recover');
});

test('upgradePackage 失败原因: info 级句末 failed to recover 同样保留', async () => {
  const reason = await reasonFor(failureStderr('real-recover-sentence-final-info.err'), 7);
  assert.equal(reason, 'FATAL: failed to recover');
});

test('upgradePackage 失败原因: 句末的 unable/not/no 恢复否定仍是诊断', async () => {
  for (const line of ['unable to recover', 'credentials not recovered', 'no recovery', 'never recovered.']) {
    const stderr = [
      'npm info run pkg@1.0.0 postinstall node_modules/pkg node post.js',
      line,
      'npm info run pkg@1.0.0 postinstall { code: 7, signal: null }',
    ].join('\n');
    const reason = await reasonFor(stderr, 7);
    assert.equal(reason, line, line);
  }
});

test('upgradePackage 失败原因: 错误块体内句末 recover 否定不被吞掉', async () => {
  const stderr = [
    'npm error code 7',
    'npm error path /pkg',
    'npm error FATAL: failed to recover',
    'npm error command failed',
    'npm error command sh -c node post.js',
  ].join('\n');
  const reason = await reasonFor(stderr, 7);
  assert.match(reason, /failed to recover/);
});

test('upgradePackage 失败原因: recovered, fine 也按公告排除', async () => {
  const stderr = [
    'npm info run pkg@1.0.0 postinstall node_modules/pkg node post.js',
    'pkg recovered, fine',
    'npm info run pkg@1.0.0 postinstall { code: 7, signal: null }',
  ].join('\n');
  const reason = await reasonFor(stderr, 7);
  assert.equal(reason, 'npm info run pkg@1.0.0 postinstall node_modules/pkg node post.js');
});

test('upgradePackage 失败原因: 失败对无垂死行时有体孪生行仍保留', async () => {
  const stderr = [
    'npm info run outer postinstall node_modules/outer node post.js',
    'npm info run outer postinstall { code: 7, signal: null }',
    'npm error code 7',
    'npm error path /pkg',
    'npm error command failed',
    'npm error command sh -c node post.js',
    'npm error code 7',
  ].join('\n');
  const reason = await reasonFor(stderr, 7);
  assert.match(reason, /code 7/);
  assert.match(reason, /command sh -c node post\.js/);
});

test('upgradePackage 失败: 信号致死不报 exit null', async () => {
  const killed = { status: null, signal: 'SIGKILL', stdout: '', stderr: '' };
  const r = await upgradePackage({ target: 'opencode' }, { doQuery: stubQuery, spawnFn: () => killed });
  assert.equal(r.success, false);
  assert.match(r.error ?? '', /SIGKILL/);
  assert.doesNotMatch(r.error ?? '', /exit null/);
});

test('upgradePackage 升级子进程: 键名空白按 vault 谓词的归一处理', async () => {
  const padded = {
    'GITHUB_TOKEN ': 'fixture-github',
    'GITLAB_TOKEN  ': 'fixture-gitlab',
    ' HUAWEICLOUD_DEVKIT_HOME': '/fixture/home',
    ' HUAWEICLOUD_NPM_REGISTRY': 'http://devkit-mirror:4873',
    npm_config_registry: 'http://operator-mirror:4873',
  };
  const ambient = [
    'GITHUB_TOKEN',
    'GITLAB_TOKEN',
    'HUAWEICLOUD_DEVKIT_HOME',
    'HUAWEICLOUD_NPM_REGISTRY',
    'npm_config_registry',
  ];
  const saved = new Map(ambient.map((key) => [key, process.env[key]]));
  for (const key of ambient) delete process.env[key];
  for (const [key, value] of Object.entries(padded)) process.env[key] = value;
  try {
    const env = await childEnv();
    assert.equal(env['GITHUB_TOKEN '], undefined, 'the padded vendor spelling strips');
    assert.equal(env['GITLAB_TOKEN  '], undefined, 'trailing spaces beyond one also strip');
    assert.equal(env[' HUAWEICLOUD_DEVKIT_HOME'], undefined, 'the padded spelling is not forwarded');
    assert.equal(
      env.HUAWEICLOUD_DEVKIT_HOME,
      '/fixture/home',
      'the padded preserve key survives under the exact name the child reads',
    );
    assert.equal(env.HUAWEICLOUD_NPM_REGISTRY, 'http://devkit-mirror:4873', 'the padded registry pin forms');
    assert.equal(env[' HUAWEICLOUD_NPM_REGISTRY'], undefined, 'the padded registry spelling is not forwarded');
    assert.equal(env.npm_config_registry, 'http://devkit-mirror:4873', 'the canonical pin wins');
    assert.deepEqual(registrySpellings(env), ['npm_config_registry'], 'one registry spelling reaches npx');
  } finally {
    for (const key of Object.keys(padded)) delete process.env[key];
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('upgradePackage 升级子进程: 预检查询与子进程共享 npm 认证与镜像归一', async () => {
  await withTokenRegistry(
    ['fixture-registry-token', 'exact-token', 'variant-token'],
    {},
    async ({ registry, seen }) => {
      await withSavedEnv(
        ['NPM_TOKEN', 'NODE_AUTH_TOKEN', 'HUAWEICLOUD_NPM_REGISTRY', 'NPM_TOKEN ', 'npm_token', 'Npm_Token'],
        async () => {
          const attempt = async () => {
            let env: NodeJS.ProcessEnv | undefined;
            let spawned = false;
            const spawnFn: UpgradeSpawnFn = (_cmd, _args, opts) => {
              spawned = true;
              env = opts.env as NodeJS.ProcessEnv;
              return { status: 0 };
            };
            const result = await upgradePackage({ target: 'opencode' }, { spawnFn });
            return { result, env, spawned };
          };
          process.env.HUAWEICLOUD_NPM_REGISTRY = registry;
          process.env.NPM_TOKEN = '  fixture-registry-token  ';
          delete process.env.NODE_AUTH_TOKEN;
          const paddedToken = await attempt();
          assert.equal(paddedToken.result.success, true);
          assert.equal(paddedToken.spawned, true, 'the act proceeds to the spawn after an authenticated query');
          assert.equal(seen.at(-1), 'Bearer fixture-registry-token', 'the pre-flight trims the token');
          assert.equal(paddedToken.env?.NPM_TOKEN, 'fixture-registry-token', 'the child env token is trimmed too');

          delete process.env.NPM_TOKEN;
          process.env.NODE_AUTH_TOKEN = 'fixture-registry-token';
          const nodeAuth = await attempt();
          assert.equal(nodeAuth.result.success, true, 'NODE_AUTH_TOKEN also authenticates the query');
          assert.equal(seen.at(-1), 'Bearer fixture-registry-token');

          process.env.HUAWEICLOUD_NPM_REGISTRY = `  ${registry}  `;
          process.env.NPM_TOKEN = 'fixture-registry-token';
          delete process.env.NODE_AUTH_TOKEN;
          const paddedRegistry = await attempt();
          assert.equal(paddedRegistry.result.success, true, 'a padded registry spelling is usable end-to-end');

          delete process.env.HUAWEICLOUD_NPM_REGISTRY;
          process.env.huaweicloud_npm_registry = `  ${registry}  `;
          const variantRegistry = await attempt();
          assert.equal(variantRegistry.result.success, true, 'a case-variant registry spelling pre-flights the mirror');
          assert.equal(
            variantRegistry.env?.HUAWEICLOUD_NPM_REGISTRY,
            registry,
            'the child pin resolves the same variant spelling',
          );

          delete process.env.huaweicloud_npm_registry;
          process.env.HUAWEICLOUD_NPM_REGISTRY = registry;
          delete process.env.NPM_TOKEN;
          process.env['NPM_TOKEN '] = '  fixture-registry-token  ';
          const paddedKey = await attempt();
          assert.equal(paddedKey.result.success, true, 'a padded token key authenticates the pre-flight');
          assert.equal(seen.at(-1), 'Bearer fixture-registry-token');
          assert.equal(paddedKey.env?.NPM_TOKEN, 'fixture-registry-token', 'the child gets the canonical token key');
          assert.equal(paddedKey.env?.['NPM_TOKEN '], undefined, 'the padded key is not forwarded');
          delete process.env['NPM_TOKEN '];

          process.env.HUAWEICLOUD_NPM_REGISTRY = registry;
          process.env.NPM_TOKEN = 'exact-token';
          process.env.npm_token = 'variant-token';
          delete process.env['NPM_TOKEN '];
          const dupExact = await attempt();
          assert.equal(dupExact.result.success, true, 'duplicate token spellings do not split the halves');
          assert.equal(seen.at(-1), 'Bearer exact-token');
          assert.equal(dupExact.env?.NPM_TOKEN, 'exact-token', 'the child gets the same exact-case token');

          delete process.env.NPM_TOKEN;
          delete process.env.npm_token;
          process.env.npm_token = 'variant-token';
          process.env.Npm_Token = 'exact-token';
          const dupVariant = await attempt();
          assert.equal(dupVariant.result.success, true, 'variants collapse to one token on both halves');
          assert.equal(
            seen.at(-1),
            `Bearer ${dupVariant.env?.NPM_TOKEN}`,
            'the pre-flight and child use the same collapsed variant',
          );

          delete process.env.npm_token;
          delete process.env.Npm_Token;
          delete process.env.NPM_TOKEN;
          delete process.env.NODE_AUTH_TOKEN;

          process.env.npm_token = 'variant-token';
          process.env.NPM_TOKEN = 'exact-token';
          const dupCanonicalLater = await attempt();
          assert.equal(dupCanonicalLater.result.success, true, 'a later exact-case token still wins for both halves');
          assert.equal(seen.at(-1), 'Bearer exact-token');
          assert.equal(dupCanonicalLater.env?.NPM_TOKEN, 'exact-token');
          delete process.env.npm_token;
          delete process.env.NPM_TOKEN;

          const withoutToken = await attempt();
          assert.equal(withoutToken.result.success, false);
          assert.equal(withoutToken.spawned, false, 'an unauthenticated mirror degrades before the spawn');
          assert.match(withoutToken.result.error ?? '', /无法确认最新版本/);
          assert.equal(seen.at(-1), undefined);
        },
      );
    },
  );
});

test('upgradePackage 升级子进程: ~/.npmrc 的 _authToken 也认证预检查询', async () => {
  await withTokenRegistry(['fixture-npmrc-token', 'fixture-legacy-token'], {}, async ({ registry, port, seen }) => {
    const userconfig = join(fixtureDir('devkit-npmrc-'), '.npmrc');
    writeFileSync(userconfig, `registry=${registry}/\n//127.0.0.1:${port}/:_authToken=fixture-npmrc-token\n`);
    await withSavedEnv(
      ['NPM_TOKEN', 'NODE_AUTH_TOKEN', 'HUAWEICLOUD_NPM_REGISTRY', 'NPM_CONFIG_USERCONFIG', 'npm_config_userconfig'],
      async () => {
        delete process.env.NPM_TOKEN;
        delete process.env.NODE_AUTH_TOKEN;
        delete process.env.npm_config_userconfig;
        process.env.HUAWEICLOUD_NPM_REGISTRY = registry;
        process.env.NPM_CONFIG_USERCONFIG = userconfig;
        let spawned = false;
        const spawnFn: UpgradeSpawnFn = () => {
          spawned = true;
          return { status: 0 };
        };
        const result = await upgradePackage({ target: 'opencode' }, { spawnFn });
        assert.equal(
          result.success,
          true,
          `the npmrc token authenticates the pre-flight seen=${JSON.stringify(seen)} cfg=${process.env.NPM_CONFIG_USERCONFIG} lcfg=${process.env.npm_config_userconfig} home=${process.env.HOME}`,
        );
        assert.equal(spawned, true, 'the act proceeds to the spawn');
        assert.equal(seen.at(-1), 'Bearer fixture-npmrc-token');

        delete process.env.NPM_CONFIG_USERCONFIG;
        process.env.npm_config_userconfig = userconfig;
        const lowercaseUserconfig = await upgradePackage({ target: 'opencode' }, { spawnFn });
        assert.equal(
          lowercaseUserconfig.success,
          true,
          'the lowercase userconfig spelling is resolved like npm resolves it',
        );

        writeFileSync(userconfig, `registry=${registry}/\n_authToken=fixture-legacy-token\n`);
        const bareToken = await upgradePackage({ target: 'opencode' }, { spawnFn: () => ({ status: 0 }) });
        assert.equal(bareToken.success, false, 'a bare _authToken is not forwarded (npm rejects it)');
        assert.equal(seen.at(-1), undefined, 'no bearer is sent for the bare legacy token');
        assert.match(bareToken.error ?? '', /无法确认最新版本/);

        writeFileSync(userconfig, `registry=${registry}/\n`);
        const untokened = await upgradePackage({ target: 'opencode' }, { spawnFn: () => ({ status: 0 }) });
        assert.equal(untokened.success, false, 'the untokened npmrc control degrades honestly');
        assert.match(untokened.error ?? '', /无法确认最新版本/);
      },
    );
  });
});

test('upgradePackage 升级子进程: npmrc 的插值/引号/斜杠省略/命名通道按 npm 语义解析', async () => {
  await withTokenRegistry('fixture-registry-token', {}, async ({ registry, port, seen }) => {
    const dir = fixtureDir('devkit-npmrc-forms-');
    const userconfig = join(dir, '.npmrc');
    await withSavedEnv(
      [
        'NPM_TOKEN',
        'NODE_AUTH_TOKEN',
        'HUAWEICLOUD_NPM_REGISTRY',
        'NPM_CONFIG_USERCONFIG',
        'npm_config_userconfig',
        ' NPM_CONFIG_USERCONFIG',
        'NEXUS_TOKEN',
      ],
      async () => {
        delete process.env.NPM_TOKEN;
        delete process.env.NODE_AUTH_TOKEN;
        delete process.env[' NPM_CONFIG_USERCONFIG'];
        delete process.env.npm_config_userconfig;
        process.env.HUAWEICLOUD_NPM_REGISTRY = registry;
        process.env.NPM_CONFIG_USERCONFIG = userconfig;
        process.env.NEXUS_TOKEN = 'fixture-registry-token';
        const attempt = async () => {
          let env: NodeJS.ProcessEnv | undefined;
          const spawnFn: UpgradeSpawnFn = (_cmd, _args, opts) => {
            env = opts.env as NodeJS.ProcessEnv;
            return { status: 0 };
          };
          const result = await upgradePackage({ target: 'opencode' }, { spawnFn, currentVersion: '0.0.1' });
          return { result, env };
        };
        const forms = {
          interpolated: `//127.0.0.1:${port}/:_authToken=\${NEXUS_TOKEN}`,
          quoted: `//127.0.0.1:${port}/:_authToken="fixture-registry-token"`,
        };
        for (const [label, line] of Object.entries(forms)) {
          writeFileSync(userconfig, `registry=${registry}/\n${line}\n`);
          const run = await attempt();
          assert.equal(run.result.success, true, `${label} form authenticates the pre-flight`);
          assert.equal(seen.at(-1), 'Bearer fixture-registry-token', `${label} bearer`);
        }
        // npm 11 does not accept the slash-less nerf key; neither do we.
        writeFileSync(userconfig, `registry=${registry}/\n//127.0.0.1:${port}:_authToken=fixture-registry-token\n`);
        const slashless = await attempt();
        assert.equal(slashless.result.success, false, 'the slash-less nerf key is not npm auth');

        process.env.NPM_TOKEN = 'stale-npmjs-token';
        process.env.NODE_AUTH_TOKEN = 'fixture-registry-token';
        writeFileSync(userconfig, `registry=${registry}/\n//127.0.0.1:${port}/:_authToken=\${NODE_AUTH_TOKEN}\n`);
        const priority = await attempt();
        assert.equal(priority.result.success, true, 'the userconfig-named channel wins over a stale NPM_TOKEN');
        assert.equal(seen.at(-1), 'Bearer fixture-registry-token');
        assert.equal(priority.env?.NPM_TOKEN, 'stale-npmjs-token');
        assert.equal(priority.env?.NODE_AUTH_TOKEN, 'fixture-registry-token');
        delete process.env.NPM_TOKEN;
        delete process.env.NODE_AUTH_TOKEN;

        delete process.env.NPM_CONFIG_USERCONFIG;
        process.env[' NPM_CONFIG_USERCONFIG'] = userconfig;
        writeFileSync(userconfig, `registry=${registry}/\n//127.0.0.1:${port}/:_authToken=fixture-registry-token\n`);
        const paddedKey = await attempt();
        assert.equal(paddedKey.result.success, false, 'a padded userconfig key is invisible to both halves');
        delete process.env[' NPM_CONFIG_USERCONFIG'];

        process.env.npm_config_userconfig = '   ';
        const whitespace = await attempt();
        assert.equal(
          whitespace.result.success,
          false,
          'a whitespace-only userconfig is a literal path for both halves',
        );
      },
    );
  });
});

test('upgradePackage 升级子进程: npmrc 级联与 npm 的表单语义', async () => {
  const { createServer } = await import('node:http');
  const accepted = new Set([
    'Bearer fixture-registry-token',
    `Basic ${Buffer.from('ci-user:fixture-registry-token').toString('base64')}`,
  ]);
  const seen: Array<string | undefined> = [];
  const server = createServer((req, res) => {
    seen.push(req.headers.authorization);
    if (!accepted.has(req.headers.authorization ?? '')) {
      res.statusCode = 401;
      res.end('unauthorized');
      return;
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ latest: '9.9.9', next: null }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const registry = `http://127.0.0.1:${address.port}`;
  const host = `//127.0.0.1:${address.port}`;
  const base = fixtureDir('devkit-npmrc-cascade-');
  const project = join(base, 'project');
  const home = join(base, 'home');
  const prefix = join(base, 'prefix');
  mkdirSync(project, { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(join(prefix, 'etc'), { recursive: true });
  writeFileSync(join(project, 'package.json'), '{}');
  const projectNpmrc = join(project, '.npmrc');
  const homeNpmrc = join(home, '.npmrc');
  const userconfig = join(base, 'userconfig.npmrc');
  const line = (value: string) => `registry=${registry}/\n${host}/:_authToken=${value}\n`;
  const savedCwd = process.cwd();
  try {
    await withSavedEnv(
      [
        'NPM_TOKEN',
        'NODE_AUTH_TOKEN',
        'HUAWEICLOUD_NPM_REGISTRY',
        'NPM_CONFIG_USERCONFIG',
        'npm_config_userconfig',
        'npm_config_prefix',
        'npm_config_globalconfig',
        'HOME',
        'CI_TOKEN',
        'NEXUS_TOKEN',
        'nexus_token',
        `npm_config_${host}/:_authToken`,
      ],
      async () => {
        delete process.env.NPM_TOKEN;
        delete process.env.NODE_AUTH_TOKEN;
        delete process.env.NPM_CONFIG_USERCONFIG;
        delete process.env.npm_config_userconfig;
        delete process.env.npm_config_prefix;
        delete process.env.npm_config_globalconfig;
        delete process.env.NEXUS_TOKEN;
        delete process.env.nexus_token;
        process.env.HUAWEICLOUD_NPM_REGISTRY = registry;
        process.env.HOME = home;
        process.env.CI_TOKEN = 'fixture-registry-token';
        const attempt = async () => {
          const spawnFn: UpgradeSpawnFn = () => ({ status: 0 });
          const result = await upgradePackage({ target: 'opencode' }, { spawnFn, currentVersion: '0.0.1' });
          return { result };
        };

        process.chdir(project);
        writeFileSync(projectNpmrc, line('${CI_TOKEN}'));
        assert.equal((await attempt()).result.success, true, 'the project .npmrc authenticates');
        assert.equal(seen.at(-1), 'Bearer fixture-registry-token');
        rmSync(projectNpmrc);

        writeFileSync(join(prefix, 'etc', 'npmrc'), line('${CI_TOKEN}'));
        process.env.npm_config_prefix = prefix;
        assert.equal((await attempt()).result.success, true, 'the global config authenticates');
        delete process.env.npm_config_prefix;
        rmSync(join(prefix, 'etc', 'npmrc'));

        writeFileSync(homeNpmrc, line('${CI_TOKEN}'));
        process.env.npm_config_userconfig = '';
        assert.equal((await attempt()).result.success, true, 'an empty userconfig falls back to ~/.npmrc');
        process.env.npm_config_userconfig = '   ';
        assert.equal(
          (await attempt()).result.success,
          false,
          'a whitespace-only userconfig is a literal empty path, not the fallback',
        );

        process.env.npm_config_userconfig = '~/.npmrc';
        assert.equal((await attempt()).result.success, true, 'a tilde userconfig expands');

        writeFileSync(userconfig, line('${NEXUS_TOKEN?}'));
        process.env.npm_config_userconfig = userconfig;
        process.env.NEXUS_TOKEN = 'fixture-registry-token';
        assert.equal((await attempt()).result.success, true, 'the optional modifier resolves when set');
        process.env.NEXUS_TOKEN = '';
        assert.equal((await attempt()).result.success, false, 'the optional modifier resolves empty when empty');
        delete process.env.NEXUS_TOKEN;

        writeFileSync(
          userconfig,
          `registry=${registry}/\n${host}/:_auth=${Buffer.from('ci-user:fixture-registry-token').toString('base64')}\n`,
        );
        assert.equal((await attempt()).result.success, true, 'the _auth basic form authenticates');
        assert.match(seen.at(-1) ?? '', /^Basic /);

        writeFileSync(
          userconfig,
          `registry=${registry}/\n${host}/:username=ci-user\n${host}/:_password=${Buffer.from('fixture-registry-token').toString('base64')}\n`,
        );
        assert.equal((await attempt()).result.success, true, 'username + _password authenticates');

        const pathRegistry = `${registry}/a/b`;
        process.env.HUAWEICLOUD_NPM_REGISTRY = pathRegistry;
        writeFileSync(userconfig, `registry=${pathRegistry}/\n${host}/a/:_authToken=fixture-registry-token\n`);
        assert.equal((await attempt()).result.success, true, 'a parent-path nerf key authenticates');
        process.env.HUAWEICLOUD_NPM_REGISTRY = registry;

        process.env[`npm_config_${host}/:_authToken`] = 'fixture-registry-token';
        assert.equal((await attempt()).result.success, true, 'an env-spread nerf key authenticates');
        delete process.env[`npm_config_${host}/:_authToken`];

        writeFileSync(userconfig, 'registry=' + registry + '/\n' + host + '/:_authToken=\\${CI_TOKEN}\n');
        assert.equal(
          (await attempt()).result.success,
          false,
          'an escaped dollar stays the literal and never authenticates',
        );

        writeFileSync(userconfig, line('${NEXUS_TOKEN}'));
        process.env.nexus_token = 'fixture-registry-token';
        assert.equal((await attempt()).result.success, false, 'envReplace is exact-name only');
        delete process.env.nexus_token;

        writeFileSync(userconfig, `registry=${registry}/\n${host}/:_authToken=fixture-registry-token ; ci token\n`);
        assert.equal((await attempt()).result.success, true, 'a semicolon comment is stripped from the token');

        // npm takes the last matching userconfig spelling.
        const otherConfig = join(base, 'other-userconfig.npmrc');
        writeFileSync(otherConfig, `registry=${registry}/\n`);
        delete process.env.NPM_CONFIG_USERCONFIG;
        delete process.env.npm_config_userconfig;
        process.env.npm_config_userconfig = otherConfig;
        process.env.NPM_CONFIG_USERCONFIG = userconfig;
        assert.equal((await attempt()).result.success, true, 'the last userconfig spelling wins');
        delete process.env.NPM_CONFIG_USERCONFIG;
        delete process.env.npm_config_userconfig;
        process.env.NPM_CONFIG_USERCONFIG = userconfig;
        process.env.npm_config_userconfig = otherConfig;
        assert.equal((await attempt()).result.success, false, 'the reverse order loses the token');
      },
    );
  } finally {
    process.chdir(savedCwd);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('upgradePackage 升级子进程: 302 重定向的目标腿保留认证', async () => {
  const { createServer } = await import('node:http');
  const seen: Array<string | undefined> = [];
  const target = createServer((req, res) => {
    seen.push(req.headers.authorization);
    if (req.headers.authorization !== 'Bearer fixture-registry-token') {
      res.statusCode = 401;
      res.end('unauthorized');
      return;
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ latest: '9.9.9', next: null }));
  });
  await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve));
  const targetAddress = target.address();
  assert.ok(targetAddress && typeof targetAddress === 'object');
  const redirector = createServer((req, res) => {
    res.statusCode = 302;
    res.setHeader('location', `http://127.0.0.1:${targetAddress.port}${req.url ?? ''}`);
    res.end();
  });
  await new Promise<void>((resolve) => redirector.listen(0, '127.0.0.1', resolve));
  const address = redirector.address();
  assert.ok(address && typeof address === 'object');
  const registry = `http://127.0.0.1:${address.port}`;
  const userconfig = join(fixtureDir('devkit-npmrc-redirect-'), '.npmrc');
  writeFileSync(userconfig, `registry=${registry}/\n//127.0.0.1:${address.port}/:_authToken=fixture-registry-token\n`);
  try {
    await withSavedEnv(
      ['NPM_TOKEN', 'NODE_AUTH_TOKEN', 'HUAWEICLOUD_NPM_REGISTRY', 'NPM_CONFIG_USERCONFIG', 'npm_config_userconfig'],
      async () => {
        delete process.env.NPM_TOKEN;
        delete process.env.NODE_AUTH_TOKEN;
        delete process.env.npm_config_userconfig;
        process.env.HUAWEICLOUD_NPM_REGISTRY = registry;
        process.env.NPM_CONFIG_USERCONFIG = userconfig;
        const spawnFn: UpgradeSpawnFn = () => ({ status: 0 });
        const result = await upgradePackage({ target: 'opencode' }, { spawnFn, currentVersion: '0.0.1' });
        assert.equal(result.success, true, 'the redirected target leg is authenticated');
        assert.equal(seen.at(-1), 'Bearer fixture-registry-token');
      },
    );
  } finally {
    redirector.closeAllConnections();
    target.closeAllConnections();
    await new Promise<void>((resolve) => redirector.close(() => resolve()));
    await new Promise<void>((resolve) => target.close(() => resolve()));
  }
});

test('upgradePackage 升级子进程: 变体镜像键让预检查询报告子进程实际安装的版本', async () => {
  await withTokenRegistry('', { latest: '1.0.0' }, async ({ registry, requested }) => {
    await withSavedEnv(['HUAWEICLOUD_NPM_REGISTRY', 'huaweicloud_npm_registry'], async () => {
      delete process.env.HUAWEICLOUD_NPM_REGISTRY;
      process.env.huaweicloud_npm_registry = registry;
      let spawned = false;
      const spawnFn: UpgradeSpawnFn = () => {
        spawned = true;
        return { status: 0 };
      };
      const result = await upgradePackage({ target: 'opencode' }, { spawnFn, currentVersion: '0.0.1' });
      assert.equal(result.success, true);
      assert.equal(spawned, true);
      assert.equal(
        result.installedVersion,
        '1.0.0',
        'the reported version is the mirror the child installs from, not the public registry',
      );
      assert.equal(
        requested.some((url) => url.includes('/-/package/huaweicloud-devkit/dist-tags')),
        true,
      );
    });
  });
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
    assert.deepEqual(spawned!.args, [
      '--yes',
      '--foreground-scripts',
      'huaweicloud-devkit@latest',
      'update',
      '--target',
      'opencode',
    ]);
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
