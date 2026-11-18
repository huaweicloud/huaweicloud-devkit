import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { getToolSchema } from '../plugins/huaweicloud-core/src/tool-schemas.ts';
import { SKILLS_ROOT, TOOL_DEFINITIONS, VENDOR_GATED_TOOLS } from '../plugins/huaweicloud-core/src/tools.ts';
import { instructionsFor } from '../plugins/huaweicloud-core/src/mcp-protocol.ts';
import { VOUCHER_TOOLS } from '../plugins/huaweicloud-core/src/packs/voucher/tools.ts';
import { pluginRoot, readSource, root } from './structure-helpers.ts';

test('core meta-skills teach the skillRoot direct read as the default with retrieve_skill as the fallback', () => {
  // The dual-path contract: list_skills discloses the tree's location on
  // stdio sessions, and both routing skills teach the attempt-first
  // direct read as the default with retrieve_skill as the fallback when
  // the attempted read fails or is denied. The references/ assertion is
  // co-occurrence-anchored (same line as skillRoot) so it pins the teaching
  // line, not the pre-existing step-2 "Read references/{sub-skill-id}.md".
  // The order pins anchor on the "otherwise" fallback connector (not a
  // bare retrieve mention, which any phrasing could satisfy) so a
  // retrieve-first regression cannot pass. Scope is the two hot lines
  // (core step 3, discovery step 3); Tool Boundary's line is deliberately
  // outside — its "read the chosen skill's SKILL.md" phrasing is what
  // keeps this anchor from matching it, so do not harmonize the two
  // wordings. New SKILL.md copy must keep avoiding see/load followed by a
  // backticked non-skill identifier — the cross-reference guard resolves
  // those against the skills tree.
  const core = readFileSync(join(pluginRoot, 'skills', 'huaweicloud-core', 'SKILL.md'), 'utf8');
  assert.match(core, /skillRoot/, 'huaweicloud-core must teach the skillRoot direct-read path');
  assert.match(
    core,
    /skillRoot[^\n]*references\//,
    'the direct-read line must name the references directory beside skillRoot',
  );
  assert.match(
    core,
    /read the skill's SKILL\.md[^\n]*otherwise[^\n]{0,20}load/,
    'the hot line must lead with the direct read and close with the otherwise-fallback',
  );

  const discovery = readFileSync(join(pluginRoot, 'skills', 'huaweicloud-capability-discovery', 'SKILL.md'), 'utf8');
  assert.match(discovery, /skillRoot/, 'huaweicloud-capability-discovery must teach the skillRoot direct-read path');
  assert.match(
    discovery,
    /skillRoot[^\n]*references\//,
    'the discovery teaching line must name the references directory beside skillRoot',
  );
  assert.match(
    discovery,
    /read the skill's SKILL\.md[^\n]*otherwise[^\n]{0,20}load/,
    'the discovery chain must lead with the direct read and close with the otherwise-fallback',
  );
});

test('agent rules file ships with the server payload (#758 D4-23)', () => {
  const pkg = readFileSync(join(root, 'package.json'), 'utf8');

  // The rules file had content and tests but zero install references — the
  // injection rides copyServerPayload (the one shared payload seam, covering
  // every install/update call site), with remove-then-copy convergence and a
  // loud abort when the source is missing (the silent-skip is the bug class).
  // After the upstream payload-machinery extraction (2a41b07), the seam lives
  // in the payload family — src/payload-placement.ts since the install-payload
  // split — the guard follows the canonical home.
  const payload = readSource(join('src', 'payload-placement.ts'));
  assert.match(payload, /function injectAgentRules\(pluginDest: string\): void/);
  assert.match(payload, /injectAgentRules\(pluginDest\);\n {2}if \(!opts\.skipDist\)/);
  assert.match(payload, /const AGENT_RULES_FILE = 'huawei-agent-rules\.mdc';/);
  assert.match(payload, /rmSync\(rulesDest, \{ force: true \}\);/);
  assert.match(payload, /copyFileVerified\(rulesSrc, rulesDest\)/);
  assert.match(payload, /agent rules file missing at/);
  // And the npm tarball actually carries it (the files allowlist).
  assert.match(pkg, /"rules",/);
});

test('agent rules file carries the skillRoot direct-read teaching', () => {
  // The rules file is agent-loaded copy with no other guard coverage; this
  // presence pin keeps its skillRoot teaching from silently vanishing in a
  // copy pass (word order there is unpinned by design — the hot lines own
  // the order contract).
  const rules = readFileSync(join(root, 'rules', 'huawei-agent-rules.mdc'), 'utf8');
  assert.match(rules, /skillRoot/, 'the agent rules file must teach the skillRoot direct-read path');
});

test('the action-first load teaching survives copy passes on every load-path surface', () => {
  // One presence pin per clause-carrying surface outside instructionsFor
  // and the retrieve_skill description (both pinned in their own tests):
  // the two routing skills' bodies, the rules file, the doctor command,
  // the list_skills description, and the hermes manifest — the two extra
  // pins close the drift window the a60ab5b guard family left open. Two
  // vocabularies pinned per file: the attempt-first imperative (attempt
  // the direct read — no reachability pre-check) and the reactive
  // fallback (fails or is denied -> load via retrieve_skill) — a copy
  // pass reverting either in any one file would keep every other gate
  // green, the exact one-file-at-a-time drift mode the telemetry-hooks
  // sweep documented.
  const attemptFirst = /attempt the direct read/;
  const reactive = /fails or is denied/;
  const core = readFileSync(join(pluginRoot, 'skills', 'huaweicloud-core', 'SKILL.md'), 'utf8');
  assert.match(core, attemptFirst, 'huaweicloud-core must teach the attempt-first imperative');
  assert.match(core, reactive, 'huaweicloud-core must teach the reactive permission fallback');
  const discovery = readFileSync(join(pluginRoot, 'skills', 'huaweicloud-capability-discovery', 'SKILL.md'), 'utf8');
  assert.match(discovery, attemptFirst, 'capability-discovery must teach the attempt-first imperative');
  assert.match(discovery, reactive, 'capability-discovery must teach the reactive permission fallback');
  const rules = readFileSync(join(root, 'rules', 'huawei-agent-rules.mdc'), 'utf8');
  assert.match(rules, attemptFirst, 'the agent rules file must teach the attempt-first imperative');
  assert.match(rules, reactive, 'the agent rules file must teach the reactive permission fallback');
  const doctor = readFileSync(join(root, 'integrations', 'opencode', 'commands', 'huaweicloud-doctor.md'), 'utf8');
  assert.match(doctor, attemptFirst, 'the doctor command must teach the attempt-first imperative');
  assert.match(doctor, reactive, 'the doctor command must teach the reactive permission fallback');
  // The description literals moved to src/tool-definitions.ts in the
  // tools.ts split; the vocabulary pin follows the registry's canonical
  // home (the exported TOOL_DEFINITIONS value still flows through the
  // tools.ts re-export face the import at the top of this file targets).
  const tools = readSource(join('src', 'tool-definitions.ts'));
  const listSkillsDescription = TOOL_DEFINITIONS.find((tool) => tool.name === 'huaweicloud_list_skills');
  assert.ok(listSkillsDescription, 'the list_skills definition must exist');
  assert.match(
    listSkillsDescription.description,
    attemptFirst,
    'the list_skills description must teach the attempt-first imperative',
  );
  assert.match(
    listSkillsDescription.description,
    reactive,
    'the list_skills description must teach the reactive permission fallback',
  );
  // Root disambiguation pins (the 2026-10-23 measured miss): the two
  // routing skills' step-3 load paths and the list_skills description
  // (the tool that carries skillRoot) each name the only-service-skill-root
  // rule — a copy pass reverting any one keeps the others green.
  const rootDisambiguation = /never guess a service skill's path by analogy to it/;
  assert.match(core, rootDisambiguation, 'huaweicloud-core must teach the root disambiguation');
  assert.match(discovery, rootDisambiguation, 'capability-discovery must teach the root disambiguation');
  // The description string escapes its apostrophe (\u2019 house style for
  // single-quoted TS literals), so its pin matches the curly form; the
  // markdown/manifest pins match the straight form their files carry.
  assert.match(
    listSkillsDescription.description,
    /never guess a service skill\u2019s path by analogy to it/,
    'the list_skills description must teach the root disambiguation (it was the tool in flight when the measured miss fired)',
  );
  assert.match(
    listSkillsDescription.description,
    /ONLY root for pack-owned service skills/,
    'the list_skills description must scope skillRoot to pack-owned service skills',
  );
  // The sequencing half of the measured miss (the guessed read fired IN
  // PARALLEL with list_skills): pinned on both routing skills and the
  // hermes manifest (a native-copy harness where the failure transfers
  // verbatim) — a copy pass reverting the sequencing sentence while
  // keeping the guess prohibition must not stay green.
  const noParallelGuess = /guessed read in parallel with/;
  assert.match(core, noParallelGuess, 'huaweicloud-core must teach the no-parallel-guess sequencing');
  assert.match(discovery, noParallelGuess, 'capability-discovery must teach the no-parallel-guess sequencing');
  const hermes = readFileSync(join(root, 'integrations', 'hermes', 'manifest.yaml'), 'utf8');
  assert.match(
    hermes,
    rootDisambiguation,
    'the hermes manifest must teach the root disambiguation (hermes is a native-copy harness)',
  );
  assert.match(hermes, noParallelGuess, 'the hermes manifest must teach the no-parallel-guess sequencing');
  const manifest = readFileSync(join(root, 'integrations', 'hermes', 'manifest.yaml'), 'utf8');
  assert.match(manifest, attemptFirst, 'the hermes manifest must teach the attempt-first imperative');
  assert.match(manifest, reactive, 'the hermes manifest must teach the reactive permission fallback');
  assert.doesNotMatch(
    manifest,
    /file tools reach/,
    'the hermes manifest must not carry the old conditional in ANY section (the description field and post_install block are one file)',
  );
  assert.match(tools, /fails or is denied/, 'the source carries the trigger vocabulary the pins grep for');
});

test('the vendor boundary survives copy passes on every disclosure surface', () => {
  // Measured failure (live probe, 2026-10-23): every disclosure surface
  // conditioned on "the task IS a Huawei Cloud task" while none defined
  // what makes it one. One presence pin per clause-carrying surface
  // outside instructionsFor (pinned in the three-form test): the core
  // routing skill's description and STOP guard, the capability-discovery
  // description (its scenario-shaped trigger was vendor-neutral), the
  // service_catalog description (its Start-here vocabulary list taught
  // availability-as-intent), the voucher_status description (its
  // session-start teaching fired before any vendor was established), the
  // huawei-voucher SKILL (the catalog entry list_skills serves — same
  // teaching, second surface), the huawei-sandbox SKILL (its
  // deployment-shaped triggers were vendor-neutral), and the hermes
  // manifest's example prompts (they taught the ambiguity anti-pattern
  // to new users). A copy pass reverting any one surface keeps every
  // other gate green — the one-file-at-a-time drift mode the load-path
  // pin family documented.
  const core = readFileSync(join(pluginRoot, 'skills', 'huaweicloud-core', 'SKILL.md'), 'utf8');
  assert.match(
    core,
    /service vocabulary alone \(ECS, VPC, RDS\) is not vendor evidence/,
    'the core skill description must carry the vendor gate',
  );
  assert.match(
    core,
    /ask the user which cloud they mean before operating on cloud resources/,
    'the core skill STOP guard must demand the vendor question',
  );
  const discovery = readFileSync(join(pluginRoot, 'skills', 'huaweicloud-capability-discovery', 'SKILL.md'), 'utf8');
  assert.match(
    discovery,
    /scenario shape alone is not vendor evidence/,
    'the capability-discovery description must gate its scenario-shaped trigger',
  );
  const serviceCatalog = TOOL_DEFINITIONS.find((tool) => tool.name === 'huaweicloud_service_catalog');
  assert.ok(serviceCatalog, 'the service_catalog definition must exist');
  assert.match(
    serviceCatalog.description,
    /is not vendor evidence/,
    'the service_catalog description must not teach availability-as-intent',
  );
  const voucherStatus = VOUCHER_TOOLS.find((tool) => tool.name === 'huaweicloud_voucher_status');
  assert.ok(voucherStatus, 'the voucher_status definition must exist');
  assert.match(
    voucherStatus.description,
    /厂商未定/,
    'the voucher_status description must not fire its session-start teaching before a vendor is established',
  );
  const voucherSkill = readFileSync(join(pluginRoot, 'skills', 'huawei-voucher', 'SKILL.md'), 'utf8');
  assert.match(
    voucherSkill,
    /厂商未定/,
    'the huawei-voucher skill (the catalog entry list_skills serves) must carry the same vendor gate as the tool',
  );
  assert.doesNotMatch(
    voucherSkill,
    /场景默认执行"先查后提示"：会话开始/,
    'the huawei-voucher proactive rule must not list an unconditional session-start trigger',
  );
  const sandboxSkill = readFileSync(join(pluginRoot, 'skills', 'huawei-sandbox', 'SKILL.md'), 'utf8');
  assert.match(
    sandboxSkill,
    /deployment\/website vocabulary alone is not vendor evidence/,
    'the huawei-sandbox description must gate its deployment-shaped triggers',
  );
  assert.match(
    sandboxSkill,
    /settle the vendor first/,
    'the huawei-sandbox proactive offering must route unknown-vendor tasks out of scope',
  );
  const manifest = readFileSync(join(root, 'integrations', 'hermes', 'manifest.yaml'), 'utf8');
  assert.match(
    manifest,
    /ECS instances on Huawei Cloud/,
    'the hermes manifest ECS example prompt must name the vendor (it teaches first tasks to new users)',
  );
  assert.match(manifest, /to Huawei Cloud OBS/, 'the hermes manifest OBS example prompt must name the vendor too');
});

test('retrieve_skill reference cap stays in sync between code and description', () => {
  // The description teaches "each reference body capped at N characters";
  // this pins the taught number to the truncation constant so neither can
  // drift silently (the repo's own description-literal pinning pattern).
  // The marker must interpolate the same constant — a restated literal in
  // the marker string drifts independently of the taught cap.
  // The description literal lives in tool-definitions.ts and the
  // truncation constant (REFERENCE_CAP, with the marker that interpolates
  // it) in skill-disclosure.ts's retrieveSkill — the split of the former
  // tools.ts monolith; the pin reads both homes at their canonical
  // locations.
  const definitions = readSource(join('src', 'tool-definitions.ts'));
  const disclosure = readSource(join('src', 'skill-disclosure.ts'));
  const cap = disclosure.match(/const REFERENCE_CAP = (\d+);/)?.[1];
  assert.ok(cap, 'the reference truncation constant must be found');
  assert.match(
    definitions,
    new RegExp(`capped at ${cap} characters`),
    'the retrieve_skill description must teach the actual reference cap',
  );
  assert.ok(
    disclosure.includes('truncated at ${REFERENCE_CAP} chars'),
    'the truncation marker must interpolate the cap constant, not restate it',
  );
  assert.ok(
    !disclosure.includes(`truncated at ${cap} chars`),
    'no literal restatement of the cap may appear in the marker template',
  );
});

test('server instructions carry the three-form skillRoot disclosure contract', () => {
  // The zero-call home of the load path, keyed on the same option pair the
  // tool registry keys on. Full stdio (the production face): path stated
  // outright + enablement caveat ahead of the read invitation + the
  // packs_configure consent sentence naming a tool that face registers.
  // Bare stdio (embedded/test constructions): same location and catalog
  // teaching, but operator-posture enablement — never the toggle's name,
  // never a runtime-mutability claim a face without the toggle cannot
  // honor. Remote: no host path, skillRoot stated as withheld, no
  // packs_configure. The absence rule is scoped to huawei-* service skills
  // on every form: the six huaweicloud-* meta-skills never appear in the
  // catalog (listSkills excludes core by design) yet are always available.
  // Wire-level content pins ride both faces in mcp-server.test.ts and
  // remote-mcp-server.test.ts; this pins the builder's forms directly.
  const full = instructionsFor(false, true);
  assert.ok(full.includes(SKILLS_ROOT), 'the stdio form must state the runtime-resolved tree location');
  assert.match(full, /the skills tree lives at/, 'the stdio form must open with the location sentence');
  assert.match(full, /pack-gated/, 'the stdio form must carry the enablement caveat');
  assert.match(
    full,
    /can change at runtime/,
    'the full stdio form may claim runtime mutability (it registers the toggle)',
  );
  assert.match(full, /huaweicloud_packs_configure/, 'the full stdio form names the session-toggle tool it registers');
  assert.match(full, /huaweicloud_list_skills/, 'the stdio form must name the effective-catalog tool');
  assert.match(
    full,
    /huaweicloud_retrieve_skill instead/,
    'the stdio form must frame retrieve_skill as the instead-of fallback',
  );
  assert.match(full, /huawei-\* service skill absent/, 'the absence rule must be scoped to service skills');
  assert.match(full, /never appear in the catalog and are always available/, 'the meta-skill exclusion must be taught');

  const bare = instructionsFor(false);
  assert.ok(bare.includes(SKILLS_ROOT), 'the bare stdio form still states the tree location');
  assert.doesNotMatch(
    bare,
    /huaweicloud_packs_configure/,
    'a face without the toggle must not be taught the toggle tool',
  );
  assert.doesNotMatch(
    bare,
    /can change at runtime/,
    'a face without the toggle cannot honor a runtime-mutability claim',
  );
  assert.match(bare, /huawei-\* service skill absent/, 'the bare form keeps the scoped absence rule');

  // The action-first load policy: both stdio forms carry it (attempt the
  // direct read first — the attempt itself is the reachability check,
  // never a pre-check, and never retrieve_skill before the attempt; only
  // when the read fails or is denied, load via retrieve_skill, which
  // needs no file access). Measured failure this guards against (operator
  // test, 2026-10-19): the previous conditional invitation ("when your
  // file tools reach the tree") made the model pre-evaluate reachability
  // pessimistically and jump straight to the guaranteed MCP loader
  // without attempting the read. The remote form does not carry it (that
  // face reads no tree; its own loader sentence keeps the fallback
  // framing).
  const remote = instructionsFor(true);
  for (const [label, form] of [
    ['full', full],
    ['bare', bare],
  ] as const) {
    assert.match(
      form,
      /attempt the direct read first/,
      `the ${label} stdio form must teach the attempt-first imperative`,
    );
    assert.match(
      form,
      /the attempt itself is the check/,
      `the ${label} stdio form must teach that attempting is the reachability check`,
    );
    assert.match(
      form,
      /do not call huaweicloud_retrieve_skill before attempting/,
      `the ${label} stdio form must forbid the loader before the attempt`,
    );
    assert.match(
      form,
      /If a direct read of the tree fails or is denied, load the skill with huaweicloud_retrieve_skill instead/,
      `the ${label} stdio form must teach the reactive fallback sentence verbatim`,
    );
    // Root disambiguation (measured miss, 2026-10-23: a session guessed a
    // service skill's path by analogy to the agent-native meta-skill
    // directory and fired the guessed read in parallel with list_skills):
    // both stdio forms name the two roots and the skillRoot-before-first-
    // read sequencing; the remote form teaches no path at all.
    assert.match(
      form,
      /never guess a service skill's path by analogy to it/,
      `the ${label} stdio form must teach the root disambiguation`,
    );
    assert.match(
      form,
      /never fetched in parallel with a guessed one/,
      `the ${label} stdio form must teach skillRoot-before-first-read sequencing`,
    );
    assert.match(form, /it needs no file access/, `the ${label} stdio form must state the loader needs no file access`);
    assert.doesNotMatch(
      form,
      /When your file tools reach the tree/,
      `the ${label} stdio form must not carry the evaluative reachability conditional`,
    );
    // Tool-routing note (measured, 2026-11-13: codex 0.167.2 + a custom
    // OpenAI-compatible provider that drops the `namespace` field — 690 of
    // 692 huaweicloud calls answered `unsupported call` without reaching
    // the devkit, and the model retried the identical call in a spin):
    // both stdio forms teach the signature and the no-retry rule; the
    // remote face rides no harness model wire and stays short.
    assert.match(
      form,
      /unsupported call: <tool>/,
      `the ${label} stdio form must name the harness tool-routing signature`,
    );
    assert.match(
      form,
      /retrying the identical call cannot succeed/,
      `the ${label} stdio form must teach the no-retry rule`,
    );
  }
  assert.doesNotMatch(
    remote,
    /attempt the direct read first/,
    'the remote form reads no tree and must not teach the attempt-first imperative',
  );
  assert.doesNotMatch(
    remote,
    /fails or is denied/,
    'the remote form reads no tree and must not teach the reactive fallback',
  );
  assert.doesNotMatch(remote, /the skills tree lives at/, 'the remote form must not state a host tree path');
  // The root-disambiguation clause is stdio-only (it presupposes the tree
  // path this form withholds); pin the absence so a future branch
  // harmonization cannot teach "the tree location stated above" on the
  // face that states no location.
  assert.doesNotMatch(
    remote,
    /never guess a service skill's path by analogy to it/,
    'the remote form must not carry the stdio root-disambiguation clause',
  );
  // The tool-routing note is stdio-only (its failure mode lives on a
  // harness model wire the stateless remote face never rides); pin the
  // absence so a future harmonization cannot grow the remote form.
  assert.doesNotMatch(remote, /unsupported call: <tool>/, 'the remote form must not carry the stdio tool-routing note');
  assert.match(remote, /skillRoot is withheld/, 'the remote form must state skillRoot is withheld');
  assert.match(remote, /huaweicloud_list_skills/, 'the remote form must name the effective-catalog tool');
  assert.match(remote, /fallback/, 'the remote form must frame retrieve_skill as the loader');
  assert.match(remote, /huawei-\* service skill absent/, 'the remote form keeps the scoped absence rule');

  // The trimmed-capability rule rides EVERY form (measured failure,
  // e2e core-free-choice-trimmed-availability, 2026-10-20, twice-stable
  // across attempts): with huaweicloud-cli trimmed the model skipped the
  // catalog and ran read-only hcloud commands straight from the shell —
  // the taught surfaces covered the skill/MCP layers, so the raw-shell
  // path looked permitted. The clause pins that unavailability is about
  // the capability on every execution path, shell included.
  for (const [label, form] of [
    ['full', full],
    ['bare', bare],
    ['remote', remote],
  ] as const) {
    assert.match(
      form,
      /unavailability is about the capability/,
      `the ${label} form must scope unavailability to the capability itself`,
    );
    assert.match(
      form,
      /including hcloud commands run directly from your shell/,
      `the ${label} form must close the raw-shell bypass path`,
    );
    assert.match(
      form,
      /never silently proceed that way; confirm with the user instead/,
      `the ${label} form must demand confirmation over silent bypass`,
    );
  }
  // The vendor boundary rides EVERY form (measured failure, live probe
  // 2026-10-23, opencode 1.19.0 + glm-5.2, twice-stable): a vendor-neutral
  // prompt ("查看ECS实例列表") in a context with no Huawei Cloud signal
  // made the model call auth_status then run_readonly_command without
  // asking which cloud the user meant — every surface conditioned on "the
  // task IS a Huawei Cloud task" while none defined what makes it one, so
  // tool availability stood in as intent evidence. The rule defines the
  // inference boundary and gates TWO prongs — cloud-resource operations,
  // and probing Huawei Cloud tooling/credential/account state (the
  // measured first moves) — while devkit meta tools fall outside by
  // construction: the probe prong names tooling/credential/account state,
  // not the plugin's own version, catalog, or skills. The other-cloud
  // allowance stays positive so the refusal-priming shape the 2026-10-19
  // postmortem documented cannot re-enter through the exemption sentence.
  for (const [label, form] of [
    ['full', full],
    ['bare', bare],
    ['remote', remote],
  ] as const) {
    assert.match(
      form,
      /not evidence of which cloud the user means/,
      `the ${label} form must deny availability-as-intent evidence`,
    );
    assert.match(
      form,
      /ask the user which cloud they mean before operating on cloud resources/,
      `the ${label} form must demand the vendor question before cloud-resource operations`,
    );
    assert.match(
      form,
      /before probing Huawei Cloud tooling, credential, or account state/,
      `the ${label} form must gate the probe face (the measured first moves)`,
    );
    assert.match(
      form,
      /generic service vocabulary \(ECS, VPC, RDS, serverless\) and the devkit's own presence do not infer it/,
      `the ${label} form must scope the inference boundary (vocabulary and presence do not infer)`,
    );
    assert.match(
      form,
      /tasks for other clouds remain answerable from general knowledge/,
      `the ${label} form must keep the other-cloud allowance positive, not exemption-from-prohibition`,
    );
  }
  assert.doesNotMatch(
    remote,
    /huaweicloud_packs_configure/,
    'packs_configure is stdio-only and must not be taught on the remote form',
  );
});

test('the vendorConfirmed gate is pinned on every gated tool face', () => {
  // The enforcement rung of the vendor boundary (landed after the measured
  // post-teaching re-run still fired the probe/execution chain on a
  // vendor-neutral prompt). Roster-derived, never hand-listed: the loop
  // reads VENDOR_GATED_TOOLS — the same set callTool's gate reads — so
  // adding a tool to the gate automatically extends this pin. Two checks
  // per face: the description carries the gate sentence (the surface a
  // model reads when choosing tools), and the schema TYPES the parameter
  // (a wrong-typed vendorConfirmed fails zod — passthrough would swallow
  // it, so the safeParse failure is the property-presence proof). The
  // converse pin holds the exemption boundary: a devkit meta tool
  // (check_update) passes the wrong-typed value through, proving the gate
  // set did not silently grow over the meta family.
  assert.ok(VENDOR_GATED_TOOLS.size >= 13, 'the measured entry set must stay gated');
  for (const name of VENDOR_GATED_TOOLS) {
    const def = TOOL_DEFINITIONS.find((tool) => tool.name === name);
    assert.ok(def, `gated tool ${name} must exist in TOOL_DEFINITIONS`);
    assert.match(
      def.description,
      /Vendor-gated \(vendorConfirmed\)/,
      `${name}'s description must carry the gate sentence`,
    );
    // Required fields are supplied per face so the failure is attributable
    // to vendorConfirmed alone — a bare wrong-type probe is vacuous for
    // the four schemas with required keys (they fail on the missing
    // required long before the parameter is examined).
    const requireds: Record<string, Record<string, unknown>> = {
      huaweicloud_plan_cli_command: { args: ['X'] },
      huaweicloud_run_readonly_command: { args: ['X'] },
      huaweicloud_list_operations: { service: 'X' },
      huaweicloud_run_approved_command: { args: ['X'], approvalToken: 't', approvedByUser: true },
    };
    const parsed = getToolSchema(name).safeParse({
      vendorConfirmed: 123,
      ...(requireds[name] ?? {}),
    });
    assert.equal(parsed.success, false, `${name}'s schema must type the vendorConfirmed parameter`);
    assert.ok(
      !parsed.success && parsed.error.issues.some((issue) => issue.path[0] === 'vendorConfirmed'),
      `${name}'s parse failure must point at vendorConfirmed, not a missing required key`,
    );
  }
  assert.ok(VENDOR_GATED_TOOLS.has('huaweicloud_auth_status'), 'the measured first move stays gated');
  assert.ok(!VENDOR_GATED_TOOLS.has('huaweicloud_check_update'), 'devkit meta tools stay outside the gate');
  // Full-roster converse (round-5 finding: a shared schema leaked the
  // attestation onto an ungated sibling — competition_voucher_claim —
  // advertising a gate that never fires): every tool whose schema types
  // the parameter must be in the gate set. Sampled per name with a bare
  // probe; schemas with required keys parse as typed (the required keys
  // are absent, but the check only needs the property-typing signal, so
  // it asserts on the property not the overall outcome).
  for (const tool of TOOL_DEFINITIONS) {
    const schema = getToolSchema(tool.name);
    const probe = schema.safeParse({ vendorConfirmed: 123 });
    const typed = !probe.success && probe.error.issues.some((issue) => issue.path[0] === 'vendorConfirmed');
    if (typed) {
      assert.ok(
        VENDOR_GATED_TOOLS.has(tool.name),
        `${tool.name} types vendorConfirmed but is not gated — split the schema or extend the gate`,
      );
    }
  }
});

test('retrieve_skill description frames the fallback, not the default', () => {
  // The observed free-choice failure was agents jumping straight to
  // retrieve_skill; the description now opens by demoting it. This pins
  // the demotion phrases, the reactive fallback trigger, and the
  // self-heal teaching (the stdio payload carries skillRoot) so a copy
  // pass cannot quietly revert any of them.
  const retrieve = TOOL_DEFINITIONS.find((tool) => tool.name === 'huaweicloud_retrieve_skill');
  assert.ok(retrieve, 'the retrieve_skill definition must exist');
  assert.match(retrieve.description, /the fallback loader, not the default/);
  assert.match(retrieve.description, /skillRoot so the next skill can be a direct read/);
  assert.match(
    retrieve.description,
    /attempt the direct read first/,
    'the description must open the load procedure with the attempt-first imperative',
  );
  assert.match(
    retrieve.description,
    /do not call this tool before the read is attempted/,
    'the description must forbid its own use before the attempt (the measured failure mode)',
  );
  assert.match(
    retrieve.description,
    /Call it only after a direct read attempt fails or is denied, or when the tree location is unknown/,
  );
  assert.match(
    retrieve.description,
    /it needs no file access/,
    'the description must state the loader needs no file access beside the trigger',
  );
});
