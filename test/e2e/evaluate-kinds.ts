// The per-kind verdict constructor: one Expectation → one ExpectationVerdict
// (pass + evidence) over the collected recordings. Called by evaluateCase
// in evaluate.ts — the evaluator's stable face.

import type { Expectation } from './types.ts';
import type { ExpectationVerdict, Recordings } from './evaluate.ts';
import {
  argsPartialMatch,
  describeRange,
  inRange,
  matchAgentSays,
  matchDisclosure,
  matchHcloud,
  matchToolCall,
} from './evaluate-matchers.ts';
import { matchedEvidence } from './evaluate-evidence.ts';
import { sequenceVerdict } from './evaluate-sequence.ts';

export function expectationVerdict(exp: Expectation, recordings: Recordings): ExpectationVerdict {
  switch (exp.kind) {
    case 'hcloud': {
      const hits = matchHcloud(exp, recordings.hcloud);
      return {
        expectation: exp,
        pass: inRange(hits.length, exp.times),
        evidence: matchedEvidence(
          'call',
          hits,
          exp.times,
          'All calls',
          recordings.hcloud.map((c) => c.argv.join(' ')),
        ),
      };
    }
    case 'toolCall': {
      const hits = matchToolCall(exp, recordings.toolCalls);
      const wanted = Array.isArray(exp.name) ? `one of [${exp.name.join(', ')}]` : exp.name;
      return {
        expectation: exp,
        pass: inRange(hits.length, exp.times),
        evidence: hits.length
          ? `${hits.length} matching call(s)`
          : `0 matching call(s) for ${wanted}, expected ${describeRange(exp.times)}. Traced calls: ${
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
      const hits = recordings.http.filter((req) => req.path === exp.path && (!exp.method || req.method === exp.method));
      return {
        expectation: exp,
        pass: inRange(hits.length, exp.times),
        evidence: matchedEvidence(
          'request',
          hits.map((h) => `${h.method} ${h.path}`),
          exp.times,
          'All requests',
          recordings.http.map((h) => `${h.method} ${h.path}`),
        ),
      };
    }
    case 'gateway': {
      const hits = recordings.gateway.filter(
        (req) =>
          (exp.tool === undefined || req.tool === exp.tool) &&
          (!exp.method || req.method === exp.method) &&
          (!exp.args || argsPartialMatch(exp.args, req.args, exp.argsIgnoreCase)),
      );
      return {
        expectation: exp,
        pass: inRange(hits.length, exp.times),
        evidence: matchedEvidence(
          'gateway request',
          hits.map((h) => `${h.method}${h.tool ? `:${h.tool}` : ''}`),
          exp.times,
          'All requests',
          recordings.gateway.map((h) => `${h.method}${h.tool ? `:${h.tool}` : ''}`),
        ),
      };
    }
    case 'sequence':
      return sequenceVerdict(exp, recordings);
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
        evidence: `${count} ws connection(s) (closes: ${recordings.ws.map((c) => c.close ?? 'open').join(',') || '(none)'})`,
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
}
