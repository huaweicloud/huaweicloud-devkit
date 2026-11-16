// The opencode saved-permission store reader — DOCTOR HYGIENE ONLY (PR-1.5).
//
// Why it exists: opencode persists an ALLOW row for the roster action when a
// user clicks "Always allow" on the client's prompt (measured on 2.2.7: the
// MCP tool wrapper asserts `resources: ['*'], save: ['*']`, the reply handler
// writes those save patterns through the saved-permission store, and
// `evaluate()` appends the saved rows AFTER the configured rules with
// findLast). That row used to suppress the client popup the old ask posture
// trusted. It cannot suppress anything now: the confirmation runs on the
// server (the approval gate raises an elicitation form, or the T3 chat
// round-trip), inside the tool call and outside opencode's permission
// evaluation. The gate NEVER reads this store; the doctor does, and reports a
// saved row as a stale grant the operator may clean up.
//
// What is trusted here: nothing in the store. The database is opened
// readOnly, only `project`, `permission`, and the optional `worktree`
// directory map are read (never a blob table), and every failure shape
// degrades to "no rows" — a missing db is the healthy fresh state, an
// unreadable or schema-shifted db is warn-only — so an opencode internals
// change can never brick a diagnostic. Read-under-service is safe: the live
// store runs WAL, and a readOnly reader takes no write lock (probe-measured
// against an 805 MB store with the service running).
//
// `node:sqlite` is REQUIRED INSIDE the scan, never imported at module scope:
// this module compiles into the setup-cli boot graph (agents/opencode.ts'
// doctor), and the builtin is experimental through Node 22.x — the declared
// floor — so a module-scope load printed its ExperimentalWarning on every CLI
// run (the officeace-sqlite.ts precedent; test/structure.test.ts pins the
// shape for every src module, and test/cli-boot-warnings.test.ts pins the
// behavior on the floor).
//
// A row's `action` is a PATTERN, not a literal: opencode matches it with its
// own wildcard matcher against the requested action, so a hand-edited or
// older row can be `huaweicloud-devkit_*`. wildcardMatch below mirrors
// opencode's `util/wildcard.ts`, so the scan asks the question the client
// asks.
//
// The action itself comes from the roster leaf (approval-roster.ts), never a
// local literal: the roster tuple is the single home of the tool name, and
// this module must not drift from it.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

import { APPROVAL_TOOLS, approvalToolAction } from '../approval-roster.ts';

/** One saved permission row, already matched as an allow for the action. */
export interface SavedAllowRow {
  id: string;
  projectId: string;
  /** The project's canonical worktree, or null when the project row is gone. */
  projectWorktree: string | null;
  action: string;
  resource: string;
}

/**
 * The scan outcome. `absent` is the healthy fresh state (no store, nothing to
 * refuse); `unreadable` is the warn-only degradation (a store we could not
 * read must never fail the call); `ok` carries the rows the caller asked for
 * under one of three scopes:
 *   - `project`     the current project resolved, so only its rows are here;
 *   - `any-project` the project join failed, so EVERY matching row is here
 *                   (the conservative fallback: a saved allow that cannot be
 *                   attributed to another project is still a saved allow);
 *   - `all`         the inventory scope (doctor), every matching row.
 */
export type SavedAllowScan =
  | { status: 'absent'; dbPath: string }
  | { status: 'unreadable'; dbPath: string; detail: string }
  | { status: 'ok'; dbPath: string; scope: 'project' | 'any-project' | 'all'; rows: SavedAllowRow[] };

export interface SavedAllowScanOptions {
  /** 'project' is the gate's question; 'all' is the doctor's inventory. */
  scope: 'project' | 'all';
  /** The permission actions to match; defaults to every roster tool's action. */
  actions?: readonly string[];
  env?: NodeJS.ProcessEnv;
  /** The directory the MCP server was spawned in (the opencode instance's project directory). */
  cwd?: string;
}

/** The permission action opencode namespaces for one roster tool. */
export function savedAllowAction(tool: string = APPROVAL_TOOLS[0]): string {
  return approvalToolAction(tool);
}

/** Every roster tool's permission action (the doctor's inventory set). */
export function savedAllowActions(): string[] {
  return APPROVAL_TOOLS.map((tool) => approvalToolAction(tool));
}

// The data root opencode keys its store off: `$XDG_DATA_HOME` when absolute,
// else `~/.local/share` (opencode's own Global data dir).
export function opencodeDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const xdg = env.XDG_DATA_HOME;
  const base = xdg !== undefined && xdg !== '' && isAbsolute(xdg) ? xdg : join(homedir(), '.local', 'share');
  return join(base, 'opencode');
}

// The exact path opencode resolves, in its own order: OPENCODE_DB wins
// outright (resolved against the data dir, exactly as the client does), then
// the channel-named store. The channel name is a build-time constant of the
// installed binary, so the reader cannot ask for it; it looks the store up
// instead: the stable `opencode.db` first, then the newest `opencode-<channel>.db`.
// `opencode-next.db` is excluded on purpose: it is the V1 legacy migration
// source with a different schema, not this store.
export function opencodeDbCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const dir = opencodeDataDir(env);
  const override = env.OPENCODE_DB;
  if (override !== undefined && override !== '') {
    if (override === ':memory:') return []; // an in-memory store persists nothing
    return [isAbsolute(override) ? override : resolve(dir, override)];
  }
  const stable = join(dir, 'opencode.db');
  const candidates = [stable];
  const channels = readdirOrEmpty(dir)
    .filter((name) => /^opencode-.+\.db$/.test(name) && name !== 'opencode-next.db')
    .map((name) => join(dir, name))
    .sort((a, b) => mtimeMs(b) - mtimeMs(a));
  candidates.push(...channels);
  return candidates;
}

function readdirOrEmpty(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return []; // no data dir yet
  }
}

function mtimeMs(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

// opencode's `util/wildcard.ts`, mirrored: backslashes normalize to '/', the
// pattern's regex metacharacters are escaped, `*` becomes `.*` and `?` a
// single char, and the result is anchored. The trailing-' *' fold (a pattern
// ending in a space-star also matches the bare prefix) is part of the same
// matcher, so it is kept.
export function wildcardMatch(input: string, pattern: string): boolean {
  const normalized = input.replaceAll('\\', '/');
  let escaped = pattern
    .replaceAll('\\', '/')
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  if (escaped.endsWith(' .*')) escaped = escaped.slice(0, -3) + '( .*)?';
  return new RegExp(`^${escaped}$`, process.platform === 'win32' ? 'si' : 's').test(normalized);
}

interface ProjectRow {
  id: string;
  worktree: string | null;
}

interface PermissionRow {
  id: string;
  projectId: string;
  action: string;
  resource: string;
}

interface DirectoryRow {
  projectId: string;
  directory: string;
}

function readRows(db: SqliteDatabase): {
  projects: ProjectRow[];
  directories: DirectoryRow[];
  permissions: PermissionRow[];
} {
  const projects = db
    .prepare('SELECT id, worktree FROM project')
    .all()
    .map((row) => ({
      id: typeof row['id'] === 'string' ? row['id'] : '',
      worktree: typeof row['worktree'] === 'string' ? row['worktree'] : null,
    }))
    .filter((row) => row.id !== '');
  const permissions = db
    .prepare('SELECT id, project_id, action, resource FROM permission')
    .all()
    .map((row) => ({
      id: typeof row['id'] === 'string' ? row['id'] : '',
      projectId: typeof row['project_id'] === 'string' ? row['project_id'] : '',
      action: typeof row['action'] === 'string' ? row['action'] : '',
      resource: typeof row['resource'] === 'string' ? row['resource'] : '',
    }))
    .filter((row) => row.id !== '');
  return { projects, directories: readDirectories(db), permissions };
}

// The directory -> project map opencode itself resolves a location through
// (the `worktree` table, which carries a row per directory it has attributed,
// linked worktrees included). Tolerated, never required: the table is newer
// than the store, so an older schema answers with the project join alone.
function readDirectories(db: SqliteDatabase): DirectoryRow[] {
  try {
    return db
      .prepare('SELECT project_id, directory FROM worktree')
      .all()
      .map((row) => ({
        projectId: typeof row['project_id'] === 'string' ? row['project_id'] : '',
        directory: typeof row['directory'] === 'string' ? row['directory'] : '',
      }))
      .filter((row) => row.projectId !== '' && row.directory !== '');
  } catch {
    return [];
  }
}

function canonical(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

// The rows whose directory is the one this process runs in. Cheap first pass
// on resolved spellings (a cwd carrying `..` or a trailing slash); the
// canonical pass runs only when nothing matched — a symlinked checkout
// spelling — so the steady-state scan stays string comparisons rather than a
// realpath sweep over every project row.
function rowsForDirectory<T>(rows: T[], pathOf: (row: T) => string, cwd: string): T[] {
  const target = resolve(cwd);
  const direct = rows.filter((row) => resolve(pathOf(row)) === target);
  if (direct.length > 0) return direct;
  const canonicalTarget = canonical(cwd);
  if (canonicalTarget === null) return [];
  return rows.filter((row) => canonical(pathOf(row)) === canonicalTarget);
}

function sha1(value: string): string {
  return createHash('sha1').update(value).digest('hex');
}

// The project ids the current directory belongs to, or null when the join
// fails (the conservative caller then treats every matching row as the
// current project's). Three readings, in the order opencode itself attributes
// a directory: the `project.worktree` join (canonical directory match — this
// is the one that resolves a plain directory, a git checkout opened at its
// root, and a clone that shares a project), the `worktree` directory map (the
// row opencode writes per attributed directory, which is what resolves a
// linked worktree), then the plain-directory hash `sha1('directory:' + dir)`
// for a project row neither directory reading can see.
function resolveProjectIds(projects: ProjectRow[], directories: DirectoryRow[], cwd: string): string[] | null {
  const joined = [
    ...rowsForDirectory(projects, (project) => project.worktree ?? '', cwd).map((project) => project.id),
    ...rowsForDirectory(directories, (row) => row.directory, cwd).map((row) => row.projectId),
  ];
  if (joined.length > 0) return [...new Set(joined)];
  const spellings = new Set([cwd, resolve(cwd)]);
  const canonicalCwd = canonical(cwd);
  if (canonicalCwd !== null) spellings.add(canonicalCwd);
  const hashed = new Set([...spellings].map((spelling) => sha1(`directory:${spelling}`)));
  const matched = projects.filter((project) => hashed.has(project.id)).map((project) => project.id);
  return matched.length > 0 ? matched : null;
}

function toRows(matched: PermissionRow[], projects: ProjectRow[]): SavedAllowRow[] {
  const worktrees = new Map(projects.map((project) => [project.id, project.worktree]));
  return matched.map((row) => ({
    id: row.id,
    projectId: row.projectId,
    projectWorktree: worktrees.get(row.projectId) ?? null,
    action: row.action,
    resource: row.resource,
  }));
}

// The builtin, loaded on demand (see the header): the doctor is the only
// consumer, and the CLI's boot graph must not import the experimental module.
interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): { all(): Array<Record<string, unknown>> };
  close(): void;
}

type SqliteCtor = new (path: string, options: { readOnly?: boolean }) => SqliteDatabase;

function loadDatabaseSync(): SqliteCtor {
  const sqlite = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync?: SqliteCtor };
  const ctor = sqlite.DatabaseSync;
  if (ctor === undefined) {
    throw new Error('node:sqlite is unavailable; the saved-permission scan requires Node.js >= 22.19');
  }
  return ctor;
}

function scanFile(dbPath: string, options: SavedAllowScanOptions): SavedAllowScan {
  const actions = options.actions ?? savedAllowActions();
  let db: SqliteDatabase;
  try {
    db = new (loadDatabaseSync())(dbPath, { readOnly: true });
  } catch (error) {
    return { status: 'unreadable', dbPath, detail: errorMessage(error) };
  }
  try {
    // A writer holding the store must not turn a read into an instant
    // SQLITE_BUSY (or a stall): the read is bounded, and a busy store still
    // reads as warn-only below, never as a refusal.
    db.exec('PRAGMA busy_timeout = 500');
    const { projects, directories, permissions } = readRows(db);
    const matching = permissions.filter((row) => actions.some((action) => wildcardMatch(action, row.action)));
    if (options.scope === 'all') {
      return { status: 'ok', dbPath, scope: 'all', rows: toRows(matching, projects) };
    }
    const projectIds = resolveProjectIds(projects, directories, options.cwd ?? process.cwd());
    if (projectIds === null) {
      return { status: 'ok', dbPath, scope: 'any-project', rows: toRows(matching, projects) };
    }
    const scoped = matching.filter((row) => projectIds.includes(row.projectId));
    return { status: 'ok', dbPath, scope: 'project', rows: toRows(scoped, projects) };
  } catch (error) {
    // A schema shift, a corrupt file, a locked table: warn-only by contract.
    return { status: 'unreadable', dbPath, detail: errorMessage(error) };
  } finally {
    db.close();
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Read the saved-permission store for allow rows covering one of `actions`
 * (default: every roster tool's action), under the scope the caller asks for.
 * Missing db reads as `absent` (pass); every read failure reads as
 * `unreadable` (warn-only). Never writes.
 */
export function scanSavedAllowRows(options: SavedAllowScanOptions): SavedAllowScan {
  const env = options.env ?? process.env;
  const candidates = opencodeDbCandidates(env);
  if (candidates.length === 0) return { status: 'absent', dbPath: '' };
  const existing = candidates.find((candidate) => existsSync(candidate));
  if (existing === undefined) return { status: 'absent', dbPath: candidates[0]! };
  return scanFile(existing, options);
}

/** The db path a scan resolved without touching the file (for messages). */
export function opencodeDbPath(env: NodeJS.ProcessEnv = process.env): string {
  return opencodeDbCandidates(env)[0] ?? '';
}
