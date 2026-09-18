import { readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TOOL_DEFINITIONS, callTool } from './tools.mjs';
import { peekCachedUpdateInfo, applyUpdateHint } from './update-check.mjs';
import { initTelemetry } from './telemetry/telemetry.mjs';
import { detectAgent } from './telemetry/agent-detect.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pluginRoot = resolve(__dirname, '..');
const packageRoot = resolve(pluginRoot, '..', '..');
let pkgVersion = '0.0.0';
for (const base of [pluginRoot, packageRoot]) {
  try {
    const version = JSON.parse(readFileSync(join(base, 'package.json'), 'utf8')).version;
    if (version) {
      pkgVersion = version;
      break;
    }
  } catch {}
}

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

/**
 * 请求级默认超时（毫秒）。可被环境变量 HCLOUD_MCP_REQUEST_TIMEOUT_MS 覆盖，
 * 也可被单个请求的 opts.timeoutMs / params._meta.timeoutMs 覆盖。
 * 0 表示不启用协议层超时（仍受各工具自身 timeoutMs 约束）。
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = (() => {
  const env = Number(process.env.HCLOUD_MCP_REQUEST_TIMEOUT_MS);
  return Number.isFinite(env) && env > 0 ? env : 0;
})();

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
 *   opts.timeoutMs > params._meta.timeoutMs > DEFAULT_REQUEST_TIMEOUT_MS
 * 返回 0 表示不启用协议层超时。
 */
function resolveTimeoutMs(opts, params) {
  const fromOpts = Number(opts?.timeoutMs);
  if (Number.isFinite(fromOpts) && fromOpts > 0) return fromOpts;
  const fromMeta = Number(params?._meta?.timeoutMs);
  if (Number.isFinite(fromMeta) && fromMeta > 0) return fromMeta;
  return DEFAULT_REQUEST_TIMEOUT_MS;
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
 * 抛出 RequestTimeoutError（code=-32000）。工作 Promise 仍可能在后台继续
 * （底层 hcloud 子进程由其自身 timeoutMs 兜底回收），但客户端会及时收到
 * -32000 响应——满足 MCP cancellation 语义。
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
    const { signal, cleanup } = createRequestSignal(opts, params);
    try {
      // signal 透传至 callTool（当前工具链不强制消费，但为未来支持预留）；
      // 协议层超时/取消由 raceWithSignal 保证及时返回 -32000。
      const work = callTool(params.name, params.arguments || {}, { signal });
      const result = await raceWithSignal(work, signal);
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
