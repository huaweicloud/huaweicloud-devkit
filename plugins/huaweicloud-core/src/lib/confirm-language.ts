// The confirmation form's display language — the display-tier counterpart
// of lib/approval-mode.ts. Approval MODE is a safety concern and fails
// loud (a bogus DEVKIT_APPROVAL_MODE aborts the server at boot); display
// LANGUAGE is a UX concern and fails SOFT: an unrecognized value at any
// tier falls through to the next, and a gated call never fails because its
// language could not be resolved.
//
// Three tiers, highest authority first:
//   1. DEVKIT_CONFIRM_LANG   the operator's explicit pin — human-written
//      configuration outranks any inference (the same doctrine as
//      DEVKIT_APPROVAL_MODE's user-value-wins).
//   2. args.confirmLanguage  the model's per-call relay of the user's
//      conversation language — the ONLY channel that observes the
//      conversation, because the MCP server never sees the chat; the model
//      is the context. The schema field's description teaches the model to
//      send it.
//   3. the machine locale    LC_ALL/LC_MESSAGES/LANG/LANGUAGE — the
//      pre-hint behavior, kept as the floor.
// Values normalize by prefix: /^zh/i → zh, /^en/i → en, anything else
// ('fr', garbage, empty) is unrecognized and falls through. Only the form's
// DISPLAY strings localize (message, title, enumNames — see
// approval-gate.ts); the enum VALUES, the refusal envelopes, and the T3
// chat instruction stay English in every language — wire vocabulary the
// gate, the ledger, and the tests pin.

export type ConfirmLanguage = 'zh' | 'en';

const ZH = /^zh/i;
const EN = /^en/i;

function normalize(value: string | undefined): ConfirmLanguage | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  if (ZH.test(trimmed)) return 'zh';
  if (EN.test(trimmed)) return 'en';
  return undefined;
}

export function resolveConfirmLanguage(
  args: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
): ConfirmLanguage {
  const pinned = normalize(env.DEVKIT_CONFIRM_LANG);
  if (pinned !== undefined) return pinned;
  const hinted = normalize(typeof args.confirmLanguage === 'string' ? args.confirmLanguage : undefined);
  if (hinted !== undefined) return hinted;
  const locales = [env.LC_ALL, env.LC_MESSAGES, env.LANG, env.LANGUAGE];
  if (locales.some((locale) => typeof locale === 'string' && ZH.test(locale))) return 'zh';
  return 'en';
}
