import { deployNginx, deployCheck, getCurrentWorkspaceId } from '../../sandbox/session-manager.ts';
import type { CallToolOptions, ToolArgs } from '../../tools.ts';
import { SANDBOX_TIMEOUT_MS } from './schemas.ts';

// Deploy handlers (nginx config + deployment completeness check) for the
// sandbox pack, extracted verbatim from tools.ts in the within-pack split
// for the jscpd complex-file bar; the tools.ts face imports them for
// SANDBOX_TOOL_HANDLERS.

export async function handleDeployNginx(args: ToolArgs = {}, _opts: CallToolOptions = {}) {
  if (!args.nginx_type || !args.port || !args.project || !args.output_dir) {
    throw new Error('nginx_type, port, project, and output_dir are required.');
  }
  const sandboxWsId7 = args.workspace_id || getCurrentWorkspaceId();
  if (!sandboxWsId7) {
    throw new Error(
      'workspace_id is required. No sandbox connected — call huaweicloud_sandbox_connect first, ' +
        'or set HW_WORKSPACE_ID environment variable before starting the agent.',
    );
  }
  const sandboxUser7 = args.username || 'root';
  const sandboxTimeout7 = args.timeout_ms || SANDBOX_TIMEOUT_MS.deploy_nginx;
  return await deployNginx(
    sandboxWsId7,
    {
      nginxType: args.nginx_type,
      port: args.port,
      project: args.project,
      outputDir: args.output_dir,
      nodePort: args.node_port,
      publicPort: args.public_port,
      configName: args.config_name,
    },
    sandboxUser7,
    sandboxTimeout7,
  );
}

export async function handleDeployCheck(args: ToolArgs = {}, _opts: CallToolOptions = {}) {
  if (!args.port || !args.project || !args.output_dir) {
    throw new Error('port, project, and output_dir are required.');
  }
  const sandboxWsId8 = args.workspace_id || getCurrentWorkspaceId();
  if (!sandboxWsId8) {
    throw new Error(
      'workspace_id is required. No sandbox connected — call huaweicloud_sandbox_connect first, ' +
        'or set HW_WORKSPACE_ID environment variable before starting the agent.',
    );
  }
  const sandboxUser8 = args.username || 'root';
  const sandboxTimeout8 = args.timeout_ms || SANDBOX_TIMEOUT_MS.deploy_check;
  return await deployCheck(
    sandboxWsId8,
    {
      port: args.port,
      project: args.project,
      outputDir: args.output_dir,
      frameworkType: args.framework_type,
    },
    sandboxUser8,
    sandboxTimeout8,
  );
}
