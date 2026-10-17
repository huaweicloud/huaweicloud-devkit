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
  const missingRequired = [...legacyRequired].filter((k) => !renderedRequired.has(k));
  if (missingRequired.length) {
    failures.push(`${tool.name}: required keys missing in zod render: ${missingRequired.join(', ')}`);
  }
  const extraRequired = [...renderedRequired].filter((k) => !legacyRequired.has(k));
  if (extraRequired.length) {
    failures.push(`${tool.name}: keys newly required by zod (legacy left them optional): ${extraRequired.join(', ')}`);
  }

  const legacyProps = propKeys(normLegacy);
  const renderedProps = propKeys(normRendered);
  const missingProps = [...legacyProps].filter((k) => !renderedProps.has(k));
  if (missingProps.length) {
    failures.push(`${tool.name}: properties missing in zod render: ${missingProps.join(', ')}`);
  }
  const extraProps = [...renderedProps].filter((k) => !legacyProps.has(k));
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
