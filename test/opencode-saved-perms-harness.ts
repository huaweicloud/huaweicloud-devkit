// The seeded opencode permission-store harness: builds a fixture SQLite
// store in the shape opencode 2.2.7 writes (the `project` and `permission`
// tables), so the reader and the doctor can be driven against a real file
// without ever touching the machine's live store. The approval gate never
// reads this store: the confirmation runs server-side.
//
// Every db lives under a fixtureDir() root in TMPDIR. The store's own
// resolution root is `$XDG_DATA_HOME/opencode`, so withStoreDir pins
// XDG_DATA_HOME to the fixture and clears OPENCODE_DB: the reader resolves
// exactly the seeded file and nothing ambient can leak in.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { fixtureDir } from './fixture-dir.ts';

export interface SeedProject {
  id: string;
  worktree: string;
}

export interface SeedPermission {
  id: string;
  projectId: string;
  action: string;
  resource?: string;
}

export interface SeedDirectory {
  projectId: string;
  directory: string;
}

export interface SeedStore {
  projects?: SeedProject[];
  /** The directory -> project map opencode writes per attributed directory. */
  worktrees?: SeedDirectory[];
  permissions?: SeedPermission[];
}

function seedDbFile(path: string, seed: SeedStore): void {
  const db = new DatabaseSync(path);
  try {
    db.exec(`CREATE TABLE project (
      id text PRIMARY KEY NOT NULL,
      worktree text NOT NULL,
      vcs text,
      name text,
      time_created integer NOT NULL,
      time_updated integer NOT NULL
    )`);
    db.exec(`CREATE TABLE permission (
      id text PRIMARY KEY NOT NULL,
      project_id text NOT NULL,
      action text NOT NULL,
      resource text NOT NULL,
      time_created integer NOT NULL,
      time_updated integer NOT NULL
    )`);
    db.exec(`CREATE TABLE worktree (
      project_id text NOT NULL,
      directory text NOT NULL,
      strategy text,
      time_created integer NOT NULL,
      PRIMARY KEY (project_id, directory)
    )`);
    db.exec('CREATE UNIQUE INDEX permission_project_action_resource_idx ON permission (project_id, action, resource)');
    const directory = db.prepare('INSERT INTO worktree (project_id, directory, time_created) VALUES (?, ?, ?)');
    for (const row of seed.worktrees ?? []) directory.run(row.projectId, row.directory, Date.now());
    const project = db.prepare('INSERT INTO project (id, worktree, time_created, time_updated) VALUES (?, ?, ?, ?)');
    for (const row of seed.projects ?? []) project.run(row.id, row.worktree, Date.now(), Date.now());
    const permission = db.prepare(
      'INSERT INTO permission (id, project_id, action, resource, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?)',
    );
    for (const row of seed.permissions ?? []) {
      permission.run(row.id, row.projectId, row.action, row.resource ?? '*', Date.now(), Date.now());
    }
  } finally {
    db.close();
  }
}

/** Seed a store at an explicit path (the channel-name shapes need this). */
export function seedStoreAt(path: string, seed: SeedStore): string {
  mkdirSync(dirname(path), { recursive: true });
  seedDbFile(path, seed);
  return path;
}

/** Seed the store the reader resolves under `dir` (the pinned XDG data root). */
export function seedStoreIn(dir: string, seed: SeedStore): string {
  return seedStoreAt(join(dir, 'opencode', 'opencode.db'), seed);
}

/**
 * Run `fn` with XDG_DATA_HOME pinned to a fresh fixture root (OPENCODE_DB
 * cleared), handing it that root. The caller seeds a store under it or
 * leaves it empty; the real machine's store is unreachable either way.
 */
export async function withStoreDir<T>(fn: (dir: string) => Promise<T> | T): Promise<T> {
  const dir = fixtureDir('hwc-saved-perms-');
  const previous = { XDG_DATA_HOME: process.env.XDG_DATA_HOME, OPENCODE_DB: process.env.OPENCODE_DB };
  process.env.XDG_DATA_HOME = dir;
  delete process.env.OPENCODE_DB;
  try {
    return await fn(dir);
  } finally {
    if (previous.XDG_DATA_HOME === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = previous.XDG_DATA_HOME;
    if (previous.OPENCODE_DB === undefined) delete process.env.OPENCODE_DB;
    else process.env.OPENCODE_DB = previous.OPENCODE_DB;
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A garbage file in place of the store: the corrupt-store shape. */
export function writeCorruptStore(dir: string): string {
  const opencodeDir = join(dir, 'opencode');
  mkdirSync(opencodeDir, { recursive: true });
  const dbPath = join(opencodeDir, 'opencode.db');
  writeFileSync(dbPath, 'not a sqlite database at all\n', 'utf8');
  return dbPath;
}
