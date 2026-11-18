import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer, type Server } from 'node:http';

import { probeModelWire } from './e2e/drivers/shared.ts';

// probeModelWire is the pre-flight that turns a dead model gateway into a
// named 30-second failure instead of an all-red suite whose only signature
// is a dead agent (measured on the 2026-10-22 CI codex leg). These tests pin
// its failure predicate against a local server: non-2xx, an SSE error frame
// behind a 200, a chat error body, connection refusal, and the secret scrub.

async function withServer(
  handler: (path: string, res: import('node:http').ServerResponse, body: string) => void,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server: Server = createServer((req, res) => {
    const path = (req.url || '/').split('?')[0]!;
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk as Buffer));
    req.on('end', () => handler(path, res, Buffer.concat(chunks).toString('utf8')));
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  try {
    await run(baseUrl);
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
}

const CHAT_INPUT = { baseUrl: '', model: 'glm-test', apiKey: 'sk-wire-probe-key', wire: 'chat' as const };
const RESPONSES_INPUT = { baseUrl: '', model: 'glm-test', apiKey: 'sk-wire-probe-key', wire: 'responses' as const };

test('wire probe passes on a healthy chat endpoint and names the route', async () => {
  await withServer(
    (_path, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'x', choices: [] }));
    },
    async (baseUrl) => {
      const result = await probeModelWire({ ...CHAT_INPUT, baseUrl });
      assert.equal(result.ok, true);
      assert.match(result.detail, /POST \/chat\/completions/);
    },
  );
});

test('wire probe fails fast on a 4xx with the status and body snippet', async () => {
  await withServer(
    (_path, res) => {
      res.writeHead(401, { 'Content-Type': 'text/plain' });
      res.end('api key not found');
    },
    async (baseUrl) => {
      const result = await probeModelWire({ ...CHAT_INPUT, baseUrl });
      assert.equal(result.ok, false);
      assert.match(result.detail, /HTTP 401/);
      assert.match(result.detail, /api key not found/);
    },
  );
});

test('wire probe passes on a healthy streamed responses endpoint', async () => {
  await withServer(
    (_path, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('event: response.created\ndata: {"type":"response.created"}\n\n');
      res.end();
    },
    async (baseUrl) => {
      const result = await probeModelWire({ ...RESPONSES_INPUT, baseUrl });
      assert.equal(result.ok, true);
      assert.match(result.detail, /POST \/responses/);
    },
  );
});

test('wire probe fails on an error frame behind a streamed 200', async () => {
  await withServer(
    (_path, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('event: error\ndata: {"type":"error","message":"bad key"}\n\n');
      res.end();
    },
    async (baseUrl) => {
      const result = await probeModelWire({ ...RESPONSES_INPUT, baseUrl });
      assert.equal(result.ok, false);
      assert.match(result.detail, /error frame/);
    },
  );
});

test('wire probe fails on a chat 200 carrying an error body', async () => {
  await withServer(
    (_path, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'quota exceeded' } }));
    },
    async (baseUrl) => {
      const result = await probeModelWire({ ...CHAT_INPUT, baseUrl });
      assert.equal(result.ok, false);
      assert.match(result.detail, /error body/);
      assert.match(result.detail, /quota exceeded/);
    },
  );
});

test('wire probe fails on connection refusal and reports the retry too', async () => {
  // Port 1 never listens: the probe retried once (network errors are the
  // transient class) and the detail names both attempts.
  const result = await probeModelWire({ ...CHAT_INPUT, baseUrl: 'http://127.0.0.1:1' });
  assert.equal(result.ok, false);
  assert.match(result.detail, /request failed/);
  assert.match(result.detail, /retry:/);
});

test('wire probe scrubs the session key out of gateway response bodies', async () => {
  const key = 'sk-leaked-key-42';
  const saved = process.env.E2E_APIKEY;
  process.env.E2E_APIKEY = key;
  try {
    await withServer(
      (_path, res) => {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end(`Incorrect API key provided: ${key}`);
      },
      async (baseUrl) => {
        const result = await probeModelWire({ ...CHAT_INPUT, baseUrl, apiKey: key });
        assert.equal(result.ok, false);
        assert.ok(!result.detail.includes(key), `detail must not carry the key: ${result.detail}`);
        assert.match(result.detail, /\[redacted\]/);
      },
    );
  } finally {
    if (saved === undefined) delete process.env.E2E_APIKEY;
    else process.env.E2E_APIKEY = saved;
  }
});

// The sampling doctrine (the 2026-11-13/14 nightly codex legs): one probe
// body cannot see a pool that fails per-request-body — identical retries of
// one body all died with gateway "Internal error" while sibling bodies
// succeeded, so the probe must send DISTINCT payloads and tolerate one bad
// sample, no more. The upstream below fails by ping payload, which is the
// observable stand-in for the body-routed failure class.
function pingOf(body: string): string {
  try {
    const parsed = JSON.parse(body) as { input?: unknown; messages?: { content?: unknown }[] };
    if (typeof parsed.input === 'string') return parsed.input;
    return String(parsed.messages?.[0]?.content ?? '');
  } catch {
    return '';
  }
}

// The flaky-pool upstream: the listed ping payloads get the deterministic
// per-body failure (written per wire — a chat error body or an SSE error
// frame, both the non-retryable class so no retry round muddies the
// sample count), every other body succeeds.
function bodyRoutedPoolUpstream(
  deadPings: readonly string[],
  failWith: (res: import('node:http').ServerResponse) => void,
): (path: string, res: import('node:http').ServerResponse, body: string) => void {
  return (_path, res, body) => {
    if (deadPings.includes(pingOf(body))) return failWith(res);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: 'x', choices: [] }));
  };
}

test('wire probe tolerates exactly one dead sample in a body-routed pool', async () => {
  await withServer(
    bodyRoutedPoolUpstream(['ping 3'], (res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'route dead' } }));
    }),
    async (baseUrl) => {
      const result = await probeModelWire({ ...CHAT_INPUT, baseUrl });
      assert.equal(result.ok, true);
      assert.match(result.detail, /4\/5 samples/);
    },
  );
});

test('wire probe fails a pool that kills two of five bodies', async () => {
  await withServer(
    bodyRoutedPoolUpstream(['ping 3', 'ping 5'], (res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end('event: error\ndata: {"type":"error","message":"route dead"}\n\n');
    }),
    async (baseUrl) => {
      const result = await probeModelWire({ ...RESPONSES_INPUT, baseUrl });
      assert.equal(result.ok, false);
      assert.match(result.detail, /3\/5 samples ok/);
      assert.match(result.detail, /error frame/);
    },
  );
});
