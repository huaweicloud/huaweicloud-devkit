import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { SECRETS_TOOLS } from '../plugins/huaweicloud-core/src/packs/secrets/tools.ts';
import { AUTH_TOOLS } from '../plugins/huaweicloud-core/src/packs/auth/tools.ts';
import { UPDATE_TOOLS } from '../plugins/huaweicloud-core/src/packs/update/tools.ts';
import { HUAWEICLOUD_OPEN_MCP_TOOLS } from '../plugins/huaweicloud-core/src/packs/huaweicloud-open-mcp/tools.ts';
import { checkPackBoundaries } from '../scripts/lib/pack-boundaries.mjs';
import { OBS_TOOLS } from '../plugins/huaweicloud-core/src/packs/obs/tools.ts';
import { TOOL_DEFINITIONS } from '../plugins/huaweicloud-core/src/tools.ts';
import { HUAWEICLOUD_CLI_TOOLS } from '../plugins/huaweicloud-core/src/packs/huaweicloud-cli/tools.ts';
import { DISCOVERY_TOOLS } from '../plugins/huaweicloud-core/src/packs/discovery/tools.ts';
import { PACK_IDS } from '../plugins/huaweicloud-core/src/lib/pack-types.ts';
import { SANDBOX_TOOLS } from '../plugins/huaweicloud-core/src/packs/sandbox/tools.ts';
import { PACKS, PACK_OF } from '../plugins/huaweicloud-core/src/packs/registry.ts';
import { VOUCHER_TOOLS } from '../plugins/huaweicloud-core/src/packs/voucher/tools.ts';
import { pluginRoot, readSource, root } from './structure-helpers.ts';

test('every serviceCatalog route names a skill a pack actually owns', () => {
  // The S-series adoption loop twice shipped a staged tree whose routeMap
  // still pointed at a deleted legacy skill (S5/S6 reviews caught the
  // unstaged-rename class). The routing data lives inline in
  // capability-catalog.ts's serviceCatalog (split out of tools.ts), so the
  // guard scans that source and cross-checks every `skills: ['...']` entry
  // against the pack registry's union.
  const known = new Set(PACKS.flatMap((pack) => pack.skills));
  const source = readSource(join('src', 'capability-catalog.ts'));
  const routed = [...source.matchAll(/skills: \[([^\]]+)\]/g)].flatMap((m) =>
    m[1]!
      .split(',')
      .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean),
  );
  assert.ok(routed.length > 20, `expected a substantive routeMap, found ${routed.length} entries`);
  for (const name of routed) {
    assert.ok(known.has(name), `serviceCatalog routes to "${name}" which no pack owns (stale rename?)`);
  }
});

test('skills resolve from the server-relative tree only (skill-disclosure.ts)', () => {
  // SKILLS_ROOT moved to skill-disclosure.ts in the tools.ts split. The
  // module MUST stay src/ROOT-level: the esbuild bundle flattens every
  // inlined module's import.meta.url to the bundle file's own, so
  // __dirname is dist/ for every module there and the one-level climb
  // resolves to the plugin root in both the tsc tree and the bundle only
  // from a src/ root file (src/ and dist/ are siblings). The pin reads
  // the canonical home and holds tools.ts to the re-export face.
  const disclosure = readSource(join('src', 'skill-disclosure.ts'));
  // SKILLS_ROOT is server data next to dist/ — no agent-native dir probing
  assert.match(disclosure, /const SKILLS_ROOT = join\(__dirname, '\.\.', 'skills'\);/);
  assert.doesNotMatch(disclosure, /function opencodeSkillsDir\(\)/, 'native dir probe must be gone');
  assert.doesNotMatch(disclosure, /findSkillsRoot/, 'multi-root fallback must be gone');
  const tools = readSource(join('src', 'tools.ts'));
  assert.match(
    tools,
    /import \{ SKILLS_ROOT, verifySkillTree, retrieveSkill, listSkills \} from '\.\/skill-disclosure\.ts';/,
    'tools.ts must keep the SKILLS_ROOT import behind its re-export face',
  );
  assert.match(tools, /export \{ SKILLS_ROOT \};/, 'tools.ts must keep the SKILLS_ROOT re-export face');
  // The listing itself lives in the shared zod-free module so the boot
  // guard, doctor, and the --check stray scan hold one membership
  // predicate; tools.ts re-exports it for its existing importers.
  assert.match(tools, /import \{ listSkillDirs \} from '\.\/lib\/skill-tree\.ts';/);
  assert.match(tools, /export \{ listSkillDirs \};/);
  const listing = readSource(join('src', 'lib', 'skill-tree.ts'));
  assert.match(listing, /d\.isDirectory\(\) \|\| d\.isSymbolicLink\(\)/);
  assert.match(listing, /existsSync\(join\(root, d\.name, 'SKILL\.md'\)\)/);
});

test('per-pack modules stay inside the pack boundary allowlist', () => {
  // Same implementation as scripts/validate-package.mjs (second entry):
  // packs import only their own root, src/lib, the core shared whitelist,
  // node:/zod/undici, and type-only edges into core. registry.ts is the
  // composition root and is not scanned.
  const result = checkPackBoundaries({ root });
  assert.deepEqual(result.lines, [], `pack boundary violations:\n${result.lines.join('\n')}`);
});

test('update pack registers version-update tools; registry carries the central dispatch', () => {
  // The update pack (src/packs/update/tools.ts) owns the tool wiring
  // (name/description/schema/handler); since P4 callTool has no per-pack case
  // labels — the PACK_TOOL_HANDLERS merge in packs/registry.ts dispatches
  // every pack tool, satisfies-checked for completeness at compile time.
  // Semantics unchanged: both update tools are registered and wired end to
  // end.
  const packTools = readSource(join('src', 'packs', 'update', 'tools.ts'));
  for (const name of ['huaweicloud_check_update', 'huaweicloud_upgrade']) {
    assert.match(packTools, new RegExp(`name: '${name}'`));
  }
  assert.match(packTools, /from '\.\.\/\.\.\/update-check\.(?:mjs|ts)'/);

  const tools = readSource(join('src', 'tools.ts'));
  for (const name of ['huaweicloud_check_update', 'huaweicloud_upgrade']) {
    assert.doesNotMatch(tools, new RegExp(`case '${name}':`));
  }
  assert.match(tools, /isPackToolName\(name\)/);
  // handlerOpts IS the call opts (the gate's approved binding is threaded
  // onto a copy for roster tools, PR-3b) — the pin is that the handler
  // receives the call's arguments and options, not raw argv.
  assert.match(tools, /PACK_TOOL_HANDLERS\[name\]\(args, handlerOpts\)/);

  // Behavioral lockstep: the pack tool list equals the PACK_OF ownership for
  // 'update'. Descriptions are derived from UPDATE_TOOLS in
  // tool-definitions.ts's packDescription, so no byte-equality pin is needed
  // here anymore.
  const ownedByUpdate = (Object.keys(PACK_OF) as Array<keyof typeof PACK_OF>).filter(
    (tool) => PACK_OF[tool] === 'update',
  );
  assert.deepEqual(
    UPDATE_TOOLS.map((tool) => tool.name).sort((a, b) => a.localeCompare(b)),
    [...ownedByUpdate].sort((a, b) => a.localeCompare(b)),
  );
});

test('eight packs register their tools; the central map dispatches them', () => {
  // Same contract as the update pack, asserted for the packs materialized
  // after P4: sandbox (17 — the async-exec claim protocol added
  // huaweicloud_sandbox_exec_poll, the port-pr6 wave added
  // huaweicloud_sandbox_shutdown, the async-expose wave added
  // huaweicloud_sandbox_expose_poll), auth (6), obs (3), voucher (3),
  // discovery (3), huaweicloud-open-mcp (3), huaweicloud-cli (7), secrets
  // (3). Their handlers reach callTool only through the
  // PACK_TOOL_HANDLERS merge in packs/registry.ts.
  const packs = [
    { id: 'sandbox', tools: SANDBOX_TOOLS, count: 17 },
    { id: 'auth', tools: AUTH_TOOLS, count: 6 },
    { id: 'obs', tools: OBS_TOOLS, count: 3 },
    { id: 'voucher', tools: VOUCHER_TOOLS, count: 3 },
    { id: 'discovery', tools: DISCOVERY_TOOLS, count: 3 },
    { id: 'huaweicloud-open-mcp', tools: HUAWEICLOUD_OPEN_MCP_TOOLS, count: 3 },
    { id: 'huaweicloud-cli', tools: HUAWEICLOUD_CLI_TOOLS, count: 7 },
    { id: 'secrets', tools: SECRETS_TOOLS, count: 3 },
  ];
  const tools = readSource(join('src', 'tools.ts'));
  const registry = readSource(join('src', 'packs', 'registry.ts'));
  for (const { id, tools: packTools, count } of packs) {
    assert.equal(packTools.length, count, `${id} pack tool count`);
    const packSource = readSource(join('src', 'packs', id, 'tools.ts'));
    for (const tool of packTools) {
      assert.match(packSource, new RegExp(`name: '${tool.name}'`));
      assert.doesNotMatch(tools, new RegExp(`case '${tool.name}':`));
    }
    // The pack's handler map is merged into the central dispatch table. The
    // export-name convention maps the pack id to UPPER_SNAKE: hyphens in the
    // id become underscores (huaweicloud-open-mcp →
    // HUAWEICLOUD_OPEN_MCP_TOOL_HANDLERS).
    const exportName = id.toUpperCase().replaceAll('-', '_');
    assert.match(registry, new RegExp(`\\.\\.\\.${exportName}_TOOL_HANDLERS`));
    // Behavioral lockstep: the pack tool list equals the PACK_OF ownership.
    const owned = (Object.keys(PACK_OF) as Array<keyof typeof PACK_OF>).filter((tool) => PACK_OF[tool] === id);
    assert.deepEqual(
      packTools.map((tool) => tool.name).sort((a, b) => a.localeCompare(b)),
      [...owned].sort((a, b) => a.localeCompare(b)),
      `${id} pack tools must match PACK_OF ownership`,
    );
  }
  assert.match(registry, /satisfies Record<PackToolName, PackToolDefinition\['handler'\]>/);
});

test('zod tool schemas match the legacy registry snapshot (deep structural diff)', () => {
  // The legacy JSON-Schema literals are gone; the checked-in snapshot is the
  // authoritative record of the pre-migration contract. scripts/registry-snapshot-diff.mjs
  // re-renders every zod schema and compares required sets, property trees,
  // types, enums, and item schemas against it, failing on any drift.
  assert.ok(
    existsSync(join(root, 'test', 'fixtures', 'legacy-registry-snapshot.json')),
    'legacy registry snapshot fixture is missing',
  );
  const run = spawnSync(process.execPath, [join(root, 'scripts', 'registry-snapshot-diff.mjs')], {
    encoding: 'utf8',
    timeout: 60_000,
  });
  assert.equal(run.status, 0, `registry snapshot diff failed:\n${run.stdout}\n${run.stderr}`);
});

test('SDK migration invariants: setup-cli stays out of the bundled module graph', () => {
  // The framing, keepalive, 406, and hint behaviors are pinned by the
  // process-level suites (mcp-server / remote-mcp-server / dist-bundle);
  // source-regex assertions on them broke on unrelated refactors. The one
  // policy no behavioral test can catch: setup-cli runs from the raw tsc
  // output before any bundling, in agent dirs without SDK node_modules — a
  // single tools/mcp-protocol/SDK import there breaks production installs
  // while every in-repo gate stays green.
  const setup = readSource(join('src', 'setup-cli.ts'));
  assert.doesNotMatch(setup, /@modelcontextprotocol/, 'setup-cli must not import the SDK (unbundled entry)');
  assert.doesNotMatch(setup, /from 'zod'/, 'setup-cli must not import zod (unbundled entry)');
  assert.doesNotMatch(setup, /from '\.\/tools\.ts'/, 'setup-cli must not import tools.ts (pulls the SDK graph)');
  assert.doesNotMatch(
    setup,
    /from '\.\/mcp-protocol\.ts'/,
    'setup-cli must not import mcp-protocol.ts (pulls the SDK graph)',
  );
});

test('pack registry partitions the tool registry and claims every skill directory', () => {
  // Mirrors test/packs-registry.test.ts: every tool lands in exactly one pack,
  // the pack union equals the full TOOL_DEFINITIONS registry, and every
  // skills/ directory is claimed exactly once.
  const allToolNames = TOOL_DEFINITIONS.map((tool) => tool.name).sort((a, b) => a.localeCompare(b));
  const packTools = PACKS.flatMap((pack) => pack.tools);
  const toolClaims = new Set<string>();
  for (const tool of packTools) {
    assert.ok(!toolClaims.has(tool), `tool ${tool} is claimed by more than one pack`);
    toolClaims.add(tool);
  }
  assert.deepEqual(
    [...toolClaims].sort((a, b) => a.localeCompare(b)),
    allToolNames,
  );

  const skillsDirs = readdirSync(join(pluginRoot, 'skills'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
  const skillClaims = new Set<string>();
  for (const pack of PACKS) {
    for (const skill of pack.skills) {
      assert.ok(!skillClaims.has(skill), `skill ${skill} is claimed by more than one pack (${pack.id})`);
      skillClaims.add(skill);
    }
  }
  assert.deepEqual(
    [...skillClaims].sort((a, b) => a.localeCompare(b)),
    skillsDirs,
  );
});

test('pack ids match the registry and the legacy binaries table is gone', () => {
  // PACK_IDS is the installer's zod-free --packs validation list
  // (setup-cli.ts cannot import the zod-dependent registry); it must equal
  // the registry's PACKS ids or --packs would reject valid packs or accept
  // ghosts.
  const registryIds = PACKS.map((pack) => pack.id).sort((a, b) => a.localeCompare(b));
  assert.deepEqual(
    [...PACK_IDS].sort((a, b) => a.localeCompare(b)),
    registryIds,
  );

  // The dependency model absorbed the old PACK_BINARIES / Pack.binaries
  // declaration wave: the binary vocabulary lives only in
  // lib/dependency-model.ts, and no pack manifest re-grows a binaries field.
  const packTypes = readSource(join('src', 'lib', 'pack-types.ts'));
  assert.doesNotMatch(packTypes, /PACK_BINARIES|PackBinary/, 'pack-types must not re-grow the binaries table');
  for (const pack of PACKS) {
    assert.ok(!('binaries' in pack), `${pack.id} declares no binaries field`);
  }
});
