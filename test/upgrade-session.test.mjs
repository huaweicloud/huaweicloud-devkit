import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  dispatch as dispatchOriginal,
  _decorateResult,
  _isHintConsumed,
  _resetHintConsumption,
} from '../plugins/huaweicloud-core/src/mcp-protocol.mjs';
import * as updateCheck from '../plugins/huaweicloud-core/src/update-check.mjs';

// ============================================================================
// 第一部分：mcp-protocol — hintConsumed 会话隔离
// ============================================================================

test('session-isolation: dispatch 接受 opts.sessionId 且不破坏无参调用', async () => {
  // initialize 无需 session，验证签名向后兼容
  const r = await dispatchOriginal('initialize', { protocolVersion: '2024-11-05', clientInfo: {} });
  assert.ok(r && r.serverInfo && typeof r.serverInfo.version === 'string');
});

test('hint-consumption: A 会话消费后 B 会话仍能拿到提示（隔离）', async () => {
  _resetHintConsumption();
  updateCheck.invalidateUpdateCache();
  // 注入真实 hint（版本 1.1.0 >= current 1.0.2 → update_available）
  await updateCheck.getCachedUpdateInfo('1.0.2', { doQuery: async () => ({ latest: '1.1.0', next: null }) });

  const base = { ok: 1 };
  const rA = _decorateResult('session-A', 'huaweicloud_check_cli', { ...base });
  assert.ok(rA._updateInfo, 'A 会话应附加 _updateInfo');
  assert.ok(_isHintConsumed('session-A'), 'A 已消费');

  const rB = _decorateResult('session-B', 'huaweicloud_check_cli', { ...base });
  assert.ok(rB._updateInfo, 'B 会话仍应附加 _updateInfo（隔离）');
  assert.ok(_isHintConsumed('session-B'), 'B 独立消费');

  // A 再次调用：不再提示（A 已消费）
  const rA2 = _decorateResult('session-A', 'huaweicloud_check_cli', { ...base });
  assert.ok(!rA2._updateInfo, 'A 二次调用不再附加');
  _resetHintConsumption();
  updateCheck.invalidateUpdateCache();
});

test('hint-consumption: stdio 固定 session 行为 = 每会话首次提示一次', async () => {
  _resetHintConsumption();
  updateCheck.invalidateUpdateCache();
  await updateCheck.getCachedUpdateInfo('1.0.2', { doQuery: async () => ({ latest: '1.1.0', next: null }) });
  const base = { ok: 1 };
  const r1 = _decorateResult('stdin', 'huaweicloud_check_cli', { ...base });
  assert.ok(r1._updateInfo, 'stdio 首次附加');
  const r2 = _decorateResult('stdin', 'huaweicloud_check_cli', { ...base });
  assert.ok(!r2._updateInfo, 'stdio 二次不附加');
  _resetHintConsumption();
  updateCheck.invalidateUpdateCache();
});

test('hint-consumption: 缺省 session 兜底为 default（行为同现版）', async () => {
  _resetHintConsumption();
  updateCheck.invalidateUpdateCache();
  await updateCheck.getCachedUpdateInfo('1.0.2', { doQuery: async () => ({ latest: '1.1.0', next: null }) });
  const base = { ok: 1 };
  const r1 = _decorateResult(undefined, 'huaweicloud_check_cli', { ...base });
  assert.ok(r1._updateInfo, '缺省登录为 default 并附加');
  const r2 = _decorateResult(undefined, 'huaweicloud_check_cli', { ...base });
  assert.ok(!r2._updateInfo, 'default 二次不附加');
  _resetHintConsumption();
  updateCheck.invalidateUpdateCache();
});

// ============================================================================
// 第二部分：update-check — skip 会话化
// ============================================================================

function tmpEnv() {
  const dir = mkdtempSync(join(tmpdir(), 'hwdk-uc-session-'));
  process.env.HUAWEICLOUD_HOME = dir;
  return dir;
}

test('skip-path: resolveSkipFilePath() 默认(无 session) 返回原路径', () => {
  const dir = tmpEnv();
  try {
    const base = join(dir, '.config', 'huaweicloud', 'devkit-skip.json');
    mkdirSync(join(dir, '.config', 'huaweicloud'), { recursive: true });
    const p = updateCheck.resolveSkipFilePath();
    assert.equal(p, base);
  } finally {
    delete process.env.HUAWEICLOUD_HOME;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('skip-path: resolveSkipFilePath("stdin") 与默认一致(向后兼容)', () => {
  const dir = tmpEnv();
  try {
    const pDefault = updateCheck.resolveSkipFilePath();
    const pStdin = updateCheck.resolveSkipFilePath('stdin');
    assert.equal(pStdin, pDefault);
  } finally {
    delete process.env.HUAWEICLOUD_HOME;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('skip-path: resolveSkipFilePath("default") 与默认一致', () => {
  const dir = tmpEnv();
  try {
    const pDefault = updateCheck.resolveSkipFilePath();
    const pDef = updateCheck.resolveSkipFilePath('default');
    assert.equal(pDef, pDefault);
  } finally {
    delete process.env.HUAWEICLOUD_HOME;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('skip-path: remote session 生成独立后缀文件', () => {
  const dir = tmpEnv();
  try {
    const pA = updateCheck.resolveSkipFilePath('session-A');
    const pB = updateCheck.resolveSkipFilePath('session-B');
    assert.ok(pA !== pB, 'session 不同须指向不同文件');
    assert.ok(pA.endsWith('.session-A'), `A 应为独立后缀, got ${pA}`);
    assert.ok(pB.endsWith('.session-B'), `B 应为独立后缀, got ${pB}`);
  } finally {
    delete process.env.HUAWEICLOUD_HOME;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('skip-path: 危险 session 值(路径穿越)被过滤为安全名', () => {
  const dir = tmpEnv();
  try {
    const p = updateCheck.resolveSkipFilePath('../evil/..id');
    const suffix = p.split('/').pop();
    assert.ok(!suffix.includes('..'), `suffix 不得含 .., got ${suffix}`);
    assert.ok(suffix.startsWith('devkit-skip.json.'), `应有会话后缀, got ${suffix}`);
    // 后缀部分仅允许 [0-9a-zA-Z_-]（过滤后不含 . / ..）
    const sessionPart = suffix.slice('devkit-skip.json.'.length);
    assert.ok(/^[0-9a-zA-Z_-]+$/.test(sessionPart), `session 仅含安全字符, got ${sessionPart}`);
  } finally {
    delete process.env.HUAWEICLOUD_HOME;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('skip-path: 会话隔离写读 —— A 写 skip 不影响 B', () => {
  const dir = tmpEnv();
  try {
    const fA = updateCheck.resolveSkipFilePath('session-A');
    const fB = updateCheck.resolveSkipFilePath('session-B');
    mkdirSync(join(dirname(fA)), { recursive: true });
    updateCheck.writeSkipState(fA, '1.1.0', { at: Date.now(), days: 3 });
    assert.ok(existsSync(fA), 'A 的 skip 文件存在');
    assert.ok(!existsSync(fB), 'B 的 skip 文件不应存在');
    assert.equal(updateCheck.readSkipState(fB), null, 'B 读取应为 null');
  } finally {
    delete process.env.HUAWEICLOUD_HOME;
    rmSync(dir, { recursive: true, force: true });
  }
});

function dirname(file) {
  return file.slice(0, file.lastIndexOf('/'));
}
