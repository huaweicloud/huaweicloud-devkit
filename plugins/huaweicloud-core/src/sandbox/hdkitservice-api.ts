import { getProxyDispatcher } from '../proxy/proxy-agent.ts';
import { cacheUserHash } from '../telemetry/telemetry.ts';
import { readInstalledVersion } from '../update-check.ts';
import { getCredentials } from './hwlink-api.ts';

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

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
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
  };
  if (securitytoken) {
    headers['X-HW-Security-Token'] = securitytoken;
  }

  const url = `${getHdkitBaseUrl()}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let resp: HttpResponseLike;
  try {
    const dispatcher = await getProxyDispatcher(url);
    const fetchOpts: RequestInit = {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    };
    if (dispatcher) {
      const { fetch: undiciFetch } = await import('undici');
      // Bridge the duplicated undici type packages (@types/node's undici-types
      // vs the undici npm package); both describe the same runtime RequestInit.
      const init = { ...fetchOpts, dispatcher } as unknown as Parameters<typeof undiciFetch>[1];
      resp = await undiciFetch(url, init);
    } else {
      resp = await fetch(url, fetchOpts);
    }
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
    const trace = data.traceId ? ` [trace: ${String(data.traceId)}]` : '';
    const err = new Error(`${code}: ${String(data.message || 'hdkitservice error')}${trace}`) as HdkitError;
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

export async function hdkitVoucherStatus(domainId?: string): Promise<Record<string, unknown>> {
  try {
    const path = domainId ? `voucher/status?domain_id=${encodeURIComponent(domainId)}` : 'voucher/status';
    return await hdkitRequest('GET', path, undefined, 30000);
  } catch (error) {
    const err = error as { message?: unknown; code?: unknown; remediation?: unknown };
    return {
      claimed: false,
      message:
        typeof err.message === 'string' && err.message
          ? err.message
          : 'Incentive service unavailable, please try again later',
      code: err.code,
      ...(err.remediation ? { remediation: err.remediation } : {}),
    };
  }
}

export async function hdkitVoucherClaim(domainId?: string): Promise<Record<string, unknown>> {
  try {
    const body: Record<string, unknown> = domainId ? { domain_id: domainId } : {};
    return await hdkitRequest('POST', 'voucher/claim', body);
  } catch (error) {
    const err = error as { message?: unknown; code?: unknown; remediation?: unknown };
    return {
      claimed: false,
      message:
        typeof err.message === 'string' && err.message
          ? err.message
          : 'Incentive service unavailable, please try again later',
      code: err.code,
      ...(err.remediation ? { remediation: err.remediation } : {}),
    };
  }
}
