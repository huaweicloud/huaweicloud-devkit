import { spawn, spawnSync } from 'node:child_process';

import { scrubSecrets } from '../env-policy.ts';
import type { RunRequest } from './types.ts';

// The MCP child env loader every env-filtering agent leg uses (codex strips
// MCP children to login vars + the server's config env block; hermes filters
// to the config env block + a safe baseline). The driver writes this script
// next to a per-attempt mcp-env.json and points the agent's server command at
// [loader, server]: the child then runs with {...agent-passed env, ...merged
// case env} — the runner-owned session env (seams, case env, fixed posture,
// shim-first PATH) reaches the server with the loader's extra winning ties.
export const MCP_ENV_LOADER_SOURCE = [
  "import { readFileSync } from 'node:fs';",
  "import { spawn } from 'node:child_process';",
  "import { dirname, join } from 'node:path';",
  'const server = process.argv[2];',
  "const envFile = join(dirname(process.argv[1]), 'mcp-env.json');",
  "const extra = JSON.parse(readFileSync(envFile, 'utf8'));",
  "const child = spawn(process.execPath, [server], { env: { ...process.env, ...extra }, stdio: 'inherit' });",
  // Signal death flattens to exit 0 deliberately: the runner kills the
  // whole detached process group on timeout/abort (bypassing handlers
  // anyway), and MCP clients observe stdio close either way.
  "child.on('exit', (code) => process.exit(code ?? 0));",
  "process.on('SIGTERM', () => child.kill('SIGTERM'));",
  '',
].join('\n');

// Shared driver plumbing. Every driver owns the same agent-independent
// mechanics: a shared model-env requirement vocabulary, a PATH probe, and a
// detached process-group spawn whose whole tree (agent → MCP server → fake
// children) can be torn down on timeout or abort — the RunRequest.signal
// contract every adapter owes. Agent-specific knowledge (config shape,
// invocation flags, final-text extraction) stays in the adapter.

const APIKEY_ENV_VARS = ['E2E_APIKEY', 'E2E_TEST_API_KEY'] as const;

// The env spelling that carries the session key (either is accepted); the
// single resolver every consumer uses so a new spelling cannot drift.
export function apiKeyEnvVar(): string | null {
  for (const key of APIKEY_ENV_VARS) {
    if (process.env[key]) return key;
  }
  return null;
}

// Model and provider stay pinned per run so failures are attributable.
// The key may ride either spelling; the caller resolves which one.
export function requiredModelEnv(): { missing: string[]; apiKeyVar: string } {
  const key = apiKeyEnvVar();
  const apiKeyVar = key ?? 'E2E_APIKEY';
  const missing = ['E2E_PROVIDER_ID', 'E2E_PROVIDER_BASEURL', 'E2E_MODEL'].filter((name) => !process.env[name]);
  if (!key) missing.push(APIKEY_ENV_VARS.join(' or '));
  return { missing, apiKeyVar };
}

export function resolveCommand(name: string): string | null {
  const direct = spawnSync(name, ['--version'], { encoding: 'utf8', timeout: 10_000 });
  if (direct.status === 0 || direct.stdout) return name;
  return null;
}

// Authorized pre-flight of the exact model wire the leg speaks (codex is
// responses-only; opencode rides chat/completions). A dead key, a missing
// route, or an unlisted model otherwise costs a full all-red suite whose
// only signature is a dead agent — measured 2026-10-22 on the CI codex leg
// (zero tool calls, zero agent hcloud calls on every case). Non-2xx, a
// fetch failure, or an SSE error frame in the first chunk fails the probe;
// network errors and 5xx get one retry (a blip at nightly o'clock must not
// void the whole run). Node's global fetch ignores proxy env vars, so the
// probe goes direct — a proxied local network where only proxy-aware agent
// stacks reach the gateway is the accepted false-negative residual.
export interface WireProbeInput {
  baseUrl: string;
  model: string;
  apiKey: string;
  wire: 'responses' | 'chat';
}

export interface WireProbeResult {
  ok: boolean;
  detail: string;
  // Transient classes (network failure, 5xx) earn one retry; a 4xx or an
  // error frame is deterministic and retrying only delays the verdict.
  retryable: boolean;
}

const WIRE_ROUTES: Record<WireProbeInput['wire'], string> = {
  responses: '/responses',
  chat: '/chat/completions',
};

async function probeModelWireOnce(input: WireProbeInput): Promise<WireProbeResult> {
  const route = WIRE_ROUTES[input.wire];
  const url = `${input.baseUrl.replace(/\/+$/, '')}${route}`;
  const body =
    input.wire === 'responses'
      ? JSON.stringify({ model: input.model, input: 'ping', stream: true })
      : JSON.stringify({ model: input.model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${input.apiKey}`, 'Content-Type': 'application/json' },
      body,
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = (await res.text()).slice(0, 200);
      return {
        ok: false,
        retryable: res.status >= 500,
        detail: `HTTP ${res.status} from POST ${route} — ${scrubSecrets(text)}`,
      };
    }
    if (input.wire === 'responses') {
      // Streamed 200 can still open with an error frame (gateway accepted,
      // then rejected auth/model mid-handshake): read the first chunk only.
      const reader = res.body?.getReader();
      if (reader) {
        const { value } = await reader.read();
        const chunk = value ? Buffer.from(value).toString('utf8') : '';
        await reader.cancel().catch(() => {});
        if (chunk.includes('"type":"error"')) {
          return {
            ok: false,
            retryable: false,
            detail: `error frame from POST ${route} — ${scrubSecrets(chunk.slice(0, 200))}`,
          };
        }
      } else {
        await res.body?.cancel().catch(() => {});
      }
      return { ok: true, retryable: false, detail: `model wire verified (HTTP 200, POST ${route})` };
    }
    const payload = (await res.json()) as { error?: unknown };
    if (payload && payload.error !== undefined) {
      return {
        ok: false,
        retryable: false,
        detail: `error body from POST ${route} — ${scrubSecrets(JSON.stringify(payload.error).slice(0, 200))}`,
      };
    }
    return { ok: true, retryable: false, detail: `model wire verified (HTTP 200, POST ${route})` };
  } catch (error) {
    return { ok: false, retryable: true, detail: `request failed: ${String((error as Error)?.message ?? error)}` };
  } finally {
    clearTimeout(timer);
  }
}

export async function probeModelWire(input: WireProbeInput): Promise<WireProbeResult> {
  const first = await probeModelWireOnce(input);
  if (first.ok || !first.retryable) return first;
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  const second = await probeModelWireOnce(input);
  if (second.ok) return second;
  return { ok: false, retryable: false, detail: `${first.detail}; retry: ${second.detail}` };
}

// The leg-facing wrapper every wire consumer uses (both drivers' probe()
// and the runner's mid-suite re-probe): resolves the session env itself so
// the probe call site cannot drift from the key-spelling resolution.
export async function verifyLegWire(wire: WireProbeInput['wire']): Promise<WireProbeResult> {
  const apiKeyVar = apiKeyEnvVar();
  return probeModelWire({
    baseUrl: process.env.E2E_PROVIDER_BASEURL!,
    model: process.env.E2E_MODEL!,
    apiKey: apiKeyVar ? process.env[apiKeyVar]! : '',
    wire,
  });
}

// Detached headless run: capture the streams, resolve on exit, and kill the
// whole process group when the case budget fires or the runner aborts. The
// caller derives finalText from whichever surface its agent exposes.
export function runHeadlessAgent(
  command: string,
  args: string[],
  req: RunRequest,
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveRun) => {
    const child = spawn(command, args, {
      cwd: req.cwd,
      env: req.env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk;
    });
    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveRun({ exitCode, stdout, stderr });
    };
    const timer = setTimeout(() => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        // the tree may already be gone
      }
    }, req.timeoutMs);
    req.signal.addEventListener(
      'abort',
      () => {
        try {
          if (child.pid) process.kill(-child.pid, 'SIGKILL');
        } catch {
          // best-effort tree teardown
        }
      },
      { once: true },
    );
    child.on('error', (err) => {
      stderr += String(err);
      finish(null);
    });
    child.on('close', (code) => finish(code));
  });
}
