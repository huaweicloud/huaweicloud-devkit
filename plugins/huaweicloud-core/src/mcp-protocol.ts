import { TOOL_DEFINITIONS, callTool } from './tools.ts';
import { peekCachedUpdateInfo, applyUpdateHint, readInstalledVersion } from './update-check.ts';
import { initTelemetry } from './telemetry/telemetry.ts';
import { detectAgent } from './telemetry/agent-detect.ts';

const pkgVersion = readInstalledVersion() || '0.0.0';

// 会话内首个非 check/upgrade 工具调用附加 _updateInfo，只消费一次。
// 按会话隔离：同进程内不同会话(A/B)各自首次提示；stdio 用固定 'stdin'。
const consumedBySession = new Map<string, boolean>();

export interface DispatchOptions {
  sessionId?: string;
}

interface ClientInfoShape {
  name: string | null;
  version: string | null;
}

// JSON-RPC errors carry a numeric code; Object.assign keeps the augmentation
// honest without casting a bare Error.
function jsonRpcError(code: number, message: string): Error & { code: number } {
  return Object.assign(new Error(message), { code });
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function toClientInfo(value: unknown): ClientInfoShape {
  const record = asRecord(value);
  return {
    name: typeof record.name === 'string' ? record.name : null,
    version: typeof record.version === 'string' ? record.version : null,
  };
}

export function _decorateResult(sessionId: string, name: string, result: unknown): unknown {
  if (consumedBySession.get(sessionId)) return result;
  try {
    const hint = peekCachedUpdateInfo();
    if (!hint) return result;
    const decorated = applyUpdateHint(result, name, hint);
    if (decorated !== result) consumedBySession.set(sessionId, true);
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

export async function dispatch(method: string, params: unknown, opts: DispatchOptions = {}): Promise<unknown> {
  const p = asRecord(params);
  const sessionId = opts.sessionId || 'default';
  if (method === 'initialize') {
    const ci = toClientInfo(p.clientInfo);

    try {
      const { hdkitGenerateUserHash } = await import('./sandbox/hdkitservice-api.ts');
      await Promise.race([
        hdkitGenerateUserHash(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000)),
      ]);
    } catch {}

    const agent = detectAgent(ci);
    initTelemetry({ harness: agent.harness, version: agent.version });
    return {
      protocolVersion: typeof p.protocolVersion === 'string' && p.protocolVersion ? p.protocolVersion : '2024-11-05',
      capabilities: {
        tools: {},
      },
      serverInfo: {
        name: 'huaweicloud-devkit',
        version: pkgVersion,
      },
    };
  }

  if (method === 'tools/list') {
    return { tools: TOOL_DEFINITIONS };
  }

  if (method === 'tools/call') {
    const tool = TOOL_DEFINITIONS.find((t) => t.name === p.name);
    if (!tool) {
      // JSON-RPC 2.0: an unknown tool name is a client-side parameter error,
      // not a server fault (#704 D9-2).
      throw jsonRpcError(-32602, `Unknown tool: ${String(p.name)}`);
    }
    const args = asRecord(p.arguments);
    const missing = (tool.inputSchema?.required || []).filter((key) => !Object.hasOwn(args, key));
    if (missing.length > 0) {
      throw jsonRpcError(
        -32602,
        `Invalid params: missing required field(s) ${missing.map((key) => JSON.stringify(key)).join(', ')} for tool "${String(p.name)}".`,
      );
    }
    // tool.name === p.name (the find predicate above), so this passes the
    // registry-typed name to the exhaustively-checked dispatch.
    const result = await callTool(tool.name, args);
    const decorated = _decorateResult(sessionId, String(p.name), result);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(decorated, null, 2),
        },
      ],
      isError: false,
    };
  }

  if (method === 'resources/list') {
    return { resources: [] };
  }

  // JSON-RPC 2.0: unknown methods must surface as -32601 (Method not found),
  // not the generic -32603 internal error (#650 D9-2).
  throw jsonRpcError(-32601, `Method not found: ${method}`);
}
