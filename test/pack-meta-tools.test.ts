import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';

import { callTool } from '../plugins/huaweicloud-core/src/tools.ts';
import { SCHEMA_DRIFT_IGNORED_KEYS } from '../plugins/huaweicloud-core/src/tool-schemas.ts';
import { createLinkedDevkitServers } from '../plugins/huaweicloud-core/src/mcp-protocol.ts';
import type { PackId } from '../plugins/huaweicloud-core/src/lib/pack-types.ts';

const PACK_IDS: readonly PackId[] = [
  'core',
  'huaweicloud-cli',
  'sandbox',
  'auth',
  'obs',
  'voucher',
  'update',
  'discovery',
  'huaweicloud-open-mcp',
  'secrets',
];

interface ListPacksPayload {
  ok: boolean;
  count: number;
  packs: Array<{
    id: PackId;
    title: string;
    description: string;
    skills: string[];
    tools: string[];
    enabled: boolean;
  }>;
}

interface PackInfoPayload {
  ok: boolean;
  pack: string;
  skills: string[];
  enabled: boolean;
  tools: Array<{ name: string; description: string; schema: Record<string, unknown> }>;
}

interface ListSkillsPayload {
  ok: boolean;
  count: number;
  skills: Array<{ name: string; description: string; pack: PackId; version: string | number; references: string[] }>;
  skillRoot?: string;
}

interface ToolErrorPayload {
  ok: boolean;
  error: string;
}

interface ClientToolResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

test('huaweicloud_list_packs returns all 10 packs, sandbox carries exactly 11 tool names', async () => {
  const result = (await callTool('huaweicloud_list_packs', {})) as ListPacksPayload;
  assert.equal(result.ok, true);
  assert.equal(result.count, 10);
  assert.deepEqual(
    result.packs.map((pack) => pack.id),
    PACK_IDS,
  );
  for (const pack of result.packs) {
    assert.equal(typeof pack.title, 'string');
    assert.equal(typeof pack.description, 'string');
    assert.equal(pack.enabled, true);
    assert.ok(Array.isArray(pack.tools) && pack.tools.length > 0, `${pack.id} must list tools`);
  }
  const cliPack = result.packs.find((pack) => pack.id === 'huaweicloud-cli');
  assert.equal(cliPack!.skills.length, 20);
  assert.ok(cliPack!.skills.includes('huawei-ecs'));
  const sandbox = result.packs.find((pack) => pack.id === 'sandbox');
  assert.equal(sandbox!.tools.length, 11);
  assert.ok(sandbox!.tools.includes('huaweicloud_sandbox_connect'));
});

test('huaweicloud_pack_info returns the 11 sandbox tools with name, description, and schema', async () => {
  const result = (await callTool('huaweicloud_pack_info', { pack: 'sandbox' })) as PackInfoPayload;
  assert.equal(result.ok, true);
  assert.equal(result.pack, 'sandbox');
  assert.deepEqual(result.skills, ['huawei-sandbox']);
  assert.equal(result.enabled, true);
  assert.equal(result.tools.length, 11);
  for (const entry of result.tools) {
    assert.equal(typeof entry.name, 'string');
    assert.ok(entry.name.startsWith('huaweicloud_sandbox_'));
    assert.equal(typeof entry.description, 'string');
    assert.ok(entry.description.length > 0, `${entry.name} description must not be empty`);
    assert.equal(entry.schema.type, 'object');
    assert.equal(entry.schema.$schema, undefined, 'pack_info schema output must be $schema-stripped');
  }
});

// pack_info and list_skills serve the same refusal for an unknown pack id
// (they share the packNotFound helper in tools.ts); one assertion body pins
// both surfaces instead of a parallel test pair.
async function assertBogusPackError(toolName: 'huaweicloud_pack_info' | 'huaweicloud_list_skills'): Promise<void> {
  const result = (await callTool(toolName, { pack: 'bogus' })) as ToolErrorPayload;
  assert.equal(result.ok, false);
  assert.match(result.error, /not found/);
  for (const id of PACK_IDS) {
    assert.match(result.error, new RegExp(`\\b${id}\\b`), `error must list valid id ${id}`);
  }
}

test('huaweicloud_pack_info bogus pack returns an error listing the valid pack ids', async () => {
  await assertBogusPackError('huaweicloud_pack_info');
});

test('huaweicloud_pack_info without a pack id reports it as required', async () => {
  const result = (await callTool('huaweicloud_pack_info', {})) as ToolErrorPayload;
  assert.equal(result.ok, false);
  assert.match(result.error, /required/);
});

// The catalog must carry the full multi-line description, quote-stripped:
// the huawei-ecs frontmatter's second paragraph (HC activity triggers) is
// the exact shape the old single-line regex truncated, and a parse that
// regressed to first-line-only would still pass a mere "non-empty" check.
test('huaweicloud_list_skills catalogs the enabled non-core skills with parsed descriptions', async () => {
  // The seam opts mark the stdio surface: only sessions that carry
  // packs_configure state get skillRoot (the same discrimination listPacks
  // applies to the toggle tool's inventory).
  const result = (await callTool('huaweicloud_list_skills', {}, { onPacksChanged: () => {} })) as ListSkillsPayload;
  assert.equal(result.ok, true);
  assert.equal(result.count, result.skills.length);
  assert.ok(result.count >= 20, 'the five skill-owning packs carry at least 20 skills');
  for (const entry of result.skills) {
    assert.notEqual(entry.pack, 'core', 'core meta-skills are excluded by design');
    assert.ok(entry.name.startsWith('huawei-'), 'every catalogued skill is a pack-owned huawei-* skill');
    assert.ok(entry.description.length > 0, `${entry.name} description must parse non-empty`);
    assert.ok(
      !/^['"]|['"]$/.test(entry.description),
      `${entry.name} description must be quote-stripped (the truncated-bug symptom)`,
    );
    assert.ok(Array.isArray(entry.references), `${entry.name} references must be a filename array`);
  }
  const ecs = result.skills.find((skill) => skill.name === 'huawei-ecs')!;
  assert.ok(ecs, 'huawei-ecs must be catalogued');
  assert.equal(ecs.pack, 'huaweicloud-cli');
  assert.equal(ecs.version, '1');
  assert.equal(ecs.description.startsWith('Use when'), true, 'leading YAML quote must not survive the parse');
  assert.ok(ecs.description.includes('HC活动场景'), 'the multi-line second paragraph must survive the parse');
  assert.deepEqual(ecs.references, [
    'create-instance.md',
    'evs.md',
    'flavors.md',
    'hc-activity.md',
    'troubleshooting.md',
  ]);
  assert.ok(isAbsolute(result.skillRoot ?? ''), 'stdio sessions disclose the tree location as an absolute path');
  assert.ok(
    existsSync(join(result.skillRoot ?? '', 'huawei-ecs', 'SKILL.md')),
    'skillRoot must locate the catalogued tree',
  );
});

test('huaweicloud_list_skills withholds skillRoot on surfaces without session state', async () => {
  // Direct callTool with no opts mirrors the stateless remote's call shape
  // (no onPacksChanged seam): the key itself is withheld — absence is the
  // guard, not a null value — so the list_skills payload on the
  // unauthenticated CORS-* remote never carries the server host's install
  // path.
  const result = (await callTool('huaweicloud_list_skills', {})) as ListSkillsPayload;
  assert.equal(result.ok, true);
  assert.equal('skillRoot' in result, false, 'skillRoot must be absent without the stdio seam');
});

test('huaweicloud_list_skills discloses skillRoot through the real stdio wiring', async () => {
  // End-to-end on the disclosing side, mirroring the remote-face test: a
  // live stdio session constructs the server with runtimePacks, so the
  // registerOne callOpts seam (mcp-protocol) — not a hand-injected opts —
  // must deliver the field. A per-tool rewiring of that construction would
  // otherwise keep every seam-level test green while real sessions lose
  // skillRoot.
  const { server, transport } = await createLinkedDevkitServers({ runtimePacks: true });
  const client = new Client({ name: 'pack-meta-test', version: '0.0.0' });
  try {
    await client.connect(transport);
    const result = (await client.callTool({
      name: 'huaweicloud_list_skills',
      arguments: {},
    })) as ClientToolResult;
    assert.equal(result.isError, false);
    const payload = JSON.parse(result.content[0].text) as { ok: boolean; skillRoot?: string };
    assert.equal(payload.ok, true);
    assert.ok(isAbsolute(payload.skillRoot ?? ''), 'the stdio wiring must deliver an absolute skillRoot');
    assert.ok(
      existsSync(join(payload.skillRoot ?? '', 'huawei-ecs', 'SKILL.md')),
      'skillRoot must locate the catalogued tree',
    );
  } finally {
    await client.close();
    await server.close();
  }
});

test('huaweicloud_list_skills pack filter returns exactly the pack\u2019s skills', async () => {
  const result = (await callTool('huaweicloud_list_skills', { pack: 'obs' })) as ListSkillsPayload;
  assert.equal(result.ok, true);
  assert.equal(result.count, 1);
  assert.deepEqual(
    result.skills.map((skill) => skill.name),
    ['huawei-obs'],
  );
  assert.equal(result.skills[0]!.pack, 'obs');
  assert.ok(result.skills[0]!.description.length > 0, 'huawei-obs description must parse');
});

test('huaweicloud_list_skills on a valid zero-skill pack returns an empty catalog', async () => {
  const result = (await callTool('huaweicloud_list_skills', { pack: 'auth' })) as ListSkillsPayload;
  assert.equal(result.ok, true);
  assert.equal(result.count, 0);
  assert.deepEqual(result.skills, []);
});

test('huaweicloud_list_skills bogus pack returns an error listing the valid pack ids', async () => {
  await assertBogusPackError('huaweicloud_list_skills');
});

test('huaweicloud_list_skills blank pack reports it as required instead of silently listing everything', async () => {
  // pack_info answers the same degenerate input with the same error; a
  // blank filter that silently returns the full catalog would look like a
  // filter that "worked" to a buggy caller.
  const result = (await callTool('huaweicloud_list_skills', { pack: '   ' })) as ToolErrorPayload;
  assert.equal(result.ok, false);
  assert.match(result.error, /required/);
});

test('huaweicloud_list_skills core filter explains the meta-skill exclusion instead of listing nothing', async () => {
  const result = (await callTool('huaweicloud_list_skills', { pack: 'core' })) as ToolErrorPayload;
  assert.equal(result.ok, false);
  assert.match(result.error, /core.*meta-skills|six core meta-skills/);
  assert.match(result.error, /huaweicloud_retrieve_skill/, 'the error must name the portable load path');
});

// The skill-name pattern is the MCP boundary guard for the server-side
// skill loader: traversal-shaped names must be rejected by schema validation
// before the handler ever touches the filesystem. Pinning it at the SDK layer
// (not just the handler re-check) is what keeps tool-schemas.ts honest.
test('retrieve_skill rejects traversal-shaped names at the MCP schema boundary', async () => {
  const { server, transport } = await createLinkedDevkitServers();
  const client = new Client({ name: 'pack-meta-test', version: '0.0.0' });
  try {
    await client.connect(transport);
    const result = (await client.callTool({
      name: 'huaweicloud_retrieve_skill',
      arguments: { name: '../src/packs/obs/skills/huawei-obs' },
    })) as ClientToolResult;
    assert.equal(result.isError, true, 'schema validation must reject the traversal name');
    assert.match(result.content[0].text, /-32602.*pattern|must match pattern/);
  } finally {
    await client.close();
    await server.close();
  }
});

test('pack_info schema output matches the tools/list rendering after stripping ignored keys', async () => {
  // The SDK renders tools/list through its draft-7 layer while pack_info uses
  // z.toJSONSchema (2020-12); SCHEMA_DRIFT_IGNORED_KEYS is the only
  // normalization needed for the two to compare equal.
  const { server, transport } = await createLinkedDevkitServers();
  const client = new Client({ name: 'pack-meta-test', version: '0.0.0' });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    let compared = 0;
    for (const packId of PACK_IDS) {
      const info = (await callTool('huaweicloud_pack_info', { pack: packId })) as PackInfoPayload;
      assert.equal(info.ok, true, `pack_info failed for ${packId}`);
      for (const entry of info.tools) {
        const fromList = listed.tools.find((tool) => tool.name === entry.name);
        assert.ok(fromList, `${entry.name} missing from tools/list`);
        const rendered = structuredClone(fromList.inputSchema);
        for (const key of SCHEMA_DRIFT_IGNORED_KEYS) delete rendered[key];
        assert.deepEqual(entry.schema, rendered, `schema drift between pack_info and tools/list for ${entry.name}`);
        compared++;
      }
    }
    assert.equal(compared, 49, 'every registered tool must be compared');
  } finally {
    await client.close();
    await server.close();
  }
});
