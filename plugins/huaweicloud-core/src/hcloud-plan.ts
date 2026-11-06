// hcloud command planning, extracted from the hcloud-cli monolith (the
// stable src/hcloud-cli.ts face re-exports planHcloudCommand and the plan
// types): the pre-execution contract — quoted command echo, risk
// classification, OBS/SG/parameter warnings, required-parameter
// validation, and the approval token. The consent layer itself lives in
// src/lib/approval-tokens.ts.

import { classifyHcloudArgs, redactSecrets, stripExecutable, type ClassifyOptions } from './safety-policy.ts';
import { isHcloudToken } from './safety/tokens.ts';
import { createApprovalToken } from './lib/approval-tokens.ts';
import type { RiskDecision } from './risk-rule-engine.ts';
import { obsWriteHint } from './hcloud-obs-redact.ts';
import { applyPreflightFindings, preflightSecurityGroupCheck, type SgFinding } from './hcloud-sg-preflight.ts';

// Approval tokens must survive a process boundary: plan and run land in
// different MCP sessions/processes (and headless subprocesses), so the old
// in-memory Map lost the token and plan→approve→run became unreachable (#578).
// The machinery lives in src/lib/approval-tokens.ts (the CLI face's
// consent layer for plan_cli_command / run_approved_command).

export interface HcloudPlan {
  executable: string;
  args: string[];
  command: string;
  executableBlock: string;
  warnings: Array<string | SgFinding>;
  classification: RiskDecision;
  sgFindings: SgFinding[];
  approvalToken: string;
  safeToRun: boolean;
}

export interface HcloudPlanWithArgs extends HcloudPlan {
  rawArgs: string[];
}

function quoteShellArg(value: unknown): string {
  const text = String(value);
  if (!text) return '""';
  if (/^[A-Za-z0-9_./:=@-]+$/.test(text)) return text;
  return `"${text.replace(/(["\\])/g, '\\$1')}"`;
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
  'FunctionGraph CreateFunction': ['func_name', 'runtime', 'handler', 'memory_size', 'package', 'timeout'],
  'FunctionGraph CreateFunctionTrigger': ['function_urn', 'trigger_type_code'],
  'APIG CreateInstanceV2': ['spec_id'],
  'OBS mb': ['obs://'],
  'OBS rm': ['obs://'],
};

const PARAM_VALUE_HINTS: Record<string, string> = {
  'server.flavorRef': 'Run `hcloud ECS ListFlavors --cli-region=<r>` to find valid flavors',
  'server.imageRef': 'Run `hcloud IMS ListImages --cli-region=<r> --__imagetype=gold` to find image IDs',
  'server.nics.1.subnet_id': 'Run `hcloud VPC ListSubnets --cli-region=<r>` to find subnet IDs',
  'subnet.vpc_id': 'Run `hcloud VPC ListVpcs --cli-region=<r>` to find VPC IDs',
  func_name: 'Function name must be unique within project',
  runtime: 'Run `hcloud FunctionGraph ListRuntimes` to see available runtimes',
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
const SECRET_KEY_ALT =
  'access[_-]?key(?:[_-]?(?:id|secret))?|secret[_-]?key|secret[_-]?string|secret[_-]?binary|security[_-]?token|x[_-]?auth[_-]?token|token|password|passwd|admin[_-]?pass|credential|input[_-]?value|user[_-]?data|metadata|private[_-]?key|authorization';
// A bare key token (`--password`, `--server.adminPass`, `--dbpassword`): the
// value rides the NEXT argv element. The optional prefix must end on a
// separator char, or `--task` would parse as the SK key token.
const SECRET_KEY_TOKEN_RE = new RegExp('^(?:--?[A-Za-z0-9_.-]*[._-])?(?:' + SECRET_KEY_ALT + '|AK|SK)$', 'i');
const PLACEHOLDER_SECRET_VALUE_RE = /^["']?<{1,2}[A-Za-z0-9_ -]{1,40}>{1,2}["']?/;

// Shared key+separator scanner (loop round 8): ONE global split drives every
// consumer. The value segment of a key runs to the NEXT key occurrence — a
// multi-key body (`{"token":"<x>","password":"Real"}`) yields one segment
// per key, so a mixed placeholder/real body can no longer hide a real value
// behind a lazy first match (loop round 7, seat-1 B1).
const SECRET_KEY_SEP_RE = new RegExp(
  '((?:(?:' + SECRET_KEY_ALT + ')|\\b(?:AK|SK))["\'\\\\]*\\s*(?:[=:]|\\s|(?=["\']))\\s*)',
  'gi',
);

function secretSegments(arg: string): Array<{ sep: string; value: string }> {
  const parts = String(arg).split(SECRET_KEY_SEP_RE);
  const segments: Array<{ sep: string; value: string }> = [];
  for (let i = 1; i < parts.length; i += 2) {
    segments.push({ sep: parts[i] ?? '', value: parts[i + 1] ?? '' });
  }
  return segments;
}

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
// a mismatch (loop round 4, seat-1 B2).
export function pinViewArgs(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = String(args[i]);
    const segments = secretSegments(arg);
    if (segments.length > 0) {
      const parts = String(arg).split(SECRET_KEY_SEP_RE);
      let folded = parts[0] ?? '';
      for (let j = 1; j < parts.length; j += 2) {
        folded += parts[j] + '<redacted>';
      }
      out.push(folded);
      continue;
    }
    const next = i + 1 < args.length ? String(args[i + 1]) : undefined;
    if (SECRET_KEY_TOKEN_RE.test(arg) && next !== undefined && !SECRET_KEY_TOKEN_RE.test(next)) {
      // Bare key token with its value riding the next argv element — fold
      // the value, keep the key. A CHAINED bare key (`--password --token x`)
      // is left for its own iteration so no real value hides behind the
      // skip (loop round 7, seat-1 residual).
      out.push(arg, '<redacted>');
      i += 1;
      continue;
    }
    out.push(arg);
  }
  return out;
}

function validateRequiredParams(args: string[]): { valid: boolean; missing: string[]; hints: string[] } {
  if (!args || args.length < 2) return { valid: true, missing: [], hints: [] };
  const key = `${args[0]} ${args[1]}`;
  const required = REQUIRED_PARAMS[key];
  if (!required) return { valid: true, missing: [], hints: [] };
  const argsStr = args.join(' ');
  const missing = required.filter((param) => !argsStr.includes(param));
  const hints = missing.map((param) => PARAM_VALUE_HINTS[param]).filter((hint): hint is string => Boolean(hint));
  return { valid: missing.length === 0, missing, hints };
}

export function planHcloudCommand(args: unknown, options: ClassifyOptions = {}): HcloudPlan {
  const inputArgs = Array.isArray(args) ? args.map(String) : [];
  const { args: normalizedArgs, stripped } = stripLeadingHcloudBinArgs(inputArgs);
  const classification = classifyHcloudArgs(normalizedArgs, options);
  const command = ['hcloud', ...normalizedArgs].map((arg) => quoteShellArg(arg)).join(' ');
  const warnings: Array<string | SgFinding> = planningWarnings(normalizedArgs);
  if (stripped !== null) warnings.unshift(leadingBinWarning(stripped));
  const obsHint = obsWriteHint(normalizedArgs);
  if (obsHint) warnings.push(obsHint);
  const sgFindings = preflightSecurityGroupCheck(normalizedArgs);
  if (sgFindings.length > 0) {
    for (const f of sgFindings) warnings.push(f);
  }
  const paramValidation = validateRequiredParams(normalizedArgs);
  if (paramValidation.missing.length > 0) {
    warnings.push('Missing required parameters: ' + paramValidation.missing.join(', '));
    if (paramValidation.hints && paramValidation.hints.length > 0) {
      warnings.push('Find valid values: ' + paramValidation.hints.join('; '));
    }
  }
  return {
    executable: 'hcloud',
    args: normalizedArgs.map((arg) => redactSecrets(arg)),
    // The plan echo is a COMMAND string, not child-process output — banner
    // stripping is an output concern, and an argument VALUE that happens to
    // carry banner-shaped text must never blank the command the user is asked
    // to approve (redactSecrets only).
    command: redactSecrets(command),
    executableBlock: redactSecrets(command),
    warnings,
    classification: applyPreflightFindings(classification, sgFindings),
    sgFindings,
    approvalToken: createApprovalToken(normalizedArgs, {
      secretsSubstitutable: secretsSubstitutable(normalizedArgs),
      argsPinView: pinViewArgs(normalizedArgs),
    }),
    safeToRun: classification.decision === 'allow',
  };
}
