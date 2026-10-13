import crypto from 'node:crypto';

import { getProxyDispatcher } from '../proxy/proxy-agent.mjs';
import { errorFromTable } from './guidance.mjs';

function iamBaseUrl() {
  return process.env.HW_IAM_ENDPOINT || 'https://iam.myhuaweicloud.com';
}

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

function signIamRequest(path, query, ak, sk, securitytoken) {
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

function projectForRegion(projects, region) {
  if (region) {
    const match = projects.find((p) => p && p.name === region && p.id);
    if (match) return match.id;
  }
  return projects.find((p) => p && p.id)?.id || null;
}

/**
 * Validate AK/SK by calling IAM KeystoneListProjects (read-only) with
 * SDK-HMAC-SHA256 request signing. A wrong SK produces an invalid signature,
 * which IAM rejects with HTTP 401 before any project data is returned.
 *
 * Returns { valid, projectId, error, warning, code, messageZh, action, nextStep }:
 * - valid: true when IAM verified the signature (or the rejection is not
 *   authentication-related), false when the credentials are unusable.
 * - projectId: first project matching `region`, else the first visible project.
 * - warning: set when credentials passed but project discovery was denied.
 * - code/messageZh/action/nextStep: unified #900 shape from the shared
 *   ERROR_TABLE (guidance.mjs). The English `error`/`warning` detail text is
 *   intentionally kept — existing consumers (tools.mjs sandbox_credentials,
 *   external string-matching tests) rely on it.
 */
export async function validateIamCredentials({ ak, sk, securityToken, region, timeoutMs = 15000 } = {}) {
  if (!ak || !sk) {
    const e = errorFromTable('HDKIT_CRED_MISSING');
    return {
      valid: false,
      projectId: null,
      error: 'AK and SK are both required for credential validation.',
      code: e.code,
      messageZh: e.messageZh,
      action: e.action,
      nextStep: e.nextStep,
    };
  }

  const base = iamBaseUrl();
  const path = '/v3/projects';
  const query = region ? { name: region } : {};
  const qs = Object.entries(query)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
  const url = `${base}${path}${qs ? `?${qs}` : ''}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let resp;
  try {
    const headers = signIamRequest(path, query, ak, sk, securityToken);
    const fetchOpts = { headers, signal: controller.signal };
    const dispatcher = await getProxyDispatcher(url);
    if (dispatcher) {
      fetchOpts.dispatcher = dispatcher;
      const { fetch: undiciFetch } = await import('undici');
      resp = await undiciFetch(url, fetchOpts);
    } else {
      resp = await fetch(url, fetchOpts);
    }
  } catch (error) {
    const e = errorFromTable('HDKIT_CRED_UNEXPECTED', error.message);
    return {
      valid: false,
      projectId: null,
      skipped: true,
      error: `IAM validation request failed (treating credentials as unverified): ${error.message}`,
      code: e.code,
      messageZh: e.messageZh,
      action: e.action,
      nextStep: e.nextStep,
    };
  } finally {
    clearTimeout(timer);
  }

  const text = await resp.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {}

  if (resp.status === 200) {
    const projects = Array.isArray(data?.projects) ? data.projects : [];
    return { valid: true, projectId: projectForRegion(projects, region), error: null, warning: null };
  }

  if (resp.status === 401) {
    const msg = data?.error?.message || text.slice(0, 200);
    const e = errorFromTable('HDKIT_CRED_INVALID', `HTTP 401: ${msg}`);
    return {
      valid: false,
      projectId: null,
      error: `IAM rejected the credentials (HTTP 401: ${msg}). The AK/SK is invalid - check the SK for typos or expired security tokens.`,
      code: e.code,
      messageZh: e.messageZh,
      action: e.action,
      nextStep: e.nextStep,
    };
  }

  if (resp.status === 403) {
    const msg = data?.error?.message || text.slice(0, 200);
    const e = errorFromTable('HDKIT_CRED_FORBIDDEN', `HTTP 403: ${msg}`);
    return {
      valid: true,
      projectId: null,
      error: null,
      warning: `Credentials signed successfully but project listing was denied (HTTP 403). Continuing without project_id.`,
      code: e.code,
      messageZh: e.messageZh,
      action: e.action,
      nextStep: e.nextStep,
    };
  }

  const e = errorFromTable('HDKIT_CRED_UNEXPECTED', `HTTP ${resp.status}`);
  return {
    valid: false,
    projectId: null,
    skipped: true,
    error: `Unexpected IAM response (HTTP ${resp.status}): ${text.slice(0, 200)}`,
    code: e.code,
    messageZh: e.messageZh,
    action: e.action,
    nextStep: e.nextStep,
  };
}
