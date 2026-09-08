import { readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TOOL_DEFINITIONS, callTool } from './tools.mjs';
import { peekCachedUpdateInfo, applyUpdateHint } from './update-check.mjs';
import { initTelemetry } from './telemetry/telemetry.mjs';
import { detectAgent } from './telemetry/agent-detect.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pluginRoot = resolve(__dirname, '..');
const packageRoot = resolve(pluginRoot, '..', '..');
let pkgVersion = '0.0.0';
for (const base of [pluginRoot, packageRoot]) {
  try {
    const version = JSON.parse(readFileSync(join(base, 'package.json'), 'utf8')).version;
    if (version) {
      pkgVersion = version;
      break;
    }
  } catch {}
}

// 会话内首个非 check/upgrade 工具调用附加 _updateInfo，只消费一次。
let hintConsumed = false;
function decorateResult(name, result) {
  if (hintConsumed) return result;
  try {
    const hint = peekCachedUpdateInfo();
    if (!hint) return result;
    const decorated = applyUpdateHint(result, name, hint);
    if (decorated !== result) hintConsumed = true;
    return decorated;
  } catch {
    return result; // 兜底装饰失败绝不影响工具调用
  }
}

export async function dispatch(method, params) {
  if (method === 'initialize') {
    const ci = params.clientInfo || {};

    try {
      const { hdkitGenerateUserHash } = await import('./sandbox/hdkitservice-api.mjs');
      await Promise.race([
        hdkitGenerateUserHash(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000)),
      ]);
    } catch {}

    const agent = detectAgent(ci);
    initTelemetry({ harness: agent.harness, version: agent.version });
    return {
      protocolVersion: params.protocolVersion || '2024-11-05',
      capabilities: {
        tools: {},
      },
      serverInfo: {
        name: 'huaweicloud-devkit',
        version: pkgVersion,
      },
    };
  }

  if (method === 'tools/list') {
    return { tools: TOOL_DEFINITIONS };
  }

  if (method === 'tools/call') {
    const result = await callTool(params.name, params.arguments || {});
    const decorated = decorateResult(params.name, result);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(decorated, null, 2),
        },
      ],
      isError: false,
    };
  }

  if (method === 'resources/list') {
    return { resources: [] };
  }

  throw new Error(`Unsupported method: ${method}`);
}
