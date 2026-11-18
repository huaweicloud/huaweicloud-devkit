// The OpenCode >= 2.0 shell-face safety gate (architecture B, in-process):
// registers permission.hook("evaluate") and denies shell commands the
// devkit's text classifier refuses — credential-file reads, env dumps,
// unapproved hcloud writes, destructive rows. MCP tool actions are named
// "huaweicloud-devkit_<tool>" and never match the shell check: that face is
// the server approval gate's own surface (formal verification: safe in
// every posture), so the adapter stays zero-intervention there.
//
// Same deployment seam as skill-tracker.js (this directory, one bare file
// per plugin): the installer copies this file beside it, and the classifier
// is the deployed payload's compiled module — the same dist/safety-policy.js
// every other face reads, never a second implementation.

const DENY_PREFIX = 'Huawei Cloud safety hook blocked this action: ';

const POLICY_LOAD_FAILED_REASON =
  'the safety policy failed to load; commands are denied fail-closed. Reinstall the huaweicloud-devkit plugin.';

const CLASSIFY_FAILED_REASON =
  'the safety classifier failed to run (corrupt safety rules?); commands are denied fail-closed. Reinstall the huaweicloud-devkit plugin.';

// Resolved relative to this file: the payload root convention skill-tracker
// uses (plugins/ and huaweicloud-plugins/ are siblings under the opencode
// config root). A deployed payload always carries dist/ (copyServerPayload
// ships it), so an import failure means a broken install — denied
// fail-closed below, never silently un-gated. No src fallback: unlike a raw
// checkout, a deployed payload is never unbuilt.
const POLICY_URL = new URL('../huaweicloud-plugins/dist/safety-policy.js', import.meta.url);

// The host has NO evaluate timeout (G1-M3: a full 30s wait, measured), so
// anything unbounded inside the handler is a hang vector. The one policy
// import races a 3s fail-closed bound: a module that never settles
// (interrogate round: a rewritten policy with a top-level forever-pending
// promise) denies instead of hanging the tool call. Any failed or lost
// race clears the cache so a later call retries — a mid-session reinstall
// heals without a host restart, and a late-settling import re-races
// cheaply (the ESM registry caches the evaluation).
const IMPORT_RACE_MS = 3000;

// The classification walk is synchronous per segment, but its cost grows
// quadratically with ';'-dense text (interrogate round: 96KB of flood took
// 213s at an allow verdict — the 256KiB cap inside the classifier protects
// nothing at this seam, and the old comment's "cannot hang a tool call"
// claim was measured false). Each segment is therefore capped at 8192
// bytes BEFORE classification: the quadratic worst case lands in the
// 1.5-2s order of a real tool call, real commands sit far below the cap,
// and the sanctioned path for oversized parameters is --cli-jsonInput,
// which the deny reason names.
const SEGMENT_BYTE_CAP = 8192;

let classifyTextCommand;
let policyLoading = null;

function loadPolicy() {
  if (!policyLoading) {
    let cancelBound;
    const bound = new Promise((_, reject) => {
      cancelBound = setTimeout(
        () => reject(new Error('the policy import did not settle within the 3s race bound')),
        IMPORT_RACE_MS,
      );
    });
    policyLoading = Promise.race([import(POLICY_URL), bound]).then(
      (module) => {
        clearTimeout(cancelBound);
        classifyTextCommand = module.classifyTextCommand;
      },
      (error) => {
        clearTimeout(cancelBound);
        policyLoading = null;
        throw error;
      },
    );
  }
  return policyLoading;
}

// The clean deny path (G1-M1/M2): effect = "deny" + message is the
// host-documented refusal channel — the message becomes the model-visible
// rejection reason. Never rethrow: a thrown hook also denies (G1-M2
// measured), but the clean path keeps the cause readable.
function deny(event, reason) {
  event.effect = 'deny';
  event.message = DENY_PREFIX + reason;
}

// The host scanner splits compound commands into per-segment resources
// (`ls /tmp && hcloud …` arrives as ['ls /tmp', 'hcloud …']) and the host's
// own rule engine denies the operation when ANY segment denies — so the
// adapter classifies each segment independently and the first deny wins
// with its reason (interrogate round: the previous join(' ') erased the
// separators and the write segment rode through as one allow, live-proven
// — the faithful port of the host's per-resource semantics).
async function onEvaluate(event) {
  try {
    if (event.action !== 'shell') return;
    const resources = Array.isArray(event.resources) ? event.resources : [];
    const segments = [];
    for (const entry of resources) {
      const text = String(entry);
      if (text.trim() !== '') segments.push(text);
    }
    if (segments.length === 0) return;
    try {
      if (!classifyTextCommand) await loadPolicy();
    } catch {
      deny(event, POLICY_LOAD_FAILED_REASON);
      return;
    }
    for (const text of segments) {
      const bytes = Buffer.byteLength(text, 'utf8');
      if (bytes > SEGMENT_BYTE_CAP) {
        deny(
          event,
          `the command text is too large for synchronous in-hook classification (${bytes} bytes > ${SEGMENT_BYTE_CAP}); split the command or pass complex parameters via --cli-jsonInput`,
        );
        return;
      }
      try {
        const verdict = classifyTextCommand(text);
        if (verdict.decision === 'deny') {
          deny(event, verdict.reason);
          return;
        }
      } catch {
        // Classify-time failure is the .mjs twin's contract: a corrupt rules
        // file must deny, not crash verdict-less.
        deny(event, CLASSIFY_FAILED_REASON);
        return;
      }
    }
  } catch {
    // The belt over the whole body — never rethrow (G1-M2's rethrow deny is
    // the last line, this keeps the message clean instead).
    deny(event, CLASSIFY_FAILED_REASON);
  }
}

// The export is the plain { id, setup } object the V2 plugin loader's
// documented contract accepts ("one default export containing a unique
// plugin id and a setup function") — the shape herdr's auto-discovered
// agent-state plugin runs as on a real host, and what skill-tracker's
// identity-define fallback reduces to where @opencode/plugin is not
// resolvable. No Plugin.define resolution dance here: it would clone
// skill-tracker's createRequire block (the zero-new-duplication gate), and
// the two plugins must stay independently loadable anyway.
export default {
  id: 'huaweicloud-safety-gate',
  async setup(ctx) {
    await ctx.permission.hook('evaluate', onEvaluate);
    // A V2 host may invoke the setup return value unguarded, and
    // undefined is not callable — the skill-tracker precedent.
    return () => {};
  },
};
