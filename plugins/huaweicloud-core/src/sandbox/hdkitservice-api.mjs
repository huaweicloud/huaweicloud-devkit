import { getCredentials } from './hwlink-api.mjs';
import { getProxyDispatcher } from '../proxy/proxy-agent.mjs';
import { cacheUserHash } from '../telemetry/telemetry.mjs';
import { detectAgent } from '../telemetry/agent-detect.mjs';
import { readInstalledVersion } from '../update-check.mjs';

function getHdkitBaseUrl() {
  return process.env.HDKITSERVICE_ENDPOINT || 'https://devkit.huaweicloud.com/rest/developer/server/hdkitservice/';
}

async function hdkitRequest(method, path, body, timeoutMs = 300000) {
  const { ak, sk, securitytoken } = getCredentials();

  if (!ak || !sk) {
    throw new Error(
      'Huawei Cloud credentials are not configured. ' +
        'Run "npx huaweicloud-devkit auth init" or set HW_ACCESS_KEY/HW_SECRET_KEY.',
    );
  }
  const headers = {
    'Content-Type': 'application/json',
    'X-HW-AK': ak,
    'X-HW-SK': sk,
    'X-HW-Client-Version': readInstalledVersion() || '0.0.0',
    // #1040: 对外请求统一携带 X-HW-Agent（值=detectAgent 结果 harness）
    'X-HW-Agent': detectAgent().harness,
  };
  if (securitytoken) {
    headers['X-HW-Security-Token'] = securitytoken;
  }

  const url = `${getHdkitBaseUrl()}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let resp;
  try {
    const dispatcher = await getProxyDispatcher(url);
    const fetchOpts = {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    };
    if (dispatcher) {
      fetchOpts.dispatcher = dispatcher;
      const { fetch: undiciFetch } = await import('undici');
      resp = await undiciFetch(url, fetchOpts);
    } else {
      resp = await fetch(url, fetchOpts);
    }
  } finally {
    clearTimeout(timer);
  }

  const text = await resp.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`hdkitservice returned non-JSON (status ${resp.status}): ${text.slice(0, 200)}`);
  }

  if (!resp.ok) {
    const code = data.code || `HTTP_${resp.status}`;
    const trace = data.traceId ? ` [trace: ${data.traceId}]` : '';
    const err = new Error(`${code}: ${data.message || 'hdkitservice error'}${trace}`);
    err.code = code;
    err.status = resp.status;
    err.traceId = data.traceId;
    const quotaInfo = classifyQuotaError(resp.status, code, resp.headers.get('retry-after'));
    if (quotaInfo) {
      err.kind = quotaInfo.kind;
      err.retryAfter = quotaInfo.retryAfter;
      err.remediation = quotaInfo.remediation;
    }
    if (code === 'HDKIT_CRED_INVALID') {
      err.remediation = {
        hint: '已保存的凭证(S1)可能已失效。请执行以下操作之一：',
        steps: [
          '运行 huaweicloud_auth_status 查看当前凭证状态（S1 指纹 vs 环境注入指纹）',
          '若环境注入了有效凭证：运行 huaweicloud_auth_switch action=clear 清除 runtime 凭证，或删除 ~/.config/huaweicloud/credentials.json 让平台凭证接管',
          '若需更新 S1：运行 npx huaweicloud-devkit auth init 重新配置有效 AK/SK',
        ],
      };
    }
    throw err;
  }

  return data;
}

export async function hdkitCheckUser() {
  const result = await hdkitRequest('GET', 'check-user', undefined, 30000);
  if (result.userHash) cacheUserHash(result.userHash);
  return result;
}

export async function hdkitGenerateUserHash() {
  const result = await hdkitRequest('GET', 'user/generatorUserIDHash', undefined, 30000);
  if (result.userHash) cacheUserHash(result.userHash);
  return result;
}

export async function hdkitSignAgreement() {
  return await hdkitRequest('POST', 'sign-agreement', {});
}

export function classifyQuotaError(status, code, retryAfterHeader) {
  if (status !== 429) return null;
  const retryAfter = retryAfterHeader || '';
  if (code === 'HDKIT_QUOTA_EXCEEDED') {
    return {
      kind: 'quota_exceeded',
      retryAfter,
      remediation: {
        hint: '沙箱配额超限（每用户每类型 1 个实例；1 非持久化 + 1 持久化可并存）。',
        steps: [
          retryAfter ? `按 Retry-After=${retryAfter} 秒等待后重试` : '稍后重试（服务端未返回 Retry-After）',
          '或释放该类型名额：结束占用任务（close_session 仅关闭终端会话；删除实例需向开发者显式二次确认）',
          '若另一类型空闲，可改选另一类型',
        ],
      },
    };
  }
  if (code === 'HDKIT_CAPACITY_INSUFFICIENT') {
    return {
      kind: 'capacity_insufficient',
      retryAfter,
      remediation: {
        hint: '资源池容量不足（池侧无可用容量，非用户配额问题）。',
        steps: ['稍后重试', '或改选另一类型（池）'],
      },
    };
  }
  return null;
}

const POOL_TEMPLATE_ENV = {
  ephemeral: 'HDKIT_POOL_TEMPLATE_EPHEMERAL',
  persistent: 'HDKIT_POOL_TEMPLATE_PERSISTENT',
};

export function resolvePoolTemplate(poolType, explicitTemplateId) {
  if (explicitTemplateId) return { template_id: explicitTemplateId, source: 'explicit' };
  if (!poolType) return { template_id: '', source: 'default' };
  if (poolType !== 'ephemeral' && poolType !== 'persistent') {
    throw new Error(`Invalid pool_type "${poolType}" — use "ephemeral" or "persistent".`);
  }
  const tpl = (process.env[POOL_TEMPLATE_ENV[poolType]] || '').trim();
  if (!tpl) {
    throw new Error(
      `pool_type="${poolType}" requested but no pool template mapped. ` +
        `The platform pre-provisions per-pool templates; configure ` +
        `${POOL_TEMPLATE_ENV[poolType]} or pass template_id explicitly.`,
    );
  }
  return { template_id: tpl, source: 'pool_map' };
}

export async function hdkitConnect(options = {}) {
  const { template_id: poolTemplateId } = resolvePoolTemplate(options.pool_type, options.template_id);
  const body = {};
  if (options.source) body.source = options.source;
  if (options.env) body.env = options.env;
  if (options.git) body.git = options.git;
  if (poolTemplateId) body.template_id = poolTemplateId;
  if (options.flavor_id) body.flavor_id = options.flavor_id;

  return await hdkitRequest('POST', 'connect', body);
}

export async function hdkitCredentials(sessionId, devStageId, enableSts = true) {
  const body = { enable_sts: enableSts };
  if (sessionId) body.session_id = sessionId;
  if (devStageId) body.dev_stage_id = devStageId;

  if (!sessionId && !devStageId) {
    throw new Error('session_id or dev_stage_id is required');
  }

  return await hdkitRequest('POST', 'credentials', body);
}

export async function hdkitVoucherStatus(domainId) {
  try {
    const path = domainId ? `voucher/status?domain_id=${encodeURIComponent(domainId)}` : 'voucher/status';
    return await hdkitRequest('GET', path, undefined, 30000);
  } catch (error) {
    return {
      claimed: false,
      message: error?.message || 'Incentive service unavailable, please try again later',
      code: error?.code,
      ...(error?.remediation ? { remediation: error.remediation } : {}),
    };
  }
}

export async function hdkitVoucherClaim(domainId) {
  try {
    const body = domainId ? { domain_id: domainId } : {};
    return await hdkitRequest('POST', 'voucher/claim', body);
  } catch (error) {
    return {
      claimed: false,
      message: error?.message || 'Incentive service unavailable, please try again later',
      code: error?.code,
      ...(error?.remediation ? { remediation: error.remediation } : {}),
    };
  }
}

export async function hdkitCompetitionVoucherClaim(domainId) {
  try {
    const body = domainId ? { domain_id: domainId } : {};
    return await hdkitRequest('POST', 'competition/voucher/claim', body);
  } catch (error) {
    return {
      claimed: false,
      message: error?.message || 'Competition voucher service unavailable, please try again later',
      code: error?.code,
      ...(error?.remediation ? { remediation: error.remediation } : {}),
    };
  }
}
