// The huaweicloud_explain_error handler, split out of tools.ts. Derives
// the service key from dotted error-code prefixes, walks the
// service-keyed pattern tables, and surfaces an expired STS token as the
// primary cause before generic auth guidance.
import { parseStsExpiry, resolveCredentialsWithRuntime } from './auth/credentials.ts';
import type { ToolArgs } from './tools.ts';

// Huawei error codes are either a letter prefix + exactly four digits
// (APIGW.0301, Ecs.0019, KPS.9004, FSS.1078) or a non-dotted identifier key
// the per-service tables carry (OBS InvalidAccessKeyId, UserRestricted).
// The shape gate does double duty: placeholder errorCode values ('N/A', '*',
// 'TODO') must not suppress message extraction, and generic uppercase words
// before HTTP statuses ('FAILED.404', 'ERROR.500') must not become codes
// (loop round 3, seat-4).
const CODE_SHAPE_RE = /^[A-Za-z][A-Za-z0-9]{1,9}\.\d{4}$/;
const CODE_IDENT_RE = /^[A-Za-z][A-Za-z0-9_-]{4,}$/;
const PLACEHOLDER_CODE_RE =
  /^(?:n\/a|na|none|null|unknown|todo|-|\*|\?|0|error|err|failed|failure|timeout|exception|invalid|unauthorized)$/i;
const CODE_EXTRACT_RE = /(?<![A-Za-z0-9])[A-Z][A-Za-z]{1,9}\.\d{4}\b/;

function codeShaped(value: string): boolean {
  const trimmed = value.trim();
  if (PLACEHOLDER_CODE_RE.test(trimmed)) return false;
  return CODE_SHAPE_RE.test(trimmed) || CODE_IDENT_RE.test(trimmed);
}

export function explainError({
  service = 'unknown',
  errorCode = '',
  code = '',
  message = '',
  requestId = '',
}: ToolArgs = {}) {
  // `code` alias (UX report #11): the loose schema passes a `code` argument
  // straight through, but only `errorCode` was read — the caller's code was
  // silently dropped and the reply looked like "no pattern matched". The
  // resolution order is shape-gated (loop round 3): a code-shaped errorCode
  // wins; otherwise a code-shaped `code` alias; otherwise extract from the
  // message. Non-code garbage in either field falls through to extraction
  // instead of suppressing it.
  let resolvedCode = String(errorCode || '');
  if (!codeShaped(resolvedCode)) {
    const alias = String(code || '');
    const extracted = String(message || '').match(CODE_EXTRACT_RE)?.[0] ?? '';
    resolvedCode = codeShaped(alias) ? alias : extracted;
  }
  // The gate trims but the pipeline did not: ' Ecs.0019 ' passed the shape
  // gate then missed every table (loop round 3, seat-4 O2 — normalize once
  // after resolution).
  resolvedCode = resolvedCode.trim();
  const msg = String(message || '');
  const combined = `${resolvedCode} ${msg}`.toLowerCase();
  const suggestions: string[] = [];
  const svc = String(service).toLowerCase();

  const SERVICE_ALIASES: Record<string, string> = {
    functiongraph: 'FSS',
    fgs: 'FSS',
    ecs: 'Ecs',
    ECS: 'Ecs',
    kps: 'Kps',
    KPS: 'Kps',
    apic: 'APIG',
    apigw: 'APIGW',
    obs: 'OBS',
  };
  // #935 E2E-B1: real MCP calls pass only errorCode (e.g. Ecs.0019, KPS.9004)
  // with no service — derive the service key from the dotted-code prefix so the
  // service-keyed mapping table is hit. Behavior for an explicit real service
  // name is unchanged; absent/empty/'unknown' service derives from the prefix.
  let resolvedService = service;
  if ((!service || svc === 'unknown') && /^[A-Za-z]+\.\w+/.test(resolvedCode)) {
    const prefix = resolvedCode.split('.')[0]!.toLowerCase();
    resolvedService = SERVICE_ALIASES[prefix] ?? resolvedCode.split('.')[0]!.toUpperCase();
  }
  const patternKey = SERVICE_ALIASES[svc] || resolvedService;

  const hwErrorPatterns: Record<string, Record<string, string>> = {
    OBS: {
      InvalidAccessKeyId:
        'OBS uses AK/SK directly (not IAM tokens). Verify AK/SK validity, OBS endpoint, and OBS permissions.',
      UserRestricted:
        'This IAM user is restricted from OBS operations (403). Check IAM console → Users → Permissions: grant OBS bucket/object actions, or use an unrestricted account. If the account is a sub-account, the main account may have imposed restrictions.',
    },
    APIG: {
      'APIC.7241': 'The enterprise_project_id is required for enterprise accounts. Add --enterprise_project_id=0.',
      'APIC.7242':
        'The EIP binding method depends on loadbalancer_provider. Use AddIngressEipV2 for elb, AddEipV2 for lvs.',
      'APIC.7256': 'Bandwidth minimum is 5 Mbps. Use --bandwidth_size=5 or higher.',
      'APIC.7310': 'available_zone_ids must use AZ codes (e.g. ap-southeast-3a), NOT UUIDs from ListAvailableZonesV2.',
    },
    FSS: {
      'FSS.0403':
        'Missing FunctionGraph IAM permissions. Attach FunctionGraph FullAccess role or grant specific actions.',
      'FSS.1078': '--code_filename is filename-only (no path). cd to the file directory before running the command.',
      'FSS.1417':
        'event_data field validation failed. Check parameter format: use dotted key=value, verify required hidden-optional fields.',
    },
    VPC: {
      'VPC.0301': 'Bandwidth name is required for PER type EIPs, even though --help marks it optional.',
    },
    Ecs: {
      'Ecs.0707':
        'The flavor + image-type combination does not exist ("the product does not exist") — the error does not say which side is wrong, so check BOTH (#922): (1) the flavor is abandoned/sellout in this region/AZ (check os_extra_specs.cond:operation:status and cond:operation:az; see the huawei-ecs skill references/flavors.md for the AZ-vs-global-status conflict rule); (2) the image TYPE is incompatible with the flavor — market-type images fail with KunPeng flavors (kc1/kc2 etc.). Fix: switch the image to a gold-type image or switch to a compatible general-purpose flavor (verified: kc2.small.2 + market Ubuntu → Ecs.0707; s6.medium.2 + gold Ubuntu works), re-listing with hcloud ECS ListFlavors / hcloud IMS ListImages --__imagetype=gold first.',
      // #935 (report 4 problem 1 / report 1 坑5): real-world ECS order failures
      // with no mapping — flavor offline, AZ capacity, balance, keypair restriction.
      'Ecs.0019':
        'The flavor has been taken offline (Ecs.0019). Run `hcloud ECS ListFlavors --cli-region=<region>` to query currently on-sale flavors and switch to a replacement flavor (see the huawei-ecs skill references/flavors.md for the cond:operation:status field rules — a flavor marked 卖光/下线 keeps failing until you pick an on-sale one), then recreate.',
      'Ecs.0319':
        'The requested flavor has insufficient capacity in the selected availability zone (Ecs.0319). Fix: retry in a different availability zone, or switch to a replacement flavor (list on-sale flavors with `hcloud ECS ListFlavors --cli-region=<region>`), then recreate.',
      'Ecs.0044':
        'The requested volume type is sold out in the selected availability zone (Ecs.0044, e.g. "the volumeType [SATA] is sellout in az[cn-north-4a]"). This is the ROOT VOLUME/DISK type being unavailable — a different failure from Ecs.0319 (flavor capacity). Fix: switch `--server.root_volume.volumetype` to an available type (SAS/SSD/GPSSD — query availability first) or retry in a different availability zone (`hcloud ECS NovaListAvailabilityZones --cli-region=<region>`). ListFlavors does NOT pre-warn about volume-type sellouts — you only find out at order time.',
      'Ecs.0067':
        'Order submission rejected for balance reasons (Ecs.0067). Check the cash balance with `hcloud BSS ShowCustomerAccountBalances --cli-region=cn-north-1` and top up if needed — pay-per-use order risk control checks the CASH balance only (代金券/vouchers do NOT participate in order risk control; they only offset the bill at settlement). Also settle any historical arrears, however small, before retrying.',
    },
    Kps: {
      // #935 (report 1 坑5): KPS keypair creation has its own restriction code —
      // the Kps service had no entry at all, so the error fell through to generic advice.
      'KPS.9004':
        'Keypair creation rejected for account restrictions (KPS.9004). Check the cash balance with `hcloud BSS ShowCustomerAccountBalances --cli-region=cn-north-1` and top up if needed, and settle any historical arrears (even a small unpaid amount triggers this) — then retry `hcloud ECS NovaCreateKeypair` or create the keypair in the console.',
    },
    APIGW: {
      'APIGW.0301':
        'Incorrect IAM authentication information. The AK/SK is invalid (check the SK for typos), the security token is missing or expired, or the profile lacks project_id. Fix: re-run "npx huaweicloud-devkit auth init" (it auto-sets project_id), or set it manually: hcloud configure set --cli-project-id=<project_id> after finding it via hcloud IAM KeystoneListProjects --cli-region=<region> --name=<region>.',
      'APIGW.0802':
        'The current IAM user has no permissions in the requested region. Go to IAM console → Users → Permissions → add the target region, or switch to a different region.',
    },
  };
  // A pasted message usually arrives with a real service name (iam) whose own
  // table is empty, while the code's dotted prefix (APIGW) carries the entry —
  // fall back to the prefix-derived key whenever the service key has no table,
  // so extracted codes reach their answers (UX report #12 probe).
  let effectiveKey = patternKey;
  if (!hwErrorPatterns[effectiveKey] && /^[A-Za-z]+\.\w+/.test(resolvedCode)) {
    const prefix = resolvedCode.split('.')[0]!.toLowerCase();
    effectiveKey = SERVICE_ALIASES[prefix] ?? resolvedCode.split('.')[0]!.toUpperCase();
  }
  const patternTable = hwErrorPatterns[effectiveKey];
  if (patternTable) {
    const exact: string | undefined = patternTable[resolvedCode];
    if (exact) {
      suggestions.push(exact);
    } else {
      // Case-variant transcriptions (e.g. ECS.0019 echoed from console output)
      // derive the right service key but used to miss the case-sensitive entry —
      // the exact-hit scan is case-insensitive on the code. Deliberate divergence
      // from main: without it the prefix-derivation feature no-ops on any
      // non-canonical casing.
      const lowerCode = resolvedCode.toLowerCase();
      for (const [code, tip] of Object.entries(patternTable)) {
        if (code.toLowerCase() === lowerCode) {
          suggestions.push(tip);
          break;
        }
      }
    }
  }
  const svcPatterns: Record<string, string> = patternTable || {};
  const lowerErrorCode = resolvedCode.toLowerCase();
  for (const [code, tip] of Object.entries(svcPatterns)) {
    if (resolvedCode && code.toLowerCase().includes(lowerErrorCode)) {
      if (!suggestions.includes(tip)) suggestions.push(tip);
    }
  }

  // When the active credential set is a temporary STS token that has already
  // expired, surface that as the PRIMARY cause before generic auth guidance.
  let activeCreds;
  try {
    activeCreds = resolveCredentialsWithRuntime({ allowMissing: true });
  } catch {
    activeCreds = null;
  }
  if (activeCreds?.ak && activeCreds?.sk && activeCreds.securityToken) {
    const expiry = parseStsExpiry({ securityToken: activeCreds.securityToken });
    if (expiry !== null && expiry <= Date.now()) {
      suggestions.push(
        'CREDENTIAL_EXPIRED: the temporary STS security token has expired. Re-authenticate to obtain fresh credentials (e.g. run "npx huaweicloud-devkit auth init" or re-login / restart the session).',
      );
    }
  }

  if (/auth|token|credential|ak|sk|401|403|unauthorized|forbidden|Incorrect IAM/i.test(combined)) {
    if (svc === 'obs') {
      suggestions.push(
        'OBS uses AK/SK directly, not IAM tokens. Verify AK/SK validity and OBS bucket permissions via hcloud configure list or the Huawei Cloud console.',
      );
    } else {
      suggestions.push('Check KooCLI profile, region, project_id, and IAM permissions without printing secrets.');
    }
  }
  if (/APIGW\.(\d+)/i.test(resolvedCode)) {
    suggestions.push(
      'APIGW.' +
        (resolvedCode.match(/APIGW\.(\d+)/i) || [])[1] +
        ': API Gateway layer error. ' +
        (resolvedCode === 'APIGW.0802'
          ? 'IAM user has no region permissions — check IAM console → User → Permissions → add target region.'
          : resolvedCode === 'APIGW.0301'
            ? 'Incorrect IAM authentication information — verify AK/SK (SK typos are the usual cause), security token expiry, and that project_id is configured (auth init auto-sets it).'
            : 'Verify the API request, region endpoint, and IAM permissions.'),
    );
  }
  if (/region|endpoint|project/i.test(combined)) {
    suggestions.push('Confirm the service endpoint, region, and project_id match the target resource.');
  }
  if (/quota|limit|insufficient|reach the limit/i.test(combined)) {
    suggestions.push(
      'Check quota and resource limits before retrying a create or scale operation. Consider switching accounts or requesting a quota increase.',
    );
  }
  if (/not.?found|404/i.test(combined)) {
    if (/list.?regions/i.test(svc)) {
      suggestions.push('Use hcloud IAM KeystoneListRegions (not list-regions).');
    } else {
      suggestions.push('List resources in the same region/project and verify the resource identifier.');
    }
  }
  if (!suggestions.length) {
    suggestions.push(
      'No known error-code pattern matched. Re-run the failing command with --debug to capture ' +
        'X-Request-Id from the response headers, then re-call explain_error with service, operation, ' +
        'region, the full redacted message, and requestId.',
    );
    if (resolvedCode) {
      suggestions.push(
        `Search the error code "${resolvedCode}" in the Huawei Cloud error center (support.huaweicloud.com) for the authoritative cause.`,
      );
    }
  }

  if (requestId) {
    suggestions.push('Provide the Request ID (' + requestId + ') when contacting Huawei Cloud support.');
  }

  const uniqueSuggestions = suggestions.filter((s, i, arr) => {
    return !arr.slice(0, i).some((prev) => prev.substring(0, 50).toLowerCase() === s.substring(0, 50).toLowerCase());
  });

  return {
    service,
    errorCode: resolvedCode,
    requestId,
    suggestions: uniqueSuggestions,
  };
}
