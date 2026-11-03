import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { TOOL_DEFINITIONS } from '../plugins/huaweicloud-core/src/tools.ts';
import { listSkillDirs } from '../plugins/huaweicloud-core/src/lib/skill-tree.ts';
import type { PackageJson } from './structure-helpers.ts';
import { pluginRoot, readJson, readSource, root } from './structure-helpers.ts';

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
  // The 2026-11-03 nightly refusal-consent red: the agent read the user's
  // standing "just execute" instruction as grant consent and self-granted
  // manage_policy add. The taught consent is for the grant, asked after
  // the refusal — a standing task instruction never covers it.
  assert.match(
    skill,
    /standing go-ahead for the task is not consent for a policy write/,
    'standing task instructions are excluded from grant consent',
  );
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

test('the served gateway_call description scopes grant consent to a post-refusal confirmation', async () => {
  // The 2026-11-03 nightly (run 41636889890) refusal-consent red: the
  // agent read the user's standing "just execute" instruction as the
  // in-conversation confirmation the consent flow teaches, and
  // self-granted manage_policy add. The description now names what the
  // confirmation is FOR and WHEN: the grant, after the refusal — never a
  // standing task instruction.
  const gatewayCall = TOOL_DEFINITIONS.find((tool) => tool.name === 'huaweicloud_gateway_call');
  assert.ok(gatewayCall, 'huaweicloud_gateway_call must exist in TOOL_DEFINITIONS');
  assert.match(
    gatewayCall.description,
    /confirm the grant with the user in conversation after the refusal/,
    'the consent object and timing are named',
  );
  assert.match(
    gatewayCall.description,
    /a standing go-ahead for the task is not consent for a policy write/,
    'a standing task instruction is excluded from grant consent',
  );
});

function listSkillDirsAll(): string[] {
  const skillsDir = join(pluginRoot, 'skills');
  return listSkillDirs(skillsDir).map((name) => join(skillsDir, name));
}

test('huawei-cloud-deployment-task-management skill uses verified KooCLI service and operation names', () => {
  // S4 adoption: the corpus pins, re-derived from main's verified skill
  // (KooCLI 7.2.12). The legacy thin skill's --app_id / DeleteApplication
  // match pins were dropped — those tokens now appear only inside the
  // sunset/replacement notes naming the new-model equivalents.
  // APIGW.0301 IS taught (the auth-failure row); Deploy.00016902 /
  // DEV-12-50002 are the project-scope / parameter errors, not auth.
  const body = readSource(
    join('src', 'packs', 'huaweicloud-cli', 'skills', 'huawei-cloud-deployment-task-management', 'SKILL.md'),
  );
  assert.match(body, /CodeArtsDeploy/);
  assert.match(body, /StartDeployTask/);
  assert.match(body, /ListAllApp/);
  assert.match(body, /CreateDeployTaskByTemplate/);
  assert.match(body, /DeleteDeployTask/);
  assert.match(body, /Deploy\.00016902/);
  assert.match(body, /DEV-12-50002/);
  assert.match(body, /APIGW\.0301/);
  assert.match(body, /不支持的服务名称:CloudDeploy/);
  assert.match(body, /sunset after 2024-09-30/);
  assert.doesNotMatch(body, /--application_id/);
  assert.doesNotMatch(body, /--app_name/);
  assert.doesNotMatch(body, /\bStartTask\b/);
  assert.doesNotMatch(body, /\bListTasks\b/);
  assert.doesNotMatch(body, /\bCreateTask\b/);
  assert.doesNotMatch(body, /\bDeleteTask\b/);
});

test('huawei-obs teaches the Content-Disposition trap and the website-config tool (#899)', () => {
  const pitfalls = readFileSync(
    join(pluginRoot, 'src', 'packs', 'obs', 'skills', 'huawei-obs', 'references', 'common-pitfalls.md'),
    'utf8',
  );
  assert.match(pitfalls, /Content-Disposition 强制下载陷阱（2022-01-01 后创建的桶）/);
  assert.match(pitfalls, /attachment.*强制注入/s);
  assert.match(pitfalls, /HEAD.*误导/s);
  assert.match(pitfalls, /自定义域名 \+ CDN（\+ header 配置 inline）是\*\*必要条件/);
  assert.match(pitfalls, /obsutil 元数据大小写陷阱/);
  assert.match(pitfalls, /x-amz-meta-content-disposition/);
  // The MCP tool is now the FIRST listed path for static-website config.
  assert.match(pitfalls, /huaweicloud_obs_set_website_config`（插件内置/);

  const staticSite = readFileSync(
    join(pluginRoot, 'src', 'packs', 'obs', 'skills', 'huawei-obs', 'references', 'static-website.md'),
    'utf8',
  );
  assert.match(staticSite, /huaweicloud_obs_set_website_config tool/);
});

test('huawei-ecs carries the windows-ssh reference and the ssh-keygen passphrase fix', () => {
  const skill = readFileSync(
    join(pluginRoot, 'src', 'packs', 'huaweicloud-cli', 'skills', 'huawei-ecs', 'SKILL.md'),
    'utf8',
  );
  assert.match(skill, /Windows Login \/ Upload \(standard paths\)/);
  assert.match(skill, /references\/windows-ssh\.md/);
  assert.ok(
    existsSync(
      join(pluginRoot, 'src', 'packs', 'huaweicloud-cli', 'skills', 'huawei-ecs', 'references', 'windows-ssh.md'),
    ),
    'windows-ssh.md must exist',
  );

  const create = readFileSync(
    join(pluginRoot, 'src', 'packs', 'huaweicloud-cli', 'skills', 'huawei-ecs', 'references', 'create-instance.md'),
    'utf8',
  );
  // bash uses -N ''; PowerShell uses --% + -N "" — no COMMAND line carries
  // -N '""' (the trap comment names it, commands never use it).
  assert.match(create, /-N ''/);
  assert.match(create, /ssh-keygen --% -t rsa -b 2048 -f \.\\<name> -N ""/);
  for (const line of create.split('\n')) {
    if (/^\s*ssh-keygen/.test(line)) {
      assert.doesNotMatch(line, /-N '""'/, `command line must not set a literal passphrase: ${line.trim()}`);
    }
  }

  const flavors = readFileSync(
    join(pluginRoot, 'src', 'packs', 'huaweicloud-cli', 'skills', 'huawei-ecs', 'references', 'flavors.md'),
    'utf8',
  );
  assert.match(flavors, /cond:operation:status` vs `cond:operation:az/);
  assert.match(flavors, /\*\*The AZ-level field \(`cond:operation:az`\) WINS for the target AZ\*\*/);
  assert.match(flavors, /Ecs\.0707/);
});

test('huawei-iac stage 5 intercepts orders the balance cannot cover (#922)', () => {
  const iac = readFileSync(
    join(pluginRoot, 'src', 'packs', 'huaweicloud-cli', 'skills', 'huawei-iac', 'SKILL.md'),
    'utf8',
  );
  assert.match(iac, /前置拦截（实测 #922）：估算成本 > 余额（含余额为 0）时 STOP/);
  assert.match(iac, /resume from stage 5 with the SAME configuration/);
  assert.match(iac, /never walk a known-doomed order/);
  assert.match(iac, /the gate INTERCEPTS before the order/);
});

test('huawei-sandbox carries the tunnel contract, the 401 trap, and the Step 0/1 hardening', () => {
  const sandbox = readFileSync(
    join(pluginRoot, 'src', 'packs', 'sandbox', 'skills', 'huawei-sandbox', 'SKILL.md'),
    'utf8',
  );
  // Workspace URL vs public share link (401 trap).
  assert.match(sandbox, /Workspace URL vs public share link \(401 trap — do not confuse them\)/);
  assert.match(sandbox, /returns \*\*401 Unauthorized\*\*/);
  assert.match(sandbox, /A \*\*publicly shareable address is ONLY the DevBridge tunnel URL\*\*/);
  // Step 0 Layer 3: direct GitHub release tar.gz.
  assert.match(sandbox, /Layer 3 \(both installer paths failed\): direct GitHub release tar\.gz/);
  assert.match(sandbox, /api\.github\.com\/repos\/huaweicloud\/devspace-devbridge\/releases\/latest/);
  // API-Key 前置引导 at the credentials step.
  assert.match(sandbox, /DevBridge API Key 前置引导（before expose, not mid-expose）/);
});

test('KooCLI 7.3.12 pin: the OBS website/cors capability claims are current, not stale', () => {
  // The bump swept the pre-7.3.12 "KooCLI OBS lacks website config" family out of
  // the skills — this guard keeps it out (the exact intra-file half-drift mode a
  // copy pass would reintroduce) and pins the new teaching on the hot surfaces.
  // U0-informed: the cors phrasings main actually ships (its 7.2.x-measured
  // claim) must not survive a copy pass — the pinned 7.3.12 live-serves the
  // cors subcommand; the dual-path doctrine is the only true teaching.
  const staleClaim =
    /KooCLI OBS does NOT support this|obsutil has no website command|lacks website config|未暴露 obsutil 的 .?cors.? 子命令|has no cors subcommand|does not expose a cors subcommand|不支持 cors 子命令/;
  const surfaces = [
    join(pluginRoot, 'src', 'packs', 'obs', 'skills', 'huawei-obs', 'SKILL.md'),
    join(pluginRoot, 'src', 'packs', 'obs', 'skills', 'huawei-obs', 'references', 'static-website.md'),
    join(pluginRoot, 'src', 'packs', 'obs', 'skills', 'huawei-obs', 'references', 'bucket-lifecycle.md'),
    join(pluginRoot, 'src', 'packs', 'obs', 'skills', 'huawei-obs', 'references', 'common-pitfalls.md'),
    join(pluginRoot, 'src', 'packs', 'huaweicloud-cli', 'skills', 'huawei-iac', 'SKILL.md'),
    join(pluginRoot, 'src', 'packs', 'huaweicloud-cli', 'skills', 'huawei-iac', 'references', 'resource-catalog.md'),
    join(pluginRoot, 'src', 'packs', 'obs', 'tools.ts'),
  ];
  for (const surface of surfaces) {
    const text = readFileSync(surface, 'utf8');
    assert.doesNotMatch(text, staleClaim, `${surface}: the pre-7.3.12 stale claim must not return`);
  }
  const obsSkill = readFileSync(join(pluginRoot, 'src', 'packs', 'obs', 'skills', 'huawei-obs', 'SKILL.md'), 'utf8');
  assert.match(obsSkill, /KooCLI 7\.3\.12\+ has `hcloud OBS website/);
  assert.match(obsSkill, /KooCLI 7\.3\.12\+ has `hcloud OBS cors/);
  const staticSite = readFileSync(
    join(pluginRoot, 'src', 'packs', 'obs', 'skills', 'huawei-obs', 'references', 'static-website.md'),
    'utf8',
  );
  assert.match(staticSite, /7\.2\.x has no such command/);
  const iacRow = readFileSync(
    join(pluginRoot, 'src', 'packs', 'huaweicloud-cli', 'skills', 'huawei-iac', 'SKILL.md'),
    'utf8',
  );
  assert.match(iacRow, /KooCLI 7\.3\.12\+ ships `hcloud OBS website/);
});

test('the #935/#971 ECS+iac field knowledge keeps its live-verified command forms', () => {
  // The 1.1.10/1.1.12 wave was ported from main with every command dry-run
  // verified against the pinned 7.3.12 binary — main's own forms USE_ERROR on
  // it (missing required params, v2-era flag names, wrong operation names).
  // Main still carries the broken forms, so a future sync copy pass is the
  // concrete regression vector; these pins keep the corrected doctrine in.
  const iac = readFileSync(
    join(pluginRoot, 'src', 'packs', 'huaweicloud-cli', 'skills', 'huawei-iac', 'SKILL.md'),
    'utf8',
  );
  const ecsCreate = readFileSync(
    join(pluginRoot, 'src', 'packs', 'huaweicloud-cli', 'skills', 'huawei-ecs', 'references', 'create-instance.md'),
    'utf8',
  );
  const ecsTrouble = readFileSync(
    join(pluginRoot, 'src', 'packs', 'huaweicloud-cli', 'skills', 'huawei-ecs', 'references', 'troubleshooting.md'),
    'utf8',
  );
  const ecsWin = readFileSync(
    join(pluginRoot, 'src', 'packs', 'huaweicloud-cli', 'skills', 'huawei-ecs', 'references', 'windows-ssh.md'),
    'utf8',
  );
  // UpdateSubnet requires --vpc_id + --subnet.name on 7.3.12, and the DNS
  // pair is cn-north-4's, not universal (main's rows omit both facts).
  for (const [label, text] of [
    ['iac SKILL.md', iac],
    ['create-instance.md', ecsCreate],
  ] as const) {
    assert.match(
      text,
      /--vpc_id=<vpc-id> --subnet_id=<(?:subnet-)?id> --subnet\.name=<name>/,
      `${label}: the UpdateSubnet DNS pre-fix must carry the required params`,
    );
    assert.doesNotMatch(
      text,
      /UpdateSubnet --subnet_id=[^ ]+ --subnet\.dnsList/,
      `${label}: the bare main form (USE_ERRORs on 7.3.12) must not return`,
    );
  }
  // The cash-balance risk-control doctrine (vouchers do not participate).
  assert.match(iac, /代金券不参与按量付费下单风控/);
  // v3 CreateSecurityGroupRule takes multiport; the v2-era port_range pair
  // must not appear as a command flag (the explanatory mention is fine).
  assert.match(ecsWin, /security_group_rule\.multiport=22/);
  for (const [label, text] of [
    ['windows-ssh.md', ecsWin],
    ['troubleshooting.md', ecsTrouble],
  ] as const) {
    assert.doesNotMatch(
      text,
      /security_group_rule\.port_range_(?:min|max)=/,
      `${label}: the v2-era flag form must not return as a command`,
    );
  }
  // ListSecurityGroupRules v3 takes the array form; the job-status operation
  // is ECS ShowJob (NovaShowJob is a wrong spelling); ListServersDetails
  // filters by --server_id (never a bare --id).
  assert.match(ecsTrouble, /--security_group_id\.1=<sg-id>/);
  assert.doesNotMatch(ecsTrouble, /ListSecurityGroupRules --security_group_id=(?!\.)/);
  assert.match(ecsTrouble, /ECS ShowJob --job_id=<job-id>/);
  assert.match(ecsTrouble, /ListServersDetails[^\n]*--server_id=/);
  assert.doesNotMatch(ecsTrouble, /ListServersDetails [^\n]* --id=/);
});

test('huawei-iam skill documents the validated primary-account judgment rule (#954)', () => {
  const body = readFileSync(
    join(pluginRoot, 'src', 'packs', 'huaweicloud-cli', 'skills', 'huawei-iam', 'SKILL.md'),
    'utf8',
  );
  assert.match(body, /username == domainName/);
  assert.match(body, /huaweicloud_check_account_type/);
  // Both disproved judgment rules must be named so they are not rediscovered.
  assert.match(body, /ShowDomainPasswordPolicy/);
  assert.match(body, /principal_id == account_id/);
  // The #935 SELF_VERIFY self-agency pre-creation trap (newly ported with #954)
  // — the ListAgencies check-before-create order is the part that matters.
  assert.match(body, /SELF_VERIFY/);
  assert.match(body, /ListAgencies/);
  assert.match(body, /check_account_type for primary\/sub-account judgment/);

  const quickRef = readFileSync(
    join(pluginRoot, 'src', 'packs', 'huaweicloud-cli', 'skills', 'huawei-iam', 'references', 'quick-ref.md'),
    'utf8',
  );
  assert.match(quickRef, /STS GetCallerIdentity/);
  assert.match(quickRef, /KeystoneListAuthDomains/);
  assert.match(quickRef, /username == domainName/);
  assert.match(quickRef, /assumed-agency/);
});

test('huawei-voucher covers HDKIT_COMPETITION_NOT_CONFIGURED', () => {
  const voucher = readFileSync(
    join(pluginRoot, 'src', 'packs', 'voucher', 'skills', 'huawei-voucher', 'SKILL.md'),
    'utf8',
  );
  assert.match(voucher, /HDKIT_COMPETITION_NOT_CONFIGURED/);
  assert.match(voucher, /服务端活动参数未配置/);
  assert.match(voucher, /告知赛事代金券暂未开放，稍后再试/);
  // The 1.1.11/1.1.12-next wave (ported from main, version 5): the real-name
  // dedup doctrine, the claimed-prefix widening, and the three new code rows.
  // The config-error rows must appear in BOTH tables (incentive + competition)
  // — a one-table drift is the half-merge failure mode.
  assert.match(voucher, /HDKIT_NOT_CODEARTS_OFFICEACE_USER/);
  for (const code of ['HDKIT_VOUCHER_NOT_CONFIGURED', 'HDKIT_VOUCHER_EXPIRE_INVALID']) {
    const hits = voucher.split(code).length - 1;
    assert.equal(hits, 2, `${code} must appear in both the incentive and competition tables`);
  }
  assert.match(voucher, /以实名认证信息为维度限领一次/);
  assert.match(voucher, /同实名账号共享额度/);
  assert.match(voucher, /以「已领取」开头/);
  // The retired per-account doctrine must not return — the real-name
  // dimension is the corrected semantics (a user whose sibling account under
  // the same real-name claimed must not be told "this account never claimed").
  assert.doesNotMatch(voucher, /每个账号（domain_id）仅可领取一次/);
});

test('web/static-site deployment intent offers target options with sandbox first, not OBS default (#918)', () => {
  // #918: the gate is now MANDATORY on all four surfaces — the options must be
  // presented via the `question` tool, never inferred; static-hosting/CDN
  // intent cannot bypass the obs gate; the sandbox option carries the OBS
  // custom-domain reminder and the ECS EIP pairing reminder.
  const core = readFileSync(join(pluginRoot, 'skills', 'huaweicloud-core', 'SKILL.md'), 'utf8');
  assert.match(core, /Deployment Target Options \(MANDATORY GATE — do not skip\)/);
  assert.match(core, /via the `question` tool \(the host agent's interactive-question tool/);
  assert.match(core, /NEVER infer or default the target/);
  assert.match(core, /is NOT a named target — still run the gate/);
  assert.match(core, /custom domain \(域名\) must be prepared/);
  assert.match(core, /EIP \(弹性公网IP\) for public access — extra billing/);

  const obs = readFileSync(join(pluginRoot, 'src', 'packs', 'obs', 'skills', 'huawei-obs', 'SKILL.md'), 'utf8');
  assert.match(obs, /Routing Guard: Deploy vs Store/);
  assert.match(obs, /via the `question` tool/);
  assert.match(obs, /NEVER infer or default the target/);
  // The static-hosting/CDN intent bypass is CLOSED: only a named target or a
  // question-gate selection proceeds.
  assert.match(obs, /cannot bypass the gate/);
  assert.match(obs, /① huawei-sandbox \(recommended\)/);

  const sandbox = readFileSync(
    join(pluginRoot, 'src', 'packs', 'sandbox', 'skills', 'huawei-sandbox', 'SKILL.md'),
    'utf8',
  );
  assert.match(sandbox, /present options, sandbox first/i);
  assert.match(sandbox, /建议优先部署到沙箱/);
  assert.match(sandbox, /需提前准备好自定义域名/);
  assert.match(sandbox, /需搭配弹性公网IP\/EIP/);

  const discovery = readFileSync(join(pluginRoot, 'skills', 'huaweicloud-capability-discovery', 'SKILL.md'), 'utf8');
  assert.match(discovery, /Deployment Target Options \(MANDATORY — use the `question` tool\)/);
  assert.match(discovery, /NEVER infer or default the target/);
});
