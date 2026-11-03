import http from 'node:http';
import { appendFileSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

import { scrubSecrets } from '../env-policy.ts';

// Optional wire dump (E2E_CODEX_PROXY_DUMP=<file>): one JSON line per
// shaped request body, plus one JSON line per complete SSE response frame
// as delivered to the client (post-rewrite — see the repair below) — the
// diagnostic for model-wire questions. Both halves pass scrubSecrets
// before they are written: the file rides the uploaded .e2e-results
// artifact in CI, and the model key reaches request bodies via printenv
// echoes under the codex leg's inherit-all shell policy, so an unscrubbed
// line would ship a secret. The response half exists for the codex stall
// forensics (ReasoningRawContentDelta without active item, 2026-10-29):
// the exact frame that trips codex 0.162.1's parser is only observable on
// this wire. Read per request so a value from test/e2e/.env (loaded in
// main, after module evaluation) also works.

// The OpenAI-compatible gateway the E2E model config points at rejects two
// request shapes codex 0.162.1 emits on the responses wire: the `namespace`
// field codex adds to function_call items for MCP-namespaced tools, and the
// array form of function_call_output.output (spike-measured 2026-10-21,
// both 400 invalid_request_error). The proxy strips exactly those two
// shapes and forwards everything else verbatim, streaming SSE straight
// through, so the model wire stays faithful apart from the two known
// incompatibilities. If the gateway grows full tolerance, the transforms
// become no-ops and the proxy can retire.
//
// The third, response-side repair (measured on the 2026-11-03 nightly, run
// 41636889890): the gateway's output function_call items only sometimes
// carry the `namespace` field (61 of 226 huaweicloud tool emissions in the
// codex wire dump), while codex dispatches MCP tools ONLY through the
// namespace field — build_tool_call derives the ToolName from the item's
// namespace, with no flat-name fallback, and a missing namespace lands the
// call in the default "functions" namespace where the registry lookup
// fails ("unsupported call: <name>", the registry.rs miss arm). The
// request-side strip above feeds this: every history function_call the
// model sees is flat, so it imitates the flat shape on later calls — the
// vendor-challenge retry in particular. The proxy therefore re-attaches
// the namespace to response.output_item.done function_call items whose
// name resolves unambiguously against the namespaces the request's tools
// declared. The done item is the dispatch source (client.rs +
// stream_events_utils.rs feed build_tool_call from OutputItemDone), so
// rewriting that one frame is sufficient. The dump records the rewritten
// line — the wire codex actually received, which is the shape triage of
// dispatch failures needs; every other frame stays byte-identical to
// upstream.
//
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

// The namespace index one request's tools declaration yields: which flat
// function names belong to which namespace, and which names the request
// also declared as top-level (default-namespace) functions. A flat name
// shadowed by a top-level function, or claimed by two namespaces, is not
// rewritten — those dispatch fine flat or are genuinely ambiguous, and a
// wrong attachment would misroute a call that codex could have resolved.
export interface NamespaceIndex {
  flatTools: ReadonlySet<string>;
  toolNamespaces: ReadonlyMap<string, string>;
}

// A fresh empty index per call: the empty case is also the proxy's initial
// state, so a shared mutable instance would let one consumer's mutation
// (a future refactor handing the index out for writing) corrupt every
// later proxy's starting point.
const emptyIndex = (): NamespaceIndex => ({ flatTools: new Set(), toolNamespaces: new Map() });

export function indexNamespaceDecls(parsed: unknown): NamespaceIndex {
  const tools = (parsed as { tools?: unknown } | null)?.tools;
  if (!Array.isArray(tools)) return emptyIndex();
  const flatTools = new Set<string>();
  const claims = new Map<string, Set<string>>();
  for (const tool of tools) {
    if (!tool || typeof tool !== 'object') continue;
    const record = tool as { type?: unknown; name?: unknown; tools?: unknown };
    if (record.type === 'function' && typeof record.name === 'string' && record.name) {
      flatTools.add(record.name);
    } else if (
      record.type === 'namespace' &&
      typeof record.name === 'string' &&
      record.name &&
      Array.isArray(record.tools)
    ) {
      for (const inner of record.tools) {
        const innerName = (inner as { name?: unknown } | null)?.name;
        if (typeof innerName !== 'string' || !innerName) continue;
        const namespaces = claims.get(innerName) ?? new Set<string>();
        namespaces.add(record.name);
        claims.set(innerName, namespaces);
      }
    }
  }
  const toolNamespaces = new Map<string, string>();
  for (const [name, namespaces] of claims) {
    if (namespaces.size !== 1 || flatTools.has(name)) continue;
    toolNamespaces.set(name, namespaces.values().next().value as string);
  }
  return { flatTools, toolNamespaces };
}

// Pure response-frame surgery: one complete SSE data line in, the line
// codex should receive out. Only response.output_item.done function_call
// items with a missing/empty namespace whose name the index resolves are
// rewritten; every other line returns byte-identical. Line-ending and
// separator hardening (interrogate rounds 1-2, all 0-occurrence on the
// measured wire but silent-failure classes when they occur): a trailing
// \r (CRLF SSE) is stripped before the match and re-appended, and the
// payload capture is [\s\S] so a raw U+2028/U+2029 inside an otherwise
// valid JSON line (JSON.stringify emits them unescaped; JS `.` excludes
// them) cannot silently no-op the rewrite.
export function reattachNamespaceInFrame(line: string, index: NamespaceIndex): string {
  const crlf = line.endsWith('\r');
  const body = crlf ? line.slice(0, -1) : line;
  const match = /^data: ?([\s\S]*)$/.exec(body);
  if (!match) return line;
  let event: unknown;
  try {
    event = JSON.parse(match[1] as string);
  } catch {
    return line;
  }
  if (!event || typeof event !== 'object') return line;
  const record = event as { type?: unknown; item?: unknown };
  if (record.type !== 'response.output_item.done') return line;
  const item = record.item;
  if (!item || typeof item !== 'object') return line;
  const call = item as { type?: unknown; name?: unknown; namespace?: unknown };
  if (call.type !== 'function_call' || typeof call.name !== 'string') return line;
  if (typeof call.namespace === 'string' && call.namespace.trim() !== '') return line;
  const namespace = index.toolNamespaces.get(call.name);
  if (!namespace) return line;
  call.namespace = namespace;
  return `data: ${JSON.stringify(event)}${crlf ? '\r' : ''}`;
}

export interface GatewayProxy {
  port: number;
  close(): Promise<void>;
}

interface InFlight {
  controller: AbortController;
}

// One scrubbed response-frame line into the dump (post-rewrite — the wire
// codex received, per the header comment). Empty lines (SSE separators) are
// skipped — a frame line is only ever complete.
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
    // The latest request's namespace declarations. The request always
    // precedes its own response on this wire, so the response-side
    // re-attachment below reads an index that already saw this turn's
    // tools; the declarations are stable within a case attempt (one
    // codex process, one proxy), so a stale index is not a shape that
    // occurs in practice.
    let namespaceIndex: NamespaceIndex = emptyIndex();
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
        if (req.method === 'POST' && shaped) {
          try {
            const parsed = JSON.parse(shaped);
            // The index update is functional (the response re-attachment
            // reads it), the dump line rides the same parse; both degrade
            // to the previous state on a non-JSON body. Only a body that
            // carries tool declarations replaces the index — a tools-less
            // POST (a future wire shape) must not silently disable the
            // re-attachment by wiping it (interrogate round 1). The null
            // guard keeps a JSON-null body (or any non-object) flowing to
            // the dump line below instead of tripping the catch.
            if (Array.isArray((parsed as { tools?: unknown } | null)?.tools)) {
              namespaceIndex = indexNamespaceDecls(parsed);
            }
            if (dumpFile) {
              appendFileSync(dumpFile, scrubSecrets(JSON.stringify({ url: req.url, body: parsed })) + '\n');
            }
          } catch {
            // best-effort: a non-JSON POST body keeps the last index
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
          // The response tee: the client receives the upstream bytes
          // verbatim except for the namespace re-attachment on complete
          // response.output_item.done data lines (see the header comment);
          // the dump gets the same complete scrubbed lines the client saw.
          // Line buffering applies with or without the dump because the
          // rewrite needs complete lines: a StringDecoder (never per-chunk
          // string concatenation — the request side's own comment) keeps
          // multi-byte UTF-8 whole across chunk boundaries; the carry
          // buffer holds the trailing partial line for the next chunk, and
          // whatever remains at stream end is flushed. The client consumes
          // complete SSE events, so holding back to line boundaries
          // changes no observable framing.
          const decoder = new StringDecoder('utf8');
          let carry = '';
          const forwardLine = (line: string): void => {
            const outLine = reattachNamespaceInFrame(line, namespaceIndex);
            res.write(`${outLine}\n`);
            if (dumpFile) appendDumpLine(dumpFile, outLine);
          };
          for await (const chunk of upstream.body) {
            carry += decoder.write(chunk as Buffer);
            const lines = carry.split('\n');
            carry = lines.pop() ?? '';
            for (const line of lines) forwardLine(line);
          }
          carry += decoder.end();
          if (carry) forwardLine(carry);
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
