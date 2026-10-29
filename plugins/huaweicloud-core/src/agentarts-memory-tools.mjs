// AgentArts memory tool DEFINITIONS (schema layer), extracted from
// agentarts-memory.mjs (the logic module: read bridge, write bridge,
// validation, envelope, snippets — ~1.2k lines, sectioned). This module
// holds only the operation enums the schemas reference and the tool
// definition arrays tools.mjs spreads. Definitions carry no handlers —
// dispatch lives in callAgentartsMemoryTool (the agentarts-cli pattern).
//
// Contract sources pinned here:
// - actor_id positions (U6): create_session/search_memories top-level
//   REQUIRED; list_sessions/list_memories optional scope; add_messages
//   per-message ONLY (top-level rejected — measured first-plan failure).
// - search semantics (U5/U6): no default min_score cutoff (the filter
//   class defaults None and its serializer drops it); a SET min_score is
//   enforced CLIENT-side by the bridge (the 0.1.7 server-side filter is
//   measured-ineffective even when set).
// - batch delete (U7): one approval per id array, sorted canonical ids,
//   partial-failure report (structured `partial` field + one JSON
//   progress line per id on stderr so a mid-batch timeout still leaves
//   a machine-readable trail).

export const MEMORY_READ_OPERATIONS = [
  'list_sessions',
  'get_session',
  'get_last_k_messages',
  'get_message',
  'list_messages',
  'search_memories',
  'list_memories',
  'get_memory',
];

export const MEMORY_WRITE_OPERATIONS = [
  'create_session',
  'add_messages',
  'delete_session',
  'delete_memory',
  'delete_memories',
];

export const AGENTARTS_MEMORY_TOOL_DEFINITIONS = [
  {
    name: 'huaweicloud_agentarts_memory_read',
    description:
      "Read the AgentArts memory DATA plane (SDK MemoryClient — the 0.1.7 CLI has NO data-plane subcommands): sessions, messages, and memories of an existing memory space. The one-time data-plane api_key is read from the wrapper-captured 0600 key file (spaces created through the memory create tool); it never enters argv, tool arguments, or output. actor_id is REQUIRED for search_memories — server-side isolation is actor-level only, and an unscoped search silently spans every actor in the space; list_memories without filters.actor_id lists ALL actors' memories (an ops/debug stance — the result carries a note). list_messages requires session_id (the SDK's space-wide form builds a broken /sessions/None path in 0.1.7). search_memories results LAG add_messages — extraction is asynchronous, so an empty result immediately after a write is EXPECTED; verify message ingestion with list_messages (immediate). search_memories with an omitted filters.min_score applies NO score cutoff — the SDK filter defaults min_score to None and drops it from the request, so the WHOLE space comes back ranked by similarity; a SET filters.min_score is enforced CLIENT-side by this bridge (the 0.1.7 server-side filter is measured-ineffective — an explicit 0.01 still returned sub-0.0001 entries; sub-threshold entries are removed from result, searchSummary describes the raw response and a note counts the cut). Judge relevance by the searchSummary score range (measured band 0.000016-0.14 — relative, not comparable across queries), not by result presence. Pagination is 0-based; sessions limit 1-20, messages/memories limit 1-100 (default 10 — pass 100 to sweep a space). Region defaults to cn-southwest-2 (the only e2e-measured region). Read-only: no approval needed.",
    inputSchema: {
      type: 'object',
      required: ['operation', 'space_id'],
      properties: {
        operation: {
          type: 'string',
          enum: MEMORY_READ_OPERATIONS,
          description:
            'The read operation. Required params: get_session/get_last_k_messages/list_messages → session_id; get_message → message_id + session_id; get_memory → memory_id; search_memories → actor_id + filters.query.',
        },
        space_id: {
          type: 'string',
          pattern: '^[A-Za-z0-9_-]+$',
          description: 'Memory space ID (the create tool captured its key file).',
        },
        actor_id: {
          type: 'string',
          description:
            'Actor whose perspective filters the query. REQUIRED for search_memories (actor-level server isolation); optional filter for list_sessions/list_memories (omitting lists every actor).',
        },
        session_id: { type: 'string' },
        message_id: { type: 'string' },
        memory_id: { type: 'string' },
        k: { type: 'integer', minimum: 1, description: 'get_last_k_messages: how many trailing messages.' },
        limit: {
          type: 'integer',
          description:
            'Page size: sessions 1-20 (default 20), messages/memories 1-100 (default 10). NOT a parameter of search_memories — its result size is filters.top_k (default 10, server-side).',
        },
        offset: { type: 'integer', minimum: 0, description: '0-based pagination offset.' },
        region: { type: 'string', description: 'Defaults to cn-southwest-2.' },
        filters: {
          type: 'object',
          description:
            'search_memories: MemorySearchFilter fields (query REQUIRED, plus strategy_type/strategy_id/assistant_id/session_id/memory_type/start_time/end_time/top_k/min_score — actor_id goes in the top-level param; omitted min_score = NO score cutoff, the whole space returns ranked; set min_score = the bridge filters CLIENT-side, the 0.1.7 server-side filter is ineffective even when set). list_memories: MemoryListFilter fields (strategy_type/strategy_id/actor_id/assistant_id/session_id/start_time/end_time — sort_by/sort_order exist on the SDK dataclass but 0.1.7 never sends them; rejected here). Unknown keys are rejected; top_k/min_score must be NUMBERS and every other filter value a non-empty string — mistyped values are rejected at the boundary, not coerced.',
        },
      },
    },
  },
];

// Write-bridge tool definitions (token-gated like every approved cloud
// write in this repo).
export const AGENTARTS_MEMORY_WRITE_TOOL_DEFINITIONS = [
  {
    name: 'huaweicloud_agentarts_memory_plan',
    description:
      'Plan an AgentArts memory DATA-PLANE WRITE (SDK MemoryClient — the 0.1.7 CLI has no data-plane subcommands): create_session, add_messages (a whole batch per approval), delete_session (soft delete: unreachable through this toolkit immediately, retained server-side for async cleanup 90-365 days per the SDK — no in-toolkit recovery), delete_memory (irreversible), delete_memories (BATCH irreversible delete of an id array — one approval covers every id; a bridge composition, the 0.1.7 SDK has no batch method; partial failures are reported per-id, and the canonical request sorts the ids so plan/write id-order differences do not mismatch the token). Validates the request, reads nothing from the cloud, and returns the exact request plus an approvalToken. Present the request to the user; on explicit approval run huaweicloud_agentarts_memory_write with the token and the SAME parameters. The token binds the exact planned request — changed parameters need a fresh plan. The one-time data-plane api_key rides the wrapper-captured 0600 key file (env-only). actor_id is REQUIRED for create_session (the actor is the isolation unit). TextMessage roles: user/assistant/system only.',
    inputSchema: {
      type: 'object',
      required: ['operation', 'space_id'],
      properties: {
        operation: { type: 'string', enum: MEMORY_WRITE_OPERATIONS },
        space_id: { type: 'string', pattern: '^[A-Za-z0-9_-]+$' },
        actor_id: {
          type: 'string',
          description:
            'REQUIRED for create_session. add_messages: pass actor_id inside each message — the top-level form is rejected (not an add_messages parameter).',
        },
        session_id: {
          type: 'string',
          description:
            'Required for add_messages/delete_session; optional custom id for create_session. For add_messages, use the id create_session returned (or the custom id you passed to it) — create_session is the first step of the write loop.',
        },
        assistant_id: { type: 'string', description: 'create_session/add_messages optional.' },
        meta: { type: 'object', description: 'create_session: session metadata object.' },
        messages: {
          type: 'array',
          description:
            'add_messages: non-empty array of {role: user|assistant|system, content: non-empty string, actor_id?, assistant_id?, meta? (strings)}. One approval covers the whole batch.',
          items: { type: 'object' },
        },
        timestamp: { type: 'integer', description: 'add_messages: message time in ms.' },
        idempotency_key: { type: 'string', description: 'add_messages: duplicate-submission guard.' },
        is_force_extract: {
          type: 'boolean',
          description:
            'add_messages: force memory extraction (default false — extraction is async; a write is not immediately retrievable).',
        },
        memory_id: { type: 'string', description: 'delete_memory (single).' },
        memory_ids: {
          type: 'array',
          items: { type: 'string' },
          description:
            'delete_memories (batch): non-empty array of unique memory ids — ONE approval covers the whole batch, each id an irreversible delete. The canonical request sorts them, so plan/write id-order differences still bind.',
        },
        region: { type: 'string', description: 'Defaults to cn-southwest-2.' },
      },
    },
  },
  {
    name: 'huaweicloud_agentarts_memory_write',
    description:
      'Execute a PLANNED and USER-APPROVED AgentArts memory data-plane write. Requires approvedByUser: true (the explicit attestation — same gate as every approved runner in this toolkit), the approvalToken from huaweicloud_agentarts_memory_plan, and the EXACT same parameters (the token binds them; a mismatch rejects without consuming the token). Single-use: a successful execution consumes the token; replaying it returns already_processed with per-operation verify guidance — verify with huaweicloud_agentarts_memory_read before re-planning anything. A failed execution burns the token (re-plan to retry; pass idempotency_key on add_messages retries — a timeout may have landed server-side). delete_memory is irreversible; delete_memories is a BATCH irreversible delete (one approval per id array; the default timeout auto-scales with the batch size — 2s per id + 30s grace, floor 120s): a partial failure exposes the per-id report as a structured `partial` field {deleted: [...], failed: [{memory_id, error}]} — re-plan ONLY the still-present ids; on a TIMEOUT the stdout report may be missing — stderr carries one JSON progress line per completed id and the authoritative reconciliation is memory_read (get_memory per id is the direct check — a not-found id is deleted; list_memories the sweep form); delete_session is a soft delete (unreachable immediately, server-side retention 90-365 days); add_messages extraction is asynchronous (not immediately searchable — use is_force_extract consciously).',
    inputSchema: {
      type: 'object',
      required: ['approvalToken', 'approvedByUser', 'operation', 'space_id'],
      properties: {
        approvalToken: {
          type: 'string',
          description: 'The approvalToken returned by huaweicloud_agentarts_memory_plan for THIS exact request.',
        },
        approvedByUser: {
          type: 'boolean',
          description: 'Must be true — set it only after the user explicitly approved the plan request you presented.',
        },
        operation: { type: 'string', enum: MEMORY_WRITE_OPERATIONS },
        space_id: { type: 'string', pattern: '^[A-Za-z0-9_-]+$', description: 'Same space the plan bound.' },
        actor_id: {
          type: 'string',
          description:
            'REQUIRED for create_session (the isolation unit). add_messages: pass actor_id inside each message — the top-level form is rejected (not an add_messages parameter).',
        },
        session_id: {
          type: 'string',
          description: 'The id create_session returned (or your custom id); required for add_messages/delete_session.',
        },
        assistant_id: { type: 'string' },
        meta: { type: 'object', description: 'create_session: session metadata object.' },
        messages: {
          type: 'array',
          items: { type: 'object' },
          description: 'add_messages: the EXACT batch from the plan (role/content/optional strings).',
        },
        timestamp: { type: 'integer', description: 'add_messages: message time in ms.' },
        idempotency_key: { type: 'string', description: 'add_messages: duplicate-submission guard — pass on retries.' },
        is_force_extract: { type: 'boolean', description: 'add_messages: force extraction (default false).' },
        memory_id: { type: 'string', description: 'delete_memory (single).' },
        memory_ids: {
          type: 'array',
          items: { type: 'string' },
          description:
            'delete_memories: the EXACT id array from the plan (any order — the binding is order-insensitive).',
        },
        region: { type: 'string', description: 'Defaults to cn-southwest-2 (bound by the plan).' },
      },
    },
  },
];
