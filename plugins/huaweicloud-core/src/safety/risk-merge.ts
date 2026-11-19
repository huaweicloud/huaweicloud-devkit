import { evaluateCommandRisk, mergeRiskDecision, type RiskDecision, type RiskEvaluation } from '../risk-rule-engine.ts';
import type { ClassifyOptions } from './policy.ts';

// The risk-rule merge seam for both classifiers: a non-deny base decision
// is merged with the catalog's evaluation of the command text, unless the
// caller skipped risk rules. One spelling so the argv face and the text
// face can never disagree on whether rules ran.

function commandRiskText(normalizedArgs: string[], options: ClassifyOptions): string {
  return options.rawCommand || ['hcloud', ...normalizedArgs].join(' ');
}

// A deny-severity base (the generic write/execution gate) still carries the
// catalog's specialized findings: the approval decision the developer reads
// must show WHY the command is risky (broad administrator grant, anonymous
// write, high-cost shape), not only the generic "write must be approved".
// Only findings/warnings are attached — decision, risk, and reason stay the
// base's, so the PreToolUse hook's risk-shaped exemption logic does not
// drift.
function attachRiskFindings(base: RiskDecision, risk: RiskEvaluation): RiskDecision {
  if (!risk.findings || risk.findings.length === 0) return base;
  const warnFindings = risk.findings.filter((finding) => finding.severity !== 'deny');
  return {
    ...base,
    findings: [...(base.findings || []), ...risk.findings],
    ...(warnFindings.length > 0 ? { warnings: [...(base.warnings || []), ...warnFindings] } : {}),
  };
}

function mergeRisk(base: RiskDecision, risk: RiskEvaluation): RiskDecision {
  return base.decision === 'deny' ? attachRiskFindings(base, risk) : mergeRiskDecision(base, risk);
}

export function applyCommandRiskRules(
  base: RiskDecision,
  normalizedArgs: string[],
  options: ClassifyOptions,
): RiskDecision {
  if (options.skipRiskRules === true) {
    return base;
  }
  const risk = evaluateCommandRisk(commandRiskText(normalizedArgs, options));
  return mergeRisk(base, risk);
}

export function applyRawCommandRiskRules(base: RiskDecision, command: string, options: ClassifyOptions): RiskDecision {
  if (options.skipRiskRules === true) {
    return base;
  }
  const risk = evaluateCommandRisk(command);
  return mergeRisk(base, risk);
}
