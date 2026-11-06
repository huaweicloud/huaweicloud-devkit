import { DEFAULT_POLICY } from './default-policy.ts';
import { commandOperation, isLocalMetadataCommand } from './command-operation.ts';
import { hasReadPrefix, hasWritePrefix, type ClassifyOptions } from './policy.ts';
import { applyCommandRiskRules } from './risk-merge.ts';
import { stripShellQuotes } from './shell-text.ts';
import { findHcloudCommandSegments } from './segments.ts';
import { OBSUTIL_WRITES } from './tokens.ts';
import { stripExecutable } from './unwrap.ts';
import { SECRET_ARGS_RE } from './vocabulary.ts';
import type { RiskDecision } from '../risk-rule-engine.ts';

export function classifyHcloudArgs(args: unknown, options: ClassifyOptions = {}): RiskDecision {
  const policy = options.policy || DEFAULT_POLICY;
  const unwrappedTokens = stripExecutable(Array.isArray(args) ? args.map((arg) => String(arg)) : []);
  // Segment pass is UNCONDITIONAL: classifying only the leading command
  // reads the operation from line one of a multi-line script and lets a
  // write on any continuation line through. Every hcloud-leading segment
  // (split on ; && || | newline &) classifies; the most severe decision
  // wins. Prefer the RAW text for the split: tokenizing first and
  // re-joining collapses quoted command strings (`bash -c "hcloud …"` one
  // token) into a flat stream where the -c argument loses its grouping.
  if (!options._segmentDepth) {
    const hcloudSegments = findHcloudCommandSegments(options.rawCommand || unwrappedTokens.join(' '));
    if (hcloudSegments.length > 0) {
      const results = hcloudSegments.map((segment) => classifyHcloudArgs(segment, { ...options, _segmentDepth: 1 }));
      // results mirrors hcloudSegments, checked non-empty above; index 0 is defined.
      // With no severe verdict anywhere, the UNCERTAIN allow outranks a
      // confident one: the faces' unknown-service triage reads risk
      // 'unknown_read' off this verdict, so `hcloud obs ls && hcloud FooBar
      // BazQux` must not inherit the first segment's read_only and bury the
      // fabricated service behind segment order (interrogate round 1,
      // seat-1 K1). The decision stays allow either way — the PreToolUse
      // hook acts on deny alone, so the hook face is unchanged; this orders
      // the risk metadata the plan/advisory enrichment consumes.
      return (
        results.find((result) => result.decision === 'deny') ||
        results.find((result) => ['write', 'execution', 'secret', 'credential'].includes(result.risk ?? '')) ||
        results.find((result) => result.risk === 'unknown_read') ||
        results[0]!
      );
    }
    // A routed TEXT with no hcloud-leading segment is an orphan: prose
    // mentioning hcloud, a quoted package-name argument (`pip install
    // "hcloud"`), redirection remnants. The argv face's orphan
    // classification is a documented TS/py drift — text calls allow;
    // direct argv calls (tools, tests) and the segment recursion keep
    // the fallthrough classifier below.
    if (options.rawCommand !== undefined) {
      return applyCommandRiskRules(
        {
          decision: 'allow',
          risk: 'not_huaweicloud',
          reason: 'No Huawei Cloud safety rule matched.',
        },
        unwrappedTokens,
        options,
      );
    }
  }
  const { service, operation, args: normalizedArgs } = commandOperation(args);
  const joined = normalizedArgs.join(' ');

  if (!normalizedArgs.length && options._narrowRouted !== false) {
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

  const serviceShadow = stripShellQuotes(service).toLowerCase();
  if (serviceShadow === 'configure') {
    const subcommand = operation.toLowerCase();
    const subcommandShadow = stripShellQuotes(operation).toLowerCase();
    if (
      (policy.blockedConfigureSubcommands.map((cmd) => cmd.toLowerCase()).includes(subcommand) ||
        policy.blockedConfigureSubcommands.map((cmd) => cmd.toLowerCase()).includes(subcommandShadow)) &&
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

  if (
    policy.blockedSecretOperations.some(
      (op) =>
        op.toLowerCase() === operation.toLowerCase() || op.toLowerCase() === stripShellQuotes(operation).toLowerCase(),
    )
  ) {
    return {
      decision: 'deny',
      risk: 'secret',
      reason: 'Direct secret value reads are blocked so plaintext secrets do not enter the agent context.',
    };
  }

  if (SECRET_ARGS_RE.test(joined)) {
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

  const obsutilWrites = OBSUTIL_WRITES;
  const obsutilReads = ['ls', 'stat', 'cat', 'help', 'version'];
  const isObs = service.toLowerCase() === 'obs';
  // Lowercase the vocab lookup (py-twin parity): the real binary rejects
  // case-variant subcommands, but the policy must not lean on that — the
  // wired Node hook faces agent-constructed text, not the binary.
  const isObsWrite = isObs && obsutilWrites.has(operation.toLowerCase());
  const isObsRead = isObs && obsutilReads.includes(operation.toLowerCase());
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

export function assertAllowed(result: RiskDecision): RiskDecision {
  if (result.decision === 'deny') {
    // Fresh Error we immediately augment; the cast names the shape we attach.
    const error = new Error(result.reason) as Error & { policy: RiskDecision };
    error.policy = result;
    throw error;
  }
  return result;
}
