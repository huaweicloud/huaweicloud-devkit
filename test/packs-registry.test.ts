import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import test from 'node:test';

import { TOOL_DEFINITIONS } from '../plugins/huaweicloud-core/src/tools.ts';
import { PACKS, PACK_TOOL_HANDLERS } from '../plugins/huaweicloud-core/src/packs/registry.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const pluginRoot = join(root, 'plugins', 'huaweicloud-core');

// The skills-claim tests below read the generated tree (a build artifact);
// one guided precondition instead of a raw ENOENT on a fresh checkout.
assert.ok(existsSync(join(pluginRoot, 'skills')), 'generated skills tree missing — run: npm run build');

test('no tool name appears in two pack tool lists', () => {
  const owner = new Map<string, string>();
  for (const pack of PACKS) {
    for (const tool of pack.tools) {
      assert.ok(!owner.has(tool), `${tool} is claimed by both ${owner.get(tool)} and ${pack.id}`);
      owner.set(tool, pack.id);
    }
  }
});

test('the pack tool union equals the full TOOL_DEFINITIONS registry', () => {
  const union = [...new Set(PACKS.flatMap((pack) => pack.tools))].sort((a, b) => a.localeCompare(b));
  const all = TOOL_DEFINITIONS.map((tool) => tool.name).sort((a, b) => a.localeCompare(b));
  assert.deepEqual(union, all);
});

test('pack tool counts match the P0 grouping', () => {
  // huaweicloud-cli is a mixed pack: the twenty service skills plus the seven
  // KooCLI execution tools sunk from core.
  const expected = {
    core: 12,
    'huaweicloud-cli': 7,
    sandbox: 11,
    auth: 5,
    obs: 2,
    voucher: 2,
    update: 2,
    discovery: 3,
    'huaweicloud-open-mcp': 3,
    secrets: 3,
  };
  let total = 0;
  for (const pack of PACKS) {
    assert.equal(pack.tools.length, expected[pack.id], `${pack.id} tool count`);
    total += pack.tools.length;
  }
  assert.equal(total, 50);
});

test('the central pack handler map keys equal the pack-owned tool names', () => {
  // PACK_TOOL_HANDLERS is the runtime dispatch table callTool consults for
  // every non-core tool; its satisfies check only guards the missing-key
  // direction at compile time. This pins the extra-key direction too: a key
  // drifting in (or a PACK_OF reassignment without a matching handler move)
  // must fail here, not surface as a silent dead entry or a live mismatch.
  const packOwned = [...new Set(PACKS.flatMap((pack) => (pack.id === 'core' ? [] : pack.tools)))].sort((a, b) =>
    a.localeCompare(b),
  );
  const mapKeys = Object.keys(PACK_TOOL_HANDLERS).sort((a, b) => a.localeCompare(b));
  assert.deepEqual(mapKeys, packOwned);
  assert.equal(mapKeys.length, 38);
});

test('every skills/ directory is claimed by exactly one pack', () => {
  const dirs = readdirSync(join(pluginRoot, 'skills'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
  const claimed = new Set<string>();
  for (const pack of PACKS) {
    for (const skill of pack.skills) {
      assert.ok(!claimed.has(skill), `skill ${skill} is claimed by more than one pack (${pack.id})`);
      claimed.add(skill);
    }
  }
  assert.deepEqual(
    [...claimed].sort((a, b) => a.localeCompare(b)),
    dirs,
  );
});
