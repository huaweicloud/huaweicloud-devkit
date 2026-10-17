import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import test from 'node:test';

import { TOOL_DEFINITIONS } from '../plugins/huaweicloud-core/src/tools.ts';
import { PACK_OF, PACKS } from '../plugins/huaweicloud-core/src/packs/registry.ts';
import { parseSkillFrontmatter } from '../plugins/huaweicloud-core/src/lib/skill-frontmatter.ts';
import { SUPPORTED_AGENT_TARGETS } from '../plugins/huaweicloud-core/src/auth/agent-registration.ts';
import { PACK_IDS } from '../plugins/huaweicloud-core/src/lib/pack-types.ts';
import {
  closeEnablement,
  DEPENDENCIES,
  DEPENDENCY_IDS,
  parseDevkitPacks,
  PACK_DEPENDENCIES,
  PACK_REQUIRES,
  PACK_USES,
  requiredDependencies,
} from '../plugins/huaweicloud-core/src/lib/dependency-model.ts';
import { UPDATE_TOOLS } from '../plugins/huaweicloud-core/src/packs/update/tools.ts';
import { AUTH_TOOLS } from '../plugins/huaweicloud-core/src/packs/auth/tools.ts';
import { OBS_TOOLS } from '../plugins/huaweicloud-core/src/packs/obs/tools.ts';
import { VOUCHER_TOOLS } from '../plugins/huaweicloud-core/src/packs/voucher/tools.ts';
import { DISCOVERY_TOOLS } from '../plugins/huaweicloud-core/src/packs/discovery/tools.ts';
import { SANDBOX_TOOLS } from '../plugins/huaweicloud-core/src/packs/sandbox/tools.ts';
import { HUAWEICLOUD_OPEN_MCP_TOOLS } from '../plugins/huaweicloud-core/src/packs/huaweicloud-open-mcp/tools.ts';
import { HUAWEICLOUD_CLI_TOOLS } from '../plugins/huaweicloud-core/src/packs/huaweicloud-cli/tools.ts';
import { SECRETS_TOOLS } from '../plugins/huaweicloud-core/src/packs/secrets/tools.ts';
import { checkPackBoundaries } from '../scripts/lib/pack-boundaries.mjs';
import { listSkillDirs } from '../plugins/huaweicloud-core/src/lib/skill-tree.ts';
import { fixtureDir } from './fixture-dir.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const pluginRoot = join(root, 'plugins', 'huaweicloud-core');

// The tree-reading guards below require the generated skills tree. One loud
// precondition instead of a dozen raw ENOENT stack traces when it is absent.
assert.ok(
  existsSync(join(pluginRoot, 'skills')),
  'generated skills tree missing under plugins/huaweicloud-core/ — run: npm run build',
);

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

// Sources are TypeScript; a few call sites still pass legacy .mjs paths.
function readSource(relativePath: string): string {
  const full = join(pluginRoot, relativePath.replace(/\.mjs$/, '.ts'));
  assert.ok(existsSync(full), `source file not found: ${relativePath}`);
  return readFileSync(full, 'utf8');
}

interface PluginManifest {
  name: string;
  mcpServers?: string;
  family?: string;
  bundleFormat?: string;
  interface?: { displayName?: string };
}

interface Marketplace {
  name: string;
  plugins: Array<{ name: string; source: { path: string } }>;
}

interface PackageJson {
  kooCliVersion: string;
  bin?: Record<string, string>;
  scripts: Record<string, string>;
  devDependencies: Record<string, string>;
}

interface JscpdConfig {
  formats: string[];
  ignore: string[];
  reporters: string[];
  threshold?: unknown;
}

interface JscpdBaseline {
  version: number;
  fingerprints: Record<string, unknown>;
}

interface JscpdReport {
  duplicates: Array<{ firstFile: { name: string }; secondFile: { name: string }; format: string }>;
}

interface PackageLock {
  packages: Record<string, { resolved?: string }>;
}

interface SafetyPolicy {
  secretKeyNamePatterns: unknown[];
  writeOperationPrefixes: unknown[];
  blockedSecretOperations: unknown[];
  credentialFilePatterns: unknown[];
}

interface RiskRulesCatalog {
  version: string;
  rules: Array<{
    id: string;
    severity: string;
    stages: string[];
    match: { any?: unknown; all?: unknown };
    message: string;
    remediation: string;
  }>;
}

interface McpConfig {
  mcpServers?: Record<string, { args?: string[] }>;
  mcp?: unknown;
}

interface HooksConfig {
  hooks?: Record<string, Array<{ hooks?: Array<{ command?: string }> }>>;
}

interface IconsManifest {
  icons: Array<{ id: string; name: unknown; logo: { source_url: string } }>;
}

test('Codex plugin manifest and marketplace are installable', () => {
  const manifest = readJson(join(pluginRoot, '.codex-plugin', 'plugin.json')) as PluginManifest;
  assert.equal(manifest.name, 'huaweicloud-devkit');
  // Skills are server data disclosed over MCP; the manifest must not declare
  // a native skills surface (same field-absence discipline as hooks).
  assert.ok(!Object.hasOwn(manifest, 'skills'), 'Codex manifest declares no native skills surface');
  assert.equal(manifest.mcpServers, './.mcp.json');
  assert.ok(!Object.hasOwn(manifest, 'hooks'), 'Codex manifest keeps hooks out');

  const marketplace = readJson(join(root, '.agents', 'plugins', 'marketplace.json')) as Marketplace;
  assert.equal(marketplace.name, 'huaweicloud-devkit');
  assert.equal(marketplace.plugins[0].name, 'huaweicloud-devkit');
  assert.equal(marketplace.plugins[0].source.path, './plugins/huaweicloud-core');
});

test('OpenClaw plugin manifest matches other agent manifests', () => {
  const openclaw = readJson(join(pluginRoot, 'openclaw.plugin.json')) as PluginManifest;
  assert.equal(openclaw.name, 'huaweicloud-devkit');
  assert.equal(openclaw.family, 'bundle-plugin');
  assert.equal(openclaw.bundleFormat, 'codex');
  assert.ok(existsSync(join(pluginRoot, 'openclaw.plugin.json')));

  // All plugin.json names must be consistent
  const manifests = [
    join(pluginRoot, '.codex-plugin', 'plugin.json'),
    join(pluginRoot, '.claude-plugin', 'plugin.json'),
    join(pluginRoot, '.cursor-plugin', 'plugin.json'),
    join(pluginRoot, '.workbuddy-plugin', 'plugin.json'),
    join(pluginRoot, '.hermes-plugin', 'plugin.json'),
    join(pluginRoot, 'openclaw.plugin.json'),
  ];
  const names = new Set(manifests.map((p) => (readJson(p) as PluginManifest).name));
  assert.equal(names.size, 1, 'All plugin.json name fields must be identical');
});

test('OpenCode integration exposes commands and MCP config', () => {
  assert.ok(existsSync(join(root, 'integrations', 'opencode', 'opencode.json')));
  assert.ok(existsSync(join(root, 'integrations', 'opencode', 'commands', 'huaweicloud-doctor.md')));
  // No native OpenCode entry-point skill: MCP tools are the entry point.
  assert.ok(!existsSync(join(root, 'integrations', 'opencode', 'skills')));
});

test('Hermes MCP Catalog manifest is present and valid', () => {
  const manifestPath = join(root, 'integrations', 'hermes', 'manifest.yaml');
  assert.ok(existsSync(manifestPath), 'Missing integrations/hermes/manifest.yaml');

  const yaml = readFileSync(manifestPath, 'utf8');

  assert.match(yaml, /manifest_version:\s*1/);
  assert.match(yaml, /name:\s*huaweicloud-devkit/);
  assert.match(yaml, /transport:/);
  assert.match(yaml, /type:\s*stdio/);
  assert.match(yaml, /command:\s*['"]node['"]/);
  assert.match(yaml, /mcp-server\.js/);
  assert.match(yaml, /install:/);
  assert.match(yaml, /type:\s*git/);
  assert.match(yaml, /huaweicloud\/huaweicloud-devkit/);
  assert.match(yaml, /--target hermes --skip-mcp-server/);
  assert.match(yaml, /post_install:/);
});

test('plugin skills are compact meta-skills instead of service encyclopedia entries', () => {
  const skillsDir = join(pluginRoot, 'skills');
  const skillNames = listSkillDirs(skillsDir);
  const requiredMetaSkills = [
    'huaweicloud-api-and-sdk',
    'huaweicloud-capability-discovery',
    'huaweicloud-cli-and-auth',
    'huaweicloud-core',
    'huaweicloud-safety',
    'huaweicloud-troubleshooting',
  ];
  for (const name of requiredMetaSkills) {
    assert.ok(skillNames.includes(name), `Missing meta-skill: ${name}`);
  }
  assert.ok(skillNames.length >= 6, 'Should have at least 6 skills');

  for (const name of skillNames) {
    const body = readFileSync(join(skillsDir, name, 'SKILL.md'), 'utf8');
    assert.match(body, /^---\r?\nname: /);
    assert.doesNotMatch(body, /TODO|\[TODO/i);
  }
});

// The corpus contract for frontmatter, pinned over every source skill:
// non-empty quote-free description, frontmatter name equal to the
// registry/directory name (the search_docs → retrieve_skill chain), absent
// or numeric version, no unsupported block-scalar marker. The multi-line
// and second-paragraph guarantees are pinned at the consumer level
// (test/pack-meta-tools.test.ts, test/tools.test.ts) — a truncation that
// still yields a clean single line would pass these shape checks.
test('every source SKILL.md description parses non-empty and quote-free', () => {
  for (const pack of PACKS) {
    for (const name of pack.skills) {
      const body = readFileSync(join(pluginRoot, 'src', 'packs', pack.id, 'skills', name, 'SKILL.md'), 'utf8');
      const fm = parseSkillFrontmatter(body);
      assert.ok(fm.description && fm.description.length > 0, `${name} description must parse non-empty`);
      assert.ok(
        !/^['"]|['"]$/.test(fm.description),
        `${name} description must parse quote-stripped (multi-line or quoted frontmatter regressed)`,
      );
      assert.ok(
        !/^[>|]/.test(fm.description),
        `${name} description must not parse to an unsupported block-scalar marker`,
      );
      assert.equal(fm.name, name, `${name} frontmatter name must equal the registry/directory name`);
      assert.ok(fm.version === null || /^\d+(\.\d+)*$/.test(fm.version), `${name} version must be absent or numeric`);
    }
  }
});

test('skills document KooCLI installation, operation discovery, region intent, and password safety', () => {
  const cliSkill = readFileSync(join(pluginRoot, 'skills', 'huaweicloud-cli-and-auth', 'SKILL.md'), 'utf8');
  assert.match(cliSkill, /support\.huaweicloud\.com\/qs-hcli\/hcli_02_003\.html/);
  assert.match(cliSkill, /HCLOUD_BIN/);
  assert.match(cliSkill, /--server\.nics\.1\.subnet_id/);
  assert.match(cliSkill, /--param=value/);

  const discoverySkill = readFileSync(
    join(pluginRoot, 'skills', 'huaweicloud-capability-discovery', 'SKILL.md'),
    'utf8',
  );
  assert.match(discoverySkill, /hcloud <Service> --help/);
  assert.match(discoverySkill, /Singapore.*ap-southeast-3/s);
  assert.match(discoverySkill, /No blind all-region scans/);

  const safetySkill = readFileSync(join(pluginRoot, 'skills', 'huaweicloud-safety', 'SKILL.md'), 'utf8');
  assert.match(safetySkill, /shell history/i);
  assert.match(safetySkill, /huaweicloud_run_approved_command/);

  // Verify KooCLI install URLs match official download URLs
  assert.ok(cliSkill.includes('huaweicloud-cli-windows-amd64.zip'), 'Windows download URL');
  assert.ok(cliSkill.includes('huaweicloud-cli-linux-amd64.tar.gz'), 'Linux download URL');
  assert.ok(cliSkill.includes('huaweicloud-cli-mac-arm64.tar.gz'), 'macOS download URL');

  // Verify KooCLI version pairing: fixed downloads pin cli/<kooCliVersion>, no stale endpoint
  const pkg = readJson(join(root, 'package.json')) as PackageJson;
  const kooCliVersion = pkg.kooCliVersion;
  assert.match(kooCliVersion ?? '', /^\d+\.\d+\.\d+$/, 'package.json declares kooCliVersion');
  assert.ok(cliSkill.includes(`cli/${kooCliVersion}`), `cli-and-auth skill pins cli/${kooCliVersion} download URLs`);
  assert.ok(!cliSkill.includes('hwcloudcli.obs.cn-north-1'), 'no stale hwcloudcli endpoint in cli-and-auth');
});

test('huawei-openapi skill teaches only vocabulary-table tools and the real params layout', async () => {
  // The teaching layer is a consent surface: a gateway tool name the
  // skill mentions but the vocabulary table does not know, or a params
  // layout contradicting the gateway's contract, misroutes real consent
  // (round-9: the wrong body-nesting row burned approvals on silently
  // dropped parameters). Guard the teachable claims mechanically.
  const { GATEWAY_TOOL_VOCABULARY } =
    await import('../plugins/huaweicloud-core/src/packs/huaweicloud-open-mcp/approval.ts');
  const skill = readFileSync(join(pluginRoot, 'skills', 'huawei-openapi', 'SKILL.md'), 'utf8');

  const gatewayTools = [...GATEWAY_TOOL_VOCABULARY.readonly, ...GATEWAY_TOOL_VOCABULARY.routed];
  const known = new Set<string>(gatewayTools);

  // Positive direction first: every vocabulary name is TAUGHT, bare or
  // with the devkit prefix (round-10: '_' is a word character, so the
  // old \b alternation never matched inside the then-existing
  // huaweicloud_search_apis skill mention and four discovery names went
  // unchecked entirely).
  for (const name of gatewayTools) {
    assert.ok(
      skill.includes(name) || skill.includes(`huaweicloud_${name}`),
      `the skill must teach the vocabulary-table tool ${name}`,
    );
  }

  // Reverse sweep: every snake_case token that looks like a gateway tool
  // name (optionally prefixed with the devkit prefix) must be either in
  // the vocabulary table or a declared non-tool identifier. This is the
  // direction that catches hallucinated/renamed names — a hand-written
  // alternation of known names can only ever check itself (round-10's
  // circularity finding).
  const nonToolIdentifiers = new Set([
    'tag_groups',
    'project_id',
    'huaweicloud_gateway_list_tools',
    'huaweicloud_gateway_call',
    'huaweicloud_gateway_restart',
    'huaweicloud_list_packs',
    'huaweicloud_pack_info',
    'huaweicloud_retrieve_skill',
  ]);
  const candidates = new Set(skill.match(/[a-z][a-z0-9]*(_[a-z0-9]+)+/g) ?? []);
  for (const token of candidates) {
    const bare = token.startsWith('huaweicloud_') ? token.slice('huaweicloud_'.length) : token;
    if (nonToolIdentifiers.has(token)) continue;
    if (known.has(bare)) continue;
    // Multi-word prose identifiers that are not tool-shaped are allowed;
    // tool-shaped means matching a routed/readonly name OR carrying the
    // devkit prefix. Anything else with 2+ underscores and a gateway-ish
    // verb is suspicious, but the strict rule is: devkit-prefixed tokens
    // must resolve to real devkit tools.
    if (token.startsWith('huaweicloud_')) {
      assert.ok(
        TOOL_DEFINITIONS.some((tool) => tool.name === token),
        `the skill references devkit tool ${token}, which does not exist`,
      );
    }
  }

  // The params contract (gateway server.py: path/query flatten into
  // params, body in params["body"]). Word boundary, not [^.]: the flat
  // spelling must be unteachable even at end-of-sentence (round-10:
  // 'toolArgs.body.' evaded the sentinel).
  assert.match(skill, /toolArgs\.params\.body/);
  assert.doesNotMatch(skill, /toolArgs\.body\b/, 'the flat toolArgs.body spelling taught wrong nesting (round-9)');
  // The contract row is scoped to execute_api (round-10: discovery tools
  // take top-level named args — an unscoped row misleads search calls).
  assert.match(skill, /For `execute_api`, path and query parameters flatten into `toolArgs\.params`/);

  // The delegated approval contract: the skill must teach the delegation
  // flow (engine refuses → its reason guides → confirm → grant with an
  // ephemeral scope → retry) and must not resurrect the retired token
  // ceremony. gatewayCallSchema is a loose object, so a stale field name
  // in the teaching layer would silently round-trip as an ignored extra
  // while an agent believes it is consenting.
  assert.match(skill, /delegated to the gateway's own policy engine/, 'the consent authority is named');
  assert.match(skill, /confirm with the user in conversation/, 'the refusal-guided consent flow is taught');
  assert.match(skill, /ephemeral scope/, 'the grant scope vocabulary is taught');
  assert.doesNotMatch(skill, /approvalToken/, 'the retired approvalToken field must not be taught');
  assert.doesNotMatch(skill, /approvedByUser/, 'the retired approvedByUser field must not be taught');
  assert.doesNotMatch(skill, /HUAWEICLOUD_OPENMCP_APPROVAL/, 'the retired mode env must not be taught');

  // Cross-references resolve to real skills — form-agnostic (See/see/load)
  // and across the whole generated tree, not just this file (round-10:
  // this commit's own capability-discovery ref used lowercase 'see' and
  // evaded the original resolver).
  for (const skillDir of listSkillDirsAll()) {
    const skillText = readFileSync(join(skillDir, 'SKILL.md'), 'utf8');
    for (const ref of skillText.matchAll(/(?:[Ss]ee|load) `([a-z0-9-]+)`/g)) {
      assert.ok(
        existsSync(join(pluginRoot, 'skills', ref[1], 'SKILL.md')),
        `${skillDir} cross-references ${ref[1]}, which does not resolve to a real skill`,
      );
    }
  }
});

// The served gateway_call description (derived from
// HUAWEICLOUD_OPEN_MCP_TOOLS in src/tools.ts — descriptions have one copy,
// in the owning pack) is the surviving zero-cost name-discovery
// path at the tools/list layer now that the six first-class discovery
// faces are gone. Literal fragments, not bare substring names: 'get_api'
// alone is satisfied by the 'get_api_examples' substring — the same
// word-character blind spot round-10 recorded for \b alternations.
test('the served gateway_call description teaches the readonly discovery surface', async () => {
  const { GATEWAY_TOOL_VOCABULARY } =
    await import('../plugins/huaweicloud-core/src/packs/huaweicloud-open-mcp/approval.ts');
  const gatewayCall = TOOL_DEFINITIONS.find((tool) => tool.name === 'huaweicloud_gateway_call');
  assert.ok(gatewayCall, 'huaweicloud_gateway_call must exist in TOOL_DEFINITIONS');
  const description = gatewayCall.description;

  // One literal teaching fragment per readonly tool: the name plus the
  // opening of its parameter list, carried far enough to pin the
  // load-bearing parameters (include_sops — dropped once during
  // absorption and undiscoverable anywhere else, so the fragments own it
  // now). A dropped tool, a renamed tool, or a lost parameter fails here.
  const fragments = [
    'search_apis (query',
    'list_products (optional',
    'get_product (product; optional include_sops',
    'list_apis (product; optional tag/search/limit/offset/include_sops',
    'get_api (product, api',
    'get_api_examples (product, api',
  ];
  for (const fragment of fragments) {
    assert.ok(
      description.includes(fragment),
      `the served gateway_call description must teach the literal fragment "${fragment}"`,
    );
  }
  // The fragment set and the vocabulary table must not drift apart: a
  // vocabulary rename with a stale fragment list (or vice versa) fails
  // here rather than silently pinning the old names.
  const fragmentNames = fragments.map((fragment) => fragment.split(' ')[0]);
  assert.deepEqual(
    [...fragmentNames].sort((a, b) => a.localeCompare(b)),
    [...GATEWAY_TOOL_VOCABULARY.readonly].sort((a, b) => a.localeCompare(b)),
  );

  // The chain sentence itself, not positions derived from indexOf: the
  // round-10-style substring blind spot made the old positional check
  // pass even with the standalone get_api entry deleted.
  assert.match(
    description,
    /Discovery chain: search_apis → list_apis → get_api → get_api_examples/,
    'the description teaches the discovery chain sentence verbatim',
  );
});

function listSkillDirsAll(): string[] {
  const skillsDir = join(pluginRoot, 'skills');
  return listSkillDirs(skillsDir).map((name) => join(skillsDir, name));
}

test('skill SKILL.md files meet minimum content quality bar', () => {
  const skillsDir = join(pluginRoot, 'skills');
  const skillNames = listSkillDirs(skillsDir);

  const exceptions = new Set([
    'huaweicloud-api-and-sdk',
    'huaweicloud-safety',
    'huaweicloud-troubleshooting',
    'huawei-deployment',
    'huawei-getting-started',
    'huawei-apig',
    'huawei-gaussdb',
  ]);

  for (const name of skillNames) {
    const body = readFileSync(join(skillsDir, name, 'SKILL.md'), 'utf8');
    const lines = body.split('\n').length;
    if (exceptions.has(name)) continue;
    assert.ok(lines >= 40, `${name}/SKILL.md has ${lines} lines (min 40)`);
  }
});

test('huawei-deployment skill uses verified KooCLI service and operation names', () => {
  const body = readFileSync(join(pluginRoot, 'skills', 'huawei-deployment', 'SKILL.md'), 'utf8');
  assert.match(body, /CodeArtsDeploy/);
  assert.match(body, /StartDeployTask/);
  assert.match(body, /ListAllApp/);
  assert.match(body, /DeleteDeployTask/);
  assert.match(body, /Deploy\.00016902/);
  assert.match(body, /APIGW\.0301/);
  assert.match(body, /--app_id/);
  assert.match(body, /DeleteApplication/);
  assert.match(body, /deprecated since 2024-09-30/);
  assert.doesNotMatch(body, /--application_id/);
  assert.doesNotMatch(body, /\bStartTask\b/);
  assert.doesNotMatch(body, /\bListTasks\b/);
  assert.doesNotMatch(body, /\bCreateTask\b/);
  assert.doesNotMatch(body, /\bDeleteTask\b/);
});

test('skills with references have non-empty reference files', () => {
  const skillsDir = join(pluginRoot, 'skills');
  const skillNames = listSkillDirs(skillsDir);

  for (const name of skillNames) {
    const refDir = join(skillsDir, name, 'references');
    if (!existsSync(refDir)) continue;
    const refFiles = readdirSync(refDir).filter((f) => f.endsWith('.md'));
    for (const ref of refFiles) {
      const body = readFileSync(join(refDir, ref), 'utf8');
      const lines = body.split('\n').length;
      assert.ok(lines >= 10, `${name}/references/${ref} has ${lines} lines (min 10)`);
    }
  }
});

test('web/static-site deployment intent offers target options with sandbox first, not OBS default', () => {
  const core = readFileSync(join(pluginRoot, 'skills', 'huaweicloud-core', 'SKILL.md'), 'utf8');
  assert.match(core, /Deployment Target Options/);
  assert.match(core, /Sandbox \(DevStation\) — recommended/);
  assert.match(core, /NEVER default to a single service such as OBS/);

  const obs = readFileSync(join(pluginRoot, 'src', 'packs', 'obs', 'skills', 'huawei-obs', 'SKILL.md'), 'utf8');
  assert.match(obs, /Routing Guard: Deploy vs Store/);
  assert.match(obs, /do NOT default to OBS/);
  assert.match(obs, /① huawei-sandbox \(recommended\)/);

  const sandbox = readFileSync(
    join(pluginRoot, 'src', 'packs', 'sandbox', 'skills', 'huawei-sandbox', 'SKILL.md'),
    'utf8',
  );
  assert.match(sandbox, /present options, sandbox first/i);
  assert.match(sandbox, /建议优先部署到沙箱/);

  const discovery = readFileSync(join(pluginRoot, 'skills', 'huaweicloud-capability-discovery', 'SKILL.md'), 'utf8');
  assert.match(discovery, /Deployment Target Options/);
  assert.match(discovery, /do NOT default to OBS/);
});

test('core meta-skills teach the skillRoot direct-read path alongside retrieve_skill', () => {
  // The dual-path contract: list_skills discloses the tree's location on
  // stdio sessions, and both routing skills must teach the direct read as
  // an alternative to the portable loader. The references/ assertion is
  // co-occurrence-anchored (same line as skillRoot) so it pins the teaching
  // line, not the pre-existing step-2 "Read references/{sub-skill-id}.md".
  // New SKILL.md copy must keep avoiding see/load followed by a backticked
  // non-skill identifier — the cross-reference guard resolves those against
  // the skills tree.
  const core = readFileSync(join(pluginRoot, 'skills', 'huaweicloud-core', 'SKILL.md'), 'utf8');
  assert.match(core, /skillRoot/, 'huaweicloud-core must teach the skillRoot direct-read path');
  assert.match(
    core,
    /skillRoot[^\n]*references\//,
    'the direct-read line must name the references directory beside skillRoot',
  );

  const discovery = readFileSync(join(pluginRoot, 'skills', 'huaweicloud-capability-discovery', 'SKILL.md'), 'utf8');
  assert.match(discovery, /skillRoot/, 'huaweicloud-capability-discovery must teach the skillRoot direct-read path');
  assert.match(
    discovery,
    /skillRoot[^\n]*references\//,
    'the discovery teaching line must name the references directory beside skillRoot',
  );
});

test('retrieve_skill reference cap stays in sync between code and description', () => {
  // The description teaches "each reference body capped at 4000 characters";
  // this pins the taught number to the truncation constant so neither can
  // drift silently (the repo's own description-literal pinning pattern).
  const tools = readSource(join('src', 'tools.ts'));
  const cap = tools.match(/\.substring\(0, (\d+)\) \}\)/)?.[1];
  assert.ok(cap, 'the reference truncation constant must be found');
  assert.match(
    tools,
    new RegExp(`capped at ${cap} characters`),
    'the retrieve_skill description must teach the actual reference cap',
  );
});

test('telemetry hooks never classify skill-tool loads', () => {
  // Doctrine guard: the telemetry hooks shed skill-load classification
  // deliberately (native loads produce no telemetry by design, and the
  // huawei* prefix match misattributes user skills). Two review rounds
  // caught drift in this family one file at a time; this sweep pins every
  // hook-events.jsonl emitter together — the five platform hooks plus the
  // plugin-dir safety hook — so a bad merge cannot quietly re-add the
  // branch anywhere.
  const integrations = join(root, 'integrations');
  const hookFiles = [
    join(integrations, 'opencode', 'hooks', 'skill-tracker.js'),
    join(integrations, 'workbuddy', 'hooks', 'telemetry-tracker.py'),
    join(integrations, 'hermes', 'hooks', 'huaweicloud-telemetry.py'),
    join(integrations, 'atomcode', 'hooks', 'huaweicloud-telemetry.js'),
    join(integrations, 'dsh', 'hook-plugin.mjs'),
    join(pluginRoot, 'hooks', 'huaweicloud-safety.py'),
  ];
  for (const file of hookFiles) {
    assert.ok(existsSync(file), `hook file ${file} must exist`);
    const body = readFileSync(file, 'utf8');
    assert.doesNotMatch(
      body,
      /skill:retrieve|isHuaweiCloudSkill|extractSkillName/,
      `${file} must not classify skill-tool loads (server data doctrine)`,
    );
  }
});

test('devbridge uses the valid `list` command, not the non-existent `ls`', () => {
  const sandbox = readFileSync(
    join(pluginRoot, 'src', 'packs', 'sandbox', 'skills', 'huawei-sandbox', 'SKILL.md'),
    'utf8',
  );
  const sessionManager = readSource(join('src', 'sandbox', 'session-manager.ts'));

  assert.doesNotMatch(sandbox, /devbridge ls\b/);
  assert.match(sandbox, /devbridge list\b/);

  assert.doesNotMatch(sessionManager, /devbridge ls\b/);
  assert.match(sessionManager, /devbridge list -j/);
});

test('huawei-sandbox skill documents devbridge description and host/connect traps', () => {
  const body = readFileSync(
    join(pluginRoot, 'src', 'packs', 'sandbox', 'skills', 'huawei-sandbox', 'SKILL.md'),
    'utf8',
  );
  assert.match(body, /only Chinese characters, digits, letters/);
  assert.match(body, /Connection failed, retrying/);
  assert.match(body, /devbridge host/);
  assert.match(body, /expose_via_devbridge/);
});

test('devbridge tunnel handling is migrated to the s2 gateway domain', () => {
  const sandbox = readFileSync(
    join(pluginRoot, 'src', 'packs', 'sandbox', 'skills', 'huawei-sandbox', 'SKILL.md'),
    'utf8',
  );
  const sessionManager = readSource(join('src', 'sandbox', 'session-manager.ts'));

  // Code must construct tunnel URLs exclusively from the s2 gateway domain.
  // The guard must also catch regex-literal occurrences where dots are escaped
  // (`cn-north-4-bridge\.myhuaweicloud\.com`) — plain dot matching is blind to those.
  assert.match(sessionManager, /devbridge-s2\.hwtunnel\.com/);
  assert.doesNotMatch(sessionManager, /cn-north-4-bridge\\?\.myhuaweicloud\\?\.com/);

  // A migrated gateway serves a placeholder page with HTTP 200 — the check must inspect the body.
  assert.match(sessionManager, /服务已迁移/);

  // The skill must teach the new URL form and the dead legacy form.
  assert.match(sandbox, /devbridge-s2\.hwtunnel\.com/);
  assert.doesNotMatch(sandbox, /https:\/\/<id>-<port>\.cn-north-4-bridge\.myhuaweicloud\.com/);
});

test('devbridge 0.2.x flow: auth capability probe, version detection, in-place upgrade guidance', () => {
  const sandbox = readFileSync(
    join(pluginRoot, 'src', 'packs', 'sandbox', 'skills', 'huawei-sandbox', 'SKILL.md'),
    'utf8',
  );
  // The credentials tool handler moved to the sandbox pack
  // (src/packs/sandbox/tools.ts) with the P2 pack program.
  const sandboxPack = readSource(join('src', 'packs', 'sandbox', 'tools.ts'));

  // SKILL.md must never teach the removed 0.1.x login flow (--huaweicloud SSO flag is
  // gone from every 0.2.x build), and the obsolete warning row must stay gone.
  assert.doesNotMatch(sandbox, /auth login --huaweicloud/);
  assert.doesNotMatch(sandbox, /Login needs --huaweicloud/);
  assert.match(sandbox, /Never expose tunnel details/);

  // Auth must be decided by probing the binary's capability, not by the version string —
  // image builds retain AK/SK (auto), release builds accept only API Key.
  assert.match(sandbox, /auth login --help 2>&1 \| grep -q -- '--access-key'/);
  assert.match(sandbox, /AUTH_MODE=AKSK_SUPPORTED/);
  assert.match(sandbox, /AUTH_MODE=API_KEY_ONLY/);
  assert.match(
    sandbox,
    /auth login --access-key "\$HW_ACCESS_KEY" --secret-key "\$HW_SECRET_KEY"/,
    'image-build branch must teach the direct AK/SK login',
  );

  // The API Key guidance (release-build branch) must survive, incl. version detection
  // and the in-place upgrade.
  assert.match(sandbox, /auth login --api-key "\$HW_API_KEY"/);
  assert.match(sandbox, /devbridge version/);
  assert.match(sandbox, /devbridge-install\.sh -s/);
  assert.match(sandbox, /devstation\.connect\.huaweicloud\.com\/space\/devbridge\/apikey/);
  assert.match(sandbox, /HW_API_KEY/);

  // The credentials tool must support injecting the DevBridge API Key:
  // - env-first precedence (keeps the long-lived key out of the conversation)
  // - separate storage from the temporary AK/SK (/tmp/hw_api_key vs /tmp/hw_creds.sh)
  assert.match(sandboxPack, /api_key/);
  assert.match(sandboxPack, /process\.env\.HW_API_KEY \|\| args\.api_key/);
  assert.match(sandboxPack, /\/tmp\/hw_api_key/);
  assert.match(sandbox, /\/tmp\/hw_api_key/);

  // The API Key must NOT be written into the shared AK/SK creds script.
  const credsWrite = sandboxPack.match(/const credsScript = \[[\s\S]*?\]/);
  assert.ok(credsWrite, 'credsScript block not found in packs/sandbox/tools.ts');
  assert.doesNotMatch(credsWrite[0], /HW_API_KEY/);

  // The CodeArts Doer sidecopy must mirror the probe-branch flow and not regress
  // to the removed 0.1.x flow either. .codeartsdoer is a gitignored install
  // copy (never tracked), so a clean checkout has no sidecopy to check.
  const sidecopyPath = join(root, '.codeartsdoer', 'skills', 'huawei-sandbox', 'SKILL.md');
  if (existsSync(sidecopyPath)) {
    const sidecopy = readFileSync(sidecopyPath, 'utf8');
    assert.doesNotMatch(sidecopy, /auth login --huaweicloud/);
    assert.doesNotMatch(sidecopy, /res-hd\.hc-cdn\.cn/);
    assert.doesNotMatch(sidecopy, /devbridge ls\b/);
    assert.doesNotMatch(sidecopy, /https:\/\/<id>-<port>\.cn-north-4-bridge/);
    assert.match(sidecopy, /auth login --help 2>&1 \| grep -q -- '--access-key'/);
    assert.match(sidecopy, /AUTH_MODE=AKSK_SUPPORTED/);
    assert.match(sidecopy, /AUTH_MODE=API_KEY_ONLY/);
    assert.match(sidecopy, /auth login --api-key "\$HW_API_KEY"/);
    assert.match(sidecopy, /devbridge-s2\.hwtunnel\.com/);
    assert.match(sidecopy, /\/tmp\/hw_api_key/);
  }
});

test('all plugin manifests are valid JSON', () => {
  const manifests = [
    join(pluginRoot, '.codex-plugin', 'plugin.json'),
    join(pluginRoot, '.claude-plugin', 'plugin.json'),
    join(pluginRoot, '.cursor-plugin', 'plugin.json'),
    join(pluginRoot, '.workbuddy-plugin', 'plugin.json'),
    join(pluginRoot, '.hermes-plugin', 'plugin.json'),
    // bundleFormat codex: the same manifest-declared surface class the codex
    // ban protects. Native core disclosure goes through directory loading,
    // never through a manifest skills field.
    join(pluginRoot, 'openclaw.plugin.json'),
  ];
  for (const path of manifests) {
    const data = readJson(path) as PluginManifest;
    assert.ok(data.name, `Manifest ${path} missing name`);
    if (path.endsWith('openclaw.plugin.json')) continue;
    assert.ok(data.interface, `Manifest ${path} missing interface`);
    // No manifest may declare a native skills surface: skills are server
    // data disclosed through the MCP tools (the core meta-skills' native
    // copies are placed by the installer, not declared here).
    assert.ok(!Object.hasOwn(data, 'skills'), `Manifest ${path} must not declare skills`);
  }
  const openclaw = readJson(join(pluginRoot, 'openclaw.plugin.json')) as PluginManifest;
  assert.ok(!Object.hasOwn(openclaw, 'skills'), 'openclaw.plugin.json must not declare skills');
});

test('safety policy.json is valid and has required fields', () => {
  const policy = readJson(join(pluginRoot, 'safety', 'policy.json')) as SafetyPolicy;
  assert.ok(Array.isArray(policy.secretKeyNamePatterns));
  assert.ok(policy.secretKeyNamePatterns.length >= 5);
  assert.ok(Array.isArray(policy.writeOperationPrefixes));
  assert.ok(policy.writeOperationPrefixes.length >= 10);
  assert.ok(Array.isArray(policy.blockedSecretOperations));
  assert.ok(Array.isArray(policy.credentialFilePatterns));
});

test('cloud risk rules are present and public-safe', () => {
  const rulesPath = join(pluginRoot, 'safety', 'rules', 'cloud-risk-rules.json');
  assert.ok(existsSync(rulesPath), 'Missing cloud-risk-rules.json');

  const catalog = readJson(rulesPath) as RiskRulesCatalog;
  assert.equal(catalog.version, '0.1.0');
  assert.ok(Array.isArray(catalog.rules), 'rules must be an array');
  assert.ok(catalog.rules.length >= 9, 'Expected baseline cloud risk rules');

  const ids = new Set();
  const allowedSeverities = new Set(['deny', 'warn', 'info']);
  const allowedStages = new Set(['command', 'artifact', 'deploy_plan']);
  for (const rule of catalog.rules) {
    assert.match(rule.id, /^hwc-[a-z0-9-]+$/, `Invalid rule id: ${rule.id}`);
    assert.ok(!ids.has(rule.id), `Duplicate rule id: ${rule.id}`);
    ids.add(rule.id);
    assert.ok(allowedSeverities.has(rule.severity), `${rule.id} has invalid severity`);
    assert.ok(Array.isArray(rule.stages) && rule.stages.length > 0, `${rule.id} missing stages`);
    for (const stage of rule.stages) {
      assert.ok(allowedStages.has(stage), `${rule.id} has invalid stage: ${stage}`);
    }
    assert.ok(rule.match && (rule.match.any || rule.match.all), `${rule.id} needs match conditions`);
    assert.ok(rule.message && rule.remediation, `${rule.id} needs message and remediation`);
    assert.doesNotMatch(JSON.stringify(rule), /\baccountId\b|\bticketId\b|\brawText\b|\binternalSource\b/i);
  }
});

test('hooks.json uses Node hook and keeps Python hook for Hermes compatibility', () => {
  const hooksDir = join(pluginRoot, 'hooks');
  const hooksJsonPath = join(hooksDir, 'hooks.json');
  assert.ok(existsSync(hooksJsonPath));
  assert.ok(existsSync(join(hooksDir, 'huaweicloud-safety.mjs')));
  assert.ok(existsSync(join(hooksDir, 'huaweicloud-safety.py')));

  const hooksJson = readFileSync(hooksJsonPath, 'utf8');
  assert.match(hooksJson, /\bnode\b/);
  assert.match(hooksJson, /huaweicloud-safety\.mjs/);
  assert.doesNotMatch(hooksJson, /\bpython3?\b/);
});

test('hook rule model documentation exists', () => {
  const doc = join(root, 'docs', 'hook-rule-model.md');
  assert.ok(existsSync(doc), 'Missing docs/hook-rule-model.md');
  const body = readFileSync(doc, 'utf8');
  assert.match(body, /Hook 规则模型/);
  assert.match(body, /隐私边界/);
  assert.match(body, /huaweicloud_hook_check_command/);
});

test('safety skill teaches proactive hook checks', () => {
  const safetySkill = readFileSync(join(pluginRoot, 'skills', 'huaweicloud-safety', 'SKILL.md'), 'utf8');
  assert.match(safetySkill, /huaweicloud_hook_check_command/);
  assert.match(safetySkill, /huaweicloud_hook_check_artifacts/);
  assert.match(safetySkill, /huaweicloud_hook_check_deploy_plan/);
});

test('.mcp.json is valid and references existing server script', () => {
  const mcpConfig = readJson(join(pluginRoot, '.mcp.json')) as McpConfig;
  assert.ok(mcpConfig.mcpServers || mcpConfig.mcp);
});

test('setup-cli.ts supports the codearts target end to end', () => {
  const setup = readSource(join('src', 'setup-cli.ts'));
  // parseTarget accepts codearts
  assert.match(setup, /'codearts'/);
  // install / uninstall / status functions exist
  assert.match(setup, /async function installCodeArts\(\)/);
  assert.match(setup, /function uninstallCodeArts\(\)/);
  assert.match(setup, /function codeartsStatus\(\)/);
  // path helpers for user-level and project-level codearts dirs
  assert.match(setup, /function codeartsSkillsDir\(\)/);
  assert.match(setup, /function codeartsMcpSettingsFile\(\)/);
  assert.match(setup, /function codeartsProjectSkillsDir\(\)/);
  assert.match(setup, /function codeartsProjectMcpSettingsFile\(\)/);
  assert.match(setup, /function codeartsPluginsDir\(\)/);
  // install ships the server payload (dist + safety + skills server data)
  // into the codearts plugin dir and registers both MCP configs
  assert.match(setup, /async function installCodeArts\(\): Promise<void> \{\s*\n\s*const pluginSrc/);
  assert.match(setup, /copyServerPayload\(pluginDest\)/);
  assert.match(setup, /registerCodeartsMcp\(codeartsMcpSettingsFile\(\)\)/);
  assert.match(setup, /registerCodeartsMcp\(codeartsProjectMcpSettingsFile\(\)\)/);
  // MCP registration writes an enabled server with local mode env
  assert.match(setup, /config\.mcpServers\['huaweicloud-devkit'\] = \{/);
  assert.match(setup, /HUAWEICLOUD_AGENT_TOOLKIT_MODE: 'local'/);
  assert.match(setup, /entry\.enabled = true;/);
  // command dispatch covers codearts for install / uninstall / status
  const branches = setup.match(/target === 'codearts' \|\| target === 'all'/g);
  const installDispatch = setup.match(/shouldInstall\('codearts'\)/g);
  assert.ok(
    (branches?.length ?? 0) + (installDispatch?.length ?? 0) >= 3,
    `codearts dispatch branches: ${(branches?.length ?? 0) + (installDispatch?.length ?? 0)}`,
  );
  // .installed marker goes to the codearts plugins dir:
  // installMarkerDirForTarget is a PAYLOAD_TARGETS lookup (its own test pins
  // the derivation, every non-codex row, and codex's natural null).
  assert.match(setup, /function installMarkerDirForTarget\(target: string\)/);
  assert.match(setup, /function writeInstallMarker\(target: string\)/);
  // doctor checks the skills tree inside installed plugin dirs, and native
  // skill dirs only for stale-copy detection. The tree check is set
  // equality against the shipped manifest (both directions — an extra dir
  // is as disqualifying as a missing one), and doctor's listing is the
  // shared SKILL.md-aware predicate from src/lib/skill-tree.ts — the same
  // membership the boot guard uses, so hollow claimed dirs count as
  // missing. The DSH package-root candidate is PLUGIN_ROOT itself because
  // serverSkillDirNames() appends 'skills'.
  assert.match(setup, /return listSkillDirs\(join\(pluginDir, 'skills'\)\);/);
  assert.match(setup, /const expectedSkills = shippedSkillRoster\(\);/);
  assert.match(setup, /present\.size === expectedSkills\.length/);
  assert.match(setup, /expectedSkills\.every\(\(name\) => present\.has\(name\)\)/);
  assert.match(setup, /skillsTreeDirs\.push\(PLUGIN_ROOT\)/);
  assert.doesNotMatch(setup, /serverSkillCount\(dir\) >= 6/, 'count-floor doctor check must be gone');
  // doctor's native-dir check is the receipt-gated one: core names warn only
  // outside a dir a sync row manages, and a manifest without pack info warns
  // instead of crashing the diagnostic run.
  assert.match(setup, /function tryCoreSkillNames\(\)/);
  assert.match(setup, /const corePack = tryCoreSkillNames\(\);/);
  assert.match(setup, /managedHere && corePack\.has\(entry\.name\)/);
  // The byte-equality comparator lives in the shared zod-free lib (doctor
  // and the install tests import the same one), not as a setup-cli local.
  assert.match(setup, /import \{ listSkillDirs, skillTreeEquals \} from '\.\/lib\/skill-tree\.ts';/);
  const skillTreeSrc = readSource(join('src', 'lib', 'skill-tree.ts'));
  assert.match(skillTreeSrc, /export function skillTreeEquals\(a: string, b: string\): boolean/);
  // help text documents the target
  assert.match(
    setup,
    /--target <opencode\|codex\|codearts\|codearts-work\|workbuddy\|dsh\|officeace\|hermes\|openclaw\|atomcode\|all>/,
  );
  assert.match(setup, /install --target codearts/);
});

// The native-disclosure wiring must stay table-driven: the cleanup/doctor
// scan list derives from the PAYLOAD_TARGETS nativeSkills rows (no second
// hand-maintained dir list), officeace stays the one explicit foreign
// detector, and the two deliberately native-copy-free rows keep absent
// nativeSkills fields.
test('nativeSkillDirs derives from PAYLOAD_TARGETS plus the officeace exception', () => {
  const setup = readSource(join('src', 'setup-cli.ts'));
  const listBody = setup.match(/function nativeSkillDirs\(\): string\[\] \{([\s\S]*?)\n\}/)?.[1] ?? '';
  assert.ok(listBody.length > 0, 'nativeSkillDirs must exist');
  assert.match(listBody, /PAYLOAD_TARGETS\.flatMap/, 'the scan list derives from the table');
  assert.match(listBody, /officeaceSkillsDir\(\)/, 'officeace stays the explicit foreign detector');
  assert.doesNotMatch(listBody, /opencodeSkillsDir\(\)/, 'no hand-listed row dirs remain');
  const officeaceRow = setup.match(/\{\s*id: 'officeace',[\s\S]*?\n {2}\},/)?.[0] ?? '';
  assert.ok(officeaceRow.length > 0, 'officeace row found');
  assert.doesNotMatch(officeaceRow, /nativeSkills/, 'officeace stays without native skill copies');
  const codexDesktopRow = setup.match(/\{\s*id: 'codex-desktop',[\s\S]*?\n {2}\},/)?.[0] ?? '';
  assert.ok(codexDesktopRow.length > 0, 'codex-desktop row found');
  assert.doesNotMatch(codexDesktopRow, /nativeSkills/, 'codex-desktop stays without native skill copies');
});

// opencode reads its config from XDG_CONFIG_HOME (default ~/.config). The
// installer's write root, the registration read, and the agent-presence
// probe must all derive from ONE shared resolver — three independent
// derivations is how "install green, agent blind" under a non-default
// XDG_CONFIG_HOME happened (each seam fixed separately drifted back).
test('opencode config root is XDG-aware through one shared resolver', () => {
  const setup = readSource(join('src', 'setup-cli.ts'));
  const registration = readSource(join('src', 'auth', 'agent-registration.ts'));
  assert.match(
    registration,
    /export function xdgConfigHome\(\): string/,
    'the shared XDG root resolver must live in agent-registration.ts',
  );
  // The resolver honors absolute XDG_CONFIG_HOME only (spec: relative ignored).
  const resolverBody = registration.match(/export function xdgConfigHome\(\): string \{[\s\S]*?\n\}/)?.[0] ?? '';
  assert.ok(resolverBody.length > 0, 'xdgConfigHome body found');
  assert.match(resolverBody, /isAbsolute/);
  // Registration detection reads the shared root, not its own derivation.
  const registrationConfigFile =
    registration.match(/function opencodeConfigFile\(\): string \{[\s\S]*?\n\}/)?.[0] ?? '';
  assert.ok(registrationConfigFile.length > 0, 'agent-registration opencodeConfigFile found');
  assert.match(registrationConfigFile, /xdgConfigHome\(\)/);
  assert.doesNotMatch(registrationConfigFile, /homedir\(\)/, 'detection must not re-derive the default root');
  // The installer's configRoot delegates instead of re-deriving ~/.config.
  const configRootBody = setup.match(/function configRoot\(target = 'opencode'\): string \{[\s\S]*?\n\}/)?.[0] ?? '';
  assert.ok(configRootBody.length > 0, 'configRoot body found');
  assert.match(configRootBody, /xdgConfigHome\(\)/);
  assert.doesNotMatch(
    configRootBody,
    /homedir\(\)|'\.config'/,
    'configRoot must not re-derive the default root inline',
  );
  // Agent-presence detection probes the same root the installer writes.
  assert.match(
    setup,
    /\['opencode', \(\) => existsSync\(configRoot\('opencode'\)\)\]/,
    'detectAgents must probe the shared opencode config root',
  );
});

// Every supported target must have a cmdStatus section row — codex-desktop
// shipped for months as "install target exists, cmdStatus does not cover
// it" (the release smoke had to skip its status check), which is exactly
// the drift this invariant makes impossible for the next target.
test('cmdStatus covers every supported agent target', () => {
  const setup = readSource(join('src', 'setup-cli.ts'));
  const sectionsBody =
    setup.match(
      /const sections: Array<\{ name: string; run: \(\) => void; on: \(_target: string\) => boolean \}> = \[([\s\S]*?)\n {2}\];/,
    )?.[1] ?? '';
  assert.ok(sectionsBody.length > 0, 'cmdStatus sections array found');
  for (const id of SUPPORTED_AGENT_TARGETS) {
    assert.match(
      sectionsBody,
      new RegExp(`target === '${id}' \\|\\| target === 'all'`),
      `status must cover the ${id} target`,
    );
  }
});

test('tools.ts resolves skills from the server-relative tree only', () => {
  const tools = readSource(join('src', 'tools.ts'));
  // SKILLS_ROOT is server data next to dist/ — no agent-native dir probing
  assert.match(tools, /const SKILLS_ROOT = join\(__dirname, '\.\.', 'skills'\);/);
  assert.doesNotMatch(tools, /function opencodeSkillsDir\(\)/, 'native dir probe must be gone');
  assert.doesNotMatch(tools, /findSkillsRoot/, 'multi-root fallback must be gone');
  // The listing itself lives in the shared zod-free module so the boot
  // guard, doctor, and the --check stray scan hold one membership
  // predicate; tools.ts re-exports it for its existing importers.
  assert.match(tools, /import \{ listSkillDirs \} from '\.\/lib\/skill-tree\.ts';/);
  assert.match(tools, /export \{ listSkillDirs \};/);
  const listing = readSource(join('src', 'lib', 'skill-tree.ts'));
  assert.match(listing, /d\.isDirectory\(\) \|\| d\.isSymbolicLink\(\)/);
  assert.match(listing, /existsSync\(join\(root, d\.name, 'SKILL\.md'\)\)/);
});

test('KooCLI sandbox blockers and privacy agreement live in their extracted modules', () => {
  const setup = readSource(join('src', 'setup-cli.ts'));
  const hcloudProbe = readSource(join('src', 'hcloud-probe.ts'));
  const codeartsSandbox = readSource(join('src', 'codearts-sandbox.ts'));
  const depHcloud = readSource(join('src', 'dep', 'installers', 'hcloud.ts'));
  // sandbox detection reads the CodeArts permission config (codearts-sandbox.ts,
  // shared by doctor and the KooCLI installer; no leftover local copy in setup-cli)
  assert.match(codeartsSandbox, /function detectCodeartsSandbox\(\)/);
  assert.match(codeartsSandbox, /codearts-data', 'storage', 'permission', 'config\.json'/);
  assert.match(codeartsSandbox, /\.\s*bash_mode/);
  // sandbox warning prompts user to install externally or disable sandbox
  assert.match(codeartsSandbox, /function printSandboxWarning\(/);
  assert.match(codeartsSandbox, /检测到码道沙箱模式/);
  assert.match(codeartsSandbox, /在码道外的终端安装并使用 KooCLI/);
  assert.match(codeartsSandbox, /关闭沙箱模式后重试/);
  assert.match(setup, /from '\.\/codearts-sandbox\.(?:mjs|ts)'/);
  assert.doesNotMatch(setup, /function detectCodeartsSandbox\(\)/, 'detection must not be duplicated in setup-cli');
  // hcloud lookup delegates to the shared resolution chain; the HCLOUD_BIN
  // override is a property of the dependency catalog (envBin), not a literal
  // in this module — the old process.env.HCLOUD_BIN regex here passed only
  // because HCLOUD_BIN_ARGS_JSON prefixes it.
  assert.match(setup, /from '\.\/hcloud-probe\.(?:mjs|ts)'/);
  assert.match(hcloudProbe, /function findHcloudBin\(\)/);
  assert.equal(DEPENDENCIES.hcloud.resolution.envBin, 'HCLOUD_BIN');
  assert.match(hcloudProbe, /resolveDependencyCommand\(DEPENDENCIES\.hcloud\.resolution\)/);
  assert.match(hcloudProbe, /sandbox_home_failure/);
  // install-hcloud surfaces sandbox guidance on failure (caller moved with the installer)
  assert.match(depHcloud, /沙箱模式拦截了 KooCLI 自动安装/);
  // privacy agreement is gated on the tty flag on BOTH platforms (the Windows
  // branch used to lack the gate and hang non-interactive sessions)
  assert.match(depHcloud, /await offerPrivacyAcceptance\(join\(installDir, 'hcloud\.exe'\), opts\.tty\)/);
  assert.match(depHcloud, /await offerPrivacyAcceptance\(binPath, opts\.tty\)/);
  assert.match(depHcloud, /非交互会话：请稍后在终端运行 hcloud version/);
  // the caller computes the gate; the installer stays testable
  assert.match(setup, /process\.stdin\.isTTY === true && process\.stdout\.isTTY === true/);
  // MCP env injects HCLOUD_BIN when an hcloud binary is found
  assert.match(setup, /if \(hcloudBin\) env\.HCLOUD_BIN = hcloudBin\.replace/);
  // doctor warns about sandbox mode with the accurate settings path (#261)
  assert.match(setup, /KooCLI 可能无法写入 ~/);
  assert.match(setup, /设置 → 对话流 → 智能体 终端命令运行模式 → 自动运行/);
});

test('hermes restart hints, unix auto-install in dep/installers/hcloud, grouped status (#280)', () => {
  const setup = readSource(join('src', 'setup-cli.ts'));
  const depHcloud = readSource(join('src', 'dep', 'installers', 'hcloud.ts'));
  // Hermes .installed marker is read for restart hints (#280-4): hermes is
  // a row of the payload-target table the marker loop and the update
  // dispatch derive from.
  assert.match(setup, /id: 'hermes',\s+label: 'Hermes Agent',\s+dir: hermesPluginsDir,/);
  assert.match(setup, /update: updateHermes,/);
  assert.match(setup, /join\(target\.dir\(\), '\.installed'\)/);
  // Unix install-hcloud executes for real: download → extract → install → verify
  // (#280-3); the body moved to dep-provision.ts when provisioning absorbed
  // it, on to dep-hcloud.ts when the per-dependency installers split, and
  // into dep/installers/ when the subsystem organized by abstraction level.
  assert.match(depHcloud, /Auto-installing to \$\{binDir\}/);
  assert.match(depHcloud, /spawnSync\('curl', \['-fL', url, '-o', tmpTar\]/);
  assert.match(depHcloud, /spawnSync\('tar', \['-xzf', tmpTar, '-C', scratch\]/);
  // download/extract scratch is per-run (mkdtemp) and cleaned up in finally:
  // the fixed tmpdir()/huaweicloud-cli-<pkg>.tar.gz path collided across
  // concurrent installs, and auto-provisioning made concurrent installs normal.
  assert.match(depHcloud, /mkdtempSync\(join\(tmpdir\(\), 'huaweicloud-devkit-'\)\)/);
  assert.match(depHcloud, /rmSync\(scratch, \{ recursive: true, force: true \}\)/);
  // status groups sections by install state, installed first (#280-9)
  assert.match(setup, /stateOrder: Record<InstallState, number> = \{ installed: 0, partial: 1, unknown: 2, not: 3 \}/);
  assert.match(setup, /已安装: /);
});

test('dependency provisioning: new modules stay unbundled; setup-cli delegates', () => {
  const setup = readSource(join('src', 'setup-cli.ts'));
  const codeartsSandbox = readSource(join('src', 'codearts-sandbox.ts'));
  const depResolve = readSource(join('src', 'lib', 'dep-resolve.ts'));
  // The dep module tree is walked, not enumerated: every .ts file under
  // src/dep/ — including one a future dependency adds, at any depth — joins
  // the guard automatically, so the zod-free import graph cannot regress by
  // forgetting a list entry.
  const depModules = (readdirSync(join(pluginRoot, 'src', 'dep'), { recursive: true }) as string[])
    .filter((name) => name.endsWith('.ts'))
    .sort((a, b) => a.localeCompare(b));
  assert.ok(depModules.length >= 5, `expected the dep module family, found: ${depModules.join(', ')}`);
  // Same walk for the secret vault: every .ts file under
  // src/lib/secret-vault/ joins the zod-free guard automatically.
  const vaultModules = (readdirSync(join(pluginRoot, 'src', 'lib', 'secret-vault'), { recursive: true }) as string[])
    .filter((name) => name.endsWith('.ts'))
    .sort((a, b) => a.localeCompare(b));
  assert.ok(vaultModules.length >= 3, `expected the secret-vault module family, found: ${vaultModules.join(', ')}`);
  // These compile into the unbundled dist/setup-cli.js graph, where only
  // undici exists at runtime: no zod, no SDK, ever.
  const guarded = [
    ...depModules.map((name) => [`src/dep/${name}`, readSource(join('src', 'dep', name))] as const),
    ...vaultModules.map(
      (name) => [`src/lib/secret-vault/${name}`, readSource(join('src', 'lib', 'secret-vault', name))] as const,
    ),
    ['src/codearts-sandbox.ts', codeartsSandbox] as const,
    ['src/lib/dep-resolve.ts', depResolve] as const,
  ];
  for (const [name, source] of guarded) {
    assert.doesNotMatch(source, /from 'zod'/, `${name} must not import zod`);
    assert.doesNotMatch(source, /@modelcontextprotocol/, `${name} must not import the SDK`);
  }
  // lib/dep-resolve keeps the src/lib contract: runtime imports are node:*
  // builtins only; the dependency-model edge is type-only.
  const importLines = depResolve.split('\n').filter((line) => line.startsWith('import '));
  assert.ok(importLines.length >= 5, 'dep-resolve should import node builtins');
  for (const line of importLines) {
    assert.ok(
      line.includes("from 'node:") || line.startsWith('import type '),
      `lib/dep-resolve.ts runtime import must be node:* or type-only: ${line}`,
    );
  }
  // The installer body is absorbed, not duplicated: setup-cli owns the CLI
  // wrapper only.
  assert.doesNotMatch(setup, /spawnSync\('curl'/, 'the KooCLI installer body lives in dep/installers/hcloud.ts');
  assert.match(
    setup,
    /await installKooCli\(\{ tty: process\.stdin\.isTTY === true && process\.stdout\.isTTY === true \}\)/,
    'cmdInstallHcloud is the thin wrapper',
  );
  // Install and update both provision after payload placement, gated on the flag.
  assert.match(setup, /Provisioning pack binaries \(enabled packs: \$\{union\.size\}\)/);
  assert.match(setup, /hasCliFlag\('--skip-binaries'\)/);
  assert.match(setup, /const updated = await dispatchUpdateTarget\(target\);/);
  assert.match(setup, /--skip-binaries {3}\(with: install\/update\) skip provisioning host binaries/);
});

test('setup-cli.ts supports the dsh target end to end', () => {
  const setup = readSource(join('src', 'setup-cli.ts'));
  // SUPPORTED_AGENT_TARGETS includes dsh and parseTarget uses it
  assert.match(setup, /'dsh'/);
  // DSH path helpers and managed patch constants exist
  assert.match(setup, /function dshRoot\(\)/);
  assert.match(setup, /function dshSkillsDir\(\)/);
  assert.match(setup, /function dshProfileDir\(\)/);
  assert.match(setup, /function dshPatchFile\(\)/);
  assert.match(setup, /function dshPluginsDir\(\)/);
  assert.match(setup, /const DSH_MCP_PATCH_START = '# HuaweiCloud DevKit DSH integration start';/);
  assert.match(setup, /const DSH_MCP_PATCH_END = '# HuaweiCloud DevKit DSH integration end';/);
  // install / update / uninstall / status functions exist
  assert.match(setup, /async function installDsh\(\)/);
  assert.match(setup, /async function updateDsh\(\)/);
  assert.match(setup, /function uninstallDsh\(\)/);
  assert.match(setup, /function dshStatus\(\)/);
  // install ships the server payload and registers MCP through cordis.patch.yml
  assert.match(setup, /copyServerPayload\(pluginDest\)/);
  // No wholesale native copy ever returns: only core-pack names sync natively
  // (syncNativeCoreSkills), so DSH's dir can never carry service skills.
  assert.match(setup, /function syncNativeCoreSkills\(dir: string\)/);
  assert.doesNotMatch(
    setup,
    /copyDir\(skillsSrc, (?:dsh|opencode|hermes|workbuddy|atomcode|openclaw|codearts|codeartsWork)SkillsDir\(\)\)/,
    'no wholesale native copy; only core-pack names sync natively',
  );
  assert.match(setup, /nativeSkills: \(\) => \[dshSkillsDir\(\)\]/, 'DSH row declares its native dir');
  assert.match(setup, /ensureDshMcpPatch\(\)/);
  assert.match(setup, /tryInstallDshMcpClient\(\)/);
  // DSH MCP patch uses dsh-mcp-client with stdio local server mode
  assert.match(setup, /name: '@deepseek-ai\/dsh-mcp-client'/);
  assert.match(setup, /serverName: huaweicloud/);
  assert.match(setup, /transport: stdio/);
  assert.match(setup, /failOnStartupError: false/);
  assert.match(setup, /HUAWEICLOUD_AGENT_TOOLKIT_MODE: local/);
  // uninstall removes only the managed patch block
  assert.match(setup, /removeDshMcpPatch\(\)/);
  // command dispatch covers dsh for install / uninstall / status / update
  const branches = setup.match(/target === 'dsh' \|\| target === 'all'/g);
  const installDispatch = setup.match(/shouldInstall\('dsh'\)/g);
  assert.ok(
    (branches?.length ?? 0) + (installDispatch?.length ?? 0) >= 4,
    `dsh dispatch branches: ${(branches?.length ?? 0) + (installDispatch?.length ?? 0)}`,
  );
  // .installed marker goes to the dsh plugins dir: the table row's dir field
  // (installMarkerDirForTarget is a lookup over the table — pinned in its own test)
  // doctor and the update dispatch reach DSH through the payload-target table
  assert.match(setup, /id: 'dsh',\s+label: 'DSH',\s+dir: dshPluginsDir,/);
  assert.match(setup, /update: updateDsh,/);
  assert.match(setup, /dshPatchConfigured\(\)/);
  // help text documents the target
  assert.match(
    setup,
    /--target <opencode\|codex\|codearts\|codearts-work\|workbuddy\|dsh\|officeace\|hermes\|openclaw\|atomcode\|all>/,
  );
  assert.match(setup, /install --target dsh/);
});

test('tools.ts resolves skills from the server-relative tree only (dsh fallback removed)', () => {
  const tools = readSource(join('src', 'tools.ts'));
  // No DSH (or any agent) dir probing survives in the server: skills are
  // server data resolved next to dist/.
  assert.doesNotMatch(tools, /function dshSkillsDir\(\)/, 'dsh dir probe must be gone');
  assert.match(tools, /const SKILLS_ROOT = join\(__dirname, '\.\.', 'skills'\);/);
  // The agent-target list moved to the zod schema descriptions when the
  // JSON-Schema registry was replaced, and into the auth pack when the
  // schemas were materialized per pack (src/packs/auth/tools.ts).
  const authPack = readSource(join('src', 'packs', 'auth', 'tools.ts'));
  assert.match(
    authPack,
    /opencode, codex, codex-desktop, codearts, codearts-work, workbuddy, dsh, officeace, hermes, openclaw, atomcode, or all/,
  );
});

test('setup-cli.ts keeps officeace capability cleanup (no native skill registration)', () => {
  const setup = readSource(join('src', 'setup-cli.ts'));
  assert.match(setup, /function removeOfficeaceSkillCapabilities\(\)/);
  assert.match(setup, /function officeaceSkillsDir\(\)/);
});

test('setup-cli.ts supports the officeace target end to end', () => {
  const setup = readSource(join('src', 'setup-cli.ts'));
  assert.match(setup, /'officeace'/);
  assert.match(setup, /async function installOfficeAce\(\)/);
  assert.match(setup, /function uninstallOfficeAce\(\)/);
  assert.match(setup, /function officeaceStatus\(\)/);
  assert.match(setup, /async function updateOfficeAce\(\)/);
  assert.match(setup, /function officeaceCapabilitiesDir\(\)/);
  assert.match(setup, /function officeaceCapabilitiesFile\(\)/);
  assert.match(setup, /function officeaceSkillsDir\(\)/);
  assert.match(setup, /function officeacePluginsDir\(\)/);
  assert.match(setup, /function readOfficeaceRegistryInstallDir\(\)/);
  assert.match(setup, /function ensureOfficeaceMcpInSqlite\(\)/);
  assert.match(setup, /function removeOfficeaceMcpFromSqlite\(\)/);
  // Native skill registration is gone; install/update actively clean the
  // capabilities entries older versions wrote.
  assert.doesNotMatch(setup, /registerOfficeaceSkillEntries/, 'no native skill registration');
  assert.match(setup, /copyServerPayload\(pluginDest\)/);
  assert.match(setup, /removeOfficeaceSkillCapabilities\(\)/);
  assert.match(setup, /mcpServer.*command.*node/s);
  assert.match(setup, /capabilities\.json/);
  const branches = setup.match(/target === 'officeace' \|\| target === 'all'/g);
  const installDispatch = setup.match(/shouldInstall\('officeace'\)/g);
  assert.ok(
    (branches?.length ?? 0) + (installDispatch?.length ?? 0) >= 3,
    `officeace dispatch branches: ${(branches?.length ?? 0) + (installDispatch?.length ?? 0)}`,
  );
  assert.match(setup, /install --target officeace/);
});

test('setup-cli.ts supports the hermes target end to end', () => {
  const setup = readSource(join('src', 'setup-cli.ts'));
  assert.match(setup, /'hermes'/);
  assert.match(setup, /async function installHermes\(\)/);
  assert.match(setup, /function uninstallHermes\(\)/);
  assert.match(setup, /function hermesStatus\(\)/);
  assert.match(setup, /async function updateHermes\(\)/);
  assert.match(setup, /function hermesHomeDir\(\)/);
  assert.match(setup, /function hermesSkillsDir\(\)/);
  assert.match(setup, /function hermesPluginsDir\(\)/);
  assert.match(setup, /function hermesConfigFile\(\)/);
  assert.match(setup, /function ensureHermesMcpConfig\(\)/);
  assert.match(setup, /function removeHermesMcpConfigBlock\(\)/);
  assert.match(setup, /function ensureHermesHooksConfig\(\)/);
  assert.match(setup, /function removeHermesHooksConfigBlock\(\)/);
  assert.match(setup, /function ensureHermesHookAllowlist\(\)/);
  assert.match(setup, /function hermesHookCommand\(\)/);
  assert.match(setup, /function hermesPythonPluginsDir\(\)/);
  assert.match(setup, /function hermesSafetyPluginDir\(\)/);
  assert.match(setup, /function ensureHermesHookPlugin\(\)/);
  assert.match(setup, /function removeHermesHookPlugin\(\)/);
  assert.match(setup, /copyServerPayload\(pluginDest, \{ skipDist: skipMcp \}\)/);
  assert.match(setup, /copyDir\(hooksDir, join\(pluginDest, 'hooks'\)\)/);
  assert.match(setup, /ensureHermesMcpConfig\(\)/);
  assert.match(setup, /ensureHermesHooksConfig\(\)/);
  assert.match(setup, /ensureHermesHookAllowlist\(\)/);
  assert.match(setup, /ensureHermesHookPlugin\(\)/);
  assert.match(setup, /mcp_servers:/);
  assert.match(setup, /huaweicloud-devkit:/);
  assert.match(setup, /HUAWEICLOUD_AGENT_TOOLKIT_MODE: "local"/);
  assert.match(setup, /hooks:/);
  assert.match(setup, /pre_tool_call:/);
  assert.match(setup, /matcher: "terminal"/);
  assert.match(setup, /fail_closed: true/);
  assert.match(setup, /shell-hooks-allowlist\.json/);
  assert.match(setup, /name: huaweicloud-safety/);
  assert.match(setup, /register_hook\("pre_tool_call"/);
  assert.match(setup, /evaluate\(tool_name, args\)/);
  assert.match(setup, /huaweicloud-safety\.py/);
  const branches = setup.match(/target === 'hermes' \|\| target === 'all'/g);
  const installDispatch = setup.match(/shouldInstall\('hermes'\)/g);
  assert.ok(
    (branches?.length ?? 0) + (installDispatch?.length ?? 0) >= 3,
    `hermes dispatch branches: ${(branches?.length ?? 0) + (installDispatch?.length ?? 0)}`,
  );
  assert.match(setup, /install --target hermes/);
  assert.match(setup, /HERMES_HOME/);
  assert.match(setup, /LOCALAPPDATA/);
  assert.match(setup, /--skip-mcp-server/);
  assert.match(setup, /function ensureHermesMcpSdk\(\)/);
  assert.match(setup, /function hermesMcpSdkOk\(\)/);
});

test('PAYLOAD_TARGETS is the single id→dir map for payload targets', () => {
  const setup = readSource(join('src', 'setup-cli.ts'));
  // The marker-dir function is a lookup over the table, not a second hand
  // list — the atomcode/openclaw drift class dies only if the lookup stays
  // derived.
  const markerFn = setup.match(/function installMarkerDirForTarget\(target: string\): string \| null \{[\s\S]*?\n\}/);
  assert.ok(markerFn, 'installMarkerDirForTarget must exist');
  assert.match(markerFn[0], /PAYLOAD_TARGETS\.find\(\(t\) => t\.id === target\)\?\.dir\(\) \?\? null/);
  assert.doesNotMatch(markerFn[0], /target === '/);
  // Every non-codex supported target has a table row: doctor's payload
  // checks, the marker dir, willPlacePayload, and the update dispatch all
  // follow the table, so a missing row silently drops a target everywhere.
  const table = setup.match(/const PAYLOAD_TARGETS: readonly PayloadTarget\[\] = \[[\s\S]*?\n\];/);
  assert.ok(table, 'PAYLOAD_TARGETS table must exist');
  for (const id of SUPPORTED_AGENT_TARGETS) {
    if (id === 'codex') continue;
    assert.match(table[0], new RegExp(`\\bid: '${id}',`), `${id} must have a PAYLOAD_TARGETS row`);
  }
});

test('sandbox timeout defaults stay single-sourced (no raw numeric fallbacks)', () => {
  const src = readSource(join('src', 'packs', 'sandbox', 'tools.ts'));
  assert.doesNotMatch(src, /args\.timeout_ms \|\| \d/, 'handler fallbacks must read SANDBOX_TIMEOUT_MS');
  const fallbacks = src.match(/args\.timeout_ms \|\| SANDBOX_TIMEOUT_MS\.\w+/g);
  assert.equal(fallbacks?.length ?? 0, 6, 'six tool handlers apply the shared defaults');
});

test('setup-cli.ts supports the version command', () => {
  const setup = readSource(join('src', 'setup-cli.ts'));
  assert.match(setup, /function cmdVersion\(\)/);
  assert.match(setup, /function readInstalledVersion\(/);
  assert.match(setup, /case '--version'/);
  assert.match(setup, /case 'version'/);
});

test('setup-cli.ts wires the auth reconcile subcommand', () => {
  const setup = readSource(join('src', 'setup-cli.ts'));
  assert.match(setup, /function cmdAuthReconcile\(\)/);
  assert.match(setup, /sub === 'reconcile'/);
  assert.match(setup, /return cmdAuthReconcile\(\)/);
});

test('setup-cli.ts resolves the active KooCLI profile for configureHcloud', () => {
  const setup = readSource(join('src', 'setup-cli.ts'));
  assert.match(setup, /function configuredProfileName\(\)/);
  assert.match(setup, /resolveManagedProfile\(\)/);
  assert.match(setup, /return name \|\| 'default'/);
  assert.match(setup, /--cli-profile=\$\{configuredProfileName\(\)\}/);
  assert.doesNotMatch(setup, /hcloud configure init/);
});

test('setup-cli.ts checks for updates on install/update via shared query', () => {
  const setup = readSource(join('src', 'setup-cli.ts'));
  assert.match(setup, /async function checkForUpdate\(\)/);
  assert.match(setup, /queryDistTagsFetch\(/);
  assert.match(setup, /semverCompare\(/);
  const calls = setup.match(/^\s+await checkForUpdate\(\);$/gm);
  assert.ok(calls && calls.length >= 2, 'checkForUpdate should be awaited in both cmdInstall and cmdUpdate');
});

test('tools.ts no longer probes hermes/atomcode native skill dirs', () => {
  const tools = readSource(join('src', 'tools.ts'));
  assert.doesNotMatch(tools, /function hermesSkillsDir\(\)/, 'hermes dir probe must be gone');
  assert.doesNotMatch(tools, /function atomcodeSkillsDir\(\)/, 'atomcode dir probe must be gone');
  assert.match(tools, /const SKILLS_ROOT = join\(__dirname, '\.\.', 'skills'\);/);
});

test('agent-registration reports openclaw registration status', () => {
  const registration = readSource(join('src', 'auth', 'agent-registration.ts'));
  assert.match(registration, /function openclawRegistered\(\)/);
  assert.match(registration, /agent === 'openclaw'/);
  assert.match(registration, /'\.agents', 'huaweicloud-plugins', '\.mcp\.json'/);
});

test('official Huawei Cloud Icons library is integrated', () => {
  const tools = readSource(join('src', 'tools.ts'));
  assert.match(tools, /name: 'huaweicloud_get_service_icon'/);

  const discoveryPack = readSource(join('src', 'packs', 'discovery', 'tools.ts'));
  assert.match(discoveryPack, /getServiceIcon\(args\.service/);

  const snapshotPath = join(pluginRoot, 'src', 'data', 'icons-manifest.v1.json');
  assert.ok(existsSync(snapshotPath), 'Missing icons-manifest.v1.json snapshot');
  const manifest = readJson(snapshotPath) as IconsManifest;
  assert.ok(Array.isArray(manifest.icons), 'icons must be an array');
  assert.ok(manifest.icons.length >= 100, `Expected at least 100 icons, got ${manifest.icons.length}`);

  const byId = new Map(manifest.icons.map((i) => [i.id, i]));
  for (const id of ['ecs', 'obs', 'vpc', 'modelarts']) {
    const icon = byId.get(id);
    assert.ok(icon, `Missing icon: ${id}`);
    assert.match(icon.logo.source_url, /^https:\/\//, `${id} logo source_url must be https`);
    assert.equal(typeof icon.name, 'string');
  }

  const discovery = readFileSync(join(pluginRoot, 'skills', 'huaweicloud-capability-discovery', 'SKILL.md'), 'utf8');
  assert.match(discovery, /huaweicloud_get_service_icon/);
  assert.match(discovery, /open\.huaweicloud\.com\/openplatform\/icons\.html/);
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
  assert.match(tools, /PACK_TOOL_HANDLERS\[name\]\(args, opts\)/);

  // Behavioral lockstep: the pack tool list equals the PACK_OF ownership for
  // 'update'. Descriptions are derived from UPDATE_TOOLS in tools.ts itself,
  // so no byte-equality pin is needed here anymore.
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
  // after P4: sandbox (11), auth (5), obs (2), voucher (2), discovery (3),
  // huaweicloud-open-mcp (3), huaweicloud-cli (7), secrets (3). Their
  // handlers reach callTool only through the PACK_TOOL_HANDLERS merge in
  // packs/registry.ts.
  const packs = [
    { id: 'sandbox', tools: SANDBOX_TOOLS, count: 11 },
    { id: 'auth', tools: AUTH_TOOLS, count: 5 },
    { id: 'obs', tools: OBS_TOOLS, count: 2 },
    { id: 'voucher', tools: VOUCHER_TOOLS, count: 2 },
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

test('stdio server warms update cache; shared protocol decorates first tool call', () => {
  const server = readSource(join('src', 'mcp-server.ts'));
  assert.match(server, /getCachedUpdateInfo\(readInstalledVersion\(\)/);
  const protocol = readSource(join('src', 'mcp-protocol.ts'));
  assert.match(protocol, /applyUpdateHint\(/);
  assert.match(protocol, /peekCachedUpdateInfo\(\)/);
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

test('hdkitservice-api sends X-HW-Client-Version; SKILL session-start wording', () => {
  const api = readSource(join('src', 'lib', 'hdkit', 'hdkitservice-api.ts'));
  assert.match(api, /X-HW-Client-Version/);
  assert.match(api, /readInstalledVersion\(\)/);
  const skill = readFileSync(join(pluginRoot, 'skills', 'huaweicloud-core', 'SKILL.md'), 'utf8');
  assert.match(skill, /先调用 `huaweicloud_check_update` 检查插件版本/);
  assert.match(skill, /若未先行检查，插件会在使用中收到服务端升级提示/);
});

test('READMEs recommend @latest for updates', () => {
  const en = readFileSync(join(root, 'README.md'), 'utf8');
  assert.match(en, /huaweicloud-devkit@latest update --target all/);
  const zh = readFileSync(join(root, 'README.zh-CN.md'), 'utf8');
  assert.match(zh, /huaweicloud-devkit@latest update --target all/);
});

test('cmdUpdate has no trailing unreachable reinstall; cmdReinstall keeps it', () => {
  const setup = readSource(join('src', 'setup-cli.ts'));
  // cmdUpdate（'update'/'upgrade' 入口）本身不得做"卸载+重装"；各 target 分支均 return。
  const cmdUpdateBody = setup.slice(
    setup.indexOf('async function cmdUpdate()'),
    setup.indexOf('async function cmdReinstall()'),
  );
  assert.doesNotMatch(cmdUpdateBody, /await cmdUninstall\(/);
  assert.doesNotMatch(cmdUpdateBody, /await cmdInstall\(/);
  // cmdReinstall 是专职重装：卸载+重装逻辑必须保留。
  const cmdReinstallBody = setup.slice(
    setup.indexOf('async function cmdReinstall()'),
    setup.indexOf('async function cmdInstallHcloud()'),
  );
  assert.match(cmdReinstallBody, /await cmdUninstall\(\{ fromReinstall: true \}\)/);
  assert.match(cmdReinstallBody, /await cmdInstall\(\)/);
});

test('doctor success message does not demand a restart', () => {
  const setupCli = readSource(join('src', 'setup-cli.ts'));
  assert.match(setupCli, /You can now describe your Huawei Cloud task/);
  assert.doesNotMatch(setupCli, /Restart your session, then describe/);
});

test('shipped runtime entry points point at built dist JavaScript', () => {
  const pkg = readJson(join(root, 'package.json')) as PackageJson;
  for (const [name, target] of Object.entries(pkg.bin ?? {})) {
    assert.doesNotMatch(target, /\.ts$/, `bin ${name} must not point at a TypeScript file`);
    assert.ok(!target.includes('/src/'), `bin ${name} must not reference src/`);
  }

  const mcp = readJson(join(pluginRoot, '.mcp.json')) as McpConfig;
  for (const server of Object.values(mcp.mcpServers ?? {})) {
    for (const arg of server.args ?? []) {
      assert.doesNotMatch(arg, /\.ts$/, `.mcp.json arg ${arg} must not point at a TypeScript file`);
      assert.ok(!arg.includes('/src/') && !arg.startsWith('./src/'), `.mcp.json arg ${arg} must not reference src/`);
    }
  }

  const hooks = readJson(join(pluginRoot, 'hooks', 'hooks.json')) as HooksConfig;
  for (const entries of Object.values(hooks.hooks ?? {})) {
    for (const entry of entries) {
      for (const hook of entry.hooks ?? []) {
        assert.doesNotMatch(hook.command ?? '', /\.ts\b/, `hook must not run TypeScript: ${hook.command}`);
      }
    }
  }

  const hookWrapper = readFileSync(join(pluginRoot, 'hooks', 'huaweicloud-safety.mjs'), 'utf8');
  assert.match(hookWrapper, /dist\/safety-policy\.js/, 'hook wrapper must prefer the built dist module');
  assert.doesNotMatch(hookWrapper, /from '\.\.\/src\//, 'hook wrapper must not statically import src');

  // A raw git or marketplace copy of the plugin has no dist; the wrapper must
  // still run the safety gate from the TypeScript source in that layout.
  const hookFallback = /existsSync\([^)]*dist[^)]*safety-policy\.js[\s\S]*import\('\.\.\/src\/safety-policy\.ts'\)/;
  assert.match(hookWrapper, hookFallback, 'hook wrapper needs a src fallback for unbuilt copies');

  const cordis = readFileSync(join(root, 'cordis.patch.yml'), 'utf8');
  assert.doesNotMatch(cordis, /\.ts\b/, 'cordis.patch.yml must not reference TypeScript files');
  assert.doesNotMatch(cordis, /plugins\/huaweicloud-core\/src\//, 'cordis.patch.yml must not reference src/');

  const hermesManifest = readFileSync(join(root, 'integrations', 'hermes', 'manifest.yaml'), 'utf8');
  assert.doesNotMatch(hermesManifest, /plugins\/huaweicloud-core\/src\//, 'hermes manifest must not reference src/');

  const setupCli = readSource(join('src', 'setup-cli.ts'));
  assert.doesNotMatch(
    setupCli,
    /'src', 'mcp-server\.js'/,
    'setup-cli must not point at a src mcp-server.js (built output lives in dist)',
  );
  assert.doesNotMatch(setupCli, /join\(PLUGIN_ROOT, 'src'\)/, 'setup-cli must copy dist, not src');
});

test('plugin src tree is TypeScript only', () => {
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)],
    );
  const scripts = walk(join(pluginRoot, 'src')).filter((file) => /\.(mjs|cjs|js)$/.test(file));
  assert.deepEqual(
    scripts,
    [],
    `src must hold only TypeScript scripts plus data assets; found JavaScript: ${scripts.join(', ')}`,
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

test('doctor renders the pack-binary section from the dependency model', () => {
  const setupCli = readSource(join('src', 'setup-cli.ts'));
  assert.doesNotMatch(setupCli, /PACK_BINARIES|PackBinary/, 'doctor must not read the deleted binaries table');
  assert.match(
    setupCli,
    /requiredDependencies\(enabledPacksUnion\)/,
    'the section iterates requiredDependencies over the enabled union',
  );
  assert.match(setupCli, /sandbox-resident, not probed host-side/);
  assert.match(setupCli, /dep install \$\{id\}/, 'the gateway WARNs point at dep install for the missing dependency');
  assert.match(setupCli, /Object\.entries\(PACK_USES\)/, 'PACK_USES soft edges warn in the same section');
  // The dedicated hcloud block stays the explicit plugin-level rule, never
  // derived from the dependency graph (see the section's comment).
  assert.match(setupCli, /check\('hcloud CLI installed'/, 'the dedicated hcloud check is untouched');
});

test('dependency model: catalog keyed by id, kinds pin the process model', () => {
  assert.deepEqual(
    Object.keys(DEPENDENCIES).sort((a, b) => a.localeCompare(b)),
    [...DEPENDENCY_IDS].sort((a, b) => a.localeCompare(b)),
  );
  assert.equal(DEPENDENCIES.devbridge.kind, 'sandbox-resident');
  assert.ok(!('resolution' in DEPENDENCIES.devbridge), 'sandbox-resident carries no host resolution');
  assert.ok(!('installPolicy' in DEPENDENCIES.devbridge), 'sandbox-resident carries no install policy');
  assert.equal(DEPENDENCIES.hcloud.kind, 'cli');
  assert.equal(DEPENDENCIES.hcloud.installPolicy, 'auto');
  assert.equal(DEPENDENCIES['open-mcp-gateway'].kind, 'managed-child');
  assert.equal(DEPENDENCIES['open-mcp-gateway'].installPolicy, 'prompt');
  assert.deepEqual(DEPENDENCIES['open-mcp-gateway'].supervision, {
    owner: 'mcp-server',
    spawn: 'lazy-on-first-call',
    lifetime: 'parent-stdin-pipe',
    escalation: 'sigterm-sigkill-3s',
    respawn: 'on-next-call',
  });
});

test('dependency model: pack edges are legal, core owns none, hcloud attributed to its consumers', () => {
  assert.deepEqual(
    Object.keys(PACK_DEPENDENCIES).sort((a, b) => a.localeCompare(b)),
    [...PACK_IDS].sort((a, b) => a.localeCompare(b)),
  );
  const used = new Set<string>();
  for (const [packId, deps] of Object.entries(PACK_DEPENDENCIES)) {
    for (const dep of deps) {
      assert.ok(
        (DEPENDENCY_IDS as readonly string[]).includes(dep),
        `${packId} -> ${dep} must be a declared dependency id`,
      );
      used.add(dep);
    }
  }
  assert.deepEqual(
    [...used].sort((a, b) => a.localeCompare(b)),
    [...DEPENDENCY_IDS].sort((a, b) => a.localeCompare(b)),
    'every dependency is required by at least one pack',
  );
  assert.deepEqual(
    PACK_DEPENDENCIES.core,
    [],
    'core owns no binary dependency: a core edge would auto-provision hcloud for CLI-less trims and block receipt-gated uninstall',
  );
  const hcloudConsumers = Object.entries(PACK_DEPENDENCIES)
    .filter(([, deps]) => (deps as readonly string[]).includes('hcloud'))
    .map(([packId]) => packId)
    .sort((a, b) => a.localeCompare(b));
  assert.deepEqual(hcloudConsumers, ['auth', 'huaweicloud-cli', 'obs']);
});

test('dependency model: requires/uses edges are legal and requires is acyclic', () => {
  for (const table of [PACK_REQUIRES, PACK_USES]) {
    for (const [packId, deps] of Object.entries(table)) {
      for (const dep of deps as readonly string[]) {
        assert.ok((PACK_IDS as readonly string[]).includes(dep), `${packId} -> ${dep} must be a pack id`);
        assert.notEqual(dep, packId, 'no self edges');
      }
    }
  }
  const seen = new Set<string>();
  const stack = new Set<string>();
  const hasCycle = (id: string): boolean => {
    if (stack.has(id)) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    stack.add(id);
    const edges = (PACK_REQUIRES as Record<string, readonly string[]>)[id] ?? [];
    const cyclic = edges.some((edge) => hasCycle(edge));
    stack.delete(id);
    return cyclic;
  };
  assert.ok(!(PACK_IDS as readonly string[]).some((id) => hasCycle(id)), 'PACK_REQUIRES must be acyclic');
  assert.deepEqual(PACK_USES.sandbox, ['discovery', 'obs']);
});

test('closeEnablement closes transitively and reports pulledBy', () => {
  const closure = closeEnablement(['obs'], (id) =>
    id === 'obs' ? ['auth', 'voucher'] : id === 'auth' ? ['discovery'] : [],
  );
  assert.deepEqual(
    [...closure.enabled].sort((a, b) => a.localeCompare(b)),
    ['auth', 'discovery', 'obs', 'voucher'],
  );
  assert.deepEqual(closure.pulledBy.get('auth'), ['obs']);
  assert.deepEqual(closure.pulledBy.get('voucher'), ['obs']);
  assert.deepEqual(closure.pulledBy.get('discovery'), ['auth']);
  assert.equal(closure.pulledBy.has('obs'), false);
  const cyclic = closeEnablement(['auth'], (id) => (id === 'auth' ? ['voucher'] : id === 'voucher' ? ['auth'] : []));
  assert.deepEqual(
    [...cyclic.enabled].sort((a, b) => a.localeCompare(b)),
    ['auth', 'voucher'],
  );
});

test('parseDevkitPacks is tolerant and defaults blank to the full surface', () => {
  for (const blank of [null, undefined, '', '   ']) {
    const parsed = parseDevkitPacks(blank);
    assert.equal(parsed.enabled.size, PACK_IDS.length);
    assert.deepEqual(parsed.unknown, []);
  }
  const parsed = parseDevkitPacks(' sandbox , bogus ');
  assert.deepEqual(parsed.unknown, ['bogus']);
  assert.deepEqual(
    [...parsed.enabled].sort((a, b) => a.localeCompare(b)),
    ['core', 'sandbox'],
  );
});

test('requiredDependencies unions pack edges; core alone requires nothing', () => {
  assert.deepEqual([...requiredDependencies(new Set(['core']))], []);
  assert.deepEqual(
    [...requiredDependencies(new Set(['huaweicloud-cli', 'auth', 'obs']))].sort((a, b) => a.localeCompare(b)),
    ['hcloud'],
  );
  assert.deepEqual([...requiredDependencies(new Set(['sandbox']))], ['devbridge']);
  assert.deepEqual([...requiredDependencies(new Set(['huaweicloud-open-mcp']))], ['open-mcp-gateway']);
});

test('test fixtures: raw mkdtempSync is denied by default across the suite', () => {
  // 2026-10-09: TMPDIR=$HOME verification runs leaked 614 unremoved
  // mkdtemp fixture dirs into $HOME (plus a stray node-compile-cache) —
  // invisible on tmpfs /tmp, where reboots hide the leak. Deny-by-default:
  // every test/*.test.ts that still writes mkdtempSync must either route
  // its fixtures through the shared registry (test/fixture-dir.ts:
  // registry-created dirs are removed at process exit, so a partially
  // migrated file fails too) or appear on the per-test-cleaner allowlist
  // below — every entry there removes its own fixtures in finally blocks,
  // verified by the isolated-TMPDIR full-suite residue check. This file is
  // exempt from its own scan: its mkdtempSync occurrences are assertion
  // regexes, never fixture creation. A new fixture-heavy test file either
  // adopts fixtureDir or joins the allowlist with cleanup of its own;
  // nothing passes silently by default.
  const perTestCleaners = new Set([
    'agent-install.test.ts',
    'auth-credentials.test.ts',
    'codearts-adaptation.test.ts',
    'cred-reconcile-e2e.test.ts',
    'cross-platform-install.test.ts',
    'dep-receipts.test.ts',
    'dsh-adaptation.test.ts',
    'hdkitservice-api.test.ts',
    'hook-node.test.ts',
    'issue-443-fix.test.ts',
    'mcp-server.test.ts',
    'officeace-adaptation.test.ts',
    'packs-command.test.ts',
    'plugins-e2e.test.ts',
    'proxy-agent.test.ts',
    'reconcile.test.ts',
    'safety-policy.test.ts',
    'setup-packs.test.ts',
    'telemetry.test.ts',
    'uninstall-cleanup.test.ts',
    'update-check.test.ts',
    'upgrade-session.test.ts',
  ]);
  const testDir = join(root, 'test');
  for (const entry of readdirSync(testDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.test.ts')) continue;
    if (entry.name === 'structure.test.ts') continue; // the guard file itself
    const source = readFileSync(join(testDir, entry.name), 'utf8');
    if (!source.includes('mkdtempSync')) continue;
    if (source.includes("from './fixture-dir.ts'")) {
      assert.ok(
        !source.includes('mkdtempSync('),
        `${entry.name} imports the fixtureDir registry but still creates a raw mkdtemp fixture (partial migration)`,
      );
      continue;
    }
    assert.ok(
      perTestCleaners.has(entry.name),
      `${entry.name} creates mkdtemp fixtures without the fixtureDir registry and is not on the per-test-cleaner allowlist; adopt fixtureDir() or clean per-test and join the list`,
    );
  }
});

// jscpd duplication gate. The committed .jscpd-baseline.json fingerprints the
// legacy clones (generated from the v2 tree), so the gate fails only on
// duplication the baseline has never seen — no branch-ref comparison, no
// total-percentage threshold. These guards keep that contract honest: the
// config must restrict formats and ignore the noisy trees (asserted on the
// file AND on the binary's actual behavior — jscpd degrades an unknown
// config key to defaults with one warning line), the pin must be exact
// (ratchet flags are documented only in --help, so version drift silently
// changes gate behavior), and the working tree must stay in sync with the
// baseline.
function jscpdRunner(): string {
  return join(root, 'node_modules', 'jscpd', 'run-jscpd.js');
}

function lintDupRoots(): string[] {
  const pkg = readJson(join(root, 'package.json')) as PackageJson;
  const script = pkg.scripts['lint:dup'] ?? '';
  assert.ok(script.startsWith('jscpd '), 'package.json must define lint:dup as a jscpd invocation');
  return script.split(' ').slice(1);
}

test('jscpd scan config: formats exclude markdown, ignores pinned, no threshold', () => {
  const config = readJson(join(root, '.jscpd.json')) as JscpdConfig;
  assert.deepEqual(config.formats, ['typescript', 'javascript']);
  assert.ok(
    !Object.hasOwn(config, 'threshold'),
    'total-percentage thresholds fail builds on legacy duplication and are the documented top reason teams disable copy/paste gates',
  );
  for (const pattern of ['**/dist/**', '**/*.d.mts', 'test/fixtures/**', 'test/huaweicloud-*/**']) {
    assert.ok(config.ignore.includes(pattern), `.jscpd.json must keep ignore pattern ${pattern}`);
  }
  assert.ok(config.reporters.includes('console'), 'local lint:dup runs need the console reporter');
});

test('jscpd devDependency is exact-pinned and lint:dup roots exclude the skills trees', () => {
  const pkg = readJson(join(root, 'package.json')) as PackageJson;
  assert.match(
    pkg.devDependencies.jscpd ?? '',
    /^\d+\.\d+\.\d+$/,
    'jscpd must be exact-pinned (no ^ or ~): the baseline ratchet flags are documented only in --help, version drift changes gate behavior',
  );
  const script = pkg.scripts['lint:dup'] ?? '';
  assert.doesNotMatch(
    script,
    /skills/,
    'the script must not mention a skills path at all (a root would scan a skills tree, an ignore glob would silently mask one); the src/packs/*/skills/ markdown sources live inside the scanned src root and are excluded only by the formats restriction (pinned by the config and behavioral tests in this suite)',
  );
  assert.ok(
    script.includes('eslint.config.mjs'),
    'eslint.config.mjs is hand-written JavaScript and belongs in the scan roots',
  );
});

test('jscpd binary honors the config: ts twins clone, markdown stays excluded', () => {
  const runner = jscpdRunner();
  assert.ok(existsSync(runner), 'jscpd is not installed; run npm install');
  const dir = fixtureDir('jscpd-config-honored-');
  const tsTwin = [
    'export function formatLabelParts(input: string): string {',
    '  const trimmed = input.trim();',
    '  const lowered = trimmed.toLowerCase();',
    '  const parts = lowered.split(/[,\\s]+/).filter((part) => part.length > 0);',
    '  const unique = [...new Set(parts)];',
    '  const joined = unique.join("-");',
    '  const wrapped = `[${joined}]`;',
    '  return wrapped;',
    '}',
    '',
  ].join('\n');
  const mdTwin = [
    '# Twin Document',
    '',
    ...Array.from({ length: 12 }, (_, i) => `Shared planning note line ${i + 1} kept identical across both files.`),
    '',
  ].join('\n');
  writeFileSync(join(dir, 'ts-twin-a.ts'), tsTwin);
  writeFileSync(join(dir, 'ts-twin-b.ts'), tsTwin);
  // The markdown twins exist to be missed: if formats ever degrade (typo'd
  // config key, jscpd upgrade renaming one), markdown enters the scan and
  // this pair becomes a clone the assertion below rejects.
  writeFileSync(join(dir, 'md-twin-a.md'), mdTwin);
  writeFileSync(join(dir, 'md-twin-b.md'), mdTwin);
  const outDir = join(dir, 'out');
  const run = spawnSync(process.execPath, [runner, dir, '--reporters', 'json', '--output', outDir, '--no-colors'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 60_000,
  });
  assert.equal(run.status, 0, `jscpd fixture scan failed: ${run.stdout}\n${run.stderr}`);
  const report = JSON.parse(readFileSync(join(outDir, 'jscpd-report.json'), 'utf8')) as JscpdReport;
  assert.equal(
    report.duplicates.length,
    1,
    `expected exactly the ts twin pair, got: ${report.duplicates.map((dup) => `${dup.format}:${dup.firstFile.name}`).join(', ')}`,
  );
  assert.equal(report.duplicates[0]?.format, 'typescript');
  assert.match(report.duplicates[0]?.firstFile.name ?? '', /^ts-twin-/);
  assert.match(report.duplicates[0]?.secondFile.name ?? '', /^ts-twin-/);
});

test('jscpd baseline is in sync: zero new clones against the committed fingerprints', () => {
  const runner = jscpdRunner();
  assert.ok(existsSync(runner), 'jscpd is not installed; run npm install');
  const baselinePath = join(root, '.jscpd-baseline.json');
  assert.ok(existsSync(baselinePath), '.jscpd-baseline.json must be committed with the gate');
  const baseline = readJson(baselinePath) as JscpdBaseline;
  assert.equal(typeof baseline.version, 'number');
  assert.ok(
    Object.keys(baseline.fingerprints).length > 0,
    'baseline fingerprints must be non-empty (regenerate with --update-baseline)',
  );
  const run = spawnSync(
    process.execPath,
    [
      runner,
      ...lintDupRoots(),
      '--reporters',
      'silent',
      '--baseline',
      '.jscpd-baseline.json',
      '--fail-on-new-clones',
      '0',
      '--fail-on-empty',
      '--no-colors',
    ],
    { cwd: root, encoding: 'utf8', timeout: 120_000 },
  );
  assert.equal(
    run.status,
    0,
    `new duplication (or a broken gate config) detected:\n${run.stdout}\n${run.stderr}\n` +
      'run `npm run lint:dup -- --baseline .jscpd-baseline.json --fail-on-new-clones 0` for the clone list; ' +
      'if the new duplication is intentional (moved-not-deleted, edits inside a baselined region, or deliberate ' +
      'test repetition), run `npm run format` first (fingerprints are whitespace-sensitive), then regenerate with ' +
      '`npm run lint:dup -- --baseline .jscpd-baseline.json --update-baseline` and commit the file',
  );
});

test('package-lock.json fetch origins are registry.npmjs.org only', () => {
  // A developer-local npm registry (e.g. the Huawei mirror the README
  // suggests) leaks into committed lockfiles: installs record the mirror's
  // URLs in `resolved`, and every CI `npm ci` then fetches from whatever
  // the lockfile names — silently, with nothing red. The jscpd install
  // captured 9 mirror URLs that way; this guard turns any re-capture into
  // a failing test instead of a latent third-party fetch dependency.
  const lock = readJson(join(root, 'package-lock.json')) as PackageLock;
  const resolved: Array<{ path: string; url: string }> = [];
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (typeof entry.resolved === 'string') resolved.push({ path, url: entry.resolved });
  }
  assert.ok(resolved.length > 0, 'package-lock.json must record resolved URLs');
  for (const { path, url } of resolved) {
    assert.match(
      url,
      /^https:\/\/registry\.npmjs\.org\//,
      `${path} resolves from ${url} — a mirror-configured npm captured its own origin into the lockfile; ` +
        're-resolve with `npm install --package-lock-only --registry=https://registry.npmjs.org/ <pkg>` and commit',
    );
  }
});

test('the safety skill documents the secret vault and its reference is not a dead end', () => {
  const skill = readSource(join('src', 'packs', 'core', 'skills', 'huaweicloud-safety', 'SKILL.md'));
  const reference = readSource(
    join('src', 'packs', 'core', 'skills', 'huaweicloud-safety', 'references', 'secrets.md'),
  );
  // SKILL.md routes to the reference; the reference actually covers the
  // ref model, the agent-side exec path, the deny on secret get, and the
  // honest security boundary (cross-skill references must not dead-end).
  assert.match(skill, /references\/secrets\.md/);
  assert.match(reference, /secret:\/\/<scope>\/<name>/);
  assert.match(reference, /secret exec --env/);
  assert.match(reference, /secret get/);
  assert.match(reference, /NOT defend/);
});

test('auth reconcile propagates through syncAuth (the seam-tested fan-out)', () => {
  // cmdAuthReconcile once hand-rolled the S1→S2/S3 propagation with a raw
  // readGlobalCredentials() and wrote literal secret:// refs into
  // ~/.obsutilconfig and the KooCLI profile. Delegation to syncAuth is the
  // structural fix; this guard pins it so the propagation cannot be
  // re-hand-rolled off the seam.
  const setup = readSource(join('src', 'setup-cli.ts'));
  const reconcileBody = setup.slice(
    setup.indexOf('async function cmdAuthReconcile'),
    setup.indexOf('async function cmdAuthSync'),
  );
  assert.match(reconcileBody, /syncAuth\(/);
  assert.doesNotMatch(reconcileBody, /writeObsConfig\(/, 'reconcile must not hand-roll the OBS fan-out');
  assert.doesNotMatch(reconcileBody, /runHcloudConfigure\(/, 'reconcile must not hand-roll the KooCLI fan-out');
});

test('no conflict-marker residue survives in tracked text files (prettier-laundered forms included)', () => {
  // A rebase resolution once left a `>>>>>>> <hash>` marker in docs/CHANGELOG.md;
  // the subsequent format pass rewrote it into a 7-deep nested blockquote
  // ("> > > > > > > <hash>"), so markdownlint, format:check, and every bare
  // `grep '<<<<<<<'` sweep went blind on it. This guard scans all tracked
  // text files for BOTH shapes: raw git markers and the formatter-normalized
  // blockquote spelling (stacked quote markers followed by a commit-hash-
  // shaped token — legitimate prose never stacks 3+ nested quotes).
  const tracked = spawnSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' })
    .stdout!.split('\n')
    .filter(Boolean)
    .filter((f) => /\.(ts|mjs|cjs|js|json|md|py|yml|yaml|sh|txt)$/.test(f));
  const rawMarker = /^(<{7}|={7}|>{7})( |$)/;
  const launderedMarker = /^(?:>\s?){3,}[0-9a-f]{7,}(\s|$)/;
  const offenders: string[] = [];
  for (const file of tracked) {
    const path = join(root, file);
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      if (rawMarker.test(line) || launderedMarker.test(line)) {
        offenders.push(`${file}: ${line.slice(0, 60)}`);
        break;
      }
    }
  }
  assert.deepEqual(offenders, [], 'conflict-marker residue found');
});
