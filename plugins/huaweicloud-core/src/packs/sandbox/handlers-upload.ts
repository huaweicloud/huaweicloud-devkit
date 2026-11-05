import {
  uploadFileWithSession,
  uploadProjectWithSession,
  getCurrentWorkspaceId,
} from '../../sandbox/session-manager.ts';
import type { CallToolOptions, ToolArgs } from '../../tools.ts';
import { SANDBOX_TIMEOUT_MS } from './schemas.ts';

// Upload handlers for the sandbox pack, extracted verbatim from tools.ts in
// the within-pack split for the jscpd complex-file bar; the tools.ts face
// imports them for SANDBOX_TOOL_HANDLERS.

export async function handleUploadFile(args: ToolArgs = {}, _opts: CallToolOptions = {}) {
  if (!args.local_path || !args.remote_path) {
    throw new Error('local_path and remote_path are required.');
  }
  const sandboxWsId5 = args.workspace_id || getCurrentWorkspaceId();
  if (!sandboxWsId5) {
    throw new Error(
      'workspace_id is required. No sandbox connected — call huaweicloud_sandbox_connect first, ' +
        'or set HW_WORKSPACE_ID environment variable before starting the agent.',
    );
  }
  const sandboxUser5 = args.username || 'root';
  const sandboxTimeout5 = args.timeout_ms || SANDBOX_TIMEOUT_MS.upload_file;
  return await uploadFileWithSession(sandboxWsId5, args.local_path, args.remote_path, sandboxUser5, sandboxTimeout5);
}

export async function handleUploadProject(args: ToolArgs = {}, _opts: CallToolOptions = {}) {
  if (!args.local_dir) {
    throw new Error('local_dir is required.');
  }
  const sandboxWsId6 = args.workspace_id || getCurrentWorkspaceId();
  if (!sandboxWsId6) {
    throw new Error(
      'workspace_id is required. No sandbox connected — call huaweicloud_sandbox_connect first, ' +
        'or set HW_WORKSPACE_ID environment variable before starting the agent.',
    );
  }
  const sandboxUser6 = args.username || 'root';
  const sandboxTimeout6 = args.timeout_ms || SANDBOX_TIMEOUT_MS.upload_project;
  return await uploadProjectWithSession(sandboxWsId6, args.local_dir, args.remote_dir, sandboxUser6, sandboxTimeout6, {
    exclude: args.exclude,
    extract: args.extract,
  });
}
