import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_JSON = resolve(__dirname, '..', '..', '..', 'package.json');

export const KOO_CLI_BASE = 'https://cn-north-4-hdn-koocli.obs.cn-north-4.myhuaweicloud.com/cli';

const VERSION_RE = /\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/;

export function getKooCliVersion() {
  try {
    const pkg = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8'));
    return pkg.kooCliVersion || null;
  } catch {
    return null;
  }
}

export function parseHcloudVersion(out) {
  if (!out) return null;
  const match = String(out).match(VERSION_RE);
  return match ? match[0] : null;
}

export function compareVersion(a, b) {
  const pa = String(a || '')
    .split(/[-+]/)[0]
    .split('.')
    .map((n) => Number.parseInt(n, 10) || 0);
  const pb = String(b || '')
    .split(/[-+]/)[0]
    .split('.')
    .map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const va = pa[i] || 0;
    const vb = pb[i] || 0;
    if (va > vb) return 1;
    if (va < vb) return -1;
  }
  return 0;
}

export function kooCliDownloadBase() {
  return `${KOO_CLI_BASE}/${getKooCliVersion() || 'latest'}`;
}
