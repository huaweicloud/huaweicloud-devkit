import { asText } from '../lib/as-text.ts';
import type { RiskDecision } from '../risk-rule-engine.ts';
import { classifyHcloudArgs } from './classify-hcloud.ts';
import { credentialFileCandidates } from './credential-path.ts';
import { DEFAULT_POLICY } from './default-policy.ts';
import { matchesAny, type ClassifyOptions } from './policy.ts';
import { applyRawCommandRiskRules } from './risk-merge.ts';
import { unwrapSecretExecWrapper } from './secret-exec.ts';
import { unwrapSkillQualityCli } from './skill-quality-cli.ts';
import {
  decodeAnsiCSpans,
  splitShellSegments,
  splitSimpleCommand,
  splitSimpleCommandGlued,
  stripShellQuotes,
} from './shell-text.ts';
import {
  basenameOf,
  COMMAND_POSITION_PREFIXES,
  isEnvAssignment,
  isHcloudToken,
  isRedirectionToken,
  OBSUTIL_WRITES,
  SHELL_FIRST_TOKENS,
  skipPrefixArguments,
} from './tokens.ts';
import { unwrapWithWindowsFlag } from './unwrap.ts';
import { windowsScriptArgAt } from './windows.ts';
import { SECRET_SHADOW_RE, SECRET_TEXT_RE } from './vocabulary.ts';

// The SCRIPT a wrapper carries (py's _script_of doctrine, interrogate
// round 11): shell -c / eval / windows-payload script text, with the
// head-stripping (redirections, env assignments, prefixes) py's probe
// loop applies — so `watch bash -c '…'`, `2>/dev/null bash -c '…'`,
// `HW_REGION=x bash -c '…'` all reach the script. The script re-runs the
// full segment walk (glued fallback included) recursively — that
// recursion is where py catches non-first-command and prefix-wrapped
// glued writes. Depth-capped at 18 (py's nested budget, one past the
// Linux executability ceiling).
function scriptTextOf(tokens: string[], depth = 0): string | null {
  if (depth >= 18 || tokens.length === 0) return null;
  const first = String(tokens[0]).toLowerCase();
  const base = basenameOf(String(tokens[0]).toLowerCase());
  const isShell = SHELL_FIRST_TOKENS.has(first) || (base !== first && SHELL_FIRST_TOKENS.has(base));
  if (isShell) {
    // Flags may precede -c (interrogate rounds 12-13: `bash -e -c '…'` and
    // `bash -o pipefail -c '…'` both execute the script) — skip non-c flag
    // clusters, LONG flags, and value-bearing flags with their values, then
    // require a c-CONTAINING cluster (c anywhere: -ce, -cxe).
    let i = 1;
    while (i < tokens.length) {
      // Round 17 C1: the flag-skip compares the NORMALIZED token (the
      // round-16 normalizer reached the interpreter branch but not this
      // one — `bash -'o' pipefail -c` executed).
      const tok = normalizeFlagToken(tokens[i] ?? '');
      if (/^--[a-z-]+$/i.test(tok)) {
        i++;
        continue;
      }
      // Value-bearing flags FIRST (o is inside the [a-bd-z] class — the
      // generic skip must not eat their values): -o pipefail → skip 2.
      if (/^-o$/i.test(tok) || /^--option$/i.test(tok)) {
        i += 2;
        continue;
      }
      if (/^-[a-bd-z]+$/i.test(tok)) {
        i++;
        continue;
      }
      break;
    }
    if (/^-[a-z]*c[a-z]*$/i.test(normalizeFlagToken(tokens[i] ?? '')) && i + 1 < tokens.length) {
      const script = String(tokens[i + 1])
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\');
      // py's join doctrine: a script word that is itself a command head
      // re-joins the invocation's tail — the flattened join of a quoted
      // original.
      const headTok = splitSimpleCommand(script)[0];
      const head = headTok !== undefined ? String(headTok).toLowerCase() : '';
      const headIsCommandish =
        headTok !== undefined &&
        (SHELL_FIRST_TOKENS.has(head) ||
          head === 'eval' ||
          COMMAND_POSITION_PREFIXES.has(head) ||
          isHcloudToken(String(headTok)));
      return headIsCommandish && i + 2 < tokens.length
        ? [script, ...tokens.slice(i + 2).map((token) => String(token))].join(' ')
        : script;
    }
  }
  if (first === 'eval' && tokens.length > 1) {
    return tokens
      .slice(1)
      .map((token) => String(token).replace(/\\"/g, '"').replace(/\\\\/g, '\\'))
      .join(' ');
  }
  // watch runs its command arguments as an sh -c SCRIPT (the join of the
  // words after its own flags — interrogate round 11: `watch -n1 '"hcl"oud
  // ECS Delete'` executes the glued bin through that join).
  // Round 17 C3: the watch head strips quote-mangling (`wat'ch'`).
  if (first.replace(/['"\\$]/g, '') === 'watch' && tokens.length > 1) {
    return skipPrefixArguments('watch', tokens.slice(1))
      .map((token) => String(token))
      .join(' ');
  }
  // Interpreter carriers (interrogate rounds 12-13): perl/python/node/ruby
  // code flags and awk's program argument carry CODE whose system()-embedded
  // string is a shell command — `python3 -c 'import os;
  // os.system("hcloud ECS DeleteServers")'` executes the write. Round 13:
  // the head is NORMALIZED (interpreterHeadOf — version-suffix collapse,
  // awk family), benign flags before the code flag are skipped
  // (`python3 -u -c …`), awk's -v/-f value flags are skipped, and the flag
  // table is per-interpreter (perl/ruby/node: -e only — their -c is
  // syntax-check; python: -c). The system() strings re-run the walk; the
  // OTHER invocation APIs (subprocess/execSync/popen) are closed by the
  // deny-opaque gate's code-context signal, not enumerated here.
  const interpreter = interpreterHeadOf(first);
  if (interpreter !== null && tokens.length > 1) {
    let i = 1;
    while (i < tokens.length && /^-[a-bd-z][a-z]*$/i.test(normalizeFlagToken(tokens[i] ?? ''))) i++;
    const flag = normalizeFlagToken(tokens[i] ?? '');
    const codeFlag =
      interpreter === 'python' ? /^-[a-z]*c[a-z]*$/i.test(flag) : /^-[a-z]*e[a-z]*$/i.test(flag) || flag === '--eval';
    if (codeFlag && i + 1 < tokens.length) {
      return interpreterSystemCommands(
        tokens
          .slice(i + 1)
          .map((token) => String(token))
          .join(' '),
      );
    }
    if (interpreter === 'awk') {
      // awk: skip -v/-f value flags and plain flags before the program.
      let j = 1;
      while (j < tokens.length) {
        const tok = String(tokens[j]);
        if (tok === '-v' || tok === '-f' || tok === '--file' || tok === '--assign') {
          j += 2;
          continue;
        }
        if (/^-[a-z]+$/i.test(tok)) {
          j++;
          continue;
        }
        break;
      }
      if (j < tokens.length) {
        return interpreterSystemCommands(String(tokens[j]));
      }
    }
  }
  const win = windowsScriptArgAt(tokens, 0);
  if (win !== null) return win;
  if (isRedirectionToken(String(tokens[0]))) return scriptTextOf(tokens.slice(1), depth + 1);
  if (isEnvAssignment(first)) return scriptTextOf(tokens.slice(1), depth + 1);
  const secretExecChild = unwrapSecretExecWrapper(tokens);
  if (secretExecChild) return scriptTextOf(secretExecChild, depth + 1);
  const sqcChild = unwrapSkillQualityCli(tokens);
  if (sqcChild) return scriptTextOf(sqcChild, depth + 1);
  // Round 19 F3: the prefix comparison strips quote-mangling
  // (`busyb'ox' awk`, `en'v' watch -n1 …`).
  if (
    COMMAND_POSITION_PREFIXES.has(first.replace(/['"\\$]/g, '')) ||
    COMMAND_POSITION_PREFIXES.has(base.replace(/['"\\$]/g, ''))
  ) {
    return scriptTextOf(skipPrefixArguments(base, tokens.slice(1)), depth + 1);
  }
  return null;
}

// The shell command embedded in interpreter code via system("…") /
// os.system('…') (interrogate round 12) — the direct-string form only;
// indirection through variables and other invocation APIs is a documented
// residual (the shell-indirection doctrine).
// The shell command(s) embedded in interpreter code via system("…") /
// os.system('…') (interrogate rounds 12-13) — ALL matches at STATEMENT
// position (preceded by start/;/newline/} — `print("system('…')")` is a
// printed string, not a call), joined with ';' so the walk classifies each
// as its own segment. Direct-string form only; variable indirection and
// other invocation APIs are the documented residual — for those, the
// deny-opaque gate below is the closure.
function interpreterSystemCommands(code: string): string | null {
  const re = /(?:^|[;\n}])\s*(?:os\.)?system\(\s*(['"])([\s\S]*?)\1\s*\)/g;
  const commands: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) commands.push(m[2] ?? '');
  return commands.length > 0 ? commands.join(';\n') : null;
}

// Round 16 C4: closed-quote-mangled code flags (`-'c'`) — strip quotes/
// backslashes/dollars from a flag token before the code-flag class tests
// (the word-gluing doctrine; the head got it in round 15, the flags did
// not).
function normalizeFlagToken(token: string): string {
  return String(token).replace(/['"\\$]/g, '');
}

// Interpreter head normalization (interrogate round 13): basename +
// version-suffix collapse — python3.11 → python, gawk/mawk/nawk → awk,
// perl5 → perl, nodejs → node, raku → ruby.
function interpreterHeadOf(head: string): 'python' | 'perl' | 'ruby' | 'node' | 'awk' | null {
  // Round 15 C-B: closed-quote mangling (`pyth'on3'`) — strip quotes,
  // backslashes, and dollars before matching (the round-9 word-gluing
  // doctrine; `pyth'on3'` reconstructs to python3).
  const h = String(head)
    .toLowerCase()
    .replace(/['"\\$]/g, '')
    .replace(/[\d.]+$/, '');
  if (/^(python|pypy)$/.test(h)) return 'python';
  if (/^perl$/.test(h)) return 'perl';
  if (/^(ruby|raku)$/.test(h)) return 'ruby';
  if (/^node$/.test(h)) return 'node';
  if (/^(awk|gawk|mawk|nawk)$/.test(h)) return 'awk';
  return null;
}

// The DENY-OPAQUE pivot (interrogate round 13, the coordinator's design
// boundary): enumerating bash's carrier grammar to SEE THROUGH it is
// non-convergent — the carrier space is unbounded (xargs/env/nohup/awk
// system()/perl -e/python -c/make -f/ssh/parallel/…). When the walk hits a
// context it cannot fully traverse AND one of OUR tokens appears in the
// line in any walkable form, deny fail-closed with the sanctioned-paths
// remediation instead of vision. The three opacity signals:
//   (a) FRAGMENTED token — the glued/decoded re-join reveals our bin while
//       the raw segment hides it (`"hcl"oud`): the fragmentation itself is
//       what required vision;
//   (b) EXPANSION marker — $' / $" / $( / backtick / <( / >( anywhere in
//       the payload (the substitution splits the marker from its segment):
//       the walk cannot reconstruct substitution-built argv;
//   (c) INTERPRETER CODE — a code-flag argument (-c/-e code, awk program):
//       code context is definitionally non-traversable, and a token inside
//       code could execute through any invocation API (the exact
//       subprocess/execSync family round 13 proved executable).
// Lines with no token anywhere stay allowed (not our business); plain
// contiguous tokens inside plain quoting with no markers stay allowed
// (prose mentions — the git-commit/echo/docker pinned allows): the
// over-deny direction is fail-closed by doctrine, the 3-layer model's MCP
// approval chain is the backstop for what one text layer cannot prove.
function opaqueCarrierDenied(segment: string, plainTokens: string[], wholeText: string): RiskDecision | null {
  const gluedJoined = splitSimpleCommandGlued(segment).join(' ');
  const decoded = stripShellQuotes(decodeAnsiCSpans(segment));
  const bins = [
    'hcloud',
    'hcloud.exe',
    'huaweicloud-devkit',
    'setup-cli.js',
    'setup-cli.mjs',
    'setup-cli.ts',
    'setup-cli.cjs',
    'setup.cjs',
  ];
  const wordIn = (text: string, bin: string): boolean =>
    new RegExp(`(^|[^a-z0-9.-])${bin.replace(/[.\-_]/g, (c) => `\\${c}`)}([^a-z0-9.-]|$)`, 'i').test(text);
  const contiguousIn = (text: string, bin: string): boolean => text.toLowerCase().includes(bin);
  // Presence is CONTIGUOUS-includes (round 14 C1: `${X:-hcloud}` — the
  // wordIn boundary excludes `-`, so the default-expanded token was
  // invisible; the coordinator's rule is "appears ANYWHERE in the line").
  const presentAnywhere = (bin: string): boolean =>
    contiguousIn(segment, bin) || wordIn(gluedJoined, bin) || wordIn(decoded, bin);
  const hasToken = bins.some((bin) => presentAnywhere(bin));
  if (!hasToken) return null;
  // (a) fragmented token: a walkable re-join reveals the bin the raw hides.
  const fragmented = bins.some(
    (bin) => (wordIn(gluedJoined, bin) || wordIn(decoded, bin)) && !contiguousIn(segment, bin),
  );
  // (b) expansion marker anywhere in the payload.
  // Round 14 (C1): ${ parameter expansion joins the marker set.
  const marker = /\$['"]|\$\(|\$\{|`|<\(|>\(/.test(wholeText);
  // (c) interpreter code context: the probe-stripped head is an interpreter
  // with a code flag (or an awk program).
  let codeContext = false;
  const { stream } = unwrapWithWindowsFlag(plainTokens);
  const head = stream.length > 0 ? interpreterHeadOf(basenameOf(String(stream[0]).toLowerCase())) : null;
  if (head !== null) {
    const rest = stream.slice(1).map((token) => String(token));
    if (head === 'awk') {
      codeContext = rest.some((tok) => !tok.startsWith('-')) || rest.includes('-v') || rest.includes('-f');
    } else {
      // Round 14 C4: a stdin heredoc (`python3 <<'EOF' …`) is code context
      // too — the body is interpreter code.
      codeContext =
        rest.some((tok) => {
          const f = normalizeFlagToken(tok);
          return head === 'python' ? /^-[a-z]*c[a-z]*$/i.test(f) : /^-[a-z]*e[a-z]*$/i.test(f) || f === '--eval';
        }) || /<<<?/.test(segment);
    }
  }
  if (!fragmented && !marker && !codeContext) return null;
  return {
    decision: 'deny',
    risk: 'invalid',
    reason:
      'an opaque command carrier (script/interpreter/exec context) mentions Huawei Cloud commands but cannot be safely classified. Write the command in plain form, or use the sanctioned MCP paths (huaweicloud_run_readonly_command for reads / huaweicloud_run_approved_command for writes).',
  };
}

// The body of a heredoc/herestring a SHELL bin reads as its script
// (interrogate round 11: `bash <<EOF\n"hcl"oud ECS Delete\nEOF` executes
// the body — the -c machinery never fires without the flag). The segment
// keeps the body inline (splitShellSegments models heredocs), so the body
// is sliced between the marker line and the delimiter line. Round 12
// completions: the head's FIRST word (after optional redirections) must be
// the shell bin — flags and stdin-redirects may sit between it and the
// marker (`bash -s <<EOF`, `bash < in <<EOF`), and an argument-position
// shell word (`echo sh <<EOF`) does NOT make the body a script; the marker
// line may carry trailing live text (`bash <<EOF 2>/dev/null`, `bash
// <<EOF; echo hi`); the delimiter may be double-quoted; the herestring
// match is position-0 (a `<<<` line INSIDE a body is body text, not the
// marker — the /m port bug).
// Round 15 C-A: the shell-head check via the walk's own probe grammar —
// prefixes (value-flag aware), env assignments, and redirections (a BARE
// operator carries its operand as the next token) may all sit before the
// shell bin. The head's first non-strippable word must be the shell bin;
// an argument-position shell word (`echo sh <<EOF`) does not make the
// body a script.
function shellHeadBefore(segment: string, endIndex: number): boolean {
  let probe = splitSimpleCommand(segment.slice(0, endIndex)).map((t) => String(t));
  for (let d = 0; d < 18 && probe.length > 0; d++) {
    const tok = probe[0]!;
    if (isRedirectionToken(tok)) {
      probe = /^[<>]&?$/.test(tok) ? probe.slice(2) : probe.slice(1);
      continue;
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tok)) {
      probe = probe.slice(1);
      continue;
    }
    // Round 19 F2: the prefix comparison strips quote-mangling
    // (`en'v' bash <<EOF`).
    const lower = tok.toLowerCase().replace(/['"\\$]/g, '');
    const base = basenameOf(lower);
    if (COMMAND_POSITION_PREFIXES.has(lower) || COMMAND_POSITION_PREFIXES.has(base)) {
      probe = skipPrefixArguments(base, probe.slice(1));
      continue;
    }
    break;
  }
  // Round 16 C1: closed-quote mid-token mangling (`ba'sh'`) — strip
  // quotes/backslashes/dollars from the head word before matching (the
  // word-gluing doctrine; round 15 fixed the interpreter heads, this is
  // the shell twin).
  const headWord = probe.length > 0 ? basenameOf(String(probe[0]).toLowerCase()).replace(/['"\\$]/g, '') : '';
  return /^(bash|sh|zsh|dash)(\.exe)?$/.test(headWord);
}

function heredocScriptText(segment: string): string | null {
  const markerIndex = segment.search(/<<<?-?/);
  if (markerIndex < 0) return null;
  // Round 15 C-A: the shell-head probe (prefix/env/redirection aware —
  // `env bash <<EOF`, `X=1 bash <<EOF`, `timeout 5 bash <<EOF`,
  // `< in bash <<EOF`).
  if (!shellHeadBefore(segment, markerIndex)) return null;
  const rest = segment.slice(markerIndex);
  const herestring = /^<<<\s*(.+)$/.exec(rest);
  if (herestring) {
    // The herestring word is ONE argv-ish blob bash parses as a script:
    // strip the edge quotes so the walk's tokenizers see the command.
    return (herestring[1] ?? '').replace(/^['"]|['"]$/g, '');
  }
  const m = /^<<-?\s*(['"]?)([A-Za-z0-9_]+)\1?[^\n]*\n/.exec(rest);
  if (!m) return null;
  const delim = m[2]!;
  const body = rest.slice(m[0].length);
  const end = body.indexOf(`\n${delim}`);
  return end < 0 ? body : body.slice(0, end);
}

// The glued-bin walk (interrogate rounds 9-11): per segment, the script
// carriers (shell -c / eval / windows payloads / heredoc bodies) recurse
// into the full walk, and the GLUED re-join of every segment classifies —
// for fragments AND for plain-leading segments (the glued argv differs
// from plain exactly when quotes fragmented an argv word — the ownership
// is the VERDICT COMPARISON, not a skip). The empty-argv + plain-leading
// shape stays owned by the standard machinery (xargs-feeder context); a
// glued bin the plain stream never saw takes the PREVIOUS segment's
// tokens as its feeder (the xargs doctrine). Returns the deny verdict or
// null.
function gluedWriteDenied(
  text: string,
  options: ClassifyOptions,
  narrowRouted: boolean,
  depth: number,
  saw: { value: boolean } = { value: false },
): RiskDecision | null {
  if (depth >= 18) return null;
  const segments = splitShellSegments(text);
  let prevTokens: string[] = [];
  for (let segIndex = 0; segIndex < segments.length; segIndex++) {
    const segment = segments[segIndex]!;
    // Per-segment traversal scope (interrogate round 14 C2): a read
    // classified in ONE segment's subtree must not switch the opaque gate
    // off for LATER segments — `hcloud List; node -e '…write…'` allowed
    // the write half. segSaw resets per segment and ORs into the caller's
    // accumulator.
    const segSaw = { value: false };
    const plainTokens = splitSimpleCommand(segment);
    // Interpreter-code opacity, UNCONDITIONAL (round 14 C2's leak within
    // the code itself: `python3 -c 'system("read"); subprocess.run("write")'`
    // — the system()-read masked the subprocess write). Code context is
    // definitionally opaque: ANY token in the segment denies, before any
    // extraction (the -c/-e flag, an awk program, or a stdin heredoc —
    // round 14 C4: `python3 <<'EOF'`).
    {
      const { stream: probeStream } = unwrapWithWindowsFlag(plainTokens);
      const interpHead =
        probeStream.length > 0 ? interpreterHeadOf(basenameOf(String(probeStream[0]).toLowerCase())) : null;
      if (interpHead !== null) {
        const rest = probeStream.slice(1).map((token) => String(token));
        const codeForm =
          rest.some((tok) => {
            const f = normalizeFlagToken(tok);
            return interpHead === 'python'
              ? /^-[a-z]*c[a-z]*$/i.test(f)
              : /^-[a-z]*e[a-z]*$/i.test(f) || f === '--eval';
          }) ||
          (interpHead === 'awk' && rest.some((tok) => !tok.startsWith('-'))) ||
          /<<<?/.test(segment);
        if (codeForm) {
          const interpOpaque = opaqueCarrierDenied(segment, plainTokens, segment);
          if (interpOpaque) return interpOpaque;
        }
      }
    }
    const script = scriptTextOf(plainTokens);
    if (script !== null) {
      const nested = gluedWriteDenied(script, options, narrowRouted, depth + 1, segSaw);
      if (nested) return nested;
      // (The round-12 SCRIPT-SHADOW pass was REMOVED in the round-13 pivot:
      // it un-quoted PROSE inside carrier scripts — `bash -c 'echo "step1;
      // hcloud …"'` denied a benign echo — and its purpose (the deep-nest
      // `'\''` idiom) is closed by the deny-opaque gate's fragmented-token
      // signal below, with strictly less false-positive surface.)
    }
    const heredoc = heredocScriptText(segment);
    if (heredoc !== null) {
      const nested = gluedWriteDenied(heredoc, options, narrowRouted, depth + 1, segSaw);
      if (nested) return nested;
    }
    // A DANGLING heredoc marker (interrogate round 12): `bash <<EOF; echo
    // hi` splits the segment at the `;` mid-line, so the marker segment
    // carries no body — bash starts the body at the LINE's newline, which
    // lands in the NEXT segment. The next segment's text after its first
    // newline, up to the delimiter line, is the script.
    const dangling = /<<-?\s*(['"]?)([A-Za-z0-9_]+)\1?[^\n]*$/.exec(segment);
    if (dangling && segIndex + 1 < segments.length) {
      // Round 15 C-A: the probe grammar (prefix/env/redirection aware —
      // a greedy regex ate the shell word as a prefix argument).
      const danglingHeadOk = shellHeadBefore(segment, dangling.index ?? 0);
      if (danglingHeadOk) {
        const delim = dangling[2]!;
        const next = segments[segIndex + 1]!;
        const nl = next.indexOf('\n');
        if (nl >= 0) {
          const body = next.slice(nl + 1);
          const end = body.indexOf(`\n${delim}`);
          if (end >= 0) {
            const nested = gluedWriteDenied(body.slice(0, end), options, narrowRouted, depth + 1, segSaw);
            if (nested) return nested;
          }
        }
      }
    }
    // find -exec/-execdir carriers (interrogate rounds 12-13): the argv
    // between the flag and the `\;`/`;`/`+` terminator is a command
    // position — `find … -exec hcloud ECS Delete {} \;` executes it. The
    // joined payload re-runs the walk — extracted from BOTH tokenizations
    // (the plain one fragments a glued bin), and GATED ON THE HEAD BEING
    // FIND (round 13: `echo -exec hcloud …` is an echo argument, not a
    // carrier — the over-deny class).
    const { stream: headStream } = unwrapWithWindowsFlag(plainTokens);
    const headIsFind = headStream.length > 0 && basenameOf(String(headStream[0]).toLowerCase()) === 'find';
    if (headIsFind) {
      for (const tokenSource of [plainTokens, splitSimpleCommandGlued(segment)]) {
        for (let e = 0; e < tokenSource.length; e++) {
          const tok = String(tokenSource[e]).toLowerCase();
          if (tok === '-exec' || tok === '-execdir') {
            const end = tokenSource.findIndex(
              (t, idx) => idx > e && (String(t) === '\\;' || String(t) === ';' || String(t) === '+'),
            );
            const payload = tokenSource.slice(e + 1, end > 0 ? end : tokenSource.length);
            if (payload.length > 0) {
              const nested = gluedWriteDenied(payload.join(' '), options, narrowRouted, depth + 1, segSaw);
              if (nested) return nested;
            }
          }
        }
      }
    }
    const { stream } = unwrapWithWindowsFlag(plainTokens);
    const plainLeading = stream.length > 0 && isHcloudToken(String(stream[0]));
    if (plainLeading) {
      segSaw.value = true;
      saw.value = true;
    }
    // The walk-back (round 17 C4/C7): the feeder args from the previous
    // segment, walking back through pass-through middles
    // (cat/sort/tee/head/tail/uniq/wc/tr — their args are redirects or
    // limits, the stdin content still flows). Shared by the pipe-consumer
    // checks and the glued xargs arms.
    const pipeWalkBackFeeder = (): string[] => {
      // Round 18 C1/C2/C3: the head comparison uses the design's own
      // recognition grammar — quote-strip + basename + prefix/env probe
      // (`c'at'`, `/usr/bin/cat`, `command cat`, `env cat`), and CONTROL
      // heads flow through too (their args are conditions; the pipe data
      // still reaches the body — the xargs walk-back's control-flow
      // doctrine).
      const passThrough = new Set(['cat', 'sort', 'tee', 'head', 'tail', 'uniq', 'wc', 'tr']);
      const controlHeads = new Set([
        'if',
        'while',
        'until',
        'for',
        'case',
        'then',
        'do',
        'else',
        'elif',
        'fi',
        'done',
        'esac',
        '{',
        '}',
        '(',
        ')',
        '!',
      ]);
      for (let back = segIndex - 1; back >= 0; back--) {
        let backTokens = splitSimpleCommand(segments[back]!).map((t) => String(t));
        // CONTROL heads flow through BEFORE any prefix probe (`if true;`
        // — the pipe data reaches the body; probing would strip the `if`
        // and misread `true` as the content head).
        const rawHead = basenameOf((backTokens[0] ?? '').toLowerCase().replace(/['"\\$]/g, ''));
        if (controlHeads.has(rawHead)) continue;
        // Prefix/env probe (bounded) — `command cat`, `env cat`; the
        // prefix comparison strips quote-mangling (round 19 F1:
        // `comm'and' cat`).
        for (let p = 0; p < 18 && backTokens.length > 0; p++) {
          const t0 = backTokens[0]!;
          if (isRedirectionToken(t0) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(t0)) {
            backTokens = backTokens.slice(1);
            continue;
          }
          const lower = t0.toLowerCase().replace(/['"\\$]/g, '');
          const base = basenameOf(lower);
          if (COMMAND_POSITION_PREFIXES.has(lower) || COMMAND_POSITION_PREFIXES.has(base)) {
            backTokens = skipPrefixArguments(base, backTokens.slice(1));
            continue;
          }
          break;
        }
        const head = basenameOf((backTokens[0] ?? '').toLowerCase().replace(/['"\\$]/g, ''));
        if (passThrough.has(head) || controlHeads.has(head)) continue;
        return backTokens.slice(1);
      }
      return [];
    };
    // Round 16 C3 + round 17 C4/C5/C6: a pipe-fed SHELL or INTERPRETER
    // reads its stdin as a SCRIPT/CODE — `echo 'hcloud …' | bash` executes
    // the piped line. The xargs-feeder doctrine, completed: (a) the
    // WALK-BACK through pass-through middles (`… | cat | bash` — the same
    // walk-back the plain xargs path owns); (b) PER-WORD feeder
    // classification (printf's format arg precedes the data — any
    // write-shaped word denies, the xargs per-word doctrine); (c)
    // INTERPRETER consumers get the code-context deny when the walked-back
    // feeder carries our token. A heredoc-to-pipe composition lands the
    // body inline in the consumer's own segment (post-newline text too).
    {
      const consumerHead = stream.length > 0 ? basenameOf(String(stream[0]).toLowerCase()).replace(/['"\\$]/g, '') : '';
      const isPipeShell =
        !plainLeading &&
        prevTokens.length > 0 &&
        /^(bash|sh|zsh|dash)(\.exe)?$/.test(consumerHead) &&
        script === null &&
        heredoc === null &&
        !stream.slice(1).some((t) => /^-[a-z]*c$/i.test(normalizeFlagToken(t)));
      const consumerInterp = interpreterHeadOf(consumerHead);
      const isPipeInterpreter =
        !plainLeading && prevTokens.length > 0 && consumerInterp !== null && script === null && heredoc === null;
      if (isPipeShell || isPipeInterpreter) {
        const feederTokens = pipeWalkBackFeeder();
        if (isPipeInterpreter) {
          // The interpreter consumer: the feeder args are CODE — the
          // code-context doctrine denies when our token rides them (the
          // deny is direct: the opaque gate is segment-scoped and the
          // token lives in the FEEDER, not the consumer segment).
          const feederText = feederTokens.join(' ');
          const pipeBins = [
            'hcloud',
            'hcloud.exe',
            'huaweicloud-devkit',
            'setup-cli.js',
            'setup-cli.mjs',
            'setup-cli.ts',
            'setup-cli.cjs',
            'setup.cjs',
          ];
          if (pipeBins.some((bin) => feederText.toLowerCase().includes(bin))) {
            return {
              decision: 'deny',
              risk: 'invalid',
              reason:
                'an opaque command carrier (script/interpreter/exec context) mentions Huawei Cloud commands but cannot be safely classified. Write the command in plain form, or use the sanctioned MCP paths (huaweicloud_run_readonly_command for reads / huaweicloud_run_approved_command for writes).',
            };
          }
        } else {
          // The shell consumer: per-word fail-closed (printf's format arg
          // precedes the data), plus the whole-args walk and the inline
          // body.
          const feederWords = feederTokens
            .flatMap((t) => t.split(/\s+/))
            .filter(Boolean)
            .map((w) => w.replace(/^['"]|['"]$/g, ''));
          for (const word of feederWords) {
            const verdict = classifyHcloudArgs(['hcloud', word], {
              ...options,
              rawCommand: text,
              _narrowRouted: narrowRouted,
              _segmentDepth: 1,
            });
            if (verdict.decision === 'deny') return verdict;
          }
          const nested = gluedWriteDenied(feederTokens.join(' '), options, narrowRouted, depth + 1, segSaw);
          if (nested) return nested;
          const inlineNl = segment.indexOf('\n');
          if (inlineNl >= 0) {
            const inlineNested = gluedWriteDenied(
              segment.slice(inlineNl + 1),
              options,
              narrowRouted,
              depth + 1,
              segSaw,
            );
            if (inlineNested) return inlineNested;
          }
        }
      }
    }
    const gluedTokens = splitSimpleCommandGlued(segment);
    const { stream: gluedStream } = unwrapWithWindowsFlag(gluedTokens);
    const gluedLeading = gluedStream.length > 0 && isHcloudToken(String(gluedStream[0]));
    if (gluedLeading) {
      segSaw.value = true;
      saw.value = true;
    }
    // Round 15 C-X: an expansion-built OPERATION/SERVICE/SUBCOMMAND slot
    // (`hcloud ECS ${X:-DeleteServers}`) — the bin IS seen, so the gate is
    // suppressed, but the classification itself is unprovable (the write
    // vocabulary cannot match `:-Delete`). The slot rule: the first two
    // non-flag argv entries carrying `${` deny opaque. Flag-position
    // expansions (`--cli-region=${REGION}`) stay allowed — the slot is the
    // rule, not the flag.
    const expansionInSlot = (streamTokens: string[]): boolean => {
      const argv = streamTokens.slice(1).filter((t) => !String(t).startsWith('-'));
      return argv.slice(0, 2).some((t) => /\$\{/.test(String(t)));
    };
    if ((plainLeading && expansionInSlot(stream)) || (gluedLeading && expansionInSlot(gluedStream))) {
      const opaque = opaqueCarrierDenied(segment, plainTokens, segment);
      if (opaque) return opaque;
    }
    if (gluedStream.length > 0 && isHcloudToken(String(gluedStream[0]))) {
      const gluedArgv = gluedStream.slice(1);
      // Round 17 C2: the xargs head comparison strips quote-mangling
      // (`x'args'`) — the glued re-join reconstructs it but this key read
      // the plain stream.
      const segmentHasXargs = [...plainTokens, ...gluedTokens].some((token) => {
        const t = String(token)
          .toLowerCase()
          .replace(/['"\\$]/g, '');
        return t === 'xargs' || basenameOf(t) === 'xargs';
      });
      if (gluedArgv.length === 0 && plainLeading) {
        // The xargs-owned shape ([prefix… hcloud], no argv): the standard
        // machinery classified it with feeder context — an empty-args
        // re-classification would deny the pinned read-feeders.
      } else if (gluedArgv.length === 0 && !plainLeading && prevTokens.length > 0 && segmentHasXargs) {
        // A glued bin the standard machinery never saw, fed by the pipe:
        // the WALKED-BACK segment's words are the argv (round 17 C7: the
        // immediately-previous segment may be a bare pass-through —
        // `… | cat | xargs "hcl"oud …` — whose args are empty; the
        // walk-back finds the real feeder).
        const feeder = pipeWalkBackFeeder()
          .flatMap((token) => String(token).split(/\s+/))
          .filter(Boolean)
          .map((word) => word.replace(/^['"]|['"]$/g, ''));
        for (const word of feeder) {
          const verdict = classifyHcloudArgs([...gluedTokens, word], {
            ...options,
            rawCommand: text,
            _narrowRouted: narrowRouted,
            _segmentDepth: 1,
          });
          if (verdict.decision === 'deny') return verdict;
        }
      } else if (!plainLeading && segmentHasXargs && prevTokens.length > 0) {
        // A glued xargs bin with its OWN argv (interrogate round 12:
        // `echo DeleteServers | xargs "hcl"oud ECS` — xargs appends the
        // stdin AFTER the own args): merge the WALKED-BACK feeder (round
        // 17 C7) into the glued argv.
        const feeder = pipeWalkBackFeeder()
          .flatMap((token) => String(token).split(/\s+/))
          .filter(Boolean)
          .map((word) => word.replace(/^['"]|['"]$/g, ''));
        const verdict = classifyHcloudArgs([...gluedTokens, ...feeder], {
          ...options,
          rawCommand: text,
          _narrowRouted: narrowRouted,
          _segmentDepth: 1,
        });
        if (verdict.decision === 'deny') return verdict;
      } else {
        const verdict = classifyHcloudArgs(gluedTokens, {
          ...options,
          rawCommand: text,
          _narrowRouted: narrowRouted,
          _segmentDepth: 1,
        });
        if (verdict.decision === 'deny') return verdict;
      }
    }
    // The DENY-OPAQUE gate (interrogate round 13, the pivot): this segment
    // was NOT a plain-leading hcloud command AND its glued re-join was not
    // hcloud-leading either (either the standard machinery classified one
    // of those forms, or the segment carries something we could not
    // traverse). If our token hides in it fragmented/marked/code-context
    // form, deny fail-closed.
    // The gate's traversal signal is `saw` (interrogate round 13): whether
    // ANY level of the walk — this segment's plain/glued streams or any
    // nested carrier's — ever classified our bin at a command position. A
    // traversed-but-unseen payload (the deep-nest idiom: extraction
    // succeeds but the mangled script never yields a leading bin) still
    // gates; a classified read does not.
    if (!segSaw.value) {
      const opaque = opaqueCarrierDenied(segment, plainTokens, text);
      if (opaque) return opaque;
    }
    saw.value = saw.value || segSaw.value;
    prevTokens = plainTokens;
  }
  return null;
}

export function classifyTextCommand(command: unknown, options: ClassifyOptions = {}): RiskDecision {
  const policy = options.policy || DEFAULT_POLICY;
  const text = asText(command || '');
  // Whitespace-only commands deny FIRST (interrogate round 9): the risk-rule
  // engine's empty-command gate sat AFTER the dump-family regexes, and a
  // newline flood (32k+ newlines) sent ARGLESS_DUMP_RE/BARE_SET_RE into
  // superlinear backtracking (7s at 32k, 25s+ at 128k — past the 5s hook
  // timeout, which reads as allow) before the deny could land. trim() is a
  // single linear pass; the placement mirrors the py twin's gate-first
  // posture.
  if (text.trim().length === 0) {
    return {
      decision: 'deny',
      risk: 'invalid',
      reason:
        'command must be a non-empty string. Remediation: Provide a valid, non-empty input before re-running the check.',
    };
  }
  const shadowText = stripShellQuotes(text);
  // The cap counts BYTES on both twins (interrogate round 5): UTF-16 units
  // (TS) vs code points (py) disagreed at the boundary on astral-plane
  // padding — the same payload denied on one layer and allowed on the
  // other. Bytes are also the honest reading of "256 KiB payload".
  const textBytes = Buffer.byteLength(text, 'utf8');
  // Continuation-dropped text (interrogate round 6): bash removes the
  // \<newline> pair before tokenization OUTSIDE single-quoted and `$'…'`
  // spans (inside those the pair is literal — the drop here is deliberately
  // blunter and only ever over-denies), reassembling `$'`/`$(`/backtick
  // across the break — the raw text of `h$\<LF>'\x63'loud …` carries only
  // `$\`, so every raw-text expansion check and the decode must run on the
  // reassembled form or a composed mangled write sails through. Dropping
  // pairs can only ever CREATE markers (a real `$'` survives the drop
  // untouched), so the dropped form subsumes the raw one — with the recorded
  // round-7 caveat that a created marker can be PHANTOM (`$$\<LF>'` glues to
  // a `$'` bash never builds, and a single-quote interior's closing quote
  // can compose one): fail-closed false denies, never a miss.
  const contDropped = text.replace(/\\\n/g, '');

  // Length cap: a routed payload past 256 KiB cannot execute through any
  // wrapper chain (MAX_ARG_STRLEN), and classifying pathological nests
  // at that size costs minutes — a hook DoS. Denied fail-closed instead.
  // An EXPANSION-BEARING over-cap payload denies too (interrogate rounds
  // 5-6): the marker check runs on the continuation-dropped text (a single
  // linear scan) — no legitimate oversized expansion-bearing Bash payload
  // exists, and the round-4 decode skip must not make the over-cap slice
  // the one place a mangled write sails through.
  if (textBytes > 262_144) {
    if (
      /(^|[^a-z0-9.-])hcloud(\.exe)?[\s)\]}'"<]/i.test(shadowText) ||
      /(^|[^a-z0-9.-])hcloud(\.exe)?[\s)\]}'"<]/i.test(text) ||
      /\$['"]|\$\(|\$\{|`/.test(contDropped)
    ) {
      return {
        decision: 'deny',
        risk: 'invalid',
        reason: 'Command payload too large to classify safely; denied fail-closed.',
      };
    }
  }
  // The ANSI-C-decoded shadow (interrogate round 3): the argv letters `$'…'`
  // spans build, reconstructed — `h$'\x63'loud` is the `hcloud` the shell
  // executes. Presence gates below that bear on cloud-command or
  // secret-reveal detection search BOTH shadows; with no `$'` span the
  // decoded candidate is the original text. Decoded from the
  // CONTINUATION-DROPPED text (round 6: the pair removal is part of bash's
  // own first pass, and the decode's outside-quote backslash branch would
  // otherwise consume the `\` of a composed `$\<LF>'` without opening the
  // span). Computed AFTER the length cap and skipped for over-cap payloads
  // (round 4: an unrouted 10 MB escape flood must not pay the decode's
  // linear pass — and the expansion-bearing cap deny above closes the
  // skip's mangled-write window at the same size).
  const decodedShadowText = textBytes > 262_144 ? shadowText : stripShellQuotes(decodeAnsiCSpans(contDropped));
  const shadowCandidates = [shadowText, decodedShadowText];

  // Raw, shadow, and path-normalized forms (shared with the MCP file gate):
  // a quote pair inside the path (`~/.config/huawei'cloud/secrets'/.master-
  // key`) or a redundant `//`/`/./` segment defeats the contiguous-substring
  // patterns while the shell reads the canonical path — the vault tree and
  // keyfile are the most sensitive at-rest data this gate protects.
  if (credentialFileCandidates(text).some((candidate) => matchesAny(candidate, policy.credentialFilePatterns))) {
    return {
      decision: 'deny',
      risk: 'credential',
      reason:
        'Reading Huawei Cloud credential or profile files is blocked. Use redacted profile inspection tools instead.',
    };
  }

  // The vault CLI's own reveal surface: `secret get` prints a stored secret
  // to stdout, which is the agent context when run through the Bash tool.
  // `secret exec` (values reach only the child env) stays allowed. Matched
  // against the quote-stripped shadow (both candidates — the decoded one
  // catches ANSI-C-mangled subcommand spellings) so quoted forms
  // (`secret 'get'`) do not slip past.
  if (shadowCandidates.some((candidate) => matchesAny(candidate, policy.blockedSecretCliPatterns))) {
    return {
      decision: 'deny',
      risk: 'secret',
      reason:
        'Printing vault secrets into the agent context is blocked. Run the value consumer instead: npx huaweicloud-devkit secret exec --env NAME=secret://<scope>/<name> -- <command> — a child you trust not to print its own environment, since its stdout is this conversation. Or use secret get --file from your own terminal.',
    };
  }

  // Order-independent reveal pair: `echo secret get <ref> --stdout | xargs
  // npx huaweicloud-devkit` reorders the argv through xargs while every word
  // is literal in the text — the patterns above assume bin-before-
  // subcommand order. Any payload carrying BOTH a devkit bin and a
  // `secret get` pair is a reveal regardless of order (both shadow
  // candidates — the decoded one catches ANSI-C-mangled spellings).
  if (
    shadowCandidates.some((candidate) =>
      /(^|[^a-z0-9.-])(?:huaweicloud-devkit|setup-cli\.(?:js|mjs|ts|cjs)|setup\.cjs)/i.test(candidate),
    ) &&
    shadowCandidates.some((candidate) => /(?:^|\s)secret\s+get\b/i.test(candidate))
  ) {
    return {
      decision: 'deny',
      risk: 'secret',
      reason:
        'Printing vault secrets into the agent context is blocked. Run the value consumer instead (npx huaweicloud-devkit secret exec --env NAME=secret://<scope>/<name> -- <command>), or use secret get --file from your own terminal.',
    };
  }

  // Obfuscated cloud-command invocation: ANSI-C escapes (`$'\x67et'`,
  // `$'\x68'uaweicloud-devkit` build argv the quote-stripping shadow cannot
  // reconstruct — the letters come from the escape, not the text) and
  // command substitution (`$(echo secret)`, a backtick form) hide tokens
  // from every presence pattern. Canonical devkit and hcloud commands never
  // contain `$'`, `$"`, `$(`, or a backtick, so a cloud-command-bearing
  // payload carrying one is denied as obfuscated rather than parsed.
  // The cloud-command-bearing clause below misses ANSI-C KEYWORD mangling
  // ($'\x68'cloud — the h exists only inside the escape, so no layer sees
  // 'hcloud'; stripShellQuotes keeps the hex digits, giving shadow 'x68cloud').
  // The write-vocabulary clause closes it fail-closed WITHOUT decoding
  // escapes: the shadow of `$'\x68'cloud ECS DeleteServers` still carries
  // 'deleteservers', so an expansion-bearing line with a write-op vocabulary
  // hit denies even when the cloud-CLI marker itself was destroyed (#927
  // audit: v2 and main both allowed this class before — the sibling
  // operation-token form `$'\x43'reateServers` was already denied).
  //
  // Interrogate round 3 adds the DECODED candidate (decodeAnsiCSpans): the
  // gate now also sees the argv letters the escapes actually build —
  // mangling past the marker (h$'\x63'loud $'\x4f'BS rm: no 'cloud', no
  // 'OBS' in the stripped shadow) can no longer hide the bin, the service
  // token, or the operation word, and mangled READS deny too (deny rather
  // than parse — the same verdict an op-mangled read with a literal bin
  // already gets; the #727 doctrine). The vocabulary itself: the policy
  // writeOperationPrefixes (this clause's pre-existing DEFAULT_POLICY read,
  // not options.policy), plus the OBS subcommand words in a MARKER-GATED
  // arm — the OBS TOKEN is the marker (word-bounded, also matches `obs://`);
  // a bare `cloud` substring was the round-2 marker and denied routine
  // huaweicloud-bearing PATHS, so it is gone — the decoded bin clause
  // carries the mangled-bin class instead. The py twin gates the same way.
  // An EMPTY prefix list cannot occur from the shipped policy (structure
  // guard floors it at >= 10) and loadPolicy now throws on a present-but-
  // empty list; the length arm mirrors the py WRITE_VOCAB_RE is-None arm
  // for any caller hand-feeding such a policy anyway. Residual, recorded:
  // the TS write gate itself (hasWritePrefix over []) stays fail-open on
  // that same abnormal shape when passed via options.policy — pre-existing
  // on main and v2, out of this fix's surface; command substitution
  // (`$(printf '\x68…')`) stays opaque to the decode — the OBS-token arm
  // still catches the service-token-literal form.
  const cloudCommandBearing = shadowCandidates.some(
    (candidate) =>
      /(^|[^a-z0-9.-])(?:huaweicloud-devkit|setup-cli\.(?:js|mjs|ts|cjs)|setup\.cjs)|(^|[^a-z0-9.-])hcloud(\.exe)?\s/i.test(
        candidate,
      ) || /secret:\/\//i.test(candidate),
  );
  const writeVocabHit =
    DEFAULT_POLICY.writeOperationPrefixes.length === 0 ||
    shadowCandidates.some((candidate) =>
      DEFAULT_POLICY.writeOperationPrefixes.some((word) => new RegExp(`(^|[^a-z])${word}`, 'i').test(candidate)),
    ) ||
    (shadowCandidates.some((candidate) => /\bOBS\b/i.test(candidate)) &&
      shadowCandidates.some((candidate) =>
        [...OBSUTIL_WRITES].some((word) => new RegExp(`(^|[^a-z])${word}`, 'i').test(candidate)),
      ));
  // The right conjunct runs on the CONTINUATION-DROPPED text (round 6): a
  // composed `$\<LF>'` carries the marker only after the pair drop, and the
  // drop never destroys a real one.
  if ((cloudCommandBearing || writeVocabHit) && /\$['"]|\$\(|`/.test(contDropped)) {
    return {
      decision: 'deny',
      risk: 'secret',
      reason:
        'An obfuscated cloud CLI invocation (shell expansion inside the command) is blocked. Write the command in plain form; secret refs and subcommands must be literal.',
    };
  }

  // The env-dump family: trailing boundary so `environment.md` /
  // `env_setup.py` do not match; the HW_ token is SUFFIX-scoped to the
  // documented credential names so `env HW_REGION=x hcloud …` (a region
  // assignment, not a credential) stays legitimate; HCLOUD_ underscored so
  // the KooCLI bin name does not false-match; HUAWEICLOUD excludes the
  // `-devkit` suffix so the devkit bin name does not feed the family token;
  // `export -p` and `declare`/`typeset` are dump forms of the same class.
  const CRED_ENV_NAMES =
    '(?:HUAWEICLOUD(?!-devkit)|HWC_|HCLOUD_|OS_|HW_(?:ACCESS_KEY|SECRET_KEY|SECRET_ACCESS_KEY|SECURITY_TOKEN|API_KEY|VAULT_MASTER_KEY))';
  if (
    /(^|\s)(env|printenv|export\s+-p|declare|typeset|set|Get-ChildItem\s+Env:|gci\s+Env:|dir\s+Env:)(?![A-Za-z0-9_-])/i.test(
      shadowText,
    ) &&
    new RegExp(CRED_ENV_NAMES, 'i').test(shadowText)
  ) {
    return {
      decision: 'deny',
      risk: 'credential',
      reason: 'Dumping cloud credential environment variables is blocked.',
    };
  }

  // Argument-less full-dump forms — at COMMAND POSITION (start of the
  // payload or after a separator), so `make env` / `rg env` stay legitimate:
  // env/printenv/export/declare/typeset take flags; bare `set` dumps, but
  // `set -e`/`set -o pipefail` set shell options and dump nothing, so only
  // the flagless form denies. A following pipe or redirect means the dump
  // leaves the process either way. The flags alternation is deliberately
  // unambiguous: the long-flag branch carries (?!u\s) so a bare `-u` can
  // ONLY parse through the `-u <value>` branch — the two-branch overlap on
  // `-u ...` chains was exponential backtracking on failing tails
  // (CodeQL js/inefficient-regular-expression; measured: 26 repetitions of
  // ' -u -- ' took 14.3s, 28 took >120s pre-fix, 5000 take 1ms post-fix).
  // The python twin (hooks/huaweicloud-safety.py ARGLESS_DUMP_RE) must stay
  // structurally identical — hook-parity.test.ts pins the shared verdicts.
  if (
    /(?:^|[;&|\n\r)]|\|\||&&)\s*(?:env|printenv|export|declare|typeset)(?![A-Za-z0-9_-])(?:\s+(?:-u\s+\S+|--?(?!u\s)[A-Za-z0-9-]+(?:=[^ ]*)?))*(\s*[|>].*)?\s*$/i.test(
      shadowText,
    ) ||
    /(?:^|[;&|\n\r)]|\|\||&&)\s*set\s*$/i.test(shadowText) ||
    /(?:^|[;&|\n\r)]|\|\||&&)\s*(?:env|printenv|set)(?![A-Za-z0-9_-])\s*(?:\||>)/i.test(shadowText)
  ) {
    return {
      decision: 'deny',
      risk: 'credential',
      reason: 'Dumping the full process environment is blocked (it includes cloud credential variables).',
    };
  }

  // Credential variable references bypass the env-command gate above: HW_ is
  // the plugin's own documented credential prefix (HW_ACCESS_KEY/HW_SECRET_KEY/
  // HW_SECURITY_TOKEN), cloud environments also expose the AWS-style
  // HUAWEICLOUD_SECRET_ACCESS_KEY spelling (#770), and `echo $HW_SECRET_KEY` /
  // `printenv HW_ACCESS_KEY`
  // previously fell through to allow (#650 D4-2).
  //
  // The negative lookbehind exempts literal-NAME references — backslash-escaped
  // (`\$HW_*`) or single-quoted (`'$HW_*'`, which the shell never expands) —
  // while unescaped `$HW_*` is a potential expansion/dump regardless of the
  // command. No command-name whitelist, so no false negative (#650 review).
  // The $-expansion alternative stays on RAW text with its lookbehind: a
  // single-quoted '$HW_*' is a literal the shell never expands, so the
  // exemption is deliberate. The printenv alternative is a command-name
  // gate, so it runs on the shadow — quoting a command name does not stop
  // execution — and matches the credential name at ANY argument position.
  // Single-quoted spans are removed before the expansion test: the shell
  // never expands inside them, but a CLOSING quote before an unquoted $HW_
  // (`echo 'a'$HW_SECRET_KEY`) still expands — a char-level lookbehind
  // wrongly exempted that.
  const unSingleQuoted = text.replace(/'[^']*'/g, '');
  if (
    /(?<!['\\])\$\{?(?:HUAWEICLOUD|HWC|HW|OS)_(?:ACCESS_KEY|SECRET_KEY|SECRET_ACCESS_KEY|SECURITY_TOKEN|API_KEY|VAULT_MASTER_KEY)/i.test(
      unSingleQuoted,
    ) ||
    /(?:^|\s)printenv\s+.*(?:HUAWEICLOUD|HWC|HW|OS)_(?:ACCESS_KEY|SECRET_KEY|SECRET_ACCESS_KEY|SECURITY_TOKEN|API_KEY|VAULT_MASTER_KEY)/i.test(
      shadowText,
    )
  ) {
    return {
      decision: 'deny',
      risk: 'credential',
      reason: 'Printing cloud credential environment variables is blocked.',
    };
  }

  // Secret-retrieval vocabulary on the raw text AND the quote-stripped
  // shadow — the py hook searches both (a quote-mangled `show'secret'`
  // token is still a secret read), so the layers must agree. This check
  // runs BEFORE the hcloud routing return so a compound payload with
  // mangled vocabulary in a non-hcloud trailing segment (py's whole-payload
  // shadow) cannot slip past the TS face.
  if (SECRET_TEXT_RE.test(text) || SECRET_SHADOW_RE.test(shadowText)) {
    return {
      decision: 'deny',
      risk: 'secret',
      reason: 'Direct secret value retrieval patterns are blocked.',
    };
  }

  // Routing on the shadow with a boundary class that admits `/`, `(`, and
  // backtick before the bin: path-qualified (`/usr/bin/hcloud`) and
  // substituted (`$(hcloud …)`) invocations must reach classification, not
  // just whitespace-preceded bare names. The bin's TAIL accepts closers
  // (`&('hcloud')`, `(hcloud)`) as well as whitespace. The RAW text is
  // tested too: the shadow strips quotes and backslashes, which GLUES the
  // bin into the preceding word (`cmd /c"hcloud …`, `C:\hcloud.exe …`)
  // and defeats the boundary class there, while the raw text still
  // carries the boundary character itself. A BROAD tail (also `;`, `&`,
  // `|`, `>`, and end-of-string) routes `… | xargs hcloud;` /
  // `xargs hcloud>` — py's per-segment gate denies those; the empty-args
  // fail-closed stays gated on the NARROW tail so the pinned bare
  // `hcloud` / `sudo hcloud` allows survive.
  const narrowRouted =
    /(^|[^a-z0-9.-])hcloud(\.exe)?[\s)\]}'"<]/i.test(shadowText) ||
    /(^|[^a-z0-9.-])hcloud(\.exe)?[\s)\]}'"<]/i.test(text);
  // The broad tail includes `<` (interrogate round 9): a glued input
  // redirect (`hcloud<f args…`) routes — bash runs the bin with the full
  // argv, the operand is stdin.
  const broadRouted =
    /(^|[^a-z0-9.-])hcloud(\.exe)?([\s)\]}'";&|<>]|$)/i.test(shadowText) ||
    /(^|[^a-z0-9.-])hcloud(\.exe)?([\s)\]}'";&|<>]|$)/i.test(text);
  if (broadRouted) {
    const standard = classifyHcloudArgs(splitSimpleCommand(text), {
      ...options,
      rawCommand: text,
      _narrowRouted: narrowRouted,
    });
    if (standard.decision === 'deny') return standard;
    // Glued-bin fallback (interrogate rounds 9-11): bash glues adjacent
    // quoted spans and word characters into ONE word — `"hcl"oud ECS
    // Delete` runs hcloud with full argv — while splitSimpleCommand keeps
    // the span/fragment distinction, so a quote-INITIAL mangled bin never
    // yields an hcloud-leading argv. The recursive walk (gluedWriteDenied,
    // above) mirrors py's doctrine end to end: script carriers (shell -c /
    // eval / windows payloads / heredoc bodies) re-run the full walk, the
    // glued re-join of every segment classifies (fragments AND
    // plain-leading segments — the verdict comparison, not a skip), and
    // glued xargs bins take the pipe feeder. A quoted argument mention
    // (`docker stop 'hcloud'`, `pip install "hcloud"`) keeps its
    // orphan-allow: the unwrapped head is not the bin.
    const glued = gluedWriteDenied(text, options, narrowRouted, 0);
    if (glued?.decision === 'deny') return glued;
    return standard;
  }

  // The walk also runs UNROUTED (interrogate round 14 C1: `${X:-hcloud}
  // ECS Delete` — the routing boundary excludes `-`, so the
  // default-expanded bin never routed and the opaque gate never ran). The
  // walk's own signals are the scope: no token → every pass returns null;
  // prose pins (contiguous token, no marker, no code context) pass the
  // gate untouched. Over-cap payloads skip it (round 15 W2: the unrouted
  // walk measured 5.3s at 9MB — past the 5s hook timeout, the verdict
  // swallows; py skips the walk for over-cap unrouted already).
  if (textBytes <= 262_144) {
    const glued = gluedWriteDenied(text, options, narrowRouted, 0);
    if (glued?.decision === 'deny') return glued;
  }

  return applyRawCommandRiskRules(
    {
      decision: 'allow',
      risk: 'not_huaweicloud',
      reason: 'No Huawei Cloud safety rule matched.',
    },
    text,
    options,
  );
}
