// E2E case contract. Cases are pure data; the runner, drivers, and the
// evaluator are consumers. Assertion surfaces are devkit-observable outbound
// artifacts only (fake-boundary recordings, files) — never agent internals.
// Agent-authored free text is matched only by the soft keyword-set matcher
// and never gates a verdict.

import type { HttpScript } from './http-fake.ts';

export type PackId =
  'core' | 'huaweicloud-cli' | 'sandbox' | 'auth' | 'obs' | 'voucher' | 'update' | 'discovery' | 'huaweicloud-open-mcp';

export interface Range {
  min: number;
  max: number;
}

// Order-insensitive hcloud argv matcher. The LLM authors the args array, so
// only the Service/Operation head and prompt-pinned flag values are matched
// literally; flag order and extra flags (e.g. --cli-region the model adds)
// are tolerated. `flags` maps flag name (no `--`) to the exact value.
export interface HcloudArgMatcher {
  head: string[];
  flags?: Record<string, string>;
  times?: Range;
}

// Soft signal: the final assistant message must contain at least one of the
// keywords. Recorded in the report, never a gating verdict.
export interface AgentSaysMatcher {
  any: string[];
}

// Trace toolCall matcher: name is exact; args is a shallow partial — every
// key must deep-equal (scalar) or array-prefix-match the traced (redacted)
// args. ok narrows by outcome when present.
export interface ToolCallMatcher {
  name: string;
  args?: Record<string, unknown>;
  ok?: boolean;
  times?: Range;
}

// Disclosure matcher over the outbound wire face: toolsList (with the
// client-visible tool count) and toolsListChanged notifications.
export interface DisclosureMatcher {
  event: 'toolsList' | 'toolsListChanged';
  toolCount?: number;
  times?: Range;
}

export type Expectation =
  | ({ kind: 'hcloud' } & HcloudArgMatcher)
  | ({ kind: 'toolCall' } & ToolCallMatcher)
  | { kind: 'noToolCall'; name: string }
  | ({ kind: 'disclosure' } & DisclosureMatcher)
  | ({ kind: 'http' } & HttpExpectation)
  | ({ kind: 'gateway' } & GatewayExpectation)
  | ({ kind: 'ws' } & WsCommandMatcher)
  | { kind: 'wsConnections'; times?: Range }
  | ({ kind: 'file' } & FileExpectation)
  | ({ kind: 'sequence' } & SequenceExpectation)
  | { kind: 'agentSays'; text: AgentSaysMatcher };

// ws-exec boundary expectation over WsFake recordings: commands with a
// recognized intent (the zero-unknown gate: intent 'unknown' with
// times {0,0} catches fake/product script drift as a red, not a silent
// degrade).
export interface WsCommandMatcher {
  intent: string;
  times?: Range;
}

// Ordered-subsequence expectation within ONE recording channel (the
// channels carry no cross-comparable timestamps, so cross-channel ordering
// would be dishonest to assert). Steps match by the channel's natural key;
// extra records between steps are tolerated. This is what pins flagship
// orderings like plan → approved run, discovery → execution, and
// IAM validation → credential injection.
export interface SequenceExpectation {
  channel: 'toolCall' | 'gateway' | 'http';
  // toolCall/gateway: tool names. http: method+path records.
  steps: SequenceStep[];
}

export type SequenceStep = string | { method?: string; path: string };

// Gateway-sidecar expectation over OPENMCP_FAKE_LOG recordings: a
// tools/call to `tool` (null tool matches non-call methods like
// tools/list), with the same shallow-partial args matching as toolCall.
// times {min:0,max:0} is the consent-flow negative (no manage_policy
// without user consent).
export interface GatewayExpectation {
  tool?: string | null;
  method?: string;
  args?: Record<string, unknown>;
  times?: Range;
}

// HTTP-boundary expectation: exact pathname (query stripped) plus optional
// method, matched against the local http fake's recordings.
export interface HttpExpectation {
  method?: string;
  path: string;
  times?: Range;
}

// File artifact expectation: path is relative to the throwaway home;
// `contains` is a substring check against the file's content (null content
// fails). Files seeded by fixtures.home can satisfy this too, so file
// expectations never count toward liveness.
export interface FileExpectation {
  path: string;
  contains?: string;
}

export interface HcloudScript {
  // Each response matches when the recorded argv starts with `argv`
  // (element-wise). First hit wins.
  responses: { argv: string[]; stdout?: string; stderr?: string; exitCode?: number }[];
  default?: { stdout?: string; stderr?: string; exitCode?: number };
}

export interface CaseFixtures {
  hcloud?: HcloudScript;
  http?: HttpScript;
  openMcp?: {
    // FAKE_POLICY=1: the fake sidecar exposes execute_api / manage_policy /
    // query_data / transform_data with the probed policy-lite semantics
    // (empty policy = deny, refusal reason teaches the consent path).
    policyTools?: boolean;
  };
  // Update-pack cases: relaxes HUAWEICLOUD_DEVKIT_SKIP_UPDATE (the only
  // relaxable posture key, env-policy whitelist) and points
  // HUAWEICLOUD_NPM_REGISTRY at the case's local HTTP fake for the run env
  // — the install env keeps the default posture. The dist-tags script
  // rides fixtures.http like any other response.
  updateCheck?: boolean;
  // Start the local hwlink ws-exec fake for this case: the literal token
  // {wsUrl} in http script bodies is replaced with its ws:// URL at
  // assembly time (the hwlink GET-poll script returns it as
  // connection_info.url; the product appends ?source=<int32> itself).
  ws?: boolean;
  // Files written into the throwaway home BEFORE install (relative path →
  // content): S1 vault seeding, KooCLI profile config, etc.
  home?: Record<string, string>;
  // Files written into the throwaway workdir BEFORE the agent runs
  // (relative path → content): the project template a case scans. The
  // literal token {workdir} in the prompt is replaced with the workdir's
  // absolute path — the only way a case can reference a path only the
  // runner knows.
  workdir?: Record<string, string>;
}

export interface E2eCase {
  id: string;
  pack: PackId;
  prompt: string;
  // Case-scoped env vars for the RUN env (never the install env), applied
  // between seam vars and the fixed posture inside buildCaseEnv — so a case
  // can add seams (e.g. HUAWEICLOUD_ICONS_OFFLINE=1) but can never defeat
  // the fixed posture (relaxFixed is the only channel for that).
  env?: Record<string, string>;
  // Pack posture rides the operator channel: `install --packs <ids>`.
  // The env channel (DEVKIT_PACKS) is stripped by env-policy for every
  // case, so this is the single delivery path.
  installPacks?: string;
  fixtures: CaseFixtures;
  expect: Expectation[];
  softExpect?: Expectation[];
  budget: { timeoutMs: number; attempts: number };
  unsupportedPlatforms?: { platform: NodeJS.Platform; reason: string }[];
}
