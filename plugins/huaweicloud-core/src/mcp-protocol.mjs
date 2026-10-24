import { TOOL_DEFINITIONS, callTool } from './tools.mjs';
import { getCachedUpdateInfo, peekCachedUpdateInfo, applyUpdateHint, readInstalledVersion } from './update-check.mjs';
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

// initialize 握手状态追踪：按会话隔离，未初始化时非 initialize 方法返回 -32600（MCP 协议时序约束 #814 D9-12）。
const initializedBySession = new Map();
export function _resetInitializedSessions() {
  initializedBySession.clear();
}
export function _isSessionInitialized(sessionId) {
  return Boolean(initializedBySession.get(sessionId));
}

// 测试可观测性：initialize 阶段是否触发了版本检查（getCachedUpdateInfo 调用 #814 D9-12 ③）。
let versionCheckTriggered = false;
export function _resetVersionCheckFlag() {
  versionCheckTriggered = false;
}
export function _wasVersionChecked() {
  return versionCheckTriggered;
}

export async function dispatch(method, params, opts = {}) {
  const sessionId = opts?.sessionId || 'default';
  // MCP 协议时序约束：initialize 之前的非 initialize 请求应被拒（JSON-RPC -32600 #814 D9-12 ⑥）。
  if (method !== 'initialize' && !initializedBySession.get(sessionId)) {
    const notInitializedError = new Error('Server not initialized');
    notInitializedError.code = -32600;
    throw notInitializedError;
  }
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
    // 版本检查：异步、非阻塞、失败静默（与 mcp-server.mjs updatePrewarm 一致 #814 D9-12 ③）。
    getCachedUpdateInfo(readInstalledVersion() || '0.0.0').catch(() => {});
    versionCheckTriggered = true;
    initializedBySession.set(sessionId, true);
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
