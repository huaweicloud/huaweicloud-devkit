import { z } from 'zod';

import { asText } from '../../lib/as-text.ts';
import type { PackToolDefinition, LooseToolSchema } from '../../lib/pack-types.ts';
import { redactSecrets } from '../../safety-policy.ts';
import { classify, GATEWAY_TOOL_VOCABULARY, resolveApprovalMode } from './approval.ts';
import { callOpenMcpTool, listGatewayTools, openMcpSidecar, restartOpenMcpSidecar } from './sidecar.ts';

// Three tools over the huaweicloud-open-mcp gateway: the generic call
// face (every gateway tool, discovery and execution alike), the live
// surface listing, and one lifecycle tool that recycles the gateway child
// in-session. The six first-class discovery proxies were deleted in favor
// of the single call face: classify() in approval.ts is now the only path
// to the sidecar's tools/call, and gateway_call's served description
// (owned here; src/tools.ts derives it from this array) is the zero-cost
// name-discovery path at the tools/list layer. The
// gateway is the authoritative validator of its own tool inputs; the zod
// schema here only guards the boundary, and the sidecar normalizes
// results to {ok, tool, ...}.
// Every gateway tool is reachable through huaweicloud_gateway_call on the
// delegated approval face: approval.ts rules only the devkit floors
// (secret operations, the protected state tree, manage_policy shape) and
// forwards everything else to the gateway's own policy engine, whose
// refusal reason teaches the consent flow (confirm with the user, grant
// via manage_policy with an ephemeral scope, retry).

const gatewayRestartSchema = z.looseObject({});

const gatewayListToolsSchema = z.looseObject({});

const gatewayCallSchema = z.looseObject({
  tool: z.string().describe('Gateway tool name, e.g. execute_api, query_data (see huaweicloud_gateway_list_tools).'),
  toolArgs: z.record(z.string(), z.unknown()).optional().describe('Arguments object for the gateway tool.'),
});

// In-process lifecycle only — no hcloud I/O, so no CLI-face approval
// token (the auth_init class of state mutation, not the
// run_approved_command class).
async function handleGatewayRestart() {
  try {
    const { pid, spawns } = await restartOpenMcpSidecar();
    return { ok: true, pid, spawns, note: 'gateway recycled; an upgraded binary is now active' };
  } catch (error) {
    // The spawn/handshake rejection can embed child stderr; same envelope
    // callOpenMcpTool already redacts one layer down.
    return { ok: false, error: redactSecrets(error instanceof Error ? error.message : String(error)) };
  }
}

// The devkit's projection of the gateway surface, DERIVED from the one
// vocabulary table in approval.ts (readonly + routed): the six read-only
// discovery tools plus the four stateful names classify() routes.
// gateway_list_tools reports drift between this list and the child's live
// tools/list so an agent can see what a generic call can reach.
const KNOWN_GATEWAY_TOOLS: readonly string[] = [...GATEWAY_TOOL_VOCABULARY.readonly, ...GATEWAY_TOOL_VOCABULARY.routed];

async function handleGatewayListTools() {
  try {
    const tools = await listGatewayTools();
    const live = new Set(tools.map((entry) => entry.name));
    const missing = KNOWN_GATEWAY_TOOLS.filter((name) => !live.has(name));
    return {
      ok: true,
      count: tools.length,
      tools,
      drift: {
        missing,
        note:
          missing.length > 0
            ? `warning: the live gateway surface no longer exposes ${missing.join(', ')}; calls to these names are still forwarded and fail at the gateway with Unknown tool`
            : 'the live surface covers every gateway tool the devkit projects',
      },
    };
  } catch (error) {
    return { ok: false, error: redactSecrets(error instanceof Error ? error.message : String(error)) };
  }
}

async function handleGatewayCall(args: Record<string, unknown>) {
  const tool = asText(args.tool || '').trim();
  const rawToolArgs = args.toolArgs;
  if (!tool) return { ok: false, error: 'tool is required' };
  // Explicit, not silent coercion: the MCP boundary already rejects these
  // shapes, but direct callTool callers would otherwise forward a call
  // built on an empty plan while believing they sent arguments.
  if (
    rawToolArgs !== undefined &&
    (rawToolArgs === null || typeof rawToolArgs !== 'object' || Array.isArray(rawToolArgs))
  ) {
    const shape = Array.isArray(rawToolArgs) ? 'an array' : `a ${typeof rawToolArgs}`;
    return { ok: false, error: `toolArgs must be an object when provided (got ${shape})` };
  }
  const toolArgs = (rawToolArgs ?? {}) as Record<string, unknown>;

  try {
    resolveApprovalMode();
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }

  // Floors refuse before the sidecar is even spawned: they are local
  // decisions over the arguments, and a denial must not depend on (or
  // pay for) a live gateway child.
  const ruling = classify(tool, toolArgs);
  if (ruling.verdict === 'deny') {
    return { ok: false, classification: 'deny', error: ruling.reason };
  }

  try {
    await openMcpSidecar();
  } catch (error) {
    return { ok: false, error: redactSecrets(error instanceof Error ? error.message : String(error)) };
  }
  return await callOpenMcpTool(tool, toolArgs);
}

export const HUAWEICLOUD_OPEN_MCP_TOOLS = [
  {
    name: 'huaweicloud_gateway_list_tools',
    description:
      "List the open-mcp gateway child's live tool surface (names, descriptions, input schemas) as its tools/list reports. Use it to check gateway capabilities and drift from the devkit projection before generic calls. Read-only; needs no credentials.",
    schema: gatewayListToolsSchema,
    handler: handleGatewayListTools,
  },
  {
    name: 'huaweicloud_gateway_call',
    description:
      "Call one open-mcp gateway tool generically with tool and toolArgs — the single face for every gateway tool. Read-only discovery (no credentials): search_apis (query; optional limit/category) finds products by entity keywords when none is named; list_products (optional category/keyword) and get_product (product; optional include_sops) cover the product dimension (category, is_global — include_sops adds full SOP texts); list_apis (product; optional tag/search/limit/offset/include_sops) lists one product's API catalog with tag_groups; get_api (product, api; optional region) returns full API documentation — parameter types/enums, x-constraint preconditions, response schema, region endpoint — a must-read before any call; get_api_examples (product, api; optional region) returns official request examples. Discovery chain: search_apis → list_apis → get_api → get_api_examples. execute_api, manage_policy, query_data, and transform_data are delegated to the gateway's own policy engine: the first call forwards immediately, and when the engine refuses, its reason names the grant options — confirm with the user in conversation, grant with manage_policy add using an ephemeral scope (once/session/temporary), then retry the call. Permanent grants are an operator policy-file edit (hot-reload). Denied outright, no grant path: secret operations, file targets inside devkit state, non-canonical manage_policy action/scope spellings, permanent-scope add, ttl_seconds on add or remove, remove with scope, and tool names outside the devkit's static vocabulary.",
    schema: gatewayCallSchema,
    handler: handleGatewayCall,
  },
  {
    name: 'huaweicloud_gateway_restart',
    description:
      'Recycle the open-mcp gateway child of this MCP server process, e.g. after upgrading the gateway on the host (npx huaweicloud-devkit dep install open-mcp-gateway) while the session was live. In-flight gateway calls are interrupted when the old child stops. No arguments. In-process lifecycle only; needs no credentials.',
    schema: gatewayRestartSchema,
    handler: handleGatewayRestart,
  },
] as const satisfies readonly PackToolDefinition[];

export type HuaweicloudOpenMcpToolName = (typeof HUAWEICLOUD_OPEN_MCP_TOOLS)[number]['name'];

export const HUAWEICLOUD_OPEN_MCP_TOOL_SCHEMAS: Readonly<Record<HuaweicloudOpenMcpToolName, LooseToolSchema>> = {
  huaweicloud_gateway_list_tools: gatewayListToolsSchema,
  huaweicloud_gateway_call: gatewayCallSchema,
  huaweicloud_gateway_restart: gatewayRestartSchema,
};

export const HUAWEICLOUD_OPEN_MCP_TOOL_HANDLERS: Readonly<
  Record<HuaweicloudOpenMcpToolName, PackToolDefinition['handler']>
> = {
  huaweicloud_gateway_list_tools: handleGatewayListTools,
  huaweicloud_gateway_call: handleGatewayCall,
  huaweicloud_gateway_restart: handleGatewayRestart,
};
