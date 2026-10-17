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

// --- ANSI-C quoting decode preprocessing (#866 D4-15) -----------------------
// Bash/zsh `$'...'` strings decode escape sequences (\xNN, \uNNNN, \UNNNNNNNN,
// octal \NNN, \cX, and C shorthands like \n) at execution time. Matching rules
// against the raw text alone lets an encoded inner command (`$'\x72m -\x72f /'`)
// slip past every rule. `expandAnsiCQuoting` decodes each `$'...'` body and
// APPENDS the decoded strings to the text, so raw-text rules keep their exact
// semantics while decoded payloads are also inspected.

const ANSI_C_STRING = /\$'((?:\\[\s\S]|[^'\\])*)'/g;
const ANSI_C_SHORT_ESCAPES = {
  a: '\x07',
  b: '\x08',
  e: '\x1b',
  E: '\x1b',
  f: '\x0c',
  n: '\n',
  r: '\r',
  t: '\t',
  v: '\x0b',
  '\\': '\\',
  "'": "'",
  '"': '"',
  '?': '?',
};

function decodeHexEscape(body, index, maxDigits) {
  const digits = body.slice(index, index + maxDigits).match(/^[0-9a-fA-F]+/);
  if (!digits) return null;
  return { char: String.fromCharCode(parseInt(digits[0], 16)), length: digits[0].length };
}

function decodeAnsiCBody(body) {
  let out = '';
  for (let i = 0; i < body.length;) {
    const ch = body[i];
    if (ch !== '\\') {
      out += ch;
      i += 1;
      continue;
    }
    const next = body[i + 1];
    if (next === undefined) {
      out += '\\';
      break;
    }
    if (Object.hasOwn(ANSI_C_SHORT_ESCAPES, next)) {
      out += ANSI_C_SHORT_ESCAPES[next];
      i += 2;
      continue;
    }
    if (next === 'x') {
      const decoded = decodeHexEscape(body, i + 2, 2);
      if (decoded) {
        out += decoded.char;
        i += 2 + decoded.length;
        continue;
      }
    }
    if (next === 'u') {
      const decoded = decodeHexEscape(body, i + 2, 4);
      if (decoded) {
        out += decoded.char;
        i += 2 + decoded.length;
        continue;
      }
    }
    if (next === 'U') {
      const decoded = decodeHexEscape(body, i + 2, 8);
      if (decoded) {
        out += decoded.char;
        i += 2 + decoded.length;
        continue;
      }
    }
    if (next === 'c' && body[i + 2] !== undefined) {
      // \cX = control char: XOR the letter with 0x40 (bash semantics).
      out += String.fromCharCode(body.charCodeAt(i + 2) ^ 0x40);
      i += 3;
      continue;
    }
    if (/[0-7]/.test(next)) {
      const octal = body.slice(i + 1, i + 4).match(/^[0-7]+/);
      if (octal) {
        out += String.fromCharCode(parseInt(octal[0], 8) & 0xff);
        i += 1 + octal[0].length;
        continue;
      }
    }
    // Unknown escape: keep the escaped character literally.
    out += next;
    i += 2;
  }
  return out;
}

export function expandAnsiCQuoting(text) {
  const value = String(text || '');
  const decoded = [];
  let match;
  ANSI_C_STRING.lastIndex = 0;
  while ((match = ANSI_C_STRING.exec(value)) !== null) {
    if (match[1]) decoded.push(decodeAnsiCBody(match[1]));
  }
  if (decoded.length === 0) return value;
  return `${value}\n${decoded.join('\n')}`;
}

// --- $(…) command substitution inner decode (#866 D4-15 step 2) --------------
// `$(printf '\x72\x6d')` and `$(echo '…' | base64 -d)` produce command text at
// execution time that the raw command string doesn't reveal. The engine extracts
// the inner command from each `$(...)`, decodes `printf` hex/octal escapes and
// `base64 -d` payloads, then APPENDS the decoded text so raw-text rules keep
// their exact semantics while decoded payloads are also inspected.
//
// Only single-level `$(...)` is extracted (nested parens are a known
// limitation, same as `extractInnerCommand` in safety-policy.mjs). The depth
// guard prevents infinite recursion on pathological input.

const CMD_SUBST_PATTERN = /\$\(([^)]+)\)/g;
// printf '...' / printf "..." with \xNN/\uNNNN/\NNN escapes (reuse decodeAnsiCBody)
const PRINTF_PATTERN = /\bprintf\s+(['"])((?:\\[\s\S]|(?!\\?\1).)*)\1/gi;
// echo '...' | base64 -d  /  echo "..." | base64 --decode  (capture the b64 blob)
const BASE64_PIPE_PATTERN = /\becho\s+(['"])([A-Za-z0-9+/=\s]+)\1\s*\|\s*base64\s+(-d|--decode)/gi;

function decodePrintfEscapes(innerCommand) {
  const decoded = [];
  let m;
  PRINTF_PATTERN.lastIndex = 0;
  while ((m = PRINTF_PATTERN.exec(innerCommand)) !== null) {
    if (m[2]) decoded.push(decodeAnsiCBody(m[2]));
  }
  return decoded;
}

function decodeBase64Payloads(innerCommand) {
  const decoded = [];
  let m;
  BASE64_PIPE_PATTERN.lastIndex = 0;
  while ((m = BASE64_PIPE_PATTERN.exec(innerCommand)) !== null) {
    if (m[2]) {
      try {
        const b64 = m[2].replace(/\s/g, '');
        decoded.push(Buffer.from(b64, 'base64').toString('utf8'));
      } catch {
        // Malformed base64 — skip; the raw echo|base64 pattern is still
        // caught by hwc-command-encoded-shell-exec if piped to a shell.
      }
    }
  }
  return decoded;
}

export function expandCommandSubstitution(text) {
  const value = String(text || '');
  const decoded = [];
  let match;
  CMD_SUBST_PATTERN.lastIndex = 0;
  while ((match = CMD_SUBST_PATTERN.exec(value)) !== null) {
    const inner = match[1];
    if (!inner) continue;
    // The inner command itself is a candidate for rule matching (e.g.
    // `$(hcloud ECS DeleteServers …)` → inner = `hcloud ECS DeleteServers …`).
    decoded.push(inner.trim());
    // Decode printf '\xNN' escapes inside the inner command.
    decoded.push(...decodePrintfEscapes(inner));
    // Decode `echo '…' | base64 -d` payloads inside the inner command.
    decoded.push(...decodeBase64Payloads(inner));
  }
  if (decoded.length === 0) return value;
  return `${value}\n${decoded.join('\n')}`;
}

function evaluationContext(stage, input) {
  if (stage === 'command') {
    const command = normalizeText(input.command || input.text || '');
    // Decode ANSI-C `$'...'` strings before rule matching (#866 D4-15).
    let expanded = expandAnsiCQuoting(command);
    // Decode $(…) command substitution inner commands (printf/base64)
    // before rule matching (#866 D4-15 step 2 — command substitution bypass).
    expanded = expandCommandSubstitution(expanded);
    return { text: expanded, command };
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
