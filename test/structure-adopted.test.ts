import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { listSkillDirs } from '../plugins/huaweicloud-core/src/lib/skill-tree.ts';
import { pluginRoot, readSource, root } from './structure-helpers.ts';

test('auth reconcile propagates through syncAuth (the seam-tested fan-out)', () => {
  // cmdAuthReconcile once hand-rolled the S1→S2/S3 propagation with a raw
  // readGlobalCredentials() and wrote literal secret:// refs into
  // ~/.obsutilconfig and the KooCLI profile. Delegation to syncAuth is the
  // structural fix; this guard pins it so the propagation cannot be
  // re-hand-rolled off the seam.
  const authCli = readSource(join('src', 'auth', 'cli.ts'));
  const reconcileBody = authCli.slice(
    authCli.indexOf('async function cmdAuthReconcile'),
    authCli.indexOf('async function cmdAuthSync'),
  );
  assert.match(reconcileBody, /syncAuth\(/);
  assert.doesNotMatch(reconcileBody, /writeObsConfig\(/, 'reconcile must not hand-roll the OBS fan-out');
  assert.doesNotMatch(reconcileBody, /runHcloudConfigure\(/, 'reconcile must not hand-roll the KooCLI fan-out');
});

test('adopted huawei-cloud-* skills teach the optional wrapper and the approval write path', () => {
  // The adopted corpus (main's 1.1.8 huawei-cloud-* skills) ships with a
  // mandatory-wrapper doctrine and a network-facing quality CLI. The v2
  // adoption rulings flip both: the wrapper is OPTIONAL (bare hcloud is
  // equivalent; the safety seam classifies both), and the shipped scripts
  // carry no telemetry/network/download surface. Every adopted skill's
  // SKILL.md must carry the two teaching notes, and its scripts must be
  // the normalized forms.
  const adopted = [
    'huawei-cloud-apig-instance-management',
    'huawei-cloud-cts-trace-management',
    'huawei-cloud-dds-dcs-instance-management',
    'huawei-cloud-deployment-task-management',
    'huawei-cloud-dew-key-management',
    'huawei-cloud-gaussdb-instance-management',
    'huawei-cloud-smn-dms-message',
    'huawei-cloud-waf-aad-rule-management',
  ];
  const cliRoot = join(pluginRoot, 'src', 'packs', 'huaweicloud-cli', 'skills');
  const present = listSkillDirs(join(pluginRoot, 'skills'));
  for (const name of adopted) {
    if (!present.includes(name)) continue; // not adopted yet (S-series in flight)
    const skillDir = join(cliRoot, name);
    const skill = readSource(join('src', 'packs', 'huaweicloud-cli', 'skills', name, 'SKILL.md'));
    assert.match(skill, /wrapper is OPTIONAL/i, `${name}: optional-wrapper note missing`);
    assert.match(
      skill,
      /huaweicloud_plan_cli_command[\s\S]{0,120}huaweicloud_run_approved_command/,
      `${name}: approval write-path routing note missing`,
    );
    // The repo-wide service-skill mandate (AGENTS.md): parameters are
    // discovered via --help, not hardcoded. S3 dropped it silently — the
    // guard now pins it for every name on the adopted list (extend the
    // list when adopting a new skill). Two family forms count: the S2/S3
    // blockquote ("Always run `hcloud SVC <Operation> ... --help` before
    // constructing a command") and the S1 list-item phrasing ("Always
    // discover parameters with `hcloud SVC <Operation> --help` before
    // executing").
    assert.match(
      skill,
      /Always (run|discover)[^\n]{0,80}`hcloud [A-Za-z|]+ <Operation>[^\n]{0,80}--help` before/,
      `${name}: --help-first discovery mandate missing`,
    );
    // Doctrine bans across SKILL.md, every reference, AND every template —
    // the mandate and the reporting doctrine were removed by ruling, not
    // reworded. templates/ joined the sweep with S2 (cts): the first adopted
    // skill to ship templates carried dead v1-framework write-gating notes
    // there (ALLOW_WRITES + allow_writes.yaml — no such file exists in v2;
    // the approval chain is the devkit's), caught only by hand.
    const doctrineFiles = [
      join(skillDir, 'SKILL.md'),
      ...readdirSync(join(skillDir, 'references')).map((f) => join(skillDir, 'references', f)),
    ];
    const templatesDir = join(skillDir, 'templates');
    if (existsSync(templatesDir)) {
      doctrineFiles.push(...readdirSync(templatesDir).map((f) => join(templatesDir, f)));
    }
    for (const file of doctrineFiles) {
      const text = readFileSync(file, 'utf8');
      for (const banned of [
        /MUST be wrapped/i,
        /mandatory rule/i,
        /strictly forbidden/i,
        /Quality telemetry is collected/i,
        /SKILL_QUALITY_REPORT/,
        /cli_reporting/,
        /skillsapi\.developer\.myhuaweicloud\.com/,
        /urlretrieve/,
        /allow_writes/i,
        /Quality reporting is delivered/i,
        /hard-binds a report/i,
        /installed by `scripts\/ensure_cli\.sh`/i,
      ]) {
        assert.doesNotMatch(text, banned, `${name}/${file.split(/[/\\]/).pop()}: banned doctrine ${banned}`);
      }
    }
    // The normalized script pair (no reporting module, no network).
    const ensurePath = join(cliRoot, name, 'scripts', 'ensure_cli.sh');
    const ensure = readFileSync(ensurePath, 'utf8');
    assert.match(ensure, /OPTIONAL/i, `${name}: ensure_cli.sh must frame the wrapper as optional`);
    assert.doesNotMatch(ensure, />> ~\/\.bashrc/, `${name}: ensure_cli.sh must not persist PATH`);
    assert.doesNotMatch(ensure, /ln -sf/, `${name}: ensure_cli.sh must not symlink into system dirs`);
    const entry = readFileSync(join(cliRoot, name, 'scripts', 'cli', 'cli_entry.py'), 'utf8');
    assert.match(entry, /ALLOWED_COMMANDS = \("hcloud",\)/, `${name}: whitelist missing`);
    for (const banned of ['urlretrieve', 'urllib.request', 'skillsapi.developer.myhuaweicloud.com', 'cli_reporting']) {
      assert.ok(!entry.includes(banned), `${name}: cli_entry.py must not reference ${banned}`);
    }
    assert.ok(
      !existsSync(join(cliRoot, name, 'scripts', 'cli', 'cli_reporting.py')),
      `${name}: cli_reporting.py must not ship`,
    );
  }
  // The normalized script pair is shared verbatim across every adopted
  // skill and ships non-executable (it is invoked via `bash` / `python3`)
  // — a copy that drifts in content OR file mode fails here (S2's
  // ensure_cli.sh file-mode fork was the first such silent drift).
  const reference: string | undefined = adopted.find((name) => present.includes(name));
  if (reference) {
    for (const rel of ['scripts/ensure_cli.sh', 'scripts/cli/cli_entry.py']) {
      const referenceText: string = readFileSync(join(cliRoot, reference, rel), 'utf8');
      for (const name of adopted) {
        if (!present.includes(name)) continue;
        if (process.platform !== 'win32') {
          assert.equal(
            statSync(join(cliRoot, name, rel)).mode & 0o111,
            0,
            `${name}/${rel} must ship non-executable (invoked via bash/python3)`,
          );
        }
        if (name === reference) continue;
        assert.equal(
          readFileSync(join(cliRoot, name, rel), 'utf8'),
          referenceText,
          `${name}/${rel} must stay byte-identical to ${reference}/${rel}`,
        );
      }
    }
    // The scripts directory carries EXACTLY the family pair — main's corpus
    // shipped extra wrappers (gaussdb_cli.sh region-injector/reporter,
    // smn_dms_skill.py engine, install_cli.sh deployer) whose doctrine the
    // adoption rulings strip; a stray script in any adopted skill fails here
    // (S6's gaussdb_cli.sh drop is the precedent).
    for (const name of adopted) {
      if (!present.includes(name)) continue;
      assert.ok(
        existsSync(join(cliRoot, name, 'scripts')),
        `${name}/scripts must exist with the family pair (ensure_cli.sh + cli/cli_entry.py)`,
      );
      assert.deepEqual(
        readdirSync(join(cliRoot, name, 'scripts')).sort((a, b) => a.localeCompare(b)),
        ['cli', 'ensure_cli.sh'],
        `${name}/scripts must contain exactly the family pair (ensure_cli.sh + cli/cli_entry.py)`,
      );
      assert.deepEqual(
        readdirSync(join(cliRoot, name, 'scripts', 'cli')).sort((a, b) => a.localeCompare(b)),
        ['cli_entry.py'],
        `${name}/scripts/cli must contain exactly cli_entry.py`,
      );
    }
  }
});

test(
  'the normalized skill-quality-cli wrapper dispatches run and enforces the whitelist (executing probe)',
  {
    skip:
      !existsSync(
        join(
          pluginRoot,
          'src',
          'packs',
          'huaweicloud-cli',
          'skills',
          'huawei-cloud-apig-instance-management',
          'scripts',
          'cli',
          'cli_entry.py',
        ),
      ) || spawnSync('python3', ['--version']).error !== undefined,
  },
  () => {
    const entry = join(
      pluginRoot,
      'src',
      'packs',
      'huaweicloud-cli',
      'skills',
      'huawei-cloud-apig-instance-management',
      'scripts',
      'cli',
      'cli_entry.py',
    );
    // version: dispatch reaches the subcommand (the argparse dest must not
    // collide with the REMAINDER positional).
    const version = spawnSync('python3', [entry, 'version'], { encoding: 'utf8', timeout: 30_000 });
    assert.equal(version.status, 0, version.stderr);
    assert.match(version.stdout, /skill-quality-cli/);
    // run: whitelist rejects a non-hcloud child with exit 2 (dispatch +
    // validation both reachable).
    const rejected = spawnSync('python3', [entry, 'run', '--', 'ls'], { encoding: 'utf8', timeout: 30_000 });
    assert.equal(rejected.status, 2, rejected.stderr);
    assert.match(rejected.stderr, /not allowed by the wrapper whitelist/);
    // self-check: local sanity summary.
    const check = spawnSync('python3', [entry, 'self-check'], { encoding: 'utf8', timeout: 30_000 });
    assert.equal(check.status, 0, check.stderr);
    assert.match(check.stdout, /network: none|no network/i);
  },
);

test('agent CLI pins stay in lockstep across e2e-nightly.yml install sites', () => {
  // The codex and opencode pins are a two-place obligation within
  // e2e-nightly.yml (the e2e matrix install step and the real-agents job
  // must test the same binaries — the lane moved out of ci.yml, whose PR
  // gate never installs agent CLIs); nothing else fails on divergence, so
  // this pin makes the obligation mechanical.
  const ci = readFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'utf8');
  const nightly = readFileSync(join(root, '.github', 'workflows', 'e2e-nightly.yml'), 'utf8');
  const extract = (text: string, pkg: string): string[] =>
    [...text.matchAll(new RegExp(`${pkg}@(\\d+\\.\\d+\\.\\d+)`, 'g'))].map((m) => m[1]!);
  for (const pkg of ['opencode-ai', '@openai/codex']) {
    const pins = extract(nightly, pkg);
    assert.ok(
      pins.length >= 2,
      `${pkg} must stay pinned in e2e-nightly.yml's agent-CLI install sites (the e2e matrix step and the real-agents job)`,
    );
    assert.ok(
      new Set(pins).size === 1,
      `${pkg} pins disagree inside e2e-nightly.yml (${pins.join(', ')}) — the agent CLI pins are a two-place event within the file`,
    );
    assert.equal(
      extract(ci, pkg).length,
      0,
      `${pkg} must not be pinned in ci.yml — the plain PR gate never installs agent CLIs (the real-agents lane lives in e2e-nightly.yml)`,
    );
  }
  // The hermes leg is E2E-only (the real-agents job installs
  // opencode/codex, never hermes), so its pin is single-site: the
  // install.sh invocation must carry an exact --commit (a floating
  // --channel stable would drift the leg's spike-validated mechanism set
  // silently).
  const hermesCommit = [...nightly.matchAll(/install\.sh \| bash -s -- [^\n]*--commit ([0-9a-f]{40})/g)].map(
    (m) => m[1]!,
  );
  assert.equal(
    hermesCommit.length,
    1,
    'e2e-nightly.yml must pin the hermes install to exactly one 40-hex commit — an upgrade is an explicit suite event',
  );
  // And the nightly-only staging: hermes must stay off the push and PR
  // lanes (accepted LLM cost, staged rollout). The gate lives at STEP
  // level — GitHub rejects the matrix context in a job-level if (the
  // shape that silently failed this whole workflow's loading from the
  // hermes commit until the move; actionlint and the 0-jobs runs pinned
  // it), so the job-level if must stay matrix-free while the budget
  // control point (the suite step) must carry the gate.
  const e2eJob = nightly.split('  e2e:')[1]!.split('\n  real-agents:')[0];
  const ifAt = e2eJob.indexOf('if: >-');
  assert.ok(ifAt !== -1, 'the e2e job-level if must keep its folded form (an inline re-spelling escapes this pin)');
  const jobIf = e2eJob.slice(ifAt, e2eJob.indexOf('concurrency:'));
  assert.ok(
    !jobIf.includes('matrix'),
    'the e2e job-level if must stay matrix-free (GitHub rejects matrix there and the workflow fails to load)',
  );
  assert.match(
    e2eJob,
    /name: Run agent-level E2E suite[^\n]*\n\s*# The staged gate's budget control point[^\n]*\n(?:\s*#[^\n]*\n)*\s*if: matrix\.agent != 'hermes' \|\| github\.event_name == 'schedule' \|\| github\.event_name == 'workflow_dispatch'/,
    'the suite step must carry the hermes staging gate — it is the only step that spends LLM budget, so dropping its if re-opens the push-lane cost',
  );
  // Event-discriminated trunk groups: the push-lane hermes leg is a green
  // idle job (the staging gate skips its budget steps), and it must never
  // share a concurrency group with the schedule/dispatch suites — a push
  // would evict the in-flight nightly hermes run and replace it with
  // zero coverage.
  assert.match(
    e2eJob,
    /format\('e2e-trunk-\{0\}-\{1\}', github\.event_name, matrix\.agent\)/,
    'the e2e trunk concurrency group must carry the event name — a push-lane idle leg sharing the schedule/dispatch group cancels the only real hermes venue (cancel-in-progress)',
  );
});

test('the e2e driver echo and the workflow grep agree on the contract', () => {
  // runner.ts prints "[runner] driver <id> ..."; the workflow greps the
  // same shape so an E2E_AGENT wiring miss fails loud. A rename on either
  // side must touch both — this pin enforces the agreement.
  const runner = readFileSync(join(root, 'test', 'e2e', 'runner.ts'), 'utf8');
  const nightly = readFileSync(join(root, '.github', 'workflows', 'e2e-nightly.yml'), 'utf8');
  assert.match(runner, /\[runner\] driver \$\{driver\.id\}/, 'the runner must keep echoing the resolved driver id');
  assert.match(
    nightly,
    /grep -q "\\\[runner\\\] driver \$\{\{ matrix\.agent \}\}"/,
    'the workflow must keep grepping the driver echo',
  );
});
