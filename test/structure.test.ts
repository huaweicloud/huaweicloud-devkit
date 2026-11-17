import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import test from 'node:test';

import { fixtureDir } from './fixture-dir.ts';
import { APPROVAL_TOOLS, APPROVAL_CLASSIFIED_TOOLS } from '../plugins/huaweicloud-core/src/approval-roster.ts';
import { APPROVAL_SPECS } from '../plugins/huaweicloud-core/src/packs/registry.ts';
import { TOOL_DEFINITIONS } from '../plugins/huaweicloud-core/src/tools.ts';
import type { JscpdBaseline, JscpdConfig, JscpdReport, PackageJson, PackageLock } from './structure-helpers.ts';
import { readJson, readSource, root } from './structure-helpers.ts';

test('the approval roster only names real tools and the classified list is a subset of it', () => {
  // The roster is a const string tuple by contract (the .mjs hook and
  // PR-2's opencode writer import it without the registry graph), so
  // nothing at compile time forces its entries to be tool names — this
  // runtime pin does. A roster entry that names no tool silently gates
  // nothing; a classified entry that is not on the roster silently
  // bypasses the gate.
  const known = new Set(TOOL_DEFINITIONS.map((tool) => tool.name));
  for (const name of APPROVAL_TOOLS) {
    assert.ok(known.has(name as (typeof TOOL_DEFINITIONS)[number]['name']), `roster names unknown tool ${name}`);
  }
  for (const name of APPROVAL_CLASSIFIED_TOOLS) {
    assert.ok(
      (APPROVAL_TOOLS as ReadonlyArray<string>).includes(name),
      `classified tool ${name} must also be on the approval roster`,
    );
  }
});

test('every approval spec is rostered: the spread-merge direction the satisfies check cannot see (round-10 finding 2)', () => {
  // The registry's satisfies closure holds for INLINE object literals
  // only: a spec added through a spread merge ({ ...A, ...B } — the shape
  // PR-3 uses for its per-pack spec tables) carries extra keys past the
  // excess-property check without failing the build. A spec-only
  // registration silently GATES its tool (the dispatch gate resolves
  // specs from the merged table) while remaining invisible to every
  // roster consumer — the hook exemption, _meta, PR-2's ask-rule
  // writer — so in ask mode the tool executes on a prompt the user was
  // never shown and records a granted/posture consent the user never
  // gave. This runtime invariant is the mirror of the
  // roster-names-real-tools pin: the merged table's keys must be a
  // subset of the roster tuple, so any roster/spec drift fails the
  // battery loud instead of silently gating.
  const roster = new Set(APPROVAL_TOOLS as ReadonlyArray<string>);
  for (const key of Object.keys(APPROVAL_SPECS)) {
    assert.ok(
      roster.has(key),
      `approval spec ${key} is not on the roster — the gate would silently engage for an unrostered tool`,
    );
  }
});

test('the approval roster stays a const tuple so the registry closure cannot be inert', () => {
  // Interrogate rounds 1-5: typing the roster as a plain
  // ReadonlyArray<string> widens ApprovalRosterName to string and
  // silently inerts the registry's satisfies Record<ApprovalRosterName,
  // ApprovalSpec> — the adversary added a roster entry with no spec and
  // typecheck stayed green. The const tuple is what makes the compile-time
  // coupling real. A text regex proved too weak four times: `as const` with
  // a cast element matched the spelling pin; a comment inside the array
  // became a phantom element; a '// ] as const;' comment terminated the
  // capture before a widening; and round 5's shape — a STRING LITERAL
  // earlier in the file carrying a clean declaration spelling — fed the
  // pin a decoy while the real tuple was widened (verified end to end: the
  // defeated pin plus a removed run-spec let unattested writes, credential
  // exfil operands, and placeholder secrets all execute).
  //
  // The parser therefore runs ONE left-to-right scan that masks string
  // literal CONTENTS (quote kept, every inner char becomes 'S') and
  // removes comments as it goes: a decoy inside a string is invisible to
  // the pattern, a comment cannot smuggle text. Round 6 closed the last
  // extraction hole: a REGEX LITERAL is neither a string nor a comment,
  // passes the skeleton verbatim, and first-match extraction read the
  // decoy's clean tuple while the real declaration was widened (verified
  // end to end: the attacked tree passed every static guard while a
  // roster member ran with no spec, no gate, no attestation). The pin now
  // requires EVERY occurrence of the declaration pattern in the skeleton
  // to be a clean masked tuple of exactly the runtime arity: a decoy
  // regex carrying a clean shape is itself an occurrence and must satisfy
  // the rules, and the widened real declaration beside it fails them —
  // there is no "first" match to hide behind. Spelling validity (what a
  // masked element cannot show) stays with the sibling test that checks
  // the runtime values against TOOL_DEFINITIONS.
  const skeletonOf = (text: string): string =>
    text.replace(
      /(['"`])((?:\\[\s\S]|(?!\1)[\s\S])*?)\1|\/\/[^\n]*|\/\*[\s\S]*?\*\//g,
      (match, quote: string, body: string) => (quote ? quote + body.replace(/[\s\S]/g, 'S') + quote : ''),
    );
  const tupleElementsOf = (occurrence: string): string[] => {
    const body = occurrence.replace(/^.*?=\s*(\[[\s\S]*?\]) as const;[\s\S]*$/, '$1');
    return body
      .replace(/^\[/, '')
      .replace(/\]$/, '')
      .split(',')
      .map((element) => element.trim())
      .filter((element) => element.length > 0);
  };
  const parseTuples = (roster: string, declaration: string): Array<string[]> => {
    const skeleton = skeletonOf(roster);
    const occurrences = [
      ...skeleton.matchAll(new RegExp(`export const ${declaration} = \\[[\\s\\S]*?\\] as const;`, 'g')),
    ].map((match) => match[0]);
    return occurrences.map((occurrence) => tupleElementsOf(occurrence));
  };
  const parseAllRosterTuples = (roster: string): Array<string[]> => parseTuples(roster, 'APPROVAL_TOOLS');
  const cleanElements = (elements: string[]): boolean =>
    elements.length > 0 && elements.every((element) => /^'S+'$/.test(element));
  // allTuplesClean: at least one declaration-shaped occurrence exists, and
  // every one is a clean masked tuple (no widening anywhere — zero
  // occurrences fails closed). allTuplesSafe additionally pins every
  // occurrence to the runtime arity — the strict form the real file must
  // satisfy: the real declaration cannot be dirty, no decoy can hide it,
  // and a clean decoy of any other arity is rejected outright (fail-closed;
  // the current tree carries exactly one occurrence).
  const allTuplesClean = (text: string): boolean => {
    const all = parseAllRosterTuples(text);
    return all.length > 0 && all.every((elements) => cleanElements(elements));
  };
  const allTuplesSafe = (text: string): boolean => {
    const all = parseAllRosterTuples(text);
    return (
      all.length > 0 && all.every((elements) => cleanElements(elements) && elements.length === APPROVAL_TOOLS.length)
    );
  };
  const roster = readSource(join('src', 'approval-roster.ts'));
  const tuples = parseAllRosterTuples(roster);
  assert.ok(tuples.length > 0, 'the roster declaration must be present outside strings and comments');
  assert.ok(
    allTuplesSafe(roster),
    'every declaration-shaped occurrence must be a clean masked tuple of the runtime arity',
  );
  // The parser itself is pinned against every adversarial shape the rounds
  // demonstrated. Clean shapes stay green; every widening goes red — and
  // round 6's decoy shapes must fail through EVERY occurrence being clean.
  assert.ok(allTuplesClean("export const APPROVAL_TOOLS = ['huaweicloud_run_approved_command'] as const;"));
  assert.ok(
    allTuplesClean(
      "export const APPROVAL_TOOLS = [\n  'huaweicloud_run_approved_command', // the run face\n  /* PR-3a */ 'huaweicloud_sandbox_connect',\n] as const;",
    ),
    'commented elements parse clean',
  );
  assert.equal(
    allTuplesClean("export const APPROVAL_TOOLS = ['huaweicloud_run_approved_command' as string] as const;"),
    false,
    'an element-level cast must fail the element check',
  );
  assert.equal(
    allTuplesClean("export const APPROVAL_TOOLS: ReadonlyArray<string> = ['x'];"),
    false,
    'a type annotation must fail the as-const requirement',
  );
  assert.equal(
    allTuplesClean(
      "export const APPROVAL_TOOLS = [\n  'huaweicloud_run_approved_command', // ] as const;\n  'huaweicloud_sandbox_connect' as string,\n] as const;",
    ),
    false,
    'a widening hidden behind an in-array "// ] as const;" comment must fail the element check',
  );
  // Round 5's string-literal decoy: masked, so only the real declaration
  // is an occurrence.
  assert.equal(
    allTuplesClean(
      `const pinExample = "export const APPROVAL_TOOLS = ['huaweicloud_run_approved_command'] as const;";\nexport const APPROVAL_TOOLS = ['huaweicloud_run_approved_command', 'huaweicloud_check_cli' as string] as const;`,
    ),
    false,
    'a decoy string before a widened real declaration must fail — the pin sees the real tuple',
  );
  assert.ok(
    allTuplesClean(
      `const pinExample = "export const APPROVAL_TOOLS = ['huaweicloud_run_approved_command'] as const;";\nexport const APPROVAL_TOOLS = ['huaweicloud_run_approved_command'] as const;`,
    ),
    'a decoy before a CLEAN real declaration stays green — the real tuple is clean',
  );
  // Round 6's regex-literal decoy (the attacked shapes verified end to
  // end): the regex passes the skeleton VERBATIM, so it is itself an
  // occurrence — clean, but the widened real declaration beside it fails.
  const regexDecoyBeforeWidenedReal = `// eslint-disable-next-line no-unused-vars\nconst pinSightDecoyRegex = /export const APPROVAL_TOOLS = ['huaweicloud_run_approved_command', 'huaweicloud_secret_set'] as const;/;\n\nexport const APPROVAL_TOOLS = ['huaweicloud_run_approved_command', 'huaweicloud_secret_set' as string] as const;`;
  assert.equal(
    allTuplesClean(regexDecoyBeforeWidenedReal),
    false,
    'a regex-literal decoy before a widened real declaration must fail — every occurrence is checked',
  );
  const regexDecoyBeforeCleanReal = `const pinSightDecoyRegex = /export const APPROVAL_TOOLS = ['huaweicloud_run_approved_command'] as const;/;\nexport const APPROVAL_TOOLS = ['huaweicloud_run_approved_command'] as const;`;
  assert.ok(
    allTuplesClean(regexDecoyBeforeCleanReal),
    'a regex decoy beside a CLEAN real declaration stays green — both occurrences are clean',
  );
  assert.equal(
    allTuplesClean('export const APPROVAL_TOOLS = [`x`] as const;'),
    false,
    'a template-literal element is a widened shape',
  );
  assert.equal(
    allTuplesClean("export const APPROVAL_TOOLS = ['x' + 'y'] as const;"),
    false,
    'a concatenated element is a widened shape',
  );
  assert.equal(
    allTuplesClean('export const APPROVAL_TOOLS = [] as const;'),
    false,
    'an empty tuple must fail (core gate registrations)',
  );
  assert.equal(
    allTuplesClean('export const APPROVAL_TOOLS = [...([] as string[])] as const;'),
    false,
    'a spread element is a widened shape',
  );
  // A same-length runtime-element swap is a clean shape by this pin; the
  // sibling value-level test (roster names real tools) is the guard for
  // that class.
  //
  // The classified list (PR-3a: the two sandbox exec faces; PR-3c adds the
  // obs pair) carries the same const-tuple discipline: it feeds structure
  // guards (every member must provide a classify) and the gate's
  // classifiedPass engagement, so widening it to a plain array would inert
  // both silently. The masked parser runs over the classified declaration
  // with the same every-occurrence rule and the runtime arity.
  const classifiedTuples = parseTuples(roster, 'APPROVAL_CLASSIFIED_TOOLS');
  assert.ok(
    classifiedTuples.length > 0,
    'the classified-list declaration must be present outside strings and comments',
  );
  assert.ok(
    classifiedTuples.every(
      (elements) => cleanElements(elements) && elements.length === APPROVAL_CLASSIFIED_TOOLS.length,
    ),
    'every classified-list occurrence must be a clean masked tuple of the runtime arity',
  );
  const classifiedClean = (text: string): boolean => {
    const all = parseTuples(text, 'APPROVAL_CLASSIFIED_TOOLS');
    return all.length > 0 && all.every((elements) => cleanElements(elements));
  };
  assert.ok(
    classifiedClean("export const APPROVAL_CLASSIFIED_TOOLS = ['huaweicloud_sandbox_exec_one_shot'] as const;"),
    'a clean classified tuple parses clean',
  );
  assert.equal(
    classifiedClean('export const APPROVAL_CLASSIFIED_TOOLS: readonly string[] = [];'),
    false,
    'a widened classified list must fail the pin',
  );
});

test('every registered classified tool provides a classify', () => {
  // ApprovalCoreMint pins classification before the mint: a classified
  // registration without a classify function cannot decide engagement, so
  // it would fail open. The registry satisfies check pins the spec's
  // existence; this pins the classified flavor's function.
  for (const name of APPROVAL_CLASSIFIED_TOOLS) {
    const spec = APPROVAL_SPECS[name as keyof typeof APPROVAL_SPECS];
    assert.ok(spec, `classified tool ${name} has no ApprovalSpec`);
    assert.equal(
      typeof spec.classify,
      'function',
      `classified tool ${name} must register a pure classify (classify-before-mint)`,
    );
  }
});

test('the sandbox and safety skills teach the registered approval gate (PR-3a)', () => {
  // The teaching layer is a consent surface: eight sandbox tools gained a
  // mechanical gate this PR, and a skill that still says "call connect" or
  // "exec runs commands" without the gate contract teaches the model to
  // fight the refusal instead of driving the confirmation. The guard pins
  // the sandbox skill's gate section and the safety skill's
  // registered-tools wording, the memo, and the standing consent. The
  // roster list is DERIVED from the roster leaf (one line per member) so
  // the sibling registrations' rebases must update it, never outgrow it.
  const sandboxSkill = readSource(join('src', 'packs', 'sandbox', 'skills', 'huawei-sandbox', 'SKILL.md'));
  assert.match(sandboxSkill, /## Approval gate \(the eight mutating tools\)/);
  assert.match(sandboxSkill, /USER_CONFIRMATION_REQUIRED/);
  assert.match(sandboxSkill, /retry-uncertain/, 'the sandbox skill names the retry memo carrier');
  assert.match(sandboxSkill, /standing-session/, 'the sandbox skill names the standing-consent carrier');
  // The exec doctrine: benign runs ungated, the refusal coverage names the
  // engine's real rows, and the boundary sentence states exactly what lies
  // outside them — never an absolutist "outright"/"still CONFIRM"/"every
  // target shape" claim.
  assert.match(sandboxSkill, /NO confirmation surface at all/);
  assert.match(sandboxSkill, /no confirmation able to unlock it/, 'the refusal coverage names its own boundary');
  assert.match(
    sandboxSkill,
    /recursive forced rm in any combined-flag spelling/,
    'the rm coverage is the combined-flag spelling, enumerated honestly',
  );
  assert.match(
    sandboxSkill,
    /The refusal set is those rows and nothing more/,
    'the refusal set is the rows, stated honestly',
  );
  assert.match(
    sandboxSkill,
    /a command outside them is NOT silently stopped/,
    'the outside-the-rows boundary is the honest sentence, never a blanket confirm claim',
  );
  assert.match(
    sandboxSkill,
    /after a restart the same command confirms again/,
    'the memo carries its restart boundary',
  );
  // The operator-approved Bash-face widening is disclosed (round 4, F3).
  assert.match(
    sandboxSkill,
    /Bash-face widening \(operator-approved\)/,
    'the Bash-face widening carries its disclosure paragraph',
  );
  assert.match(sandboxSkill, /rm -rf node_modules/, 'the disclosure names the node_modules shape');
  assert.match(
    sandboxSkill,
    /the hook gates the agent face only/,
    'the disclosure scopes the change to the agent face',
  );

  const approvals = readSource(
    join('src', 'packs', 'core', 'skills', 'huaweicloud-safety', 'references', 'approvals.md'),
  );
  assert.match(approvals, /The registered tools today/, 'the approvals reference names the registered roster');
  for (const tool of APPROVAL_TOOLS) {
    assert.ok(approvals.includes(`\`${tool}\``), `the approvals reference lists ${tool} per the roster leaf`);
  }
  assert.match(approvals, /## The retry memo \(uncertain delivery\)/);
  assert.match(approvals, /approvedVia: "retry-uncertain"/);
  assert.match(approvals, /Remember for this session/);
  assert.match(approvals, /approvedVia: "standing-session"/);
  assert.match(approvals, /The refusal set is those rows and nothing more/, 'the refusal class is the enumerated one');
  assert.match(
    approvals,
    /recursive forced rm in any combined-flag spelling/,
    'the approvals rm coverage is the combined-flag spelling',
  );
  assert.match(
    approvals,
    /a command outside them is not silently stopped/,
    'the outside-the-rows boundary carries the responsibility wording',
  );
  assert.match(approvals, /dies with it: after a restart the same command confirms again/, 'the memo restart boundary');
  assert.match(
    approvals,
    /operator-approved widening/,
    'the approvals reference carries the Bash-face widening disclosure',
  );
  assert.match(
    approvals,
    /the hook gates the agent face only/,
    'the disclosure scopes the Bash-face change to the agent face',
  );
});

test('the sandbox skill teaches selective tunnel cleanup, never blanket delete-all (port-pr4)', () => {
  // The doctrine layer: the automated connect/expose paths run a selective
  // cleanup (orphans + same-port only), and the skill must teach the same
  // contract — the old "always run devbridge delete-all" pre-flight contradicted
  // the concurrency warning one paragraph below it and killed keepalive-protected
  // and other-sessions' tunnels when followed. delete-all survives only as the
  // documented manual full-reset exception.
  const sandboxSkill = readSource(join('src', 'packs', 'sandbox', 'skills', 'huawei-sandbox', 'SKILL.md'));
  assert.match(sandboxSkill, /selective cleanup/i);
  assert.match(sandboxSkill, /cleanup_mode=stale/);
  assert.match(sandboxSkill, /devbridge_tunnel_quota_exceeded/);
  // The connect-time doctrine names what is preserved.
  assert.match(sandboxSkill, /keep other ports\/sessions/i);
  // The contradictory blanket pre-flight must not come back.
  assert.doesNotMatch(sandboxSkill, /always run `devbridge delete-all`/);
  // The delete-all mentions that remain are always scoped as the manual
  // full-reset exception, never the default path.
  for (const m of sandboxSkill.matchAll(/devbridge delete-all/g)) {
    const around = sandboxSkill.slice(Math.max(0, m.index - 160), m.index + 80);
    assert.match(
      around,
      /full reset|GLOBAL operations/i,
      `every delete-all mention must be scoped as the manual exception (context: …${around.slice(-100)})`,
    );
  }
});

test('the sandbox skill gates pool selection on task intent, never on tech stack (port-pr5)', () => {
  // dev b1ab4029: the pool choice is a doctrine gate beside the target and
  // stack gates — the key sentences an agent must meet before
  // huaweicloud_sandbox_connect. The four semantic rules and the scenario
  // table are pinned by the acceptance port in
  // structure-sandbox-pool-selection.test.ts; this guard pins the gate
  // posture plus the anchor every cross-reference must resolve.
  const sandboxSkill = readSource(join('src', 'packs', 'sandbox', 'skills', 'huawei-sandbox', 'SKILL.md'));
  assert.match(sandboxSkill, /^## Pool-Selection Gate \(MANDATORY — do not skip\)$/m);
  assert.match(sandboxSkill, /select the pool by \*\*task intent\*\*, not by tech stack/);
  assert.match(sandboxSkill, /Default is `ephemeral`/);
  assert.match(sandboxSkill, /Never select `persistent` merely because the project is full-stack or DB-backed\./);
  assert.match(sandboxSkill, /Never switch pool silently mid-task\./);
  assert.match(sandboxSkill, /Never ask the pool question when the intent is already explicit\./);
  assert.match(
    sandboxSkill,
    /\[Pool-Selection Gate\]\(#pool-selection-gate-mandatory--do-not-skip\)/,
    'the gate anchor must be linked from at least one cross-reference surface',
  );
});

test('sandbox timeout defaults stay single-sourced (no raw numeric fallbacks)', () => {
  // Since the sandbox pack's family split the handlers live in
  // src/packs/sandbox/handlers-*.ts with tools.ts as the re-export face, so
  // the guard scans every TypeScript module in the pack directory —
  // strictly stronger than the old single-file read: no sibling can smuggle
  // a raw numeric fallback (or drop a table-based one) unnoticed.
  const packDir = join(root, 'plugins', 'huaweicloud-core', 'src', 'packs', 'sandbox');
  const family = readdirSync(packDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => readSource(join('src', 'packs', 'sandbox', entry.name)));
  assert.ok(family.length >= 3, 'sandbox pack family modules expected');
  let fallbacks = 0;
  for (const src of family) {
    assert.doesNotMatch(src, /args\.timeout_ms \|\| \d/, 'handler fallbacks must read SANDBOX_TIMEOUT_MS');
    fallbacks += src.match(/args\.timeout_ms \|\| SANDBOX_TIMEOUT_MS\.\w+/g)?.length ?? 0;
  }
  // 11 since the async-exec claim protocol: the nine legacy timeout-bearing
  // handlers, plus the async-start branch (exec_one_shot_async) and the
  // exec_poll handler (both in handlers-hwexec.ts) — the poll's wait_ms
  // budget folds ON TOP of its table default via
  // resolveHwexecPollTimeoutMs, which is why its fallback reads the table.
  assert.equal(fallbacks, 11, 'eleven tool handlers apply the shared defaults');
});

test('agent-registration reports openclaw registration status', () => {
  const registration = readSource(join('src', 'auth', 'agent-registration.ts'));
  assert.match(registration, /function openclawRegistered\(\)/);
  assert.match(registration, /agent === 'openclaw'/);
  assert.match(registration, /'\.agents', 'huaweicloud-plugins', '\.mcp\.json'/);
});

test('node:sqlite is required inside functions, never at module scope', () => {
  // 2026-11-10: the 2.0.0 tarball install printed "(node:xxxx)
  // ExperimentalWarning: SQLite is an experimental feature" on Node 22.x
  // (the CLI's declared floor) because the OfficeAce connector family
  // required node:sqlite at module scope — every CLI boot, install
  // included, paid the warning (and a hard error below Node 22.5) though
  // only the officeace packs/doctor paths ever open the connector db.
  // agent-registration.ts kept the correct shape all along: its require
  // sits inside officeaceRegistered(). This scan pins that shape for every
  // src module — a require of node:sqlite must never start a line at
  // column 0, the textual signature of a module-scope load. The behavioral
  // half of the guard is test/cli-boot-warnings.test.ts spawning the real
  // CLI and asserting its stderr carries no Node warning lines (that half
  // only has teeth on Node 22.x, where the builtin still warns).
  const srcDir = join(root, 'plugins', 'huaweicloud-core', 'src');
  // Two spellings reach module scope: a top-level `createRequire(...)('node:sqlite')`
  // and an ES import. The import arm joined after PR-1.5's saved-perms reader
  // walked through the require-only scan (its ESM import was invisible to the
  // regex) and printed the warning on every CLI boot on Node 22.19.
  const moduleScopeRequire = /^(?:export\s+)?(?:const|let|var)\b.*\(\s*['"]node:sqlite['"]\s*\)/;
  const moduleScopeImport = /^\s*import\b[^;]*\bfrom\s+['"]node:sqlite['"]/;
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const entryPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(entryPath);
      } else if (entry.name.endsWith('.ts')) {
        for (const [idx, line] of readFileSync(entryPath, 'utf8').split('\n').entries()) {
          if (moduleScopeRequire.test(line) || moduleScopeImport.test(line)) {
            offenders.push(`${relative(srcDir, entryPath)}:${idx + 1}`);
          }
        }
      }
    }
  };
  walk(srcDir);
  assert.deepEqual(
    offenders,
    [],
    'node:sqlite must be loaded lazily inside functions (require or import), never at module scope',
  );
});

test('spawn call sites never combine a non-empty args array with shell', () => {
  // 2026-11-10 report #2: the install's gateway-prompt line carried
  // "(node:xxxx) [DEP0190] DeprecationWarning: Passing args to a child
  // process with shell option true..." — installRuntimeDeps spawned npm
  // with an args array plus shell:true (Node 24 deprecates the shape:
  // shell concatenates the args unescaped). emitWarning defers the
  // stderr write, so the warning surfaced one step later, glued to the
  // provisioning prompt. The fixed shape spawns a string command under
  // shell — identical concatenation semantics minus the warning, and
  // shell stays load-bearing for Windows .cmd routing (#643). Args
  // arrays remain correct for shell-less spawns (gateway/dep-resolve
  // pass argv directly). The scan flags a spawn call whose arguments
  // start with a non-empty array literal while shell:true sits in the
  // call's own options, inline or through the options binding's const
  // initializer. Honest limit: an array passed via an identifier (the
  // update-upgrade seam's args) escapes a textual scan; that line is
  // held by the seam's injected test doubles plus the join inside
  // defaultSpawn. The behavioral half is cli-boot-warnings.test.ts's
  // install spawn, which failed red on Node 24 before the fix.
  const srcDir = join(root, 'plugins', 'huaweicloud-core', 'src');
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const entryPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(entryPath);
      } else if (entry.name.endsWith('.ts')) {
        const rel = relative(srcDir, entryPath);
        const text = readFileSync(entryPath, 'utf8');
        const lines = text.split('\n');
        for (let i = 0; i < lines.length; i++) {
          // Call-start lines only (every args-array spawn in the tree
          // starts its call on one line); the empty-array shell sites
          // (codex family, doctor's hcloud auth check) are excluded by
          // the lookahead.
          if (!/\bspawn(?:Sync)?\([^\n,]*,\s*\[\s*(?!\s*\])/.test(lines[i]!)) continue;
          const window = lines.slice(i, i + 10).join('\n');
          if (/shell:\s*true/.test(window)) {
            offenders.push(`${rel}:${i + 1}`);
            continue;
          }
          const optionsBinding = lines
            .slice(i, i + 7)
            .join('\n')
            .match(/,\s*([A-Za-z_$][\w$]*)\s*\)\s*;/)?.[1];
          if (optionsBinding && new RegExp(`const ${optionsBinding}\\b[\\s\\S]{0,600}?shell:\\s*true`).test(text)) {
            offenders.push(`${rel}:${i + 1}`);
          }
        }
      }
    }
  };
  walk(srcDir);
  assert.deepEqual(
    offenders,
    [],
    'spawn with a non-empty args array must not set shell (DEP0190 on Node 24); pass a string command instead',
  );
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
    'agent-install-agents.test.ts',
    'agent-install-codex.test.ts',
    'agent-install-misc.test.ts',
    'agent-install-native.test.ts',
    'agent-install-opencode.test.ts',
    'auth-agent-registration.test.ts',
    'auth-credentials.test.ts',
    'codearts-adaptation.test.ts',
    'cred-reconcile-e2e.test.ts',
    'cross-platform-install.test.ts',
    'dep-receipts.test.ts',
    'dsh-adaptation.test.ts',
    'hdkitservice-api.test.ts',
    'hook-node.test.ts',
    'issue-443-fix.test.ts',
    'mcp-server-tools.test.ts',
    'officeace-adaptation.test.ts',
    'packs-command.test.ts',
    'plugins-e2e-catalog.test.ts',
    'plugins-e2e.test.ts',
    'proxy-agent.test.ts',
    'reconcile.test.ts',
    'safety-hcloud-args.test.ts',
    'safety-redact.test.ts',
    'safety-secret-gates.test.ts',
    'safety-policy.test.ts',
    'safety-text-command.test.ts',
    'safety-vocabulary.test.ts',
    'setup-packs.test.ts',
    'telemetry.test.ts',
    'uninstall-cleanup.test.ts',
    'update-check.test.ts',
    'upgrade-session.test.ts',
  ]);
  const testDir = join(root, 'test');
  for (const entry of readdirSync(testDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.test.ts')) continue;
    // The guard file itself, plus the one sibling part whose mkdtempSync
    // occurrences are assertion regexes over dep/installers/hcloud.ts source
    // text (never fixture creation) — same exemption class as below.
    if (entry.name === 'structure.test.ts' || entry.name === 'structure-installer-cmds.test.ts') continue;
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
