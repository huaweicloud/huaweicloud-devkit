import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { classifyHcloudArgs, redactSecrets, assertAllowed } from './safety-policy.mjs';
import { getProxySettings } from './proxy/proxy-config.mjs';
import { resolveHcloudCommand } from './hcloud-probe.mjs';
import { parseStsExpiry, resolveCredentialsWithRuntime } from './auth/credentials.mjs';

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_FORCE_KILL_AFTER_MS = 2_000;
const DEFAULT_MAX_RETRIES = 1;
const APPROVAL_TTL_MS = 5 * 60_000;
const LARGE_OUTPUT_THRESHOLD = 50_000;
const OUTPUT_DIR = join('/tmp', 'huaweicloud-devkit');

// Approval tokens must survive a process boundary: plan and run land in
// different MCP sessions/processes (and headless subprocesses), so the old
// in-memory Map lost the token and plan→approve→run became unreachable (#578).
// Persist to a per-user JSON file as the single source of truth. Only the
// sha256 of the args plus the redacted form are stored — never the raw args,
// which may carry --adminPass / --server.user_data secrets.
function approvalFilePath() {
  return join(process.env.HUAWEICLOUD_HOME || homedir(), '.config', 'huaweicloud', 'approvals.json');
}

function sha256Hex(data) {
  return createHash('sha256').update(data).digest('hex');
}

export function hashArgs(args) {
  return sha256Hex(JSON.stringify(args));
}

function readApprovals() {
  try {
    const path = approvalFilePath();
    if (!existsSync(path)) return {};
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeApprovals(map) {
  try {
    const path = approvalFilePath();
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(map), { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, path);
  } catch {
    // Best-effort: an in-file failure degrades cross-process persistence but a
    // token created/consumed within one process still works.
  }
}

function pruneStale(map, now = Date.now()) {
  let changed = false;
  for (const [key, value] of Object.entries(map)) {
    if (now - value.createdAt > APPROVAL_TTL_MS) {
      delete map[key];
      changed = true;
    }
  }
  return changed;
}

// Approval token lifecycle states, surfaced to callers so they can emit the
// precise JSON contract required by D4-24 (#745):
//   'valid'            — token exists, not expired, not yet consumed
//   'expired'          — token exists but createdAt is past APPROVAL_TTL_MS
//   'already_consumed' — token was consumed on a prior call (tombstone kept)
//   'not_found'        — token was never created (unknown / typo / pruned)
const TOKEN_STATE_VALID = 'valid';
const TOKEN_STATE_EXPIRED = 'expired';
const TOKEN_STATE_ALREADY_CONSUMED = 'already_consumed';
const TOKEN_STATE_NOT_FOUND = 'not_found';

export function createApprovalToken(rawArgs) {
  const token = randomUUID();
  const map = readApprovals();
  map[token] = {
    argsHash: hashArgs(rawArgs),
    argsRedacted: redactSecrets(rawArgs),
    createdAt: Date.now(),
  };
  pruneStale(map);
  writeApprovals(map);
  return token;
}

// Inspect a token's lifecycle state WITHOUT consuming it. Used by
// runApprovedCommand to decide between the 'expired' / 'already_consumed'
// / 'not_found' JSON shapes. A consumed token leaves a tombstone
// ({ consumedAt }) until it ages out past APPROVAL_TTL_MS.
export function inspectApprovalToken(token) {
  const map = readApprovals();
  const entry = map[token];
  if (!entry) return { state: TOKEN_STATE_NOT_FOUND };
  if (entry.consumedAt !== undefined) return { state: TOKEN_STATE_ALREADY_CONSUMED };
  if (Date.now() - entry.createdAt > APPROVAL_TTL_MS) return { state: TOKEN_STATE_EXPIRED };
  return { state: TOKEN_STATE_VALID, entry };
}

// Backward-compatible single-use consume. Returns the stored entry on first
// call, then null. After consumption a tombstone ({ consumedAt }) is written
// so a second call can be distinguished from an unknown token via
// inspectApprovalToken. Kept for existing tests that assert null on reuse.
export function consumeApprovalToken(token) {
  const map = readApprovals();
  const entry = map[token];
  if (!entry) return null;
  if (entry.consumedAt !== undefined) return null;
  if (Date.now() - entry.createdAt > APPROVAL_TTL_MS) {
    delete map[token];
    writeApprovals(map);
    return null;
  }
  // Mark as consumed (tombstone) instead of deleting outright, so a repeat
  // call can be classified as already_processed rather than not_found.
  map[token] = { consumedAt: Date.now(), createdAt: entry.createdAt };
  writeApprovals(map);
  return entry;
}

function saveLargeOutput(rawStdout) {
  if (rawStdout.length <= LARGE_OUTPUT_THRESHOLD) return null;
  try {
    mkdirSync(OUTPUT_DIR, { recursive: true });
    const filePath = join(OUTPUT_DIR, `output-${Date.now()}.json`);
    writeFileSync(filePath, rawStdout, { encoding: 'utf8' });
    return filePath;
  } catch {
    return null;
  }
}

function preflightSecurityGroupCheck(normalizedArgs) {
  const service = normalizedArgs[0];
  const operation = normalizedArgs[1];
  if (service !== 'ECS' || !/CreateServers|RunInstances/i.test(operation)) return [];

  const sgIds = [];
  for (const arg of normalizedArgs) {
    const m = arg.match(/^(?:--security_group_id(?:\.\d+)?|--server\.security_groups(?:\.\d+)?\.id)=(.+)/);
    if (m) sgIds.push(m[1]);
  }
  if (sgIds.length === 0) return [];

  const regionArg = normalizedArgs.find((a) => a.startsWith('--cli-region='));
  const findings = [];
  for (const sgId of sgIds) {
    try {
      const { executable, argsPrefix } = resolveHcloudCommand();
      const spawnArgs = ['VPC', 'ListSecurityGroupRules', `--security_group_id.1=${sgId}`];
      if (regionArg) spawnArgs.push(regionArg);
      const r = spawnSync(executable, [...argsPrefix, ...spawnArgs], {
        shell: false,
        windowsHide: true,
        stdio: 'pipe',
        timeout: 20000,
      });
      const stdout = (r.stdout || '').toString();
      if (r.status !== 0 || !stdout.includes('security_group_rules')) continue;

      const bracketIdx = stdout.indexOf('{');
      const jsonText = bracketIdx >= 0 ? stdout.slice(bracketIdx) : stdout;
      const data = JSON.parse(jsonText);
      const rules = data?.security_group_rules || [];

      for (const rule of rules) {
        const direction = rule.direction || '';
        const remoteIp = rule.remote_ip_prefix || rule.remote_address_group_id || '';
        const portMin = String(rule.port_range_min || rule.multiport || '');
        const portMax = String(rule.port_range_max || rule.multiport || '');
        const protocol = (rule.protocol || '').toLowerCase();
        if (direction !== 'ingress') continue;
        if (remoteIp !== '0.0.0.0/0' && remoteIp !== '::/0') continue;
        if (protocol === 'icmp' || protocol === 'icmpv6') {
          findings.push({
            severity: 'warn',
            title: `Security group ${sgId}: ICMP open to public`,
            message: `安全组 ${sgId} 对公网开放了 ICMP (ping)，可能被用于探测。是否继续？`,
          });
          continue;
        }
        const sensitivePorts = ['22', '3389', '3306', '5432', '6379', '9200', '27017', '8080', '8443'];
        const port = portMin || portMax;
        if (port && sensitivePorts.includes(port)) {
          findings.push({
            severity: 'deny',
            title: `Security group ${sgId}: port ${port} open to public`,
            message: `安全组 ${sgId} 已对公网开放 ${port} 端口（${protocol || 'TCP'}）。确认继续创建 ECS？`,
          });
        }
      }
    } catch (error) {
      // Preflight failed silently; don't block the plan
    }
  }
  return findings;
}

function applyPreflightFindings(classification, sgFindings) {
  if (!sgFindings || sgFindings.length === 0) return classification;
  const hasDeny = sgFindings.some((f) => f.severity === 'deny');
  if (hasDeny) {
    return {
      ...classification,
      decision: 'deny',
      risk: 'public_exposure',
      reason: sgFindings[0].message,
    };
  }
  return classification;
}

const OBS_WRITE_SUBCOMMANDS = new Set(['mb', 'cp', 'mv', 'rm', 'chattri', 'restore']);

function obsWriteHint(args) {
  if (!Array.isArray(args) || args.length < 2) return null;
  if (String(args[0]).toUpperCase() !== 'OBS') return null;
  if (!OBS_WRITE_SUBCOMMANDS.has(String(args[1]).toLowerCase())) return null;
  return 'OBS write operations are obsutil-style and always write-class. Before executing, present the full resource manifest (bucket/object list) to the user for ONE batch approval, then run each command through plan → approve (see huawei-iac skill, Provisioning Rules).';
}

const CATALOG_TTL_MS = 5 * 60 * 1000;
let _catalogCache = { dir: null, t: 0, cn: new Set(), en: new Set() };

export function readServiceCatalogs(metaDir = join(homedir(), '.hcloud', 'metaRepo')) {
  const now = Date.now();
  if (_catalogCache.dir === metaDir && now - _catalogCache.t < CATALOG_TTL_MS) return _catalogCache;
  const load = (f) => {
    try {
      const p = join(metaDir, f);
      if (!existsSync(p)) return { present: false, set: new Set() };
      const d = JSON.parse(readFileSync(p, 'utf8'));
      // Normalize to uppercase on load: catalog entries are mixed-case
      // (DevStar, CloudTable, MapDS, ...) while lookups use uppercase.
      return {
        present: true,
        set: new Set((d.items || []).map((i) => i?.Service?.Text?.toUpperCase()).filter(Boolean)),
      };
    } catch {
      return { present: false, set: new Set() };
    }
  };
  const cn = load('services_cn.json');
  const en = load('services_en.json');
  _catalogCache = { dir: metaDir, t: now, cn: cn.set, en: en.set, cnPresent: cn.present, enPresent: en.present };
  return _catalogCache;
}

export function classifyUnsupported(service, metaDir) {
  const { cn, en, cnPresent, enPresent } = readServiceCatalogs(metaDir);
  const s = String(service || '').toUpperCase();
  if (!s) return 'other';
  if (cnPresent && enPresent) {
    if (cn.has(s) && !en.has(s)) return 'lang-missing';
    if (!cn.has(s) && !en.has(s)) return 'not-found';
    return 'other';
  }
  // One or both catalog files are missing locally — we cannot distinguish
  // "service missing from the en catalog" from "en catalog not downloaded".
  return 'unknown';
}

// Build command-line credential-injection args when the current credentials are
// temporary STS (carry a non-empty security token). KooCLI/obsutil do not read the
// platform-injected HW_* env (link B reads only S2/S3 config), so for a live STS
// credential set that R3 forbids writing to disk, we pass it per-command instead.
// Zero-persist: nothing touches S1/S2/S3 and every invocation re-reads the current
// value (stale as soon as the token is).
// Redact executed args for MCP-visible output. Besides the generic key=value
// redaction (--cli-access-key=...), obsutil-style standalone credential flags
// (-i AK / -k SK / -t TOKEN) carry the temporary STS as following array elements,
// which redactSecrets can't match. We scrub those explicitly.
export function redactArgsWithObs(rawArgs) {
  const arr = Array.isArray(rawArgs) ? rawArgs.map(String) : [];
  const out = [...arr];
  for (let i = 0; i < out.length; i += 1) {
    if (out[i] === '-i' || out[i] === '-k' || out[i] === '-t') {
      if (i + 1 < out.length) out[i + 1] = '<redacted>';
      i += 1;
    } else if (/^-i[A-Za-z0-9]/.test(out[i])) {
      out[i] = '-i<redacted>';
    } else if (/^-k[A-Za-z0-9]/.test(out[i])) {
      out[i] = '-k<redacted>';
    } else if (/^-t[A-Za-z0-9]/.test(out[i])) {
      out[i] = '-t<redacted>';
    }
  }
  return redactSecrets(out);
}

export function resolveStsInjectArgs(rawArgs) {
  const normalized = Array.isArray(rawArgs) ? rawArgs.map(String) : [];
  if (normalized.length === 0) return [];
  const flat = normalized.map(String);

  // Explicit kill-switch (R2): CI/ops can disable argv-injection entirely so the
  // temporary STS never appears in a process list.
  const flag = process.env.HUAWEICLOUD_INJECT_STS_CMD;
  if (flag === '0' || flag === 'false') return [];

  // Never inject for help / metadata subcommands — the flags are meaningless there.
  if (flat.some((a) => a === '--help' || a === '-h' || a === 'help')) return [];

  // Wrapper invocation (bash -c / sudo / sh ...): our extra args would land in the
  // wrapper's argv, not hcloud's — either ineffective or misleading. Skip them.
  const WRAP = new Set([
    'bash',
    'sh',
    'zsh',
    'dash',
    'bash.exe',
    'sh.exe',
    '/bin/bash',
    '/bin/sh',
    '/bin/zsh',
    '/bin/dash',
    'sudo',
  ]);
  const first = String(flat[0] || '').toLowerCase();
  if (WRAP.has(first)) return [];

  // KooCLI profile-management subcommands don't take --cli-security-token.
  if (first === 'configure' || first === 'config') return [];

  // If the caller already passed explicit credential flags, do not override them.
  if (
    flat.some(
      (a) =>
        a.startsWith('--cli-access-key=') || a.startsWith('--cli-secret-key=') || a.startsWith('--cli-security-token='),
    )
  ) {
    return [];
  }
  // Explicit obsutil-style credentials already present — standalone (-i AK) or
  // attached (-iAK) — should not be overridden by an extra injection.
  if (flat.some((a) => a === '-i' || a === '-k' || a === '-t' || /^-[ikt][A-Za-z0-9]/.test(a))) return [];

  let creds;
  try {
    creds = resolveCredentialsWithRuntime({ allowMissing: true });
  } catch {
    return [];
  }
  if (!creds || !creds.ak || !creds.sk || !creds.securityToken) return [];

  // R3: if we can derive an expiry and the token is already at/within 60s of
  // expiring, skip injection — using a dead token would make a doomed IAM round
  // trip. If expiry is unknown/unparseable we keep the existing "inject anyway"
  // behavior (can't prove it's stale).
  const expiry = parseStsExpiry({ securityToken: creds.securityToken });
  if (expiry !== null) {
    const grace = 60 * 1000;
    if (expiry <= Date.now() + grace) return [];
  }

  const isObs = flat[0].toUpperCase() === 'OBS';
  return isObs
    ? ['-i', creds.ak, '-k', creds.sk, '-t', creds.securityToken]
    : ['--cli-access-key=' + creds.ak, '--cli-secret-key=' + creds.sk, '--cli-security-token=' + creds.securityToken];
}

export function planHcloudCommand(args, options = {}) {
  const normalizedArgs = Array.isArray(args) ? args.map(String) : [];
  const classification = classifyHcloudArgs(normalizedArgs, options);
  const command = ['hcloud', ...normalizedArgs].map((arg) => quoteShellArg(arg)).join(' ');
  const warnings = planningWarnings(normalizedArgs);
  const obsHint = obsWriteHint(normalizedArgs);
  if (obsHint) warnings.push(obsHint);
  const sgFindings = preflightSecurityGroupCheck(normalizedArgs);
  if (sgFindings.length > 0) {
    for (const f of sgFindings) warnings.push(f);
  }
  const paramValidation = validateRequiredParams(normalizedArgs);
  if (paramValidation.missing.length > 0) {
    warnings.push('Missing required parameters: ' + paramValidation.missing.join(', '));
    if (paramValidation.hints && paramValidation.hints.length > 0) {
      warnings.push('Find valid values: ' + paramValidation.hints.join('; '));
    }
  }
  return {
    executable: 'hcloud',
    args: redactSecrets(normalizedArgs),
    command: redactOutput(command),
    executableBlock: redactOutput(command),
    warnings,
    classification: applyPreflightFindings(classification, sgFindings),
    sgFindings,
    approvalToken: createApprovalToken(normalizedArgs),
    safeToRun: classification.decision === 'allow',
  };
}

const UNSUPPORTED_SERVICE_RE = /Unsupported service:\s*([A-Za-z0-9_-]+)/i;

function appendLangHint(result, service, metaDir) {
  const cause = classifyUnsupported(service, metaDir);
  if (cause === 'lang-missing' || cause === 'unknown') {
    const nextStep =
      'KooCLI switches language only via global config: hcloud configure set --cli-lang=cn (changes CLI output language; BSS requires Chinese mode).';
    return {
      ...result,
      langCause: cause,
      langHint: `Unsupported service: ${service}. ${nextStep}`,
      langNextStep: nextStep,
    };
  }
  const nextStep = 'Check the service name, or refresh KooCLI metadata (hcloud upgrade / configure).';
  return {
    ...result,
    langCause: cause,
    langHint: `Unsupported service: ${service}. ${nextStep}`,
    langNextStep: nextStep,
  };
}

// Returns true when the current credentials are a TEMPORARY STS set that has
// already expired (per HW_STS_EXPIRES_AT / token expiry). Lets us fail fast with
// a clear CREDENTIAL_EXPIRED instead of letting a doomed IAM call return a
// misleading error. Permanent AK/SK (no token) and unparseable expiry are never
// treated as expired.
function isTemporaryStsExpired() {
  let creds;
  try {
    creds = resolveCredentialsWithRuntime({ allowMissing: true });
  } catch {
    return false;
  }
  if (!creds?.securityToken) return false;
  const expiry = parseStsExpiry({ securityToken: creds.securityToken });
  if (expiry === null) return false; // unknown → don't block
  return expiry <= Date.now();
}

export async function runHcloud(args, options = {}) {
  const normalizedArgs = Array.isArray(args) ? args.map(String) : [];
  const plan = {
    ...planHcloudCommand(normalizedArgs, options),
    rawArgs: normalizedArgs,
  };
  assertAllowed(plan.classification);

  // A: fail fast when the platform-injected temporary STS is already expired —
  // otherwise hcloud would make a doomed IAM round trip and surface a misleading
  // error (e.g. "缺少 cli-domain-id"). Permanent AK/SK are unaffected.
  if (isTemporaryStsExpired()) {
    return {
      ok: false,
      code: 'CREDENTIAL_EXPIRED',
      error:
        'Temporary STS credentials have expired. Re-login or start a new session so the platform injects fresh credentials, then retry.',
      stderr: '',
      stdout: '',
      plan,
    };
  }

  // Link B: when the runtime/environment carries live temporary STS credentials
  // (security token set), KooCLI/obsutil would not see them (they read S2/S3 only
  // and R3 forbids writing them to disk). Inject per-command so hcloud actually
  // authenticates with the platform-provided STS. Injection args are appended to
  // the EXECUTED args only; classification/approval used the original args.
  const stsInject = resolveStsInjectArgs(normalizedArgs);
  if (stsInject.length > 0) {
    plan.rawArgs = [...plan.rawArgs, ...stsInject];
  }

  const metaDir = options.metaDir;

  // KooCLI only switches language globally (`hcloud configure set --cli-lang=cn`); there is no
  // per-command `--cli-lang` flag (it is rejected as "不正确的参数:cli-lang"). So we never mutate
  // the command — we run it as-is and annotate `Unsupported service` with an actionable cause.
  const result = await runHcloudOnceWithRetries(plan, options);
  const text = `${result.stderr || ''}\n${result.stdout || ''}`;
  const match = text.match(UNSUPPORTED_SERVICE_RE);
  if (match && !result.ok) {
    return appendLangHint(result, match[1], metaDir);
  }
  return result;
}

async function runHcloudOnceWithRetries(plan, options) {
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const result = await runHcloudOnce(plan, options);
    if (result.ok || attempt >= maxRetries || !isRetryableNetworkError(result)) {
      const merged = {
        ...result,
        ok: result.ok ?? false,
        exitCode: result.exitCode ?? null,
        retries: attempt,
        attempts: attempt + 1,
      };
      if (merged.ok) {
        const warning = await runtimeCurrentMismatchWarning();
        return warning ? { ...merged, authWarning: warning } : merged;
      }
      return merged;
    }
    await wait((options.retryBaseDelayMs ?? 500) * 2 ** attempt);
  }
  throw new Error('Unreachable retry state.');
}

async function runtimeCurrentMismatchWarning() {
  try {
    const { hasRuntimeCredentials, scanState } = await import('./auth/reconcile.mjs');
    if (!hasRuntimeCredentials()) return null;
    const scan = scanState();
    const { runtimeFingerprint, currentFingerprint } = scan.stores;
    if (runtimeFingerprint && currentFingerprint && runtimeFingerprint !== currentFingerprint) {
      return '会话内临时账号与 KooCLI current 档不一致：hcloud 命令仍使用 current 档账号。如需对齐请用 huaweicloud_auth_switch action=persist。';
    }
    return null;
  } catch {
    // reconcile unavailable → no warning, never block the command
    return null;
  }
}

function runHcloudOnce(plan, options) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const forceKillAfterMs = options.forceKillAfterMs ?? DEFAULT_FORCE_KILL_AFTER_MS;
  const { executable: resolvedExec, argsPrefix } = resolveHcloudCommand({
    executable: options.executable || options.env?.HCLOUD_BIN,
    executableArgs: options.executableArgs,
  });
  const executable = resolvedExec || 'hcloud';
  const executableArgs = argsPrefix;
  const cwd = options.cwd || undefined;
  const stdin = options.stdin ?? 'y\n';
  const childOptions = { ...options };
  delete childOptions.metaDir;
  const childEnv = { ...process.env, ...childOptions.env };

  return new Promise((resolve) => {
    const proxySettings = getProxySettings();
    const proxyEnv = {};
    if (proxySettings) {
      if (proxySettings.https_proxy) proxyEnv.HTTPS_PROXY = proxySettings.https_proxy;
      if (proxySettings.http_proxy) proxyEnv.HTTP_PROXY = proxySettings.http_proxy;
      if (proxySettings.no_proxy) proxyEnv.NO_PROXY = proxySettings.no_proxy;
    }
    const child = spawn(executable, [...executableArgs, ...plan.rawArgs], {
      shell: false,
      windowsHide: true,
      cwd,
      env: {
        ...process.env,
        ...proxyEnv,
        ...childEnv,
      },
    });
    if (stdin) {
      if (typeof stdin === 'function') {
        stdin(child.stdin);
      } else {
        child.stdin.write(String(stdin));
        child.stdin.end();
      }
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let forceTimer;
    let settleTimer;

    function finish(result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(forceTimer);
      clearTimeout(settleTimer);
      if (result.stdout && String(result.stdout).length > LARGE_OUTPUT_THRESHOLD) {
        const outputFile = saveLargeOutput(stdout);
        if (outputFile) {
          result.outputFile = outputFile;
          result.stdout = String(result.stdout).slice(0, 2000) + `\n...(truncated, full output saved to ${outputFile})`;
        }
      }
      // Never surface raw args (may include the injected temporary STS) to MCP
      // clients / agent conversation — redact before resolve. The live `plan`
      // object itself is left untouched so retries keep executing the real args.
      if (result.plan && Array.isArray(result.plan.rawArgs)) {
        const redactedPlan = { ...result.plan, rawArgs: redactArgsWithObs(result.plan.rawArgs) };
        result.plan = redactedPlan;
      }
      resolve(result);
    }

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      forceTimer = setTimeout(() => child.kill('SIGKILL'), forceKillAfterMs);
      settleTimer = setTimeout(() => {
        finish({
          ok: false,
          code: 'TIMEOUT',
          error: `hcloud command timed out after ${timeoutMs} ms.`,
          exitCode: null,
          signal: null,
          stdout: redactOutput(stdout),
          stderr: redactOutput(stderr),
          plan,
        });
      }, forceKillAfterMs + 500);
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      finish({
        ok: false,
        code: 'SPAWN_ERROR',
        error: error.message,
        exitCode: null,
        signal: null,
        plan,
      });
    });
    child.on('close', (code, signal) => {
      if (timedOut) {
        finish({
          ok: false,
          code: 'TIMEOUT',
          error: `hcloud command timed out after ${timeoutMs} ms.`,
          exitCode: code,
          signal,
          stdout: redactOutput(stdout),
          stderr: redactOutput(stderr),
          plan,
        });
        return;
      }
      const apiError = extractApiError(stdout);
      if (apiError) {
        finish({
          ok: false,
          exitCode: code,
          signal,
          errorCode: apiError.errorCode,
          errorMessage: apiError.errorMessage,
          stdout: redactOutput(stdout),
          stderr: redactOutput(stderr),
          plan,
        });
        return;
      }
      // #921: the ok verdict converges on the exit code plus structured error
      // parsing (errorCode-first, handled above). Two false-positive classes
      // are closed here:
      //   1. exit code 0 but the output carries a KooCLI parameter error (e.g.
      //      `--delete_ip` instead of `--delete_publicip`) — the command never
      //      executed; report ok:false with a PARAM_ERROR errorCode.
      //   2. non-zero exit code with "successfully" in the output — the old
      //      broad regex flagged ANY failure mentioning "successfully". It is
      //      narrowed to OBS obsutil-style commands (which are known to return
      //      non-zero exit codes on success, #57) AND require the output to
      //      carry no error indicators.
      const combined = `${stdout}${stderr}`;
      const paramError = combined.match(
        /\[?(?:ERROR|USE_ERROR)\]?[: ]*(?:unknown parameter|unknown option|incorrect (?:option|switch|parameter)|invalid (?:parameter|argument)|参数不存在|参数错误|无效的参数)[^\n]*/i,
      );
      if (paramError) {
        finish({
          ok: false,
          exitCode: code,
          signal,
          errorCode: 'PARAM_ERROR',
          errorMessage: paramError[0].trim(),
          stdout: redactOutput(stdout),
          stderr: redactOutput(stderr),
          plan,
        });
        return;
      }
      const isObsCommand = /^obs\b/i.test(String(plan.rawArgs?.[0] || ''));
      const successText = /successfully/i.test(combined);
      const errorIndicators = /error|failed|失败|invalid|not found|denied|拒绝/i.test(combined);
      finish({
        ok: code === 0 || (isObsCommand && successText && !errorIndicators),
        exitCode: code,
        signal,
        stdout: redactOutput(stdout),
        stderr: redactOutput(stderr),
        plan,
      });
    });
  });
}

function isRetryableNetworkError(result) {
  if (result.code === 'TIMEOUT') return false;
  const text = `${result.error || ''}\n${result.stdout || ''}\n${result.stderr || ''}`;
  return /\[NETWORK_ERROR\]|connection timed out|ECONNRESET|ETIMEDOUT|temporary failure|TLS handshake timeout/i.test(
    text,
  );
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function quoteShellArg(value) {
  const text = String(value);
  if (!text) return '""';
  if (/^[A-Za-z0-9_./:=@-]+$/.test(text)) return text;
  return `"${text.replace(/(["\\])/g, '\\$1')}"`;
}

function planningWarnings(args) {
  const joined = args.join(' ');
  const warnings = [];
  if (/admin[_-]?pass|password|passwd|secret|token/i.test(joined)) {
    warnings.push(
      'This command appears to contain a password or secret field. Do not leave plaintext secrets in shell history; prefer local-only input or a runtime injection pattern.',
    );
  }
  return warnings;
}

const REQUIRED_PARAMS = {
  'ECS CreateServers': ['server.flavorRef', 'server.imageRef', 'server.nics.1.subnet_id'],
  'VPC CreateVpc': ['vpc.cidr'],
  'VPC CreateSubnet': ['subnet.vpc_id', 'subnet.cidr'],
  'VPC CreateSecurityGroupRule': [
    'security_group_rule.security_group_id',
    'security_group_rule.direction',
    'security_group_rule.protocol',
  ],
  'EIP CreatePublicip': ['bandwidth.share_type', 'publicip.type'],
  'FunctionGraph CreateFunction': ['func_name', 'runtime', 'handler', 'memory_size', 'package', 'timeout'],
  'FunctionGraph CreateFunctionTrigger': ['function_urn', 'trigger_type_code'],
  'APIG CreateInstanceV2': ['spec_id'],
  'OBS mb': ['obs://'],
  'OBS rm': ['obs://'],
};

const PARAM_VALUE_HINTS = {
  'server.flavorRef': 'Run `hcloud ECS ListFlavors --cli-region=<r>` to find valid flavors',
  'server.imageRef': 'Run `hcloud IMS ListImages --cli-region=<r> --__imagetype=gold` to find valid image IDs',
  'server.nics.1.subnet_id': 'Run `hcloud VPC ListSubnets --cli-region=<r>` to find subnet IDs',
  'subnet.vpc_id': 'Run `hcloud VPC ListVpcs --cli-region=<r>` to find VPC IDs',
  func_name: 'Function name must be unique within project',
  runtime: 'Run `hcloud FunctionGraph ListRuntimes` to see available runtimes',
  spec_id: 'APIG spec: BASIC (no public IP) or PROFESSIONAL (requires --loadbalancer_provider)',
  'obs://': 'Bucket name must be globally unique and DNS-compliant (lowercase, numbers, hyphens only)',
};

function validateRequiredParams(args) {
  if (!args || args.length < 2) return { valid: true, missing: [], hints: [] };
  const key = `${args[0]} ${args[1]}`;
  const required = REQUIRED_PARAMS[key];
  if (!required) return { valid: true, missing: [], hints: [] };
  const argsStr = args.join(' ');
  const missing = required.filter((param) => !argsStr.includes(param));
  const hints = missing.map((param) => PARAM_VALUE_HINTS[param]).filter(Boolean);
  return { valid: missing.length === 0, missing, hints };
}

export function extractApiError(stdout) {
  let text = String(stdout || '');
  // Strip KooCLI multi-version prefix lines (e.g. "ListVpcs有多个版本,默认使用该API版本v3…")
  const bracketIdx = text.indexOf('{');
  if (bracketIdx > 0) text = text.substring(bracketIdx);
  try {
    const parsed = JSON.parse(text);
    if (parsed.error_code || parsed.errorCode) {
      return {
        errorCode: parsed.error_code || parsed.errorCode || 'UNKNOWN',
        errorMessage: parsed.error_msg || parsed.errorMsg || parsed.message || '',
      };
    }
    if (parsed.error && typeof parsed.error === 'object') {
      return {
        errorCode: parsed.error.code || parsed.error.error_code || 'UNKNOWN',
        errorMessage: parsed.error.message || parsed.error.error_msg || '',
      };
    }
  } catch {}
  const ecMatch = text.match(/"error_code"\s*:\s*"([^"]+)"/);
  const emMatch = text.match(/"error_msg"\s*:\s*"([^"]+)"/);
  if (ecMatch) {
    return { errorCode: ecMatch[1], errorMessage: emMatch ? emMatch[1] : '' };
  }
  return null;
}

// A4 (#935): KooCLI 7.2.x prints a version-upgrade banner on EVERY command
// output (e.g. 「可执行 hcloud update 更新至 7.3.12」), which floods agent
// conversations and drowns the actual result. Banner lines are stripped from
// command output here; the only upgrade hint DevKit emits is check_cli/doctor's
// soft, one-shot mismatch hint — kooCliVersion in package.json is the single
// source of truth for the paired version, and check_cli/doctor keep their
// non-blocking semantics.
export function stripKooCliUpdateBanner(output) {
  return String(output || '')
    .split('\n')
    .filter((line) => !(/hcloud\s+update/i.test(line) && /更新至|update to/i.test(line)))
    .join('\n');
}

export function redactOutput(output) {
  let text = stripKooCliUpdateBanner(String(output || ''));
  const bracketIdx = text.indexOf('{');
  if (bracketIdx > 0) text = text.substring(bracketIdx);
  try {
    return JSON.stringify(redactSecrets(JSON.parse(text)), null, 2);
  } catch {
    return redactSecrets(text);
  }
}
