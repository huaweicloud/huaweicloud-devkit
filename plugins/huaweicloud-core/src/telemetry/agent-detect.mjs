import { AGENTS, matchAgent, detectVersion } from './agent-registry.mjs';

/**
 * 仅返回 harness 字符串，不返回 version。
 * 用于简单场景（如 keepalive 判断、测试断言）。
 *
 * #1029: 白名单/envVar 未命中时一律返回 'unknown'，
 * 不再把 clientInfo.name（含 startup / voucher-claim 前缀 / test 前缀等探针名）
 * 或安装路径段当作 agent 身份透出。
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

  // #1029: 兜底收敛——白名单未命中时不再拼接 `|安装段`（曾产生
  // `startup|plugins`、`test|.npm/...` 等污染 agent 名，占现网约 73% 记录）。
  // installSegment() 仅用于遥测的安装位置字段，禁止进入 agent 名。
  return {
    harness: 'unknown',
    version: clientInfo.version || '0.0.0',
  };
}
