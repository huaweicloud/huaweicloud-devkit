import {
  exposeTunnel,
  renewTunnel,
  installKeepaliveWatchdog,
  validateTunnelId,
} from '../../sandbox/devbridge-tunnel.ts';
import { getCurrentWorkspaceId } from '../../sandbox/session-manager.ts';
import { poolContextFor, withPoolContext } from '../../lib/hdkit/sandbox-pool.ts';
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
  return withPoolContext(
    sandboxWsId9,
    await exposeTunnel(
      sandboxWsId9,
      {
        port: args.port,
        expiryHours: typeof args.expiry_hours === 'number' ? args.expiry_hours : undefined,
        keepalive: typeof args.keepalive === 'boolean' ? args.keepalive : undefined,
        // DevBridge API Key 自动创建兜底（认证固定 apikey，AK/SK 已移除）
        poolType: poolContextFor(sandboxWsId9)?.poolMode || 'ephemeral',
        keyUpgrade: { ensureDevbridgeKey, recreateDevbridgeKey, buildKeyringInjectScript, listKeysForQuotaHint },
      },
      sandboxUser9,
      sandboxTimeout9,
    ),
  );
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
  return withPoolContext(
    wsId,
    await renewTunnel(
      wsId,
      { tunnelId: args.tunnel_id, expiryHours: typeof args.expiry_hours === 'number' ? args.expiry_hours : undefined },
      args.username || 'root',
      args.timeout_ms || SANDBOX_TIMEOUT_MS.renew_tunnel,
    ),
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
  return withPoolContext(
    wsId,
    await installKeepaliveWatchdog(
      wsId,
      { tunnels },
      args.username || 'root',
      args.timeout_ms || SANDBOX_TIMEOUT_MS.keepalive_watchdog,
    ),
  );
}
