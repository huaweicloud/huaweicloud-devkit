import { DEFAULT_POLICY, type Policy } from './default-policy.ts';
import { regexFrom } from './policy.ts';

function isSecretKeyName(key: unknown, policy: Policy = DEFAULT_POLICY): boolean {
  const normalized = String(key)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
  if (
    /access.*key|secret.*key|security.*token|xauth.*token|authorization|password|passwd|adminpass|credential|private.*key|userdata|metadata|inputvalue/.test(
      normalized,
    )
  ) {
    return true;
  }
  return policy.secretKeyNamePatterns.some((pattern) => regexFrom(`^(${pattern})$`).test(String(key)));
}

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
      .replace(
        /(["']?(?:access[_-]?key(?:[_-]?(?:id|secret))?|secret[_-]?key|secret[_-]?string|secret[_-]?binary|security[_-]?token|token|password|passwd|admin[_-]?pass|credential|input[_-]?value)["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;]+)/gi,
        '$1<redacted>',
      )
      .replace(/\b(["']?(?:AK|SK)["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1<redacted>')
  );
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
