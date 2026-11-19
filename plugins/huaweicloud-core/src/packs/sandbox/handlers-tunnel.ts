import {
  exposeTunnel,
  renewTunnel,
  installKeepaliveWatchdog,
  validateTunnelId,
} from '../../sandbox/devbridge-tunnel.ts';
import { getCurrentWorkspaceId } from '../../sandbox/session-manager.ts';
import { validateTunnelPort } from '../../sandbox/devbridge-validation.ts';
import { poolContextFor } from '../../lib/hdkit/sandbox-pool.ts';
import { startExposeTask, pollExposeTask } from './expose-task.ts';
import {
  buildKeyringInjectScript,
  ensureDevbridgeKey,
  listKeysForQuotaHint,
  recreateDevbridgeKey,
} from '../../sandbox/devbridge-key.ts';
import type { CallToolOptions, ToolArgs } from '../../tools.ts';
import { SANDBOX_TIMEOUT_MS } from './schemas.ts';

// Tunnel handlers (expose/renew/keepalive-watchdog) for the sandbox pack,
// extracted verbatim from tools.ts in the within-pack split for the jscpd
// complex-file bar; the tools.ts face imports them for SANDBOX_TOOL_HANDLERS.

export async function handleExposeTunnel(args: ToolArgs = {}, _opts: CallToolOptions = {}) {
  if (!args.port) {
    throw new Error(
      'port is required. Use the ACTUAL "port" value returned by huaweicloud_sandbox_deploy_nginx (it may have been auto-incremented on a port conflict).',
    );
  }
  const sandboxWsId9 = args.workspace_id || getCurrentWorkspaceId();
  if (!sandboxWsId9) {
    throw new Error(
      'workspace_id is required. No sandbox connected — call huaweicloud_sandbox_connect first, ' +
        'or set HW_WORKSPACE_ID environment variable before starting the agent.',
    );
  }
  const sandboxUser9 = args.username || 'root';
  const sandboxTimeout9 = args.timeout_ms || SANDBOX_TIMEOUT_MS.expose_tunnel;
  const exposePoolContext = poolContextFor(sandboxWsId9);
  const exposeArgs = {
    port: validateTunnelPort(args.port),
    expiryHours: typeof args.expiry_hours === 'number' ? args.expiry_hours : undefined,
    keepalive: typeof args.keepalive === 'boolean' ? args.keepalive : undefined,
    cleanupMode: args.cleanup_mode,
    // DevBridge API Key 自动创建兜底（认证固定 apikey，AK/SK 已移除）
    poolType: exposePoolContext?.poolMode || 'ephemeral',
    poolContext: exposePoolContext,
    keyUpgrade: { ensureDevbridgeKey, recreateDevbridgeKey, buildKeyringInjectScript, listKeysForQuotaHint },
  };
  // AX N-SB.1: the chain can outlive the host's request timeout while the
  // server completes it — async starts it detached and the poll tool delivers
  // the URL in-band. The fast parameter checks above stay synchronous, so a
  // bad port is an immediate error, not a deferred task failure.
  if (args.mode === 'async') {
    const { taskId } = startExposeTask(sandboxWsId9, exposeArgs.port, () =>
      exposeTunnel(sandboxWsId9, exposeArgs, sandboxUser9, sandboxTimeout9),
    );
    return {
      started: true,
      mode: 'async',
      taskId,
      hint:
        'The expose chain is running in the background. Poll huaweicloud_sandbox_expose_poll with this taskId until ' +
        'state is done — the publicUrl and urlLifetimeHint are delivered there (the task receipt lives 30 minutes in ' +
        'this MCP server process).',
    };
  }
  return await exposeTunnel(sandboxWsId9, exposeArgs, sandboxUser9, sandboxTimeout9);
}

export async function handleExposePoll(args: ToolArgs = {}, _opts: CallToolOptions = {}) {
  const taskId = args.task_id;
  if (typeof taskId !== 'string' || taskId === '') {
    throw new Error(
      'task_id is required — pass the taskId returned by huaweicloud_sandbox_expose_tunnel mode:"async".',
    );
  }
  return pollExposeTask(taskId);
}

export async function handleRenewTunnel(args: ToolArgs = {}, _opts: CallToolOptions = {}) {
  if (!args.tunnel_id) {
    throw new Error(
      'tunnel_id is required. Get it from huaweicloud_sandbox_expose_tunnel or extract it from the public URL (https://<tunnel_id>-<port>.devbridge-s2.hwtunnel.com).',
    );
  }
  const wsId = args.workspace_id || getCurrentWorkspaceId();
  if (!wsId) {
    throw new Error(
      'workspace_id is required. No sandbox connected — call huaweicloud_sandbox_connect first, ' +
        'or set HW_WORKSPACE_ID environment variable before starting the agent.',
    );
  }
  // Fail fast on a malformed ID before any exec (the validator's error names
  // the expected shape).
  validateTunnelId(args.tunnel_id);
  return await renewTunnel(
    wsId,
    { tunnelId: args.tunnel_id, expiryHours: typeof args.expiry_hours === 'number' ? args.expiry_hours : undefined },
    args.username || 'root',
    args.timeout_ms || SANDBOX_TIMEOUT_MS.renew_tunnel,
  );
}

export async function handleKeepaliveWatchdog(args: ToolArgs = {}, _opts: CallToolOptions = {}) {
  if (!Array.isArray(args.tunnels) || args.tunnels.length === 0) {
    throw new Error(
      'tunnels is required — a non-empty array of {tunnel_id, url} from huaweicloud_sandbox_expose_tunnel results.',
    );
  }
  const wsId = args.workspace_id || getCurrentWorkspaceId();
  if (!wsId) {
    throw new Error(
      'workspace_id is required. No sandbox connected — call huaweicloud_sandbox_connect first, ' +
        'or set HW_WORKSPACE_ID environment variable before starting the agent.',
    );
  }
  const tunnels = (args.tunnels as Array<Record<string, unknown>>).map((t) => ({
    tunnelId: t.tunnel_id ?? t.tunnelId,
    url: t.url,
  }));
  return await installKeepaliveWatchdog(
    wsId,
    { tunnels },
    args.username || 'root',
    args.timeout_ms || SANDBOX_TIMEOUT_MS.keepalive_watchdog,
  );
}
