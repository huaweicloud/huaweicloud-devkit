import { appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const DEBUG = process.env.HUAWEICLOUD_DEVKIT_DEBUG === 'true';

const selfDir = dirname(fileURLToPath(import.meta.url));
const agentDir = join(selfDir, '..', 'huaweicloud-plugins', 'telemetry');
if (!existsSync(agentDir)) mkdirSync(agentDir, { recursive: true });

function debugLog(msg) {
  if (!DEBUG) return;
  try {
    appendFileSync(join(agentDir, 'plugin-debug.log'), `${new Date().toISOString()} ${msg}\n`);
  } catch (_) {}
}

function isHuaweiCloudSkill(name) {
  return typeof name === 'string' && name && /^huawei/i.test(name);
}

function writeEvent(key, value, extra = {}) {
  const data = JSON.stringify({ key, value, ...extra }) + '\n';
  try {
    appendFileSync(join(agentDir, 'hook-events.jsonl'), data);
  } catch (_) {}
}

// ── CLI command classification ────────────────────────────────

const HCLOUD_RE = /(?:^|[;&|]\s*)hcloud(?:\.exe)?\s+([^\s;&|"<>]+(?:\s+[^\s;&|"<>]+){0,3})/i;
const READ_VERBS = /\b(List|Show|Get|Describe|NovaList|NovaShow)\w*/i;
const WRITE_VERBS = new RegExp(
  '\\b(Create|Delete|Update|Modify|Remove|Revoke|Grant|Attach|Detach|' +
    'Enable|Disable|Set|Add|Bind|Unbind|Reset|Change|Activate|Deactivate|' +
    'Register|Unregister|Import|Export|Download|Upload|Copy|Move|Convert|' +
    'Migrate|Run|Execute|Invoke|Trigger|Deploy|Push|Start|Stop|Restart|' +
    'Reboot|Suspend|Resume|Terminate|Release|Allocate)\\w*',
  'i',
);

function classifyHcloud(text) {
  const m = HCLOUD_RE.exec(text);
  if (!m) return null;
  const raw = m[1].trim();
  if (!raw) return null;
  const cmdTokens = [];
  for (const t of raw.split(/\s+/)) {
    if (t.startsWith('--')) break;
    cmdTokens.push(t);
  }
  if (cmdTokens.length === 0) return null;
  const cmd = cmdTokens.join(' ');
  if (READ_VERBS.test(cmd)) return { key: 'cli:read', value: `hcloud ${cmd}` };
  if (WRITE_VERBS.test(cmd)) return { key: 'cli:write', value: `hcloud ${cmd}` };
  return { key: 'cli:invoke', value: `hcloud ${cmd}` };
}

// ── Shared hooks ──────────────────────────────────────────────

function getHooks() {
  return {
    'tool.execute.before': function (input, output) {
      try {
        debugLog(`HOOK tool.execute.before tool=${input?.tool}`);
        if (input.tool === 'skill') {
          const name = output?.args?.name;
          debugLog(`SKILL name=${name}`);
          if (isHuaweiCloudSkill(name)) {
            writeEvent('skill:retrieve', name);
            debugLog(`SKILL TRACKED: ${name}`);
          }
          return;
        }
        if (input.tool === 'bash') {
          const cmd = output?.args?.command || '';
          if (!cmd) return;
          const result = classifyHcloud(cmd);
          if (result) writeEvent(result.key, result.value, { capability: 'cli' });
        }
      } catch (error) {
        debugLog(`HOOK ERROR: ${error?.message || error}`);
      }
    },
    event: function ({ event }) {
      try {
        if (event?.type === 'message.part.updated') {
          const text = event?.properties?.part?.text;
          if (typeof text === 'string') {
            const m = text.match(/Base directory for this skill:\s*.*?skills[/\\]([a-z0-9-]+)/i);
            if (m && isHuaweiCloudSkill(m[1])) writeEvent('skill:retrieve', m[1]);
          }
        }
      } catch (error) {
        debugLog(`EVENT ERROR: ${error?.message || error}`);
      }
    },
  };
}

// ── V2 setup: register hooks on their owning domains via the context. ──────
//    `tool.execute.before` → ctx.tool.hook("execute.before", ...) whose single
//    event carries `.tool` (name) and `.input` (args), replacing V1's (input, output).
//    `event` → ctx.event.subscribe(AsyncIterable of { type, properties }).
async function setupV2(ctx) {
  await ctx.tool.hook('execute.before', (event) => {
    try {
      debugLog(`HOOK tool.execute.before tool=${event?.tool}`);
      if (event?.tool === 'skill') {
        const name = event?.input?.name ?? event?.args?.name;
        debugLog(`SKILL name=${name}`);
        if (isHuaweiCloudSkill(name)) {
          writeEvent('skill:retrieve', name);
          debugLog(`SKILL TRACKED: ${name}`);
        }
        return;
      }
      if (event?.tool === 'bash') {
        const cmd = event?.input?.command ?? event?.args?.command ?? '';
        if (!cmd) return;
        const result = classifyHcloud(cmd);
        if (result) writeEvent(result.key, result.value, { capability: 'cli' });
      }
    } catch (error) {
      debugLog(`HOOK ERROR: ${error?.message || error}`);
    }
  });

  const controller = new AbortController();
  void (async () => {
    try {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        if (event?.type === 'message.part.updated') {
          const text = event?.properties?.part?.text;
          if (typeof text === 'string') {
            const m = text.match(/Base directory for this skill:\s*.*?skills[/\\]([a-z0-9-]+)/i);
            if (m && isHuaweiCloudSkill(m[1])) writeEvent('skill:retrieve', m[1]);
          }
        }
      }
    } catch (error) {
      debugLog(`EVENT ERROR: ${error?.message || error}`);
    }
  })();

  return () => controller.abort();
}

// ── Dual export: one default object serves OpenCode V1 and V2 ───────────────
//    V1 loader reads `server()` (returns legacy string-keyed hooks).
//    V2 loader reads `id` + `setup(ctx)` (registers hooks on the context domains).
//    `Plugin.define` is a type/runtime helper injected lazily so a V1 host that
//    lacks `@opencode/plugin` still loads (fallback to an identity define).
let Plugin = { define: (def) => def };
try {
  const require = createRequire(import.meta.url);
  for (const pkg of ['@opencode/plugin', '@opencode-ai/plugin']) {
    try {
      const mod = require(pkg);
      if (mod?.Plugin?.define) {
        Plugin = mod.Plugin;
        break;
      }
      if (typeof mod?.define === 'function') {
        Plugin = mod;
        break;
      }
    } catch {
      // not installed in this host; keep the identity define
    }
  }
} catch {
  // createRequire unavailable; keep the identity define
}

export default {
  ...Plugin.define({
    id: 'huaweicloud-skill-tracker',
    async setup(ctx) {
      return setupV2(ctx);
    },
  }),
  async server() {
    return getHooks();
  },
};

debugLog('=== PLUGIN INIT DONE ===');
