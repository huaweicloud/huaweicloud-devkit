import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { join } from 'node:path';
import test from 'node:test';

import { clientToolNamespaces, restoreNamespaces, startGatewayProxy } from './e2e/drivers/gateway-proxy.ts';
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

// One proxied round trip shared by the wire tests: an SSE upstream that
// An upstream SSE server (the handler owns its write pattern) with the
// shaping proxy in front of it; `done` tears both down.
async function proxyAroundUpstream(
  handler: http.RequestListener,
): Promise<{ proxyPort: number; done(): Promise<void> }> {
  const upstream = http.createServer(handler);
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', () => resolve()));
  const upstreamPort = (upstream.address() as { port: number }).port;
  const proxy = await startGatewayProxy(`http://127.0.0.1:${upstreamPort}`);
  return {
    proxyPort: proxy.port,
    done: async () => {
      await proxy.close();
      upstream.closeAllConnections?.();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    },
  };
}

// Writes the payload in `splits.length + 1` writes (the split indices are
// byte offsets INSIDE the payload, chosen mid-multi-byte to prove the
// relay carries partial characters across chunk boundaries) and returns
// the client-received stream as RAW BYTES — the byte-identity contract is
// exact, so the tests must not round-trip through a UTF-8 text decode.
async function relayThroughProxy(payload: Buffer, splits: number[], requestBody: string): Promise<Buffer> {
  const { proxyPort, done } = await proxyAroundUpstream((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const bounds = [...splits, payload.length];
    let start = 0;
    for (const end of bounds) {
      const chunk = payload.subarray(start, end);
      if (end === payload.length) res.end(chunk);
      else res.write(chunk);
      start = end;
    }
  });
  try {
    const resp = await fetch(`http://127.0.0.1:${proxyPort}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: requestBody,
    });
    assert.equal(resp.status, 200);
    return Buffer.from(await resp.arrayBuffer());
  } finally {
    await done();
  }
}

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
  const clientBytes = await relayThroughProxy(
    payload,
    [payload.indexOf('中') + 1, payload.indexOf('中') + 2],
    JSON.stringify({ input: [{ type: 'message', text: `echo ${SECRET}` }], stream: true }),
  );
  try {
    assert.ok(clientBytes.equals(payload), 'client stream must stay byte-identical to upstream');
  } finally {
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

// The namespace restore, pinned at both layers (the codex-leg failure of
// run 41636889890: every regenerated function_call arrived namespace-less
// and codex answered "unsupported call: <tool>" without dispatching).

const NAMESPACE_TOOLS_REQUEST = {
  tools: [
    { type: 'function', name: 'exec_command', parameters: { type: 'object' } },
    {
      type: 'namespace',
      name: 'mcp__hwc',
      tools: [
        { type: 'function', name: 'huaweicloud_voucher_claim', parameters: { type: 'object' } },
        { type: 'function', name: 'huaweicloud_plan_cli_command', parameters: { type: 'object' } },
      ],
    },
  ],
};

test('clientToolNamespaces maps inner tool names to their namespace', () => {
  const namespaces = clientToolNamespaces(NAMESPACE_TOOLS_REQUEST);
  assert.equal(namespaces.get('huaweicloud_voucher_claim'), 'mcp__hwc');
  assert.equal(namespaces.get('huaweicloud_plan_cli_command'), 'mcp__hwc');
  assert.equal(namespaces.has('exec_command'), false, 'plain function tools stay unmapped');
  assert.equal(clientToolNamespaces({}).size, 0);
  assert.equal(clientToolNamespaces(undefined).size, 0);
  assert.equal(clientToolNamespaces({ tools: 'nope' }).size, 0);
  // Ambiguity never re-routes a call: a name shared with a plain function
  // tool, or claimed by two namespaces, stays out of the map.
  const shared = clientToolNamespaces({
    tools: [
      { type: 'function', name: 'exec_command', parameters: { type: 'object' } },
      {
        type: 'namespace',
        name: 'mcp__a',
        tools: [{ type: 'function', name: 'exec_command', parameters: { type: 'object' } }],
      },
      {
        type: 'namespace',
        name: 'mcp__a',
        tools: [{ type: 'function', name: 'shared_tool', parameters: { type: 'object' } }],
      },
      {
        type: 'namespace',
        name: 'mcp__b',
        tools: [{ type: 'function', name: 'shared_tool', parameters: { type: 'object' } }],
      },
      {
        type: 'namespace',
        name: 'mcp__b',
        tools: [{ type: 'function', name: 'only_b', parameters: { type: 'object' } }],
      },
    ],
  });
  assert.equal(shared.has('exec_command'), false, 'a plain-function name is never re-routed into a namespace');
  assert.equal(shared.has('shared_tool'), false, 'a name claimed by two namespaces is ambiguous, so unmapped');
  assert.equal(shared.get('only_b'), 'mcp__b', 'unambiguous names still map');
});

test('restoreNamespaces re-tags namespace-less function_calls and leaves everything else byte-identical', () => {
  const namespaces = clientToolNamespaces(NAMESPACE_TOOLS_REQUEST);

  // The retry shape from the run-41636889890 wire: an output_item.done
  // function_call with no namespace key.
  const retryLine =
    'data: {"type":"response.output_item.done","item":{"type":"function_call","name":"huaweicloud_voucher_claim","call_id":"c1","arguments":"{\\"vendorConfirmed\\":\\"q\\"}"}}';
  const restored = JSON.parse(restoreNamespaces(retryLine, namespaces)!.slice(6));
  assert.equal(restored.item.namespace, 'mcp__hwc', 'the retry regains its namespace');

  // response.completed carries the items in a nested output array.
  const completedLine =
    'data: {"type":"response.completed","response":{"output":[{"type":"function_call","name":"huaweicloud_plan_cli_command","call_id":"c2","arguments":"{}"}]}}';
  const completed = JSON.parse(restoreNamespaces(completedLine, namespaces)!.slice(6));
  assert.equal(completed.response.output[0].namespace, 'mcp__hwc');

  // A fresh call already carries the namespace: byte-identical passthrough.
  const freshLine =
    'data: {"type":"response.output_item.done","item":{"type":"function_call","name":"huaweicloud_voucher_claim","call_id":"c3","namespace":"mcp__hwc","arguments":"{}"}}';
  assert.equal(restoreNamespaces(freshLine, namespaces), freshLine);

  // A builtin call is not a namespace tool: byte-identical passthrough.
  const builtinLine =
    'data: {"type":"response.output_item.done","item":{"type":"function_call","name":"exec_command","call_id":"c4","arguments":"{}"}}';
  assert.equal(restoreNamespaces(builtinLine, namespaces), builtinLine);

  // Non-data lines, non-JSON data lines, and an empty namespace map never
  // rewrite anything.
  assert.equal(restoreNamespaces('event: response.created', namespaces), 'event: response.created');
  assert.equal(restoreNamespaces('data: not json', namespaces), 'data: not json');
  assert.equal(restoreNamespaces(retryLine, new Map()), retryLine);

  // A data line without the space after the colon is still SSE data.
  const tight =
    'data:{"type":"response.completed","response":{"output":[{"type":"function_call","name":"huaweicloud_voucher_claim","call_id":"c5","arguments":"{}"}]}}';
  const restoredTight = restoreNamespaces(tight, namespaces);
  assert.ok(restoredTight!.startsWith('data:{"type"'), 'the tight data: prefix is preserved');
  assert.equal(JSON.parse(restoredTight!.slice(5)).response.output[0].namespace, 'mcp__hwc');
});

test('the proxy restores namespaces on the client-bound stream and records the restored form in the dump', async () => {
  const dir = fixtureDir('hwc-gw-proxy-ns-');
  const dumpPath = join(dir, 'dump.jsonl');
  const savedDump = process.env.E2E_CODEX_PROXY_DUMP;
  process.env.E2E_CODEX_PROXY_DUMP = dumpPath;

  // Upstream frames mirror the measured failure: a fresh namespaced call,
  // then the namespace-less retry (split mid-UTF-8 to prove the
  // line-buffered relay keeps multi-byte sequences whole).
  const payload = Buffer.from(
    `data: {"type":"response.output_item.done","item":{"type":"function_call","name":"huaweicloud_voucher_claim","call_id":"c1","namespace":"mcp__hwc","arguments":"{}"}}\n\n` +
      `data: {"type":"response.output_item.done","item":{"type":"function_call","name":"huaweicloud_voucher_claim","call_id":"c2","arguments":"{\\"vendorConfirmed\\":\\"帮我领取代金券\\"}"}}\n\n`,
    'utf8',
  );
  try {
    const clientBytes = await relayThroughProxy(
      payload,
      [payload.indexOf(Buffer.from('领取', 'utf8')) + 2],
      JSON.stringify({ ...NAMESPACE_TOOLS_REQUEST, input: [], stream: true }),
    );
    const clientText = clientBytes.toString('utf8');
    const clientItems = [...clientText.matchAll(/^data: (.*)$/gm)]
      .map((match) => JSON.parse(match[1] ?? '{}') as { item?: { call_id?: string; namespace?: string } })
      .map((event) => event.item);
    const fresh = clientItems.find((item) => item?.call_id === 'c1');
    const retry = clientItems.find((item) => item?.call_id === 'c2');
    assert.equal(fresh?.namespace, 'mcp__hwc', 'the fresh namespaced call stays as upstream sent it');
    assert.equal(retry?.namespace, 'mcp__hwc', 'the namespace-less retry regains mcp__hwc');
    // The CJK payload survived the mid-character chunk split.
    assert.ok(clientText.includes('领取'), 'multi-byte UTF-8 survives the relay');
  } finally {
    if (savedDump === undefined) delete process.env.E2E_CODEX_PROXY_DUMP;
    else process.env.E2E_CODEX_PROXY_DUMP = savedDump;
  }

  const frameLines = readFileSync(dumpPath, 'utf8')
    .trim()
    .split('\n')
    .filter((line) => line.includes('"frame"'))
    .map((line) => (JSON.parse(line) as { frame: string }).frame);
  const retryFrame = frameLines.find((f) => f.includes('"call_id":"c2"'));
  assert.ok(retryFrame, 'the retry frame reached the dump');
  assert.ok(retryFrame?.includes('"namespace":"mcp__hwc"'), 'the dump records the restored form the client consumed');
  assert.ok(
    frameLines.some((f) => f.includes('领取')),
    'the dump keeps the multi-byte payload whole',
  );
});

// Interrogate round 2: both round-1 hardenings were untested — a mutant
// that re-encodes unchanged lines or one that lets a walk failure tear
// the stream down shipped green against the suite. These pin them.

test('an unchanged line with invalid UTF-8 relays as its raw bytes', async () => {
  // No function_call anywhere, so every line is an unchanged line: the
  // raw 0xff 0xfe pair must reach the client verbatim, not as U+FFFD.
  const payload = Buffer.concat([
    Buffer.from('data: {"type":"x","v":"', 'utf8'),
    Buffer.from([0xff, 0xfe]),
    Buffer.from('"}\n\nevent: ping\n\n', 'utf8'),
  ]);
  const clientBytes = await relayThroughProxy(
    payload,
    [payload.indexOf(Buffer.from([0xff])) + 1],
    JSON.stringify({ input: [], stream: true }),
  );
  assert.ok(clientBytes.equals(payload), 'unchanged lines are byte-identical even with invalid UTF-8');
});

test('a frame whose walk would throw is relayed verbatim and never tears the stream down', async () => {
  // A data line JSON.parse accepts but a recursive walk cannot traverse
  // (~4882 nesting levels is the walk's measured cliff; JSON.parse is
  // iterative and accepts millions): the guard must return the original
  // line and the stream must complete — a transform bug may never destroy
  // the response. The deep nesting is BALANCED arrays with the
  // function_call at the bottom, so the line is valid JSON the walk
  // recurses into (round-3 finding: the first cut's unbalanced closer
  // died at JSON.parse and never reached the walk — vacuous).
  const inner = JSON.stringify({
    type: 'function_call',
    name: 'huaweicloud_voucher_claim',
    call_id: 'c1',
    arguments: '{}',
  });
  let deepLine = 'data: {"type":"response.output_item.done","item":';
  for (let i = 0; i < 20000; i++) deepLine += '[';
  deepLine += inner;
  for (let i = 0; i < 20000; i++) deepLine += ']';
  deepLine += '}\n\n';
  const frames = Buffer.from(deepLine + 'data: {"type":"response.completed"}\n\n', 'utf8');
  const clientBytes = await relayThroughProxy(
    frames,
    [frames.indexOf('r', 20)],
    JSON.stringify({ ...NAMESPACE_TOOLS_REQUEST, input: [], stream: true }),
  );
  const clientText = clientBytes.toString('utf8');
  assert.ok(
    clientText.includes('data: {"type":"response.completed"}'),
    'the stream completed past the pathological frame',
  );
  assert.ok(clientText.includes(inner), 'the pathological frame was relayed, not dropped');
  assert.ok(
    !clientText.includes('"namespace"'),
    'the walk never tagged anything inside it (the guard returned the original line)',
  );
});

test('a null or empty namespace is restored like a missing one', () => {
  const namespaces = clientToolNamespaces(NAMESPACE_TOOLS_REQUEST);
  const nullLine =
    'data: {"type":"response.output_item.done","item":{"type":"function_call","name":"huaweicloud_voucher_claim","call_id":"c1","namespace":null,"arguments":"{}"}}';
  const restored = JSON.parse(restoreNamespaces(nullLine, namespaces)!.slice(6));
  assert.equal(restored.item.namespace, 'mcp__hwc', 'null namespace is namespace-less as codex experiences it');
  const emptyLine =
    'data: {"type":"response.output_item.done","item":{"type":"function_call","name":"huaweicloud_voucher_claim","call_id":"c1","namespace":"","arguments":"{}"}}';
  const emptied = JSON.parse(restoreNamespaces(emptyLine, namespaces)!.slice(6));
  assert.equal(emptied.item.namespace, 'mcp__hwc');
});

test('a stalled client at high frame counts does not tear the stream down', async () => {
  // The write-granularity pin (round 3): the relay writes ONE res.write per
  // upstream chunk. A per-line-write relay hits a Node writev EINVAL cliff
  // at ~100k queued small chunks under a slow client — measured 8/8 streams
  // torn at 200k frames (mutation-verified: the per-line mutant tears at
  // ~35k frames seen, the chunked relay completes all 200k). The stall
  // parks the reader after the first chunk so the relay's outbound queue
  // backs up, then drains; the measured wire's worst response is 4176
  // frame lines, ~50x under this pin's scale.
  const FRAMES = 200000;
  const frame = `data: {"i":"${'x'.repeat(64)}"}\n\n`;
  const { proxyPort, done } = await proxyAroundUpstream((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    let i = 0;
    const tick = () => {
      const deadline = Date.now() + 4;
      while (i < FRAMES && Date.now() < deadline) {
        if (!res.write(frame)) {
          i++;
          res.once('drain', tick);
          return;
        }
        i++;
      }
      if (i >= FRAMES) res.end('data: {"type":"response.completed"}\n\n');
      else setTimeout(tick);
    };
    tick();
  });
  try {
    const resp = await fetch(`http://127.0.0.1:${proxyPort}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: [], stream: true }),
    });
    assert.equal(resp.status, 200);
    const reader = resp.body!.getReader();
    const chunks: Buffer[] = [];
    const first = await reader.read();
    if (first.value) chunks.push(Buffer.from(first.value));
    await new Promise((resolve) => setTimeout(resolve, 3000));
    for (;;) {
      const { done: finished, value } = await reader.read();
      if (finished) break;
      if (value) chunks.push(Buffer.from(value));
    }
    const text = Buffer.concat(chunks).toString('utf8');
    const seen = (text.match(/"i":/g) ?? []).length;
    assert.ok(text.includes('"response.completed"'), `the stream completed (${seen} frames seen)`);
    assert.equal(seen, FRAMES, 'every frame reached the client');
  } finally {
    await done();
  }
});
