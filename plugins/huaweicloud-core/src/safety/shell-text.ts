// The shell TEXT structure model: how a raw payload splits into command
// segments (separators, quotes, heredocs) and how a single command
// tokenizes. Every consumer in the safety family re-uses these so the
// text model has one spelling.

import { scanHeredocStart } from './heredoc.ts';

// A word that began as a Windows drive prefix (`X:` or `X:\…`): every
// backslash inside it is a path separator, never a POSIX escape. The
// opening quote is stripped so the check works inside quoted spans.
function isWindowsPathWord(current: string): boolean {
  const lastWord = current.slice(current.lastIndexOf(' ') + 1).replace(/^['"]/, '');
  return /^[A-Za-z]:$/.test(lastWord) || /^[A-Za-z]:[\\/]/.test(lastWord);
}

// Split a raw shell payload into command segments with a real (minimal)
// structure model instead of a flat regex: separators count only OUTSIDE
// quotes and heredoc bodies, and a trailing backslash joins lines. This is
// what keeps prose honest in both directions — `echo "a; hcloud <write>"`
// does not split inside the quoted string (the write is not a command),
// while a heredoc body or a newline-joined script still classifies per
// command. Substitution boundaries (`$(`, `<(`, backtick, `)`) split too,
// so `cat <(hcloud …)` and `case x in a) hcloud …` reach classification.
export function splitShellSegments(text: string, sepsOut?: string[]): string[] {
  const separators = new Set([';', '&', '|', '\n', '\r', ')']);
  const segments: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  // Set when a heredoc delimiter was seen: from the NEXT newline, consume
  // the body until the delimiter line. The rest of the STARTING line stays
  // live command text (bash semantics: `cat <<EOF; cmd2` runs cmd2).
  let pendingHeredoc: string | null = null;
  let heredocDelim: string | null = null;
  let heredocLine = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (heredocDelim !== null) {
      // Inside a heredoc body: nothing splits until the delimiter line ends.
      current += ch;
      if (ch === '\n') {
        if (heredocLine.trim() === heredocDelim) {
          heredocDelim = null;
          segments.push(current);
          sepsOut?.push('\n');
          current = '';
        }
        heredocLine = '';
      } else {
        heredocLine += ch;
      }
      i++;
      continue;
    }
    if (quote !== null) {
      if (ch === '\\' && i + 1 < text.length) {
        // Backslash escapes the next char — BOTH chars stay in the segment
        // (the downstream escape-aware tokenizer can regroup the span,
        // `bash -c "cmd /c \"hcloud …\""`), EXCEPT the line continuation:
        // bash removes the \<newline> PAIR at parser level inside double
        // quotes too (interrogate round 4: `hcloud ECS "De\<LF>leteServers"`
        // hid the operation from every shadow); the single-quote span keeps
        // the pair (literal there).
        if (quote === '"' && text[i + 1] === '\n') {
          i += 2;
          continue;
        }
        current += ch;
        current += text[i + 1]!;
        i += 2;
        continue;
      }
      current += ch;
      if (ch === quote) quote = null;
      i++;
      continue;
    }
    if (ch === '\\') {
      // Backslash escapes the next char; \<newline> is a line continuation —
      // the joined command must NOT split AND bash removes the PAIR, so the
      // newline is dropped entirely (interrogate round 4: `h\<LF>cloud` hid
      // the bin from every shadow — routing, vocab, and decode all saw a
      // newline inside the token). A Windows drive path (`C:\Windows\…`)
      // keeps its backslashes for the same reason as the quoted branch.
      if (i + 1 < text.length) {
        if (text[i + 1] === '\n') {
          i += 2;
          continue;
        }
        current += (isWindowsPathWord(current) ? ch : '') + text[i + 1]!;
        i += 2;
        continue;
      }
      current += ch;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      i++;
      continue;
    }
    if (ch === '$' && text[i + 1] === '(') {
      segments.push(current);
      sepsOut?.push('$(');
      current = '';
      i += 2;
      continue;
    }
    if (ch === '<' && text[i + 1] === '(') {
      segments.push(current);
      sepsOut?.push('<(');
      current = '';
      i += 2;
      continue;
    }
    if (ch === '>' && text[i + 1] === '(') {
      segments.push(current);
      sepsOut?.push('>(');
      current = '';
      i += 2;
      continue;
    }
    if (ch === '`') {
      segments.push(current);
      sepsOut?.push('`');
      current = '';
      i++;
      continue;
    }
    if (separators.has(ch)) {
      // `&` directly after `>`/`<` is the redirection-dup operator
      // (`2>&1`, `<&0`) — part of the redirection token, not a separator
      // (interrogate round 11: `2>&1 bash -c '…'` split mid-redirection
      // and the script never reached the wrapper walk).
      if (ch === '&' && i > 0 && (text[i - 1] === '>' || text[i - 1] === '<')) {
        current += ch;
        i++;
        continue;
      }
      if (ch === '\n' && pendingHeredoc !== null) {
        // The heredoc body starts here.
        heredocDelim = pendingHeredoc;
        pendingHeredoc = null;
        heredocLine = '';
        current += ch;
        i++;
        continue;
      }
      segments.push(current);
      sepsOut?.push(ch);
      current = '';
      i++;
      continue;
    }
    if (ch === '<' && text[i + 1] === '<') {
      const start = scanHeredocStart(text, i, separators);
      if (start !== null) {
        // Render the marker (operator, dashes, quote, delimiter) and
        // align i to the scan position — the spaced forms
        // double-consumed the last delimiter char.
        current += '<<';
        for (let k2 = i + 2; text[k2] === '-'; k2++) current += '-';
        if (start.delimQuote) {
          quote = start.delimQuote as '"' | "'";
          current += start.delimQuote;
        }
        current += start.delim;
        i = start.next;
        pendingHeredoc = start.delim;
        continue;
      }
    }
    current += ch;
    i++;
  }
  segments.push(current);
  sepsOut?.push('');
  if (!sepsOut) return segments.map((segment) => segment.trim()).filter(Boolean);
  // Keep sepsOut aligned when empty segments are filtered out.
  const trimmed = segments.map((segment) => segment.trim());
  const kept: string[] = [];
  const keptSeps: string[] = [];
  for (let i = 0; i < trimmed.length; i++) {
    if (trimmed[i]) {
      kept.push(trimmed[i]!);
      keptSeps.push(sepsOut[i] ?? '');
    }
  }
  sepsOut.length = 0;
  sepsOut.push(...keptSeps);
  return kept;
}

export function splitSimpleCommand(command: unknown): string[] {
  // Double-quoted spans honor backslash escapes (`\"` nests quotes — the
  // canonical bash way to embed a Windows wrapper, `bash -c "cmd /c
  // \"hcloud …\""`); single-quoted spans do not (POSIX: no escapes inside
  // single quotes). A single-quote span's closer is OPTIONAL — an
  // unterminated `'…` runs to the end of the string as one token
  // (mirroring the py tokenizer) so malformed-but-nested payloads keep
  // their grouping; a double-quote span REQUIRES its closer so a glued
  // Windows flag (`cmd /c"hcloud …` with the closing quote stranded on
  // the last argument) re-tokenizes per-word with the leading quote
  // stripped by the edge replace.
  //
  // Line continuations are removed before matching (interrogate round 4):
  // bash drops the \<newline> pair at parser level, and the \S+ branch
  // would otherwise split `De\<LF>leteServers` into two tokens leaving the
  // operation slot reading `De\`. Single-quoted spans keep the pair in
  // real bash — over-stripping there only ever JOINS tokens (fail-closed
  // toward classification, never hides one).
  return (
    String(command)
      .replace(/\\\n/g, '')
      .match(/"(?:[^"\\]|\\.)*"|'[^']*'?|\S+/g)
      ?.map((part) => part.replace(/^['"]|['"]$/g, '')) || []
  );
}

// Bash-word-faithful tokenizer for the write gate's glued-bin fallback
// (interrogate round 9): adjacent quoted spans and word characters form ONE
// token — `"hcl"oud ECS Delete` is the single word hcloud to bash, with
// ECS/Delete as real argv — unlike splitSimpleCommand, which keeps the
// span/fragment distinction other consumers rely on (the windows-payload
// piece-split's quote-carrying refusal, the feeder expanders).
// Single-quoted spans keep their literal backslashes; double-quoted spans
// resolve \" and \\ pairs; unterminated spans run to the end; \\<newline>
// continuations drop first (bash's own first pass). Mirrored by
// split_tokens_glued in hooks/huaweicloud-safety.py — the tokenizer twin
// corpus pins the shared outputs.
export function splitSimpleCommandGlued(command: unknown): string[] {
  const text = String(command).replace(/\\\n/g, '');
  const tokens: string[] = [];
  let cur = '';
  let i = 0;
  const flush = (): void => {
    if (cur) {
      tokens.push(cur);
      cur = '';
    }
  };
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === "'") {
      const end = text.indexOf("'", i + 1);
      if (end < 0) {
        cur += text.slice(i + 1);
        i = text.length;
        continue;
      }
      cur += text.slice(i + 1, end);
      i = end + 1;
      continue;
    }
    if (ch === '"') {
      i++;
      let closed = false;
      while (i < text.length) {
        const c = text[i]!;
        if (c === '\\' && i + 1 < text.length && (text[i + 1] === '"' || text[i + 1] === '\\')) {
          cur += c + text[i + 1]!;
          i += 2;
          continue;
        }
        if (c === '"') {
          closed = true;
          i++;
          break;
        }
        cur += c;
        i++;
      }
      if (!closed && i >= text.length) break;
      continue;
    }
    if (/\s/.test(ch)) {
      flush();
      i++;
      continue;
    }
    cur += ch;
    i++;
  }
  flush();
  return tokens;
}

// Quote/backslash-stripped shadow of a command text for PRESENCE gates: an
// agent can quote any token (`secret 'get'`, `bash -c "hcloud ..."`, g\et)
// so the raw-text regexes miss it while the shell still executes the
// canonical argv. Tokenizing (splitSimpleCommand) stays authoritative for
// classification; this only widens detection.
export function stripShellQuotes(text: string): string {
  // Also strips `$` and backticks: bash's ANSI-C ($'get') and locale
  // ($"get") quoting, and command substitution, produce the canonical argv
  // while leaving those characters behind. None of the canonical tokens
  // (huaweicloud-devkit, secret, get, hcloud, …) contain them, so the shadow
  // of `sec$'r'et` collapses to `secret`. Variable indirection ($S, ${X:-…})
  // remains a documented residual — a text-presence gate cannot see through
  // expansion.
  //
  // Line continuations drop FIRST (interrogate round 4): bash removes the
  // \<newline> pair at parser level, and the surviving newline broke
  // contiguity everywhere (`h\<LF>cloud` never routed, `De\<LF>leteServers`
  // never matched a prefix). Single-quoted spans keep the pair in real
  // bash — over-stripping there only ever JOINS text (fail-closed toward
  // detection, never hides a marker).
  return text.replace(/\\\n/g, '').replace(/['"\\$`]/g, '');
}

// mirrors the py twin's ANSI_C_DECODE_RE; sticky (lastIndex-anchored) so the
// per-escape probe allocates nothing on megabyte payloads. The x/u/U
// prefixes sit OUTSIDE the capture groups — the captured digits must parse.
const ANSI_C_ESCAPE_RE = /\\(?:x([0-9a-fA-F]{1,2})|([0-7]{1,3})|u([0-9a-fA-F]{1,4})|U([0-9a-fA-F]{1,8}))/y;

// Reconstruct the argv letters ANSI-C quoting builds: inside `$'…'` spans
// (opened only OUTSIDE quotes — a `$` already inside a plain quoted span is
// a literal), decode \xHH, \NNN (octal), \uHHHH, and \UHHHHHHHH escapes to
// their characters; everything else passes through verbatim (interrogate
// round 3: the obfuscation gate's candidates now see `h$'\x63'loud` as the
// `hcloud` the shell actually executes, so mangling past a marker — the
// round-2 cloud-marker gate's bypass — no longer hides the bin, the service
// token, or the operation word). `\'` inside the span does not close it;
// `\\` and unrecognized escapes stay literal (conservative); an unterminated
// span returns the ORIGINAL text (no decode — today's shadow); `$"…"` spans
// are passed through (locale quoting, no escape processing for identifiers);
// command substitution `$(…)` stays opaque (the documented residual — the
// printf-built bin class). Mirrored by decode_ansi_c_spans in
// hooks/huaweicloud-safety.py — hook-parity pins the shared verdicts.
export function decodeAnsiCSpans(text: string): string {
  if (!text.includes("$'")) return text;
  const out: string[] = [];
  let i = 0;
  let quote: '"' | "'" | null = null;
  while (i < text.length) {
    const ch = text[i]!;
    if (quote !== null) {
      out.push(ch);
      if (ch === '\\' && quote === '"' && i + 1 < text.length) {
        out.push(text[i + 1]!);
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      out.push(ch);
      i++;
      continue;
    }
    if (ch === '\\' && i + 1 < text.length) {
      // Outside quotes a backslash escapes the NEXT character (both stay —
      // the shadow's own backslash-strip handles them). Without this, an
      // escaped quote opened PHANTOM quote state and disabled the entire
      // decode for the rest of the payload (interrogate round 4: `\' ;
      // h$'\x63'loud …` let the mangled write through every layer), and \$'
      // mis-parsed as an ANSI-C span opener instead of \$ + plain quotes.
      out.push(ch, text[i + 1]!);
      i += 2;
      continue;
    }
    if (ch === '$' && text[i + 1] === "'") {
      const span: string[] = [];
      let j = i + 2;
      let closed = false;
      while (j < text.length) {
        const c = text[j]!;
        if (c === "'") {
          closed = true;
          j++;
          break;
        }
        if (c === '\\' && j + 1 < text.length) {
          const next = text[j + 1]!;
          if (next === "'") {
            span.push("'");
            j += 2;
            continue;
          }
          ANSI_C_ESCAPE_RE.lastIndex = j;
          const m = ANSI_C_ESCAPE_RE.exec(text);
          if (m) {
            const digits = m[1] ?? m[2] ?? m[3] ?? m[4] ?? '';
            const isOctal = m[2] !== undefined;
            const radix = isOctal ? 8 : 16;
            let value = Number.parseInt(digits, radix);
            if (isOctal) value &= 0xff; // bash masks \NNN to 8 bits (NUL-truncating >0o377)
            if (Number.isFinite(value) && value <= 0x10ffff) {
              span.push(String.fromCodePoint(value));
              j += m[0].length;
              continue;
            }
          }
          span.push(c, next);
          j += 2;
          continue;
        }
        span.push(c);
        j++;
      }
      if (!closed) return text;
      out.push(span.join(''));
      i = j;
      continue;
    }
    out.push(ch);
    i++;
  }
  return out.join('');
}
