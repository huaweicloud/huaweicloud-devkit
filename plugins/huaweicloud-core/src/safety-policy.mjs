import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { evaluateCommandRisk, mergeRiskDecision } from './risk-rule-engine.mjs';
import { redactCredentialShapes } from './redact-core.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const policyPath = join(__dirname, '..', 'safety', 'policy.json');

export function loadPolicy() {
  const policy = JSON.parse(readFileSync(policyPath, 'utf8'));
  // A parseable-but-degraded policy must fail loud: missing keys, empty
  // lists, or a wrong-typed agentartsCommandPolicy would silently disable
  // gates (or crash mid-classification) while the module still loads. The
  // wired hook converts the throw into a fail-safe deny.
  for (const key of ['credentialFilePatterns', 'blockedSecretOperations', 'writeOperationPrefixes']) {
    if (!Array.isArray(policy[key]) || policy[key].length === 0) {
      throw new Error(`safety policy key ${key} must be a non-empty array`);
    }
  }
  if (
    typeof policy.agentartsCommandPolicy !== 'object' ||
    policy.agentartsCommandPolicy === null ||
    Array.isArray(policy.agentartsCommandPolicy) ||
    Object.keys(policy.agentartsCommandPolicy).length === 0
  ) {
    throw new Error('safety policy key agentartsCommandPolicy must be a non-empty object');
  }
  return policy;
}

const DEFAULT_POLICY = loadPolicy();

function regexFrom(pattern) {
  return new RegExp(pattern, 'i');
}

function isSecretKeyName(key, policy = DEFAULT_POLICY) {
  const normalized = String(key)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
  if (
    /access.*key|secret.*key|security.*token|xauth.*token|authorization|password|passwd|adminpass|credential|private.*key|userdata|metadata/.test(
      normalized,
    )
  ) {
    return true;
  }
  return policy.secretKeyNamePatterns.some((pattern) => regexFrom(`^(${pattern})$`).test(key));
}

function redactString(text) {
  // The string path is the safety net for unparseable CLI output; the
  // shapes it must catch live in redact-core.mjs (single source, shared
  // with risk-rule-engine's evidence scrubber — findings trap 27).
  return redactCredentialShapes(text);
}

export function redactSecrets(value, policy = DEFAULT_POLICY) {
  if (Array.isArray(value)) {
    return value.map((item) => redactSecrets(item, policy));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, val]) => [
        key,
        isSecretKeyName(key, policy) ? '<redacted>' : redactSecrets(val, policy),
      ]),
    );
  }
  if (typeof value === 'string') {
    return redactString(value);
  }
  return value;
}

function stripExecutable(args) {
  if (!args.length) return [];
  let current = args;
  // Unwrap shell wrappers (bash -c / sh -c 'hcloud ...', sudo hcloud ...,
  // cmd /c "hcloud ...", powershell -Command "hcloud ...") so wrapped write
  // commands keep their deny classification (#650 D4-16, #731 / #760).
  for (let depth = 0; depth < 5; depth++) {
    const first = String(current[0]).toLowerCase();
    const isShell = [
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
    ].includes(first);
    if (isShell && String(current[1]).toLowerCase() === '-c' && current[2]) {
      current = splitSimpleCommand(current[2]);
      continue;
    }
    // Windows: cmd /c "…" / cmd /k "…" / cmd.exe /c "…"
    if (first === 'cmd' || first === 'cmd.exe') {
      const flag = String(current[1] || '').toLowerCase();
      if ((flag === '/c' || flag === '/k') && current[2]) {
        current = splitSimpleCommand(current[2]);
        continue;
      }
    }
    // Windows: powershell -Command "…" / powershell -c "…" / pwsh -Command "…"
    if (first === 'powershell' || first === 'powershell.exe' || first === 'pwsh' || first === 'pwsh.exe') {
      const flag = String(current[1] || '').toLowerCase();
      if ((flag === '-command' || flag === '-c') && current[2]) {
        current = splitSimpleCommand(current[2]);
        continue;
      }
    }
    if (first === 'sudo' && current.length > 1) {
      current = current.slice(1);
      continue;
    }
    break;
  }
  const first = String(current[0]).toLowerCase();
  if (first === 'hcloud' || first.endsWith('/hcloud') || first.endsWith('\\hcloud') || first === 'hcloud.exe') {
    return current.slice(1);
  }
  return current;
}

function commandOperation(args) {
  const stripped = stripExecutable(args).map(String).filter(Boolean);
  if (stripped[0]?.toLowerCase() === 'configure') {
    return { service: 'configure', operation: stripped[1] || '', args: stripped };
  }
  const nonFlags = stripped.filter((arg) => !arg.startsWith('-'));
  return {
    service: nonFlags[0] || '',
    operation: nonFlags[1] || nonFlags[0] || '',
    args: stripped,
  };
}

function matchesAny(value, patterns) {
  return patterns.some((pattern) => regexFrom(pattern).test(value));
}

function hasWritePrefix(operation, policy) {
  const normalized = String(operation);
  return policy.writeOperationPrefixes.some((prefix) => new RegExp(`(^|[A-Za-z0-9])${prefix}`, 'i').test(normalized));
}

function hasReadPrefix(operation, policy) {
  return policy.readOperationPrefixes.some((prefix) => new RegExp(`^${prefix}`, 'i').test(operation));
}

function isLocalMetadataCommand(args) {
  return args.some((arg) => /^(--help|-h|help|version|--version)$/i.test(String(arg)));
}

function commandRiskText(normalizedArgs, options = {}) {
  return options.rawCommand || ['hcloud', ...normalizedArgs].join(' ');
}

function applyCommandRiskRules(base, normalizedArgs, options = {}) {
  if (base.decision === 'deny' || options.skipRiskRules === true) {
    return base;
  }
  const risk = evaluateCommandRisk(commandRiskText(normalizedArgs, options));
  return mergeRiskDecision(base, risk);
}

function applyRawCommandRiskRules(base, command, options = {}) {
  if (base.decision === 'deny' || options.skipRiskRules === true) {
    return base;
  }
  const risk = evaluateCommandRisk(command);
  return mergeRiskDecision(base, risk);
}

// Find hcloud command segments split by shell operators (; && || |) so a write
// command in the middle of a concatenated string keeps its deny classification
// (#650 review edge 1).
function findHcloudCommandSegments(text) {
  return String(text)
    .split(/(?:\|\||&&|;|\|)/)
    .map((segment) => segment.trim())
    .filter(Boolean)
    .map((segment) => splitSimpleCommand(segment))
    .filter((tokens) => {
      const first = String(tokens[0] || '').toLowerCase();
      return first === 'hcloud' || first.endsWith('/hcloud') || first.endsWith('\\hcloud') || first === 'hcloud.exe';
    });
}

export function classifyHcloudArgs(args, options = {}) {
  const policy = options.policy || DEFAULT_POLICY;
  // Second pass for shell-wrapped input (#650 D4-16 review edge 1): when the
  // leading command is not hcloud but a concatenated segment contains one,
  // classify every hcloud segment and merge to the most severe decision.
  const unwrappedTokens = stripExecutable(Array.isArray(args) ? args.map(String) : []);
  const unwrappedFirst = String(unwrappedTokens[0] || '').toLowerCase();
  const unwrappedIsHcloud =
    unwrappedFirst === 'hcloud' ||
    unwrappedFirst.endsWith('/hcloud') ||
    unwrappedFirst.endsWith('\\hcloud') ||
    unwrappedFirst === 'hcloud.exe';
  if (!unwrappedIsHcloud && !options._segmentDepth) {
    const hcloudSegments = findHcloudCommandSegments(unwrappedTokens.join(' '));
    if (hcloudSegments.length > 0) {
      const results = hcloudSegments.map((segment) => classifyHcloudArgs(segment, { ...options, _segmentDepth: 1 }));
      return (
        results.find((result) => result.decision === 'deny') ||
        results.find((result) => ['write', 'execution', 'secret', 'credential'].includes(result.risk)) ||
        results[0]
      );
    }
  }
  const { service, operation, args: normalizedArgs } = commandOperation(args);
  const joined = normalizedArgs.join(' ');

  if (!normalizedArgs.length) {
    // `… | xargs/parallel hcloud` feeds the arguments on stdin — they cannot
    // be classified, so fail-safe deny (the same guard the agentarts
    // bare-allow carries). Without it the bare-allow re-opened the write
    // floor for stdin-fed invocations.
    if (options.segment && isStdinFedSegment(options.segment)) {
      return {
        decision: 'deny',
        risk: 'write',
        reason:
          'hcloud invoked via xargs/parallel (arguments arrive on stdin and cannot be classified); run it in your own terminal or use the approved tooling (huaweicloud_run_approved_command).',
        service,
        operation,
        args: normalizedArgs,
      };
    }
    // Bare `hcloud` (and path-final references like `ls /usr/local/bin/hcloud`
    // located by the path-prefix window) print help or probe the binary —
    // local metadata, mirroring the bare-agentarts allow. The old deny
    // turned every path-form file operand into a block.
    return applyCommandRiskRules(
      {
        decision: 'allow',
        risk: 'local_metadata',
        reason: 'Bare hcloud invocation prints help.',
        service,
        operation,
        args: normalizedArgs,
      },
      joined,
      options,
    );
  }

  if (isLocalMetadataCommand(normalizedArgs)) {
    return applyCommandRiskRules(
      {
        decision: 'allow',
        risk: 'local_metadata',
        reason: 'KooCLI local help and version commands are read-only and do not call Huawei Cloud resource APIs.',
        service,
        operation,
        args: normalizedArgs,
      },
      normalizedArgs,
      options,
    );
  }

  if (service.toLowerCase() === 'configure') {
    const subcommand = operation.toLowerCase();
    if (
      policy.blockedConfigureSubcommands.map((cmd) => cmd.toLowerCase()).includes(subcommand) &&
      options.allowCredentialRead !== true
    ) {
      return {
        decision: 'deny',
        risk: 'credential',
        reason:
          'Direct hcloud configure inspection may expose profile credentials. Use the redacted toolkit tools instead.',
      };
    }
  }

  if (policy.blockedSecretOperations.some((op) => op.toLowerCase() === operation.toLowerCase())) {
    return {
      decision: 'deny',
      risk: 'secret',
      reason: 'Direct secret value reads are blocked so plaintext secrets do not enter the agent context.',
    };
  }

  if (/secret[_-]?string|secret[_-]?binary|showsecret|showsecretversion|getsecretvalue/i.test(joined)) {
    return {
      decision: 'deny',
      risk: 'secret',
      reason: 'The command appears to retrieve a secret value. Use a runtime secret reference pattern instead.',
    };
  }

  const readOnly = hasReadPrefix(operation, policy);
  const executionOps =
    /(^|\.)(Invoke|SyncInvoke|AsyncInvoke|Send|Trigger|Execute|Start|Reboot|Restart|Stop|Publish|Deploy)/i;
  const isExecution = executionOps.test(operation) && !readOnly;
  const isWrite = !readOnly && hasWritePrefix(operation, policy);

  if (isExecution && !options.allowWrites) {
    return {
      decision: 'deny',
      risk: 'execution',
      reason: 'Huawei Cloud execution/trigger operation blocked until approved.',
    };
  }

  if (isWrite && !options.allowWrites) {
    return {
      decision: 'deny',
      risk: 'write',
      reason:
        'Huawei Cloud write operation blocked until the agent presents a plan and receives explicit user approval.',
    };
  }

  const obsutilWrites = [
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
    // #1001: 'cors' and 'website' were removed — KooCLI 7.x's OBS wrapper does
    // NOT expose them (`hcloud OBS help cors` → "No such command"; same for
    // website). A nonexistent command cannot produce a write side effect, so
    // grading it as a write was safety based on a stale assumption. CORS/static-
    // website config goes through the REST API (PUT /?cors) — see the
    // huawei-obs skill common-pitfalls.md CORS chapter.
    'sign',
    'share-add',
    'share-update',
    'share-rm',
  ];
  const obsutilReads = ['ls', 'stat', 'cat', 'help', 'version'];
  const isObs = service.toLowerCase() === 'obs' || service.toLowerCase() === 'hcloud obs';
  const isObsWrite = isObs && obsutilWrites.includes(operation);
  const isObsRead = isObs && obsutilReads.includes(operation);
  if (isObsWrite && !options.allowWrites) {
    return {
      decision: 'deny',
      risk: 'write',
      reason: 'OBS write operation blocked until the agent presents a plan and receives explicit user approval.',
    };
  }
  if (isObsRead) {
    return applyCommandRiskRules(
      {
        decision: 'allow',
        risk: 'read_only',
        reason: 'OBS read-only operation.',
        service,
        operation,
        args: normalizedArgs,
      },
      normalizedArgs,
      options,
    );
  }
  if (isObsWrite && options.allowWrites) {
    return applyCommandRiskRules(
      {
        decision: 'allow',
        risk: 'write',
        reason: 'OBS write operation approved by user.',
        service,
        operation,
        args: normalizedArgs,
      },
      normalizedArgs,
      options,
    );
  }

  if (isExecution && options.allowWrites) {
    return applyCommandRiskRules(
      {
        decision: 'allow',
        risk: 'execution',
        reason: 'Huawei Cloud execution/trigger operation approved by user.',
        service,
        operation,
        args: normalizedArgs,
      },
      normalizedArgs,
      options,
    );
  }

  if (isWrite && options.allowWrites) {
    return applyCommandRiskRules(
      {
        decision: 'allow',
        risk: 'write',
        reason: 'Huawei Cloud write operation approved by user.',
        service,
        operation,
        args: normalizedArgs,
      },
      normalizedArgs,
      options,
    );
  }

  return applyCommandRiskRules(
    {
      decision: 'allow',
      risk: readOnly ? 'read_only' : 'unknown_read',
      reason: readOnly
        ? 'Command appears to be a read-only Huawei Cloud operation.'
        : 'Command does not match a known write or secret operation; treat output as untrusted and redact it.',
      service,
      operation,
      args: normalizedArgs,
    },
    normalizedArgs,
    options,
  );
}

function splitSimpleCommand(command) {
  return (
    String(command)
      .match(/"[^"]*"|'[^']*'|\S+/g)
      // Strip ALL quote characters (not just the outer pair): POSIX shells
      // remove quotes before executing, so an embedded-quote form like
      // `hcloud ECS De'leteServer …` actually runs `DeleteServer`. Stripping
      // only outer quotes left `De'leteServer` in the token and let the write/
      // secret/execution matchers miss it (#927). This hcloud classification
      // path only — credential-var lookbehind still sees raw text with quotes.
      .map((part) => part.replace(/['"]/g, '')) || []
  );
}

// Extract inner command text from shell wrappers: bash -c "…", sh -c '…',
// eval "…", $(…), `…`, Windows cmd/powershell. Returns an array of extracted
// inner strings (may include nested extractions). This lets classifyTextCommand
// inspect the actual payload instead of the wrapper tokens (#758 D4-16).
// Payload captures are BOUNDED ({0,1024} quoted / {1,512} substitution):
// unbounded runs made every `$(`/backtick/quote start a quadratic
// backtracking position, and a ~40-80KB padded command killed the hook
// before any gate could deny — a dead hook is a non-blocking error, i.e.
// allow. A quoted payload longer than 1024 or a substitution payload longer
// than 512 is left unextracted (documented residual, same class as the
// locator's 256-char window).
export function extractInnerCommand(text, depth = 0) {
  if (depth > 3) return [];
  const t = String(text || '');
  const results = [];
  let m;

  // bash -c "…" / sh -c '…' / /bin/bash -c "…" / bash.exe -c '…'
  const shellWrap =
    /\b(?:bash|sh|zsh|dash|\/bin\/(?:bash|sh|zsh|dash)|bash\.exe|sh\.exe)\s+-c\s+(["'])([\s\S]{0,1024}?)\1/gi;
  while ((m = shellWrap.exec(t)) !== null) {
    if (m[2]) {
      results.push(m[2]);
      results.push(...extractInnerCommand(m[2], depth + 1));
    }
  }

  // eval "…" / eval '…'
  const evalWrap = /\beval\s+(["'])([\s\S]{0,1024}?)\1/gi;
  while ((m = evalWrap.exec(t)) !== null) {
    if (m[2]) {
      results.push(m[2]);
      results.push(...extractInnerCommand(m[2], depth + 1));
    }
  }

  // $(…) command substitution (single-level; nested parens are a known limitation)
  const cmdSubst = /\$\(([^)]{1,512})\)/g;
  while ((m = cmdSubst.exec(t)) !== null) {
    if (m[1]) {
      results.push(m[1]);
      results.push(...extractInnerCommand(m[1], depth + 1));
    }
  }

  // `…` backtick command substitution (POSIX sh). Treated the same as $(…):
  // the inner text is extracted as an independent candidate and recursed
  // into so that `hcloud ECS DeleteServer …` is classified correctly (#758).
  const backtickSubst = /`([^`]{1,512})`/g;
  while ((m = backtickSubst.exec(t)) !== null) {
    if (m[1]) {
      results.push(m[1]);
      results.push(...extractInnerCommand(m[1], depth + 1));
    }
  }

  // Windows: cmd /c "…" / cmd /k '…' / cmd.exe /c "…" (#731 / #760).
  // /c runs and terminates; /k runs and keeps the shell — both can wrap hcloud.
  const cmdWrap = /\b(?:cmd|cmd\.exe)\s+\/[ck]\s+(["'])([\s\S]{0,1024}?)\1/gi;
  while ((m = cmdWrap.exec(t)) !== null) {
    if (m[2]) {
      results.push(m[2]);
      results.push(...extractInnerCommand(m[2], depth + 1));
    }
  }

  // Windows: powershell -Command "…" / powershell -c '…' / pwsh -Command "…"
  // / pwsh.exe -c "…" (#731 / #760). Covers both Windows PowerShell and
  // PowerShell Core (pwsh). The -Command/-c flag executes the quoted string.
  const psWrap = /\b(?:powershell|powershell\.exe|pwsh|pwsh\.exe)\s+(?:-Command|-c)\s+(["'])([\s\S]{0,1024}?)\1/gi;
  while ((m = psWrap.exec(t)) !== null) {
    if (m[2]) {
      results.push(m[2]);
      results.push(...extractInnerCommand(m[2], depth + 1));
    }
  }

  return results;
}

// hcloud keyword, located with the same linear no-star scan + bounded
// suffix-window prefix test as the agentarts keyword (see the performance
// contract below). Natural-language/echo mentions with PLAIN whitespace
// before the keyword stay excluded (#758 D4-11); candidates from
// extractInnerCommand start with hcloud directly so the empty window (^)
// catches wrapped commands. `sudo hcloud …` stays a real command (#760 P0).
// The prefix window ALSO catches launcher/assignment/path-prefixed writes
// (`FOO=1 hcloud …`, `nice hcloud …`) that the pre-window anchored pattern
// missed. Inherited deny-direction FP classes from the shared window (same
// ledger as agentarts): assignment-shaped prose (`echo version=1.0 hcloud
// ECS DeleteServer x`), launcher token-run prose (`watch -n 5 grep hcloud
// …`), and path-prefix prose (`see docs/hcloud ECS DeleteServer guide`).
// Bare/path-final `hcloud` (a file operand or help print) is allowed — see
// the empty-args branch in classifyHcloudArgs.
const HCLOUD_KW_PATTERN = /(hcloud(?:\.exe)?\b)/gi;

// AgentArts CLI (agentarts-sdk) keyword locator — command-position semantics
// aligned with the hcloud pattern, extended for invocation shapes the
// agentarts floor must catch on its own (PR1 has no approval wrapper yet as
// the second line of defense): launcher prefixes with option/argument runs
// (env -i, nice -n 5, xargs -r, timeout --foreground 300, g-prefixed GNU
// spellings, dotenv, parallel/ionice/taskset), env-var assignments
// (FOO=1 agentarts …, VAR=/path/agentarts …), path invocation
// (/opt/venv/bin/agentarts …, ./agentarts …), sudo with options, values, and
// executor words (strace/time/ltrace/perf/valgrind/script), and the
// $AGENTARTS_BIN handle. Natural-language mentions ("see agentarts docs")
// still never match: plain whitespace is not a command-position prefix.
// The (?![\w./-]) boundary excludes agentarts-sdk / agentarts-setup
// lookalikes, directory paths like docs/agentarts/README, and
// printenv/setenv variable-name mentions.
//
// Performance contract: the keyword is located with a linear no-star scan,
// and the prefix is validated against a 256-character window ENDING at the
// keyword (suffix-anchored, token runs bounded to 32). Scanning the full
// text with starred prefix alternations was quadratic per start position —
// a ~48KB padded command stalled the wired hook past its 5s runner timeout,
// and a dead hook is a non-blocking error, i.e. allow. The window and the
// token bound leave one documented residual: a launcher more than 256
// characters or 32 tokens before the keyword, and path-form executor words
// under sudo (sudo /usr/bin/strace agentarts …), fall back to allow.
//
// Accepted deny-direction false positives: quoted strings and grep patterns
// containing `;|& agentarts <group>` or `<path>/ agentarts <group>`;
// assignment-shaped prose (`echo version=1.0 agentarts rocks`); prose after
// a launcher token-run (`watch -n 5 grep agentarts logfile`). The remedy in
// every case is the taught degraded path — run it in the user terminal.
// One windowing artifact: a cut landing mid-word can expose a launcher-word
// fragment at window start (fabricating the \b) — engineered >256-char
// padding only, deny-direction.
const AGENTARTS_KW_PATTERN = /(?:agentarts(?:\.exe)?|\$\{?AGENTARTS_BIN\}?)(?![\w./-])/gi;
const AGENTARTS_PREFIX_SUFFIX_RE = new RegExp(
  '(?:^|[;|&]\\s*|\\$\\(\\s*|`\\s*|\\r?\\n\\s*|' +
    '\\b(?:g(?:timeout|xargs|nice|stdbuf|watch|env|nohup|setsid)|dotenv|parallel|ionice|taskset|env|nohup|exec|command|xargs|nice|setsid|stdbuf|watch|timeout)(?:\\s+\\S+){0,32}\\s+|' +
    'sudo(?:\\s+(?:-\\S+(?:\\s+[^\\s-]+)?|strace|ltrace|perf|valgrind|script|time)){0,32}\\s+|' +
    '[A-Za-z_][A-Za-z0-9_]*=\\S*\\s+|[A-Za-z_][A-Za-z0-9_]*=|[\\w.~\\\\/-]*[/\\\\])$',
  'i',
);
const AGENTARTS_WINDOW = 256;

function findKeywordCommandPosition(hay, kwRegex) {
  for (const match of hay.matchAll(kwRegex)) {
    const window = hay.slice(Math.max(0, match.index - AGENTARTS_WINDOW), match.index);
    // Dual test: raw window, then the trailing-whitespace-trimmed window.
    // The trim restores the pre-window unbounded `\s*` anchor semantics for
    // padded separators (`echo hi; <300 spaces> hcloud …`): a pure-whitespace
    // window means the keyword is still preceded by a whitespace run from a
    // command position, whatever the anchor char was. Deny-direction FP
    // surface (documented): pure-whitespace windows ≥256 chars
    // (`echo <300 spaces> hcloud …`), and — because the path alternative
    // cannot consume trailing whitespace — path-terminated windows followed
    // by ANY trailing whitespace, a single space suffices
    // (`echo see docs/ hcloud ECS DeleteServer guide`).
    if (AGENTARTS_PREFIX_SUFFIX_RE.test(window) || AGENTARTS_PREFIX_SUFFIX_RE.test(window.replace(/\s+$/, ''))) {
      return match.index;
    }
  }
  return -1;
}

function findAgentartsKeyword(hay) {
  return findKeywordCommandPosition(hay, AGENTARTS_KW_PATTERN);
}

function extractHcloudSubcommand(text) {
  const t = String(text || '');
  // A hcloud command at the start of any line must be located and fully
  // classified — previously `echo hello\nhcloud ECS DeleteServer …` fell
  // through as not_huaweicloud allow (#927); the window's \r?\n branch
  // covers line starts.
  const direct = findKeywordCommandPosition(t, HCLOUD_KW_PATTERN);
  if (direct !== -1) {
    return t.slice(direct);
  }
  // Keyword-embedded quotes fallback (#927 B1): POSIX shells strip quotes
  // before execution, so `hc'loud ECS DeleteServer …` runs `hcloud …` — but
  // the literal match never sees the keyword through the quotes. Retry on a
  // quote-stripped COPY used only for keyword location; the returned
  // subcommand is the de-quoted text, matching the de-quote semantics
  // splitSimpleCommand already applies to tokens. Credential/env-var checks
  // in classifyTextCommand still run on the raw text — the two paths stay
  // independent — and plain-whitespace natural-language mentions ("see
  // hcloud docs") never match the prefix window; the inherited deny-direction
  // FP classes are enumerated at HCLOUD_KW_PATTERN above.
  const stripped = t.replace(/['"]/g, '');
  const retry = findKeywordCommandPosition(stripped, HCLOUD_KW_PATTERN);
  if (retry === -1) return null;
  return stripped.slice(retry);
}

function extractAgentartsSubcommand(text) {
  const t = String(text || '');
  const direct = findAgentartsKeyword(t);
  if (direct !== -1) {
    return t.slice(direct);
  }
  // Quote-embedded keyword fallback, same shape as the hcloud #927 retry:
  // `agen'tarts destroy …` runs `agentarts destroy …` after POSIX de-quoting,
  // but the literal match never sees the keyword through the quote.
  const stripped = t.replace(/['"]/g, '');
  const retry = findAgentartsKeyword(stripped);
  if (retry === -1) return null;
  return stripped.slice(retry);
}

// Classify an agentarts invocation from the de-quoted tokens that follow the
// `agentarts` keyword. Tiers and labels are measured facts
// (docs/agentarts-pr0-findings.md; fixtures in test/fixtures/agentarts/) and
// live in policy.json agentartsCommandPolicy so the Node hook, the Python
// hook, and the approval wrapper consume one source. Tier semantics for the
// hook layer: local/readonly allow, approved deny-for-Bash (user terminal or
// approved tooling), blocked deny outright (deferred capability).
// A segment whose command resolves to a bare keyword fed by xargs/parallel:
// the arguments arrive on stdin and cannot be classified. Matched on the raw
// and de-quoted segment copies (g-prefixed and quote-split spellings too).
function isStdinFedSegment(segment) {
  const re = /\b(?:g)?(?:xargs|parallel)\b/i;
  return re.test(segment) || re.test(segment.replace(/['"]/g, ''));
}

// Group-level value-taking options (parsed by the GROUP's own callback
// before any subcommand), fixture-pinned 0.1.7: only the config wizard
// takes them (config.txt's Options panel); gateway/memory/runtime groups
// offer --help only. CANONICAL single source — the approval wrapper's
// GROUP_LEVEL_VALUE_FLAGS re-exports this map, and the subcommand
// locator below consumes it, so the three cannot drift.
export const AGENTARTS_GROUP_LEVEL_VALUE_FLAGS = new Map([
  [
    'config',
    new Set([
      '--name',
      '-n',
      '--entrypoint',
      '-e',
      '--region',
      '-r',
      '--dependency-file',
      '-d',
      '--swr-org',
      '--swr-repo',
    ]),
  ],
]);
const GROUP_LEVEL_EMPTY_FLAGS = new Set();

// Group/subcommand token resolution for an agentarts argv (WITHOUT the
// executable token): skip leading dash tokens, lowercase, apply the
// policy's aliases, and resolve the subcommand ONLY for groups with a
// subcommands table. Exported so the approval wrapper's effective
// classification mirrors THIS resolution (aliases included) instead of
// hand-copying it — a policy alias mapping into a command family must
// resolve identically in both places.
// Subcommand location walk (round 10): click parses the GROUP's own
// option panel before the subcommand resolves, and a group-level `--`
// separator is CONSUMED by the group parser while the subcommand parser
// restarts fresh (click core.py: `ctx.protected_args, ctx.args =
// rest[:1], rest[1:]`; measured: `memory -- create x` executes exactly
// like `memory create x`, `config --name x remove foo` executes
// remove). A naive next-token read saw no subcommand for both shapes —
// every subcommand-scoped guard (strategies, --output json
// canonicalization, one-time-key capture, install hard-stop, irreversible
// labels) was skipped and reads like `memory -- list` demoted to the
// group's approved tier. The walk skips group value-flag PAIRS and at
// most ONE `--`, then the next non-dash token is the subcommand.
export function resolveAgentartsGroupTokens(rawArgs, policy = DEFAULT_POLICY) {
  const commandPolicy = policy.agentartsCommandPolicy || {};
  const commands = commandPolicy.commands || {};
  const aliases = commandPolicy.aliases || {};
  const args = (Array.isArray(rawArgs) ? rawArgs : []).map((token) => String(token).toLowerCase());
  let i = 0;
  while (i < args.length && args[i].startsWith('-')) i += 1;
  const group = args[i] || '';
  const normalizedGroup = aliases[group] || group;
  const entry = commands[normalizedGroup];
  // Only groups WITH a subcommands table can resolve a subcommand: `invoke`
  // takes a required positional {payload}, and treating it as a subcommand
  // glued the payload into the operation (bogus "unregistered" warnings,
  // broken timeout selection, Node/Python reason drift).
  if (!entry?.subcommands) return { groupIndex: i, group: normalizedGroup, sub: undefined, subIndex: undefined };
  const groupValueFlags = AGENTARTS_GROUP_LEVEL_VALUE_FLAGS.get(normalizedGroup) ?? GROUP_LEVEL_EMPTY_FLAGS;
  let j = i + 1;
  let sawSeparator = false;
  while (j < args.length) {
    const token = args[j];
    if (token === '--' && !sawSeparator) {
      sawSeparator = true;
      j += 1;
      continue;
    }
    if (groupValueFlags.has(token) && j + 1 < args.length) {
      j += 2;
      continue;
    }
    // Inline group-flag forms (`--name=x`, one-letter `-nx`) are
    // self-contained — the subcommand can resolve right after them.
    const inline = /^(--[a-z0-9-]+)=/.exec(token) || /^(-[a-z0-9])(.+)$/.exec(token);
    if (inline && groupValueFlags.has(inline[1])) {
      j += 1;
      continue;
    }
    break;
  }
  const sub = j < args.length && !args[j].startsWith('-') ? args[j] : undefined;
  return { groupIndex: i, group: normalizedGroup, sub, subIndex: sub === undefined ? undefined : j };
}

// Registry resolution shared by the hook decision path AND the agentarts
// approval wrapper (agentarts-cli.mjs) — one classification source, so the
// "hook classification ≡ wrapper tier" invariant is structural, not tested
// after the fact. ONE measured exception (findings trap 26a): the wrapper
// re-derives help-in-value-slot argvs to their real tier; the hook's
// position-blind help short-circuit stands until the per-command value-
// flag metadata lands (recorded follow-up). Returns { tier, labels, group,
// subcommand, operation, unregistered } for an argv array WITHOUT the
// executable token.
export function resolveAgentartsTier(rawArgs, options = {}) {
  const policy = options.policy || DEFAULT_POLICY;
  const commandPolicy = policy.agentartsCommandPolicy || {};
  const commands = commandPolicy.commands || {};
  const defaultTier = commandPolicy.defaultTier || 'approved';

  const args = (Array.isArray(rawArgs) ? rawArgs : []).map((token) => token.toLowerCase());
  const resolved = resolveAgentartsGroupTokens(args, policy);
  const i = resolved.groupIndex;
  const normalizedGroup = resolved.group;
  const subcommand = resolved.sub ?? '';
  const group = args[i] || '';

  // Typer eager flags: --help/-h are valid at every command level, so any
  // position makes the invocation local metadata; --version/-v only exist at
  // root level, so only the leading flag region (before the group token)
  // counts. A bare invocation prints help.
  if (
    !group ||
    args.some((token) => /^(--help|-h)$/.test(token)) ||
    args.slice(0, i).some((token) => /^(--version|-v)$/.test(token))
  ) {
    return { tier: 'local', labels: [], group, subcommand: '', operation: group, unregistered: false };
  }

  const entry = commands[normalizedGroup];
  let tier = defaultTier;
  let labels = [];
  let unregistered = !entry;
  if (entry) {
    tier = entry.tier || defaultTier;
    labels = entry.labels || [];
    if (subcommand) {
      const subEntry = entry.subcommands[subcommand];
      if (subEntry) {
        tier = subEntry.tier || tier;
        labels = subEntry.labels || labels;
      } else {
        // Unknown subcommand under a group keeps the group default tier —
        // fail-safe, mirroring the unknown-top-level defaultTier.
        unregistered = true;
      }
    }
  }
  return {
    tier,
    labels,
    group: normalizedGroup,
    subcommand,
    operation: subcommand ? `${normalizedGroup} ${subcommand}` : normalizedGroup,
    unregistered,
  };
}

export function classifyAgentartsArgs(tokens, options = {}) {
  const policy = options.policy || DEFAULT_POLICY;

  let args = (Array.isArray(tokens) ? tokens.map(String) : [])
    .map((token) => token.toLowerCase())
    // splitSimpleCommand can emit empty tokens for quoted-empty arguments
    // (`agentarts "" launch`); dropping them keeps the group resolution
    // aligned with the Python tokenizer.
    .filter((token) => token !== '');
  // extractAgentartsSubcommand returns text starting AT the keyword (same
  // contract as the hcloud path), so strip the executable token first —
  // exact name, .exe, path-invoked forms, and the $AGENTARTS_BIN handle.
  const first = args[0] || '';
  if (
    first === 'agentarts' ||
    first === 'agentarts.exe' ||
    first.endsWith('/agentarts') ||
    first.endsWith('\\agentarts') ||
    /^\$\{?agentarts_bin\}?$/.test(first)
  ) {
    args = args.slice(1);
  }
  const base = { service: 'AgentArts', args };
  const resolved = resolveAgentartsTier(args, { policy });
  base.operation = resolved.operation;

  if (resolved.tier === 'local' && !resolved.group && options.segment && isStdinFedSegment(options.segment)) {
    // `… | xargs [-r/-n1/…] agentarts` (any spelling, incl. path or
    // $AGENTARTS_BIN) feeds the subcommand on stdin — unclassifiable and
    // therefore fail-safe deny rather than bare-help allow.
    return {
      decision: 'deny',
      risk: 'agentarts_write',
      reason:
        'agentarts invoked via xargs (arguments arrive on stdin and cannot be classified); run it in your own terminal (see the huawei-agentarts skill).',
      ...base,
    };
  }

  if (resolved.tier === 'approved' || resolved.tier === 'blocked') {
    const labelSuffix = resolved.labels.length ? ` (${resolved.labels.join(', ')})` : '';
    return {
      decision: 'deny',
      risk: resolved.tier === 'blocked' ? 'agentarts_blocked' : 'agentarts_write',
      reason:
        resolved.tier === 'blocked'
          ? `agentarts ${base.operation} is deferred to a later toolkit release; run it in your own terminal if needed (see the huawei-agentarts skill).`
          : `Bash execution of agentarts ${base.operation}${labelSuffix} is blocked: cloud write operations must run in your own terminal or through approved tooling (see the huawei-agentarts skill).`,
      ...base,
    };
  }

  return applyRawCommandRiskRules(
    {
      decision: 'allow',
      risk: resolved.tier === 'readonly' ? 'agentarts_read_only' : 'agentarts_local',
      reason:
        resolved.tier === 'readonly'
          ? 'Read-only agentarts operation; treat output as untrusted and redact it.'
          : // Bare/help invocations (no group token) are metadata; a resolved
            // local group (init/dev) is an actual local command.
            resolved.group
            ? 'Local agentarts operation.'
            : 'Local agentarts metadata operation.',
      ...base,
    },
    options.rawCommand || args.join(' '),
    options,
  );
}

// Segment sweep for the agentarts gate: shell operators, single `&`, and
// newlines can chain a write after a readonly agentarts command
// (`agentarts memory list && agentarts launch`), which a single
// first-keyword classification misses. Splits on a SUPERSET of the
// findHcloudCommandSegments operator set (newlines and single `&` added;
// the args-level sweep still lacks both — a documented pre-existing
// residual — but the text-level classifyHcloudText sweep below covers them
// for raw-text classification) and classifies every segment that invokes
// agentarts, merging to the most severe decision.
function classifyAgentartsText(text, options = {}) {
  const segments = String(text || '')
    .split(/(?:\|\||&&|;|\||&|\r?\n)/)
    .map((segment) => segment.trim())
    .filter(Boolean);
  let merged = null;
  for (const segment of segments) {
    const subcommand = extractAgentartsSubcommand(segment);
    if (!subcommand) continue;
    const decision = classifyAgentartsArgs(splitSimpleCommand(subcommand), {
      ...options,
      segment,
    });
    if (decision.decision === 'deny') return decision;
    if (!merged) merged = decision;
  }
  return merged;
}

// Text-level segment sweep for the hcloud gate (the same contract): splits
// on ||, &&, ;, |, single &, and newlines, then classifies every segment
// that invokes hcloud, merging deny-first. This closes the shapes the
// args-level findHcloudCommandSegments sweep cannot see from the TEXT path —
// a write chained after a readonly segment via & or a newline, and the
// padded-decoy shape where the FIRST located keyword is a whitespace-echo
// false positive (`echo <300 spaces> hcloud & hcloud ECS DeleteServer …`)
// and the real write would be swallowed into the first extraction.
function classifyHcloudText(text, options = {}) {
  const segments = String(text || '')
    .split(/(?:\|\||&&|;|\||&|\r?\n)/)
    .map((segment) => segment.trim())
    .filter(Boolean);
  let merged = null;
  for (const segment of segments) {
    const subcommand = extractHcloudSubcommand(segment);
    if (!subcommand) continue;
    const decision = classifyHcloudArgs(splitSimpleCommand(subcommand), {
      ...options,
      segment,
    });
    if (decision.decision === 'deny') return decision;
    if (!merged) merged = decision;
  }
  return merged;
}

export function classifyTextCommand(command, options = {}) {
  const policy = options.policy || DEFAULT_POLICY;
  const text = String(command || '');

  // Extract inner commands from shell wrappers (bash -c, sh -c, eval, $()).
  // Each candidate (original + extracted inners) is checked independently so a
  // wrapped credential dump or hcloud write is caught even when the wrapper
  // text alone doesn't match (#758 D4-16, also covers #682 env-dump vector).
  const candidates = [text, ...extractInnerCommand(text)];

  // Credential file reads — check all candidates.
  for (const candidate of candidates) {
    if (matchesAny(candidate, policy.credentialFilePatterns)) {
      return {
        decision: 'deny',
        risk: 'credential',
        reason:
          'Reading Huawei Cloud credential or profile files is blocked. Use redacted profile inspection tools instead.',
      };
    }
  }

  // Env var dumps — check all candidates (covers bash -c "env | grep HUAWEICLOUD", #682).
  for (const candidate of candidates) {
    if (
      /(^|\s)(env|printenv|Get-ChildItem\s+Env:|gci\s+Env:|dir\s+Env:)/i.test(candidate) &&
      /HUAWEICLOUD|HWC_|HW_|HCLOUD|OS_/i.test(candidate)
    ) {
      return {
        decision: 'deny',
        risk: 'credential',
        reason: 'Dumping cloud credential environment variables is blocked.',
      };
    }
  }

  // Credential variable references bypass the env-command gate above: HW_ is
  // the plugin's own documented credential prefix (HW_ACCESS_KEY/HW_SECRET_KEY/
  // HW_SECURITY_TOKEN), cloud environments also expose the AWS-style
  // HUAWEICLOUD_SECRET_ACCESS_KEY name, and `echo $HW_SECRET_KEY` /
  // `printenv HW_ACCESS_KEY` / `echo $HUAWEICLOUD_SECRET_ACCESS_KEY` previously
  // fell through to allow (#650 D4-2, #770 D4-2).
  //
  // The negative lookbehind exempts literal-NAME references — backslash-escaped
  // (`\$HW_*`) or single-quoted (`'$HW_*'`, which the shell never expands) —
  // while unescaped `$HW_*` is a potential expansion/dump regardless of the
  // command. No command-name whitelist, so no false negative (#650 review).
  for (const candidate of candidates) {
    if (
      /(?<!['\\])\$\{?(?:HUAWEICLOUD|HWC|HW|OS)_(?:SECRET_ACCESS_KEY|ACCESS_KEY|SECRET_KEY|SECURITY_TOKEN|SDK_AK|SDK_SK|SDK_MEMORY_API_KEY)/i.test(
        candidate,
      ) ||
      /(?:^|\s)printenv\s+(?:HUAWEICLOUD|HWC|HW|OS)_(?:SECRET_ACCESS_KEY|ACCESS_KEY|SECRET_KEY|SECURITY_TOKEN|SDK_AK|SDK_SK|SDK_MEMORY_API_KEY)/i.test(
        candidate,
      )
    ) {
      return {
        decision: 'deny',
        risk: 'credential',
        reason: 'Printing cloud credential environment variables is blocked.',
      };
    }
  }

  // hcloud command detection — extract the subcommand starting from the hcloud
  // keyword so prompt-injection prefixes ("Ignore previous instructions and
  // hcloud …") and shell wrappers ("bash -c \"hcloud …\"") are classified
  // correctly (#758 D4-16 + D4-11). Check all candidates (original + inners),
  // each through a text-level segment sweep (classifyHcloudText) so a write
  // chained after a readonly segment via && ; | & or a newline is caught —
  // including the padded-decoy shape where the FIRST located keyword is a
  // whitespace-echo FP and the real write follows an operator.
  // Non-deny decisions are held pending instead of returned immediately: a
  // readonly allow from the first matching candidate must not shadow a deny
  // in a later candidate or in the agentarts sweep below (e.g.
  // `agentarts memory list && bash -c "agentarts launch"`, or a mixed
  // `hcloud … && agentarts launch` chain) — deny wins across candidates,
  // mirroring the Python hook's loop semantics.
  let hcloudPending = null;
  for (const candidate of candidates) {
    const hcloudDecision = classifyHcloudText(candidate, { ...options, rawCommand: text });
    if (hcloudDecision) {
      if (hcloudDecision.decision === 'deny') {
        return hcloudDecision;
      }
      hcloudPending = hcloudPending || hcloudDecision;
    }
  }

  // agentarts CLI detection — same candidate sweep with a per-candidate
  // segment sweep so chained writes after a readonly segment are caught.
  let agentartsPending = null;
  for (const candidate of candidates) {
    const agentartsDecision = classifyAgentartsText(candidate, { ...options, rawCommand: text });
    if (agentartsDecision) {
      if (agentartsDecision.decision === 'deny') {
        return agentartsDecision;
      }
      agentartsPending = agentartsPending || agentartsDecision;
    }
  }
  if (hcloudPending) {
    return hcloudPending;
  }
  if (agentartsPending) {
    return agentartsPending;
  }

  if (/ShowSecretVersion|ShowSecret|GetSecretValue|secret_string|secret_binary/i.test(text)) {
    return {
      decision: 'deny',
      risk: 'secret',
      reason: 'Direct secret value retrieval patterns are blocked.',
    };
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

export function assertAllowed(result) {
  if (result.decision === 'deny') {
    const error = new Error(result.reason);
    error.policy = result;
    throw error;
  }
  return result;
}
