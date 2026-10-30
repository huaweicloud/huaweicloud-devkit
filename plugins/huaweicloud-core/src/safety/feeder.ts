import { basenameOf } from './tokens.ts';
import { splitSimpleCommand } from './shell-text.ts';

// The xargs feeder model: whether a segment draws its argv from stdin,
// and every visible source those words come from. The scanner in
// segments.ts orchestrates; this module owns the pipe walk-back, the
// word expansion, and the inline feeder merges.

// xargs is detected on the PRE-unwrap segment tokens AND the unwrapped
// stream: inside a quoted windows payload the whole command is one
// token, and only the unwrapped head exposes the `xargs` bin (`echo
// Delete | cmd /c "xargs hcloud ECS"` — the child inherits the pipe and
// executes the merged write). A span token whose FIRST word is xargs
// counts too.
export function segmentBearsXargs(tokens: string[], unwrappedRaw: string[]): boolean {
  // Round 19: the xargs comparison strips quote-mangling (`x'args'`) —
  // py's twin got the same normalization at its detector.
  const isXargsToken = (token: unknown): boolean => {
    const t = String(token)
      .toLowerCase()
      .replace(/['"\\$]/g, '');
    if (
      t === 'xargs' ||
      basenameOf(
        String(token)
          .toLowerCase()
          .replace(/['"\\$]/g, ''),
      ) === 'xargs'
    )
      return true;
    if (/\s/.test(String(token))) {
      const firstWord = splitSimpleCommand(String(token))[0];
      return (
        String(firstWord ?? '')
          .toLowerCase()
          .replace(/['"\\$]/g, '') === 'xargs'
      );
    }
    return false;
  };
  return tokens.some((t) => isXargsToken(t)) || unwrappedRaw.some((t) => isXargsToken(t));
}

// xargs splits stdin on IFS: a QUOTED feeder token carries multiple words
// (`echo "ECS DeleteServers" | xargs hcloud` runs `hcloud ECS
// DeleteServers`) — expand every feeder token into its
// whitespace-separated words.
export function expandWords(tokens: string[]): string[] {
  return tokens.flatMap((t) =>
    String(t)
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => w.replace(/^['"]|['"]$/g, '')),
  );
}

// The feeder is the UNION of every visible source: the pipeline WALK-BACK
// (through control headers, group braces, and argless pass-through
// filters — the pipe's data reaches the xargs body through them: `echo
// Delete | if true; then xargs hcloud ECS; fi`; a `;`-separated consuming
// command stops the walk), the inherited outer pipe (the script's stdin),
// herestring words, and redirection-substitution words. Union is
// fail-closed: any write-shaped word reaching the argv denies.
export function collectFeederWords(
  scannerSegments: string[],
  segmentSeps: string[],
  s: number,
  tokens: string[],
  herestringAt: number,
  trailingRedirect: boolean,
  inheritedFeeder: string[] | null,
): string[] {
  const controlHeadWords = new Set([
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
  const passThroughBins = new Set(['cat', 'sort', 'tee', 'head', 'tail', 'uniq', 'wc', 'tr']);
  const walkBackFeeder = (): string[] => {
    const words: string[] = [];
    let k = s - 1;
    while (k >= 0) {
      const segToks = splitSimpleCommand(scannerSegments[k]!);
      const headTok = String(segToks[0] ?? '').toLowerCase();
      const args = segToks.slice(1).map(String);
      const isCtrl =
        controlHeadWords.has(headTok.replace(/['"\\$]/g, '')) ||
        (passThroughBins.has(headTok.replace(/['"\\$]/g, '')) && args.length === 0);
      const sepAfter = segmentSeps[k] ?? '';
      const sepBefore = k > 0 ? (segmentSeps[k - 1] ?? '') : '';
      // `)` (substitution/subshell body) and `>(` (process substitution)
      // flow like `|` — the substituted data reaches the pipe (`cat
      // <(echo Delete) | xargs hcloud ECS`).
      const flows = sepAfter === '|' || sepAfter === ')' || sepAfter === '>(';
      if (!isCtrl && !flows) {
        // A consuming command not pipe-connected to the xargs segment
        // (`echo Delete | true; xargs …`): no stdin flow.
        if (k === s - 1) return words;
        break;
      }
      words.push(...args);
      if (!isCtrl && sepBefore !== '|' && sepBefore !== ')' && sepBefore !== '>(') break;
      k -= 1;
    }
    return words;
  };
  let feeder = expandWords([...walkBackFeeder(), ...(inheritedFeeder ?? [])]);
  if (herestringAt >= 0 && /^0*<{3,}$/.test(String(tokens[herestringAt]))) {
    // A BARE `<<<` marker: the following tokens are the payload. A GLUED
    // marker (`<<<"OBS rm"` tokenizes as `<<<"OBS` + `rm"`) is handled by
    // the redirect-marker branch of the argv split — running both would
    // duplicate the payload words.
    feeder = [...feeder, ...expandWords(tokens.slice(herestringAt + 1).map(String))];
  }
  if (trailingRedirect) {
    feeder = [
      ...feeder,
      ...expandWords(
        splitSimpleCommand(scannerSegments[s + 1]!)
          .slice(1)
          .map(String),
      ),
    ];
  }
  return feeder;
}
