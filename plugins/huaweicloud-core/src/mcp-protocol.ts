import { McpServer, type RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult, JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

import {
  TOOL_DEFINITIONS,
  callTool,
  verifySkillTree,
  SKILLS_ROOT,
  type CallToolOptions,
  type ToolDefinition,
  type ToolName,
} from './tools.ts';
import { PACK_OF } from './packs/registry.ts';
import { resolveEnabledPacks } from './packs/enable.ts';
import { getToolSchema, assertConstructedSchemas } from './tool-schemas.ts';
import { peekCachedUpdateInfo, applyUpdateHint, readInstalledVersion } from './update-check.ts';
import { initTelemetry } from './telemetry/telemetry.ts';
import { detectAgent } from './telemetry/agent-detect.ts';
import { asRecord } from './lib/as-record.ts';
import { approvalModeFromEnv } from './lib/approval-mode.ts';

const pkgVersion = readInstalledVersion() || '0.0.0';

// Server-level instructions ride the initialize handshake result — the one
// teaching surface that needs neither a skill load nor a description read.
// Emission is what this side controls and proves; whether the client
// renders instructions into model context is the client's contract (the
// MCP spec makes it a courtesy), and agents that do not render them keep
// the old posture — that residual is accepted and documented.
// Three honest forms, keyed on the same option pair the tool registry
// keys on (which face am I / does this face carry session toggling):
// - stdio with runtimePacks (the production stdio face): the tree's
//   absolute location (SKILLS_ROOT, resolved at runtime — never baked at
//   build time) is stated outright, so the direct read needs no catalog
//   detour; the enablement caveat deliberately PRECEDES the read
//   instruction (a path never implies "on disk == usable": trimmed packs'
//   files are reachable but gated), the load instruction is the
//   unconditional attempt-first imperative, and the packs_configure
//   consent sentence names a tool this face actually registers.
// - stdio without runtimePacks (embedded/test constructions): the same
//   location and catalog teaching, but the operator-posture enablement
//   line — never the toggle tool's name, never a runtime-mutability claim
//   a face without the toggle cannot honor.
// - remote: skillRoot is withheld on that face, so the text names the
//   catalog + retrieve_skill loader instead of a path the caller cannot
//   use, and never names the stdio-only packs_configure.
// The absence rule is scoped to huawei-* service skills everywhere: the
// six huaweicloud-* meta-skills never appear in the catalog (listSkills
// excludes core by design) yet are always available — an unscoped rule
// would teach "huaweicloud-core is trimmed", a dead end no pack can fix.
// Flag matrix: instructions key on (remoteSurface, runtimePacks) at
// construction; the payload skillRoot seams (list_skills, retrieve_skill)
// key on opts.onPacksChanged, which registerOne attaches from runtimePacks.
// The factory refuses the contradictory remoteSurface+runtimePacks
// combination, so no form can name a tool its face withholds while its
// payloads publish host paths — the pairs stay legal by construction.
// The stdio forms teach the action-first load policy: attempt the direct
// read FIRST — the attempt itself is the reachability check — and only
// when the read fails or is denied, load the skill via retrieve_skill
// (which needs no file access) instead of repeatedly requesting. Measured
// failure this closes (operator test, 2026-10-19): a conditional
// invitation ("when your file tools reach the tree, read directly") made
// the model pre-evaluate reachability pessimistically and jump straight
// to the guaranteed MCP loader without ever attempting the read — the
// model's own post-hoc reflection named the gap ("did not try read
// <skillRoot>/<name>/SKILL.md first"). The imperative sequence removes
// the evaluation step: the read is attempted unconditionally, and failure
// IS the fallback signal. This holds on every harness — with the
// installer's permission seam the attempt succeeds silently; on a gating
// harness the attempt triggers the ask and a denial is the signal; on
// ungated harnesses it just succeeds. Installer-side relief (OpenCode only, the one
// harness measured where the prompt cannot express directory-scope
// grants): setup-cli.ts writes a persistent permission seam —
// external_directory allow + edit deny over the tree globs
// (lib/opencode-permission-seam.ts owns the contract) — so direct reads
// stop prompting; the teaching here stays true on every harness
// regardless of config.
// Trimmed-posture rule shared by every instruction form. The observed
// failure (e2e core-free-choice-trimmed-availability, twice-stable): with
// huaweicloud-cli trimmed, the model skipped the catalog entirely and ran
// read-only `hcloud` commands straight from the shell — every taught
// surface covered the skill/MCP layers, none stated that the unavailability
// is about the CAPABILITY, so the raw-shell path looked permitted. This
// clause closes that gap on the one surface guaranteed to reach the model
// (the initialize handshake).
const TRIMMED_CAPABILITY_RULE =
  "That unavailability is about the capability, not just the skill text or the MCP tools: a trimmed pack's services are unavailable through every execution path, including hcloud commands run directly from your shell — never silently proceed that way; confirm with the user instead. ";

// Vendor boundary, shared by every instruction form. Measured failure
// (live probe, 2026-10-23, opencode 1.19.0 + glm-5.2, twice-stable): with
// a vendor-neutral prompt ("查看ECS实例列表") in a context carrying no
// Huawei Cloud signal, the model called auth_status then
// run_readonly_command(ECS ListServersDetails) without ever asking which
// cloud the user meant — every disclosure surface conditioned on "the task
// IS a Huawei Cloud task" while none defined what makes it one, so tool
// availability stood in as intent evidence. The rule defines the
// inference boundary explicitly (vendor mention, hcloud artifacts,
// myhuaweicloud endpoints, Huawei region IDs, earlier turns — generic
// service vocabulary and the devkit's own presence do NOT infer it) and
// gates both cloud-resource operations AND the Huawei Cloud
// tooling/credential/account probe face (CLI install checks, profile
// reads, auth status — the measured first moves); devkit meta tools
// (check_update, list_skills, ...) fall outside by construction — the
// probe clause names tooling/credential/account state, not the plugin's
// own version, catalog, or skills. The wording leads with the procedure
// and keeps the other-cloud allowance positive ("remain answerable from
// general knowledge") — evaluative classifications and
// exemption-from-prohibition phrasing primed refusal in the 2026-10-19
// retrieve_skill measurement.
const VENDOR_BOUNDARY_RULE =
  'Vendor boundary: tools or skills being available in this session is not evidence of which cloud the user means. ' +
  "For a request that involves cloud resources but names no vendor, infer the vendor only from an explicit mention, hcloud/KooCLI artifacts, myhuaweicloud endpoints, Huawei region IDs, or earlier turns of this conversation — generic service vocabulary (ECS, VPC, RDS, serverless) and the devkit's own presence do not infer it. " +
  "When the vendor is still unknown, ask the user which cloud they mean before operating on cloud resources through any tool or hcloud command, and before probing Huawei Cloud tooling, credential, or account state (CLI install checks, profile reads, auth status). Cloud-facing tools enforce this with a vendorConfirmed parameter — pass the user's establishing words as its value, never an invented quote. " +
  "Requests that are not cloud tasks are outside this rule; tasks for other clouds remain answerable from general knowledge — the devkit's tools themselves only operate on Huawei Cloud. ";

export function instructionsFor(remote: boolean, runtimePacks = false): string {
  if (remote) {
    return (
      'Skill loading: call huaweicloud_list_skills once for the effective skill catalog ' +
      '(the six huaweicloud-* meta-skills never appear in it and are always available). ' +
      'Remote sessions cannot reach the skills tree on the server host (skillRoot is withheld on the remote face), ' +
      'so huaweicloud_retrieve_skill is the loader — the fallback that applies to every skill here. ' +
      'Which skills are ENABLED is pack-gated (the operator controls pack posture); ' +
      'a huawei-* service skill absent from the catalog belongs to a trimmed pack; treat it as unavailable. ' +
      TRIMMED_CAPABILITY_RULE +
      VENDOR_BOUNDARY_RULE +
      'Route Huawei Cloud tasks through the huaweicloud-core skill; browse packs with huaweicloud_list_packs.'
    );
  }
  const enablement = runtimePacks
    ? 'Which skills are ENABLED is pack-gated and can change at runtime — call huaweicloud_list_skills for the effective catalog; ' +
      'a huawei-* service skill absent from that catalog belongs to a trimmed pack, so treat it as unavailable and confirm with the user before huaweicloud_packs_configure ' +
      '(the six huaweicloud-* meta-skills never appear in the catalog and are always available). '
    : 'Which skills are ENABLED is pack-gated (the operator controls pack posture) — call huaweicloud_list_skills for the effective catalog; ' +
      'a huawei-* service skill absent from that catalog belongs to a trimmed pack, so treat it as unavailable ' +
      '(the six huaweicloud-* meta-skills never appear in the catalog and are always available). ';
  return (
    `Skill loading: the skills tree lives at ${SKILLS_ROOT} (stdio session). ` +
    enablement +
    TRIMMED_CAPABILITY_RULE +
    `To load a skill, attempt the direct read first: read ${SKILLS_ROOT}/<name>/SKILL.md and the references/ files you need with your file tools — untruncated and selective. ` +
    'Do not pre-check reachability and do not call huaweicloud_retrieve_skill before attempting — the attempt itself is the check. ' +
    'If a direct read of the tree fails or is denied, load the skill with huaweicloud_retrieve_skill instead — it needs no file access. ' +
    // Measured miss (2026-10-23, live session): with the six meta-skill
    // native copies listed in the agent's own skills directory, a session
    // guessed a service skill's path by analogy to that directory and
    // fired the guessed read in parallel with list_skills instead of
    // waiting for skillRoot — File not found on the first move. The
    // clause names the two roots and the sequencing rule. Scoped to
    // pack-owned service skills (marketplace-installed skills legitimately
    // live in the agent skills directory); the native-copy reference is
    // conditional because only the eight directory-loading agents carry
    // those copies — the manifest-surface harnesses have no such
    // directory, and the stdio instructions render on both.
    "Root disambiguation: huawei-* pack-owned service skills live only in this tree — on directory-loading agents, the native skills directory carrying the six huaweicloud-* meta-skill copies in your context is a different root, so never guess a service skill's path by analogy to it; the tree location stated above (skillRoot, the field a huaweicloud_list_skills payload carries) must be in hand before the first service-skill read, never fetched in parallel with a guessed one. " +
    VENDOR_BOUNDARY_RULE +
    'Route Huawei Cloud tasks through the huaweicloud-core skill; browse packs with huaweicloud_list_packs.'
  );
}

// 会话内首个非 check/upgrade 工具调用附加 _updateInfo，只消费一次。
// 按会话隔离：同进程内不同会话(A/B)各自首次提示；stdio 用固定 'stdin'。
const consumedBySession = new Map<string, boolean>();

export interface DevkitServerOptions {
  sessionId?: string | null;
  // stdio sessions own runtime pack toggling (huaweicloud_packs_configure
  // gets registered and its opts carry the disclosure re-sync seam). The
  // stateless remote leaves this off: it builds a fresh server per request
  // and must never hold cross-request mutable pack state.
  runtimePacks?: boolean;
  // The stateless remote is unauthenticated HTTP: vault mutations (set /
  // rotate / delete against the user's local secret store) must never be
  // reachable there, so the remote surface withholds the secrets pack the
  // same way it withholds packs_configure. stdio and test constructions
  // omit it.
  remoteSurface?: boolean;
}

export function _decorateResult(sessionId: string | undefined | null, name: string, result: unknown): unknown {
  const key = sessionId || 'default';
  if (consumedBySession.get(key)) return result;
  try {
    const hint = peekCachedUpdateInfo();
    if (!hint) return result;
    const decorated = applyUpdateHint(result, name, hint);
    if (decorated !== result) consumedBySession.set(key, true);
    return decorated;
  } catch {
    return result; // 兜底装饰失败绝不影响工具调用
  }
}

export function _resetHintConsumption(): void {
  consumedBySession.clear();
}

export function _isHintConsumed(sessionId: string): boolean {
  return Boolean(consumedBySession.get(sessionId));
}

// Initialize side effects (user-hash prewarm for telemetry, agent detection)
// shared by both transports. The SDK offers no pre-initialize hook, so each
// transport invokes this from its JSON boundary after decoding an initialize
// request and before/while forwarding it. Awaited: the legacy dispatch held
// the initialize response for up to 3s on the hash race, and that ordering
// is observable behavior we keep.
//
// Both call sites hand over the full initialize params; the client identity
// lives one level down at params.clientInfo. A call site that passed params
// straight into detectAgent silently degraded agent detection to env-only.
export function toClientInfo(params: unknown): { name: string | null; version: string | null } {
  const info = asRecord(asRecord(params).clientInfo);
  return {
    name: typeof info.name === 'string' ? info.name : null,
    version: typeof info.version === 'string' ? info.version : null,
  };
}

export async function runInitializeSideEffects(params: unknown): Promise<void> {
  try {
    const { hdkitGenerateUserHash } = await import('./lib/hdkit/hdkitservice-api.ts');
    await Promise.race([
      hdkitGenerateUserHash(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000)),
    ]);
  } catch {
    // best-effort: hash prewarm failure (offline or timeout) must not block initialize
  }

  const agent = detectAgent(toClientInfo(params));
  initTelemetry({ harness: agent.harness, version: agent.version });
}

// MCP permits omitting `arguments` on tools/call. The SDK hands
// request.params.arguments to the zod schema verbatim, where undefined fails
// "expected object". Transports call this right after decoding a tools/call
// body so the default lives once at the JSON boundary, before the SDK sees
// the message.
export function normalizeToolCallParams(message: JSONRPCMessage): JSONRPCMessage {
  if (
    message &&
    typeof message === 'object' &&
    !Array.isArray(message) &&
    'method' in message &&
    (message as { method?: unknown }).method === 'tools/call'
  ) {
    const params = (message as { params?: unknown }).params;
    if (params !== null && typeof params === 'object' && !Array.isArray(params)) {
      const record = params as Record<string, unknown>;
      if (!('arguments' in record) || record.arguments === undefined || record.arguments === null) {
        return { ...message, params: { ...record, arguments: {} } };
      }
    }
  }
  return message;
}

export function createDevkitMcpServer({
  sessionId,
  runtimePacks = false,
  remoteSurface = false,
}: DevkitServerOptions = {}): McpServer {
  assertConstructedSchemas();
  // The approval posture resolves once at construction: a bogus
  // DEVKIT_APPROVAL_MODE throws here (boot fail-fast, the same doctrine
  // DEVKIT_PACKS applies through syncDisclosure), and registerOne below is
  // the one place the mode changes the wire surface.
  const askMode = approvalModeFromEnv(process.env) === 'ask';
  // The contradictory construction is refused, not cautioned: a remote that
  // also carried runtime pack toggling would attach the onPacksChanged seam
  // to every callOpts, publishing the server host's absolute install path
  // through every list_skills/retrieve_skill payload on an unauthenticated
  // HTTP face while its instructions honestly claimed withholding. Illegal
  // states stay unrepresentable (the same doctrine the packs_configure
  // refusal applies from the other direction).
  if (remoteSurface && runtimePacks) {
    throw new Error(
      'contradictory construction: remoteSurface and runtimePacks are mutually exclusive — ' +
        'the stateless remote must not carry runtime pack toggling (it would leak host paths through skill payloads)',
    );
  }
  // Refuse to start on a missing/partial skills tree: list_packs is
  // registry-driven and would otherwise advertise skills retrieve_skill
  // cannot serve. stdio and the stateless remote both boot through here,
  // and the remote re-verifies per request (one readdir — cheap).
  verifySkillTree();
  // Enablement resolves inside syncDisclosure: stdio resolves once at boot
  // (fail-fast exit on a bogus DEVKIT_PACKS), the stateless remote re-reads
  // env on every request, so both transports share one code path with no
  // transport branching. Unknown pack ids throw here; core is always in the
  // set, so its tools (the base face plus the three pack meta tools and
  // packs_configure) are never filtered.
  const server = new McpServer(
    { name: 'huaweicloud-devkit', version: pkgVersion },
    { instructions: instructionsFor(remoteSurface, runtimePacks) },
  );
  const registered = new Map<ToolName, RegisteredTool>();

  // One wanted-set derivation for boot and re-sync: enablement decides pack
  // ownership, runtimePacks decides the session-toggle tool itself, so a
  // server that never exposed the toggle can never grow it mid-flight. The
  // remoteSurface flag withholds every tool that writes the user's LOCAL
  // credential state on the unauthenticated remote: the vault mutations
  // (secrets pack), the auth mutation family (auth_init sets module-global
  // runtime credentials — cross-request state on a stateless face; auth_sync
  // / auth_switch persist / auth_confirm decrypt S1 vault refs and write
  // plaintext into ~/.obsutilconfig and the KooCLI profile), and the OBS
  // config fan-out. Ref-consuming sandbox calls remain callable there
  // (values go to the sandbox service, not the caller); that read-seam
  // residual is accepted, loopback-bound, and documented. sandbox_
  // expose_tunnel joins the same accepted residual deliberately: it opens
  // a PUBLIC tunnel URL on the operator's sandbox (not a read), bounded by
  // the server host's own hdkit credentials — same posture as its exec/
  // deploy siblings, and the connect-before-expose requirement.
  const REMOTE_WITHHELD_LOCAL_WRITERS = new Set([
    'huaweicloud_secret_set',
    'huaweicloud_secret_delete',
    'huaweicloud_auth_sync',
    'huaweicloud_auth_init',
    'huaweicloud_auth_switch',
    'huaweicloud_auth_confirm',
    'huaweicloud_setup_obs_config',
  ]);
  const isWanted = (tool: ToolDefinition, enabled: ReadonlySet<string>): boolean =>
    enabled.has(PACK_OF[tool.name]) &&
    (runtimePacks || tool.name !== 'huaweicloud_packs_configure') &&
    (!remoteSurface || (PACK_OF[tool.name] !== 'secrets' && !REMOTE_WITHHELD_LOCAL_WRITERS.has(tool.name)));

  const registerOne = (tool: ToolDefinition): void => {
    registered.set(
      tool.name,
      server.registerTool(
        tool.name,
        {
          description: tool.description,
          inputSchema: getToolSchema(tool.name),
          // Ask mode only: Claude Code honors this flag by prompting the
          // user on every call of this tool — even in acceptEdits/auto/
          // bypassPermissions modes, with no "don't ask again" — and that
          // client prompt IS the user's confirmation the mode trusts.
          // Other clients ignore the flag. Declared only in ask mode so
          // token-mode Claude Code users don't gain a second prompt on top
          // of the terminal approve they already run.
          ...(askMode && tool.name === 'huaweicloud_run_approved_command'
            ? { _meta: { 'anthropic/requiresUserInteraction': true } }
            : {}),
        },
        async (args): Promise<CallToolResult> => {
          const callOpts: CallToolOptions = runtimePacks
            ? { sessionId, onPacksChanged: () => syncDisclosure() }
            : { sessionId };
          const result = await callTool(tool.name, args, callOpts);
          const decorated = _decorateResult(sessionId, tool.name, result);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(decorated, null, 2),
              },
            ],
            isError: false,
          };
        },
      ),
    );
  };

  // Re-disclosure after huaweicloud_packs_configure mutates the override:
  // diff the wanted set against the registered set, add what appeared,
  // remove what vanished (RegisteredTool.remove). The SDK emits one
  // tools/list_changed per register/remove and no-ops them before connect,
  // so boot and re-sync share this one path and no extra notification is
  // needed. A client that ignores tools/list_changed still converges on its
  // next reconnect.
  const syncDisclosure = (): void => {
    const enabled = resolveEnabledPacks();
    for (const tool of TOOL_DEFINITIONS) {
      const wanted = isWanted(tool, enabled);
      const held = registered.has(tool.name);
      if (wanted && !held) registerOne(tool);
      else if (!wanted && held) {
        registered.get(tool.name)?.remove();
        registered.delete(tool.name);
      }
    }
  };

  syncDisclosure();

  return server;
}

// In-memory pair for tests: full SDK chain (registerTool, validation,
// decoration) without spawning a process.
export async function createLinkedDevkitServers(
  options: DevkitServerOptions = {},
): Promise<{ server: McpServer; transport: InMemoryTransport }> {
  const server = createDevkitMcpServer(options);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  return { server, transport: clientTransport };
}
