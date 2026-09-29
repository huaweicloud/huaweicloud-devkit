import { getProxyDispatcher } from './proxy/proxy-agent.ts';

const INDEX_URL =
  'https://gitcode.com/api/v5/repos/2501_91318609/skills-for-index/contents/skills-index/index.json?ref=main';
const CN_EN_MAP_URL =
  'https://gitcode.com/api/v5/repos/2501_91318609/skills-for-index/contents/skills-index/cn-en-map.json?ref=main';
const HTTP_TIMEOUT_MS = 10000;

const GENERIC_KEYWORDS = new Set([
  '华为云',
  'huawei',
  'huawei cloud',
  '云',
  'cloud',
  '技能',
  'skill',
  'skills',
  '所有',
  'all',
  '全部',
  '有什么',
  '有哪些',
  '相关',
  '列表',
  'list',
  '查找',
  '搜索',
  '发现',
  '浏览',
  'find',
  'search',
  'discover',
  'browse',
  'show',
  'explore',
  'agent',
  '市场',
  'market',
  '类目',
  'category',
  '安装',
  'install',
]);

interface MarketSkill {
  name?: string;
  description?: string;
  service?: string;
  category?: string;
  triggers?: string[];
}

interface MarketIndex {
  skills?: MarketSkill[];
  categories?: string[];
}

interface MarketplaceItem {
  score: number;
  name: string;
  category: string;
  service: string;
  description: string;
  triggers: string[];
  matched: string[];
  installCommand: string;
}

interface MarketplaceSearchResult {
  ok: boolean;
  query: string;
  category: string;
  count: number;
  results: MarketplaceItem[];
  fallback?: string[];
  expandedKeywords?: string[];
}

let cachedIndex: MarketIndex | null = null;
let cachedCnEnMap: Record<string, string> | null = null;

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function toMarketSkill(value: unknown): MarketSkill {
  const raw = asRecord(value);
  return {
    name: typeof raw.name === 'string' ? raw.name : undefined,
    description: typeof raw.description === 'string' ? raw.description : undefined,
    service: typeof raw.service === 'string' ? raw.service : undefined,
    category: typeof raw.category === 'string' ? raw.category : undefined,
    triggers: Array.isArray(raw.triggers)
      ? raw.triggers.filter((trigger): trigger is string => typeof trigger === 'string')
      : undefined,
  };
}

function toMarketIndex(value: unknown): MarketIndex {
  const raw = asRecord(value);
  return {
    skills: Array.isArray(raw.skills) ? raw.skills.map((skill) => toMarketSkill(skill)) : undefined,
    categories: Array.isArray(raw.categories)
      ? raw.categories.filter((category): category is string => typeof category === 'string')
      : undefined,
  };
}

function toCnEnMap(value: unknown): Record<string, string> {
  const raw = asRecord(value);
  const map: Record<string, string> = {};
  for (const [key, val] of Object.entries(raw)) {
    if (typeof val === 'string') map[key] = val;
  }
  return map;
}

async function fetchJson(url: string, label = ''): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    const dispatcher = await getProxyDispatcher(url);
    const fetchOpts: RequestInit & { dispatcher?: unknown } = {
      headers: { 'User-Agent': 'huaweicloud-devkit/1.0' },
      signal: controller.signal,
    };
    if (dispatcher) fetchOpts.dispatcher = dispatcher;
    const resp = await fetch(url, fetchOpts);
    const data: unknown = await resp.json();
    const record = asRecord(data);
    if (record.encoding === 'base64' && typeof record.content === 'string' && record.content) {
      const decoded = Buffer.from(record.content, 'base64').toString('utf8');
      return JSON.parse(decoded);
    }
    return data;
  } catch (error) {
    throw new Error(`Failed to fetch ${label}: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function loadIndex(): Promise<MarketIndex> {
  if (!cachedIndex) cachedIndex = toMarketIndex(await fetchJson(INDEX_URL, 'index.json'));
  return cachedIndex;
}

async function loadCnEnMap(): Promise<Record<string, string>> {
  if (!cachedCnEnMap) cachedCnEnMap = toCnEnMap(await fetchJson(CN_EN_MAP_URL, 'cn-en-map.json'));
  return cachedCnEnMap;
}

export function clearMarketCache(): void {
  cachedIndex = null;
  cachedCnEnMap = null;
}

function isGeneric(kw: string): boolean {
  const k = kw.toLowerCase().trim();
  return GENERIC_KEYWORDS.has(k) || /华为云|huawei/i.test(k);
}

function expandKeywords(rawKeyword: string, cnEnMap: Record<string, string>): [string[], string[]] {
  if (!rawKeyword) return [[], []];
  const parts = rawKeyword.replace(/[,;]/g, ' ').split(/\s+/).filter(Boolean);
  const expanded = [...parts];
  for (const p of parts) {
    const lower = p.toLowerCase();
    if (cnEnMap[p]) expanded.push(cnEnMap[p]);
    for (const [cn, en] of Object.entries(cnEnMap)) {
      if (en === lower) expanded.push(cn);
    }
  }
  const unique = [...new Set(expanded)].sort((a, b) => a.localeCompare(b));
  const specific = unique.filter((kw) => !isGeneric(kw));
  const generic = unique.filter((kw) => isGeneric(kw));
  return [specific, generic];
}

function scoreSkill(skill: MarketSkill, specificKws: string[], genericKws: string[]): [number, string[]] {
  if (!specificKws.length && !genericKws.length) return [1, []];
  let total = 0;
  const matched: string[] = [];
  const nameLower = (skill.name || '').toLowerCase();
  const descLower = (skill.description || '').toLowerCase();
  const serviceLower = (skill.service || '').toLowerCase();
  const triggers = (skill.triggers || []).map((t) => (t || '').toLowerCase());

  for (const kw of specificKws) {
    const k = kw.toLowerCase();
    let s = 0;
    if (nameLower.includes(k)) s += 10;
    else if (triggers.some((t) => t.includes(k))) s += 8;
    else if (descLower.includes(k)) s += 5;
    else if (serviceLower.includes(k)) s += 3;
    if (s > 0) {
      total += s;
      matched.push(kw);
    }
  }
  for (const kw of genericKws) {
    const k = kw.toLowerCase();
    let s = 0;
    if (nameLower.includes(k)) s += 10;
    else if (triggers.some((t) => t.includes(k))) s += 4;
    else if (descLower.includes(k)) s += 2;
    else if (serviceLower.includes(k)) s += 1;
    if (s > 0) {
      total += s;
      matched.push(kw);
    }
  }
  if (!specificKws.length && total === 0) {
    total = 1;
    if (descLower.length > 20) total += 1;
    if (triggers.length) total += 1;
  }
  return [total, matched];
}

function truncate(desc: string | undefined, limit = 150): string {
  if (!desc) return '';
  return desc.length > limit ? desc.slice(0, limit) + '...' : desc;
}

export async function searchMarketplace(query = '', category = ''): Promise<MarketplaceSearchResult> {
  const idx = await loadIndex();
  const cnEnMap = await loadCnEnMap();
  const [specificKws, genericKws] = expandKeywords(query, cnEnMap);
  const hasSpecific = specificKws.length > 0;

  const results: MarketplaceItem[] = [];
  for (const skill of idx.skills || []) {
    if (category && skill.category !== category) continue;
    const [score, matched] = scoreSkill(skill, specificKws, genericKws);
    if (hasSpecific && score === 0) continue;
    results.push({
      score,
      name: skill.name || '',
      category: skill.category || '',
      service: skill.service || '',
      description: truncate(skill.description),
      triggers: (skill.triggers || []).slice(0, 5),
      matched,
      installCommand: `npx skills add huaweicloud/huaweicloud-skills --skill ${skill.name}`,
    });
  }
  results.sort((a, b) => b.score - a.score);

  if (!results.length) {
    return {
      ok: true,
      query,
      category,
      count: 0,
      results: [],
      fallback: [
        'Try broader or alternative keywords',
        'Remove category filter',
        'Switch CN<->EN (e.g., obs <-> object storage)',
        'List all: search with empty keyword and a category',
      ],
    };
  }

  const allKws = [...new Set([...specificKws, ...genericKws])];
  return {
    ok: true,
    query,
    category,
    count: results.length,
    expandedKeywords: allKws.length > 1 ? allKws : undefined,
    results,
  };
}

export async function getMarketplaceCategories(): Promise<{ ok: boolean; categories: string[] }> {
  const idx = await loadIndex();
  return { ok: true, categories: idx.categories || [] };
}
