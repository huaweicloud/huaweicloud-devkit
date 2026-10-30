import { z } from 'zod';

import { vendorConfirmed } from '../../lib/tool-schema-parts.ts';
import {
  hdkitVoucherStatus,
  hdkitVoucherClaim,
  hdkitCompetitionVoucherClaim,
} from '../../lib/hdkit/hdkitservice-api.ts';
import { flushTelemetryEvents } from '../../telemetry/telemetry.ts';
import type { PackToolDefinition, LooseToolSchema } from '../../lib/pack-types.ts';
import type { CallToolOptions, ToolArgs } from '../../tools.ts';

// Handlers migrated verbatim from src/tools.ts.

async function handleVoucherStatus(args: ToolArgs = {}, _opts: CallToolOptions = {}) {
  return await hdkitVoucherStatus(args.domain_id);
}

// P0 sync flush (E4c, the #1014 wave): a claim is one-shot and the session
// often ends right after it, so the claim telemetry must not ride the
// 60s timer — await the flush AFTER the claim result arrives and BEFORE
// returning, so the tool:huaweicloud_voucher_claim event gets a real send
// attempt by the time the caller sees success. Scope, honestly: the await
// is one flush round plus any in-flight chain — when a dead telemetry
// endpoint has accumulated ≥ BATCH_SIZE (100) queued events, the claim
// event can ride the un-flushed tail, which the exit spool (E4b) and the
// periodic timer then own; the guarantee is "not lost when the session
// ends", layered, not "synchronously delivered at any queue depth". The
// flush promise never rejects (E4a: failures requeue or drop), so a
// telemetry outage degrades to a delayed requeue, never a failed claim
// result. Latency coupling: with a healthy endpoint the await adds one
// fetch; with an unreachable one the wait scales with concurrent flush
// arrivals (each in-flight collision adds a follow-up round — on a busy
// multi-session remote this can exceed the per-batch retry budget's
// horizon; the budget bounds each batch's delivery lifetime, not the
// chain's latency) — on the stdio face that is the documented trade, and
// it equally applies to the remote surface, whose voucher calls dispatch through this same handler against
// process-wide telemetry state (initialized on each initialize handshake;
// a tools/call-first request on a fresh remote process has no telemetry
// state and the await is a no-op). voucher_status stays unflushed on
// purpose: a status probe does not end a session, and the claim-success
// moment is the P0 the review named.
async function handleVoucherClaim(args: ToolArgs = {}, _opts: CallToolOptions = {}) {
  const result = await hdkitVoucherClaim(args.domain_id);
  await flushTelemetryEvents();
  return result;
}

async function handleCompetitionVoucherClaim(args: ToolArgs = {}, _opts: CallToolOptions = {}) {
  const result = await hdkitCompetitionVoucherClaim(args.domain_id);
  await flushTelemetryEvents();
  return result;
}

const voucherStatusSchema = z.looseObject({
  domain_id: z
    .string()
    .optional()
    .describe('Optional. Leave empty in production — account is resolved from IAM automatically.'),
});

const voucherClaimSchema = z.looseObject({
  vendorConfirmed,
  domain_id: z
    .string()
    .optional()
    .describe('Optional. Leave empty in production — account is resolved from IAM automatically.'),
});

export const VOUCHER_TOOLS = [
  {
    name: 'huaweicloud_voucher_status',
    description:
      '查询代金券领取状态。当会话已处于华为云任务上下文（用户已指明华为云，或先前轮次已确认）且用户首次使用或询问插件能力时，主动调用本工具检查：未领取（claimed=false）则主动提示可领取一张代金券；已领取（claimed=true）则不提示、不打扰。厂商未定（用户未指明、上下文无法推断）时不要调用——先问用户用的是哪家云。',
    schema: voucherStatusSchema,
    handler: handleVoucherStatus,
  },
  {
    name: 'huaweicloud_voucher_claim',
    description:
      '领取代金券（一人一次）。重复领取会返回已领取。Vendor-gated (vendorConfirmed)：仅在厂商已确立时调用（见参数规则）；厂商未定时先问用户用的是哪家云。',
    schema: voucherClaimSchema,
    handler: handleVoucherClaim,
  },
  {
    name: 'huaweicloud_competition_voucher_claim',
    description:
      '领取华为开发者大赛·小红书skill创新赛专属华为云代金券。前置条件：用户已完成该赛事报名（后端自动校验，未报名返回 code=HDKIT_NOT_SIGNED_UP）。仅当用户明确要求领取该赛事代金券时调用，不要主动提示。重复领取会返回已领取。Vendor-gated (vendorConfirmed)：仅在厂商已确立时调用（见参数规则）；厂商未定时先问用户用的是哪家云。',
    schema: voucherClaimSchema,
    handler: handleCompetitionVoucherClaim,
  },
] as const satisfies readonly PackToolDefinition[];

export type VoucherToolName = (typeof VOUCHER_TOOLS)[number]['name'];

// Schema map keyed by tool name for src/tool-schemas.ts: TOOL_SCHEMAS spreads
// it in place, keeping the satisfies Record<ToolName, LooseToolSchema>
// completeness check over every ToolName key.
export const VOUCHER_TOOL_SCHEMAS: Readonly<Record<VoucherToolName, LooseToolSchema>> = {
  huaweicloud_voucher_status: voucherStatusSchema,
  huaweicloud_voucher_claim: voucherClaimSchema,
  huaweicloud_competition_voucher_claim: voucherClaimSchema,
};

// Dispatch map merged into PACK_TOOL_HANDLERS in packs/registry.ts. Typed over
// VoucherToolName, so a tool added to VOUCHER_TOOLS without a handler entry
// here — or the reverse — fails to compile instead of failing at runtime.
export const VOUCHER_TOOL_HANDLERS: Readonly<Record<VoucherToolName, PackToolDefinition['handler']>> = {
  huaweicloud_voucher_status: handleVoucherStatus,
  huaweicloud_voucher_claim: handleVoucherClaim,
  huaweicloud_competition_voucher_claim: handleCompetitionVoucherClaim,
};
