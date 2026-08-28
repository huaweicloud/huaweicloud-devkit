import { getCredentials } from './hwlink-api.mjs';
import { getProxyDispatcher } from '../proxy/proxy-agent.mjs';
import { cacheUserHash } from '../telemetry/telemetry.mjs';

function getHdkitBaseUrl() {
  return process.env.HDKITSERVICE_ENDPOINT || 'https://devkit.huaweicloud.com/rest/developer/server/hdkitservice/';
}

async function hdkitRequest(method, path, body, timeoutMs = 300000) {
  const { ak, sk, securitytoken } = getCredentials();

  const headers = {
    'Content-Type': 'application/json',
    'X-HW-AK': ak,
    'X-HW-SK': sk,
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
    const err = new Error(data.message || `hdkitservice error: ${data.code || resp.status}`);
    err.code = data.code;
    err.status = resp.status;
    err.traceId = data.traceId; // 后端实际返回驼峰 traceId
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
    return { claimed: false, message: 'Incentive service unavailable, please try again later' };
  }
}

export async function hdkitVoucherClaim(domainId) {
  try {
    const body = domainId ? { domain_id: domainId } : {};
    return await hdkitRequest('POST', 'voucher/claim', body);
  } catch (error) {
    return { claimed: false, message: 'Incentive service unavailable, please try again later' };
  }
}
