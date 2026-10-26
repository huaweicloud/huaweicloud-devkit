import { AGENTS, matchAgent, detectVersion } from './agent-registry.mjs';

/**
 * 仅返回 harness 字符串（或 'unknown'），不返回 version。
 * 用于简单场景（如 keepalive 判断、测试断言）。
 *
 * #1028: 白名单/envVar 未命中时不再回退 clientInfo.name，
 * 探针类 clientName（startup、voucher-claim*、test* 等）一律归 'unknown'，
 * 禁止把非 agent 标识上报为 harness。
 */
export function detectAgentHarness(clientInfo = {}) {
  if (process.env.AGENT_HARNESS) return process.env.AGENT_HARNESS;
  for (const agent of AGENTS) {
    if (matchAgent(agent, clientInfo)) return agent.id;
  }
  return 'unknown';
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

  // #1028: 未命中白名单/AGENT_HARNESS 时不再拼接安装路径段，
  // 安装段只允许作为遥测的安装位置字段，禁止进入 agent 名。
  return {
    harness: 'unknown',
    version: clientInfo.version || '0.0.0',
  };
}
