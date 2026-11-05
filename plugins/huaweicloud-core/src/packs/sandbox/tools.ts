import {
  execWithSessionSchema,
  execOneShotSchema,
  closeSessionSchema,
  uploadFileSchema,
  uploadProjectSchema,
  deployNginxSchema,
  deployCheckSchema,
  checkUserSchema,
  exposeTunnelSchema,
  renewTunnelSchema,
  keepaliveWatchdogSchema,
  signAgreementSchema,
  connectSchema,
  credentialsSchema,
} from './schemas.ts';
import { handleExecWithSession, handleExecOneShot, handleCloseSession } from './handlers-session.ts';
import { handleUploadFile, handleUploadProject } from './handlers-upload.ts';
import { handleDeployNginx, handleDeployCheck } from './handlers-deploy.ts';
import { handleExposeTunnel, handleRenewTunnel, handleKeepaliveWatchdog } from './handlers-tunnel.ts';
import { handleCheckUser, handleSignAgreement, handleConnect } from './handlers-account.ts';
import { handleCredentials } from './handlers-credentials.ts';
import type { PackToolDefinition, LooseToolSchema } from '../../lib/pack-types.ts';

// The sandbox pack's stable face (split from the former 879-line monolith
// for the jscpd complex-file bar, cx < 50 per file; the safety-policy.ts
// precedent — same exported names, same import path, same behavior). It
// holds the SANDBOX_TOOLS / SANDBOX_TOOL_SCHEMAS / SANDBOX_TOOL_HANDLERS
// arrays and their satisfies compile-time completeness checks, and
// re-exports SANDBOX_TIMEOUT_MS; registry.ts, pack.ts, tool-definitions.ts,
// tool-schemas.ts, and the tests keep importing exactly these names from
// here. The family behind it (all siblings inside src/packs/sandbox/,
// joining the pack-boundaries walk automatically): schemas.ts (the zod
// schema block + the timeout table), git-transfer.ts (the repo transfer
// trio), handlers-session.ts / handlers-upload.ts / handlers-deploy.ts /
// handlers-tunnel.ts / handlers-account.ts / handlers-credentials.ts (the
// tool handlers, migrated verbatim from src/tools.ts with the P2 pack
// program).

export { SANDBOX_TIMEOUT_MS } from './schemas.ts';

export const SANDBOX_TOOLS = [
  {
    name: 'huaweicloud_sandbox_exec_with_session',
    description:
      'Execute a command on a workspace terminal with session reuse (state persists across calls). Shell state (cd, env vars, aliases) carries over between calls. Use for interactive work and command sequences that need shared state. NOT for long-running commands (>30s) — prefer exec_one_shot for those.',
    schema: execWithSessionSchema,
    handler: handleExecWithSession,
  },
  {
    name: 'huaweicloud_sandbox_exec_one_shot',
    description:
      'Execute a command on a workspace terminal with a fresh connection per call (no session state carries over). Each invocation opens a new WebSocket connection, executes one command, then disconnects. Use for long-running build/deploy/install commands (>30s) that do not need shell state persistence between calls. More stable than session-based execution for heavy workloads.',
    schema: execOneShotSchema,
    handler: handleExecOneShot,
  },
  {
    name: 'huaweicloud_sandbox_close_session',
    description:
      'Close the persistent terminal session for a workspace. This closes the agent-side terminal session only — it does NOT delete the sandbox instance. Resource-pool sandbox deletion is developer-initiated (always ask for a second confirmation before guiding a delete) or handled by the platform resource-group idle-reclaim policy within the 7-day cap (v3 caliber); devkit never defers or performs deletion on the user behalf.',
    schema: closeSessionSchema,
    handler: handleCloseSession,
  },
  {
    name: 'huaweicloud_sandbox_upload_file',
    description:
      'Upload a local file into the sandbox workspace. Base64-encodes the file, writes it in small chunks through the terminal session (the exec channel is fragile for large single commands), then decodes and verifies the md5 checksum. The remote parent directory is created automatically if absent. Use this instead of embedding large file content directly in a command. local_path must be readable from the machine running the DevKit MCP server — if the file lives elsewhere, copy it to the local temp directory first.',
    schema: uploadFileSchema,
    handler: handleUploadFile,
  },
  {
    name: 'huaweicloud_sandbox_upload_project',
    description:
      'Package a local project directory and upload it to a sandbox workspace via HTTP tunnel. Creates a tar.gz archive, uploads it, and extracts it on the sandbox by default. local_dir must be readable from the machine running the DevKit MCP server — if the project lives elsewhere, copy it to the local temp directory first.',
    schema: uploadProjectSchema,
    handler: handleUploadProject,
  },
  {
    name: 'huaweicloud_sandbox_deploy_nginx',
    description:
      'Deploy an nginx configuration on the sandbox and reload. Takes nginxType, port, project, outputDir from framework detection and writes the correct template (SPA try_files, SSR reverse proxy, or static). Also fixes directory traverse permissions on the project path. Use this instead of manually constructing nginx config — it handles permissions, template selection, and reload in one call. If the requested port is already in use, the actual port is auto-incremented and returned in "port" alongside a warning.',
    schema: deployNginxSchema,
    handler: handleDeployNginx,
  },
  {
    name: 'huaweicloud_sandbox_deploy_check',
    description:
      'Run a deployment completeness check on the sandbox. Verifies nginx is serving, output directory exists, DevBridge tunnel is active and accessible, and QR code exists (cross-platform). Returns a score, nextStep, and (when the DevBridge tunnel is missing) an executable "remediation" command string. Call this at the end of a deployment workflow to confirm everything is working before reporting success.',
    schema: deployCheckSchema,
    handler: handleDeployCheck,
  },
  {
    name: 'huaweicloud_sandbox_expose_tunnel',
    description:
      'Expose a port on the sandbox to a public DevBridge tunnel URL (devbridge 0.2.x). Authenticates automatically (probing AK/SK vs API-Key builds, using /tmp/hw_creds.sh and /tmp/hw_api_key as injected by huaweicloud_sandbox_credentials), pre-cleans stale tunnels to avoid quota errors, starts the host detached from the exec session (setsid/nohup/disown so it survives session teardown), extracts the public URL (https://<id>-<port>.devbridge-s2.hwtunnel.com), and health-checks it before returning. Use the ACTUAL port reported by huaweicloud_sandbox_deploy_nginx (its "port" field auto-increments on conflict) — never the originally requested port. This automates the manual "Expose the deployed app" flow (huawei-sandbox skill). Returns ok, publicUrl, port, tunnelId, authMode, expiresAt (expiry_hours lifetime, default 72h; 1-720), keepalive.enrolled/tunnelCount/watchdogPid, and warnings. AUTO-ENROLLS the tunnel into the keepalive watchdog (unattended renewal + host re-attach + health check; pass keepalive:false to opt out). The URL is re-verified from a second independent exec session: persistent/verifyHttpCode distinguish a session-surviving URL from one that dies with the deploying session, and a non-persistent URL carries a 请勿分享 warning. Gateway-level tunnel errors (404 "tunnel not found" / "port not configured", 502 "bad gateway") are classified by exact body — an app\'s own 404/502 page is never mistaken for them. When no usable URL is reachable after retries it returns ok:false instead of a dead URL. If the API Key is missing on a release build it returns ok:false with instructions to create one.',
    schema: exposeTunnelSchema,
    handler: handleExposeTunnel,
  },
  {
    name: 'huaweicloud_sandbox_renew_tunnel',
    description:
      "Renew a DevBridge tunnel's lifetime (devbridge update <id> -e <hours>) — a ROLLING window: expiration = now + hours regardless of remaining time, so renewing before expiry keeps the SAME public URL alive indefinitely (the URL is bound to the tunnel ID and never changes). Default 720h = the 30-day maximum. Returns ok, tunnelId, expiresAt (absolute ISO timestamp read back via show -v — a management-plane loss (10002 tunnel not found) is NOT misread as success), renewedForHours. Use the tunnelId from huaweicloud_sandbox_expose_tunnel or extract it from the URL. The keepalive watchdog renews automatically; this tool is the manual/one-off path.",
    schema: renewTunnelSchema,
    handler: handleRenewTunnel,
  },
  {
    name: 'huaweicloud_sandbox_keepalive_watchdog',
    description:
      'Install or replace the 3-layer keepalive watchdog for a set of tunnels (the tunnel-persistence pattern): (1) host re-attach — restarts `devbridge host <id>` when the host process dies (URL unchanged); (2) daily renewal — `update <id> -e 720` (29-day failure tolerance); (3) health check — curls each URL every 5 minutes and logs WARN on non-200/304. URLs are hardcoded per tunnel (never derived from port-list output — OSC escapes make those greps fail silently). Replaces the current watchdog (expose_tunnel MERGES into it; this tool SETS the list). Returns ok, scriptPath, logPath, watchdogPid, tunnels. The watchdog lives at /tmp/tunnel-keepalive.sh — cleared on reboot (the tunnel LIST dies with it): re-run this tool with the full list after a reboot (a re-expose enrolls only its own NEW tunnel).',
    schema: keepaliveWatchdogSchema,
    handler: handleKeepaliveWatchdog,
  },
  {
    name: 'huaweicloud_sandbox_check_user',
    description:
      'Check if the current user has completed real-name verification and signed the required agreements. Returns 200 {realnameVerified, agreementSigned} when all good; throws 403 HDKIT_NOT_REALNAME / HDKIT_NOT_AGREEMENT / HDKIT_NOT_REALNAME_AND_AGREEMENT to indicate what is missing. Never signs anything itself.',
    schema: checkUserSchema,
    handler: handleCheckUser,
  },
  {
    name: 'huaweicloud_sandbox_sign_agreement',
    description:
      "Sign all unsigned or outdated agreements for the current user. Required before huaweicloud_sandbox_connect if check-user returns agreementSigned=false. CRITICAL: only call after the user explicitly consents to signing — never sign agreements on the user's behalf without their explicit request.",
    schema: signAgreementSchema,
    handler: handleSignAgreement,
  },
  {
    name: 'huaweicloud_sandbox_connect',
    description:
      'Connect to a sandbox via hdkitservice. One instance per user per pool — reuses the same-pool sandbox if available, otherwise creates a new one. Quota: 1 instance per pool type (a user may hold 1 ephemeral AND 1 persistent simultaneously; same-type requests reuse the existing instance). On quota exhaustion the API returns HTTP 429 with a Retry-After header and a dual error code: HDKIT_QUOTA_EXCEEDED (retry useless — release or reuse the existing instance) vs HDKIT_CAPACITY_INSUFFICIENT (pool capacity; retry later / off-peak). Returns session_id, dev_stage_id, connection_id, connection_address, expiresAt (STS credential expiry), and pool_type/template_id echo. Ephemeral pool (default): idle auto-shutdown after 30min, auto-delete after 1h — do not keep important data there. Persistent pool: data disk retained (EVS 32G), idle reclaim capped at 7 days. Vendor-gated (vendorConfirmed): call only when the vendor is established — see the vendorConfirmed parameter description; when unknown, ask which cloud the user means first.',
    schema: connectSchema,
    handler: handleConnect,
  },
  {
    name: 'huaweicloud_sandbox_credentials',
    description:
      'Configure temporary AK/SK for a sandbox via hdkitservice. Validates the current AK/SK against IAM before injecting (invalid SK is rejected here instead of failing later with APIGW.0301 during exec), then injects temporary credentials into the sandbox. Also injects an optional DevBridge API Key — required for devbridge 0.2.x tunnel exposure because 0.2.x removed AK/SK login. The API Key is a long-lived account-level credential, so it is stored in a separate file (/tmp/hw_api_key, 0600) from the temporary AK/SK (/tmp/hw_creds.sh). Source of truth: local HW_API_KEY env first, then the api_key param. The sandbox must be in RUNNING state.',
    schema: credentialsSchema,
    handler: handleCredentials,
  },
] as const satisfies readonly PackToolDefinition[];

export type SandboxToolName = (typeof SANDBOX_TOOLS)[number]['name'];

// Schema map keyed by tool name for src/tool-schemas.ts: TOOL_SCHEMAS spreads
// it in place, keeping the satisfies Record<ToolName, LooseToolSchema>
// completeness check over every ToolName key.
export const SANDBOX_TOOL_SCHEMAS: Readonly<Record<SandboxToolName, LooseToolSchema>> = {
  huaweicloud_sandbox_exec_with_session: execWithSessionSchema,
  huaweicloud_sandbox_exec_one_shot: execOneShotSchema,
  huaweicloud_sandbox_close_session: closeSessionSchema,
  huaweicloud_sandbox_upload_file: uploadFileSchema,
  huaweicloud_sandbox_upload_project: uploadProjectSchema,
  huaweicloud_sandbox_deploy_nginx: deployNginxSchema,
  huaweicloud_sandbox_deploy_check: deployCheckSchema,
  huaweicloud_sandbox_expose_tunnel: exposeTunnelSchema,
  huaweicloud_sandbox_renew_tunnel: renewTunnelSchema,
  huaweicloud_sandbox_keepalive_watchdog: keepaliveWatchdogSchema,
  huaweicloud_sandbox_check_user: checkUserSchema,
  huaweicloud_sandbox_sign_agreement: signAgreementSchema,
  huaweicloud_sandbox_connect: connectSchema,
  huaweicloud_sandbox_credentials: credentialsSchema,
};

// Dispatch map merged into PACK_TOOL_HANDLERS in packs/registry.ts. Typed over
// SandboxToolName, so a tool added to SANDBOX_TOOLS without a handler entry
// here — or the reverse — fails to compile instead of failing at runtime.
export const SANDBOX_TOOL_HANDLERS: Readonly<Record<SandboxToolName, PackToolDefinition['handler']>> = {
  huaweicloud_sandbox_exec_with_session: handleExecWithSession,
  huaweicloud_sandbox_exec_one_shot: handleExecOneShot,
  huaweicloud_sandbox_close_session: handleCloseSession,
  huaweicloud_sandbox_upload_file: handleUploadFile,
  huaweicloud_sandbox_upload_project: handleUploadProject,
  huaweicloud_sandbox_deploy_nginx: handleDeployNginx,
  huaweicloud_sandbox_deploy_check: handleDeployCheck,
  huaweicloud_sandbox_expose_tunnel: handleExposeTunnel,
  huaweicloud_sandbox_renew_tunnel: handleRenewTunnel,
  huaweicloud_sandbox_keepalive_watchdog: handleKeepaliveWatchdog,
  huaweicloud_sandbox_check_user: handleCheckUser,
  huaweicloud_sandbox_sign_agreement: handleSignAgreement,
  huaweicloud_sandbox_connect: handleConnect,
  huaweicloud_sandbox_credentials: handleCredentials,
};
