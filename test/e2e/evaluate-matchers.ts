// The evaluator's matcher layer: predicates over one recording channel,
// shared by the per-kind verdict constructors (evaluate-kinds.ts). Pure
// functions — no evidence strings here, only hits.

import type { AgentSaysMatcher, DisclosureMatcher, HcloudArgMatcher, Range, ToolCallMatcher } from './types.ts';
import type { HcloudCall, TraceDisclosure, TraceToolCall } from './evaluate.ts';

const UNBOUNDED = Number.POSITIVE_INFINITY;

export function inRange(count: number, range: Range | undefined, defaultMin = 1): boolean {
  const min = range?.min ?? defaultMin;
  const max = range?.max ?? UNBOUNDED;
  return count >= min && count <= max;
}

export function describeRange(range: Range | undefined, defaultMin = 1): string {
  const min = range?.min ?? defaultMin;
  const max = range?.max ?? UNBOUNDED;
  return `${min}..${max === UNBOUNDED ? '∞' : max}`;
}

export function matchHcloud(matcher: HcloudArgMatcher, calls: HcloudCall[]): string[] {
  return calls
    .filter((call) => {
      if (call.argv.length < matcher.head.length) return false;
      for (let i = 0; i < matcher.head.length; i++) {
        if (call.argv[i] !== matcher.head[i]) return false;
      }
      if (matcher.flags) {
        for (const [name, value] of Object.entries(matcher.flags)) {
          const needle = `--${name}=${value}`;
          if (!call.argv.some((arg) => arg === needle)) return false;
        }
      }
      return true;
    })
    .map((call) => call.argv.join(' '));
}

// Shallow partial match against a traced (redacted) args object. Arrays
// match by element-wise prefix (the hcloud argv matcher precedent);
// primitives match by strict equality, except keys named in ignoreCase
// (scalars only, folded — the gateway resolves product/api ids
// case-insensitively, measured).
export function argsPartialMatch(
  expected: Record<string, unknown>,
  actual: unknown,
  ignoreCase?: readonly string[],
): boolean {
  if (!actual || typeof actual !== 'object' || Array.isArray(actual)) return false;
  for (const [key, value] of Object.entries(expected)) {
    const traced = (actual as Record<string, unknown>)[key];
    if (Array.isArray(value) && Array.isArray(traced)) {
      if (value.length > traced.length) return false;
      for (let i = 0; i < value.length; i++) {
        if (value[i] !== traced[i]) return false;
      }
    } else if (
      ignoreCase?.includes(key) &&
      typeof value === 'string' &&
      typeof traced === 'string' &&
      value.toLowerCase() === traced.toLowerCase()
    ) {
      continue;
    } else if (value !== traced) {
      return false;
    }
  }
  return true;
}

export function matchToolCall(matcher: ToolCallMatcher, calls: TraceToolCall[]): TraceToolCall[] {
  const names = new Set(Array.isArray(matcher.name) ? matcher.name : [matcher.name]);
  return calls.filter(
    (call) =>
      names.has(call.name) &&
      (matcher.ok === undefined || call.ok === matcher.ok) &&
      (!matcher.args || argsPartialMatch(matcher.args, call.args)),
  );
}

export function matchDisclosure(matcher: DisclosureMatcher, events: TraceDisclosure[]): TraceDisclosure[] {
  return events.filter(
    (event) =>
      event.event === matcher.event && (matcher.toolCount === undefined || event.toolCount === matcher.toolCount),
  );
}

export function matchAgentSays(matcher: AgentSaysMatcher, finalText: string | null): boolean {
  if (!finalText) return false;
  const lower = finalText.toLowerCase();
  return matcher.any.some((keyword) => lower.includes(keyword.toLowerCase()));
}
