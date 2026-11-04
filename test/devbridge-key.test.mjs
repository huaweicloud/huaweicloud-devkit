import { test, mock } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// devbridge-key 模块单测：key name 映射 / 缓存读写 / 孤儿清理 / 自动创建
// relay API 走 module mock（hdkitservice-api 三函数）

const realHome = process.env.HOME;
const realProfile = process.env.USERPROFILE;
const tmpHome = mkdtempSync(join(tmpdir(), 'devbridge-key-test-'));
// Windows: os.homedir() 用 USERPROFILE；Linux/macOS 用 HOME——两者都设
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;

// Mock hdkitservice-api 的三个 relay 函数 + hwlink-api 的 getCredentials
let mockKeys = [];
let mockCreateResult = null;
let mockCreateError = null;
let mockDeleteCalls = [];

mock.module('../plugins/huaweicloud-core/src/sandbox/hwlink-api.mjs', {
  namedExports: {
    getCredentials: () => ({ ak: 'TESTAK', sk: 'TESTSK', securitytoken: null }),
    createConnection: async () => ({}),
    BASE_URL: 'https://mock.test',
  },
});

mock.module('../plugins/huaweicloud-core/src/sandbox/hdkitservice-api.mjs', {
  namedExports: {
    hdkitCreateApiKey: async (name, scope) => {
      if (mockCreateError) throw mockCreateError;
      return mockCreateResult || { api_key: 'devbridge_MOCKKEY', name, scope, id: 'mock-id' };
    },
    hdkitListApiKeys: async () => mockKeys,
    hdkitDeleteApiKey: async (keyId) => {
      mockDeleteCalls.push(keyId);
      return { deleted: true };
    },
    hdkitConnect: async () => ({}),
    hdkitCredentials: async () => ({}),
    hdkitCheckUser: async () => ({}),
    hdkitSignAgreement: async () => ({}),
    hdkitVoucherStatus: async () => ({}),
    hdkitVoucherClaim: async () => ({}),
    hdkitCompetitionVoucherClaim: async () => ({}),
    hdkitGenerateUserHash: async () => ({}),
  },
});

const {
  keyNameForPool,
  clearCachedKey,
  ensureDevbridgeKey,
  recreateDevbridgeKey,
  listKeysForQuotaHint,
  buildKeyringInjectScript,
} = await import('../plugins/huaweicloud-core/src/sandbox/devbridge-key.mjs');

// ── key name 映射 ──

test('keyNameForPool maps pool types to fixed names', () => {
  assert.equal(keyNameForPool('ephemeral'), 'devkit-ephemeral');
  assert.equal(keyNameForPool('persistent'), 'devkit-persistent');
  assert.equal(keyNameForPool(null), 'devkit-ephemeral');
  assert.equal(keyNameForPool('unknown'), 'devkit-ephemeral');
});

// ── 缓存读写（文件级隔离，HOME 指向 tmp）──

test('getCachedKey reads what setCachedKey writes (via ensureDevbridgeKey)', async () => {
  mockCreateResult = { api_key: 'devbridge_TEST1', name: 'devkit-ephemeral', id: 'id1' };
  const result = await ensureDevbridgeKey('ephemeral');
  assert.equal(result.mode, 'CREATED');
  assert.equal(result.apiKey, 'devbridge_TEST1');
  // 缓存写入后，第二次调用走 CACHE_HIT
  const result2 = await ensureDevbridgeKey('ephemeral');
  assert.equal(result2.mode, 'CACHE_HIT');
  assert.equal(result2.apiKey, 'devbridge_TEST1');
});

test('clearCachedKey invalidates the cache', async () => {
  clearCachedKey('TESTAK', 'ephemeral');
  // After clear, next call re-creates
  mockCreateResult = { api_key: 'devbridge_TEST2', name: 'devkit-ephemeral', id: 'id2' };
  const result = await recreateDevbridgeKey('ephemeral');
  assert.equal(result.mode, 'CREATED');
  assert.equal(result.apiKey, 'devbridge_TEST2');
});

// ── 孤儿清理（#1090 边缘安全守卫）──

test('ensureDevbridgeKey deletes a same-name orphan only when it is stale (last_used_at older than 5 min)', async () => {
  clearCachedKey('test-ak', 'persistent');
  mockDeleteCalls = [];
  mockKeys = [
    { name: 'devkit-persistent', id: 'orphan-id', last_used_at: '2020-01-01T00:00:00Z' },
    { name: 'other-key', id: 'other-id', last_used_at: '2020-01-01T00:00:00Z' },
  ];
  mockCreateResult = { api_key: 'devbridge_NEW', name: 'devkit-persistent', id: 'new-id' };
  const result = await ensureDevbridgeKey('persistent');
  assert.equal(result.mode, 'CREATED');
  // Stale same-name orphan deleted, other key untouched
  assert.ok(mockDeleteCalls.includes('orphan-id'));
  assert.ok(!mockDeleteCalls.includes('other-id'));
});

test('#1090: live same-name orphan (recent last_used_at) is kept and NOT blindly recreated', async () => {
  clearCachedKey('TESTAK', 'ephemeral');
  mockDeleteCalls = [];
  mockKeys = [{ name: 'devkit-ephemeral', id: 'live-id', last_used_at: new Date(Date.now() - 60_000).toISOString() }];
  await assert.rejects(ensureDevbridgeKey('ephemeral'), (err) => {
    assert.equal(err.code, 'HDKIT_DEVBRIDGE_KEY_IN_USE');
    assert.match(err.message, /in use by another live sandbox/);
    assert.match(err.message, /devkit-ephemeral/);
    return true;
  });
  // LIVE key must NOT be deleted
  assert.equal(mockDeleteCalls.length, 0);
});

test('#1090: missing/unparseable last_used_at is treated as LIVE (conservative, fail-closed)', async () => {
  clearCachedKey('TESTAK', 'ephemeral');
  mockDeleteCalls = [];
  mockKeys = [{ name: 'devkit-ephemeral', id: 'fresh-id' }];
  await assert.rejects(ensureDevbridgeKey('ephemeral'), (err) => err.code === 'HDKIT_DEVBRIDGE_KEY_IN_USE');
  mockKeys = [{ name: 'devkit-ephemeral', id: 'nan-id', last_used_at: 'not-a-date' }];
  await assert.rejects(ensureDevbridgeKey('ephemeral'), (err) => err.code === 'HDKIT_DEVBRIDGE_KEY_IN_USE');
  assert.equal(mockDeleteCalls.length, 0);
});

test('ensureDevbridgeKey does not delete when no orphan exists', async () => {
  clearCachedKey('TESTAK', 'ephemeral');
  mockDeleteCalls = [];
  mockKeys = [{ name: 'other-key', id: 'other-id', last_used_at: '2020-01-01T00:00:00Z' }];
  mockCreateResult = { api_key: 'devbridge_NO_ORPHAN', name: 'devkit-ephemeral', id: 'no-orphan-id' };
  await ensureDevbridgeKey('ephemeral');
  assert.equal(mockDeleteCalls.length, 0);
});

test('ensureDevbridgeKey propagates upstream create errors (e.g. quota) with their code', async () => {
  clearCachedKey('TESTAK', 'ephemeral');
  mockKeys = [];
  mockCreateError = Object.assign(new Error('13002: quota exceeded'), { code: 'HDKIT_DEVBRIDGE_KEY_QUOTA_EXCEEDED' });
  await assert.rejects(ensureDevbridgeKey('ephemeral'), (err) => err.code === 'HDKIT_DEVBRIDGE_KEY_QUOTA_EXCEEDED');
  mockCreateError = null;
});

// ── 配额满降级数据 ──

test('listKeysForQuotaHint returns key list on success', async () => {
  mockKeys = [
    { name: 'key-a', id: 'a', last_used_at: '2026-11-01' },
    { name: 'key-b', id: 'b', last_used_at: '' },
  ];
  const keys = await listKeysForQuotaHint();
  assert.equal(keys.length, 2);
  assert.equal(keys[0].name, 'key-a');
  assert.equal(keys[0].lastUsed, '2026-11-01');
});

// ── keyring 注入命令构建 ──

test('buildKeyringInjectScript includes keyring set and file fallback', () => {
  const script = buildKeyringInjectScript('devbridge_INJECT_TEST');
  assert.ok(script.includes("hwcloud keyring set HW_DEVBRIDGE_API_KEY 'devbridge_INJECT_TEST'"));
  assert.ok(script.includes('echo "export HW_API_KEY=\'devbridge_INJECT_TEST\'" > /tmp/hw_api_key'));
  assert.ok(script.includes('chmod 600 /tmp/hw_api_key'));
  assert.ok(script.includes('DB_KEY_INJECTED'));
});

test('#1090: buildKeyringInjectScript rejects keys with quote/escape characters (single-quote splicing)', () => {
  assert.throws(() => buildKeyringInjectScript("devbridge_ev'il"), /invalid DevBridge API Key characters/);
  assert.throws(() => buildKeyringInjectScript('devbridge_ev"il'), /invalid DevBridge API Key characters/);
  assert.throws(() => buildKeyringInjectScript('devbridge_ev\\il'), /invalid DevBridge API Key characters/);
  assert.throws(() => buildKeyringInjectScript('devbridge_ev$il'), /invalid DevBridge API Key characters/);
  assert.throws(() => buildKeyringInjectScript(''), /invalid DevBridge API Key characters/);
});

// ── 清理 ──

test('cleanup tmp home', () => {
  rmSync(tmpHome, { recursive: true, force: true });
  if (realHome) process.env.HOME = realHome;
  if (realProfile) process.env.USERPROFILE = realProfile;
});
