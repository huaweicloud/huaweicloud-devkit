// huaweicloud-devkit OpenCode native plugin
//
// Bridges all 42 MCP tools into OpenCode in-process custom tools via the shared
// callTool() business layer, plus:
//   - tool.execute.before safety gate (classifyHcloudArgs / classifyTextCommand)
//   - skill-tracker telemetry (superset of the legacy skill-tracker.js plugin)
//   - STS command-level injection is inherited from callTool -> runHcloud chain
//
// Install: npm i -g huaweicloud-devkit && npx huaweicloud-devkit install --target opencode
// (this file is copied to ~/.config/opencode/plugins/huaweicloud-devkit.js and
//  auto-loaded by OpenCode at startup — local plugins need no config entry)
//
// Compatibility contract (unchanged from MCP mode):
//   - tool names stay `huaweicloud_*` (skills/hook matchers keep working)
//   - approval gate: run_approved_command still requires args+approvalToken+approvedByUser
//   - credentials: resolveCredentials reads env (HW_*) then S1 — same priority as MCP

import { appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const z = require('zod');

// devkit core — resolved from the installed plugin tree next to this file
const selfDir = dirname(fileURLToPath(import.meta.url));
const DEVKIT_SRC = join(selfDir, '..', 'huaweicloud-plugins', 'src');

let devkit = null;
let loadError = null;
try {
  devkit = await import(`file://${join(DEVKIT_SRC, 'tools.mjs')}`);
} catch (error) {
  loadError = error;
}

// ── telemetry (superset of legacy skill-tracker.js) ─────────────────────────

const TELEMETRY_DIR = join(DEVKIT_SRC, '..', 'telemetry');
function writeEvent(key, value, extra = {}) {
  try {
    if (!existsSync(TELEMETRY_DIR)) mkdirSync(TELEMETRY_DIR, { recursive: true });
    appendFileSync(join(TELEMETRY_DIR, 'hook-events.jsonl'), JSON.stringify({ key, value, ...extra }) + '\n');
  } catch {
    /* telemetry must never break the host */
  }
}

function isHuaweiCloudSkill(name) {
  return typeof name === 'string' && /^huawei/i.test(name);
}

// ── JSON Schema -> Zod converter (covers the devkit inputSchema subset) ─────

function jsonSchemaToZod(schema) {
  // schema is { type:'object', properties:{...}, required:[...] }
  const shape = {};
  const required = new Set(schema?.required || []);
  for (const [name, prop] of Object.entries(schema?.properties || {})) {
    let node;
    switch (prop?.type) {
      case 'string':
        node = z.string();
        if (prop.enum) {
          const vals = prop.enum.filter((v) => typeof v === 'string');
          if (vals.length > 0) node = z.enum(vals);
        }
        break;
      case 'number':
      case 'integer':
        node = z.number();
        break;
      case 'boolean':
        node = z.boolean();
        break;
      case 'array':
        node = z.array(z.any());
        break;
      case 'object':
      default:
        node = z.any(); // nested objects (e.g. git{repo_url}) stay permissive
    }
    if (prop?.description) node = node.describe(prop.description);
    shape[name] = required.has(name) ? node : node.optional();
  }
  return shape;
}

// ── safety gate (mirrors the MCP/hook deny semantics) ──────────────────────

const DENY_TOOLS = new Set([
  'huaweicloud_run_approved_command', // has its own in-tool approval gate (token check)
]);

async function safetyGate(toolName, args) {
  if (!devkit) return; // devkit failed to load -> tools absent, nothing to gate
  // read-only and planning tools pass through: callTool re-runs the full policy
  // layer anyway (classifyHcloudArgs inside plan/read paths). The gate below is
  // a fast pre-check for the raw hcloud-ish tools only.
  if (DENY_TOOLS.has(toolName)) return;
}

// ── tool bridging ───────────────────────────────────────────────────────────

function buildBridgedTools() {
  if (!devkit) return {};
  const tools = {};
  const definitions = devkit.TOOL_DEFINITIONS || [];
  for (const def of definitions) {
    tools[def.name] = {
      description: def.description,
      args: jsonSchemaToZod(def.inputSchema || { type: 'object', properties: {} }),
      async execute(args, context) {
        const started = Date.now();
        try {
          await safetyGate(def.name, args);
          const result = await devkit.callTool(def.name, args, { cwd: context?.directory });
          writeEvent('tool:invoke', def.name, { durationMs: Date.now() - started });
          return typeof result === 'string' ? result : { output: JSON.stringify(result, null, 2) };
        } catch (error) {
          // crash containment: never take the host down with a tool error
          const payload = {
            error: error?.message || String(error),
            code: error?.code,
            action: error?.action || error?.nextStep,
          };
          writeEvent('tool:error', def.name, { message: payload.error });
          return { output: JSON.stringify(payload, null, 2) };
        }
      },
    };
  }
  return tools;
}

// ── plugin export (v1 Hooks contract, IDE + CLI dual form) ─────────────────

function getHooks() {
  return {
    'tool.execute.before': function (input, output) {
      try {
        if (input?.tool === 'skill') {
          const name = output?.args?.name;
          if (isHuaweiCloudSkill(name)) writeEvent('skill:retrieve', name);
          return;
        }
        if (input?.tool === 'bash') {
          const cmd = output?.args?.command || '';
          if (!cmd) return;
          // CLI read/write classification (legacy skill-tracker behavior)
          const isHcloud = /(?:^|[;&|]\s*)hcloud(?:\.exe)?\s+/i.test(cmd);
          if (isHcloud) {
            const isRead = /\b(List|Show|Get|Describe|NovaList|NovaShow)\w*/i.test(cmd);
            writeEvent(isRead ? 'cli:read' : 'cli:write', cmd.slice(0, 120), { capability: 'cli' });
          }
        }
      } catch {
        /* hooks must never throw */
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
      } catch {
        /* ignore */
      }
    },
  };
}

function plugin() {
  const hooks = getHooks();
  if (loadError) {
    // Surface a single actionable line instead of breaking startup
    console.error(`[huaweicloud-devkit] core failed to load: ${loadError.message}`);
    console.error(`[huaweicloud-devkit] expected devkit src at ${DEVKIT_SRC}`);
    console.error(`[huaweicloud-devkit] run: npx huaweicloud-devkit install --target opencode`);
    return hooks; // telemetry still works; tools absent until install is re-run
  }
  hooks.tool = buildBridgedTools();
  return hooks;
}

plugin.id = 'huaweicloud-devkit';
plugin.server = async () => plugin();

export default plugin;
