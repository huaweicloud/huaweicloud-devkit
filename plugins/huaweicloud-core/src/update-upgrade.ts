// The upgrade act: elects the target tag (latest/next), spawns
// `npx huaweicloud-devkit@<tag> update --target <target>`, and shapes the
// restart/manual-command guidance. Part of the src/update-* family behind the
// src/update-check.ts re-export face.
import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from 'node:child_process';

import { SUPPORTED_AGENT_TARGETS } from './auth/agent-registration.ts';
import { isCredentialEnvVarName } from './lib/secret-vault/refs.ts';
import { determineTarget, semverCompare, type DistTags } from './update-semver.ts';
import { readInstalledVersion } from './update-installed.ts';
import { queryDistTags, errorMessage, resolveRegistryOverride, resolveEnvSpelling } from './update-registry.ts';
import { invalidateUpdateCache } from './update-cache.ts';

const NPX_BIN = process.platform === 'win32' ? 'npx.cmd' : 'npx';

// The upgrade child is arbitrary registry code and the published package needs
// no account, so it gets an environment without the credential family the
// vault predicate owns (case-normalized, so a Windows spelling cannot survive),
// plus dev 4890d78c's AWS keys and KooCLI's `HUAWEI_*` alias spellings, which the
// predicate does not claim.
const UPGRADE_EXTRA_CREDENTIAL_ENV_KEYS = new Set([
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'HUAWEI_ACCESS_KEY',
  'HUAWEI_SECRET_KEY',
  'GITHUB_ENTERPRISE_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'DOCKER_PASSWORD',
  'DOCKER_AUTH_CONFIG',
  'GITLAB_TOKEN',
  'GITLAB_CI_JOB_TOKEN',
  'BITBUCKET_TOKEN',
  'AZURE_DEVOPS_EXT_PAT',
  'NPM_AUTH_TOKEN',
  'YARN_NPM_AUTH_TOKEN',
  'NUGET_API_KEY',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'VAULT_TOKEN',
  'TERRAFORM_CLOUD_TOKEN',
  'HEROKU_API_KEY',
  'SLACK_TOKEN',
  'PYPI_TOKEN',
  'TWINE_PASSWORD',
  'HUAWEI_DOMAIN_TOKEN',
  'HUAWEI_SECURITY_TOKEN',
]);

// The predicate's prefixes also cover the devkit's own configuration. These
// names are read by the child's update graph (registry, proxy, state root,
// binary resolution, install skips), so they pass through unchanged.
const UPGRADE_PRESERVE_ENV_KEYS = new Set([
  'HCLOUD_BIN',
  'HCLOUD_BIN_ARGS_JSON',
  'HCLOUD_CONFIG_PATH',
  'HCLOUD_META_DIR',
  'HCLOUD_OBS_CONFIG_PATH',
  'HUAWEICLOUD_DEVKIT_DEBUG',
  'HUAWEICLOUD_DEVKIT_HOME',
  'HUAWEICLOUD_DEVKIT_SKIP_DSH_PLUGIN_INSTALL',
  'HUAWEICLOUD_DEVKIT_SKIP_OFFICEACE_DETECT',
  'HUAWEICLOUD_DEVKIT_SKIP_UPDATE',
  'HUAWEICLOUD_DEVKIT_TELEMETRY',
  'HUAWEICLOUD_DEVKIT_TELEMETRY_ENDPOINT',
  'HUAWEICLOUD_HOME',
  'HUAWEICLOUD_ICONS_OFFLINE',
  'HUAWEICLOUD_INJECT_STS_CMD',
  'HUAWEICLOUD_MCP_POLICY_FILE',
  'HUAWEICLOUD_NPM_REGISTRY',
  'HUAWEICLOUD_OPENCODE_PERMISSION_SEAM',
  'HUAWEICLOUD_REGION',
  'HUAWEICLOUD_VENDOR_CHALLENGE',
  'HW_IAM_ENDPOINT',
  'HW_POOL_TEMPLATE_EPHEMERAL',
  'HW_POOL_TEMPLATE_PERSISTENT',
  'HW_REGION',
  'HW_SANDBOX_POOL_CACHE_PATH',
  'HW_STS_EXPIRES_AT',
  'HW_WORKSPACE_ID',
]);

function upgradeEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = {};
  const registrySpellings: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    // The vault predicate trims its spelling; the strip and preserve lists must
    // agree, so a padded vendor key strips and a padded preserve key survives.
    const upper = key.trim().toUpperCase();
    if (upper === 'HUAWEICLOUD_NPM_REGISTRY') continue;
    if (upper === 'NPM_CONFIG_REGISTRY') registrySpellings.push(key);
    // npm's own auth channels are resolved after the loop through the shared
    // spelling rule, matching the pre-flight query's bearer exactly.
    if (upper === 'NPM_TOKEN' || upper === 'NODE_AUTH_TOKEN') continue;
    if (UPGRADE_PRESERVE_ENV_KEYS.has(upper)) {
      // A padded spelling cannot reach the child's exact-name lookup: forward
      // the trimmed name, letting an existing exact spelling win.
      const canonical = key.trim();
      if (key === canonical || next[canonical] === undefined) next[canonical] = value;
      continue;
    }
    if (isCredentialEnvVarName(key) || UPGRADE_EXTRA_CREDENTIAL_ENV_KEYS.has(upper)) continue;
    next[key] = value;
  }
  // One canonical channel through the shared resolver, so the child's own
  // devkit lookup, npm's pin, and the pre-flight query cannot disagree; empty
  // and whitespace count as unset everywhere, and an unset override never pins.
  const authKeys = ['NPM_TOKEN', 'NODE_AUTH_TOKEN'] as const;
  for (const name of authKeys) {
    const token = resolveEnvSpelling(env, name);
    if (token) next[name] = token;
  }
  const registry = resolveRegistryOverride(env);
  if (registry) {
    next.HUAWEICLOUD_NPM_REGISTRY = registry;
    for (const key of registrySpellings) delete next[key];
    next.npm_config_registry = registry;
  }
  return next;
}

interface SpawnResultLike {
  status?: number | null;
  signal?: string | null;
  stdout?: string;
  stderr?: string;
  error?: { message?: string } | null;
}

type UpgradeSpawnFn = (
  _command: string,
  _args: readonly string[],
  _options: SpawnSyncOptionsWithStringEncoding,
) => SpawnResultLike;

function defaultSpawn(
  command: string,
  args: readonly string[],
  options: SpawnSyncOptionsWithStringEncoding,
): SpawnResultLike {
  // The args join into the command string before the spawn: options carries
  // shell:true (the #643 npm.cmd routing; the target interpolation stays
  // guarded by the SUPPORTED_AGENT_TARGETS allowlist, review #717), and an
  // args array under shell is DEP0190 on Node 24. shell:true already
  // concatenates args unescaped, so the join is behavior-identical minus
  // the warning; the seam's (command, args) contract is unchanged for the
  // injected test doubles.
  return spawnSync([command, ...args].join(' '), options);
}

// npm reports failures as `npm error ...` lines (npm 7+) or `npm ERR! ...`
// (legacy), with ANSI color, pty spinners, warnings, notices, and log pointers
// around them. The tail is boilerplate, so the reason keeps the identifying
// code line plus the human diagnostic when the npm block wins; a strong
// code-less line wins alone, and a weak one inherits the code line (#1117).
const ESCAPE = String.fromCharCode(27);
const ANSI_ESCAPE = new RegExp(`${ESCAPE}\\[[0-9;?]*[A-Za-z]`, 'g');
const SINGLE_FRAME_BEFORE_ESCAPE = new RegExp(`^[|\\\\/-](?=${ESCAPE})`);
const LOG_POINTER_SUFFIX =
  /\s*(?:npm error\s+)?(?:A complete log of this run can be found in:|For a full report see:|(?:完整的运行日志|本次运行的完整日志)可在以下位置(?:找到|查看)[:：]|Please include the following file with any support request:).*$/;
const DIAGNOSTIC_HINT =
  /\b[A-Za-z]*Error\b|\b(?:failed|failure|fatal|unknown|unsupported|stopped|cannot|unable)\b|permission denied|错误|失败|不支持|未知/i;
// Error-name starts: Error, TypeError, RangeError, ReferenceError, SyntaxError,
// and the bracketed dump header `[TypeError: ...] {`.
const ERROR_NAME = /^(?:\[?[A-Za-z]*Error\b|fatal\b|FATAL\b)/;
// Errno names are a closed vocabulary (POSIX plus npm's own codes), so
// membership is the shape test real errno tokens have. An English progress
// word cannot masquerade no matter how the vocabulary of prose grows
// (EVICTED, ENQUEUED, EVALUATING, ERRORS, and every future sibling).
const ERRNO_SHAPE = /^E[A-Z0-9][A-Z0-9_]+$/;
const ERRNO_CODES = new Set([
  'E2BIG',
  'EACCES',
  'EADDRINUSE',
  'EADDRNOTAVAIL',
  'EAFNOSUPPORT',
  'EAGAIN',
  'EALREADY',
  'EBADF',
  'EBADMSG',
  'EBUSY',
  'ECANCELED',
  'ECHILD',
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EDEADLK',
  'EDESTADDRREQ',
  'EDOM',
  'EDQUOT',
  'EEXIST',
  'EFAULT',
  'EFBIG',
  'EHOSTDOWN',
  'EHOSTUNREACH',
  'EIDRM',
  'EILSEQ',
  'EINPROGRESS',
  'EINTR',
  'EINVAL',
  'EIO',
  'EISCONN',
  'EISDIR',
  'ELOOP',
  'EMFILE',
  'EMLINK',
  'EMSGSIZE',
  'EMULTIHOP',
  'ENAMETOOLONG',
  'ENETDOWN',
  'ENETRESET',
  'ENETUNREACH',
  'ENFILE',
  'ENOBUFS',
  'ENODATA',
  'ENODEV',
  'ENOENT',
  'ENOEXEC',
  'ENOLCK',
  'ENOLINK',
  'ENOMEM',
  'ENOMSG',
  'ENOPROTOOPT',
  'ENOSPC',
  'ENOSR',
  'ENOSTR',
  'ENOSYS',
  'ENOTCONN',
  'ENOTDIR',
  'ENOTEMPTY',
  'ENOTRECOVERABLE',
  'ENOTSOCK',
  'ENOTSUP',
  'ENOTTY',
  'ENXIO',
  'EOPNOTSUPP',
  'EOVERFLOW',
  'EOWNERDEAD',
  'EPERM',
  'EPIPE',
  'EPROTO',
  'EPROTONOSUPPORT',
  'EPROTOTYPE',
  'ERANGE',
  'EROFS',
  'ESPIPE',
  'ESRCH',
  'ESTALE',
  'ETIME',
  'ETIMEDOUT',
  'ETXTBSY',
  'EWOULDBLOCK',
  'EXDEV',
  'EAI_AGAIN',
  'EUSAGE',
  'ENOGIT',
  'EMISSINGROOT',
  'ELOCKVERIFY',
  'EINTEGRITY',
  'EINVALIDPACKAGENAME',
  'ECOMPROMISED',
  'EAI_SYSTEM',
  'EAI_SOCKTYPE',
  'EAI_SERVICE',
  'EAI_OVERFLOW',
  'EAI_NONAME',
  'EAI_MEMORY',
  'EAI_FAIL',
  'EAI_NODATA',
  'E404',
  'E401',
  'E403',
  'E426',
  'E429',
  'E500',
  'EBADENGINE',
  'EBADPLATFORM',
  'EJSONPARSE',
  'ELIFECYCLE',
  'EMAXREDIRECT',
  'EMAXREDIRECTS',
  'ENOAUDIT',
  'ENOLOCAL',
  'ENOLOCK',
  'ENOSELF',
  'ENOVERSIONS',
  'ENOTCACHED',
  'ENOTFOUND',
  'EOTP',
  'EREGISTRY',
  'ERESOLVE',
  'ETARGET',
  'EUNKNOWNCOMMAND',
  'EUNSUPPORTEDPROTOCOL',
]);

function isErrnoToken(token: string | undefined): boolean {
  return Boolean(token && ERRNO_SHAPE.test(token) && ERRNO_CODES.has(token));
}

function stripLogPointerSuffix(line: string): string {
  return line.replace(LOG_POINTER_SUFFIX, '').trim();
}

function shiftNpmErrorToken(line: string): string {
  const errorAt = line.search(/npm error\b/);
  if (errorAt === 0) return line;
  if (errorAt > 0 && /^[^\x21-\x7e]*$/.test(line.slice(0, errorAt))) return line.slice(errorAt);
  // npm 9 under a pty glues progress text before the legacy token; nothing
  // printable there is a diagnostic of its own, so the token still moves.
  const legacyAt = line.search(/npm ERR!/);
  return legacyAt > 0 ? line.slice(legacyAt) : line;
}

function normalizeNpmLine(line: string): string {
  const withoutSpinner = line
    .trim()
    .replace(SINGLE_FRAME_BEFORE_ESCAPE, '')
    .replace(ANSI_ESCAPE, '')
    .replace(/^[\u2800-\u28ff\s]+/, '')
    .replace(/^[|\\/-]{2,}/, '');
  const shifted = shiftNpmErrorToken(withoutSpinner);
  return stripLogPointerSuffix(shifted.replace(/^npm ERR!\s?/, 'npm error '));
}

function npmPayload(line: string): string {
  return line.replace(/^npm error\s*/, '');
}

function isNpmErrorLine(line: string): boolean {
  return /^npm error\b/.test(line);
}

// A pointer line carries nothing but the npm log path (optionally behind a
// label); a sentence that mentions the path keeps its content.
function isPointerOnlyLine(line: string): boolean {
  const payload = npmPayload(line)
    .trim()
    .replace(/^(?:[A-Za-z][\w .-]*|[\u4e00-\u9fa5][\u4e00-\u9fa5\w .-]*)\s*[:：]\s*/, '');
  if (!/(?:-debug(?:-\d+)?\.log|-eresolve-report\.txt)$/.test(payload)) return false;
  if (/^(?:[A-Za-z]:[\\/]|~[\\/]|\.{0,2}[\\/])/.test(payload)) return true;
  // A bare relative log name ("npm-debug.log", "logs/npm-debug-0.log").
  return !/\s/.test(payload) && !payload.includes(':');
}

// V8 frames: `at`, optional async/new, a token (optionally aliased `[as x]`),
// then a location in parentheses, a `file:`/`node:`/`<anonymous>` target, a
// `wasm` frame, or a bare `:<line>:<col>` tail. A sentence that opens with
// "at least" or "at startup (retry 1)" carries prose, not a location.
function isStackFrame(payload: string): boolean {
  const match = /^\s*at\s+(?:async\s+|new\s+)?(.+)$/.exec(payload);
  if (!match) return false;
  const rest = match[1]!.trim();
  if (rest === '<anonymous>') return true;
  if (/^wasm[-:]/.test(rest) || /\bwasm-function\b/.test(rest)) return true;
  const call = /^\S+(?:\s+\[as [^\]]+\])?\s*\(([^)]*)\)\s*{?\s*$/.exec(rest);
  if (call) {
    const location = call[1]!.trim();
    return location === '<anonymous>' || /^index \d+$/.test(location) || /^\S+:\d+(?::\d+)?$/.test(location);
  }
  // Nested eval frames close more than one paren (eval at <anonymous> (...)),
  // so the flat paren match above cannot span them; a frame ends with a paren
  // and carries a location token.
  if (/\)\s*$/.test(rest) && /(?:file:|node:|\[eval\]|eval at |<anonymous>|:\d+(?::\d+)?)/.test(rest)) {
    return true;
  }
  return /^(?:file:|node:)\S*:\d+:\d+\b/.test(rest) || /^\S+:\d+:\d+\b/.test(rest);
}

function isNpmNoiseLine(line: string): boolean {
  if (/^Node\.js v\d/.test(line) || /^\s*\^\s*$/.test(line)) return true;
  if (/^Require stack:/.test(line) || /^\s*-\s+[/~]\S*$/.test(line)) return true;
  if (/^\s*throw err;\s*$/.test(line)) return true;
  if (!/[\p{L}\p{N}]/u.test(line)) return true;
  if (/^(?:npm warn\b|npm notice\b|\(node:\d+\))/i.test(line)) return true;
  // Node's non-deprecation warning footer: the `(node:…)` header is dropped
  // above, but its continuation lines are boilerplate too (the
  // MODULE_TYPELESS_PACKAGE_JSON / ExperimentalWarning family). Anchor on the
  // emission shapes, not the word "warning", which can ride a real diagnostic.
  if (/^\(Use `node --trace-warnings\b[^`]*` to show where the warning was created\)$/.test(line)) return true;
  if (/^Reparsing as ES module because module syntax was detected\b/.test(line)) return true;
  if (/^To eliminate this warning, add "type": "module" to\b/.test(line)) return true;
  // npm's log channels are not diagnostics: every `npm <channel>` prefix is
  // noise except the error channel and the `info run` echo of a script.
  if (
    /^npm\s+(?:notice|warn|info|verbose|verb(?:ose)?|http|silly|sill|timing)\b/i.test(line) &&
    !/^npm info run\b/i.test(line)
  ) {
    return true;
  }
  if (/DeprecationWarning|trace-deprecation/i.test(line)) return true;
  if (/^gyp info\b/i.test(line)) return true;
  if (/^added \d+ packages? in\b/i.test(line)) return true;
  const payload = npmPayload(line);
  return (
    /^A complete log of this run can be found in:/.test(payload) ||
    /^For a full report see:/.test(payload) ||
    /^Log files were not written due to an error writing to the directory:/.test(payload) ||
    /^You can rerun the command with `--loglevel=verbose`/.test(payload) ||
    isPointerOnlyLine(line) ||
    isStackFrame(payload)
  );
}

// Tiers: a strong failure marker, then failure words, then the plain position
// tier, and metadata last. The strongest tier takes its later line (a fatal
// line lands after a retry marker), the hint tier its earlier one (the real
// failure precedes cleanup chatter), and the position tier the later line in
// the codeless branch.
function isNpmScriptResult(line: string): boolean {
  return /\{\s*code:\s*(?:-?\d+|null)\s*,?\s*signal:/.test(line);
}

function isFailingScriptResult(line: string): boolean {
  const match = /\{\s*code:\s*(-?\d+|null)\s*,?\s*signal:\s*(null|'[^']*'|"[^"]*")/.exec(line);
  if (!match) return false;
  return !(match[1] === '0' && match[2] === 'null');
}

// npm's echo of a failing script: the block's `command <shell> -c <script>`
// line (sh, bash, or cmd.exe) and the npm-prefixed `info run` echo. A child
// line that merely starts with "command:" or a shell word is not an echo.
function isEchoLine(line: string, payload: string): boolean {
  if (isNpmScriptResult(line) || isNpmScriptResult(payload)) return false;
  if (/^npm info run\b/.test(line)) return true;
  // npm's block echo, whichever shell it named; `command failed` is metadata.
  if (/^npm error\s+command\s+/i.test(line) && !/^command failed$/i.test(payload)) return true;
  // A bare shell lead counts only when the -c payload is one command (quoted
  // or a single token), not a child sentence that merely starts with one.
  const commandEnd = /^(?:"[^"]*"|'[^']*'|\S+)\s*$/;
  const shell = /^(?:\S*\/)?(?:ba|z|k|da)?sh\s+-c\s+(.*)$/.exec(payload)?.[1];
  if (shell && commandEnd.test(shell)) return true;
  const cmd = /^cmd(?:\.exe)?\b[^]*?\/c\s+(.*)$/i.exec(payload)?.[1];
  if (cmd && commandEnd.test(cmd)) return true;
  return false;
}

function lineRank(line: string): number {
  const payload = npmPayload(line);
  // Dump punctuation demotes before any token scan: a `[cause]:` line carrying
  // an errno code is still dump metadata, not a diagnosis.
  if (/^\[cause\]:/.test(payload)) return 4;
  // The echo test runs before the strong-marker scans: an echo that quotes the
  // child's own errno token must not tie with the child's line.
  if (isEchoLine(line, payload)) return 3;
  if (ERROR_NAME.test(payload)) return 0;
  const token = /^([A-Z0-9_]+)(?=:|\s|$)/.exec(payload)?.[1];
  if (isErrnoToken(token)) return 0;
  for (const match of payload.matchAll(/(?<=:\s)(E[A-Z0-9][A-Z0-9_]+)\b/g)) {
    if (isErrnoToken(match[1])) return 0;
  }
  if (!payload || /^(?:errno|syscall|path|code|command failed)\b/.test(payload)) return 4;
  if (/^\s*[A-Za-z_]\w*:\s*(?:'[^']*'|"[^"]*"|-?\d+|\[[^\]]*\])\s*,?\s*$/.test(payload)) return 4;
  if (/^\s*[A-Za-z_]\w*:\s*\[[^\]]*\]\s*,?\s*$/.test(payload)) return 4;
  if (/^\s*requireStack:\s*\[.*$/.test(payload) || /^\s*'[^']*',?\s*$/.test(payload)) return 4;
  if (isNpmScriptResult(payload)) return 4;
  // npm's echo of the failing script carries the child's words in quotes, so it
  // must not tie with the child's own line; it is the honest fallback only when
  // the child printed nothing.
  if (DIAGNOSTIC_HINT.test(payload)) return 1;
  return 2;
}

type LineEntry = { line: string; index: number };

function lastFailingResult(entries: LineEntry[]): LineEntry | undefined {
  return entries.filter((entry) => isNpmScriptResult(entry.line) && isFailingScriptResult(entry.line)).at(-1);
}

function lastEchoBefore(entries: LineEntry[], index: number): LineEntry | undefined {
  return entries.filter((entry) => entry.index < index && lineRank(entry.line) === 3).at(-1);
}

function selectFailureLine(
  rawEntries: LineEntry[],
  { positionLast, echoAllowed = () => true }: { positionLast: boolean; echoAllowed?: (index: number) => boolean },
): { line: string; rank: number; index: number } | undefined {
  // A recovery announcement (in a block body or in the plain stderr) is never a
  // candidate; skipping it lets the next truthful tier of the same capture win.
  const entries = rawEntries.filter((entry) => !isRecoveryAnnouncement(entry.line));
  for (const rank of [0, 1, 2, 3, 4]) {
    const hits = entries.filter((entry) => lineRank(entry.line) === rank);
    if (!hits.length) continue;
    if (rank === 3) {
      // The echo tier names the failing script: the last echo that carries the
      // failing result's own package/script identity wins, so a nesting script's
      // nearer echo cannot stand in; an echo that belongs to a recovered window
      // never qualifies; else the last allowed echo.
      const allowed = hits.filter((entry) => echoAllowed(entry.index));
      if (!allowed.length) continue;
      const failing = lastFailingResult(entries);
      const identity = failing ? npmRunIdentity(failing.line) : undefined;
      const identityPaired = identity
        ? allowed
            .filter(
              (entry) =>
                entry.index < failing!.index && lineRank(entry.line) === 3 && npmRunIdentity(entry.line) === identity,
            )
            .at(-1)
        : undefined;
      const paired =
        identityPaired ?? (failing ? allowed.filter((entry) => entry.index < failing.index).at(-1) : undefined);
      const chosen = paired ?? allowed.at(-1)!;
      return { line: chosen.line, rank, index: chosen.index };
    }
    const later = rank === 0 || (rank === 2 && positionLast);
    const chosen = later ? hits.at(-1)! : hits[0]!;
    return { line: chosen.line, rank, index: chosen.index };
  }
  return undefined;
}

// Error blocks are npm's `code` lines plus the metadata and diagnostic lines
// that follow each one, bounded by the next code line. An `npm error` block and
// its code line are one unit: an errno-code block that a later block supersedes
// is a nested or recovered step, not the failure.
type ErrorBlock = { code: LineEntry; entries: LineEntry[] };

function errorBlocks(
  codeEntries: LineEntry[],
  otherEntries: LineEntry[],
  codelessEntries: LineEntry[] = [],
): ErrorBlock[] {
  return codeEntries.map((code, position) => {
    const next = codeEntries[position + 1]?.index ?? Number.POSITIVE_INFINITY;
    // A lifecycle line (an info-run echo or a result) starts the next step:
    // the block body (npm's error metadata) cannot own a later step's echo.
    const bare =
      codelessEntries.find(
        (entry) =>
          entry.index > code.index &&
          entry.index < next &&
          (/^npm info run\b/.test(entry.line) || isNpmScriptResult(entry.line)),
      )?.index ?? next;
    const boundary = Math.min(next, bare);
    return {
      code,
      entries: otherEntries.filter((entry) => entry.index > code.index && entry.index < boundary),
    };
  });
}

function pickInBlock(block: ErrorBlock): { line: string; rank: number; index: number } | undefined {
  const entries = block.entries.filter((entry) => !isRecoveryAnnouncement(entry.line));
  for (const rank of [0, 1, 2, 3, 4]) {
    const hits = entries.filter((entry) => lineRank(entry.line) === rank);
    if (!hits.length) continue;
    // The in-block pick mirrors the selector it overrides: the strongest tier
    // takes its later line (a fatal line follows a retry marker).
    const hit = rank === 0 ? hits.at(-1)! : hits[0]!;
    return { line: hit.line, rank, index: hit.index };
  }
  return undefined;
}

function npmRunIdentity(line: string): string | undefined {
  return /^npm info run (\S+ \S+)\b/.exec(npmPayload(line))?.[1];
}

// A line that *announces* a recovery is evidence the step succeeded, not a
// dying word. A token at the sentence end is the canonical announcement
// ("... failed once, recovered"); the sentence's final clause wins over an
// earlier failure mention ("first attempt failed, recovered, fine"), while a
// governing verb/negation ("failed to recover", "could not yet recover")
// keeps the line a diagnostic.
const RECOVER_TOKEN = /\brecover(?:ed|ing|s|y|ies)?\b/i;
const RECOVER_CONTINUATION =
  /^\s*(?:[.!?]?\s*$|,\s*(?:continuing\b|anyway\b|complete\b|succeeded\b|ok\b|fine\b).*|\s+(?:complete|completely|fully|succeeded|ok|fine)\b.*)$/i;
// The governing verb/negation before the token turns a sentence into a failure
// statement ("failed to recover", "not yet recovered", "no recovery"), even
// when the recover token is the sentence's last word. Adverbs may sit before or
// after `to` ("failed to fully recover", "unable to completely recover").
const RECOVER_GOVERNING =
  /(?:failed|failure|refused|rejected|unable|could not|cannot|can't|not|never|no)\s+(?:(?:yet|still|even|ever|really|quite|fully|actually|entirely|completely|eventually)\s+)*(?:to\s+(?:(?:yet|still|even|ever|really|quite|fully|actually|entirely|completely|eventually)\s+)*)?$/i;
// A recovered step's continuation notices ("falling back to the bundled
// toolchain", "retrying from snapshot", "using cached copy of previous build",
// "best-effort rebuild only", "degraded mode active"): "falling back" and
// "retrying" are announcements only in their full forms, so a failing step's
// bare dying words surface, while the cached/best-effort/degraded idiom tokens
// mark an announcement wherever they appear. A dying line that merely contains
// one of those fallback tokens is therefore treated as a recovered-step notice
// (a ledgered trade).
const CONTINUATION_ANNOUNCEMENT = /\b(?:falling back to|retrying from|using cached|best-effort|degraded)\b/i;
function isRecoveryAnnouncement(line: string): boolean {
  const payload = npmPayload(line);
  // A command/echo line names a script, not prose: "sh -c node recover" is not
  // a recovery announcement.
  if (
    /^command\b/i.test(payload) ||
    /^(?:\S*\/)?(?:ba|z|k|da)?sh\s+-c\b/i.test(payload) ||
    /^cmd(?:\.exe)?\s/i.test(payload)
  ) {
    return false;
  }
  const match = RECOVER_TOKEN.exec(payload);
  if (match) {
    const prefix = payload.slice(0, match.index);
    const suffix = payload.slice(match.index + match[0].length);
    // Governing negation/verb first: the sentence-final shortcut must not eat it.
    if (RECOVER_GOVERNING.test(prefix)) return false;
    // The recovery is the sentence's final clause: a failure mention earlier in
    // the sentence ("first attempt failed, recovered, fine") does not veto it.
    return RECOVER_CONTINUATION.test(suffix);
  }
  const continuation = CONTINUATION_ANNOUNCEMENT.exec(payload);
  if (!continuation) return false;
  return !RECOVER_GOVERNING.test(payload.slice(0, continuation.index));
}

function isCauseLine(line: string): boolean {
  const payload = npmPayload(line);
  if (!/^\[cause\]:/.test(payload)) return false;
  const rest = payload.replace(/^\[cause\]:\s*/, '');
  if (ERROR_NAME.test(rest)) return true;
  const token = /^([A-Z0-9_]+)(?=:|\s|$)/.exec(rest)?.[1];
  return isErrnoToken(token);
}

function extractNpmFailureReason(execResult: SpawnResultLike): string {
  // Keep the untrimmed source beside the normalized lines: the blank-line and
  // stack-frame shapes the warning scan needs survive only in the raw text.
  const sourceLines = String(execResult.stderr || '').split(/\r?\n/);
  const rawLines = sourceLines.map((line) => normalizeNpmLine(line));
  // A Node crash preamble carries three lines the per-line rules cannot judge:
  // the `file:line` header, the source snippet, and the caret under it.
  const crashPreamble = new Set<number>();
  rawLines.forEach((line, index) => {
    const header = /^\S+:\d+$/.test(line);
    const snippet = Boolean(rawLines[index + 1] && /[;=()]/.test(rawLines[index + 1]!));
    const caret = /^\s*\^+\s*$/.test(rawLines[index + 2] ?? '');
    if (header && snippet && caret) {
      crashPreamble
        .add(index)
        .add(index + 1)
        .add(index + 2);
    }
  });
  // Node's warning continuation lines are boilerplate whatever their wording.
  // The region ends at the FIRST structural closer met scanning forward from
  // the header — a traced stack-frame run (its last frame), an `npm error`
  // block start (the last line before it is kept as the child's possible
  // diagnostic), a blank line, the `(Use …)` footer, or a crash/diagnostic
  // header (the lines before it are excluded, the header itself is kept). A
  // later closer never re-extends a region an earlier one already closed: the
  // outer loop re-scans from every warning header, which covers adjacent
  // warnings without a separate header clause.
  const WARNING_FOOTER =
    /^\(Use `node --trace-(?:warnings|deprecation)\b[^`]*` to show where the warning was created\)$/;
  const WARNING_HEADER = /^\(node:\d+\)/;
  const frameLine = (raw: string) => /^\s+at\s/.test(raw);
  const crashHeader = (line: string) => /^\S+:\d+$/.test(line);
  const diagnosticHeader = (line: string) => /^(?:\[?[A-Za-z]*Error\b|[Ff][Aa][Tt][Aa][Ll]\b|Uncaught\b)/.test(line);
  const warningContinuation = new Set<number>();
  for (let index = 0; index < rawLines.length; index += 1) {
    if (!WARNING_HEADER.test(rawLines[index]!)) continue;
    let end = -1;
    let frameSeen = false;
    for (let cursor = index + 1; cursor < rawLines.length; cursor += 1) {
      const raw = sourceLines[cursor] ?? '';
      const line = rawLines[cursor]!;
      if (frameLine(raw)) {
        frameSeen = true;
        end = cursor;
        continue;
      }
      if (frameSeen) break;
      if (!raw.trim()) {
        end = cursor - 1;
        break;
      }
      if (isNpmErrorLine(line)) {
        end = cursor - 2;
        break;
      }
      if (WARNING_FOOTER.test(line)) {
        end = cursor;
        break;
      }
      if (crashHeader(line) || diagnosticHeader(line)) {
        end = cursor - 1;
        break;
      }
    }
    for (let cursor = index + 1; cursor <= end; cursor += 1) warningContinuation.add(cursor);
  }
  // Every entry keeps its raw position: the code candidate, the block and the
  // echo are compared against the success window in one index space, so a
  // duplicate text line can never be re-resolved to its first occurrence.
  const entries: LineEntry[] = rawLines
    .map((line, index) => ({ line, index }))
    .filter(
      (entry) =>
        Boolean(entry.line) &&
        !crashPreamble.has(entry.index) &&
        !warningContinuation.has(entry.index) &&
        !isNpmNoiseLine(entry.line),
    );
  const codeEntries = entries.filter((entry) => isNpmErrorLine(entry.line) && /^code \S+/.test(npmPayload(entry.line)));
  const otherEntries = entries.filter(
    (entry) => isNpmErrorLine(entry.line) && !codeEntries.some((code) => code.index === entry.index),
  );
  const codelessEntries = entries.filter((entry) => !isNpmErrorLine(entry.line));
  const codeFor = (target: { index: number } | undefined) =>
    (target ? codeEntries.filter((entry) => entry.index <= target.index).at(-1) : undefined)?.line ??
    codeEntries.at(-1)?.line;

  const isSuccessAssertion = (line: string) =>
    /^gyp info ok\b/i.test(line) ||
    /^prebuilt binary installed\b/i.test(line) ||
    (isNpmScriptResult(line) && !isFailingScriptResult(line));
  const lastSuccessIndex = (before: number): number => {
    let found = -1;
    rawLines.forEach((line, index) => {
      if (index < before && isSuccessAssertion(line)) found = index;
    });
    return found;
  };

  // The gate is a failing pair: a failure result line with its own echo. A
  // successful script's echo pair, or a lone echo, proves nothing about the
  // failing step.
  const failing = lastFailingResult(codelessEntries);
  // npm's echo of the failing script may be a bare shell line or the block's own
  // `npm error command` line; the pair is the result line plus the echo that
  // names the same package and lifecycle script. A nesting script's nearer echo
  // must not stand in for the failing step, and a result line whose echo landed
  // after it (a dying step that printed `gyp info ok` then its result) is not a
  // pair.
  const failingIdentity = failing ? npmRunIdentity(failing.line) : undefined;
  // A code-0 result owns the lines between its echo and its result, whether or
  // not it shares the failing step's identity: a recovered run of the same
  // package is a different step. Each result claims its nearest preceding echo
  // of the same identity that no earlier result claimed, so interleaved
  // same-identity siblings get one window each instead of both anchoring at the
  // later echo.
  // Under concurrency a later successful run of the same package must not claim
  // the echo the failing pair needs: the pair's anchoring wins.
  const reservedPairEchoes = new Set<number>();
  if (failing && failingIdentity) {
    const identityEchoes = entries.filter(
      (entry) =>
        entry.index < failing.index && lineRank(entry.line) === 3 && npmRunIdentity(entry.line) === failingIdentity,
    );
    // The pair's own echo is the one followed by its failure-shaped rank-0
    // dying words (a FATAL/Error header). An errno diagnostic follower (for
    // example "EACCES: permission denied, using user cache instead") can be a
    // successful sibling's recovered evidence, so it never reserves an echo;
    // under concurrency the other same-identity echo belongs to the sibling's
    // run.
    const strongWordEcho = identityEchoes
      .filter((echo) => {
        const next = codelessEntries.find((entry) => entry.index > echo.index && entry.index < failing.index);
        return Boolean(
          next &&
          lineRank(next.line) === 0 &&
          ERROR_NAME.test(npmPayload(next.line)) &&
          !isNpmScriptResult(next.line) &&
          !isRecoveryAnnouncement(next.line),
        );
      })
      .at(-1);
    // A lone echo cannot be split between two runs; reserving it would leave
    // the pair with nothing, so the sequential claim handles that shape.
    if (strongWordEcho && identityEchoes.length >= 2) reservedPairEchoes.add(strongWordEcho.index);
  }
  const recoveredWindows: Array<{ start: number; end: number }> = [];
  const claimedEchoes = new Set<number>();
  for (const result of codelessEntries) {
    if (!isNpmScriptResult(result.line) || isFailingScriptResult(result.line)) continue;
    const identity = npmRunIdentity(result.line);
    if (!identity) continue;
    const echo = entries
      .filter(
        (entry) =>
          entry.index < result.index &&
          lineRank(entry.line) === 3 &&
          npmRunIdentity(entry.line) === identity &&
          !claimedEchoes.has(entry.index) &&
          !reservedPairEchoes.has(entry.index),
      )
      .at(-1);
    if (echo) {
      claimedEchoes.add(echo.index);
      recoveredWindows.push({ start: echo.index, end: result.index });
    }
    // A result with no claimable echo is unattributable: it registers no window.
  }
  const startsRecoveredWindow = (index: number) => recoveredWindows.some((window) => window.start === index);
  // The failing pair's echo is the step's own: the nearest identity echo that
  // does not belong to a recovered window; a fallback echo that does belong to
  // one leaves the pair unattributable.
  const ownEcho = failing
    ? entries
        .filter(
          (entry) =>
            entry.index < failing.index &&
            lineRank(entry.line) === 3 &&
            npmRunIdentity(entry.line) === failingIdentity &&
            !startsRecoveredWindow(entry.index),
        )
        .at(-1)
    : undefined;
  const fallbackEcho = failing ? lastEchoBefore(entries, failing.index) : undefined;
  const failingPairEcho =
    ownEcho ?? (fallbackEcho && !startsRecoveredWindow(fallbackEcho.index) ? fallbackEcho : undefined);
  const hasFailingPair = Boolean(failing && failingPairEcho);
  // A nested window whose own echo starts after the failing pair's echo belongs
  // to a nested step and is excluded even when it sits inside the pair's span;
  // only the failing step's own words between its echo and result are in-pair
  // survivors. Boundaries are inclusive: a window's own echo is not a reason.
  const insideFailingPair = (index: number) =>
    Boolean(failing && failingPairEcho && index > failingPairEcho.index && index < failing.index);
  // A candidate line is excluded when it is a recovery notice or sits in a
  // nested window (one opening after the failing echo). A window opening before
  // the failing echo can interleave with the failing step, so it blocks only its
  // recovery notices; with no failing pair every window blocks its whole span.
  const inNestedWindow = (index: number) =>
    recoveredWindows.some(
      (window) => index >= window.start && index <= window.end && window.start > (failingPairEcho?.index ?? -1),
    );
  const lineExcluded = (index: number) => {
    const line = entries.find((entry) => entry.index === index)?.line ?? '';
    // With no failing pair every window start is past the sentinel, so
    // inNestedWindow already covers the whole span.
    return isRecoveryAnnouncement(line) || inNestedWindow(index);
  };
  // A success assertion is recovery evidence only when it precedes the last
  // failing pair: the failing step's own `gyp info ok`, printed after its dying
  // words and before its own result line, is not a recovery.
  const recoverySuccess = failingPairEcho ? lastSuccessIndex(failingPairEcho.index) : -1;

  const echoAllowed = (index: number) => !startsRecoveredWindow(index);
  let block = selectFailureLine(otherEntries, { positionLast: false, echoAllowed });
  let bare = selectFailureLine(codelessEntries, { positionLast: true, echoAllowed });
  let codeLine = codeFor(block);
  let recoveredSwap = false;
  let bodylessTwin = false;
  const blocks = codeEntries.length ? errorBlocks(codeEntries, otherEntries, codelessEntries) : [];
  const blockBodyEnd = (target: ErrorBlock) =>
    target.entries.reduce((max, entry) => Math.max(max, entry.index), target.code.index);
  const firstBlockCode = blocks[0]?.code.index ?? -1;
  const lastBlockBodyEnd = blocks.length ? blockBodyEnd(blocks.at(-1)!) : -1;
  const inBlockRange = (index: number) =>
    blocks.some((target) => index >= target.code.index && index <= blockBodyEnd(target));

  // At npm's default loglevel lifecycle result lines do not exist, so a nested
  // step's recovered block is the only visible error text while the failing
  // step said nothing. With no failing pair, the last error block is the only
  // attributable one; a sole nested block whose errno code cannot be tied to
  // the exit falls to the honest exit status, and a child line outside it is
  // the child's dying words.
  if (!hasFailingPair && codeEntries.length) {
    const lastBlock = blocks.at(-1)!;
    // A duplicate `code N` line with no body of its own (a harness prepend) is
    // one logical block; two populated blocks are distinct steps even when
    // their code text matches, so both shapes keep the last-block rule.
    const previous = blocks.at(-2);
    const distinctLastCode =
      Boolean(previous) &&
      npmPayload(previous!.code.line).replace(/^code\s+/, '') !==
        npmPayload(lastBlock.code.line).replace(/^code\s+/, '');
    // A harness-prepended `code N` line has no block body of its own: it is the
    // same logical block as the one that follows the child diagnostic. A real
    // nested block always carries its own path/echo lines, so shared code text
    // between two populated blocks must not disable the last-block rule.
    const previousHasBody = Boolean(previous && previous.entries.length);
    const overrides = blocks.length > 1 && (distinctLastCode || previousHasBody);
    const picked = pickInBlock(lastBlock);
    const lastHasEcho = lastBlock.entries.some((entry) => lineRank(entry.line) === 3);
    const codeToken = npmPayload(lastBlock.code.line).replace(/^code\s+/, '');
    const numericLast = /^-?\d+$/.test(codeToken);
    const codeTiesExit =
      numericLast && typeof execResult.status === 'number' && Number(codeToken) === execResult.status;
    // Two populated blocks are a recovered step plus npm's summary of the
    // failing one; a shared code text is the round-25 shape. From three blocks
    // on, a numeric block whose code does not tie to the exit is another nested
    // step even when it carries npm's inner script echo.
    const attributableNumeric =
      numericLast && (codeTiesExit || blocks.length <= 2 || typeof execResult.status !== 'number');
    const unattributableNested = numericLast
      ? typeof execResult.status === 'number' && execResult.status > 1 && !attributableNumeric
      : !lastHasEcho && typeof execResult.status === 'number' && execResult.status > 1;
    const blockEnd = blockBodyEnd(lastBlock);
    if (overrides) {
      // A body-less trailing duplicate of a tying populated block is npm's
      // summary of the same step: the populated twin's line and echo ride.
      const tiedBodyless = !picked && Boolean(previous?.entries.length) && !distinctLastCode;
      bodylessTwin = tiedBodyless;
      const owner = tiedBodyless ? previous! : lastBlock;
      block = (tiedBodyless ? pickInBlock(previous!) : picked) ?? {
        line: lastBlock.code.line,
        rank: 4,
        index: lastBlock.code.index,
      };
      codeLine = owner.code.line;
      // The child's earlier chatter belongs to a recovered step; the last
      // block's own echo names the failing script.
      if (bare && bare.index < lastBlock.code.index) bare = undefined;
    }
    // An errno-coded block with no echo is a nested/recovered block, not this
    // exit's failure at an exit above 1: plural nested blocks and the
    // metadata-only lone block are the same shape. A child line after the block
    // is the dying words; otherwise the exit status is honest. A top-level errno
    // failure exits 1 and keeps its code line, as do the numeric blocks above.
    if (unattributableNested) {
      const dying = codelessEntries
        .filter((entry) => entry.index > blockEnd && lineRank(entry.line) <= 2)
        .filter(
          (entry) =>
            !isRecoveryAnnouncement(entry.line) &&
            !rawLines.some((line, index) => index > entry.index && isSuccessAssertion(line)),
        )
        .at(-1);
      if (dying) return dying.line;
      block = undefined;
      codeLine = undefined;
    }
  }

  // A block that trails the last failing result is npm's own summary of that
  // step, and it owns the failure even when an earlier, recovered block carries
  // a higher-ranked diagnostic (the verbose/default asymmetry). Its code line
  // is the failing step's, so no recovered block's code can be the reason.
  let trailingSwap = false;
  if (hasFailingPair) {
    const tiesExit = (candidate: ErrorBlock) => {
      const token = npmPayload(candidate.code.line).replace(/^code\s+/, '');
      return /^-?\d+$/.test(token) && typeof execResult.status === 'number' && Number(token) === execResult.status;
    };
    const trailing = blocks.filter((candidate) => candidate.code.index > failing!.index).at(-1);
    const firstFailing = codelessEntries.find(
      (entry) => isNpmScriptResult(entry.line) && isFailingScriptResult(entry.line),
    );
    const tyingTrailing =
      firstFailing && !(trailing && tiesExit(trailing))
        ? blocks.filter((candidate) => candidate.code.index > firstFailing.index && tiesExit(candidate)).at(-1)
        : undefined;
    const chosen = trailing && tiesExit(trailing) ? trailing : (tyingTrailing ?? trailing);
    const chosenIndex = chosen ? blocks.indexOf(chosen) : -1;
    const previousBlock = chosenIndex > 0 ? blocks[chosenIndex - 1] : undefined;
    const tiedBodyless =
      chosen &&
      !chosen.entries.length &&
      Boolean(previousBlock?.entries.length) &&
      npmPayload(previousBlock!.code.line).replace(/^code\s+/, '') ===
        npmPayload(chosen.code.line).replace(/^code\s+/, '');
    const owner = tiedBodyless ? previousBlock! : chosen;
    if (owner) {
      block = pickInBlock(owner) ?? { line: owner.code.line, rank: 4, index: owner.code.index };
      codeLine = owner.code.line;
      // The child's earlier chatter belongs to the step that recovered.
      if (bare && bare.index < owner.code.index) bare = undefined;
      trailingSwap = true;
      recoveredSwap = true;
    }
  }
  // A loud successful script (or a gyp error it survived) is not the cause when
  // npm emitted a failing echo pair later: the echo names the failing script.
  if (bare && failing && failingPairEcho && recoverySuccess > -1 && bare.index < recoverySuccess) {
    bare = { line: failingPairEcho.line, rank: 3, index: failingPairEcho.index };
  }
  // The failing step's own dying words sit between its echo and its result;
  // earlier chatter belongs to a step that recovered (or another step). This is
  // the in-pair window: a code-0 success between the echo and the result does
  // not restore the earlier line.
  let promotedInPair = false;
  if (failing && failingPairEcho) {
    const inside = codelessEntries
      .filter((entry) => entry.index > failingPairEcho.index && entry.index < failing.index)
      .filter((entry) => lineRank(entry.line) <= 2)
      .filter((entry) => !lineExcluded(entry.index))
      .at(-1);
    if (inside) {
      bare = { line: inside.line, rank: lineRank(inside.line), index: inside.index };
      promotedInPair = true;
    } else if (!bare || !insideFailingPair(bare.index)) {
      bare = { line: failingPairEcho.line, rank: 3, index: failingPairEcho.index };
    }
  }
  // Lines belonging to a step whose own result says it recovered are not this
  // failure's words: the failing pair's echo is the honest fallback, and with no
  // attributable pair echo the floor is the exit status. The in-pair promotion
  // already filtered its own candidates.
  if (bare && lineExcluded(bare.index)) {
    bare = failingPairEcho ? { line: failingPairEcho.line, rank: 3, index: failingPairEcho.index } : undefined;
  }
  // The outer shell names a signal death "Terminated" or "Killed"; when npm
  // emitted the failing echo pair, the named script is the better reason.
  if (bare?.rank === 2 && /^(?:Terminated|Killed)\b/i.test(bare.line) && hasFailingPair) {
    bare = { line: failingPairEcho!.line, rank: 3, index: failingPairEcho!.index };
  }
  // A spawn kill (timeout, buffer ceiling) or a plain nonzero status with no
  // failing pair and no error block leaves no line attributable to the failing
  // script: the spawn artifact or the exit status is the honest reason.
  const unattributableStatus =
    (typeof execResult.status === 'number' && execResult.status !== 0) ||
    (execResult.status === null && Boolean(execResult.signal || execResult.error));
  if (
    !block &&
    !codeLine &&
    !hasFailingPair &&
    bare &&
    !/^(?:Terminated|Killed)\b/i.test(bare.line) &&
    unattributableStatus
  ) {
    bare = undefined;
  }
  // A sole surviving diagnostic line is the child's dying words and is kept
  // after the floor, even when noise filtering discarded its companions (a
  // pointer, a stack frame, spinner residue). Only a failure-marked line
  // qualifies: plain progress chatter does not distinguish itself, and a
  // filtered success assertion (a code-0 result, gyp's info channel) means the
  // survivor belongs to a script that did not fail.
  const survivorEligible = (entry: LineEntry) =>
    !inBlockRange(entry.index) &&
    !lineExcluded(entry.index) &&
    !(
      hasFailingPair &&
      failing &&
      failingPairEcho &&
      entry.index < failingPairEcho.index &&
      rawLines.some((line, index) => index > entry.index && index < failing.index && isSuccessAssertion(line))
    ) &&
    (entry.index > lastBlockBodyEnd || (blocks.length <= 1 && entry.index < firstBlockCode));
  const strongSurvivors = codelessEntries.filter((entry) => lineRank(entry.line) <= 1 && survivorEligible(entry));
  // A demoted `[cause]:` line still rides when it is the only substantive text:
  // the rank-4 demotion exists to keep it from outranking a header, not to
  // silence a dump that has nothing else.
  const attributableSurvivors = strongSurvivors.length
    ? strongSurvivors
    : codelessEntries.filter((entry) => isCauseLine(entry.line) && survivorEligible(entry));
  if (
    !block &&
    !codeLine &&
    typeof execResult.status === 'number' &&
    execResult.status !== 0 &&
    attributableSurvivors.length === 1
  ) {
    const survivor = attributableSurvivors[0]!;
    // The entry's own raw position: a crash snippet that repeats the text must
    // not move the survivor past the success assertion that vetoes it.
    const survivorIndex = survivor.index;
    const echoIndex = failingPairEcho ? failingPairEcho.index : -1;
    const successAfter = rawLines.some((line, index) => index >= survivorIndex && isSuccessAssertion(line));
    const laterFailingPair =
      hasFailingPair &&
      echoIndex > survivorIndex &&
      rawLines.some((line, index) => index > survivorIndex && index < echoIndex && isSuccessAssertion(line));
    if (!laterFailingPair && (!successAfter || hasFailingPair)) return survivor.line;
  }
  // A recovered block's echo must name the failing step: the block line moved
  // to a later echo only when the success that recovered it precedes the last
  // failing pair, and the code line is re-derived from the failing step's own
  // block (never re-resolved by duplicate text).
  if (block && block.rank <= 2 && recoverySuccess > block.index) {
    const echo = entries
      .filter((entry) => lineRank(entry.line) === 3 && entry.index > block!.index && entry.index > recoverySuccess)
      .at(-1);
    if (echo) {
      block = { line: echo.line, rank: 3, index: echo.index };
      codeLine = codeEntries.filter((entry) => entry.index > recoverySuccess).at(-1)?.line;
      recoveredSwap = true;
    }
  }
  // A success assertion after a rank-0/1 code-less line means that line came
  // from a step that recovered and a later block names a different step; the
  // block's code line and echo are the honest reason instead.
  if (!hasFailingPair && bare && block && bare.rank <= 1) {
    const laterCode = codeEntries.find((entry) => entry.index > bare!.index);
    const boundary = laterCode?.index ?? block.index;
    const recovered = rawLines.some(
      (line, index) => index > bare!.index && index < boundary && isSuccessAssertion(line),
    );
    if (recovered) return [codeLine, block.line].filter((line): line is string => Boolean(line)).join(' ');
  }
  // A failing pair after an earlier dying-words line, with a success assertion
  // between them, names a later failing step; prefer it. Without that gap the
  // pair belongs to the same script as the cause, and the cause stays.
  const bareRawIndex = bare ? bare.index : -1;
  if (
    hasFailingPair &&
    failingPairEcho &&
    bare &&
    bareRawIndex >= 0 &&
    bareRawIndex < failingPairEcho.index &&
    bare.rank <= 1 &&
    rawLines.some((line, index) => index > bareRawIndex && index < failingPairEcho.index && isSuccessAssertion(line))
  ) {
    bare = { line: failingPairEcho.line, rank: 3, index: failingPairEcho.index };
  }
  // An echo that precedes the chosen block belongs to an earlier step; a
  // metadata-only block must not inherit it.
  if (bare && lineRank(bare.line) === 3 && block && bare.index < block.index) bare = undefined;
  // A success assertion is never the reason: it names a step that recovered.
  if (bare && isSuccessAssertion(bare.line)) bare = undefined;
  // The same holds when the echo itself won the tier: npm's block echo follows
  // its code line, so an echo above the last code line is an earlier step's.
  if (
    !bodylessTwin &&
    !trailingSwap &&
    block &&
    lineRank(block.line) === 3 &&
    codeEntries.length &&
    block.index < codeEntries.at(-1)!.index
  ) {
    block = undefined;
  }
  // Both branches compete: an unprefixed crash line outranks a block echo, and
  // the block keeps its code prefix when the block wins or when only a weak
  // code-less line survives, because the code still identifies the failure.
  if (bare && (!block || bare.rank < block.rank)) {
    if (trailingSwap && promotedInPair) return bare.line;
    if (recoveredSwap && block && bare.rank >= 2) {
      return [codeLine, block.line].filter((line): line is string => Boolean(line)).join(' ');
    }
    return codeLine && bare.rank >= 2 ? `${codeLine} ${bare.line}` : bare.line;
  }
  if (block && block.rank < 4) return [codeLine, block.line].filter((line): line is string => Boolean(line)).join(' ');
  if (codeLine) return codeLine;
  if (bare) return bare.line;
  // A spawn artifact (timeout, ENOBUFS) names the kill for unattributable
  // stderr; a block or a failing pair has already won above.
  if (execResult.error?.message) return execResult.error.message;
  if (execResult.signal) return `signal ${execResult.signal}`;
  if (typeof execResult.status === 'number') return `exit ${execResult.status}`;
  return 'unknown failure';
}

function restartMessage(target: string): string {
  if (target === 'officeace') {
    return '升级完成，请打开连接器 → 我的连接器 → huaweicloud-devkit → 重新连接后使用新版本。';
  }
  return '升级完成，请重启当前会话使新版本生效。';
}

export interface UpgradeOptions {
  doQuery?: () => Promise<DistTags | null>;
  spawnFn?: UpgradeSpawnFn;
  currentVersion?: string;
}

export async function upgradePackage(
  { target = 'all', version = 'latest' }: { target?: string; version?: string } = {},
  options: UpgradeOptions = {},
) {
  if (version !== 'latest') {
    return { success: false, error: 'version 参数仅支持 latest。目标版本由插件自动判定。' };
  }
  // The target is interpolated into an npx command spawned with shell:true;
  // reject anything outside the known agent set + 'all' so a crafted value
  // cannot be interpreted as shell operators (review #717).
  const targetStr = String(target);
  if (targetStr !== 'all' && !SUPPORTED_AGENT_TARGETS.includes(targetStr)) {
    return { success: false, error: `不支持的升级目标：${targetStr}` };
  }
  const { doQuery = queryDistTags, spawnFn = defaultSpawn } = options;
  // Tests inject currentVersion explicitly - the repo package.json version changes
  // between prerelease and stable lines, which must not flip the upgrade-tag logic.
  const previousVersion = options.currentVersion || readInstalledVersion();
  let distTags: DistTags | null;
  try {
    distTags = await doQuery();
  } catch (error) {
    return {
      success: false,
      error: errorMessage(error) || '无法确认最新版本（registry 查询失败）。',
      manual: `npx --yes --foreground-scripts huaweicloud-devkit@latest update --target ${target}`,
    };
  }
  const targetVersion = determineTarget(previousVersion, distTags ?? {});
  if (distTags === null) {
    return {
      success: false,
      error: '无法确认最新版本（registry 查询失败）。',
      manual: `npx --yes --foreground-scripts huaweicloud-devkit@latest update --target ${target}`,
    };
  }
  if (!targetVersion) {
    return { success: false, message: '已是最新版本，无需升级。', requiresRestart: false };
  }
  const isNextTarget = Boolean(distTags.next && semverCompare(targetVersion, distTags.next) === 0);
  const tag = isNextTarget ? 'next' : 'latest';
  const command = ['--yes', '--foreground-scripts', `huaweicloud-devkit@${tag}`, 'update', '--target', String(target)];
  let execResult: SpawnResultLike;
  try {
    execResult = spawnFn(NPX_BIN, command, {
      encoding: 'utf8',
      timeout: 300000,
      windowsHide: true,
      shell: true,
      env: upgradeEnv(),
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (error) {
    return {
      success: false,
      error: errorMessage(error) || '升级命令执行失败。',
      manual: `npx --yes --foreground-scripts huaweicloud-devkit@${tag} update --target ${target}`,
    };
  }
  if (execResult.status === 0) {
    invalidateUpdateCache();
    return {
      success: true,
      previousVersion,
      installedVersion: targetVersion,
      requiresRestart: true,
      message: restartMessage(target),
    };
  }
  const reason = extractNpmFailureReason(execResult);
  return {
    success: false,
    error: reason,
    manual: `npx --yes --foreground-scripts huaweicloud-devkit@${tag} update --target ${target}`,
  };
}
