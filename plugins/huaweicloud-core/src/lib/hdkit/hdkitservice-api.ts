import { fetchWithProxy } from '../../proxy/proxy-agent.ts';
import { cacheUserHash } from '../../telemetry/telemetry.ts';
import { detectAgent } from '../../telemetry/agent-detect.ts';
import { readInstalledVersion } from '../../update-check.ts';
import { getCredentials } from './hwlink-api.ts';
import { pinnedTemplateFor } from './sandbox-pool.ts';
import {
  VERSION_GATE_CODE,
  applyVersionGate,
  canonCode,
  cleanMessage,
  connectRetryDelaysMs,
  decorateExhaustedConnect,
  gateFoldPayload,
  isErrorCarrier,
  isGatewayTransient,
  isNonRetryableBusinessError,
  isVersionGateError,
  safeMessageText,
  safeReadField,
  serializableRemediation,
} from './hdkit-gate.ts';
import { asRecord } from '../as-record.ts';
import { asString, asText } from '../as-text.ts';

export interface HdkitError extends Error {
  code?: string;
  status?: number;
  traceId?: unknown;
  remediation?: { hint: string; steps: string[] };
  retryAfter?: string;
  coreHoursExhausted?: boolean;
  clientVersion?: string;
  minVersion?: string;
}

// Structural surface shared by the global and undici Response implementations;
// only ok/status/text/headers.get are consumed below.
interface HttpResponseLike {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  headers: { get(name: string): string | null };
}

function getHdkitBaseUrl(): string {
  return process.env.HDKITSERVICE_ENDPOINT || 'https://devkit.huaweicloud.com/rest/developer/server/hdkitservice/';
}

// resp 接缝的安全读（round 17 建、round 18 补有限数窄化）：敌意响应对象
// 的 status/ok/headers.get 都是 getter——裸读在各分支里把设计信封换成
// TypeError。三读全部带卫队与窄化：status 只在有限数字时携带，ok 只在真
// 布尔时按真处理（缺读按非 ok——不可确认的成功不是成功），Retry-After
// 只在头读返回字符串时携带
function safeRespStatus(resp: unknown): number | undefined {
  const status = safeReadField(resp, 'status');
  // 合法状态窄化（round 18 有限数、round 19 细则）：NaN/Infinity 之外，
  // -1/-0/502.5 这类有限数也非服务器可签的状态——携带会伪造 HTTP_-1/
  // HTTP_502.5 伪码；只有 100–599 的整数携带（其余按缺读：渲染"未知"、
  // 无码可制造、不作瞬时判定输入）
  return typeof status === 'number' && Number.isSafeInteger(status) && status >= 100 && status <= 599
    ? status
    : undefined;
}

function safeRespOk(resp: unknown): boolean {
  return safeReadField(resp, 'ok') === true;
}

function safeRetryAfterHeader(resp: unknown): string | undefined {
  try {
    const headers = safeReadField(resp, 'headers');
    if (headers !== null && typeof headers === 'object') {
      const read = safeReadField(headers, 'get');
      if (typeof read === 'function') {
        const value = (read as (name: string) => unknown).call(headers, 'Retry-After');
        return typeof value === 'string' ? value : undefined;
      }
    }
  } catch {
    // 敌意头对象按缺失
  }
  return undefined;
}

// 传输层拒绝的统一包装（round 7 响应体 + round 8 fetch 层）：从清洗值构建
// 抛出错误——空白/纯不可见原因落设计文案，真文本原样透传；原对象（含传输
// 层自带的 code 属性，如 AbortError DOMException 的数值 20）不透传；
// bodyUnreadable 标记供门禁折叠区分传输形态与服务端话术。
// round 15 起来因形态也不可信：instanceof 在撤销代理上抛（[[GetPrototypeOf]]
// 陷阱），message 读在抛出型 getter 上抛——包装口全部的意义就是不信任来因。
// 原型检查与消息读都带防护，任一被拒按缺失（兜底文案）
function transportReason(error: unknown, fallback: string): Error {
  let reason = '';
  try {
    // 有界 Error 判定（round 25/SHOULD 6）：instanceof 的 OrdinaryHasInstance
    // 无界走查——本模块唯一未设跳数的链走（实测 V8 内部 RangeError 兜底
    // 87ms/111MB，界不归本模块定）；换 isErrorCarrier（visited+1024 跳，
    // 与门禁走查同界），铸造陷阱毫秒级返回
    if (isErrorCarrier(error)) {
      const raw = (error as { message?: unknown }).message;
      if (typeof raw === 'string') reason = raw;
    } else if (typeof error === 'string') {
      reason = error;
    }
  } catch {
    reason = '';
  }
  return Object.assign(new Error(cleanMessage(reason) || fallback), { bodyUnreadable: true });
}

async function hdkitRequest(
  method: string,
  path: string,
  body: unknown,
  timeoutMs = 300000,
): Promise<Record<string, unknown> | unknown[]> {
  const { ak, sk, securitytoken } = getCredentials();

  if (!ak || !sk) {
    throw new Error(
      'Huawei Cloud credentials are not configured. ' +
        'Run "npx huaweicloud-devkit auth init" or set HW_ACCESS_KEY/HW_SECRET_KEY.',
    );
  }
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-HW-AK': ak,
    'X-HW-SK': sk,
    'X-HW-Client-Version': readInstalledVersion() || '0.0.0',
    // #1040: 对外请求统一携带 X-HW-Agent（值=detectAgent 结果 harness，
    // 'unknown' 兜底——探针类 clientName 不再透传）。
    'X-HW-Agent': detectAgent().harness,
  };
  if (securitytoken) {
    headers['X-HW-Security-Token'] = securitytoken;
  }

  const url = `${getHdkitBaseUrl()}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  // fetch 层中断（round 8，v2 标注分歧——dev 裸抛）：30s/300s 定时器的
  // AbortError DOMException 携传输层 code 20，此前无响应可包——原对象从每个
  // hdkit 出口裸抛。与响应体中断同缝守卫：从清洗值构建抛出错误，标记
  // bodyUnreadable、不带 status（无响应即无网关信号，不重试、不门禁）。
  let resp: HttpResponseLike;
  try {
    resp = await fetchWithProxy(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (error) {
    throw transportReason(error, 'hdkitservice request failed (no response)');
  } finally {
    clearTimeout(timer);
  }

  // 响应体读取中断同样携带 resp.status（round 4，v2 标注分歧——dev 裸抛）：
  // 已收到 502/504 status 时重试契约照常适用。两分支统一从清洗值构建抛出
  // 错误（round 7）：字符串与 Error 原因的清洗输出即为最终消息——边缘空白/
  // 不可见字符不存活到 MCP 边界，原对象（含传输层自带的 code 属性，如
  // DOMException 的 20）不透传；bodyUnreadable 标记供门禁折叠区分传输噪声
  // 与服务端话术。
  // 体读取的有界化（round 19）：fetch 的 abort 定时器在其 finally 里、体读
  // 取之前清除——永不结算的 text() 此前无模块侧上界，工具调用悬挂。第二个
  // 定时器跨体读取持续武装（真 Response 流随 controller.abort 拒绝），并经
  // Promise.race 兜住不理会 abort 的敌意体：非结算体在 timeoutMs 内落进设
  // 计 transportReason 包装。已知边界（台账）：自转 thenable（then 里再 resolve
  // 自身）把微任务队列永远排满，任何定时器都上不了 CPU——无客户端方案可
  // 界定，与全陷阱谎言同族的记录边界
  let bodyTimer: ReturnType<typeof setTimeout> | undefined;
  const bodyBound = new Promise<never>((_, reject) => {
    bodyTimer = setTimeout(() => {
      controller.abort();
      reject(new Error(`hdkitservice response body read timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  let text: string;
  try {
    const raw: unknown = await Promise.race([resp.text() as unknown, bodyBound]);
    // 敌意体收口（round 18）：text() 可 resolve 出任意值——非字符串先前在非
    // JSON catch 里裸做 text.slice，原始 TypeError 顶替设计信封（409 门禁折
    // 叠死、502 不再重试）。按不可读体处理：本 catch 的设计包装（清洗文案 +
    // bodyUnreadable + 安全读 status），与 text() 拒绝孪生同形
    if (typeof raw !== 'string') {
      throw new TypeError(`hdkitservice response body is not text (typeof ${typeof raw})`);
    }
    text = raw;
  } catch (error) {
    // 状态读过安全卫队（round 16）：text() 拒绝 + 敌意 status getter 不得
    // 在包装口自己的 catch 里引爆——无状态即无网关信号（不重试），标记照带
    const wrapped = transportReason(error, 'hdkitservice response body read aborted');
    const status = safeRespStatus(resp);
    if (status !== undefined) Object.assign(wrapped, { status });
    throw wrapped;
  } finally {
    if (bodyTimer !== undefined) clearTimeout(bodyTimer);
  }
  let data: Record<string, unknown> | unknown[];
  try {
    // asRecord collapses arrays into {} — the list endpoints (api-keys) return
    // real arrays, and collapsing them silently kills the orphan-key ladder.
    const parsed: unknown = JSON.parse(text);
    data = Array.isArray(parsed) ? parsed : asRecord(parsed);
  } catch {
    // 非 JSON 页携带 status（round 17 起过安全读+窄化）：诚实的有限数字照带
    // ——瞬时判定按 status 裁决（round 3 的教训：不带 status 的抛错会被消息
    // 兜底误判）；敌意/非有限读按缺读处理——渲染"未知"、不携带（无状态即
    // 无码可制造）。bodyUnreadable 同标记（round 6）。
    // 片段按码点截断并过清洗口（round 10）：UTF-16 单元截断会把星面区对截成
    // 孤立代理对，阻断所有清洗——不可见字符随片段骑进折叠消息
    // 先按 UTF-16 单元截头部再按码点截断（round 11）：[...text] 会物化整个
    // 响应体（40MB 页面实测 1.07GB 堆），400 单元保证覆盖 200 码点
    const snippet = cleanMessage([...text.slice(0, 400)].slice(0, 200).join(''));
    const nonJsonStatus = safeRespStatus(resp);
    throw Object.assign(
      new Error(`hdkitservice returned non-JSON (status ${nonJsonStatus ?? '未知'})${snippet ? `: ${snippet}` : ''}`),
      { ...(nonJsonStatus !== undefined ? { status: nonJsonStatus } : {}), bodyUnreadable: true },
    );
  }

  if (!safeRespOk(resp)) {
    const rec = asRecord(data);
    const rawCode = rec.code;
    // 码字段与消息/版本字段同过清洗口（round 7——此前唯一未窄化的边界读）：
    // 纯空白/Cf 码视同缺失，409 走无码门禁折叠，其余状态照旧伪造 HTTP_x；
    // 409 且无码/门禁码即门禁，带其他服务端码的 409 按其自身码处理
    const serverCode = typeof rawCode === 'string' ? cleanMessage(rawCode) : '';
    // 状态读过卫队（round 17）：缺读不制造 "HTTP_undefined" 伪码——无状态即
    // 无码，信封裸 message 兜底；409 语义照旧
    const respStatus = safeRespStatus(resp);
    const code =
      serverCode || (respStatus === 409 ? undefined : respStatus !== undefined ? `HTTP_${respStatus}` : undefined);
    const trace = rec.traceId ? ` [trace: ${asText(rec.traceId)}]` : '';
    // 消息构建口（round 4 + round 5）：空白与纯不可见字符（零宽空格等
    // trim 不清除的 Cf 类）均视为缺失——设计好的 'hdkitservice error'
    // 兜底在所有出口生效
    const message = cleanMessage(asString(rec.message)) || 'hdkitservice error';
    let err = new Error(code ? `${code}: ${message}${trace}` : `${message}${trace}`) as HdkitError;
    err.code = code;
    if (respStatus !== undefined) err.status = respStatus;
    err.traceId = rec.traceId;
    if (canonCode(code) === 'HDKIT_CRED_INVALID') {
      err.remediation = {
        hint: '已保存的凭证(S1)可能已失效。请执行以下操作之一：',
        steps: [
          '运行 huaweicloud_auth_status 查看当前凭证状态（S1 指纹 vs 环境注入指纹）',
          '若环境注入了有效凭证：运行 huaweicloud_auth_switch action=clear 清除 runtime 凭证，或删除 ~/.config/huaweicloud/credentials.json 让平台凭证接管',
          '若需更新 S1：运行 npx huaweicloud-devkit auth init 重新配置有效 AK/SK',
        ],
      };
    }
    // 429 双错误码（两池配额契约）：配额满给出释放/复用引导；池容量不足只透传服务端
    // 最终文案（“DevKit 免费资源当前使用人数较多，建议您错峰使用，感谢理解！”），
    // 不再附加额外引导——该文案即最终展示内容。两者均携带服务端 Retry-After。
    if (canonCode(code) === 'HDKIT_QUOTA_EXCEEDED') {
      err.retryAfter = safeRetryAfterHeader(resp) || undefined;
      err.remediation = {
        hint: '沙箱并发配额已满（每账号最多 5 台、每类型 1 台），重试无效：',
        steps: [
          '确认已有实例是否够用：connect 对同池实例自动复用，无需重复创建',
          '释放不再使用的沙箱（控制台或平台回收）后重试',
          '如需两种生命周期语义并存：ephemeral 与 persistent 各可持有 1 台',
        ],
      };
    }
    if (canonCode(code) === 'HDKIT_CAPACITY_INSUFFICIENT') {
      err.retryAfter = safeRetryAfterHeader(resp) || undefined;
      // 该文案即最终展示内容（不带 "CODE: " 前缀、不附加引导）。
      // cleanMessage 窄化（round 5）：undefined/空白/纯不可见字符均不覆盖——
      // 保留构建口的代码前缀兜底
      err.message = cleanMessage(asString(rec.message)) || err.message;
    }
    // 版本硬门禁（409 HDKIT_VERSION_TOO_OLD）：结构化升级引导，remediation 才能
    // 穿透 MCP 边界（dev 501fd8b4）。烧核分支的 !err.remediation 守卫保持其排他性。
    // asString 窄化（不用 asText：asText(undefined) === 'undefined' 是真值，
    // `|| undefined` 兜底永不生效，字面量会流进用户可见文案）
    if (canonCode(code) === VERSION_GATE_CODE) {
      // 返回值即生效载体（round 15）：请求层自建载体恒可写、就地装填返回原
      // 对象；拒绝装饰的载体（仅导出面可达）返回装填好的克隆
      err = applyVersionGate(err, {
        clientVersion: asString(rec.clientVersion),
        minVersion: asString(rec.minVersion),
        message: asString(rec.message),
      });
    }
    // 烧核播报（缺口#5 代码层）：账号核心时长耗尽——上游码 HD.97520422 经
    // hdkitservice 以 HDKIT_UPSTREAM_ERROR 包装透传，客户端按消息内错误码识别。
    // 仅在前面的分支未设置 remediation 时生效（else-if 语义：烧核不覆盖 429 双码/凭证指引）
    if (!err.remediation && asText(rec.message || '').includes('HD.97520422')) {
      err.coreHoursExhausted = true;
      err.remediation = {
        hint: '账号核心时长（核时）已耗尽，沙箱无法继续运行：',
        steps: [
          '核时按沙箱运行时长消耗，当前账号余额为 0',
          '更换有核时余额的账号，或等待/申请核时补充',
          '详见华为云开发者空间核心时长说明',
        ],
      };
    }
    throw err;
  }

  return data;
}

export async function hdkitCheckUser(): Promise<Record<string, unknown>> {
  const result = asRecord(await hdkitRequest('GET', 'check-user', undefined, 30000));
  if (result.userHash) cacheUserHash(result.userHash);
  return result;
}

export async function hdkitGenerateUserHash(): Promise<Record<string, unknown>> {
  const result = asRecord(await hdkitRequest('GET', 'user/generatorUserIDHash', undefined, 30000));
  if (result.userHash) cacheUserHash(result.userHash);
  return result;
}

export async function hdkitSignAgreement(): Promise<Record<string, unknown>> {
  return asRecord(await hdkitRequest('POST', 'sign-agreement', {}));
}

export async function hdkitConnect(options: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const body: Record<string, unknown> = {};
  if (options.source) body.source = options.source;
  if (options.env) body.env = options.env;
  if (options.git) body.git = options.git;
  if (options.template_id) body.template_id = options.template_id;
  if (options.flavor_id) body.flavor_id = options.flavor_id;
  if (options.pool_type) {
    // 两池：pool_type 由服务端权威映射（不传默认 ephemeral）。
    // 可选运维钉扎：配置 HW_POOL_TEMPLATE_* 时附带映射模板（服务端与老服务端均按显式模板处理）
    body.pool_type = options.pool_type;
    const pinned = pinnedTemplateFor(options.pool_type);
    if (pinned && !body.template_id) body.template_id = pinned;
  }

  return asRecord(await hdkitRequest('POST', 'connect', body));
}

/**
 * connect 专用网关 502/504 重试（dev e0c8700b）：编排期响应超时不是创建失败，
 * 服务端可能已创建/启动实例，重试通常复用。有界重试、逐档退避，其余状态一律
 * 不重试（含 409 版本门禁与配额/容量/凭证类客户端裁决码——不可重试裁决由
 * hdkit-gate 的瞬时判定与裁决码集合独占）。
 * 重试表经 HW_SANDBOX_CONNECT_RETRY_DELAYS_MS 针脚可覆写（v2 扩展）。
 * 成功路径回显 connect_retries（v2 扩展；dev 仅在错误路径带尝试次数）。
 */
export async function hdkitConnectWithRetry(options: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const delays = connectRetryDelaysMs();
  let retries = 0;
  for (;;) {
    try {
      const result = await hdkitConnect(options);
      if (retries > 0) result.connect_retries = retries;
      return result;
    } catch (error) {
      const transient = isGatewayTransient(error) && !isNonRetryableBusinessError(error);
      if (!transient || retries >= delays.length) {
        // 写入带防护（round 10）：拒绝装饰的载体（冻结等）不在此抛 TypeError——
        // 耗尽路径的克隆分支补 connectRetries，非耗尽路径原样抛出
        try {
          (error as { connectRetries?: number }).connectRetries = retries;
        } catch {
          // 请求层不会产生拒绝载体；此防御仅守导出面
        }
        // 耗尽装填返回待抛对象：常规载体即原错误，拒绝装饰的载体为克隆（round 9）
        if (transient) throw decorateExhaustedConnect(error, retries);
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, delays[retries]));
      retries += 1;
    }
  }
}

export async function hdkitCredentials(
  sessionId: unknown,
  devStageId: unknown,
  enableSts = true,
): Promise<Record<string, unknown>> {
  const body: Record<string, unknown> = { enable_sts: enableSts };
  if (sessionId) body.session_id = sessionId;
  if (devStageId) body.dev_stage_id = devStageId;

  if (!sessionId && !devStageId) {
    throw new Error('session_id or dev_stage_id is required');
  }

  return asRecord(await hdkitRequest('POST', 'credentials', body));
}

// ── DevBridge API Key relay 代理（经 hdkitservice 透传 DevStation relay 接口）──
// 凭证由 hdkitRequest 内部 getCredentials() 统一解析，调用方无需传

/**
 * 创建 DevBridge API Key。响应含完整 api_key（仅创建时可见）。
 * 配额满（13002）时服务端返回 429 HDKIT_DEVBRIDGE_KEY_QUOTA_EXCEEDED，
 * hdkitRequest 抛错 err.code 携带该码。
 */
export async function hdkitCreateApiKey(name: string, scope = 'devbridge'): Promise<Record<string, unknown>> {
  return asRecord(await hdkitRequest('POST', 'api-key', { name, scope }));
}

/** 列出当前账号所有 API Key（仅 mask + last_used_at）。数组负载原样返回，由调用方 Array.isArray 守卫。 */
export async function hdkitListApiKeys(): Promise<unknown> {
  return await hdkitRequest('GET', 'api-keys', undefined, 30000);
}

/** 按 keyId 删除 API Key（上游 DELETE 方法）。 */
export async function hdkitDeleteApiKey(keyId: string): Promise<Record<string, unknown>> {
  return asRecord(await hdkitRequest('DELETE', `api-keys/${encodeURIComponent(keyId)}`, undefined, 30000));
}

// The voucher endpoints answer failures with a { claimed: false } shape
// instead of throwing, so the claim flow can warn rather than abort. The
// three endpoints share the fallback; only the service-unavailable wording
// differs.
function voucherFallback(error: unknown, unavailableMessage: string): Record<string, unknown> {
  // 409 门禁（带码或无码）在此出口同折（round 6）：claimed:false 信封 + 门禁
  // 字段——凭证/传输类错误才走 unavailable 文案
  if (isVersionGateError(error)) {
    return { claimed: false, ...gateFoldPayload(error) };
  }
  // 非门禁信封的字段读全过安全卫队与窄化（round 15 建、round 16 深验、
  // round 17 嵌套上下文+快照往返、round 18 快照形态窄化）：抛出型 getter/
  // 撤销代理按缺失，缺失的消息走 unavailable 文案；remediation 经
  // serializableRemediation 深验——非对象、嵌套 BigInt、循环引用、判别器、
  // 有状态换值、非对象 JSON 视图一并不骑信封
  const rawCode = safeReadField(error, 'code');
  const rawClientVersion = safeReadField(error, 'clientVersion');
  const rawMinVersion = safeReadField(error, 'minVersion');
  const remediation = serializableRemediation(safeReadField(error, 'remediation'));
  // 非门禁信封同过清洗口（round 24/SHOULD 6 建、round 25 收口洗钱缝）：纯
  // 空白/纯不可见版本字段视同缺失（round 6 出口信条）；码按拼写口径——服
  // 务端亲署码不含空白渲染字符，原始拼写带空白渲染字符即非亲署：渲染其清
  // 洗形会让伪造码洗成亲署拼写的字节等价物（HDKIT_CRED_INVA\u200bLID 洗成
  // HDKIT_CRED_INVALID）——一律省略（比较口径的 canonCode 只作判等，不作
  // 渲染；round-24 的"渲染清洗形"预期按本条取代）
  const canonicalCode = typeof rawCode === 'string' ? canonCode(rawCode) : '';
  const cleanedCode = canonicalCode !== '' && canonicalCode === rawCode ? rawCode : undefined;
  const cleanedClientVersion =
    typeof rawClientVersion === 'string' ? cleanMessage(rawClientVersion) || undefined : undefined;
  const cleanedMinVersion = typeof rawMinVersion === 'string' ? cleanMessage(rawMinVersion) || undefined : undefined;
  return {
    claimed: false,
    message: cleanMessage(safeMessageText(error)) || unavailableMessage,
    // dev voucherErrorResult 语义：非门禁错误自带的指引字段（如 CRED_INVALID
    // 的 S1 修复引导）清洗后透传
    ...(cleanedCode !== undefined ? { code: cleanedCode } : {}),
    ...(cleanedClientVersion !== undefined ? { clientVersion: cleanedClientVersion } : {}),
    ...(cleanedMinVersion !== undefined ? { minVersion: cleanedMinVersion } : {}),
    ...(remediation ? { remediation } : {}),
  };
}

export async function hdkitVoucherStatus(domainId?: string): Promise<Record<string, unknown>> {
  try {
    const path = domainId ? `voucher/status?domain_id=${encodeURIComponent(domainId)}` : 'voucher/status';
    return asRecord(await hdkitRequest('GET', path, undefined, 30000));
  } catch (error) {
    return voucherFallback(error, 'Incentive service unavailable, please try again later');
  }
}

export async function hdkitVoucherClaim(domainId?: string): Promise<Record<string, unknown>> {
  try {
    const body: Record<string, unknown> = domainId ? { domain_id: domainId } : {};
    return asRecord(await hdkitRequest('POST', 'voucher/claim', body));
  } catch (error) {
    return voucherFallback(error, 'Incentive service unavailable, please try again later');
  }
}

export async function hdkitCompetitionVoucherClaim(domainId?: string): Promise<Record<string, unknown>> {
  try {
    const body: Record<string, unknown> = domainId ? { domain_id: domainId } : {};
    return asRecord(await hdkitRequest('POST', 'competition/voucher/claim', body));
  } catch (error) {
    return voucherFallback(error, 'Competition voucher service unavailable, please try again later');
  }
}
