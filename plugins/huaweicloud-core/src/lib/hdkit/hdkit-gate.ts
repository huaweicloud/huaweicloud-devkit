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

/**
 * 装填被拒的诊断字段（round 19 建、round 20 降级为诊断）：中和后仍存活的
 * 装饰值/访问器——延迟谎言、陷阱 defineProperty、第三值访问器一并覆盖。
 * 裁决不在此字段、也不在载体上的任何读数：折叠口查 refusedCarriers（模块
 * 态 WeakMap，按对象身份，零载体读——吞写陷阱吞掉本字段、谎言 get 藏起本
 * 字段都不影响折叠拒绝）。本字段仅尽力而为落盘供观测，写不落不影响裁决。
 */
export const DECORATION_REFUSED_FIELD = 'hdkitDecorationRefused';

// 装填被拒的载体登记（round 20 建、round 22 挣得键、round 23 种类并存）：
// 裁决的权威在模块态。WeakMap 按对象身份查询——不触发任何代理陷阱，撤销
// 代理/原始值/吞写载体一律安全（get 对非对象键恒 undefined，无需卫队）。
// round 23：一个载体可被两种装饰器先后拒绝——kinds 并存（cross-kind 第二
// 拒绝并入而非丢弃），每种各自记挣得键；解除（lift）只在唯一种类且挣得键
// 全部落定验证时发生（round 21 的无记忆解除让无关字段的再装饰/跨装饰器拼
// 写整体解除登记，谎言随解除复活；round 23 收口：并存的种类永不解除——
// 另一种类的立着访问器在解除后会裸露）。折叠按种类裁决：门禁折叠只对
// gate 登记铸造、exhaustion 登记不折叠（round 23/SHOULD 7），耗尽折叠对
// 一切登记拒绝
type RefusalKind = 'gate' | 'exhaustion';
type RefusalRecord = {
  kinds: Set<RefusalKind>;
  keysByKind: Map<RefusalKind, Set<string | symbol>>;
};
const refusedCarriers = new WeakMap<object, RefusalRecord>();

function refusalOf(error: unknown): RefusalRecord | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  return refusedCarriers.get(error);
}

// 落定登记（round 24/MUST 3c）：就地装填成功时记下设计字段——折叠口按记
// 录值铸信封而非经 [[Get]] 重读（落定后的翻供/删除让门禁信封自相矛盾、耗
// 尽折叠消失成裸抛）。登记只在成功路径整体重写：拒绝路径不写（登记在身的
// 载体由登记裁决折叠），解除后的再装饰按新落定记录折叠
const provenLandings = new WeakMap<object, Map<string, unknown>>();

function recordProvenLanding(target: object, fields: Array<[string, unknown]>, kind?: RefusalKind): void {
  const record = new Map<string, unknown>();
  for (const [key, value] of fields) record.set(key, value);
  if (kind !== undefined) record.set('__kind', kind);
  provenLandings.set(target, record);
}

function provenKindIs(error: unknown, kind: RefusalKind): boolean {
  if (typeof error !== 'object' || error === null) return false;
  return provenLandings.get(error)?.get('__kind') === kind;
}

function provenField(error: unknown, key: string): unknown {
  if (typeof error !== 'object' || error === null) return undefined;
  const record = provenLandings.get(error);
  return record !== undefined && record.has(key) ? record.get(key) : undefined;
}

// 折叠口对记录未含字段（服务端亲署码/消息/转向字段不经装饰）的回退读
// （round 24/MUST 3c）：自有数据描述符取值（honest gOPD，非 [[Get]]——翻
// 供、删除、抛出不波及）；访问器、无自有定义、敌意 gOPD 一律按缺失
function ownDataValue(error: unknown, key: string): unknown {
  if (typeof error !== 'object' || error === null) return undefined;
  try {
    const desc = Object.getOwnPropertyDescriptor(error, key);
    if (desc !== undefined && desc.get === undefined && desc.set === undefined) return desc.value;
  } catch {
    // 敌意 gOPD——按缺失
  }
  return undefined;
}

// 登记并入（round 23）：同种类合并键集，跨种类并入 kinds——首胜丢弃会让
// 另一种类的立着访问器在单种类解除后裸露
function registerRefusal(target: object, kind: RefusalKind, keys: ReadonlySet<string | symbol>): void {
  const existing = refusedCarriers.get(target);
  if (existing === undefined) {
    refusedCarriers.set(target, {
      kinds: new Set([kind]),
      keysByKind: new Map([[kind, new Set(keys)]]),
    });
    return;
  }
  existing.kinds.add(kind);
  const merged = existing.keysByKind.get(kind) ?? new Set<string | symbol>();
  for (const key of keys) merged.add(key);
  existing.keysByKind.set(kind, merged);
}

// 登记载体的门禁信封（round 23 去重）：两处折叠共用一份铸造
function registeredGateEnvelope(): Record<string, unknown> {
  return {
    ok: false,
    code: VERSION_GATE_CODE,
    message: VERSION_GATE_FALLBACK_MESSAGE,
    remediation: codelessGateFields().remediation,
  };
}

// 链上访问器判定（round 22/MUST 1）：gOPD 只看自有属性——原型 getter/setter
// 对两处新判定全溜过（落定键判定把原件交回、undefined 存活判定跳过登记）。
// 沿查找链走到首个定义该键的层级定夺：访问器即立着（可随时翻供）；全链无
// 定义为纯数据。原型走查抛出（撤销代理/敌意链）从严按立着处理
// 链首定义查找（round 23 去重两探测共用）：visited 环卫队（getPrototypeOf
// 陷阱可造合法 2-环——环不抛出，无界走查让工具调用悬挂，仪器实测 100001
// 跳）——走到首个定义该键的层级返回其描述符；环或走查抛入 hostile（调用
// 方从严处理）；全链无定义返回 undefined
function firstDefiningDescriptor(
  target: object,
  key: string | symbol,
): { desc: PropertyDescriptor } | { hostile: true } | undefined {
  try {
    let level: object | null = target;
    const visited = new Set<unknown>();
    // 跳数上界（round 24/MUST 1）：visited 只拦再访——每次铸造新代理的
    // getPrototypeOf 陷阱永不重复，直到 V8 有序哈希 16,777,216 上限以
    // RangeError 落进 catch（实测 9.8s/3.5GB 每次走查；512MB 预算下是杀
    // 整个 MCP 进程的 OOM）。1024 跳远超真实链深（自有测试 100 层）；
    // 超深同环按敌意处理
    let hops = 0;
    while (level !== null) {
      if (visited.has(level) || ++hops > 1024) return { hostile: true };
      visited.add(level);
      const desc = Object.getOwnPropertyDescriptor(level, key);
      if (desc) return { desc };
      level = Object.getPrototypeOf(level) as object | null;
    }
    return undefined;
  } catch {
    return { hostile: true };
  }
}

// 访问器立着判定（round 22 建、round 23 环安全）：首个定义层是访问器即立
// （可翻供）；环/抛出按立着（拒绝/克隆），与意图句同判
function chainAccessorStanding(target: object, key: string | symbol): boolean {
  const found = firstDefiningDescriptor(target, key);
  if (found === undefined) return false;
  if ('hostile' in found) return true;
  return found.desc.get !== undefined || found.desc.set !== undefined;
}

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
  // status 过安全读（round 14）：重试 catch 里第一个求值的谓词——抛出型
  // getter 或撤销代理按缺失（非瞬时），不在 catch 里把原错误换成 TypeError，
  // 硬化过的姊妹谓词（裁决码集合）才有机会跑
  const status = safeReadField(error, 'status');
  return typeof status === 'number' && TRANSIENT_STATUSES.has(status);
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
  // 门禁登记先查（round 23/MUST 6）：中继出口与折叠共用此判定——登记过的
  // 门禁载体就是门禁，无论其 code 视图当前如何（抛出型 getter / 撤销后变
  // 坏）。零读裁决，与折叠同一规则；exhaustion 登记不在此列（正常路径裁决）
  const refusal = refusalOf(error);
  if (refusal !== undefined) {
    // 种类对称（round 24/MUST 4）：门禁登记即门禁（零读）；仅耗尽登记的
    // 载体不是门禁——其自身字段读不可采信（中继出口此前照读，铸出门禁
    // 信封而每个 handler 出口都拒绝同载体）。与 versionGateResult 同规则
    return refusal.kinds.has('gate');
  }
  return canonCode(safeReadField(error, 'code')) === VERSION_GATE_CODE || isCodelessGateStatus(error);
}

/**
 * 无码 409 判定（round 6 去重、round 7 收口）：带 409 status 且无可用服务端
 * 码——body 读取中断 / 非 JSON 页 / 可读但 code 字段缺失或纯空白——即门禁。
 * 中断形态以 bodyUnreadable 标记为准：真实传输层中断（AbortController 的
 * DOMException）自带 code 属性（数值 20），不得以 code 是否存在裁决。
 */
function isCodelessGateStatus(error: unknown): boolean {
  // 三读全过安全卫队（round 13）：抛出型 getter 与撤销代理按缺失——
  // 缺失的 status 即非 409，不折叠也不引爆
  if (safeReadField(error, 'status') !== 409) return false;
  if (safeReadField(error, 'bodyUnreadable') === true) return true;
  return canonCode(safeReadField(error, 'code')) === '';
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
// 载体白名单（round 23/MUST 5，替 round 22 的黑名单）：只有真正的 Error
// （查找链可达 Error.prototype）就地装填——Map/Date/RegExp/Promise/WeakMap/
// Uint8Array/装箱原始值/数组/无原型对象/函数一律换盖戳新载体（此前黑名单
// 漏掉前六者：就地"装饰"交回无码非 Error，round 22 宣称关闭的类）。走查环
// 安全（visited 集合——getPrototypeOf 陷阱的 2-环既不抛也不终止）；走查
// 抛出（撤销代理）按非载体。谎报 null 原型（r3 形态）在链上看不到
// Error.prototype → 换新载体——继承访问器对无从隐藏
// 内建错误家族原型点名集（round 24/MUST 5）：Error.prototype/TypeError.
// prototype 等共享原型自身走查可达 Error.prototype（Error.prototype 第一层
// 即命中）——就地装填即进程级污染，此后每个 new Error() 都折家族信封。原生
// instanceof 不作判据：TypeError.prototype instanceof Error 实测为 true（其
// 原型即 Error.prototype，实例检查挡不住它），且 OrdinaryHasInstance 无界走
// 查、只靠 V8 内部 RangeError 兜底——铸造新代理的 getPrototypeOf 陷阱
// （MUST 1 的威胁类）的界不归本模块定。点名集是恒等比较零读零陷阱；用户子
// 类原型（MyErr.prototype）仍可达 Error.prototype 而被就地装填——其污染面
// 仅限调用方自己的类实例，非进程级，记录边界
const BUILTIN_ERROR_PROTOTYPES = new Set<unknown>([
  Error.prototype,
  TypeError.prototype,
  EvalError.prototype,
  RangeError.prototype,
  ReferenceError.prototype,
  SyntaxError.prototype,
  URIError.prototype,
  AggregateError.prototype,
]);

function isErrorCarrier(error: unknown): boolean {
  if (error === null) return false;
  if (typeof error !== 'object') return false;
  if (BUILTIN_ERROR_PROTOTYPES.has(error)) return false;
  try {
    let level: unknown = error;
    const visited = new Set<unknown>();
    // 跳数上界（round 24/MUST 1）：visited 只拦再访——每次铸造新代理的
    // getPrototypeOf 陷阱永不重复；1024 跳远超真实链深，超深同环按非载体
    let hops = 0;
    while (level !== null && level !== undefined) {
      if (visited.has(level) || ++hops > 1024) return false;
      visited.add(level);
      if (level === Error.prototype) return true;
      level = Object.getPrototypeOf(level);
    }
    return false;
  } catch {
    return false;
  }
}

export function applyVersionGate(error: unknown, payload: VersionGatePayload): Error {
  // 载体白名单预检（round 21 建非对象守卫、round 22 黑名单、round 23 白名
  // 单）：非 Error 形态（原始值/装箱/集合类/函数/谎报原型）一律换新载体：
  // 盖上家族码与兜底文案（decoratePlainCarrier 同款——无码新载体任何出口
  // 认不出门禁错误），再递归装填（新载体恒就地成功，不经拒绝/登记机制）
  if (!isErrorCarrier(error)) {
    const plain = new Error(VERSION_GATE_FALLBACK_MESSAGE) as Error & { code?: unknown };
    plain.code = VERSION_GATE_CODE;
    return applyVersionGate(plain, payload);
  }
  // round 6：版本字段与消息同过清洗口（cleanMessage）——纯不可见值视同缺失，
  // hint 不留不可见空位，兜底（未知/最新版）照常生效。
  // round 14：payload 读补齐 gateFoldPayload 的双卫队（round 12 回归类——
  // 安全读丢了字符串窄化，非字符串值在清洗口迭代时抛 TypeError）——
  // 安全读防抛出型 getter，窄化防非字符串值，缺一不可
  const rawClientVersion = safeReadField(payload, 'clientVersion');
  const rawMinVersion = safeReadField(payload, 'minVersion');
  const rawMessage = safeReadField(payload, 'message');
  const clientVersion = typeof rawClientVersion === 'string' ? cleanMessage(rawClientVersion) || undefined : undefined;
  const minVersion = typeof rawMinVersion === 'string' ? cleanMessage(rawMinVersion) || undefined : undefined;
  const message = typeof rawMessage === 'string' ? cleanMessage(rawMessage) || undefined : undefined;
  // 装填走 decorateInPlace 模式（round 15）：写口与读口同为门禁折叠的入口
  // ——拒绝装饰的载体（冻结/不可配置 getter；请求层自建载体恒可写，仅导出
  // 面可达）克隆后装填。返回值即生效载体——调用方抛它
  const fields: Array<[string, unknown]> = [
    ['clientVersion', clientVersion],
    ['minVersion', minVersion],
    [
      'remediation',
      {
        hint: `插件版本过旧（当前 ${clientVersion || '未知'}，需升级至正式版 ${minVersion || '最新版'} 及以上）：`,
        steps: [...UPGRADE_STEPS],
      },
    ],
  ];
  if (message) fields.push(['message', message]);
  if (decorateInPlace(error as Record<string, unknown>, fields, 'gate')) return error as Error;
  // 拒绝克隆按构造盖家族码+兜底文案（round 24/MUST 2）
  return cloneCarrier(error as object, fields, {
    code: VERSION_GATE_CODE,
    message: VERSION_GATE_FALLBACK_MESSAGE,
  });
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
  // 装填被拒的载体（round 19 建、round 20 收口裁决、round 22 身份先于读）：
  // 模块态登记按身份拒绝，版本字段/消息/remediation 全不信，铸未知版本信封
  // （码仍是服务端亲署——门禁判定不受拒绝影响）。round 23：此处为载荷铸造
  // 口（门禁判定已由调用方/检测器成立），不分种类一律铸拒绝信封
  if (refusalOf(error) !== undefined) {
    return {
      code: VERSION_GATE_CODE,
      message: VERSION_GATE_FALLBACK_MESSAGE,
      remediation: codelessGateFields().remediation,
    };
  }
  // 落定登记优先（round 24/MUST 3c）：门禁装填的落定记录——经 [[Get]] 重读
  // 会翻供，按记录的设计字段铸载荷；记录未含的字段（亲署消息/remediation
  // 不经装饰）回退自有数据描述符读（ownDataValue）。载荷形态与通用分支同
  // （ok 与转向字段由 versionGateResult 的外壳补齐）
  if (provenKindIs(error, 'gate')) {
    const rawCv = provenField(error, 'clientVersion');
    const rawMv = provenField(error, 'minVersion');
    const clientVersion = typeof rawCv === 'string' ? cleanMessage(rawCv) || undefined : undefined;
    const minVersion = typeof rawMv === 'string' ? cleanMessage(rawMv) || undefined : undefined;
    const rawRem = provenField(error, 'remediation') ?? ownDataValue(error, 'remediation');
    const remediation = serializableRemediation(rawRem);
    const rawMessage = provenField(error, 'message') ?? ownDataValue(error, 'message');
    const message = cleanMessage(typeof rawMessage === 'string' ? rawMessage : '') || VERSION_GATE_FALLBACK_MESSAGE;
    return {
      code: VERSION_GATE_CODE,
      message,
      remediation: remediation ?? codelessGateFields().remediation,
      ...(clientVersion ? { clientVersion } : {}),
      ...(minVersion ? { minVersion } : {}),
    };
  }
  const rawCode = safeReadField(error, 'code');
  if (canonCode(rawCode) === VERSION_GATE_CODE) {
    // 字符串收窄恢复（round 13）：安全读只防抛出，非字符串值（数字/对象）
    // 仍需窄化后再进清洗口——cleanMessage 会迭代输入
    const rawClientVersion = safeReadField(error, 'clientVersion');
    const rawMinVersion = safeReadField(error, 'minVersion');
    const clientVersion =
      typeof rawClientVersion === 'string' ? cleanMessage(rawClientVersion) || undefined : undefined;
    const minVersion = typeof rawMinVersion === 'string' ? cleanMessage(rawMinVersion) || undefined : undefined;
    // remediation 深验（round 16 建、round 17 修嵌套上下文+快照往返、
    // round 18 快照形态窄化）：嵌套 BigInt/循环引用/判别器/有状态换值/
    // 非对象 JSON 视图同样兜底，共用 serializableRemediation
    const remediation = serializableRemediation(safeReadField(error, 'remediation'));
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
  // 身份先于一切读取（round 22/MUST 4）、按种类裁决（round 23/SHOULD 7）：
  // gate 登记零读铸门禁未知信封——exhaustion 登记不是门禁（其结构化信封属
  // 耗尽折叠，由克隆承载），返回 undefined 交还调用方；此前不分种类，耗尽
  // 登记也铸门禁信封——错误标签的 remediation 混用
  const refusal = refusalOf(error);
  if (refusal !== undefined) {
    if (refusal.kinds.has('gate')) return registeredGateEnvelope();
    return undefined;
  }
  if (!isVersionGateError(error)) return undefined;
  // round 12：字段读安全化（抛出型 getter 按缺失）；retryAfter 窄化到字符串
  // （round 16）——BigInt 等非字符串值不骑信封（MCP 序列化边界）
  const rawRetryAfter = safeReadField(error, 'retryAfter');
  const retryAfter = typeof rawRetryAfter === 'string' ? rawRetryAfter : undefined;
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
export function safeReadField(target: unknown, key: string): unknown {
  try {
    return (target as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

export function safeMessageText(err: unknown): string {
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
// 字符（内部与边缘一视同仁）。服务端亲署业务码不含空白渲染字符；织入与边缘
// 垫入的拼写与干净拼写同码。已知边界（round 12 台账，round 14 注释对齐）：
// 空白顶替下划线的业务码拼写不在此列——剔除不能凭空造出下划线
// （'HDKIT\u00a0QUOTA_EXCEEDED' 不会规范成 'HDKIT_QUOTA_EXCEEDED'），该拼写
// 同样绝非服务端亲署，按未知码处理；伪造 HTTP 家族不受影响（家族判定下划线
// 可选，分隔符替换照旧命中）。非字符串值归 ''（无码）。
export function canonCode(code: unknown): string {
  return typeof code === 'string' ? blankCharsRemoved(code) : '';
}

// remediation 的深序列化验证（round 16 建、round 17 修上下文与快照、
// round 18 快照形态窄化、round 19/20 可用引导判定、round 21 全字符串步骤）：
// 窄化只看第一层——嵌套
// BigInt/循环引用在 MCP 序列化边界照样炸，故按边界形态深验。round 17：①
// 验证必须在嵌套上下文——边界按信封键 'remediation' 序列化，JSON.stringify
// 把属性键传给 toJSON，顶层验证时 toJSON 收到 ''——无状态判别器（toJSON
// 看 key 分叉）可在顶层过关并在真实边界引爆（实测经真实 registerTool 链
// 端到端复现）；② 信封搭载的必须是验证过的字节，不是活引用——有状态
// getter（验证读数良性、后续读数炸）无从换值。往返快照一次解决两类：
// stringify({ remediation: raw }) 即边界形态，JSON.parse 取回纯数据快照。
// round 18：非对象/数组视图拒绝（toJSON 可在 remediation 键下呈现 0/''/
// null/[]）。round 19：记录形态过关还需可用——hint 非空白字符串且 steps
// 数组，{} 与字段敌意记录一律拒绝。折叠是错误路径上的一次调用，往返成本
// 可忽略
export function serializableRemediation(raw: unknown): { hint: string; steps: string[] } | undefined {
  if (raw === null || typeof raw !== 'object') return undefined;
  try {
    const verified = JSON.stringify({ remediation: raw });
    const snapshot = JSON.parse(verified) as { remediation?: unknown };
    // 快照形态与可用引导窄化（round 18 形态、round 19/20/21 可用性）：toJSON
    // 在 remediation 键下可呈现任意 JSON 值——非对象（0/''/null）与数组不是
    // 引导记录（round 18）；记录形态过关还不够——{} 骑上即零引导（round
    // 19），steps 只查 Array.isArray 会让空数组、非字符串元素、全空白串照骑
    // （round 20），非字符串元素在 string[] 断言下说谎（round 21）。可用判
    // 定：hint 非空白字符串，steps 全字符串且至少一个非空白（设计铸造带三
    // 条，少于此不如铸造）；字段验证、整体原样随信封（round 17 的字节往返
    // 不变式：服务端多余键如 traceId 原样保留）。
    // 拒绝时门禁与耗尽两折叠口的设计引导铸造兜底——handler/voucher 信封
    // 有意省略（无设计引导可铸）
    const parsed = snapshot.remediation;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const shaped = parsed as { hint?: unknown; steps?: unknown };
    if (typeof shaped.hint !== 'string' || rendersBlank(shaped.hint) || !Array.isArray(shaped.steps)) {
      return undefined;
    }
    if (!shaped.steps.every((step) => typeof step === 'string')) return undefined;
    if (!shaped.steps.some((step) => !rendersBlank(step))) return undefined;
    return parsed as { hint: string; steps: string[] };
  } catch {
    return undefined;
  }
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
  // 下划线不是字面量而是分隔符位（round 13）：分隔符位接受下划线或任意
  // 空白渲染字符——空白顶替下划线（HTTP\u00a0502 对 HTTP_502）与镜像
  // （HTTP_502 对 HTTP\u00a0502 码）两个方向都命中；其余字符间同样可夹
  // 空白。拼写里的下划线并入分隔符位（删除后以 SEP_STAR 连接）。
  const significant = [...spelling].filter((ch) => ch !== '_');
  if (significant.length === 0) return undefined;
  const body = significant.map((ch) => ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join(SEP_STAR);
  return new RegExp(`^${SEP_STAR}${body}${SEP_STAR}:`, 'u');
}

const SEP_STAR = `[\\s\\p{Default_Ignorable_Code_Point}\\p{Cc}\u{FFF9}-\u{FFFB}\u{13430}-\u{1343F}\u2800_]*`;

// 装填辅助（round 9 收口、round 10 回滚）：普通赋值失败（getter-only 原型
// 访问器，如 DOMException.code）用 defineProperty 落 own 属性；载体整体拒绝
// 装饰（冻结对象、不可配置的 own getter）时回滚已写字段后返回 false——由
// 调用方走克隆分支，丢弃的原对象不得带半截装饰（gatewayRetryExhausted 已
// 落而 code 未换，会把传输码 20 折叠出去）。
function decorateInPlace(
  target: Record<string, unknown>,
  fields: Array<[string, unknown]>,
  kind?: RefusalKind,
): boolean {
  const applied: Array<string> = [];
  // 快照改走 own 描述符（round 16）：has/get 都过代理陷阱——撒谎的 has+get
  // 视图让"恢复"变成重新种标记或用谎言覆盖原码（round-15 只关了被拒键，
  // applied 键的快照读仍信敌意视图）。getOwnPropertyDescriptor 的默认陷阱
  // 透出目标的真实自有属性状态，撒谎 has+get 家族污染不了快照；描述符读
  // 抛出按无描述符处理（删除兜底）。残留边界：连 gOPD 陷阱一并撒谎的代理
  // 能骗过任何客户端方案——导出面防御的记录边界
  const snapshots = new Map<string, PropertyDescriptor | undefined>();
  const writtenValues = new Map<string | symbol, unknown>();
  for (const [key, value] of fields) {
    writtenValues.set(key, value);
    let prior: PropertyDescriptor | undefined;
    try {
      prior = Object.getOwnPropertyDescriptor(target, key);
    } catch {
      prior = undefined;
    }
    snapshots.set(key, prior);
    // 免除空写（round 24/MUST 3a 配套）：装饰值与自有数据现状相等时跳过写
    // 入——装饰器有意的同值写（消息原样保留、请求层预写的 connectRetries）
    // 在"预存等值不算落定"下会整族拒绝诚实载体；跳过即视为落定（值已在位
    // 即本轮目标达成），且不触发 [[Set]]/[[Get]]（敌意面更小）。谎报 gOPD 的
    // 幻影等值在落定证明的写前快照对照处仍有拦截（两读分歧即写未落）
    try {
      const current = Object.getOwnPropertyDescriptor(target, key);
      if (current !== undefined && current.get === undefined && current.set === undefined && current.value === value) {
        applied.push(key);
        continue;
      }
    } catch {
      // 敌意 gOPD——按现状未知处理，走正常写入路径
    }
    let wrote = false;
    try {
      target[key] = value;
      wrote = true;
    } catch {
      try {
        Object.defineProperty(target, key, { value, writable: true, configurable: true });
        wrote = true;
      } catch {
        // 两条写入路径都抛出——写入可能已物理落地（先转发后抛的陷阱，
        // round 15），拒绝由回滚的尽力删除兜底，走克隆分支
      }
    }
    // 写后回读（round 13）：陷阱代理的 [[Set]] 可既不抛也不落——回读不等
    // 即视为拒绝，走克隆分支；回读本身抛出同样视为未落。回读也探测先转发
    // 后抛的陷阱（round 15）：写入落地而回读抛出 → 拒绝 → 被拒键删除
    let landed = false;
    if (wrote) {
      try {
        landed = target[key] === value;
      } catch {
        landed = false;
      }
      // 落定证明（round 23 建、round 24/MUST 3 收紧到自有+本轮写入）：读回
      // 是一次敌意读——读回匹配后要求该键有值为装饰值的自有数据描述符，且
      // 由本轮写入创建（写前快照同值即预存等值，写未落）；继承定义不算
      // （吞写载体靠原型持有装饰值通过——原件交回、折叠直出原型信封）。自
      // 有访问器不在此否决：写经其 setter、值或真存或谎，访问器始终立着随
      // 时翻供——留给循环后的访问器立着判定（round 21），其登记+克隆路径
      // 不删键不回滚（回滚的尽力删除会摧毁载体自己的访问器、判空存活、丢
      // 掉挣得登记）。无自有等值数据描述符即写未落（round 13 契约）→ 拒
      // 绝 → 克隆；gOPD 陷阱伪造幽灵数据描述符（全陷阱谎者）在已记录边界
      // 内
      if (landed) {
        try {
          const desc = Object.getOwnPropertyDescriptor(target, key);
          if (desc === undefined) {
            landed = false;
          } else if (desc.get === undefined && desc.set === undefined) {
            const priorDesc = snapshots.get(key);
            landed =
              desc.value === value &&
              !(
                priorDesc !== undefined &&
                priorDesc.get === undefined &&
                priorDesc.set === undefined &&
                priorDesc.value === value
              );
          }
        } catch {
          landed = false;
        }
      }
    }
    if (!landed) {
      // 被拒键的回滚绝不信敌意视图（round 15）：`wrote` 布尔不可信——陷阱可
      // 先转发后抛（写入物理落地而 wrote=false，round-14 的 wrote 门把被拒键
      // 漏出清单）。被拒键一律尽力删除（round 16 注释如实化，round 17 移至
      // 其真实路径：吞写陷阱在此落点——写入被吞、回读读回目标真值，删除并
      // 非空操作，会摧毁目标的完好原值（如预存 code 20）；原值风险换残留风
      // 险，折叠以标记为触发、两端都不折叠，载体本被丢弃；删除被拒亦尽力而
      // 为——冻结/不可配置键的删除抛出即被吞）
      try {
        delete target[key];
      } catch {
        // 尽力而为
      }
      // applied 键的恢复同样不信视图（round 16）：按描述符快照恢复——有
      // 描述符走 defineProperty（恢复访问器/不可枚举形态），无描述符删除。
      // 描述符快照经 gOPD 陷阱读，撒谎的 has+get 不再污染恢复；恢复被拒亦
      // 尽力而为
      for (const done of applied) {
        const snap = snapshots.get(done);
        try {
          if (snap) Object.defineProperty(target, done, snap);
          else delete target[done];
        } catch {
          // 还原亦被拒（被丢弃的原对象，尽力而为）
        }
      }
      // 回滚验证与中和（round 17 建、round 18 补读回验证）：删除/恢复都可能
      // 被拒或被谎——不可配置落盘（plain class 的原型 setter 落 own 属性后
      // 封壳，删除与恢复双双静默失败）、撒谎 deleteProperty（报成功不删
      // 除）、谎言 set（接受写入但存回装饰值——赋值"成功"而标记存活）。
      // 逐键回读：装饰值仍在则中和——先赋值（有快照恢复快照值，否则
      // undefined），赋值后回读验证（装饰写自 round 13 起的读回纪律，中和
      // 写 round 18 起同律）；读回仍是装饰值则走 defineProperty 臂——把可
      // 配置的访问器整体替换为数据属性（恢复臂的同款能力）；再失败即
      // round-17 记录边界：全写路径封死的载体无客户端方案可移除，载体本
      // 被丢弃，台账记录。undefined 装饰值跳过——空值点不燃任何折叠触发
      let poisoned = false;
      const poisonedKeys = new Set<string | symbol>();
      for (const done of [...applied, key]) {
        const written = writtenValues.get(done);
        // 判定无条件跑（round 21/MUST 2）：written === undefined 的跳过让省
        // 略字段的存活访问器既不判定也不登记——丢弃载体折叠谎言（minVersion:
        // 9.9.9-lie）。存活语义按写入值细化：undefined 装饰下只有访问器算存活
        // （数据值恒等 undefined 是写入本身，非谎言，无从翻供）；defined 装饰
        // 下访问器或数据值仍是装饰值即存活。中和臂保持值门控（round 21 裁定）
        const survivesByDescriptor = (): boolean => {
          try {
            const desc = Object.getOwnPropertyDescriptor(target, done);
            if (desc && (desc.get !== undefined || desc.set !== undefined)) return true;
            if (desc) return written !== undefined && desc.value === written;
            // 无自有描述符：首个定义该键的层级定夺（round 22/MUST 1）——原型
            // 访问器可翻供，视为立着；全链无定义时 undefined 装饰无物存活，
            // defined 装饰读一次（无落点可翻供）
            if (chainAccessorStanding(target, done)) return true;
            if (written === undefined) return false;
            try {
              return target[done] === written;
            } catch {
              return false;
            }
          } catch {
            return true;
          }
        };
        if (!survivesByDescriptor()) continue;
        if (written === undefined) {
          // undefined 装饰无值可中和——判定已跑、访问器存活即登记
          poisoned = true;
          poisonedKeys.add(done);
          continue;
        }
        const snap = snapshots.get(done);
        const neutral: unknown = snap && snap.value !== undefined ? snap.value : undefined;
        let neutralized = false;
        try {
          target[done] = neutral;
          try {
            neutralized = target[done] !== written;
          } catch {
            // 读回抛出——视为未中和，走 defineProperty 臂
          }
        } catch {
          // 赋值被拒——视为未中和，走 defineProperty 臂
        }
        if (!neutralized) {
          try {
            Object.defineProperty(target, done, { value: neutral, writable: true, configurable: true });
          } catch {
            // 赋值与 defineProperty 双双被拒——交给重判
          }
        }
        // 中和尝试后再判（round 20）：延迟谎言在中和读回时奉上中性值、
        // 陷阱 defineProperty 报成功不落——重判描述符定夺，读数不作数
        if (survivesByDescriptor()) {
          poisoned = true;
          poisonedKeys.add(done);
        }
      }
      if (poisoned && kind !== undefined) {
        // 登记挣得键与种类（round 22/MUST 2、round 23 并存）：同种类合并键
        // 集、跨种类并入 kinds。诊断字段尽力而为（round 20 降级）——此写仅
        // 观测，吞写/谎报不影响裁决；双双被拒即 round-17 记录边界
        registerRefusal(target, kind, poisonedKeys);
        try {
          target[DECORATION_REFUSED_FIELD] = true;
        } catch {
          try {
            Object.defineProperty(target, DECORATION_REFUSED_FIELD, {
              value: true,
              writable: true,
              configurable: true,
            });
          } catch {
            // 记录边界
          }
        }
      }
      return false;
    }
    applied.push(key);
  }
  // 落定键的描述符判定（round 21/MUST 4）：合作一次的访问器（回读通过、就地
  // 装填"成功"）折叠时翻供——落定键也要过判定，访问器仍立着 → 走克隆，
  // 克隆的设计值折叠（信封不再自相矛盾：hint 一版、字段读谎言）。原对象同
  // 时登记：立着的访问器随时可翻供，丢弃载体的任何陈述不可信——与拒绝路径
  // 的存活登记同一doctrine
  const accessorKeys = new Set<string | symbol>();
  for (const done of applied) {
    // 链上访问器判定（round 22/MUST 1）：gOPD 只看自有属性——原型
    // getter/setter 对此前溜过落定键判定，就地"成功"交回原件，折叠时翻供
    if (chainAccessorStanding(target, done)) accessorKeys.add(done);
  }
  if (accessorKeys.size > 0) {
    if (kind !== undefined) {
      registerRefusal(target, kind, accessorKeys);
    }
    try {
      target[DECORATION_REFUSED_FIELD] = true;
    } catch {
      // 诊断字段尽力而为——登记在模块态
    }
    return false;
  }
  // 有范围的解除（round 22/MUST 2、round 23 种类并存，替 round 21 的无记
  // 忆整体解除）：解除只在唯一种类（本装饰器）且挣得键全部在本轮落定验证
  // 时发生——无关字段的再装饰（如无 message 的门禁装填触碰不到 message
  // 挣得键）、跨装饰器拼写、以及种类并存的载体（另一装饰器也拒绝过）一律
  // 保持登记——并存种类解除会裸露另一方的立着访问器。保持登记的载体走克
  // 隆（return false）——把原件交回会按身份拒绝，结构化信封在 connect 出口
  // 全失（round 20 的错）。访问器挣得的拒绝永不解除：立着的访问器可在任何
  // 后续读翻供，与拒绝路径同一 doctrine——解除只对数据值存活（中和失败的
  // 落盘值）可达，其再装饰经同键落定验证即解除
  const prior = refusalOf(target);
  if (prior !== undefined) {
    const liftFires =
      prior.kinds.size === 1 &&
      kind !== undefined &&
      prior.kinds.has(kind) &&
      [...(prior.keysByKind.get(kind) ?? [])].every((k) => applied.includes(k as string));
    if (!liftFires) return false;
    refusedCarriers.delete(target);
    try {
      delete target[DECORATION_REFUSED_FIELD];
    } catch {
      // 尽力而为——被拒的字段不阻塞成功路径
    }
  }
  recordProvenLanding(target, fields, kind);
  return true;
}

// 耗尽引导的统一铸造（round 17）：装饰两处（就地/纯载体）与折叠口共三处
// 铸造同一文案——深验拒绝敌意 remediation 时，折叠口绝不丢弃（信封指引不
// 得少于空载体；round-16 的丢弃行为按 round-17 MUST 4 修为铸造）。次数已知
// 时文案与装饰逐字一致；无次数（导出面裸载体）省略次数短句
export function designedTransientRemediation(retries: number | undefined): {
  hint: string;
  steps: string[];
} {
  return {
    hint: `${retries !== undefined ? `连接已自动重试 ${retries} 次仍失败，` : ''}连续遭遇网关 502/504 超时（瞬时故障，非沙箱创建失败）：`,
    steps: [
      '服务端可能已创建/启动沙箱实例——再次 connect 同池实例会自动复用，通常直接成功',
      '稍后重试 connect；网关超时通常在数分钟内自愈',
      '多次重试仍失败时，检查本地网络或代理配置后再试',
    ],
  };
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
  // 载体白名单（round 11 非对象守卫、round 23/MUST 5 白名单）：只有真正的
  // Error 就地装填——Map/Date/RegExp/Promise/WeakMap/Uint8Array/函数等对象
  // 样非载体此前就地"装饰"交回无码非 Error；纯载体盖家族码（decoratePlainCarrier）
  if (!isErrorCarrier(error)) {
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
    // 形态不敏感兜底（round 13）：下划线与空白在两侧都可互换——剥完仍以
    // 制造拼写开头（含"消息=码"形态）按去下划线的规范形态比较
    const formFree = (text: string) => canonCode(text).replaceAll('_', '');
    const opensWithSpelling = spelling !== '' && formFree(cleaned).startsWith(formFree(spelling));
    fields.push(['message', cleaned === '' || opensWithSpelling ? designedCopy : cleaned]);
  } else if (canonCode(effectiveCode) === 'HDKIT_GATEWAY_TIMEOUT' && !cleanMessage(rawMessage)) {
    fields.push(['message', designedCopy]);
  }
  if (!rawRemediation) {
    fields.push(['remediation', designedTransientRemediation(retries)]);
  }
  const decorateTarget = err as unknown as Record<string, unknown>;
  if (decorateInPlace(decorateTarget, fields, 'exhaustion')) return error;
  // 拒绝克隆按构造盖家族码+设计文案（round 24/MUST 2）
  return cloneCarrier(err, fields, { code: 'HDKIT_GATEWAY_TIMEOUT', message: designedCopy });
}

// 非对象载体的装填（round 11）：无字段可读——码/消息/remediation 全走设计值
function decoratePlainCarrier(retries: number): Error {
  const plain = new Error(`hdkitservice 连续遭遇网关 502/504 超时（已自动重试 ${retries} 次）`);
  const fields: Array<[string, unknown]> = [
    ['gatewayRetryExhausted', true],
    ['connectRetries', retries],
    ['code', 'HDKIT_GATEWAY_TIMEOUT'],
    ['remediation', designedTransientRemediation(retries)],
  ];
  decorateInPlace(plain as unknown as Record<string, unknown>, fields);
  return plain;
}

// 拒绝装饰载体的克隆（round 10）：own 字段按属性描述符复制（Object.assign
// 会丢不可枚举业务字段，[[Get]] 读法会引爆抛出型 getter），message/stack 与
// 被装饰键除外——装饰键由 fields 落值；message 安全读取，读失败按缺失处理。
function cloneCarrier(
  err: object,
  fields: Array<[string, unknown]>,
  designed: { code: string; message: string },
): Error {
  // 拒绝源只携带设计字段（round 24/MUST 2，替 round 23 的登记重推导）：两
  // 调用点均拒绝路径（decorateInPlace 返回 false 后才到达）——未登记的拒绝
  // （冻结/不可写差值/中和失败）同样拒绝，登记查询会漏掉它们。code/
  // remediation/message/retryAfter/coreHours/clientVersion/minVersion 一律
  // 不从源种子（门禁克隆被延迟谎 code 误路由成升级指令、伪造 remediation 骑
  // 指令面）；家族码+设计文案由 designed 对按构造盖戳——克隆恒折叠设计信封
  const clone = new Error(designed.message);
  const decoratedKeys = new Set<string | symbol>(fields.map(([key]) => key));
  try {
    for (const key of Reflect.ownKeys(err)) {
      if (
        key === 'retryAfter' ||
        key === 'coreHoursExhausted' ||
        key === 'code' ||
        key === 'remediation' ||
        key === 'message' ||
        key === 'clientVersion' ||
        key === 'minVersion'
      ) {
        continue;
      }
      // 字符串与符号键都按描述符复制（round 11：符号键是业务字段），message/
      // stack、被装饰键、毒标字段除外——装饰键由 fields 落值；毒标属于丢弃
      // 载体（round 20）：有效载体是调用方要抛的，生而干净——泄过去即耗尽
      // 克隆折叠 undefined、门禁克隆退化未知版本
      if (key === 'message' || key === 'stack' || decoratedKeys.has(key)) continue;
      if (key === DECORATION_REFUSED_FIELD) continue;
      const desc = Object.getOwnPropertyDescriptor(err, key);
      if (!desc) continue;
      // 访问器按复制时取值快照（round 20）：重发布丢弃载体的活访问器会让装
      // 饰后的翻供骑过有效载体；读取抛出按缺失跳过
      if (desc.get !== undefined || desc.set !== undefined) {
        let snapshotValue: unknown;
        try {
          snapshotValue = (err as Record<string | symbol, unknown>)[key];
        } catch {
          continue;
        }
        Object.defineProperty(clone, key, {
          value: snapshotValue,
          writable: true,
          enumerable: desc.enumerable,
          configurable: true,
        });
        continue;
      }
      Object.defineProperty(clone, key, desc);
    }
  } catch {
    // 撤销/陷阱代理（round 12）：枚举即抛——按无携带字段处理，设计值兜底
  }
  // 拒绝源的字段过滤（round 24/MUST 2 尾）：message 字段在拒绝前从源读出
  // （耗尽 replaceCode 分支）——敌意读的产物不装填；设计文案接管
  const effectiveFields = fields.filter(([key]) => key !== 'message');
  decorateInPlace(clone as unknown as Record<string, unknown>, effectiveFields);
  // 家族码+设计文案无条件盖戳（round 24/MUST 2）：[[Get]] 预检会读进被污染
  // 的继承视图；装饰字段若已写入同值，覆盖亦同值无副作用
  const stamped = clone as Error & { code?: unknown; message?: unknown };
  stamped.code = designed.code;
  stamped.message = designed.message;
  return stamped;
}

/**
 * connect 出口的耗尽折叠（v2 扩展；dev 在此路径裸抛）：带 gatewayRetryExhausted
 * 标记的错误转 ok:false 结构化返回，remediation 与尝试次数穿透 MCP 边界。
 */
export function transientExhaustionResult(error: unknown): Record<string, unknown> | undefined {
  // 身份先于一切读取（round 19 建、round 22 排序收口）：登记拒绝的载体
  // 不在此折叠——丢弃载体上的任何陈述都不可信，零读拒绝。
  // 落定登记优先（round 24/MUST 3c）：经 [[Get]] 重读会翻供/删除——按记
  // 录的设计字段铸信封，零载体读
  if (refusalOf(error) !== undefined) return undefined;
  if (provenKindIs(error, 'exhaustion')) {
    const marker = provenField(error, 'gatewayRetryExhausted');
    if (marker !== true) return undefined;
    // 记录未含的字段（服务端亲署码/消息/转向字段不经装饰）回退到自有数据
    // 描述符读（ownDataValue）——亲署码与消息保留（round-24 授权行）；窄化
    // 与通用分支同口径（round 16/18/19）
    const rawCode = provenField(error, 'code') ?? ownDataValue(error, 'code');
    const rawRetries = provenField(error, 'connectRetries') ?? ownDataValue(error, 'connectRetries');
    const rawRetryAfter = provenField(error, 'retryAfter') ?? ownDataValue(error, 'retryAfter');
    const rawCore = provenField(error, 'coreHoursExhausted') ?? ownDataValue(error, 'coreHoursExhausted');
    const rawRemediation = provenField(error, 'remediation') ?? ownDataValue(error, 'remediation');
    const remediation = serializableRemediation(rawRemediation);
    const connectRetries =
      typeof rawRetries === 'number' && Number.isSafeInteger(rawRetries) && rawRetries >= 0 ? rawRetries : undefined;
    const rawMessage = provenField(error, 'message') ?? ownDataValue(error, 'message');
    return {
      ok: false,
      ...(typeof rawCode === 'string' ? { code: rawCode } : {}),
      message: cleanMessage(typeof rawMessage === 'string' ? rawMessage : '') || 'connect 持续遭遇网关 502/504 超时',
      ...(connectRetries !== undefined ? { connectRetries } : {}),
      ...(rawCore ? { coreHoursExhausted: true } : {}),
      ...(typeof rawRetryAfter === 'string' ? { retryAfter: rawRetryAfter } : {}),
      remediation: remediation ?? designedTransientRemediation(connectRetries),
    };
  }
  // round 12：全部字段过安全读——抛出型 getter 按缺失，标记缺失即不折叠。
  // round 16：presence-gate 之上再窄化——code 窄到字符串、connectRetries 窄到
  // 数字、retryAfter 窄到字符串、remediation 深验（serializableRemediation），
  // BigInt 等敌意值不骑信封（MCP 序列化边界，round-15 窄化漏了的最后一个折叠口）
  const gatewayRetryExhausted = safeReadField(error, 'gatewayRetryExhausted');
  if (gatewayRetryExhausted !== true) return undefined;
  const coreHoursExhausted = safeReadField(error, 'coreHoursExhausted');
  const rawRetryAfter = safeReadField(error, 'retryAfter');
  const retryAfter = typeof rawRetryAfter === 'string' ? rawRetryAfter : undefined;
  const rawCode = safeReadField(error, 'code');
  const code = typeof rawCode === 'string' ? rawCode : undefined;
  const rawRetries = safeReadField(error, 'connectRetries');
  // 非负整数窄化（round 18 有限数、round 19 细则）：NaN/Infinity 骑上信封
  // 序列化成 null，负数/分数渲染"重试 -5 次/2.5 次"——均不是次数；缺省时
  // 铸造文案省略次数短句
  const connectRetries =
    typeof rawRetries === 'number' && Number.isSafeInteger(rawRetries) && rawRetries >= 0 ? rawRetries : undefined;
  // remediation 深验拒绝即铸造（round 17 / MUST 4）：耗尽信封的指引不得少于
  // 空载体——丢弃敌意值换来"零引导"是倒退；设计瞬时文案统一铸造
  const remediation =
    serializableRemediation(safeReadField(error, 'remediation')) ?? designedTransientRemediation(connectRetries);
  return {
    ok: false,
    ...(code !== undefined ? { code } : {}),
    // round 6：耗尽出口的消息读同样过清洗口——纯不可见原因不渲染成不可见文案
    message: cleanMessage(safeMessageText(error)) || 'connect 持续遭遇网关 502/504 超时',
    ...(connectRetries !== undefined ? { connectRetries } : {}),
    ...(coreHoursExhausted ? { coreHoursExhausted: true } : {}),
    ...(retryAfter ? { retryAfter } : {}),
    remediation,
  };
}
