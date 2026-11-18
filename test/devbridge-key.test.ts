import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

import { fixtureDir } from './fixture-dir.ts';

// devbridge-key 模块单测：key name 映射 / 缓存读写 / 孤儿清理 / 自动创建
// relay API 走 module mock（hdkitservice-api 三函数 + hwlink-api getCredentials）。
// 缓存文件路径是模块常量（homedir() 派生），隔离靠 import 前重定向 HOME ——
// node --test 每文件独立进程，环境变量不跨文件泄漏。

const realHome = process.env.HOME;
const realProfile = process.env.USERPROFILE;
const tmpHome = fixtureDir('devbridge-key-home-');
// Windows: os.homedir() 用 USERPROFILE；Linux/macOS 用 HOME——两者都设
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;

// Mock hdkitservice-api 的三个 relay 函数 + hwlink-api 的 getCredentials
let mockKeys: Array<Record<string, unknown>> = [];
let mockCreateResult: Record<string, unknown> | null = null;
let mockCreateError: (Error & { code?: string }) | null = null;
let mockListError: (Error & { code?: string }) | null = null;
let mockCreateCalls = 0;
let mockDeleteCalls: string[] = [];

mock.module('../plugins/huaweicloud-core/src/lib/hdkit/hwlink-api.ts', {
  namedExports: {
    getCredentials: () => ({ ak: 'TESTAK', sk: 'TESTSK', securitytoken: '' }),
    createConnection: async () => ({}),
  },
});

mock.module('../plugins/huaweicloud-core/src/lib/hdkit/hdkitservice-api.ts', {
  namedExports: {
    hdkitCreateApiKey: async (name: string, scope: string) => {
      mockCreateCalls += 1;
      if (mockCreateError) throw mockCreateError;
      return mockCreateResult || { api_key: 'devbridge_MOCKKEY', name, scope, id: 'mock-id' };
    },
    hdkitListApiKeys: async () => {
      if (mockListError) throw mockListError;
      return mockKeys;
    },
    hdkitDeleteApiKey: async (keyId: string) => {
      mockDeleteCalls.push(keyId);
      return { deleted: true };
    },
  },
});

const {
  keyNameForPool,
  clearCachedKey,
  ensureDevbridgeKey,
  recreateDevbridgeKey,
  listKeysForQuotaHint,
  buildKeyringInjectScript,
} = await import('../plugins/huaweicloud-core/src/sandbox/devbridge-key.ts');

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
  // 缓存键是 getCredentials() 返回的 AK 指纹（mock 返回 TESTAK）——
  // 传错 AK 会变成空清除，用例就只能靠前序用例的清除级联通过
  clearCachedKey('TESTAK', 'ephemeral');
  // After clear, next call re-creates
  mockCreateResult = { api_key: 'devbridge_TEST2', name: 'devkit-ephemeral', id: 'id2' };
  const result = await recreateDevbridgeKey('ephemeral');
  assert.equal(result.mode, 'CREATED');
  assert.equal(result.apiKey, 'devbridge_TEST2');
});

// ── 孤儿清理 ──

test('ensureDevbridgeKey deletes same-name orphan before creating', async () => {
  clearCachedKey('TESTAK', 'persistent');
  mockDeleteCalls = [];
  mockKeys = [
    { name: 'devkit-persistent', id: 'orphan-id' },
    { name: 'other-key', id: 'other-id' },
  ];
  mockCreateResult = { api_key: 'devbridge_NEW', name: 'devkit-persistent', id: 'new-id' };
  const result = await ensureDevbridgeKey('persistent');
  assert.equal(result.mode, 'CREATED');
  // Same-name orphan deleted, other key untouched
  assert.ok(mockDeleteCalls.includes('orphan-id'));
  assert.ok(!mockDeleteCalls.includes('other-id'));
});

test('ensureDevbridgeKey does not delete when no orphan exists', async () => {
  clearCachedKey('TESTAK', 'ephemeral');
  mockDeleteCalls = [];
  mockKeys = [{ name: 'other-key', id: 'other-id' }];
  mockCreateResult = { api_key: 'devbridge_NO_ORPHAN', name: 'devkit-ephemeral', id: 'no-orphan-id' };
  await ensureDevbridgeKey('ephemeral');
  assert.equal(mockDeleteCalls.length, 0);
});

// ── 配额满降级数据 ──

test('listKeysForQuotaHint returns key list on success', async () => {
  mockKeys = [
    { name: 'key-a', id: 'a', last_used_at: '2026-11-01' },
    { name: 'key-b', id: 'b', last_used_at: '' },
  ];
  const keys = await listKeysForQuotaHint();
  assert.equal(keys.length, 2);
  assert.equal(keys[0]!.name, 'key-a');
  assert.equal(keys[0]!.lastUsed, '2026-11-01');
});

// ── 错误传播（配额降级的机制前提）：create 抛错不吞 ──

test('recreateDevbridgeKey propagates the relay create error (quota path depends on it)', async () => {
  mockDeleteCalls = [];
  mockKeys = [];
  mockCreateResult = null;
  mockCreateError = Object.assign(new Error('HDKIT_DEVBRIDGE_KEY_QUOTA_EXCEEDED: 20 key limit'), {
    code: 'HDKIT_DEVBRIDGE_KEY_QUOTA_EXCEEDED',
  });
  try {
    // recreate clears the real account's cache entry before re-ensuring, so
    // the create (and its error) is actually reached despite earlier hits.
    await assert.rejects(recreateDevbridgeKey('ephemeral'), /HDKIT_DEVBRIDGE_KEY_QUOTA_EXCEEDED/);
  } finally {
    mockCreateError = null;
  }
});

test('the orphan-list step re-throws the 409 version gate instead of swallowing it', async () => {
  clearCachedKey('TESTAK', 'ephemeral');
  mockListError = Object.assign(new Error('HDKIT_VERSION_TOO_OLD: 插件版本过旧，请升级至正式版 2.0.0 及以上。'), {
    code: 'HDKIT_VERSION_TOO_OLD',
    clientVersion: '2.0.0-next.0',
    minVersion: '2.0.0',
    remediation: { hint: '插件版本过旧（当前 2.0.0-next.0，需升级至正式版 2.0.0 及以上）：', steps: ['x'] },
  });
  mockCreateCalls = 0;
  try {
    // 409 门禁必须穿透孤儿清理的容错吞错（relay 侧按出口折叠的前提），
    // 否则 create 抛错被泛化降级掩盖成凭证误诊
    await assert.rejects(ensureDevbridgeKey('ephemeral'), (error: Error & { code?: string }) => {
      assert.equal(error.code, 'HDKIT_VERSION_TOO_OLD');
      assert.equal((error as { clientVersion?: string }).clientVersion, '2.0.0-next.0');
      assert.ok((error as { remediation?: unknown }).remediation, 'the gate payload must survive the re-throw');
      return true;
    });
    assert.equal(mockCreateCalls, 0, 'a gated client must not spend a create call');
  } finally {
    mockListError = null;
  }
});

test('a non-gate list failure still does not block creation', async () => {
  clearCachedKey('TESTAK', 'ephemeral');
  mockListError = new Error('network unreachable');
  mockCreateCalls = 0;
  mockCreateResult = { api_key: 'devbridge_AFTER_LIST_FAIL', name: 'devkit-ephemeral', id: 'after-list-id' };
  try {
    const result = await ensureDevbridgeKey('ephemeral');
    assert.equal(result.mode, 'CREATED');
    assert.equal(mockCreateCalls, 1);
  } finally {
    mockListError = null;
    mockCreateResult = null;
  }
});

test('listKeysForQuotaHint re-throws the 409 version gate instead of swallowing it', async () => {
  mockListError = Object.assign(new Error('HDKIT_VERSION_TOO_OLD: 插件版本过旧，请升级至正式版 2.0.0 及以上。'), {
    code: 'HDKIT_VERSION_TOO_OLD',
  });
  try {
    // 配额降级数据读取遭遇门禁必须穿透（devbridge-auth 侧按出口折叠的前提），
    // 否则配额信封拿着读不出来的 currentKeys 教用户清 key
    await assert.rejects(listKeysForQuotaHint(), (error: Error & { code?: string }) => {
      assert.equal(error.code, 'HDKIT_VERSION_TOO_OLD');
      return true;
    });
  } finally {
    mockListError = null;
  }
});

// ── keyring 注入命令构建 ──

test('buildKeyringInjectScript includes keyring set and file fallback', () => {
  const script = buildKeyringInjectScript('devbridge_INJECT_TEST');
  assert.ok(script.includes("hwcloud keyring set HW_DEVBRIDGE_API_KEY 'devbridge_INJECT_TEST'"));
  assert.ok(script.includes('echo "export HW_API_KEY=\'devbridge_INJECT_TEST\'" > /tmp/hw_api_key'));
  assert.ok(script.includes('chmod 600 /tmp/hw_api_key'));
  assert.ok(script.includes('DB_KEY_INJECTED'));
});

// ── 清理 ──

test('cleanup tmp home', () => {
  mockKeys = [];
  mockCreateResult = null;
  mockListError = null;
  mockCreateCalls = 0;
  mockDeleteCalls = [];
  if (realHome) process.env.HOME = realHome;
  if (realProfile) process.env.USERPROFILE = realProfile;
});
