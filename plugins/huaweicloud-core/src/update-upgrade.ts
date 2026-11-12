// The upgrade act: elects the target tag (latest/next), spawns
// `npx huaweicloud-devkit@<tag> update --target <target>`, and shapes the
// restart/manual-command guidance. Part of the src/update-* family behind the
// src/update-check.ts re-export face.
import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from 'node:child_process';

import { SUPPORTED_AGENT_TARGETS } from './auth/agent-registration.ts';
import { isCredentialEnvVarName } from './lib/secret-vault/refs.ts';
import { determineTarget, semverCompare, type DistTags } from './update-semver.ts';
import { readInstalledVersion } from './update-installed.ts';
import { queryDistTags, errorMessage } from './update-registry.ts';
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
  const devkitSpellings: Array<[string, string | undefined]> = [];
  for (const [key, value] of Object.entries(env)) {
    // The vault predicate trims its spelling; the strip and preserve lists must
    // agree, so a padded vendor key strips and a padded preserve key survives.
    const upper = key.trim().toUpperCase();
    if (upper === 'HUAWEICLOUD_NPM_REGISTRY') {
      devkitSpellings.push([key, value]);
      continue;
    }
    if (upper === 'NPM_CONFIG_REGISTRY') registrySpellings.push(key);
    // npm's own auth channels reach the child trimmed, matching the pre-flight
    // query's bearer: a padded token must authenticate both or neither.
    if (upper === 'NPM_TOKEN' || upper === 'NODE_AUTH_TOKEN') {
      const token = value?.trim();
      if (token) next[key] = token;
      continue;
    }
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
  // Pathological case spellings: the trimmed non-empty exact-case key wins,
  // else the first trimmed non-empty spelling; empty and whitespace count as
  // unset everywhere. One canonical channel, so the child's own devkit lookup
  // and npm's pin cannot disagree, and an unset override never pins.
  const nonEmpty = devkitSpellings.filter(([, value]) => Boolean(value?.trim()));
  const registry = (nonEmpty.find(([key]) => key === 'HUAWEICLOUD_NPM_REGISTRY') ?? nonEmpty[0])?.[1]?.trim();
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
  /\b[A-Za-z]*Error\b|\b(?:failed|failure|fatal|unknown|unsupported|stopped)\b|permission denied|错误|失败|不支持|未知/i;
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
  entries: LineEntry[],
  { positionLast }: { positionLast: boolean },
): { line: string; rank: number; index: number } | undefined {
  for (const rank of [0, 1, 2, 3, 4]) {
    const hits = entries.filter((entry) => lineRank(entry.line) === rank);
    if (!hits.length) continue;
    if (rank === 3) {
      // The echo tier names the failing script: the last echo that carries the
      // failing result's own package/script identity wins, so a nesting script's
      // nearer echo cannot stand in; else the last echo.
      const failing = lastFailingResult(entries);
      const identity = failing ? npmRunIdentity(failing.line) : undefined;
      const identityPaired = identity
        ? entries
            .filter(
              (entry) =>
                entry.index < failing!.index && lineRank(entry.line) === 3 && npmRunIdentity(entry.line) === identity,
            )
            .at(-1)
        : undefined;
      const paired = identityPaired ?? (failing ? lastEchoBefore(entries, failing.index) : undefined);
      const chosen = paired ?? hits.at(-1)!;
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

function errorBlocks(codeEntries: LineEntry[], otherEntries: LineEntry[]): ErrorBlock[] {
  return codeEntries.map((code, position) => {
    const next = codeEntries[position + 1]?.index ?? Number.POSITIVE_INFINITY;
    return {
      code,
      entries: otherEntries.filter((entry) => entry.index > code.index && entry.index < next),
    };
  });
}

function pickInBlock(block: ErrorBlock): { line: string; rank: number; index: number } | undefined {
  for (const rank of [0, 1, 2, 3, 4]) {
    const hits = block.entries.filter((entry) => lineRank(entry.line) === rank);
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

function isCauseLine(line: string): boolean {
  const payload = npmPayload(line);
  if (!/^\[cause\]:/.test(payload)) return false;
  const rest = payload.replace(/^\[cause\]:\s*/, '');
  if (ERROR_NAME.test(rest)) return true;
  const token = /^([A-Z0-9_]+)(?=:|\s|$)/.exec(rest)?.[1];
  return isErrnoToken(token);
}

function extractNpmFailureReason(execResult: SpawnResultLike): string {
  const rawLines = String(execResult.stderr || '')
    .split(/\r?\n/)
    .map((line) => normalizeNpmLine(line))
    .filter(Boolean);
  // A Node crash preamble carries three lines the per-line rules cannot judge:
  // the `file:line` header, the source snippet, and the caret under it.
  const crashPreamble = new Set<number>();
  rawLines.forEach((line, index) => {
    const header = /^\S+:\d+$/.test(line);
    const snippet = Boolean(rawLines[index + 1] && /[;=()]/.test(rawLines[index + 1]!));
    const caret = /^\s*\^\s*$/.test(rawLines[index + 2] ?? '');
    if (header && snippet && caret) {
      crashPreamble
        .add(index)
        .add(index + 1)
        .add(index + 2);
    }
  });
  // Every entry keeps its raw position: the code candidate, the block and the
  // echo are compared against the success window in one index space, so a
  // duplicate text line can never be re-resolved to its first occurrence.
  const entries: LineEntry[] = rawLines
    .map((line, index) => ({ line, index }))
    .filter((entry) => !crashPreamble.has(entry.index) && !isNpmNoiseLine(entry.line));
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
  const identityEchoesBefore = (before: number, identity: string | undefined) =>
    identity
      ? entries
          .filter(
            (entry) => entry.index < before && lineRank(entry.line) === 3 && npmRunIdentity(entry.line) === identity,
          )
          .at(-1)
      : undefined;
  // A code-0 result owns the lines between its echo and its result, whether or
  // not it shares the failing step's identity: a recovered run of the same
  // package is a different step. Pair every success with its nearest identity
  // echo.
  const recoveredWindows: Array<{ start: number; end: number }> = [];
  for (const result of codelessEntries) {
    if (!isNpmScriptResult(result.line) || isFailingScriptResult(result.line)) continue;
    const echo = identityEchoesBefore(result.index, npmRunIdentity(result.line));
    if (echo) recoveredWindows.push({ start: echo.index, end: result.index });
  }
  // The failing pair's echo is the step's own: the nearest identity echo that
  // does not start or sit in a recovered window, else the adjacent echo.
  const ownEcho = failing
    ? entries
        .filter(
          (entry) =>
            entry.index < failing.index &&
            lineRank(entry.line) === 3 &&
            npmRunIdentity(entry.line) === failingIdentity &&
            !recoveredWindows.some((window) => entry.index >= window.start && entry.index <= window.end),
        )
        .at(-1)
    : undefined;
  const failingPairEcho = ownEcho ?? (failing ? lastEchoBefore(entries, failing.index) : undefined);
  const hasFailingPair = Boolean(failing && failingPairEcho);
  // A nested window whose own echo starts after the failing pair's echo belongs
  // to a nested step and is excluded even when it sits inside the pair's span;
  // only the failing step's own words between its echo and result are in-pair
  // survivors.
  const insideFailingPair = (index: number) =>
    Boolean(failing && failingPairEcho && index > failingPairEcho.index && index < failing.index);
  const inRecoveredWindow = (index: number) =>
    recoveredWindows.some(
      (window) =>
        index > window.start &&
        index < window.end &&
        (window.start > (failingPairEcho?.index ?? -1) || !insideFailingPair(index)),
    );
  // A success assertion is recovery evidence only when it precedes the last
  // failing pair: the failing step's own `gyp info ok`, printed after its dying
  // words and before its own result line, is not a recovery.
  const recoverySuccess = failingPairEcho ? lastSuccessIndex(failingPairEcho.index) : -1;

  let block = selectFailureLine(otherEntries, { positionLast: false });
  let bare = selectFailureLine(codelessEntries, { positionLast: true });
  let codeLine = codeFor(block);
  let recoveredSwap = false;
  const blocks = codeEntries.length ? errorBlocks(codeEntries, otherEntries) : [];
  const blockBodyEnd = (target: ErrorBlock) =>
    target.entries.reduce((max, entry) => Math.max(max, entry.index), target.code.index);
  const firstBlockCode = blocks[0]?.code.index ?? -1;
  const lastBlockBodyEnd = blocks.length ? blockBodyEnd(blocks.at(-1)!) : -1;
  // A pre-block preamble is the child's own words; the first-block-through-last-
  // body span belongs to recovered steps and is excluded.
  const outsideBlocks = (index: number) => !blocks.length || index < firstBlockCode || index > lastBlockBodyEnd;

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
      block = picked ?? { line: lastBlock.code.line, rank: 4, index: lastBlock.code.index };
      codeLine = lastBlock.code.line;
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
      const dying = codelessEntries.filter((entry) => entry.index > blockEnd && lineRank(entry.line) <= 2).at(-1);
      if (dying) return dying.line;
      block = undefined;
      codeLine = undefined;
    }
  }

  // A block that trails the last failing result is npm's own summary of that
  // step, and it owns the failure even when an earlier, recovered block carries
  // a higher-ranked diagnostic (the verbose/default asymmetry). Its code line
  // is the failing step's, so no recovered block's code can be the reason.
  if (hasFailingPair) {
    const trailing = errorBlocks(codeEntries, otherEntries)
      .filter((candidate) => candidate.code.index > failing!.index)
      .at(-1);
    if (trailing) {
      block = pickInBlock(trailing) ?? { line: trailing.code.line, rank: 4, index: trailing.code.index };
      codeLine = trailing.code.line;
      // The child's earlier chatter belongs to the step that recovered.
      if (bare && bare.index < trailing.code.index) bare = undefined;
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
  if (failing && failingPairEcho && bare && bare.index < failingPairEcho.index) {
    const inside = codelessEntries
      .filter((entry) => entry.index > failingPairEcho.index && entry.index < failing.index)
      .filter((entry) => lineRank(entry.line) <= 2)
      .at(-1);
    if (inside) bare = { line: inside.line, rank: lineRank(inside.line), index: inside.index };
  }
  // Lines belonging to a step whose own result says it recovered are not this
  // failure's words: the failing pair's echo is the honest fallback.
  if (hasFailingPair && failingPairEcho && bare && inRecoveredWindow(bare.index)) {
    bare = { line: failingPairEcho.line, rank: 3, index: failingPairEcho.index };
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
  const survivorEligible = (entry: LineEntry) => outsideBlocks(entry.index) && !inRecoveredWindow(entry.index);
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
  if (block && lineRank(block.line) === 3 && codeEntries.length && block.index < codeEntries.at(-1)!.index) {
    block = undefined;
  }
  // Both branches compete: an unprefixed crash line outranks a block echo, and
  // the block keeps its code prefix when the block wins or when only a weak
  // code-less line survives, because the code still identifies the failure.
  if (bare && (!block || bare.rank < block.rank)) {
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
