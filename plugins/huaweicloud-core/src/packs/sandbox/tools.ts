import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { mkdirSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';

import {
  execWithSession,
  execOneShot,
  closeSession,
  uploadFileWithSession,
  uploadProjectWithSession,
  deployNginx,
  deployCheck,
  getCurrentWorkspaceId,
  setWorkspaceId,
} from '../../sandbox/session-manager.ts';
import {
  hdkitCheckUser,
  hdkitSignAgreement,
  hdkitConnect,
  hdkitCredentials,
} from '../../lib/hdkit/hdkitservice-api.ts';
import { getCredentials } from '../../lib/hdkit/hwlink-api.ts';
import { validateIamCredentials } from '../../auth/credential-validator.ts';
import { resolveCredentialsWithRuntime } from '../../auth/credentials.ts';
import { asCredentialRecord, type CredentialLike } from '../../lib/credentials.ts';
import { vaultGet, VaultError } from '../../lib/secret-vault/store.ts';
import { isSecretRef } from '../../lib/secret-vault/refs.ts';
import { numericArg, looseObject, gitConfig, workspaceId, username } from '../../lib/tool-schema-parts.ts';
import type { PackToolDefinition, LooseToolSchema } from '../../lib/pack-types.ts';
import type { CallToolOptions, ToolArgs } from '../../tools.ts';

// Handlers migrated verbatim from src/tools.ts; the git repo transfer chain
// (isGitAvailable/gitCloneToLocal/transferGitRepo) is sandbox-specific and
// moved with the connect handler.

// The single source for each tool's timeout default. The zod schema text
// and the handler fallback must agree, and direct callTool callers bypass
// SDK schema application, so the handler fallback stays — both read this.
export const SANDBOX_TIMEOUT_MS = {
  exec_with_session: 120000,
  exec_one_shot: 120000,
  upload_file: 120000,
  upload_project: 120000,
  deploy_nginx: 60000,
  deploy_check: 30000,
} as const;

const execFilePromise = promisify(execFile);

async function isGitAvailable() {
  try {
    await execFilePromise('git', ['--version'], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

async function gitCloneToLocal(repoUrl: string, branch: string | undefined, targetBasename: string) {
  const tempRoot = join(tmpdir(), `hw-sandbox-git-${Date.now()}`);
  const cloneDir = join(tempRoot, targetBasename);
  mkdirSync(tempRoot, { recursive: true });
  const args = ['clone', '--depth', '1'];
  if (branch) args.push('-b', branch);
  args.push(repoUrl, cloneDir);
  await execFilePromise('git', args, { timeout: 120000 });
  return { cloneDir, tempRoot };
}

async function transferGitRepo(args: ToolArgs, devStageId: string, connectResult: Record<string, unknown>) {
  const git = args.git;
  if (!git?.repo_url || !git?.target_path) return;

  const { repo_url, repo_branch, target_path } = git;

  try {
    const existsCheck = await execOneShot(
      devStageId,
      `test -d "${target_path}/.git" && echo "EXISTS" || echo "NOT_EXISTS"`,
      'root',
      10000,
    );
    if (String(existsCheck.stdout || '').includes('EXISTS')) {
      connectResult._repoStatus = 'already_exists';
      return;
    }
  } catch {
    /* 检查失败继续 */
  }

  const hasGit = await isGitAvailable();
  if (hasGit) {
    let tempRoot = null;
    try {
      const targetName = basename(target_path);
      const { cloneDir, tempRoot: root } = await gitCloneToLocal(repo_url, repo_branch, targetName);
      tempRoot = root;
      await uploadProjectWithSession(devStageId, cloneDir, dirname(target_path), 'root', 300000, {
        extract: true,
        exclude: ['.git', 'node_modules'],
      });
      connectResult._repoStatus = 'uploaded_from_local';
      return;
    } catch {
      /* 本地方式失败，进入兜底 */
    } finally {
      if (tempRoot) {
        try {
          rmSync(tempRoot, { recursive: true, force: true });
        } catch {
          /* 清理失败忽略 */
        }
      }
    }
  }

  const branchFlag = repo_branch ? `-b ${repo_branch}` : '';
  await execOneShot(
    devStageId,
    `mkdir -p $(dirname "${target_path}") && git clone --depth 1 ${branchFlag} "${repo_url}" "${target_path}"`,
    'root',
    120000,
  );
  connectResult._repoStatus = 'cloned_in_sandbox';
}

async function handleExecWithSession(args: ToolArgs = {}, _opts: CallToolOptions = {}) {
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
  return { stdout: sandboxResult2.stdout, exitCode: sandboxResult2.exitCode };
}

async function handleExecOneShot(args: ToolArgs = {}, _opts: CallToolOptions = {}) {
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
  return { stdout: sandboxResult3.stdout, exitCode: sandboxResult3.exitCode };
}

async function handleCloseSession(args: ToolArgs = {}, _opts: CallToolOptions = {}) {
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

async function handleUploadFile(args: ToolArgs = {}, _opts: CallToolOptions = {}) {
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

async function handleUploadProject(args: ToolArgs = {}, _opts: CallToolOptions = {}) {
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

async function handleDeployNginx(args: ToolArgs = {}, _opts: CallToolOptions = {}) {
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

async function handleDeployCheck(args: ToolArgs = {}, _opts: CallToolOptions = {}) {
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

async function handleCheckUser(_args: ToolArgs = {}, _opts: CallToolOptions = {}) {
  return await hdkitCheckUser();
}

async function handleSignAgreement(_args: ToolArgs = {}, _opts: CallToolOptions = {}) {
  return await hdkitSignAgreement();
}

async function handleConnect(args: ToolArgs = {}, _opts: CallToolOptions = {}) {
  const connectResult = await hdkitConnect(args);
  const rawDevStageId = connectResult?.dev_stage_id || connectResult?.devStageId;
  const devStageId = typeof rawDevStageId === 'string' ? rawDevStageId : undefined;
  if (devStageId) {
    setWorkspaceId(devStageId);
    try {
      await execOneShot(devStageId, 'devbridge delete-all 2>/dev/null || true', 'root', 15000);
    } catch {
      // best-effort: a fresh sandbox may have no tunnels (or no devbridge) to delete
    }
    try {
      await execWithSession(devStageId, 'export PATH=$HOME/.huawei/bin${PATH:+:$PATH}', 'root', 10000);
    } catch {
      // best-effort: the PATH export only aids later devbridge calls in this session
    }
    await transferGitRepo(args, devStageId, connectResult);
  }
  return connectResult;
}

// POSIX single-quote escaping for every generated export line: vault values
// are arbitrary user strings, and an unescaped `'` in a value would either
// break the sourced script or inject commands into the sandbox shell.
function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function handleCredentials(args: ToolArgs = {}, _opts: CallToolOptions = {}) {
  const devStageId = args.dev_stage_id || getCurrentWorkspaceId();
  let resolved: CredentialLike | null;
  let resolveError: unknown;
  try {
    resolved = asCredentialRecord(resolveCredentialsWithRuntime());
  } catch (error) {
    resolved = null;
    resolveError = error;
  }
  if (!resolved?.ak || !resolved?.sk) {
    // A broken S1 vault link is NOT "not configured" — and the auth init
    // remediation would overwrite the refs with plaintext. Distinguish.
    if (resolveError instanceof VaultError) {
      return {
        ok: false,
        error: `Stored credentials use a secret vault ref that cannot be resolved: ${resolveError.message}`,
        hint: 'Fix the vault (check "npx huaweicloud-devkit secret list" from a terminal; the master key may be missing or rotated) or replace the refs in ~/.config/huaweicloud/credentials.json with plaintext.',
      };
    }
    return {
      ok: false,
      error: 'Huawei Cloud credentials are not configured. Nothing was injected into the sandbox.',
      hint: 'Run "npx huaweicloud-devkit auth init" or set HW_ACCESS_KEY/HW_SECRET_KEY, then retry.',
    };
  }
  const validation = await validateIamCredentials({
    ak: resolved.ak,
    sk: resolved.sk,
    securityToken: resolved.securityToken,
    region: args.region || resolved.region,
  });
  if (!validation.valid && !validation.skipped) {
    return {
      ok: false,
      error: 'Credential validation failed before injection: ' + validation.error,
      hint: 'Credentials were NOT injected into the sandbox. Fix AK/SK first: run "npx huaweicloud-devkit auth init" or correct HW_ACCESS_KEY/HW_SECRET_KEY, then retry.',
    };
  }
  const credResult = await hdkitCredentials(args.session_id, devStageId, args.enable_sts !== false);
  const sandboxWsIdCred = args.dev_stage_id || getCurrentWorkspaceId();
  // The DevBridge API Key is a LONG-LIVED account-level credential (no expiry, manual
  // revocation only) — unlike the temporary STS AK/SK. It is stored in its own file
  // (/tmp/hw_api_key, 0600) so an accidental dump of /tmp/hw_creds.sh never exposes it,
  // and the local HW_API_KEY env takes precedence over the tool param so the key can be
  // delivered without entering the conversation. The param also accepts a vault ref
  // (secret://<scope>/<name>), resolved here so the plaintext stays out of the
  // conversation and out of argv.
  const rawApiKey = process.env.HW_API_KEY || args.api_key || '';
  let apiKey = rawApiKey;
  if (isSecretRef(rawApiKey)) {
    try {
      apiKey = vaultGet(rawApiKey).value;
    } catch (error) {
      return {
        ok: false,
        error: `Cannot resolve the api_key vault ref: ${error instanceof Error ? error.message : String(error)}`,
        hint: 'Check the ref with "npx huaweicloud-devkit secret list" from your terminal, or pass the key via the local HW_API_KEY environment variable.',
      };
    }
  }
  const apiKeyFile = '/tmp/hw_api_key';
  if (sandboxWsIdCred) {
    try {
      const { ak, sk, securitytoken } = getCredentials();
      const credsScript = [
        `export HW_ACCESS_KEY=${shellSingleQuote(ak)}`,
        `export HW_SECRET_KEY=${shellSingleQuote(sk)}`,
        securitytoken ? `export HW_SECURITY_TOKEN=${shellSingleQuote(securitytoken)}` : '',
        securitytoken ? `export X_HW_SECURITY_TOKEN=${shellSingleQuote(securitytoken)}` : '',
        validation.projectId ? `export HW_PROJECT_ID=${shellSingleQuote(validation.projectId)}` : '',
      ]
        .filter(Boolean)
        .join('\n');
      const credsFile = '/tmp/hw_creds.sh';
      // Random per-call heredoc delimiter: vault values are arbitrary user
      // strings, and a fixed delimiter line inside a value would terminate
      // the heredoc early and execute the remainder as root shell commands.
      const credsDelim = `HWCREDS_${randomBytes(8).toString('hex')}`;
      await execOneShot(
        sandboxWsIdCred,
        `cat > ${credsFile} << '${credsDelim}'\n${credsScript}\n${credsDelim}\nchmod 600 ${credsFile}`,
        'root',
        15000,
      );
      await execWithSession(sandboxWsIdCred, `source ${credsFile} && echo "CREDS_SOURCED"`, 'root', 15000);
      if (apiKey) {
        const apiKeyDelim = `HWAPIKEY_${randomBytes(8).toString('hex')}`;
        await execOneShot(
          sandboxWsIdCred,
          `cat > ${apiKeyFile} << '${apiKeyDelim}'\nexport HW_API_KEY=${shellSingleQuote(apiKey)}\n${apiKeyDelim}\nchmod 600 ${apiKeyFile}`,
          'root',
          15000,
        );
      } else {
        // Refresh with no key → drop any stale copy, same semantics as the creds file rewrite.
        await execOneShot(sandboxWsIdCred, `rm -f ${apiKeyFile}`, 'root', 15000);
      }
    } catch {
      // best-effort: the hdkitservice injection already succeeded; the /tmp files only supplement shell access
    }
  }
  const result: Record<string, unknown> = {
    ...credResult,
    credentialValidation: validation.warning ? 'passed-with-warning' : 'passed',
  };
  if (sandboxWsIdCred) result.apiKeyInjected = Boolean(apiKey);
  if (apiKey) {
    result.apiKeyHint =
      'DevBridge API Key written to /tmp/hw_api_key (0600, kept separate from the temporary AK/SK in /tmp/hw_creds.sh — it is a long-lived account-level credential). Release builds of devbridge 0.2.x use it via: source /tmp/hw_api_key && devbridge auth login --api-key "$HW_API_KEY". Image builds retain AK/SK login — the huawei-sandbox skill probes the capability at expose time. Never echo the key into logs.';
  } else {
    result.apiKeyHint =
      'No DevBridge API Key provided — release builds of devbridge 0.2.x cannot log in with AK/SK (image builds retain AK/SK; the huawei-sandbox skill probes the build at expose time and uses the injected AK/SK directly when supported). For release builds, ask the user for an API Key (created at https://devstation.connect.huaweicloud.com/space/devbridge/apikey) and re-run with api_key, or set the local HW_API_KEY environment variable (preferred — keeps the key out of the conversation).';
  }
  if (validation.projectId) result.projectId = validation.projectId;
  if (validation.warning) result.warning = validation.warning;
  if (validation.skipped) result.warning = validation.error;
  return result;
}

const execWithSessionSchema = z.looseObject({
  command: z.string().describe('The shell command to execute on the remote workspace'),
  workspace_id: workspaceId,
  username,
  timeout_ms: numericArg
    .optional()
    .describe(`Execution timeout in milliseconds (default: ${SANDBOX_TIMEOUT_MS.exec_with_session})`),
});

const execOneShotSchema = z.looseObject({
  command: z.string().describe('The shell command to execute on the remote workspace'),
  workspace_id: workspaceId,
  username,
  timeout_ms: numericArg
    .optional()
    .describe(`Execution timeout in milliseconds (default: ${SANDBOX_TIMEOUT_MS.exec_one_shot})`),
});

const closeSessionSchema = z.looseObject({
  workspace_id: workspaceId,
  username,
});

const uploadFileSchema = z.looseObject({
  local_path: z.string().describe('Absolute path to the local file to upload.'),
  remote_path: z.string().describe('Target path in the sandbox, e.g. /workspace/<repo>/index.html.'),
  workspace_id: workspaceId,
  username,
  timeout_ms: numericArg
    .optional()
    .describe(`Execution timeout in milliseconds (default: ${SANDBOX_TIMEOUT_MS.upload_file})`),
});

const uploadProjectSchema = z.looseObject({
  local_dir: z.string().describe('Local project directory to upload.'),
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

const deployNginxSchema = z.looseObject({
  nginx_type: z
    .enum(['spa', 'proxy', 'static'])
    .describe(
      'Nginx config type from framework detection: spa (try_files fallback for SPA/SSG/cross-platform), proxy (reverse proxy for SSR), or static (plain root for Hugo/Hexo).',
    ),
  port: z.number().describe('Listen port (from framework detection).'),
  project: z.string().describe('Project directory name under /workspace, e.g. movie-ticket.'),
  output_dir: z.string().describe('Build output directory relative to /workspace/<project>, e.g. dist/build/h5.'),
  node_port: z.number().optional().describe('Node.js app port for SSR (required when nginx_type=proxy).'),
  public_port: z.number().optional().describe('Public listen port for SSR proxy (optional, defaults to port).'),
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

const deployCheckSchema = z.looseObject({
  port: z.number().describe('App listen port (from framework detection).'),
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

const checkUserSchema = z.looseObject({});

const signAgreementSchema = z.looseObject({});

const connectSchema = z.looseObject({
  source: z
    .string()
    .optional()
    .describe('Source identifier (default: WEB). Options: VSCODE, CLI, WEB, WEBVNC, WEBPTY, WEBIDE, CURSOR, etc.'),
  template_id: z.string().optional().describe('Template ID; overrides server default (only for new sandbox)'),
  flavor_id: z.string().optional().describe('Flavor ID; overrides server default (only for new sandbox)'),
  env: looseObject.optional().describe('Environment variables to set in the sandbox (only for new sandbox)'),
  git: gitConfig.optional().describe('Git repo config (only for new sandbox)'),
});

const credentialsSchema = z.looseObject({
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
    description: 'Close the persistent terminal session for a workspace.',
    schema: closeSessionSchema,
    handler: handleCloseSession,
  },
  {
    name: 'huaweicloud_sandbox_upload_file',
    description:
      'Upload a local file into the sandbox workspace. Base64-encodes the file, writes it in small chunks through the terminal session (the exec channel is fragile for large single commands), then decodes and verifies the md5 checksum. Use this instead of embedding large file content directly in a command.',
    schema: uploadFileSchema,
    handler: handleUploadFile,
  },
  {
    name: 'huaweicloud_sandbox_upload_project',
    description:
      'Package a local project directory and upload it to a sandbox workspace via HTTP tunnel. Creates a tar.gz archive, uploads it, and extracts it on the sandbox by default.',
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
      'Connect to a sandbox via hdkitservice. One user one instance - reuses existing sandbox if available, otherwise creates a new one. Returns session_id, dev_stage_id, connection_id, connection_address, and expiresAt (STS credential expiry).',
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
  huaweicloud_sandbox_check_user: handleCheckUser,
  huaweicloud_sandbox_sign_agreement: handleSignAgreement,
  huaweicloud_sandbox_connect: handleConnect,
  huaweicloud_sandbox_credentials: handleCredentials,
};
