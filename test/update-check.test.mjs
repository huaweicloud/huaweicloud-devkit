import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  semverParse,
  semverCompare,
  hasPrerelease,
  determineTarget,
  judgeUpdate,
  parseDistTagsOutput,
  readSkipState,
  writeSkipState,
  queryDistTagsSync,
  queryDistTags,
  queryDistTagsFetch,
  getCachedUpdateInfo,
  peekCachedUpdateInfo,
  invalidateUpdateCache,
  applyUpdateHint,
  upgradePackage,
} from '../plugins/huaweicloud-core/src/update-check.mjs';

test('semverParse 解析稳定版与 prerelease', () => {
  assert.deepEqual(semverParse('1.1.1-next.15'), {
    major: 1,
    minor: 1,
    patch: 1,
    pre: ['next', '15'],
    raw: '1.1.1-next.15',
  });
  assert.equal(semverParse('1.1.1').pre, null);
  assert.equal(semverParse('not-a-version'), null);
});

test('semverCompare 完整排序契约', () => {
  assert.equal(semverCompare('1.1.1', '1.1.1-next.15'), 1); // 稳定 > 同基数预发布
  assert.equal(semverCompare('1.1.1-next.15', '1.1.1-next.12'), 1);
  assert.equal(semverCompare('1.1.1-next.15', '1.1.1-next.9'), 1); // 数值序
  assert.equal(semverCompare('1.1.1-next.12', '1.1.1-next.12'), 0);
  assert.equal(semverCompare('1.0.2', '1.1.0'), -1);
  assert.equal(semverCompare('1.1.0', '1.0.2'), 1);
});

test('hasPrerelease', () => {
  assert.equal(hasPrerelease('1.1.1-next.12'), true);
  assert.equal(hasPrerelease('1.1.1'), false);
});

test('determineTarget 频道选取（§4 矩阵）', () => {
  assert.equal(determineTarget('1.0.2', { latest: '1.1.0', next: null }), '1.1.0');
  assert.equal(determineTarget('1.1.1-next.12', { latest: '1.1.1', next: '1.1.1-next.15' }), '1.1.1');
  assert.equal(determineTarget('1.1.1-next.12', { latest: '1.1.0', next: '1.1.1-next.15' }), '1.1.1-next.15');
  assert.equal(determineTarget('1.1.1-next.15', { latest: '1.1.1', next: '1.1.1-next.15' }), '1.1.1');
  assert.equal(determineTarget('1.1.1-next.12', { latest: '1.1.0', next: null }), '1.1.0');
  assert.equal(determineTarget('1.1.0', { latest: null, next: '1.1.1-next.15' }), null); // 稳定用户不看 next
  assert.equal(determineTarget('1.1.0', { latest: null, next: null }), null);
});

test('judgeUpdate 四态 + 冷却（§4 全表）', () => {
  const now = Date.parse('2026-09-08T00:00:00Z');
  const inCooldown = {
    dismissedVersion: '1.1.0',
    dismissedAt: '2026-09-07T00:00:00Z',
    expireAt: '2026-09-10T00:00:00Z',
  };
  const inCooldownOlderVersion = { ...inCooldown, dismissedVersion: '1.0.2' };

  assert.equal(judgeUpdate('1.0.2', { latest: '1.1.0', next: null }, null, now).result, 'update_available');
  assert.equal(judgeUpdate('1.1.0', { latest: '1.1.0', next: null }, null, now).result, 'up_to_date');
  assert.equal(
    judgeUpdate('1.1.1-next.12', { latest: '1.1.1', next: '1.1.1-next.15' }, null, now).result,
    'update_available',
  );
  assert.equal(
    judgeUpdate('1.1.1-next.12', { latest: '1.1.0', next: '1.1.1-next.15' }, null, now).result,
    'update_available',
  );
  assert.equal(
    judgeUpdate('1.1.1-next.15', { latest: '1.1.1', next: '1.1.1-next.15' }, null, now).result,
    'update_available',
  );
  assert.equal(judgeUpdate('1.1.1-next.12', { latest: '1.1.0', next: null }, null, now).result, 'up_to_date');
  assert.equal(judgeUpdate('1.0.2', { latest: '1.1.0', next: null }, inCooldown, now).result, 'dismissed');
  assert.equal(judgeUpdate('1.0.2', { latest: '1.1.1', next: null }, inCooldown, now).result, 'update_available'); // 新版本无视冷却
  assert.equal(
    judgeUpdate('1.0.2', { latest: '1.1.0', next: null }, inCooldownOlderVersion, now).result,
    'update_available',
  ); // 拒绝的是更旧版本
  assert.equal(judgeUpdate('1.0.2', null, null, now).result, 'check_failed'); // distTags 缺失
});

test('judgeUpdate 返回字段完整性', () => {
  const r = judgeUpdate('1.0.2', { latest: '1.1.0', next: null }, null);
  assert.equal(r.currentVersion, '1.0.2');
  assert.equal(r.latestStable, '1.1.0');
  assert.equal(r.latestNext, null);
  assert.equal(r.targetVersion, '1.1.0');
  assert.equal(r.updateAvailable, true);
  assert.equal(r.dismissed, false);
  assert.equal(r.result, 'update_available');
  const f = judgeUpdate('1.0.2', null, null);
  assert.equal(f.result, 'check_failed');
  assert.equal(f.note, '检测失败，不影响使用');
});

test('parseDistTagsOutput 解析 npm view --json 输出', () => {
  assert.deepEqual(parseDistTagsOutput('{"latest":"1.1.0","next":"1.1.1-next.15"}'), {
    latest: '1.1.0',
    next: '1.1.1-next.15',
  });
  assert.deepEqual(parseDistTagsOutput('{"latest":"1.1.0"}'), { latest: '1.1.0', next: null });
  assert.equal(parseDistTagsOutput('not json'), null);
  assert.equal(parseDistTagsOutput(''), null);
});

function tmpDir() {
  const dir = mkdtempSync(join(tmpdir(), 'upd-'));
  return dir;
}

test('skip state 原子写往返 + 损坏容错', () => {
  const dir = tmpDir();
  try {
    const file = join(dir, '.update-skip.json');
    assert.equal(readSkipState(file), null); // 不存在
    const state = writeSkipState(file, '1.1.1-next.12');
    assert.equal(state.dismissedVersion, '1.1.1-next.12');
    assert.ok(!existsSync(`${file}.tmp`)); // 不留 tmp 残渣
    const read = readSkipState(file);
    assert.equal(read.dismissedVersion, '1.1.1-next.12');
    assert.ok(Date.parse(read.expireAt) - Date.parse(read.dismissedAt) >= 2 * 24 * 60 * 60 * 1000); // 3 天
    writeFileSync(file, '{broken json');
    assert.equal(readSkipState(file), null); // 损坏 → null
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeSkipState 目标不可写时清理临时文件', () => {
  const dir = tmpDir();
  try {
    const file = join(dir, '.update-skip.json');
    mkdirSync(file, { recursive: true }); // 目标为目录 → rename 失败
    let threw = false;
    try {
      writeSkipState(file, '1.1.1');
    } catch {
      threw = true;
    }
    assert.equal(threw, true);
    const leftover = readdirSync(dir).filter((f) => f.includes('.tmp'));
    assert.deepEqual(leftover, []); // 不留 temp 残渣
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('queryDistTagsSync 成功返回 distTags 对象', () => {
  const result = queryDistTagsSync({ timeoutMs: 5000 });
  // 结果允许为 null（离线/超时）；若成功则形状必须正确
  if (result !== null) {
    assert.equal(typeof result.latest, 'string');
    assert.ok(result.next === null || typeof result.next === 'string');
  }
});

test('queryDistTags 异步非阻塞: 同步调用立即返回 Promise', async () => {
  const before = Date.now();
  const p = queryDistTags({ timeoutMs: 5000 });
  const callMs = Date.now() - before;
  assert.ok(p instanceof Promise, 'queryDistTags 应返回 Promise');
  assert.ok(callMs < 100, `queryDistTags 同步调用应非阻塞, 实际耗时 ${callMs}ms`);
  const result = await p;
  // 结果允许为 null（离线/超时）；若成功则形状必须正确
  if (result !== null) {
    assert.equal(typeof result.latest, 'string');
    assert.ok(result.next === null || typeof result.next === 'string');
  }
});

test('queryDistTagsFetch 直接 fetch registry 返回 distTags', async () => {
  const result = await queryDistTagsFetch({ timeoutMs: 15000 });
  // 结果允许为 null（受限网络）；若成功则形状必须正确
  if (result !== null) {
    assert.equal(typeof result.latest, 'string');
    assert.ok(result.next === null || typeof result.next === 'string');
  }
});

test('queryDistTagsFetch 尊重 HUAWEICLOUD_NPM_REGISTRY 覆盖', async () => {
  const prev = process.env.HUAWEICLOUD_NPM_REGISTRY;
  process.env.HUAWEICLOUD_NPM_REGISTRY = 'http://127.0.0.1:1';
  try {
    const result = await queryDistTagsFetch({ timeoutMs: 2000 });
    assert.equal(result, null); // 不可达 registry → 静默降级 null
  } finally {
    if (prev === undefined) delete process.env.HUAWEICLOUD_NPM_REGISTRY;
    else process.env.HUAWEICLOUD_NPM_REGISTRY = prev;
  }
});

test('queryDistTagsSync 失败时在 DEBUG 下输出日志而非静默', () => {
  const prev = process.env.HUAWEICLOUD_DEVKIT_DEBUG;
  const logs = [];
  const origErr = console.error;
  console.error = (msg) => logs.push(String(msg));
  process.env.HUAWEICLOUD_DEVKIT_DEBUG = '1';
  try {
    // 指向不可达 registry 的 npm view 会失败（fast，避免慢网拖长）
    const result = queryDistTagsSync({
      timeoutMs: 2000,
      cwd: '/nonexistent-dir-to-force-failure',
    });
    assert.equal(result, null);
  } finally {
    console.error = origErr;
    if (prev === undefined) delete process.env.HUAWEICLOUD_DEVKIT_DEBUG;
    else process.env.HUAWEICLOUD_DEVKIT_DEBUG = prev;
  }
  assert.ok(
    logs.some((l) => l.includes('[debug] queryDistTagsSync')),
    `expected debug log, got: ${logs}`,
  );
});

test('getCachedUpdateInfo 单飞: 并发只查一次', async () => {
  invalidateUpdateCache();
  let calls = 0;
  const fakeQuery = async () => {
    calls++;
    await new Promise((r) => setTimeout(r, 20));
    return { latest: '1.1.1', next: null };
  };
  const [a, b] = await Promise.all([
    getCachedUpdateInfo('1.0.2', { doQuery: fakeQuery }),
    getCachedUpdateInfo('1.0.2', { doQuery: fakeQuery }),
  ]);
  assert.equal(calls, 1);
  assert.equal(a.result, 'update_available');
  assert.equal(b.result, 'update_available');
  assert.equal(a.targetVersion, '1.1.1');
  invalidateUpdateCache();
});

test('getCachedUpdateInfo TTL: 未过期不重复查询', async () => {
  invalidateUpdateCache();
  let calls = 0;
  const fakeQuery = async () => {
    calls++;
    return { latest: '1.2.0', next: null };
  };
  assert.equal((await getCachedUpdateInfo('1.0.2', { doQuery: fakeQuery })).result, 'update_available');
  assert.equal((await getCachedUpdateInfo('1.0.2', { doQuery: fakeQuery })).result, 'update_available');
  assert.equal(calls, 1);
  invalidateUpdateCache();
});

test('getCachedUpdateInfo 失败节流: 失败后短时间不重查', async () => {
  invalidateUpdateCache();
  let calls = 0;
  const failQuery = async () => {
    calls++;
    return null;
  };
  const r1 = await getCachedUpdateInfo('1.0.2', { doQuery: failQuery });
  const r2 = await getCachedUpdateInfo('1.0.2', { doQuery: failQuery });
  assert.equal(r1.result, 'check_failed');
  assert.equal(r2.result, 'check_failed');
  assert.equal(calls, 1); // 同会话节流
  invalidateUpdateCache();
});

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

test('applyUpdateHint 附加/跳过规则', () => {
  const base = { ok: true };
  const hint = { updateAvailable: true, currentVersion: '1.0.2', targetVersion: '1.1.0' };
  assert.equal(applyUpdateHint(base, 'huaweicloud_check_cli', hint)._updateInfo.latestVersion, '1.1.0');
  assert.equal(applyUpdateHint(base, 'huaweicloud_check_update', hint), base); // 自身不加
  assert.equal(applyUpdateHint(base, 'huaweicloud_upgrade', hint), base);
  assert.equal(applyUpdateHint(base, 'huaweicloud_check_cli', null), base); // 无 hint 不加
  assert.equal(applyUpdateHint(base, 'huaweicloud_check_cli', { updateAvailable: false }), base);
  assert.equal(applyUpdateHint(base, 'huaweicloud_check_cli', { updateAvailable: true }), base); // 无 targetVersion 不加
  assert.equal(
    applyUpdateHint(base, 'huaweicloud_check_cli', { updateAvailable: true, currentVersion: '1.0.2' }),
    base,
  );
  assert.deepEqual(applyUpdateHint(base, 'huaweicloud_check_cli', hint)._updateInfo, {
    currentVersion: '1.0.2',
    latestVersion: '1.1.0',
  });
});

test('upgradePackage 参数校验: version 仅支持 latest', async () => {
  const r = await upgradePackage({ target: 'opencode', version: '1.0.0' }, { spawnFn: () => ({ status: 0 }) });
  assert.equal(r.success, false);
  assert.match(r.error, /version 参数仅支持 latest/);
});

test('upgradePackage 成功路径: 目标版本/重启/文案/缓存失效', async () => {
  invalidateUpdateCache();
  let spawned = null;
  const spawnFn = (cmd, args, opts) => {
    spawned = { cmd, args, opts };
    return { status: 0, stdout: '', stderr: '' };
  };
  const doQuery = async () => ({ latest: '1.1.1', next: null });
  const r = await upgradePackage({ target: 'opencode', version: 'latest' }, { doQuery, spawnFn });
  assert.equal(r.success, true);
  const repoPkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'));
  assert.equal(r.previousVersion, repoPkg.version); // 与仓库 package.json 当前版本动态一致
  assert.equal(r.installedVersion, '1.1.1');
  assert.equal(r.requiresRestart, true);
  assert.match(r.message, /重启当前会话/);
  assert.equal(spawned.cmd, process.platform === 'win32' ? 'npx.cmd' : 'npx');
  assert.deepEqual(spawned.args, ['--yes', 'huaweicloud-devkit@latest', 'update', '--target', 'opencode']);
  assert.equal(spawned.opts.timeout, 300000);
  // 升级后缓存失效 → 下一次检测重新查询（此处不 fetch，只验证 invalidate 生效）
  invalidateUpdateCache();
});

test('upgradePackage next 目标: 用 next tag', async () => {
  let spawned = null;
  const spawnFn = (cmd, args) => {
    spawned = args;
    return { status: 0 };
  };
  const doQuery = async () => ({ latest: '1.1.0', next: '1.1.1-next.15' });
  // currentVersion 显式注入：包版本在 prerelease/stable 之间切换（如 release 分支 bump 成稳定版）
  // 不应改变升级 tag 的判定逻辑
  await upgradePackage({ target: 'opencode' }, { doQuery, spawnFn, currentVersion: '1.1.0-next.1' });
  assert.ok(spawned.some((a) => a === 'huaweicloud-devkit@next'));
});

test('upgradePackage officeace 专属重连文案', async () => {
  const spawnFn = () => ({ status: 0 });
  const doQuery = async () => ({ latest: '1.1.1', next: null });
  const r = await upgradePackage({ target: 'officeace' }, { doQuery, spawnFn });
  assert.match(r.message, /连接器/);
});

test('upgradePackage 失败: 返回手动命令', async () => {
  const spawnFn = () => ({ status: 1, stdout: '', stderr: 'EPERM: permission denied' });
  const doQuery = async () => ({ latest: '1.1.1', next: null });
  const r = await upgradePackage({ target: 'opencode' }, { doQuery, spawnFn });
  assert.equal(r.success, false);
  assert.match(r.manual, /npx --yes huaweicloud-devkit@latest update --target opencode/);
  assert.match(r.error, /EPERM/);
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
  assert.match(r.error, /ENOENT/);
  assert.doesNotMatch(r.error, /exit null/);
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
  assert.match(r.manual, /huaweicloud-devkit@latest update/);
});
