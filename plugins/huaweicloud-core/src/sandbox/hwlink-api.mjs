import crypto from 'node:crypto';

import { resolveCredentialsWithRuntime } from '../auth/credentials.mjs';
import { getProxyDispatcher } from '../proxy/proxy-agent.mjs';

const BASE_URL = process.env.HWLINK_ENDPOINT || 'https://devstation.myhuaweicloud.com';

function sha256Hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function hmacSha256(key, data) {
  return crypto.createHmac('sha256', key).update(data).digest('hex');
}

function urlEncode(str) {
  const hex = (c) => '%' + (c < 16 ? '0' : '') + c.toString(16).toUpperCase();
  const noEscape = new Set('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.~'.split(''));
  let out = '';
  for (const ch of str) {
    const c = ch.codePointAt(0);
    out += noEscape.has(ch) && c < 0x80 ? ch : c < 0x80 ? hex(c) : encodeURIComponent(ch);
  }
  return out;
}

function timestamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '') + 'Z';
}

function sortedQs(query) {
  return Object.entries(query)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}

function signRequest(method, path, query, body, ak, sk, securitytoken) {
  const ts = timestamp();
  const host = new URL(BASE_URL).host;

  const cqs = Object.entries(query)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${urlEncode(k)}=${urlEncode(v)}`)
    .join('&');

  const curi =
    '/' +
    path
      .split('/')
      .filter(Boolean)
      .map((s) => urlEncode(s))
      .join('/') +
    '/';

  const signedHeaders = securitytoken ? 'host;x-sdk-date;x-security-token' : 'host;x-sdk-date';
  const canonicalHeaders = securitytoken
    ? `host:${host}\nx-sdk-date:${ts}\nx-security-token:${securitytoken}\n`
    : `host:${host}\nx-sdk-date:${ts}\n`;

  const bodyStr = body ? JSON.stringify(body) : '';
  const payloadHash = sha256Hex(bodyStr);

  const canonicalRequest = [method, curi, cqs, canonicalHeaders, signedHeaders, payloadHash].join('\n');

  const stringToSign = `SDK-HMAC-SHA256\n${ts}\n${sha256Hex(canonicalRequest)}`;
  const signature = hmacSha256(sk, stringToSign);

  const headers = {
    host,
    'x-sdk-date': ts,
    Authorization: `SDK-HMAC-SHA256 Access=${ak}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
  if (securitytoken) {
    headers['x-security-token'] = securitytoken;
  }
  return headers;
}

export function getCredentials() {
  const credentials = resolveCredentialsWithRuntime();
  return { ak: credentials.ak, sk: credentials.sk, securitytoken: credentials.securityToken };
}

async function apiGet(path, query, ak, sk, securitytoken) {
  query = query || {};
  const qs = sortedQs(query);
  const fullPath = qs ? `${path}?${qs}` : path;
  const headers = signRequest('GET', path, query, undefined, ak, sk, securitytoken);
  const url = `${BASE_URL}${fullPath}`;
  const dispatcher = await getProxyDispatcher(url);
  const fetchOpts = { headers };
  if (dispatcher) {
    fetchOpts.dispatcher = dispatcher;
    const { fetch: undiciFetch } = await import('undici');
    const resp = await undiciFetch(url, fetchOpts);
    return { status: resp.status, data: await resp.json() };
  }
  const resp = await fetch(url, fetchOpts);
  return { status: resp.status, data: await resp.json() };
}

async function apiPost(path, body, ak, sk, securitytoken) {
  const headers = signRequest('POST', path, {}, body, ak, sk, securitytoken);
  const url = `${BASE_URL}${path}`;
  const dispatcher = await getProxyDispatcher(url);
  const fetchOpts = {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
  if (dispatcher) {
    fetchOpts.dispatcher = dispatcher;
    const { fetch: undiciFetch } = await import('undici');
    const resp = await undiciFetch(url, fetchOpts);
    return { status: resp.status, data: await resp.json() };
  }
  const resp = await fetch(url, fetchOpts);
  return { status: resp.status, data: await resp.json() };
}

// Transient/restriction-class error codes from the connection API.
// HDKIT_SUB_ACCOUNT_RESTRICTED and HD.83700029 are the SAME server-side
// transient condition under two different codes (measured 2026-10-21/22: the
// same AK/SK and the same request body got HD.83700029 on the 21st and
// HDKIT_SUB_ACCOUNT_RESTRICTED on the 22nd — the code drifts between calls).
// The message accuses the account of being a restricted sub-account, but a
// fully compliant account (realnameVerified:true, agreementSigned:true, no
// sub-users) got the SAME error and the identical request succeeded 25 minutes
// later — the only action that helped was waiting. Retry these instead of
// failing, and NEVER surface the server's "switch to the main account" advice
// as actionable: acting on it is an irreversible, account-wide operation
// triggered by a transient state.
const TRANSIENT_CONNECTION_CODES = new Set(['HDKIT_SUB_ACCOUNT_RESTRICTED', 'HD.83700029']);

// Classify a connection-API failure (exported for tests). Returns
// 'transient_restricted' / 'retryable_server' (retried with backoff) or
// 'fatal' (fails fast, no retry).
export function classifyConnectionError(data, status) {
  const code = String(data?.error_code || data?.code || '').toUpperCase();
  if (TRANSIENT_CONNECTION_CODES.has(code)) return 'transient_restricted';
  if (status === 429 || (status >= 500 && status < 600)) return 'retryable_server';
  return 'fatal';
}

// Default backoff between connection retries, in ms. The measured incident
// self-resolved in ~25 minutes, so three spaced retries cover the short end
// without blocking exec callers for long.
export const CONNECTION_RETRY_BACKOFF_MS = [1000, 4000, 10000];

const CONNECTION_RETRY_HINT =
  'This is a TRANSIENT server-side state, NOT an account problem: the same request typically succeeds after a short wait ' +
  '(measured 2026-10-22: HDKIT_SUB_ACCOUNT_RESTRICTED self-resolved in 25 minutes for a fully compliant account — realname verified, agreement signed, no sub-users). ' +
  'Do NOT switch to the main account, do NOT modify IAM users or credentials based on this error — retry with backoff instead.';

async function waitForConnection(connectionId, envId, ak, sk, securitytoken) {
  const maxAttempts = 60;

  for (let i = 0; i < maxAttempts; i++) {
    process.stderr.write(`\rWaiting for connection ${connectionId}... (${i}s)`);
    const { data: getData } = await apiGet(
      `/open-api-public/v1/devenvs/${envId}/connections/${connectionId}`,
      {},
      ak,
      sk,
      securitytoken,
    );

    if (getData?.result?.connection_info?.url && getData.result.connection_info.extensions?.source != null) {
      const u = new URL(getData.result.connection_info.url);
      u.searchParams.set('source', String(getData.result.connection_info.extensions.source));
      process.stderr.write(`\rConnection ${connectionId} established (${i}s).\n`);
      return {
        wsUrl: u.toString(),
        source: getData.result.connection_info.extensions.source,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  throw new Error(`Timed out waiting for connection ${connectionId}`);
}

export async function createConnection(envId, ak, sk, securitytoken, { maxRetries = 3, backoffMs } = {}) {
  const backoff = backoffMs || CONNECTION_RETRY_BACKOFF_MS;
  const maxAttempts = maxRetries + 1;
  let lastFailure = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (attempt > 1) {
      const wait = backoff[Math.min(attempt - 2, backoff.length - 1)];
      process.stderr.write(
        `createConnection: retryable error (${lastFailure.kind}) — retry ${attempt - 1}/${maxRetries} in ${wait}ms\n`,
      );
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
    const { status, data } = await apiPost(
      `/open-api-public/v1/devenvs/${envId}/connections`,
      { source: 'CLI' },
      ak,
      sk,
      securitytoken,
    );

    if (status === 200 && data?.error_code === '0000' && data?.result?.connection_id) {
      return await waitForConnection(data.result.connection_id, envId, ak, sk, securitytoken);
    }

    const kind = classifyConnectionError(data, status);
    if (kind === 'fatal') {
      throw new Error(`Failed to create connection: ${JSON.stringify(data)}`);
    }
    lastFailure = { kind, status, data };
  }

  const err = new Error(
    `Failed to create connection after ${maxAttempts} attempts (${lastFailure.kind}): ${JSON.stringify(lastFailure.data)}. ${CONNECTION_RETRY_HINT}`,
  );
  err.code = String(lastFailure.data?.error_code || `HTTP_${lastFailure.status}`);
  err.kind = lastFailure.kind;
  err.retryable = true;
  err.suggestedRetryAfterMs = backoff[backoff.length - 1];
  throw err;
}
