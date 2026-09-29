import crypto from 'node:crypto';
import type { Dispatcher } from 'undici';

import { getProxyDispatcher } from '../proxy/proxy-agent.ts';

function iamBaseUrl(): string {
  return process.env.HW_IAM_ENDPOINT || 'https://iam.myhuaweicloud.com';
}

function sha256Hex(data: string): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function hmacSha256(key: string, data: string): string {
  return crypto.createHmac('sha256', key).update(data).digest('hex');
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

function signIamRequest(
  path: string,
  query: Record<string, string>,
  ak: string,
  sk: string,
  securitytoken?: string,
): Record<string, string> {
  const ts = timestamp();
  const host = new URL(iamBaseUrl()).host;

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

  const payloadHash = sha256Hex('');
  const canonicalRequest = ['GET', curi, cqs, canonicalHeaders, signedHeaders, payloadHash].join('\n');
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

interface IamProject {
  id: string;
  name?: unknown;
}

// One-property reads off unknown parsed JSON; only an object with a non-empty
// string id is a usable project (IAM project ids are strings).
function toIamProject(value: unknown): IamProject | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as { id?: unknown; name?: unknown };
  if (typeof record.id !== 'string' || record.id === '') return null;
  return { id: record.id, name: record.name };
}

function projectForRegion(projects: unknown[], region?: string): string | null {
  const usable = projects.map((p) => toIamProject(p)).filter((p): p is IamProject => p !== null);
  if (region) {
    const match = usable.find((p) => p.name === region);
    if (match) return match.id;
  }
  return usable.find((p) => p.id)?.id || null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export interface ValidateIamCredentialsOptions {
  ak?: string;
  sk?: string;
  securityToken?: string;
  region?: string;
  timeoutMs?: number;
}

export interface IamValidationResult {
  valid: boolean;
  projectId: string | null;
  error: string | null;
  warning?: string | null;
  skipped?: boolean;
}

/**
 * Validate AK/SK by calling IAM KeystoneListProjects (read-only) with
 * SDK-HMAC-SHA256 request signing. A wrong SK produces an invalid signature,
 * which IAM rejects with HTTP 401 before any project data is returned.
 *
 * Returns { valid, projectId, error, warning }:
 * - valid: true when IAM verified the signature (or the rejection is not
 *   authentication-related), false when the credentials are unusable.
 * - projectId: first project matching `region`, else the first visible project.
 * - warning: set when credentials passed but project discovery was denied.
 */
export async function validateIamCredentials({
  ak,
  sk,
  securityToken,
  region,
  timeoutMs = 15000,
}: ValidateIamCredentialsOptions = {}): Promise<IamValidationResult> {
  if (!ak || !sk) {
    return { valid: false, projectId: null, error: 'AK and SK are both required for credential validation.' };
  }

  const base = iamBaseUrl();
  const path = '/v3/projects';
  const query: Record<string, string> = region ? { name: region } : {};
  const qs = Object.entries(query)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
  const url = `${base}${path}${qs ? `?${qs}` : ''}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let resp: { status: number; text(): Promise<string> };
  try {
    const headers = signIamRequest(path, query, ak, sk, securityToken);
    const fetchOpts: RequestInit & { dispatcher?: Dispatcher } = { headers, signal: controller.signal };
    const dispatcher = await getProxyDispatcher(url);
    if (dispatcher) {
      fetchOpts.dispatcher = dispatcher;
      const { fetch: undiciFetch } = await import('undici');
      // Bridge the duplicated undici type packages (@types/node's undici-types
      // vs the undici npm package); both describe the same runtime RequestInit.
      const init = fetchOpts as unknown as Parameters<typeof undiciFetch>[1];
      resp = await undiciFetch(url, init);
    } else {
      resp = await fetch(url, fetchOpts);
    }
  } catch (error) {
    return {
      valid: false,
      projectId: null,
      skipped: true,
      error: `IAM validation request failed (treating credentials as unverified): ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  } finally {
    clearTimeout(timer);
  }

  const text = await resp.text();
  let data: unknown = null;
  try {
    data = JSON.parse(text);
  } catch {}

  if (resp.status === 200) {
    const projects = Array.isArray(asRecord(data).projects) ? (asRecord(data).projects as unknown[]) : [];
    return { valid: true, projectId: projectForRegion(projects, region), error: null, warning: null };
  }

  if (resp.status === 401) {
    const errMsg = asRecord(asRecord(data).error).message;
    const msg = typeof errMsg === 'string' && errMsg ? errMsg : text.slice(0, 200);
    return {
      valid: false,
      projectId: null,
      error: `IAM rejected the credentials (HTTP 401: ${msg}). The AK/SK is invalid - check the SK for typos or expired security tokens.`,
    };
  }

  if (resp.status === 403) {
    return {
      valid: true,
      projectId: null,
      error: null,
      warning: `Credentials signed successfully but project listing was denied (HTTP 403). Continuing without project_id.`,
    };
  }

  return {
    valid: false,
    projectId: null,
    skipped: true,
    error: `Unexpected IAM response (HTTP ${resp.status}): ${text.slice(0, 200)}`,
  };
}
