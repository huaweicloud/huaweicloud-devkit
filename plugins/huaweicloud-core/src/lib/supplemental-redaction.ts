import { redactSecrets } from '../safety-policy.ts';

// The ToolArgs-surface redaction pass shared by the call trace and the
// approval-gate pin views. redactSecrets covers ak/sk/securityToken/token,
// but the tool surface also carries long-lived keys under api_key / apiKey
// (sandbox_credentials, gateway_call toolArgs) and the secrets pack's set
// tool carries the plaintext itself under value (channel=value) — no other
// tool schema uses that arg name, so the denylist entry is collision-free.
// Redaction must be a superset of the product's, so these get their own
// pass here.
const SUPPLEMENTAL_SECRET_KEYS = new Set(['api_key', 'apikey', 'value']);

export function redactWithSupplementalKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => redactWithSupplementalKeys(item));
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
