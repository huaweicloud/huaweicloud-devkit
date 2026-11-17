// The shared display-redaction leaf. Two passes live here, one canonical home
// each:
//   1. the secret-TOKEN FOLD — the argv/string fold that hides secret VALUES
//      from every display and store surface (the run face's pin view, the
//      sandbox exec views, the approval token store's argsRedacted, the
//      trace). The fold's primitives were born in hcloud-plan.ts for the
//      run face's pin view; PR-3a round 3 moved them HERE because the exec
//      face and the token store need the same fold and cannot import the
//      face (approval-tokens ← hcloud-cli would be a value cycle). One
//      fold, every consumer; the classification engines see the RAW
//      command always — this leaf is for display and persistence only.
//   2. the supplemental-key denylist (api_key/apiKey/value) — object-shaped
//      secrets redactSecrets alone never covered.
const SUPPLEMENTAL_SECRET_KEYS = new Set(['api_key', 'apikey', 'value']);

// The secret key families (the run face's exact vocabulary, kept verbatim):
// unanchored inside a token (redactSecrets folds `password=` inside
// `--dbpassword=` the same way), with AK/SK boundary-anchored.
const SECRET_KEY_ALT =
  'access[_-]?key(?:[_-]?(?:id|secret))?|secret[_-]?key|secret[_-]?string|secret[_-]?binary|security[_-]?token|x[_-]?auth[_-]?token|token|password|passwd|admin[_-]?pass|credential|input[_-]?value|user[_-]?data|metadata|private[_-]?key|authorization';
// A bare key token (`--password`, `--server.adminPass`, `--dbpassword`): the
// value rides the NEXT argv element. The optional prefix must end on a
// separator char, or `--task` would parse as the SK key token.
export const SECRET_KEY_TOKEN_RE = new RegExp('^(?:--?[A-Za-z0-9_.-]*[._-])?(?:' + SECRET_KEY_ALT + '|AK|SK)$', 'i');
// Shared key+separator scanner: ONE global split drives every consumer. The
// value segment of a key runs to the NEXT key occurrence — a multi-key body
// yields one segment per key.
const SECRET_KEY_SEP_RE = new RegExp(
  '((?:(?:' + SECRET_KEY_ALT + ')|\\b(?:AK|SK))["\'\\\\]*\\s*(?:[=:]|\\s|(?=["\']))\\s*)',
  'gi',
);

export function secretSegments(arg: string): Array<{ sep: string; value: string }> {
  const parts = String(arg).split(SECRET_KEY_SEP_RE);
  const segments: Array<{ sep: string; value: string }> = [];
  for (let i = 1; i < parts.length; i += 2) {
    segments.push({ sep: parts[i] ?? '', value: parts[i + 1] ?? '' });
  }
  return segments;
}

// The canonical argv fold (the run face's pin view, verbatim): a string
// token the scanner sees a secret key in has every value segment folded to
// `<redacted>` while the STRUCTURE (flag names, key names, non-secret
// prefix) survives, and a bare key token folds the value riding the next
// element. A chained bare key (`--password --token x`) is left for its own
// iteration so no real value hides behind the skip. Mixed arrays are safe:
// non-string elements pass through untouched at their position, so object
// payloads (the tunnel faces' arrays) never coerce.
export function foldSecretTokens(args: readonly unknown[]): unknown[] {
  const out: unknown[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const raw = args[i];
    if (typeof raw !== 'string' && typeof raw !== 'number') {
      out.push(raw);
      continue;
    }
    const arg = String(raw);
    const segments = secretSegments(arg);
    if (segments.length > 0) {
      const parts = String(arg).split(SECRET_KEY_SEP_RE);
      let folded = parts[0] ?? '';
      for (let j = 1; j < parts.length; j += 2) {
        folded += parts[j] + '<redacted>';
      }
      out.push(folded);
      continue;
    }
    const nextRaw = i + 1 < args.length ? args[i + 1] : undefined;
    // Narrow before String(): only string- and number-shaped elements can
    // be a bare key's value token — anything else (objects, arrays) is not
    // a shell word and passes through untouched, and Object's default
    // stringification never enters the fold.
    const next: string | undefined =
      typeof nextRaw === 'string' || typeof nextRaw === 'number' ? String(nextRaw) : undefined;
    if (SECRET_KEY_TOKEN_RE.test(arg) && next !== undefined && !SECRET_KEY_TOKEN_RE.test(next)) {
      out.push(arg, '<redacted>');
      i += 1;
      continue;
    }
    out.push(raw);
  }
  return out;
}

// The string twin of the argv fold: whitespace-split a command string into
// its words, fold the same way, rejoin. The word approximation is the
// documented residual: a quoted value containing spaces folds only its
// first word (the same space-bearing-value partial-redaction class the
// run face records).
export function foldSecretTokensInString(text: string): string {
  return (foldSecretTokens(text.split(/\s+/)) as string[]).join(' ');
}

// THE COMPOSITION RULE (one statement, every consumer): a display or store
// surface redacts by composing `redactSecrets(value)` FIRST (the engine's
// glued key=value/key:value folds) and `redactWithSupplementalKeys(...)`
// SECOND (the supplemental key denylist plus the two-token fold). There is
// deliberately no helper wrapping the pair: the consumers run it on whole
// argv arrays and object bindings (values redactSecrets alone mishandles),
// so a string-only helper was a zero-call-site lie the round-4 seat caught.
// redactSecrets's import stays — it is the first half of the composition
// the callers name at their sites.

export function redactWithSupplementalKeys(value: unknown): unknown {
  if (typeof value === 'string') {
    // The two-token secret form (`--password hunter2`) folds on the string
    // leaf every display/store consumer routes through: the glued forms
    // fold earlier via redactSecrets (the callers compose this leaf after
    // it), the cross-word forms here (interrogate round 3, F1 — reproduced
    // on every surface by both seats and the root).
    return foldSecretTokensInString(value);
  }
  if (Array.isArray(value)) {
    // The array fold is pairwise: adjacent elements carry the bare key
    // token and its value (the run face's argv shape), so recursion alone
    // could never catch the pair.
    return foldSecretTokens(value.map((item) => redactWithSupplementalKeys(item)));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, val]) => [
        key,
        SUPPLEMENTAL_SECRET_KEYS.has(key.toLowerCase()) ? '<redacted>' : redactWithSupplementalKeys(val),
      ]),
    );
  }
  return value;
}
