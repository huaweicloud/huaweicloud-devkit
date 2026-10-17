import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import { redactSecrets } from '../safety-policy.ts';
import { huaweiConfigBase } from './pack-state.ts';

// The CLI face's approval tokens: the consent layer for
// plan_cli_command / run_approved_command in the huaweicloud-cli pack.
// Nothing here knows hcloud — the payload is an opaque serializable
// value, hashed, redacted, and persisted with a TTL.
//
// hcloud-cli.ts re-exports these for existing test import sites (the
// tool-schemas.ts re-export precedent).
//
// The token hash is canonical: object keys are recursively sorted at mint
// and verify, so the same logical arguments hash identically no matter how
// an agent re-serializes them (key order is the dominant re-emission
// drift). The CLI face's string[] payloads are unaffected — arrays keep
// their order, which is semantic there.
//
// Single-use is enforced by an exclusive-create marker next to the store
// (approvals-consumed/<token>.claimed, O_EXCL): the file round-trip alone
// has a read-modify-write window in which two processes can both consume
// one token. Marker creation that fails for other reasons (read-only home)
// degrades to the file round-trip alone — the window returns, but nothing
// that worked before breaks.

// Approval tokens must survive a process boundary: plan and run land in
// different MCP sessions/processes (and headless subprocesses), so the old
// in-memory Map lost the token and plan→approve→run became unreachable (#578).
// Persist to a per-user JSON file as the single source of truth. Only the
// sha256 of the args plus the redacted form are stored — never the raw args,
// which may carry --adminPass / --server.user_data secrets.
interface ApprovalEntry {
  argsHash: string;
  argsRedacted: unknown;
  createdAt: number;
}

type ApprovalMap = Record<string, ApprovalEntry>;

const APPROVAL_TTL_MS = 5 * 60_000;

function approvalFilePath(): string {
  return join(huaweiConfigBase(), 'approvals.json');
}

function sha256Hex(data: string): string {
  return createHash('sha256').update(data).digest('hex');
}

// Canonical JSON for token hashes: recursively sort object keys so agent
// re-serialization cannot change the hash of the same logical value.
// Arrays keep their order (order is semantic); undefined-valued keys are
// dropped by JSON.stringify exactly as before, on both sides of the hash.
// The target object is null-prototype: a plain object literal invokes the
// prototype setter for '__proto__', silently dropping the key from own
// properties and from the hash — a replay smuggling a different nested
// __proto__ (JSON.parse makes it an own property) hashed identically to
// the approved form (round-5 probe). On a null-prototype target, plain
// assignment creates an own property for every key, so the hash sees
// exactly what the wire sees. The seen-set bounds recursion on circular
// input (unreachable past the JSON boundary, reachable from direct
// callTool callers) — hash must never reject, only hash.
// The seen-set is a RECURSION PATH (add before recursing, delete after),
// not a global visited set: a DAG (the same object referenced twice, never
// circular) serializes structurally with it, while a visited-set collapsed
// the second reference to null — making {a:X,b:X} and {a:X,b:null} hash
// identically for direct callTool callers (round-7 probe). True cycles
// still terminate: the cycle edge revisits an ancestor and reads null.
function canonicalize(value: unknown, seen = new Set<unknown>()): unknown {
  if (Array.isArray(value)) {
    // Arrays join the recursion path too: a self-referential array
    // recursed unboundedly through the map before the object guard ever
    // saw it (round-8 probe: RangeError), violating the module's own
    // "hash never rejects" contract.
    if (seen.has(value)) return null;
    seen.add(value);
    try {
      return value.map((item) => canonicalize(item, seen));
    } finally {
      seen.delete(value);
    }
  }
  if (value !== null && typeof value === 'object') {
    if (seen.has(value)) return null;
    seen.add(value);
    try {
      const source = value as Record<string, unknown>;
      const sorted = Object.create(null) as Record<string, unknown>;
      // Code-unit comparison, the default sort's exact semantics made explicit.
      for (const key of Object.keys(source).sort((a, b) => (a > b ? 1 : a < b ? -1 : 0))) {
        sorted[key] = canonicalize(source[key], seen);
      }
      return sorted;
    } finally {
      seen.delete(value);
    }
  }
  return value;
}

export function hashArgs(args: unknown): string {
  return sha256Hex(JSON.stringify(canonicalize(args)));
}

function readApprovals(): ApprovalMap {
  try {
    const path = approvalFilePath();
    if (!existsSync(path)) return {};
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const result: ApprovalMap = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const entry = value as Record<string, unknown>;
      if (typeof entry.argsHash !== 'string' || typeof entry.createdAt !== 'number') continue;
      result[key] = { argsHash: entry.argsHash, argsRedacted: entry.argsRedacted, createdAt: entry.createdAt };
    }
    return result;
  } catch {
    return {};
  }
}

function writeApprovals(map: ApprovalMap): void {
  try {
    const path = approvalFilePath();
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(map), { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, path);
  } catch {
    // Best-effort: an in-file failure degrades cross-process persistence but a
    // token created/consumed within one process still works.
  }
}

function pruneStale(map: ApprovalMap, now = Date.now()): boolean {
  let changed = false;
  for (const [key, value] of Object.entries(map)) {
    if (now - value.createdAt > APPROVAL_TTL_MS) {
      delete map[key];
      changed = true;
    }
  }
  return changed;
}

function consumedMarkerDir(): string {
  return join(huaweiConfigBase(), 'approvals-consumed');
}

// Exclusive-create claim on a token: 'wx' maps to O_EXCL|O_CREAT, so the
// first consumer wins atomically and every replay sees EEXIST. Claimed
// only AFTER the entry is confirmed present and valid, so bogus or expired
// tokens never create marker files. Any non-EEXIST failure (read-only
// home) returns true — degradation to file-only single-use, which is no
// worse than the pre-marker state.
function claimSingleUse(token: string): boolean {
  try {
    mkdirSync(consumedMarkerDir(), { recursive: true, mode: 0o700 });
    writeFileSync(join(consumedMarkerDir(), `${token}.claimed`), '', { flag: 'wx', mode: 0o600 });
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'EEXIST';
  }
}

// Markers outlive their tokens only briefly: prune ones older than 4x the
// TTL, long past any window in which the token could still validate.
function pruneConsumedMarkers(now = Date.now()): void {
  try {
    const dir = consumedMarkerDir();
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      try {
        if (now - statSync(path).mtimeMs > APPROVAL_TTL_MS * 4) unlinkSync(path);
      } catch {
        // raced away between readdir and stat/unlink; harmless
      }
    }
  } catch {
    // dir absent or unreadable: nothing to prune
  }
}

export function createApprovalToken(rawArgs: unknown): string {
  const token = randomUUID();
  const map = readApprovals();
  map[token] = {
    argsHash: hashArgs(rawArgs),
    argsRedacted: redactSecrets(rawArgs),
    createdAt: Date.now(),
  };
  pruneStale(map);
  pruneConsumedMarkers();
  writeApprovals(map);
  return token;
}

// Tokens are minted by randomUUID(); anything else is agent noise. The
// shape check runs before ANY filesystem effect: the token string once
// reached join() unsanitized, so a '..'-bearing "token" could write
// marker files outside the marker directory.
const TOKEN_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function consumeApprovalToken(token: string): ApprovalEntry | null {
  if (!TOKEN_SHAPE.test(token)) return null;
  const map = readApprovals();
  const entry = map[token];
  if (!entry) return null;
  if (Date.now() - entry.createdAt > APPROVAL_TTL_MS) {
    delete map[token];
    writeApprovals(map);
    return null;
  }
  // Claim after validation: the marker exists only for tokens that were
  // real and unexpired at read time. A crash between claim and the
  // delete-write below can burn a valid token without spending it —
  // fail-closed, rare, accepted.
  if (!claimSingleUse(token)) return null;
  delete map[token];
  writeApprovals(map);
  return entry;
}
