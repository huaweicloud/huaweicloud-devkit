import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const defaultRulesPath = join(__dirname, '..', 'safety', 'rules', 'cloud-risk-rules.json');

// The shipped catalog only authors `deny` and `warn`; `info` is kept because the
// rank table below defines it and future rules may use it.
export type Severity = 'deny' | 'warn' | 'info';

const SEVERITY_RANK: Record<Severity, number> = {
  deny: 3,
  warn: 2,
  info: 1,
};

export interface RiskRuleCondition {
  field?: string;
  regex: string;
}

export interface RiskRuleMatch {
  all?: RiskRuleCondition[];
  any?: RiskRuleCondition[];
  none?: RiskRuleCondition[];
}

export interface RiskRule {
  id: string;
  title: string;
  category: string;
  severity: Severity;
  stages: string[];
  match: RiskRuleMatch;
  message: string;
  remediation: string;
}

export interface RiskCatalog {
  version?: string;
  rules: RiskRule[];
}

export interface RiskFinding {
  ruleId: string;
  title: string;
  category: string;
  severity: Severity;
  message: string;
  remediation: string;
  source: string;
  evidence: string;
}

export interface RiskEvaluation {
  decision: 'allow' | 'warn' | 'deny';
  findings: RiskFinding[];
  risk?: string;
}

export interface RiskDecision {
  decision: 'allow' | 'warn' | 'deny';
  risk?: string;
  reason?: string;
  service?: string;
  operation?: string;
  args?: string[];
  blockedByRiskRule?: boolean;
  findings?: RiskFinding[];
  warnings?: RiskFinding[];
}

export interface RiskRuleOptions {
  path?: string;
  catalog?: RiskCatalog;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

// Unknown severities normalize to 'info' (rank 1). The shipped JSON only emits
// deny/warn, so this branch is unreachable for valid catalogs.
function toSeverity(value: unknown): Severity {
  return value === 'deny' || value === 'warn' || value === 'info' ? value : 'info';
}

function toCondition(value: unknown): RiskRuleCondition {
  const raw = asRecord(value);
  return {
    field: typeof raw.field === 'string' ? raw.field : undefined,
    regex: typeof raw.regex === 'string' ? raw.regex : '',
  };
}

function toConditionList(value: unknown): RiskRuleCondition[] | undefined {
  return Array.isArray(value) ? value.map((condition) => toCondition(condition)) : undefined;
}

function toMatch(value: unknown): RiskRuleMatch {
  const raw = asRecord(value);
  return {
    all: toConditionList(raw.all),
    any: toConditionList(raw.any),
    none: toConditionList(raw.none),
  };
}

function toRule(value: unknown): RiskRule {
  const raw = asRecord(value);
  return {
    id: typeof raw.id === 'string' ? raw.id : '',
    title: typeof raw.title === 'string' ? raw.title : '',
    category: typeof raw.category === 'string' ? raw.category : '',
    severity: toSeverity(raw.severity),
    stages: Array.isArray(raw.stages) ? raw.stages.filter((stage): stage is string => typeof stage === 'string') : [],
    match: toMatch(raw.match),
    message: typeof raw.message === 'string' ? raw.message : '',
    remediation: typeof raw.remediation === 'string' ? raw.remediation : '',
  };
}

function toCatalog(value: unknown): RiskCatalog {
  const raw = asRecord(value);
  return {
    version: typeof raw.version === 'string' ? raw.version : undefined,
    rules: Array.isArray(raw.rules) ? raw.rules.map((rule) => toRule(rule)) : [],
  };
}

export function loadRiskRules(options: RiskRuleOptions = {}): RiskCatalog {
  const path = options.path || defaultRulesPath;
  return toCatalog(JSON.parse(readFileSync(path, 'utf8')));
}

function redactEvidence(text: unknown): string {
  return String(text)
    .replace(
      /((?:access[_-]?key|secret[_-]?key|security[_-]?token|x[_-]?auth[_-]?token|token|authorization|password|passwd|admin[_-]?pass|credential)\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;]+)/gi,
      '$1<redacted>',
    )
    .replace(/(AK|SK)\s*[:=]\s*("[^"]*"|'[^']*'|[^\s,;]+)/g, '$1=<redacted>');
}

function normalizeText(value: unknown): string {
  if (typeof value === 'string') return value;
  return JSON.stringify(value, null, 2);
}

interface EvaluationContext {
  text: string;
  command?: string;
  path?: string;
  content?: string;
  plan?: string;
  [key: string]: string | undefined;
}

function evaluationContext(stage: string, input: unknown): EvaluationContext {
  const record = asRecord(input);
  if (stage === 'command') {
    const command = normalizeText(record.command || record.text || '');
    return { text: command, command };
  }
  if (stage === 'artifact') {
    const path = String(record.path || '');
    const content = normalizeText(record.content || '');
    return { text: `${path}\n${content}`, path, content };
  }
  if (stage === 'deploy_plan') {
    const plan = normalizeText(record.plan || record.text || input);
    return { text: plan, plan };
  }
  return { text: normalizeText(input) };
}

function conditionMatches(condition: RiskRuleCondition, context: EvaluationContext): boolean {
  const field = condition.field || 'text';
  const value = Object.hasOwn(context, field) ? context[field] : context.text;
  return new RegExp(condition.regex, 'ims').test(String(value || ''));
}

function ruleMatches(rule: RiskRule, context: EvaluationContext): boolean {
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

function excerpt(text: unknown): string {
  const compact = redactEvidence(String(text).replace(/\s+/g, ' ').trim());
  if (compact.length <= 240) return compact;
  return `${compact.slice(0, 237)}...`;
}

// One-property read off unknown, validated before use: only a string path is
// reported as a finding source (falling back to the stage label otherwise).
function inputPath(input: unknown): string | undefined {
  if (input === null || typeof input !== 'object') return undefined;
  const path = (input as { path?: unknown }).path;
  return typeof path === 'string' ? path : undefined;
}

function evaluate(stage: string, inputs: unknown, options: RiskRuleOptions = {}): RiskEvaluation {
  const catalog = options.catalog || loadRiskRules(options);
  const items: unknown[] = Array.isArray(inputs) ? inputs : [inputs];
  const findings: RiskFinding[] = [];

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
        source: inputPath(input) || stage,
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

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isNonEmptyContainer(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === 'object') return Object.keys(value).length > 0;
  return false;
}

// A risk check that could not inspect its input must never report "allow"
// (fail-open) — it reports deny with an `invalid` risk and a synthetic finding
// so the reason is visible through the tool response (#564).
function invalidRiskResult(stage: string, reason: string): RiskEvaluation {
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

export function evaluateCommandRisk(command: unknown, options: RiskRuleOptions = {}): RiskEvaluation {
  if (!isNonEmptyString(command)) {
    return invalidRiskResult('command', 'command must be a non-empty string.');
  }
  return evaluate('command', { command }, options);
}

export function evaluateArtifacts(artifacts: unknown, options: RiskRuleOptions = {}): RiskEvaluation {
  if (!Array.isArray(artifacts) || artifacts.length === 0) {
    return invalidRiskResult('artifact', 'artifacts must be a non-empty array.');
  }
  return evaluate('artifact', artifacts, options);
}

export function evaluateDeployPlan(plan: unknown, options: RiskRuleOptions = {}): RiskEvaluation {
  const valid = isNonEmptyString(plan) || (plan != null && typeof plan === 'object' && isNonEmptyContainer(plan));
  if (!valid) {
    return invalidRiskResult('deploy_plan', 'plan must be a non-empty object, array, or string.');
  }
  return evaluate('deploy_plan', { plan }, options);
}

export function mergeRiskDecision(base: RiskDecision, risk: RiskEvaluation): RiskDecision {
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
