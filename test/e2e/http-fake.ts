import { createServer, type IncomingMessage, type Server } from 'node:http';

// Local HTTP fake for the Huawei Cloud boundary. One instance per case
// attempt; HDKITSERVICE_ENDPOINT, HW_IAM_ENDPOINT, and HWLINK_ENDPOINT all
// point at it (path namespaces do not collide: hdkitservice short paths,
// IAM /v3/projects, hwlink its own). Every request is recorded (method,
// pathname without query, truncated body) — the assertion surface. Scripted
// responses match by exact pathname plus optional method, first hit wins;
// everything else gets the default 404 so unknown paths (hwlink probes,
// boot prewarm) fail fast and deterministically instead of hanging.
export interface HttpRecording {
  method: string;
  path: string;
  body?: string;
}

export interface HttpScriptedResponse {
  path: string;
  method?: string;
  status?: number;
  body?: unknown;
}

export interface HttpScript {
  responses: HttpScriptedResponse[];
  default?: { status?: number; body?: unknown };
}

const MAX_BODY_RECORD = 4096;

export class HttpFake {
  readonly recordings: HttpRecording[] = [];
  private server: Server | null = null;
  private port = 0;
  private readonly script: HttpScript;

  constructor(script: HttpScript = { responses: [] }) {
    this.script = script;
  }

  async start(): Promise<void> {
    const server = createServer((req, res) => this.handle(req, res));
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    this.server = server;
    this.port = (server.address() as { port: number }).port;
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  // hdkitservice concatenates base + relative path, and its default base has
  // a trailing slash — hand it the slash-terminated form.
  get hdkitserviceBaseUrl(): string {
    return `${this.baseUrl}/`;
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    this.server = null;
  }

  private handle(req: IncomingMessage, res: import('node:http').ServerResponse): void {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const path = (req.url || '/').split('?')[0]!;
      this.recordings.push({
        method: req.method || 'GET',
        path,
        ...(body ? { body: body.slice(0, MAX_BODY_RECORD) } : {}),
      });
      const hit = this.script.responses.find(
        (r) => r.path === path && (!r.method || r.method === (req.method || 'GET')),
      );
      const chosen = hit ??
        this.script.default ?? { status: 404, body: { message: 'e2e http fake: no scripted response' } };
      const status = typeof chosen.status === 'number' ? chosen.status : 200;
      const payload = JSON.stringify(chosen.body ?? {});
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(payload);
    });
    req.on('error', () => {
      res.destroy();
    });
  }
}
