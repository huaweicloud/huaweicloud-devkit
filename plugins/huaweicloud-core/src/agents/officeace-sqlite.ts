// The OfficeAce sqlite connector family, split out of agents/officeace.ts for
// the complex-file bar: the node:sqlite module surface (runtime-only builtin
// loaded through createRequire), the database path + connection, the
// owner_user_id resolution, and the DEVKIT_PACKS read. The connector-row
// write/remove domain logic lives in agents/officeace-registry.ts; the
// capabilities-root resolution and the lifecycle stay in agents/officeace.ts,
// with the path family in officeace-paths.ts (the shared leaf).
// agent-registration.ts keeps its own smaller sqlite model: it is the MCP
// graph's read-side probe and must stay lazily loaded there.

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

import { asText } from '../lib/as-text.ts';
import { asRecord } from '../lib/as-record.ts';
import { officeaceCapabilitiesDirSafe } from '../officeace-paths.ts';
import { errorMessage } from '../install-payload.ts';
import type { PackWriteResult } from '../packs-cli/slots.ts';

// node:sqlite is a runtime-only builtin loaded through createRequire; only the
// DatabaseSync surface this module calls is modeled (see auth/agent-registration.ts).
interface SqliteRunResult {
  changes?: unknown;
}

interface SqliteStatement {
  get: (..._params: unknown[]) => unknown;
  run: (..._params: unknown[]) => SqliteRunResult;
}

export interface SqliteDatabase {
  prepare: (_sql: string) => SqliteStatement;
  close: () => void;
}

interface SqliteModule {
  DatabaseSync: new (_path: string) => SqliteDatabase;
}

function toSqliteModule(value: unknown): SqliteModule | null {
  if (!value || typeof value !== 'object') return null;
  const ctor = (value as { DatabaseSync?: unknown }).DatabaseSync;
  return typeof ctor === 'function' ? (value as SqliteModule) : null;
}

// The builtin is required inside a function, never at module scope: loading
// the setup-cli graph is the CLI's boot, and node:sqlite is experimental
// through Node 22.x (the declared floor) — at module scope it printed
// "(node:xxxx) ExperimentalWarning: SQLite is an experimental feature" on
// every CLI run, install included, and throws outright below Node 22.5,
// though only the officeace packs/doctor paths ever open the connector db.
// agent-registration.ts keeps the same doctrine for the MCP graph's probe.
function loadDatabaseSync(): new (_path: string) => SqliteDatabase {
  const sqliteModule = toSqliteModule(createRequire(import.meta.url)('node:sqlite'));
  if (!sqliteModule) {
    throw new Error('node:sqlite is unavailable; the OfficeAce integration requires Node.js >= 22');
  }
  return sqliteModule.DatabaseSync;
}

export function officeaceSqlitePath(): string {
  const capDir = officeaceCapabilitiesDirSafe();
  return join(resolve(capDir, '..'), 'data', 'mcp-connectors.sqlite');
}

export function openOfficeaceDb(): SqliteDatabase {
  const DatabaseSync = loadDatabaseSync();
  return new DatabaseSync(officeaceSqlitePath());
}

export function officeaceGetOwnerUserId(): string | number | null {
  if (!existsSync(officeaceSqlitePath())) return null;
  try {
    const db = openOfficeaceDb();
    const row: unknown = db
      .prepare('SELECT owner_user_id FROM mcp_connectors WHERE owner_user_id IS NOT NULL LIMIT 1')
      .get();
    db.close();
    const value = asRecord(row).owner_user_id;
    return typeof value === 'string' || typeof value === 'number' ? value : null;
  } catch {
    return null;
  }
}

// The OfficeAce DEVKIT_PACKS write — sqlite-connector I/O, the write side
// of readOfficeaceDevkitPacks (the PACK_SLOTS officeace row's write field).
// The write touches only that env_json row: replace its value, insert it,
// or delete it.
export function writeDevkitPacksInOfficeace(next: string | null): PackWriteResult {
  const dbPath = officeaceSqlitePath();
  if (!existsSync(dbPath)) {
    return { ok: false, reason: 'not-installed', detail: `database not found: ${dbPath}` };
  }
  let db: SqliteDatabase | null = null;
  try {
    db = openOfficeaceDb();
    const row: unknown = db.prepare("SELECT id, env_json FROM mcp_connectors WHERE name = 'huaweicloud-devkit'").get();
    const existing = asRecord(row);
    if (!('id' in existing)) {
      return { ok: false, reason: 'not-installed', detail: `no huaweicloud-devkit connector in ${dbPath}` };
    }
    let env: unknown = [];
    try {
      env = JSON.parse(asText(existing.env_json || '[]'));
    } catch {
      // parse failure falls back to an empty env list — no packs row means insert
    }
    const rows: unknown[] = Array.isArray(env) ? env : [];
    const idx = rows.findIndex((e) => asRecord(e).key === 'DEVKIT_PACKS');
    const current = idx >= 0 ? asRecord(rows[idx]).value : null;
    if ((typeof current === 'string' ? current : null) === next) return { ok: true, changed: false };
    let nextRows: unknown[];
    if (next === null) {
      nextRows = rows.filter((e) => asRecord(e).key !== 'DEVKIT_PACKS');
    } else if (idx >= 0) {
      nextRows = rows.map((e, i) =>
        i === idx ? { ...asRecord(e), key: 'DEVKIT_PACKS', value: next, sensitive: false } : e,
      );
    } else {
      nextRows = [...rows, { key: 'DEVKIT_PACKS', value: next, sensitive: false }];
    }
    db.prepare('UPDATE mcp_connectors SET env_json = ?, updated_at = ? WHERE id = ?').run(
      JSON.stringify(nextRows),
      Date.now(),
      existing.id,
    );
    return { ok: true, changed: true };
  } catch (error) {
    return { ok: false, reason: 'parse-failed', detail: errorMessage(error) };
  } finally {
    try {
      db?.close();
    } catch {
      // best-effort close: the packs write result is already resolved
    }
  }
}

// The OfficeAce sqlite registry's DEVKIT_PACKS value — registry I/O, not
// policy, so it stays with the officeace adapter family.
export function readOfficeaceDevkitPacks(): string | null {
  if (!existsSync(officeaceSqlitePath())) return null;
  let db: SqliteDatabase | null = null;
  try {
    db = openOfficeaceDb();
    const row: unknown = db.prepare("SELECT env_json FROM mcp_connectors WHERE name = 'huaweicloud-devkit'").get();
    const parsed: unknown = JSON.parse(asText(asRecord(row).env_json || '[]'));
    if (!Array.isArray(parsed)) return null;
    const hit: unknown = parsed.find((e) => asRecord(e).key === 'DEVKIT_PACKS');
    const value = hit ? asRecord(hit).value : null;
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      // best-effort close: the packs value is already resolved
    }
  }
}
