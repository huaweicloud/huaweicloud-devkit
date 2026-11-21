// The credential resolution tiers, extracted from the credentials monolith
// (the stable src/auth/credentials.ts face re-exports this family): the
// env > CodeArts > S1-with-refs chain with its precedence rules (R9
// configuredBySession, the STS-triplet sandbox rule, R11 placeholder
// skipping). The #900 missing-credential error lives in
// ./missing-credential-error.ts and the runtime override tier in
// ./runtime-credentials.ts.
import { present } from './credential-placeholder.ts';
import { readGlobalCredentialsResolved } from './s1-store.ts';
import { isCodeArtsContext, readCodeArtsCredentials } from './codearts-context.ts';
import { missingCredentialError } from './missing-credential-error.ts';

export interface ResolvedCredentials {
  ak: string;
  sk: string;
  securityToken: string;
  region: string;
}

export interface ResolveCredentialsOptions {
  allowMissing?: boolean;
}

export function resolveCredentials(options: ResolveCredentialsOptions = {}): ResolvedCredentials | null {
  // R11: placeholder/masked env values are "not configured", never credentials.
  const envAk = process.env.HW_ACCESS_KEY;
  const envSk = process.env.HW_SECRET_KEY;
  const envSecurityToken = process.env.HW_SECURITY_TOKEN;
  let ak = present(envAk) ? envAk : '';
  let sk = present(envSk) ? envSk : '';
  let securityToken = present(envSecurityToken) ? envSecurityToken : '';
  let region = process.env.HUAWEICLOUD_REGION || process.env.HW_REGION || '';

  const codeartsCreds = isCodeArtsContext() ? readCodeArtsCredentials() : null;
  if (codeartsCreds) {
    if (!ak && codeartsCreds.ak) ak = codeartsCreds.ak;
    if (!sk && codeartsCreds.sk) sk = codeartsCreds.sk;
    if (!securityToken && codeartsCreds.securityToken) securityToken = codeartsCreds.securityToken;
    if (!region && codeartsCreds.region) region = codeartsCreds.region;
  }

  const stored = readGlobalCredentialsResolved();
  if (stored) {
    // R11: skip placeholder/masked values from the vault too (templates must
    // not win the truthiness check and shadow another store).
    if (!ak && present(stored.ak)) ak = stored.ak;
    if (!sk && present(stored.sk)) sk = stored.sk;
    if (!securityToken && present(stored.securityToken)) securityToken = stored.securityToken;
    if (!region && typeof stored.region === 'string' && stored.region) region = stored.region;
  }

  // R9: S1 written by `auth_switch persist` (configuredBySession) is the session's
  // source of truth and wins over env-injected defaults. Plain S1 (`auth init`)
  // still yields to env so devspace-style env injection keeps working.
  if (stored && stored.configuredBySession === true && present(stored.ak) && present(stored.sk)) {
    ak = stored.ak;
    sk = stored.sk;
    if (!securityToken) securityToken = present(stored.securityToken) ? stored.securityToken : '';
    if (!region && typeof stored.region === 'string' && stored.region) region = stored.region;
  }

  // Sandbox/platform-injected temporary STS credentials (env vars carrying a
  // security token) must not shadow the user's explicit permanent credentials
  // from `auth init`. Prefer the stored file when both exist.
  const envHasFullTriplet = present(envAk) && present(envSk) && present(envSecurityToken);
  if (envHasFullTriplet && stored && present(stored.ak) && present(stored.sk)) {
    ak = stored.ak;
    sk = stored.sk;
    securityToken = present(stored.securityToken) ? stored.securityToken : '';
    region = typeof stored.region === 'string' && stored.region ? stored.region : region;
  }

  if (!ak || !sk) {
    if (options.allowMissing) return null;
    // #900: the onboarding-guidance error shape lives in its own module
    // (missing-credential-error.ts), shared semantics with computeOnboarding.
    throw missingCredentialError();
  }

  return { ak, sk, securityToken, region };
}
