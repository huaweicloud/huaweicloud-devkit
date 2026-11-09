// The single-execution hcloud child supervisor, extracted from the
// hcloud-cli monolith's run engine (the retrying orchestrator lives in
// hcloud-run.ts; the stable src/hcloud-cli.ts face re-exports only the
// orchestrator's names): one spawn with the prober's executable
// resolution, the proxy env assembly, stdin plumbing, SIGTERM→SIGKILL
// timeout escalation, large-output save, result redaction, and the #921
// ok-gate over child output.

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { getProxySettings } from './proxy/proxy-config.ts';
import { resolveHcloudCommand } from './hcloud-probe.ts';
import { stripKooCliUpdateBanner } from './koocli-version.ts';
import { extractApiError, redactOutput } from './hcloud-api-error.ts';
import { redactArgsWithObs } from './hcloud-obs-redact.ts';
import type { HcloudPlanWithArgs } from './hcloud-plan.ts';
import type { HcloudRunOptions, HcloudRunResult } from './hcloud-run.ts';

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_FORCE_KILL_AFTER_MS = 2_000;
const LARGE_OUTPUT_THRESHOLD = 50_000;
const OUTPUT_DIR = join('/tmp', 'huaweicloud-devkit');

function saveLargeOutput(rawStdout: string): string | null {
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

// Consumed by the retrying orchestrator (hcloud-run.ts); not part of the
// face's public surface.
export function runHcloudOnce(plan: HcloudPlanWithArgs, options: HcloudRunOptions): Promise<HcloudRunResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const forceKillAfterMs = options.forceKillAfterMs ?? DEFAULT_FORCE_KILL_AFTER_MS;
  // One resolution chain with the prober (hcloud-probe's resolveHcloudCommand
  // over the shared lib/dep-resolve tier order): options.env is child
  // environment, never an executable override, and HCLOUD_BIN_ARGS_JSON is
  // honored here exactly as the prober honors it.
  const { executable, argsPrefix } = resolveHcloudCommand({
    executable: options.executable,
    executableArgs: options.executableArgs,
  });
  const executableArgs = argsPrefix.map(String);
  const cwd = options.cwd || undefined;
  const stdin = options.stdin ?? 'y\n';
  const childOptions: HcloudRunOptions = { ...options };
  delete childOptions.metaDir;
  const childEnv = { ...process.env, ...childOptions.env };

  return new Promise<HcloudRunResult>((resolve) => {
    const proxySettings = getProxySettings();
    const proxyEnv: Record<string, string> = {};
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
        // A child that exits without reading stdin (obsutil early-exit paths,
        // test binaries) makes this write fail with EPIPE; an unhandled
        // 'error' event on the pipe used to crash the whole MCP process
        // (2026-11-05 UX probe). The command result still resolves through
        // the child's close/error handlers — only the dead pipe is ignored.
        child.stdin.on('error', () => {});
        child.stdin.write(String(stdin));
        child.stdin.end();
      }
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let forceTimer: NodeJS.Timeout | undefined;
    let settleTimer: NodeJS.Timeout | undefined;

    function finish(result: HcloudRunResult): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(forceTimer);
      clearTimeout(settleTimer);
      if (result.stdout && String(result.stdout).length > LARGE_OUTPUT_THRESHOLD) {
        // A4 (#935): the raw accumulator still carries the banner — the saved
        // file is agent-read (the truncated stdout points at it), so the strip
        // must apply here too, not only to the in-band redacted stdout.
        const outputFile = saveLargeOutput(stripKooCliUpdateBanner(stdout));
        if (outputFile) {
          result.outputFile = outputFile;
          result.stdout = String(result.stdout).slice(0, 2000) + `\n...(truncated, full output saved to ${outputFile})`;
        }
      }
      // Never surface raw args (may include the injected temporary STS) to MCP
      // clients / agent conversation — redact before resolve. The live `plan`
      // object itself is left untouched so retries keep executing the real args.
      if (result.plan && Array.isArray(result.plan.rawArgs)) {
        const redactedPlan: HcloudPlanWithArgs = {
          ...result.plan,
          rawArgs: redactArgsWithObs(result.plan.rawArgs),
        };
        result.plan = redactedPlan;
      }
      resolve(result);
    }

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      forceTimer = setTimeout(() => child.kill('SIGKILL'), forceKillAfterMs);
      settleTimer = setTimeout(() => {
        // Same shape the close-path TIMEOUT and SPAWN_ERROR results carry:
        // exitCode/signal are always present (null when unknown — the child
        // never reported a close event on this backstop path).
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

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
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
      // #921: two ok-gate holes that surfaced from live testing are closed here:
      //   1. exit code 0 but the output carries a KooCLI parameter error (e.g.
      //      `--delete_ip` instead of `--delete_publicip`) — the command never
      //      executed; report ok:false with a PARAM_ERROR errorCode.
      //   2. non-zero exit code with "successfully" in the output — the old
      //      broad regex flagged ANY failure mentioning "successfully". It is
      //      narrowed to OBS obsutil-style commands (which are known to return
      //      non-zero exit codes on success, #57) AND require the output to
      //      carry no error indicators.
      const combined = `${stdout}${stderr}`;
      // #921 (loop rounds 2-11): KooCLI's parameter-complaint shapes exit 0
      // (`[USE_ERROR]参数ls的格式错误,正确格式为:--param=value`, the
      // doubled-hcloud input from UX report #6; the English marker family
      // `[ERROR]: unknown option …`). BOTH families anchor the marker at
      // the FIRST line of the meaningful output (post-banner stdout;
      // stderr only when stdout is empty).
      // DOCUMENTED TRADE-OFF (loop round 12, seat-1 B1 / seat-2): a
      // successful payload whose FIRST LINE opens with a historical
      // USE_ERROR line (an OBS cat of a one-line error log) is
      // indistinguishable from the real failure by shape alone and IS
      // reported as PARAM_ERROR; multi-line payloads (first line anything
      // else) keep ok:true. The alternative — requiring the whole output to
      // be one line — misses real errors that print usage/help after the
      // marker, the worse direction. Comment promised fixed; anchor kept.
      const useErrorSource = stripKooCliUpdateBanner(stdout).trim() || stderr.trim();
      const useErrorFormatError = useErrorSource.match(/^\[?USE_ERROR\]?\s*参数\S*的格式错误[^\n]*$/i);
      const useErrorMarked = useErrorSource.match(
        /^\[?(?:ERROR|USE_ERROR)\]?[: ]*(?:unknown parameter|unknown option|incorrect (?:option|switch|parameter)|invalid (?:parameter|argument)|参数不存在|参数错误|无效的参数|缺少必填参数|不正确的参数|不支持的服务名称|Unsupported service|The following parameters are required|[^\n]{0,40}?parameter format must be|format must be)[^\n]*/i,
      );
      const paramError = useErrorMarked ?? useErrorFormatError;
      if (paramError) {
        finish({
          ok: false,
          exitCode: code,
          signal,
          errorCode: 'PARAM_ERROR',
          errorMessage: paramError[0]?.trim() ?? '',
          stdout: redactOutput(stdout),
          stderr: redactOutput(stderr),
          plan,
        });
        return;
      }
      const isObsCommand = /^obs\b/i.test(String(plan.rawArgs?.[0] || ''));
      const successText = /successfully/i.test(combined);
      // Zero-count summaries are not errors: obsutil batch output routinely
      // prints "Failed count: 0" / "失败数量: 0" lines even on full success —
      // strip them before scanning for real error indicators.
      const summaryText = combined.replace(/(?:failed|失败)(?:\s*(?:count|数量)?\s*[:=]?\s*0)\b/gi, '');
      const errorIndicators = /error|failed|失败|invalid|not found|denied|拒绝/i.test(summaryText);
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
