// Bin-token predicates and shell vocabulary sets for the safety family:
// how a token spells a binary (hcloud, the devkit bins, wrapper heads),
// which words occupy the command position without being the command, and
// which obsutil subcommands write. Pure leaf — one spelling for every
// consumer (the unwrap engine, the segment scanner, the classifiers).

// Shell and wrapper unwrapping shared by the classification path and the
// hcloud-segment pass: bash -c / sudo / the devkit secret-exec wrapper.
export const SHELL_FIRST_TOKENS = new Set([
  'bash',
  'sh',
  'zsh',
  'dash',
  'bash.exe',
  'sh.exe',
  '/bin/bash',
  '/bin/sh',
  '/bin/zsh',
  '/bin/dash',
]);

// Tokens that occupy the command position without being the command:
// wrappers and control keywords (sudo unwraps below; nohup/env/time/timeout/
// watch/nice/stdbuf/setsid/ionice prefix real invocations; do/then follow
// loop/if bodies while if/while/until/case/{ HEAD them; exec/command/eval
// dispatch the command), plus cmd.exe's launch builtins start/call (the
// unwrapped Windows payload `start /b hcloud …` re-bases onto the child),
// the PowerShell/cmd control vocabulary (see the inline block), and
// VAR=VALUE assignments (`env HW_REGION=x hcloud …`). Stripping them lets
// the hcloud-leading check see the actual command token.
export const COMMAND_POSITION_PREFIXES = new Set([
  'sudo',
  'nohup',
  'env',
  'time',
  'do',
  'then',
  'elif',
  'elseif',
  'else',
  'xargs',
  'if',
  'while',
  'until',
  'exec',
  'command',
  'coproc',
  '!',
  '{',
  '(',
  'timeout',
  'watch',
  // busybox: the applet dispatcher — `busybox sh -c '…'` / `busybox awk
  // '…'` run the applet named as the next token (interrogate round 14 C3:
  // both the walk families and the interpreter table missed it).
  'busybox',
  'nice',
  'stdbuf',
  'setsid',
  'ionice',
  'start',
  'call',
  // PowerShell scriptblock control grammar (try/catch/finally, begin/
  // process/end, switch/default, foreach/%, where, function/filter) and
  // cmd `if`-condition words (defined/exist/not/errorlevel): a wrapper
  // payload headed by these runs its body, so the re-base must see
  // through them. None is a plausible bare POSIX program name.
  'try',
  'catch',
  'finally',
  'begin',
  'process',
  'end',
  'switch',
  'default',
  'foreach',
  'where',
  'function',
  'filter',
  'defined',
  'exist',
  'not',
  'errorlevel',
  '%',
]);

// Value-taking single-letter flags PER PREFIX (`sudo -u root`, `nice -n 5`,
// `xargs -I {}`, `stdbuf -o0` attached). A shared set over-stripped:
// `time -p` and `command -p` take no value, so the command token itself
// was eaten.
export const PREFIX_FLAGS_WITH_VALUE = new Map<string, ReadonlySet<string>>([
  [
    'sudo',
    new Set([
      '-u',
      '-g',
      '-p',
      '-U',
      '-r',
      '-t',
      '-D',
      '-C',
      '--user',
      '--group',
      '--prompt',
      '--other-user',
      '--role',
      '--type',
    ]),
  ],
  ['nice', new Set(['-n', '--adjustment'])],
  ['xargs', new Set(['-I', '-d', '-E', '-S', '--replace', '--delimiter', '--max-args', '--max-chars'])],
  ['stdbuf', new Set(['-o', '-e', '-i'])],
  ['env', new Set(['-u', '--unset'])],
  ['timeout', new Set(['--signal', '-s', '-k', '--kill-after'])],
  // watch's -n/--interval carry the interval; -d/-t/-g/-b/-e are boolean
  // (the COMMAND words follow the flags — never consume them).
  ['watch', new Set(['-n', '--interval'])],
  // cmd.exe's `start` takes slash flags (`/b /wait /min …`); `/d <path>`
  // carries a value.
  ['start', new Set(['/d'])],
]);

// obsutil write subcommands (module scope — shared by the OBS
// classification and the xargs feeder pre-filter).
export const OBSUTIL_WRITES = new Set([
  'mb',
  'cp',
  'mv',
  'rm',
  'delete',
  'mkdir',
  'sync',
  'restore',
  'chattri',
  'bucketpolicy',
  'lifecycle',
  // cors/website materialized as real write-capable subcommands in KooCLI
  // 7.3.12 (the pinned version): live-measured `OBS help cors|website` exits 0
  // with -method=[get,put,delete], and `-method=get` on a nonexistent bucket
  // returns an OBS-side NoSuchBucket 404 — a service-reaching command, not a
  // stub. KooCLI 7.2.x rejects both with "No such command" (exit 3), which is
  // where upstream main's #1001 "nonexistent subcommands" removal was measured;
  // keep them denied so a future three-way merge resolves by this evidence,
  // not by main's stale comment.
  'cors',
  'website',
  'sign',
  'share-add',
  'share-update',
  'share-rm',
  // KooCLI 7.3.12 added these write-capable obsutil subcommands — set/put/
  // delete via -method for bucket-tagging/object-tagging/encryption/
  // mirror-back-to-source; custom-domain writes ride on -cname/certificate
  // options instead. All must hit the write deny like their older siblings.
  'bucket-tagging',
  'object-tagging',
  'encryption',
  'custom-domain',
  'mirror-back-to-source',
  // 7.3.12's public-access-block family: the get*/read variants stay reads,
  // but put/delete are full-name writes (Set/Delete the bucket's
  // Block-Public-Access configuration — deleting it re-opens public access).
  'put-public-access-block',
  'delete-public-access-block',
  // Pre-existing on 7.2.x too but never dispositioned (7.3.12-pin sweep catch):
  // abort discards in-flight multipart uploads; archive writes log files into
  // OBS — both cloud-side writes, same class as cp/rm.
  'abort',
  'archive',
  // create-share is the live share-authorization family (issues a capability
  // token — the same privilege class as sign, which is denied); the
  // share-add/update/rm spellings above are the dead pre-rename names.
  // update is obsutil's SELF-update (mutates the installed binary — denied on
  // the same least-surprise grounds).
  'create-share',
  'update',
]);

// Shared bin-token normalization for the wrapper seams. A trailing
// @version spec (npx pkg@latest) is stripped — but never a path segment
// (/opt/sqc@old/bin keeps its @). Leading `$(` / `$` runs are stripped
// (substitution heads; a bare `$bin` variable is the known fail-closed
// corner — isHcloudToken has the same property). Quote/backslash/dollar
// mangling is normalized because the tokenizer keeps mid-token quoting
// while the shell still executes the canonical bin (`skill'-'quality'-'cli`).
// `<` is deliberately NOT stripped: a `<hcloud` token is a redirection, and
// matching one as "the hcloud child" manufactures a child the classifier
// then has to rescue — the segment splitter consumes live `<(` before
// tokenization, so nothing real reaches the predicate with a leading `<`.
export function normalizeBinToken(token: string): string {
  return String(token)
    .toLowerCase()
    .replace(/@[^/\\]*$/, '')
    .replace(/^[$(]+/, '')
    .replace(/['"`$\\]/g, '');
}

// Bin-name matching tries BOTH the raw token (Windows `\`-qualified paths
// keep their separators — normalizing first would strip them and dead-code
// every `\\name` branch) and the normalized form (POSIX quote/escape
// mangling — `skill\-quality\-cli`).
export function matchesBinName(token: string, names: readonly string[]): boolean {
  const raw = String(token)
    .toLowerCase()
    .replace(/@[^/\\]*$/, '');
  const norm = normalizeBinToken(token);
  return names.some(
    (n) =>
      raw === n ||
      raw.endsWith(`/${n}`) ||
      raw.endsWith(`\\${n}`) ||
      norm === n ||
      norm.endsWith(`/${n}`) ||
      norm.endsWith(`\\${n}`),
  );
}

// Peel a trailing glued redirection (with its operand) off a token:
// `hcloud>out`, `OBS>&2`, and the INPUT forms `hcloud<f`, `hcloud<<EOF`
// (interrogate round 9 — bash runs `bin<file args…` as the bin with the
// full argv; the operand is stdin, never argv) — bash still runs the bin
// with the service.
export function peelGluedRedirect(token: string): string {
  return token
    .replace(/>{1,2}[^>;&|\s]*$/, '')
    .replace(/<{1,2}[^<>;&|\s]*$/, '')
    .replace(/>&\d+$/, '');
}

// One spelling of the hcloud bin-token predicate. The token is normalized
// first — stripping a leading `$(`/backtick/`{`/`&`/`@` (the cmd
// echo-suppression sigil) and any quote/backslash characters — because the
// tokenizer keeps mid-token quoting (`hclou'd'`, `$(hcloud`, the
// PowerShell call-operator's glued `&{hcloud`, cmd's `@hcloud`) while the
// shell still executes the canonical bin. The RAW token is checked FIRST
// (before backslash stripping) so a Windows drive-qualified bin
// (`C:\hcloud.exe`) keeps its separators — the same dual raw+normalized
// doctrine matchesBinName applies to wrapper heads.
export function isHcloudToken(token: string): boolean {
  // Trailing shell-operator runs (`hcloud>`, `hcloud;`, `hcloud|`) and
  // glued redirect-with-operand (`hcloud>out`) attach to the bin in a
  // single token — bash still runs the bin.
  const raw = peelGluedRedirect(
    String(token)
      .toLowerCase()
      .replace(/^[$(`{&@<.]+/, '')
      .replace(/[>;&|]+$/, ''),
  );
  if (
    raw === 'hcloud' ||
    raw === 'hcloud.exe' ||
    raw.endsWith('/hcloud') ||
    raw.endsWith('\\hcloud') ||
    raw.endsWith('/hcloud.exe') ||
    raw.endsWith('\\hcloud.exe') ||
    /^[a-z]:hcloud(\.exe)?$/.test(raw)
  ) {
    return true;
  }
  // Quote-mangled Windows paths (`C:\hclou"d".exe`, the call operator's
  // `&('C:\hcloud.exe')`): strip quotes and wrapping parens but KEEP
  // backslashes before the path-suffix/drive-relative checks.
  const noQuotes = raw.replace(/['"()]/g, '');
  if (
    noQuotes !== raw &&
    (noQuotes.endsWith('\\hcloud') || noQuotes.endsWith('\\hcloud.exe') || /^[a-z]:hcloud(\.exe)?$/.test(noQuotes))
  ) {
    return true;
  }
  // Fully normalized: the PowerShell call operator on a parenthesized
  // string literal (`&('hcloud')`, `.('hcloud')`) peels its wrapping
  // punctuation to the canonical bin.
  const t = raw.replace(/['"\\`$()]/g, '');
  return t === 'hcloud' || t === 'hcloud.exe' || t.endsWith('/hcloud');
}

// Leading redirection tokens (`2>/dev/null cmd`, `<in cmd`, `2>&1 cmd`)
// occupy the command position without being the command.
export function isRedirectionToken(token: string): boolean {
  return /^\d*(>>|>|<|&>>|>&|<&)/.test(token);
}

// Basename of a path-qualified wrapper (`/usr/bin/time` → `time`).
export function basenameOf(token: string): string {
  const t = token.replaceAll('\\', '/');
  const idx = t.lastIndexOf('/');
  return idx < 0 ? t : t.slice(idx + 1);
}

function isFlagOrDuration(token: string): boolean {
  return token.startsWith('-') || /^\d*\.?\d+[smh]?$/i.test(token);
}

export function isEnvAssignment(token: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(token);
}

export function skipPrefixArguments(prefix: string, tokens: string[]): string[] {
  const valueFlags = PREFIX_FLAGS_WITH_VALUE.get(prefix) ?? new Set<string>();
  let rest = tokens;
  while (
    rest.length > 0 &&
    (isFlagOrDuration(String(rest[0])) ||
      ((prefix === 'start' || prefix === 'call') && String(rest[0]).startsWith('/')))
  ) {
    // Round 19 F1b: the value-flag comparison strips quote-mangling
    // (`env -'u' X cat` — the flag token read raw missed its value class,
    // eating the operand as the content head).
    const flag = String(rest[0]).replace(/['"\\$]/g, '');
    rest = rest.slice(1);
    if (!flag.includes('=') && valueFlags.has(flag) && rest.length > 0) {
      rest = rest.slice(1);
    }
  }
  return rest;
}

export function isHcloudBinToken(token: string): boolean {
  const t = normalizeBinToken(token);
  return t === 'hcloud' || t.endsWith('/hcloud') || t === 'hcloud.exe';
}
