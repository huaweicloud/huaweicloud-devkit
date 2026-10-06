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

// D9-4: MCP initialize lifecycle gating.
// A session must complete the initialize handshake before sending any other
// request. The server marks the session initialized on a successful
// `initialize` response; the `notifications/initialized` client notification
// reinforces this state. Requests before initialize return JSON-RPC -32002.
const initializedSessions = new Map();
export function _markInitialized(sessionId) {
  initializedSessions.set(sessionId, true);
}
export function _isSessionInitialized(sessionId) {
  return Boolean(initializedSessions.get(sessionId));
}
export function _resetInitializedSessions() {
  initializedSessions.clear();
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
    // D9-4: a successful initialize response marks the session initialized.
    // The client's subsequent `notifications/initialized` notification
    // reinforces this state (handled by the transport layer).
    _markInitialized(sessionId);
    return {
      protocolVersion: params.protocolVersion || '2024-11-05',
      capabilities: {
        tools: {},
        // D9-9: declare cancellation capability so clients know the server
        // honors `notifications/cancelled` for in-flight requests.
        cancellation: {},
      },
      serverInfo: {
        name: 'huaweicloud-devkit',
        version: pkgVersion,
      },
    };
  }

  // D9-4: every non-initialize method requires an initialized session.
  // Returns JSON-RPC -32002 (Server not initialized) per MCP spec.
  if (!_isSessionInitialized(sessionId)) {
    const notInitializedError = new Error('Server not initialized: call initialize first');
    notInitializedError.code = -32002;
    throw notInitializedError;
  }

  if (method === 'tools/list') {
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
