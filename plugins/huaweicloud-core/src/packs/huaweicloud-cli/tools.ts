import { z } from 'zod';

import {
  runHcloud,
  planHcloudCommand,
  stripLeadingHcloudBinArgs,
  firstPlaceholderSecretArg,
  pinViewArgs,
  type HcloudRunResult,
} from '../../hcloud-cli.ts';
import { hcloudProbeNextStep, hcloudProbeRaw, probeHcloud, type ProbeHcloudOptions } from '../../hcloud-probe.ts';
import { redactSecrets } from '../../safety-policy.ts';
import { asText } from '../../lib/as-text.ts';
import { consumeApprovalToken, hashArgs, inspectApprovalToken } from '../../lib/approval-tokens.ts';
import { booleanArg, numericArg, stringArrayArg, vendorConfirmed } from '../../lib/tool-schema-parts.ts';
import type { PackToolDefinition, LooseToolSchema } from '../../lib/pack-types.ts';
import type { CallToolOptions, ToolArgs } from '../../tools.ts';
import { asRecord } from '../../lib/as-record.ts';

// The seven KooCLI-coupled execution tools sunk from core (src/tools.ts):
// version/profile inspection, plan/read-only/approved command execution,
// operation discovery, and region listing. The consent layer is imported
// directly from src/lib/approval-tokens.ts (the CLI face's consent module),
// not the hcloud-cli.ts re-export shim. The only allowWrites:true call site
// in the codebase (runApprovedCommand) lives here, so trimming this pack
// removes the CLI execution face and its approval tools together: a
// configuration trimmed of this pack has no devkit-side hcloud CLI write
// path, and the gateway face, when enabled, is a separate delegated write
// path.

export async function runVersionCheck(options: ProbeHcloudOptions = {}) {
  const result = probeHcloud(options);
  return {
    installed: result.installed,
    authenticated: result.ok && !/配置文件中不存在配置项|USE_ERROR.*配置/i.test(result.output || ''),
    errorCode: result.errorCode,
    status: result.status,
    output: result.output,
    kooCliVersion: result.requiredVersion || undefined,
    installedVersion: result.installedVersion || undefined,
    versionMismatch: Boolean(result.versionMismatch),
    nextStep: hcloudProbeNextStep(result),
    // #900: verbose English guidance lives only in this side-channel.
    raw: hcloudProbeRaw(result),
    authHint:
      'If hcloud is installed but commands fail with "配置文件中不存在配置项", run `npx huaweicloud-devkit auth init` outside agent chat to configure credentials.',
  };
}

async function showProfileRedacted(profile?: string) {
  const args = ['configure', 'show'];
  if (profile) {
    args.push('--cli-profile', String(profile));
  }
  // The catch fallback adds the blocked/reason markers on top of a run result.
  type ProfileRunResult = HcloudRunResult & { blocked?: boolean; reason?: string };
  const result: ProfileRunResult = await runHcloud(args, { allowWrites: false, allowCredentialRead: true }).catch(
    (error): ProfileRunResult => ({
      ok: false,
      blocked: true,
      reason: error instanceof Error ? error.message : String(error),
    }),
  );
  if (result.blocked) {
    return {
      ok: false,
      blockedByPolicy: true,
      reason: result.reason,
      safeAlternative:
        'Use huaweicloud_show_profile_redacted so profile output is returned through the redaction pipeline.',
    };
  }
  return {
    ok: result.ok,
    note: result.ok
      ? 'Profile information was returned through the toolkit redaction pipeline.'
      : 'Failed to retrieve profile — hcloud may not be installed or configured.',
    result: redactSecrets(result),
  };
}

const SERVICE_EXAMPLES: Record<string, { list: string; create: string; show: string }> = {
  ECS: { list: 'ECS ListServersDetails', create: 'ECS CreateServers', show: 'IMS GlanceShowImage' },
  VPC: { list: 'VPC ListVpcs', create: 'VPC CreateVpc', show: 'VPC ShowVpc' },
  FUNCTIONGRAPH: {
    list: 'FunctionGraph ListFunctions',
    create: 'FunctionGraph CreateFunction',
    show: 'FunctionGraph ShowFunctionConfig',
  },
  APIG: { list: 'APIG ListInstancesV2', create: 'APIG CreateInstanceV2', show: 'APIG ShowDetailsOfInstanceV2' },
  OBS: { list: 'OBS ls', create: 'OBS mb obs://<bucket>', show: 'OBS stat obs://<bucket>/<key>' },
  RDS: { list: 'RDS ListInstances', create: 'RDS CreateInstance', show: 'RDS ShowInstance' },
  CES: { list: 'CES ListAlarms', create: 'CES CreateAlarm', show: 'CES ListMetrics' },
  GAUSSDB: {
    list: 'GaussDB ListGaussMySqlInstances',
    create: 'GaussDB CreateGaussMySqlInstance',
    show: 'GaussDB ShowGaussMySqlInstanceInfo',
  },
  DDS: { list: 'DDS ListInstances', create: 'DDS CreateInstance', show: 'DDS ShowInstance' },
  DCS: { list: 'DCS ListInstances', create: 'DCS CreateInstance', show: 'DCS ShowInstance' },
};

// DMS and DEW are Huawei Cloud aggregate service names that do not exist as
// single KooCLI service identifiers. Each maps to real KooCLI sub-services.
const AGGREGATE_SERVICE_MAP: Record<string, string[]> = {
  DMS: ['Kafka', 'RabbitMQ', 'RocketMQ'],
  DEW: ['KMS', 'CSMS'],
};

// Identity-class notes per service. BSS leads: its operations are split between
// Customer-level APIs (work with a normal IAM user) and Partner-level APIs
// (only valid for a partner/dealer identity). Calling a Partner-level API with a
// customer credential returns APIGW.0301 even when AK/SK are perfectly valid —
// the common false-positive diagnosis is "cli-domain-id missing".
const SERVICE_IDENTITY_NOTES: Record<string, Array<{ identity: string; apis: string[]; note: string }>> = {
  BSS: [
    {
      identity: 'Customer-level (normal IAM user)',
      apis: [
        'ShowCustomerAccountBalances',
        'ListCustomerBillsFeeRecords',
        'ListCustomerCouponChangeRecords',
        'ListResourceUsage',
        'ListCosts',
      ],
      note: 'Work with a normal IAM user that has BSS Administrator or Finance role.',
    },
    {
      identity: 'Partner-level (partner/dealer only)',
      apis: ['ListQuotaCoupons', 'ListSubCustomerCoupons', 'ListSubCustomerBillDetail'],
      note: 'APIGW.0301 here means the caller identity is not a partner — NOT bad AK/SK or a missing cli-domain-id.',
    },
  ],
};

async function listOperations(service: string | undefined, options: { timeoutMs?: number } = {}) {
  const serviceName = String(service || '').trim();
  if (!/^[A-Za-z][A-Za-z0-9-]{1,63}$/.test(serviceName)) {
    throw new Error('service must be a KooCLI service name such as ECS, VPC, IMS, OBS, RDS, or CDN.');
  }
  const upperName = serviceName.toUpperCase();
  const subServices = AGGREGATE_SERVICE_MAP[upperName];
  if (subServices && subServices.length) {
    // Aggregate fan-out: return each sub-service's operations instead of failing
    // on the aggregate name directly (DMS/DEW do not exist as KooCLI services).
    const results = await Promise.all(
      subServices.map(async (sub) => {
        let result = await runHcloud([sub, '--help'], {
          timeoutMs: options.timeoutMs,
          maxRetries: 0,
        });
        if (!result.ok) {
          result = await runHcloud([sub, 'help'], {
            timeoutMs: options.timeoutMs,
            maxRetries: 0,
          });
        }
        return {
          subService: sub,
          command: `hcloud ${sub} --help`,
          examples: SERVICE_EXAMPLES[sub.toUpperCase()] || {
            note: `No cached examples for ${sub}. Use the help text above to discover available operations.`,
          },
          result,
        };
      }),
    );
    return {
      service: serviceName,
      aggregate: true,
      aggregatedFrom: subServices,
      selectionRule:
        'DMS/DEW are aggregate service names. Use each sub-service help text below to select the exact KooCLI operation name.',
      identityNotes: SERVICE_IDENTITY_NOTES[upperName] || null,
      subServices: results,
    };
  }
  const isObs = /^obs$/i.test(serviceName);
  const svc = isObs ? 'obs' : serviceName;
  const args = isObs ? ['obs', 'help'] : [svc, '--help'];
  let result = await runHcloud(args, {
    timeoutMs: options.timeoutMs,
    maxRetries: 0,
  });
  if (!result.ok && !isObs) {
    result = await runHcloud([svc, 'help'], {
      timeoutMs: options.timeoutMs,
      maxRetries: 0,
    });
  }
  return {
    service: serviceName,
    command: isObs ? 'hcloud obs help' : `hcloud ${svc} --help`,
    selectionRule:
      'Use this help text to select the exact KooCLI operation name before planning any service command. After selecting an operation, run "hcloud <Service> <Operation> --help" to confirm exact parameter names before constructing the command.',
    identityNotes: SERVICE_IDENTITY_NOTES[upperName] || null,
    examples: SERVICE_EXAMPLES[upperName] || {
      note: `No cached examples for ${serviceName}. Use the help text above to discover available operations.`,
    },
    result,
  };
}

async function runApprovedCommand(args: ToolArgs = {}) {
  if (args.approvedByUser !== true) {
    throw new Error('approvedByUser must be true after explicit user approval for this exact command.');
  }
  const token = String(args.approvalToken || '');

  // D4-24 precise JSON contract (#745): expired and already-consumed tokens
  // return a structured result instead of throwing a generic Error string, so
  // clients can machine-assert the two non-success states.
  const inspection = inspectApprovalToken(token);
  if (inspection.state === 'already_consumed') {
    return { status: 'ok', outcome: 'already_processed' };
  }
  if (inspection.state === 'expired') {
    return { status: 'rejected', code: 'CONFIRM_TOKEN_EXPIRED' };
  }
  if (inspection.state === 'not_found') {
    // A token that was never created (typo / unknown / pruned beyond the
    // tombstone window) is still a rejection, but carries no expired/already
    // semantics — surface a distinct code so clients can tell the cases apart.
    return { status: 'rejected', code: 'CONFIRM_TOKEN_NOT_FOUND' };
  }

  const providedArgs = Array.isArray(args.args) ? args.args.map(String) : [];
  // The token binds the plan's EFFECTIVE args (the plan strips a leading bin
  // token before minting), so the verify side normalizes the same way: a run
  // call that echoes the plan verbatim and one that sends the cleaned args
  // both hash to the stored value, while any real argument change still
  // rejects. Without this, a prefixed plan followed by a self-corrected run
  // burned the single-use token on a mismatch (2026-11-05 UX report #6, the
  // approval-trap probe).
  const { args: effectiveArgs } = stripLeadingHcloudBinArgs(providedArgs);
  // A placeholder-shaped secret VALUE at run time is never a real secret:
  // executing a literal `<redacted>`/`<password>` as the password is always
  // wrong. This guard runs BEFORE the token is consumed, so its own guidance
  // (replace the value, then re-run) stays followable on the same approval
  // (loop round 3, seat-1 B3: the guidance used to be a dead end — the
  // rejection burned the only token).
  const placeholderArg = firstPlaceholderSecretArg(effectiveArgs);
  if (placeholderArg) {
    throw new Error(
      `The argument "${placeholderArg}" still carries a placeholder secret value: replace <redacted> with the actual value the user approved, then re-run with the same approval token.`,
    );
  }

  const stored = consumeApprovalToken(token);
  if (!stored) {
    // Defensive: inspectApprovalToken said 'valid' but consume returned null.
    // The only path is the O_EXCL claim losing a race — another consumer is
    // spending this exact token right now — so classify as already_consumed
    // (never a misleading success, never a false not_found).
    const recheck = inspectApprovalToken(token);
    if (recheck.state === 'expired') return { status: 'rejected', code: 'CONFIRM_TOKEN_EXPIRED' };
    return { status: 'ok', outcome: 'already_processed' };
  }
  if (hashArgs(effectiveArgs) !== stored.argsHash) {
    // The pin view is the canonical fold for the substitution comparison
    // (loop round 4, seat-1 B2): it folds the two-token/glued secret forms
    // the redactor never did, so following the placeholder guidance on a
    // two-token plan no longer dead-ends in a mismatch. Pre-schema entries
    // (no argsPinView) fall back to the redactor comparison.
    const storedView = JSON.stringify(stored.argsPinView ?? stored.argsRedacted);
    const providedView = JSON.stringify(pinViewArgs(effectiveArgs));
    if (storedView !== providedView) {
      throw new Error(
        'Provided args do not match the approved plan. Use the exact args from the plan. ' +
          'If the plan shows <redacted> for passwords or secrets, replace <redacted> with the actual values.',
      );
    }
    // Views equal means ONLY secret values differ. The plan carried real
    // (non-placeholder) secrets → they are pinned: a different real secret
    // rejects (loop round 2, the seat-2 A3 probe — a changed password used
    // to execute). A placeholder-bearing plan (secretsSubstitutable) keeps
    // the documented substitution flow.
    if (stored.secretsSubstitutable !== true) {
      // The message deliberately does not assert WHY the plan pinned: the
      // detector is key-shape heuristic, so the plan may have carried real
      // secrets, placeholder-adjacent values, or JSON-body forms where the
      // substitution contract is not reliable (loop round 9, seat-1 B1/B2).
      throw new Error(
        'Secret values are pinned to the approved plan: re-run huaweicloud_plan_cli_command with the final values and re-approve.',
      );
    }
  }
  const strictPlan = planHcloudCommand(effectiveArgs, { allowWrites: false });
  const result = await runHcloud(effectiveArgs, {
    allowWrites: true,
    timeoutMs: args.timeoutMs,
    maxRetries: args.maxRetries,
    cwd: args.cwd,
    stdin: args.stdin,
  });
  // Spread instead of in-place mutation: identical serialized content, minus a
  // write to the HcloudRunResult shape owned by hcloud-cli.ts.
  return { ...result, approved: true, plan: strictPlan };
}

async function listRegions() {
  const result = await runHcloud(['IAM', 'KeystoneListRegions'], { timeoutMs: 30000, maxRetries: 0 }).catch(
    (error): HcloudRunResult => ({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }),
  );
  if (!result.ok) {
    return {
      ok: false,
      error: result.error || 'Failed to list regions.',
      fallback: 'Check https://developer.huaweicloud.com/endpoint for available regions.',
      staticRegions: [
        { id: 'cn-north-1', description: '华北-北京一' },
        { id: 'cn-north-4', description: '华北-北京四' },
        { id: 'cn-east-3', description: '华东-上海一' },
        { id: 'cn-east-2', description: '华东-上海二' },
        { id: 'cn-south-1', description: '华南-广州' },
        { id: 'ap-southeast-1', description: '香港' },
        { id: 'ap-southeast-3', description: '新加坡' },
        { id: 'ap-southeast-2', description: '曼谷' },
        { id: 'af-south-1', description: '约翰内斯堡' },
      ],
      note: 'hcloud unavailable. Showing static region list. For the complete list, visit the fallback URL.',
    };
  }
  let regions: Array<Record<string, unknown>>;
  try {
    const parsed: unknown = typeof result.stdout === 'string' ? JSON.parse(result.stdout) : result.stdout;
    const rawRegionsValue = asRecord(parsed).regions;
    const rawRegions = Array.isArray(rawRegionsValue) ? rawRegionsValue : [];
    regions = rawRegions.map((r) => {
      const record = asRecord(r);
      return {
        id: record.id,
        description: record.description || record.names,
        type: record.type,
        locales: record.locales,
      };
    });
  } catch {
    regions = [{ raw: String(result.stdout).substring(0, 1000) }];
  }
  regions.sort((a, b) => asText(a.id || '').localeCompare(asText(b.id || '')));
  return { ok: true, count: regions.length, regions };
}

async function handleCheckCli(_args: ToolArgs = {}, _opts: CallToolOptions = {}) {
  return runVersionCheck();
}

async function handlePlanCliCommand(args: ToolArgs = {}, _opts: CallToolOptions = {}) {
  return planHcloudCommand(args.args || [], { allowWrites: args.allowWrites === true });
}

async function handleRunReadonlyCommand(args: ToolArgs = {}, _opts: CallToolOptions = {}) {
  return runHcloud(args.args || [], {
    timeoutMs: args.timeoutMs,
    maxRetries: args.maxRetries,
    cwd: args.cwd,
    stdin: args.stdin,
  });
}

async function handleListOperations(args: ToolArgs = {}, _opts: CallToolOptions = {}) {
  return listOperations(args.service, { timeoutMs: args.timeoutMs });
}

async function handleRunApprovedCommand(args: ToolArgs = {}, _opts: CallToolOptions = {}) {
  return runApprovedCommand(args);
}

async function handleShowProfileRedacted(args: ToolArgs = {}, _opts: CallToolOptions = {}) {
  return showProfileRedacted(args.profile);
}

async function handleListRegions(_args: ToolArgs = {}, _opts: CallToolOptions = {}) {
  return listRegions();
}

const checkCliSchema = z.looseObject({ vendorConfirmed });
const planCliCommandSchema = z.looseObject({
  vendorConfirmed,
  args: stringArrayArg.describe('hcloud arguments, excluding the hcloud executable.'),
  allowWrites: booleanArg.optional().describe('Only true after explicit user approval for this exact operation.'),
});
const runReadonlyCommandSchema = z.looseObject({
  vendorConfirmed,
  args: stringArrayArg,
  timeoutMs: numericArg.optional().describe('Optional timeout in milliseconds. Defaults to 60000.'),
  maxRetries: numericArg.optional().describe('Optional retry count for transient network errors. Defaults to 1.'),
  cwd: z.string().optional().describe('Optional working directory for the hcloud process.'),
});
const listOperationsSchema = z.looseObject({
  vendorConfirmed,
  service: z.string().describe('KooCLI service name, such as ECS, VPC, IMS, OBS, RDS, or CDN.'),
  timeoutMs: numericArg.optional().describe('Optional timeout in milliseconds. Defaults to 60000.'),
});
const runApprovedCommandSchema = z.looseObject({
  vendorConfirmed,
  args: stringArrayArg.describe('hcloud arguments, excluding the hcloud executable.'),
  approvalToken: z.string().describe('The approvalToken returned by huaweicloud_plan_cli_command.'),
  approvedByUser: booleanArg.describe('Must be true only after the user explicitly approves this exact command.'),
  timeoutMs: numericArg.optional().describe('Optional timeout in milliseconds. Defaults to 60000.'),
  maxRetries: numericArg.optional().describe('Optional retry count for transient network errors. Defaults to 1.'),
  cwd: z.string().optional().describe('Optional working directory for the hcloud process.'),
});
const showProfileRedactedSchema = z.looseObject({
  vendorConfirmed,
  profile: z.string().optional().describe('Optional KooCLI profile name.'),
});
const listRegionsSchema = z.looseObject({ vendorConfirmed });

export const HUAWEICLOUD_CLI_TOOLS = [
  {
    name: 'huaweicloud_check_cli',
    description:
      'Check whether Huawei Cloud KooCLI hcloud is installed and whether its version matches the plugin paired version. Returns redacted output. Vendor-gated (vendorConfirmed): call only when the vendor is established — see the vendorConfirmed parameter description; when unknown, ask which cloud the user means first.',
    schema: checkCliSchema,
    handler: handleCheckCli,
  },
  {
    name: 'huaweicloud_plan_cli_command',
    description:
      'Classify and plan a Huawei Cloud hcloud command without executing it. Vendor-gated (vendorConfirmed): call only when the vendor is established — see the vendorConfirmed parameter description; when unknown, ask which cloud the user means first.',
    schema: planCliCommandSchema,
    handler: handlePlanCliCommand,
  },
  {
    name: 'huaweicloud_run_readonly_command',
    description:
      'Run a read-only hcloud command through the toolkit safety policy and redact output. Vendor-gated (vendorConfirmed): call only when the vendor is established — see the vendorConfirmed parameter description; when unknown, ask which cloud the user means first.',
    schema: runReadonlyCommandSchema,
    handler: handleRunReadonlyCommand,
  },
  {
    name: 'huaweicloud_list_operations',
    description:
      'List KooCLI operations for a Huawei Cloud service by running local/read-only hcloud <Service> --help. Vendor-gated (vendorConfirmed): call only when the vendor is established — see the vendorConfirmed parameter description; when unknown, ask which cloud the user means first.',
    schema: listOperationsSchema,
    handler: handleListOperations,
  },
  {
    name: 'huaweicloud_run_approved_command',
    description:
      'Run a write-capable hcloud command only after the exact command has been shown and explicitly approved by the user. Vendor-gated (vendorConfirmed): call only when the vendor is established — see the vendorConfirmed parameter description; when unknown, ask which cloud the user means first.',
    schema: runApprovedCommandSchema,
    handler: handleRunApprovedCommand,
  },
  {
    name: 'huaweicloud_show_profile_redacted',
    description:
      'Inspect a KooCLI profile through hcloud configure show and return only redacted output. Vendor-gated (vendorConfirmed): call only when the vendor is established — see the vendorConfirmed parameter description; when unknown, ask which cloud the user means first.',
    schema: showProfileRedactedSchema,
    handler: handleShowProfileRedacted,
  },
  {
    name: 'huaweicloud_list_regions',
    description:
      'List available Huawei Cloud regions. Returns region IDs, display names, and endpoints. Use when the agent needs to discover available regions before creating resources. Vendor-gated (vendorConfirmed): call only when the vendor is established — see the vendorConfirmed parameter description; when unknown, ask which cloud the user means first.',
    schema: listRegionsSchema,
    handler: handleListRegions,
  },
] as const satisfies readonly PackToolDefinition[];

export type HuaweicloudCliToolName = (typeof HUAWEICLOUD_CLI_TOOLS)[number]['name'];

// Schema map keyed by tool name for src/tool-schemas.ts: TOOL_SCHEMAS spreads
// it in place, keeping the satisfies Record<ToolName, LooseToolSchema>
// completeness check over every ToolName key.
export const HUAWEICLOUD_CLI_TOOL_SCHEMAS: Readonly<Record<HuaweicloudCliToolName, LooseToolSchema>> = {
  huaweicloud_check_cli: checkCliSchema,
  huaweicloud_plan_cli_command: planCliCommandSchema,
  huaweicloud_run_readonly_command: runReadonlyCommandSchema,
  huaweicloud_list_operations: listOperationsSchema,
  huaweicloud_run_approved_command: runApprovedCommandSchema,
  huaweicloud_show_profile_redacted: showProfileRedactedSchema,
  huaweicloud_list_regions: listRegionsSchema,
};

// Dispatch map merged into PACK_TOOL_HANDLERS in packs/registry.ts. Typed
// over HuaweicloudCliToolName, so a tool added to HUAWEICLOUD_CLI_TOOLS
// without a handler entry here — or the reverse — fails to compile instead
// of failing at runtime.
export const HUAWEICLOUD_CLI_TOOL_HANDLERS: Readonly<Record<HuaweicloudCliToolName, PackToolDefinition['handler']>> = {
  huaweicloud_check_cli: handleCheckCli,
  huaweicloud_plan_cli_command: handlePlanCliCommand,
  huaweicloud_run_readonly_command: handleRunReadonlyCommand,
  huaweicloud_list_operations: handleListOperations,
  huaweicloud_run_approved_command: handleRunApprovedCommand,
  huaweicloud_show_profile_redacted: handleShowProfileRedacted,
  huaweicloud_list_regions: handleListRegions,
};
