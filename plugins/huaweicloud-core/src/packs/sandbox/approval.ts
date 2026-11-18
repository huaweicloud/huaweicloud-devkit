import { asText } from '../../lib/as-text.ts';
import { hashArgs } from '../../lib/approval-tokens.ts';
import { classifyTextCommand, redactSecrets } from '../../safety-policy.ts';
import { evaluateCommandRisk, loadRiskRules, type RiskCatalog } from '../../risk-rule-engine.ts';
import { redactWithSupplementalKeys } from '../../lib/supplemental-redaction.ts';
import { isSecretRef } from '../../lib/secret-vault/refs.ts';
import type { ApprovalSpec } from '../../approval-types.ts';
import type { ToolArgs } from '../../tools.ts';

// The sandbox pack's approval spec table. Nine tools join the gate: the two
// exec faces are CLASSIFIED (content decides — a benign command runs with no
// confirmation surface at all, a write-classified one confirms on every
// call), the seven mutating lifecycle faces are ALWAYS (a human present per
// call, no content rule ever exempts them). The strict classification runs
// on the exec faces' `command` argument through the SAME engines the Bash
// face uses — classifyTextCommand plus the cloud-risk-rules catalog — so a
// destructive command is a disabled guard at the gate face (never a minted
// token the run then denies, ApprovalCoreMint's NoDoomedToken) and the deny
// survives every confirmation channel.
//
// The binding value is the call's own arguments with the approval carriers
// (approvalToken, approvedByUser, vendorConfirmed) stripped: the hash the
// token binds and the ledger records is the CONTENT the user confirms, so a
// retry that only drifts on a carrier rides the same consent key.

// Approval-chain carrier fields: never part of the content the user
// confirms. `command` stays IN the binding — on the exec faces it is the
// content itself, not a display anchor (the commandAnchor machinery is the
// hcloud pair's; these tools declare none).
const APPROVAL_CARRIER_KEYS = new Set(['approvalToken', 'approvedByUser', 'vendorConfirmed']);

export function bindingArgs(args: ToolArgs): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args ?? {})) {
    if (APPROVAL_CARRIER_KEYS.has(key)) continue;
    out[key] = value;
  }
  return out;
}

// The pin view: the binding value through the product's redaction pipeline
// plus the supplemental key vocabulary the trace face shares (api_key and
// the value channel — sandbox_credentials' long-lived DevBridge key rides
// api_key; no sandbox tool uses `value`, so the entry is collision-free).
function pinViewOf(bindingValue: unknown): unknown {
  return redactWithSupplementalKeys(redactSecrets(bindingValue));
}

// The strict ruling over an exec command, one evaluation shared by the
// spec's classify (the confirmation question) and its execution floor (the
// never-unlockable denies): write/execution content confirms, every other
// deny — destructive, secret, credential, invalid — refuses outright
// whatever the channel, and the rules engine's own deny findings win over a
// text-classifier pass. The WeakMap collapses the two evaluations the gate
// performs per arrival (classify, then the floor) onto one.
export interface SandboxCommandRuling {
  verdict: 'required' | 'none';
  denyReason?: string;
}

const rulingMemo = new WeakMap<object, SandboxCommandRuling>();

function computeRuling(command: string): SandboxCommandRuling {
  // The catalog is file-backed; read it once per process (classify stays a
  // pure function of its input — same command, same ruling).
  const catalog: RiskCatalog = loadRiskRules();
  const rulesDeny = evaluateCommandRisk(command, { catalog }).findings.find((finding) => finding.severity === 'deny');
  if (rulesDeny) {
    return {
      verdict: 'none',
      denyReason: `rule ${rulesDeny.ruleId}: ${rulesDeny.message} Remediation: ${rulesDeny.remediation}`,
    };
  }
  const text = classifyTextCommand(command);
  if (text.decision === 'deny' && (text.risk === 'write' || text.risk === 'execution')) {
    return { verdict: 'required' };
  }
  if (text.decision === 'deny') {
    return { verdict: 'none', denyReason: text.reason ?? 'the command is blocked by strict classification.' };
  }
  return { verdict: 'none' };
}

function rulingForBinding(bindingValue: unknown): SandboxCommandRuling {
  if (bindingValue && typeof bindingValue === 'object' && !Array.isArray(bindingValue)) {
    const cached = rulingMemo.get(bindingValue);
    if (cached) return cached;
    const ruling = computeRuling(asText((bindingValue as Record<string, unknown>).command ?? ''));
    rulingMemo.set(bindingValue, ruling);
    return ruling;
  }
  return computeRuling(asText(bindingValue));
}

// The execution floor: a strict deny refuses in BOTH modes, before any mint,
// consent record, or token consume — destructive content is never
// unlockable, so the refusal names the rule and nothing burns.
function assertCommandAllowed(bindingValue: unknown): void {
  const ruling = rulingForBinding(bindingValue);
  if (ruling.denyReason === undefined) return;
  throw new Error(
    'Sandbox command denied by strict classification (no confirmation unlocks it). ' + `${ruling.denyReason}`,
  );
}

// One summarized view per tool family. Every string the view carries is
// built from the REDACTED pin view — the summarize contract forbids the raw
// argument stream in any popup surface.
function asRecordView(bindingValue: unknown): Record<string, unknown> {
  return bindingValue && typeof bindingValue === 'object' && !Array.isArray(bindingValue)
    ? (bindingValue as Record<string, unknown>)
    : {};
}

function viewOf(bindingValue: unknown, summary: (view: Record<string, unknown>) => string) {
  const record = asRecordView(bindingValue);
  return {
    summary: summary(record),
    argsHash: hashArgs(bindingValue),
    pinView: pinViewOf(bindingValue),
  };
}

// A short redacted field echo for the summary line: "port 8080" style, never
// the whole JSON blob.
function fieldEcho(view: Record<string, unknown>, keys: string[]): string {
  const parts: string[] = [];
  for (const key of keys) {
    const value = view[key];
    if (value === undefined || value === null || value === '') continue;
    const text = asText(pinViewOf(value));
    parts.push(`${key} ${text}`);
  }
  return parts.join(', ');
}

function execView(toolShortName: string, bindingValue: unknown) {
  const record = asRecordView(bindingValue);
  const command = typeof record.command === 'string' ? asText(pinViewOf(record.command)) : '';
  const where = fieldEcho(record, ['workspace_id', 'username']);
  const summary =
    `huaweicloud_sandbox_${toolShortName}${where !== '' ? ` (${where})` : ''}: ` +
    (command !== '' ? command : '(no command)');
  return {
    summary,
    argsHash: hashArgs(bindingValue),
    pinView: pinViewOf(bindingValue),
    ...(command !== '' ? { command } : {}),
  };
}

// One shared spec line for every sandbox registration: the binding value is
// the call's own arguments with the approval carriers stripped (see
// bindingArgs). Without this the carriers ride into the hash — a retry
// carrying the token would bind differently from the mint, and every
// confirmation would be single-use-by-construction.
function sandboxBinding(): Pick<ApprovalSpec, 'domain' | 'tokenSource' | 'normalizeArgs'> {
  return { domain: 'sandbox', tokenSource: 'gate', normalizeArgs: (args) => bindingArgs(args) };
}

function execSpec(toolShortName: 'exec_with_session' | 'exec_one_shot'): ApprovalSpec {
  return {
    ...sandboxBinding(),
    flavor: 'classified',
    classify: (bindingValue) => rulingForBinding(bindingValue).verdict,
    assertArgsExecutable: (bindingValue) => assertCommandAllowed(bindingValue),
    // The command IS the content, and the confirmation surfaces display it,
    // so it anchors itself: provided must equal the binding's own command
    // (it always does when the call is honest — the binding derives from
    // the args). The anchor exists so the no-anchor refusal shape (a
    // stuffed command on a tool that declares no displayable line) never
    // kills the exec faces after the serial landing (the anchor-collision
    // decision): the exec calls are anchored, the seven lifecycle faces are
    // not and refuse a stuffed command.
    commandAnchor: (bindingValue) => {
      const command = (bindingValue as Record<string, unknown>).command;
      return typeof command === 'string' && command !== '' ? [command] : [];
    },
    summarize: (bindingValue) => execView(toolShortName, bindingValue),
  };
}

const connectSpec: ApprovalSpec = {
  ...sandboxBinding(),
  flavor: 'always',
  summarize: (bindingValue) =>
    viewOf(bindingValue, (view) => {
      const target = fieldEcho(view, ['pool_type']);
      return `huaweicloud_sandbox_connect: connect a sandbox${target !== '' ? ` (${target})` : ''}`;
    }),
};

const exposeTunnelSpec: ApprovalSpec = {
  ...sandboxBinding(),
  flavor: 'always',
  summarize: (bindingValue) =>
    viewOf(bindingValue, (view) => {
      const target = fieldEcho(view, ['port', 'expiry_hours']);
      return `huaweicloud_sandbox_expose_tunnel: expose a public tunnel URL${target !== '' ? ` (${target})` : ''}`;
    }),
};

const renewTunnelSpec: ApprovalSpec = {
  ...sandboxBinding(),
  flavor: 'always',
  summarize: (bindingValue) =>
    viewOf(bindingValue, (view) => {
      const target = fieldEcho(view, ['tunnel_id', 'expiry_hours']);
      return `huaweicloud_sandbox_renew_tunnel: renew a tunnel's lifetime${target !== '' ? ` (${target})` : ''}`;
    }),
};

const keepaliveWatchdogSpec: ApprovalSpec = {
  ...sandboxBinding(),
  flavor: 'always',
  summarize: (bindingValue) =>
    viewOf(bindingValue, (view) => {
      const count = Array.isArray(view.tunnels) ? view.tunnels.length : 0;
      const ids = Array.isArray(view.tunnels)
        ? view.tunnels
            .map((tunnel) =>
              tunnel && typeof tunnel === 'object' ? asText((tunnel as Record<string, unknown>).tunnel_id ?? '') : '',
            )
            .filter((id) => id !== '')
        : [];
      return `huaweicloud_sandbox_keepalive_watchdog: install/replace the keepalive watchdog over ${count} tunnel(s)${
        ids.length > 0 ? ` (${ids.join(', ')})` : ''
      }`;
    }),
};

const signAgreementSpec: ApprovalSpec = {
  ...sandboxBinding(),
  flavor: 'always',
  summarize: (bindingValue) =>
    viewOf(
      bindingValue,
      () =>
        'huaweicloud_sandbox_sign_agreement: sign all unsigned or outdated Huawei Cloud developer service agreements for the current user',
    ),
};

const credentialsSpec: ApprovalSpec = {
  ...sandboxBinding(),
  flavor: 'always',
  summarize: (bindingValue) => {
    // Name the api_key channel the HANDLER will actually use, never the
    // value (interrogate F1 round 3, F2): handlers-credentials resolves
    // env-first (process.env.HW_API_KEY || args.api_key), so the view
    // mirrors that precedence — an env tier set makes the parameter or ref
    // beside it a dead letter the confirmation must not claim. A vault ref
    // is itself conversation-safe (that is the ref doctrine), and the
    // parameter channel is named with the value redacted by the pin-view
    // pass.
    const rawApiKey = asText(asRecordView(bindingValue).api_key ?? '');
    const channel = process.env.HW_API_KEY
      ? 'api_key via environment (value redacted)'
      : rawApiKey !== ''
        ? isSecretRef(rawApiKey)
          ? `api_key via vault ref ${rawApiKey}`
          : 'api_key via parameter (value redacted)'
        : '';
    return viewOf(bindingValue, (view) => {
      const target = fieldEcho(view, ['session_id', 'dev_stage_id', 'enable_sts']);
      const scope = target !== '' ? ` (${target})` : '';
      return (
        `huaweicloud_sandbox_credentials: validate and inject temporary credentials into the sandbox${scope}` +
        (channel !== '' ? `; ${channel}` : '')
      );
    });
  },
};

// 关机（port-pr6）：不可逆生命周期面，always。确认视图点名目标 id 与
// close-not-delete 事实——确认面显示的是开发者要关哪台沙箱，不是参数流。
const shutdownSpec: ApprovalSpec = {
  ...sandboxBinding(),
  flavor: 'always',
  summarize: (bindingValue) =>
    viewOf(bindingValue, (view) => {
      const target = fieldEcho(view, ['session_id', 'dev_stage_id', 'workspace_id']);
      return `huaweicloud_sandbox_shutdown: shut down the sandbox (close only — instance retained, reconnect wakes it)${target !== '' ? ` (${target})` : ''}`;
    }),
};

export const SANDBOX_APPROVAL_SPECS = {
  huaweicloud_sandbox_connect: connectSpec,
  huaweicloud_sandbox_exec_with_session: execSpec('exec_with_session'),
  huaweicloud_sandbox_exec_one_shot: execSpec('exec_one_shot'),
  huaweicloud_sandbox_expose_tunnel: exposeTunnelSpec,
  huaweicloud_sandbox_renew_tunnel: renewTunnelSpec,
  huaweicloud_sandbox_keepalive_watchdog: keepaliveWatchdogSpec,
  huaweicloud_sandbox_sign_agreement: signAgreementSpec,
  huaweicloud_sandbox_credentials: credentialsSpec,
  huaweicloud_sandbox_shutdown: shutdownSpec,
} as const satisfies Record<string, ApprovalSpec>;
