// hdkitservice 的两类连接期裁决：409 版本门禁与网关 502/504 瞬时超时。
// 移植 dev e0c8700b（连接重试）+ 501fd8b4（版本门禁结构化引导）+
// e1255a4b（按出口折叠——MCP 错误信封只携带 code+message，remediation 等
// 指引字段在 throw 路径会丢失）。两条规则都只在本模块定义，调用方不得再推导。
//
// v2 扩展（相对 dev，见 docs/CHANGELOG.md 台账）：
// - HW_SANDBOX_CONNECT_RETRY_DELAYS_MS 重试表针脚（用法同 HW_SANDBOX_POOL_CACHE_PATH，
//   用时读 env；dev 固定 30s/45s，测试/运维无法等待）
// - connect 成功路径的 connect_retries 回显（dev 只在错误路径带尝试次数）
// - 瞬时耗尽的 connect 出口结构化折叠（dev 在此路径裸抛）

import { asText } from '../as-text.ts';

/** 版本门禁（服务端 UPGRADE_MIN_VERSION 硬门禁）的唯一错误码 */
export const VERSION_GATE_CODE = 'HDKIT_VERSION_TOO_OLD';

/** 连接重试表（dev e0c8700b 终态）：网关 502/504 各退避重试一次 */
export const CONNECT_RETRY_DELAYS_MS: readonly number[] = [30000, 45000];

const SEAM_ENV = 'HW_SANDBOX_CONNECT_RETRY_DELAYS_MS';

/**
 * 重试表解析：HW_SANDBOX_CONNECT_RETRY_DELAYS_MS 逗号分隔毫秒。任一条目非法
 * 即整体回退默认表（写错的值宁可全默认，不静默改变节奏）；空表同样回退。
 * 空白条目按非法处理——Number('') === 0，放行会成为零延迟重试档。
 */
export function connectRetryDelaysMs(): number[] {
  const raw = process.env[SEAM_ENV];
  if (!raw) return [...CONNECT_RETRY_DELAYS_MS];
  const parts = raw.split(',').map((entry) => entry.trim());
  const usable =
    parts.length > 0 && parts.every((part) => part !== '' && Number.isFinite(Number(part)) && Number(part) >= 0);
  return usable ? parts.map((part) => Number(part)) : [...CONNECT_RETRY_DELAYS_MS];
}

const TRANSIENT_STATUSES: ReadonlySet<number> = new Set([502, 504]);

/**
 * 网关 502/504 瞬时判定（dev e0c8700b + v2 分歧）：编排期响应超时，非创建
 * 失败——服务端可能已在编排实例，重试通常复用同一实例。携带 status 的错误
 * （JSON 信封路径）只按 status 判定；消息形态仅服务无 status 的非 JSON 网关页。
 * v2 分歧（台账记录）：dev 的消息正则无条件生效，一个 HTTP 500 业务错误只要
 * 文案里带 "Bad Gateway"（如烧核 HDKIT_UPSTREAM_ERROR 转述上游文本）就会被
 * 误判成瞬时网关超时。
 */
export function isGatewayTransient(error: unknown): boolean {
  const err = error as { status?: unknown; message?: unknown };
  if (typeof err.status === 'number') return TRANSIENT_STATUSES.has(err.status);
  const message = typeof err.message === 'string' ? err.message : '';
  return /non-JSON \(status (502|504)\)/i.test(message) || /Gateway Time-out|Bad Gateway/i.test(message);
}

export interface VersionGatePayload {
  clientVersion?: string;
  minVersion?: string;
  message?: string;
}

/**
 * relay 侧（devbridge-key/auth 折叠链）识别 409 门禁错误的唯一判定。与
 * versionGateResult 共用同一规则源：只认 VERSION_GATE_CODE。
 */
export function isVersionGateError(error: unknown): boolean {
  return (error as { code?: unknown }).code === VERSION_GATE_CODE;
}

const UPGRADE_STEPS = [
  '在终端执行：npx --yes huaweicloud-devkit@latest update --target <agent>',
  '升级完成后重启当前 Agent 会话（MCP 工具需重启才生效）',
  '也可直接调用 huaweicloud_upgrade 工具完成升级',
] as const;

/**
 * 409 门禁装填（hdkitRequest 错误分支调用）：把服务端 payload 与升级引导挂到
 * 抛出的错误上。remediation 文案与 dev 501fd8b4 逐字一致；v2 不带 dev 的
 * autoUpgrade 字段（其自动升级模块未移植）。
 */
export function applyVersionGate(error: unknown, payload: VersionGatePayload): void {
  const err = error as {
    clientVersion?: string;
    minVersion?: string;
    message?: string;
    remediation?: { hint: string; steps: string[] };
  };
  err.clientVersion = payload.clientVersion;
  err.minVersion = payload.minVersion;
  if (payload.message) err.message = payload.message;
  err.remediation = {
    hint: `插件版本过旧（当前 ${payload.clientVersion || '未知'}，需升级至正式版 ${payload.minVersion || '最新版'} 及以上）：`,
    steps: [...UPGRADE_STEPS],
  };
}

/**
 * 门禁字段的统一展开：clientVersion/minVersion/remediation 按存在性附加。
 * versionGateResult 与 voucherFallback 共用——出口信封形态不同（ok:false vs
 * claimed:false），但字段规则只有这一份。
 */
export function gatePayloadFields(err: {
  clientVersion?: unknown;
  minVersion?: unknown;
  remediation?: unknown;
}): Record<string, unknown> {
  return {
    ...(err.clientVersion ? { clientVersion: err.clientVersion } : {}),
    ...(err.minVersion ? { minVersion: err.minVersion } : {}),
    ...(err.remediation ? { remediation: err.remediation } : {}),
  };
}

/**
 * 各出口的 409 门禁折叠（dev e1255a4b 的 toVersionGateResult）：非门禁错误返回
 * undefined，调用方继续原有抛出/业务折叠。
 */
export function versionGateResult(error: unknown): Record<string, unknown> | undefined {
  const err = error as {
    code?: unknown;
    message?: unknown;
    retryAfter?: unknown;
    coreHoursExhausted?: unknown;
    clientVersion?: unknown;
    minVersion?: unknown;
    remediation?: unknown;
  };
  if (err.code !== VERSION_GATE_CODE) return undefined;
  return {
    ok: false,
    code: VERSION_GATE_CODE,
    message: asText(err.message) || '插件版本过旧，请升级插件后重启会话',
    ...(err.retryAfter ? { retryAfter: err.retryAfter } : {}),
    ...(err.coreHoursExhausted ? { coreHoursExhausted: true } : {}),
    ...gatePayloadFields(err),
  };
}

/**
 * 连接重试耗尽装填（v2 扩展）：gatewayRetryExhausted 标记供 connect 出口折叠
 * 识别；业务码已存在的 502（如烧核 HDKIT_UPSTREAM_ERROR）保留其 code 与
 * remediation，不覆盖。
 */
export function decorateExhaustedConnect(error: unknown, retries: number): void {
  const err = error as {
    code?: string;
    remediation?: { hint: string; steps: string[] };
    gatewayRetryExhausted?: boolean;
  };
  err.gatewayRetryExhausted = true;
  if (!err.code) err.code = 'HDKIT_GATEWAY_TIMEOUT';
  if (!err.remediation) {
    err.remediation = {
      hint: `连接已自动重试 ${retries} 次仍失败，连续遭遇网关 502/504 超时（瞬时故障，非沙箱创建失败）：`,
      steps: [
        '服务端可能已创建/启动沙箱实例——再次 connect 同池实例会自动复用，通常直接成功',
        '稍后重试 connect；网关超时通常在数分钟内自愈',
        '多次重试仍失败时，检查本地网络或代理配置后再试',
      ],
    };
  }
}

/**
 * connect 出口的耗尽折叠（v2 扩展；dev 在此路径裸抛）：带 gatewayRetryExhausted
 * 标记的错误转 ok:false 结构化返回，remediation 与尝试次数穿透 MCP 边界。
 */
export function transientExhaustionResult(error: unknown): Record<string, unknown> | undefined {
  const err = error as {
    gatewayRetryExhausted?: unknown;
    code?: unknown;
    message?: unknown;
    connectRetries?: unknown;
    coreHoursExhausted?: unknown;
    retryAfter?: unknown;
    remediation?: unknown;
  };
  if (err.gatewayRetryExhausted !== true) return undefined;
  return {
    ok: false,
    code: err.code,
    message: asText(err.message) || 'connect 持续遭遇网关 502/504 超时',
    connectRetries: err.connectRetries,
    ...(err.coreHoursExhausted ? { coreHoursExhausted: true } : {}),
    ...(err.retryAfter ? { retryAfter: err.retryAfter } : {}),
    ...(err.remediation ? { remediation: err.remediation } : {}),
  };
}
