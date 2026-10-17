import type {
  AgentSaysMatcher,
  DisclosureMatcher,
  E2eCase,
  Expectation,
  HcloudArgMatcher,
  Range,
  SequenceExpectation,
  ToolCallMatcher,
} from './types.ts';
import type { HttpRecording } from './http-fake.ts';
import type { WsConnectionRecording } from './ws-fake/hwlink-server.ts';

// Pure evaluation over collected recordings. Verdicts gate only on
// devkit-observable outbound artifacts (fake-boundary recordings, the
// env-gated trace, files); agent text is a soft signal.

export interface HcloudCall {
  argv: string[];
}

export interface TraceToolCall {
  name: string;
  args: unknown;
  ok: boolean;
}

export interface TraceDisclosure {
  event: 'toolsList' | 'toolsListChanged';
  toolCount?: number;
}

export interface GatewayRecording {
  method: string;
  tool: string | null;
  args: unknown;
}

export interface Recordings {
  hcloud: HcloudCall[];
  toolCalls: TraceToolCall[];
  disclosures: TraceDisclosure[];
  http: HttpRecording[];
  gateway: GatewayRecording[];
  ws: WsConnectionRecording[];
  files: Record<string, string | null>;
  finalText: string | null;
}

export interface ExpectationVerdict {
  expectation: Expectation;
  pass: boolean;
  evidence: string;
}

export interface CaseVerdict {
  caseId: string;
  pass: boolean;
  liveness: boolean;
  expectations: ExpectationVerdict[];
  soft: ExpectationVerdict[];
}

const UNBOUNDED = Number.POSITIVE_INFINITY;

function inRange(count: number, range: Range | undefined, defaultMin = 1): boolean {
  const min = range?.min ?? defaultMin;
  const max = range?.max ?? UNBOUNDED;
  return count >= min && count <= max;
}

function describeRange(range: Range | undefined, defaultMin = 1): string {
  const min = range?.min ?? defaultMin;
  const max = range?.max ?? UNBOUNDED;
  return `${min}..${max === UNBOUNDED ? '∞' : max}`;
}

function matchHcloud(matcher: HcloudArgMatcher, calls: HcloudCall[]): string[] {
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
// primitives match by strict equality.
function argsPartialMatch(expected: Record<string, unknown>, actual: unknown): boolean {
  if (!actual || typeof actual !== 'object' || Array.isArray(actual)) return false;
  for (const [key, value] of Object.entries(expected)) {
    const traced = (actual as Record<string, unknown>)[key];
    if (Array.isArray(value) && Array.isArray(traced)) {
      if (value.length > traced.length) return false;
      for (let i = 0; i < value.length; i++) {
        if (value[i] !== traced[i]) return false;
      }
    } else if (value !== traced) {
      return false;
    }
  }
  return true;
}

function matchToolCall(matcher: ToolCallMatcher, calls: TraceToolCall[]): TraceToolCall[] {
  return calls.filter(
    (call) =>
      call.name === matcher.name &&
      (matcher.ok === undefined || call.ok === matcher.ok) &&
      (!matcher.args || argsPartialMatch(matcher.args, call.args)),
  );
}

function matchDisclosure(matcher: DisclosureMatcher, events: TraceDisclosure[]): TraceDisclosure[] {
  return events.filter(
    (event) =>
      event.event === matcher.event && (matcher.toolCount === undefined || event.toolCount === matcher.toolCount),
  );
}

function matchAgentSays(matcher: AgentSaysMatcher, finalText: string | null): boolean {
  if (!finalText) return false;
  const lower = finalText.toLowerCase();
  return matcher.any.some((keyword) => lower.includes(keyword.toLowerCase()));
}

// Ordered-subsequence matching over one channel: a cursor advances past
// extra records, so interleaved noise (boot prewarm, discovery probes)
// between the pinned steps is tolerated. Returns how far the cursor got —
// the failure evidence names the first unmatched step.
function matchSequence(
  exp: SequenceExpectation,
  recordings: Recordings,
): { matched: number; describe: (index: number) => string; channelTrace: string } {
  const describeStep = (index: number): string =>
    typeof exp.steps[index] === 'string' ? String(exp.steps[index]) : JSON.stringify(exp.steps[index]);
  if (exp.channel === 'toolCall') {
    const steps = exp.steps as string[];
    let cursor = 0;
    for (const call of recordings.toolCalls) {
      if (cursor < steps.length && call.name === steps[cursor]) cursor++;
    }
    return {
      matched: cursor,
      describe: describeStep,
      channelTrace: recordings.toolCalls.map((c) => `${c.name}(ok=${c.ok})`).join(' | '),
    };
  }
  if (exp.channel === 'gateway') {
    const steps = exp.steps as string[];
    let cursor = 0;
    for (const req of recordings.gateway) {
      if (cursor < steps.length && req.tool === steps[cursor]) cursor++;
    }
    return {
      matched: cursor,
      describe: describeStep,
      channelTrace: recordings.gateway.map((g) => `${g.method}${g.tool ? `:${g.tool}` : ''}`).join(' | '),
    };
  }
  const steps = exp.steps as { method?: string; path: string }[];
  let cursor = 0;
  for (const req of recordings.http) {
    const step = steps[cursor];
    if (cursor < steps.length && req.path === step.path && (!step.method || req.method === step.method)) {
      cursor++;
    }
  }
  return {
    matched: cursor,
    describe: describeStep,
    channelTrace: recordings.http.map((h) => `${h.method} ${h.path}`).join(' | '),
  };
}

export function evaluateCase(caseDef: E2eCase, recordings: Recordings): CaseVerdict {
  const expectations: ExpectationVerdict[] = caseDef.expect.map((exp) => {
    switch (exp.kind) {
      case 'hcloud': {
        const hits = matchHcloud(exp, recordings.hcloud);
        return {
          expectation: exp,
          pass: inRange(hits.length, exp.times),
          evidence: hits.length
            ? `${hits.length} matching call(s): ${hits.slice(0, 3).join(' | ')}`
            : `0 matching call(s), expected ${describeRange(exp.times)}. All calls: ${
                recordings.hcloud
                  .map((c) => c.argv.join(' '))
                  .slice(0, 10)
                  .join(' | ') || '(none)'
              }`,
        };
      }
      case 'toolCall': {
        const hits = matchToolCall(exp, recordings.toolCalls);
        return {
          expectation: exp,
          pass: inRange(hits.length, exp.times),
          evidence: hits.length
            ? `${hits.length} matching call(s)`
            : `0 matching call(s), expected ${describeRange(exp.times)}. Traced calls: ${
                recordings.toolCalls
                  .map((c) => `${c.name}(ok=${c.ok})`)
                  .slice(0, 10)
                  .join(' | ') || '(none)'
              }`,
        };
      }
      case 'noToolCall': {
        const hits = matchToolCall({ name: exp.name }, recordings.toolCalls);
        return {
          expectation: exp,
          pass: hits.length === 0,
          evidence: hits.length
            ? `forbidden call happened ${hits.length}x: ${JSON.stringify(hits[0]?.args).slice(0, 200)}`
            : 'no matching call traced',
        };
      }
      case 'disclosure': {
        const hits = matchDisclosure(exp, recordings.disclosures);
        return {
          expectation: exp,
          pass: inRange(hits.length, exp.times),
          evidence: hits.length
            ? `${hits.length} matching event(s)`
            : `0 matching event(s), expected ${describeRange(exp.times)}. Events: ${JSON.stringify(recordings.disclosures).slice(0, 300)}`,
        };
      }
      case 'http': {
        const hits = recordings.http.filter(
          (req) => req.path === exp.path && (!exp.method || req.method === exp.method),
        );
        return {
          expectation: exp,
          pass: inRange(hits.length, exp.times),
          evidence: hits.length
            ? `${hits.length} matching request(s): ${hits
                .map((h) => `${h.method} ${h.path}`)
                .slice(0, 3)
                .join(' | ')}`
            : `0 matching request(s), expected ${describeRange(exp.times)}. All requests: ${
                recordings.http
                  .map((h) => `${h.method} ${h.path}`)
                  .slice(0, 10)
                  .join(' | ') || '(none)'
              }`,
        };
      }
      case 'gateway': {
        const hits = recordings.gateway.filter(
          (req) =>
            (exp.tool === undefined || req.tool === exp.tool) &&
            (!exp.method || req.method === exp.method) &&
            (!exp.args || argsPartialMatch(exp.args, req.args)),
        );
        return {
          expectation: exp,
          pass: inRange(hits.length, exp.times),
          evidence: hits.length
            ? `${hits.length} matching gateway request(s): ${hits
                .map((h) => `${h.method}${h.tool ? `:${h.tool}` : ''}`)
                .slice(0, 3)
                .join(' | ')}`
            : `0 matching gateway request(s), expected ${describeRange(exp.times)}. All requests: ${
                recordings.gateway
                  .map((h) => `${h.method}${h.tool ? `:${h.tool}` : ''}`)
                  .slice(0, 10)
                  .join(' | ') || '(none)'
              }`,
        };
      }
      case 'sequence': {
        const seq = matchSequence(exp, recordings);
        const pass = seq.matched === exp.steps.length;
        return {
          expectation: exp,
          pass,
          evidence: pass
            ? `all ${exp.steps.length} step(s) in order`
            : `stopped at step ${seq.matched + 1}/${exp.steps.length} (${seq.describe(seq.matched)}). Channel trace: ${seq.channelTrace || '(empty)'}`,
        };
      }
      case 'ws': {
        const allCommands = recordings.ws.flatMap((conn) => conn.commands);
        const hits = allCommands.filter((cmd) => cmd.intent === exp.intent);
        return {
          expectation: exp,
          pass: inRange(hits.length, exp.times),
          evidence: hits.length
            ? `${hits.length} command(s) with intent ${exp.intent}`
            : `0 command(s) with intent ${exp.intent}, expected ${describeRange(exp.times)}. All commands: ${
                allCommands
                  .map((c) => c.intent)
                  .slice(0, 12)
                  .join(' | ') || '(none)'
              }`,
        };
      }
      case 'wsConnections': {
        const count = recordings.ws.length;
        return {
          expectation: exp,
          pass: inRange(count, exp.times),
          evidence: `${count} ws connection(s) (closes: ${
            recordings.ws.map((c) => c.close ?? 'open').join(',') || '(none)'
          })`,
        };
      }
      case 'file': {
        const content = recordings.files[exp.path];
        const exists = content !== null && content !== undefined;
        const pass = exists && (exp.contains === undefined || content.includes(exp.contains));
        return {
          expectation: exp,
          pass,
          evidence: pass
            ? `file ${exp.path} content matches`
            : exists
              ? `file ${exp.path} exists but does not contain ${JSON.stringify(exp.contains)}`
              : `file ${exp.path} missing`,
        };
      }
      case 'agentSays':
        return {
          expectation: exp,
          pass: matchAgentSays(exp.text, recordings.finalText),
          evidence: 'final-message keyword match',
        };
    }
  });

  const soft = (caseDef.softExpect ?? []).map((exp) => {
    const says = exp as { kind: 'agentSays'; text: AgentSaysMatcher };
    return {
      expectation: exp,
      pass: matchAgentSays(says.text, recordings.finalText),
      evidence: 'soft: recorded, not gating',
    };
  });

  // Liveness: any boundary-channel activity proves the agent→MCP→devkit chain
  // is alive, so a passing negative (noToolCall / max=0) cannot be the
  // vacuous green of a dead harness. Files are excluded on purpose: fixtures
  // can seed them. A session with zero tool calls, zero hcloud calls, zero
  // http requests, and zero gateway requests never exercised devkit at all.
  const liveness =
    recordings.toolCalls.length > 0 ||
    recordings.hcloud.length > 0 ||
    recordings.http.length > 0 ||
    recordings.gateway.length > 0 ||
    recordings.ws.some((conn) => conn.commands.length > 0);

  return {
    caseId: caseDef.id,
    pass: liveness && expectations.every((v) => v.pass),
    liveness,
    expectations,
    soft,
  };
}
