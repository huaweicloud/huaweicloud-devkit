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
// is a pure string-array module, so the fallback needs no build). A
// load failure takes the deny-fail-closed path below together with the
// policy: an exemption the hook cannot resolve must not silently widen.
let rosterApprovalTools;
try {
  const policyModule = existsSync(join(__dirname, '..', 'dist', 'safety-policy.js'))
    ? await import('../dist/safety-policy.js')
    : await import('../src/safety-policy.ts');
  ({ classifyTextCommand } = policyModule);
  const rosterModule = existsSync(join(__dirname, '..', 'dist', 'approval-roster.js'))
    ? await import('../dist/approval-roster.js')
    : await import('../src/approval-roster.ts');
  ({ APPROVAL_TOOLS: rosterApprovalTools } = rosterModule);
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

function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

// The roster exemption (the approval-chain core PR): a call attributable
// to the devkit server's roster tool skips ONLY the deny classes the
// dispatch-layer approval gate owns (write/execution — it binds a token,
// a human grant, and a pin view before anything executes). Every other
// deny — credential-file reads, secret reveals, invalid input — stays in
// force for roster calls too, because the server gate does not replicate
// them (interrogate round 1, finding 2: the argv classifier never consults
// credentialFilePatterns, and the exemption would have lifted the hook's
// only defense).
//
// Attribution is shape-scoped, not suffix-scoped (interrogate round 1,
// finding 1): a bare tool name equals the roster entry, or the harness's
// server-prefixed form must carry the roster tool's input shape — an args
// array and no Bash-shaped command/cmd/script string. The shape test keeps
// a user-renamed devkit server exempt while a foreign server's
// colliding tool name carrying a command string falls through to full
// classification (trunk's verdict). The residual: a foreign tool that
// copies both the name and the shape is indistinguishable from the devkit
// at the hook layer; a hostile MCP server was always outside the hook's
// trust boundary (it can dodge the harness matcher by its name alone).
function isRosterToolCall(toolName, toolInput) {
  if (typeof toolName !== 'string' || !Array.isArray(rosterApprovalTools)) return false;
  const args = (toolInput ?? {}) || {};
  const rosterShaped =
    Array.isArray(args.args) && args.command === undefined && args.cmd === undefined && args.script === undefined;
  return rosterApprovalTools.some((tool) => toolName === tool || (rosterShaped && toolName.endsWith('_' + tool)));
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
  // The exemption skips only the approval-gated classes (write/execution)
  // for attributable roster calls; every other deny stands, and nothing is
  // skipped before the classifier has produced a verdict.
  if (isRosterToolCall(data.tool_name, data.tool_input) && (result.risk === 'write' || result.risk === 'execution')) {
    return;
  }
  deny(result.reason);
}

main();
