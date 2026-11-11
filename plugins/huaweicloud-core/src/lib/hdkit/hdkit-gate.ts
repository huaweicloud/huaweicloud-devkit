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
  return NON_RETRYABLE_CLIENT_CODES.has(canonCode(safeReadField(error, 'code')));
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
  return canonCode(safeReadField(error, 'code')) === VERSION_GATE_CODE || isCodelessGateStatus(error);
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
  return canonCode(err.code) === '';
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
  // round 11：消息读过安全卫队——抛出型 getter 按缺失，兜底文案生效
  return cleanMessage(safeMessageText(error)) || VERSION_GATE_FALLBACK_MESSAGE;
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
  const rawCode = safeReadField(error, 'code');
  if (canonCode(rawCode) === VERSION_GATE_CODE) {
    const clientVersion = cleanMessage(safeReadField(error, 'clientVersion') as string | undefined) || undefined;
    const minVersion = cleanMessage(safeReadField(error, 'minVersion') as string | undefined) || undefined;
    const remediation = safeReadField(error, 'remediation') as { hint: string; steps: string[] } | undefined;
    return {
      code: VERSION_GATE_CODE,
      message: versionGateMessage(error),
      remediation: remediation ?? codelessGateFields().remediation,
      ...(clientVersion ? { clientVersion } : {}),
      ...(minVersion ? { minVersion } : {}),
    };
  }
  const bodyUnreadable = safeReadField(error, 'bodyUnreadable');
  return {
    code: VERSION_GATE_CODE,
    message: bodyUnreadable === true ? VERSION_GATE_FALLBACK_MESSAGE : versionGateMessage(error),
    remediation: codelessGateFields().remediation,
  };
}

/**
 * 各出口的 409 门禁折叠（dev e1255a4b 的 toVersionGateResult）：非门禁错误返回
 * undefined，调用方继续原有抛出/业务折叠。无码 409（可读/中断/非 JSON）同折。
 */
export function versionGateResult(error: unknown): Record<string, unknown> | undefined {
  if (!isVersionGateError(error)) return undefined;
  // round 12：字段读安全化（抛出型 getter 按缺失）
  const retryAfter = safeReadField(error, 'retryAfter');
  const coreHoursExhausted = safeReadField(error, 'coreHoursExhausted');
  return {
    ok: false,
    ...gateFoldPayload(error),
    ...(retryAfter ? { retryAfter } : {}),
    ...(coreHoursExhausted ? { coreHoursExhausted: true } : {}),
  };
}

// 安全字段读取（round 10–11）：抛出型 getter 不引爆——按缺失处理，装饰与
// 折叠分支的设计文案兜底。message 专读（字符串或缺失）与通用字段读共用。
function safeReadField(target: unknown, key: string): unknown {
  try {
    return (target as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

function safeMessageText(err: unknown): string {
  const raw = safeReadField(err, 'message');
  return typeof raw === 'string' ? raw : '';
}

// 拼写清洗（round 11）：剔除全部空白渲染字符（权威类 + 19 Cf 附加 + \s +
// 盲文空白），内部与边缘一视同仁——码字段的判定口径。消息清洗（cleanMessage）
// 保留内部不可见（真文本语义）；码拼写不保留：HTTP_5⁠02 与 HTTP_502 同为
// 伪造拼写，服务端亲署业务码不含空白渲染字符。
function blankCharsRemoved(text: string): string {
  return [...text].filter((ch) => !rendersBlank(ch)).join('');
}

// 码字段裁决标准（round 12）：一切码身份比较的唯一口径——剔除全部空白渲染
// 字符（内部与边缘一视同仁）。服务端亲署业务码不含空白渲染字符；织入/垫入/
// 分隔符替换的拼写与干净拼写同码。非字符串值归 ''（无码）。
export function canonCode(code: unknown): string {
  return typeof code === 'string' ? blankCharsRemoved(code) : '';
}

// 伪造码家族判定（round 12）：规范拼写为 HTTP 加可选下划线加数字——下划线
// 被空白渲染字符替换（HTTP\u00a0502 / HTTP 502 / HTTP_5\u206002）同样是伪造拼写，
// 按模块自身教义，含空白渲染字符的码绝非服务端亲署。
const MANUFACTURED_FAMILY = /^HTTP_?\d+$/;

// 伪造码前缀的规范匹配（round 12）：以拼写为骨、字符间与冒号前允许夹任意
// 空白渲染字符——'HTTP_5⁠02: ' 与 'HTTP 502: ' 都命中 'HTTP_502' 的模式。
// 仅在装饰的 replaceCode 分支使用（拼写必为 HTTP 家族或空）。
function manufacturedPrefixPattern(spelling: string): RegExp | undefined {
  if (!spelling) return undefined;
  const body = [...spelling].map((ch) => ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join(BLANK_STAR);
  return new RegExp(`^${BLANK_STAR}${body}${BLANK_STAR}:`, 'u');
}

const BLANK_STAR = '[\\s\\p{Default_Ignorable_Code_Point}\\p{Cc}\u{FFF9}-\u{FFFB}\u{13430}-\u{1343F}\u2800]*';

// 装填辅助（round 9 收口、round 10 回滚）：普通赋值失败（getter-only 原型
// 访问器，如 DOMException.code）用 defineProperty 落 own 属性；载体整体拒绝
// 装饰（冻结对象、不可配置的 own getter）时回滚已写字段后返回 false——由
// 调用方走克隆分支，丢弃的原对象不得带半截装饰（gatewayRetryExhausted 已
// 落而 code 未换，会把传输码 20 折叠出去）。
function decorateInPlace(target: Record<string, unknown>, fields: Array<[string, unknown]>): boolean {
  const applied: Array<string> = [];
  const snapshots = new Map<string, { had: boolean; value: unknown }>();
  for (const [key, value] of fields) {
    // 快照读取带防护：抛出型 getter 不引爆回滚路径（按缺失快照）
    let prior: unknown;
    let had = false;
    try {
      had = key in target;
      prior = had ? target[key] : undefined;
    } catch {
      prior = undefined;
    }
    snapshots.set(key, { had, value: prior });
    try {
      target[key] = value;
      applied.push(key);
    } catch {
      try {
        Object.defineProperty(target, key, { value, writable: true, configurable: true });
        applied.push(key);
      } catch {
        for (const done of applied) {
          const snap = snapshots.get(done)!;
          try {
            if (snap.had) target[done] = snap.value;
            else delete target[done];
          } catch {
            // 还原亦被拒（被丢弃的原对象，尽力而为）
          }
        }
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
  // 非对象载体（round 11 导出面防御）：null/原始值上的属性读取即抛——直接
  // 返回装填好设计字段的普通 Error
  if (error === null || (typeof error !== 'object' && typeof error !== 'function')) {
    return decoratePlainCarrier(retries);
  }
  const err = error as {
    code?: unknown;
    message?: unknown;
    remediation?: { hint: string; steps: string[] };
    gatewayRetryExhausted?: boolean;
  };
  // 码与 remediation 过安全读（round 11）：抛出型 getter 按缺失处理——与
  // message 同一卫队，快照防护之前不再引爆
  const rawCode = safeReadField(err, 'code');
  const rawMessage = safeMessageText(err);
  const rawRemediation = safeReadField(err, 'remediation');
  // mint 判定用拼写口径（round 11）：内部与边缘的空白渲染字符一并剔除——
  // HTTP_5⁠02（词连接符藏码内）与垫码（HTTP_504+ZWSP）同为伪造拼写；
  // 服务端亲署业务码不含空白渲染字符，不受影响
  const spelling = canonCode(rawCode);
  const replaceCode = spelling === '' || MANUFACTURED_FAMILY.test(spelling);
  const effectiveCode = replaceCode ? 'HDKIT_GATEWAY_TIMEOUT' : rawCode;
  const designedCopy = `hdkitservice 连续遭遇网关 502/504 超时（已自动重试 ${retries} 次）`;
  const fields: Array<[string, unknown]> = [
    ['gatewayRetryExhausted', true],
    ['connectRetries', retries],
  ];
  if (replaceCode) {
    fields.push(['code', 'HDKIT_GATEWAY_TIMEOUT']);
    // 伪造码的最后表面（round 10–11）：消息里与被替换码同名的 "HTTP_x: "
    // 前缀循环剥除（页面消息以码拼写开头会翻倍），原始与拼写两种形态都剥；
    // 剥后仍以拼写开头（含"消息=码"形态）或为空则用设计文案
    let remainder = rawMessage;
    // 按规范比较（round 12）：拼写字符间与冒号前可夹空白渲染字符——织入副本
    // 与干净码的交叉形态同样剥除；剥后仍以拼写开头（含"消息=码"形态，规范
    // 口径）或为空则用设计文案
    const prefixPattern = manufacturedPrefixPattern(spelling);
    if (prefixPattern) {
      for (;;) {
        const hit = prefixPattern.exec(remainder);
        if (!hit) break;
        remainder = remainder.slice(hit[0].length);
      }
    }
    const cleaned = cleanMessage(remainder);
    const opensWithSpelling = spelling !== '' && canonCode(cleaned).startsWith(spelling);
    fields.push(['message', cleaned === '' || opensWithSpelling ? designedCopy : cleaned]);
  } else if (canonCode(effectiveCode) === 'HDKIT_GATEWAY_TIMEOUT' && !cleanMessage(rawMessage)) {
    fields.push(['message', designedCopy]);
  }
  if (!rawRemediation) {
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
  return cloneCarrier(err, fields);
}

// 非对象载体的装填（round 11）：无字段可读——码/消息/remediation 全走设计值
function decoratePlainCarrier(retries: number): Error {
  const plain = new Error(`hdkitservice 连续遭遇网关 502/504 超时（已自动重试 ${retries} 次）`);
  const fields: Array<[string, unknown]> = [
    ['gatewayRetryExhausted', true],
    ['connectRetries', retries],
    ['code', 'HDKIT_GATEWAY_TIMEOUT'],
    [
      'remediation',
      {
        hint: `连接已自动重试 ${retries} 次仍失败，连续遭遇网关 502/504 超时（瞬时故障，非沙箱创建失败）：`,
        steps: [
          '服务端可能已创建/启动沙箱实例——再次 connect 同池实例会自动复用，通常直接成功',
          '稍后重试 connect；网关超时通常在数分钟内自愈',
          '多次重试仍失败时，检查本地网络或代理配置后再试',
        ],
      },
    ],
  ];
  decorateInPlace(plain as unknown as Record<string, unknown>, fields);
  return plain;
}

// 拒绝装饰载体的克隆（round 10）：own 字段按属性描述符复制（Object.assign
// 会丢不可枚举业务字段，[[Get]] 读法会引爆抛出型 getter），message/stack 与
// 被装饰键除外——装饰键由 fields 落值；message 安全读取，读失败按缺失处理。
function cloneCarrier(err: object, fields: Array<[string, unknown]>): Error {
  const clone = new Error(safeMessageText(err));
  const decoratedKeys = new Set<string | symbol>(fields.map(([key]) => key));
  try {
    for (const key of Reflect.ownKeys(err)) {
      // 字符串与符号键都按描述符复制（round 11：符号键是业务字段），message/
      // stack 与被装饰键除外——装饰键由 fields 落值
      if (key === 'message' || key === 'stack' || decoratedKeys.has(key)) continue;
      const desc = Object.getOwnPropertyDescriptor(err, key);
      if (desc) Object.defineProperty(clone, key, desc);
    }
  } catch {
    // 撤销/陷阱代理（round 12）：枚举即抛——按无携带字段处理，设计值兜底
  }
  decorateInPlace(clone as unknown as Record<string, unknown>, fields);
  return clone;
}

/**
 * connect 出口的耗尽折叠（v2 扩展；dev 在此路径裸抛）：带 gatewayRetryExhausted
 * 标记的错误转 ok:false 结构化返回，remediation 与尝试次数穿透 MCP 边界。
 */
export function transientExhaustionResult(error: unknown): Record<string, unknown> | undefined {
  // round 12：全部字段过安全读——抛出型 getter 按缺失，标记缺失即不折叠
  const gatewayRetryExhausted = safeReadField(error, 'gatewayRetryExhausted');
  if (gatewayRetryExhausted !== true) return undefined;
  const coreHoursExhausted = safeReadField(error, 'coreHoursExhausted');
  const retryAfter = safeReadField(error, 'retryAfter');
  const remediation = safeReadField(error, 'remediation');
  return {
    ok: false,
    code: safeReadField(error, 'code'),
    // round 6：耗尽出口的消息读同样过清洗口——纯不可见原因不渲染成不可见文案
    message: cleanMessage(safeMessageText(error)) || 'connect 持续遭遇网关 502/504 超时',
    connectRetries: safeReadField(error, 'connectRetries'),
    ...(coreHoursExhausted ? { coreHoursExhausted: true } : {}),
    ...(retryAfter ? { retryAfter } : {}),
    ...(remediation ? { remediation } : {}),
  };
}
