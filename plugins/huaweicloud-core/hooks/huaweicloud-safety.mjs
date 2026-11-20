import { existsSync, readFileSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// npm tarballs and built checkouts carry dist/; a raw git or marketplace copy
// of the plugin does not. Prefer the compiled module and fall back to the
// TypeScript source (Node >= 22.18 strips types outside node_modules) so the
// PreToolUse safety gate keeps running instead of crashing open. Staleness
// is out of scope: a dist built from an older source tree imports fine and
// silently runs the old classifier — freshness is the build/install chain's
// job, not the hook's.

const DENY_PREFIX = 'Huawei Cloud safety hook blocked this action: ';

const POLICY_LOAD_FAILED_REASON =
  'the safety policy failed to load; commands are denied fail-closed. Reinstall the huaweicloud-devkit plugin.';

// Distinct from the load failure (interrogate round 3): the policy parsed
// fine and the crash happened INSIDE classification (a truncated
// cloud-risk-rules.json) — the reason names the actual break so the
// reinstall actually fixes it.
const CLASSIFY_FAILED_REASON =
  'the safety classifier failed to run (corrupt safety rules?); commands are denied fail-closed. Reinstall the huaweicloud-devkit plugin.';

function commandText(toolInput) {
  if (typeof toolInput === 'string') return toolInput;
  if (toolInput && typeof toolInput === 'object') {
    const values = [];
    for (const key of ['command', 'cmd', 'script', 'args', 'arguments']) {
      const value = toolInput[key];
      if (Array.isArray(value)) values.push(value.map(String).join(' '));
      else if (value !== undefined && value !== null) values.push(String(value));
    }
    if (values.length > 0) return values.join('\n');
    return JSON.stringify(toolInput);
  }
  return JSON.stringify(toolInput);
}

function deny(reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: DENY_PREFIX + reason,
      },
    }) + '\n',
  );
}

// A payload too broken to load its own policy (missing/corrupt policy.json —
// DEFAULT_POLICY throws at module load) cannot classify safely either: deny
// fail-closed instead of dying with no verdict, which a PreToolUse harness
// reads as "allow" (the py twin's fail-closed posture, interrogate round 1).
// The verdict is written SYNCHRONOUSLY before the exit (interrogate round 2):
// process.exit() does not wait for pending async pipe writes, and a dropped
// fail-closed verdict reads as allow — the exact failure this guard prevents.
// (The deny() placement above is cosmetic, not semantic: function
// declarations hoist, so the import could sit anywhere; it reads best here.)
let classifyTextCommand;
// The approval-gate roster, imported from the same place the policy came
// from (compiled dist/ preferred, TypeScript source fallback — the roster
// is a pure string-array module, so the fallback needs no build). The
// roster is NOT load-bearing for the classifier: an unresolvable roster
// falls back to EMPTY, which narrows to trunk behavior — every
// write/execution deny stands, no exemption fires — so no safety
// property is lost and the staleness contract keeps holding. Round 9,
// finding 2: this import used to share the policy's try block, so a
// dist built before approval-roster.js existed (a stale checkout — dist
// is gitignored, a pull does not rebuild) threw, the catch denied EVERY
// Bash payload as "the safety policy failed to load" (wrong cause: the
// policy loaded fine), and the hook's own staleness contract ("an
// older dist silently runs the old classifier") inverted into
// "classifier unavailable". The empty-roster fallback is the fail-closed
// posture FOR THE EXEMPTION; only a policy load failure fails the
// classifier.
//
// Round 10, finding 3: the roster leaf also carries each member's
// payload-shape row (APPROVAL_TOOL_INPUT_SHAPES — the run face an args
// array, PR-3a's exec faces a command string). An older leaf (no such
// export) degrades to an empty table, and the per-tool fallback below
// covers the transition.
let rosterApprovalTools;
let rosterInputShapes;
let policyModule;
try {
  policyModule = existsSync(join(__dirname, '..', 'dist', 'safety-policy.js'))
    ? await import('../dist/safety-policy.js')
    : await import('../src/safety-policy.ts');
  ({ classifyTextCommand } = policyModule);
} catch {
  writeSync(
    1,
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: DENY_PREFIX + POLICY_LOAD_FAILED_REASON,
      },
    }) + '\n',
  );
  process.exit(0);
}

// The load-time behavior self-check (the integrity unit's layer 2, the
// opencode safety-gate adapter's twin): an import that succeeds is not yet
// a classifier — a stale replacement, a truncated overwrite, or a bad
// upgrade can hand over a module that is shaped right and decides wrong.
// Three canaries run before the module is trusted: the export shape, a
// canonical write vector (must deny), and a canonical benign read (must
// allow); any failure denies fail-closed with the self-check reason before
// main() runs. This runs per hook invocation (a fresh process per Bash
// call) and catches NON-adversarial corruption; the crafted module that
// passes the canaries is the documented residual the doctor drift check
// (layer 3) owns. The reason literal is pinned byte-identical to the
// adapter's by the safety-gate test.
const SELF_CHECK_FAILED_REASON =
  'the deployed safety policy failed its load-time self-check (shape or behavior canary); commands are denied fail-closed. Reinstall the huaweicloud-devkit plugin.';
const CANARY_WRITE_VECTOR = 'hcloud ECS DeleteServers --server.id=x';
const CANARY_BENIGN_READ = 'ls /tmp';

function policySelfCheckFailed(module) {
  if (typeof module.classifyTextCommand !== 'function') return true;
  try {
    if (module.classifyTextCommand(CANARY_WRITE_VECTOR).decision !== 'deny') return true;
    if (module.classifyTextCommand(CANARY_BENIGN_READ).decision !== 'allow') return true;
  } catch {
    return true;
  }
  return false;
}

if (policySelfCheckFailed(policyModule)) {
  writeSync(
    1,
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: DENY_PREFIX + SELF_CHECK_FAILED_REASON,
      },
    }) + '\n',
  );
  process.exit(0);
}
try {
  const rosterModule = existsSync(join(__dirname, '..', 'dist', 'approval-roster.js'))
    ? await import('../dist/approval-roster.js')
    : await import('../src/approval-roster.ts');
  ({ APPROVAL_TOOLS: rosterApprovalTools, APPROVAL_TOOL_INPUT_SHAPES: rosterInputShapes } = rosterModule);
} catch {
  // A dist predating the roster (stale checkout) or any other resolution
  // failure: run with the empty roster — no exemption fires, every deny
  // stands. Strictly safer than the total block this replaced, and the
  // deny message is not misattributed to the policy.
  rosterApprovalTools = [];
  rosterInputShapes = [];
}

function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

// The roster exemption (the approval-chain core PR): a call attributable
// to the devkit server's roster tool skips ONLY the deny classes the
// dispatch-layer approval gate owns, and the skip set is
// payload-shape-scoped (round 10, finding 3):
//   - args-array tools (the hcloud run face): write/execution — the spec
//     binds a token, a human grant, and a pin view before anything
//     executes. The hook's destructive class KEEPS denying for them: an
//     argv payload never carries shell text the server classifies, and
//     the r1/r2 batteries pinned exactly this split.
//   - command-string tools (PR-3a's exec faces): write/execution AND
//     destructive — the command IS the payload, and the server gate's
//     classified flow (token mint → confirm → strict classification,
//     the plan's PR-3a lanes) owns the whole command content; without
//     the destructive skip the plan's own lane-2 command (rm -rf) could
//     never reach the server gate the plan bets on.
//   - structured tools (PR-3a's lifecycle faces, PR-3b's auth pair,
//     PR-3c's registrations): NO exemption, by their shape row's
//     declaration — a present row the hook does not exempt returns no
//     class, and full classification stands, so a stuffed command string
//     or args array on those names can never borrow an exempt class. The
//     auth pair rides the same class: its named credential fields are a
//     no-command-surface payload, and the server gate does not classify
//     that payload text, so the hook's text deny stays as a belt. PR-3c's
//     payloads (obs config, upgrade, secret_delete, packs_configure)
//     classify allow as real text (measured), so their calls reach the
//     server gate with every deny class still armed.
// Every other deny — credential-file reads, secret reveals, invalid
// input — stays in force for roster calls too, because the server gate
// does not replicate them at the hook's breadth (interrogate round 1:
// the argv classifier never consults credentialFilePatterns).
//
// Attribution is shape-scoped (interrogate rounds 1-2) and PER-TOOL
// (round 10, finding 3): each roster member's payload shape row lives in
// the roster leaf's APPROVAL_TOOL_INPUT_SHAPES, and a payload is exempt
// only when it matches ITS tool's row. The run face's row is the args
// array with none of the other text keys present — a command string
// riding its name (the round-1/round-2 foreign-suffix smuggle) still
// fails, whatever server sent it. The exec faces' row (PR-3a's
// registrations) is the command string their pinned schema actually
// carries — without a row for them, their real payload shape could never
// satisfy the test, so PR-3a's registrations could never reach the
// server gate on hook-bearing harnesses. A roster member with NO row
// (an older roster leaf, or the transition window while PR-3 lands)
// admits only the two known devkit payload shapes — and the
// command-bearing class only on the tool's EXACT name, so a foreign
// suffixed name cannot reach the command shape through the fallback; a
// present commandString row matches like any other row (the devkit's
// own prefixed calls must reach it). The residual is unchanged: a
// foreign tool that copies both the name and the shape is
// indistinguishable from the devkit at the hook layer; a hostile MCP
// server was always outside the hook's trust boundary.
const TEXT_KEYS_COMMAND_TEXT_READS = ['command', 'cmd', 'script', 'arguments'];

function matchesArgsArrayShape(args) {
  return Array.isArray(args.args) && TEXT_KEYS_COMMAND_TEXT_READS.every((key) => args[key] === undefined);
}

function matchesCommandStringShape(args) {
  return (
    typeof args.command === 'string' &&
    args.args === undefined &&
    TEXT_KEYS_COMMAND_TEXT_READS.every((key) => key === 'command' || args[key] === undefined)
  );
}

// The payload-shape class a roster-attributed call matched, or undefined
// when the call is not exempt: 'argsArray' or 'commandString' (the skip
// set differs between them, so the caller needs the class, not a
// boolean).
function rosterExemptionShape(toolName, toolInput) {
  if (typeof toolName !== 'string' || !Array.isArray(rosterApprovalTools)) return undefined;
  const args = (toolInput ?? {}) || {};
  const exact = rosterApprovalTools.find((tool) => toolName === tool);
  const matched = exact !== undefined ? exact : rosterApprovalTools.find((tool) => toolName.endsWith('_' + tool));
  if (matched === undefined) return undefined;
  const shape = (rosterInputShapes ?? {})[matched];
  if (shape === 'commandString') return matchesCommandStringShape(args) ? 'commandString' : undefined;
  if (shape === 'argsArray') return matchesArgsArrayShape(args) ? 'argsArray' : undefined;
  // A PRESENT row the hook does not exempt ('structured': a payload with
  // no command surface — PR-3a's lifecycle faces, PR-3b's auth pair,
  // PR-3c's registrations) never falls through to the transition fallback
  // — the fallback admits the two devkit shapes on the exact name, so a
  // structured tool with a stuffed `command` string or `args` array must
  // not be able to borrow an exempt class. Full classification stands.
  if (shape !== undefined) return undefined;
  // No shape row (an older roster leaf, or the transition window while
  // PR-3 lands): the two known devkit payload shapes, with the
  // command-bearing class restricted to the exact tool name (a foreign
  // suffixed impostor cannot reach it).
  if (matchesArgsArrayShape(args)) return 'argsArray';
  if (exact !== undefined && matchesCommandStringShape(args)) return 'commandString';
  return undefined;
}

function main() {
  const input = readStdin();
  let data;
  try {
    data = JSON.parse(input);
  } catch {
    return;
  }

  const text = commandText(data.tool_input ?? {});
  // Classify-time failure is the same contract as load-time (interrogate
  // round 2): a payload whose rules file dies mid-classification
  // (risk-rule-engine's JSON.parse) must deny fail-closed, not crash
  // verdict-less — which a PreToolUse harness reads as "allow". The natural
  // return after deny() lets the process drain (no exit race).
  let result;
  try {
    result = classifyTextCommand(text);
  } catch {
    deny(CLASSIFY_FAILED_REASON);
    return;
  }
  if (result.decision !== 'deny') return;
  // The exemption skips only the approval-gated classes for attributable
  // roster calls, scoped by the payload's shape class (the skip sets are
  // documented at rosterExemptionShape): args-array payloads skip
  // write/execution, command-string payloads — the exec faces whose
  // whole payload the server gate's classified flow owns — skip
  // write/execution/destructive. Every other deny stands, and nothing is
  // skipped before the classifier has produced a verdict.
  const exemptShape = rosterExemptionShape(data.tool_name, data.tool_input);
  if (exemptShape === 'argsArray' && (result.risk === 'write' || result.risk === 'execution')) {
    return;
  }
  if (
    exemptShape === 'commandString' &&
    (result.risk === 'write' || result.risk === 'execution' || result.risk === 'destructive')
  ) {
    return;
  }
  deny(result.reason);
}

main();
