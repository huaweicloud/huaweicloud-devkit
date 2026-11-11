import { fetchWithProxy } from '../../proxy/proxy-agent.ts';
import { cacheUserHash } from '../../telemetry/telemetry.ts';
import { detectAgent } from '../../telemetry/agent-detect.ts';
import { readInstalledVersion } from '../../update-check.ts';
import { getCredentials } from './hwlink-api.ts';
import { pinnedTemplateFor } from './sandbox-pool.ts';
import {
  VERSION_GATE_CODE,
  applyVersionGate,
  cleanMessage,
  connectRetryDelaysMs,
  decorateExhaustedConnect,
  gatePayloadFields,
  isGatewayTransient,
  isNonRetryableBusinessError,
} from './hdkit-gate.ts';
import { asRecord } from '../as-record.ts';
import { asString, asText } from '../as-text.ts';

export interface HdkitError extends Error {
  code?: string;
  status?: number;
  traceId?: unknown;
  remediation?: { hint: string; steps: string[] };
  retryAfter?: string;
  coreHoursExhausted?: boolean;
  clientVersion?: string;
  minVersion?: string;
}

// Structural surface shared by the global and undici Response implementations;
// only ok/status/text/headers.get are consumed below.
interface HttpResponseLike {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  headers: { get(name: string): string | null };
}

function getHdkitBaseUrl(): string {
  return process.env.HDKITSERVICE_ENDPOINT || 'https://devkit.huaweicloud.com/rest/developer/server/hdkitservice/';
}

async function hdkitRequest(
  method: string,
  path: string,
  body: unknown,
  timeoutMs = 300000,
): Promise<Record<string, unknown> | unknown[]> {
  const { ak, sk, securitytoken } = getCredentials();

  if (!ak || !sk) {
    throw new Error(
      'Huawei Cloud credentials are not configured. ' +
        'Run "npx huaweicloud-devkit auth init" or set HW_ACCESS_KEY/HW_SECRET_KEY.',
    );
  }
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-HW-AK': ak,
    'X-HW-SK': sk,
    'X-HW-Client-Version': readInstalledVersion() || '0.0.0',
    // #1040: 对外请求统一携带 X-HW-Agent（值=detectAgent 结果 harness，
    // 'unknown' 兜底——探针类 clientName 不再透传）。
    'X-HW-Agent': detectAgent().harness,
  };
  if (securitytoken) {
    headers['X-HW-Security-Token'] = securitytoken;
  }

  const url = `${getHdkitBaseUrl()}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let resp: HttpResponseLike;
  try {
    resp = await fetchWithProxy(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  // 响应体读取中断同样携带 resp.status（round 4，v2 标注分歧——dev 裸抛）：
  // 已收到 502/504 status 时重试契约照常适用。非 Error 拒绝原因（undefined/null/
  // 字符串等）不落字面量——String(error) 对 undefined 是真值 "undefined"，与
  // asText 同款陷阱（round 5）
  let text: string;
  try {
    text = await resp.text();
  } catch (error) {
    const reason =
      error instanceof Error
        ? error
        : typeof error === 'string' && error.trim() !== ''
          ? new Error(error)
          : new Error('hdkitservice response body read aborted');
    throw Object.assign(reason, { status: resp.status });
  }
  let data: Record<string, unknown> | unknown[];
  try {
    // asRecord collapses arrays into {} — the list endpoints (api-keys) return
    // real arrays, and collapsing them silently kills the orphan-key ladder.
    const parsed: unknown = JSON.parse(text);
    data = Array.isArray(parsed) ? parsed : asRecord(parsed);
  } catch {
    // 非 JSON 页必须携带 resp.status：瞬时判定按 status 裁决，不带 status 的
    // 抛错会被消息兜底误判（round 3）
    throw Object.assign(new Error(`hdkitservice returned non-JSON (status ${resp.status}): ${text.slice(0, 200)}`), {
      status: resp.status,
    });
  }

  if (!resp.ok) {
    const rec = asRecord(data);
    const rawCode = rec.code;
    const code = typeof rawCode === 'string' && rawCode ? rawCode : `HTTP_${resp.status}`;
    const trace = rec.traceId ? ` [trace: ${asText(rec.traceId)}]` : '';
    // 消息构建口（round 4 + round 5）：空白与纯不可见字符（零宽空格等
    // trim 不清除的 Cf 类）均视为缺失——设计好的 'hdkitservice error'
    // 兜底在所有出口生效
    const message = cleanMessage(asString(rec.message)) || 'hdkitservice error';
    const err = new Error(`${code}: ${message}${trace}`) as HdkitError;
    err.code = code;
    err.status = resp.status;
    err.traceId = rec.traceId;
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
      // 该文案即最终展示内容（不带 "CODE: " 前缀、不附加引导）。
      // cleanMessage 窄化（round 5）：undefined/空白/纯不可见字符均不覆盖——
      // 保留构建口的代码前缀兜底
      err.message = cleanMessage(asString(rec.message)) || err.message;
    }
    // 版本硬门禁（409 HDKIT_VERSION_TOO_OLD）：结构化升级引导，remediation 才能
    // 穿透 MCP 边界（dev 501fd8b4）。烧核分支的 !err.remediation 守卫保持其排他性。
    // asString 窄化（不用 asText：asText(undefined) === 'undefined' 是真值，
    // `|| undefined` 兜底永不生效，字面量会流进用户可见文案）
    if (code === VERSION_GATE_CODE) {
      applyVersionGate(err, {
        clientVersion: asString(rec.clientVersion),
        minVersion: asString(rec.minVersion),
        message: asString(rec.message),
      });
    }
    // 烧核播报（缺口#5 代码层）：账号核心时长耗尽——上游码 HD.97520422 经
    // hdkitservice 以 HDKIT_UPSTREAM_ERROR 包装透传，客户端按消息内错误码识别。
    // 仅在前面的分支未设置 remediation 时生效（else-if 语义：烧核不覆盖 429 双码/凭证指引）
    if (!err.remediation && asText(rec.message || '').includes('HD.97520422')) {
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

export async function hdkitCheckUser(): Promise<Record<string, unknown>> {
  const result = asRecord(await hdkitRequest('GET', 'check-user', undefined, 30000));
  if (result.userHash) cacheUserHash(result.userHash);
  return result;
}

export async function hdkitGenerateUserHash(): Promise<Record<string, unknown>> {
  const result = asRecord(await hdkitRequest('GET', 'user/generatorUserIDHash', undefined, 30000));
  if (result.userHash) cacheUserHash(result.userHash);
  return result;
}

export async function hdkitSignAgreement(): Promise<Record<string, unknown>> {
  return asRecord(await hdkitRequest('POST', 'sign-agreement', {}));
}

export async function hdkitConnect(options: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const body: Record<string, unknown> = {};
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

  return asRecord(await hdkitRequest('POST', 'connect', body));
}

/**
 * connect 专用网关 502/504 重试（dev e0c8700b）：编排期响应超时不是创建失败，
 * 服务端可能已创建/启动实例，重试通常复用。有界重试、逐档退避，其余状态一律
 * 不重试（含 409 版本门禁与配额/容量/凭证类客户端裁决码——不可重试裁决由
 * hdkit-gate 的瞬时判定与裁决码集合独占）。
 * 重试表经 HW_SANDBOX_CONNECT_RETRY_DELAYS_MS 针脚可覆写（v2 扩展）。
 * 成功路径回显 connect_retries（v2 扩展；dev 仅在错误路径带尝试次数）。
 */
export async function hdkitConnectWithRetry(options: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const delays = connectRetryDelaysMs();
  let retries = 0;
  for (;;) {
    try {
      const result = await hdkitConnect(options);
      if (retries > 0) result.connect_retries = retries;
      return result;
    } catch (error) {
      const transient = isGatewayTransient(error) && !isNonRetryableBusinessError(error);
      if (!transient || retries >= delays.length) {
        (error as { connectRetries?: number }).connectRetries = retries;
        if (transient) decorateExhaustedConnect(error, retries);
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, delays[retries]));
      retries += 1;
    }
  }
}

export async function hdkitCredentials(
  sessionId: unknown,
  devStageId: unknown,
  enableSts = true,
): Promise<Record<string, unknown>> {
  const body: Record<string, unknown> = { enable_sts: enableSts };
  if (sessionId) body.session_id = sessionId;
  if (devStageId) body.dev_stage_id = devStageId;

  if (!sessionId && !devStageId) {
    throw new Error('session_id or dev_stage_id is required');
  }

  return asRecord(await hdkitRequest('POST', 'credentials', body));
}

// ── DevBridge API Key relay 代理（经 hdkitservice 透传 DevStation relay 接口）──
// 凭证由 hdkitRequest 内部 getCredentials() 统一解析，调用方无需传

/**
 * 创建 DevBridge API Key。响应含完整 api_key（仅创建时可见）。
 * 配额满（13002）时服务端返回 429 HDKIT_DEVBRIDGE_KEY_QUOTA_EXCEEDED，
 * hdkitRequest 抛错 err.code 携带该码。
 */
export async function hdkitCreateApiKey(name: string, scope = 'devbridge'): Promise<Record<string, unknown>> {
  return asRecord(await hdkitRequest('POST', 'api-key', { name, scope }));
}

/** 列出当前账号所有 API Key（仅 mask + last_used_at）。数组负载原样返回，由调用方 Array.isArray 守卫。 */
export async function hdkitListApiKeys(): Promise<unknown> {
  return await hdkitRequest('GET', 'api-keys', undefined, 30000);
}

/** 按 keyId 删除 API Key（上游 DELETE 方法）。 */
export async function hdkitDeleteApiKey(keyId: string): Promise<Record<string, unknown>> {
  return asRecord(await hdkitRequest('DELETE', `api-keys/${encodeURIComponent(keyId)}`, undefined, 30000));
}

// The voucher endpoints answer failures with a { claimed: false } shape
// instead of throwing, so the claim flow can warn rather than abort. The
// three endpoints share the fallback; only the service-unavailable wording
// differs.
function voucherFallback(error: unknown, unavailableMessage: string): Record<string, unknown> {
  const err = error as {
    message?: unknown;
    code?: unknown;
    clientVersion?: unknown;
    minVersion?: unknown;
    remediation?: unknown;
  };
  return {
    claimed: false,
    message: typeof err.message === 'string' && err.message ? err.message : unavailableMessage,
    code: err.code,
    ...gatePayloadFields(err),
  };
}

export async function hdkitVoucherStatus(domainId?: string): Promise<Record<string, unknown>> {
  try {
    const path = domainId ? `voucher/status?domain_id=${encodeURIComponent(domainId)}` : 'voucher/status';
    return asRecord(await hdkitRequest('GET', path, undefined, 30000));
  } catch (error) {
    return voucherFallback(error, 'Incentive service unavailable, please try again later');
  }
}

export async function hdkitVoucherClaim(domainId?: string): Promise<Record<string, unknown>> {
  try {
    const body: Record<string, unknown> = domainId ? { domain_id: domainId } : {};
    return asRecord(await hdkitRequest('POST', 'voucher/claim', body));
  } catch (error) {
    return voucherFallback(error, 'Incentive service unavailable, please try again later');
  }
}

export async function hdkitCompetitionVoucherClaim(domainId?: string): Promise<Record<string, unknown>> {
  try {
    const body: Record<string, unknown> = domainId ? { domain_id: domainId } : {};
    return asRecord(await hdkitRequest('POST', 'competition/voucher/claim', body));
  } catch (error) {
    return voucherFallback(error, 'Competition voucher service unavailable, please try again later');
  }
}
