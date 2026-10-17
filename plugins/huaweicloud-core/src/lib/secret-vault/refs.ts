// Secret refs: secret://<scope>/<name>. The grammar is the one validation
// contract the vault's security depends on — both segments join a filesystem
// path and the canonical spelling is the GCM AAD, so anything outside
// [a-z0-9-] (dot segments, percent-encoding, case folding, ports) is rejected
// at the boundary instead of normalized. Deliberately NOT parsed with
// new URL(): WHATWG host folding would fold case and resolve dot-segments,
// producing two spellings for one file. Same boundary-guard shape as
// huaweicloud_retrieve_skill's `^[a-z0-9-]+$` name schema.

const SEGMENT = /^[a-z0-9][a-z0-9-]{0,63}$/;

export const SECRET_REF_PATTERN = /^secret:\/\/([a-z0-9][a-z0-9-]{0,63})\/([a-z0-9][a-z0-9-]{0,63})$/;

// Scope names the vault itself uses under the store root. `lock` is the
// withDepLock claim directory; a ref claiming it would collide with the lock
// machinery.
const RESERVED_SCOPES = new Set(['lock']);

export interface SecretRef {
  scope: string;
  name: string;
}

export function isSecretRef(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = SECRET_REF_PATTERN.exec(value);
  return match !== null && !RESERVED_SCOPES.has(match[1]!);
}

export function parseSecretRef(value: unknown): SecretRef | null {
  if (typeof value !== 'string') return null;
  const match = SECRET_REF_PATTERN.exec(value);
  if (!match) return null;
  const scope = match[1]!;
  if (RESERVED_SCOPES.has(scope)) return null;
  return { scope, name: match[2]! };
}

export function formatSecretRef(ref: SecretRef): string {
  return `secret://${ref.scope}/${ref.name}`;
}

export function isValidScopeSegment(value: unknown): value is string {
  return typeof value === 'string' && SEGMENT.test(value) && !RESERVED_SCOPES.has(value);
}

export function isValidNameSegment(value: unknown): value is string {
  return typeof value === 'string' && SEGMENT.test(value);
}

// The vault error base. It lives in the vocabulary module (zero imports) so
// both store.ts (VaultError and its re-export) and custody.ts
// (VaultCustodyError) share ONE hierarchy — consumers catching VaultError
// must see custody-tier failures (locked keychain, corrupt keyfile) too,
// not just store-tier ones.
export class VaultError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

// The credential env family the safety hooks treat as dump-protected
// (HW_/HUAWEICLOUD_/HWC_/OS_ — the same prefix list the env-dump gates use).
// The vault's env channels (secret set --env / channel=envVar) must refuse
// these names: harvesting the MCP server's own credential environment into
// the vault is a dump by another route, and the Bash-face hooks cannot see
// tool_input JSON to stop it.
const CREDENTIAL_ENV_PREFIXES = ['HW_', 'HUAWEICLOUD_', 'HWC_', 'OS_', 'HCLOUD_'];

export function isCredentialEnvVarName(name: string): boolean {
  const normalized = name.trim().toUpperCase();
  return CREDENTIAL_ENV_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}
