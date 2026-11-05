import assert from 'node:assert/strict';

import test from 'node:test';

import { _setOneShotForTests, exposeTunnel } from '../plugins/huaweicloud-core/src/sandbox/devbridge-tunnel.ts';

// A2 (#935): the in-script probe retry loop — the LAST probe decides
// reachability; intermediate 502/000 probes are gateway-not-ready noise.

// ── exposeTunnel control flow (via the one-shot seam) ──────────────────────

export const AUTH_FAIL_STDOUT = 'DB_ATTEMPT_KEYRING=no-valid-key\nDB_AUTH_MODE=NO_CREDENTIAL\n';

export function exposeStdout(
  url: string,
  httpCode: string,
  quota = '0',
  body = '',
  expiry = '72',
  migration = '0',
): string {
  return [
    'DB_HOST_LOG=',
    url ? `Tunnel URL: ${url}` : '',
    `DB_TUNNEL_URL=${url}`,
    `DB_HTTP_CODE=${httpCode}`,
    `DB_EXPIRY_HOURS=${expiry}`,
    `DB_TUNNEL_BODY=${body}`,
    `DB_QUOTA_ERROR=${quota}`,
    `DB_MIGRATION=${migration}`,
  ].join('\n');
}

// A2 (#935): probe-laden expose stdout — the reported regression (#935
// report 2 problem 8) fired a reachability warning while the final probe (and
// DB_HTTP_CODE) said 200; the composition through exposeTunnel must not.
export function exposeStdoutWithProbes(url: string, probes: string[], httpCode: string): string {
  return [
    'DB_HOST_LOG=',
    `Tunnel URL: ${url}`,
    ...probes.map((code, i) => `DB_PROBE_${i + 1}=${code}`),
    `DB_TUNNEL_URL=${url}`,
    `DB_HTTP_CODE=${httpCode}`,
    'DB_EXPIRY_HOURS=72',
    'DB_TUNNEL_BODY=',
    'DB_QUOTA_ERROR=0',
  ].join('\n');
}

// The auth-branch boilerplate shared by the A2 seam tests — the pre-existing
// seam tests carry their own baselined copies of this shape. The delegate may
// be async (a throwing verify exec, for instance).
export function withAuthOk(
  delegate: (command: string) => { stdout: string; exitCode: number } | Promise<{ stdout: string; exitCode: number }>,
): OneShotSeam {
  return async (_ws, command) => {
    if (command.includes('DB_AUTH_MODE')) {
      return { stdout: 'DB_AUTH_MODE=API_KEY_KEYRING\n', exitCode: 0 };
    }
    return delegate(command);
  };
}

export function verifyStdout(httpCode: string, notFound = '0'): string {
  return `DB_VERIFY_HTTP_CODE=${httpCode}\nDB_VERIFY_NOT_FOUND=${notFound}\n`;
}

export type OneShotSeam = NonNullable<Parameters<typeof _setOneShotForTests>[0]>;

// Drive exposeTunnel under a one-shot seam with guaranteed teardown — every
// control-flow test composes its matcher and asserts on the result.
// Options are forwarded verbatim — OMITTING them exercises the production
// default (enroll). The legacy expose-mechanics tests below pass an explicit
// { keepalive: false }: their simplistic seams cannot answer the watchdog
// read/install commands. The AUTO-ENROLL, default-omitted, and failure
// behaviors have dedicated tests with keepalive-aware seams.
export async function exposeViaSeam(
  seam: OneShotSeam,
  port: number | string = 8080,
  options?: { keepalive?: boolean },
) {
  _setOneShotForTests(seam);
  try {
    return await exposeTunnel('ws-1', { port, ...options });
  } finally {
    _setOneShotForTests(null);
  }
}

// A seam matcher for the healthy path: auth → expose (200) → verify (200).
// `exposeBody` overrides the probe body echoed in DB_TUNNEL_BODY (app content).
export function healthyOneShot(url: string, verify: string = verifyStdout('200'), exposeBody = ''): OneShotSeam {
  return async (_ws, command) => {
    if (command.includes('DB_AUTH_MODE')) {
      return { stdout: 'DB_AUTH_MODE=API_KEY_KEYRING\n', exitCode: 0 };
    }
    if (command.startsWith('VERIFY_CODE=')) {
      return { stdout: verify, exitCode: 0 };
    }
    return { stdout: exposeStdout(url, '200', '0', exposeBody), exitCode: 0 };
  };
}

// Wrap a seam matcher with first-40-char call recording for order assertions.
export function recordingSeam(base: OneShotSeam): { seam: OneShotSeam; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    seam: (ws, command, user, timeout) => {
      // #999: 120 chars — the data-disk PATH export prefix rides the first
      // line now, pushing the discriminating tokens past the old 40-char window.
      calls.push(command.slice(0, 120));
      return base(ws, command, user, timeout);
    },
  };
}

// ---- #998: devbridge version probe + gate ----

// ---- U16: tunnel persistence (renewal + keepalive watchdog) ----
