import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const POOL_TYPES = new Set(['ephemeral', 'persistent']);
const ENV_KEYS = {
  ephemeral: 'HDKIT_POOL_TEMPLATE_EPHEMERAL',
  persistent: 'HDKIT_POOL_TEMPLATE_PERSISTENT',
};

function poolConfigPath() {
  return (
    process.env.HDKIT_SANDBOX_POOLS_CONFIG || join(homedir(), '.config', 'huaweicloud-devkit', 'sandbox-pools.json')
  );
}

function readPoolConfigFile() {
  try {
    return JSON.parse(readFileSync(poolConfigPath(), 'utf8')) || {};
  } catch {
    return {};
  }
}

export function resolvePoolTemplate(poolType, explicitTemplateId) {
  if (explicitTemplateId) return { template_id: explicitTemplateId, source: 'explicit' };
  if (!poolType) return { template_id: '', source: 'default' };
  if (!POOL_TYPES.has(poolType)) {
    throw new Error(`Invalid pool_type "${poolType}" — use "ephemeral" or "persistent".`);
  }
  const cfg = readPoolConfigFile();
  const tpl = String(cfg?.templates?.[poolType] || process.env[ENV_KEYS[poolType]] || '').trim();
  if (!tpl) {
    throw new Error(
      `pool_type="${poolType}" requested but no pool template mapped. ` +
        `The platform pre-provisions per-pool templates; configure templates.${poolType} in ${poolConfigPath()} ` +
        `or set ${ENV_KEYS[poolType]}, or pass template_id explicitly.`,
    );
  }
  return { template_id: tpl, source: 'pool_map' };
}

export function getPoolLifecycleGuidance(poolType) {
  if (poolType === 'ephemeral') {
    return {
      positioning: '预览/试用/一次性任务/敏感即焚',
      lifecycle: '闲置关机/闲置删除时间可配（目标 30min 闲置关机 + 1h 闲置自动删除）',
      durability: '不承诺会话外存活——任务完成即交付成果',
      verification: '待验证：闲置参数可配性未实测（实测项 a）',
    };
  }
  if (poolType === 'persistent') {
    return {
      positioning: '开发工作台/带数据库项目/跨日评审',
      storage: '挂 EVS 32G——代码/数据库跨重启存活（当前两池实际差异仅此，待测试）',
      idle: '1h 闲置关机（目标口径）；活性检测当前仅 connect 连接判定（进程/预览流量：诉求中）',
      retention: '停机后最长保留 7 天（资源组数据库上限，原 14 天口径已作废）',
      pre_shutdown_notice: '当前不支持关机/删除前通知（诉求中）',
    };
  }
  return null;
}

export function buildConnectPoolInfo(poolType, templateId, templateSource) {
  if (!poolType) return null;
  return {
    type: poolType,
    template_id: templateId || '',
    template_source: templateSource,
    lifecycle: getPoolLifecycleGuidance(poolType),
    quota:
      '每用户每类型 1 实例（1 ephemeral + 1 persistent 可并存；同类请求复用现有实例）；' +
      '超限返回 HTTP 429 + Retry-After，错误码区分配额超限（HDKIT_QUOTA_EXCEEDED）与容量不足（HDKIT_CAPACITY_INSUFFICIENT）',
  };
}
