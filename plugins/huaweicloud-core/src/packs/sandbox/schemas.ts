import { z } from 'zod';

import {
  numericArg,
  looseObject,
  gitConfig,
  workspaceId,
  username,
  vendorConfirmed,
} from '../../lib/tool-schema-parts.ts';

// The sandbox pack's zod schema family, extracted from tools.ts in the
// within-pack split for the jscpd complex-file bar. tools.ts stays the stable
// face: it imports every schema here for the SANDBOX_TOOLS /
// SANDBOX_TOOL_SCHEMAS arrays and re-exports SANDBOX_TIMEOUT_MS, so no
// consumer import changes. zod is allowed here (the pack compiles into the
// bundled mcp-server graph); the SDK is not.

// The single source for each tool's timeout default. The zod schema text
// and the handler fallback must agree, and direct callTool callers bypass
// SDK schema application, so the handler fallback stays — both read this.
export const SANDBOX_TIMEOUT_MS = {
  exec_with_session: 120000,
  exec_one_shot: 120000,
  upload_file: 120000,
  upload_project: 120000,
  deploy_nginx: 60000,
  // Bounded per-tunnel probing can spend up to 5 × 5s of curl alone plus
  // devbridge list round-trips — the probe loop must fit the budget instead
  // of dying as a ws-exec timeout (the pre-probing 30s default did not).
  deploy_check: 60000,
  // The expose script's A2 (#935) bounded waits can spend ~63s in one exec
  // (2s settle + up to 9s URL-extraction retries + 4 × 10s probes + 3 × 5s
  // backoff) plus the delete-all round-trip — the headroom exists for the
  // slow-gateway days the probe loop exists for, and a timeout still folds
  // into the structured unreachable envelope (never a raw ws error).
  expose_tunnel: 90000,
  renew_tunnel: 60000,
  keepalive_watchdog: 60000,
} as const;

export const execWithSessionSchema = z.looseObject({
  command: z.string().describe('The shell command to execute on the remote workspace'),
  workspace_id: workspaceId,
  username,
  timeout_ms: numericArg
    .optional()
    .describe(`Execution timeout in milliseconds (default: ${SANDBOX_TIMEOUT_MS.exec_with_session})`),
});

export const execOneShotSchema = z.looseObject({
  command: z.string().describe('The shell command to execute on the remote workspace'),
  workspace_id: workspaceId,
  username,
  timeout_ms: numericArg
    .optional()
    .describe(`Execution timeout in milliseconds (default: ${SANDBOX_TIMEOUT_MS.exec_one_shot})`),
});

export const closeSessionSchema = z.looseObject({
  workspace_id: workspaceId,
  username,
});

export const uploadFileSchema = z.looseObject({
  local_path: z
    .string()
    .describe(
      'Absolute path to the local file, readable from the machine running the DevKit MCP server (copy to the local temp dir first if not).',
    ),
  remote_path: z
    .string()
    .describe(
      'Target path in the sandbox, e.g. /workspace/<repo>/index.html. The remote parent directory is created automatically if absent.',
    ),
  workspace_id: workspaceId,
  username,
  timeout_ms: numericArg
    .optional()
    .describe(`Execution timeout in milliseconds (default: ${SANDBOX_TIMEOUT_MS.upload_file})`),
});

export const uploadProjectSchema = z.looseObject({
  local_dir: z
    .string()
    .describe(
      'Local project directory, readable from the machine running the DevKit MCP server (copy to the local temp dir first if not).',
    ),
  remote_dir: z
    .string()
    .optional()
    .describe(
      'Remote parent directory where project will be extracted (default: /workspace). Final layout: <remote_dir>/<dirname>/',
    ),
  workspace_id: workspaceId,
  username,
  exclude: z
    .array(z.string())
    .optional()
    .describe('Patterns to exclude from archive (default: .git, node_modules, __pycache__, .venv)'),
  extract: z.boolean().optional().describe('Extract tar.gz on sandbox after upload (default: true)'),
  timeout_ms: numericArg
    .optional()
    .describe(`Execution timeout in milliseconds (default: ${SANDBOX_TIMEOUT_MS.upload_project})`),
});

export const deployNginxSchema = z.looseObject({
  nginx_type: z
    .enum(['spa', 'proxy', 'static'])
    .describe(
      'Nginx config type from framework detection: spa (try_files fallback for SPA/SSG/cross-platform), proxy (reverse proxy for SSR), or static (plain root for Hugo/Hexo).',
    ),
  port: numericArg.describe('Listen port (from framework detection).'),
  project: z.string().describe('Project directory name under /workspace, e.g. movie-ticket.'),
  output_dir: z.string().describe('Build output directory relative to /workspace/<project>, e.g. dist/build/h5.'),
  node_port: numericArg
    .optional()
    .describe(
      'Node.js app port for SSR proxy. Defaults to the resolved nginx listen port plus one (targetPort + 1) when omitted; the result carries nodePort so you know which port to bind the Node process to.',
    ),
  public_port: numericArg.optional().describe('Public listen port for SSR proxy (optional, defaults to port).'),
  config_name: z
    .string()
    .optional()
    .describe(
      'Config file name (without .conf suffix). Defaults to the project name, ensuring each project gets its own config. Override with distinct names (e.g. admin, docs) for sub-app deployments.',
    ),
  workspace_id: workspaceId,
  username,
  timeout_ms: numericArg
    .optional()
    .describe(`Execution timeout in milliseconds (default: ${SANDBOX_TIMEOUT_MS.deploy_nginx})`),
});

export const deployCheckSchema = z.looseObject({
  port: numericArg.describe('App listen port (from framework detection).'),
  project: z.string().describe('Project directory name under /workspace.'),
  output_dir: z.string().describe('Build output directory relative to /workspace/<project>, e.g. dist/build/h5.'),
  framework_type: z
    .enum(['spa', 'ssr', 'ssg', 'cross-platform', 'monorepo', 'static'])
    .optional()
    .describe('Framework type from detect_framework. Set to cross-platform for QR code check.'),
  workspace_id: workspaceId,
  username,
  timeout_ms: numericArg
    .optional()
    .describe(`Execution timeout in milliseconds (default: ${SANDBOX_TIMEOUT_MS.deploy_check})`),
});

export const checkUserSchema = z.looseObject({});

export const exposeTunnelSchema = z.looseObject({
  port: numericArg.describe(
    'Port nginx actually serves on — use the "port" value returned by huaweicloud_sandbox_deploy_nginx, not the originally requested port.',
  ),
  expiry_hours: numericArg
    .optional()
    .describe(
      'Tunnel lifetime in hours, 1-720 (default 72). 720 = the devbridge 30-day maximum; the keepalive watchdog renews to 720h daily.',
    ),
  keepalive: z
    .boolean()
    .optional()
    .describe(
      'Enroll the tunnel into the keepalive watchdog (default true — pass false to opt out). Returns keepalive.enrolled/tunnelCount/watchdogPid.',
    ),
  workspace_id: workspaceId,
  username,
  timeout_ms: numericArg
    .optional()
    .describe(`Execution timeout in milliseconds (default: ${SANDBOX_TIMEOUT_MS.expose_tunnel})`),
});

export const renewTunnelSchema = z.looseObject({
  tunnel_id: z
    .string()
    .describe(
      "DevBridge tunnel ID to renew (from expose_tunnel's tunnelId field, or extract from the URL https://<tunnel_id>-<port>.devbridge-s2.hwtunnel.com).",
    ),
  expiry_hours: numericArg
    .optional()
    .describe(
      'New lifetime in hours, 1-720 (default 720 = the 30-day maximum). Renewal is a rolling window — the same URL stays alive.',
    ),
  workspace_id: workspaceId,
  username,
  timeout_ms: numericArg
    .optional()
    .describe(`Execution timeout in milliseconds (default: ${SANDBOX_TIMEOUT_MS.renew_tunnel})`),
});

export const keepaliveWatchdogSchema = z.looseObject({
  tunnels: z
    .array(
      z.looseObject({
        tunnel_id: z
          .string()
          .describe('DevBridge tunnel ID (from expose_tunnel or the URL); a camelCase tunnelId key is also accepted.'),
        url: z.string().describe("The tunnel's public URL (from expose_tunnel's publicUrl)."),
      }),
    )
    .min(1)
    .describe(
      'Tunnels for the watchdog to protect: {tunnel_id, url}. Replaces the current list (expose_tunnel MERGES; this tool sets).',
    ),
  workspace_id: workspaceId,
  username,
  timeout_ms: numericArg
    .optional()
    .describe(`Execution timeout in milliseconds (default: ${SANDBOX_TIMEOUT_MS.keepalive_watchdog})`),
});

export const signAgreementSchema = z.looseObject({});

export const connectSchema = z.looseObject({
  vendorConfirmed,
  source: z
    .string()
    .optional()
    .describe('Source identifier (default: WEB). Options: VSCODE, CLI, WEB, WEBVNC, WEBPTY, WEBIDE, CURSOR, etc.'),
  pool_type: z
    .enum(['ephemeral', 'persistent'])
    .optional()
    .describe(
      'Sandbox pool type (default ephemeral). ephemeral = non-persistent: idle auto-shutdown 30min + auto-delete 1h (platform scheduled task, verified) — save important data elsewhere; persistent = data disk retained, idle reclaim within 7 days. Each user may hold one instance per pool type (1+1). Explicit template_id overrides pool_type.',
    ),
  template_id: z.string().optional().describe('Template ID; overrides server default (only for new sandbox)'),
  flavor_id: z.string().optional().describe('Flavor ID; overrides server default (only for new sandbox)'),
  env: looseObject.optional().describe('Environment variables to set in the sandbox (only for new sandbox)'),
  git: gitConfig.optional().describe('Git repo config (only for new sandbox)'),
});

export const credentialsSchema = z.looseObject({
  session_id: z.string().optional().describe('Session ID from huaweicloud_sandbox_connect'),
  dev_stage_id: z.string().optional().describe('DevStation environment ID (alternative to session_id)'),
  enable_sts: z.boolean().optional().describe('Whether to enable STS temporary AK/SK (default: true)'),
  region: z
    .string()
    .optional()
    .describe(
      'Region used for IAM credential validation and project_id resolution (defaults to the configured region)',
    ),
  api_key: z
    .string()
    .optional()
    .describe(
      'DevBridge API Key (devbridge_...), injected into the sandbox as HW_API_KEY for devbridge 0.2.x auth. Also accepts a vault ref (secret://<scope>/<name>), resolved locally so the key never enters the conversation. The local HW_API_KEY environment variable takes precedence over this param (preferred delivery — keeps the long-lived key out of the conversation). Users create one at https://devstation.connect.huaweicloud.com/space/devbridge/apikey (full value shown once at creation). Required for exposing web apps via devbridge 0.2.x; if missing, guide the user through creating one.',
    ),
});
