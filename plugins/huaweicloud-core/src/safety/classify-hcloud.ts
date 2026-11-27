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

// The dry-run preflight vocabulary (see the carve-out comment in
// classifyHcloudArgs). The global `--dryrun` flag is KooCLI's own
// "print the request, do not execute" (hcloud --help, service-agnostic);
// the body param `--dry_run=true` is the service-side preflight, pinned to
// the `${service} ${operation}` pairs (lowercased) whose operation-level
// --help documents it. Verified against `hcloud <op> --help` on
// 2026-11-27 for both entries; a future operation joins the set only with
// the same --help evidence.
const DRYRUN_GLOBAL_TOKEN = '--dryrun';
const DRY_RUN_PREFLIGHT_OPERATIONS = new Set(['ecs createservers', 'ecs createpostpaidservers']);
const DRY_RUN_EXACT_TOKEN = '--dry_run=true';

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

  // The dry-run preflight carve-out (the argv tool faces only — never the
  // text/hook faces, see the rawCommand guard): a command whose child
  // provably creates nothing is not a write, so plans/runs need no
  // confirmation. Two documented zero-side-effect channels:
  //   (a) the KooCLI GLOBAL flag `--dryrun` — "Print the request message
  //       after verification, without execution" (hcloud --help): no
  //       request ever leaves the CLI, for ANY service/operation.
  //   (b) the ECS body param `--dry_run=true` — the service-side preflight
  //       ("true: indicates that only the request is sent, but the ECS
  //       will not be created. Check items include mandatory parameters
  //       and request format", per `hcloud ECS CreateServers --help`),
  //       allowlisted to the operations whose --help documents it
  //       (ECS CreateServers / CreatePostPaidServers, verified 2026-11-27).
  // Fences keep the carve-out narrower than the facts it rests on:
  //   - EXACT TOKENS — only `--dryrun` and `--dry_run=true`. Case
  //     variants, `=True`, `=1`, `--dry-run`, or a bare `--dry_run` keep
  //     the write verdict, so a misspelled preflight still asks the user
  //     (fail-closed).
  //   - The body-param arm refuses `--cli-jsonInput`: a JSON body could
  //     carry a conflicting dry_run value under a precedence the CLI owns
  //     and the classifier cannot see.
  //   - The rawCommand === undefined guard is the face boundary: every
  //     hook entry point (the .mjs PreToolUse twin, the opencode
  //     in-process gate, and every nested walk inside classifyTextCommand)
  //     classifies TEXT with rawCommand set, so raw Bash keeps its deny
  //     and the py twin's verdicts stay parity-true. The argv faces —
  //     plan/run tool calls — carry no rawCommand and take the carve-out.
  //     A compound argv (a value containing `;`/`&&`/…) fragments in the
  //     segment pass and lands here WITHOUT its preflight token in the
  //     fragment, so the severity merge denies fail-closed.
  if (
    options.rawCommand === undefined &&
    (normalizedArgs.includes(DRYRUN_GLOBAL_TOKEN) ||
      (DRY_RUN_PREFLIGHT_OPERATIONS.has(`${service.toLowerCase()} ${operation.toLowerCase()}`) &&
        normalizedArgs.includes(DRY_RUN_EXACT_TOKEN) &&
        !normalizedArgs.some((arg) => arg.startsWith('--cli-jsonInput'))))
  ) {
    return applyCommandRiskRules(
      {
        decision: 'allow',
        risk: 'preflight',
        reason:
          'Documented dry-run preflight: the CLI prints the request without executing, or the service validates it and creates nothing, so no confirmation is required.',
        service,
        operation,
        args: normalizedArgs,
      },
      normalizedArgs,
      options,
    );
  }

  const readOnly = hasReadPrefix(operation, policy);
  const executionOps =
    /(^|\.)(Invoke|SyncInvoke|AsyncInvoke|Send|Trigger|Execute|Start|Reboot|Restart|Stop|Publish|Deploy)/i;
  const isExecution = executionOps.test(operation) && !readOnly;
  const isWrite = !readOnly && hasWritePrefix(operation, policy);

  if (isExecution && !options.allowWrites) {
    return applyCommandRiskRules(
      {
        decision: 'deny',
        risk: 'execution',
        reason: 'Huawei Cloud execution/trigger operation blocked until approved.',
      },
      normalizedArgs,
      options,
    );
  }

  if (isWrite && !options.allowWrites) {
    return applyCommandRiskRules(
      {
        decision: 'deny',
        risk: 'write',
        reason:
          'Huawei Cloud write operation blocked until the agent presents a plan and receives explicit user approval.',
      },
      normalizedArgs,
      options,
    );
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
    return applyCommandRiskRules(
      {
        decision: 'deny',
        risk: 'write',
        reason: 'OBS write operation blocked until the agent presents a plan and receives explicit user approval.',
      },
      normalizedArgs,
      options,
    );
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
