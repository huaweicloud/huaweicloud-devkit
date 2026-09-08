import { AGENTS, matchAgent, detectVersion, installSegment } from './agent-registry.mjs';

/**
 * 仅返回 harness 字符串（或 null），不返回 version。
 * 用于简单场景（如 keepalive 判断、测试断言）。
 */
export function detectAgentHarness(clientInfo = {}) {
  if (process.env.AGENT_HARNESS) return process.env.AGENT_HARNESS;
  for (const agent of AGENTS) {
    if (matchAgent(agent, clientInfo)) return agent.id;
  }
  return clientInfo.name || null;
}

export function detectAgent(clientInfo = {}) {
  if (process.env.AGENT_HARNESS) {
    const cfg = AGENTS.find((a) => a.id === process.env.AGENT_HARNESS) || null;
    return {
      harness: process.env.AGENT_HARNESS,
      version: detectVersion(cfg ? cfg.version : null) || clientInfo.version || '0.0.0',
    };
  }

  for (const agent of AGENTS) {
    if (matchAgent(agent, clientInfo)) {
      return {
        harness: agent.id,
        version: detectVersion(agent.version) || clientInfo.version || '0.0.0',
      };
    }
  }

  const seg = installSegment();
  const base = clientInfo.name || 'unknown';
  const harness = seg ? `${base}|${seg}` : base;
  return {
    harness: harness.length > 32 ? harness.slice(0, 32) : harness,
    version: clientInfo.version || '0.0.0',
  };
}
