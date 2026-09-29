import { createHash, createHmac } from 'node:crypto';

import { resolveCredentialsWithRuntime } from '../auth/credentials.ts';
import { getProxyDispatcher } from '../proxy/proxy-agent.ts';

const BASE_URL = process.env.HWLINK_ENDPOINT || 'https://devstation.myhuaweicloud.com';

function sha256Hex(data: string): string {
  return createHash('sha256').update(data).digest('hex');
}

function hmacSha256(key: string, data: string): string {
  return createHmac('sha256', key).update(data).digest('hex');
}

function urlEncode(str: string): string {
  const hex = (c: number): string => '%' + (c < 16 ? '0' : '') + c.toString(16).toUpperCase();
  const noEscape = new Set('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.~'.split(''));
  let out = '';
  for (const ch of str) {
    const c = ch.codePointAt(0) ?? 0;
    out += noEscape.has(ch) && c < 0x80 ? ch : c < 0x80 ? hex(c) : encodeURIComponent(ch);
  }
  return out;
}

function timestamp(): string {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '') + 'Z';
}

function sortedQs(query: Record<string, unknown>): string {
  return Object.entries(query)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
}

function signRequest(
  method: string,
  path: string,
  query: Record<string, unknown>,
  body: unknown,
  ak: string,
  sk: string,
  securitytoken: string,
): Record<string, string> {
  const ts = timestamp();
  const host = new URL(BASE_URL).host;

  const cqs = Object.entries(query)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${urlEncode(k)}=${urlEncode(String(v))}`)
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

  const headers: Record<string, string> = {
    host,
    'x-sdk-date': ts,
    Authorization: `SDK-HMAC-SHA256 Access=${ak}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
  if (securitytoken) {
    headers['x-security-token'] = securitytoken;
  }
  return headers;
}

export function getCredentials(): { ak: string; sk: string; securitytoken: string } {
  const credentials = resolveCredentialsWithRuntime();
  // resolveCredentialsWithRuntime is called without allowMissing, so it throws
  // rather than returning null; this guard only narrows the inferred type.
  if (!credentials) {
    throw new Error('Huawei Cloud credentials are not configured.');
  }
  return { ak: credentials.ak, sk: credentials.sk, securitytoken: credentials.securityToken };
}

async function apiGet(
  path: string,
  query: Record<string, unknown> | undefined,
  ak: string,
  sk: string,
  securitytoken: string,
): Promise<{ status: number; data: unknown }> {
  query = query || {};
  const qs = sortedQs(query);
  const fullPath = qs ? `${path}?${qs}` : path;
  const headers = signRequest('GET', path, query, undefined, ak, sk, securitytoken);
  const url = `${BASE_URL}${fullPath}`;
  const dispatcher = await getProxyDispatcher(url);
  const fetchOpts: RequestInit = { headers };
  if (dispatcher) {
    const { fetch: undiciFetch } = await import('undici');
    // Bridge the duplicated undici type packages; see proxy-agent.ts.
    const init = { ...fetchOpts, dispatcher } as unknown as Parameters<typeof undiciFetch>[1];
    const resp = await undiciFetch(url, init);
    return { status: resp.status, data: await resp.json() };
  }
  const resp = await fetch(url, fetchOpts);
  return { status: resp.status, data: await resp.json() };
}

async function apiPost(
  path: string,
  body: unknown,
  ak: string,
  sk: string,
  securitytoken: string,
): Promise<{ status: number; data: unknown }> {
  const headers = signRequest('POST', path, {}, body, ak, sk, securitytoken);
  const url = `${BASE_URL}${path}`;
  const dispatcher = await getProxyDispatcher(url);
  const fetchOpts: RequestInit = {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
  if (dispatcher) {
    const { fetch: undiciFetch } = await import('undici');
    // Bridge the duplicated undici type packages; see proxy-agent.ts.
    const init = { ...fetchOpts, dispatcher } as unknown as Parameters<typeof undiciFetch>[1];
    const resp = await undiciFetch(url, init);
    return { status: resp.status, data: await resp.json() };
  }
  const resp = await fetch(url, fetchOpts);
  return { status: resp.status, data: await resp.json() };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export async function createConnection(
  envId: string,
  ak: string,
  sk: string,
  securitytoken: string,
): Promise<{ wsUrl: string; source: unknown }> {
  const { status, data } = await apiPost(
    `/open-api-public/v1/devenvs/${envId}/connections`,
    { source: 'CLI' },
    ak,
    sk,
    securitytoken,
  );

  const payload = asRecord(data);
  const result = asRecord(payload.result);
  if (status !== 200 || payload.error_code !== '0000' || !result.connection_id) {
    throw new Error(`Failed to create connection: ${JSON.stringify(data)}`);
  }

  const connectionId = String(result.connection_id);
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

    const getPayload = asRecord(getData);
    const getResult = asRecord(getPayload.result);
    const connectionInfo = asRecord(getResult.connection_info);
    const extensions = asRecord(connectionInfo.extensions);
    if (typeof connectionInfo.url === 'string' && connectionInfo.url && extensions.source != null) {
      const u = new URL(connectionInfo.url);
      u.searchParams.set('source', String(extensions.source));
      process.stderr.write(`\rConnection ${connectionId} established (${i}s).\n`);
      return {
        wsUrl: u.toString(),
        source: extensions.source,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  throw new Error(`Timed out waiting for connection ${connectionId}`);
}
