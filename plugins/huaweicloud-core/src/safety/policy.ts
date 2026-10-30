import { readFileSync } from 'node:fs';

import { stripShellQuotes } from './shell-text.ts';

// Only the pattern-array fields this module reads are modeled. Extra keys in
// policy.json are intentionally not surfaced through the type.
export interface Policy {
  secretKeyNamePatterns: string[];
  credentialFilePatterns: string[];
  blockedConfigureSubcommands: string[];
  blockedSecretOperations: string[];
  blockedSecretCliPatterns: string[];
  writeOperationPrefixes: string[];
  readOperationPrefixes: string[];
}

export interface ClassifyOptions {
  policy?: Policy;
  allowWrites?: boolean;
  allowCredentialRead?: boolean;
  rawCommand?: string;
  skipRiskRules?: boolean;
  _segmentDepth?: number;
  _narrowRouted?: boolean;
}

// An absent field normalizes to [] (older policies). A field that is present
// but not an array throws: the pre-migration module crashed on first use of a
// malformed policy, and silently emptying e.g. writeOperationPrefixes would
// reclassify write commands as safe — the enforcement layer must fail closed.
function toStringArray(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new TypeError(`safety policy field "${field}" must be an array of strings`);
  }
  return value.filter((item): item is string => typeof item === 'string');
}

export function loadPolicy(path: string): Policy {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TypeError('safety policy must be a JSON object');
  }
  const raw = parsed as Record<string, unknown>;
  const writeOperationPrefixes = toStringArray(raw.writeOperationPrefixes, 'writeOperationPrefixes');
  // An EMPTIED write list reclassifies write commands as safe — the exact
  // fail-open the non-array throw above exists to prevent, one shape over
  // (the absent field still normalizes to [] for older policies; only a
  // present-but-empty or all-non-string list throws). Interrogate round 2:
  // this closes the last py/TS disagreement on the degraded surface — the
  // py hook denies fail-closed when its write vocabulary is unavailable, and
  // the TS side now fails LOUD at load (module-load throw → the .mjs hook's
  // fail-closed deny, the MCP server's refuse-to-boot) instead of silently
  // classifying with no write vocabulary.
  if (raw.writeOperationPrefixes !== undefined && writeOperationPrefixes.length === 0) {
    throw new TypeError('safety policy field "writeOperationPrefixes" must not be empty');
  }
  return {
    secretKeyNamePatterns: toStringArray(raw.secretKeyNamePatterns, 'secretKeyNamePatterns'),
    credentialFilePatterns: toStringArray(raw.credentialFilePatterns, 'credentialFilePatterns'),
    blockedConfigureSubcommands: toStringArray(raw.blockedConfigureSubcommands, 'blockedConfigureSubcommands'),
    blockedSecretOperations: toStringArray(raw.blockedSecretOperations, 'blockedSecretOperations'),
    blockedSecretCliPatterns: toStringArray(raw.blockedSecretCliPatterns, 'blockedSecretCliPatterns'),
    writeOperationPrefixes,
    readOperationPrefixes: toStringArray(raw.readOperationPrefixes, 'readOperationPrefixes'),
  };
}

// Pattern application shared by the redaction walk, the credential-file
// gates, and the operation-prefix classifiers: policy.json patterns compile
// case-insensitively, one spelling everywhere.
export function regexFrom(pattern: string): RegExp {
  return new RegExp(pattern, 'i');
}

export function matchesAny(value: string, patterns: string[]): boolean {
  return patterns.some((pattern) => regexFrom(pattern).test(value));
}

export function hasWritePrefix(operation: string, policy: Policy): boolean {
  // Both the raw token and its quote-stripped shadow: a mid-token quote
  // (`Cre'ateServers`) builds the canonical argv while hiding the prefix
  // from the raw form.
  const candidates = [String(operation), stripShellQuotes(String(operation))];
  return candidates.some((normalized) =>
    policy.writeOperationPrefixes.some((prefix) => new RegExp(`(^|[A-Za-z0-9])${prefix}`, 'i').test(normalized)),
  );
}

export function hasReadPrefix(operation: string, policy: Policy): boolean {
  const candidates = [String(operation), stripShellQuotes(String(operation))];
  return candidates.some((normalized) =>
    policy.readOperationPrefixes.some((prefix) => new RegExp(`^${prefix}`, 'i').test(normalized)),
  );
}
