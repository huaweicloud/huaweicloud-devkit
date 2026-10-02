import { TOOL_DEFINITIONS, callTool } from './tools.mjs';
import { peekCachedUpdateInfo, applyUpdateHint, readInstalledVersion } from './update-check.mjs';
import { initTelemetry } from './telemetry/telemetry.mjs';
import { detectAgent } from './telemetry/agent-detect.mjs';

const pkgVersion = readInstalledVersion() || '0.0.0';

// 会话内首个非 check/upgrade 工具调用附加 _updateInfo，只消费一次。
// 按会话隔离：同进程内不同会话(A/B)各自首次提示；stdio 用固定 'stdin'。
const consumedBySession = new Map();
export function _decorateResult(sessionId, name, result) {
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
export function _resetHintConsumption() {
  consumedBySession.clear();
}
export function _isHintConsumed(sessionId) {
  return Boolean(consumedBySession.get(sessionId));
}

export async function dispatch(method, params, opts = {}) {
  const sessionId = opts?.sessionId || 'default';
  if (method === 'initialize') {
    const ci = params.clientInfo || {};

    try {
      const { hdkitGenerateUserHash } = await import('./sandbox/hdkitservice-api.mjs');
      await Promise.race([
        hdkitGenerateUserHash(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000)),
      ]);
    } catch {}

    const agent = detectAgent(ci);
    initTelemetry({ harness: agent.harness, version: agent.version });
    return {
      protocolVersion: params.protocolVersion || '2024-11-05',
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
    // JSON-RPC 2.0: params, when present, must be an object (struct). A
    // non-object params (string/number/boolean/array) is an -32602 Invalid
    // params error, aligned with the tools/call branch below. Omitting params
    // (undefined/null) is allowed by the spec and returns the tool list (#817 D9-2).
    if (params !== undefined && params !== null && (typeof params !== 'object' || Array.isArray(params))) {
      const invalidParamsError = new Error('Invalid params: tools/list expects an object or no params.');
      invalidParamsError.code = -32602;
      throw invalidParamsError;
    }
    return { tools: TOOL_DEFINITIONS };
  }

  if (method === 'tools/call') {
    const tool = TOOL_DEFINITIONS.find((t) => t.name === params.name);
    if (!tool) {
      // JSON-RPC 2.0: an unknown tool name is a client-side parameter error,
      // not a server fault (#704 D9-2).
      const unknownToolError = new Error(`Unknown tool: ${params.name}`);
      unknownToolError.code = -32602;
      throw unknownToolError;
    }
    const missing = (tool.inputSchema?.required || []).filter(
      (key) => !params.arguments || !Object.hasOwn(params.arguments, key),
    );
    if (missing.length > 0) {
      const invalidParamsError = new Error(
        `Invalid params: missing required field(s) ${missing.map((key) => JSON.stringify(key)).join(', ')} for tool "${params.name}".`,
      );
      invalidParamsError.code = -32602;
      throw invalidParamsError;
    }
    const result = await callTool(params.name, params.arguments || {});
    const decorated = _decorateResult(sessionId, params.name, result);
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
  const methodError = new Error(`Method not found: ${method}`);
  methodError.code = -32601;
  throw methodError;
}
