import { z } from 'zod';

import { runHcloud, planHcloudCommand, type HcloudRunResult } from '../../hcloud-cli.ts';
import { hcloudProbeNextStep, probeHcloud, type ProbeHcloudOptions } from '../../hcloud-probe.ts';
import { redactSecrets } from '../../safety-policy.ts';
import { asText } from '../../lib/as-text.ts';
import { consumeApprovalToken, hashArgs } from '../../lib/approval-tokens.ts';
import { numericArg } from '../../lib/tool-schema-parts.ts';
import type { PackToolDefinition, LooseToolSchema } from '../../lib/pack-types.ts';
import type { CallToolOptions, ToolArgs } from '../../tools.ts';

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

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

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
  GAUSSDB: { list: 'GaussDB ListInstances', create: 'GaussDB CreateInstance', show: 'GaussDB ShowInstance' },
  DDS: { list: 'DDS ListInstances', create: 'DDS CreateInstance', show: 'DDS ShowInstance' },
  DCS: { list: 'DCS ListInstances', create: 'DCS CreateInstance', show: 'DCS ShowInstance' },
};

async function listOperations(service: string | undefined, options: { timeoutMs?: number } = {}) {
  const serviceName = String(service || '').trim();
  if (!/^[A-Za-z][A-Za-z0-9-]{1,63}$/.test(serviceName)) {
    throw new Error('service must be a KooCLI service name such as ECS, VPC, IMS, OBS, RDS, or CDN.');
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
    selectionRule: 'Use this help text to select the exact KooCLI operation name before planning any service command.',
    examples: SERVICE_EXAMPLES[serviceName.toUpperCase()] || {
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
  const stored = consumeApprovalToken(token);
  if (!stored) {
    throw new Error('Invalid or expired approval token. Please re-plan the command.');
  }
  const providedArgs = Array.isArray(args.args) ? args.args.map(String) : [];
  if (hashArgs(providedArgs) !== stored.argsHash) {
    const redactedStored = JSON.stringify(stored.argsRedacted);
    const redactedProvided = JSON.stringify(redactSecrets(providedArgs));
    if (redactedStored !== redactedProvided) {
      throw new Error(
        'Provided args do not match the approved plan. Use the exact args from the plan. ' +
          'If the plan shows <redacted> for passwords or secrets, replace <redacted> with the actual values in approvedCommand.',
      );
    }
  }
  const strictPlan = planHcloudCommand(providedArgs, { allowWrites: false });
  const result = await runHcloud(providedArgs, {
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

const checkCliSchema = z.looseObject({});
const planCliCommandSchema = z.looseObject({
  args: z.array(z.string()).describe('hcloud arguments, excluding the hcloud executable.'),
  allowWrites: z.boolean().optional().describe('Only true after explicit user approval for this exact operation.'),
});
const runReadonlyCommandSchema = z.looseObject({
  args: z.array(z.string()),
  timeoutMs: numericArg.optional().describe('Optional timeout in milliseconds. Defaults to 60000.'),
  maxRetries: numericArg.optional().describe('Optional retry count for transient network errors. Defaults to 1.'),
  cwd: z.string().optional().describe('Optional working directory for the hcloud process.'),
});
const listOperationsSchema = z.looseObject({
  service: z.string().describe('KooCLI service name, such as ECS, VPC, IMS, OBS, RDS, or CDN.'),
  timeoutMs: numericArg.optional().describe('Optional timeout in milliseconds. Defaults to 60000.'),
});
const runApprovedCommandSchema = z.looseObject({
  args: z.array(z.string()).describe('hcloud arguments, excluding the hcloud executable.'),
  approvalToken: z.string().describe('The approvalToken returned by huaweicloud_plan_cli_command.'),
  approvedByUser: z.boolean().describe('Must be true only after the user explicitly approves this exact command.'),
  timeoutMs: numericArg.optional().describe('Optional timeout in milliseconds. Defaults to 60000.'),
  maxRetries: numericArg.optional().describe('Optional retry count for transient network errors. Defaults to 1.'),
  cwd: z.string().optional().describe('Optional working directory for the hcloud process.'),
});
const showProfileRedactedSchema = z.looseObject({
  profile: z.string().optional().describe('Optional KooCLI profile name.'),
});
const listRegionsSchema = z.looseObject({});

export const HUAWEICLOUD_CLI_TOOLS = [
  {
    name: 'huaweicloud_check_cli',
    description:
      'Check whether Huawei Cloud KooCLI hcloud is installed and whether its version matches the plugin paired version. Returns redacted output.',
    schema: checkCliSchema,
    handler: handleCheckCli,
  },
  {
    name: 'huaweicloud_plan_cli_command',
    description: 'Classify and plan a Huawei Cloud hcloud command without executing it.',
    schema: planCliCommandSchema,
    handler: handlePlanCliCommand,
  },
  {
    name: 'huaweicloud_run_readonly_command',
    description: 'Run a read-only hcloud command through the toolkit safety policy and redact output.',
    schema: runReadonlyCommandSchema,
    handler: handleRunReadonlyCommand,
  },
  {
    name: 'huaweicloud_list_operations',
    description:
      'List KooCLI operations for a Huawei Cloud service by running local/read-only hcloud <Service> --help.',
    schema: listOperationsSchema,
    handler: handleListOperations,
  },
  {
    name: 'huaweicloud_run_approved_command',
    description:
      'Run a write-capable hcloud command only after the exact command has been shown and explicitly approved by the user.',
    schema: runApprovedCommandSchema,
    handler: handleRunApprovedCommand,
  },
  {
    name: 'huaweicloud_show_profile_redacted',
    description: 'Inspect a KooCLI profile through hcloud configure show and return only redacted output.',
    schema: showProfileRedactedSchema,
    handler: handleShowProfileRedacted,
  },
  {
    name: 'huaweicloud_list_regions',
    description:
      'List available Huawei Cloud regions. Returns region IDs, display names, and endpoints. Use when the agent needs to discover available regions before creating resources.',
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
