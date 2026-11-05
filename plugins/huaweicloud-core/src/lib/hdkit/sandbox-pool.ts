// 两池沙箱（pool_type）客户端支持。
// 机制（定稿）：池 = 平台预置模板，客户端传 pool_type（ephemeral/persistent），
// 服务端权威映射 template_id；显式 template_id 优先（运维钉扎场景）。
// - 非持久池（默认）：闲置 30min 自动关机 + 1h 删除（平台定时任务，已实测生效）
// - 持久池：EVS 数据盘跨关机保留，闲置回收保留期上限 7 天
// - 配额：每用户每类型 1 台（同类复用），账号并发上限 5

import { asText } from '../as-text.ts';

export type PoolType = 'ephemeral' | 'persistent';

// 按类型键的生命周期表：每个池域事实（TTL 播报、模式提示、钉扎环境变量）
// 在这里只有一份，消费方按键取用，不写散落的类型分支。
export interface PoolLifecycle {
  lifecycle: string;
  ttlHint: string;
  persistenceHint: string;
  pinnedTemplateEnv: string;
}

export const DEFAULT_POOL_LIFECYCLE: Record<PoolType, PoolLifecycle> = {
  ephemeral: {
    lifecycle: 'idle 30min auto-shutdown + 1h auto-delete (platform scheduled task, verified)',
    ttlHint:
      '非持久沙箱：闲置 30 分钟将自动关机、闲置 1 小时将自动删除（平台定时任务已生效）。' +
      '重要数据请及时保存或迁出；需要跨会话保留数据请改用 pool_type=persistent。',
    persistenceHint: '非持久沙箱：闲置 30 分钟自动关机、1 小时自动删除，重要数据请及时保存或迁出',
    pinnedTemplateEnv: 'HW_POOL_TEMPLATE_EPHEMERAL',
  },
  persistent: {
    lifecycle: 'EVS data disk retained; idle reclaim within 7 days max',
    ttlHint: '持久沙箱：数据盘跨关机保留，闲置回收保留期最长 7 天；长期不用请自行导出数据。',
    persistenceHint: '持久沙箱：数据盘跨关机保留，闲置回收保留期最长 7 天',
    pinnedTemplateEnv: 'HW_POOL_TEMPLATE_PERSISTENT',
  },
};

const POOL_TYPES: ReadonlySet<string> = new Set(['ephemeral', 'persistent']);

/** workspaceId → poolType 缓存：exec/upload/deploy 等工具返回值据此附带池上下文 */
const workspacePool = new Map<string, string>();

export interface PoolContext {
  poolMode: PoolType;
  persistenceHint: string;
}

export interface ConnectPoolBroadcast {
  pool_type: PoolType;
  lifecycle: string;
  ttl_hint: string;
}

/**
 * 校验并归一化 pool_type；未传时返回 null（交由服务端默认 ephemeral，不在客户端伪造语义）。
 * @throws Error 非法值（ephemeral/persistent 之外）
 */
export function validatePoolType(raw: unknown): PoolType | null {
  if (raw === undefined || raw === null || raw === '') return null;
  const rawText = asText(raw);
  const normalized = rawText.trim().toLowerCase();
  if (!POOL_TYPES.has(normalized)) {
    throw new Error(
      `invalid pool_type "${rawText}" (expected ephemeral or persistent). ` +
        'ephemeral = 非持久沙箱（闲置 30min 自动关机、1h 删除）；persistent = 持久沙箱（数据盘保留，闲置回收上限 7 天）',
    );
  }
  return normalized as PoolType;
}

/**
 * 运维钉扎（可选）：设置 HW_POOL_TEMPLATE_EPHEMERAL/PERSISTENT 后，客户端把映射出的
 * template_id 与 pool_type 一并上送——服务端（及未升级的老服务端）按显式模板处理。
 * 日常部署无需配置：模板 ID 由服务端 POOL_TEMPLATE_* 环境变量权威维护。
 */
export function pinnedTemplateFor(poolType: unknown): string {
  if (poolType === 'ephemeral' || poolType === 'persistent') {
    return process.env[DEFAULT_POOL_LIFECYCLE[poolType].pinnedTemplateEnv] || '';
  }
  return '';
}

/** 记录 workspace 的池归属（来自服务端 connect 响应的 pool_type 回显） */
export function rememberWorkspacePool(workspaceId: unknown, poolType: unknown): void {
  if (workspaceId && poolType) workspacePool.set(asText(workspaceId), asText(poolType));
}

/** 清理 workspace 池缓存（测试用） */
export function forgetWorkspacePool(workspaceId?: string): void {
  if (workspaceId === undefined) workspacePool.clear();
  else workspacePool.delete(workspaceId);
}

/**
 * exec/upload/deploy 等工具返回值的池上下文（缺口#2 模式提示）。
 * 未记录池归属（老服务端/自定义模板）时返回 undefined，不附加任何字段。
 */
export function poolContextFor(workspaceId: string): PoolContext | undefined {
  const poolType = workspacePool.get(workspaceId);
  if (poolType === 'ephemeral' || poolType === 'persistent') {
    return { poolMode: poolType, persistenceHint: DEFAULT_POOL_LIFECYCLE[poolType].persistenceHint };
  }
  return undefined;
}

// 回显读取做 pool_type/poolType 双读兜底（与 devStageId 双读同型，防 wire 命名漂移）。
function readPoolTypeEcho(result: Record<string, unknown>): unknown {
  return result.pool_type || result.poolType;
}

/**
 * connect 结果池富化（缺口#1 TTL 播报）。
 * 仅当服务端回显 pool_type 才播报（两种状态制：服务端未确认池语义不编造）。
 * 钉扎/自定义模板（服务端回显 null）不播报。
 */
export function enrichConnectResult<T>(result: T): T {
  if (!result || typeof result !== 'object') return result;
  const rec = result as Record<string, unknown>;
  const poolType = readPoolTypeEcho(rec);
  if (poolType === 'ephemeral' || poolType === 'persistent') {
    rec.pool = {
      pool_type: poolType,
      lifecycle: DEFAULT_POOL_LIFECYCLE[poolType].lifecycle,
      ttl_hint: DEFAULT_POOL_LIFECYCLE[poolType].ttlHint,
    } satisfies ConnectPoolBroadcast;
  }
  return result;
}

/** 池信息字段并入既有对象结果（非对象结果原样返回） */
export function withPoolContext<T>(workspaceId: string, result: T): T {
  const ctx = poolContextFor(workspaceId);
  if (!ctx || !result || typeof result !== 'object') return result;
  return { ...(result as Record<string, unknown>), ...ctx } as T;
}
