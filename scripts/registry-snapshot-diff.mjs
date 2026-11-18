// Snapshot diff between the checked-in legacy registry snapshot and the zod
// registry. The fixture is the authoritative pre-migration JSON-Schema
// contract, extracted from the git-History tools.ts literals by
// scripts/extract-legacy-registry.mjs (NOT a zod render). Exits non-zero on
// any drift in property names (both directions), types, enums, required
// sets, nested shapes, or item schemas. Declared additive keys of zod
// rendering ($schema, additionalProperties, description presence) are
// ignored; the INTENTIONAL_DRIFTS list carries the reviewed semantic
// widenings (numericArg union, free-form unions, record key typing).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { TOOL_DEFINITIONS } from '../plugins/huaweicloud-core/src/tools.ts';
import { getToolSchema, assertConstructedSchemas } from '../plugins/huaweicloud-core/src/tool-schemas.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const snapshotPath = join(root, 'test', 'fixtures', 'legacy-registry-snapshot.json');

const IGNORED_KEYS = new Set(['$schema', 'additionalProperties', 'description']);

// Tools registered after the legacy snapshot was extracted. They have no git
// history to regenerate the fixture from, so the snapshot cannot cover them;
// listed here instead of weakening the check for the remaining legacy tools.
const EXEMPT_TOOLS = new Set([
  'huaweicloud_list_packs',
  'huaweicloud_pack_info',
  'huaweicloud_list_skills',
  'huaweicloud_packs_configure',
  'huaweicloud_gateway_list_tools',
  'huaweicloud_gateway_call',
  'huaweicloud_gateway_restart',
  'huaweicloud_secret_set',
  'huaweicloud_secret_list',
  'huaweicloud_secret_delete',
  'huaweicloud_competition_voucher_claim',
  'huaweicloud_sandbox_expose_tunnel',
  'huaweicloud_obs_set_cors',
  'huaweicloud_check_account_type',
  'huaweicloud_sandbox_renew_tunnel',
  'huaweicloud_sandbox_keepalive_watchdog',
  'huaweicloud_sandbox_exec_poll',
  'huaweicloud_sandbox_shutdown',
]);

// Declared, intentional drifts from the legacy literals. Each entry names the
// semantic reason the zod render is allowed to differ.
const INTENTIONAL_DRIFTS = [
  {
    tool: '*',
    reason:
      'numericArg fields declare the #530 leniency the old literals omitted: number | string | null in, normalizeNumericArgs keeps the final say',
    match: (tool, key, legacy, rendered) =>
      legacy &&
      typeof legacy === 'object' &&
      legacy.type === 'number' &&
      rendered &&
      typeof rendered === 'object' &&
      JSON.stringify(rendered.type) === '["number","string","null"]',
  },
  {
    tool: '*',
    reason: 'free-form union properties get an explicit anyOf the legacy literal left untyped',
    match: (tool, key, legacy, rendered) =>
      legacy &&
      typeof legacy === 'object' &&
      Object.keys(legacy).length === 0 &&
      rendered &&
      typeof rendered === 'object' &&
      Array.isArray(rendered.anyOf),
  },
  {
    tool: '*',
    reason: 'z.record declares key typing (propertyNames) the legacy bare object omitted',
    match: (tool, key, legacy, rendered) =>
      legacy &&
      typeof legacy === 'object' &&
      legacy.type === 'object' &&
      Object.keys(legacy).length === 1 &&
      rendered &&
      typeof rendered === 'object' &&
      rendered.type === 'object' &&
      Object.keys(rendered).every((k) => k === 'type' || k === 'propertyNames'),
  },
  {
    tool: 'huaweicloud_retrieve_skill',
    reason:
      'name declares the skill-name pattern the legacy literal left untyped: retrieve_skill is the server-side skill loader, so traversal-shaped names are rejected at the schema boundary',
    match: (tool, key, legacy, rendered) =>
      legacy &&
      typeof legacy === 'object' &&
      legacy.type === 'string' &&
      rendered &&
      typeof rendered === 'object' &&
      rendered.type === 'string' &&
      rendered.pattern === '^[a-z0-9-]+$',
  },
];

// The confirm-language hint rows share one reason (the addition is one
// feature across the roster, not ten): the model relays the user's
// conversation language so the human-facing confirmation form renders its
// display text in it — the MCP server never sees the chat, so the model is
// the only context observer. Optional and soft-failing (an unrecognized
// value falls through to the operator's DEVKIT_CONFIRM_LANG pin, then the
// machine locale; lib/confirm-language.ts owns the ladder). Injected on
// every roster tool by src/tool-schemas.ts; the six roster tools absent
// here sit in EXEMPT_TOOLS above, where no row can fire.
const confirmLanguageAdditionReason =
  "The confirm-language hint (the approval domain's parameter, injected roster-wide by src/tool-schemas.ts): the model relays the user's conversation language so the confirmation form's display text localizes to it; optional and soft-failing, resolved by lib/confirm-language.ts's tier ladder (operator env pin, then the hint, then the machine locale).";

// Deliberate additive properties. The legacy snapshot is the pre-migration
// contract, so features ported after it add properties the fixture can never
// carry (same reasoning as EXEMPT_TOOLS: the fixture is history, not a live
// render). Each entry names the source of the addition.
const DELIBERATE_ADDITIONS = [
  {
    tool: 'huaweicloud_sandbox_connect',
    property: 'pool_type',
    reason:
      'dev 60743c2b 两池 pool_type 客户端适配：连接时选择 ephemeral/persistent 池（服务端权威映射模板，显式 template_id 优先）',
  },
  {
    tool: 'huaweicloud_explain_error',
    property: 'code',
    reason:
      '2026-11-05 UX report #11: `code` was the silent-failure alias agents actually sent (the loose schema already passed it through to the handler); declaring it documents the accepted alias instead of leaving the drop implicit.',
  },
  {
    tool: 'huaweicloud_sandbox_exec_one_shot',
    property: 'mode',
    reason:
      'The async-exec claim protocol (TLA+-verified as HwExecClaim): mode "async" claims a task directory and spawns the command detached, so long build-class commands stop hitting the synchronous timeout cliff; the pre-migration contract only knew the sync exec.',
  },
  {
    tool: 'huaweicloud_run_approved_command',
    property: 'command',
    reason:
      'The operator-approved command-forward shape: the harness permission popup renders the tool input, so a top-level command line makes the command the first thing the user reads. Optional in the schema ON PURPOSE (the gate, not zod, is the enforcer): an args-only legacy call must still reach the gate, and the gate checks equality whenever the field is present.',
  },
  {
    tool: 'huaweicloud_sandbox_exec_one_shot',
    property: 'task_id',
    reason:
      "The async-exec claim protocol's task identity: a path- and pgrep-safe id the caller reuses when retrying an uncertain start — the claim file blocks a second spawn; omitting it lets the tool generate one.",
  },
  {
    tool: 'huaweicloud_sandbox_connect',
    property: 'approvalToken',
    reason:
      'PR-3a registers connect on the approval gate (always flavor, gate token source): the token the USER_CONFIRMATION_REQUIRED envelope mints spends the confirmation. Optional in the schema like the hcloud run face — the gate, not zod, is the enforcer, so a first no-token call must reach the gate to receive the mint envelope.',
  },
  {
    tool: 'huaweicloud_sandbox_connect',
    property: 'approvedByUser',
    reason:
      "PR-3a's gate attestation: in token mode the call requires the agent's explicit statement that the user approved; in ask mode it is the T3 chat round-trip retry marker. Schema-optional because a required field would die in SDK validation before the gate could teach the confirmation ritual.",
  },
  {
    tool: 'huaweicloud_sandbox_exec_with_session',
    property: 'approvalToken',
    reason:
      'PR-3a registers the session exec face as a CLASSIFIED gate tool: a write-classified command confirms per call (mint → terminal approve → retry), a benign one passes through with no token at all. Schema-optional so both shapes reach the gate.',
  },
  {
    tool: 'huaweicloud_sandbox_exec_with_session',
    property: 'approvedByUser',
    reason:
      "PR-3a's gate attestation on the session exec face: the token-mode statement of user approval, and the ask-mode chat round-trip retry marker. Schema-optional for the same reason as the run face's.",
  },
  {
    tool: 'huaweicloud_sandbox_exec_one_shot',
    property: 'approvalToken',
    reason:
      'PR-3a registers the one-shot exec face as a CLASSIFIED gate tool (same contract as the session face): write-classified content confirms per call, benign content passes ungated.',
  },
  {
    tool: 'huaweicloud_sandbox_exec_one_shot',
    property: 'approvedByUser',
    reason:
      "PR-3a's gate attestation on the one-shot exec face: token-mode statement of user approval, ask-mode chat round-trip retry marker.",
  },
  {
    tool: 'huaweicloud_sandbox_sign_agreement',
    property: 'approvalToken',
    reason:
      'PR-3a registers agreement signing on the approval gate (always flavor): a legal-agreement signature earns a human present per call, mechanically — the skill teaching that demanded explicit consent is now enforced, not requested.',
  },
  {
    tool: 'huaweicloud_sandbox_sign_agreement',
    property: 'approvedByUser',
    reason:
      "PR-3a's gate attestation on the agreement face: the token-mode statement of user approval and the ask-mode retry marker.",
  },
  {
    tool: 'huaweicloud_sandbox_credentials',
    property: 'approvalToken',
    reason:
      'PR-3a registers credential injection on the approval gate (always flavor): injecting temporary AK/SK plus a long-lived DevBridge API key into a sandbox mutates its credential state, so it confirms per call.',
  },
  {
    tool: 'huaweicloud_sandbox_credentials',
    property: 'approvedByUser',
    reason:
      "PR-3a's gate attestation on the credentials face: the token-mode statement of user approval and the ask-mode retry marker.",
  },
  {
    tool: 'huaweicloud_auth_init',
    property: 'approvalToken',
    reason:
      'PR-3b registers the account-switch pair on the approval chain (gate tokenSource): a no-token call returns the USER_CONFIRMATION_REQUIRED envelope carrying this minted token, so the property is part of the gate contract the legacy snapshot predates.',
  },
  {
    tool: 'huaweicloud_auth_init',
    property: 'approvedByUser',
    reason:
      'PR-3b approval-chain registration: the attestation the chat round-trip retry carries in ask mode (and the token-mode attestation), optional in the schema on purpose so a missing value reaches the gate and its teaching refusal instead of dying in SDK validation.',
  },
  {
    tool: 'huaweicloud_auth_switch',
    property: 'approvalToken',
    reason:
      'PR-3b registers the account-switch pair on the approval chain (gate tokenSource): a no-token call returns the USER_CONFIRMATION_REQUIRED envelope carrying this minted token, so the property is part of the gate contract the legacy snapshot predates.',
  },
  {
    tool: 'huaweicloud_auth_switch',
    property: 'approvedByUser',
    reason:
      'PR-3b approval-chain registration: the attestation the chat round-trip retry carries in ask mode (and the token-mode attestation), optional in the schema on purpose so a missing value reaches the gate and its teaching refusal instead of dying in SDK validation.',
  },
  {
    tool: 'huaweicloud_obs_set_website_config',
    property: 'approvalToken',
    reason:
      'PR-3c approval registration: the gate-source token parameter the approval gate mints on a no-token call. Optional in the schema ON PURPOSE (the gate, not zod, is the enforcer): a no-token call must reach the gate to receive the USER_CONFIRMATION_REQUIRED envelope.',
  },
  {
    tool: 'huaweicloud_obs_set_website_config',
    property: 'approvedByUser',
    reason:
      'PR-3c approval registration: the attestation parameter — token mode requires it beside the token; in ask mode it is the T3 chat round-trip retry marker.',
  },
  {
    tool: 'huaweicloud_upgrade',
    property: 'approvalToken',
    reason:
      'PR-3c approval registration (the mechanical gate replaces the description-level consent): the gate-source token parameter, same optional-in-schema doctrine as the obs pair.',
  },
  {
    tool: 'huaweicloud_upgrade',
    property: 'approvedByUser',
    reason: 'PR-3c approval registration: the attestation parameter, same mode-conditional doctrine as the obs pair.',
  },
  {
    tool: 'huaweicloud_run_approved_command',
    property: 'confirmLanguage',
    reason: confirmLanguageAdditionReason,
  },
  {
    tool: 'huaweicloud_sandbox_connect',
    property: 'confirmLanguage',
    reason: confirmLanguageAdditionReason,
  },
  {
    tool: 'huaweicloud_sandbox_exec_with_session',
    property: 'confirmLanguage',
    reason: confirmLanguageAdditionReason,
  },
  {
    tool: 'huaweicloud_sandbox_exec_one_shot',
    property: 'confirmLanguage',
    reason: confirmLanguageAdditionReason,
  },
  {
    tool: 'huaweicloud_sandbox_sign_agreement',
    property: 'confirmLanguage',
    reason: confirmLanguageAdditionReason,
  },
  {
    tool: 'huaweicloud_sandbox_credentials',
    property: 'confirmLanguage',
    reason: confirmLanguageAdditionReason,
  },
  {
    tool: 'huaweicloud_auth_init',
    property: 'confirmLanguage',
    reason: confirmLanguageAdditionReason,
  },
  {
    tool: 'huaweicloud_auth_switch',
    property: 'confirmLanguage',
    reason: confirmLanguageAdditionReason,
  },
  {
    tool: 'huaweicloud_obs_set_website_config',
    property: 'confirmLanguage',
    reason: confirmLanguageAdditionReason,
  },
  {
    tool: 'huaweicloud_upgrade',
    property: 'confirmLanguage',
    reason: confirmLanguageAdditionReason,
  },
];

// The other three PR-3c registrations (huaweicloud_obs_set_cors,
// huaweicloud_secret_delete, huaweicloud_packs_configure) sit in
// EXEMPT_TOOLS above: the snapshot has no legacy entry for them, so the
// comparison loop skips them before it ever consults this list — their
// approval parts are exercised by the structure and approval batteries
// instead, and no DELIBERATE_ADDITIONS row could ever fire for them.

// Deliberate optionals: properties the legacy snapshot carries as REQUIRED
// that a reviewed change made mode-conditional. Same reasoning as
// DELIBERATE_ADDITIONS — the fixture is history, not a live render — but the
// drift direction is required→optional, so an entry is consulted by the
// missingRequired check only; every other check (types, enums, nested
// shapes, newly-required keys) still applies to the property in full.
const DELIBERATE_OPTIONALS = [
  {
    tool: 'huaweicloud_run_approved_command',
    property: 'approvalToken',
    reason: 'DEVKIT_APPROVAL_MODE=ask makes the harness client the confirmation, so the token becomes mode-conditional',
  },
  {
    tool: 'huaweicloud_run_approved_command',
    property: 'approvedByUser',
    reason:
      'PR-1.5 server-run confirmation: the attestation is the T3 chat round-trip retry marker, so the first ask-mode arrival carries none and must reach the gate (a schema-required field would die in SDK validation). Token mode still throws the teaching rejection when it is absent.',
  },
];

// Deliberate removals: properties the legacy snapshot carries that a reviewed
// change removed from the live contract. Same reasoning as
// DELIBERATE_ADDITIONS — the fixture is history, not a live render — but the
// drift direction is removal, so an entry is consulted by the missingProps
// check only; every other check (types, enums, nested shapes) still applies
// to every remaining property in full.
const DELIBERATE_REMOVALS = [
  {
    tool: 'huaweicloud_sandbox_connect',
    property: 'template_id',
    reason:
      'dev 8c1af52e: custom templates retired — connect only supports pool_type, the server owns the pool_type → template mapping, and the client neither sends nor exposes template_id (HW_POOL_TEMPLATE_* pinning dropped with it)',
  },
];

function normalize(node) {
  if (Array.isArray(node)) return node.map((item) => normalize(item));
  if (node !== null && typeof node === 'object') {
    const out = {};
    for (const key of Object.keys(node).sort((a, b) => a.localeCompare(b))) {
      if (IGNORED_KEYS.has(key)) continue;
      out[key] = normalize(node[key]);
    }
    // zod renders single-type leaves as "type": "string" and unions as
    // arrays; collapse single-element arrays for comparison.
    if (Array.isArray(out.type) && out.type.length === 1) out.type = out.type[0];
    return out;
  }
  return node;
}

function isIntentionalDrift(tool, key, legacyProp, renderedProp) {
  return INTENTIONAL_DRIFTS.some((rule) => rule.match(tool, key, legacyProp, renderedProp));
}

// zod renders optional leaves by omitting them from `required`, not by
// marking the property — same semantic as the legacy literals. `required`
// itself is compared as a set.
function requiredSet(schema) {
  return new Set(schema.required ?? []);
}

function propKeys(schema) {
  return new Set(Object.keys(schema.properties ?? {}));
}

assertConstructedSchemas();

const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8'));
const failures = [];

let compared = 0;
for (const tool of TOOL_DEFINITIONS) {
  if (EXEMPT_TOOLS.has(tool.name)) continue;
  compared++;
  const legacy = snapshot[tool.name];
  if (!legacy) {
    failures.push(`${tool.name}: no legacy snapshot entry (regenerate the fixture from git history)`);
    continue;
  }
  const normLegacy = normalize(legacy);
  const normRendered = normalize(getToolSchema(tool.name).toJSONSchema());

  const legacyRequired = requiredSet(normLegacy);
  const renderedRequired = requiredSet(normRendered);
  const missingRequired = [...legacyRequired].filter(
    (k) =>
      !renderedRequired.has(k) &&
      !DELIBERATE_OPTIONALS.some((optional) => optional.tool === tool.name && optional.property === k),
  );
  if (missingRequired.length) {
    failures.push(`${tool.name}: required keys missing in zod render: ${missingRequired.join(', ')}`);
  }
  const extraRequired = [...renderedRequired].filter((k) => !legacyRequired.has(k));
  if (extraRequired.length) {
    failures.push(`${tool.name}: keys newly required by zod (legacy left them optional): ${extraRequired.join(', ')}`);
  }

  const legacyProps = propKeys(normLegacy);
  const renderedProps = propKeys(normRendered);
  const missingProps = [...legacyProps].filter(
    (k) =>
      !renderedProps.has(k) &&
      !DELIBERATE_REMOVALS.some((removal) => removal.tool === tool.name && removal.property === k),
  );
  if (missingProps.length) {
    failures.push(`${tool.name}: properties missing in zod render: ${missingProps.join(', ')}`);
  }
  const extraProps = [...renderedProps].filter(
    (k) =>
      !legacyProps.has(k) &&
      !DELIBERATE_ADDITIONS.some((addition) => addition.tool === tool.name && addition.property === k),
  );
  if (extraProps.length) {
    failures.push(`${tool.name}: properties added by zod render (legacy contract had none): ${extraProps.join(', ')}`);
  }

  // Deep structural comparison per shared property: type, enum, items,
  // nested property trees and nested required.
  for (const key of legacyProps) {
    if (!normRendered.properties?.[key]) continue;
    const a = normLegacy.properties[key];
    const b = normRendered.properties[key];
    if (JSON.stringify(a) !== JSON.stringify(b) && !isIntentionalDrift(tool.name, key, a, b)) {
      failures.push(
        `${tool.name}.${key}: structural drift\n  legacy:   ${JSON.stringify(a)}\n  rendered: ${JSON.stringify(b)}`,
      );
    }
  }
}

if (failures.length > 0) {
  console.error(`registry snapshot diff FAILED (${failures.length}):`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(
  `registry snapshot diff OK: ${compared} tools structurally identical (${TOOL_DEFINITIONS.length - compared} exempt, no legacy snapshot).`,
);
