import { evalScriptStream, shellScriptStream } from './script-stream.ts';
import { splitSimpleCommand } from './shell-text.ts';
import { unwrapSecretExecWrapper } from './secret-exec.ts';
import { unwrapSkillQualityCli } from './skill-quality-cli.ts';
import {
  basenameOf,
  COMMAND_POSITION_PREFIXES,
  isEnvAssignment,
  isHcloudToken,
  isRedirectionToken,
  SHELL_FIRST_TOKENS,
  skipPrefixArguments,
} from './tokens.ts';
import { windowsScriptArgAt } from './windows.ts';
import { hcloudPieceAt, startTitleRebase } from './windows-rebase.ts';

// Unwrap with the windows-payload context exposed: the segment scanner
// needs to know the stream passed through a cmd/powershell payload (every
// LATER hcloud occurrence in a brace-grammar payload is a live command
// site, and `}` is not a segment separator).
export function unwrapWithWindowsFlag(args: string[]): { stream: string[]; windowsPayload: boolean } {
  let windowsPayload = false;
  const stream = unwrapCore(args, (entered) => {
    if (entered) windowsPayload = true;
  });
  return { stream, windowsPayload };
}

function unwrapShellAndWrappers(args: string[]): string[] {
  return unwrapCore(args, null);
}

function unwrapCore(args: string[], onWindowsPayload: ((entered: boolean) => void) | null): string[] {
  let current = args;
  // Set once a Windows wrapper payload has been entered: from then on, a
  // stall at grammar the POSIX vocabulary cannot strip (cmd `if defined X
  // …`, PS `try { … } catch { … }` — `}` is not a segment separator)
  // re-bases to the first hcloud bin with a following token — the same
  // fail-closed doctrine the skill-quality-cli REMAINDER walk applies to
  // unknown flag grammar.
  let inWindowsPayload = false;
  // Env assignments strip UNBOUNDED before the loop (interrogate round 13:
  // `X1=1 … X19=1 hcloud …` executes — assignments are linear, no nesting,
  // so no budget is charged; the 18 budget stays for the nested carriers a
  // malicious input could otherwise loop). A malicious input cannot loop
  // here because every branch strictly shrinks `current`.
  while (current.length > 0 && isEnvAssignment(String(current[0]).toLowerCase())) {
    current = current.slice(1);
  }
  // Depth-capped (interrogate round 12: flat prefix/env stacks past 10
  // stalled the unwrap — `X1=1 … X11=1 hcloud …` executes; 18 matches the
  // walk's budget).
  for (let depth = 0; depth < 18; depth++) {
    if (!current.length) return current;
    const first = String(current[0]).toLowerCase();
    const isShell = SHELL_FIRST_TOKENS.has(first);
    // `-c`, `-lc`, `-xc` … any option cluster ending in c takes the
    // script; the script stream (re-tokenized, tail joined when the
    // script is itself a wrapper head) replaces the invocation.
    if (isShell && /^-[a-z]*c$/i.test(String(current[1] ?? '')) && current[2]) {
      current = shellScriptStream(current);
      continue;
    }
    // eval evaluates the JOIN of all its arguments — the script string is
    // the whole tail, not just the first word.
    if (first === 'eval' && current[1]) {
      current = evalScriptStream(current);
      continue;
    }
    // bash/PS function definitions: the NAME follows the keyword before
    // the body (`function f { hcloud … }`) — strip keyword + name.
    if ((first === 'function' || first === 'filter') && current.length > 2) {
      current = current.slice(2);
      continue;
    }
    // Windows script wrappers carry the command as ONE argument too:
    // `cmd /c "hcloud …"` / `powershell -Command "hcloud …"`.
    const winScript = windowsScriptArgAt(current, 0);
    if (winScript !== null) {
      current = splitSimpleCommand(winScript);
      inWindowsPayload = true;
      onWindowsPayload?.(true);
      continue;
    }
    if (isRedirectionToken(String(current[0]))) {
      current = current.slice(1);
      continue;
    }
    // Round 19 F4: the prefix comparison strips quote-mangling
    // (`en'v' python3 -c …` — the probe never reached the interpreter).
    if (
      COMMAND_POSITION_PREFIXES.has(first.replace(/['"\\$]/g, '')) ||
      COMMAND_POSITION_PREFIXES.has(
        basenameOf(String(current[0]))
          .toLowerCase()
          .replace(/['"\\$]/g, ''),
      )
    ) {
      // Locator carve-out: `where hcloud`, `if exist hcloud` probe the
      // bin's PRESENCE (cmd builtins) — a bare bin with no argv is the
      // probe shape, not a command; stripping the locator would hit the
      // empty-args fail-closed and deny a read-only lookup.
      if (
        (first === 'where' || first === 'exist' || first === 'defined') &&
        current.length === 2 &&
        isHcloudToken(String(current[1] ?? ''))
      ) {
        break;
      }
      if (basenameOf(String(current[0])).toLowerCase() === 'start') {
        const rebase = startTitleRebase(current);
        if (rebase !== null) {
          current = rebase;
          continue;
        }
      }
      // The (lowercased) basename resolves the prefix key for
      // skipPrefixArguments too: a path-qualified `/usr/bin/sudo -u root
      // hcloud …` (any letter case) must consult sudo's value-flag grammar,
      // not an unknown-prefix empty set.
      current = skipPrefixArguments(basenameOf(String(current[0])).toLowerCase(), current.slice(1));
      continue;
    }
    if (isEnvAssignment(first)) {
      current = current.slice(1);
      continue;
    }
    const secretExecChild = unwrapSecretExecWrapper(current);
    if (secretExecChild) {
      current = secretExecChild;
      continue;
    }
    const sqcChild = unwrapSkillQualityCli(current);
    if (sqcChild) {
      current = sqcChild;
      continue;
    }
    if (inWindowsPayload && !isHcloudToken(String(current[0] ?? ''))) {
      for (let i = 1; i < current.length; i++) {
        const pieceStream = hcloudPieceAt(current, i);
        if (pieceStream !== null && pieceStream.length > 1) {
          current = pieceStream;
          break;
        }
      }
      if (isHcloudToken(String(current[0] ?? ''))) continue;
    }
    break;
  }
  return current;
}

export function stripExecutable(args: string[]): string[] {
  if (!args.length) return [];
  // Unwrap shell wrappers (bash -c / sh -c 'hcloud ...', sudo hcloud ...) so
  // wrapped write commands keep their deny classification (#650 D4-16).
  const current = unwrapShellAndWrappers(args);
  if (isHcloudToken(String(current[0] || ''))) {
    return current.slice(1);
  }
  return current;
}
