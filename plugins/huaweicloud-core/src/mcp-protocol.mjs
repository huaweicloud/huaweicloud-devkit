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

/**
 * 请求级基础超时（毫秒）。可被环境变量 HCLOUD_MCP_REQUEST_TIMEOUT_MS 覆盖，
 * 也可被单个请求的 opts.timeoutMs / params._meta.timeoutMs 覆盖。
 *
 * 基础值为 60s（D9-9 要求「有合理默认值」）：普通工具在 60s 后返回
 * { code: -32000 } 而不是一直挂起。声明了更长执行契约的沙箱工具不套用
 * 60s，而是按工具注册表 / args.timeout_ms 取更长的协议预算（见
 * resolveTimeoutMs），避免 upload_project(300s) 等合法长任务被误杀。
 * HCLOUD_MCP_REQUEST_TIMEOUT_MS=0 表示显式关闭协议层超时（仍受各工具自身
 * timeoutMs 约束），用于需要无限期等待的特殊场景。
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

/**
 * 环境变量解析结果。导出供测试断言；0 表示显式关闭协议层超时。
 */
export const CONFIGURED_REQUEST_TIMEOUT_MS = (() => {
  const raw = process.env.HCLOUD_MCP_REQUEST_TIMEOUT_MS;
  if (raw === undefined || raw === '') return DEFAULT_REQUEST_TIMEOUT_MS;
  const env = Number(raw);
  return Number.isFinite(env) && env >= 0 ? env : DEFAULT_REQUEST_TIMEOUT_MS;
})();

/**
 * 给工具自身 timeout_ms 预留的协议余量：协议层必须比工具执行窗口更宽松，
 * 否则工具会在自己的 timeout 到期前先被协议层截断，产生「后台仍在执行、
 * 客户端已收到 -32000」的不确定态。
 */
export const REQUEST_TIMEOUT_MARGIN_MS = 30_000;

/**
 * 工具级请求超时下限。这些沙箱工具的执行契约比全局 60s 更长（工具自身
 * timeout_ms 默认值，见 tools.mjs 的定义与 callTool 的 fallback），协议层
 * 不能把它们统一截在 60s。实际值取 max(全局默认, 工具下限, args.timeout_ms + 余量)。
 */
export const TOOL_REQUEST_TIMEOUTS_MS = Object.freeze({
  huaweicloud_sandbox_exec_with_session: 150_000, // args.timeout_ms 默认 120s + 余量
  huaweicloud_sandbox_exec_one_shot: 150_000,
  huaweicloud_sandbox_upload_file: 150_000,
  huaweicloud_sandbox_upload_project: 330_000, // 默认 300s + 余量
  huaweicloud_sandbox_deploy_nginx: 90_000,
  huaweicloud_sandbox_deploy_check: 60_000,
  huaweicloud_sandbox_expose_tunnel: 120_000, // 默认 90s + 余量
  huaweicloud_sandbox_renew_tunnel: 90_000,
  huaweicloud_sandbox_keepalive_watchdog: 90_000,
});

/**
 * JSON-RPC error code for request-level timeout / cancellation.
 * MCP 协议约定 -32000（Server error 段）用于「请求超时或被取消」语义，
 * 与每日测试报告 D9-9 预期「超时返回 {code:-32000, message 含 timeout}」一致。
 */
export const REQUEST_TIMEOUT_ERROR_CODE = -32000;

/**
 * 当请求被取消或超时时抛出的错误。code=-32000，message 含 timeout/cancelled。
 * 传输层捕获后封装为 { jsonrpc, id, error: { code, message } }。
 */
export class RequestTimeoutError extends Error {
  constructor(message = 'Request timed out') {
    super(message);
    this.name = 'RequestTimeoutError';
    this.code = REQUEST_TIMEOUT_ERROR_CODE;
  }
}

/**
 * 进行中的请求注册表：requestId -> AbortController。
 * 传输层在收到 notifications/cancelled 时调用 abortRequest() 中断对应请求。
 * key 为 JSON-RPC id（number|string）。通知类消息无 id，不进入注册表。
 */
const inFlight = new Map();

export function _registerRequest(id, controller) {
  if (id === undefined || id === null) return;
  inFlight.set(id, controller);
}

export function _unregisterRequest(id) {
  inFlight.delete(id);
}

/**
 * 中断一个进行中的请求。供 notifications/cancelled 处理调用。
 * @param {*} id JSON-RPC request id
 * @param {string} [reason] 取消原因（写入 abort reason）
 * @returns {boolean} 是否找到并中断了对应请求
 */
export function abortRequest(id, reason = 'Client cancelled') {
  const controller = inFlight.get(id);
  if (!controller || controller.signal.aborted) return false;
  try {
    controller.abort(new RequestTimeoutError(`Request cancelled: ${reason}`));
  } catch {
    // AbortController.abort 在某些环境下对重复 abort 抛错——忽略。
  }
  return true;
}

export function _inFlightCount() {
  return inFlight.size;
}

/**
 * 解析单个请求的超时时长。优先级：
 *   opts.timeoutMs > params._meta.timeoutMs > 工具预算 / 全局默认
 *
 * 未显式指定时，对声明了更长执行窗口的沙箱工具取
 *   max(全局默认, 工具注册表下限, args.timeout_ms + 余量)
 * 避免通用 60s 截断 upload_project(300s)/sandbox_exec(120s) 等合法长任务。
 * 返回 0 表示不启用协议层超时（HCLOUD_MCP_REQUEST_TIMEOUT_MS=0）。
 */
export function resolveTimeoutMs(opts, params) {
  const fromOpts = Number(opts?.timeoutMs);
  if (Number.isFinite(fromOpts) && fromOpts > 0) return fromOpts;
  const fromMeta = Number(params?._meta?.timeoutMs);
  if (Number.isFinite(fromMeta) && fromMeta > 0) return fromMeta;
  if (CONFIGURED_REQUEST_TIMEOUT_MS <= 0) return 0;

  const toolFloor = TOOL_REQUEST_TIMEOUTS_MS[params?.name] ?? 0;
  const declaredArgsTimeout = Number(params?.arguments?.timeout_ms ?? params?.arguments?.timeoutMs);
  const argsBudget =
    Number.isFinite(declaredArgsTimeout) && declaredArgsTimeout > 0
      ? declaredArgsTimeout + REQUEST_TIMEOUT_MARGIN_MS
      : 0;
  return Math.max(CONFIGURED_REQUEST_TIMEOUT_MS, toolFloor, argsBudget);
}

/**
 * 为一个请求包装超时 + 取消语义，返回一个受控的 AbortSignal。
 * - 若 opts.signal 已提供（来自 transport 的 AbortController），监听其 abort
 *   事件并联动本地 controller；
 * - 按 timeoutMs 启动超时定时器，到期 abort 本地 controller；
 * - 调用方负责在请求结束后调用 cleanup() 清理定时器与监听器。
 *
 * 超时/取消时，通过 raceWithSignal() 抛出 RequestTimeoutError（code=-32000）。
 */
function createRequestSignal(opts, params) {
  const timeoutMs = resolveTimeoutMs(opts, params);
  const externalSignal = opts?.signal;
  const controller = new AbortController();
  const signal = controller.signal;

  let timer = null;

  const abortWith = (err) => {
    if (signal.aborted) return;
    try {
      controller.abort(err);
    } catch {}
  };

  const onExternalAbort = () => {
    const reason = externalSignal?.reason;
    abortWith(
      reason instanceof RequestTimeoutError
        ? reason
        : new RequestTimeoutError(`Request cancelled: ${externalSignal?.reason?.message || 'external signal'}`),
    );
  };

  if (externalSignal) {
    if (externalSignal.aborted) {
      throw externalSignal.reason instanceof RequestTimeoutError
        ? externalSignal.reason
        : new RequestTimeoutError('Request cancelled');
    }
    externalSignal.addEventListener('abort', onExternalAbort, { once: true });
  }

  if (timeoutMs > 0) {
    timer = setTimeout(() => {
      abortWith(new RequestTimeoutError(`Request timed out after ${timeoutMs} ms`));
    }, timeoutMs);
  }

  const cleanup = () => {
    if (timer) clearTimeout(timer);
    if (externalSignal) {
      try {
        externalSignal.removeEventListener('abort', onExternalAbort);
      } catch {}
    }
  };

  return { signal, cleanup };
}

/**
 * 将一个异步工作 Promise 与 AbortSignal 竞速：signal abort 时立即拒绝，
 * 抛出 RequestTimeoutError（code=-32000）。
 *
 * abort 不是「只丢弃响应」：signal 会透传至 callTool → runHcloud / 沙箱执行层，
 * 底层 hcloud 子进程被终止（POSIX 下按进程组回收，含孙进程），沙箱会话/上传
 * 通道会被关闭。唯一例外是尚未接入 signal 的沙箱调用点（见 README 说明），
 * 它们可能在协议层返回 -32000 后继续收尾。
 */
async function raceWithSignal(work, signal) {
  if (!signal) return work;
  if (signal.aborted) {
    const reason = signal.reason;
    throw reason instanceof RequestTimeoutError ? reason : new RequestTimeoutError('Request cancelled');
  }
  return new Promise((resolveP, rejectP) => {
    const onAbort = () => {
      const reason = signal.reason;
      rejectP(reason instanceof RequestTimeoutError ? reason : new RequestTimeoutError('Request cancelled'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (val) => {
        signal.removeEventListener('abort', onAbort);
        resolveP(val);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        rejectP(error);
      },
    );
  });
}

// 暴露内部方法供单元测试验证超时/取消语义（不作为公共 API）。
export { createRequestSignal, raceWithSignal };

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
        // 声明服务端支持请求取消：客户端可发送 notifications/cancelled
        // 中断进行中的 tools/call 等请求；tools/call 支持请求级超时，
        // 超时返回 JSON-RPC error { code: -32000, message 含 timeout }。
        cancellation: {},
        // D9-9 日测夹具按 capabilities.notifications.cancellation（布尔）
        // 探测能力，这里同步声明以保持契约一致（顶层 cancellation 保留给
        // 其它标准客户端读取）。
        notifications: {
          cancellation: true,
        },
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
    const { signal, cleanup } = createRequestSignal(opts, params);
    try {
      // signal 透传至 callTool → runHcloud / 沙箱执行层（execWithSession、
      // execOneShot、upload、deploy、expose 等）。abort 时底层工作随之停止；
      // 协议层用 raceWithSignal 保证客户端及时收到 -32000。
      const work = callTool(params.name, params.arguments || {}, { signal });
      const result = await raceWithSignal(work, signal);
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
    } finally {
      cleanup();
    }
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
