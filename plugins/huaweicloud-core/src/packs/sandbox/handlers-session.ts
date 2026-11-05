import { execWithSession, execOneShot, closeSession, getCurrentWorkspaceId } from '../../sandbox/session-manager.ts';
import { poolContextFor } from '../../lib/hdkit/sandbox-pool.ts';
import type { CallToolOptions, ToolArgs } from '../../tools.ts';
import { SANDBOX_TIMEOUT_MS } from './schemas.ts';

// Session/exec handlers for the sandbox pack, extracted verbatim from
// tools.ts in the within-pack split for the jscpd complex-file bar; the
// tools.ts face imports them for SANDBOX_TOOL_HANDLERS.

export async function handleExecWithSession(args: ToolArgs = {}, _opts: CallToolOptions = {}) {
  const sandboxWsId2 = args.workspace_id || getCurrentWorkspaceId();
  if (!sandboxWsId2) {
    throw new Error(
      'workspace_id is required. No sandbox connected — call huaweicloud_sandbox_connect first, ' +
        'or set HW_WORKSPACE_ID environment variable before starting the agent.',
    );
  }
  const sandboxUser2 = args.username || 'root';
  const sandboxTimeout2 = args.timeout_ms || SANDBOX_TIMEOUT_MS.exec_with_session;
  const sandboxResult2 = await execWithSession(sandboxWsId2, args.command || '', sandboxUser2, sandboxTimeout2);
  return { stdout: sandboxResult2.stdout, exitCode: sandboxResult2.exitCode, ...poolContextFor(sandboxWsId2) };
}

export async function handleExecOneShot(args: ToolArgs = {}, _opts: CallToolOptions = {}) {
  const sandboxWsId3 = args.workspace_id || getCurrentWorkspaceId();
  if (!sandboxWsId3) {
    throw new Error(
      'workspace_id is required. No sandbox connected — call huaweicloud_sandbox_connect first, ' +
        'or set HW_WORKSPACE_ID environment variable before starting the agent.',
    );
  }
  const sandboxUser3 = args.username || 'root';
  const sandboxTimeout3 = args.timeout_ms || SANDBOX_TIMEOUT_MS.exec_one_shot;
  const sandboxResult3 = await execOneShot(sandboxWsId3, args.command || '', sandboxUser3, sandboxTimeout3);
  return { stdout: sandboxResult3.stdout, exitCode: sandboxResult3.exitCode, ...poolContextFor(sandboxWsId3) };
}

export async function handleCloseSession(args: ToolArgs = {}, _opts: CallToolOptions = {}) {
  const sandboxWsId4 = args.workspace_id || getCurrentWorkspaceId();
  if (!sandboxWsId4) {
    throw new Error(
      'workspace_id is required. No sandbox connected — call huaweicloud_sandbox_connect first, ' +
        'or set HW_WORKSPACE_ID environment variable before starting the agent.',
    );
  }
  const sandboxUser4 = args.username || 'root';
  const closed = await closeSession(sandboxWsId4, sandboxUser4);
  return closed ? 'ok' : 'not_connected';
}
