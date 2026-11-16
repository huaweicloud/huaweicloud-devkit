// Session pack configuration. One mutation with three shapes (enable,
// disable, reset) over the override state in packs/enable.ts. The delta math
// works at the effective level (the closed enablement set), never at the raw
// requested seed: a duplicated DEVKIT_PACKS id or a closure-pulled pack must
// not turn a no-op into a stored override. The seed is joined in PACK_IDS
// order and always carries core (the base set includes it and disable cannot
// remove it), so the blank-value trap (blank means the full surface) is
// unreachable and needs no fallback branch.
import type {
  // Session pack configuration (the huaweicloud_packs_configure tool
  // handler), split out of tools.ts alongside the capability catalog. One
  // mutation with three shapes over the override state in packs/enable.ts;
  // the catalog module carries the read-only pack inventory.
  ToolArgs,
  CallToolOptions,
} from './tools.ts';
import {
  resolveEnabledPacks,
  setRuntimePacksOverride,
  clearRuntimePacksOverride,
  runtimePacksOverride,
} from './packs/enable.ts';
import { PACK_IDS, type PackId } from './lib/pack-types.ts';
import { closePackEnablement } from './lib/dependency-model.ts';
import { hashArgs } from './lib/approval-tokens.ts';
import { redactSecrets } from './safety-policy.ts';
import { asString } from './lib/as-text.ts';
import type { ApprovalSpec } from './approval-types.ts';

export function configurePacks(args: ToolArgs, opts: CallToolOptions): unknown {
  const enable = (args.enable ?? []).map((id) => String(id));
  const disable = (args.disable ?? []).map((id) => String(id));
  const reset = args.reset === true;
  if (!reset && enable.length === 0 && disable.length === 0) {
    return { ok: false, error: 'Provide at least one of enable, disable, or reset.' };
  }
  const bogus = [...enable, ...disable].filter((id) => !(PACK_IDS as readonly string[]).includes(id));
  if (bogus.length > 0) {
    return {
      ok: false,
      error: 'Unknown pack id(s): ' + bogus.join(', ') + '. Valid pack ids: ' + PACK_IDS.join(', ') + '.',
    };
  }
  if (disable.includes('core')) {
    return {
      ok: false,
      error:
        'core is always enabled (the pack meta, safety, and discovery surface is force-included) and cannot be disabled.',
    };
  }
  const overlap = enable.filter((id) => disable.includes(id));
  if (overlap.length > 0) {
    return {
      ok: false,
      error: 'Pack id(s) cannot be both enabled and disabled in one call: ' + overlap.join(', ') + '.',
    };
  }
  if (!opts.onPacksChanged) {
    return {
      ok: false,
      error:
        'Runtime pack configuration is available in stdio agent sessions only; this surface carries no session state.',
    };
  }
  const current = runtimePacksOverride();
  if (reset && (enable.length > 0 || disable.length > 0)) {
    return {
      ok: false,
      error: 'reset drops the whole session override and cannot be combined with enable or disable.',
    };
  }

  const currentEffective = resolveEnabledPacks();
  // Both lists were validated against PACK_IDS above, so the ids are PackId
  // at runtime; one narrowing here keeps the set math below typewise clean.
  const enableIds = enable as PackId[];
  const disableIds = disable as PackId[];
  const next = new Set<PackId>(currentEffective);
  for (const id of disableIds) next.delete(id);
  for (const id of enableIds) next.add(id);
  const wouldEnable = closePackEnablement(next).enabled;
  const same = wouldEnable.size === currentEffective.size && [...currentEffective].every((id) => wouldEnable.has(id));

  let changed = false;
  if (reset) {
    if (current) {
      clearRuntimePacksOverride();
      changed = true;
    }
  } else if (!same) {
    setRuntimePacksOverride(PACK_IDS.filter((id) => next.has(id)).join(','));
    changed = true;
  }
  if (changed) opts.onPacksChanged();

  const effective = resolveEnabledPacks();
  return {
    ok: true,
    changed,
    override: runtimePacksOverride()?.raw ?? null,
    effectivePacks: PACK_IDS.filter((id) => effective.has(id)),
    note: changed
      ? 'Session override active. Restarting the session restores the operator DEVKIT_PACKS posture.'
      : reset
        ? 'No session override was active.'
        : 'The requested surface already applies.',
  };
}

// The packs_configure approval registration (PR-3c). ALWAYS gated, because
// widening the session's disclosure face is the actual consequence — an
// enabled pack materializes its tools and skills for every later call — and
// the summarize view names the exact ids so the confirmation surface shows
// the consequence itself. requiresSessionSeam mirrors this handler's own
// stdio-only refusal: the gate checks opts.onPacksChanged BEFORE engaging
// (the refusal lives here, downstream of any dispatch-layer gate), so a
// no-seam call refuses with no token minted and no ledger entry — the
// ordering the gate's precheck exists to enforce. The binding is the
// {enable, disable, reset} projection, never the gate fields.
export const PACKS_CONFIGURE_APPROVAL_SPEC: Readonly<ApprovalSpec> = {
  domain: 'packs',
  flavor: 'always',
  tokenSource: 'gate',
  requiresSessionSeam: true,
  normalizeArgs: (args: ToolArgs): Record<string, unknown> => ({
    enable: args.enable,
    disable: args.disable,
    reset: args.reset,
  }),
  summarize: (value) => {
    // The view folds through the shared redaction vocabulary before any
    // field reaches the summary or pin view (the ApprovalSpec contract);
    // the hash binds the raw content.
    const safe = redactSecrets(value) as { enable?: unknown; disable?: unknown; reset?: unknown };
    const list = (ids: unknown): string =>
      Array.isArray(ids) ? ids.map((id) => String(id)).join(', ') : (asString(ids) ?? '');
    const parts: string[] = [];
    if (Array.isArray(safe.enable) && safe.enable.length > 0) parts.push(`enable pack(s) ${list(safe.enable)}`);
    if (Array.isArray(safe.disable) && safe.disable.length > 0) parts.push(`disable pack(s) ${list(safe.disable)}`);
    if (safe.reset === true) parts.push('reset the session override (restore the operator DEVKIT_PACKS posture)');
    if (parts.length === 0) parts.push('no-op: provide enable, disable, or reset');
    return {
      summary: `huaweicloud_packs_configure: ${parts.join('; ')}`,
      argsHash: hashArgs(value),
      pinView: safe,
    };
  },
  // NoDoomedToken (interrogate round 2, fix-in-pass i): the handler's own
  // five pure validations, hoisted BEFORE the mint — a shape the handler
  // refuses would burn the user's approval on a guaranteed refusal, so it
  // never mints. Message texts mirror the handler's exactly, so the two
  // layers can never drift into different teachings; the handler keeps its
  // own copies as the belt behind this floor.
  assertArgsExecutable: (value: unknown): void => {
    const { enable, disable, reset } = value as { enable?: unknown; disable?: unknown; reset?: unknown };
    const enableIds = Array.isArray(enable) ? enable.map((id) => String(id)) : [];
    const disableIds = Array.isArray(disable) ? disable.map((id) => String(id)) : [];
    const resetIs = reset === true;
    if (!resetIs && enableIds.length === 0 && disableIds.length === 0) {
      throw new Error('Provide at least one of enable, disable, or reset.');
    }
    const bogus = [...enableIds, ...disableIds].filter((id) => !(PACK_IDS as readonly string[]).includes(id));
    if (bogus.length > 0) {
      throw new Error('Unknown pack id(s): ' + bogus.join(', ') + '. Valid pack ids: ' + PACK_IDS.join(', ') + '.');
    }
    if (disableIds.includes('core')) {
      throw new Error(
        'core is always enabled (the pack meta, safety, and discovery surface is force-included) and cannot be disabled.',
      );
    }
    const overlap = enableIds.filter((id) => disableIds.includes(id));
    if (overlap.length > 0) {
      throw new Error('Pack id(s) cannot be both enabled and disabled in one call: ' + overlap.join(', ') + '.');
    }
    if (resetIs && (enableIds.length > 0 || disableIds.length > 0)) {
      throw new Error('reset drops the whole session override and cannot be combined with enable or disable.');
    }
  },
};
