// hcloud command planning, extracted from the hcloud-cli monolith (the
// stable src/hcloud-cli.ts face re-exports planHcloudCommand and the plan
// types): the pre-execution contract — quoted command echo, risk
// classification, OBS/SG/parameter warnings, required-parameter
// validation, and the approval token. The consent layer itself lives in
// src/lib/approval-tokens.ts.
//
// The plan's approval posture is mode-dependent (HcloudPlanOptions.
// approvalMode): 'ask' (DEVKIT_APPROVAL_MODE=ask) plans for the SERVER-run
// confirmation — the approval gate raises an elicitation form, or the T3
// chat round-trip on a client that cannot render one — so no token is
// minted and userConfirmation carries the ask note instead of a terminal
// approve line; 'token' (the default) keeps the mint + approve line
// contract above.

import { classifyHcloudArgs, redactSecrets, stripExecutable, type ClassifyOptions } from './safety-policy.ts';
import { isHcloudToken } from './safety/tokens.ts';
import { createApprovalToken } from './lib/approval-tokens.ts';
import { foldSecretTokens, SECRET_KEY_TOKEN_RE, secretSegments } from './lib/supplemental-redaction.ts';
import type { ApprovalMode } from './lib/approval-mode.ts';
import type { RiskDecision } from './risk-rule-engine.ts';
import { obsWriteHint } from './hcloud-obs-redact.ts';
import { applyPreflightFindings, preflightSecurityGroupCheck, type SgFinding } from './hcloud-sg-preflight.ts';
import { triageUnknownService } from './hcloud-triage.ts';

// Approval tokens must survive a process boundary: plan and run land in
// different MCP sessions/processes (and headless subprocesses), so the old
// in-memory Map lost the token and plan→approve→run became unreachable (#578).
// The machinery lives in src/lib/approval-tokens.ts (the CLI face's
// consent layer for plan_cli_command / run_approved_command).

// The plan's terminal-confirmation block: `needed` says the command waits
// on a confirmation the user makes in their own terminal, `command` is the
// exact line they run (present only on plans that minted a token). Ask
// mode shifts the confirmation onto the server-run gate (a form, or the T3
// chat round-trip): `mode` names that posture and `note` teaches the run
// call that satisfies it — no `command` exists to name.
export interface HcloudPlanUserConfirmation {
  needed: boolean;
  command?: string;
  mode?: 'ask';
  note?: string;
}

export interface HcloudPlan {
  executable: string;
  args: string[];
  command: string;
  executableBlock: string;
  warnings: Array<string | SgFinding>;
  classification: RiskDecision;
  sgFindings: SgFinding[];
  // Present only when this call minted one: run paths pass
  // mintApprovalToken:false, so a run result never carries a fresh usable
  // token (the model leaves minting to the plan face).
  approvalToken?: string;
  userConfirmation: HcloudPlanUserConfirmation;
  safeToRun: boolean;
}

export interface HcloudPlanWithArgs extends HcloudPlan {
  rawArgs: string[];
}

export interface HcloudPlanOptions extends ClassifyOptions {
  // Catalog override for the unknown-service triage (tests); production
  // resolves through HCLOUD_META_DIR / the homedir default. Deliberately
  // operator-side only — never a tool argument an agent could aim at a fake
  // catalog to downgrade its own verdict.
  metaDir?: string;
  // False on run paths: only the plan face mints approval tokens. Defaults
  // true, so the plan tool face keeps its consent contract unchanged.
  mintApprovalToken?: boolean;
  // The approval posture this plan reports: 'ask' suppresses token minting
  // and describes the client-prompt confirmation in userConfirmation;
  // 'token' (the default) keeps the terminal gate. The tool faces resolve
  // it from DEVKIT_APPROVAL_MODE (lib/approval-mode.ts) — never a tool
  // argument an agent could set.
  approvalMode?: ApprovalMode;
}

// Does this command wait on the user's terminal confirmation? The verdict
// comes from the STRICT view — allowWrites forced false — never the
// caller's option, so an agent passing allowWrites:true cannot weaken it.
// Only write/execution denies answer true: secret, credential, and invalid
// denies are never unlockable by a terminal confirmation, and reads never
// need one.
export function needsUserConfirmation(args: string[], options: ClassifyOptions = {}): boolean {
  const strict = classifyHcloudArgs(args, { ...options, allowWrites: false });
  return strict.decision === 'deny' && (strict.risk === 'write' || strict.risk === 'execution');
}

export function quoteShellArg(value: unknown): string {
  const text = String(value);
  if (!text) return '""';
  if (/^[A-Za-z0-9_./:=@-]+$/.test(text)) return text;
  return `"${text.replace(/(["\\])/g, '\\$1')}"`;
}

// One redacted echo argument: the real argument's quoting shape with the
// value text replaced. A real argument quoteShellArg leaves bare stays bare
// (so a safe-charset substitution is the gate's plain line); one it would
// quote gets the same wrapper around the redacted spelling (so a
// shell-special substitution is the gate's quoted line).
function redactedCommandArg(raw: string, redacted: string): string {
  if (quoteShellArg(raw) === raw) return redacted;
  return `"${redacted.replace(/(["\\])/g, '\\$1')}"`;
}

// The accepted executable lines for a normalized argument list: the
// command-forward `command` field must equal one of them exactly. The plain
// space-joined line is the contract's stated anchor; the shell-quoted line is
// this module's own echo (plan.command), so a model that forwards the plan's
// echo verbatim passes too. The two coincide for the ordinary case (service,
// operation, --key=value) and differ only where an argument carries a space,
// a quote, or another character the echo has to quote.
export function hcloudExecutableLines(normalizedArgs: readonly string[]): string[] {
  const plain = ['hcloud', ...normalizedArgs].join(' ');
  const quoted = ['hcloud', ...normalizedArgs].map((arg) => quoteShellArg(arg)).join(' ');
  return plain === quoted ? [plain] : [plain, quoted];
}

function planningWarnings(args: string[]): string[] {
  const joined = args.join(' ');
  const warnings: string[] = [];
  if (/admin[_-]?pass|password|passwd|secret|token/i.test(joined)) {
    warnings.push(
      'This command appears to contain a password or secret field. Do not leave plaintext secrets in shell history; prefer local-only input or a runtime injection pattern.',
    );
  }
  return warnings;
}

// The FunctionGraph CreateFunction contract (#815 / D3-S6), as KooCLI flags.
// The request body names some of these fields differently — `function_name` for
// the function name, `code.filename` / `code.zip_file` for the code payload —
// and each release reported the missing field under whichever body name its
// validation reached first, so one defect surfaced as function_name,
// code.filename and code.zip_file in turn. Both spellings are recognized here,
// always reported under the canonical flag, and a body-name spelling is called
// out as a correction instead of quietly satisfying the check.
export const FUNCTIONGRAPH_CREATE_REQUIRED = [
  'func_name',
  'package',
  'runtime',
  'handler',
  'memory_size',
  'timeout',
  'code_type',
];

// One of these must also be present; which one is valid follows from --code_type.
export const FUNCTIONGRAPH_CODE_SOURCE = ['func_code.file', 'code_filename', 'code_url'];

export const FUNCTIONGRAPH_CREATE_ALIASES: Readonly<Record<string, string>> = {
  function_name: 'func_name',
  funcname: 'func_name',
  'code.filename': 'code_filename',
  'code.zip_file': 'func_code.file',
  code_file: 'func_code.file',
};

const REQUIRED_PARAMS: Record<string, string[]> = {
  'ECS CreateServers': ['server.flavorRef', 'server.imageRef', 'server.nics.1.subnet_id'],
  'VPC CreateVpc': ['vpc.cidr'],
  'VPC CreateSubnet': ['subnet.vpc_id', 'subnet.cidr'],
  'VPC CreateSecurityGroupRule': [
    'security_group_rule.security_group_id',
    'security_group_rule.direction',
    'security_group_rule.protocol',
  ],
  'EIP CreatePublicip': ['bandwidth.share_type', 'publicip.type'],
  'FunctionGraph CreateFunction': FUNCTIONGRAPH_CREATE_REQUIRED,
  'FunctionGraph CreateFunctionTrigger': ['function_urn', 'trigger_type_code'],
  'APIG CreateInstanceV2': ['spec_id'],
  'OBS mb': ['obs://'],
  'OBS rm': ['obs://'],
};

// Operations whose required set has interchangeable members: any one of the
// listed keys satisfies the group, so a caller is never asked for two shapes of
// the same value at once (inline code vs zip file name vs OBS URL).
const REQUIRED_PARAM_GROUPS: Record<string, Array<{ anyOf: string[]; report: string }>> = {
  'FunctionGraph CreateFunction': [
    {
      anyOf: FUNCTIONGRAPH_CODE_SOURCE,
      report: 'func_code.file (code_type=inline) | code_filename (code_type=zip) | code_url (code_type=obs)',
    },
  ],
};

const PARAM_VALUE_HINTS: Record<string, string> = {
  'server.flavorRef': 'Run `hcloud ECS ListFlavors --cli-region=<r>` to find valid flavors',
  'server.imageRef': 'Run `hcloud IMS ListImages --cli-region=<r> --__imagetype=gold` to find image IDs',
  'server.nics.1.subnet_id': 'Run `hcloud VPC ListSubnets --cli-region=<r>` to find subnet IDs',
  'subnet.vpc_id': 'Run `hcloud VPC ListVpcs --cli-region=<r>` to find VPC IDs',
  func_name: 'Function name must be unique within project',
  runtime: 'Run `hcloud FunctionGraph ListRuntimes` to see available runtimes',
  code_type: 'inline (func_code.file) | zip/jar (code_filename) | obs (code_url) — prefer inline for small code',
  'func_code.file': 'Base64-encoded code for code_type=inline',
  spec_id: 'APIG spec: BASIC (no public IP) or PROFESSIONAL (requires --loadbalancer_provider)',
  'obs://': 'Bucket name must be globally unique and DNS-compliant (lowercase, numbers, hyphens only)',
};

// One normalization seam for the hcloud tools' args array (2026-11-05 UX
// report #6): the tools take hcloud ARGUMENTS ("excluding the hcloud
// executable" per the schema), but agents routinely paste the bin anyway —
// bare, path-qualified (`./hcloud`, `C:\hcloud.exe`), or behind wrapper/env
// prefixes (`HW_REGION=x hcloud …`, `sudo hcloud …`). Classification always
// normalized through the classifier's own unwrap vocabulary (stripExecutable)
// while the command echo and the spawned child kept the raw input, so plan,
// argv, and classification disagreed. Everyone now normalizes through this
// one helper — the same stripExecutable the classifier uses, so
// classification, the plan echo, the approval hash, and the executed argv
// cannot disagree (loop round 2, seat-1 R1 probe: the env/sudo-prefixed
// shapes still doubled the bin into spawn, skipped the OBS-write hint, and
// burned approval tokens).
export function stripLeadingHcloudBinArgs(args: string[]): { args: string[]; stripped: string | null } {
  if (args.length > 0 && isHcloudToken(String(args[0]))) {
    return { args: args.slice(1), stripped: String(args[0]) };
  }
  const effective = stripExecutable(args);
  const unchanged = effective.length === args.length && effective.every((value, i) => value === args[i]);
  if (unchanged) return { args, stripped: null };
  // The removed span is head-only for the wrapper/env shapes (the common
  // case); script-stream re-tokenization (bash -c) rewrites the whole tail,
  // where the label is approximate — the warning is advisory either way.
  return { args: effective, stripped: String(args[0] ?? '') || null };
}

function leadingBinWarning(stripped: string): string {
  return (
    `Leading executable/wrapper token(s) starting with "${stripped}" were removed from args — this tool takes ` +
    'hcloud arguments only (e.g. ["obs","ls"], without the "hcloud" prefix or env/sudo wrappers).'
  );
}

// Secret-value pinning (2026-11-06 loop round 2): the redacted-equality
// branch in runApprovedCommand cannot tell a changed real secret from the
// documented placeholder→real substitution flow — redaction folds both. The
// distinction lives at PLAN time: a plan whose every secret-shaped value is
// a placeholder (`<redacted>`, `<password>`) carries no real secret, so
// run-time substitution is the intended flow; a plan with a real secret
// value pins it.
//
// Loop round 4 (seat-1 B1/B2/B3): the detector must mirror redactString's
// EXACT anchoring semantics in BOTH directions —
//   - the key families of arm 1/2 are UNANCHORED (redactString folds
//     `password=` inside `--dbpassword=`; a left guard here let a changed
//     real infix-key secret execute);
//   - bare AK/SK are boundary-anchored (`\bAK[:=]` — 'task=' must not read
//     as the SK key);
//   - the separator accepts `=`/`:` AND whitespace (the glued single-token
//     form `--password <x>`), and the two-token form (`--password`, `<x>`
//     as the next argv element) is handled by the callers — the redactor
//     never folds those two, so the comparison uses pinViewArgs (below), a
//     canonical fold computed on BOTH sides of the verify instead of the
//     redactor's output.
// A placeholder match is PREFIX-anchored on the value: `<redacted> extra`
// still "carries a placeholder" for the run-time gate (loop round 3, seat-1
// B3), and a plan whose value merely STARTS with a placeholder stays
// substitutable (the trailing text rides along in the pin view).
// DOCUMENTED LIMIT (loop round 9, seat-1 B1/B2): a JSON-body argument whose
// segment structure interleaves keys and quoted values can defeat the
// segment model (a value's leading quote lands in the PREVIOUS key's
// segment). The failure direction is fail-closed — an all-placeholder body
// may mint substitutable:false, which pins the plan (re-plan with final
// values) instead of executing a half-detected substitution — and the
// pinning message no longer claims a reason. Free-form JSON bodies with
// real secrets should go through plan→approve with literal values (hash
// path), not the substitution flow.
// The secret-token fold's primitives (the key vocabulary, the scanner, the
// argv fold) live in lib/supplemental-redaction.ts since PR-3a round 3 —
// one canonical home shared with the exec views and the token store, which
// cannot import this module's face (approval-tokens ← hcloud-cli would be
// a value cycle). The detector comments below describe THEIR semantics and
// stay authoritative for the substitution flow.
const PLACEHOLDER_SECRET_VALUE_RE = /^["']?<{1,2}[A-Za-z0-9_ -]{1,40}>{1,2}["']?/;

function placeholderShaped(value: string): boolean {
  return PLACEHOLDER_SECRET_VALUE_RE.test(value.trim());
}

export function secretsSubstitutable(args: string[]): boolean {
  for (let i = 0; i < args.length; i += 1) {
    const arg = String(args[i]);
    // Every key's value segment must be placeholder-shaped — a mixed body
    // (one placeholder + one real secret) pins (loop round 8, seat-1 B1:
    // the lazy first match let a real later key hide behind an earlier
    // placeholder).
    for (const segment of secretSegments(arg)) {
      if (!placeholderShaped(segment.value)) return false;
    }
    const next = i + 1 < args.length ? String(args[i + 1]) : undefined;
    if (
      SECRET_KEY_TOKEN_RE.test(arg) &&
      next !== undefined &&
      !SECRET_KEY_TOKEN_RE.test(next) &&
      !placeholderShaped(next)
    ) {
      return false;
    }
  }
  return true;
}

// The first argument still carrying a placeholder secret VALUE at run time
// (inline, glued, or two-token) — executing a literal `<redacted>` as the
// password is always wrong, so runApprovedCommand rejects with the
// substitution guidance BEFORE the token is consumed (a burned token made
// that guidance a dead end — loop round 3, seat-1 B3).
export function firstPlaceholderSecretArg(args: string[]): string | null {
  for (let i = 0; i < args.length; i += 1) {
    const arg = String(args[i]);
    for (const segment of secretSegments(arg)) {
      if (placeholderShaped(segment.value)) return arg;
    }
    const next = i + 1 < args.length ? String(args[i + 1]) : undefined;
    if (SECRET_KEY_TOKEN_RE.test(arg) && next !== undefined && placeholderShaped(next)) {
      return `${arg} ${next}`;
    }
  }
  return null;
}

// Canonical pin view for the approval verify comparison: an argument the
// detector sees a secret key in has every value segment folded to
// `<redacted>` while the STRUCTURE (flag names, key names, non-secret
// prefix) survives — a run cannot swap the argument's identity past the
// consent, and no plaintext reaches argsPinView on disk (multi-key bodies
// included; loop rounds 5-7: the walk-only version leaked multi-key bodies,
// the map-only version dropped the two-token branch and let cross-form
// swaps through). The redactor's own output cannot serve here — it never
// folds the two-token/glued forms, so the substitution flow dead-ended in
// a mismatch (loop round 4, seat-1 B2). Since PR-3a round 3 the fold body
// lives in the shared leaf (lib/supplemental-redaction.ts) with the exec
// views and the token store as its co-consumers; this export keeps the
// run face's canonical name.
export function pinViewArgs(args: string[]): string[] {
  return foldSecretTokens(args) as string[];
}

// KooCLI flags carry the parameter name before the first `=`; reading flag keys
// instead of substring-matching the joined args stops a VALUE from satisfying a
// check, and lets a body-name spelling be recognized and reported as a
// correction rather than silently accepted.
function flagKeys(args: string[]): Set<string> {
  const keys = new Set<string>();
  for (const arg of args.slice(2)) {
    const text = String(arg);
    if (!text.startsWith('--')) continue;
    const equals = text.indexOf('=');
    keys.add(equals === -1 ? text.slice(2) : text.slice(2, equals));
  }
  return keys;
}

function requiredParamPresent(args: string[], keys: Set<string>, param: string): boolean {
  // Pseudo-entries such as OBS's `obs://` are literal argument text, not flags.
  if (param.includes('://')) return args.join(' ').includes(param);
  return keys.has(param);
}

interface ParamValidation {
  valid: boolean;
  missing: string[];
  hints: string[];
  corrections: Array<{ received: string; canonical: string }>;
}

function validateRequiredParams(args: string[]): ParamValidation {
  const empty: ParamValidation = { valid: true, missing: [], hints: [], corrections: [] };
  if (!args || args.length < 2) return empty;
  const key = `${args[0]} ${args[1]}`;
  const required = REQUIRED_PARAMS[key];
  if (!required) return empty;
  const keys = flagKeys(args);
  // --cli-jsonInput carries the parameters in a file this layer cannot inspect;
  // reporting every flag as missing there would be noise, not a finding.
  if (keys.has('cli-jsonInput') || keys.has('cli-json_input')) return empty;
  const corrections = [...keys]
    .filter((received) => FUNCTIONGRAPH_CREATE_ALIASES[received] && !keys.has(FUNCTIONGRAPH_CREATE_ALIASES[received]))
    .map((received) => ({ received, canonical: FUNCTIONGRAPH_CREATE_ALIASES[received] ?? received }));
  const missing = required.filter((param) => !requiredParamPresent(args, keys, param));
  for (const group of REQUIRED_PARAM_GROUPS[key] ?? []) {
    if (group.anyOf.some((param) => requiredParamPresent(args, keys, param))) continue;
    // A body-name spelling of a member still counts as that member's absence,
    // reported under the canonical flag so the list does not depend on it.
    const aliasTarget = corrections
      .map((correction) => correction.canonical)
      .find((canonical) => group.anyOf.includes(canonical));
    missing.push(aliasTarget ?? group.report);
  }
  const hints = missing.map((param) => PARAM_VALUE_HINTS[param]).filter((hint): hint is string => Boolean(hint));
  return { valid: missing.length === 0, missing, hints, corrections };
}

// The timer trigger consumes the func_urn a successful create returns. A
// placeholder (or absent) value cannot succeed — the trigger either fails on the
// missing URN or fires at whatever the placeholder happened to parse as, so the
// plan must say to create the function first and pass the URN it returns.
// #815 / D3-S6: the trigger previously failed together with the function it was
// planned alongside, with no instruction saying which step owed the URN.
function functionTriggerUrnWarning(args: string[]): string | null {
  if (`${args[0]} ${args[1]}` !== 'FunctionGraph CreateFunctionTrigger') return null;
  const keys = flagKeys(args);
  const flag = args.find((arg) => String(arg).startsWith('--function_urn='));
  const urn = flag ? String(flag).slice('--function_urn='.length).trim() : '';
  // A URN carrying a template marker anywhere (`urn:fss:<region>:…`) is as
  // unusable as an absent one — the marker survives into the API call.
  const placeholder = !urn || /[<>]|\$\{|\{\{/.test(urn);
  if (!placeholder) return null;
  return `CreateFunctionTrigger needs the real --function_urn${
    keys.has('function_urn') ? '' : ' (it is missing)'
  }: run CreateFunction first, read func_urn from its response, then plan the trigger with that value — a placeholder cannot be approved into a working trigger.`;
}

export function planHcloudCommand(args: unknown, options: HcloudPlanOptions = {}): HcloudPlan {
  const inputArgs = Array.isArray(args) ? args.map(String) : [];
  const { args: normalizedArgs, stripped } = stripLeadingHcloudBinArgs(inputArgs);
  const classification = classifyHcloudArgs(normalizedArgs, options);
  // The echo reproduces the REAL argument's quoting SHAPE and redacts only the
  // value text inside it, so replacing `<redacted>` with the real value yields
  // exactly the line the approval gate accepts for every charset family.
  // Quoting must be decided from the raw argument: the placeholder itself is
  // not charset-safe (`<` and `>` sit outside quoteShellArg's safe set), so
  // quoting the redacted spelling unconditionally would wrap a safe-charset
  // value the real line leaves bare and dead-end the substitution on the most
  // common family (alphanumeric password, hex token). The old post-quote
  // redaction had the mirror defect on the shell-special family (an
  // unbalanced quote), so this one construction now serves both.
  const redactedArgs = normalizedArgs.map((arg) => redactSecrets(arg));
  const command = ['hcloud', ...normalizedArgs.map((raw, i) => redactedCommandArg(raw, redactedArgs[i] ?? ''))].join(
    ' ',
  );
  const warnings: Array<string | SgFinding> = planningWarnings(normalizedArgs);
  if (stripped !== null) warnings.unshift(leadingBinWarning(stripped));
  const obsHint = obsWriteHint(normalizedArgs);
  if (obsHint) warnings.push(obsHint);
  const sgFindings = preflightSecurityGroupCheck(normalizedArgs);
  if (sgFindings.length > 0) {
    for (const f of sgFindings) warnings.push(f);
  }
  const paramValidation = validateRequiredParams(normalizedArgs);
  for (const correction of paramValidation.corrections) {
    warnings.push(
      `--${correction.received} is a request-body field name, not a KooCLI parameter; use --${correction.canonical} (confirm with \`hcloud ${normalizedArgs[0]} ${normalizedArgs[1]} --help\`).`,
    );
  }
  if (paramValidation.missing.length > 0) {
    warnings.push('Missing required parameters: ' + paramValidation.missing.join(', '));
    if (paramValidation.hints && paramValidation.hints.length > 0) {
      warnings.push('Find valid values: ' + paramValidation.hints.join('; '));
    }
  }
  const triggerUrnWarning = functionTriggerUrnWarning(normalizedArgs);
  if (triggerUrnWarning) warnings.push(triggerUrnWarning);
  // Unknown-service triage (2026-11-06, UX report #8/D6): ONE seam refines
  // the unknown_read fallthrough with catalog evidence. A service present
  // in NEITHER local catalog denies right here — the run face inherits the
  // deny through assertAllowed(plan.classification), so plan and run can
  // never disagree about the same command (the #6 lesson: one seam per
  // fact). lang-missing only annotates — the service is real, and the cn
  // hint matches what the run engine attaches post-execution.
  // operation-unknown and no-evidence keep the P0-B semantics: allow, no
  // triage noise (the advisory face owns the warn there).
  let effectiveClassification = classification;
  if (classification.decision === 'allow' && classification.risk === 'unknown_read') {
    const triage = triageUnknownService(classification.service, options.metaDir);
    if (triage.cause === 'service-not-found') {
      effectiveClassification = {
        ...classification,
        decision: 'deny',
        risk: 'invalid',
        reason: `${triage.message} ${triage.nextStep}`,
      };
      warnings.push(triage.message);
    } else if (triage.cause === 'lang-missing') {
      warnings.push(`${triage.message} ${triage.nextStep}`);
    }
  }
  const approvalMode = options.approvalMode ?? 'token';
  // Ask mode never mints: the confirmation is the server-run gate inside
  // the run call, so there is no token to hand the model and nothing lands
  // in the approvals store. Run paths keep mintApprovalToken:false in both
  // modes.
  const approvalToken =
    approvalMode === 'ask' || options.mintApprovalToken === false
      ? undefined
      : createApprovalToken(normalizedArgs, {
          secretsSubstitutable: secretsSubstitutable(normalizedArgs),
          argsPinView: pinViewArgs(normalizedArgs),
        });
  const needsConfirmation = needsUserConfirmation(normalizedArgs, options);
  return {
    executable: 'hcloud',
    args: normalizedArgs.map((arg) => redactSecrets(arg)),
    // The plan echo is a COMMAND string, not child-process output — banner
    // stripping is an output concern, and an argument VALUE that happens to
    // carry banner-shaped text must never blank the command the user is asked
    // to approve (redaction only, already applied per arg above so the
    // quoting stays balanced).
    command,
    executableBlock: command,
    warnings,
    classification: applyPreflightFindings(effectiveClassification, sgFindings),
    sgFindings,
    ...(approvalToken !== undefined ? { approvalToken } : {}),
    // `command` exists only where a token was minted: a run-path plan stays
    // silent rather than name a line for a token the run cannot offer.
    // Ask mode names the posture instead — the confirmation happens at the
    // run call, and the note teaches exactly that.
    userConfirmation: needsConfirmation
      ? approvalMode === 'ask'
        ? {
            needed: true,
            mode: 'ask',
            note: 'The confirmation happens on the server when huaweicloud_run_approved_command is called: an elicitation-capable client renders a form with this command line, and any other client returns ASK_CONFIRMATION_REQUIRED, which you answer by showing the user this command in chat and retrying with approvedByUser: true. Send the same args on every call. This command field is the display line: where it shows <redacted>, substitute the real values, and the args array spelled out is always accepted as the command. No terminal approval line or token is needed.',
          }
        : {
            needed: true,
            ...(approvalToken !== undefined ? { command: `npx huaweicloud-devkit approve ${approvalToken}` } : {}),
          }
      : { needed: false },
    // "Safe to run NOW": a caller-supplied allowWrites:true only unlocks the
    // classification — the strict view still demands the user's confirmation
    // (the approval token/form), so a plan showing decision:"allow" must not
    // also read as runnable while userConfirmation.needed is true (AX D-02
    // display-layer alignment).
    safeToRun: effectiveClassification.decision === 'allow' && !needsConfirmation,
  };
}
