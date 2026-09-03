#!/usr/bin/env python3
"""PreToolUse hook for Huawei Cloud agent safety.

Blocks the highest-risk leakage paths before an agent tool runs:
- reading local Huawei Cloud credential files
- dumping cloud credential environment variables
- directly retrieving cloud secret values
- running unapproved write operations through hcloud

The MCP server carries the same policy in Node for platforms that do not support
plugin hooks.
"""

import json
import re
import sys
from pathlib import Path

DENY_PREFIX = "Huawei Cloud safety hook blocked this action: "
RULES_PATH = Path(__file__).resolve().parents[1] / "safety" / "rules" / "cloud-risk-rules.json"
POLICY_PATH = Path(__file__).resolve().parents[1] / "safety" / "policy.json"

CONFIG_FILE_RE = None
SECRET_READ_RE = None
WRITE_OPERATION_RE = None


def load_policy():
    global CONFIG_FILE_RE, SECRET_READ_RE, WRITE_OPERATION_RE
    try:
        with POLICY_PATH.open("r", encoding="utf-8") as file_obj:
            policy = json.load(file_obj)
        cred_patterns = policy.get("credentialFilePatterns", [])
        if cred_patterns:
            CONFIG_FILE_RE = re.compile("|".join(cred_patterns), re.I)
        blocked_secrets = policy.get("blockedSecretOperations", [])
        if blocked_secrets:
            SECRET_READ_RE = re.compile("|".join(re.escape(op) for op in blocked_secrets), re.I)
        write_prefixes = policy.get("writeOperationPrefixes", [])
        if write_prefixes:
            WRITE_OPERATION_RE = re.compile(r"\b(" + "|".join(write_prefixes) + r")\w*", re.I)
    except Exception:
        pass


load_policy()

ENV_DUMP_RE = re.compile(
    r"(env|printenv|Get-ChildItem\s+Env:|gci\s+Env:|dir\s+Env:).*(HUAWEICLOUD|HWC_|HCLOUD|OS_)", re.I,
)
HCLOUD_RE = re.compile(r"(^|\s)hcloud(\.exe)?\s+", re.I)
READ_OPERATION_RE = re.compile(r"\b(List|Show|Get|Describe|NovaList|NovaShow)\w*", re.I)
READ_OPERATION_RE = re.compile(r"\b(List|Show|Get|Describe|NovaList|NovaShow)\w*", re.I)


def deny(reason, hermes=False):
    sys.stdout.write(
        json.dumps(
            {
                "action": "block",
                "message": DENY_PREFIX + reason,
            }
            if hermes
            else {
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": "deny",
                    "permissionDecisionReason": DENY_PREFIX + reason,
                }
            }
        )
        + "\n"
    )
    sys.exit(0)


def allow():
    sys.exit(0)


def command_text(tool_input):
    if isinstance(tool_input, str):
        return tool_input
    if isinstance(tool_input, dict):
        values = []
        for key in ("command", "cmd", "script", "args", "arguments"):
            value = tool_input.get(key)
            if isinstance(value, list):
                values.append(" ".join(str(item) for item in value))
            elif value is not None:
                values.append(str(value))
        if values:
            return "\n".join(values)
        return json.dumps(tool_input)
    return json.dumps(tool_input)


def load_cloud_risk_rules():
    try:
        with RULES_PATH.open("r", encoding="utf-8") as file_obj:
            catalog = json.load(file_obj)
        return catalog.get("rules", [])
    except Exception:
        return []


def condition_matches(condition, text):
    return re.search(condition.get("regex", r"a^"), text, re.I | re.M | re.S) is not None


def rule_matches(rule, text):
    match = rule.get("match") or {}
    all_conditions = match.get("all")
    any_conditions = match.get("any")
    none_conditions = match.get("none")

    if isinstance(all_conditions, list):
        for condition in all_conditions:
            if not condition_matches(condition, text):
                return False
    if isinstance(any_conditions, list):
        if not any(condition_matches(condition, text) for condition in any_conditions):
            return False
    if isinstance(none_conditions, list):
        if any(condition_matches(condition, text) for condition in none_conditions):
            return False
    return isinstance(all_conditions, list) or isinstance(any_conditions, list)


def first_denied_command_rule(text):
    for rule in load_cloud_risk_rules():
        if "command" not in rule.get("stages", []):
            continue
        if rule.get("severity") != "deny":
            continue
        if rule_matches(rule, text):
            return rule
    return None


def evaluate(tool_name, tool_input):
    """Run the full safety check and return a raw block reason, or None to allow.

    Shared by the CLI shell (``main``) and the Hermes Python-plugin hook, which
    reuses this module via ``importlib`` so a single implementation enforces the
    policy everywhere. The returned reason does NOT include ``DENY_PREFIX`` —
    callers decide the exact output shape.
    """
    text = command_text(tool_input)

    if CONFIG_FILE_RE and CONFIG_FILE_RE.search(text):
        return "reading Huawei Cloud credential/profile files can expose AK/SK or tokens. Use redacted toolkit tools."
    if ENV_DUMP_RE.search(text):
        return "dumping cloud credential environment variables is not allowed."
    if SECRET_READ_RE and SECRET_READ_RE.search(text):
        return "direct secret value retrieval would put plaintext secrets into the agent context."
    denied_rule = first_denied_command_rule(text)
    if denied_rule:
        return f"{denied_rule.get('message')} Remediation: {denied_rule.get('remediation')}"
    if tool_name in ("Bash", "terminal") and HCLOUD_RE.search(text) and WRITE_OPERATION_RE.search(text) and not READ_OPERATION_RE.search(text):
        return "unapproved Huawei Cloud write operations must be planned first and explicitly approved by the user."

    return None


def main():
    try:
        data = json.load(sys.stdin)
    except Exception:
        allow()

    tool_name = data.get("tool_name", "")
    tool_input = data.get("tool_input", {})
    hermes = "hook_event_name" in data

    reason = evaluate(tool_name, tool_input)
    if reason:
        deny(reason, hermes)

    allow()


if __name__ == "__main__":
    main()
