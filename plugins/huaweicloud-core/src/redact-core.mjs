// Single-source string-path credential redaction. Two consumers must never
// drift again: safety-policy (redactString, the recursive object+string
// redactor behind redactSecrets) and risk-rule-engine (redactEvidence, the
// risk-finding evidence scrubber). Before this module the evidence path
// lacked api_key entirely, and NEITHER tolerated quoted JSON/Python-dict
// keys ("api_key": "…" — the closing quote between key and separator broke
// the key[:=] alignment, and the one-time agentarts memory api_key rode
// tool output unmasked; findings trap 27).

// Key tokens. The string path renders each as a separator-optional,
// case-insensitive fragment (access_key -> access[_-]?key, which also
// matches camelCase accessKey). Every token must ALSO be classified by the
// object path (isSecretKeyName via policy.json secretKeyNamePatterns or its
// hardcoded classes) — pinned behaviorally by test/safety-policy.test.mjs.
export const BLOB_KEY_TOKENS = ['user_data', 'metadata', 'private_key'];
export const CREDENTIAL_KEY_TOKENS = [
  'access_key',
  'secret_key',
  'api_key',
  'x_api_key',
  'security_token',
  'x_auth_token',
  'token',
  'authorization',
  'password',
  'passwd',
  'admin_pass',
  'credential',
  'secret',
];
export const AKSK_KEY_TOKENS = ['ak', 'sk'];

const keyPattern = (tokens) => tokens.map((t) => t.replace(/_/g, '[_-]?')).join('|');

const BLOB = keyPattern(BLOB_KEY_TOKENS);
const CREDS = keyPattern(CREDENTIAL_KEY_TOKENS);

// A quoted value may itself be backslash-escaped when the whole document is
// embedded as a JSON string value (invoke/FunctionGraph results):
// \"api_key\": \"…\". One escape level is tolerated on the quotes, and the
// quoted bodies match internal escape pairs ("a\"b"). The blob class gets
// the same tolerance plus object/array values up to two nesting levels
// ("user_data": {"script": {"body": …}}) — the string path must not be
// weaker than the parsed-object path for the shapes real output prints.
const VALUE = '(\\\\?"(?:[^"\\\\]|\\\\.)*\\\\?"|\\\\?\'(?:[^\'\\\\]|\\\\.)*\\\\?\'|[^\\s,;]+)';
const QUOTED_BLOB_VALUE =
  '(\\{(?:[^{}]|\\{[^{}]*\\})*\\}|\\[[^\\]\\[]*\\]|\\\\?"(?:[^"\\\\]|\\\\.)*\\\\?"|\\\\?\'(?:[^\'\\\\]|\\\\.)*\\\\?\')';

// Blob bound policy. The DISPLAY path (redactSecrets — payload stdout, 0600
// side files) sweeps the whole rest of the line: a blob value has no
// reliable terminator and may embed arbitrary sensitive content. The
// EVIDENCE path (risk-finding evidence) stops the sweep at the next
// key-shaped token so later fields on the same evidence line stay
// diagnosable — nested credential-shaped content is still caught by the
// credential pass that runs right after.
export function redactCredentialShapes(text, { blobBound = 'line' } = {}) {
  const unquotedBlob =
    blobBound === 'nextKey'
      ? [new RegExp(`((?:${BLOB})\\s*[:=]\\s*)((?:(?!\\s+[\\w.-]+[:=]).)*)(.*)`, 'gi'), '$1<redacted>$3']
      : [new RegExp(`((?:${BLOB})\\s*[:=]\\s*).*`, 'gi'), '$1<redacted>'];
  return (
    String(text)
      // Bearer/Basic tokens first: `Authorization: Bearer <token>` (and the
      // Basic sibling) would otherwise redact only the scheme word and let
      // the credential ride — and the agentarts data-plane key transits
      // exactly as a Bearer header value. Both schemes are single-token.
      .replace(/((?:authorization)\s*[:=]\s*)(?:bearer|basic)\s+[^\s,;"']+/gi, '$1<redacted>')
      // QUOTED blob keys: the value is a quoted string (or one-level
      // object/array) — redact exactly it and let mid-JSON neighbors on
      // the same line survive.
      .replace(new RegExp(`((\\\\?["'])(?:${BLOB})\\2\\s*[:=]\\s*)(${QUOTED_BLOB_VALUE})`, 'gi'), '$1<redacted>')
      // UNQUOTED blob form: bound per the policy above.
      .replace(unquotedBlob[0], unquotedBlob[1])
      // Credential-shaped keys. The backreferenced quote pair tolerates
      // JSON/Python-dict keys and one backslash escape level.
      .replace(new RegExp(`(\\\\?["']?)(${CREDS})\\1(\\s*[:=]\\s*)(${VALUE})`, 'gi'), '$1$2$1$3<redacted>')
      // Bare AK/SK prefixes (agentarts/SDK CLIs print `ak: value` shapes);
      // same quote and escape tolerance. Keeps the historical separator
      // normalization to '='.
      .replace(new RegExp(`(\\\\?["']?)\\b(ak|sk)\\b\\1(\\s*[:=]\\s*)(${VALUE})`, 'gi'), '$1$2$1=<redacted>')
  );
}
