import { runHcloud } from './hcloud-cli.mjs';

// Parse `hcloud STS GetCallerIdentity` stdout into structured identity fields.
// URN forms (see https://support.huaweicloud.com/usermanual-iam5/iam_01_1275.html):
//   iam::<account_id>:user:<username>            — user credentials (primary or IAM sub-user)
//   sts::<account_id>::assumed-agency:<name>/…   — agency session credentials (rule does not apply)
export function parseCallerIdentity(stdout) {
  let parsed;
  try {
    parsed = typeof stdout === 'string' ? JSON.parse(stdout) : stdout;
  } catch {
    return { ok: false, error: 'GetCallerIdentity returned non-JSON output.' };
  }
  if (!parsed || typeof parsed !== 'object' || !parsed.principal_urn || !parsed.account_id) {
    return { ok: false, error: 'GetCallerIdentity response missing principal_urn/account_id.' };
  }
  const principalUrn = String(parsed.principal_urn);
  let urnType = 'unknown';
  let username;
  const userMatch = principalUrn.match(/^iam::[^:]+:user:(.+)$/);
  if (userMatch) {
    urnType = 'user';
    username = userMatch[1];
  } else if (/^sts::/.test(principalUrn) || /assumed-agency/.test(principalUrn)) {
    urnType = 'agency';
  }
  return {
    ok: true,
    accountId: String(parsed.account_id),
    principalUrn,
    principalId: parsed.principal_id ? String(parsed.principal_id) : undefined,
    urnType,
    username,
  };
}

// Parse `hcloud IAM KeystoneListAuthDomains` stdout into the domain list.
export function parseAuthDomains(stdout) {
  let parsed;
  try {
    parsed = typeof stdout === 'string' ? JSON.parse(stdout) : stdout;
  } catch {
    return { ok: false, error: 'KeystoneListAuthDomains returned non-JSON output.' };
  }
  const domains = Array.isArray(parsed?.domains) ? parsed.domains : [];
  if (domains.length === 0) {
    return { ok: false, error: 'IAM returned no domain information. Verify the AK/SK is valid.' };
  }
  return {
    ok: true,
    domains: domains.map((d) => ({ id: String(d.id), name: String(d.name || '') })),
  };
}

// Judge primary vs sub-account. Rule (validated against 6 real credentials + 1 report case):
//   username == domainName  -> primary account (its operator user is named after the domain)
//   username != domainName  -> IAM sub-user (a sub-user cannot occupy the domain name)
// Two tempting-but-wrong rules, kept here so they are not "rediscovered":
//   - ShowDomainPasswordPolicy is NOT primary-only (it is permission-gated; a sub-user with IAM
//     permissions can call it) — observed live.
//   - principal_id == account_id does NOT hold for primary accounts either — observed on three
//     separate primary-account samples.
export function judgeAccountType(identity, domains) {
  if (identity.urnType !== 'user') {
    return {
      ok: true,
      applicable: false,
      reason:
        'Credentials are an agency session (principal_urn is not iam::…:user:…). ' +
        'The primary/sub-account judgment applies to user credentials only.',
      principalUrn: identity.principalUrn,
    };
  }
  const matched = domains.domains.find((d) => d.id === identity.accountId);
  if (!matched) {
    return {
      ok: false,
      error:
        'Inconsistent identity response: GetCallerIdentity account_id does not match any domain ' +
        'returned by KeystoneListAuthDomains. Retry, and re-run "npx huaweicloud-devkit auth init" if it persists.',
    };
  }
  const isPrimaryAccount = identity.username === matched.name;
  return {
    ok: true,
    applicable: true,
    isPrimaryAccount,
    domainId: matched.id,
    domainName: matched.name,
    username: identity.username,
    userId: identity.principalId,
    principalUrn: identity.principalUrn,
    evidence: isPrimaryAccount
      ? `username == domainName ("${identity.username}") — the primary account's operator user is named after the domain.`
      : `username ("${identity.username}") != domainName ("${matched.name}") — the caller is an IAM user under the domain.`,
  };
}

// Orchestrate the two read-only hcloud calls and judge the account type.
export async function checkAccountType({ region } = {}) {
  const regionArgs = region ? [`--cli-region=${region}`] : [];
  const identityResult = await runHcloud(['STS', 'GetCallerIdentity', ...regionArgs], {
    timeoutMs: 30000,
    maxRetries: 0,
  }).catch((error) => ({ ok: false, error: error.message }));
  if (!identityResult.ok) {
    return {
      ok: false,
      error: identityResult.error || 'STS GetCallerIdentity failed.',
      hint: 'Re-run "npx huaweicloud-devkit auth init" (invalid/expired AK/SK is the most common cause, e.g. APIGW.0301).',
    };
  }
  const identity = parseCallerIdentity(identityResult.stdout);
  if (!identity.ok) {
    return { ok: false, error: identity.error };
  }

  const domainsResult = await runHcloud(['IAM', 'KeystoneListAuthDomains'], {
    timeoutMs: 30000,
    maxRetries: 0,
  }).catch((error) => ({ ok: false, error: error.message }));
  if (!domainsResult.ok) {
    return {
      ok: false,
      error: domainsResult.error || 'IAM KeystoneListAuthDomains failed.',
      hint: 'Re-run "npx huaweicloud-devkit auth init" if credentials are suspected expired.',
    };
  }
  const domains = parseAuthDomains(domainsResult.stdout);
  if (!domains.ok) {
    return { ok: false, error: domains.error };
  }

  return judgeAccountType(identity, domains);
}
