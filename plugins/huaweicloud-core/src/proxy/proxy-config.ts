import { existsSync, readFileSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

export interface ProxyConfigFile {
  https_proxy?: string;
  http_proxy?: string;
  no_proxy?: string;
  HTTPS_PROXY?: string;
  HTTP_PROXY?: string;
  NO_PROXY?: string;
}

export interface ProxySettings {
  proxyUrl?: string;
  noProxyList: string[];
  targetProtocol?: string;
  https_proxy?: string;
  http_proxy?: string;
  no_proxy?: string;
}

function baseHome(): string {
  return process.env.HUAWEICLOUD_HOME || homedir();
}

export function proxyConfigPath(): string {
  return join(baseHome(), '.config', 'huaweicloud', 'proxy.json');
}

// One-key reads off unknown parsed JSON, validated before use: only string
// values are surfaced, so callers never handle a raw `unknown` field.
function readString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === 'string' ? value : undefined;
}

export function readProxyConfig(): ProxyConfigFile | null {
  const path = proxyConfigPath();
  if (!existsSync(path)) return null;
  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (raw === null || typeof raw !== 'object') return null;
    const record = raw as Record<string, unknown>;
    return {
      https_proxy: readString(record, 'https_proxy'),
      http_proxy: readString(record, 'http_proxy'),
      no_proxy: readString(record, 'no_proxy'),
      HTTPS_PROXY: readString(record, 'HTTPS_PROXY'),
      HTTP_PROXY: readString(record, 'HTTP_PROXY'),
      NO_PROXY: readString(record, 'NO_PROXY'),
    };
  } catch {
    return null;
  }
}

export function writeProxyConfig(config: ProxyConfigFile = {}): string {
  const path = proxyConfigPath();
  mkdirSync(dirname(path), { recursive: true });
  const payload = {
    https_proxy: String(config.https_proxy || ''),
    http_proxy: String(config.http_proxy || ''),
    no_proxy: String(config.no_proxy || ''),
  };
  writeFileSync(path, JSON.stringify(payload, null, 2), { encoding: 'utf8' });
  return path;
}

export function clearProxyConfig(): boolean {
  const path = proxyConfigPath();
  if (!existsSync(path)) return false;
  rmSync(path);
  return true;
}

function shouldBypassProxy(hostname: string, noProxyList: string[]): boolean {
  if (!noProxyList.length) return false;
  const lower = hostname.toLowerCase();
  for (const pattern of noProxyList) {
    const p = pattern.trim().toLowerCase();
    if (!p) continue;
    if (p === lower) return true;
    if (p === '*') return true;
    if (p.startsWith('*.')) {
      const domain = p.slice(1);
      if (lower.endsWith(domain) || lower === p.slice(2)) return true;
    }
    if (p.startsWith('.') && lower.endsWith(p)) return true;
    if (lower.endsWith('.' + p)) return true;
  }
  return false;
}

export function getProxySettings(targetUrl?: string | URL): ProxySettings | null {
  const envHttps = process.env.HTTPS_PROXY || process.env.https_proxy || '';
  const envHttp = process.env.HTTP_PROXY || process.env.http_proxy || '';
  const envNoProxy = process.env.NO_PROXY || process.env.no_proxy || '';

  const fileConfig = readProxyConfig();

  const https_proxy = envHttps || fileConfig?.https_proxy || fileConfig?.HTTPS_PROXY || '';
  const http_proxy = envHttp || fileConfig?.http_proxy || fileConfig?.HTTP_PROXY || '';
  const no_proxy = envNoProxy || fileConfig?.no_proxy || fileConfig?.NO_PROXY || '';

  if (!https_proxy && !http_proxy) return null;

  const noProxyList = no_proxy
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  if (targetUrl) {
    const parsed = new URL(targetUrl);
    if (shouldBypassProxy(parsed.hostname, noProxyList)) return null;
    const isHttps = parsed.protocol === 'https:';
    const proxyUrl = isHttps ? https_proxy : http_proxy;
    if (!proxyUrl) return null;
    return { proxyUrl, noProxyList, targetProtocol: parsed.protocol };
  }

  return { https_proxy, http_proxy, no_proxy, noProxyList };
}

export function getProxyUrlForTarget(targetUrl?: string | URL): string | null {
  const settings = getProxySettings(targetUrl);
  if (!settings) return null;
  return settings.proxyUrl || null;
}
