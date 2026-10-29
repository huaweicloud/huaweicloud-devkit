// AgentArts memory DATA-PLANE bridge (U2 read + U3 write). The 0.1.7 CLI
// stops at space management — the SDK's MemoryClient exposes 12 data-plane
// methods with zero CLI subcommands (fixtures + client.py, findings trap
// 1), so an agent that created a space through the wrapper hit a dead end.
// This module bridges all 12 through the same safety model as list_agents:
// an inline python snippet over the CLI-owned interpreter, our own exit
// codes, allowlist child env, redaction on every surface. Reads are free;
// writes follow the repo's approval-token contract (plan mints a token in
// the agentarts-memory-sdk namespace bound to the exact canonical request;
// write requires approvedByUser + the token + the same parameters).
//
// Credential model (deliberately NARROWER than every other agentarts
// tool): the data plane authenticates with a per-space one-time api_key
// (Authorization: Bearer), NOT AK/SK — MemoryClient's control plane is
// lazy and none of these methods touch it. The key is read from the
// wrapper-captured 0600 key file (memoryApiKeyFile), injected ONLY into
// the child env (HUAWEICLOUD_SDK_MEMORY_API_KEY), and never appears in
// argv, the tool arguments, or the payload.
//
// Request transport: BOTH bridges' requests travel via STDIN, not argv
// (interrogate round 2 aligned the read side with the write side): argv
// is process-list visible (a search query is arbitrary
// conversation-derived text, not an id/limit shape) and a document-sized
// query would hit the kernel per-argument limit as E2BIG, which the
// candidate chain misdiagnosed as "install the SDK".
//
// Accepted residual: message content is the USER's data and may contain
// credential-shaped text the user chose to memorize. The plan payload
// shows it verbatim (informed approval requires it — hash-exact binding
// forbids display-scrubbing), the token store's argsRedacted copy in
// approvals.json (0600, 5-minute TTL, dropped by the consume tombstone)
// carries shape-redacted content, and a plan-time WARNING fires when
// content matches credential shapes. Storing credentials in cloud memory
// remains the user's decision, made loudly.
//
// Failure contract: the snippet's exit codes are OURS and trustworthy
// (0 = JSON printed, 1 = failure, 3 = module missing). NO content
// signature scan runs on the payload — memory CONTENT is by design a
// store of failure experience (tracebacks, ERROR log lines), so scanning
// result text guarantees false positives on successful reads. Exit code
// + stdout-parseability is the whole detector.

import { readFileSync } from 'node:fs';

import {
  buildChildEnv,
  DEFAULT_APPROVED_TIMEOUT_MS,
  memoryApiKeyFile,
  READONLY_TIMEOUT_MS,
  runOverPythonCandidates,
  saveLargeOutput,
} from './agentarts-cli.mjs';
import { MEMORY_READ_OPERATIONS, MEMORY_WRITE_OPERATIONS } from './agentarts-memory-tools.mjs';
import { createApprovalTokenStore, hashNamespacedArgs } from './approval-tokens.mjs';
import { redactCredentialShapes } from './redact-core.mjs';
import { redactSecrets } from './safety-policy.mjs';

const LIMIT_RANGES = {
  list_sessions: [1, 20],
  list_messages: [1, 100],
  list_memories: [1, 100],
};

const MEMORY_READ_SNIPPET = [
  'import json, sys',
  'try:',
  '    from agentarts.sdk.memory.client import MemoryClient',
  '    from agentarts.sdk.memory.inner.config import MemoryListFilter, MemorySearchFilter',
  'except ModuleNotFoundError:',
  '    print("AGENTARTS_SDK_MISSING", file=sys.stderr)',
  '    sys.exit(3)',
  'try:',
  // Reads ride STDIN too (interrogate round 2): the old argv transport
  // put filters.query — arbitrary conversation-derived text — on the
  // process list, and a document-sized query hit the kernel per-argument
  // limit as E2BIG, which the candidate chain misdiagnosed as
  // "install the SDK". Same rationale as the write bridge.
  '    params = json.loads(sys.stdin.read())',
  '    client = MemoryClient(region_name=params["region"])',
  '    op = params["operation"]',
  '    space = params["space_id"]',
  '    if op == "list_sessions":',
  '        kwargs = {}',
  '        if params.get("actor_id"): kwargs["actor_id"] = params["actor_id"]',
  '        if params.get("limit") is not None: kwargs["limit"] = params["limit"]',
  '        if params.get("offset") is not None: kwargs["offset"] = params["offset"]',
  '        result = client.list_sessions(space, **kwargs)',
  '    elif op == "get_session":',
  '        result = client.get_session(space, params["session_id"])',
  '    elif op == "get_last_k_messages":',
  '        result = client.get_last_k_messages(params["session_id"], params["k"], space)',
  '    elif op == "get_message":',
  '        result = client.get_message(params["message_id"], space, params["session_id"])',
  '    elif op == "list_messages":',
  '        kwargs = {}',
  '        if params.get("session_id"): kwargs["session_id"] = params["session_id"]',
  '        if params.get("limit") is not None: kwargs["limit"] = params["limit"]',
  '        if params.get("offset") is not None: kwargs["offset"] = params["offset"]',
  '        result = client.list_messages(space, **kwargs)',
  '    elif op == "search_memories":',
  '        filters = MemorySearchFilter(**params["filters"])',
  '        result = client.search_memories(space, filters)',
  '    elif op == "list_memories":',
  '        kwargs = {}',
  '        if params.get("limit") is not None: kwargs["limit"] = params["limit"]',
  '        if params.get("offset") is not None: kwargs["offset"] = params["offset"]',
  '        if params.get("filters"): kwargs["filters"] = MemoryListFilter(**params["filters"])',
  '        result = client.list_memories(space, **kwargs)',
  '    elif op == "get_memory":',
  '        result = client.get_memory(space, params["memory_id"])',
  '    else:',
  '        print("AGENTARTS_MEMORY_BAD_OPERATION", file=sys.stderr)',
  '        sys.exit(2)',
  '    print(json.dumps(result, ensure_ascii=False, default=lambda o: getattr(o, "__dict__", str(o))))',
  'except Exception as error:',
  '    print("{}: {}".format(type(error).__name__, error), file=sys.stderr)',
  '    sys.exit(1)',
].join('\n');

// Filter-key allowlists, transcribed from the pinned venv's
// sdk/memory/inner/config.py dataclasses. The boundary REJECTS unknown
// keys: a stray key would either raise a dataclass TypeError at run time
// or (worse) ride the argv JSON silently — and a credential-shaped key in
// filters would put a secret on the process list (the top-level params
// are whitelisted; filters must be too).
// - search: actor_id is managed by the REQUIRED top-level param (the
//   bridge injects it into filters) — passing it inside filters is
//   rejected to avoid two sources for one isolation-critical field.
// - list: sort_by/sort_order exist on the dataclass but the 0.1.7 HTTP
//   layer never sends them (memory_service.py filter_mappings maps 7
//   keys) — rejected as the silent-no-op class.
const SEARCH_FILTER_FIELDS = [
  'query',
  'strategy_type',
  'strategy_id',
  'assistant_id',
  'session_id',
  'memory_type',
  'start_time',
  'end_time',
  'top_k',
  'min_score',
];
const LIST_FILTER_FIELDS = [
  'strategy_type',
  'strategy_id',
  'actor_id',
  'assistant_id',
  'session_id',
  'start_time',
  'end_time',
];

function validateFilterKeys(operation, filters) {
  const legal = operation === 'search_memories' ? SEARCH_FILTER_FIELDS : LIST_FILTER_FIELDS;
  for (const key of Object.keys(filters)) {
    if (key === 'actor_id' && operation === 'search_memories') {
      return 'filters.actor_id is managed by the required top-level actor_id parameter — pass it there, not inside filters.';
    }
    if ((key === 'sort_by' || key === 'sort_order') && operation === 'list_memories') {
      return `filters.${key} exists on the MemoryListFilter dataclass but the 0.1.7 HTTP layer never sends it (memory_service.py filter_mappings) — a silent no-op. Sorting is server-default only.`;
    }
    if (!legal.includes(key)) {
      return `Unknown filters key "${key}" — legal keys for ${operation}: ${legal.join(', ')}.`;
    }
  }
  return null;
}

// Filter VALUE validation (interrogate round 1): keys were allowlisted,
// values rode through unchecked — and U6 made min_score load-bearing
// (the bridge enforces it), so a mistyped value must be REJECTED at this
// boundary, not Number()-coerced deep in the shaper (measured failure
// modes of the coercion: true → threshold 1 silently nukes every entry;
// 'abc' → NaN → the user's threshold invisibly does nothing; [0.01] →
// 0.01; '' → 0). The top-level limit/offset/k checks above enforce the
// same policy (interrogate round 2 aligned them). NUMERIC_FILTER_FIELDS
// can only arrive on the search path — validateFilterKeys runs first
// and rejects top_k/min_score as unknown keys for list_memories.
const NUMERIC_FILTER_FIELDS = new Set(['top_k', 'min_score']);
function validateFilterValues(filters) {
  for (const [key, value] of Object.entries(filters)) {
    if (value === null || value === undefined) continue; // unset — dropped from the request
    if (NUMERIC_FILTER_FIELDS.has(key)) {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return `filters.${key} must be a finite number (got ${typeof value}) — mistyped filter values are rejected, not coerced.`;
      }
      if (key === 'top_k' && (!Number.isSafeInteger(value) || value < 1)) {
        return 'filters.top_k must be a positive integer.';
      }
      continue;
    }
    if (typeof value !== 'string' || value.length === 0) {
      return `filters.${key} must be a non-empty string (got ${typeof value}) — mistyped filter values are rejected, not coerced.`;
    }
  }
  return null;
}

// Legal top-level parameter keys per bridge — a typo'd field must not
// vanish silently (the silent-no-op class; a typo'd idempotency_key on a
// retry would disarm the duplicate-write guard).
const MEMORY_READ_PARAM_KEYS = [
  'operation',
  'space_id',
  'actor_id',
  'session_id',
  'message_id',
  'memory_id',
  'k',
  'limit',
  'offset',
  'region',
  'filters',
];
const MEMORY_WRITE_PARAM_KEYS = [
  'operation',
  'space_id',
  'actor_id',
  'assistant_id',
  'session_id',
  'meta',
  'messages',
  'timestamp',
  'idempotency_key',
  'is_force_extract',
  'memory_id',
  'memory_ids',
  'region',
];

// Per-operation applicability: a LEGAL key in the wrong operation is a
// silent no-op otherwise (top-level meta with add_messages, actor_id with
// list_memories — which wants filters.actor_id). Every operation takes
// operation/space_id/region; the map lists the rest.
const OP_PARAM_APPLICABILITY = {
  list_sessions: ['actor_id', 'limit', 'offset'],
  get_session: ['session_id'],
  get_last_k_messages: ['session_id', 'k'],
  get_message: ['session_id', 'message_id'],
  list_messages: ['session_id', 'limit', 'offset'],
  search_memories: ['actor_id', 'filters'],
  list_memories: ['limit', 'offset', 'filters'],
  get_memory: ['memory_id'],
  create_session: ['actor_id', 'assistant_id', 'session_id', 'meta'],
  add_messages: ['session_id', 'messages', 'timestamp', 'idempotency_key', 'is_force_extract'],
  delete_session: ['session_id'],
  delete_memory: ['memory_id'],
  delete_memories: ['memory_ids'],
};

function rejectUnknownParams(params, legalKeys, operation) {
  const applicable = OP_PARAM_APPLICABILITY[operation] ?? [];
  for (const key of Object.keys(params)) {
    if (!legalKeys.includes(key)) {
      return `Unknown parameter "${key}" — legal keys: ${legalKeys.join(', ')}.`;
    }
    if (!['operation', 'space_id', 'region'].includes(key) && !applicable.includes(key)) {
      return `"${key}" is not a parameter of ${operation} — it would be silently ignored. Applicable keys for ${operation}: ${applicable.join(', ') || '(none beyond operation/space_id/region)'}.`;
    }
  }
  return null;
}

// Boundary validation (the tool's front door — the snippet trusts what
// arrives). Returns an error string or null.
function validateMemoryRead(params) {
  if (!MEMORY_READ_OPERATIONS.includes(params.operation)) {
    return `operation must be one of: ${MEMORY_READ_OPERATIONS.join(', ')}.`;
  }
  const spaceFile = memoryApiKeyFile(params.space_id);
  if (!spaceFile.ok) return spaceFile.error;
  if (typeof params.space_id !== 'string' || params.space_id.length === 0) {
    return 'space_id is required.';
  }
  const unknown = rejectUnknownParams(params, MEMORY_READ_PARAM_KEYS, params.operation);
  if (unknown) return unknown;
  const need = (field, message) => {
    if (typeof params[field] !== 'string' || params[field].length === 0) return message;
    return null;
  };
  // list_messages: the SDK docstring claims session_id is optional ("query
  // all messages under Space"), but the 0.1.7 HTTP layer builds
  // /sessions/{session_id}/messages unconditionally — None stringifies
  // into the path (memory_service.py list_messages). Required here until
  // an S0 run proves the space-wide form works.
  if (
    params.operation === 'get_session' ||
    params.operation === 'get_last_k_messages' ||
    params.operation === 'list_messages'
  ) {
    const err = need('session_id', 'session_id is required for this operation.');
    if (err) return err;
  }
  if (params.operation === 'get_message') {
    const err =
      need('session_id', 'session_id is required for this operation.') ??
      need('message_id', 'message_id is required for this operation.');
    if (err) return err;
  }
  if (params.operation === 'get_memory') {
    const err = need('memory_id', 'memory_id is required for this operation.');
    if (err) return err;
  }
  if (params.operation === 'search_memories') {
    if (typeof params.actor_id !== 'string' || params.actor_id.length === 0) {
      return "actor_id is REQUIRED for search_memories: server-side isolation is actor-level only — an unscoped search silently returns every actor's memories in the space.";
    }
    const filters = params.filters;
    if (
      !filters ||
      typeof filters !== 'object' ||
      Array.isArray(filters) ||
      typeof filters.query !== 'string' ||
      filters.query.length === 0
    ) {
      return 'search_memories requires filters.query (a non-empty string) — the semantic query.';
    }
  }
  const range = LIMIT_RANGES[params.operation];
  if (range) {
    for (const field of ['limit', 'offset']) {
      if (params[field] !== undefined && params[field] !== null) {
        // Strict typing (interrogate round 2): no Number() coercion —
        // limit: true would become 1 and limit: '20' would pass, the
        // exact mistyped-value class validateFilterValues rejects one
        // branch below. null = unset.
        const value = params[field];
        if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
          return `${field} must be an integer (got ${typeof value}) — mistyped values are rejected, not coerced.`;
        }
        if (field === 'limit' && (value < range[0] || value > range[1])) {
          return `limit must be ${range[0]}-${range[1]} for ${params.operation} (SDK range).`;
        }
        if (field === 'offset' && value < 0) return 'offset must be >= 0 (0-based).';
      }
    }
  }
  // get_last_k_messages: k is a REQUIRED positional with no unset
  // semantics (unlike limit/offset, where null = SDK default) — the R2
  // strict-typing pass wrongly copied the optional-field guard here,
  // letting a missing k reach the snippet as KeyError (interrogate
  // round 3, unanimous).
  if (params.operation === 'get_last_k_messages') {
    if (typeof params.k !== 'number' || !Number.isSafeInteger(params.k) || params.k < 1) {
      return 'k must be a positive integer (mistyped values are rejected, not coerced).';
    }
  }
  if (params.filters !== undefined && params.filters !== null) {
    // Only the two list/search operations take filters — on the other six
    // the param would ride the argv JSON and be silently ignored by the
    // snippet (the same silent-no-op class as sort_by).
    if (params.operation !== 'search_memories' && params.operation !== 'list_memories') {
      return `${params.operation} takes no filters — only search_memories and list_memories do.`;
    }
    if (typeof params.filters !== 'object' || Array.isArray(params.filters)) {
      return 'filters must be an object (MemorySearchFilter / MemoryListFilter fields).';
    }
    const filterError = validateFilterKeys(params.operation, params.filters);
    if (filterError) return filterError;
    const valueError = validateFilterValues(params.filters);
    if (valueError) return valueError;
  }
  // Top-level actor_id on the list ops: the request builder drops a
  // non-string silently, which would turn a "scoped" call into an
  // unscoped one with no note (the advisory checks what the user SENT,
  // not what rode the wire) — reject the misinput at the boundary.
  if (params.operation === 'list_sessions' && params.actor_id !== undefined && params.actor_id !== null) {
    if (typeof params.actor_id !== 'string' || params.actor_id.length === 0) {
      return 'actor_id must be a non-empty string when provided.';
    }
  }
  // region: same boundary policy (interrogate round 3) — a mistyped
  // region silently became the cn-southwest-2 default, substituting
  // which regional endpoint serves the request with no signal.
  if (params.region !== undefined && params.region !== null) {
    if (typeof params.region !== 'string' || params.region.length === 0) {
      return 'region must be a non-empty string when provided.';
    }
  }
  return null;
}

// Read the one-time data-plane key from the wrapper-captured 0600 file.
// Failure carries the bootstrap remediation: key files exist only for
// spaces created through this wrapper's `memory create` — a space made in
// the user's terminal has no file, and the key is unrecoverable upstream
// (no re-issue command; the S0 question whether `memory get` returns it
// once is open).
function loadMemoryApiKey(spaceId) {
  const file = memoryApiKeyFile(spaceId);
  if (!file.ok) return { ok: false, error: file.error };
  let key;
  try {
    key = readFileSync(file.path, 'utf8').trim();
  } catch {
    return {
      ok: false,
      error: `No data-plane api_key file for space ${spaceId} at ${file.path}. Key files exist only for spaces created through huaweicloud_agentarts_run_approved_command (memory create) — the one-time key is printed once and has no re-issue command. For a space created outside the wrapper, delete and recreate it through the memory create tool to capture a fresh key.`,
    };
  }
  if (!key)
    return {
      ok: false,
      error: `The data-plane api_key file for space ${spaceId} is empty (${file.path}) — delete and recreate the space to capture a fresh key.`,
    };
  return { ok: true, key };
}

export async function readAgentartsMemory(params = {}, options = {}) {
  const invalid = validateMemoryRead(params);
  if (invalid) {
    return {
      ok: false,
      service: 'AgentArts',
      operation: `memory ${params.operation || '(unknown)'} (SDK data plane)`,
      error: invalid,
    };
  }
  const keyLoad = loadMemoryApiKey(params.space_id);
  if (!keyLoad.ok) {
    return {
      ok: false,
      service: 'AgentArts',
      operation: `memory ${params.operation} (SDK data plane)`,
      error: keyLoad.error,
    };
  }

  // The request carries ONLY non-secret parameters. The api_key rides the
  // child env, never argv (process-list visible) and never the payload.
  const request = {
    operation: params.operation,
    space_id: params.space_id,
    region: typeof params.region === 'string' && params.region ? params.region : 'cn-southwest-2',
  };
  for (const field of ['actor_id', 'session_id', 'message_id', 'memory_id']) {
    if (typeof params[field] === 'string' && params[field]) request[field] = params[field];
  }
  for (const field of ['k', 'limit', 'offset']) {
    // Strict-typed at the boundary (typeof number) — pass through; the
    // old Number() coercion here accepted what validation now rejects.
    if (params[field] !== undefined && params[field] !== null) request[field] = params[field];
  }
  if (params.filters !== undefined && params.filters !== null) {
    const filters = { ...(params.filters || {}) };
    if (params.operation === 'search_memories') filters.actor_id = params.actor_id;
    // Drop null/undefined filter values — the SDK filter dataclasses treat
    // None as "not set", and json null would arrive as None anyway, but
    // dropping here keeps the snippet's kwargs construction honest.
    for (const key of Object.keys(filters)) {
      if (filters[key] === null || filters[key] === undefined) delete filters[key];
    }
    request.filters = filters;
  }
  const jsonArg = JSON.stringify(request);

  // Allowlist env + the data-plane key. injectCredentials stays OFF: the
  // data plane needs no AK/SK (MemoryClient's control plane is lazy and
  // none of these methods reach it) — a narrower credential surface
  // than every other agentarts tool, on purpose.
  const childEnv = { ...buildChildEnv({ injectCredentials: false }), HUAWEICLOUD_SDK_MEMORY_API_KEY: keyLoad.key };
  const timeoutMs = options.timeoutMs ?? READONLY_TIMEOUT_MS;
  const args = ['-c', MEMORY_READ_SNIPPET];

  return runOverPythonCandidates({
    args,
    childEnv,
    timeoutMs,
    // The request rides STDIN (see the snippet comment): query text is
    // process-list visible in argv and can exceed the kernel arg limit.
    stdinData: jsonArg,
    runCandidate: options.runCandidate,
    // Parse ONCE per call, threaded into both consumers (envelope +
    // enrichment — one derivation, one truth; interrogate round 2).
    shapeResult: (result, candidate) => {
      const parsed = parseSnippetStdout(result);
      return enrichMemoryRead(shapeMemoryResult(result, candidate, params, timeoutMs, parsed), params, parsed);
    },
  });
}

// Numeric digest of a search_memories response (A3/A4): semantic search
// with an omitted min_score returns the WHOLE space ranked — the
// MemorySearchFilter dataclass defaults min_score to None and its
// to_dict drops None (pinned venv config.py:122-132), so no cutoff is
// sent and "result present" says nothing about relevance. The score
// RANGE is the relevance signal; this aggregates it without touching
// content (the no-content-scan contract is unchanged — pure numbers).
// Score typing (interrogate round 2): only a genuine finite number
// counts. Number() coercion here would turn a serialized null
// (Python None → JSON null — the realistic unscored wire shape) into 0,
// flattening the digest's lower bound and cutting "scoreless entries
// are KEPT" down to the absent-key case; `true` would become 1.
function entryScore(entry) {
  return entry && typeof entry === 'object' && typeof entry.score === 'number' && Number.isFinite(entry.score)
    ? entry.score
    : Number.NaN;
}
function searchScoreSummary(parsed) {
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.results)) return null;
  const summary = { resultCount: parsed.results.length };
  let max = -Infinity;
  let min = Infinity;
  let seen = 0;
  for (const entry of parsed.results) {
    const score = entryScore(entry);
    if (!Number.isFinite(score)) continue;
    if (score > max) max = score;
    if (score < min) min = score;
    seen++;
  }
  if (seen > 0) {
    summary.maxScore = max;
    summary.minScore = min;
  }
  return summary;
}

// Parse the snippet's stdout into a redacted object, or null. Computed
// ONCE per call in the shapeResult closure and threaded into both the
// envelope and the read enrichment (interrogate round 2: two independent
// derivations of "the parsed result" could silently diverge if one call
// site were later edited — one derivation, one truth).
function parseSnippetStdout(result) {
  if (result.timedOut || result.exitCode !== 0) return null;
  try {
    const parsed = JSON.parse(result.stdout);
    return parsed === null || parsed === undefined ? null : redactSecrets(parsed);
  } catch {
    return null;
  }
}

// Shared payload ENVELOPE for the read and write bridges (identical
// failure contract, redaction, and truncation semantics). Pure: parse,
// redact, fail, truncate, assemble — no operation-specific enrichment.
// Read-specific post-processing (searchSummary, advisories, the
// client-side filter) lives in enrichMemoryRead; write-specific
// post-processing (the partial report, burn notes) lives in the write
// bridge's shapeResult callback. Both extensions compose AROUND this
// envelope — every new concern grows its bridge, not the shared path.
function shapeMemoryResult(result, candidate, params, timeoutMs, parsed = parseSnippetStdout(result)) {
  // Trustworthy exit codes (see the module header): exit 0 means the
  // snippet printed result JSON — a parse failure on exit 0 is a
  // pollution detector, NOT a content scan. No failure signature runs
  // against the payload: memory CONTENT is by design a store of
  // failure experience (tracebacks, ERROR lines), so scanning it
  // guarantees false positives on successful reads.
  const failed = result.timedOut || result.exitCode !== 0 || parsed === null;
  const safeStdout = redactSecrets(result.stdout || '');
  // Truncation applies to successes AND failures (a long timeout can
  // accumulate a lot of output). When the side file fires, `result`
  // is dropped — the file pointer is the contract; returning an
  // untruncated parsed object next to a truncated stdout would defeat
  // the whole large-output machinery.
  const largeOutputFile = saveLargeOutput(safeStdout);
  const payloadStdout = largeOutputFile
    ? `${safeStdout.slice(0, 2000)}\n...(truncated, full output saved to ${largeOutputFile})`
    : safeStdout;
  const parsePolluted = !result.timedOut && result.exitCode === 0 && parsed === null;
  return {
    ok: !failed,
    service: 'AgentArts',
    operation: `memory ${params.operation} (SDK data plane; no CLI subcommand in 0.1.7)`,
    executable: candidate,
    exitCode: result.exitCode,
    failureDetected: failed,
    ...(largeOutputFile || failed ? {} : { result: parsed }),
    stdout: payloadStdout,
    stderr: redactSecrets(result.stderr || ''),
    ...(result.timedOut
      ? { timedOut: true, error: `agentarts memory ${params.operation} timed out after ${timeoutMs} ms.` }
      : {}),
    ...(parsePolluted
      ? {
          error:
            'exit 0 but stdout was not parseable JSON — output pollution suspected (the snippet prints clean JSON on success).',
        }
      : {}),
  };
}

// Read-bridge post-processing, composed around the envelope at the read
// call site only (writes never run this). Takes the envelope payload
// plus the SAME parsed stdout the envelope consumed (the envelope may
// have dropped `result` to the side file, but searchSummary must survive
// truncation).
function enrichMemoryRead(payload, params, parsed) {
  if (!payload.ok) return payload; // advisories describe RESULTS — a failed call has none
  const notes = [];
  // Unscoped-list advisory (U5/A7): list_sessions/list_memories without
  // an actor scope span EVERY actor's data in the space — legal
  // (ops/debug stance) but easy to misread as one actor's view. The
  // note names the scoping parameter per operation (top-level actor_id
  // for list_sessions; filters.actor_id for list_memories — the
  // top-level form is rejected there as not-a-parameter). Typed at the
  // boundary, so presence here means "a real non-empty scope".
  if (
    (params.operation === 'list_sessions' && !params.actor_id) ||
    (params.operation === 'list_memories' && !(params.filters && params.filters.actor_id))
  ) {
    notes.push(
      `Unscoped list: results span EVERY actor in the space. Scope with ${
        params.operation === 'list_sessions' ? 'actor_id' : 'filters.actor_id'
      } if a single actor's view was intended.`,
    );
  }
  if (params.operation === 'search_memories' && parsed !== null && parsed !== undefined) {
    // The score digest over the RAW server response — computed BEFORE
    // the client-side filter so it always describes what the server
    // actually did (and it survives truncation: three numbers, set
    // directly on the payload).
    const searchSummary = searchScoreSummary(parsed);
    if (searchSummary) payload.searchSummary = searchSummary;
    // Client-side min_score enforcement (U6, trap 31): the 0.1.7
    // server-side filter is measured-ineffective — an explicit 0.01
    // still returned sub-0.0001 entries. The bridge applies the
    // threshold itself when `result` is present (not truncated):
    // sub-threshold entries are removed, `total` is corrected to the
    // kept count (a filtered view that mimics pagination must not
    // advertise the raw total — an agent trusting it would re-query for
    // entries the filter removed), and the note counts the cut.
    // searchSummary still describes the RAW response. Entries without a
    // finite score are KEPT — "not below threshold" is not a judgement
    // the bridge can make for the server. min_score is typed at the
    // boundary (finite number), so no coercion runs here.
    const minScore = params.filters ? params.filters.min_score : undefined;
    if (typeof minScore === 'number' && Number.isFinite(minScore)) {
      if (payload.result && Array.isArray(payload.result.results)) {
        const kept = payload.result.results.filter((entry) => {
          // entryScore (interrogate round 2): only genuine finite numbers
          // compare — a serialized null (Python None) is scoreless and
          // KEPT, not coerced to 0 and cut.
          const score = entryScore(entry);
          return !Number.isFinite(score) || score >= minScore;
        });
        if (kept.length !== payload.result.results.length) {
          notes.push(
            `filters.min_score=${minScore} removed ${
              payload.result.results.length - kept.length
            } of ${payload.result.results.length} server-returned entries CLIENT-side — the 0.1.7 server-side filter is ineffective even when set (measured, trap 31). searchSummary describes the RAW response.`,
          );
          payload.result = { ...payload.result, results: kept, total: kept.length };
        }
      } else if (!('result' in payload)) {
        // Truncation disclosure (interrogate round 2; shape split round
        // 3): the threshold was SET but could not be applied — `result`
        // went to the side file unfiltered. Without this note, "no
        // notes" is ambiguous between "nothing was cut" and "the filter
        // never ran". The envelope omits `result` ONLY on truncation
        // (failure already early-returned above), so this branch is
        // exactly the truncation case.
        notes.push(
          'filters.min_score was NOT applied — the result was truncated to the side file, whose contents are UNFILTERED. Apply the threshold yourself when reading the saved output; searchSummary describes the raw response.',
        );
      } else {
        // Present-but-unexpected shape (a parsed, ok:true response whose
        // body is not {results: [...]} — SDK/server drift): honest
        // disclosure, no false truncation claim (interrogate round 3).
        notes.push(
          'filters.min_score was NOT applied — the response did not carry a results array (unexpected shape; no searchSummary either). Inspect stdout/side file before trusting any relevance judgement.',
        );
      }
    }
  }
  if (notes.length > 0) payload.notes = notes;
  return payload;
}

// The WRITE data-plane operations (U3 + U7), token-gated like every
// approved cloud write in this repo. Signatures (pinned venv client.py):
// - create_memory_session(space_id, id?, actor_id?, assistant_id?, meta?)
//   — actor_id REQUIRED at this boundary (the isolation model; a session
//   without an actor breaks actor-scoped retrieval).
// - add_messages(space_id, session_id, messages: TextMessage[], *,
//   timestamp?, idempotency_key?, is_force_extract=False) — TextMessage
//   roles are user/assistant/system ONLY (the dataclass Literal; tool
//   roles are ToolCallMessage shapes this bridge does not expose), and
//   content must be non-empty (to_dict raises on empty). ONE approval
//   covers the whole batch.
// - delete_session(space_id, session_id) — SOFT delete (90-365d async
//   cleanup per the SDK docstring): approved, not irreversible-labeled.
// - delete_memory(space_id, memory_id) — the SDK docstring says
//   "this operation is irreversible": carries the irreversible label.
// - delete_memories(space_id, memory_ids[]) — a BRIDGE composition (U7;
//   the 0.1.7 SDK has no batch method, upstream ask #15): the snippet
//   loops client.delete_memory per id, emitting one JSON progress line
//   per id to STDERR (flushed — a mid-batch timeout still leaves a
//   machine-readable trail). ONE approval covers the whole id batch;
//   per-id failures are collected and reported honestly (a structured
//   `partial` {deleted, failed} field on the failure payload; partial
//   deletion exits 1 with the report on stdout). The canonical request
//   SORTS the ids — deletion order is semantically irrelevant, and the
//   token binds the canonical bytes (an id-order-only difference must
//   not spuriously mismatch).
// MEMORY_WRITE_OPERATIONS itself lives in agentarts-memory-tools.mjs.
// Per-operation WRITE metadata as data (interrogate round 2 collapsed
// the scattered per-op conditionals into one registry): labels carried
// on the plan/approval surface, and the approval-scope sentence naming
// what one approval covers. A new write operation that forgets an entry
// shows up as a lookup gap here, not as a silently missing branch four
// functions apart. replayGuidanceNote and the failure batchNote stay
// functions — they interpolate live values, they are not pure lookups.
const WRITE_OPERATION_META = {
  create_session: { labels: [], approvalScope: null },
  add_messages: {
    labels: [],
    approvalScope: ' One approval covers the whole message batch.',
  },
  delete_session: { labels: [], approvalScope: null },
  delete_memory: { labels: ['irreversible'], approvalScope: null },
  delete_memories: {
    labels: ['irreversible'],
    approvalScope: (idCount) =>
      ` One approval covers the whole id batch — each of the ${idCount} ids is an irreversible delete.`,
  },
};

// TextMessage's role Literal (config.py:904-905) — 'tool' is NOT a
// TextMessage role; the tool-call/result message shapes are separate
// dataclasses this bridge deliberately does not expose.
const TEXT_MESSAGE_ROLES = new Set(['user', 'assistant', 'system']);

// delete_memories runs N sequential network deletes inside ONE child
// process — the single-op default timeout is not a budget for it
// (interrogate round 2). Auto-scale at 2s/id + 30s grace, floored at
// the single-op default. HEURISTIC: per-id latency is unmeasured (S0);
// a real measurement retunes the per-id constant, not the shape.
function batchTimeoutMs(idCount) {
  return Math.max(DEFAULT_APPROVED_TIMEOUT_MS, idCount * 2000 + 30_000);
}

function validateMemoryWrite(params) {
  if (!MEMORY_WRITE_OPERATIONS.includes(params.operation)) {
    return `operation must be one of: ${MEMORY_WRITE_OPERATIONS.join(', ')}.`;
  }
  const spaceFile = memoryApiKeyFile(params.space_id);
  if (!spaceFile.ok) return spaceFile.error;
  if (typeof params.space_id !== 'string' || params.space_id.length === 0) {
    return 'space_id is required.';
  }
  const unknown = rejectUnknownParams(params, MEMORY_WRITE_PARAM_KEYS, params.operation);
  if (unknown) return unknown;
  if (params.operation === 'create_session') {
    if (typeof params.actor_id !== 'string' || params.actor_id.length === 0) {
      return 'actor_id is REQUIRED for create_session: the actor is the isolation unit of the whole memory model — a session without one breaks actor-scoped retrieval.';
    }
    for (const field of ['assistant_id', 'session_id']) {
      if (
        params[field] !== undefined &&
        params[field] !== null &&
        (typeof params[field] !== 'string' || !params[field])
      ) {
        return `${field} must be a non-empty string when provided.`;
      }
    }
    if (
      params.meta !== undefined &&
      params.meta !== null &&
      (typeof params.meta !== 'object' || Array.isArray(params.meta))
    ) {
      return 'session meta must be an object.';
    }
  }
  if (params.operation === 'add_messages') {
    if (typeof params.session_id !== 'string' || params.session_id.length === 0) {
      return 'session_id is required for add_messages.';
    }
    if (!Array.isArray(params.messages) || params.messages.length === 0) {
      return 'messages must be a non-empty array (one approval covers the whole batch).';
    }
    for (const [index, message] of params.messages.entries()) {
      if (!message || typeof message !== 'object' || Array.isArray(message)) {
        return `messages[${index}] must be an object.`;
      }
      // Unknown keys are rejected (symmetry with the read bridge's filter
      // allowlists): a typo'd field must not vanish silently.
      for (const key of Object.keys(message)) {
        if (!['role', 'content', 'actor_id', 'assistant_id', 'meta'].includes(key)) {
          return `messages[${index}] has unknown key "${key}" — legal keys: role, content, actor_id, assistant_id, meta.`;
        }
      }
      if (!TEXT_MESSAGE_ROLES.has(message.role)) {
        return `messages[${index}].role must be one of user, assistant, system (TextMessage's Literal — tool roles are separate dataclasses this bridge does not expose).`;
      }
      if (typeof message.content !== 'string' || message.content.length === 0) {
        return `messages[${index}].content must be a non-empty string (the SDK raises on empty content).`;
      }
      for (const field of ['actor_id', 'assistant_id', 'meta']) {
        // Empty strings are rejected (interrogate round 2): the
        // canonicalizer drops falsy strings, so an '' would silently
        // vanish from the approved request — the approval must show what
        // the caller sent or not accept it (same rule as create_session).
        if (message[field] !== undefined && message[field] !== null) {
          if (typeof message[field] !== 'string' || message[field].length === 0) {
            return `messages[${index}].${field} must be a non-empty string when provided.`;
          }
        }
      }
    }
    if (params.timestamp !== undefined && params.timestamp !== null && !Number.isSafeInteger(params.timestamp)) {
      return 'timestamp must be an integer (milliseconds).';
    }
    if (
      params.idempotency_key !== undefined &&
      params.idempotency_key !== null &&
      (typeof params.idempotency_key !== 'string' || !params.idempotency_key)
    ) {
      return 'idempotency_key must be a non-empty string when provided.';
    }
    if (
      params.is_force_extract !== undefined &&
      params.is_force_extract !== null &&
      typeof params.is_force_extract !== 'boolean'
    ) {
      return 'is_force_extract must be a boolean.';
    }
  }
  if (params.operation === 'delete_session') {
    if (typeof params.session_id !== 'string' || params.session_id.length === 0) {
      return 'session_id is required for delete_session.';
    }
  }
  if (params.operation === 'delete_memory') {
    if (typeof params.memory_id !== 'string' || params.memory_id.length === 0) {
      return 'memory_id is required for delete_memory.';
    }
  }
  // region: same boundary policy as the read bridge (interrogate round
  // 3) — a mistyped region must not silently become the default that
  // the token then binds.
  if (params.region !== undefined && params.region !== null) {
    if (typeof params.region !== 'string' || params.region.length === 0) {
      return 'region must be a non-empty string when provided.';
    }
  }
  if (params.operation === 'delete_memories') {
    if (!Array.isArray(params.memory_ids) || params.memory_ids.length === 0) {
      return 'memory_ids must be a non-empty array (one approval covers the whole batch — every id is an irreversible delete).';
    }
    const seen = new Set();
    for (const [index, id] of params.memory_ids.entries()) {
      if (typeof id !== 'string' || id.length === 0) {
        return `memory_ids[${index}] must be a non-empty string.`;
      }
      // Duplicates are rejected, not silently deduped: the approval shows
      // the exact request, and a silently-deduped execution would differ
      // from what the user approved (the no-silent-no-op class).
      if (seen.has(id)) {
        return `memory_ids[${index}] duplicates "${id}" — pass each id once (a duplicate would fail server-side on the second delete).`;
      }
      seen.add(id);
    }
  }
  return null;
}

// Deep-sort object keys so semantically identical requests (same meta with
// different key order) produce the SAME canonical JSON — the token binds
// bytes, and key-order-only differences would spuriously mismatch. Default
// code-unit sort (object keys are always strings, so no coercion runs):
// locale-sensitive ordering would make the canonical form
// environment-dependent across plan/write processes (interrogate round 1).
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

// The canonical request: plan and write build it from params the SAME way,
// so the approval token binds byte-identical JSON. It carries ONLY
// non-secret parameters (the key rides the child env, never here).
function buildMemoryWriteRequest(params) {
  const request = {
    operation: params.operation,
    space_id: params.space_id,
    region: typeof params.region === 'string' && params.region ? params.region : 'cn-southwest-2',
  };
  if (params.operation === 'create_session') {
    request.actor_id = params.actor_id;
    for (const field of ['assistant_id', 'session_id']) {
      if (typeof params[field] === 'string' && params[field]) request[field] = params[field];
    }
    // An EMPTY meta object is dropped from the canonical request
    // (interrogate round 8): the Python snippet's `if params.get("meta")`
    // treats {} as unset, so keeping it in the approval would diverge
    // what the user approved from what executes — plan and execution
    // must agree ({} is semantically unset server-side).
    if (params.meta !== undefined && params.meta !== null && Object.keys(params.meta).length > 0) {
      request.meta = deepSortKeys(params.meta);
    }
  }
  if (params.operation === 'add_messages') {
    request.session_id = params.session_id;
    request.messages = params.messages.map((message) => {
      const entry = { role: message.role, content: message.content };
      for (const field of ['actor_id', 'assistant_id', 'meta']) {
        if (typeof message[field] === 'string' && message[field]) entry[field] = message[field];
      }
      return entry;
    });
    if (params.timestamp !== undefined && params.timestamp !== null) request.timestamp = params.timestamp;
    if (typeof params.idempotency_key === 'string' && params.idempotency_key) {
      request.idempotency_key = params.idempotency_key;
    }
    if (params.is_force_extract === true) request.is_force_extract = true;
  }
  if (params.operation === 'delete_session') request.session_id = params.session_id;
  if (params.operation === 'delete_memory') request.memory_id = params.memory_id;
  // delete_memories: the canonical form SORTS the ids — deletion order is
  // semantically irrelevant (unlike add_messages, where message order is
  // conversation order), so an id-order-only difference between plan and
  // write must not spuriously mismatch the token (the same class as meta
  // deep-sorting). Default code-unit sort, NOT localeCompare: the token
  // binds bytes and plan/write may run in different processes or locales
  // (interrogate round 1) — locale-sensitive ordering would make the
  // canonical form environment-dependent.
  if (params.operation === 'delete_memories') {
    request.memory_ids = [...params.memory_ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  }
  return request;
}

// Token namespace for the memory data-plane writes — distinct from the
// agentarts CLI namespace so a CLI token can never authorize an SDK write
// (and vice versa). The request JSON carries no secrets, so hash-exact
// binding is the whole check (the CLI's scrub-tolerance fallback exists
// for argv secrets; there are none here by construction).
const MEMORY_WRITE_TOKEN_CLI = 'agentarts-memory-sdk';

export function planAgentartsMemoryWrite(params = {}) {
  const invalid = validateMemoryWrite(params);
  if (invalid) {
    return {
      ok: false,
      service: 'AgentArts',
      operation: `memory ${params.operation || '(unknown)'} (SDK data plane)`,
      error: invalid,
    };
  }
  const keyLoad = loadMemoryApiKey(params.space_id);
  if (!keyLoad.ok) {
    return {
      ok: false,
      service: 'AgentArts',
      operation: `memory ${params.operation} (SDK data plane)`,
      error: keyLoad.error,
    };
  }
  const request = buildMemoryWriteRequest(params);
  const approvalToken = createApprovalTokenStore(MEMORY_WRITE_TOKEN_CLI).create([JSON.stringify(request)]);
  // Loud-storage warning: message content matching credential shapes is
  // the user's decision to make, not an accident to record silently.
  const warnings = [];
  const credentialShaped = (text) => typeof text === 'string' && redactCredentialShapes(text) !== text;
  const flagged =
    (Array.isArray(params.messages) &&
      params.messages.some((message) => credentialShaped(message?.content) || credentialShaped(message?.meta))) ||
    (params.meta !== undefined &&
      params.meta !== null &&
      typeof params.meta === 'object' &&
      credentialShaped(JSON.stringify(params.meta)));
  if (flagged) {
    warnings.push(
      'Some request content (message bodies or metadata) matches credential shapes (api_key/password/token patterns — the check is over-inclusive on ordinary key:value phrasing). Storing credentials in cloud memory makes them retrievable by every actor-scoped query — confirm the user intends THIS content to be memorized before presenting the request for approval.',
    );
  }
  // No ?? fallback (interrogate round 3): a write operation added to the
  // enum without a meta entry must FAIL LOUDLY here, not silently lose
  // its labels and approval-scope text — the ?? default did the opposite
  // of the registry's stated purpose. Key parity with
  // MEMORY_WRITE_OPERATIONS is pinned in structure.test.mjs.
  const meta = WRITE_OPERATION_META[params.operation];
  const labels = meta.labels;
  const labelSuffix = labels.length > 0 ? ` Labels: ${labels.join(', ')}.` : '';
  // Approval-scope sentence per operation (WRITE_OPERATION_META): the
  // approval's coverage stated in the vocabulary of THIS operation —
  // an add_messages batch is messages; a delete_memories batch is
  // irreversible deletes, with its timeout budget (interrogate round 2:
  // the batch runs N sequential deletes under one child process — the
  // default timeout auto-scales at 2s/id + 30s grace, a heuristic until
  // per-id latency is measured on a real space).
  const scopeText =
    typeof meta.approvalScope === 'function' ? meta.approvalScope(request.memory_ids.length) : meta.approvalScope;
  const timeoutBudgetNote =
    params.operation === 'delete_memories'
      ? ` Execution budget: ${batchTimeoutMs(params.memory_ids.length)} ms (auto-scaled: 2s per id + 30s grace, floor 120s).`
      : '';
  return {
    ok: true,
    service: 'AgentArts',
    tier: 'approved',
    operation: `memory ${params.operation} (SDK data plane; no CLI subcommand in 0.1.7)`,
    labels,
    warnings,
    request,
    approvalToken,
    approvalNote: `Present the request above to the user.${labelSuffix} On explicit approval, run huaweicloud_agentarts_memory_write with THIS approvalToken, the SAME parameters, and approvedByUser: true (the token binds them exactly); otherwise discard it.${scopeText ?? ''}${timeoutBudgetNote}`,
  };
}

const MEMORY_WRITE_SNIPPET = [
  'import json, sys',
  'try:',
  '    from agentarts.sdk.memory.client import MemoryClient',
  '    from agentarts.sdk.memory.inner.config import TextMessage',
  'except ModuleNotFoundError:',
  '    print("AGENTARTS_SDK_MISSING", file=sys.stderr)',
  '    sys.exit(3)',
  'try:',
  '    # The request rides STDIN: conversation batches can exceed the',
  '    # kernel argv limit, and argv is process-list visible.',
  '    params = json.loads(sys.stdin.read())',
  '    client = MemoryClient(region_name=params["region"])',
  '    op = params["operation"]',
  '    space = params["space_id"]',
  '    if op == "create_session":',
  '        kwargs = {"actor_id": params["actor_id"]}',
  '        if params.get("assistant_id"): kwargs["assistant_id"] = params["assistant_id"]',
  '        if params.get("session_id"): kwargs["id"] = params["session_id"]',
  '        if params.get("meta"): kwargs["meta"] = params["meta"]',
  '        result = client.create_memory_session(space, **kwargs)',
  '    elif op == "add_messages":',
  '        messages = [TextMessage(role=m["role"], content=m["content"], actor_id=m.get("actor_id"), assistant_id=m.get("assistant_id"), meta=m.get("meta")) for m in params["messages"]]',
  '        kwargs = {}',
  '        if params.get("timestamp") is not None: kwargs["timestamp"] = params["timestamp"]',
  '        if params.get("idempotency_key"): kwargs["idempotency_key"] = params["idempotency_key"]',
  '        if params.get("is_force_extract") is not None: kwargs["is_force_extract"] = params["is_force_extract"]',
  '        result = client.add_messages(space, params["session_id"], messages, **kwargs)',
  '    elif op == "delete_session":',
  '        client.delete_session(space, params["session_id"])',
  '        result = {"deleted": True, "session_id": params["session_id"]}',
  '    elif op == "delete_memory":',
  '        client.delete_memory(space, params["memory_id"])',
  '        result = {"deleted": True, "memory_id": params["memory_id"]}',
  '    elif op == "delete_memories":',
  // Per-id progress rides STDERR with flush=True (interrogate round 1):
  // stdout stays the single-JSON-per-result contract the envelope parses,
  // while a mid-batch SIGKILL (timeout) still leaves a machine-readable
  // trail of completed ids — runPythonSnippet accumulates stderr
  // continuously, so the trail survives the kill.
  '        deleted, failed = [], []',
  '        for mid in params["memory_ids"]:',
  '            try:',
  '                client.delete_memory(space, mid)',
  '                deleted.append(mid)',
  '                print(json.dumps({"progress": "deleted", "memory_id": mid}, ensure_ascii=False), file=sys.stderr, flush=True)',
  '            except Exception as error:',
  '                failed.append({"memory_id": mid, "error": "{}: {}".format(type(error).__name__, error)})',
  '                print(json.dumps({"progress": "failed", "memory_id": mid}, ensure_ascii=False), file=sys.stderr, flush=True)',
  '        if failed:',
  '            print(json.dumps({"deleted": deleted, "failed": failed}, ensure_ascii=False))',
  '            sys.exit(1)',
  '        result = {"deleted": deleted, "failed": []}',
  '    else:',
  '        print("AGENTARTS_MEMORY_BAD_OPERATION", file=sys.stderr)',
  '        sys.exit(2)',
  '    print(json.dumps(result, ensure_ascii=False, default=lambda o: getattr(o, "__dict__", str(o))))',
  'except Exception as error:',
  '    print("{}: {}".format(type(error).__name__, error), file=sys.stderr)',
  '    sys.exit(1)',
].join('\n');

// Replay (already_consumed) guidance, per-operation (interrogate round 1):
// the old single note taught add_messages verification to every op — a
// delete_memories replay needs list_memories per id instead.
function replayGuidanceNote(operation, concurrency) {
  const prefix = concurrency
    ? 'This token was consumed by a concurrent call — the write may already have executed.'
    : 'This token was already used — the write may already have executed.';
  if (operation === 'add_messages') {
    return `${prefix} Verify with huaweicloud_agentarts_memory_read (list_messages is immediate; search lags extraction) BEFORE re-planning anything, and pass idempotency_key on retries.`;
  }
  if (operation === 'delete_memories') {
    return `${prefix} Verify with huaweicloud_agentarts_memory_read — get_memory per id is the direct per-id check (a not-found id is deleted), list_memories the sweep form — BEFORE re-planning, and re-plan ONLY the ids still present.`;
  }
  return `${prefix} Verify with huaweicloud_agentarts_memory_read BEFORE re-planning anything.`;
}

export async function runAgentartsMemoryWrite({ approvalToken, approvedByUser, ...params } = {}, options = {}) {
  const invalid = validateMemoryWrite(params);
  if (invalid) {
    return {
      ok: false,
      service: 'AgentArts',
      operation: `memory ${params.operation || '(unknown)'} (SDK data plane)`,
      error: invalid,
    };
  }
  // The repo's three-element approval contract: token + exact parameters +
  // the explicit attestation (same gate as every approved runner — the
  // plan tool's guidance is the teaching layer, THIS is the enforcement).
  // Ordering divergence from the CLI runners is deliberate: param
  // validation runs FIRST (a pure data error needs no attestation), the
  // attestation throw second.
  if (approvedByUser !== true) {
    throw new Error(
      'approvedByUser must be true after explicit user approval of the plan request — run huaweicloud_agentarts_memory_plan, present the request to the user, and only then execute with the token.',
    );
  }
  if (typeof approvalToken !== 'string' || !approvalToken) {
    return {
      ok: false,
      service: 'AgentArts',
      operation: `memory ${params.operation} (SDK data plane)`,
      error:
        'approvalToken is required — run huaweicloud_agentarts_memory_plan first, present the request to the user, and pass the token plus the SAME parameters here on explicit approval.',
    };
  }
  const store = createApprovalTokenStore(MEMORY_WRITE_TOKEN_CLI);
  const inspection = store.inspect(approvalToken);
  // Precise token lifecycle (the D4-24 contract vocabulary): a consumed
  // token is idempotent SUCCESS ("already processed — stop"), not an
  // error that invites a duplicate write; expired/not-found carry
  // machine-assertable codes.
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
      operation: `memory ${params.operation} (SDK data plane)`,
      error: 'approvalToken expired — re-plan with huaweicloud_agentarts_memory_plan and get a fresh approval.',
    };
  }
  if (inspection.state === 'not_found') {
    return {
      ok: false,
      status: 'rejected',
      code: 'CONFIRM_TOKEN_NOT_FOUND',
      service: 'AgentArts',
      operation: `memory ${params.operation} (SDK data plane)`,
      error: 'approvalToken not found (never created, pruned, or minted in a different namespace) — re-plan.',
    };
  }
  const request = buildMemoryWriteRequest(params);
  const requestHash = hashNamespacedArgs(MEMORY_WRITE_TOKEN_CLI, [JSON.stringify(request)]);
  if (requestHash !== inspection.entry.argsHash) {
    return {
      ok: false,
      status: 'rejected',
      code: 'CONFIRM_TOKEN_MISMATCH',
      service: 'AgentArts',
      operation: `memory ${params.operation} (SDK data plane)`,
      error:
        'approvalToken was minted for DIFFERENT parameters — the write binds the exact planned request. Re-plan with the changed parameters (the token stays valid for the original ones).',
    };
  }
  // Credentials BEFORE consumption (the CLI runner's order): a vanished
  // key file must not burn the approval on a no-op.
  const keyLoad = loadMemoryApiKey(params.space_id);
  if (!keyLoad.ok) {
    return {
      ok: false,
      service: 'AgentArts',
      operation: `memory ${params.operation} (SDK data plane)`,
      error: keyLoad.error,
    };
  }
  // Binding + credentials verified — consume (single-use tombstone) before
  // executing. A failed execution burns the token (concurrency safety);
  // the failure payload says so (see tokenConsumedNote below).
  if (!store.consume(approvalToken)) {
    // Defensive recheck (the CLI runner's pattern): inspect said valid but
    // consume lost a race — re-classify instead of guessing expired.
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
      operation: `memory ${params.operation} (SDK data plane)`,
      error: 'approvalToken could not be consumed (raced and pruned?) — re-plan.',
    };
  }
  const childEnv = { ...buildChildEnv({ injectCredentials: false }), HUAWEICLOUD_SDK_MEMORY_API_KEY: keyLoad.key };
  const timeoutMs =
    options.timeoutMs ??
    (params.operation === 'delete_memories' && Array.isArray(params.memory_ids)
      ? batchTimeoutMs(params.memory_ids.length)
      : DEFAULT_APPROVED_TIMEOUT_MS);
  // The request rides STDIN (module header): conversation batches can
  // exceed the kernel argv limit and argv is process-list visible.
  const args = ['-c', MEMORY_WRITE_SNIPPET];
  const outcome = await runOverPythonCandidates({
    args,
    childEnv,
    timeoutMs,
    stdinData: JSON.stringify(request),
    runCandidate: options.runCandidate,
    shapeResult: (result, candidate) => {
      // Envelope only — write-specific post-processing composes here,
      // symmetric with enrichMemoryRead on the read bridge.
      const payload = shapeMemoryResult(result, candidate, params, timeoutMs);
      if (!payload.ok) {
        // Structured partial report (interrogate round 1): on a failed
        // batch delete the snippet's exit-1 stdout IS the
        // {deleted, failed} report. Parse the RAW stdout — the payload's
        // stdout may be a truncated pointer to the side file, and the
        // retry decision ("re-plan only what survived") must not depend
        // on regexing a possibly-cut string.
        if (params.operation === 'delete_memories' && !result.timedOut && result.exitCode === 1) {
          try {
            const report = JSON.parse(result.stdout);
            if (report && Array.isArray(report.deleted) && Array.isArray(report.failed)) {
              payload.partial = redactSecrets(report);
            }
          } catch {
            // stdout is not the report (pollution) — the envelope carries it.
          }
        }
        // Batch deletes carry a partial-execution hazard the single-op
        // note does not cover: a mid-batch failure leaves SOME ids
        // already deleted, and re-planning the whole batch would fail
        // on them again. The timeout path names its own reconciliation
        // (stderr progress trail + list_memories).
        const batchNote =
          params.operation === 'delete_memories'
            ? ' For a batch delete: the partial field (when present) lists per-id outcomes — re-plan ONLY the ids still present. On a TIMEOUT the stdout report may be missing: stderr carries one JSON progress line per completed id, and the authoritative reconciliation is memory_read (get_memory per id is the direct check — a not-found id is deleted; list_memories the sweep form).'
            : '';
        payload.error = `${payload.error || 'Execution failed.'} The single-use token was consumed by this attempt — re-plan for a retry (and pass idempotency_key on add_messages retries to guard against a timeout that may have landed server-side).${batchNote}`;
      }
      return payload;
    },
  });
  // Fallthrough honesty (interrogate round 1; round 2 made the signal
  // EXPLICIT): when NO python candidate could run the SDK,
  // runOverPythonCandidates returns its generic install remediation
  // marked unshaped: true — shapeResult never ran, so the
  // consumed-token disclosure must come from here. Without it a later
  // replay would report already_processed ("may have executed") for a
  // write that never ran.
  if (!outcome.ok && outcome.unshaped === true) {
    outcome.error = `${outcome.error} The single-use approval token was already CONSUMED by this attempt and stays burned — after fixing the SDK install, re-plan (replaying this token returns already_processed without executing anything).`;
  }
  return outcome;
}

// Tool dispatch (definitions live in agentarts-memory-tools.mjs).
export async function callAgentartsMemoryTool(name, rawArgs = {}) {
  if (name === 'huaweicloud_agentarts_memory_read') return readAgentartsMemory(rawArgs);
  if (name === 'huaweicloud_agentarts_memory_plan') return planAgentartsMemoryWrite(rawArgs);
  if (name === 'huaweicloud_agentarts_memory_write') return runAgentartsMemoryWrite(rawArgs);
  return { ok: false, error: `Unknown agentarts memory tool: ${name}` };
}
