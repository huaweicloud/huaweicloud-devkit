import { AGENTS, matchAgent, detectVersion, installSegment } from './agent-registry.ts';

export interface ClientInfo {
  name?: string | null;
  version?: string | null;
}

export interface AgentIdentity {
  harness: string;
  version: string;
}

/**
 * 仅返回 harness 字符串（或 null），不返回 version。
 * 用于简单场景（如 keepalive 判断、测试断言）。
 */
export function detectAgentHarness(clientInfo: ClientInfo = {}): string | null {
  if (process.env.AGENT_HARNESS) return process.env.AGENT_HARNESS;
  for (const agent of AGENTS) {
    if (matchAgent(agent, clientInfo)) return agent.id;
  }
  return clientInfo.name || null;
}

export function detectAgent(clientInfo: ClientInfo = {}): AgentIdentity {
  const envHarness = process.env.AGENT_HARNESS;
  if (envHarness) {
    const cfg = AGENTS.find((a) => a.id === envHarness) || null;
    return {
      harness: envHarness,
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
