import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import type { RiskRulesCatalog, SafetyPolicy } from './structure-helpers.ts';
import { pluginRoot, readJson, readSource, root } from './structure-helpers.ts';

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

test('the py hook derives the obfuscation gate write vocabulary from policy.json (prefixes), with the OBS half marker-gated', () => {
  // port-v2defects (interrogate round): WRITE_VOCAB_RE was a hardcoded
  // 20-word alternation whose comment claimed to mirror policy.json's 37
  // writeOperationPrefixes — the 17 missing words (invoke/execute/trigger/
  // deploy among them) let mangled InvokeFunction/Execute/Trigger/Deploy
  // writes through the py-hook faces (Hermes importlib, WorkBuddy deploy)
  // while the TS layer denied via writeVocabHit. The vocabulary is now
  // DERIVED by load_policy from the same list WRITE_OPERATION_RE reads, and
  // an unavailable derivation (unreadable policy, empty list) fails the
  // gate's clause CLOSED — the `is None` arm fires — instead of silently
  // reopening the mangled-write hole.
  const pyHook = readSource(join('hooks', 'huaweicloud-safety.py'));
  assert.match(pyHook, /WRITE_VOCAB_RE = None/);
  // Every compile of the prefix vocabulary must derive from the policy list —
  // the assignment-scan shape, not a byte-exact line pin, so cosmetic
  // reformatting stays green while a re-hardcoded alternation (the drift
  // shape, in any spelling or order) fails: a compile without write_prefixes
  // IS a hand-maintained list.
  const vocabAssignments = pyHook.match(/WRITE_VOCAB_RE = re\.compile\([^\n]*\)/g) ?? [];
  assert.ok(vocabAssignments.length >= 1, 'the prefix vocabulary must be compiled inside load_policy');
  for (const assignment of vocabAssignments) {
    assert.match(assignment, /write_prefixes/, `policy-derived compile required: ${assignment}`);
  }
  // The OBS subcommand half is a separate module-compiled regex (its own
  // dual-home doctrine, not foldable into policy.json), gated at the gate by
  // the word-bounded OBS TOKEN — a bare `cloud` substring was the round-2
  // marker and denied routine huaweicloud-bearing PATHS; the decoded-bin
  // clause carries the mangled-bin class now.
  const obsAssignments = pyHook.match(/OBS_VOCAB_RE = re\.compile\([^\n]*\)/g) ?? [];
  assert.ok(obsAssignments.length >= 1, 'the OBS vocabulary must be module-compiled');
  for (const assignment of obsAssignments) {
    assert.match(assignment, /OBSUTIL_WRITES/, `the OBS vocabulary derives from OBSUTIL_WRITES: ${assignment}`);
  }
  assert.match(pyHook, /OBS_MARKER_RE = re\.compile\(r"\\bOBS\\b", re\.I\)/);
  // The ANSI-C decode (interrogate round 3): both layers reconstruct the
  // argv letters $'…' spans build, and the gate's clauses search BOTH
  // shadow candidates — mangle-past-the-marker no longer hides the bin.
  // The decode is size-guarded (round 4: an over-cap payload skips the
  // linear pass) and the outside-quote backslash branch defeats the
  // phantom-quote poisoning (`\' ; h$'…` no longer disables the decode).
  assert.match(pyHook, /def decode_ansi_c_spans\(text\):/);
  assert.match(
    pyHook,
    /decoded_unquoted = \(\s*unquoted if text_bytes > 262144 else strip_shell_quotes\(decode_ansi_c_spans\(text_cont\)\)\s*\)/,
  );
  // Round 6: the marker check and the decode run on the CONTINUATION-DROPPED
  // text (bash removes the pair before tokenization, reassembling $' across
  // the break), and the byte count is surrogate-safe ("replace" — a lone
  // \ud800 crashed the hook verdict-less before).
  assert.match(pyHook, /text_cont = re\.sub\(r"\\\\\\n", "", text\)/);
  // Round 7: the byte count is the utf-16-surrogatepass round-trip —
  // paired surrogates survive, lone ones become U+FFFD, byte-identical to
  // Node's Buffer.byteLength (round 6's "replace" counted 1 vs Node's 3).
  // Round 8: the pin ties text_bytes itself to the chain (the codec-only
  // assert let a rename drift past).
  assert.match(
    pyHook,
    /text_bytes = len\(\s*text\.encode\("utf-16", "surrogatepass"\)\.decode\("utf-16", "replace"\)\.encode\("utf-8"\)\s*\)/,
  );
  // Round 8-9: whitespace-only commands deny on the EXACT JS trim() set
  // (round 8's bare str.strip() also stripped \x85 and \x1c-\x1f — a
  // one-directional drift), the over-cap latency guard skips the segment
  // walk for broad-unrouted payloads (the BROAD tail mirrors TS's
  // broadRouted, `<` included in round 9), and the glued-bin fallback
  // tokenizer + input-redirect peel close the round-9 criticals.
  assert.match(pyHook, /if not text\.strip\(/);
  assert.ok(
    pyHook.includes(
      String.raw`HCLOUD_ROUTE_BROAD_RE = re.compile(r"(^|[^a-z0-9.-])hcloud(\.exe)?([\s)\]}'\";&|<>]|$)", re.I)`,
    ),
    'the BROAD routing tail must carry the full class incl. <',
  );
  assert.match(pyHook, /def split_tokens_glued\(text\):/);
  assert.match(pyHook, /t = re\.sub\(r"<\{1,2\}\[\^<>&;\\|\\s\]\*\$", "", t\)/);
  assert.match(pyHook, /OBFUSCATION_RE\.search\(text_cont\)/);
  assert.match(pyHook, /# Outside quotes a backslash escapes the NEXT character/);
  const shellText = readSource(join('src', 'safety', 'shell-text.ts'));
  assert.match(shellText, /export function decodeAnsiCSpans\(text: string\): string \{/);
  assert.match(shellText, /Outside quotes a backslash escapes the NEXT character/);
  const classifyText = readSource(join('src', 'safety', 'classify-text.ts'));
  assert.match(classifyText, /decodeAnsiCSpans/);
  assert.match(classifyText, /textBytes > 262_144 \? shadowText : stripShellQuotes\(decodeAnsiCSpans\(contDropped\)\)/);
  assert.match(classifyText, /const contDropped = text\.replace\(\/\\\\\\n\/g, ''\)/);
  // The cap counts BYTES on both twins and denies expansion-bearing
  // over-cap payloads (round 5: the decode skip must not make the over-cap
  // slice the one place a mangled write sails through).
  assert.match(classifyText, /Buffer\.byteLength\(text, 'utf8'\)/);
  assert.ok(
    classifyText.includes('/\\$[\'"]|\\$\\(|`/.test(contDropped)'),
    'the over-cap deny must cover expansion-bearing payloads (on the continuation-dropped text)',
  );
  assert.match(pyHook, /if text_bytes > 262144 and \(\s*\n\s*OBFUSCATION_RE\.search\(text_cont\)/);
  // The fail-closed arm sits in the gate's vocabulary clause (whitespace-
  // tolerant: indentation reflow must not break the pin — interrogate
  // round 2).
  assert.match(
    pyHook,
    /or WRITE_VOCAB_RE is None\s+or any\(WRITE_VOCAB_RE\.search\(candidate\) for candidate in candidates\)/,
  );
});

test('the py hook degrades coherently: derived vocabularies, isolated fields, fail-closed gates (interrogate round 1)', () => {
  // The read vocabulary is ALSO policy-derived (the last hand-maintained
  // policy mirror), the write gate's read exemption is start-anchored
  // (re.match, TS hasReadPrefix parity), and an unavailable write
  // vocabulary denies hcloud-LEADING invocations (prose mentions stay
  // allowed) instead of silently allowing plain writes while the mangled
  // forms deny.
  const pyHook = readSource(join('hooks', 'huaweicloud-safety.py'));
  assert.match(pyHook, /READ_OPERATION_RE = None/);
  const readAssignments = pyHook.match(/READ_OPERATION_RE = re\.compile\([^\n]*\)/g) ?? [];
  assert.ok(readAssignments.length >= 1, 'the read vocabulary must be compiled inside load_policy');
  for (const assignment of readAssignments) {
    assert.match(assignment, /read_prefixes/, `policy-derived compile required: ${assignment}`);
  }
  // Start-anchored read exemption (the drift let `Update-Show-x` allow).
  assert.match(pyHook, /READ_OPERATION_RE is None or not READ_OPERATION_RE\.match\(operation\)/);
  // The write-gate fail-closed arm with its cause-named reason (the honest
  // widened text names the empty-vocabulary cause, not just load failure).
  assert.match(pyHook, /could not be loaded or carries no write vocabulary/);
  // Per-field isolation: the vocabularies compile FIRST, before the
  // pattern-bearing fields whose invalid regexes must not abort them.
  const writeFirst = pyHook.indexOf('write_prefixes = policy.get');
  const credLater = pyHook.indexOf('cred_patterns = policy.get');
  assert.ok(
    writeFirst !== -1 && credLater !== -1 && writeFirst < credLater,
    'the vocabularies load before the pattern fields',
  );
  // Non-list values funnel into the fail-closed arms, never a garbage
  // char-alternation from "|".join on a string.
  assert.match(pyHook, /if not isinstance\(write_prefixes, list\):/);
  assert.match(pyHook, /if not isinstance\(read_prefixes, list\):/);

  // The TS twin: writeVocabHit's OBS arm is marker-gated on the OBS token
  // over BOTH shadow candidates, and treats an empty prefix list as a hit
  // (the is-None arm's mirror).
  const classifyText = readSource(join('src', 'safety', 'classify-text.ts'));
  // Round 10: the TS glued gate reuses the FULL unwrap grammar
  // (unwrapWithWindowsFlag) per segment, skips plain-leading segments (the
  // Round 10-11: the TS glued gate reuses the FULL unwrap grammar and is
  // RECURSIVE (scriptTextOf / heredocScriptText / gluedWriteDenied).
  assert.match(classifyText, /import \{ unwrapWithWindowsFlag \} from '\.\/unwrap\.ts';/);
  assert.match(classifyText, /import \{ unwrapSecretExecWrapper \} from '\.\/secret-exec\.ts';/);
  assert.match(classifyText, /import \{ unwrapSkillQualityCli \} from '\.\/skill-quality-cli\.ts';/);
  // Round 11: the TS walk is RECURSIVE (py's doctrine): scriptTextOf
  // extracts shell -c / eval / watch-join / windows / secret-exec /
  // skill-quality script carriers with head-stripping (redirections, env
  // assignments, prefixes); heredocScriptText slices shell-stdin script
  // bodies; gluedWriteDenied re-runs the walk per segment with the
  // verdict-comparison ownership (plain-leading segments get the glued
  // re-join too) and the xargs pipe feeder for glued bins.
  assert.match(classifyText, /function scriptTextOf\(tokens: string\[\], depth = 0\): string \| null \{/);
  assert.match(classifyText, /function heredocScriptText\(segment: string\): string \| null \{/);
  assert.match(classifyText, /function gluedWriteDenied\(/);
  assert.match(classifyText, /const glued = gluedWriteDenied\(text, options, narrowRouted, 0\);/);
  // The py twin: the heredoc helper, the broad glued scope, the
  // redirection-dup splitter guard, and watch's script-join.
  assert.match(pyHook, /def _heredoc_script_text\(segment\):/);
  assert.match(pyHook, /glued_scope = \(/);
  assert.match(pyHook, /if ch == "&" and i > 0 and text\[i - 1\] in "><":/);
  assert.ok(pyHook.includes('== "watch" and len(tokens) > 1:'), 'the watch head strips quote-mangling');
  // The py twin: the per-segment glued fallback inside the walk.
  assert.match(pyHook, /glued_stripped = hcloud_leading_segment\(split_tokens_glued\(segment\)\)/);
  // Round 12: the flags-before--c scan (the skip class excludes c —
  // [a-bd-z]), the heredoc first-word head check, the find-exec carrier,
  // the interpreter system() extraction, the script-shadow pass (scoped to
  // carrier scripts, empty-args suppressed on prose artifacts), and the
  // 18-deep unwrap budgets.
  assert.match(pyHook, /re\.match\(r"\^-\[a-bd-z\]\+\$", tok, re\.I\)/);

  assert.match(pyHook, /in \("-exec", "-execdir"\)/);
  // Round 13 / the DESIGN PIVOT: the vision tail closes by DENIAL — the
  // opaque gate (fragmented-token / expansion-marker / interpreter-code
  // signals) denies what the walk cannot traverse, gated on the walk never
  // having seen our bin at a classifiable position (the `saw` accumulator)
  // — and the script-shadow pass it replaces is gone.
  assert.match(pyHook, /def _opaque_carrier_denied\(segment, tokens, whole_text\):/);
  assert.match(pyHook, /def _interpreter_head_of\(head\):/);
  assert.match(pyHook, /def _interpreter_system_commands\(code\):/);
  assert.match(pyHook, /saw\[0\] = True/);
  assert.match(pyHook, /if not seg_saw\[0\]:/);
  // Round 14 (the exit round on the pivot): ${ joins the marker set, the
  // saw accumulator is PER-SEGMENT (seg_saw, ORed into the caller's saw),
  // busybox dispatches applets, and stdin heredocs are interpreter code.
  assert.match(pyHook, /seg_saw = \[False\]/);
  assert.match(pyHook, /saw\[0\] = saw\[0\] or seg_saw\[0\]/);
  assert.match(pyHook, /"busybox"/);
  assert.ok(pyHook.includes('or re.search(r"<<<?", segment)'), 'the stdin-heredoc code-context arm');
  assert.ok(pyHook.includes('b.lower() in segment.lower()'), 'contiguous presence (the ${X:-hcloud} fix)');
  // Round 16: the mangled-flag normalizer, the mangled shell heads, the
  // glued slot rule, and the pipe-fed shell stdin.
  assert.match(pyHook, /def _normalize_flag_token\(token\):/);
  assert.match(pyHook, /_normalize_flag_token\(tokens\[i\]\)/);
  assert.match(classifyText, /function normalizeFlagToken\(token: string\): string \{/);
  assert.match(classifyText, /function shellHeadBefore\(segment: string, endIndex: number\): boolean \{/);
  assert.ok(
    classifyText.includes(".replace(/['\"\\\\$]/g, '')"),
    'the shell head word strips quotes (the ba-sh mangle fix)',
  );
  assert.match(pyHook, /_shell_head_ok = bool\(/);
  assert.ok(pyHook.includes('_gslot_argv'), 'the glued-path slot rule');
  assert.doesNotMatch(pyHook, /nested_shadow = strip_shell_quotes\(nested\)/);
  assert.match(classifyText, /function opaqueCarrierDenied\(/);
  assert.match(classifyText, /function interpreterHeadOf\(/);
  assert.match(classifyText, /function interpreterSystemCommands\(/);
  assert.match(classifyText, /saw\.value = true/);
  assert.ok(
    classifyText.includes('if (!segSaw.value) {'),
    'the opaque gate fires only when the segment subtree never saw the bin',
  );
  assert.doesNotMatch(classifyText, /const scriptShadow = stripShellQuotes\(script\);/);
  assert.ok(classifyText.includes('/^-[a-bd-z]+$/i'), 'the flags-before--c skip class must exclude c');
  assert.match(classifyText, /tok === '-exec' \|\| tok === '-execdir'/);
  assert.match(classifyText, /writeOperationPrefixes\.length === 0/);
  assert.ok(
    classifyText.includes('shadowCandidates.some((candidate) => /\\bOBS\\b/i.test(candidate)) &&'),
    'the OBS vocabulary arm must be OBS-token-gated over both shadow candidates',
  );
  assert.match(classifyText, /\[\.\.\.OBSUTIL_WRITES\]\.some/);

  // The Node hook wrapper fails CLOSED on a payload too broken to load its
  // own policy (DEFAULT_POLICY throws at module load) instead of dying with
  // no verdict, which a PreToolUse harness reads as "allow" — and its
  // verdict write is SYNCHRONOUS (process.exit does not wait for pending
  // async pipe writes; a dropped fail-closed verdict reads as allow).
  // readSource rewrites legacy .mjs paths to .ts — the hook is a real .mjs,
  // so it is read directly (the structure-runtime precedent).
  const nodeHook = readFileSync(join(pluginRoot, 'hooks', 'huaweicloud-safety.mjs'), 'utf8');
  assert.match(nodeHook, /} catch \{\s*\n\s*writeSync\(/);
  assert.match(nodeHook, /POLICY_LOAD_FAILED_REASON/);
  // Classify-time failure (a corrupt rules file) denies the same way, with
  // its own cause-named reason (round 3: the policy parsed fine).
  assert.match(
    nodeHook,
    /result = classifyTextCommand\(text\);\s*\n\s*\} catch \{\s*\n\s*deny\(CLASSIFY_FAILED_REASON\);/,
  );
});

test('the safety policy loader rejects an emptied write list (interrogate round 2 parity closure)', () => {
  // A present-but-empty writeOperationPrefixes reclassifies write commands
  // as safe — the exact fail-open the non-array throw exists to prevent,
  // one shape over. loadPolicy now throws, so the degraded surfaces cohere:
  // py denies fail-closed (unavailable vocabulary), the .mjs hook denies
  // fail-closed (module-load throw), the MCP server refuses to boot
  // (fail-loud by design). The absent field still normalizes to [] for
  // older policies.
  const policySource = readSource(join('src', 'safety', 'policy.ts'));
  assert.match(policySource, /must not be empty/);
  assert.match(policySource, /raw\.writeOperationPrefixes !== undefined && writeOperationPrefixes\.length === 0/);
});

test('the OBSUTIL_WRITES vocabulary is set-equal across the py hook and the TS tokens module (interrogate round 2)', () => {
  // 11 of the 28 words had no verdict pin anywhere — a future single-layer
  // edit could reopen those words' mangled-write holes unpinned (the exact
  // dual-maintenance drift shape this task exists to kill). One structural
  // equality assertion kills the whole class. Comment lines are stripped
  // before extraction (both blocks carry prose with apostrophes/quotes).
  const stripCommentLines = (block: string, marker: string): string =>
    block
      .split('\n')
      .filter((line) => !line.trim().startsWith(marker))
      .join('\n');
  const pyHook = readSource(join('hooks', 'huaweicloud-safety.py'));
  const pyBlock = stripCommentLines(pyHook.match(/OBSUTIL_WRITES = \{([\s\S]*?)\}/)?.[1] ?? '', '#');
  const pyWords = new Set([...pyBlock.matchAll(/"([^"]+)"/g)].map((m) => m[1] ?? ''));
  const tokens = readSource(join('src', 'safety', 'tokens.ts'));
  const tsBlock = stripCommentLines(
    tokens.match(/export const OBSUTIL_WRITES = new Set\(\[([\s\S]*?)\]\)/)?.[1] ?? '',
    '//',
  );
  const tsWords = new Set([...tsBlock.matchAll(/'([^']+)'/g)].map((m) => m[1] ?? ''));
  assert.ok(pyWords.size >= 20, `py OBSUTIL_WRITES parsed sanely (${pyWords.size} words)`);
  assert.ok(tsWords.size >= 20, `ts OBSUTIL_WRITES parsed sanely (${tsWords.size} words)`);
  assert.deepEqual(
    [...pyWords].filter((word) => !tsWords.has(word)),
    [],
    'words only in the py hook drift the layers',
  );
  assert.deepEqual(
    [...tsWords].filter((word) => !pyWords.has(word)),
    [],
    'words only in the TS tokens drift the layers',
  );
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
  // The skill-quality-cli wrapper-unwrap residual is documented here too:
  // variable-indirection and alternate-entry spellings are the seam gaps.
  assert.match(reference, /skill-quality-cli/);
  assert.match(reference, /python3 -m skill_quality_cli/);
  assert.match(reference, /cli_entry\.py/);
});

test('the signing test vectors never spell a contiguous Signature=<hex> literal', () => {
  // The CI secret scanner (gitleaks generic-api-key) matches the contiguous
  // '<token keyword>...=...<64-hex>' shape: it flagged two of the four
  // deterministic HMAC vectors on PR #1037 (2026-10-27) — test digests, not
  // credentials. The vectors now live as prefix + DIGEST_* concatenation so
  // no keyword sits inside the scanner's window of a hex value; a "cleanup"
  // that merges them back into single literals re-trips the gate. This pin
  // makes that regression a named failure instead of a red CI mystery.
  const vectors = readFileSync(join(root, 'test', 'hw-request-signing.test.ts'), 'utf8');
  assert.doesNotMatch(vectors, /Signature=[0-9a-f]{64}/);
  assert.match(vectors, /Signature=' \+ DIGEST_/);
});

test('real-hook spawns gate the shared spool writes (the #1040 windows-CI flood)', () => {
  // The safety py hook's record_cli_event appends to
  // plugins/huaweicloud-core/telemetry/hook-events.jsonl — a path derived
  // from the hook file's own location, immune to every test HOME
  // isolation, and READ by the repo telemetry module's enqueue-side
  // ingest. A test spawning the real hook with inherited env floods that
  // shared file (~490 hcloud battery rows); any later test's telemetry
  // ingest then carries the flood into its queue, and one awaited flush
  // splices only BATCH_SIZE=100 — the #1040 flush pin's tool event
  // (enqueued last) missed its round on the windows CI legs twice
  // (2026-10-29, runs 40841747815 / 40849117055; reproduced red-first on
  // Linux with a staged 120-line spool). Every REAL-hook spawn (the
  // [hookPath] argument — copies like [hookCopy] redirect their writes
  // into their own fixtures and need no gate) must carry the
  // HUAWEICLOUD_DEVKIT_TELEMETRY=off gate. A new ungated spawn site
  // re-opens the class — this pin makes it a named failure.
  for (const file of ['hook-parity.test.ts', 'hook-python.test.ts']) {
    const body = readFileSync(join(root, 'test', file), 'utf8');
    const spawnBlocks = body.split('spawnSync(').slice(1);
    const realHookBlocks = spawnBlocks.filter((block) => block.includes('[hookPath]'));
    assert.ok(realHookBlocks.length > 0, `${file} lost its real-hook spawns — stale pin?`);
    for (const block of realHookBlocks) {
      assert.ok(
        block.includes("HUAWEICLOUD_DEVKIT_TELEMETRY: 'off'"),
        `${file} spawns the real hook without the telemetry-off gate — the shared agent-dir spool floods later tests' telemetry ingests`,
      );
    }
  }
});
