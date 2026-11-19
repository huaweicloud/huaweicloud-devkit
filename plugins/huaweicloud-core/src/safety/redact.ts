import { DEFAULT_POLICY, type Policy } from './default-policy.ts';
import { regexFrom } from './policy.ts';

function isSecretKeyName(key: unknown, policy: Policy = DEFAULT_POLICY): boolean {
  const normalized = String(key)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
  if (
    /access.*key|secret.*key|secret.*string|secret.*binary|secret.*text|api.*key|security.*token|xauth.*token|authorization|password|passwd|adminpass|credential|private.*key|userdata|metadata|inputvalue/.test(
      normalized,
    )
  ) {
    return true;
  }
  return policy.secretKeyNamePatterns.some((pattern) => regexFrom(`^(${pattern})$`).test(String(key)));
}

// The key vocabulary is shared by every evidence/command redaction face.
// Backslashes around the key/value are tolerated because shell-transcribed
// commands and nested JSON carry `\"password\":\"…\"` spellings; `secret://`
// refs are exempt (the ref is conversation-safe by doctrine). `secret_text`
// and `api_key` joined the family with the AX N-R4.1 fix — DEW's plaintext
// secret and the DevBridge key were crossing every evidence surface.
const SECRET_KEY_VALUE_RE =
  /((?:access[_-]?key(?:[_-]?(?:id|secret))?|secret[_-]?key|secret[_-]?string|secret[_-]?binary|secret[_-]?text|api[_-]?key|secret(?!:\/)|security[_-]?token|x[_-]?auth[_-]?token|token|authorization|password|passwd|admin[_-]?pass|credential|input[_-]?value)\\*["']?\s*[:=]\s*[\\"']*\s*)("[^"]*"|'[^']*'|[^\s,;]+)/gi;

function redactString(text: unknown): string {
  return (
    String(text)
      // Opaque blob keys (cloud-init user_data, metadata, private_key) carry
      // base64/scripts that may embed SSH keys, DB passwords, bootstrap tokens.
      // Redact the ENTIRE value of this arg — not just the first whitespace token.
      // Quoted-key variants: gateway validation errors echo arguments as JSON
      // ("adminPass":"...") and pydantic echoes them as input_value=... — the
      // unquoted key=value form alone left both shapes crossing unredacted.
      // Auth-style headers carry multi-word values ("Authorization: Bearer
      // <jwt>"): the first-token capture redacted 'Bearer' and crossed the
      // credential itself, so this family consumes to end-of-line like the
      // blob-key branch above.
      .replace(
        /(["']?(?:user[_-]?data|metadata|private[_-]?key|authorization|x[_-]?auth[_-]?token)["']?\s*[:=]\s*).*/gi,
        '$1<redacted>',
      )
      .replace(SECRET_KEY_VALUE_RE, '$1<redacted>')
      // XML settings shapes (`<password>value</password>`, the settings.xml
      // deploy idiom) carry no `:`/`=` separator, so the key-value family
      // never saw them — the artifact evidence echoed the password verbatim
      // (AX N-R4.1). The tag name is backreferenced so a mismatched close
      // tag is not half-redacted.
      .replace(/<(password|passwd|pwd)>[^<]*<\/\1>/gi, '<$1><redacted></$1>')
      .replace(/\b(["']?(?:AK|SK)\\*["']?\s*[:=]\s*[\\"']*\s*)("[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1<redacted>')
  );
}

// The string-level evidence redaction entry (risk-rule-engine's excerpt and
// any future evidence face): one vocabulary, no second drift-prone copy.
export function redactEvidenceText(text: unknown): string {
  return redactString(text);
}

// Overload parameter names are documentation only; the implementation below
// carries the real, used parameters.
export function redactSecrets(value: string, policy?: Policy): string;
export function redactSecrets(value: unknown, policy?: Policy): unknown;
export function redactSecrets(value: unknown, policy: Policy = DEFAULT_POLICY): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactSecrets(item, policy));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, val]) => [
        key,
        isSecretKeyName(key, policy) ? '<redacted>' : redactSecrets(val, policy),
      ]),
    );
  }
  if (typeof value === 'string') {
    return redactString(value);
  }
  return value;
}
