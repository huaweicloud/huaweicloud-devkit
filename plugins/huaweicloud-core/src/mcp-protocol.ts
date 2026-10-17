import { McpServer, type RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult, JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

import {
  TOOL_DEFINITIONS,
  callTool,
  verifySkillTree,
  type CallToolOptions,
  type ToolDefinition,
  type ToolName,
} from './tools.ts';
import { PACK_OF } from './packs/registry.ts';
import { resolveEnabledPacks } from './packs/enable.ts';
import { getToolSchema, assertConstructedSchemas } from './tool-schemas.ts';
import { peekCachedUpdateInfo, applyUpdateHint, readInstalledVersion } from './update-check.ts';
import { initTelemetry } from './telemetry/telemetry.ts';
import { detectAgent } from './telemetry/agent-detect.ts';

const pkgVersion = readInstalledVersion() || '0.0.0';

// 会话内首个非 check/upgrade 工具调用附加 _updateInfo，只消费一次。
// 按会话隔离：同进程内不同会话(A/B)各自首次提示；stdio 用固定 'stdin'。
const consumedBySession = new Map<string, boolean>();

export interface DevkitServerOptions {
  sessionId?: string | null;
  // stdio sessions own runtime pack toggling (huaweicloud_packs_configure
  // gets registered and its opts carry the disclosure re-sync seam). The
  // stateless remote leaves this off: it builds a fresh server per request
  // and must never hold cross-request mutable pack state.
  runtimePacks?: boolean;
  // The stateless remote is unauthenticated HTTP: vault mutations (set /
  // rotate / delete against the user's local secret store) must never be
  // reachable there, so the remote surface withholds the secrets pack the
  // same way it withholds packs_configure. stdio and test constructions
  // omit it.
  remoteSurface?: boolean;
}

export function _decorateResult(sessionId: string | undefined | null, name: string, result: unknown): unknown {
  const key = sessionId || 'default';
  if (consumedBySession.get(key)) return result;
  try {
    const hint = peekCachedUpdateInfo();
    if (!hint) return result;
    const decorated = applyUpdateHint(result, name, hint);
    if (decorated !== result) consumedBySession.set(key, true);
    return decorated;
  } catch {
    return result; // 兜底装饰失败绝不影响工具调用
  }
}

export function _resetHintConsumption(): void {
  consumedBySession.clear();
}

export function _isHintConsumed(sessionId: string): boolean {
  return Boolean(consumedBySession.get(sessionId));
}

// Initialize side effects (user-hash prewarm for telemetry, agent detection)
// shared by both transports. The SDK offers no pre-initialize hook, so each
// transport invokes this from its JSON boundary after decoding an initialize
// request and before/while forwarding it. Awaited: the legacy dispatch held
// the initialize response for up to 3s on the hash race, and that ordering
// is observable behavior we keep.
//
// Both call sites hand over the full initialize params; the client identity
// lives one level down at params.clientInfo. A call site that passed params
// straight into detectAgent silently degraded agent detection to env-only.
function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function toClientInfo(params: unknown): { name: string | null; version: string | null } {
  const info = asRecord(asRecord(params).clientInfo);
  return {
    name: typeof info.name === 'string' ? info.name : null,
    version: typeof info.version === 'string' ? info.version : null,
  };
}

export async function runInitializeSideEffects(params: unknown): Promise<void> {
  try {
    const { hdkitGenerateUserHash } = await import('./lib/hdkit/hdkitservice-api.ts');
    await Promise.race([
      hdkitGenerateUserHash(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000)),
    ]);
  } catch {
    // best-effort: hash prewarm failure (offline or timeout) must not block initialize
  }

  const agent = detectAgent(toClientInfo(params));
  initTelemetry({ harness: agent.harness, version: agent.version });
}

// MCP permits omitting `arguments` on tools/call. The SDK hands
// request.params.arguments to the zod schema verbatim, where undefined fails
// "expected object". Transports call this right after decoding a tools/call
// body so the default lives once at the JSON boundary, before the SDK sees
// the message.
export function normalizeToolCallParams(message: JSONRPCMessage): JSONRPCMessage {
  if (
    message &&
    typeof message === 'object' &&
    !Array.isArray(message) &&
    'method' in message &&
    (message as { method?: unknown }).method === 'tools/call'
  ) {
    const params = (message as { params?: unknown }).params;
    if (params !== null && typeof params === 'object' && !Array.isArray(params)) {
      const record = params as Record<string, unknown>;
      if (!('arguments' in record) || record.arguments === undefined || record.arguments === null) {
        return { ...message, params: { ...record, arguments: {} } };
      }
    }
  }
  return message;
}

export function createDevkitMcpServer({
  sessionId,
  runtimePacks = false,
  remoteSurface = false,
}: DevkitServerOptions = {}): McpServer {
  assertConstructedSchemas();
  // Refuse to start on a missing/partial skills tree: list_packs is
  // registry-driven and would otherwise advertise skills retrieve_skill
  // cannot serve. stdio and the stateless remote both boot through here,
  // and the remote re-verifies per request (one readdir — cheap).
  verifySkillTree();
  // Enablement resolves inside syncDisclosure: stdio resolves once at boot
  // (fail-fast exit on a bogus DEVKIT_PACKS), the stateless remote re-reads
  // env on every request, so both transports share one code path with no
  // transport branching. Unknown pack ids throw here; core is always in the
  // set, so its tools (the base face plus the three pack meta tools and
  // packs_configure) are never filtered.
  const server = new McpServer({ name: 'huaweicloud-devkit', version: pkgVersion });
  const registered = new Map<ToolName, RegisteredTool>();

  // One wanted-set derivation for boot and re-sync: enablement decides pack
  // ownership, runtimePacks decides the session-toggle tool itself, so a
  // server that never exposed the toggle can never grow it mid-flight. The
  // remoteSurface flag withholds every tool that writes the user's LOCAL
  // credential state on the unauthenticated remote: the vault mutations
  // (secrets pack), the auth mutation family (auth_init sets module-global
  // runtime credentials — cross-request state on a stateless face; auth_sync
  // / auth_switch persist / auth_confirm decrypt S1 vault refs and write
  // plaintext into ~/.obsutilconfig and the KooCLI profile), and the OBS
  // config fan-out. Ref-consuming sandbox calls remain callable there
  // (values go to the sandbox service, not the caller); that read-seam
  // residual is accepted, loopback-bound, and documented.
  const REMOTE_WITHHELD_LOCAL_WRITERS = new Set([
    'huaweicloud_secret_set',
    'huaweicloud_secret_delete',
    'huaweicloud_auth_sync',
    'huaweicloud_auth_init',
    'huaweicloud_auth_switch',
    'huaweicloud_auth_confirm',
    'huaweicloud_setup_obs_config',
  ]);
  const isWanted = (tool: ToolDefinition, enabled: ReadonlySet<string>): boolean =>
    enabled.has(PACK_OF[tool.name]) &&
    (runtimePacks || tool.name !== 'huaweicloud_packs_configure') &&
    (!remoteSurface || (PACK_OF[tool.name] !== 'secrets' && !REMOTE_WITHHELD_LOCAL_WRITERS.has(tool.name)));

  const registerOne = (tool: ToolDefinition): void => {
    registered.set(
      tool.name,
      server.registerTool(
        tool.name,
        { description: tool.description, inputSchema: getToolSchema(tool.name) },
        async (args): Promise<CallToolResult> => {
          const callOpts: CallToolOptions = runtimePacks
            ? { sessionId, onPacksChanged: () => syncDisclosure() }
            : { sessionId };
          const result = await callTool(tool.name, args, callOpts);
          const decorated = _decorateResult(sessionId, tool.name, result);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(decorated, null, 2),
              },
            ],
            isError: false,
          };
        },
      ),
    );
  };

  // Re-disclosure after huaweicloud_packs_configure mutates the override:
  // diff the wanted set against the registered set, add what appeared,
  // remove what vanished (RegisteredTool.remove). The SDK emits one
  // tools/list_changed per register/remove and no-ops them before connect,
  // so boot and re-sync share this one path and no extra notification is
  // needed. A client that ignores tools/list_changed still converges on its
  // next reconnect.
  const syncDisclosure = (): void => {
    const enabled = resolveEnabledPacks();
    for (const tool of TOOL_DEFINITIONS) {
      const wanted = isWanted(tool, enabled);
      const held = registered.has(tool.name);
      if (wanted && !held) registerOne(tool);
      else if (!wanted && held) {
        registered.get(tool.name)?.remove();
        registered.delete(tool.name);
      }
    }
  };

  syncDisclosure();

  return server;
}

// In-memory pair for tests: full SDK chain (registerTool, validation,
// decoration) without spawning a process.
export async function createLinkedDevkitServers(
  options: DevkitServerOptions = {},
): Promise<{ server: McpServer; transport: InMemoryTransport }> {
  const server = createDevkitMcpServer(options);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  return { server, transport: clientTransport };
}
