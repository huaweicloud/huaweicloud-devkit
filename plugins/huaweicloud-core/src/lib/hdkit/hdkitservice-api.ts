import { fetchWithProxy } from '../../proxy/proxy-agent.ts';
import { cacheUserHash } from '../../telemetry/telemetry.ts';
import { detectAgent } from '../../telemetry/agent-detect.ts';
import { readInstalledVersion } from '../../update-check.ts';
import { getCredentials } from './hwlink-api.ts';
import { asRecord } from '../as-record.ts';
import { asText } from '../as-text.ts';

interface HdkitError extends Error {
  code?: string;
  status?: number;
  traceId?: unknown;
  remediation?: { hint: string; steps: string[] };
}

// Structural surface shared by the global and undici Response implementations;
// only ok/status/text are consumed below.
interface HttpResponseLike {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

function getHdkitBaseUrl(): string {
  return process.env.HDKITSERVICE_ENDPOINT || 'https://devkit.huaweicloud.com/rest/developer/server/hdkitservice/';
}

async function hdkitRequest(
  method: string,
  path: string,
  body: unknown,
  timeoutMs = 300000,
): Promise<Record<string, unknown>> {
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

  const text = await resp.text();
  let data: Record<string, unknown>;
  try {
    data = asRecord(JSON.parse(text));
  } catch {
    throw new Error(`hdkitservice returned non-JSON (status ${resp.status}): ${text.slice(0, 200)}`);
  }

  if (!resp.ok) {
    const rawCode = data.code;
    const code = typeof rawCode === 'string' && rawCode ? rawCode : `HTTP_${resp.status}`;
    const trace = data.traceId ? ` [trace: ${asText(data.traceId)}]` : '';
    const err = new Error(`${code}: ${asText(data.message || 'hdkitservice error')}${trace}`) as HdkitError;
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
    throw err;
  }

  return data;
}

export async function hdkitCheckUser(): Promise<Record<string, unknown>> {
  const result = await hdkitRequest('GET', 'check-user', undefined, 30000);
  if (result.userHash) cacheUserHash(result.userHash);
  return result;
}

export async function hdkitGenerateUserHash(): Promise<Record<string, unknown>> {
  const result = await hdkitRequest('GET', 'user/generatorUserIDHash', undefined, 30000);
  if (result.userHash) cacheUserHash(result.userHash);
  return result;
}

export async function hdkitSignAgreement(): Promise<Record<string, unknown>> {
  return await hdkitRequest('POST', 'sign-agreement', {});
}

export async function hdkitConnect(options: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const body: Record<string, unknown> = {};
  if (options.source) body.source = options.source;
  if (options.env) body.env = options.env;
  if (options.git) body.git = options.git;
  if (options.template_id) body.template_id = options.template_id;
  if (options.flavor_id) body.flavor_id = options.flavor_id;

  return await hdkitRequest('POST', 'connect', body);
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

  return await hdkitRequest('POST', 'credentials', body);
}

// The voucher endpoints answer failures with a { claimed: false } shape
// instead of throwing, so the claim flow can warn rather than abort. The
// three endpoints share the fallback; only the service-unavailable wording
// differs.
function voucherFallback(error: unknown, unavailableMessage: string): Record<string, unknown> {
  const err = error as { message?: unknown; code?: unknown; remediation?: unknown };
  return {
    claimed: false,
    message: typeof err.message === 'string' && err.message ? err.message : unavailableMessage,
    code: err.code,
    ...(err.remediation ? { remediation: err.remediation } : {}),
  };
}

export async function hdkitVoucherStatus(domainId?: string): Promise<Record<string, unknown>> {
  try {
    const path = domainId ? `voucher/status?domain_id=${encodeURIComponent(domainId)}` : 'voucher/status';
    return await hdkitRequest('GET', path, undefined, 30000);
  } catch (error) {
    return voucherFallback(error, 'Incentive service unavailable, please try again later');
  }
}

export async function hdkitVoucherClaim(domainId?: string): Promise<Record<string, unknown>> {
  try {
    const body: Record<string, unknown> = domainId ? { domain_id: domainId } : {};
    return await hdkitRequest('POST', 'voucher/claim', body);
  } catch (error) {
    return voucherFallback(error, 'Incentive service unavailable, please try again later');
  }
}

export async function hdkitCompetitionVoucherClaim(domainId?: string): Promise<Record<string, unknown>> {
  try {
    const body: Record<string, unknown> = domainId ? { domain_id: domainId } : {};
    return await hdkitRequest('POST', 'competition/voucher/claim', body);
  } catch (error) {
    return voucherFallback(error, 'Competition voucher service unavailable, please try again later');
  }
}
