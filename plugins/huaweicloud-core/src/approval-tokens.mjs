import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { redactSecrets } from './safety-policy.mjs';

// Shared approval-token machinery, consumed by every CLI wrapper
// (hcloud-cli.mjs, agentarts-cli.mjs, and the SDK bridges' dedicated
// namespaces). Extracted from hcloud-cli.mjs so the cross-process
// persistence, TTL pruning, single-use tombstones, and atomic writes
// (#578, #745) have exactly one implementation.
//
// Cross-CLI confusion guard: the CLI id is mixed into the args hash AND
// stored on each entry, so a token minted by one wrapper can never approve
// another wrapper's command — `agentarts plan(['gateway','delete','x'])`
// cannot be consumed by `hcloud run_approved` with the same array.
//
// Only the sha256 of the namespaced args plus the redacted form are stored —
// never the raw args, which may carry secrets.
//
// Mutations are serialized cross-process by an O_EXCL lock file (R2 review
// round, browser bridge): create and consume are read-modify-write cycles,
// and two wrapper processes racing the cycle could both consume the SAME
// token (tombstone lost to a last-rename-wins write — the single-use
// guarantee broken, reviewer-reproduced 15/15 at store level). In-process
// the synchronous ops are event-loop-atomic; the lock covers the
// multi-process dimension (two MCP servers, or the CLI plus MCP).
// writeApprovals FAILS CLOSED (throws) since the same round: a swallowed
// write failure used to let consume() report success without persisting
// the tombstone — a replay then re-executed an approved write.

const APPROVAL_TTL_MS = 5 * 60_000;
// Tombstones (consumedAt set) survive this long FROM CONSUMPTION, not from
// creation: a slow approval whose plan aged past the TTL still replays as
// already_processed instead of not_found's "re-plan" advice (R2).
const TOMBSTONE_TTL_MS = 5 * 60_000;
// Lock parameters (R3/R4): a lock whose holder pid is DEAD breaks at any
// age (pid-liveness via process.kill(pid, 0)); mtime is only the backstop
// for unreadable content or pid-recycling paranoia. A LIVE pid is never
// broken — mutual exclusion beats availability (the R3 mtime-only break
// could kill a slow-but-alive holder's critical section and resurrect the
// exact lost-tombstone class the lock exists to prevent). The atomic break
// is a RENAME: exactly one breaker's renameSync succeeds, so two waiters
// cannot both claim a stale lock.
const LOCK_STALE_MS = 10_000;
const LOCK_WAIT_MS = 15_000;

function approvalFilePath() {
  return join(process.env.HUAWEICLOUD_HOME || homedir(), '.config', 'huaweicloud', 'approvals.json');
}

function lockFilePath() {
  return `${approvalFilePath()}.lock`;
}

// Synchronous sleep (Atomics.wait blocks the main thread in Node) — the
// store ops are already fully synchronous.
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function lockOwnerId() {
  return `${process.pid}:${randomUUID()}`;
}

function readLockOwner(lockPath) {
  try {
    return readFileSync(lockPath, 'utf8').trim();
  } catch {
    return null;
  }
}

function pidIsRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // ESRCH: no such process (dead). EPERM: exists but not ours (alive).
    return error.code === 'EPERM';
  }
}

// A lock is breakable ONLY when its holder cannot be vouched for: the
// owner line is unparseable (torn write — fall back to mtime age), or the
// recorded pid is dead (age-gated against pid recycling). A live pid is
// never breakable, however old — the waiter times out instead.
function lockIsBreakable(lockPath, owner) {
  const match = owner && owner.match(/^(\d+):/);
  if (!match) {
    try {
      return Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS;
    } catch {
      return false;
    }
  }
  if (!pidIsRunning(Number(match[1]))) {
    try {
      return Date.now() - statSync(lockPath).mtimeMs > 1_000;
    } catch {
      return false;
    }
  }
  return false;
}

// Cross-process mutual exclusion around the read-modify-write mutations.
// Acquisition is O_EXCL with the holder identity (pid:uuid) written into
// the lock; a stale lock is claimed ATOMICALLY by renaming it away
// (renameSync succeeds for exactly ONE breaker — the loser's rename hits
// ENOENT and rejoins the wait loop); release re-reads the lock and unlinks
// ONLY if the content still matches this holder (a late finally-unlink
// must never delete a replacement lock another process legitimately
// acquired, R3).
function withStoreLock(fn) {
  const lockPath = lockFilePath();
  // The store directory may not exist yet on the first-ever create — the
  // lock needs it before writeApprovals ever mkdirs.
  mkdirSync(dirname(lockPath), { recursive: true });
  const owner = lockOwnerId();
  const deadline = Date.now() + LOCK_WAIT_MS;
  let fd;
  for (;;) {
    try {
      fd = openSync(lockPath, 'wx');
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const current = readLockOwner(lockPath);
      if (current !== null && lockIsBreakable(lockPath, current)) {
        // Atomic claim (R4): exactly one breaker wins the rename; a loser
        // ENOENTs. Post-rename CONTENT VERIFICATION (R5/R6): the rename is
        // content-blind — a preempted break decision can steal a lock a
        // second breaker already claimed and re-acquired with a LIVE
        // owner. Verify the claimed file still carries the dead owner we
        // judged; on mismatch, restore it atomically (linkSync fails
        // EEXIST if a third party already re-acquired the path — then the
        // claim is simply dropped) and rejoin the wait.
        const claimed = `${lockPath}.breaking.${randomUUID()}`;
        try {
          renameSync(lockPath, claimed);
        } catch {
          continue; // lost the break race — retry the loop
        }
        if (readLockOwner(claimed) !== current) {
          try {
            linkSync(claimed, lockPath);
          } catch {
            // The path was re-acquired in the gap — drop the claim.
          }
        }
        try {
          unlinkSync(claimed);
        } catch {
          // Best effort.
        }
        // No sleep — retry immediately after freeing a stale lock; the
        // deadline check below bounds the pathological loop.
      } else {
        // Unreadable lock content (vanished mid-read, torn write, or an
        // unexpected shape like a directory at the lock path) and live
        // holders take the SAME bounded wait — an unreadable-but-present
        // lock must never spin unbounded (R4: the lock-path-is-a-directory
        // shape hung the original loop).
        sleepSync(25);
      }
      if (Date.now() > deadline) {
        throw new Error(`approval-token store lock could not be acquired (another process holds ${lockPath})`, {
          cause: error,
        });
      }
    }
  }
  try {
    writeFileSync(fd, owner, { encoding: 'utf8' });
    return fn();
  } finally {
    closeSync(fd);
    // Ownership-verified release: unlink only the lock we still own, or
    // the EMPTY lock a failed owner write left behind (R5: a fresh
    // unparseable lock waits out the full 10s mtime backstop before any
    // breaker can claim it — releasing it here keeps one transient write
    // failure from stalling every store mutation; no one can hold a
    // legitimate claim on microseconds-old empty content).
    const finalOwner = readLockOwner(lockPath);
    if (finalOwner === owner || finalOwner === '') {
      try {
        unlinkSync(lockPath);
      } catch {
        // Best effort — the stale break will reclaim it.
      }
    }
  }
}

function sha256Hex(data) {
  return createHash('sha256').update(data).digest('hex');
}

// A positional value whose PRECEDING token names a secret (config set-env
// HUAWEICLOUD_SDK_AK <value>, --api-key <value>, obsutil -i <ak>) must be
// scrubbed from every display/storage surface — redactSecrets only covers
// key[:=]value shapes, so bare positionals would otherwise ride
// argsRedacted into approvals.json at rest. Shared by the store's
// create(), the binding comparison below, and every wrapper's display
// surfaces.
// Bearer detection is CONTEXT-based, never shape-based on the positional
// itself: (a) any dash-flag token with a secret-sounding name, (b) the
// NAME slot of `config set-env NAME VALUE` (bare AK/SK env names match
// there — the slot is unambiguous), (c) for the hcloud CLI, the obsutil
// short flags -i/-k/-t. An ordinary positional (a memory space named
// my-task / auth-token / PROD_SK / MY_TOKEN) is NEVER a bearer — treating
// one as such corrupts the approval display and, via the scrub-tolerant
// binding comparison, makes the successor token freely substitutable.
// The bare ak/sk flag suffixes are SEPARATOR-GATED ([_-]ak|sk): 'flask',
// 'task' must not match. And a dash-prefixed successor is never scrubbed:
// no measured secret value is dash-prefixed, and scrubbing a flag token is
// exactly the display-corruption class.
const SECRET_FLAG_NAME_RE =
  /(?:api[_-]?key|access[_-]?key|secret[_-]?key|admin[_-]?pass|token|credential|password|passwd|[_-](?:ak|sk))$/i;
// Env-var names and config-set KEYS (dotted keys like env.access_key are
// the natural config-set spelling): separator class includes '.' for the
// key context.
const SECRET_ENV_NAME_RE =
  /^(?:.*[._-])?(?:ak|sk|api[_-]?key|access[_-]?key|secret[_-]?key|token|credential|password|passwd)$/i;
// Exact-token forced secrets: the bearer short flag (-bt, any case) —
// argv-rejected by the wrapper, but the REJECTION payload must not echo
// its value.
function isForcedSecretFlag(prev) {
  return /^-bt$/i.test(prev);
}

// The obsutil credential dialect is scoped to the hcloud CLI AND the OBS
// family. Service resolution: the first non-dash token — UNLESS a bare
// (non-inline) dash flag immediately precedes it, in which case the
// "service" may be that flag's VALUE (a separated --cli-region cn-north-4
// prefix, invalid at run but plan/store surfaces run first) and the
// position is AMBIGUOUS. In the ambiguous case the obsutil scrub applies
// conservatively: over-scrubbing -i/-k/-t in an already-invalid argv is
// harmless, while missing credentials leaks at rest.
function obsutilDialectApplies(args) {
  const idx = args.findIndex((a) => !String(a).startsWith('-'));
  if (idx === -1) return false;
  if (String(args[idx]).toUpperCase() === 'OBS') return true;
  const prev = idx > 0 ? String(args[idx - 1]) : null;
  return prev !== null && /^--?[A-Za-z0-9_.-]+$/.test(prev) && !prev.includes('=');
}

// Attached obsutil credential shapes only (-iAK, -i=AK, -kSK, -tTOKEN):
// the value starts with '=' or an uppercase letter/digit/underscore
// (Huawei AK/SK/token charset). Word-form obsutil OPTIONS — -include,
// -threshold, -tempFileDir, -timeRange, core cp syntax per `OBS help cp`
// — start with a lowercase letter and must stay visible.
const OBSUTIL_ATTACHED_RE = /^-[ikt](?:=|[A-Z0-9_])/;

export function scrubPositionalSecrets(args, cli = null) {
  const scrubbed = [...(Array.isArray(args) ? args : []).map(String)];
  const obsutil = cli === 'hcloud' && obsutilDialectApplies(scrubbed);
  // Pass 1: attached obsutil credentials, ANY position (a trailing
  // -iAK has no successor iteration, so the successor scan alone would
  // miss it). Rewrite PRESERVING the flag letter (-i<redacted>): the form
  // round-trips — a retry with any attached spelling (-iNEW, -i=NEW)
  // scrubs to the same shape and passes the binding, while a literal
  // -i<redacted> echo is rejected by the placeholder guard.
  if (obsutil) {
    for (let i = 0; i < scrubbed.length; i += 1) {
      if (OBSUTIL_ATTACHED_RE.test(scrubbed[i])) {
        scrubbed[i] = `${scrubbed[i].slice(0, 2)}<redacted>`;
      }
    }
  }
  // Bearer forms with the value INSIDE the token — neither pass 2's
  // successor scan nor redactSecrets' name-based masking catches them:
  // -bt=SECRET (click 8.1.6 multi-char short option with '='),
  // -btSECRET (attached, click-invalid but must not ride a rejection
  // payload), any case (-BT, -Bt), and the attached long form. Rewrite
  // preserving the flag so any rejection payload / argsRedacted stays
  // clean — the plan layer rejects the argv outright anyway.
  for (let i = 0; i < scrubbed.length; i += 1) {
    const t = scrubbed[i];
    if (/^-bt=/i.test(t)) {
      scrubbed[i] = '-bt=<redacted>';
    } else if (/^-bt/i.test(t) && t.length > 3) {
      scrubbed[i] = '-bt<redacted>';
    } else if (/^--bearer-token/i.test(t) && t.length > '--bearer-token'.length && !t.includes('=')) {
      scrubbed[i] = '--bearer-token<redacted>';
    }
  }
  // Pass 2: successor scan — separated obsutil shorts, forced secret
  // flags, generic flags, and the config set/set-env key slots.
  for (let i = 1; i < scrubbed.length; i += 1) {
    const prev = scrubbed[i - 1];
    if (/^-/.test(scrubbed[i])) continue;
    let bearer = null;
    if (isForcedSecretFlag(prev)) bearer = 'forced';
    else if (obsutil && /^-[ikt]$/.test(prev)) bearer = 'obsutil';
    else if (/^--?[A-Za-z0-9_.-]+$/.test(prev)) bearer = 'flag';
    // The set-env NAME slot AND the `config set KEY VALUE` slot (the
    // taught fallback when set-env crashes on basic-template projects):
    // the KEY at i-1 following config|configure set|set-env at i-2. A
    // memory-family NAME positional never sits in that shape.
    else if (
      ['set-env', 'set'].includes(String(scrubbed[i - 2]).toLowerCase()) &&
      ['config', 'configure'].includes(String(scrubbed[i - 3]).toLowerCase())
    )
      bearer = 'env';
    if (!bearer) continue;
    if (bearer === 'obsutil' || bearer === 'forced') {
      if (scrubbed[i] !== '<redacted>') scrubbed[i] = '<redacted>';
      continue;
    }
    const flagMatch = prev.match(/^--?([A-Za-z0-9_.-]+)$/);
    const name = flagMatch ? flagMatch[1] : prev;
    const nameRe = bearer === 'env' ? SECRET_ENV_NAME_RE : SECRET_FLAG_NAME_RE;
    if (nameRe.test(name) && scrubbed[i] !== '<redacted>') {
      scrubbed[i] = '<redacted>';
    }
  }
  return scrubbed;
}

// Binding check shared by every CLI wrapper's approved runner. Order
// matters: (1) the token hash binds the EXACT approved args — a
// hash-exact replay is the approved command, even when an arg
// legitimately contains the literal '<redacted>' (an invoke payload, a
// description); a scrubbed copy can never hash-match (the stored hash is
// over the raw args). (2) Any arg CONTAINING '<redacted>' — bare
// placeholder or the inline --param=<redacted> form the plan displays
// for KooCLI-style parameters — is rejected on the fallback path:
// executing the placeholder would silently write the literal string as
// the secret. (3) Scrub-tolerance ONLY for replaced secret values (the
// documented replacement flow — both sides scrub through the same
// scrubber).
export function argsMatchPlanBinding(stored, providedArgs) {
  const provided = (Array.isArray(providedArgs) ? providedArgs : []).map(String);
  const cli = stored.cli || 'hcloud';
  if (hashNamespacedArgs(cli, provided) === stored.argsHash) return { ok: true };
  if (provided.some((a) => a.includes('<redacted>'))) return { ok: false, reason: 'placeholder' };
  const storedRedacted = JSON.stringify(stored.argsRedacted);
  const providedRedacted = JSON.stringify(scrubPositionalSecrets(redactSecrets(provided), cli));
  return storedRedacted === providedRedacted ? { ok: true } : { ok: false, reason: 'mismatch' };
}

export function hashNamespacedArgs(cli, args) {
  return sha256Hex(JSON.stringify({ cli, args: (Array.isArray(args) ? args : []).map(String) }));
}

function readApprovals() {
  try {
    const path = approvalFilePath();
    if (!existsSync(path)) return {};
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

// Fail CLOSED (R2 review round): a write failure must not let create or
// consume report success without persistence — the old swallow let a
// consume return the entry with the tombstone never written, and a replay
// re-executed an approved write. Callers surface the fs error.
function writeApprovals(map) {
  const path = approvalFilePath();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(map), { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, path);
}

function pruneStale(map, now = Date.now()) {
  let changed = false;
  for (const [key, value] of Object.entries(map)) {
    // Tombstones age from CONSUMPTION (R2): a consumed entry survives
    // TOMBSTONE_TTL_MS past its consumedAt so slow approvals keep the
    // already_processed replay semantics instead of degrading to
    // not_found's re-plan advice.
    if (value.consumedAt !== undefined) {
      if (now - value.consumedAt > TOMBSTONE_TTL_MS) {
        delete map[key];
        changed = true;
      }
      continue;
    }
    if (now - value.createdAt > APPROVAL_TTL_MS) {
      delete map[key];
      changed = true;
    }
  }
  return changed;
}

// Approval token lifecycle states, surfaced to callers so they can emit the
// precise JSON contract required by D4-24 (#745):
//   'valid'            — token exists, not expired, not yet consumed
//   'expired'          — token exists but createdAt is past APPROVAL_TTL_MS
//   'already_consumed' — token was consumed on a prior call (tombstone kept)
//   'not_found'        — token was never created, pruned, or minted by a
//                        different CLI namespace
export const TOKEN_STATE_VALID = 'valid';
export const TOKEN_STATE_EXPIRED = 'expired';
export const TOKEN_STATE_ALREADY_CONSUMED = 'already_consumed';
export const TOKEN_STATE_NOT_FOUND = 'not_found';

function entryBelongsToCli(entry, cli) {
  // Entries written before the namespace split carry no cli field; they are
  // hcloud tokens (the only pre-existing wrapper).
  return (entry.cli || 'hcloud') === cli;
}

export function createApprovalTokenStore(cli) {
  const create = (rawArgs) =>
    withStoreLock(() => {
      const token = randomUUID();
      const map = readApprovals();
      map[token] = {
        cli,
        argsHash: hashNamespacedArgs(cli, rawArgs),
        argsRedacted: scrubPositionalSecrets(redactSecrets(rawArgs), cli),
        createdAt: Date.now(),
      };
      pruneStale(map);
      writeApprovals(map);
      return token;
    });

  const inspect = (token) => {
    const map = readApprovals();
    const entry = map[token];
    if (!entry || !entryBelongsToCli(entry, cli)) return { state: TOKEN_STATE_NOT_FOUND };
    if (entry.consumedAt !== undefined) return { state: TOKEN_STATE_ALREADY_CONSUMED };
    if (Date.now() - entry.createdAt > APPROVAL_TTL_MS) return { state: TOKEN_STATE_EXPIRED };
    return { state: TOKEN_STATE_VALID, entry };
  };

  const consume = (token) =>
    withStoreLock(() => {
      const map = readApprovals();
      const entry = map[token];
      if (!entry || !entryBelongsToCli(entry, cli)) return null;
      if (entry.consumedAt !== undefined) return null;
      if (Date.now() - entry.createdAt > APPROVAL_TTL_MS) {
        delete map[token];
        writeApprovals(map);
        return null;
      }
      map[token] = { cli, consumedAt: Date.now(), createdAt: entry.createdAt };
      writeApprovals(map);
      return entry;
    });

  return {
    create,
    inspect,
    consume,
    hashArgs: (args) => hashNamespacedArgs(cli, args),
  };
}
