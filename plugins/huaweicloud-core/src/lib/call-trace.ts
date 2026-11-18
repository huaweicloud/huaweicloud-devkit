// Env-gated JSONL tool-call trace — the agent-level E2E assertion seam.
//
// CONTRACT (frozen; changing any of this is a deliberate edit that must
// update test/call-trace.test.ts in the same change):
//   Env: HUAWEICLOUD_DEVKIT_TRACE=<absolute file path>. Unset = no tracing.
//   Records: one JSON object per line, two discriminated shapes (v: 1):
//     { type: 'toolCall', v: 1, ts, name, args, ok, error? }
//     { type: 'disclosure', v: 1, ts, event: 'toolsList'|'toolsListChanged'|'instructions', toolCount? }
//   Redaction: args pass redactSecrets plus this module's supplemental key
//   denylist (api_key/apiKey) BEFORE the write; credentials never reach the
//   file. error strings are truncated and redacted.
//   Scope: toolCall records only calls that reached callTool's dispatch —
//   SDK-level zod validation rejects a call BEFORE callTool and is
//   deliberately NOT traced (that path is pinned by mcp-server.test.ts).
//   disclosure records are written at the stdio transport's outbound wire
//   face only (the initialize result's instructions, tools/list results,
//   and notifications/tools/list_changed); the remote HTTP transport does
//   not trace. Recording instructions proves the session's first context
//   block carried the load-path teaching; content pins live in the unit
//   tests (mcp-server.test.ts, remote-mcp-server.test.ts). Recording
//   tools/list_changed proves EMISSION in a live stdio session;
//   delivery/convergence is covered by the in-memory unit tests
//   (packs-configure.test.ts).
//   Failure model: best-effort — a trace write error must never fail a
//   tool call or a transport send.
//   Permissions: the file is created 0600 on first write.

import { appendFileSync, existsSync, writeFileSync } from 'node:fs';

import { redactSecrets } from '../safety-policy.ts';
// The supplemental-key pass (api_key/apiKey/value): one shared leaf so
// every redaction consumer — the trace here, the approval gate's pin views —
// runs the same vocabulary.
import { redactWithSupplementalKeys } from './supplemental-redaction.ts';

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
  event: 'toolsList' | 'toolsListChanged' | 'instructions';
  toolCount?: number;
}

export type TraceRecord = ToolCallTraceRecord | DisclosureTraceRecord;

// redactSecrets covers ak/sk/securityToken/token, but the ToolArgs surface
// also carries long-lived keys under api_key / apiKey (sandbox_credentials,
// gateway_call toolArgs) and the secrets pack's set tool carries the
// plaintext itself under value (channel=value) — no other tool schema uses
// that arg name, so the denylist entry is collision-free. Trace redaction
// must be a superset of the product's, so the supplemental keys get their
// own pass (imported above from the shared leaf).
export function redactForTrace(args: unknown): unknown {
  return redactWithSupplementalKeys(redactSecrets(args));
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

export function recordDisclosure(event: 'toolsList' | 'toolsListChanged' | 'instructions', toolCount?: number): void {
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
// messages produce records — the initialize result (when it carries
// server instructions), the tools/list result (its .tools array), and
// the tools/list_changed notification.
export function traceOutboundDisclosure(message: unknown): void {
  if (!traceEnabled() || !message || typeof message !== 'object') return;
  const msg = message as { method?: unknown; result?: unknown };
  if (msg.method === 'notifications/tools/list_changed') {
    recordDisclosure('toolsListChanged');
    return;
  }
  const result = msg.result as { tools?: unknown; serverInfo?: unknown; instructions?: unknown } | undefined;
  if (result && Array.isArray(result.tools)) {
    recordDisclosure('toolsList', result.tools.length);
    return;
  }
  // The initialize result is the only message carrying serverInfo; when it
  // also carries instructions, emission is the disclosure fact worth
  // tracing. An initialize without instructions records nothing — absence
  // is honest, and the content itself is pinned by the unit tests.
  if (result && result.serverInfo && typeof result.instructions === 'string') {
    recordDisclosure('instructions');
  }
}
