import { getCredentials } from './hwlink-api.mjs';
import { getProxyDispatcher } from '../proxy/proxy-agent.mjs';
import { cacheUserHash } from '../telemetry/telemetry.mjs';
import { detectAgent } from '../telemetry/agent-detect.mjs';
import { readInstalledVersion } from '../update-check.mjs';
import { pinnedTemplateFor } from './sandbox-pool.mjs';

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
    // 429 双错误码（两池配额契约）：配额满给出释放/复用引导；池容量不足只透传服务端
    // 最终文案（“DevKit 免费资源当前使用人数较多，建议您错峰使用，感谢理解！”），
    // 不再附加额外引导——该文案即最终展示内容。两者均携带服务端 Retry-After。
    if (code === 'HDKIT_QUOTA_EXCEEDED') {
      err.retryAfter = resp.headers.get('Retry-After') || undefined;
      err.remediation = {
        hint: '沙箱并发配额已满（每账号最多 5 台、每类型 1 台），重试无效：',
        steps: [
          '确认已有实例是否够用：connect 对同池实例自动复用，无需重复创建',
          '释放不再使用的沙箱（控制台或平台回收）后重试',
          '如需两种生命周期语义并存：ephemeral 与 persistent 各可持有 1 台',
        ],
      };
    }
    if (code === 'HDKIT_CAPACITY_INSUFFICIENT') {
      err.retryAfter = resp.headers.get('Retry-After') || undefined;
      // 该文案即最终展示内容（不带 "CODE: " 前缀、不附加引导）
      err.message = data.message || err.message;
    }
    // 烧核播报（缺口#5 代码层）：账号核心时长耗尽——上游码 HD.97520422 经
    // hdkitservice 以 HDKIT_UPSTREAM_ERROR 包装透传，客户端按消息内错误码识别。
    // 仅在前面的分支未设置 remediation 时生效（else-if 语义：烧核不覆盖 429 双码/凭证指引）
    if (!err.remediation && String(data.message || '').includes('HD.97520422')) {
      err.coreHoursExhausted = true;
      err.remediation = {
        hint: '账号核心时长（核时）已耗尽，沙箱无法继续运行：',
        steps: [
          '核时按沙箱运行时长消耗，当前账号余额为 0',
          '更换有核时余额的账号，或等待/申请核时补充',
          '详见华为云开发者空间核心时长说明',
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

export async function hdkitConnect(options = {}) {
  const body = {};
  if (options.source) body.source = options.source;
  if (options.env) body.env = options.env;
  if (options.git) body.git = options.git;
  if (options.template_id) body.template_id = options.template_id;
  if (options.flavor_id) body.flavor_id = options.flavor_id;
  if (options.pool_type) {
    // 两池：pool_type 由服务端权威映射（不传默认 ephemeral）。
    // 可选运维钉扎：配置 HW_POOL_TEMPLATE_* 时附带映射模板（服务端与老服务端均按显式模板处理）
    body.pool_type = options.pool_type;
    const pinned = pinnedTemplateFor(options.pool_type);
    if (pinned && !body.template_id) body.template_id = pinned;
  }

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

// ── DevBridge API Key relay 代理（经 hdkitservice 透传 DevStation relay 接口）──
// 凭证由 hdkitRequest 内部 getCredentials() 统一解析，调用方无需传

/**
 * 创建 DevBridge API Key。响应含完整 api_key（仅创建时可见）。
 * 配额满（13002）时服务端返回 429 HDKIT_DEVBRIDGE_KEY_QUOTA_EXCEEDED，
 * hdkitRequest 抛错 err.code 携带该码。
 */
export async function hdkitCreateApiKey(name, scope = 'devbridge') {
  return await hdkitRequest('POST', 'api-key', { name, scope });
}

/** 列出当前账号所有 API Key（仅 mask + last_used_at）。 */
export async function hdkitListApiKeys() {
  return await hdkitRequest('GET', 'api-keys', undefined, 30000);
}

/** 按 keyId 删除 API Key（上游 DELETE 方法）。 */
export async function hdkitDeleteApiKey(keyId) {
  return await hdkitRequest('DELETE', `api-keys/${encodeURIComponent(keyId)}`, undefined, 30000);
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
