import { join } from 'node:path';

import { asText } from '../../lib/as-text.ts';
import { isInsideProtectedTree, packStateDir } from '../../lib/pack-state.ts';
import { classifyTextCommand } from '../../safety-policy.ts';
import { POLICY_FILE } from './sidecar.ts';

// The gateway_call floor table: the devkit-side residue of the delegated
// approval face. Authorization for every routed gateway tool belongs to
// the gateway's own policy engine (probed 2026-10-10 against the real
// gateway v0.2.0a4: an empty policy file makes it refuse execute_api with
// a consent-teaching reason, while query_data/transform_data are not
// policy-gated gateway-side at all). What stays here are the floors the
// gateway cannot enforce for this face: secret operations, the protected
// state tree, and the shape of manage_policy itself. Every ruling is one
// of {deny, forward} — this face never mints consent, it only refuses
// before forwarding; everything else is the engine's call.

export type Verdict = 'deny' | 'forward';

export interface Ruling {
  verdict: Verdict;
  /** Populated for deny: actionable, names the violated floor. */
  reason?: string;
}

// HUAWEICLOUD_OPENMCP_APPROVAL is retired with the devkit/native mode
// split. An operator who set it must not upgrade into a silent no-op:
// the guard throws with the migration pointer and stays for at least one
// release (the DEVKIT_PACKS unknown-id precedent). Call-time validation,
// deliberately NOT wired into createDevkitMcpServer: the protocol layer
// stays pack-agnostic, and the error surfaces as an actionable tool
// result instead of a failed boot.
export function resolveApprovalMode(env: NodeJS.ProcessEnv = process.env): void {
  const value = (env.HUAWEICLOUD_OPENMCP_APPROVAL ?? '').trim();
  if (value === '') return;
  const operatorPath = (env.HUAWEICLOUD_MCP_POLICY_FILE ?? '').trim();
  const policyFile = operatorPath !== '' ? operatorPath : join(packStateDir('huaweicloud-open-mcp', env), POLICY_FILE);
  throw new Error(
    `HUAWEICLOUD_OPENMCP_APPROVAL is retired (was set to "${value}"): gateway tool approval is delegated to the gateway's own policy engine. ` +
      `Manage consent in the operator policy file (${policyFile}); it hot-reloads, so edits take effect without a restart. ` +
      'See docs/safety-model.md for the delegation contract and the floors this face still enforces.',
  );
}

// The one vocabulary table for the gateway tool surface. Every list that
// enumerates gateway tool names derives from here: classify's read-only
// set, the unknown-tool deny, and gateway_list_tools' projection
// (KNOWN_GATEWAY_TOOLS in tools.ts). Adding a gateway tool is a one-row
// edit plus a classify row — no hand-maintained duplicates.
export const GATEWAY_TOOL_VOCABULARY = {
  readonly: ['search_apis', 'list_products', 'get_product', 'list_apis', 'get_api', 'get_api_examples'],
  routed: ['manage_policy', 'execute_api', 'query_data', 'transform_data'],
} as const;

const READONLY_TOOLS = new Set<string>(GATEWAY_TOOL_VOCABULARY.readonly);
const KNOWN_TOOLS = new Set<string>([...GATEWAY_TOOL_VOCABULARY.readonly, ...GATEWAY_TOOL_VOCABULARY.routed]);

// The only scopes an agent may grant through manage_policy add: every one
// of them dies with the process or the clock. An allow-list, not a
// deny-list of known persistent spellings. The gateway itself would
// accept scope=permanent and write the rule straight into the operator's
// policy file (probed 2026-10-10) — this floor is the only barrier
// between an agent and a grant that outlives every consent boundary.
const EPHEMERAL_SCOPES = new Set(['once', 'session', 'temporary']);

// Permanent grants are the one policy mutation an agent can never buy: a
// permanent allow outlives every consent boundary this devkit enforces,
// so it stays an operator gesture against the file itself.
function permanentGrantReason(): string {
  const operatorPath = (process.env.HUAWEICLOUD_MCP_POLICY_FILE ?? '').trim();
  const path = operatorPath !== '' ? operatorPath : join(packStateDir('huaweicloud-open-mcp'), POLICY_FILE);
  return `permanent-scope grants are an operator gesture, not an agent action: edit the policy file directly (${path}); it hot-reloads, so the change takes effect without a restart`;
}

export function classify(tool: string, toolArgs: Record<string, unknown>): Ruling {
  if (READONLY_TOOLS.has(tool)) return { verdict: 'forward' };

  if (tool === 'manage_policy') {
    const rawAction = toolArgs.action;
    if (typeof rawAction !== 'string') {
      return {
        verdict: 'deny',
        reason: `manage_policy accepts only list, add, and remove through this face (got ${JSON.stringify(rawAction)}).`,
      };
    }
    // F1 spelling floor: only canonical spellings cross. The gateway
    // validates its own scope vocabulary at add (re-probed 2026-10-11
    // against v0.2.0a4: ' ONCE '/'Once' are rejected with 未知 scope), and
    // round-5's verbatim-' ONCE '-grant behavior measured a pre-a4 build.
    // The floor stays fail-closed regardless of gateway-side validation:
    // the devkit's actionable English deny beats relaying a Chinese
    // rejection, and a future gateway that relaxes validation meets this
    // floor first.
    if (rawAction !== rawAction.trim().toLowerCase()) {
      return {
        verdict: 'deny',
        reason: `manage_policy action must use the exact canonical spelling (got ${JSON.stringify(rawAction)}); resend with "list", "add", or "remove" in lowercase, no surrounding whitespace.`,
      };
    }
    if (rawAction === 'list') return { verdict: 'forward' };
    if (rawAction !== 'add' && rawAction !== 'remove') {
      return {
        verdict: 'deny',
        reason: `manage_policy accepts only list, add, and remove through this face (got ${JSON.stringify(rawAction)}).`,
      };
    }
    if (rawAction === 'add') {
      const rawScope = toolArgs.scope;
      if (typeof rawScope !== 'string') {
        return {
          verdict: 'deny',
          reason: `manage_policy add accepts only the ephemeral scopes (${[...EPHEMERAL_SCOPES].join(', ')}) through this face; pass one explicitly. ${permanentGrantReason()}`,
        };
      }
      if (rawScope !== rawScope.trim().toLowerCase()) {
        return {
          verdict: 'deny',
          reason: `manage_policy add requires the scope in its exact canonical spelling (once, session, temporary); got ${JSON.stringify(rawScope)}.`,
        };
      }
      if (!EPHEMERAL_SCOPES.has(rawScope)) {
        return {
          verdict: 'deny',
          reason: `manage_policy add accepts only the ephemeral scopes (${[...EPHEMERAL_SCOPES].join(', ')}) through this face; pass one explicitly. ${permanentGrantReason()}`,
        };
      }
      // F2 ttl floor: the gateway honors ttl_seconds only with
      // scope=temporary (probed 2026-10-10), where it stretches an
      // "ephemeral" grant into an arbitrarily long-lived one. The knob
      // is denied outright; durable rules are the operator's file edit.
      if (toolArgs.ttl_seconds !== undefined && toolArgs.ttl_seconds !== null) {
        return {
          verdict: 'deny',
          reason:
            'manage_policy add takes no ttl_seconds through this face: the gateway honors it only with scope=temporary, where it would stretch an ephemeral grant into a long-lived one. ' +
            `${permanentGrantReason()}`,
        };
      }
      return { verdict: 'forward' };
    }
    // remove: the gateway REJECTS remove with a scope or ttl_seconds
    // (manage_policy_ops: "remove 不接受 scope/ttl_seconds 参数") — a
    // forwarded remove carrying either is a guaranteed gateway rejection,
    // so the shape is refused here.
    if (
      (toolArgs.scope !== undefined && toolArgs.scope !== null) ||
      (toolArgs.ttl_seconds !== undefined && toolArgs.ttl_seconds !== null)
    ) {
      return {
        verdict: 'deny',
        reason:
          'manage_policy remove takes no scope or ttl_seconds: removal is cross-layer by line, and the gateway rejects a scoped remove outright.',
      };
    }
    return { verdict: 'forward' };
  }

  if (tool === 'execute_api') {
    // The secret floor: the hcloud secret rules encode which operations
    // must never surface plaintext in the agent context, and no gateway
    // policy setting can widen that (the gateway itself has no secret
    // guard — probed 2026-10-10, an allowed KMS ShowSecretVersion rule
    // proceeded to catalog resolution).
    const secretCheck = classifyTextCommand(`hcloud ${asText(toolArgs.product)} ${asText(toolArgs.api)}`);
    if (secretCheck.risk === 'secret') return { verdict: 'deny', reason: secretCheck.reason };
    return { verdict: 'forward' };
  }

  if (tool === 'query_data' || tool === 'transform_data') {
    const violation = localFileTargetViolation(toolArgs);
    if (violation) return { verdict: 'deny', reason: violation };
    return { verdict: 'forward' };
  }

  // Unknown tool names deny against the static vocabulary: the live
  // surface is not consulted, and no name outside the table gets a free
  // pass on ignorance. Fail closed.
  return {
    verdict: 'deny',
    reason: `${tool} is not in the gateway tool vocabulary this face routes (${[...KNOWN_TOOLS].join(', ')}); the call is denied rather than forwarded blind.`,
  };
}

// The local-file boundary for the data tools: every structured path field
// the gateway resolves (out.path, tables.*.path) crosses the protected
// tree check, and every path-like string value anywhere in the arguments
// crosses the CLI face's own credential patterns. Raw values are walked,
// never JSON.stringify: serialization doubles backslashes, defeating
// single-separator patterns on Windows paths (round-5 probe). A seen-set
// bounds the walk instead. Path-like means the value contains a separator
// — the whole value is the candidate and is a superset of any literal
// inside it (the patterns are unanchored substrings, so classifying the
// whole subsumes classifying any fragment; a separate literal-extraction
// pass changed no verdict and was deleted, round-6). Each candidate is
// also matched in a backslash-collapsed variant: a value that is itself a
// JSON string (read_json('{"path":"C:\\\\hcloud\\\\config"}')) carries
// the doubling in memory, and collapsing it restores the single separator
// the patterns require. Residual: non-credential protected paths written
// as SQL literals are not caught by the scan (the structured fields are,
// via the tree check).
function localFileTargetViolation(toolArgs: Record<string, unknown>): string | null {
  const targets: string[] = [];
  const out = toolArgs.out;
  if (out !== null && typeof out === 'object' && !Array.isArray(out)) {
    const outPath = (out as Record<string, unknown>).path;
    if (typeof outPath === 'string') targets.push(outPath);
  }
  const tables = toolArgs.tables;
  if (tables !== null && typeof tables === 'object' && !Array.isArray(tables)) {
    for (const entry of Object.values(tables as Record<string, unknown>)) {
      if (entry !== null && typeof entry === 'object' && !Array.isArray(entry)) {
        const entryPath = (entry as Record<string, unknown>).path;
        if (typeof entryPath === 'string') targets.push(entryPath);
      }
    }
  }
  for (const target of targets) {
    if (isInsideProtectedTree(target)) {
      return `file targets inside devkit consent infrastructure are blocked (${target} resolves inside the protected state tree)`;
    }
  }
  const candidates = new Set<string>();
  collectPathLikeStrings(toolArgs, candidates);
  for (const candidate of candidates) {
    for (const variant of [candidate, candidate.replace(/\\\\/g, '\\')]) {
      const ruling = classifyTextCommand(variant);
      if (ruling.risk === 'credential') {
        return `${ruling.reason || 'Reading Huawei Cloud credential or profile files is blocked.'} Matched the path-like token "${variant}" in the tool arguments; the scan deliberately over-denies, so a benign mention of the same name is refused too.`;
      }
    }
  }
  return null;
}

// Whole string values that contain a path separator. The seen-set makes
// pathological (circular) inputs terminate instead of throwing — classify
// must never reject, only rule.
function collectPathLikeStrings(value: unknown, out: Set<string>, seen = new Set<unknown>()): void {
  if (typeof value === 'string') {
    if (/[\\/]/.test(value)) out.add(value);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  if (seen.has(value)) return;
  seen.add(value);
  for (const child of Object.values(value as Record<string, unknown>)) {
    collectPathLikeStrings(child, out, seen);
  }
}
