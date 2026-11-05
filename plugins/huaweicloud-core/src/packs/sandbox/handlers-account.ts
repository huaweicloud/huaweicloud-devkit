import { execOneShot, execWithSession, setWorkspaceId } from '../../sandbox/session-manager.ts';
import { hdkitCheckUser, hdkitSignAgreement, hdkitConnect } from '../../lib/hdkit/hdkitservice-api.ts';
import { validatePoolType, rememberWorkspacePool, enrichConnectResult } from '../../lib/hdkit/sandbox-pool.ts';
import type { CallToolOptions, ToolArgs } from '../../tools.ts';
import { transferGitRepo } from './git-transfer.ts';

// Account/session-gate handlers (check_user, sign_agreement, connect) for
// the sandbox pack, extracted verbatim from tools.ts in the within-pack
// split for the jscpd complex-file bar; the tools.ts face imports them for
// SANDBOX_TOOL_HANDLERS. handleConnect owns the git repo transfer chain
// invocation (git-transfer.ts).

export async function handleCheckUser(_args: ToolArgs = {}, _opts: CallToolOptions = {}) {
  return await hdkitCheckUser();
}

export async function handleSignAgreement(_args: ToolArgs = {}, _opts: CallToolOptions = {}) {
  return await hdkitSignAgreement();
}

export async function handleConnect(args: ToolArgs = {}, _opts: CallToolOptions = {}) {
  // 两池：客户端校验 pool_type（非法值在本地即报错，不发无效请求）；未传交由服务端默认 ephemeral
  const connectArgs = { ...args };
  if (connectArgs.pool_type !== undefined) {
    const poolType = validatePoolType(connectArgs.pool_type);
    if (poolType === null) delete connectArgs.pool_type;
    else connectArgs.pool_type = poolType;
  }
  const connectResult = await hdkitConnect(connectArgs);
  const rawDevStageId = connectResult?.dev_stage_id || connectResult?.devStageId;
  const devStageId = typeof rawDevStageId === 'string' ? rawDevStageId : undefined;
  if (devStageId) {
    setWorkspaceId(devStageId);
    // 池归属缓存：exec/upload/deploy 等工具返回值据此附带池模式提示（缺口#2）；
    // 双读兜底与 devStageId 同型（防服务端 wire 命名漂移，QA #1082 配对复审教训）
    rememberWorkspacePool(devStageId, connectResult?.pool_type || connectResult?.poolType);
    try {
      await execOneShot(devStageId, 'devbridge delete-all 2>/dev/null || true', 'root', 15000);
    } catch {
      // best-effort: a fresh sandbox may have no tunnels (or no devbridge) to delete
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
  // TTL 播报（缺口#1）：服务端回显 pool_type 才附带生命周期提示
  return enrichConnectResult(connectResult);
}
