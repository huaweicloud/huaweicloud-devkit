// Env-gated JSONL tool-call trace — the agent-level E2E assertion seam.
//
// CONTRACT (frozen; changing any of this is a deliberate edit that must
// update test/call-trace.test.ts in the same change):
//   Env: HUAWEICLOUD_DEVKIT_TRACE=<absolute file path>. Unset = no tracing.
//   Records: one JSON object per line, two discriminated shapes (v: 1):
//     { type: 'toolCall', v: 1, ts, name, args, ok, error? }
//     { type: 'disclosure', v: 1, ts, event: 'toolsList'|'toolsListChanged', toolCount? }
//   Redaction: args pass redactSecrets plus this module's supplemental key
//   denylist (api_key/apiKey) BEFORE the write; credentials never reach the
//   file. error strings are truncated and redacted.
//   Scope: toolCall records only calls that reached callTool's dispatch —
//   SDK-level zod validation rejects a call BEFORE callTool and is
//   deliberately NOT traced (that path is pinned by mcp-server.test.ts).
//   disclosure records are written at the stdio transport's outbound wire
//   face only (notifications/tools/list_changed and tools/list results);
//   the remote HTTP transport does not trace. Recording tools/list_changed
//   proves EMISSION in a live stdio session; delivery/convergence is
//   covered by the in-memory unit tests (packs-configure.test.ts).
//   Failure model: best-effort — a trace write error must never fail a
//   tool call or a transport send.
//   Permissions: the file is created 0600 on first write.

import { appendFileSync, existsSync, writeFileSync } from 'node:fs';

import { redactSecrets } from '../safety-policy.ts';

const TRACE_ENV = 'HUAWEICLOUD_DEVKIT_TRACE';
const TRACE_VERSION = 1;
const MAX_ERROR_LENGTH = 300;

export interface ToolCallTraceRecord {
  type: 'toolCall';
  v: number;
  ts: string;
  name: string;
  args: unknown;
  ok: boolean;
  error?: string;
}

export interface DisclosureTraceRecord {
  type: 'disclosure';
  v: number;
  ts: string;
  event: 'toolsList' | 'toolsListChanged';
  toolCount?: number;
}

export type TraceRecord = ToolCallTraceRecord | DisclosureTraceRecord;

// redactSecrets covers ak/sk/securityToken/token, but the ToolArgs surface
// also carries long-lived keys under api_key / apiKey (sandbox_credentials,
// gateway_call toolArgs) and the secrets pack's set tool carries the
// plaintext itself under value (channel=value) — no other tool schema uses
// that arg name, so the denylist entry is collision-free. Trace redaction
// must be a superset of the product's, so these get their own pass here.
const SUPPLEMENTAL_SECRET_KEYS = new Set(['api_key', 'apikey', 'value']);

function redactSupplemental(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => redactSupplemental(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, val]) => [
        key,
        SUPPLEMENTAL_SECRET_KEYS.has(key.toLowerCase()) ? '<redacted>' : redactSupplemental(val),
      ]),
    );
  }
  return value;
}

export function redactForTrace(args: unknown): unknown {
  return redactSupplemental(redactSecrets(args));
}

export function traceEnabled(): boolean {
  return Boolean(process.env[TRACE_ENV]);
}

function appendRecord(record: TraceRecord): void {
  const path = process.env[TRACE_ENV];
  if (!path) return;
  try {
    const line = `${JSON.stringify(record)}\n`;
    if (existsSync(path)) {
      appendFileSync(path, line, 'utf8');
    } else {
      writeFileSync(path, line, { mode: 0o600, encoding: 'utf8' });
    }
  } catch {
    // best-effort by contract: tracing must never fail a tool call
  }
}

export function recordToolCall(name: string, args: unknown, ok: boolean, error?: unknown): void {
  if (!traceEnabled()) return;
  const record: ToolCallTraceRecord = {
    type: 'toolCall',
    v: TRACE_VERSION,
    ts: new Date().toISOString(),
    name,
    args: redactForTrace(args),
    ok,
  };
  if (error !== undefined) {
    const message = error instanceof Error ? error.message : JSON.stringify(error);
    record.error = String(redactSecrets(message.slice(0, MAX_ERROR_LENGTH)));
  }
  appendRecord(record);
}

export function recordDisclosure(event: 'toolsList' | 'toolsListChanged', toolCount?: number): void {
  if (!traceEnabled()) return;
  const record: DisclosureTraceRecord = {
    type: 'disclosure',
    v: TRACE_VERSION,
    ts: new Date().toISOString(),
    event,
  };
  if (typeof toolCount === 'number') record.toolCount = toolCount;
  appendRecord(record);
}

// Outbound-wire disclosure extraction: called from the stdio transport's
// send() with every outgoing JSON-RPC message. Only disclosure-relevant
// messages produce records — the tools/list result (its .tools array) and
// the tools/list_changed notification.
export function traceOutboundDisclosure(message: unknown): void {
  if (!traceEnabled() || !message || typeof message !== 'object') return;
  const msg = message as { method?: unknown; result?: unknown };
  if (msg.method === 'notifications/tools/list_changed') {
    recordDisclosure('toolsListChanged');
    return;
  }
  const result = msg.result as { tools?: unknown } | undefined;
  if (result && Array.isArray(result.tools)) {
    recordDisclosure('toolsList', result.tools.length);
  }
}
