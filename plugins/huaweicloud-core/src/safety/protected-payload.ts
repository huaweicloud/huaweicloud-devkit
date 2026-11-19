import type { RiskDecision } from '../risk-rule-engine.ts';
import { credentialFileCandidates } from './credential-path.ts';
import type { Policy } from './default-policy.ts';

// The payload path-write gate (the integrity unit's layer 1): a
// write-shaped shell command that targets the DEPLOYED devkit payload —
// the classifier files the in-process gates import — denies. The residual
// it closes: PR #22's seam killed the edit-tool vector on the deployed
// classifier, but the bash face could still `echo '<permissive>' >
// …/dist/safety-policy.js` and the adapter's lazy, retryable import loaded
// the agent's file, disarming every in-process gate mid-session (the TLA
// counterexample path). READ-shaped references stay allowed: skills reads,
// skill-tracker, doctor, and plain `cat`/`ls`/`grep` over the payload tree
// are legitimate agent surface.
//
// Write-shape spec (mirrored by the py twin's evaluate gate — keep the two
// byte-identical in verdicts):
//   candidates: raw text, quote-stripped shadow, path-normalized both (the
//     credentialFileCandidates doctrine — a quote pair inside the path or a
//     redundant `//`/`./` segment must not hide the marker);
//   chunks: each candidate splits on [;&|\n\r] — a crude split, deliberately:
//     it can only over-SPLIT (a separator inside quotes is part of a FILE
//     NAME, and a real payload path never carries one), never join, so a
//     detection can only be lost on non-payload targets;
//   shapes, per chunk (MARKER = the policy alternation):
//     1. redirect      />>?[^;&|]*MARKER/          — target-side marker
//     2. tee           anchor + tee … MARKER       — tee's operands are targets
//     3. cp|mv|rsync|install  anchor + … final word carries MARKER (dest)
//     4. dd            anchor + … of=… MARKER     — of= is the output
//     5. sed           anchor + … -i … MARKER     — in-place edit target
//     6. patch         anchor + … MARKER          — operand is the target
//   anchor: chunk start, optional env assignments, then optional
//     sudo/env/nice/nohup/command/xargs heads — command position for the
//     write verbs, so `grep tee <marker-file>` (a read) never trips.
// Whitespace classes are [ \t] (bash IFS without newline — chunks carry no
// newlines), keeping JS/py classes identical.
//
// Honest ceiling (documented, not closed): quote/variable indirection
// building the marker path, `cp -t`-style flag targets, timeout-wrapped
// write verbs, and verbs outside the shape table (truncate/ln/…) are
// residuals of a text gate; rm/rename of payload files break the gate
// fail-closed at import time rather than disarm it. Against arbitrary
// user-permission bash NO purely local mechanism fully closes this — the
// layer-2 load-time canary and the layer-3 doctor drift check raise the
// escape cost to forging multiple artifacts.

// The shape fragments are shared verbatim with the py twin. Every \s in
// them is [ \t]; MARKER substitutes the policy alternation.
function shapeRegexes(markers: string[]): RegExp[] {
  if (markers.length === 0) return [];
  const markerAlt = `(?:${markers.join('|')})`;
  const anchor = String.raw`^[ \t]*(?:[A-Za-z_][A-Za-z0-9_]*=\S*[ \t]+)*(?:(?:sudo|env|nice|nohup|command|xargs)[ \t]+)*`;
  return [
    // 1. Redirection: the marker sits in the redirect's target region.
    // Direction is inherent — `cat <marker> > /tmp/out` keeps its marker
    // BEFORE the operator and never matches.
    new RegExp(String.raw`>>?[^;&|]*` + markerAlt, 'i'),
    // 2. tee: every operand is a write target.
    new RegExp(anchor + String.raw`tee\b[^;&|]*` + markerAlt, 'i'),
    // 3. The copy family: the destination is the LAST operand, so the
    // marker must ride the final word — `cp <marker> /tmp/` (a copy-out)
    // stays allowed.
    new RegExp(anchor + String.raw`(?:cp|mv|rsync|install)\b[^;&|]*[ \t]\S*` + markerAlt + String.raw`\S*[ \t]*$`, 'i'),
    // 4. dd: the of= operand is the output.
    new RegExp(anchor + String.raw`dd\b[^;&|]*\bof[ \t]*=[ \t]*[^;&|]*` + markerAlt, 'i'),
    // 5. sed: a whitespace-preceded -i flag (in-place) anywhere before the
    // marker; a read-only sed over the payload stays allowed.
    new RegExp(anchor + String.raw`sed\b[^;&|]*[ \t]-i\b[^;&|]*` + markerAlt, 'i'),
    // 6. patch: the operand is the file being patched.
    new RegExp(anchor + String.raw`patch\b[^;&|]*` + markerAlt, 'i'),
  ];
}

export function protectedPayloadWriteDenied(text: string, policy: Policy): RiskDecision | null {
  if (policy.protectedPayloadPathMarkers.length === 0) return null;
  const shapes = shapeRegexes(policy.protectedPayloadPathMarkers);
  // The candidates a path-bearing gate tests (the credential gate's set):
  // quoting and path redundancy must not hide the marker.
  for (const candidate of credentialFileCandidates(text)) {
    for (const chunk of candidate.split(/[;&|\n\r]/)) {
      for (const shape of shapes) {
        if (shape.test(chunk)) {
          return {
            decision: 'deny',
            // risk 'invalid': exempt from NO roster exemption class (the
            // .mjs/py hooks skip write/execution/destructive for exempt
            // shapes — a payload-write deny must never be skippable).
            risk: 'invalid',
            reason:
              "Writing to the deployed Huawei Cloud DevKit plugin payload is blocked: this command targets the installed safety policy files, and modifying them would disarm the gates that classify agent commands. Reinstall or update via npx huaweicloud-devkit install from your own terminal; see the huaweicloud-safety skill's approvals reference for the integrity model.",
          };
        }
      }
    }
  }
  return null;
}
