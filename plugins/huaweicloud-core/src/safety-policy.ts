import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { evaluateCommandRisk, mergeRiskDecision, type RiskDecision } from './risk-rule-engine.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const policyPath = join(__dirname, '..', 'safety', 'policy.json');

// Only the pattern-array fields this module reads are modeled. Extra keys in
// policy.json are intentionally not surfaced through the type.
export interface Policy {
  secretKeyNamePatterns: string[];
  credentialFilePatterns: string[];
  blockedConfigureSubcommands: string[];
  blockedSecretOperations: string[];
  writeOperationPrefixes: string[];
  readOperationPrefixes: string[];
}

export interface ClassifyOptions {
  policy?: Policy;
  allowWrites?: boolean;
  allowCredentialRead?: boolean;
  rawCommand?: string;
  skipRiskRules?: boolean;
  _segmentDepth?: number;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

// Missing / non-array fields normalize to []. Valid policy.json always has all
// six arrays; malformed fields that used to throw at first use become empty.
function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

export function loadPolicy(): Policy {
  const raw = asRecord(JSON.parse(readFileSync(policyPath, 'utf8')));
  return {
    secretKeyNamePatterns: toStringArray(raw.secretKeyNamePatterns),
    credentialFilePatterns: toStringArray(raw.credentialFilePatterns),
    blockedConfigureSubcommands: toStringArray(raw.blockedConfigureSubcommands),
    blockedSecretOperations: toStringArray(raw.blockedSecretOperations),
    writeOperationPrefixes: toStringArray(raw.writeOperationPrefixes),
    readOperationPrefixes: toStringArray(raw.readOperationPrefixes),
  };
}

const DEFAULT_POLICY = loadPolicy();

function regexFrom(pattern: string): RegExp {
  return new RegExp(pattern, 'i');
}

function isSecretKeyName(key: unknown, policy: Policy = DEFAULT_POLICY): boolean {
  const normalized = String(key)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
  if (
    /access.*key|secret.*key|security.*token|xauth.*token|authorization|password|passwd|adminpass|credential|private.*key|userdata|metadata/.test(
      normalized,
    )
  ) {
    return true;
  }
  return policy.secretKeyNamePatterns.some((pattern) => regexFrom(`^(${pattern})$`).test(String(key)));
}

function redactString(text: unknown): string {
  return (
    String(text)
      // Opaque blob keys (cloud-init user_data, metadata, private_key) carry
      // base64/scripts that may embed SSH keys, DB passwords, bootstrap tokens.
      // Redact the ENTIRE value of this arg — not just the first whitespace token.
      .replace(/((?:user[_-]?data|metadata|private[_-]?key)\s*[:=]\s*).*/gi, '$1<redacted>')
      .replace(
        /((?:access[_-]?key|secret[_-]?key|security[_-]?token|x[_-]?auth[_-]?token|token|authorization|password|passwd|admin[_-]?pass|credential)\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;]+)/gi,
        '$1<redacted>',
      )
      .replace(/(AK|SK)\s*[:=]\s*("[^"]*"|'[^']*'|[^\s,;]+)/g, '$1=<redacted>')
  );
}

// Overload parameter names are documentation only; the implementation below
// carries the real, used parameters.
// eslint-disable-next-line no-unused-vars
export function redactSecrets(value: string, policy?: Policy): string;
// eslint-disable-next-line no-unused-vars
export function redactSecrets(value: unknown, policy?: Policy): unknown;
export function redactSecrets(value: unknown, policy: Policy = DEFAULT_POLICY): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactSecrets(item, policy));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, val]) => [
        key,
        isSecretKeyName(key, policy) ? '<redacted>' : redactSecrets(val, policy),
      ]),
    );
  }
  if (typeof value === 'string') {
    return redactString(value);
  }
  return value;
}

function stripExecutable(args: string[]): string[] {
  if (!args.length) return [];
  let current = args;
  // Unwrap shell wrappers (bash -c / sh -c 'hcloud ...', sudo hcloud ...) so
  // wrapped write commands keep their deny classification (#650 D4-16).
  for (let depth = 0; depth < 5; depth++) {
    const first = String(current[0]).toLowerCase();
    const isShell = [
      'bash',
      'sh',
      'zsh',
      'dash',
      'bash.exe',
      'sh.exe',
      '/bin/bash',
      '/bin/sh',
      '/bin/zsh',
      '/bin/dash',
    ].includes(first);
    if (isShell && String(current[1]).toLowerCase() === '-c' && current[2]) {
      current = splitSimpleCommand(current[2]);
      continue;
    }
    if (first === 'sudo' && current.length > 1) {
      current = current.slice(1);
      continue;
    }
    break;
  }
  const first = String(current[0]).toLowerCase();
  if (first === 'hcloud' || first.endsWith('/hcloud') || first.endsWith('\\hcloud') || first === 'hcloud.exe') {
    return current.slice(1);
  }
  return current;
}

function commandOperation(args: unknown): { service: string; operation: string; args: string[] } {
  const stripped = stripExecutable(Array.isArray(args) ? args.map((arg) => String(arg)) : [])
    .map(String)
    .filter(Boolean);
  if (stripped[0]?.toLowerCase() === 'configure') {
    return { service: 'configure', operation: stripped[1] || '', args: stripped };
  }
  const nonFlags = stripped.filter((arg) => !arg.startsWith('-'));
  return {
    service: nonFlags[0] || '',
    operation: nonFlags[1] || nonFlags[0] || '',
    args: stripped,
  };
}

function matchesAny(value: string, patterns: string[]): boolean {
  return patterns.some((pattern) => regexFrom(pattern).test(value));
}

function hasWritePrefix(operation: string, policy: Policy): boolean {
  const normalized = String(operation);
  return policy.writeOperationPrefixes.some((prefix) => new RegExp(`(^|[A-Za-z0-9])${prefix}`, 'i').test(normalized));
}

function hasReadPrefix(operation: string, policy: Policy): boolean {
  return policy.readOperationPrefixes.some((prefix) => new RegExp(`^${prefix}`, 'i').test(operation));
}

function isLocalMetadataCommand(args: string[]): boolean {
  return args.some((arg) => /^(--help|-h|help|version|--version)$/i.test(String(arg)));
}

function commandRiskText(normalizedArgs: string[], options: ClassifyOptions): string {
  return options.rawCommand || ['hcloud', ...normalizedArgs].join(' ');
}

function applyCommandRiskRules(base: RiskDecision, normalizedArgs: string[], options: ClassifyOptions): RiskDecision {
  if (base.decision === 'deny' || options.skipRiskRules === true) {
    return base;
  }
  const risk = evaluateCommandRisk(commandRiskText(normalizedArgs, options));
  return mergeRiskDecision(base, risk);
}

function applyRawCommandRiskRules(base: RiskDecision, command: string, options: ClassifyOptions): RiskDecision {
  if (base.decision === 'deny' || options.skipRiskRules === true) {
    return base;
  }
  const risk = evaluateCommandRisk(command);
  return mergeRiskDecision(base, risk);
}

// Find hcloud command segments split by shell operators (; && || |) so a write
// command in the middle of a concatenated string keeps its deny classification
// (#650 review edge 1).
function findHcloudCommandSegments(text: unknown): string[][] {
  return String(text)
    .split(/(?:\|\||&&|;|\|)/)
    .map((segment) => segment.trim())
    .filter(Boolean)
    .map((segment) => splitSimpleCommand(segment))
    .filter((tokens) => {
      const first = String(tokens[0] || '').toLowerCase();
      return first === 'hcloud' || first.endsWith('/hcloud') || first.endsWith('\\hcloud') || first === 'hcloud.exe';
    });
}

export function classifyHcloudArgs(args: unknown, options: ClassifyOptions = {}): RiskDecision {
  const policy = options.policy || DEFAULT_POLICY;
  // Second pass for shell-wrapped input (#650 D4-16 review edge 1): when the
  // leading command is not hcloud but a concatenated segment contains one,
  // classify every hcloud segment and merge to the most severe decision.
  const unwrappedTokens = stripExecutable(Array.isArray(args) ? args.map((arg) => String(arg)) : []);
  const unwrappedFirst = String(unwrappedTokens[0] || '').toLowerCase();
  const unwrappedIsHcloud =
    unwrappedFirst === 'hcloud' ||
    unwrappedFirst.endsWith('/hcloud') ||
    unwrappedFirst.endsWith('\\hcloud') ||
    unwrappedFirst === 'hcloud.exe';
  if (!unwrappedIsHcloud && !options._segmentDepth) {
    const hcloudSegments = findHcloudCommandSegments(unwrappedTokens.join(' '));
    if (hcloudSegments.length > 0) {
      const results = hcloudSegments.map((segment) => classifyHcloudArgs(segment, { ...options, _segmentDepth: 1 }));
      return (
        results.find((result) => result.decision === 'deny') ||
        results.find((result) => ['write', 'execution', 'secret', 'credential'].includes(result.risk ?? '')) ||
        results[0]
      );
    }
  }
  const { service, operation, args: normalizedArgs } = commandOperation(args);
  const joined = normalizedArgs.join(' ');

  if (!normalizedArgs.length) {
    return {
      decision: 'deny',
      risk: 'invalid',
      reason: 'Empty hcloud command arguments are not executable.',
    };
  }

  if (isLocalMetadataCommand(normalizedArgs)) {
    return applyCommandRiskRules(
      {
        decision: 'allow',
        risk: 'local_metadata',
        reason: 'KooCLI local help and version commands are read-only and do not call Huawei Cloud resource APIs.',
        service,
        operation,
        args: normalizedArgs,
      },
      normalizedArgs,
      options,
    );
  }

  if (service.toLowerCase() === 'configure') {
    const subcommand = operation.toLowerCase();
    if (
      policy.blockedConfigureSubcommands.map((cmd) => cmd.toLowerCase()).includes(subcommand) &&
      options.allowCredentialRead !== true
    ) {
      return {
        decision: 'deny',
        risk: 'credential',
        reason:
          'Direct hcloud configure inspection may expose profile credentials. Use the redacted toolkit tools instead.',
      };
    }
  }

  if (policy.blockedSecretOperations.some((op) => op.toLowerCase() === operation.toLowerCase())) {
    return {
      decision: 'deny',
      risk: 'secret',
      reason: 'Direct secret value reads are blocked so plaintext secrets do not enter the agent context.',
    };
  }

  if (/secret[_-]?string|secret[_-]?binary|showsecretversion|getsecretvalue/i.test(joined)) {
    return {
      decision: 'deny',
      risk: 'secret',
      reason: 'The command appears to retrieve a secret value. Use a runtime secret reference pattern instead.',
    };
  }

  const readOnly = hasReadPrefix(operation, policy);
  const executionOps =
    /(^|\.)(Invoke|SyncInvoke|AsyncInvoke|Send|Trigger|Execute|Start|Reboot|Restart|Stop|Publish|Deploy)/i;
  const isExecution = executionOps.test(operation) && !readOnly;
  const isWrite = !readOnly && hasWritePrefix(operation, policy);

  if (isExecution && !options.allowWrites) {
    return {
      decision: 'deny',
      risk: 'execution',
      reason: 'Huawei Cloud execution/trigger operation blocked until approved.',
    };
  }

  if (isWrite && !options.allowWrites) {
    return {
      decision: 'deny',
      risk: 'write',
      reason:
        'Huawei Cloud write operation blocked until the agent presents a plan and receives explicit user approval.',
    };
  }

  const obsutilWrites = [
    'mb',
    'cp',
    'mv',
    'rm',
    'delete',
    'mkdir',
    'sync',
    'restore',
    'chattri',
    'bucketpolicy',
    'lifecycle',
    'cors',
    'website',
    'sign',
    'share-add',
    'share-update',
    'share-rm',
  ];
  const obsutilReads = ['ls', 'stat', 'cat', 'help', 'version'];
  const isObs = service.toLowerCase() === 'obs' || service.toLowerCase() === 'hcloud obs';
  const isObsWrite = isObs && obsutilWrites.includes(operation);
  const isObsRead = isObs && obsutilReads.includes(operation);
  if (isObsWrite && !options.allowWrites) {
    return {
      decision: 'deny',
      risk: 'write',
      reason: 'OBS write operation blocked until the agent presents a plan and receives explicit user approval.',
    };
  }
  if (isObsRead) {
    return applyCommandRiskRules(
      {
        decision: 'allow',
        risk: 'read_only',
        reason: 'OBS read-only operation.',
        service,
        operation,
        args: normalizedArgs,
      },
      normalizedArgs,
      options,
    );
  }
  if (isObsWrite && options.allowWrites) {
    return applyCommandRiskRules(
      {
        decision: 'allow',
        risk: 'write',
        reason: 'OBS write operation approved by user.',
        service,
        operation,
        args: normalizedArgs,
      },
      normalizedArgs,
      options,
    );
  }

  if (isExecution && options.allowWrites) {
    return applyCommandRiskRules(
      {
        decision: 'allow',
        risk: 'execution',
        reason: 'Huawei Cloud execution/trigger operation approved by user.',
        service,
        operation,
        args: normalizedArgs,
      },
      normalizedArgs,
      options,
    );
  }

  if (isWrite && options.allowWrites) {
    return applyCommandRiskRules(
      {
        decision: 'allow',
        risk: 'write',
        reason: 'Huawei Cloud write operation approved by user.',
        service,
        operation,
        args: normalizedArgs,
      },
      normalizedArgs,
      options,
    );
  }

  return applyCommandRiskRules(
    {
      decision: 'allow',
      risk: readOnly ? 'read_only' : 'unknown_read',
      reason: readOnly
        ? 'Command appears to be a read-only Huawei Cloud operation.'
        : 'Command does not match a known write or secret operation; treat output as untrusted and redact it.',
      service,
      operation,
      args: normalizedArgs,
    },
    normalizedArgs,
    options,
  );
}

function splitSimpleCommand(command: unknown): string[] {
  return (
    String(command)
      .match(/"[^"]*"|'[^']*'|\S+/g)
      ?.map((part) => part.replace(/^['"]|['"]$/g, '')) || []
  );
}

export function classifyTextCommand(command: unknown, options: ClassifyOptions = {}): RiskDecision {
  const policy = options.policy || DEFAULT_POLICY;
  const text = String(command || '');

  if (matchesAny(text, policy.credentialFilePatterns)) {
    return {
      decision: 'deny',
      risk: 'credential',
      reason:
        'Reading Huawei Cloud credential or profile files is blocked. Use redacted profile inspection tools instead.',
    };
  }

  if (
    /(^|\s)(env|printenv|Get-ChildItem\s+Env:|gci\s+Env:|dir\s+Env:)/i.test(text) &&
    /HUAWEICLOUD|HWC_|HCLOUD|OS_/i.test(text)
  ) {
    return {
      decision: 'deny',
      risk: 'credential',
      reason: 'Dumping cloud credential environment variables is blocked.',
    };
  }

  // Credential variable references bypass the env-command gate above: HW_ is
  // the plugin's own documented credential prefix (HW_ACCESS_KEY/HW_SECRET_KEY/
  // HW_SECURITY_TOKEN), and `echo $HW_SECRET_KEY` / `printenv HW_ACCESS_KEY`
  // previously fell through to allow (#650 D4-2).
  //
  // The negative lookbehind exempts literal-NAME references — backslash-escaped
  // (`\$HW_*`) or single-quoted (`'$HW_*'`, which the shell never expands) —
  // while unescaped `$HW_*` is a potential expansion/dump regardless of the
  // command. No command-name whitelist, so no false negative (#650 review).
  if (
    /(?<!['\\])\$\{?(?:HUAWEICLOUD|HWC|HW|OS)_(?:ACCESS_KEY|SECRET_KEY|SECURITY_TOKEN)/i.test(text) ||
    /(?:^|\s)printenv\s+(?:HUAWEICLOUD|HWC|HW|OS)_(?:ACCESS_KEY|SECRET_KEY|SECURITY_TOKEN)/i.test(text)
  ) {
    return {
      decision: 'deny',
      risk: 'credential',
      reason: 'Printing cloud credential environment variables is blocked.',
    };
  }

  if (/(^|\s)hcloud(\.exe)?\s+/i.test(text)) {
    return classifyHcloudArgs(splitSimpleCommand(text), { ...options, rawCommand: text });
  }

  if (/ShowSecretVersion|GetSecretValue|secret_string|secret_binary/i.test(text)) {
    return {
      decision: 'deny',
      risk: 'secret',
      reason: 'Direct secret value retrieval patterns are blocked.',
    };
  }

  return applyRawCommandRiskRules(
    {
      decision: 'allow',
      risk: 'not_huaweicloud',
      reason: 'No Huawei Cloud safety rule matched.',
    },
    text,
    options,
  );
}

export function assertAllowed(result: RiskDecision): RiskDecision {
  if (result.decision === 'deny') {
    // Fresh Error we immediately augment; the cast names the shape we attach.
    const error = new Error(result.reason) as Error & { policy: RiskDecision };
    error.policy = result;
    throw error;
  }
  return result;
}
