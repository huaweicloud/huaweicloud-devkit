import { existsSync, readFileSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

function baseHome() {
  return process.env.HUAWEICLOUD_HOME || homedir();
}

export function proxyConfigPath() {
  return join(baseHome(), '.config', 'huaweicloud', 'proxy.json');
}

export function readProxyConfig() {
  const path = proxyConfigPath();
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

export function writeProxyConfig(config = {}) {
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

export function clearProxyConfig() {
  const path = proxyConfigPath();
  if (!existsSync(path)) return false;
  rmSync(path);
  return true;
}

function ipv4ToInt(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const v = Number(part);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return BigInt(n);
}

function ipv6ToBigInt(ip) {
  let addr = ip.toLowerCase();
  if (addr === '::') addr = '0:0:0:0:0:0:0:0';
  const [head, tail] = addr.split('::');
  const headGroups = head ? head.split(':').filter(Boolean) : [];
  const tailGroups = tail ? tail.split(':').filter(Boolean) : [];
  if (addr.includes('::')) {
    const missing = 8 - headGroups.length - tailGroups.length;
    if (missing < 0) return null;
    const groups = [...headGroups, ...Array(missing).fill('0'), ...tailGroups];
    if (groups.length !== 8) return null;
    return groupsToBigInt(groups);
  }
  const groups = head ? head.split(':') : [];
  if (groups.length !== 8) return null;
  return groupsToBigInt(groups);
}

function groupsToBigInt(groups) {
  let n = 0n;
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    n = (n << 16n) | BigInt(parseInt(g, 16));
  }
  return n;
}

function ipv4MappedV6ToBigInt(ip) {
  // ::ffff:a.b.c.d — IPv4-mapped IPv6. Compare against IPv4 CIDR too.
  const m = ip.match(/^::ffff:([0-9.]+)$/i);
  if (!m) return null;
  const v4 = ipv4ToInt(m[1]);
  if (v4 === null) return null;
  return v4;
}

function parseCidr(pattern) {
  const slash = pattern.lastIndexOf('/');
  if (slash < 0) return null;
  const ipPart = pattern.slice(0, slash);
  const maskPart = pattern.slice(slash + 1);
  if (!/^\d{1,3}$/.test(maskPart)) return null;
  const prefix = Number(maskPart);
  if (ipPart.includes(':')) {
    const mapped = ipv4MappedV6ToBigInt(ipPart);
    if (mapped !== null) {
      if (prefix < 0 || prefix > 32) return null;
      const mask = prefix === 0 ? 0n : ((1n << 32n) - 1n) ^ ((1n << (32n - BigInt(prefix))) - 1n);
      return { bits: 32n, base: mapped, mask };
    }
    const base = ipv6ToBigInt(ipPart);
    if (base === null) return null;
    if (prefix < 0 || prefix > 128) return null;
    const mask = prefix === 0 ? 0n : ((1n << 128n) - 1n) ^ ((1n << (128n - BigInt(prefix))) - 1n);
    return { bits: 128n, base, mask };
  }
  const base = ipv4ToInt(ipPart);
  if (base === null) return null;
  if (prefix < 0 || prefix > 32) return null;
  const mask = prefix === 0 ? 0n : ((1n << 32n) - 1n) ^ ((1n << (32n - BigInt(prefix))) - 1n);
  return { bits: 32n, base, mask };
}

function ipInCidr(hostname, cidr) {
  if (cidr.bits === 32n) {
    const v4 = ipv4ToInt(hostname);
    if (v4 !== null) return (v4 & cidr.mask) === (cidr.base & cidr.mask);
    const mapped = ipv4MappedV6ToBigInt(hostname);
    if (mapped !== null) return (mapped & cidr.mask) === (cidr.base & cidr.mask);
    return false;
  }
  const v6 = ipv6ToBigInt(hostname);
  if (v6 !== null) return (v6 & cidr.mask) === (cidr.base & cidr.mask);
  return false;
}

export function shouldBypassProxy(hostname, noProxyList) {
  if (!noProxyList.length) return false;
  const lower = hostname.toLowerCase();
  for (const pattern of noProxyList) {
    const p = pattern.trim().toLowerCase();
    if (!p) continue;
    if (p === lower) return true;
    if (p === '*') return true;
    if (p.includes('/')) {
      const cidr = parseCidr(p);
      if (cidr && ipInCidr(lower, cidr)) return true;
    }
    if (p.startsWith('*.')) {
      const domain = p.slice(1);
      if (lower.endsWith(domain) || lower === p.slice(2)) return true;
    }
    if (p.startsWith('.') && lower.endsWith(p)) return true;
    if (lower.endsWith('.' + p)) return true;
  }
  return false;
}

export function getProxySettings(targetUrl) {
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

export function getProxyUrlForTarget(targetUrl) {
  const settings = getProxySettings(targetUrl);
  if (!settings) return null;
  return settings.proxyUrl || null;
}
