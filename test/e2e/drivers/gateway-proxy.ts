import http from 'node:http';
import { appendFileSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

import { scrubSecrets } from '../env-policy.ts';

// Optional wire dump (E2E_CODEX_PROXY_DUMP=<file>): one JSON line per
// shaped request body, plus one JSON line per complete upstream SSE
// response frame — the diagnostic for model-wire questions. Both halves
// pass scrubSecrets before they are written: the file rides the uploaded
// .e2e-results artifact in CI, and the model key reaches request bodies
// via printenv echoes under the codex leg's inherit-all shell policy, so
// an unscrubbed line would ship a secret. The client stream is untouched
// (byte-identical to upstream). The response half exists for the codex
// stall forensics (ReasoningRawContentDelta without active item,
// 2026-10-29): the exact upstream frame that trips codex 0.162.1's parser
// is only observable on this wire. Read per request so a value from
// test/e2e/.env (loaded in main, after module evaluation) also works.

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
          if (!dumpFile) {
            for await (const chunk of upstream.body) res.write(chunk);
          } else {
            // The response tee: the client still receives the upstream bytes
            // verbatim; the dump gets complete scrubbed lines only. A
            // StringDecoder (never per-chunk string concatenation — the
            // request side's own comment) keeps multi-byte UTF-8 whole
            // across chunk boundaries; the carry buffer holds the trailing
            // partial line for the next chunk, and whatever remains at
            // stream end is flushed best-effort.
            const decoder = new StringDecoder('utf8');
            let carry = '';
            for await (const chunk of upstream.body) {
              res.write(chunk);
              carry += decoder.write(chunk as Buffer);
              const lines = carry.split('\n');
              carry = lines.pop() ?? '';
              for (const line of lines) appendDumpLine(dumpFile, line);
            }
            carry += decoder.end();
            if (carry) appendDumpLine(dumpFile, carry);
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
