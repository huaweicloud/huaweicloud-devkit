import http from 'node:http';
import { appendFileSync } from 'node:fs';

import { scrubSecrets } from '../env-policy.ts';

// The SSE line terminator, pre-encoded: outbound lines join with the exact
// upstream byte rather than a string round-trip.
const NEWLINE = Buffer.from('\n', 'utf8');

// Optional wire dump (E2E_CODEX_PROXY_DUMP=<file>): one JSON line per
// shaped request body, plus one JSON line per complete upstream SSE
// response frame — the diagnostic for model-wire questions. Both halves
// pass scrubSecrets before they are written, and both halves record the
// post-surgery form (the shaped request, the namespace-restored frame —
// what the client actually consumed): the file rides the uploaded
// .e2e-results artifact in CI, and the model key reaches request bodies
// via printenv echoes under the codex leg's inherit-all shell policy, so
// an unscrubbed line would ship a secret. The client stream stays
// byte-identical to upstream except on function_call lines whose namespace
// was restored (multi-byte UTF-8 split across chunk boundaries is
// preserved — every case prompt is Chinese). The response half exists for
// the codex stall forensics (ReasoningRawContentDelta without active item,
// 2026-10-29): the exact upstream frame that trips codex 0.162.1's parser
// is only observable on this wire. Read per request so a value from
// test/e2e/.env (loaded in main, after module evaluation) also works.

// The OpenAI-compatible gateway the E2E model config points at rejects two
// request shapes codex 0.162.1 emits on the responses wire: the `namespace`
// field codex adds to function_call items for MCP-namespaced tools, and the
// array form of function_call_output.output (spike-measured 2026-10-21,
// both 400 invalid_request_error). The proxy strips exactly those two
// shapes and forwards everything else verbatim, so the model wire stays
// faithful apart from the known incompatibilities. If the gateway grows
// full tolerance, the transforms become no-ops and the proxy can retire.
//
// The namespace strip has a response-side mirror (measured 2026-11-03, fork
// run 41636889890, codex leg): codex presents each MCP server as ONE
// namespace tool ({"type":"namespace","name":"mcp__hwc","tools":[...]}) and
// the model must tag every function_call with that namespace. A stripped
// history teaches the model the wrong call shape: when a tool response
// tells the model to retry (the vendor gate's first-assertion challenge —
// "Retry the same call to proceed"), the regenerated call imitates the
// namespace-less items it can see and arrives without a namespace; codex
// then resolves the name in the default namespace, finds nothing, and
// answers "unsupported call: <tool>" without ever dispatching (codex-rs
// registry.rs unsupported_tool_call_message). The wall fired on every
// regenerated call in the run — failing and passing sessions alike
// (core-approval-negative's retry hit it too and passed only because its
// expectations do not need the plan call to succeed). The restore
// re-injects the namespace into function_call items of response frames
// (matching the tool name against the namespace tools of the same
// request), so the round trip codex→strip→model→restore→codex is faithful
// again. Fresh calls already carry the namespace and pass through
// byte-identically.

// The proxy receives the upstream ORIGIN; the request path arrives intact
// because the driver rewrites codex's base_url to
// http://127.0.0.1:<port><pathname-of-real-base> — codex then requests
// <pathname>/responses and origin + req.url reconstructs the real URL.

// Exported for the unit test: pure request-body surgery.
export function shapeForGateway(body: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return body;
  }
  if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { input?: unknown }).input)) {
    for (const item of (parsed as { input: unknown[] }).input) {
      if (item && typeof item === 'object') {
        const record = item as Record<string, unknown>;
        if (record.type === 'function_call') delete record.namespace;
        if (record.type === 'function_call_output' && Array.isArray(record.output)) {
          record.output = (record.output as { text?: unknown }[])
            .map((part) => (part && typeof part.text === 'string' ? part.text : ''))
            .join('');
        }
      }
    }
  }
  return JSON.stringify(parsed);
}

// Tool-name → namespace map for the response-side restore, derived from the
// request's namespace tools: every inner tool of a {"type":"namespace"}
// entry resolves to that entry's name. Names stay out of the map when they
// are ambiguous — a name that ALSO rides a plain function tool (a builtin
// call must not be re-routed into a namespace) or appears as an inner tool
// of TWO namespaces (nothing could pick the right one). The measured wire
// carries neither shape (548 requests in run 41636889890: zero collisions),
// so both rules are construction guarantees, not observed luck.
export function clientToolNamespaces(body: unknown): Map<string, string> {
  const namespaces = new Map<string, string>();
  const tools = (body as { tools?: unknown } | null | undefined)?.tools;
  if (!Array.isArray(tools)) return namespaces;
  const plainFunctionNames = new Set<string>();
  const claimed = new Map<string, string | null>();
  for (const tool of tools) {
    if (!tool || typeof tool !== 'object') continue;
    const entry = tool as { type?: unknown; name?: unknown; tools?: unknown };
    if (typeof entry.name !== 'string') continue;
    if (entry.type !== 'namespace' || !Array.isArray(entry.tools)) {
      plainFunctionNames.add(entry.name);
      continue;
    }
    for (const inner of entry.tools) {
      if (!inner || typeof inner !== 'object') continue;
      const name = (inner as { name?: unknown }).name;
      if (typeof name !== 'string') continue;
      claimed.set(name, claimed.has(name) ? null : entry.name);
    }
  }
  for (const [name, namespace] of claimed) {
    if (namespace !== null && !plainFunctionNames.has(name)) namespaces.set(name, namespace);
  }
  return namespaces;
}

// One response-frame line: re-serialize only when a function_call item
// gained a namespace; every other line returns byte-identical. A null or
// empty namespace is namespace-less as codex experiences it (both resolve
// into the default namespace and miss), so those items are restored too.
// Any parse or walk failure returns the original line — the relay must
// never tear a response down over a transform bug. Multi-line SSE `data:`
// framing (an event's data field split across several data: lines, which
// the parser joins with \n) is NOT restored — the measured gateway frames
// every event single-line (47533/47533 frames in the run-41636889890
// dump), and an unparseable data line simply passes through, so that shape
// degrades to the pre-restore behavior instead of corrupting the stream.
// The `includes('function_call')` fast path shares that degradation class:
// a line whose `type` spelling arrives \u-escaped (no standard serializer
// emits that) skips the restore and relays byte-identically.
export function restoreNamespaces(line: string, namespaces: Map<string, string>): string {
  if (namespaces.size === 0 || !line.includes('function_call')) return line;
  if (!line.startsWith('data:')) return line;
  const rest = line.slice('data:'.length);
  const leadingSpace = rest.startsWith(' ') ? ' ' : '';
  let parsed: unknown;
  try {
    parsed = JSON.parse(leadingSpace ? rest.slice(1) : rest);
  } catch {
    return line;
  }
  try {
    let changed = false;
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) {
        for (const item of value) walk(item);
        return;
      }
      if (!value || typeof value !== 'object') return;
      const record = value as Record<string, unknown>;
      if (
        record.type === 'function_call' &&
        typeof record.name === 'string' &&
        (record.namespace === undefined || record.namespace === null || record.namespace === '') &&
        namespaces.has(record.name)
      ) {
        record.namespace = namespaces.get(record.name);
        changed = true;
      }
      for (const inner of Object.values(record)) walk(inner);
    };
    walk(parsed);
    if (!changed) return line;
    return `data:${leadingSpace}${JSON.stringify(parsed)}`;
  } catch {
    return line;
  }
}

export interface GatewayProxy {
  port: number;
  close(): Promise<void>;
}

interface InFlight {
  controller: AbortController;
}

// One scrubbed response-frame line into the dump. Empty lines (SSE
// separators) are skipped — a frame line is only ever complete.
function appendDumpLine(file: string, line: string): void {
  if (!line) return;
  try {
    appendFileSync(file, JSON.stringify({ frame: scrubSecrets(line) }) + '\n');
  } catch {
    // the dump is best-effort diagnostics
  }
}

export function startGatewayProxy(upstreamOrigin: string): Promise<GatewayProxy> {
  const inFlight = new Set<InFlight>();
  return new Promise((resolveStart, rejectStart) => {
    let listening = false;
    const server = http.createServer((req, res) => {
      void handle(req, res).catch(() => {
        // A proxy bug must never crash the runner: the response is already
        // torn down by its own error path.
      });
    });
    // A pre-listen failure must reject the start promise, not swallow into
    // a forever-pending await that hangs the runner before codex spawns.
    server.on('error', (error) => {
      if (!listening) rejectStart(new Error(`gateway proxy listen failed: ${String(error)}`));
    });

    async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
      const controller = new AbortController();
      const entry: InFlight = { controller };
      inFlight.add(entry);
      // The client dying (case-budget tree kill, codex crash) must abort the
      // upstream pull instead of streaming into a dead socket until close().
      res.on('close', () => controller.abort());
      res.on('error', () => controller.abort());
      try {
        // Buffers are concatenated before decoding: per-chunk string
        // concatenation corrupts multi-byte UTF-8 split across chunk
        // boundaries, and every case prompt is Chinese.
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const body = Buffer.concat(chunks).toString('utf8');
        const headers: Record<string, string> = {};
        for (const [key, value] of Object.entries(req.headers)) {
          if (typeof value === 'string') headers[key] = value;
          else if (Array.isArray(value)) headers[key] = value.join(', ');
        }
        delete headers.host;
        delete headers['content-length'];
        delete headers.connection;
        const shaped = req.method === 'POST' && body ? shapeForGateway(body) : body;
        const dumpFile = process.env.E2E_CODEX_PROXY_DUMP;
        if (dumpFile && shaped) {
          try {
            appendFileSync(dumpFile, scrubSecrets(JSON.stringify({ url: req.url, body: JSON.parse(shaped) })) + '\n');
          } catch {
            // the dump is best-effort diagnostics
          }
        }
        let namespaces = new Map<string, string>();
        if (req.method === 'POST' && shaped) {
          try {
            namespaces = clientToolNamespaces(JSON.parse(shaped));
          } catch {
            // unparseable bodies have no namespace tools to restore
          }
        }
        const upstream = await fetch(`${upstreamOrigin}${req.url}`, {
          method: req.method,
          headers,
          body: req.method === 'GET' || !shaped ? undefined : shaped,
          signal: controller.signal,
        });
        const responseHeaders: Record<string, string> = {};
        upstream.headers.forEach((value, key) => {
          const lower = key.toLowerCase();
          // Undici decodes compressed bodies, so the compressed byte count
          // (and the chunked framing) must not be echoed to the client.
          if (lower !== 'content-encoding' && lower !== 'transfer-encoding' && lower !== 'content-length') {
            responseHeaders[key] = value;
          }
        });
        res.writeHead(upstream.status, responseHeaders);
        if (upstream.body) {
          // The response relay is line-buffered at the BYTE level: SSE lines
          // split at 0x0A are whole multi-byte sequences (UTF-8 continuation
          // bytes are never 0x0A), and a line the transform does not touch
          // relays as its ORIGINAL bytes — byte-identical even if upstream
          // ever sent invalid UTF-8 (a JSON/SSE gateway never does, but the
          // contract does not depend on that). Only a namespace-restored
          // line is decoded, re-serialized, and re-encoded. One res.write
          // per upstream CHUNK (the complete lines it contained, joined):
          // the transform is per-line but the write granularity matches the
          // pre-restore relay — per-frame writes hit a Node writev EINVAL
          // cliff at ~100k queued small chunks under a slow client
          // (interrogate round 2, 8/8 torn vs 0/8 at HEAD), while one write
          // per chunk queues O(chunks) like the verbatim pass-through did.
          // Each complete line reaches the dump in its post-surgery form —
          // what the client consumed, the same contract the request half
          // records.
          let carry = Buffer.alloc(0);
          for await (const chunk of upstream.body) {
            carry = Buffer.concat([carry, chunk as Buffer]);
            const outbound: Buffer[] = [];
            let lineEnd: number;
            while ((lineEnd = carry.indexOf(0x0a)) !== -1) {
              const line = carry.subarray(0, lineEnd);
              carry = carry.subarray(lineEnd + 1);
              const text = line.toString('utf8');
              const out = restoreNamespaces(text, namespaces);
              outbound.push(out === text ? line : Buffer.from(out, 'utf8'));
              outbound.push(NEWLINE);
              if (dumpFile) appendDumpLine(dumpFile, out);
            }
            if (outbound.length) res.write(Buffer.concat(outbound));
          }
          if (carry.length) {
            const text = carry.toString('utf8');
            const out = restoreNamespaces(text, namespaces);
            res.write(out === text ? carry : out);
            if (dumpFile) appendDumpLine(dumpFile, out);
          }
        }
        res.end();
      } catch {
        // Headers-sent guard: writeHead after a flushed response throws
        // ERR_HTTP_HEADERS_SENT, which would otherwise escape as an
        // unhandled rejection and kill the runner mid-suite.
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'gateway proxy upstream error' } }));
        } else {
          res.destroy();
        }
      } finally {
        inFlight.delete(entry);
      }
    }

    server.listen(0, '127.0.0.1', () => {
      listening = true;
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolveStart({
        port,
        close: () => {
          for (const entry of inFlight) entry.controller.abort();
          server.closeIdleConnections();
          return new Promise<void>((resolveClose) => {
            server.close(() => resolveClose());
          });
        },
      });
    });
  });
}
