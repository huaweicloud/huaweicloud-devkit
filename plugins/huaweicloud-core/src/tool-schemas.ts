import { z } from 'zod';

import type { ToolName } from './tools.ts';
import type { LooseToolSchema } from './lib/pack-types.ts';
import { PACK_IDS } from './lib/pack-types.ts';
import { looseObject } from './lib/tool-schema-parts.ts';
import { UPDATE_TOOL_SCHEMAS } from './packs/update/tools.ts';
import { HUAWEICLOUD_OPEN_MCP_TOOL_SCHEMAS } from './packs/huaweicloud-open-mcp/tools.ts';
import { HUAWEICLOUD_CLI_TOOL_SCHEMAS } from './packs/huaweicloud-cli/tools.ts';
import { AUTH_TOOL_SCHEMAS } from './packs/auth/tools.ts';
import { OBS_TOOL_SCHEMAS } from './packs/obs/tools.ts';
import { VOUCHER_TOOL_SCHEMAS } from './packs/voucher/tools.ts';
import { DISCOVERY_TOOL_SCHEMAS } from './packs/discovery/tools.ts';
import { SANDBOX_TOOL_SCHEMAS } from './packs/sandbox/tools.ts';
import { SECRETS_TOOL_SCHEMAS } from './packs/secrets/tools.ts';

// LooseToolSchema now lives in src/lib/pack-types.ts (shared pack vocabulary);
// re-exported here so existing import sites keep working.
export type { LooseToolSchema };

// Keys stripped from z.toJSONSchema() output before huaweicloud_pack_info
// returns a tool schema: the MCP SDK renders tools/list through its draft-7
// compatibility layer while z.toJSONSchema() defaults to 2020-12, so the
// $schema discriminator is the only key that differs between the two renders.
export const SCHEMA_DRIFT_IGNORED_KEYS = ['$schema'] as const;

// Shared zod building blocks (numericArg, looseObject, gitConfig,
// workspaceId, username) moved to src/lib/tool-schema-parts.ts so the sandbox
// pack can value-import them without a cycle against this file's pack schema
// spreads.

const artifactsItem = z.looseObject({
  path: z.string(),
  content: z.string(),
});

const TOOL_SCHEMAS = {
  huaweicloud_hook_check_command: z.looseObject({
    command: z.string().describe('The exact command text to inspect.'),
  }),
  huaweicloud_hook_check_artifacts: z.looseObject({
    artifacts: z.array(artifactsItem),
  }),
  huaweicloud_hook_check_deploy_plan: z.looseObject({
    plan: z
      .union([looseObject, z.array(z.unknown()), z.string()])
      .describe('Deployment plan as an object, array, or string.'),
  }),
  huaweicloud_service_catalog: z.looseObject({
    intent: z
      .string()
      .optional()
      .describe('Developer intent to route, such as deploy app, use API, debug error, or inspect resources.'),
  }),
  huaweicloud_explain_error: z.looseObject({
    service: z.string().optional(),
    errorCode: z.string().optional(),
    message: z.string().optional(),
    requestId: z.string().optional(),
  }),
  huaweicloud_search_docs: z.looseObject({
    query: z.string().describe('Search query across skill descriptions and documentation.'),
    topic: z
      .string()
      .optional()
      .describe('Optional filter: all | ecs | obs | vpc | iam | rds | cce | modelarts | dew. Defaults to all.'),
  }),
  huaweicloud_retrieve_skill: z.looseObject({
    name: z
      .string()
      .regex(/^[a-z0-9-]+$/)
      .describe('Skill name, e.g., huawei-ecs, huawei-vpc, huawei-obs. Lowercase letters, digits, dashes only.'),
  }),
  huaweicloud_get_regional_availability: z.looseObject({
    service: z.string().describe('Service name: ecs, obs, rds, gaussdb, cce, modelarts, functiongraph, etc.'),
    region: z.string().describe('Region ID: cn-south-1, cn-north-4, ap-southeast-3, etc.'),
  }),
  // The discovery pack owns its tool schemas (src/packs/discovery/tools.ts);
  // the spread keeps them in TOOL_SCHEMAS so the satisfies check below still
  // covers every ToolName key.
  ...DISCOVERY_TOOL_SCHEMAS,
  // The obs pack owns its tool schemas (src/packs/obs/tools.ts); the
  // spread keeps them in TOOL_SCHEMAS so the satisfies check below still
  // covers every ToolName key.
  ...OBS_TOOL_SCHEMAS,
  // The voucher pack owns its tool schemas (src/packs/voucher/tools.ts);
  // the spread keeps them in TOOL_SCHEMAS so the satisfies check below still
  // covers every ToolName key.
  ...VOUCHER_TOOL_SCHEMAS,
  // The auth pack owns its tool schemas (src/packs/auth/tools.ts); the
  // spread keeps them in TOOL_SCHEMAS so the satisfies check below still
  // covers every ToolName key.
  ...AUTH_TOOL_SCHEMAS,
  // The sandbox pack owns its tool schemas (src/packs/sandbox/tools.ts);
  // the spread keeps them in TOOL_SCHEMAS so the satisfies check below still
  // covers every ToolName key.
  ...SANDBOX_TOOL_SCHEMAS,
  // The update pack owns its tool schemas (src/packs/update/tools.ts); the
  // spread keeps them in TOOL_SCHEMAS so the satisfies check below still
  // covers every ToolName key.
  ...UPDATE_TOOL_SCHEMAS,
  // The huaweicloud-open-mcp pack owns its tool schemas
  // (src/packs/huaweicloud-open-mcp/tools.ts);
  // the spread keeps them in TOOL_SCHEMAS so the satisfies check below still
  // covers every ToolName key.
  ...HUAWEICLOUD_OPEN_MCP_TOOL_SCHEMAS,
  // The huaweicloud-cli pack owns its tool schemas (the seven KooCLI
  // execution tools sunk from core; src/packs/huaweicloud-cli/tools.ts);
  // the spread keeps them in TOOL_SCHEMAS so the satisfies check below still
  // covers every ToolName key.
  ...HUAWEICLOUD_CLI_TOOL_SCHEMAS,
  // The secrets pack owns its tool schemas (src/packs/secrets/tools.ts);
  // same spread contract.
  ...SECRETS_TOOL_SCHEMAS,
  huaweicloud_list_packs: z.looseObject({}),
  huaweicloud_pack_info: z.looseObject({
    pack: z
      .string()
      .describe(
        'Pack id from huaweicloud_list_packs, such as core, huaweicloud-cli, sandbox, auth, obs, voucher, update, discovery, huaweicloud-open-mcp.',
      ),
  }),
  // The pack filter is deliberately z.string (handler-side PACKS lookup),
  // not z.enum(PACK_IDS): the unknown-id error must name every valid id at
  // the handler boundary so callTool-driven callers and SDK-validated MCP
  // callers see the same shape packs_configure's enum boundary would split.
  huaweicloud_list_skills: z.looseObject({
    pack: z
      .string()
      .optional()
      .describe(
        'Optional pack id filter from huaweicloud_list_packs. Skill-owning packs (huaweicloud-cli, sandbox, obs, voucher, huaweicloud-open-mcp) list their skills; a valid zero-skill pack (auth, update, discovery, secrets) returns an empty list; the core pack is refused with an explanation (its six meta-skills are excluded by design). Omit to list every enabled pack\u2019s skills.',
      ),
  }),
  huaweicloud_packs_configure: z.looseObject({
    enable: z
      .array(z.enum(PACK_IDS))
      .optional()
      .describe(
        'Pack ids to enable for this session, e.g. ["obs", "sandbox"]. Ignored when the surface is already full.',
      ),
    disable: z
      .array(z.enum(PACK_IDS))
      .optional()
      .describe('Pack ids to disable for this session. core cannot be disabled.'),
    reset: z
      .boolean()
      .optional()
      .describe('Drop the session override and return to the operator DEVKIT_PACKS posture.'),
  }),
} satisfies Record<ToolName, LooseToolSchema>;

export type ToolSchemaMap = typeof TOOL_SCHEMAS;
export type ToolSchemaEntry = ToolSchemaMap[ToolName];

export function getToolSchema(name: ToolName): LooseToolSchema {
  return TOOL_SCHEMAS[name];
}

export function toolSchemaEntries(): Array<[ToolName, LooseToolSchema]> {
  return Object.entries(TOOL_SCHEMAS) as Array<[ToolName, LooseToolSchema]>;
}

// Runtime guard: every entry must be a constructed zod loose-object. A bare
// raw shape would be wrapped by the SDK into STRIP semantics, silently
// dropping client keys instead of passing them through.
export function assertConstructedSchemas(): void {
  for (const [name, schema] of toolSchemaEntries()) {
    const def = (schema as unknown as { _zod?: { def?: { shape?: unknown } } })._zod?.def;
    if (!def || !('shape' in def)) {
      throw new Error(`tool schema for ${name} is not a constructed zod loose-object`);
    }
  }
}

export { TOOL_SCHEMAS };
