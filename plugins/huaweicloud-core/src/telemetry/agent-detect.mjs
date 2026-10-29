import { AGENTS, matchAgent, detectVersion } from './agent-registry.mjs';

/**
 * 仅返回 harness 字符串，不返回 version。
 * #1040: 白名单 / AGENT_HARNESS 未命中时一律返回 'unknown'——
 * 不再透传 clientInfo.name（startup、voucher-claim*、test* 等探针类 clientName 同样归 unknown），
 * 也不拼接 installSegment，避免 agent 名出现 '|' 污染。
 */
export function detectAgentHarness(clientInfo = {}) {
  const envHarness = process.env.AGENT_HARNESS;
  if (envHarness && AGENTS.some((a) => a.id === envHarness)) return envHarness;
  for (const agent of AGENTS) {
    if (matchAgent(agent, clientInfo)) return agent.id;
  }
  return 'unknown';
}

export function detectAgent(clientInfo = {}) {
  // AGENT_HARNESS 仅在命中白名单时生效；未命中视为不可信输入，不透传任意环境值。
  const envHarness = process.env.AGENT_HARNESS;
  if (envHarness) {
    const cfg = AGENTS.find((a) => a.id === envHarness) || null;
    if (cfg) {
      return {
        harness: envHarness,
        version: detectVersion(cfg.version) || clientInfo.version || '0.0.0',
      };
    }
  }

  for (const agent of AGENTS) {
    if (matchAgent(agent, clientInfo)) {
      return {
        harness: agent.id,
        version: detectVersion(agent.version) || clientInfo.version || '0.0.0',
      };
    }
  }

  // #1040: 兜底收敛 'unknown'——安装位置信息走遥测独立字段 installSegment，不进入 agent 名。
  return {
    harness: 'unknown',
    version: clientInfo.version || '0.0.0',
  };
}
