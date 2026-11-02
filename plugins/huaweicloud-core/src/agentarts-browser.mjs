// AgentArts browser CONTROL-PLANE read bridge (B2). The 0.1.7 CLI has
// zero browser subcommands (toolkit tree grep — findings trap 61 context),
// so the SDK Browser class is the only path. This module mirrors the
// memory read bridge (agentarts-memory.mjs): inline python snippet over
// the CLI-owned interpreter, our own exit codes, allowlist child env,
// redaction on every surface, boundary validation with no coercion.
//
// Credential model (WIDER than the memory data-plane bridge, NARROWER
// than nothing): the browser control plane authenticates with the
// injected AK/SK (SDK-HMAC-SHA256, the list_agents posture) —
// injectCredentials stays ON. The data plane is not touched by these
// four reads: list/get browsers and profiles ride the control-plane
// client only, so no data endpoint and no browser api_key are needed.
//
// Request transport: STDIN, not argv (the repo-wide rule since
// interrogate round 2 — argv is process-list visible and a long name
// filter would hit the kernel per-argument limit).
//
// Failure contract: the snippet's exit codes are OURS (0 = JSON
// printed, 1 = failure, 3 = module missing) and the exception handler
// catches BaseException, NOT Exception — the SDK's ToolsAPIError
// extends BaseException (tools_http.py:10, findings trap A5/TH:10),
// so an `except Exception` bridge leaks the error past the handler and
// kills the child with an uncaught traceback. This is the single
// browser-specific deviation from the memory snippet.

import { mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync as writeSessionFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  buildChildEnv,
  DEFAULT_APPROVED_TIMEOUT_MS,
  hasInjectableCredentials,
  OUTPUT_DIR,
  READONLY_TIMEOUT_MS,
  runOverPythonCandidates,
  saveLargeOutput,
} from './agentarts-cli.mjs';
import {
  BROWSER_INVOKE_ACTIONS,
  BROWSER_READ_OPERATIONS,
  BROWSER_SESSION_OPERATIONS,
  BROWSER_WRITE_OPERATIONS,
} from './agentarts-browser-tools.mjs';
import { createApprovalTokenStore, hashNamespacedArgs } from './approval-tokens.mjs';
import { CREDENTIAL_KEY_TOKENS, redactCredentialShapes } from './redact-core.mjs';
import { redactSecrets } from './safety-policy.mjs';

// Bare-token prefixes for the plan-time loud-storage warning (R2): Huawei
// AKs (AKLT...), GitHub (ghp_/gho_), OpenAI-style (sk-), Slack (xox),
// Anthropic (sk-ant-), and URL-with-credentials shapes. Detection only —
// nothing here redacts; the warning text carries the decision to the user.
const BARE_TOKEN_PREFIX =
  /\b(?:AKLT[A-Za-z0-9]{8,}|ghp_[A-Za-z0-9]{16,}|gho_[A-Za-z0-9]{16,}|sk-ant-[A-Za-z0-9-]{16,}|sk-[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/\s:@]+:[^/\s:@]+@)/;

// Browser list bounds: the SDK client applies NO limit/offset cap
// (browser_client.py list methods pass them straight through), so the
// bridge holds the conservative 1-100 window (the memory list posture).
const BROWSER_LIMIT_RANGE = [1, 100];

const BROWSER_READ_SNIPPET = [
  'import json, sys',
  'try:',
  '    from agentarts.sdk import Browser',
  'except ModuleNotFoundError:',
  '    print("AGENTARTS_SDK_MISSING", file=sys.stderr)',
  '    sys.exit(3)',
  'try:',
  '    params = json.loads(sys.stdin.read())',
  '    client = Browser(region=params["region"])',
  '    op = params["operation"]',
  '    if op == "list_browsers" or op == "list_browser_profiles":',
  '        kwargs = {}',
  '        if params.get("name"): kwargs["name"] = params["name"]',
  '        if params.get("limit") is not None: kwargs["limit"] = params["limit"]',
  '        if params.get("offset") is not None: kwargs["offset"] = params["offset"]',
  '        if params.get("sort_key"): kwargs["sort_key"] = params["sort_key"]',
  '        if params.get("sort_dir"): kwargs["sort_dir"] = params["sort_dir"]',
  '        if op == "list_browsers":',
  '            result = client.list_browsers(**kwargs)',
  '        else:',
  '            result = client.list_browser_profiles(**kwargs)',
  '    elif op == "get_browser":',
  '        result = client.get_browser(params["browser_id"])',
  '    elif op == "get_browser_profile":',
  '        result = client.get_browser_profile(params["profile_id"])',
  '    else:',
  '        print("AGENTARTS_BROWSER_BAD_OPERATION", file=sys.stderr)',
  '        sys.exit(2)',
  '    print(json.dumps(result, ensure_ascii=False, default=lambda o: getattr(o, "__dict__", str(o))))',
  // SystemExit must propagate (R1 review round): the bad-operation
  // sys.exit(2) inside the try raises SystemExit, which extends
  // BaseException — an unqualified BaseException handler converts our
  // own exit-2 contract into "SystemExit: 2" on stderr with exit 1.
  // Re-raising SystemExit first preserves BOTH the ToolsAPIError catch
  // and the exit-code contract.
  'except SystemExit:',
  '    raise',
  // ToolsAPIError extends BaseException (tools_http.py:10) — an
  // `except Exception` handler cannot catch it and the child dies with
  // an uncaught traceback instead of our exit-1 contract.
  'except BaseException as error:',
  '    print("{}: {}".format(type(error).__name__, error), file=sys.stderr)',
  '    sys.exit(1)',
].join('\n');

// Legal top-level parameter keys — a typo'd field must not vanish
// silently (the silent-no-op class; the memory bridge's rule). Tag
// filters exist on the SDK list methods but are deliberately NOT
// exposed: they stay unknown-param-rejected until a measured need.
const BROWSER_READ_PARAM_KEYS = [
  'operation',
  'browser_id',
  'profile_id',
  'name',
  'limit',
  'offset',
  'sort_key',
  'sort_dir',
  'region',
];

// Per-operation applicability: a legal key in the wrong operation is a
// silent no-op otherwise. Every operation takes operation/region; the
// map lists the rest.
const OP_PARAM_APPLICABILITY = {
  list_browsers: ['name', 'limit', 'offset', 'sort_key', 'sort_dir'],
  list_browser_profiles: ['name', 'limit', 'offset', 'sort_key', 'sort_dir'],
  get_browser: ['browser_id'],
  get_browser_profile: ['profile_id'],
};

function rejectUnknownParams(params, legalKeys, operation) {
  const applicable = OP_PARAM_APPLICABILITY[operation] ?? [];
  for (const key of Object.keys(params)) {
    if (!legalKeys.includes(key)) {
      return `Unknown parameter "${key}" — legal keys: ${legalKeys.join(', ')}.`;
    }
    if (!['operation', 'region'].includes(key) && !applicable.includes(key)) {
      return `"${key}" is not a parameter of ${operation} — it would be silently ignored. Applicable keys for ${operation}: ${applicable.join(', ') || '(none beyond operation/region)'}.`;
    }
  }
  return null;
}

// Boundary validation (the tool's front door — the snippet trusts what
// arrives). Returns an error string or null. Strict typing throughout:
// mistyped values are rejected, never coerced (the memory bridge's
// interrogate-round-1/2/3 policy).
// The SDK's own client-side validators, enforced at THIS boundary so a
// deterministic child failure cannot waste a spawn (or burn a write
// token — the R1 review round's boundary-burn class): sort_key is
// created_at|updated_at (browser_client.py:370-372), the list name
// filter is 2-40 chars (:378-380), and ids are UUIDs (:460-463).
const BROWSER_SORT_KEYS = ['created_at', 'updated_at'];
const BROWSER_NAME_FILTER_RANGE = [2, 40];
const UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function validateBrowserRead(params) {
  if (!BROWSER_READ_OPERATIONS.includes(params.operation)) {
    return `operation must be one of: ${BROWSER_READ_OPERATIONS.join(', ')}.`;
  }
  const unknown = rejectUnknownParams(params, BROWSER_READ_PARAM_KEYS, params.operation);
  if (unknown) return unknown;
  const need = (field, message) => {
    if (typeof params[field] !== 'string' || params[field].length === 0) return message;
    return null;
  };
  if (params.operation === 'get_browser') {
    const err = need('browser_id', 'browser_id is required for get_browser.');
    if (err) return err;
    if (!UUID_PATTERN.test(params.browser_id)) {
      return 'browser_id must be a valid UUID (the SDK validates the format client-side and rejects anything else — pass the id exactly as list_browsers returned it).';
    }
  }
  if (params.operation === 'get_browser_profile') {
    const err = need('profile_id', 'profile_id is required for get_browser_profile.');
    if (err) return err;
    if (!UUID_PATTERN.test(params.profile_id)) {
      return 'profile_id must be a valid UUID (the SDK validates the format client-side — pass the id exactly as list_browser_profiles returned it).';
    }
  }
  for (const field of ['name', 'sort_key']) {
    if (params[field] !== undefined && params[field] !== null) {
      if (typeof params[field] !== 'string' || params[field].length === 0) {
        return `${field} must be a non-empty string when provided — mistyped values are rejected, not coerced.`;
      }
    }
  }
  if (params.name !== undefined && params.name !== null) {
    if (params.name.length < BROWSER_NAME_FILTER_RANGE[0] || params.name.length > BROWSER_NAME_FILTER_RANGE[1]) {
      return `name must be ${BROWSER_NAME_FILTER_RANGE[0]}-${BROWSER_NAME_FILTER_RANGE[1]} characters (the SDK's own client-side filter rule).`;
    }
  }
  if (params.sort_key !== undefined && params.sort_key !== null && !BROWSER_SORT_KEYS.includes(params.sort_key)) {
    return `sort_key must be one of: ${BROWSER_SORT_KEYS.join(', ')} (the SDK's own client-side rule).`;
  }
  if (params.sort_dir !== undefined && params.sort_dir !== null && !['asc', 'desc'].includes(params.sort_dir)) {
    return 'sort_dir must be "asc" or "desc".';
  }
  for (const field of ['limit', 'offset']) {
    if (params[field] !== undefined && params[field] !== null) {
      const value = params[field];
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || Object.is(value, -0)) {
        return `${field} must be an integer (got ${typeof value}) — mistyped values are rejected, not coerced.`;
      }
      if (field === 'limit' && (value < BROWSER_LIMIT_RANGE[0] || value > BROWSER_LIMIT_RANGE[1])) {
        return `limit must be ${BROWSER_LIMIT_RANGE[0]}-${BROWSER_LIMIT_RANGE[1]} (conservative bridge window; SDK applies no cap).`;
      }
      if (field === 'offset' && value < 0) return 'offset must be >= 0 (0-based).';
    }
  }
  // region: a mistyped region silently became the cn-southwest-2 default
  // in the memory bridge once — rejected at the boundary here too.
  if (params.region !== undefined && params.region !== null) {
    if (typeof params.region !== 'string' || params.region.length === 0) {
      return 'region must be a non-empty string when provided.';
    }
  }
  return null;
}

// Parse the snippet's stdout into a redacted object, or null (exit 0
// with unparseable stdout is output pollution — the envelope's detector).
function parseSnippetStdout(result) {
  if (result.timedOut || result.exitCode !== 0) return null;
  try {
    const parsed = JSON.parse(result.stdout);
    return parsed === null || parsed === undefined ? null : redactSecrets(parsed);
  } catch {
    return null;
  }
}

// Shared payload ENVELOPE, the memory bridge's shape verbatim (parse,
// redact, fail, truncate, assemble — no operation-specific enrichment).
function shapeBrowserResult(result, candidate, params, timeoutMs, parsed = parseSnippetStdout(result)) {
  const failed = result.timedOut || result.exitCode !== 0 || parsed === null;
  const safeStdout = redactSecrets(result.stdout || '');
  const largeOutputFile = saveLargeOutput(safeStdout);
  const payloadStdout = largeOutputFile
    ? `${safeStdout.slice(0, 2000)}\n...(truncated, full output saved to ${largeOutputFile})`
    : safeStdout;
  const parsePolluted = !result.timedOut && result.exitCode === 0 && parsed === null;
  return {
    ok: !failed,
    service: 'AgentArts',
    operation: `browser ${params.operation} (SDK control plane; no CLI subcommand in 0.1.7)`,
    executable: candidate,
    exitCode: result.exitCode,
    failureDetected: failed,
    ...(largeOutputFile || failed ? {} : { result: parsed }),
    stdout: payloadStdout,
    stderr: redactSecrets(result.stderr || ''),
    ...(result.timedOut
      ? { timedOut: true, error: `agentarts browser ${params.operation} timed out after ${timeoutMs} ms.` }
      : {}),
    ...(parsePolluted
      ? {
          error:
            'exit 0 but stdout was not parseable JSON — output pollution suspected (the snippet prints clean JSON on success).',
        }
      : {}),
    // R10: an ok:false payload ALWAYS carries an error — a plain exit-1
    // failure previously carried none, and every downstream `${payload.error}`
    // mapping then prefixed its guidance with the literal "undefined".
    ...(failed && !result.timedOut && !parsePolluted
      ? { error: 'Execution failed (see stderr for the SDK error).' }
      : {}),
  };
}

// Read-bridge post-processing (the enrichMemoryRead pattern). The one
// browser load-bearing advisory: an API_KEY-typed browser cannot be
// driven by this toolkit's default posture (the console key is the only
// route — trap 61), so the read surface teaches it exactly where the
// agent discovers the resource it was about to pick.
function enrichBrowserRead(payload, params, parsed) {
  if (!payload.ok) return payload; // advisories describe RESULTS — a failed call has none
  const notes = [];
  const collectAuthTypes = (entry) =>
    entry && typeof entry === 'object' && typeof entry.auth_type === 'string' ? [entry.auth_type] : [];
  const entries = Array.isArray(parsed?.items)
    ? parsed.items.flatMap((entry) => collectAuthTypes(entry))
    : collectAuthTypes(parsed);
  if (entries.includes('API_KEY')) {
    notes.push(
      'API_KEY-typed browser in results: the data plane needs the console api_key (HUAWEICLOUD_SDK_BROWSER_API_KEY env) — create/get responses never return the key value (trap 61). Prefer an IAM-typed browser (or create one through the browser create tool), which signs the data plane with the same AK/SK this toolkit injects.',
    );
  }
  if (notes.length > 0) payload.notes = notes;
  return payload;
}

export async function readAgentartsBrowser(params = {}, options = {}) {
  const invalid = validateBrowserRead(params);
  if (invalid) {
    return {
      ok: false,
      service: 'AgentArts',
      operation: `browser ${params.operation || '(unknown)'} (SDK control plane)`,
      error: invalid,
    };
  }
  // Credential pre-gate (R1 review round, unanimous three-reviewer
  // finding): without injectable AK/SK the child falls through the
  // profile/metadata chain — the SDK's metadata provider
  // (http://169.254.169.254) is a live third link on runtime hosts, so
  // an unmanaged ambient identity can silently authenticate the read.
  // list_agents and the CLI readonly runner gate the same way; the
  // write twin gates before token consumption.
  if (hasInjectableCredentials() === false) {
    return {
      ok: false,
      service: 'AgentArts',
      operation: `browser ${params.operation} (SDK control plane)`,
      error:
        'No devkit credentials available for agentarts (HUAWEICLOUD_SDK_AK/SK injection). Run huaweicloud_auth_init first, or execute the command in your own terminal — the wrapper never falls back to unmanaged profile files or the metadata chain.',
    };
  }

  // The request carries ONLY non-secret parameters; AK/SK ride the child
  // env (injectCredentials on — the control plane is AK/SK-signed, the
  // list_agents posture; the memory data plane's narrower key-file model
  // does not apply here).
  const request = {
    operation: params.operation,
    region: typeof params.region === 'string' && params.region ? params.region : 'cn-southwest-2',
  };
  for (const field of ['browser_id', 'profile_id', 'name', 'sort_key', 'sort_dir']) {
    if (typeof params[field] === 'string' && params[field]) request[field] = params[field];
  }
  for (const field of ['limit', 'offset']) {
    if (params[field] !== undefined && params[field] !== null) request[field] = params[field];
  }
  const jsonArg = JSON.stringify(request);

  const childEnv = buildChildEnv({ injectCredentials: true });
  const timeoutMs = options.timeoutMs ?? READONLY_TIMEOUT_MS;
  const args = ['-c', BROWSER_READ_SNIPPET];

  return runOverPythonCandidates({
    args,
    childEnv,
    timeoutMs,
    stdinData: jsonArg,
    runCandidate: options.runCandidate,
    shapeResult: (result, candidate) => {
      const parsed = parseSnippetStdout(result);
      return enrichBrowserRead(shapeBrowserResult(result, candidate, params, timeoutMs, parsed), params, parsed);
    },
  });
}

// Tool dispatch (definitions live in agentarts-browser-tools.mjs).
export async function callAgentartsBrowserTool(name, rawArgs = {}) {
  if (name === 'huaweicloud_agentarts_browser_read') return readAgentartsBrowser(rawArgs);
  if (name === 'huaweicloud_agentarts_browser_plan') return planAgentartsBrowserWrite(rawArgs);
  if (name === 'huaweicloud_agentarts_browser_write') return runAgentartsBrowserWrite(rawArgs);
  if (name === 'huaweicloud_agentarts_browser_session') return runAgentartsBrowserSession(rawArgs);
  if (name === 'huaweicloud_agentarts_browser_invoke') return runAgentartsBrowserInvoke(rawArgs);
  return { ok: false, error: `Unknown agentarts browser tool: ${name}` };
}

// ---------------------------------------------------------------------------
// WRITE bridge (B3): browser + profile resource lifecycle, token-gated
// like every approved cloud write in this repo. The canonical request
// carries ONLY non-secret parameters (names, ids, tags, region); AK/SK
// ride the child env exactly as the read bridge does.
//
// Plan-time credential-shape warning over description and tag values
// (the memory bridge's loud-storage pattern, browser-worded — R1 review
// round): browser descriptions/tags are display metadata, not a
// retrieval store like memory content, BUT the tag {key, value} JSON
// shape defeats the at-rest redactor's key[:=] adjacency, so a
// secret-shaped value riding tags lands UNMASKED in approvals.json
// (0600, 5-minute TTL). The warning is the only surface that flags it.

// Per-operation WRITE metadata (the memory bridge's registry pattern):
// labels on the plan/approval surface, replay guidance per op. A new
// write operation without an entry fails LOUDLY here — key parity with
// BROWSER_WRITE_OPERATIONS is pinned in structure.test.mjs.
const WRITE_OPERATION_META = {
  create_browser: { labels: [] },
  update_browser: { labels: [] },
  delete_browser: { labels: ['irreversible'] },
  create_browser_profile: { labels: [] },
  delete_browser_profile: { labels: ['irreversible'] },
  start_session: {
    labels: [],
    approvalScope:
      ' One approval starts the session AND its lease: the domain fence and timeout shown above are what the cloud session will enforce (fence hits are only detectable via current_url — trap 65).',
  },
  save_profile: { labels: [] },
  update_stream: { labels: [] },
};

const BROWSER_NAME_PATTERN = /^[a-z][a-z0-9-]{0,38}[a-z0-9]$/;
const API_KEY_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

const BROWSER_WRITE_PARAM_KEYS = [
  'operation',
  'name',
  'auth_type',
  'api_key_name',
  'description',
  'browser_id',
  'profile_id',
  'session_id',
  'browser_name',
  'session_name',
  'session_timeout',
  'viewport',
  'allowed_domains',
  'blocked_domains',
  'profile_configuration',
  'stream_status',
  'tags',
  'region',
];

const BROWSER_WRITE_OP_APPLICABILITY = {
  create_browser: ['name', 'auth_type', 'api_key_name', 'description', 'tags'],
  update_browser: ['browser_id', 'tags'],
  delete_browser: ['browser_id'],
  create_browser_profile: ['name', 'description', 'tags'],
  delete_browser_profile: ['profile_id'],
  start_session: [
    'browser_name',
    'session_name',
    'session_timeout',
    'viewport',
    'allowed_domains',
    'blocked_domains',
    'profile_configuration',
  ],
  save_profile: ['session_id', 'profile_id'],
  update_stream: ['session_id', 'stream_status'],
};

function rejectUnknownWriteParams(params, operation) {
  const applicable = BROWSER_WRITE_OP_APPLICABILITY[operation] ?? [];
  for (const key of Object.keys(params)) {
    if (!BROWSER_WRITE_PARAM_KEYS.includes(key)) {
      return `Unknown parameter "${key}" — legal keys: ${BROWSER_WRITE_PARAM_KEYS.join(', ')}.`;
    }
    if (!['operation', 'region'].includes(key) && !applicable.includes(key)) {
      return `"${key}" is not a parameter of ${operation} — it would be silently ignored. Applicable keys for ${operation}: ${applicable.join(', ') || '(none beyond operation/region)'}.`;
    }
  }
  return null;
}

// Tags: max 20, unique keys, {key, value} string pairs (the SDK's own
// rules, BC:282-292). A malformed tag must fail at THIS boundary, not as
// a server 400 after the token is minted (or burned).
function validateTags(tags) {
  if (tags.length > 20) return 'tags must contain at most 20 items.';
  const seen = new Set();
  for (const [index, tag] of tags.entries()) {
    if (!tag || typeof tag !== 'object' || Array.isArray(tag)) {
      return `tags[${index}] must be an object {key, value}.`;
    }
    const keys = Object.keys(tag);
    if (keys.length !== 2 || !keys.includes('key') || !keys.includes('value')) {
      return `tags[${index}] must have exactly the keys "key" and "value" — got {${keys.join(', ')}}.`;
    }
    if (
      typeof tag.key !== 'string' ||
      tag.key.length === 0 ||
      typeof tag.value !== 'string' ||
      tag.value.length === 0
    ) {
      return `tags[${index}].key and .value must be non-empty strings.`;
    }
    if (seen.has(tag.key)) return `tags[${index}] duplicates key "${tag.key}" — tag keys must be unique.`;
    seen.add(tag.key);
  }
  return null;
}

function validateBrowserWrite(params) {
  if (!BROWSER_WRITE_OPERATIONS.includes(params.operation)) {
    return `operation must be one of: ${BROWSER_WRITE_OPERATIONS.join(', ')}.`;
  }
  const unknown = rejectUnknownWriteParams(params, params.operation);
  if (unknown) return unknown;
  const need = (field, message) => {
    if (typeof params[field] !== 'string' || params[field].length === 0) return message;
    return null;
  };
  if (params.operation === 'create_browser' || params.operation === 'create_browser_profile') {
    const err = need(
      'name',
      `name is required for ${params.operation} (pattern ^[a-z][a-z0-9-]{0,38}[a-z0-9]$, 2-40 chars).`,
    );
    if (err) return err;
    if (!BROWSER_NAME_PATTERN.test(params.name)) {
      return `name must match ^[a-z][a-z0-9-]{0,38}[a-z0-9]$ — 2-40 chars, lowercase letters/digits/hyphens, start lowercase letter, end lowercase letter or digit.`;
    }
    if (
      params.description !== undefined &&
      params.description !== null &&
      (typeof params.description !== 'string' || params.description.length === 0)
    ) {
      return 'description must be a non-empty string when provided.';
    }
    // 4096 on BOTH create ops (R1 review round): the SDK docstring
    // documents the limit for browsers (browser_client.py:198-199) and
    // enforces it client-side for profiles (:614-617). The browser-side
    // server behavior is unmeasured, but the cost asymmetry favors the
    // boundary: a false rejection is a clear retry-with-shorter-text,
    // while a real server 400 burns a minted approval token.
    if (params.operation === 'create_browser' && params.description && params.description.length > 4096) {
      return 'description must be at most 4096 characters (the SDK documents this limit for browsers and enforces it client-side for profiles).';
    }
    if (params.operation === 'create_browser_profile' && params.description && params.description.length > 4096) {
      return 'description must be at most 4096 characters (SDK limit for profiles).';
    }
  }
  if (params.operation === 'create_browser') {
    if (params.auth_type !== undefined && params.auth_type !== null && !['IAM', 'API_KEY'].includes(params.auth_type)) {
      return 'auth_type must be "IAM" or "API_KEY".';
    }
    const effectiveAuth = params.auth_type || 'IAM';
    if (effectiveAuth === 'API_KEY') {
      const err = need(
        'api_key_name',
        'api_key_name is required when auth_type=API_KEY (the SDK rejects the create without it).',
      );
      if (err) return err;
    }
    if (params.api_key_name !== undefined && params.api_key_name !== null) {
      if (effectiveAuth === 'IAM') {
        return 'api_key_name only applies to auth_type=API_KEY — with IAM the data plane signs with AK/SK and no key is ever issued (passing a name would name a key nothing uses).';
      }
      if (typeof params.api_key_name !== 'string' || !API_KEY_NAME_PATTERN.test(params.api_key_name)) {
        return 'api_key_name must match ^[a-zA-Z0-9_-]{1,64}$.';
      }
    }
  }
  if (params.operation === 'update_browser') {
    const err = need('browser_id', 'browser_id is required for update_browser.');
    if (err) return err;
    if (!UUID_PATTERN.test(params.browser_id)) {
      return 'browser_id must be a valid UUID (the SDK validates the format client-side BEFORE any network call — a malformed id would consume the approval token on a guaranteed no-op).';
    }
    if (!Array.isArray(params.tags) || params.tags.length === 0) {
      return 'update_browser requires a non-empty tags array — tags are the only updatable field this bridge exposes (the SDK also updates observability, an opaque dict not exposed here). An update with nothing to update is rejected.';
    }
  }
  if (params.operation === 'delete_browser') {
    const err = need('browser_id', 'browser_id is required for delete_browser.');
    if (err) return err;
    if (!UUID_PATTERN.test(params.browser_id)) {
      return 'browser_id must be a valid UUID (the SDK validates the format client-side BEFORE any network call — a malformed id would consume the approval token on a guaranteed no-op).';
    }
  }
  if (params.operation === 'delete_browser_profile') {
    const err = need('profile_id', 'profile_id is required for delete_browser_profile.');
    if (err) return err;
    if (!UUID_PATTERN.test(params.profile_id)) {
      return 'profile_id must be a valid UUID (the SDK validates the format client-side BEFORE any network call — a malformed id would consume the approval token on a guaranteed no-op).';
    }
  }
  if (params.tags !== undefined && params.tags !== null) {
    if (!Array.isArray(params.tags)) return 'tags must be an array of {key, value} objects.';
    const tagError = validateTags(params.tags);
    if (tagError) return tagError;
  }
  if (params.region !== undefined && params.region !== null) {
    if (typeof params.region !== 'string' || params.region.length === 0) {
      return 'region must be a non-empty string when provided.';
    }
  }
  const sessionError = validateBrowserWriteSessionExtension(params);
  if (sessionError) return sessionError;
  return null;
}

// The canonical request: plan and write build it from params the SAME
// way, so the approval token binds byte-identical JSON. create_browser
// canonicalizes auth_type=IAM when absent (the B1 verdict — the approval
// shows the EFFECTIVE request). Tags SORT by key (code-unit, not
// localeCompare — the token binds bytes and plan/write may run in
// different processes or locales); tag ORDER is semantically irrelevant,
// unlike memory's message order. An empty tags array is dropped (the
// SDK's `if tags:` treats [] as unset — the approval must show what
// executes).
function buildBrowserWriteRequest(params) {
  const request = {
    operation: params.operation,
    region: typeof params.region === 'string' && params.region ? params.region : 'cn-southwest-2',
  };
  const canonicalTags = (tags) => {
    if (!Array.isArray(tags) || tags.length === 0) return undefined;
    return [...tags]
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
      .map((tag) => ({
        key: tag.key,
        value: tag.value,
      }));
  };
  if (params.operation === 'create_browser') {
    request.name = params.name;
    request.auth_type = params.auth_type === 'API_KEY' ? 'API_KEY' : 'IAM';
    if (request.auth_type === 'API_KEY') request.api_key_name = params.api_key_name;
    if (typeof params.description === 'string' && params.description) request.description = params.description;
    const tags = canonicalTags(params.tags);
    if (tags) request.tags = tags;
  }
  if (params.operation === 'update_browser') {
    request.browser_id = params.browser_id;
    const tags = canonicalTags(params.tags);
    if (tags) request.tags = tags;
  }
  if (params.operation === 'delete_browser') request.browser_id = params.browser_id;
  if (params.operation === 'create_browser_profile') {
    request.name = params.name;
    if (typeof params.description === 'string' && params.description) request.description = params.description;
    const tags = canonicalTags(params.tags);
    if (tags) request.tags = tags;
  }
  if (params.operation === 'delete_browser_profile') request.profile_id = params.profile_id;
  return buildBrowserWriteRequestSessionExtension(request, params);
}

// Token namespace — distinct from the agentarts CLI and memory namespaces
// so a CLI or memory token can never authorize a browser write (and vice
// versa). The request JSON carries no secrets; hash-exact binding is the
// whole check.
const BROWSER_WRITE_TOKEN_CLI = 'agentarts-browser-sdk';

export function planAgentartsBrowserWrite(params = {}) {
  const invalid = validateBrowserWrite(params);
  if (invalid) {
    return {
      ok: false,
      service: 'AgentArts',
      operation: `browser ${params.operation || '(unknown)'} (SDK control plane)`,
      error: invalid,
    };
  }
  // Orphan guard (plan-time local check; the write rechecks pre-consume
  // with a coded rejection).
  if (params.operation === 'start_session') {
    const guard = guardExistingSession(params.browser_name);
    if (guard) {
      return {
        ok: false,
        service: 'AgentArts',
        operation: `browser ${params.operation} (SDK control plane)`,
        error: guard,
      };
    }
  }
  const request = buildBrowserWriteRequest(params);
  let approvalToken;
  try {
    approvalToken = createApprovalTokenStore(BROWSER_WRITE_TOKEN_CLI).create([JSON.stringify(request)]);
  } catch (error) {
    // Fail-closed store surfaced as a structured rejection (R3: the raw
    // throw escaped to the MCP layer as a bare -32603 — the write twin
    // already catches its consume).
    return {
      ok: false,
      service: 'AgentArts',
      operation: `browser ${params.operation} (SDK control plane)`,
      error: `The approval-token store could not be written (${error.message}) — no token was minted and nothing was executed. Fix the store access (~/.config/huaweicloud/approvals.json) and re-plan.`,
    };
  }
  // Loud-storage warning (R1 review round, restored from the memory
  // bridge's pattern with browser wording): the tag {key, value} shape
  // puts a credential-shaped NAME and its VALUE in separate JSON keys,
  // so neither redactSecrets' key[:=]-adjacency nor the approvals-store
  // scrub can mask them at rest — the warning is the only surface that
  // flags a secret riding tags or description into approvals.json.
  // Detection covers BOTH halves: a secret-shaped tag KEY (password/
  // token/api_key/… — the shape the at-rest redactor cannot see) and
  // credential-shaped free text in tag values or description.
  const warnings = [];
  // Bare-token prefixes (R2): a pasted AK or token as a bare tag VALUE under
  // an innocuous key rides at rest unflagged — redactCredentialShapes only
  // matches key[:=]-adjacent shapes, and the at-rest redactor has no
  // bare-token pattern at all. Scoped to this warning deliberately: the
  // global redactor over-redacting general text is a tradeoff this module
  // does not make for the whole repo.
  const credentialShaped = (text) =>
    typeof text === 'string' && (redactCredentialShapes(text) !== text || BARE_TOKEN_PREFIX.test(text));
  const secretKeyName = new RegExp(`(${CREDENTIAL_KEY_TOKENS.map((t) => t.replace(/_/g, '[_-]?')).join('|')})`, 'i');
  const descriptionFlagged = typeof params.description === 'string' && credentialShaped(params.description);
  const tagsFlagged =
    Array.isArray(params.tags) &&
    params.tags.some(
      (tag) =>
        tag &&
        typeof tag === 'object' &&
        (secretKeyName.test(String(tag.key || '')) || credentialShaped(String(tag.value || ''))),
    );
  if (descriptionFlagged || tagsFlagged) {
    warnings.push(
      'Some request content (description or tag key/value pairs) matches credential shapes (api_key/password/token patterns — the check is over-inclusive on ordinary key:value phrasing). The request persists in the approval store (0600, 5-minute TTL) with tag values UNMASKABLE by the at-rest redactor (the {key, value} JSON shape defeats key[:=] adjacency), and tags are visible on every future list/get of the resource — confirm the user intends THIS content on a cloud resource before presenting the request for approval.',
    );
  }
  // No ?? fallback (the memory bridge's round-3 rule): a write operation
  // added to the enum without a meta entry must FAIL LOUDLY here. Key
  // parity with BROWSER_WRITE_OPERATIONS is pinned in structure.test.mjs.
  const meta = WRITE_OPERATION_META[params.operation];
  const labels = meta.labels;
  const labelSuffix = labels.length > 0 ? ` Labels: ${labels.join(', ')}.` : '';
  const scopeText = typeof meta.approvalScope === 'function' ? meta.approvalScope(request) : meta.approvalScope;
  const authTypeNote =
    params.operation === 'create_browser'
      ? request.auth_type === 'IAM'
        ? ' auth_type defaults to IAM (canonicalized): the data plane signs with the same AK/SK this toolkit injects — no further setup needed for sessions and actions.'
        : ' auth_type=API_KEY: the data plane will need the console api_key (HUAWEICLOUD_SDK_BROWSER_API_KEY) — the create response never returns the key value (trap 61).'
      : '';
  return {
    ok: true,
    service: 'AgentArts',
    tier: 'approved',
    operation: `browser ${params.operation} (SDK control plane; no CLI subcommand in 0.1.7)`,
    labels,
    warnings,
    request,
    approvalToken,
    approvalNote: `Present the request above to the user.${labelSuffix} On explicit approval, run huaweicloud_agentarts_browser_write with THIS approvalToken, the SAME parameters, and approvedByUser: true (the token binds them exactly); otherwise discard it.${scopeText ?? ''}${authTypeNote}`,
  };
}

const BROWSER_WRITE_SNIPPET = [
  'import json, sys',
  'try:',
  '    from agentarts.sdk import Browser',
  'except ModuleNotFoundError:',
  '    print("AGENTARTS_SDK_MISSING", file=sys.stderr)',
  '    sys.exit(3)',
  'try:',
  '    # The request rides STDIN (the repo-wide rule): argv is process-list',
  '    # visible and a long description would hit the kernel argv limit.',
  '    params = json.loads(sys.stdin.read())',
  '    client = Browser(region=params["region"])',
  '    op = params["operation"]',
  '    if op == "create_browser":',
  '        kwargs = {"name": params["name"], "auth_type": params["auth_type"]}',
  '        if params.get("api_key_name"): kwargs["api_key_name"] = params["api_key_name"]',
  '        if params.get("description"): kwargs["description"] = params["description"]',
  '        if params.get("tags"): kwargs["tags"] = params["tags"]',
  '        result = client.create_browser(**kwargs)',
  '    elif op == "update_browser":',
  '        result = client.update_browser(params["browser_id"], tags=params["tags"])',
  '        if result is None:',
  '            # Empty-body 200 (R2): the SDK transport returns None when the',
  '            # response has no content — a SUCCESS misread as pollution by',
  '            # the envelope without this synthesis (the delete branches',
  '            # already synthesize for the same reason).',
  '            result = {"updated": True, "browser_id": params["browser_id"]}',
  '    elif op == "delete_browser":',
  '        client.delete_browser(params["browser_id"])',
  '        result = {"deleted": True, "browser_id": params["browser_id"]}',
  '    elif op == "create_browser_profile":',
  '        kwargs = {"name": params["name"]}',
  '        if params.get("description"): kwargs["description"] = params["description"]',
  '        if params.get("tags"): kwargs["tags"] = params["tags"]',
  '        result = client.create_browser_profile(**kwargs)',
  '    elif op == "delete_browser_profile":',
  '        client.delete_browser_profile(params["profile_id"])',
  '        result = {"deleted": True, "profile_id": params["profile_id"]}',
  '    else:',
  '        print("AGENTARTS_BROWSER_BAD_OPERATION", file=sys.stderr)',
  '        sys.exit(2)',
  '    print(json.dumps(result, ensure_ascii=False, default=lambda o: getattr(o, "__dict__", str(o))))',
  // SystemExit re-raise + BaseException catch: same as the read snippet
  // (SystemExit must not become "SystemExit: 2" with exit 1; the
  // bad-operation exit-2 path lives inside this try).
  'except SystemExit:',
  '    raise',
  // ToolsAPIError extends BaseException (tools_http.py:10) — same
  // deviation as the read snippet, same reason.
  'except BaseException as error:',
  '    print("{}: {}".format(type(error).__name__, error), file=sys.stderr)',
  '    sys.exit(1)',
].join('\n');

// Session-write post-processing: the start's session state capture (the
// LEASE — parsed from raw stdout so truncation cannot lose it) and the
// trap-61 api_key error mapping for API_KEY-typed browsers.
function enrichBrowserSessionWrite(payload, params, request, rawResult) {
  if (params.operation === 'start_session' && payload.ok) {
    const state = captureSessionState(rawResult, request);
    if (state) {
      // R7/R8 post-mint conflict disclosure: the guard is check-then-act
      // across the async spawn gap — a concurrent start on the same browser
      // can have minted another lease. Disclose instead of pretending
      // atomicity. R8: the filter applies the guard's OWN liveness
      // predicate (an already-expired concurrent lease is not "live" and
      // not an orphan hazard), and the scan runs in the save-failure
      // branch too (a foreign lease is disclosable even when our own
      // lease record could not be written).
      const concurrentNote = (browserName, ownId) => {
        const live = scanBrowserSessions().filter(
          (other) =>
            other.browser_name === browserName &&
            other.session_id !== ownId &&
            typeof other.lease_expires_at === 'number' &&
            other.lease_expires_at > Date.now(),
        );
        return live.length > 0
          ? ` CONCURRENT-START WARNING: ${live.length} other live lease(s) exist for browser "${browserName}" (${live.map((c) => c.session_id).join(', ')}) — the earlier cloud session is likely ORPHANED (the guard is check-then-act across the spawn; the SDK's own second start overwrites silently, BC:904-905). Stop the orphaned one via the console or wait for its timeout.`
          : '';
      };
      let saved = null;
      try {
        saved = saveBrowserSession(state);
      } catch (error) {
        // The lease carrier itself failed (disk/permissions) — the cloud
        // session is LIVE: disclose loudly instead of throwing past the
        // consumed-token disclosure (R7).
        payload.notes = [
          ...(payload.notes || []),
          `WARNING: the session state file could NOT be written (${error.message}) — the cloud session is live as session_id ${state.session_id} but this toolkit cannot drive or stop it. Stop the session via the console before it times out (${state.session_timeout}s).${concurrentNote(state.browser_name, state.session_id)}`,
        ];
      }
      if (saved && saved.ok) {
        const conflictNote = concurrentNote(state.browser_name, state.session_id);
        payload.notes = [
          ...(payload.notes || []),
          `Session lease recorded: session_id ${state.session_id}, lease expires at ${new Date(state.lease_expires_at).toISOString()} (${state.session_timeout}s). Drive it with huaweicloud_agentarts_browser_session (get_session / stop_session / take_control) by session_id; the state file is ${saved.path} (0600). live_view_endpoint (${state.live_view_endpoint || 'absent in response'}) is the human's live view.${conflictNote}`,
        ];
      } else if (saved && !saved.ok) {
        payload.notes = [
          ...(payload.notes || []),
          `WARNING: the session state file could not be recorded (${saved.error}) — the cloud session is live as session_id ${state.session_id} but this toolkit cannot drive it. Stop it via the console before it times out.${concurrentNote(state.browser_name, state.session_id)}`,
        ];
      }
    } else {
      // The session is LIVE in the cloud but the local lease could not be
      // captured (unexpected shape / non-UUID session id) — disclose
      // loudly: without the record, the session tool cannot address it.
      // Best-effort: surface whatever session id the raw response carried.
      let rawId = '(unreadable)';
      try {
        const raw = JSON.parse(rawResult.stdout);
        if (raw && raw.session && typeof raw.session.session_id === 'string') rawId = raw.session.session_id;
      } catch {
        // leave unreadable
      }
      payload.notes = [
        ...(payload.notes || []),
        `WARNING: the session state file could NOT be captured from the start response (unexpected shape) — the cloud session is live as session_id ${rawId} but this toolkit cannot drive or stop it by id. Stop the session via the console before it times out.`,
      ];
    }
  }
  const apiKeyMissing =
    /API Key is not provided/i.test(rawResult?.stderr || '') || /API Key is not provided/i.test(payload?.stderr || '');
  if (!payload.ok && apiKeyMissing) {
    payload.error = `${payload.error || 'Execution failed.'} The browser is API_KEY-typed: the data plane needs the console api_key exported as HUAWEICLOUD_SDK_BROWSER_API_KEY in the agent launcher's environment (the create response never returns the key value — trap 61). The token was consumed by this attempt — re-plan after exporting the key.`;
  }
  return payload;
}

// Replay (already_consumed) guidance, per-operation: what verify call
// answers "did it land" for each write shape.
function replayGuidanceNote(operation, concurrency) {
  const prefix = concurrency
    ? 'This token was consumed by a concurrent call — the write may already have executed.'
    : 'This token was already used — the write may already have executed.';
  const verify =
    operation === 'create_browser'
      ? 'huaweicloud_agentarts_browser_read (list_browsers by name)'
      : operation === 'start_session' || operation === 'update_stream'
        ? 'huaweicloud_agentarts_browser_session (get_session by the session id from the original result) or the local session state file'
        : operation === 'save_profile'
          ? 'huaweicloud_agentarts_browser_read (get_browser_profile per id)'
          : operation === 'update_browser' || operation === 'delete_browser'
            ? 'huaweicloud_agentarts_browser_read (get_browser per id — not-found on a delete means deleted; the update-family rule is success ≠ applied)'
            : 'huaweicloud_agentarts_browser_read (list_browser_profiles)';
  return `${prefix} Verify with ${verify} BEFORE re-planning anything.`;
}

// Write-side post-processing, composed around the envelope at the write
// call site (the memory bridge's symmetric extension point). Success
// notes teach the measured traps at the result surface; failure carries
// the burn disclosure. Notes describe the REQUEST semantics, not the
// response's field presence (R1 review round: an unconditional "in the
// result" claim breaks on SDK shape drift — the memory family gates its
// equivalents on parsed shape).
function enrichBrowserWrite(payload, params) {
  if (!payload.ok) {
    payload.error = `${payload.error || 'Execution failed.'} The single-use token was consumed by this attempt — re-plan for a retry.`;
    return payload;
  }
  const notes = [];
  if (params.operation === 'create_browser') {
    const authType = params.auth_type === 'API_KEY' ? 'API_KEY' : 'IAM';
    if (authType === 'API_KEY') {
      notes.push(
        'API_KEY-typed browser created: the data plane needs the console api_key (HUAWEICLOUD_SDK_BROWSER_API_KEY) — the create response never returns the key value (trap 61). Sessions and actions on this browser require that env var.',
      );
    }
    notes.push(
      'The create attaches the tenant-shared default gateway (persists across deletes — trap 63 family) and the response access_endpoint IS the data-plane base URL once https:// is prepended (trap 62).',
    );
  }
  if (params.operation === 'update_browser') {
    notes.push(
      'Verify with huaweicloud_agentarts_browser_read (get_browser): the update-family rule is success ≠ applied (measured on the sibling gateway family, trap 45) — the server may accept and silently drop fields.',
    );
  }
  if (params.operation === 'delete_browser' || params.operation === 'delete_browser_profile') {
    notes.push(
      'The delete returned before the list converged — a seconds-scale staleness window may still show the resource (trap 63). Poll list_browsers/list_browser_profiles to confirm deletion.',
    );
  }
  if (notes.length > 0) payload.notes = notes;
  return payload;
}

export async function runAgentartsBrowserWrite({ approvalToken, approvedByUser, ...params } = {}, options = {}) {
  const invalid = validateBrowserWrite(params);
  if (invalid) {
    return {
      ok: false,
      service: 'AgentArts',
      operation: `browser ${params.operation || '(unknown)'} (SDK control plane)`,
      error: invalid,
    };
  }
  // The repo's three-element approval contract: token + exact parameters +
  // the explicit attestation. Param validation runs FIRST (a pure data
  // error needs no attestation), the attestation throw second — the
  // memory bridge's deliberate ordering.
  if (approvedByUser !== true) {
    throw new Error(
      'approvedByUser must be true after explicit user approval of the plan request — run huaweicloud_agentarts_browser_plan, present the request to the user, and only then execute with the token.',
    );
  }
  if (typeof approvalToken !== 'string' || !approvalToken) {
    return {
      ok: false,
      service: 'AgentArts',
      operation: `browser ${params.operation} (SDK control plane)`,
      error:
        'approvalToken is required — run huaweicloud_agentarts_browser_plan first, present the request to the user, and pass the token plus the SAME parameters here on explicit approval.',
    };
  }
  const store = createApprovalTokenStore(BROWSER_WRITE_TOKEN_CLI);
  const inspection = store.inspect(approvalToken);
  if (inspection.state === 'already_consumed') {
    return {
      ok: true,
      status: 'ok',
      outcome: 'already_processed',
      note: replayGuidanceNote(params.operation, false),
    };
  }
  if (inspection.state === 'expired') {
    return {
      ok: false,
      status: 'rejected',
      code: 'CONFIRM_TOKEN_EXPIRED',
      service: 'AgentArts',
      operation: `browser ${params.operation} (SDK control plane)`,
      error: 'approvalToken expired — re-plan with huaweicloud_agentarts_browser_plan and get a fresh approval.',
    };
  }
  if (inspection.state === 'not_found') {
    return {
      ok: false,
      status: 'rejected',
      code: 'CONFIRM_TOKEN_NOT_FOUND',
      service: 'AgentArts',
      operation: `browser ${params.operation} (SDK control plane)`,
      error:
        'approvalToken not found (never created, pruned after the TTL, or minted in a different namespace) — a token consumed long ago may have had its tombstone pruned, in which case the write may already have executed: verify with huaweicloud_agentarts_browser_read BEFORE re-planning anything.',
    };
  }
  const request = buildBrowserWriteRequest(params);
  const requestHash = hashNamespacedArgs(BROWSER_WRITE_TOKEN_CLI, [JSON.stringify(request)]);
  if (requestHash !== inspection.entry.argsHash) {
    return {
      ok: false,
      status: 'rejected',
      code: 'CONFIRM_TOKEN_MISMATCH',
      service: 'AgentArts',
      operation: `browser ${params.operation} (SDK control plane)`,
      error:
        'approvalToken was minted for DIFFERENT parameters — the write binds the exact planned request. Re-plan with the changed parameters (the token stays valid for the original ones).',
    };
  }
  // Session-op pre-consumption guards (the CLI runner's order: a
  // guaranteed-no-op or policy-blocked write must not burn the approval):
  // (a) start_session rechecks the orphan guard (state may have changed
  // since plan); (b) save_profile/update_stream reload the session state
  // file (it may have been stopped or expired away between plan and
  // write).
  const isSessionWrite = ['start_session', 'save_profile', 'update_stream'].includes(params.operation);
  let sessionState = null;
  if (isSessionWrite && params.operation === 'start_session') {
    const guard = guardExistingSession(params.browser_name);
    if (guard) {
      return {
        ok: false,
        status: 'rejected',
        code: 'SESSION_LEASE_CONFLICT',
        service: 'AgentArts',
        operation: `browser ${params.operation} (SDK control plane)`,
        error: `${guard} The token was NOT consumed.`,
      };
    }
  }
  if (isSessionWrite && params.operation !== 'start_session') {
    const load = loadBrowserSession(params.session_id);
    if (!load.ok) {
      return {
        ok: false,
        status: 'rejected',
        code: 'SESSION_NOT_ON_RECORD',
        service: 'AgentArts',
        operation: `browser ${params.operation} (SDK data plane)`,
        error: `${load.error} The token was NOT consumed.`,
      };
    }
    sessionState = load.session;
  }
  // Credentials BEFORE consumption (the CLI runner's order; the memory
  // bridge checks its key file here): the browser control plane needs
  // injectable AK/SK, and a missing-credential rejection must not burn
  // the approval on a guaranteed no-op spawn.
  if (hasInjectableCredentials() === false) {
    return {
      ok: false,
      status: 'rejected',
      code: 'NO_DEVKIT_CREDENTIALS',
      service: 'AgentArts',
      operation: `browser ${params.operation} (SDK control plane)`,
      error:
        'No devkit credentials available for agentarts (HUAWEICLOUD_SDK_AK/SK injection). Run huaweicloud_auth_init first, or execute the command in your own terminal — the wrapper never falls back to unmanaged profile files or the metadata chain. The token was NOT consumed.',
    };
  }
  // Binding + credentials verified — consume (single-use tombstone) before
  // executing. The store write FAILS CLOSED (R2): a store that cannot
  // persist the tombstone must not let the write execute (a swallowed
  // failure used to report consume-success without the tombstone, and a
  // replay re-executed an approved write).
  let stored;
  try {
    stored = store.consume(approvalToken);
  } catch (error) {
    return {
      ok: false,
      status: 'rejected',
      code: 'TOKEN_STORE_UNWRITABLE',
      service: 'AgentArts',
      operation: `browser ${params.operation} (SDK control plane)`,
      error: `The approval-token store could not be updated (${error.message}) — the token was NOT consumed and the write did NOT execute. Fix the store access (~/.config/huaweicloud/approvals.json), then retry with the SAME token.`,
    };
  }
  if (!stored) {
    const recheck = store.inspect(approvalToken);
    if (recheck.state === 'already_consumed') {
      return {
        ok: true,
        status: 'ok',
        outcome: 'already_processed',
        note: replayGuidanceNote(params.operation, true),
      };
    }
    return {
      ok: false,
      status: 'rejected',
      code: recheck.state === 'expired' ? 'CONFIRM_TOKEN_EXPIRED' : 'CONFIRM_TOKEN_NOT_FOUND',
      service: 'AgentArts',
      operation: `browser ${params.operation} (SDK control plane)`,
      error: 'approvalToken could not be consumed (raced and pruned?) — re-plan.',
    };
  }
  const childEnv = buildChildEnv({ injectCredentials: true });
  const timeoutMs = options.timeoutMs ?? DEFAULT_APPROVED_TIMEOUT_MS;
  // Session ops take the session snippet and the EXECUTION request (the
  // canonical token-bound request plus the state-file context — see
  // buildSessionWriteExecutionRequest); resource ops run the canonical
  // request verbatim.
  const args = ['-c', isSessionWrite ? BROWSER_SESSION_WRITE_SNIPPET : BROWSER_WRITE_SNIPPET];
  const executionRequest = isSessionWrite ? buildSessionWriteExecutionRequest(request, sessionState) : request;
  const outcome = await runOverPythonCandidates({
    args,
    childEnv,
    timeoutMs,
    stdinData: JSON.stringify(executionRequest),
    runCandidate: options.runCandidate,
    shapeResult: (result, candidate) => {
      const parsed = parseSnippetStdout(result);
      const payload = enrichBrowserWrite(shapeBrowserResult(result, candidate, params, timeoutMs, parsed), params);
      if (isSessionWrite) return enrichBrowserSessionWrite(payload, params, request, result);
      return payload;
    },
  });
  // Fallthrough honesty (the memory bridge's round-1/2 rule): when NO
  // python candidate could run the SDK, the generic install remediation
  // comes back marked unshaped: true — shapeResult never ran, so the
  // consumed-token disclosure must come from here.
  if (!outcome.ok && outcome.unshaped === true) {
    outcome.error = `${outcome.error} The single-use approval token was already CONSUMED by this attempt and stays burned — after fixing the SDK install, re-plan (replaying this token returns already_processed without executing anything).`;
  }
  return outcome;
}

// ---------------------------------------------------------------------------
// B4: session lifecycle. start_session/save_profile/update_stream extend the
// WRITE pair (the session lease IS an approved boundary — it carries the
// domain fence and the timeout the user consented to); get/stop/take_control
// are the FREE session tool (reads, cleanup, human handoff — risk only
// decreases). The lease's local carrier is the 0600 session state file,
// written by the start write and deleted by stop.
//
// The state file carries NO credentials (IAM-typed browsers sign the data
// plane with the injected AK/SK; API_KEY-typed ones need the console key in
// HUAWEICLOUD_SDK_BROWSER_API_KEY, allowlisted through buildChildEnv — the
// file stores only the session context: names, ids, endpoints, expiry).

const SESSION_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;
const SESSION_TIMEOUT_RANGE = [60, 3600];

function browserSessionFile(sessionId) {
  if (!UUID_PATTERN.test(sessionId)) {
    return { ok: false, error: 'session_id must be a valid UUID (the id start_session returned).' };
  }
  const root = process.env.HUAWEICLOUD_HOME || homedir();
  return {
    ok: true,
    path: join(root, '.config', 'huaweicloud', `agentarts-browser-session-${sessionId}.json`),
  };
}

function loadBrowserSession(sessionId) {
  const file = browserSessionFile(sessionId);
  if (!file.ok) return { ok: false, error: file.error };
  let raw;
  try {
    raw = readFileSync(file.path, 'utf8');
  } catch {
    return {
      ok: false,
      error: `No session state file for session ${sessionId} (${file.path}). Sessions are recorded by the start_session write — if the session was started outside this toolkit, or its lease already ended and the file was removed, there is no local record to drive it from. Re-start the session through the browser write pair.`,
    };
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !parsed.session_id || !parsed.browser_name) {
      return {
        ok: false,
        error: `The session state file ${file.path} is malformed — delete it and re-start the session.`,
      };
    }
    // R10: the lease IS the approval boundary — a record without a numeric
    // lease_expires_at (or with a non-UUID inner session id that would ride
    // the wire and the screenshot filename) is malformed, not ungated.
    if (typeof parsed.lease_expires_at !== 'number' || !UUID_PATTERN.test(String(parsed.session_id))) {
      return {
        ok: false,
        error: `The session state file ${file.path} is malformed (missing lease or bad session id) — delete it and re-start the session.`,
      };
    }
    return { ok: true, session: parsed };
  } catch {
    return {
      ok: false,
      error: `The session state file ${file.path} is not parseable JSON — delete it and re-start the session.`,
    };
  }
}

function saveBrowserSession(state) {
  const file = browserSessionFile(state.session_id);
  if (!file.ok) return file;
  mkdirSync(dirname(file.path), { recursive: true });
  writeSessionFileSync(file.path, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 });
  return { ok: true, path: file.path };
}

function deleteBrowserSession(sessionId) {
  const file = browserSessionFile(sessionId);
  if (!file.ok) return;
  try {
    unlinkSync(file.path);
  } catch {
    // Already gone — the desired end state.
  }
}

// The orphan guard (trap A3 / BC:904-905): a second start_session on the
// same browser_name silently OVERWRITES the cloud session, orphaning it.
// The bridge rejects the second start while an unexpired local lease for
// the same browser exists, and opportunistically sweeps EXPIRED records
// for that browser (stale leases describe nothing live).
function scanBrowserSessions() {
  const root = process.env.HUAWEICLOUD_HOME || homedir();
  const dir = join(root, '.config', 'huaweicloud');
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const sessions = [];
  for (const entry of entries) {
    if (!entry.startsWith('agentarts-browser-session-') || !entry.endsWith('.json')) continue;
    try {
      const parsed = JSON.parse(readFileSync(join(dir, entry), 'utf8'));
      if (parsed && typeof parsed === 'object' && parsed.session_id && parsed.browser_name) {
        // Carry the FILE PATH: a non-UUID inner id cannot address the file
        // through browserSessionFile's UUID gate, and the sweep must
        // unlink malformed records regardless (R13).
        sessions.push({ ...parsed, __path: join(dir, entry) });
      }
    } catch {
      // Malformed session records are not this scan's problem — load-time
      // errors disclose them by session id.
    }
  }
  return sessions;
}

function guardExistingSession(browserName) {
  const now = Date.now();
  const matches = [];
  for (const session of scanBrowserSessions()) {
    if (session.browser_name !== browserName) continue;
    // R13: a record failing the session shape (no numeric lease / non-UUID
    // inner id) is undriveable AND unstoppable by every tool — holding the
    // guard hostage until expiry would dead-end the guard's own
    // remediation. Sweep it like an expired record (the cloud session, if
    // any, dies at its own timeout or via the console).
    const shapeOk = typeof session.lease_expires_at === 'number' && UUID_PATTERN.test(String(session.session_id));
    if (shapeOk && session.lease_expires_at > now) {
      matches.push(session);
    } else {
      // Stale or malformed record: the local lease describes nothing
      // actionable — sweep it BY PATH (a non-UUID inner id cannot go
      // through the UUID-gated delete helper).
      try {
        unlinkSync(session.__path);
      } catch {
        // Already gone.
      }
    }
  }
  if (matches.length > 0) {
    const live = matches
      .map((m) => `${m.session_id} (lease until ${new Date(m.lease_expires_at).toISOString()})`)
      .join(', ');
    return `An unexpired session lease already exists for browser "${browserName}": ${live}. A second start would silently ORPHAN the cloud session (the SDK overwrites without stopping — BC:904-905). Stop it first with huaweicloud_agentarts_browser_session (operation stop_session), or wait for the lease to expire.`;
  }
  return null;
}

// Deep-sort object keys (the memory bridge's canonicalization rule,
// duplicated for this module's independence): semantically identical
// objects produce the SAME canonical JSON so the token binds bytes.
function deepSortKeys(value) {
  if (Array.isArray(value)) return value.map((item) => deepSortKeys(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
        .map((key) => [key, deepSortKeys(value[key])]),
    );
  }
  return value;
}

function validateSessionDomains(candidate, name) {
  const domains = candidate[name];
  if (domains === undefined || domains === null) return null;
  if (!Array.isArray(domains) || domains.length === 0) {
    return `${name} must be a non-empty array of domain pattern strings when provided.`;
  }
  for (const [index, domain] of domains.entries()) {
    if (typeof domain !== 'string' || domain.length === 0) {
      return `${name}[${index}] must be a non-empty string.`;
    }
  }
  return null;
}

const needField = (candidate, field, message) =>
  typeof candidate[field] !== 'string' || candidate[field].length === 0 ? message : null;

// Session-lifecycle validation, composed INTO validateBrowserWrite at its
// tail (the write pair's single front door stays one function).
function validateBrowserWriteSessionExtension(candidate) {
  if (candidate.operation === 'start_session') {
    const err =
      needField(
        candidate,
        'browser_name',
        'browser_name is required for start_session (pattern ^[a-z][a-z0-9-]{0,38}[a-z0-9]$).',
      ) ??
      needField(
        candidate,
        'session_name',
        'session_name is required for start_session (pattern ^[a-zA-Z0-9_-]{1,128}$).',
      );
    if (err) return err;
    if (!BROWSER_NAME_PATTERN.test(candidate.browser_name)) {
      return 'browser_name must match ^[a-z][a-z0-9-]{0,38}[a-z0-9]$ — the browser resource name (list_browsers carries it).';
    }
    if (!SESSION_NAME_PATTERN.test(candidate.session_name)) {
      return 'session_name must match ^[a-zA-Z0-9_-]{1,128}$ (the SDK rejects anything else client-side).';
    }
    if (candidate.session_timeout !== undefined && candidate.session_timeout !== null) {
      const t = candidate.session_timeout;
      if (typeof t !== 'number' || !Number.isSafeInteger(t) || Object.is(t, -0)) {
        return 'session_timeout must be an integer (seconds).';
      }
      if (t < SESSION_TIMEOUT_RANGE[0] || t > SESSION_TIMEOUT_RANGE[1]) {
        return `session_timeout must be ${SESSION_TIMEOUT_RANGE[0]}-${SESSION_TIMEOUT_RANGE[1]} seconds (SDK default 900; a conservative bridge window — B1 measured 60 accepted).`;
      }
    }
    if (candidate.viewport !== undefined && candidate.viewport !== null) {
      const v = candidate.viewport;
      if (!v || typeof v !== 'object' || Array.isArray(v)) return 'viewport must be an object {width, height}.';
      const keys = Object.keys(v);
      if (keys.length !== 2 || !keys.includes('width') || !keys.includes('height')) {
        return 'viewport must have exactly the keys "width" and "height".';
      }
      for (const dim of ['width', 'height']) {
        if (typeof v[dim] !== 'number' || !Number.isSafeInteger(v[dim]) || v[dim] <= 0) {
          return `viewport.${dim} must be a positive integer.`;
        }
      }
    }
    if (Array.isArray(candidate.allowed_domains) && Array.isArray(candidate.blocked_domains)) {
      return 'allowed_domains and blocked_domains are mutually exclusive (the SDK rejects both).';
    }
    const domainError =
      validateSessionDomains(candidate, 'allowed_domains') ?? validateSessionDomains(candidate, 'blocked_domains');
    if (domainError) return domainError;
    if (candidate.profile_configuration !== undefined && candidate.profile_configuration !== null) {
      if (typeof candidate.profile_configuration !== 'object' || Array.isArray(candidate.profile_configuration)) {
        return 'profile_configuration must be an object (opaque, passed through as-is).';
      }
    }
  }
  if (candidate.operation === 'save_profile' || candidate.operation === 'update_stream') {
    if (candidate.region !== undefined && candidate.region !== null) {
      return `${candidate.operation} takes no region — the session's region/endpoint/auth type resolve from the session state file start_session recorded, never from tool args.`;
    }
  }
  if (candidate.operation === 'save_profile') {
    const err =
      needField(candidate, 'session_id', 'session_id is required for save_profile (the id start_session returned).') ??
      needField(candidate, 'profile_id', 'profile_id is required for save_profile.');
    if (err) return err;
    if (!UUID_PATTERN.test(candidate.session_id))
      return 'session_id must be a valid UUID (the id start_session returned).';
    if (!UUID_PATTERN.test(candidate.profile_id)) return 'profile_id must be a valid UUID.';
    const load = loadBrowserSession(candidate.session_id);
    if (!load.ok) return load.error;
  }
  if (candidate.operation === 'update_stream') {
    const err =
      needField(candidate, 'session_id', 'session_id is required for update_stream (the id start_session returned).') ??
      needField(candidate, 'stream_status', 'stream_status is required for update_stream (disabled or enabled).');
    if (err) return err;
    if (!UUID_PATTERN.test(candidate.session_id))
      return 'session_id must be a valid UUID (the id start_session returned).';
    if (!['disabled', 'enabled'].includes(candidate.stream_status)) {
      return 'stream_status must be "disabled" or "enabled".';
    }
    const load = loadBrowserSession(candidate.session_id);
    if (!load.ok) return load.error;
  }
  return null;
}

// Canonical request extension for the session ops (the token binds bytes):
// start_session carries the EFFECTIVE fence — domains SORTED (list order is
// semantically irrelevant), viewport/profile_configuration deep-sorted,
// session_timeout only when explicitly set (the SDK default 900 applies
// when omitted on BOTH sides of the binding). save_profile/update_stream
// bind only caller-visible fields — region/endpoint/auth come from the
// session state file at execution, never from the approval surface.
function buildBrowserWriteRequestSessionExtension(request, params) {
  if (params.operation === 'start_session') {
    request.browser_name = params.browser_name;
    request.session_name = params.session_name;
    if (params.session_timeout !== undefined && params.session_timeout !== null) {
      request.session_timeout = params.session_timeout;
    }
    if (params.viewport !== undefined && params.viewport !== null) {
      request.viewport = deepSortKeys(params.viewport);
    }
    if (params.profile_configuration !== undefined && params.profile_configuration !== null) {
      request.profile_configuration = deepSortKeys(params.profile_configuration);
    }
    for (const field of ['allowed_domains', 'blocked_domains']) {
      if (Array.isArray(params[field]) && params[field].length > 0) {
        request[field] = [...params[field]].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      }
    }
  }
  if (params.operation === 'save_profile') {
    delete request.region;
    request.session_id = params.session_id;
    request.profile_id = params.profile_id;
  }
  if (params.operation === 'update_stream') {
    delete request.region;
    request.session_id = params.session_id;
    request.stream_status = params.stream_status;
  }
  return request;
}

const BROWSER_SESSION_WRITE_SNIPPET = [
  'import json, sys',
  'try:',
  '    from agentarts.sdk import Browser',
  'except ModuleNotFoundError:',
  '    print("AGENTARTS_SDK_MISSING", file=sys.stderr)',
  '    sys.exit(3)',
  'try:',
  '    params = json.loads(sys.stdin.read())',
  '    op = params["operation"]',
  '    if op == "start_session":',
  '        # Trap 62: the data-plane endpoint has no region default and the',
  '        # missing-endpoint failure never mentions endpoints — resolve it',
  '        # from the control plane FIRST (list_browsers by name carries',
  '        # access_endpoint and auth_type directly).',
  '        probe = Browser(region=params["region"])',
  '        found = probe.list_browsers(name=params["browser_name"])',
  '        items = found.get("items") or []',
  '        if not items:',
  '            print("ToolsAPIError: browser {} not found — list_browsers by name returned nothing (verify with huaweicloud_agentarts_browser_read)".format(params["browser_name"]), file=sys.stderr)',
  '            sys.exit(1)',
  '        info = items[0]',
  '        # R7: the server-side name filter is EXACTNESS-UNMEASURED — a',
  '        # fuzzy or reordered match must not silently start the wrong',
  '        # browser (the approval bound this exact name).',
  '        if info.get("name") != params["browser_name"]:',
  '            print("ToolsAPIError: list_browsers returned {} for name {} — the name filter did not match exactly; refusing to start the wrong browser".format(info.get("name"), params["browser_name"]), file=sys.stderr)',
  '            sys.exit(1)',
  '        endpoint = info.get("access_endpoint")',
  '        if not endpoint:',
  '            print("ToolsAPIError: browser {} carries no access_endpoint (unexpected shape)".format(params["browser_name"]), file=sys.stderr)',
  '            sys.exit(1)',
  '        if not endpoint.startswith("http"):',
  '            endpoint = "https://" + endpoint',
  '        auth = info.get("auth_type") or "IAM"',
  '        client = Browser(region=params["region"], data_endpoint=endpoint, auth_type=auth)',
  '        kwargs = {"browser_name": params["browser_name"], "session_name": params["session_name"]}',
  '        if params.get("session_timeout") is not None: kwargs["session_timeout"] = params["session_timeout"]',
  '        if params.get("viewport"): kwargs["viewport"] = params["viewport"]',
  '        if params.get("profile_configuration"): kwargs["profile_configuration"] = params["profile_configuration"]',
  '        if params.get("allowed_domains"): kwargs["allowed_domains"] = params["allowed_domains"]',
  '        if params.get("blocked_domains"): kwargs["blocked_domains"] = params["blocked_domains"]',
  '        session = client.start_session(**kwargs)',
  '        # The bridge captures the session state file from THIS envelope:',
  '        # the browser half (endpoint resolution context) plus the raw',
  '        # start response (session_id, streams — B1-measured shape).',
  '        result = {"browser": {"id": info.get("id"), "name": info.get("name"), "auth_type": auth, "access_endpoint": endpoint}, "session": session}',
  '    elif op == "save_profile":',
  '        client = Browser(region=params["region"], data_endpoint=params["data_endpoint"], auth_type=params["auth_type"])',
  '        client.browser_name = params["browser_name"]',
  '        client.session_id = params["session_id"]',
  '        result = client.save_profile(profile_id=params["profile_id"])',
  '        if result is None:',
  '            result = {"saved": True, "profile_id": params["profile_id"]}',
  '    elif op == "update_stream":',
  '        client = Browser(region=params["region"], data_endpoint=params["data_endpoint"], auth_type=params["auth_type"])',
  '        client.browser_name = params["browser_name"]',
  '        client.session_id = params["session_id"]',
  '        result = client.update_stream(stream_status=params["stream_status"])',
  '        if result is None:',
  '            result = {"stream_status": params["stream_status"], "session_id": params["session_id"]}',
  '    else:',
  '        print("AGENTARTS_BROWSER_BAD_OPERATION", file=sys.stderr)',
  '        sys.exit(2)',
  '    print(json.dumps(result, ensure_ascii=False, default=lambda o: getattr(o, "__dict__", str(o))))',
  'except SystemExit:',
  '    raise',
  'except BaseException as error:',
  '    print("{}: {}".format(type(error).__name__, error), file=sys.stderr)',
  '    sys.exit(1)',
].join('\n');

// The session write's execution request is the CANONICAL (token-bound)
// request PLUS the resolved session context (region/data_endpoint/auth_type/
// browser_name for save/update come from the state file at execution time,
// never from the approval surface). For start_session the context resolves
// inside the snippet (control-plane probe).
function buildSessionWriteExecutionRequest(canonicalRequest, session) {
  const request = { ...canonicalRequest };
  if (session) {
    request.region = session.region;
    request.data_endpoint = session.data_endpoint;
    request.auth_type = session.auth_type;
    request.browser_name = session.browser_name;
    request.session_id = session.session_id;
  }
  return request;
}

// Post-execution session state capture for start_session: parsed from the
// RAW stdout (not the envelope's possibly-truncated result) — the lease
// record must exist even when the display payload truncated.
function captureSessionState(rawResult, request) {
  if (rawResult.timedOut || rawResult.exitCode !== 0) return null;
  try {
    const parsed = JSON.parse(rawResult.stdout);
    const browser = parsed && parsed.browser;
    const session = parsed && parsed.session;
    if (!browser || !session || typeof session !== 'object') return null;
    if (!session.session_id || !session.browser_name) return null;
    // A non-UUID session_id cannot address the 0600 state file — treat as
    // capture failure (the WARNING branch discloses the undriveable live
    // session, R7).
    if (!UUID_PATTERN.test(String(session.session_id))) return null;
    const startedAt = Date.now();
    const timeout = typeof request.session_timeout === 'number' ? request.session_timeout : 900;
    return {
      browser_id: browser.id,
      browser_name: session.browser_name,
      auth_type: browser.auth_type,
      region: request.region,
      data_endpoint: browser.access_endpoint,
      session_id: session.session_id,
      session_name: session.name || request.session_name,
      session_timeout: timeout,
      automation_endpoint: session.streams?.automation_stream?.stream_endpoint,
      live_view_endpoint: session.streams?.live_view_stream?.stream_endpoint,
      started_at: startedAt,
      lease_expires_at: startedAt + timeout * 1000,
    };
  } catch {
    return null;
  }
}

const BROWSER_SESSION_TOOL_SNIPPET = [
  'import json, sys',
  'try:',
  '    from agentarts.sdk import Browser',
  'except ModuleNotFoundError:',
  '    print("AGENTARTS_SDK_MISSING", file=sys.stderr)',
  '    sys.exit(3)',
  'try:',
  '    params = json.loads(sys.stdin.read())',
  '    client = Browser(region=params["region"], data_endpoint=params["data_endpoint"], auth_type=params["auth_type"])',
  '    client.browser_name = params["browser_name"]',
  '    client.session_id = params["session_id"]',
  '    op = params["operation"]',
  '    if op == "get_session":',
  '        result = client.get_session()',
  '        if result is None:',
  '            result = {"session_state": "unknown (empty response)"}',
  '    elif op == "stop_session":',
  '        client.stop_session()',
  '        result = {"stopped": True, "session_id": params["session_id"]}',
  '    elif op == "take_control":',
  '        result = client.update_stream(stream_status="disabled")',
  '        if result is None:',
  '            result = {"stream_status": "disabled", "session_id": params["session_id"]}',
  '    else:',
  '        print("AGENTARTS_BROWSER_BAD_OPERATION", file=sys.stderr)',
  '        sys.exit(2)',
  '    print(json.dumps(result, ensure_ascii=False, default=lambda o: getattr(o, "__dict__", str(o))))',
  'except SystemExit:',
  '    raise',
  'except BaseException as error:',
  '    print("{}: {}".format(type(error).__name__, error), file=sys.stderr)',
  '    sys.exit(1)',
].join('\n');

// Free-tier session tool (no approval token): get/stop/take_control over a
// recorded session lease.
export async function runAgentartsBrowserSession(params = {}, options = {}) {
  if (!BROWSER_SESSION_OPERATIONS.includes(params.operation)) {
    return {
      ok: false,
      service: 'AgentArts',
      operation: `browser session ${params.operation || '(unknown)'} (SDK data plane)`,
      error: `operation must be one of: ${BROWSER_SESSION_OPERATIONS.join(', ')}.`,
    };
  }
  for (const key of Object.keys(params)) {
    if (key !== 'operation' && key !== 'session_id') {
      return {
        ok: false,
        service: 'AgentArts',
        operation: `browser session ${params.operation} (SDK data plane)`,
        error: `Unknown parameter "${key}" — legal keys: operation, session_id. (Region/endpoint/auth type resolve from the session state file, never from tool args.)`,
      };
    }
  }
  if (typeof params.session_id !== 'string' || params.session_id.length === 0) {
    return {
      ok: false,
      service: 'AgentArts',
      operation: `browser session ${params.operation} (SDK data plane)`,
      error: 'session_id is required — the id start_session returned.',
    };
  }
  if (!UUID_PATTERN.test(params.session_id)) {
    return {
      ok: false,
      service: 'AgentArts',
      operation: `browser session ${params.operation} (SDK data plane)`,
      error: 'session_id must be a valid UUID (the id start_session returned).',
    };
  }
  if (hasInjectableCredentials() === false) {
    return {
      ok: false,
      service: 'AgentArts',
      operation: `browser session ${params.operation} (SDK data plane)`,
      error:
        'No devkit credentials available for agentarts (HUAWEICLOUD_SDK_AK/SK injection). Run huaweicloud_auth_init first, or execute the command in your own terminal — the wrapper never falls back to unmanaged profile files or the metadata chain.',
    };
  }
  const load = loadBrowserSession(params.session_id);
  if (!load.ok) {
    return {
      ok: false,
      service: 'AgentArts',
      operation: `browser session ${params.operation} (SDK data plane)`,
      error: load.error,
    };
  }
  const session = load.session;
  const request = {
    operation: params.operation,
    region: session.region,
    data_endpoint: session.data_endpoint,
    auth_type: session.auth_type,
    browser_name: session.browser_name,
    session_id: session.session_id,
  };
  const childEnv = buildChildEnv({ injectCredentials: true });
  const timeoutMs = options.timeoutMs ?? READONLY_TIMEOUT_MS;
  const args = ['-c', BROWSER_SESSION_TOOL_SNIPPET];
  const outcome = await runOverPythonCandidates({
    args,
    childEnv,
    timeoutMs,
    stdinData: JSON.stringify(request),
    runCandidate: options.runCandidate,
    shapeResult: (result, candidate) => {
      const parsed = parseSnippetStdout(result);
      const payload = shapeSessionToolResult(result, candidate, params, timeoutMs, parsed);
      return enrichBrowserSession(payload, params, session, result);
    },
  });
  return outcome;
}

// The session tool's envelope: same shape, data-plane operation label.
function shapeSessionToolResult(result, candidate, params, timeoutMs, parsed = parseSnippetStdout(result)) {
  const payload = shapeBrowserResult(result, candidate, params, timeoutMs, parsed);
  payload.operation = `browser session ${params.operation} (SDK data plane; no CLI subcommand in 0.1.7)`;
  return payload;
}

// Session-tool post-processing: lease staleness disclosure, stop's file
// cleanup, take_control's handoff teaching, and the trap-61 api_key error
// mapping (an API_KEY-typed session started without the console key fails
// with a message that never says where the key goes).
function enrichBrowserSession(payload, params, session, rawResult) {
  const now = Date.now();
  const expired = typeof session.lease_expires_at === 'number' && session.lease_expires_at <= now;
  const apiKeyMissing =
    /API Key is not provided/i.test(rawResult?.stderr || '') || /API Key is not provided/i.test(payload?.stderr || '');
  if (payload.ok) {
    const notes = [];
    if (params.operation === 'stop_session') {
      deleteBrowserSession(params.session_id);
      notes.push(
        `The local session lease record was removed (${browserSessionFile(params.session_id).path}). The SDK's stop is a no-op True on an already-gone session (trap 67) — success says the cleanup ran, not that the session was live.`,
      );
    }
    if (params.operation === 'take_control') {
      notes.push(
        'Automation stream disabled — the human owns the session now (page state is PRESERVED through the disable/enable cycle, trap 66). Re-arming the agent is the approved write update_stream with stream_status=enabled.',
      );
    }
    if (expired) {
      notes.push(
        `The local lease expired at ${new Date(session.lease_expires_at).toISOString()} — the cloud session dies independently at its own timeout and may already be gone.`,
      );
    }
    if (notes.length > 0) payload.notes = notes;
  } else if (apiKeyMissing) {
    payload.error = `${payload.error || 'Execution failed.'} The session's browser is API_KEY-typed: the data plane needs the console api_key exported as HUAWEICLOUD_SDK_BROWSER_API_KEY in the agent launcher's environment (the create response never returns the key value — trap 61).`;
  }
  return payload;
}

// ---------------------------------------------------------------------------
// B5: the lease-gated action tool. One invoke surface for all 18 action
// types; the lease recorded by start_session IS the approval boundary.
// Boundary validation reimplements the SDK wrappers' own rules
// (presses 1-100, keys 1-5, wait 0.1-30, quality 1-100, format png/jpeg —
// browser_client.py:1476-1641) so a deterministic client-side rejection
// cannot waste a spawn; the action dict is built HERE and the snippet makes
// ONE generic invoke call (no per-type Python branching).

const INVOKE_PARAM_KEYS = [
  'action',
  'session_id',
  'x',
  'y',
  'button',
  'click_count',
  'start_x',
  'start_y',
  'end_x',
  'end_y',
  'delta_x',
  'delta_y',
  'key',
  'presses',
  'keys',
  'text',
  'url',
  'format',
  'quality',
  'full_page',
  'duration',
  'tab_id',
];

const INVOKE_ACTION_PARAMS = {
  mouse_click: ['x', 'y', 'button', 'click_count'],
  mouse_move: ['x', 'y'],
  mouse_drag: ['start_x', 'start_y', 'end_x', 'end_y', 'button'],
  mouse_scroll: ['x', 'y', 'delta_x', 'delta_y'],
  key_press: ['key', 'presses'],
  key_type: ['text'],
  key_shortcut: ['keys'],
  navigate: ['url'],
  go_back: [],
  go_forward: [],
  refresh: [],
  get_page_info: [],
  screenshot: ['format', 'quality', 'full_page'],
  wait: ['duration'],
  list_tabs: [],
  switch_tab: ['tab_id'],
  close_tab: ['tab_id'],
  new_tab: ['url'],
};

// Defaults the SDK wrappers would fill (BC:1259-1720): applied here so the
// built action dict is explicit and identical between validation and
// execution.
const INVOKE_ACTION_DEFAULTS = {
  mouse_click: { button: 'left', click_count: 1 },
  mouse_drag: { button: 'left' },
  screenshot: { format: 'jpeg', quality: 80, full_page: false },
  key_press: { presses: 1 },
};

function validateBrowserInvoke(params) {
  if (!BROWSER_INVOKE_ACTIONS.includes(params.action)) {
    return `action must be one of: ${BROWSER_INVOKE_ACTIONS.join(', ')}.`;
  }
  if (typeof params.session_id !== 'string' || params.session_id.length === 0) {
    return 'session_id is required — the id start_session returned.';
  }
  if (!UUID_PATTERN.test(params.session_id)) {
    return 'session_id must be a valid UUID (the id start_session returned).';
  }
  // Unknown top-level keys: the typo'd-field rule (a legal key in the
  // wrong action is the silent-no-op class).
  const applicable = INVOKE_ACTION_PARAMS[params.action] ?? [];
  for (const key of Object.keys(params)) {
    if (!INVOKE_PARAM_KEYS.includes(key)) {
      return `Unknown parameter "${key}" — legal keys: ${INVOKE_PARAM_KEYS.join(', ')}.`;
    }
    if (!['action', 'session_id'].includes(key) && !applicable.includes(key)) {
      return `"${key}" is not a parameter of ${params.action} — it would be silently ignored. Applicable keys for ${params.action}: ${applicable.join(', ') || '(none beyond action/session_id)'}.`;
    }
  }
  // Per-field typing (the SDK wrappers' own rules, enforced BEFORE the
  // spawn so a deterministic child failure cannot waste it).
  const integerFields = [
    'x',
    'y',
    'click_count',
    'start_x',
    'start_y',
    'end_x',
    'end_y',
    'delta_x',
    'delta_y',
    'presses',
    'quality',
  ];
  for (const field of integerFields) {
    if (params[field] !== undefined && params[field] !== null) {
      const value = params[field];
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || Object.is(value, -0)) {
        return `${field} must be an integer (got ${typeof value}) — mistyped values are rejected, not coerced.`;
      }
    }
  }
  if (params.x !== undefined && params.x !== null && params.x < 0) return 'x must be >= 0.';
  if (params.y !== undefined && params.y !== null && params.y < 0) return 'y must be >= 0.';
  if (
    params.click_count !== undefined &&
    params.click_count !== null &&
    (params.click_count < 1 || params.click_count > 100)
  ) {
    return 'click_count must be 1-100.';
  }
  if (params.presses !== undefined && params.presses !== null && (params.presses < 1 || params.presses > 100)) {
    return 'presses must be 1-100 (the SDK rejects anything else client-side).';
  }
  if (params.quality !== undefined && params.quality !== null && (params.quality < 1 || params.quality > 100)) {
    return 'quality must be 1-100 (the SDK rejects anything else client-side).';
  }
  if (params.button !== undefined && params.button !== null && !['left', 'right', 'middle'].includes(params.button)) {
    return 'button must be "left", "right", or "middle".';
  }
  if (params.format !== undefined && params.format !== null && !['png', 'jpeg'].includes(params.format)) {
    return 'format must be "png" or "jpeg" (the SDK rejects anything else client-side).';
  }
  if (params.full_page !== undefined && params.full_page !== null && typeof params.full_page !== 'boolean') {
    return 'full_page must be a boolean.';
  }
  if (params.duration !== undefined && params.duration !== null) {
    if (typeof params.duration !== 'number' || !Number.isFinite(params.duration)) {
      return 'duration must be a number (seconds).';
    }
    if (params.duration < 0.1 || params.duration > 30) {
      return 'duration must be 0.1-30 seconds (the SDK rejects anything else client-side).';
    }
  }
  for (const field of ['key', 'text', 'url', 'tab_id']) {
    if (
      params[field] !== undefined &&
      params[field] !== null &&
      (typeof params[field] !== 'string' || params[field].length === 0)
    ) {
      return `${field} must be a non-empty string when provided.`;
    }
  }
  if (params.keys !== undefined && params.keys !== null) {
    if (!Array.isArray(params.keys) || params.keys.length < 1 || params.keys.length > 5) {
      return 'keys must be an array of 1-5 key names (the SDK rejects anything else client-side).';
    }
    for (const [index, key] of params.keys.entries()) {
      if (typeof key !== 'string' || key.length === 0) {
        return `keys[${index}] must be a non-empty string.`;
      }
    }
  }
  // Required params per action.
  if (params.action === 'mouse_click' || params.action === 'mouse_move' || params.action === 'mouse_scroll') {
    if (params.x === undefined || params.x === null) return 'x is required for this action.';
    if (params.y === undefined || params.y === null) return 'y is required for this action.';
  }
  if (params.action === 'mouse_drag') {
    for (const field of ['start_x', 'start_y', 'end_x', 'end_y']) {
      if (params[field] === undefined || params[field] === null) return `${field} is required for mouse_drag.`;
    }
  }
  if (params.action === 'key_press' && (params.key === undefined || params.key === null)) {
    return 'key is required for key_press.';
  }
  if (params.action === 'key_type' && (params.text === undefined || params.text === null)) {
    return 'text is required for key_type.';
  }
  if (params.action === 'key_shortcut' && (params.keys === undefined || params.keys === null)) {
    return 'keys is required for key_shortcut.';
  }
  if (params.action === 'navigate' && (params.url === undefined || params.url === null)) {
    return 'url is required for navigate.';
  }
  if (params.action === 'wait' && (params.duration === undefined || params.duration === null)) {
    return 'duration is required for wait.';
  }
  if (params.action === 'switch_tab' && (params.tab_id === undefined || params.tab_id === null)) {
    return 'tab_id is required for switch_tab.';
  }
  return null;
}

// Build the SDK action dict from validated params (defaults explicit).
function buildInvokeActionParams(params) {
  const applicable = INVOKE_ACTION_PARAMS[params.action] ?? [];
  const defaults = INVOKE_ACTION_DEFAULTS[params.action] || {};
  const action = {};
  for (const field of applicable) {
    if (params[field] !== undefined && params[field] !== null) {
      action[field] = params[field];
    } else if (defaults[field] !== undefined) {
      action[field] = defaults[field];
    }
  }
  return action;
}

const BROWSER_INVOKE_SNIPPET = [
  'import base64, json, os, sys, time',
  'try:',
  '    from agentarts.sdk import Browser',
  'except ModuleNotFoundError:',
  '    print("AGENTARTS_SDK_MISSING", file=sys.stderr)',
  '    sys.exit(3)',
  'try:',
  '    params = json.loads(sys.stdin.read())',
  '    client = Browser(region=params["region"], data_endpoint=params["data_endpoint"], auth_type=params["auth_type"])',
  '    client.browser_name = params["browser_name"]',
  '    client.session_id = params["session_id"]',
  '    result = client.invoke(type=params["action"], action=params["action_params"])',
  '    # Screenshots arrive as native MCP image blocks (base64 in content[]).',
  '    # Decode them to 0600 files BEFORE printing: the base64 never crosses',
  '    # stdout, so the payload stays small and parseable (trap 64: a trivial',
  '    # page is ~72KB base64, over the envelope truncation threshold).',
  '    image_counter = [0]',
  '    def strip_images(node):',
  '        if isinstance(node, dict):',
  '            if node.get("type") == "image" and isinstance(node.get("data"), str):',
  '                # R10: per-block fault isolation — a corrupt base64 or an',
  '                # unwritable path degrades THIS block to a decode_error',
  '                # stub instead of failing the whole (already-executed)',
  '                # action; the counter keeps same-millisecond siblings',
  '                # from overwriting each other.',
  '                try:',
  '                    decoded = base64.b64decode(node["data"])',
  '                    out_dir = params["screenshot_dir"]',
  '                    os.makedirs(out_dir, exist_ok=True)',
  '                    ext = (node.get("mime_type") or "image/jpeg").split("/")[-1]',
  '                    image_counter[0] += 1',
  '                    path = os.path.join(out_dir, "agentarts-browser-screenshot-{}-{}-{}.{}".format(params["session_id"], int(time.time() * 1000), image_counter[0], ext))',
  '                    # R13: decode BEFORE open — a failed decode used to',
  '                    # leave a 0-byte non-0600 orphan behind.',
  '                    with open(path, "wb") as fh:',
  '                        fh.write(decoded)',
  '                    os.chmod(path, 0o600)',
  '                    return {"type": "image", "saved_to": path, "mime_type": node.get("mime_type"), "base64_chars": len(node["data"])}',
  '                except Exception as decode_error:',
  '                    try:',
  '                        os.unlink(path)',
  '                    except Exception:',
  '                        pass',
  '                    return {"type": "image", "decode_error": str(decode_error), "base64_chars": len(node["data"])}',
  '            return {k: strip_images(v) for k, v in node.items()}',
  '        if isinstance(node, list):',
  '            return [strip_images(x) for x in node]',
  '        return node',
  '    result = strip_images(result)',
  '    print(json.dumps(result, ensure_ascii=False, default=lambda o: getattr(o, "__dict__", str(o))))',
  'except SystemExit:',
  '    raise',
  'except BaseException as error:',
  '    # ToolsAPIError extends BaseException (tools_http.py:10) — the',
  '    # browser-specific deviation, same as every browser snippet.',
  '    print("{}: {}".format(type(error).__name__, error), file=sys.stderr)',
  '    sys.exit(1)',
].join('\n');

// Invoke-tool post-processing: the three measured detection mappings
// (fence via current_url, trap 65; session death and stream-disabled,
// trap 66; API_KEY-missing, trap 61), the lease-expiry warning window,
// and the get_page_info doubly-encoded text parse (trap 64).
function enrichBrowserInvoke(payload, params, session, rawResult) {
  const notes = [];
  const now = Date.now();
  if (payload.ok) {
    // Lease warning window (the plan's 30s pre-expiry warning).
    if (typeof session.lease_expires_at === 'number') {
      const remaining = session.lease_expires_at - now;
      if (remaining < 30_000) {
        notes.push(
          `The local lease expires in ${Math.max(0, Math.round(remaining / 1000))}s — finish the interaction or restart the session; after expiry the cloud session answers "Session not found".`,
        );
      }
    }
    // Fence detection (trap 65): the envelope's is_error stays FALSE on a
    // fenced navigate — current_url is the only signal. Derived from the
    // RAW stdout when the envelope's result was truncated away (the
    // captureSessionState precedent — a >50KB page is get_page_info's
    // NORMAL case, and the fence check is its documented purpose).
    let structured = payload.result?.result?.structured_content || payload.result?.structured_content;
    if (!structured && !('result' in payload) && rawResult && !rawResult.timedOut && rawResult.exitCode === 0) {
      try {
        const raw = JSON.parse(rawResult.stdout);
        structured = raw?.result?.structured_content || raw?.structured_content;
      } catch {
        // Unparseable raw stdout — the envelope already says so.
      }
    }
    const currentUrl = structured?.current_url;
    if (typeof currentUrl === 'string' && currentUrl.startsWith('chrome-error://')) {
      notes.push(
        `DOMAIN FENCE HIT: current_url is ${currentUrl} — the navigate was blocked at page-load by the session's domain fence and is_error stays false (trap 65; detection is current_url, never the error bit).`,
      );
    }
    // get_page_info's content[0].text is a doubly-encoded JSON string
    // (trap 64): parse it into an object for the display surface.
    const content = payload.result?.result?.content || payload.result?.content;
    if (Array.isArray(content)) {
      for (const item of content) {
        if (item && typeof item === 'object' && item.type === 'text' && typeof item.text === 'string') {
          try {
            const parsed = JSON.parse(item.text);
            if (parsed && typeof parsed === 'object') item.text = parsed;
          } catch {
            // Plain text — leave it.
          }
        }
      }
    }
    if (notes.length > 0) payload.notes = [...(payload.notes || []), ...notes];
    return payload;
  }
  // Error mappings (traps 61/66).
  const text = `${payload.stderr || ''} ${payload.error || ''}`;
  // B7 real-machine shapes (trap 80): the snippet formats the exception as
  // "{class}: {message}" and ToolsAPIError's own str() prefixes "Tools API
  // Error: " — the real stderr reads "ToolsAPIError: Tools API Error:
  // Session not found". The server's session-death WORDING is also
  // unstable across same-shaped runs (measured 2026-10-31: "Session not
  // found" and "No active session" on two identical expiry probes — the
  // gateway-family trap-54 class): both are mapped.
  if (/ToolsAPIError: (?:Tools API Error: )?(Session not found|No active session)/i.test(text)) {
    payload.error = `${payload.error} The cloud session is gone (expired at its own timeout, stopped, or orphaned — trap 66). Restart it via huaweicloud_agentarts_browser_plan (operation start_session) if you still need the browser.`;
  } else if (/ToolsAPIError: (?:Tools API Error: )?Stream is disabled/i.test(text)) {
    payload.error = `${payload.error} A human holds control of this session (take_control was used — trap 66; page state is preserved). Release it back to the agent via the approved write huaweicloud_agentarts_browser_plan operation update_stream with stream_status=enabled.`;
  } else if (/API Key is not provided/i.test(`${rawResult?.stderr || ''} ${payload.stderr || ''}`)) {
    payload.error = `${payload.error || 'Execution failed.'} The session's browser is API_KEY-typed: the data plane needs the console api_key exported as HUAWEICLOUD_SDK_BROWSER_API_KEY in the agent launcher's environment (trap 61).`;
  }
  return payload;
}

export async function runAgentartsBrowserInvoke(params = {}, options = {}) {
  const invalid = validateBrowserInvoke(params);
  if (invalid) {
    return {
      ok: false,
      service: 'AgentArts',
      operation: `browser invoke ${params.action || '(unknown)'} (SDK data plane)`,
      error: invalid,
    };
  }
  if (hasInjectableCredentials() === false) {
    return {
      ok: false,
      service: 'AgentArts',
      operation: `browser invoke ${params.action} (SDK data plane)`,
      error:
        'No devkit credentials available for agentarts (HUAWEICLOUD_SDK_AK/SK injection). Run huaweicloud_auth_init first, or execute the command in your own terminal — the wrapper never falls back to unmanaged profile files or the metadata chain.',
    };
  }
  const load = loadBrowserSession(params.session_id);
  if (!load.ok) {
    return {
      ok: false,
      service: 'AgentArts',
      operation: `browser invoke ${params.action} (SDK data plane)`,
      error: load.error,
    };
  }
  const session = load.session;
  // The lease gate (B5's core): an expired lease is rejected with restart
  // guidance — the cloud session dies independently and would answer
  // "Session not found" anyway (trap 66).
  if (typeof session.lease_expires_at === 'number' && session.lease_expires_at <= Date.now()) {
    return {
      ok: false,
      service: 'AgentArts',
      operation: `browser invoke ${params.action} (SDK data plane)`,
      code: 'SESSION_LEASE_EXPIRED',
      error: `The local lease for session ${params.session_id} expired at ${new Date(session.lease_expires_at).toISOString()} — the cloud session dies independently at its own timeout and would answer "Session not found" (trap 66). Restart via huaweicloud_agentarts_browser_plan (operation start_session) if you still need the browser.`,
    };
  }
  const request = {
    action: params.action,
    action_params: buildInvokeActionParams(params),
    region: session.region,
    data_endpoint: session.data_endpoint,
    auth_type: session.auth_type,
    browser_name: session.browser_name,
    session_id: session.session_id,
    screenshot_dir: OUTPUT_DIR,
  };
  const childEnv = buildChildEnv({ injectCredentials: true });
  const timeoutMs = options.timeoutMs ?? READONLY_TIMEOUT_MS;
  const args = ['-c', BROWSER_INVOKE_SNIPPET];
  return runOverPythonCandidates({
    args,
    childEnv,
    timeoutMs,
    stdinData: JSON.stringify(request),
    runCandidate: options.runCandidate,
    shapeResult: (result, candidate) => {
      const parsed = parseSnippetStdout(result);
      const payload = shapeBrowserResult(result, candidate, params, timeoutMs, parsed);
      payload.operation = `browser invoke ${params.action} (SDK data plane; no CLI subcommand in 0.1.7)`;
      return enrichBrowserInvoke(payload, params, session, result);
    },
  });
}
