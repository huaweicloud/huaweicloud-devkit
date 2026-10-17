#!/usr/bin/env node
// Minimal newline-JSON-RPC MCP server standing in for the real
// huaweicloud-open-mcp gateway in the open-mcp-pack tests. Known tools echo
// their arguments as structuredContent (the branch the REAL gateway's
// successful calls always take — its SDK derives structuredContent from the
// return annotations) plus a content-text mirror. Four synthetic tools pin
// the remaining normalization branches (the fourth echoes JSON inside an
// isError envelope, the strongest redaction shape), and
// FAKE_FAIL_HANDSHAKE=1 makes initialize answer with a JSON-RPC error to
// exercise the spawn-failure path. Exits on stdin EOF, which is exactly the
// parent-death semantics the real gateway's stdio transport has and the
// sidecar lifetime contract depends on.
//
// Drift/policy knobs (read from the inherited env, so set them before the
// spawn that must see them):
//   FAKE_POLICY=1              adds execute_api, manage_policy, query_data
//                              and transform_data to both tools/list and the
//                              callable set, with policy-lite semantics:
//                              manage_policy keeps an in-memory {line, scope}
//                              rules array on top of the --policy file,
//                              execute_api resolves overlay ++ file as one
//                              ordered rule set and burns a matching
//                              scope 'once' rule, refusing with the
//                              gateway's envelope-failure shape otherwise.
//   FAKE_HIDE_TOOLS=a,b        removes those names from tools/list and the
//                              callable set (drift-degrade tests).
//   FAKE_SLOW_MS=<ms>          delays every tools/call answer by <ms> so a
//                              short caller timeout lands in sidecar.request's
//                              timer (the forwarded:false catch path).
//   OPENMCP_FAKE_LOG=<path>    records every JSON-RPC request as one JSON
//                              line ({method, tool?, args?}) — the E2E
//                              assertion surface. Unset = no recording, so
//                              parallel unit tests never interleave writes.
const fs = await import('node:fs');

function recordRequest(request) {
  const log = process.env.OPENMCP_FAKE_LOG;
  if (!log) return;
  try {
    const entry = { method: request.method };
    if (request.method === 'tools/call') {
      entry.tool = request.params?.name ?? null;
      entry.args = request.params?.arguments ?? {};
    }
    fs.appendFileSync(log, `${JSON.stringify(entry)}\n`);
  } catch {
    // best-effort: recording must never fail the sidecar
  }
}

const CORE_TOOLS = [
  'search_apis',
  'list_products',
  'get_product',
  'list_apis',
  'get_api',
  'get_api_examples',
  'failing_tool',
  'envelope_fail_tool',
  'raw_text_tool',
  'json_error_tool',
];
const POLICY_TOOLS = ['execute_api', 'manage_policy', 'query_data', 'transform_data'];
const rules = [];
let buffer = '';

function gatewayToolNames() {
  const names = [...CORE_TOOLS];
  if (process.env.FAKE_POLICY === '1') names.push(...POLICY_TOOLS);
  const hidden = new Set(
    (process.env.FAKE_HIDE_TOOLS ?? '')
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean),
  );
  return names.filter((name) => !hidden.has(name));
}

// fnmatch translation for the api-pattern side of a rule. Hand-maintained
// against the gateway's fnmatch semantics with no lockstep contract: when
// the gateway's matching changes, this must be re-derived by hand. Class
// translation per fnmatch.translate: '!' after '[' negates, ']' right
// after '[' or '[!' is literal, '\' escaped, unterminated '[' literal,
// guarded construction with literal fallback.
function fnmatchRegex(pattern) {
  let out = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === '*') out += '.*';
    else if (char === '?') out += '.';
    else if (char === '[') {
      let cursor = index + 1;
      let negated = false;
      if (pattern[cursor] === '!') {
        negated = true;
        cursor += 1;
      }
      const close = pattern.indexOf(']', cursor);
      if (close < 0) {
        out += '\\[';
      } else {
        let body = pattern.slice(cursor, close).replace(/\\/g, '\\\\');
        if (body.startsWith(']')) body = `\\]${body.slice(1)}`;
        if (body.startsWith('^')) body = `\\^${body.slice(1)}`;
        out += `[${negated ? '^' : ''}${body}]`;
        index = close;
      }
    } else out += char.replace(/[.+^${}()|\\]/g, '\\$&');
  }
  try {
    return new RegExp(`^${out}$`, 'i');
  } catch {
    return new RegExp(`^${pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
  }
}

// The gateway's evaluate is exact-or-'*' on the PRODUCT side; only the api
// pattern goes through fnmatch.
function productMatches(side, product) {
  return side === '*' || side.toLowerCase() === product.toLowerCase();
}

function sideMatches(side, value) {
  return fnmatchRegex(side).test(value);
}

// The gateway's add scope vocabulary (probed 2026-10-10): exactly these
// four, matched by exact string. permanent is among them — the real
// gateway accepts it and writes the rule into the operator's policy file;
// this fixture keeps every add in the in-memory overlay, and the devkit
// face's permanent floor makes the spelling unreachable through
// gateway_call anyway.
const SCOPE_VOCAB = new Set(['permanent', 'temporary', 'session', 'once']);

// File-layer mirror: the real gateway resolves its policy file from
// --policy; this fixture reuses that argv entry, so file-layer rules and
// removes run against real bytes instead of the in-memory overlay alone.
function policyFilePath() {
  const index = process.argv.indexOf('--policy');
  return index >= 0 ? process.argv[index + 1] : null;
}
function readFileText() {
  const path = policyFilePath();
  if (!path) return '';
  try {
    return fs.readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}
function fileLines() {
  return readFileText()
    .split('\n')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '' && !entry.startsWith('#'));
}
function writeFileLines(lines) {
  const path = policyFilePath();
  if (!path) return;
  fs.writeFileSync(path, lines.length === 0 ? '' : `${lines.join('\n')}\n`);
}

// The fixture's execute-path matching, routed through the SHARED
// semantic surface (round-11: the previous inline lastIndexOf/split copy
// was effect-blind — a deny line could authorize an execute — and
// skipped the per-side trim the gateway's parse_policy applies). The
// gateway's evaluate is FIRST-MATCH-WINS over side-matching lines: the
// first line whose sides match decides, and a deny there refuses (the
// probe must not skip past a matching deny to a later allow).
function sideMatchOf(line, product, api) {
  const key = semanticKeyOf(line);
  if (key.startsWith('empty:') || key.startsWith('unparseable:') || key.startsWith('server:')) return null;
  const eq = key.lastIndexOf('::');
  const effect = key.slice(eq + 2);
  const [productSide, apiPattern] = key.slice(0, eq).split('::');
  if (!productMatches(productSide, product) || !sideMatches(apiPattern, api)) return null;
  return effect === 'allow';
}

function matchingRule(product, api) {
  const hitIndex = rules.findIndex((rule) => sideMatchOf(rule.line, product, api) !== null);
  if (hitIndex < 0) return undefined;
  const hit = rules[hitIndex];
  // hitIndex rides along because the returned object is a spread copy, not
  // the array element: the once-burn in execute_api splices by index (a
  // copy's indexOf is -1, and splice(-1) eats the LAST rule).
  return { ...hit, grants: sideMatchOf(hit.line, product, api) === true, hitIndex };
}

// File-layer rule match for execute (the real gateway evaluates the
// overlay ++ file rules as one ordered set; the file layer grants with
// scope 'permanent' semantics, so a matching file grant survives every
// execute). First-match-wins with the same effect discipline.
function matchingFileRule(product, api) {
  const file = fileLines().find((fileLine) => sideMatchOf(fileLine, product, api) !== null);
  if (file === undefined) return null;
  return { line: file, scope: 'permanent', grants: sideMatchOf(file, product, api) === true };
}

// Per-line semantic keys, the fixture's single parse authority:
// empty:/unparseable:/server: for the non-rule kinds,
// product::pattern::effect for rules — acceptance checks and
// side-matching share one parse instead of two drifting copies.
function semanticKeyOf(text) {
  const stripped = String(text).trim();
  if (stripped === '' || stripped.startsWith('#')) return `empty:${stripped.toLowerCase()}`;
  const eq = stripped.lastIndexOf('=');
  const effect =
    eq < 0
      ? ''
      : stripped
          .slice(eq + 1)
          .trim()
          .toLowerCase();
  if (effect !== 'allow' && effect !== 'deny') return `unparseable:${stripped.toLowerCase()}`;
  const target = stripped.slice(0, eq).trim();
  if (target.startsWith('server:')) return `server:${stripped.toLowerCase()}`;
  const colon = target.indexOf(':');
  if (colon < 0 && target !== '*') return `unparseable:${stripped.toLowerCase()}`;
  const product = (colon < 0 ? '*' : target.slice(0, colon)).trim() || '*';
  const apiPattern = (colon < 0 ? '*' : target.slice(colon + 1)).trim() || '*';
  return `${product.toLowerCase()}::${apiPattern.toLowerCase()}::${effect}`;
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf('\n');
  while (newline >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line) handleLine(line);
    newline = buffer.indexOf('\n');
  }
});
process.stdin.on('end', () => process.exit(0));

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

function respond(id, payload) {
  send({
    jsonrpc: '2.0',
    id,
    result: {
      content: [{ type: 'text', text: JSON.stringify(payload) }],
      structuredContent: payload,
      isError: false,
    },
  });
}

function handleLine(line) {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }
  if (request && typeof request === 'object') recordRequest(request);
  if (request.method === 'initialize') {
    if (process.env.FAKE_FAIL_HANDSHAKE === '1') {
      send({ jsonrpc: '2.0', id: request.id, error: { code: -32603, message: 'fake handshake failure' } });
      return;
    }
    send({
      jsonrpc: '2.0',
      id: request.id,
      result: {
        protocolVersion: request.params?.protocolVersion ?? '2025-03-26',
        capabilities: {},
        serverInfo: { name: 'fake-open-mcp-sidecar', version: '0.0.0' },
      },
    });
  } else if (request.method === 'tools/list') {
    send({
      jsonrpc: '2.0',
      id: request.id,
      result: {
        tools: gatewayToolNames().map((name) => ({
          name,
          description: `fake gateway tool: ${name}`,
          inputSchema: { type: 'object' },
        })),
      },
    });
  } else if (request.method === 'tools/call') {
    // FAKE_SLOW_MS delays every tools/call answer by <ms> so a short caller
    // timeout lands in sidecar.request's timer (the forwarded:false catch
    // path) instead of a fast fake answer.
    const slowMs = Number(process.env.FAKE_SLOW_MS ?? '0');
    if (Number.isFinite(slowMs) && slowMs > 0) {
      setTimeout(() => handleToolsCall(request), slowMs);
      return;
    }
    handleToolsCall(request);
  } else if (request.id !== undefined) {
    send({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: `Method not found: ${request.method}` } });
  }
}

function handleToolsCall(request) {
  const name = request.params?.name;
  if (typeof name !== 'string' || !gatewayToolNames().includes(name)) {
    send({ jsonrpc: '2.0', id: request.id, error: { code: -32602, message: `Unknown tool: ${name}` } });
    return;
  }
  if (name === 'failing_tool') {
    // With arguments present, echo them as key=value text: validation
    // failures echo the offending input, and the error-path redaction
    // tests pin that shape. Empty arguments keep the fixed string so the
    // long-standing normalization assertions stay byte-identical.
    const args = request.params?.arguments ?? {};
    const entries = Object.entries(args);
    const text =
      entries.length === 0
        ? 'fake gateway tool failure'
        : `fake gateway tool failure ${entries.map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`).join(' ')}`;
    send({
      jsonrpc: '2.0',
      id: request.id,
      result: { content: [{ type: 'text', text }], isError: true },
    });
    return;
  }
  if (name === 'envelope_fail_tool') {
    send({
      jsonrpc: '2.0',
      id: request.id,
      result: {
        content: [{ type: 'text', text: JSON.stringify({ ok: false, reason: 'fake envelope failure' }) }],
        structuredContent: { ok: false, reason: 'fake envelope failure', tool: name },
        isError: false,
      },
    });
    return;
  }
  if (name === 'raw_text_tool') {
    send({
      jsonrpc: '2.0',
      id: request.id,
      result: { content: [{ type: 'text', text: 'not json at all' }], isError: false },
    });
    return;
  }
  if (name === 'json_error_tool') {
    // Validation failures echo the offending input as JSON inside an
    // isError envelope: the strongest redaction shape (the object walk
    // applies only when the text parses).
    send({
      jsonrpc: '2.0',
      id: request.id,
      result: {
        content: [{ type: 'text', text: JSON.stringify({ error: 'validation failed', ...request.params?.arguments }) }],
        isError: true,
      },
    });
    return;
  }
  if (name === 'manage_policy') {
    const args = request.params?.arguments ?? {};
    const line = String(args.line ?? '');
    // Exact-string action dispatch: the real gateway compares the raw
    // value (round-7 probe: 'ADD' is a guaranteed gateway rejection),
    // and the devkit face refuses non-canonical input outright — the
    // fixture never normalizes what it receives.
    const action = args.action;
    // Deliberate unmodeled divergences, probe-observed: real add
    // rejections echo {action, scope, policy} next to reason (that
    // shape is unreachable through gateway_call, the F1 floor fires
    // first), and real remove successes echo the removed rule's scope
    // (no test reads it).
    if (action === 'list') {
      // The real gateway's list shape (source-verified): the rules array
      // carries the overlay AND the file's semantic lines (scope
      // 'permanent'), overlay entries first (the gateway's own order,
      // re-probed 2026-10-11 against v0.2.0a4 — also this fixture's
      // overlay-first match precedence), and the 'policy' text field
      // carries the raw file including comments.
      const fileText = readFileText();
      const fileRows = fileLines().map((fileLine) => ({ line: fileLine, scope: 'permanent', expires_in: null }));
      respond(request.id, {
        ok: true,
        tool: name,
        action: 'list',
        policy: fileText,
        rules: [...rules.map((rule) => ({ line: rule.line, scope: rule.scope, expires_in: null })), ...fileRows],
      });
    } else if (action === 'add') {
      // The real gateway's add validates the line through parse_policy
      // and rejects unparseable ones outright (round-8 mirror). A line is
      // addable iff its semantic key is a product RULE. The scope check
      // is exact-string against the vocabulary: v0.2.0a4 rejects ' ONCE '
      // at add (re-probed 2026-10-11; round-5's never-burning ' ONCE '
      // grant was the pre-a4 gateway), so only canonical spellings are
      // ever stored — and burned — and the raw spelling echoes in the
      // rejection, never normalized.
      const key = semanticKeyOf(line);
      if (key.startsWith('empty:') || key.startsWith('unparseable:') || key.startsWith('server:')) {
        respond(request.id, { ok: false, reason: `规则格式非法：${line}` });
        return;
      }
      // A non-string scope stores scope:null, a grant that survives
      // every execute; only the devkit floor stops it on the real face.
      const scope = typeof args.scope === 'string' ? args.scope : null;
      if (scope !== null && !SCOPE_VOCAB.has(scope)) {
        respond(request.id, { ok: false, reason: `未知 scope: ${scope}（可选 ${[...SCOPE_VOCAB].join('/')}）` });
        return;
      }
      rules.push({ line, scope });
      // Success responses may carry fixture fields beyond the gateway's
      // envelope (tool, line, removed) — they serve test assertions.
      respond(request.id, { ok: true, tool: name, action: 'add', line, scope, policy: readFileText() });
    } else if (action === 'remove') {
      // The real gateway's remove envelope (source-verified rounds 7-8):
      // a scoped remove is rejected outright ("remove 不接受
      // scope/ttl_seconds 参数"); an unparseable line is rejected
      // ("规则格式非法"); a valid line that matches nothing is rejected
      // ("未找到匹配的规则"); a hit removes by SEMANTIC key, overlay
      // first then file, so spacing/case variants do not protect a rule.
      if (
        (args.scope !== undefined && args.scope !== null) ||
        (args.ttl_seconds !== undefined && args.ttl_seconds !== null)
      ) {
        respond(request.id, {
          ok: false,
          reason: 'remove 不接受 scope/ttl_seconds 参数（跨层匹配：先会话/临时后文件，首个语义命中移除）',
        });
        return;
      }
      const wanted = semanticKeyOf(line);
      if (wanted.startsWith('empty:') || wanted.startsWith('unparseable:') || wanted.startsWith('server:')) {
        respond(request.id, { ok: false, reason: `规则格式非法：${line}` });
        return;
      }
      let removed = false;
      // Overlay first, then the file layer — the real gateway's
      // cross-layer remove order.
      const index = rules.findIndex((rule) => semanticKeyOf(rule.line) === wanted);
      if (index >= 0) {
        rules.splice(index, 1);
        removed = true;
      } else {
        const file = fileLines();
        const fileIndex = file.findIndex((fileLine) => semanticKeyOf(fileLine) === wanted);
        if (fileIndex >= 0) {
          file.splice(fileIndex, 1);
          writeFileLines(file);
          removed = true;
        }
      }
      if (!removed) {
        respond(request.id, { ok: false, reason: `未找到匹配的规则：${line}` });
        return;
      }
      respond(request.id, { ok: true, tool: name, action: 'remove', line, removed: true, policy: readFileText() });
    } else {
      respond(request.id, { ok: false, reason: `unsupported manage_policy action: ${args.action}` });
    }
    return;
  }
  if (name === 'execute_api') {
    const args = request.params?.arguments ?? {};
    const product = String(args.product ?? '');
    const api = String(args.api ?? '');
    const rule = matchingRule(product, api) ?? matchingFileRule(product, api);
    if (!rule || rule.grants !== true) {
      // The probed v0.2.0a4 refusal reason in full: the tail teaches the
      // consent path (the manage_policy grant shapes) inline.
      respond(request.id, {
        ok: false,
        reason: `safety policy 拒绝执行 ${product}:${api}；如确需执行，请先经对话/交互式问询（如 question 工具）向用户确认后，调用 manage_policy 授予（line 支持传数组一次批量授予）：api=最小规则 '${product}:${api}=allow'（一次性）/api_session=最小规则 '${product}:${api}=allow'（会话内）/product=产品级规则 '${product}:*=allow'（会话内）/readonly=产品级只读规则集 '${product}:*List*=allow/${product}:*Show*=allow/${product}:*Get*=allow/${product}:*Query*=allow'（会话内，重启即失）/none=不授予`,
      });
      return;
    }
    // Only canonical spellings are ever stored (the add-side vocab
    // check rejects the rest), so the burn condition firing on 'once'
    // is vacuous-safe; the hitIndex splice is what aims the burn at
    // the granting rule instead of the last one.
    if (rule.scope === 'once' && rule.hitIndex !== undefined) rules.splice(rule.hitIndex, 1);
    respond(request.id, { ok: true, tool: name, executed: { product, api }, pid: process.pid });
    return;
  }
  // query_data / transform_data fall through to the echo below, which
  // carries their arguments (transform_data's out.path included).
  const payload = {
    ok: true,
    tool: name,
    arguments: request.params?.arguments ?? {},
    pid: process.pid,
    // Spawn-introspection echo: tests assert the sidecar's pin-unless-env
    // arg policy (was --mode passed? was --policy passed?) and the scratch
    // cwd through the round trip, without any extra protocol surface.
    argv: process.argv,
    cwd: process.cwd(),
    env: {
      HUAWEICLOUD_MCP_MODE: process.env.HUAWEICLOUD_MCP_MODE ?? null,
      HUAWEICLOUD_MCP_POLICY_FILE: process.env.HUAWEICLOUD_MCP_POLICY_FILE ?? null,
      HUAWEICLOUD_MCP_AUDIT_FILE: process.env.HUAWEICLOUD_MCP_AUDIT_FILE ?? null,
    },
  };
  respond(request.id, payload);
}
