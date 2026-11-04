// 两池沙箱（pool_type）客户端支持。
// 机制（定稿）：池 = 平台预置模板，客户端传 pool_type（ephemeral/persistent），
// 服务端权威映射 template_id；显式 template_id 优先（运维钉扎场景）。
// - 非持久池（默认）：闲置自动关机 + 自动删除（平台策略）
// - 持久池：EVS 数据盘跨关机保留，闲置回收保留期上限 7 天
// - 生命周期数值由 hdkitservice 配置回显（仅播报口径，实际策略由平台执行）
// - 配额：每用户每类型 1 台（同类复用），账号并发上限 5

import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

const POOL_TYPES = new Set(['ephemeral', 'persistent']);

/** 默认生命周期口径：与服务端默认一致；服务端回显优先，缺失时兜底 */
export const DEFAULT_POOL_LIFECYCLE = {
  ephemeral: { idleShutdownMinutes: 30, idleDeleteMinutes: 60, reclaimDays: null },
  persistent: { idleShutdownMinutes: 60, idleDeleteMinutes: null, reclaimDays: 7 },
};

const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** workspaceId → { poolType, lifecycle, updatedAt }：connect 回显后缓存 */
const workspacePool = new Map();
/** 本进程内已播报过 connect 提示的 workspace（会话级，不落盘） */
const announcedWorkspaces = new Set();
let cacheLoaded = false;

function cachePath() {
  return process.env.HW_SANDBOX_POOL_CACHE_PATH || join(homedir(), '.config', 'huaweicloud', 'sandbox-pools.json');
}

/**
 * 校验并归一化 pool_type；未传时返回 null（交由服务端默认 ephemeral，不在客户端伪造语义）。
 * @throws Error 非法值（ephemeral/persistent 之外）
 */
export function validatePoolType(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const normalized = String(raw).trim().toLowerCase();
  if (!POOL_TYPES.has(normalized)) {
    throw new Error(
      `invalid pool_type "${raw}" (expected ephemeral or persistent). ` +
        'ephemeral = 非持久沙箱（闲置自动关机/删除）；persistent = 持久沙箱（数据盘保留，闲置回收上限 7 天）',
    );
  }
  return normalized;
}

/**
 * 运维钉扎（可选）：设置 HW_POOL_TEMPLATE_EPHEMERAL/PERSISTENT 后，客户端把映射出的
 * template_id 与 pool_type 一并上送——服务端（及未升级的老服务端）按显式模板处理。
 * 日常部署无需配置：模板 ID 由服务端 POOL_TEMPLATE_* 环境变量权威维护。
 */
export function pinnedTemplateFor(poolType) {
  if (poolType === 'ephemeral') return process.env.HW_POOL_TEMPLATE_EPHEMERAL || '';
  if (poolType === 'persistent') return process.env.HW_POOL_TEMPLATE_PERSISTENT || '';
  return '';
}

function positiveNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * 归一化生命周期口径：服务端字段（snake_case 官方契约）+ camelCase 双读兜底；
 * 缺失/非法时回退客户端默认值（与服务端默认一致）。
 */
function normalizeLifecycle(poolType, raw = {}) {
  const defaults = DEFAULT_POOL_LIFECYCLE[poolType];
  if (!defaults) return null;
  const pick = (...keys) => {
    for (const key of keys) {
      const value = positiveNumber(raw[key]);
      if (value !== null) return value;
    }
    return null;
  };
  const idleShutdownMinutes =
    pick('pool_idle_shutdown_minutes', 'poolIdleShutdownMinutes', 'idleShutdownMinutes') ??
    defaults.idleShutdownMinutes;
  const idleDeleteMinutes =
    poolType === 'ephemeral'
      ? (pick('pool_idle_delete_minutes', 'poolIdleDeleteMinutes', 'idleDeleteMinutes') ?? defaults.idleDeleteMinutes)
      : null;
  const reclaimDays =
    poolType === 'persistent'
      ? (pick('pool_reclaim_days', 'poolReclaimDays', 'reclaimDays') ?? defaults.reclaimDays)
      : null;
  return { idleShutdownMinutes, idleDeleteMinutes, reclaimDays };
}

function ensureCacheLoaded() {
  if (cacheLoaded) return;
  cacheLoaded = true;
  try {
    const raw = JSON.parse(readFileSync(cachePath(), 'utf8'));
    const now = Date.now();
    for (const [wsId, entry] of Object.entries(raw?.workspaces || {})) {
      if (!entry || !POOL_TYPES.has(entry.poolType)) continue;
      if (!Number.isFinite(entry.updatedAt) || now - entry.updatedAt > CACHE_TTL_MS) continue;
      workspacePool.set(wsId, {
        poolType: entry.poolType,
        lifecycle: normalizeLifecycle(entry.poolType, entry.lifecycle || {}),
        updatedAt: entry.updatedAt,
      });
    }
  } catch {
    // 首次使用 / 文件损坏：按空缓存处理
  }
}

function persistCache() {
  try {
    ensureCacheLoaded();
    const file = cachePath();
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const workspaces = {};
    for (const [wsId, entry] of workspacePool) workspaces[wsId] = entry;
    const payload = JSON.stringify({ workspaces }, null, 2);
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, payload, { mode: 0o600 });
    try {
      renameSync(tmp, file);
    } catch {
      writeFileSync(file, payload, { mode: 0o600 });
    }
  } catch {
    // 缓存失败不影响主流程（仅丢失跨进程提示能力）
  }
}

/**
 * 记录 workspace 的池归属与生命周期口径（来自服务端 connect 回显）。
 * 无 pool_type 回显（自定义模板 / 老服务端）不记录，避免编造池语义。
 */
export function rememberWorkspacePool(workspaceId, poolType, lifecycleRaw) {
  if (!workspaceId || !POOL_TYPES.has(poolType)) return;
  workspacePool.set(workspaceId, {
    poolType,
    lifecycle: normalizeLifecycle(poolType, lifecycleRaw || {}),
    updatedAt: Date.now(),
  });
  persistCache();
}

/** 清理 workspace 池缓存（测试用 / 会话关闭时） */
export function forgetWorkspacePool(workspaceId) {
  if (workspaceId === undefined) {
    workspacePool.clear();
    announcedWorkspaces.clear();
  } else {
    workspacePool.delete(workspaceId);
    announcedWorkspaces.delete(workspaceId);
  }
  persistCache();
}

/**
 * connect 生命周期提示的播报判定：会话首次 connect 播报；
 * 复用实例被本次 connect 唤醒（started=true）时再次播报；其余复用静默。
 */
export function shouldAnnounceConnect(workspaceId, result = {}) {
  const started = result.started === true || result.startedFromStopped === true;
  if (!workspaceId) return true;
  if (!announcedWorkspaces.has(workspaceId)) {
    announcedWorkspaces.add(workspaceId);
    return true;
  }
  return started;
}

/** 分钟数 → 中文口径（60 的整数倍显示为小时） */
function formatMinutes(minutes, fallback) {
  const n = Number(minutes) > 0 ? Number(minutes) : fallback;
  if (n % 60 === 0 && n >= 60) return `${n / 60} 小时`;
  return `${n} 分钟`;
}

function formatDays(days, fallback) {
  const n = Number(days) > 0 ? Number(days) : fallback;
  return `${n} 天`;
}

/**
 * exec/upload/deploy 等工具的内部池上下文（不再默认并入工具返回，避免逐次刷屏）。
 * expose_tunnel 用 poolLifecycle 生成交付地址提示；poolMode 用于 DevBridge key 分池。
 */
export function poolContextFor(workspaceId) {
  ensureCacheLoaded();
  const entry = workspacePool.get(workspaceId);
  if (!entry) return undefined;
  const { poolType, lifecycle } = entry;
  const shutdown = formatMinutes(lifecycle.idleShutdownMinutes, DEFAULT_POOL_LIFECYCLE[poolType].idleShutdownMinutes);
  if (poolType === 'ephemeral') {
    const del = formatMinutes(lifecycle.idleDeleteMinutes, DEFAULT_POOL_LIFECYCLE.ephemeral.idleDeleteMinutes);
    return {
      poolMode: 'ephemeral',
      poolLifecycle: { poolType, ...lifecycle },
      persistenceHint: `非持久沙箱：闲置 ${shutdown}自动关机、${del}自动删除，重要数据请及时保存或迁出`,
    };
  }
  const reclaim = formatDays(lifecycle.reclaimDays, DEFAULT_POOL_LIFECYCLE.persistent.reclaimDays);
  return {
    poolMode: 'persistent',
    poolLifecycle: { poolType, ...lifecycle },
    persistenceHint: `持久沙箱：闲置 ${shutdown}自动关机（数据盘保留）；闲置回收保留期最长 ${reclaim}`,
  };
}

function buildConnectTtlHint(poolType, lifecycle) {
  if (poolType === 'ephemeral') {
    const shutdown = formatMinutes(lifecycle.idleShutdownMinutes, DEFAULT_POOL_LIFECYCLE.ephemeral.idleShutdownMinutes);
    const del = formatMinutes(lifecycle.idleDeleteMinutes, DEFAULT_POOL_LIFECYCLE.ephemeral.idleDeleteMinutes);
    return {
      lifecycle: `idle shutdown ${lifecycle.idleShutdownMinutes}min + auto-delete ${lifecycle.idleDeleteMinutes}min (platform policy)`,
      ttl_hint: `非持久沙箱：闲置 ${shutdown}自动关机、${del}自动删除（平台策略）。重要数据请及时保存或迁出。`,
    };
  }
  const shutdown = formatMinutes(lifecycle.idleShutdownMinutes, DEFAULT_POOL_LIFECYCLE.persistent.idleShutdownMinutes);
  const reclaim = formatDays(lifecycle.reclaimDays, DEFAULT_POOL_LIFECYCLE.persistent.reclaimDays);
  return {
    lifecycle: `idle shutdown ${lifecycle.idleShutdownMinutes}min; EVS data disk retained; idle reclaim within ${lifecycle.reclaimDays} days max`,
    ttl_hint: `持久沙箱：闲置 ${shutdown}自动关机（实例与数据盘保留，重新连接可继续使用）；闲置回收保留期最长 ${reclaim}，到期实例与数据将被删除，长期不用请自行导出。`,
  };
}

/**
 * connect 结果池富化（生命周期播报）。
 * - 仅当服务端回显 pool_type 才生成提示（自定义模板不编造池语义）
 * - announce=false 时不播报（会话内重复复用）
 * - 数值以服务端回显为准，缺失时用客户端默认口径兜底
 */
export function enrichConnectResult(result, options = {}) {
  if (!result || typeof result !== 'object') return result;
  const poolType = result.pool_type || result.poolType;
  const announce = options.announce !== false;
  if (!announce || !POOL_TYPES.has(poolType)) {
    delete result.pool;
    return result;
  }
  const lifecycle = normalizeLifecycle(poolType, result);
  result.pool = {
    pool_type: poolType,
    ...buildConnectTtlHint(poolType, lifecycle),
  };
  return result;
}

/**
 * 交付公网地址时的沙箱存活期提示（expose_tunnel 专用）。
 * 返回 undefined 表示池语义未知（自定义模板 / 无缓存），不编造提示。
 */
export function buildExposeLifetimeNotice(poolContext, expiryHours) {
  const lifecycle = poolContext?.poolLifecycle;
  if (!lifecycle) return undefined;
  const poolType = lifecycle.poolType;
  const tunnelHours = Number(expiryHours) > 0 ? Number(expiryHours) : 72;
  if (poolType === 'ephemeral') {
    const shutdown = formatMinutes(lifecycle.idleShutdownMinutes, DEFAULT_POOL_LIFECYCLE.ephemeral.idleShutdownMinutes);
    const del = formatMinutes(lifecycle.idleDeleteMinutes, DEFAULT_POOL_LIFECYCLE.ephemeral.idleDeleteMinutes);
    return {
      sandboxLifetime: {
        poolType,
        idleShutdownMinutes: lifecycle.idleShutdownMinutes,
        idleDeleteMinutes: lifecycle.idleDeleteMinutes,
      },
      urlLifetimeHint:
        `该公网地址随沙箱存亡：非持久沙箱闲置 ${shutdown}自动关机（地址随即失效）、` +
        `闲置 ${del}自动删除（地址与数据永久消失）。隧道有效期 ${tunnelHours} 小时不等于沙箱存活期；` +
        '自动续期只保隧道，不能阻止沙箱关机。',
      warning:
        `URL 存活期提示：非持久沙箱闲置 ${shutdown}自动关机、${del}自动删除，此地址届时失效` +
        `（隧道 ${tunnelHours} 小时有效期不等于沙箱存活期）`,
    };
  }
  const shutdown = formatMinutes(lifecycle.idleShutdownMinutes, DEFAULT_POOL_LIFECYCLE.persistent.idleShutdownMinutes);
  const reclaim = formatDays(lifecycle.reclaimDays, DEFAULT_POOL_LIFECYCLE.persistent.reclaimDays);
  return {
    sandboxLifetime: {
      poolType,
      idleShutdownMinutes: lifecycle.idleShutdownMinutes,
      reclaimDays: lifecycle.reclaimDays,
    },
    urlLifetimeHint:
      `该公网地址随沙箱存亡：持久沙箱闲置 ${shutdown}自动关机（地址失效，但实例与数据盘保留，` +
      `重新连接沙箱后可重新暴露端口恢复访问）；闲置回收保留期最长 ${reclaim}，到期实例与数据将被删除。` +
      `隧道有效期 ${tunnelHours} 小时不等于沙箱存活期；自动续期只保隧道，不能阻止沙箱关机。`,
    warning:
      `URL 存活期提示：持久沙箱闲置 ${shutdown}自动关机，此地址届时失效（实例与数据保留，` +
      `重新连接后可恢复）；闲置回收上限 ${reclaim}`,
  };
}
