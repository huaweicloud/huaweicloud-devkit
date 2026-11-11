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

// 非 DI 空白判定（round 8–9）：\s（空白不在 DI）、\p{Cc} 控制符（NUL/BEL
// 无渲染，DI 不含 Cc）、盲文空白 U+2800（So 类，空点阵），以及 19 个 UAX 44
// 从 DI 永久除名的不可见 Cf（round 9：U+FFF9–U+FFFB 行间注释锚点、
// U+13430–U+1343F 圣书体连字符——round 7 的 \p{Cf} 类曾覆盖它们，round 8 的
// DI 权威收口时遗漏）。其余 12 个 Cf-非-DI 码点（U+0600–U+0605、U+06DD、
// U+070F、U+0890/U+0891、U+110BD/U+110CD 等阿拉伯/叙利亚数字与句读号，
// 以及 U+08E2）渲染可见符号，是真文本——08E2（阿拉伯任选连字符）与软连字符
// U+00AD 同语义但按根裁定不在 19 码之列，边界记录在台账。
const NON_DI_INVISIBLE_CF = /[\u{FFF9}-\u{FFFB}\u{13430}-\u{1343F}]/u;

/**
 * 消息可见性判定（round 6 收口、round 8 权威、round 9 补 19 Cf）：权威是
 * Unicode 的 Default_Ignorable_Code_Point 属性类；纯不可见才判空白——只要有
 * 任何一个字符渲染可见，消息就是真文本；真文本包着一个不可见字符是可见
 * 消息，走边缘剥离而非缺失。
 */
export function rendersBlank(text: string): boolean {
  const hasVisible = [...text].some(
    (ch) =>
      !/\s/u.test(ch) &&
      !/\p{Default_Ignorable_Code_Point}/u.test(ch) &&
      !/\p{Cc}/u.test(ch) &&
      !NON_DI_INVISIBLE_CF.test(ch) &&
      (ch.codePointAt(0) ?? 0) !== 0x2800,
  );
  return !hasVisible;
}

/**
 * 消息清洗（round 5 + round 7 + round 8）：纯空白/纯不可见视为缺失；真文本
 * 去掉两端的空白与不可见字符（round 8 起按码点迭代——UTF-16 单元读法会让
 * 星面区空白字符存活在边缘），内部不可见字符保留（真文本语义）。请求层
 * 消息构建与 versionGateMessage/耗尽消息/码字段读共用——任何出口都不渲染
 * 空白文案或带不可见边缘的码。
 */
export function cleanMessage(text: string | undefined): string {
  if (!text) return '';
  if (rendersBlank(text)) return '';
  const chars = [...text];
  let lo = 0;
  let hi = chars.length;
  while (lo < hi && rendersBlank(chars[lo]!)) lo += 1;
  while (hi > lo && rendersBlank(chars[hi - 1]!)) hi -= 1;
  return chars.slice(lo, hi).join('');
}

/**
 * 网关 502/504 瞬时判定（dev e0c8700b + v2 分歧，两轮收口）：编排期响应超时，
 * 非创建失败——服务端可能已在编排实例，重试通常复用同一实例。
 * v2 分歧（台账记录）：dev 的消息正则无条件生效，非 JSON 页/转述上游文案的
 * 错误会被误判；v2 只按 status 裁决——非 JSON 抛错自带 resp.status（round 3
 * 起 Object.assign 携带），消息兜底随之全死并删除。
 */
export function isGatewayTransient(error: unknown): boolean {
  const err = error as { status?: unknown };
  return typeof err.status === 'number' && TRANSIENT_STATUSES.has(err.status);
}

/**
 * 客户端裁决码不参与重试（round 3 + round 4）：状态改写网关可能把业务信封套在
 * 502/504 下送达。裁决码的 remediation/指引指向调用方要做的动作（升级/释放/
 * 错峰/修凭证/实名签署），有界即时重试无法推进——与上游错误码（如烧核
 * HDKIT_UPSTREAM_ERROR，跟随 status，dev 同款）的分界即在于此。round 4 补入
 * 账号校验三码：SKILL 的 connect 契约把它们教成"告知开发者一次即停"的裁决。
 */
const NON_RETRYABLE_CLIENT_CODES: ReadonlySet<string> = new Set([
  VERSION_GATE_CODE,
  'HDKIT_QUOTA_EXCEEDED',
  'HDKIT_CAPACITY_INSUFFICIENT',
  'HDKIT_CRED_INVALID',
  'HDKIT_NOT_REALNAME',
  'HDKIT_NOT_AGREEMENT',
  'HDKIT_NOT_REALNAME_AND_AGREEMENT',
]);

export function isNonRetryableBusinessError(error: unknown): boolean {
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && NON_RETRYABLE_CLIENT_CODES.has(code);
}

export interface VersionGatePayload {
  clientVersion?: string;
  minVersion?: string;
  message?: string;
}

/**
 * relay 侧（devbridge-key/auth 折叠链）识别 409 门禁错误的判定。与
 * versionGateResult 共用同一规则源（isCodelessGateStatus）：认
 * VERSION_GATE_CODE，或无可用码的 409——409 且无码/门禁码即门禁；带其他
 * 服务端码的 409 按其自身码处理（round 7 措辞收口）。空白/Cf 码视同无码
 * （round 7），中断形态按 bodyUnreadable 判定（不依赖传输层不占 code 属性）。
 */
export function isVersionGateError(error: unknown): boolean {
  return (error as { code?: unknown }).code === VERSION_GATE_CODE || isCodelessGateStatus(error);
}

/**
 * 无码 409 判定（round 6 去重、round 7 收口）：带 409 status 且无可用服务端
 * 码——body 读取中断 / 非 JSON 页 / 可读但 code 字段缺失或纯空白——即门禁。
 * 中断形态以 bodyUnreadable 标记为准：真实传输层中断（AbortController 的
 * DOMException）自带 code 属性（数值 20），不得以 code 是否存在裁决。
 */
function isCodelessGateStatus(error: unknown): boolean {
  const err = error as { code?: unknown; status?: unknown; bodyUnreadable?: unknown };
  if (err.status !== 409) return false;
  if (err.bodyUnreadable === true) return true;
  return typeof err.code !== 'string' || cleanMessage(err.code) === '';
}

const UPGRADE_STEPS = [
  '在终端执行：npx --yes huaweicloud-devkit@latest update --target <agent>',
  '升级完成后重启当前 Agent 会话（MCP 工具需重启才生效）',
  '也可直接调用 huaweicloud_upgrade 工具完成升级',
] as const;

/**
 * 409 门禁装填（hdkitRequest 错误分支调用）：把服务端 payload 与升级引导挂到
 * 抛出的错误上。remediation 文案与 dev 501fd8b4 逐字一致；v2 不带 dev 的
 * autoUpgrade 字段（其自动升级模块未移植）。空白字段值归一为缺失——hint 不留
 * 空位，兜底（未知/最新版）照常生效。
 */
export function applyVersionGate(error: unknown, payload: VersionGatePayload): void {
  const err = error as {
    clientVersion?: string;
    minVersion?: string;
    message?: string;
    remediation?: { hint: string; steps: string[] };
  };
  // round 6：版本字段与消息同过清洗口（cleanMessage）——纯不可见值视同缺失，
  // hint 不留不可见空位，兜底（未知/最新版）照常生效
  const clientVersion = cleanMessage(payload.clientVersion) || undefined;
  const minVersion = cleanMessage(payload.minVersion) || undefined;
  const message = cleanMessage(payload.message) || undefined;
  err.clientVersion = clientVersion;
  err.minVersion = minVersion;
  if (message) err.message = message;
  err.remediation = {
    hint: `插件版本过旧（当前 ${clientVersion || '未知'}，需升级至正式版 ${minVersion || '最新版'} 及以上）：`,
    steps: [...UPGRADE_STEPS],
  };
}

/**
 * 门禁消息的统一读取（round 4）：空白即缺失，兜底文案只此一份——
 * versionGateResult 与 relay 折叠共用，任何出口都不渲染空白的 error 字段。
 */
export const VERSION_GATE_FALLBACK_MESSAGE = '插件版本过旧，请升级插件后重启会话';

export function versionGateMessage(error: unknown): string {
  const raw = (error as { message?: unknown }).message;
  return cleanMessage(typeof raw === 'string' ? raw : '') || VERSION_GATE_FALLBACK_MESSAGE;
}

/**
 * 无码 409 的未知版本兜底（round 5 v2 扩展）：body 不可读（读取中断/非 JSON）
 * 或可读但无服务端码的 409，其 remediation 就地铸出。
 */
export function codelessGateFields(): { remediation: { hint: string; steps: string[] } } {
  return {
    remediation: {
      hint: '插件版本过旧（当前 未知，需升级至正式版 最新版 及以上）：',
      steps: [...UPGRADE_STEPS],
    },
  };
}

export interface GateFoldPayload {
  code: string;
  message: string;
  remediation: { hint: string; steps: string[] };
  clientVersion?: string;
  minVersion?: string;
}

/**
 * 门禁折叠的统一载荷（round 6 收口，替代三处分叉的折叠逻辑）：带码门禁透传
 * 服务端字段——消息过 versionGateMessage 清洗口，remediation 缺失时就地铸出，
 * 版本字段同样清洗（纯不可见视同缺失）。无码 409 走未知版本兜底——body 不可读
 * 时消息用设计文案（传输噪声不冒充服务端话术，bodyUnreadable 标记），可读时
 * 透传服务端 copy。versionGateResult / voucherFallback / relay 折叠共用此份。
 */
export function gateFoldPayload(error: unknown): GateFoldPayload {
  const err = error as {
    code?: unknown;
    clientVersion?: unknown;
    minVersion?: unknown;
    remediation?: { hint: string; steps: string[] };
    bodyUnreadable?: unknown;
  };
  if (err.code === VERSION_GATE_CODE) {
    const clientVersion = cleanMessage(typeof err.clientVersion === 'string' ? err.clientVersion : '') || undefined;
    const minVersion = cleanMessage(typeof err.minVersion === 'string' ? err.minVersion : '') || undefined;
    return {
      code: VERSION_GATE_CODE,
      message: versionGateMessage(err),
      remediation: err.remediation ?? codelessGateFields().remediation,
      ...(clientVersion ? { clientVersion } : {}),
      ...(minVersion ? { minVersion } : {}),
    };
  }
  return {
    code: VERSION_GATE_CODE,
    message: err.bodyUnreadable === true ? VERSION_GATE_FALLBACK_MESSAGE : versionGateMessage(err),
    remediation: codelessGateFields().remediation,
  };
}

/**
 * 各出口的 409 门禁折叠（dev e1255a4b 的 toVersionGateResult）：非门禁错误返回
 * undefined，调用方继续原有抛出/业务折叠。无码 409（可读/中断/非 JSON）同折。
 */
export function versionGateResult(error: unknown): Record<string, unknown> | undefined {
  if (!isVersionGateError(error)) return undefined;
  const err = error as { retryAfter?: unknown; coreHoursExhausted?: unknown };
  return {
    ok: false,
    ...gateFoldPayload(error),
    ...(err.retryAfter ? { retryAfter: err.retryAfter } : {}),
    ...(err.coreHoursExhausted ? { coreHoursExhausted: true } : {}),
  };
}

// 装填辅助（round 9 收口）：普通赋值失败（getter-only 原型访问器，如
// DOMException.code）用 defineProperty 落 own 属性；载体整体拒绝装饰（冻结
// 对象、不可配置的 own getter）时返回 false——由调用方走克隆分支。
function decorateInPlace(target: Record<string, unknown>, fields: Array<[string, unknown]>): boolean {
  for (const [key, value] of fields) {
    try {
      target[key] = value;
    } catch {
      try {
        Object.defineProperty(target, key, { value, writable: true, configurable: true });
      } catch {
        return false;
      }
    }
  }
  return true;
}

/**
 * 连接重试耗尽装填（v2 扩展）：gatewayRetryExhausted 标记供 connect 出口折叠
 * 识别；业务码已存在的 502（如烧核 HDKIT_UPSTREAM_ERROR）保留其 code 与
 * remediation，不覆盖。设计网关码对传输/伪造码无条件胜出（round 8）：数值
 * code（AbortError DOMException 的 20）与请求层伪造的 HTTP_x 码（可读无码
 * JSON 502 制造的 HTTP_502）替换为 HDKIT_GATEWAY_TIMEOUT，服务端业务码保留。
 * 返回值（round 9）：常规载体就地装填并返回原对象；拒绝装饰的载体（冻结/
 * 不可配置 getter——请求层不会产生，仅导出面可达）克隆后装填并返回克隆，
 * 调用方须抛出返回值。DOMException 等可扩展原型访问器载体仍就地装填。
 */
export function decorateExhaustedConnect(error: unknown, retries: number): unknown {
  const err = error as {
    code?: unknown;
    message?: unknown;
    remediation?: { hint: string; steps: string[] };
    gatewayRetryExhausted?: boolean;
  };
  const replaceCode = typeof err.code !== 'string' || err.code === '' || /^HTTP_\d+$/.test(err.code);
  const effectiveCode = replaceCode ? 'HDKIT_GATEWAY_TIMEOUT' : err.code;
  const fields: Array<[string, unknown]> = [['gatewayRetryExhausted', true]];
  if (replaceCode) fields.push(['code', 'HDKIT_GATEWAY_TIMEOUT']);
  if (effectiveCode === 'HDKIT_GATEWAY_TIMEOUT' && !cleanMessage(typeof err.message === 'string' ? err.message : '')) {
    fields.push(['message', `hdkitservice 连续遭遇网关 502/504 超时（已自动重试 ${retries} 次）`]);
  }
  if (!err.remediation) {
    fields.push([
      'remediation',
      {
        hint: `连接已自动重试 ${retries} 次仍失败，连续遭遇网关 502/504 超时（瞬时故障，非沙箱创建失败）：`,
        steps: [
          '服务端可能已创建/启动沙箱实例——再次 connect 同池实例会自动复用，通常直接成功',
          '稍后重试 connect；网关超时通常在数分钟内自愈',
          '多次重试仍失败时，检查本地网络或代理配置后再试',
        ],
      },
    ]);
  }
  const decorateTarget = err as unknown as Record<string, unknown>;
  if (decorateInPlace(decorateTarget, fields)) return error;
  const clone = Object.assign(new Error(String((err as Error).message ?? '')), decorateTarget);
  decorateInPlace(clone, fields);
  return clone;
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
    // round 6：耗尽出口的消息读同样过清洗口——纯不可见原因不渲染成不可见文案
    message: cleanMessage(typeof err.message === 'string' ? err.message : '') || 'connect 持续遭遇网关 502/504 超时',
    connectRetries: err.connectRetries,
    ...(err.coreHoursExhausted ? { coreHoursExhausted: true } : {}),
    ...(err.retryAfter ? { retryAfter: err.retryAfter } : {}),
    ...(err.remediation ? { remediation: err.remediation } : {}),
  };
}
