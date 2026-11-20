import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const defaultRulesPath = join(__dirname, '..', 'safety', 'rules', 'cloud-risk-rules.json');

const SEVERITY_RANK = {
  deny: 3,
  warn: 2,
  info: 1,
};

export function loadRiskRules(options = {}) {
  const path = options.path || defaultRulesPath;
  return JSON.parse(readFileSync(path, 'utf8'));
}

function redactEvidence(text) {
  return String(text)
    .replace(
      /((?:access[_-]?key|secret[_-]?key|secret|security[_-]?token|x[_-]?auth[_-]?token|token|authorization|password|passwd|admin[_-]?pass|credential)\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;]+)/gi,
      '$1<redacted>',
    )
    .replace(/(?<![A-Za-z])(AK|SK)\s*[:=]\s*("[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1=<redacted>');
}

function normalizeText(value) {
  if (typeof value === 'string') return value;
  return JSON.stringify(value, null, 2);
}

// #1055 D4-17: "no rule matched" must not degrade an unreviewable input to
// allow. A command whose surface form cannot be parsed statically (control
// bytes, a leading shell operator, unbalanced or nested command substitution,
// or a remote fetch executed inside a substitution) has an unknown runtime
// payload, so the risk check fails closed instead of reporting a clean allow.
const LEADING_SHELL_OPERATOR_PATTERN = /^\s*(?:&&|\|\||\||;|&)\s*\S/;
const SINGLE_SUBST_PATTERN = /\$\(([^)]*)\)/g;
const SINGLE_BACKTICK_PATTERN = /`([^`]*)`/g;
const NESTED_SUBST_PATTERN = /\$\(|`/;
const REMOTE_FETCH_PATTERN = /\b(?:curl|wget|iwr|invoke-webrequest)\b/i;
const INTERPRETER_REMOTE_PROCESS_SUBST_PATTERN = /\b(?:bash|sh|zsh|dash|ksh)\b[^\n;|&]*<\s*\(\s*(?:curl|wget)\b/i;

function hasControlCharacters(text) {
  for (const char of text) {
    const code = char.codePointAt(0);
    if (
      (code >= 0x00 && code <= 0x08) ||
      code === 0x0b ||
      code === 0x0c ||
      (code >= 0x0e && code <= 0x1f) ||
      code === 0x7f
    ) {
      return true;
    }
  }
  return false;
}

function hasUnparsableSubstitution(text) {
  const openings = (text.match(/\$\(/g) || []).length;
  const parsed = (text.match(SINGLE_SUBST_PATTERN) || []).length;
  if (openings > parsed) return true;
  const backticks = (text.match(/`/g) || []).length;
  return backticks % 2 === 1;
}

function hasNestedSubstitution(text) {
  for (const match of text.matchAll(SINGLE_SUBST_PATTERN)) {
    if (NESTED_SUBST_PATTERN.test(match[1] || '')) return true;
  }
  for (const match of text.matchAll(SINGLE_BACKTICK_PATTERN)) {
    if (NESTED_SUBST_PATTERN.test(match[1] || '')) return true;
  }
  return false;
}

function hasRemoteFetchSubstitution(text) {
  for (const match of text.matchAll(SINGLE_SUBST_PATTERN)) {
    if (REMOTE_FETCH_PATTERN.test(match[1] || '')) return true;
  }
  for (const match of text.matchAll(SINGLE_BACKTICK_PATTERN)) {
    if (REMOTE_FETCH_PATTERN.test(match[1] || '')) return true;
  }
  return false;
}

function unreviewableCommandReason(command) {
  const text = String(command || '');
  if (hasControlCharacters(text)) {
    return 'Command contains control characters and cannot be parsed as a shell command.';
  }
  if (LEADING_SHELL_OPERATOR_PATTERN.test(text)) {
    return 'Command starts with a shell control operator and has no executable name.';
  }
  if (hasUnparsableSubstitution(text)) {
    return 'Command contains an unbalanced or nested $(...)/backtick substitution whose payload resolves only at runtime.';
  }
  if (hasNestedSubstitution(text)) {
    return 'Command nests command substitution, so the executed payload resolves only at runtime.';
  }
  if (hasRemoteFetchSubstitution(text)) {
    return 'Command executes a remote fetch inside command substitution, so the payload is downloaded at runtime.';
  }
  if (INTERPRETER_REMOTE_PROCESS_SUBST_PATTERN.test(text)) {
    return 'Command executes a remote process substitution inside a shell interpreter.';
  }
  return '';
}

function evaluationContext(stage, input) {
  if (stage === 'command') {
    const command = normalizeText(input.command || input.text || '');
    return { text: command, command };
  }
  if (stage === 'artifact') {
    const path = String(input.path || '');
    const content = normalizeText(input.content || '');
    return { text: `${path}\n${content}`, path, content };
  }
  if (stage === 'deploy_plan') {
    const plan = normalizeText(input.plan || input.text || input);
    return { text: plan, plan };
  }
  return { text: normalizeText(input) };
}

function conditionMatches(condition, context) {
  const field = condition.field || 'text';
  const value = Object.hasOwn(context, field) ? context[field] : context.text;
  return new RegExp(condition.regex, 'ims').test(String(value || ''));
}

function ruleMatches(rule, context) {
  const match = rule.match || {};
  const all = match.all;
  const any = match.any;
  const none = match.none;
  if (Array.isArray(all) && !all.every((condition) => conditionMatches(condition, context))) {
    return false;
  }
  if (Array.isArray(any) && !any.some((condition) => conditionMatches(condition, context))) {
    return false;
  }
  if (Array.isArray(none) && none.some((condition) => conditionMatches(condition, context))) {
    return false;
  }
  return Array.isArray(all) || Array.isArray(any);
}

function excerpt(text) {
  const compact = redactEvidence(String(text).replace(/\s+/g, ' ').trim());
  if (compact.length <= 240) return compact;
  return `${compact.slice(0, 237)}...`;
}

function evaluate(stage, inputs, options = {}) {
  const catalog = options.catalog || loadRiskRules(options);
  const items = Array.isArray(inputs) ? inputs : [inputs];
  const findings = [];

  for (const input of items) {
    const context = evaluationContext(stage, input || {});
    for (const rule of catalog.rules) {
      if (!rule.stages.includes(stage)) continue;
      if (!ruleMatches(rule, context)) continue;
      findings.push({
        ruleId: rule.id,
        title: rule.title,
        category: rule.category,
        severity: rule.severity,
        message: rule.message,
        remediation: rule.remediation,
        source: input?.path || stage,
        evidence: excerpt(context.text),
      });
    }

    // #1055 D4-17 fail-closed: a command that cannot be reviewed statically
    // must not come back as allow just because no catalog rule matched.
    if (stage === 'command') {
      const reason = unreviewableCommandReason(context.command);
      if (reason && !findings.some((finding) => finding.severity === 'deny')) {
        findings.push({
          ruleId: 'hwc-command-unreviewable',
          title: 'Unreviewable command input',
          category: 'execution',
          severity: 'deny',
          message: reason,
          remediation:
            'Rewrite the command as an explicit, statically reviewable invocation, or have a human review it before execution.',
          source: input?.path || stage,
          evidence: excerpt(context.text),
        });
      }
    }
  }

  findings.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);
  const hasDeny = findings.some((finding) => finding.severity === 'deny');
  const hasWarn = findings.some((finding) => finding.severity === 'warn');
  return {
    decision: hasDeny ? 'deny' : hasWarn ? 'warn' : 'allow',
    findings,
  };
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isNonEmptyContainer(value) {
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === 'object') return Object.keys(value).length > 0;
  return false;
}

// A risk check that could not inspect its input must never report "allow"
// (fail-open) — it reports deny with an `invalid` risk and a synthetic finding
// so the reason is visible through the tool response (#564).
function invalidRiskResult(stage, reason) {
  return {
    decision: 'deny',
    risk: 'invalid',
    findings: [
      {
        ruleId: 'invalid-input',
        title: 'Invalid input for risk check',
        category: 'invalid',
        severity: 'deny',
        message: reason,
        remediation: 'Provide a valid, non-empty input before re-running the check.',
        source: stage,
        evidence: '',
      },
    ],
  };
}

export function evaluateCommandRisk(command, options = {}) {
  if (!isNonEmptyString(command)) {
    return invalidRiskResult('command', 'command must be a non-empty string.');
  }
  return evaluate('command', { command }, options);
}

export function evaluateArtifacts(artifacts, options = {}) {
  if (!Array.isArray(artifacts) || artifacts.length === 0) {
    return invalidRiskResult('artifact', 'artifacts must be a non-empty array.');
  }
  return evaluate('artifact', artifacts, options);
}

export function evaluateDeployPlan(plan, options = {}) {
  const valid = isNonEmptyString(plan) || (plan != null && typeof plan === 'object' && isNonEmptyContainer(plan));
  if (!valid) {
    return invalidRiskResult('deploy_plan', 'plan must be a non-empty object, array, or string.');
  }
  return evaluate('deploy_plan', { plan }, options);
}

export function mergeRiskDecision(base, risk) {
  if (!risk || !risk.findings?.length) return base;
  if (risk.decision === 'deny') {
    const topFinding = risk.findings[0];
    return {
      ...base,
      decision: 'deny',
      risk: topFinding.category,
      reason: topFinding.message,
      blockedByRiskRule: true,
      findings: risk.findings,
    };
  }
  return {
    ...base,
    warnings: [...(base.warnings || []), ...risk.findings],
  };
}
