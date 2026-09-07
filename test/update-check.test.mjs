import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
  getCachedUpdateInfo,
  peekCachedUpdateInfo,
  invalidateUpdateCache,
  applyUpdateHint,
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

test('queryDistTagsSync 成功返回 distTags 对象', () => {
  const result = queryDistTagsSync({ timeoutMs: 5000 });
  // 结果允许为 null（离线/超时）；若成功则形状必须正确
  if (result !== null) {
    assert.equal(typeof result.latest, 'string');
    assert.ok(result.next === null || typeof result.next === 'string');
  }
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
  assert.deepEqual(applyUpdateHint(base, 'huaweicloud_check_cli', hint)._updateInfo, {
    currentVersion: '1.0.2',
    latestVersion: '1.1.0',
  });
});
