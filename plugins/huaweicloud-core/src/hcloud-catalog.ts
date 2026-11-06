// KooCLI service-catalog knowledge, extracted from the hcloud-cli monolith
// (the stable src/hcloud-cli.ts face re-exports the public names): the
// en/cn metaRepo catalog walk with its TTL cache, the "Unsupported
// service" cause classifier (lang-missing vs not-found vs unknown), and
// the language-hint annotation the run engine attaches when a command's
// output carries that error.

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { asRecord } from './lib/as-record.ts';
import { asText } from './lib/as-text.ts';
import type { HcloudRunResult } from './hcloud-run.ts';

const CATALOG_TTL_MS = 5 * 60 * 1000;

interface ServiceCatalogLoad {
  present: boolean;
  set: Set<string>;
}

export interface ServiceCatalogCache {
  dir: string | null;
  t: number;
  cn: Set<string>;
  en: Set<string>;
  cnPresent?: boolean;
  enPresent?: boolean;
}

let _catalogCache: ServiceCatalogCache = { dir: null, t: 0, cn: new Set(), en: new Set() };

export function readServiceCatalogs(metaDir = join(homedir(), '.hcloud', 'metaRepo')): ServiceCatalogCache {
  const now = Date.now();
  if (_catalogCache.dir === metaDir && now - _catalogCache.t < CATALOG_TTL_MS) return _catalogCache;
  const load = (f: string): ServiceCatalogLoad => {
    try {
      const p = join(metaDir, f);
      if (!existsSync(p)) return { present: false, set: new Set<string>() };
      const d: unknown = JSON.parse(readFileSync(p, 'utf8'));
      const items = asRecord(d).items;
      // Normalize to uppercase on load: catalog entries are mixed-case
      // (DevStar, CloudTable, MapDS, ...) while lookups use uppercase.
      return {
        present: true,
        set: new Set(
          (Array.isArray(items) ? items : [])
            .map((i) => {
              const text = asRecord(asRecord(i).Service).Text;
              return typeof text === 'string' ? text.toUpperCase() : undefined;
            })
            .filter((text): text is string => Boolean(text)),
        ),
      };
    } catch {
      return { present: false, set: new Set<string>() };
    }
  };
  const cn = load('services_cn.json');
  const en = load('services_en.json');
  _catalogCache = { dir: metaDir, t: now, cn: cn.set, en: en.set, cnPresent: cn.present, enPresent: en.present };
  return _catalogCache;
}

export type UnsupportedCause = 'other' | 'lang-missing' | 'not-found' | 'unknown';

export function classifyUnsupported(service: unknown, metaDir?: string): UnsupportedCause {
  const { cn, en, cnPresent, enPresent } = readServiceCatalogs(metaDir);
  const s = asText(service || '').toUpperCase();
  if (!s) return 'other';
  if (cnPresent && enPresent) {
    if (cn.has(s) && !en.has(s)) return 'lang-missing';
    if (!cn.has(s) && !en.has(s)) return 'not-found';
    return 'other';
  }
  // One or both catalog files are missing locally — we cannot distinguish
  // "service missing from the en catalog" from "en catalog not downloaded".
  return 'unknown';
}

// The "Unsupported service: X" output pattern the run engine matches to
// trigger the language annotation below.
export const UNSUPPORTED_SERVICE_RE = /Unsupported service:\s*([A-Za-z0-9_-]+)/i;

// Shared remediation wording: the run annotation (appendLangHint) and the
// unknown-service triage (hcloud-triage.ts) must hand the agent the SAME cn
// instruction — two copies would drift the way the tool/hook message pairs
// did before the parity harnesses.
export const CN_LANG_SWITCH_HINT =
  'KooCLI switches language only via global config: hcloud configure set --cli-lang=cn (changes CLI output language; BSS requires Chinese mode).';

export const CATALOG_REFRESH_HINT = 'Check the service name, or refresh KooCLI metadata (hcloud upgrade / configure).';

// Consumed by the run engine (hcloud-run.ts); not part of the face's
// public surface.
export function appendLangHint(result: HcloudRunResult, service: string, metaDir?: string): HcloudRunResult {
  const cause = classifyUnsupported(service, metaDir);
  if (cause === 'lang-missing' || cause === 'unknown') {
    const nextStep = CN_LANG_SWITCH_HINT;
    return {
      ...result,
      langCause: cause,
      langHint: `Unsupported service: ${service}. ${nextStep}`,
      langNextStep: nextStep,
    };
  }
  const nextStep = CATALOG_REFRESH_HINT;
  return {
    ...result,
    langCause: cause,
    langHint: `Unsupported service: ${service}. ${nextStep}`,
    langNextStep: nextStep,
  };
}
