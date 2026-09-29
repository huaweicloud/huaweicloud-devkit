import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getProxyDispatcher } from './proxy/proxy-agent.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_PATH = join(__dirname, 'data', 'icons-manifest.v1.json');
const MANIFEST_URL = 'https://open.huaweicloud.com/openplatform/icons/manifest.v1.json';
const ICONS_PAGE_URL = 'https://open.huaweicloud.com/openplatform/icons.html';
const HTTP_TIMEOUT_MS = 10000;
const MAX_RESULTS = 5;

interface IconLogo {
  source_url?: string;
  local_path?: string;
}

interface IconArchitecture {
  status?: string;
  local_path?: string;
}

interface IconEntry {
  id: string;
  name: string;
  category: string;
  subcategory: string;
  description: string;
  product_url: string;
  aliases: string[];
  tags: string[];
  logo: IconLogo;
  architecture?: IconArchitecture;
}

interface IconManifest {
  generated_at?: string;
  icons: IconEntry[];
}

interface IconIndex {
  aliases: Record<string, string[]>;
  tags: Record<string, string[]>;
  categories: Record<string, string>;
  descriptions: Record<string, string>;
}

interface IconResult {
  id: string;
  name: string;
  category: string;
  subcategory?: string;
  description?: string;
  aliases: string[];
  product_url: string;
  logo: IconLogo;
  architecture?: IconArchitecture;
  score: number;
  matched: string[];
}

let cachedManifest: { manifest: IconManifest; source: 'snapshot' | 'live' } | null = null;

export function clearIconCache(): void {
  cachedManifest = null;
}

// Narrow parsed JSON at the boundary: unknown fields are validated field by
// field into a fully typed manifest, so scoring code never touches `unknown`.
function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function toIconLogo(value: unknown): IconLogo {
  const raw = asRecord(value);
  return {
    source_url: typeof raw.source_url === 'string' ? raw.source_url : undefined,
    local_path: typeof raw.local_path === 'string' ? raw.local_path : undefined,
  };
}

function toIconArchitecture(value: unknown): IconArchitecture | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const raw = asRecord(value);
  return {
    status: typeof raw.status === 'string' ? raw.status : undefined,
    local_path: typeof raw.local_path === 'string' ? raw.local_path : undefined,
  };
}

function toIconEntry(value: unknown): IconEntry {
  const raw = asRecord(value);
  return {
    id: typeof raw.id === 'string' ? raw.id : '',
    name: typeof raw.name === 'string' ? raw.name : '',
    category: typeof raw.category === 'string' ? raw.category : '',
    subcategory: typeof raw.subcategory === 'string' ? raw.subcategory : '',
    description: typeof raw.description === 'string' ? raw.description : '',
    product_url: typeof raw.product_url === 'string' ? raw.product_url : '',
    aliases: Array.isArray(raw.aliases) ? raw.aliases.map((a) => String(a)) : [],
    tags: Array.isArray(raw.tags) ? raw.tags.map((t) => String(t)) : [],
    logo: toIconLogo(raw.logo),
    architecture: toIconArchitecture(raw.architecture),
  };
}

function parseManifest(value: unknown): IconManifest | null {
  const raw = asRecord(value);
  if (!Array.isArray(raw.icons)) return null;
  return {
    generated_at: typeof raw.generated_at === 'string' ? raw.generated_at : undefined,
    icons: raw.icons.map((icon) => toIconEntry(icon)),
  };
}

async function fetchLiveManifest(): Promise<IconManifest> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    const dispatcher = await getProxyDispatcher(MANIFEST_URL);
    const fetchOpts: RequestInit & { dispatcher?: unknown } = {
      headers: { 'User-Agent': 'huaweicloud-devkit/1.0' },
      signal: controller.signal,
    };
    if (dispatcher) fetchOpts.dispatcher = dispatcher;
    const resp = await fetch(MANIFEST_URL, fetchOpts);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data: unknown = await resp.json();
    const manifest = parseManifest(data);
    if (!manifest) {
      throw new Error('Manifest is missing the icons array.');
    }
    return manifest;
  } finally {
    clearTimeout(timer);
  }
}

function loadSnapshot(): IconManifest {
  const manifest = parseManifest(JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8')));
  if (!manifest) {
    throw new Error('Bundled icons manifest is corrupted.');
  }
  return manifest;
}

async function loadManifest(): Promise<{ manifest: IconManifest; source: 'snapshot' | 'live' }> {
  if (cachedManifest) return cachedManifest;
  if (process.env.HUAWEICLOUD_ICONS_OFFLINE === '1') {
    cachedManifest = { manifest: loadSnapshot(), source: 'snapshot' };
    return cachedManifest;
  }
  try {
    const live = await fetchLiveManifest();
    cachedManifest = { manifest: live, source: 'live' };
  } catch {
    cachedManifest = { manifest: loadSnapshot(), source: 'snapshot' };
  }
  return cachedManifest;
}

function normalizeToken(token: string): string {
  return token.toLowerCase();
}

function scoreIcon(icon: IconEntry, tokens: string[], index: IconIndex): [number, string[]] {
  let total = 0;
  const matched: string[] = [];
  for (const token of tokens) {
    let best = 0;
    const id = (icon.id || '').toLowerCase();
    const name = (icon.name || '').toLowerCase();
    if (id === token || (index.aliases[token] || []).includes(id)) {
      best = 10;
    } else if (name === token) {
      best = 9;
    } else if (name.startsWith(token)) {
      best = 8;
    } else if (name.includes(token)) {
      best = 7;
    } else if (id.includes(token)) {
      best = 5;
    } else if ((index.aliases[id] || []).some((a) => a.includes(token))) {
      best = 6;
    } else if ((index.tags[id] || []).some((t) => t.includes(token))) {
      best = 4;
    } else if ((index.categories[id] || '').includes(token)) {
      best = 3;
    } else if ((index.descriptions[id] || '').includes(token)) {
      best = 2;
    }
    if (best > 0) {
      total += best;
      matched.push(token);
    }
  }
  return [total, matched];
}

export async function getServiceIcon(service: string = '', category: string = '') {
  const query = String(service || '').trim();
  const catFilter = String(category || '')
    .trim()
    .toLowerCase();
  if (!query && !catFilter) {
    return {
      ok: false,
      error:
        'service or category is required. Examples: ecs, obs, modelarts, 对象存储, 虚拟私有云, or a category such as 计算 / 存储 / 人工智能.',
      iconsPageUrl: ICONS_PAGE_URL,
    };
  }
  const { manifest, source } = await loadManifest();
  const tokens = query
    .replace(/[,;]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => normalizeToken(t));

  const index: IconIndex = { aliases: {}, tags: {}, categories: {}, descriptions: {} };
  for (const icon of manifest.icons) {
    const id = (icon.id || '').toLowerCase();
    index.aliases[id] = (icon.aliases || []).map((a) => String(a).toLowerCase());
    index.tags[id] = (icon.tags || []).map((t) => String(t).toLowerCase());
    index.categories[id] = [
      String(icon.category || '').toLowerCase(),
      String(icon.subcategory || '').toLowerCase(),
    ].join(' ');
    index.descriptions[id] = String(icon.description || '').toLowerCase();
  }

  const results: IconResult[] = [];
  for (const icon of manifest.icons) {
    const categoryMatches = !catFilter || String(icon.category || '').toLowerCase() === catFilter;
    if (!categoryMatches) continue;
    const [score, matched]: [number, string[]] = tokens.length ? scoreIcon(icon, tokens, index) : [0, []];
    if (tokens.length && score === 0) continue;
    results.push({
      id: icon.id,
      name: icon.name,
      category: icon.category,
      subcategory: icon.subcategory || undefined,
      description: icon.description || undefined,
      aliases: icon.aliases,
      product_url: icon.product_url,
      logo: {
        source_url: icon.logo?.source_url,
        local_path: icon.logo?.local_path,
      },
      architecture: icon.architecture
        ? { status: icon.architecture.status, local_path: icon.architecture.local_path }
        : undefined,
      score,
      matched,
    });
  }
  results.sort((a, b) => b.score - a.score);

  return {
    ok: true,
    query,
    category: catFilter || undefined,
    source,
    manifestGeneratedAt: manifest.generated_at,
    count: results.length,
    iconsPageUrl: ICONS_PAGE_URL,
    note:
      source === 'live'
        ? 'Live manifest from open.huaweicloud.com.'
        : 'Live manifest unreachable; using bundled snapshot. Upgrade the package to refresh the bundled snapshot.',
    results: results.slice(0, MAX_RESULTS),
  };
}
