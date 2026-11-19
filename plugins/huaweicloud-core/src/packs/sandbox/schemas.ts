import { z } from 'zod';

import {
  HWEXEC_POLL_HEADROOM_MS,
  HWEXEC_TAIL_BYTES_DEFAULT,
  HWEXEC_TAIL_BYTES_MAX,
  HWEXEC_TASK_ID_PATTERN,
  HWEXEC_WAIT_MS_MAX,
} from '../../sandbox/hwexec-task.ts';
import {
  numericArg,
  looseObject,
  gitConfig,
  workspaceId,
  username,
  vendorConfirmed,
  approvalTokenArg,
  approvedByUserArg,
} from '../../lib/tool-schema-parts.ts';
import { EXPOSE_TASK_ID_PATTERN } from './expose-task.ts';

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
  // The async start's exec budget: the start script itself is fast (claim +
  // spawn + receipt echo); a timeout here folds into the 'uncertain'
  // receipt — the claim may have landed, and the same-task_id retry is
  // structurally safe, so the short bound is honest, not lossy.
  exec_one_shot_async: 30000,
  // The poll's exec budget floor: the bounded wait loop (wait_ms, capped at
  // 60000) plus the field round-trips must sit inside the timeout — the
  // handler folds wait_ms + 15000 headroom via resolveHwexecPollTimeoutMs
  // (the devbridge-expose-flow A2 doctrine), never below this floor.
  exec_poll: 30000,
  upload_file: 120000,
  upload_project: 120000,
  deploy_nginx: 60000,
  // Bounded per-tunnel probing can spend up to 5 × 5s of curl alone plus
  // devbridge list round-trips — the probe loop must fit the budget instead
  // of dying as a ws-exec timeout (the pre-probing 30s default did not).
  deploy_check: 60000,
  // The expose script's A2 (#935) bounded waits can spend ~63s in one exec
  // (up to 9s URL-extraction retries + 4 × 10s probes + 3 × 5s backoff) — the
  // headroom exists for the slow-gateway days the probe loop exists for, and
  // a timeout still folds into the structured unreachable envelope (never a
  // raw ws error). The selective pre-clean execs run outside this budget,
  // each with its own bounded one-shot (devbridge-cleanup.ts).
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
  approvalToken: approvalTokenArg,
  approvedByUser: approvedByUserArg,
});

export const execOneShotSchema = z.looseObject({
  command: z.string().describe('The shell command to execute on the remote workspace'),
  mode: z
    .enum(['sync', 'async'])
    .optional()
    .describe(
      'sync (default): this exec waits for the command and returns its output. async: claim a per-task directory and spawn the command detached (it survives the exec session), return {started, taskId, taskDir} immediately, then poll with huaweicloud_sandbox_exec_poll. Use async for build/install-class commands that can outlive the sync timeout. Retry ladder: started:"uncertain" (start exec timed out, the claim may be placed) → retry the SAME task_id — the claim file blocks a second spawn; started:"dup" + verdict "never" → start over with a NEW task_id.',
    ),
  task_id: z
    .string()
    .optional()
    .describe(
      `async mode: the task id to claim, ${HWEXEC_TASK_ID_PATTERN.source} (path- and pgrep-safe). Defaults to a generated id. Reuse the SAME task_id when retrying an uncertain start — the claim file blocks a second copy.`,
    ),
  workspace_id: workspaceId,
  username,
  timeout_ms: numericArg
    .optional()
    .describe(
      `Execution timeout in milliseconds (sync default: ${SANDBOX_TIMEOUT_MS.exec_one_shot}; async bounds only the start exec, default ${SANDBOX_TIMEOUT_MS.exec_one_shot_async} — the async command itself is unbounded and outlives the exec)`,
    ),
  approvalToken: approvalTokenArg,
  approvedByUser: approvedByUserArg,
});

export const execPollSchema = z.looseObject({
  task_id: z
    .string()
    .describe(`The task id from huaweicloud_sandbox_exec_one_shot async mode, ${HWEXEC_TASK_ID_PATTERN.source}.`),
  workspace_id: workspaceId,
  username,
  wait_ms: numericArg
    .optional()
    .describe(
      `Bounded in-poll wait: sleep-2 intervals checking the task status file, 0-${HWEXEC_WAIT_MS_MAX} (default 0 — snapshot only). The exec timeout auto-raises to wait_ms + ${HWEXEC_POLL_HEADROOM_MS} so the wait always fits.`,
    ),
  tail_bytes: numericArg
    .optional()
    .describe(`Log tail size in bytes, 1-${HWEXEC_TAIL_BYTES_MAX} (default: ${HWEXEC_TAIL_BYTES_DEFAULT}).`),
  timeout_ms: numericArg
    .optional()
    .describe(
      `Execution timeout in milliseconds (default: ${SANDBOX_TIMEOUT_MS.exec_poll}; auto-raised to wait_ms + ${HWEXEC_POLL_HEADROOM_MS} headroom, never below the default)`,
    ),
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
  cleanup_mode: z
    .enum(['stale', 'all', 'none'])
    .optional()
    .describe(
      "Tunnel cleanup before exposing. stale (default): delete same-port tunnels + orphan records/hosts; preserve other ports, other sessions and keepalive-protected tunnels — except a tunnel bound to THIS port, which is always replaced. all: wipe every tunnel/host (manual full reset only — a shared sandbox loses every session's tunnels). none: no cleanup (a stale same-port host can then conflict).",
    ),
  mode: z
    .enum(['sync', 'async'])
    .optional()
    .describe(
      'sync (default): run the whole expose chain and return its result. async: start the chain in the background and return ' +
        '{started:true, taskId, hint} immediately — use it on MCP hosts whose per-request timeout is shorter than the expose ' +
        'chain (auth + selective cleanup + up to four ~63s expose attempts + re-verify + keepalive enrollment), then poll ' +
        'huaweicloud_sandbox_expose_poll with taskId. The task receipt lives in this MCP server process (30 min).',
    ),
  workspace_id: workspaceId,
  username,
  timeout_ms: numericArg
    .optional()
    .describe(`Execution timeout in milliseconds (default: ${SANDBOX_TIMEOUT_MS.expose_tunnel})`),
  approvalToken: approvalTokenArg,
  approvedByUser: approvedByUserArg,
});

export const exposePollSchema = z.looseObject({
  task_id: z
    .string()
    .regex(
      EXPOSE_TASK_ID_PATTERN,
      'task_id must be the exp-<uuid> from huaweicloud_sandbox_expose_tunnel mode:"async".',
    )
    .describe('The taskId returned by huaweicloud_sandbox_expose_tunnel with mode:"async".'),
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
  approvalToken: approvalTokenArg,
  approvedByUser: approvedByUserArg,
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
  approvalToken: approvalTokenArg,
  approvedByUser: approvedByUserArg,
});

export const signAgreementSchema = z.looseObject({
  approvalToken: approvalTokenArg,
  approvedByUser: approvedByUserArg,
});

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
      'Sandbox pool type (default ephemeral). ephemeral = non-persistent: idle auto-shutdown 30min + auto-delete 1h (platform scheduled task, verified) — save important data elsewhere; persistent = data disk retained, idle reclaim within 7 days. Each user may hold one instance per pool type (1+1); same-type requests reuse the existing instance. Custom templates are no longer supported.',
    ),
  flavor_id: z.string().optional().describe('Flavor ID; overrides server default (only for new sandbox)'),
  env: looseObject.optional().describe('Environment variables to set in the sandbox (only for new sandbox)'),
  git: gitConfig.optional().describe('Git repo config (only for new sandbox)'),
  approvalToken: approvalTokenArg,
  approvedByUser: approvedByUserArg,
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
  approvalToken: approvalTokenArg,
  approvedByUser: approvedByUserArg,
});

// 关机（dev 5d89c880）：不可逆写类工具，走审批门（always 面）；token 与
// attestation 与其余门面工具同型——schema 可选，门是执行者，首个无 token
// 调用必须能到达门以领取 mint 信封。
export const shutdownSchema = z.looseObject({
  session_id: z.string().optional().describe('Session ID from huaweicloud_sandbox_connect (optional)'),
  dev_stage_id: z.string().optional().describe('DevStation environment ID (alternative to session_id)'),
  workspace_id: z
    .string()
    .optional()
    .describe('Workspace ID; defaults to the current workspace (an alternative to session_id/dev_stage_id)'),
  username,
  approvalToken: approvalTokenArg,
  approvedByUser: approvedByUserArg,
});
