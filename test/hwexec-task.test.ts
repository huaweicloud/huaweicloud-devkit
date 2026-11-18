import assert from 'node:assert/strict';
import test from 'node:test';

import {
  HWEXEC_POLL_HEADROOM_MS,
  HWEXEC_TAIL_BYTES_DEFAULT,
  HWEXEC_WAIT_MS_MAX,
  HWEXEC_WAIT_STEP_MS,
  buildHwexecPollScript,
  buildHwexecStartScript,
  classifyHwexecStartOutput,
  deriveHwexecVerdict,
  escapeHwexecCommand,
  generateHwexecTaskId,
  hwexecPollLoops,
  hwexecTaskDir,
  parseHwexecPollOutput,
  resolveHwexecPollTimeoutMs,
  validateHwexecTaskId,
  validateHwexecTailBytes,
  validateHwexecWaitMs,
  type HwexecPollFacts,
} from '../plugins/huaweicloud-core/src/sandbox/hwexec-task.ts';

// Script-shape pins (the devbridge-scripts.test.ts doctrine): the claim
// protocol's safety lives in the script's line ORDER, so the shapes are
// pinned textually — the claim create strictly before the spawn, the O_EXCL
// idiom, the session-survival trio with its fallback, and the poll's
// variable-concatenation guard.

test('hwexec start script: the O_EXCL claim strictly precedes the spawn (claim-before-spawn line order)', () => {
  const script = buildHwexecStartScript('t-shape-1', 'npm run build');
  const claimIdx = script.indexOf('if (set -C; : > "$D/claim") 2>/dev/null; then');
  const spawnIdx = script.indexOf('setsid nohup sh -c');
  const dupIdx = script.indexOf('elif [ -f "$D/claim" ]; then');
  assert.ok(claimIdx !== -1, 'the O_EXCL claim idiom must be present');
  assert.ok(spawnIdx !== -1, 'the setsid spawn must be present');
  assert.ok(claimIdx < spawnIdx, 'claim MUST precede spawn — the claim is the only spawn arbiter');
  // The elif only classifies the failed create — it sits after the spawn
  // block, never before it.
  assert.ok(dupIdx > spawnIdx, 'the dup classification must follow the spawn branch');
  // O_EXCL idiom verbatim: noclobber + create-only redirect, stderr eaten.
  assert.ok(script.includes('(set -C; : > "$D/claim") 2>/dev/null'));
});

test('hwexec start script: the falsified guard-file variant cannot reappear', () => {
  // HwExecGuard3's OneCopyRunning counterexample lives in any pre-spawn
  // check of the launched guard. The real script must contain NO launched
  // test at all — launched appears only inside the wrapper (its first
  // action, after the claim), and never as a spawn gate.
  const script = buildHwexecStartScript('t-shape-1', 'npm run build');
  assert.ok(!script.includes('[ -f "$D/launched" ]'), 'no pre-spawn launched check may exist');
  const claimIdx = script.indexOf('if (set -C; : > "$D/claim")');
  const launchedIdx = script.indexOf('launched');
  assert.ok(launchedIdx > claimIdx, 'launched only ever appears inside the wrapper, after the claim');
});

test('hwexec start script: session-survival trio with the setsid-missing fallback and guarded disown', () => {
  const script = buildHwexecStartScript('t-shape-1', 'npm run build');
  // #919/#922: the same guarded form as devbridge-expose.ts — setsid when
  // available, bare nohup otherwise, both with the tty-dropping stdin.
  assert.match(
    script,
    /if command -v setsid > \/dev\/null 2>&1; then setsid nohup sh -c '.*' >\/dev\/null 2>&1 < \/dev\/null & else nohup sh -c '.*' >\/dev\/null 2>&1 < \/dev\/null & fi/,
  );
  // Guarded disown inside the claim-success branch (the brief's two-space
  // indent), same guard form as devbridge-expose.ts.
  assert.match(script, /^ {2}disown 2>\/dev\/null \|\| true$/m);
});

test('hwexec start script: the wrapper is guard-first, log-appending, status-committing, path-inlined', () => {
  const script = buildHwexecStartScript('t-shape-1', 'npm run build');
  // The wrapper's sh -c carries LITERAL paths (its fresh shell sees no $D,
  // and pgrep -f liveness matches the literal launched path in its own
  // command line): guard write, subshell'd command with redirections over
  // the whole compound, then the exit-status commit.
  assert.ok(
    script.includes(
      ': > "/tmp/.hwexec/t-shape-1/launched"; ( npm run build ) >> "/tmp/.hwexec/t-shape-1/log" 2>&1; echo "exit:$?" > "/tmp/.hwexec/t-shape-1/status"',
    ),
  );
  // The cmd file write (diagnostics only; poll never reads it).
  assert.ok(script.includes(`printf '%s\\n' 'npm run build' > "$D/cmd"`));
  // Receipt echoes: started / dup / claim-error classification.
  assert.ok(script.includes('echo "HW_STARTED=t-shape-1"'));
  assert.ok(script.includes('echo "HW_DUP=t-shape-1"'));
  assert.ok(script.includes('echo "HW_CLAIM_ERROR=1"'));
});

test('hwexec start script: embedded single quotes are escaped for both single-quoted spans', () => {
  const script = buildHwexecStartScript('t-shape-2', "echo 'done' && exit 3");
  assert.equal(escapeHwexecCommand("echo 'done'"), String.raw`echo '\''done'\''`);
  // The cmd write and the wrapper's sh -c both carry the escaped form.
  assert.ok(script.includes(String.raw`printf '%s\n' 'echo '\''done'\'' && exit 3' > "$D/cmd"`));
  assert.ok(script.includes(String.raw`( echo '\''done'\'' && exit 3 ) >> "/tmp/.hwexec/t-shape-2/log" 2>&1`));
});

test('hwexec start script: task ids are validated before any interpolation', () => {
  for (const bad of ['Bad-Id', '../escape', 'a;b', '', 'x'.repeat(65), 'a b', 'héllo']) {
    assert.throws(() => buildHwexecStartScript(bad, 'true'), /invalid task_id/, `expected rejection for ${bad}`);
  }
  assert.equal(validateHwexecTaskId('t-ok-1'), 't-ok-1');
  assert.match(generateHwexecTaskId(), /^t-[0-9a-f]{12}$/);
  assert.equal(hwexecTaskDir('t-ok-1'), '/tmp/.hwexec/t-ok-1');
});

test('hwexec poll script: the pgrep pattern is built by quoted concatenation, never literal', () => {
  const script = buildHwexecPollScript('t-shape-1', 0, 4096);
  // The pattern VALUE (hwexec/t-shape-1/launched) must never appear
  // literally in the script text: a shell whose command line carries this
  // script (an sh -c wrapper) would match itself and read every task as
  // alive. Both construction lines carry the concatenated-fragment form.
  assert.ok(script.includes('P="hwexec/""t-shape-1""/launched"'));
  assert.ok(script.includes('D="/tmp/"".hwexec/""t-shape-1"'));
  assert.ok(!script.includes('hwexec/t-shape-1/launched'), 'the pattern value must not appear literally');
  assert.ok(!script.includes('/tmp/.hwexec/t-shape-1'), 'the task dir must not appear literally either');
  // The /launched suffix anchors the pattern to THIS task's wrapper — a
  // bare hwexec/<id> prefix would also match hwexec/<id>-suffix siblings.
  assert.ok(script.includes('pgrep -f "$P"'));
});

test('hwexec poll script: the bounded wait loop folds from wait_ms (floor), content-matched status', () => {
  const zero = buildHwexecPollScript('t-shape-1', 0, 4096);
  assert.ok(zero.includes('while [ "$i" -lt 0 ]; do'), 'wait_ms 0 → no wait iterations');
  const minute = buildHwexecPollScript('t-shape-1', 60000, 4096);
  assert.ok(minute.includes('while [ "$i" -lt 30 ]; do'), 'wait_ms 60000 → 30 sleep-2 iterations');
  assert.ok(minute.includes('sleep 2'));
  // Early exit the moment the status line commits — content-matched, never
  // existence-matched (a torn/empty status file keeps waiting and finally
  // reads as running).
  assert.ok(minute.includes(String.raw`grep -q '^exit:[0-9][0-9]*$' "$D/status" 2>/dev/null && break`));
  assert.ok(minute.includes(String.raw`S=$(grep -m1 '^exit:[0-9][0-9]*$' "$D/status" 2>/dev/null || true)`));
  assert.ok(minute.includes('echo "HW_STATUS=$S"'));
});

test('hwexec poll script: field echoes, log fence, and no line-initial HW_ token', () => {
  const script = buildHwexecPollScript('t-shape-1', 0, 4096);
  for (const field of ['HW_DIR=', 'HW_STATUS=', 'HW_ALIVE=', 'HW_LAUNCHED=']) {
    assert.ok(script.includes(`echo "${field}`), `field ${field} must be echoed`);
  }
  assert.ok(script.includes('echo "HW_LOG_BEGIN"'));
  assert.ok(script.includes('echo "HW_LOG_END"'));
  assert.ok(script.includes('tail -c 4096 "$D/log" 2>/dev/null'));
  // Echo-injection guard: no script line starts with an HW_ field name —
  // an echoed script line can never spoof the anchored ^KEY= parser.
  for (const line of script.split('\n')) {
    assert.ok(!line.startsWith('HW_'), `script lines must not start with a field name: ${line}`);
  }
});

test('hwexec poll script: wait_ms and tail_bytes are validated before interpolation', () => {
  assert.throws(() => buildHwexecPollScript('t-shape-1', 60001, 4096), /invalid wait_ms/);
  assert.throws(() => buildHwexecPollScript('t-shape-1', -1, 4096), /invalid wait_ms/);
  assert.throws(() => buildHwexecPollScript('t-shape-1', 0, 0), /invalid tail_bytes/);
  assert.throws(() => buildHwexecPollScript('t-shape-1', 0, 65537), /invalid tail_bytes/);
  assert.equal(validateHwexecWaitMs(undefined), 0);
  assert.equal(validateHwexecTailBytes(undefined), 4096);
  assert.equal(validateHwexecTailBytes('8192'), 8192);
});

test('hwexec budget pins: the bounded wait total never exceeds wait_ms, and the exec timeout folds with headroom', () => {
  assert.equal(HWEXEC_WAIT_MS_MAX, 60000);
  assert.equal(HWEXEC_TAIL_BYTES_DEFAULT, 4096);
  assert.equal(HWEXEC_POLL_HEADROOM_MS, 15000);
  // Floor folding: total sleep = loops × 2s ≤ wait_ms at every legal wait.
  for (const waitMs of [0, 1, 2000, 5000, 59999, 60000]) {
    assert.ok(hwexecPollLoops(waitMs) * HWEXEC_WAIT_STEP_MS <= waitMs, `wait ${waitMs}ms must cover its own sleeps`);
  }
  assert.equal(hwexecPollLoops(60000), 30);
  // The A2 budget doctrine: wait_ms + 15s headroom, never below the floor.
  assert.equal(resolveHwexecPollTimeoutMs(0, 30000), 30000);
  assert.equal(resolveHwexecPollTimeoutMs(20000, 30000), 35000);
  assert.equal(resolveHwexecPollTimeoutMs(60000, 30000), 75000);
  assert.equal(resolveHwexecPollTimeoutMs(60000, 90000), 90000);
});

// Parser + verdict-table pins — the judgment is derived ONLY from the parsed
// discriminated union, never from raw stdout downstream.

const facts = (over: Partial<HwexecPollFacts>): HwexecPollFacts => ({
  dir: true,
  status: '',
  alive: false,
  launched: true,
  logTail: '',
  ...over,
});

test('hwexec parseHwexecPollOutput: full field set, log fence, and torn-status handling', () => {
  const parsed = parseHwexecPollOutput(
    'HW_DIR=1\nHW_STATUS=exit:3\nHW_ALIVE=0\nHW_LAUNCHED=1\nHW_LOG_BEGIN\nline one\nline two\nHW_LOG_END\n',
  );
  assert.equal(parsed.dir, true);
  assert.equal(parsed.status, 'exit:3');
  assert.equal(parsed.alive, false);
  assert.equal(parsed.launched, true);
  assert.equal(parsed.logTail, 'line one\nline two');
  // A torn (empty) status field stays empty — it is a CONTENT match, so a
  // half-written file reads as not-done, never as a wrong exit code.
  const torn = parseHwexecPollOutput('HW_DIR=1\nHW_STATUS=\nHW_ALIVE=1\nHW_LAUNCHED=1\nHW_LOG_BEGIN\nHW_LOG_END\n');
  assert.equal(torn.status, '');
  // The done verdict wins even while the wrapper is still exiting.
  assert.equal(deriveHwexecVerdict(torn, true).verdict, 'running');
});

test('hwexec parseHwexecPollOutput: log content cannot spoof verdict fields', () => {
  // Fields are read only from the region before HW_LOG_BEGIN — a command
  // whose output mints HW_DIR=0 / HW_STATUS= lines cannot bend the verdict.
  const parsed = parseHwexecPollOutput(
    'HW_DIR=1\nHW_STATUS=exit:0\nHW_ALIVE=0\nHW_LAUNCHED=1\nHW_LOG_BEGIN\nHW_DIR=0\nHW_STATUS=exit:99\nHW_LOG_END\n',
  );
  assert.equal(parsed.dir, true);
  assert.equal(parsed.status, 'exit:0');
  assert.equal(parsed.logTail, 'HW_DIR=0\nHW_STATUS=exit:99');
});

test('hwexec parseHwexecPollOutput: missing verdict fields throw (fail-closed, never default)', () => {
  // A truncated/garbled output must fail the poll outright: a defaulted
  // never/lost would send the caller to a new task_id while a copy still
  // runs.
  assert.throws(() => parseHwexecPollOutput(''), /HW_DIR/);
  assert.throws(() => parseHwexecPollOutput('HW_DIR=1\n'), /HW_STATUS/);
  assert.throws(() => parseHwexecPollOutput('HW_DIR=1\nHW_STATUS=\n'), /HW_ALIVE/);
  assert.throws(() => parseHwexecPollOutput('HW_DIR=1\nHW_STATUS=\nHW_ALIVE=0\n'), /HW_LAUNCHED/);
});

test('hwexec parseHwexecPollOutput survives OSC/CSI-wrapped output (#946)', () => {
  const noisy = parseHwexecPollOutput(
    '\x1b]133;C\x07HW_DIR=1\r\n\x1b[?2026hHW_STATUS=exit:0\r\n\x1b]133;C\x07HW_ALIVE=0\r\nHW_LAUNCHED=1\r\nHW_LOG_BEGIN\nok\nHW_LOG_END\n',
  );
  assert.equal(noisy.dir, true);
  assert.equal(noisy.status, 'exit:0');
  assert.equal(noisy.alive, false);
  assert.equal(noisy.launched, true);
  assert.equal(noisy.logTail, 'ok');
});

test('hwexec verdict table: the five states, in the judgment order', () => {
  // dir absent: lost when the client remembers the task (reboot), else unknown.
  const dirGone = facts({ dir: false, launched: false });
  assert.equal(deriveHwexecVerdict(dirGone, true).verdict, 'lost');
  assert.equal(deriveHwexecVerdict(dirGone, false).verdict, 'unknown');
  // status committed → done (even with the wrapper still up: the committed
  // status is the truth, per the spec's Verdict order).
  const done = facts({ status: 'exit:0', alive: true, logTail: 'out' });
  const doneVerdict = deriveHwexecVerdict(done, true);
  assert.equal(doneVerdict.verdict, 'done');
  if (doneVerdict.verdict === 'done') {
    assert.equal(doneVerdict.exitCode, 0);
    assert.equal(doneVerdict.logTail, 'out');
  }
  // torn status + alive → running (the convergence rule).
  assert.equal(deriveHwexecVerdict(facts({ status: '', alive: true }), true).verdict, 'running');
  // launched && !alive && no status → lost (ran and was lost).
  assert.equal(deriveHwexecVerdict(facts({ status: '', alive: false, launched: true }), true).verdict, 'lost');
  // !launched && !alive → never (claimed, the exec died before spawn).
  assert.equal(deriveHwexecVerdict(facts({ status: '', alive: false, launched: false }), true).verdict, 'never');
  // knowTask never changes a dir-present verdict.
  assert.equal(deriveHwexecVerdict(facts({ status: '', alive: false, launched: false }), false).verdict, 'never');
});

test('hwexec classifyHwexecStartOutput: the four receipt outcomes', () => {
  assert.equal(classifyHwexecStartOutput('HW_STARTED=t-1\n', 't-1'), 'started');
  assert.equal(classifyHwexecStartOutput('HW_DUP=t-1\n', 't-1'), 'dup');
  assert.equal(classifyHwexecStartOutput('HW_CLAIM_ERROR=1\n', 't-1'), 'claim_error');
  // A cross-task id never reads as this task's started receipt.
  assert.equal(classifyHwexecStartOutput('HW_STARTED=other\n', 't-1'), 'uncertain');
  // Lost output (timeout ate the echoes, truncation) → uncertain: the
  // receipt is gone, which is what the same-task_id retry ladder covers.
  assert.equal(classifyHwexecStartOutput('', 't-1'), 'uncertain');
  assert.equal(classifyHwexecStartOutput('\x1b]133;C\x07HW_STARTED=t-1\r\n', 't-1'), 'started');
});
