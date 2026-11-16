import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import test from 'node:test';

import { createClient, frame, serverPath } from './mcp-server-client.ts';

test('MCP server returns JSON-RPC -32601 for unknown methods (#650 D9-2)', async () => {
  const client = createClient();
  try {
    await client.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '0.0.0' },
    });
    const response = await client.request('tools/unknown_xyz');
    assert.ok(response.error, 'expected an error response');
    assert.equal(response.error.code, -32601);
    assert.match(response.error.message, /Method not found/);
  } finally {
    client.close();
  }
});

test('MCP server returns -32700 and keeps serving after a malformed frame (#643)', async () => {
  const client = createClient();
  try {
    await client.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '0.0.0' },
    });
    client.raw('Content-Length: 5\r\n\r\n{bad!');

    // Same budget class as request()/requestInChunks above: the server
    // cold-boots through type stripping and under machine load a 3s poll
    // deadline produced load-dependent flakes in full-suite runs.
    const deadline = Date.now() + 10_000;
    let parseError;
    while (Date.now() < deadline) {
      parseError = client.frames().find((p) => p.error && p.error.code === -32700);
      if (parseError) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(parseError, 'expected a -32700 Parse error frame');
    assert.equal(parseError.error.code, -32700);
    assert.equal(parseError.id, null, 'parse error has null id');

    const listed = await client.request('tools/list');
    assert.ok(Array.isArray(listed.result.tools), 'server still serves valid requests after a parse error');
    assert.equal(client.isAlive(), true, 'malformed frame must not kill the process');
  } finally {
    client.close();
  }
});

test('MCP server returns -32700 for a malformed newline-delimited frame (#643)', async () => {
  const child = spawn(process.execPath, [serverPath], { stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    out += chunk;
  });
  try {
    child.stdin.write('{bad!\n');
    // Same budget class as request()/requestInChunks above: the server
    // cold-boots through type stripping and under machine load a 3s poll
    // deadline produced load-dependent flakes in full-suite runs.
    const deadline = Date.now() + 10_000;
    let line = '';
    while (Date.now() < deadline) {
      line = out.split('\n').find((l) => l.includes('-32700')) || '';
      if (line) break;
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    assert.ok(line, 'expected a newline-delimited -32700 frame');
    const payload = JSON.parse(line);
    assert.equal(payload.error.code, -32700);
    assert.equal(payload.id, null);
    assert.equal(child.exitCode, null, 'malformed newline frame must not kill the process');
  } finally {
    child.kill();
  }
});

test('MCP server returns isError tool results for tools/call missing required params (#704, SDK semantics)', async () => {
  const client = createClient();
  try {
    await client.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '0.0.0' },
    });
    // Since the SDK migration, validation failures are isError CallToolResults
    // (the SDK high-level server wraps McpError InvalidParams), not JSON-RPC
    // -32602 error responses. The migration decision is recorded in the SDK
    // migration plan; this pins the new contract.
    const single = await client.request('tools/call', {
      name: 'huaweicloud_plan_cli_command',
      arguments: { vendorConfirmed: 'test: vendor established by the harness' },
    });
    assert.ok(single.result, 'missing required param must return a tool result');
    assert.equal(single.result.isError, true, 'missing required param must set isError');
    assert.match(single.result.content[0].text, /args/);

    const multi = await client.request('tools/call', { name: 'huaweicloud_run_approved_command', arguments: {} });
    assert.ok(multi.result, 'missing required params must return a tool result');
    assert.equal(multi.result.isError, true, 'missing required params must set isError');
    const text = multi.result.content.map((c) => c.text || '').join(' ');
    assert.match(text, /args/);
    // Both approval parameters are mode-conditional in the schema
    // (PR-1.5): approvalToken is token-mode-only, and approvedByUser is the
    // T3 chat round-trip retry marker, so the first ask-mode arrival carries
    // neither and must reach the gate. The schema therefore names neither in
    // a bare call, and the gate owns their teaching (pinned by
    // hcloud-cli-approval.test.ts and approval-gate.test.ts).
    assert.doesNotMatch(text, /approvedByUser/);
  } finally {
    client.close();
  }
});

test('MCP server returns isError tool results for tools/call with unknown tool name (#704, SDK semantics)', async () => {
  const client = createClient();
  try {
    await client.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '0.0.0' },
    });
    const response = await client.request('tools/call', { name: 'huaweicloud_nonexistent', arguments: {} });
    assert.ok(response.result, 'unknown tool must return a tool result');
    assert.equal(response.result.isError, true, 'unknown tool must set isError');
    assert.match(response.result.content[0].text, /not found/);
  } finally {
    client.close();
  }
});

test('MCP server does not require params for tools without required fields (#704)', async () => {
  const client = createClient();
  try {
    await client.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '0.0.0' },
    });
    // explain_error has no required fields and must still return a result.
    const response = await client.request('tools/call', { name: 'huaweicloud_explain_error', arguments: {} });
    assert.ok(response.result, 'expected a result, not an error');
    assert.equal(response.result.isError, false);
  } finally {
    client.close();
  }
});

test('MCP server waits for incomplete Content-Length frames instead of spinning', async () => {
  const client = createClient();
  try {
    const payload = {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'split-client', version: '0.0.0' },
    };

    const initialized = await client.requestInChunks('initialize', payload, 8);

    assert.equal(initialized.result.serverInfo.name, 'huaweicloud-devkit');
  } finally {
    client.close();
  }
});

test('MCP server returns -32600 for valid JSON that is not a request object', async () => {
  const client = createClient();
  try {
    await client.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '0.0.0' },
    });
    client.raw(frame('a bare json string'));
    client.raw(frame(null));
    client.raw(frame([1, 2, 3]));

    // Same budget class as request()/requestInChunks above: the server
    // cold-boots through type stripping and under machine load a 3s poll
    // deadline produced load-dependent flakes in full-suite runs.
    const deadline = Date.now() + 10_000;
    let invalidRequest;
    while (Date.now() < deadline) {
      invalidRequest = client.frames().find((p) => p.error && p.error.code === -32600);
      if (invalidRequest) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(invalidRequest, 'expected a -32600 Invalid Request frame');
    assert.equal(invalidRequest.id, null);
    assert.equal(client.isAlive(), true, 'non-object JSON must not kill the process');

    // An id-bearing message with no method must also get a visible reply,
    // not silence (the SDK would drop it and the client would hang). The
    // reply echoes the request id so the failure is correlatable.
    client.raw(frame({ jsonrpc: '2.0', id: 42 }));
    const deadline2 = Date.now() + 10_000;
    let methodNotFound;
    while (Date.now() < deadline2) {
      methodNotFound = client.frames().find((p) => p.error && p.error.code === -32601);
      if (methodNotFound) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(methodNotFound, 'expected a -32601 for an id-bearing no-method message');
    assert.equal(methodNotFound.id, 42, 'the -32601 reply must echo the request id');
  } finally {
    client.close();
  }
});

test('MCP server waits for a frame header split across chunks', async () => {
  const client = createClient();
  try {
    // Split inside the "Content-Length" token itself: the first chunk is a
    // partial header prefix, the second carries the rest of the header plus
    // the body. Consuming the prefix as a JSON line would emit a spurious
    // -32700 and permanently desync framing.
    const payload = {
      jsonrpc: '2.0',
      id: 77,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'header-split-client', version: '0.0.0' },
      },
    };
    const framed = frame(payload);
    const splitAt = 'Content-Len'.length;
    client.raw(framed.slice(0, splitAt));
    setTimeout(() => client.raw(framed.slice(splitAt)), 50);

    // Same budget class as request()/requestInChunks above: the server
    // cold-boots through type stripping and under machine load a 3s poll
    // deadline produced load-dependent flakes in full-suite runs.
    const deadline = Date.now() + 10_000;
    let response;
    while (Date.now() < deadline) {
      response = client.frames().find((p) => p.id === 77);
      if (response) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(response, 'expected the initialize response after the split header arrived');
    assert.equal(response.result.serverInfo.name, 'huaweicloud-devkit');
    assert.ok(
      !client.frames().some((p) => p.error && p.error.code === -32700),
      'a split header must not produce a parse error',
    );
  } finally {
    client.close();
  }
});

test('ping is auto-answered by the SDK protocol layer', async () => {
  const client = createClient();
  try {
    await client.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '0.0.0' },
    });
    const response = await client.request('ping', {});
    assert.ok(response.result !== undefined, 'ping must return a result');
  } finally {
    client.close();
  }
});

test('the stdio transport forwards client responses to server-initiated requests', async () => {
  // PR-1.5: the server raises the approval form itself (elicitation/create),
  // and the client's ANSWER is an id-bearing message with no method. The
  // transport used to answer every such message with -32601, which left the
  // SDK's request pending until its timeout — the server form could never
  // round-trip on the real stdio face (measured end-to-end through
  // dist/mcp-server.js; the in-memory transport did not catch it). A
  // response carries result/error and must reach the SDK; the malformed
  // shape (neither) keeps its -32601 reply.
  const { PassThrough } = await import('node:stream');
  const { DevkitStdioTransport } = await import('../plugins/huaweicloud-core/src/mcp-stdio-transport.ts');
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const transport = new DevkitStdioTransport({
    streams: { stdin, stdout },
    initializeSideEffects: async () => {},
  });
  const forwarded: unknown[] = [];
  transport.onmessage = (message) => {
    forwarded.push(message);
  };
  const written: string[] = [];
  stdout.on('data', (chunk: Buffer) => written.push(chunk.toString('utf8')));
  await transport.start();

  stdin.write(
    `${JSON.stringify({ jsonrpc: '2.0', id: 7, result: { action: 'accept', content: { confirm: true } } })}\n`,
  );
  stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 8 })}\n`);
  await new Promise((resolve) => setTimeout(resolve, 50));
  await transport.close();

  assert.deepEqual(
    forwarded.map((message) => (message as { id: number }).id),
    [7],
    'the response reached the SDK; the malformed id-only message did not',
  );
  assert.match(written.join(''), /-32601/, 'the malformed message still earns a visible reply');
});
