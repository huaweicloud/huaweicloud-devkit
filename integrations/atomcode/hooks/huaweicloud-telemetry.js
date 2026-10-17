/**
 * huaweicloud-telemetry.js — AtomCode PreToolUse Hook
 *
 * Captures hcloud CLI commands and MCP tool invocations, writing structured
 * events to hook-events.jsonl for the devkit telemetry module to ingest and
 * report. Service skills are server data disclosed over MCP, so their
 * retrieval telemetry rides trackSkillRetrieve inside
 * huaweicloud_retrieve_skill; direct reads via the stdio skillRoot
 * disclosure are observable only as catalog calls, never as which skill
 * file was consumed. The six core meta-skills are installed as native
 * copies (system-prompt disclosure); those loads produce no telemetry by
 * design — so this hook never classifies skill-tool loads (the prefix
 * match would also misattribute user skills sharing the huawei* prefix).
 *
 * Classification mirrors the other platform hooks' trimmed shape: the
 * hcloud CLI classifier plus MCP tool events (opencode's hook carries
 * the CLI classifier only). This hook NEVER blocks execution — it
 * always exits 0.
 */

import { appendFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// ══════════════════════════════════════════════════════════════════
// Debug
// ══════════════════════════════════════════════════════════════════

const DEBUG = process.env.HUAWEICLOUD_DEVKIT_DEBUG === 'true';

function debugLog(msg) {
  if (!DEBUG) return;
  try {
    const logPath = join(TELEMETRY_DIR, 'atomcode-debug.log');
    appendFileSync(logPath, `${new Date().toISOString()} ${msg}\n`);
  } catch (_) {
    /* best-effort */
  }
}

// ══════════════════════════════════════════════════════════════════
// Paths — hook is installed at <plugin_dir>/hooks/
// ══════════════════════════════════════════════════════════════════

const __filename = fileURLToPath(import.meta.url);
const HOOK_DIR = dirname(__filename);
const PLUGIN_DIR = dirname(HOOK_DIR);
const TELEMETRY_DIR = join(PLUGIN_DIR, 'telemetry');
const HOOK_EVENTS_PATH = join(TELEMETRY_DIR, 'hook-events.jsonl');

// ══════════════════════════════════════════════════════════════════
// Helpers
// ══════════════════════════════════════════════════════════════════

function ensureDir(dirPath) {
  if (!existsSync(dirPath)) mkdirSync(dirPath, { recursive: true });
}

function writeEvent(key, value, extra = {}) {
  try {
    ensureDir(TELEMETRY_DIR);
    const line = JSON.stringify({ key, value, ...extra }) + '\n';
    appendFileSync(HOOK_EVENTS_PATH, line, 'utf8');
    debugLog(`writeEvent key=${key} value=${value}`);
  } catch (error) {
    debugLog(`writeEvent FAILED: ${error.message}`);
  }
}

// ══════════════════════════════════════════════════════════════════
// CLI command classification (the unbounded-capture variant shared with
// the workbuddy/hermes hooks; opencode/dsh use a bounded 4-token capture)
// ══════════════════════════════════════════════════════════════════

const HCLOUD_RE = /(?:^|[;&|]\s*)hcloud(?:\.exe)?\s+(.+)/i;
const READ_VERBS = /\b(List|Show|Get|Describe|NovaList|NovaShow)\w*/i;
const WRITE_VERBS =
  /\b(Create|Delete|Update|Modify|Remove|Revoke|Grant|Attach|Detach|Enable|Disable|Set|Add|Bind|Unbind|Reset|Change|Activate|Deactivate|Register|Unregister|Import|Export|Download|Upload|Copy|Move|Convert|Migrate|Run|Execute|Invoke|Trigger|Deploy|Push|Start|Stop|Restart|Reboot|Suspend|Resume|Terminate|Release|Allocate)\w*/i;

function classifyHcloud(text) {
  const m = HCLOUD_RE.exec(text);
  if (!m) return null;
  const rest = m[1].trim();
  const parts = rest.split(/\s+/).filter((p) => !p.startsWith('--'));
  const cmd = parts.join(' ');
  if (!cmd) return null;
  if (READ_VERBS.test(cmd)) return { key: 'cli:read', value: `hcloud ${cmd}` };
  if (WRITE_VERBS.test(cmd)) return { key: 'cli:write', value: `hcloud ${cmd}` };
  return { key: 'cli:invoke', value: `hcloud ${cmd}` };
}

// ══════════════════════════════════════════════════════════════════
// Input parsing — stdin JSON, with env-var fallback
// ══════════════════════════════════════════════════════════════════

function parseInput() {
  // Primary: AtomCode passes data via env vars
  const toolName = process.env.ATOMCODE_TOOL_NAME || '';
  const context = process.env.ATOMCODE_HOOK_CONTEXT || '';
  if (toolName || context) {
    const input = { tool_name: toolName };
    if (context) {
      try {
        input.tool_input = JSON.parse(context);
      } catch (_) {
        input.tool_input = { command: context };
      }
    } else {
      input.tool_input = {};
    }
    return input;
  }

  // Fallback: stdin JSON (piped for manual testing)
  try {
    const data = readFileSync(0, 'utf8').trim();
    if (data) return JSON.parse(data);
  } catch (_) {
    /* stdin unavailable */
  }

  return { tool_name: '', tool_input: {} };
}

function extractCommand(toolInput) {
  if (typeof toolInput === 'string') return toolInput;
  if (toolInput && typeof toolInput === 'object') {
    return toolInput.command || toolInput.arguments?.command || '';
  }
  return '';
}

// ══════════════════════════════════════════════════════════════════
// Main
// ══════════════════════════════════════════════════════════════════

try {
  const input = parseInput();
  const toolName = input.tool_name || input.tool || '';
  const toolInput = input.tool_input || input.arguments || {};

  debugLog(`tool=${toolName}`);

  // ── Category 1: Bash/pwsh with hcloud commands ──
  if (toolName === 'bash' || toolName === 'pwsh') {
    const command = extractCommand(toolInput);
    if (command && HCLOUD_RE.test(command)) {
      debugLog(`hcloud command: ${command.slice(0, 120)}`);
      const classified = classifyHcloud(command);
      if (classified) {
        writeEvent(classified.key, classified.value, { capability: 'cli' });
      }
    }
  }

  // ── Category 2: MCP Huawei Cloud tools ──
  if (toolName.startsWith('mcp__huaweicloud')) {
    writeEvent(`tool:${toolName}`, '1', { capability: 'mcp' });
    debugLog(`MCP tool: ${toolName}`);
  }
} catch (error) {
  debugLog(`FATAL: ${error?.message || error}`);
}

// Always allow — telemetry hook never blocks; the process exits 0 naturally
// since all I/O is synchronous and nothing holds the event loop open.
