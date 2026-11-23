import { TOOL_DEFINITIONS, callTool } from './tools.mjs';
import { peekCachedUpdateInfo, applyUpdateHint, getRuntimeVersion } from './update-check.mjs';
import { getAutoUpgradeNotice } from './update-auto.mjs';
import { initTelemetry, flushEvents } from './telemetry/telemetry.mjs';
import { detectAgent } from './telemetry/agent-detect.mjs';

// #1014 P0: 领券类工具同步上报——callTool 完毕后 await flushEvents()，
// 防止进程提前退出导致领券遥测丢失。
const P0_SYNC_FLUSH_TOOLS = new Set(['huaweicloud_voucher_claim', 'huaweicloud_competition_voucher_claim']);

const pkgVersion = getRuntimeVersion();

// 会话内首个非 check/upgrade 工具调用附加 _updateInfo，只消费一次。
// 按会话隔离：同进程内不同会话(A/B)各自首次提示；stdio 用固定 'stdin'。
const consumedBySession = new Map();
export function _decorateResult(sessionId, name, result) {
  if (consumedBySession.get(sessionId)) return result;
  try {
    const hint = peekCachedUpdateInfo();
    const notice =
      name === 'huaweicloud_check_update' || name === 'huaweicloud_upgrade' ? null : getAutoUpgradeNotice();
    if (!hint && !notice) return result;
    let decorated = hint ? applyUpdateHint(result, name, hint) : result;
    if (notice && decorated && typeof decorated === 'object' && !Array.isArray(decorated)) {
      decorated = {
        ...decorated,
        _updateInfo: { ...(decorated._updateInfo || {}), autoUpgrade: notice },
      };
    }
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
// A session must complete the handshake with an `initialize` request before
// sending any other request. Only a successful `initialize` request marks the
// session initialized: `notifications/initialized` is accepted for protocol
// completeness but never unlocks a session by itself, so a client that skips
// `initialize` cannot bypass the gate by sending the notification alone.
// Requests from an uninitialized session fail with JSON-RPC -32002
// (Server not initialized).
const MAX_TRACKED_SESSIONS = 512;
const initializedSessions = new Map();

// Bounded LRU: re-insert to refresh recency, then evict the oldest entries so a
// long-lived server with many short sessions cannot grow without limit.
function rememberSession(sessionId) {
  initializedSessions.delete(sessionId);
  initializedSessions.set(sessionId, true);
  while (initializedSessions.size > MAX_TRACKED_SESSIONS) {
    initializedSessions.delete(initializedSessions.keys().next().value);
  }
}

export function _markInitialized(sessionId) {
  rememberSession(sessionId);
}
export function _isSessionInitialized(sessionId) {
  return Boolean(initializedSessions.get(sessionId));
}
export function _resetInitializedSessions() {
  initializedSessions.clear();
}

// D9-9: `notifications/cancelled` handling (MCP 2024-11-05 lifecycle utility).
// The spec defines cancellation at the protocol level, not as a server
// capability: the client sends `notifications/cancelled` with the requestId of
// an in-flight request and the receiver MUST NOT answer that request. Each
// transport registers the cancellation here and drops the response instead of
// writing it. Tracking is bounded like the session set.
const MAX_TRACKED_CANCELLATIONS = 512;
const cancelledRequests = new Map();

function cancellationKey(sessionId, requestId) {
  return `${sessionId}\u0000${requestId}`;
}

export function _markRequestCancelled(sessionId, requestId) {
  if (requestId === undefined || requestId === null) return;
  const key = cancellationKey(sessionId, requestId);
  cancelledRequests.delete(key);
  cancelledRequests.set(key, true);
  while (cancelledRequests.size > MAX_TRACKED_CANCELLATIONS) {
    cancelledRequests.delete(cancelledRequests.keys().next().value);
  }
}

// Returns true (and forgets the record) when the request was cancelled.
export function _consumeRequestCancellation(sessionId, requestId) {
  return cancelledRequests.delete(cancellationKey(sessionId, requestId));
}

export function _resetCancelledRequests() {
  cancelledRequests.clear();
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
    // D9-4: only a successful `initialize` request marks the session
    // initialized. The transports accept `notifications/initialized` but do
    // not let it unlock a session on its own.
    _markInitialized(sessionId);
    return {
      protocolVersion: params.protocolVersion || '2024-11-05',
      capabilities: {
        tools: {},
        // D9-9: devkit extension field. MCP 2024-11-05 defines no standard
        // `cancellation` capability (cancellation is protocol-level), so this
        // field is declared explicitly for clients that probe for it; the
        // transports honor `notifications/cancelled` by not answering the
        // cancelled request (see _markRequestCancelled above).
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
    if (P0_SYNC_FLUSH_TOOLS.has(params.name)) {
      await flushEvents().catch(() => {});
    }
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
