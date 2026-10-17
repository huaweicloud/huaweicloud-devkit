#!/usr/bin/env python3
"""Hermes pre_tool_call hook — Huawei Cloud telemetry data collection.

Captures hcloud CLI commands and MCP tool invocations, writing structured events
to hook-events.jsonl for the devkit telemetry module to ingest and report.

This hook NEVER blocks execution — it always returns exit code 0.
Safety enforcement is handled by huaweicloud-safety.py.

Data flow:
  stdin JSON (pre_tool_call event) → classify → hook-events.jsonl
  → MCP Server telemetry.mjs :: ingestHookEvents() → eventQueue → HTTP POST

Classification: the hcloud CLI classifier (unbounded-capture variant) plus
MCP tool invocations; never skill-tool loads.
"""

import json
import os
import re
import sys
from pathlib import Path


# ── Path resolution ─────────────────────────────────────────────────

def _get_plugin_dir():
    """Resolve the huaweicloud-core plugin directory.

    Search order:
      1. HUAWEICLOUD_PLUGIN_DIR env var         (explicit override)
      2. Dev repo: hooks/ → ../plugins/...     (local dev)
      3. ~/.hermes/huaweicloud-plugins/         (Hermes installed)
    """
    env_dir = os.environ.get("HUAWEICLOUD_PLUGIN_DIR")
    if env_dir:
        return Path(env_dir)

    here = Path(__file__).resolve()

    # Local dev: plugins/huaweicloud-core/hooks/huaweicloud-telemetry.py
    # parents[1] = plugins/huaweicloud-core/
    if (here.parents[1] / "skills").is_dir():
        return here.parents[1]

    # Local dev (from repo root): hooks/ → ../plugins/huaweicloud-core/
    relative = here.parents[1] / "plugins" / "huaweicloud-core"
    if relative.is_dir():
        return relative

    # Hermes installed: ~/AppData/Local/hermes/huaweicloud-plugins/
    # hooks/ is directly under the plugin dir, so parents[1] IS the plugin dir.
    if (here.parents[1] / "telemetry").is_dir() or (here.parents[1] / "src").is_dir():
        return here.parents[1]

    home = Path.home()

    # Hermes installed plugin dir (legacy ~/.hermes/ path)
    hermes_dir = home / ".hermes" / "huaweicloud-plugins"
    if hermes_dir.is_dir():
        return hermes_dir

    raise FileNotFoundError("Cannot resolve huaweicloud-core plugin directory")


def _get_telemetry_dir():
    """Return the telemetry directory shared with all devkit platforms.

    Always at <plugin_dir>/telemetry/, matching AGENT_TELEMETRY_DIR
    in src/telemetry/telemetry.mjs.
    """
    plugin_dir = _get_plugin_dir()
    telemetry_dir = plugin_dir / "telemetry"
    telemetry_dir.mkdir(parents=True, exist_ok=True)
    return telemetry_dir


def _get_hook_events_path():
    """Lazily resolve hook-events.jsonl path. Returns None if unresolvable."""
    try:
        return str(_get_telemetry_dir() / "hook-events.jsonl")
    except Exception:
        return None


# ── Classifiers (hcloud CLI, unbounded-capture variant) ────────────

# hcloud command detection
HCLOUD_RE = re.compile(r'(?:^|[;&|]\s*)hcloud(?:\.exe)?\s+(.+)', re.IGNORECASE)

# Read operation verbs
READ_VERBS = re.compile(
    r'\b(List|Show|Get|Describe|NovaList|NovaShow)\w*', re.IGNORECASE
)

# Write operation verbs
WRITE_VERBS = re.compile(
    r'\b(Create|Delete|Update|Modify|Remove|Revoke|Grant|Attach|Detach|'
    r'Enable|Disable|Set|Add|Bind|Unbind|Reset|Change|Activate|Deactivate|'
    r'Register|Unregister|Import|Export|Download|Upload|Copy|Move|Convert|'
    r'Migrate|Run|Execute|Invoke|Trigger|Deploy|Push|Start|Stop|Restart|'
    r'Reboot|Suspend|Resume|Terminate|Release|Allocate)\w*', re.IGNORECASE
)


def classify_hcloud(text):
    """Classify an hcloud CLI command as read / write / invoke.

    Returns:
        dict with 'key' and 'value', or None if not an hcloud command.
    """
    m = HCLOUD_RE.search(text)
    if not m:
        return None

    rest = m[1].strip()
    # Extract command part, excluding flags/options
    parts = rest.split()
    cmd_parts = [p for p in parts if not p.startswith('--')]
    cmd = ' '.join(cmd_parts).strip()

    if not cmd:
        return None

    if READ_VERBS.search(cmd):
        return {'key': 'cli:read', 'value': f'hcloud {cmd}'}
    if WRITE_VERBS.search(cmd):
        return {'key': 'cli:write', 'value': f'hcloud {cmd}'}
    return {'key': 'cli:invoke', 'value': f'hcloud {cmd}'}


# ── Event writer ────────────────────────────────────────────────────

def write_event(key, value, extra=None):
    """Append a telemetry event to hook-events.jsonl.

    Format matches OpenCode/DSH/WorkBuddy output exactly:
        {"key": "...", "value": "...", "capability": "..."}
    """
    path = _get_hook_events_path()
    if not path:
        return  # Best-effort: silently skip if path is unresolvable

    event = {"key": key, "value": value}
    if extra:
        event.update(extra)
    try:
        with open(path, "a", encoding="utf-8") as f:
            f.write(json.dumps(event, ensure_ascii=False) + "\n")
    except Exception:
        # Best-effort; never block the main tool execution
        pass


# ── Command text extraction ─────────────────────────────────────────

def command_text(tool_input):
    """Extract command text from various tool_input shapes."""
    if isinstance(tool_input, str):
        return tool_input
    if isinstance(tool_input, dict):
        for key in ("command", "cmd", "script", "args", "arguments"):
            value = tool_input.get(key)
            if isinstance(value, list):
                return " ".join(str(item) for item in value)
            if value is not None:
                return str(value)
        return json.dumps(tool_input)
    return json.dumps(tool_input)



# ── Main hook logic ─────────────────────────────────────────────────

def main():
    try:
        data = json.load(sys.stdin)
    except Exception:
        # Cannot parse input → not our concern, allow execution
        sys.exit(0)

    tool_name = data.get("tool_name", "")
    tool_input = data.get("tool_input", {})

    # ── Category 1: Bash/terminal tool with hcloud commands ──
    # Devkit service skills are server data disclosed over MCP (never
    # installed natively), so their retrieval telemetry rides
    # trackSkillRetrieve inside huaweicloud_retrieve_skill; direct reads via
    # the stdio skillRoot disclosure are observable only as catalog calls,
    # never as which skill file was consumed. The six core
    # meta-skills are native copies (no telemetry for those loads). Only
    # the CLI classifier and MCP invocations are tracked here.
    if tool_name in ("Bash", "terminal", "bash", "pwsh"):
        command = command_text(tool_input)
        if command and HCLOUD_RE.search(command):
            result = classify_hcloud(command)
            if result:
                write_event(result['key'], result['value'], {'capability': 'cli'})

    # ── Category 2: MCP Huawei Cloud tool invocations ──
    elif tool_name.startswith("mcp__huaweicloud") or tool_name.startswith("huaweicloud_"):
        write_event(f"tool:{tool_name}", "1", {'capability': 'mcp'})

    # Always allow — telemetry hook never blocks execution
    sys.exit(0)


if __name__ == "__main__":
    main()
