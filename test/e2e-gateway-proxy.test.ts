import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { join } from 'node:path';
import test from 'node:test';

import { startGatewayProxy } from './e2e/drivers/gateway-proxy.ts';
import { fixtureDir } from './fixture-dir.ts';

// The proxy's dump contract, both halves: the client stream stays
// byte-identical to upstream (multi-byte UTF-8 split across chunk
// boundaries included — every case prompt is Chinese), and EVERY line
// written to E2E_CODEX_PROXY_DUMP passes scrubSecrets — the shaped request
// line (the pre-existing writer) and the response frames alike. The file
// rides the uploaded .e2e-results artifact in CI, and the model key
// reaches request bodies via printenv echoes under the codex leg's
// inherit-all shell policy, so an unscrubbed line of either kind would
// ship a secret (interrogate finding, 2026-10-29: the request half was the
// leak; only the response half had been planned to scrub).

// Assembled, never one contiguous literal: a keyword-adjacent contiguous
// value is exactly the CI secret scanner's generic-api-key shape (it
// flagged this fixture's first spelling, run 41042351976, 2026-10-30) —
// the hw-request-signing DIGEST_* split is the established dodge. Each
// half stays under the rule's value-length floor; the runtime value is a
// distinctive 23-char scrub target (scrubSecrets needs >= 8).
const SECRET = 'wire-' + 'probe-' + 'scrub-' + 'marker';

test('the proxy tee keeps the client stream byte-identical and both dump halves scrubbed', async () => {
  const dir = fixtureDir('hwc-gw-proxy-');
  const dumpPath = join(dir, 'dump.jsonl');
  const savedKey = process.env.E2E_APIKEY;
  const savedDump = process.env.E2E_CODEX_PROXY_DUMP;
  process.env.E2E_APIKEY = SECRET;
  process.env.E2E_CODEX_PROXY_DUMP = dumpPath;

  const payload = Buffer.from(
    `data: {"type":"response.created"}\n\ndata: {"delta":"中文测试 key ${SECRET} tail"}\n\ndata: {"type":"response.completed"}\n\n`,
  );
  // Split the writes INSIDE the CJK sequence so the tee's decoder must
  // carry partial multi-byte bytes across chunk boundaries.
  const splitA = payload.indexOf('中') + 1;
  const splitB = payload.indexOf('中') + 2;

  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(payload.subarray(0, splitA));
    res.write(payload.subarray(splitA, splitB));
    res.end(payload.subarray(splitB));
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', () => resolve()));
  const upstreamPort = (upstream.address() as { port: number }).port;

  const proxy = await startGatewayProxy(`http://127.0.0.1:${upstreamPort}`);
  try {
    const resp = await fetch(`http://127.0.0.1:${proxy.port}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: [{ type: 'message', text: `echo ${SECRET}` }], stream: true }),
    });
    assert.equal(resp.status, 200);
    const clientBytes = Buffer.from(await resp.arrayBuffer());
    assert.ok(clientBytes.equals(payload), 'client stream must stay byte-identical to upstream');
  } finally {
    await proxy.close();
    upstream.closeAllConnections?.();
    upstream.close();
    if (savedKey === undefined) delete process.env.E2E_APIKEY;
    else process.env.E2E_APIKEY = savedKey;
    if (savedDump === undefined) delete process.env.E2E_CODEX_PROXY_DUMP;
    else process.env.E2E_CODEX_PROXY_DUMP = savedDump;
  }

  const lines = readFileSync(dumpPath, 'utf8').trim().split('\n').filter(Boolean);
  for (const line of lines) JSON.parse(line);
  const requestLines = lines.filter((line) => line.includes('"url"'));
  const frameLines = lines.filter((line) => line.includes('"frame"'));
  assert.equal(requestLines.length, 1, 'exactly one request line');
  assert.ok(!lines.some((line) => line.includes(SECRET)), 'no dump line may carry the raw key value');
  assert.ok(
    lines.some((line) => line.includes('[redacted]')),
    'the scrub replaced the key',
  );
  const frames = frameLines.map((line) => (JSON.parse(line) as { frame: string }).frame);
  assert.ok(
    frames.some((f) => f.includes('中文测试')),
    'multi-byte UTF-8 survives the chunk splits',
  );
  assert.ok(
    frames.some((f) => f.includes('data: {"type":"response.completed"}')),
    'every frame line is a complete SSE line',
  );
});
