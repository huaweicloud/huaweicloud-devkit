import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { asText } from './lib/as-text.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_JSON = resolve(__dirname, '..', '..', '..', 'package.json');

export const KOO_CLI_BASE = 'https://cn-north-4-hdn-koocli.obs.cn-north-4.myhuaweicloud.com/cli';

const VERSION_RE = /\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/;

export function getKooCliVersion(): string | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const kooCliVersion = (parsed as Record<string, unknown>).kooCliVersion;
    return typeof kooCliVersion === 'string' && kooCliVersion ? kooCliVersion : null;
  } catch {
    return null;
  }
}

export function parseHcloudVersion(out: unknown): string | null {
  if (!out) return null;
  const match = asText(out).match(VERSION_RE);
  return match ? match[0] : null;
}

// String#split never returns an empty array, so the [0] indexes below are defined.
export function compareVersion(a: unknown, b: unknown): number {
  const pa = asText(a || '')
    .split(/[-+]/)[0]!
    .split('.')
    .map((n) => Number.parseInt(n, 10) || 0);
  const pb = asText(b || '')
    .split(/[-+]/)[0]!
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

export function kooCliDownloadBase(): string {
  return `${KOO_CLI_BASE}/${getKooCliVersion() || 'latest'}`;
}
