// DevBridge API Key 管理：本地缓存 + 孤儿清理 + 自动创建 + 两池分流。
//
// 认证架构（定稿）：
// - devbridge 固定使用 API Key 认证（AK/SK 登录已移除）
// - key 来源优先级：keyring（我们注入的为主，平台遗留兼容命中）
//   → 自动创建兜底 → /tmp/hw_api_key 文件（手动通道最后）
// - key 生命周期：每账号 × 每池恰 1 个固定 name key
//   - ephemeral → devkit-ephemeral
//   - persistent → devkit-persistent（未知池归 ephemeral）
// - 配额上限 20 个/账号（上游错误码 13002）
//
// 缓存文件 ~/.config/huaweicloud/devbridge-api-keys.json（0600）：
// { [akFingerprint]: { ephemeral: "devbridge_...", persistent: "devbridge_..." } }
// 完整 key 只在创建时可见（list 仅 mask），缓存是唯一复用途径。

import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';

import { hdkitCreateApiKey, hdkitListApiKeys, hdkitDeleteApiKey } from './hdkitservice-api.mjs';
import { getCredentials } from './hwlink-api.mjs';

const POOL_KEY_NAMES = {
  ephemeral: 'devkit-ephemeral',
  persistent: 'devkit-persistent',
};
const DEFAULT_POOL = 'ephemeral';
const CACHE_FILE = join(homedir(), '.config', 'huaweicloud', 'devbridge-api-keys.json');

/** pool → 固定 key name */
export function keyNameForPool(poolType) {
  return POOL_KEY_NAMES[poolType] || POOL_KEY_NAMES[DEFAULT_POOL];
}

/** AK 指纹（缓存键，不落明文 AK） */
function akFingerprint(ak) {
  return createHash('sha256').update(String(ak)).digest('hex').slice(0, 16);
}

// ── 本地缓存 ──

function readCache() {
  try {
    return JSON.parse(readFileSync(CACHE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function writeCache(cache) {
  const dir = dirname(CACHE_FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), { mode: 0o600 });
  try {
    chmodSync(CACHE_FILE, 0o600);
  } catch {
    // Windows: chmod 可能不可用
  }
}

/** 读缓存中的完整 key（按 AK + 池） */
export function getCachedKey(ak, poolType) {
  const cache = readCache();
  return cache[akFingerprint(ak)]?.[keyNameForPool(poolType)] || '';
}

/** 写缓存（按 AK + 池） */
function setCachedKey(ak, poolType, apiKey) {
  const fp = akFingerprint(ak);
  const cache = readCache();
  if (!cache[fp]) cache[fp] = {};
  cache[fp][keyNameForPool(poolType)] = apiKey;
  writeCache(cache);
}

/** 清除缓存（key 失效时自愈用） */
export function clearCachedKey(ak, poolType) {
  const fp = akFingerprint(ak);
  const cache = readCache();
  if (cache[fp]?.[keyNameForPool(poolType)]) {
    delete cache[fp][keyNameForPool(poolType)];
    writeCache(cache);
  }
}

// ── 自动创建链路 ──

/**
 * 确保当前账号在指定池有一个可用的 DevBridge API Key。
 *
 * 流程：缓存命中 → 直接返回
 *       无缓存 → list 删同名孤儿 → 创建 → 缓存 → 返回
 *
 * @param {string} poolType ephemeral/persistent（未知归 ephemeral）
 * @returns {Promise<{apiKey: string, mode: string, ak: string}>}
 * @throws Error 配额满（code=HDKIT_DEVBRIDGE_KEY_QUOTA_EXCEEDED）或上游错误
 */
export async function ensureDevbridgeKey(poolType) {
  const { ak } = getCredentials();
  const pool = POOL_KEY_NAMES[poolType] ? poolType : DEFAULT_POOL;
  const name = keyNameForPool(pool);

  // 1. 缓存命中
  const cached = getCachedKey(ak, pool);
  if (cached) {
    return { apiKey: cached, mode: 'CACHE_HIT', ak };
  }

  // 2. list → 删同名孤儿（配额安全：每池恰 1 个；last_used_at 活跃检查防误删跨宿主 LIVE key）
  try {
    const keys = await hdkitListApiKeys();
    const orphan = Array.isArray(keys) ? keys.find((k) => k.name === name) : null;
    // 安全删除条件：同名且 5 分钟内未使用（跨宿主 LIVE key 的 last_used_at 会持续刷新）
    if (orphan && (!orphan.last_used_at || Date.parse(orphan.last_used_at) < Date.now() - 5 * 60 * 1000)) {
      await hdkitDeleteApiKey(orphan.id);
    }
  } catch {
    // list/delete 失败不阻断创建（可能权限或网络问题，继续尝试创建）
  }

  // 3. 创建
  const created = await hdkitCreateApiKey(name, 'devbridge');

  // 4. 缓存
  setCachedKey(ak, pool, created.api_key);

  return { apiKey: created.api_key, mode: 'CREATED', ak };
}

/**
 * key 失效自愈：清除缓存 → 走完整重建链路。
 * 由沙箱内 devbridge auth login 失败触发。
 */
export async function recreateDevbridgeKey(poolType) {
  const { ak } = getCredentials();
  clearCachedKey(ak, poolType);
  return ensureDevbridgeKey(poolType);
}

// ── 配额降级数据 ──

/**
 * 获取配额降级所需的 key 清单（list 成功时返回数组，含 last_used_at）。
 * 用于配额满时给用户展示可清理的 key。
 */
export async function listKeysForQuotaHint() {
  try {
    const keys = await hdkitListApiKeys();
    if (!Array.isArray(keys)) return [];
    return keys.map((k) => ({
      name: k.name,
      id: k.id,
      lastUsed: k.last_used_at || '',
    }));
  } catch {
    return [];
  }
}

// ── keyring 注入命令构建 ──

/**
 * 构建沙箱内 keyring 注入命令（exec 到沙箱执行）。
 * keyring 不可用时降级写 /tmp/hw_api_key 文件。
 */
export function buildKeyringInjectScript(apiKey) {
  return [
    `export PATH="/workspace/.local/bin:$HOME/.huawei/bin:$PATH"`,
    `export HOME="\${HOME:-/root}"`,
    // 尝试 keyring set（hwcloud 支持 set 时优先）
    `KEY_INJECTED=0`,
    `if command -v hwcloud >/dev/null 2>&1; then`,
    `  export DBUS_SESSION_BUS_ADDRESS="\${DBUS_SESSION_BUS_ADDRESS:-unix:path=/run/dbus-session}"`,
    `  if ! pgrep -x dbus-daemon >/dev/null 2>&1 && command -v dbus-daemon >/dev/null 2>&1; then`,
    `    dbus-daemon --session --address="$DBUS_SESSION_BUS_ADDRESS" --fork --nopidfile >/dev/null 2>&1 || true`,
    `    sleep 1`,
    `  fi`,
    `  hwcloud keyring set HW_DEVBRIDGE_API_KEY '${apiKey}' 2>/dev/null && KEY_INJECTED=1`,
    `fi`,
    // keyring 不可用 → 降级写文件（0600，与手动通道同路径但内容是我们注入的自动 key）
    `if [ "$KEY_INJECTED" -eq 0 ]; then`,
    `  echo "export HW_API_KEY='${apiKey}'" > /tmp/hw_api_key`,
    `  chmod 600 /tmp/hw_api_key`,
    `fi`,
    `echo "DB_KEY_INJECTED=$KEY_INJECTED"`,
  ].join('\n');
}
