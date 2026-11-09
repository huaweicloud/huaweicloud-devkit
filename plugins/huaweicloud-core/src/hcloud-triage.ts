// Unknown-service triage for the classifier's unknown_read fallthrough
// (2026-11-05 UX report #8 / D6). The safety vocabulary is a DANGER
// vocabulary: an operation matching neither the read nor the write list
// classifies allow/unknown_read ("treat output as untrusted"), and the P0-B
// fix (1a93591c) kept the run faces allow so legitimate reads outside the
// vocabulary keep executing. What the vocabulary cannot say, the LOCAL
// KooCLI catalog can: whether the service name exists at all. This module is
// that evidence tier — an enrichment applied at the plan and advisory faces,
// never inside src/safety/, so the PreToolUse hook graph
// (dist/safety-policy.js) and its py twin stay vocabulary-only and the
// hook's deny-only contract is untouched.
//
// Epistemic contract (docs/unknown-operation-triage-design.md):
//   negative evidence — both catalogs present, service in neither: the
//     command cannot succeed as written; the plan face denies (the run face
//     inherits through assertAllowed(plan.classification)) and the advisory
//     face upgrades its finding
//   partial evidence — cn-only entry: a real service behind the en-catalog
//     gap; the cn language hint applies, execution stays allowed
//   positive, unclassified — real service, unrecognized operation: the
//     write vocabulary may simply not know it (the Register/Restore class
//     was closed by vocabulary, not by architecture); unknown_read
//     semantics stand
//   missing evidence — a catalog file absent (KooCLI uninstalled, bare
//     HOME): a normal environment state, not a broken guard, so unlike the
//     write-vocabulary degradation (which fails closed at load) this stays
//     open — a face without a catalog cannot know better than "no catalog".

import { homedir } from 'node:os';
import { join } from 'node:path';

import { CN_LANG_SWITCH_HINT, readServiceCatalogs } from './hcloud-catalog.ts';

export type UnknownServiceTriage =
  | { cause: 'service-not-found'; message: string; nextStep: string }
  | { cause: 'lang-missing'; message: string; nextStep: string }
  | { cause: 'operation-unknown' }
  | { cause: 'no-evidence' };

// The advisory face resolves the catalog through this chain so tests can pin
// every branch deterministically without new tool-arg surface (an
// agent-controllable catalog path would let the caller fake the evidence and
// downgrade its own verdict — metaDir stays operator-side only, mirroring
// the HCLOUD_BIN doctrine). runHcloud already carries an explicit
// options.metaDir and threads it into the plan, which is where the triage
// actually reads.
export function resolveMetaDir(explicit?: string): string {
  return explicit ?? process.env.HCLOUD_META_DIR ?? join(homedir(), '.hcloud', 'metaRepo');
}

export function triageUnknownService(service: string | undefined, metaDir?: string): UnknownServiceTriage {
  // Catalog lookups are uppercase on both sides (readServiceCatalogs
  // normalizes on load); mixed-case input must not read as not-found. The
  // message quotes the RAW token — the agent typed it, and "FOOBAR" in prose
  // reads like a different name than the one it sent.
  const raw = typeof service === 'string' ? service.trim() : '';
  const s = raw.toUpperCase();
  if (!raw) return { cause: 'no-evidence' };
  const { cn, en, cnPresent, enPresent } = readServiceCatalogs(metaDir ?? resolveMetaDir());
  // Either file missing → the catalog proves nothing in either direction
  // (the en catalog alone would misread cn-only services as fabricated and
  // vice versa — the same G-rev asymmetry classifyUnsupported encodes).
  if (!cnPresent || !enPresent) return { cause: 'no-evidence' };
  if (!cn.has(s) && !en.has(s)) {
    return {
      cause: 'service-not-found',
      message: `Service "${raw}" is not in the local KooCLI service catalog. The command cannot succeed as written — the name is likely a typo or not a real KooCLI service.`,
      nextStep:
        'Verify the service and operation names with `hcloud <Service> --help`; if the service is genuinely new, refresh KooCLI metadata (hcloud upgrade / configure) and re-check.',
    };
  }
  if (cn.has(s) && !en.has(s)) {
    return {
      cause: 'lang-missing',
      message: `Service "${s}" is known only to KooCLI's Chinese catalog; the safety vocabulary does not recognize the operation.`,
      nextStep: CN_LANG_SWITCH_HINT,
    };
  }
  return { cause: 'operation-unknown' };
}
