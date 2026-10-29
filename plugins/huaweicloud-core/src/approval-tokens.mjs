import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { redactSecrets } from './safety-policy.mjs';

// Shared approval-token machinery, consumed by every CLI wrapper
// (hcloud-cli.mjs, agentarts-cli.mjs). Extracted from hcloud-cli.mjs so the
// cross-process persistence, TTL pruning, single-use tombstones, and atomic
// writes (#578, #745) have exactly one implementation.
//
// Cross-CLI confusion guard: the CLI id is mixed into the args hash AND
// stored on each entry, so a token minted by one wrapper can never approve
// another wrapper's command — `agentarts plan(['gateway','delete','x'])`
// cannot be consumed by `hcloud run_approved` with the same array.
//
// Only the sha256 of the namespaced args plus the redacted form are stored —
// never the raw args, which may carry secrets.

const APPROVAL_TTL_MS = 5 * 60_000;

function approvalFilePath() {
  return join(process.env.HUAWEICLOUD_HOME || homedir(), '.config', 'huaweicloud', 'approvals.json');
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

function writeApprovals(map) {
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

function pruneStale(map, now = Date.now()) {
  let changed = false;
  for (const [key, value] of Object.entries(map)) {
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
  const create = (rawArgs) => {
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
  };

  const inspect = (token) => {
    const map = readApprovals();
    const entry = map[token];
    if (!entry || !entryBelongsToCli(entry, cli)) return { state: TOKEN_STATE_NOT_FOUND };
    if (entry.consumedAt !== undefined) return { state: TOKEN_STATE_ALREADY_CONSUMED };
    if (Date.now() - entry.createdAt > APPROVAL_TTL_MS) return { state: TOKEN_STATE_EXPIRED };
    return { state: TOKEN_STATE_VALID, entry };
  };

  const consume = (token) => {
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
  };

  return {
    create,
    inspect,
    consume,
    hashArgs: (args) => hashNamespacedArgs(cli, args),
  };
}
