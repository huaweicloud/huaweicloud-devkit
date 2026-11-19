import { execWithSession, closeSession, getCurrentWorkspaceId, setWorkspaceId } from '../../sandbox/session-manager.ts';
import { cleanupDevbridgeTunnels } from '../../sandbox/devbridge-tunnel.ts';
import {
  hdkitCheckUser,
  hdkitSignAgreement,
  hdkitConnectWithRetry,
  hdkitShutdown,
} from '../../lib/hdkit/hdkitservice-api.ts';
import {
  MANUFACTURED_FAMILY,
  manufacturedPrefixPattern,
  canonCode,
  chainDataValue,
  cleanMessage,
  ownDataValue,
  safeMessageText,
  safeReadField,
  serializableRemediation,
  transientExhaustionResult,
  versionGateResult,
} from '../../lib/hdkit/hdkit-gate.ts';
import type { HdkitError } from '../../lib/hdkit/hdkitservice-api.ts';
import { asString } from '../../lib/as-text.ts';
import {
  validatePoolType,
  rememberWorkspacePool,
  shouldAnnounceConnect,
  enrichConnectResult,
} from '../../lib/hdkit/sandbox-pool.ts';
import type { CallToolOptions, ToolArgs } from '../../tools.ts';
import { transferGitRepo } from './git-transfer.ts';

// Account/session-gate handlers (check_user, sign_agreement, connect,
// shutdown) for the sandbox pack, extracted verbatim from tools.ts in the
// within-pack split for the jscpd complex-file bar; the tools.ts face imports
// them for SANDBOX_TOOL_HANDLERS. handleConnect owns the git repo transfer
// chain invocation (git-transfer.ts); handleShutdown owns the DevStation
// close face (dev 5d89c880 + 3bfc1f53 tip state).

export async function handleCheckUser(_args: ToolArgs = {}, _opts: CallToolOptions = {}) {
  try {
    return await hdkitCheckUser();
  } catch (error) {
    // 409 版本门禁按出口折叠（dev e1255a4b）：MCP 错误信封只携带 code+message，
    // clientVersion/minVersion/remediation 必须展开为结构化返回才能穿透
    const gate = versionGateResult(error);
    if (gate) return gate;
    throw error;
  }
}

export async function handleSignAgreement(_args: ToolArgs = {}, _opts: CallToolOptions = {}) {
  try {
    return await hdkitSignAgreement();
  } catch (error) {
    const gate = versionGateResult(error);
    if (gate) return gate;
    throw error;
  }
}

export async function handleConnect(args: ToolArgs = {}, _opts: CallToolOptions = {}) {
  // 两池：客户端校验 pool_type（非法值在本地即报错，不发无效请求）；未传交由服务端默认 ephemeral
  const connectArgs = { ...args };
  let poolType: ReturnType<typeof validatePoolType>;
  try {
    poolType = connectArgs.pool_type !== undefined ? validatePoolType(connectArgs.pool_type) : null;
    if (poolType) connectArgs.pool_type = poolType;
  } catch (error) {
    // 非法 pool_type 结构化返回：MCP 错误信封只携带 code+message，指引字段在 throw 路径会丢失（参照 voucher 模式）
    return { ok: false, code: 'HDKIT_INVALID_POOL_TYPE', message: (error as Error).message };
  }
  let connectResult: Record<string, unknown>;
  try {
    // AX N-SB.2: the MCP tool answers inside the host's request budget — a
    // transient gateway timeout returns a pending receipt instead of sleeping
    // through the 30s/45s table (the next call re-attempts and reuses any
    // instance the server already created). Short backoffs (tests/operators)
    // keep the inline ladder.
    connectResult = await hdkitConnectWithRetry(connectArgs, { maxInlineDelayMs: 1000 });
  } catch (error) {
    // 业务预期失败（429 三码 / 烧核 / 凭证失效）转结构化返回，remediation 才能穿透 MCP 边界；
    // 其余错误维持抛出（MCP 层透传 code+message）。
    // 409 版本门禁（dev e1255a4b）与网关 502/504 重试耗尽（v2 扩展）同样在此折叠。
    const err = error as HdkitError;
    const gate = versionGateResult(err);
    if (gate) return gate;
    const exhausted = transientExhaustionResult(err);
    if (exhausted) return exhausted;
    // 业务折叠的字段读全过安全卫队与窄化（round 15 建、round 16 深验、
    // round 17 嵌套上下文+快照往返、round 18 快照形态窄化）：抛出型 getter/
    // 撤销代理按缺失——缺失的码不进业务分支，原错误原样抛出；remediation 经
    // serializableRemediation 深验——非对象、嵌套 BigInt、循环引用、判别器、
    // 有状态换值、非对象 JSON 视图一并不骑信封
    // 判等口径 vs 渲染口径（round 26/MUST 3）：canonCode 只作判等——织入/垫
    // 码的业务码仍按 round-12 教义识别（传输噪声下的真服务码）；渲染对齐
    // voucher 谓词——服务端亲署码不含空白渲染字符，原始拼写带空白渲染字
    // 符即非亲署，渲染其清洗形会把伪造码洗成亲署拼写的字节等价物（
    // HDKIT_QUOTA\u200b_EXCEEDED 洗成签名 HDKIT_QUOTA_EXCEEDED——真实 wire
    // 路径可经网关/代理注入织入拼写）——一律省略（码字段与前缀同判）；
    // 空白码同样省略（never-blank-code 教义——此前渲染 code:''）
    const rawBusinessCode = safeReadField(error, 'code');
    const businessCode = canonCode(rawBusinessCode);
    // 伪造码不渲染（round 30/MUST 3，round 8 教义在业务折叠落地）：
    // 无码烧核 502/504 经请求层制造了 HTTP_502/504——分发追踪靠标记
    // （r29），信封的码字段与前缀不得渲染客户端制造拼写
    const renderCode =
      typeof rawBusinessCode === 'string' &&
      businessCode !== '' &&
      businessCode === rawBusinessCode &&
      !MANUFACTURED_FAMILY.test(businessCode)
        ? rawBusinessCode
        : undefined;
    // 伪造码的消息前缀一并剥除（round 30/MUST 3，与耗尽装饰同法：
    // 请求层把 "HTTP_x: " 合进了消息——客户端制造拼写不得以任何表面（码字段或
    // 可见消息）渲染上信封；循环剥除（页面消息可翻倍），剥后为空则走设计兜底
    let businessMessage = cleanMessage(safeMessageText(error)) || '';
    if (businessCode !== '' && MANUFACTURED_FAMILY.test(businessCode)) {
      const stripPattern = manufacturedPrefixPattern(businessCode);
      while (stripPattern) {
        const hit = stripPattern.exec(businessMessage);
        if (!hit) break;
        businessMessage = businessMessage.slice(hit[0].length);
      }
      businessMessage = cleanMessage(businessMessage);
    }
    // 转向字段改自有数据描述符读（round 26/MUST 3）：[[Get]] 读让立着访问
    // 器注入任意文案（pay-here URL）；与门禁/耗尽折叠的 ownDataValue 同标
    // 准（round 25 漏掉了本折叠）
    const coreHoursExhausted = chainDataValue(error, 'coreHoursExhausted');
    if (
      businessCode === 'HDKIT_QUOTA_EXCEEDED' ||
      businessCode === 'HDKIT_TEMPLATE_QUOTA_EXCEEDED' ||
      businessCode === 'HDKIT_CAPACITY_INSUFFICIENT' ||
      businessCode === 'HDKIT_CRED_INVALID' ||
      coreHoursExhausted
    ) {
      // retryAfter 窄到字符串、remediation 深验（round 16）：BigInt 等敌意值
      // 不骑信封（MCP 序列化边界，与门禁/耗尽折叠同口径）
      const rawRetryAfter = ownDataValue(error, 'retryAfter');
      const retryAfter = typeof rawRetryAfter === 'string' ? rawRetryAfter : undefined;
      const remediation = serializableRemediation(ownDataValue(error, 'remediation'));
      // 空白/缺失消息走构建口同款代码前缀兜底（round 20）：其余折叠口从不
      // 渲染空 message，此处对齐——纯不可见消息按缺失
      const fallbackMessage = renderCode ? `${renderCode}: hdkitservice error` : 'hdkitservice error';
      return {
        ok: false,
        ...(renderCode ? { code: renderCode } : {}),
        message: businessMessage || fallbackMessage,
        ...(retryAfter ? { retryAfter } : {}),
        ...(coreHoursExhausted ? { coreHoursExhausted: true } : {}),
        ...(remediation ? { remediation } : {}),
      };
    }
    throw error;
  }
  if (connectResult?.pending === true) {
    const retryAfterMs =
      typeof connectResult.retryAfterMs === 'number' && Number.isFinite(connectResult.retryAfterMs)
        ? connectResult.retryAfterMs
        : 30000;
    const retryAfter = `${Math.max(1, Math.ceil(retryAfterMs / 1000))}s`;
    return {
      ok: false,
      pending: true,
      retryAfter,
      retryAfterMs,
      ...(typeof connectResult.code === 'string' ? { code: connectResult.code } : {}),
      message:
        typeof connectResult.message === 'string' && connectResult.message
          ? connectResult.message
          : 'the hdkitservice gateway timed out during orchestration.',
      hint:
        `The sandbox instance may already exist on the server. Re-call huaweicloud_sandbox_connect with the SAME ` +
        `parameters after ~${retryAfter} — a created instance is reused. Do not start a second sandbox and do not ` +
        `debug this as a credential failure.`,
    };
  }
  const rawDevStageId = connectResult?.dev_stage_id || connectResult?.devStageId;
  const devStageId = typeof rawDevStageId === 'string' ? rawDevStageId : undefined;
  let announceConnect = true;
  if (devStageId) {
    setWorkspaceId(devStageId);
    // 播报判定：会话首次 connect 或复用实例被唤醒（started=true）才提示，其余复用静默
    announceConnect = shouldAnnounceConnect(devStageId, connectResult || {});
    // 池归属 + 生命周期口径缓存（服务端回显优先，缺失时客户端默认兜底）。
    // 双读兜底与 devStageId 同型（防服务端 wire 命名漂移，QA #1082 配对复审教训）
    rememberWorkspacePool(devStageId, connectResult?.pool_type || connectResult?.poolType, connectResult || {});
    // 连接后的选择性隧道清理（dev 97c4bc8a）：只清孤儿记录/宿主；保留其他
    // 端口、其他会话与 keepalive 名单内的隧道。best-effort —— 清理失败不得
    // 阻断 connect 本身。
    try {
      await cleanupDevbridgeTunnels(devStageId, { mode: 'stale' });
    } catch {
      // best-effort: a fresh sandbox may have no tunnels (or no devbridge) to clean
    }
    try {
      // #999: /workspace/.local/bin first — the data-disk install survives
      // sandbox reboots; ~/.huawei/bin is wiped back to the image state.
      await execWithSession(
        devStageId,
        'export PATH=/workspace/.local/bin:$HOME/.huawei/bin${PATH:+:$PATH}',
        'root',
        10000,
      );
    } catch {
      // best-effort: the PATH export only aids later devbridge calls in this session
    }
    await transferGitRepo(args, devStageId, connectResult);
  }
  // 生命周期提示：仅首次连接 / 关机唤醒时播报（服务端回显 pool_type 才生成）
  return enrichConnectResult(connectResult, { announce: announceConnect });
}

// 关机错误的结构化折叠（dev 5d89c880 的 toVersionGateResult 面，去掉 v2 未
// 移植的 autoUpgrade 字段）：MCP 错误信封只携带 code+message，指引与版本字段
// 必须展开为结构化返回才能穿透边界——404 HDKIT_SANDBOX_NOT_FOUND、烧核、
// 版本门禁与传输层失败一律 ok:false 返回，不再裸抛。
function shutdownErrorResult(error: unknown): Record<string, unknown> {
  const err = error as HdkitError;
  return {
    ok: false,
    code: err.code,
    message: err instanceof Error ? err.message : String(error),
    ...(err.retryAfter !== undefined ? { retryAfter: err.retryAfter } : {}),
    ...(err.coreHoursExhausted ? { coreHoursExhausted: true } : {}),
    ...(err.clientVersion ? { clientVersion: err.clientVersion } : {}),
    ...(err.minVersion ? { minVersion: err.minVersion } : {}),
    ...(err.remediation ? { remediation: err.remediation } : {}),
  };
}

export async function handleShutdown(args: ToolArgs = {}, _opts: CallToolOptions = {}) {
  const sessionId = args.session_id;
  // 3bfc1f53：workspaceId 与 devStageId 分开解析。仅 session_id 时 devStageId
  // 留空（不把 session_id 字符串当 workspace 用），终端会话以服务端回传的
  // devStageId 为准关闭。
  const workspaceId = args.dev_stage_id || args.workspace_id || getCurrentWorkspaceId();
  const devStageId = args.dev_stage_id || args.workspace_id || (sessionId ? undefined : workspaceId);
  const id = sessionId || devStageId;
  if (!id) {
    return {
      ok: false,
      code: 'HDKIT_INVALID_REQUEST',
      message:
        'session_id or dev_stage_id is required. No sandbox connected — call huaweicloud_sandbox_connect first, or pass workspace_id.',
    };
  }
  try {
    const shutdown = await hdkitShutdown(sessionId, devStageId);
    try {
      // 3bfc1f53 终态：仅 session_id 时以服务端回传的 devStageId 关终端会话。
      // 与 dev 同形的 || 穿透（dev 3bfc1f53）：空串回显不截停链——asString 只
      // 收窄类型，真值判定仍按 ||（id 检查已保证链上有真值，'' 尾仅为类型
      // 完备）。
      const wsForClose = asString(shutdown.devStageId) || asString(workspaceId) || asString(sessionId) || '';
      await closeSession(wsForClose, args.username || 'root');
    } catch {
      // best-effort: 关机已受理，终端会话随沙箱停止一并消亡
    }
    return { ok: true, ...shutdown };
  } catch (error) {
    return shutdownErrorResult(error);
  }
}
