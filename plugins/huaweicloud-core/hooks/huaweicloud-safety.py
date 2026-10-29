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
from datetime import datetime, timezone

DENY_PREFIX = "Huawei Cloud safety hook blocked this action: "
RULES_PATH = Path(__file__).resolve().parents[1] / "safety" / "rules" / "cloud-risk-rules.json"
POLICY_PATH = Path(__file__).resolve().parents[1] / "safety" / "policy.json"

PLUGIN_DIR = Path(__file__).resolve().parents[2]
TELEMETRY_DIR = PLUGIN_DIR / "telemetry"
HOOK_EVENTS_PATH = TELEMETRY_DIR / "hook-events.jsonl"

CONFIG_FILE_RE = None
SECRET_READ_RE = None
WRITE_OPERATION_RE = None
AGENTARTS_POLICY = None
POLICY_OK = True


def load_policy():
    global CONFIG_FILE_RE, SECRET_READ_RE, WRITE_OPERATION_RE, AGENTARTS_POLICY, POLICY_OK
    try:
        with POLICY_PATH.open("r", encoding="utf-8") as file_obj:
            policy = json.load(file_obj)
        # A parseable-but-degraded policy is a third degradation state: treat
        # it like a load failure so the None-guarded gates cannot silently
        # turn off (or crash mid-classification) while POLICY_OK stays true —
        # missing keys, empty lists, and a wrong-typed agentartsCommandPolicy
        # all raise here.
        list_keys = ("credentialFilePatterns", "blockedSecretOperations", "writeOperationPrefixes")
        if any(not isinstance(policy.get(key), list) or not policy[key] for key in list_keys):
            raise ValueError("policy.json list keys must be non-empty arrays")
        if not isinstance(policy.get("agentartsCommandPolicy"), dict) or not policy["agentartsCommandPolicy"]:
            raise ValueError("policy.json agentartsCommandPolicy must be a non-empty object")
        cred_patterns = policy.get("credentialFilePatterns", [])
        if cred_patterns:
            CONFIG_FILE_RE = re.compile("|".join(cred_patterns), re.I)
        blocked_secrets = policy.get("blockedSecretOperations", [])
        if blocked_secrets:
            SECRET_READ_RE = re.compile("|".join(re.escape(op) for op in blocked_secrets), re.I)
        write_prefixes = policy.get("writeOperationPrefixes", [])
        if write_prefixes:
            # \s joins the prefix class so plain space-preceded operation
            # tokens (`hcloud ECS DeleteServer …`) match, not only
            # camel-compounded ones (NovaDeleteServer) — the previous
            # wordchar-only class missed the most common shape.
            WRITE_OPERATION_RE = re.compile(r"(?:^|\s|[A-Za-z0-9])(" + "|".join(write_prefixes) + r")\w*", re.I)
        AGENTARTS_POLICY = policy.get("agentartsCommandPolicy")
    except Exception:
        # Fail-safe flag: evaluate() denies everything while the policy is
        # unavailable, matching the wired Node hook's load-failure posture
        # (a silently-degraded hook would allow writes unclassified).
        POLICY_OK = False


load_policy()

# Env-var dump gate: two independent linear searches (command word, cloud
# prefix) instead of one bridged `.*` regex — the bridge was quadratic on
# padded input and could stall this hook past its runner timeout. The command
# word is anchored like safety-policy.mjs classifyTextCommand (^|\s), so
# mid-word mentions (notenv) and quote-preceded words stay allowed.
ENV_DUMP_CMD_RE = re.compile(r"(?:^|\s)(env|printenv|Get-ChildItem\s+Env:|gci\s+Env:|dir\s+Env:)", re.I)
ENV_DUMP_CLOUD_RE = re.compile(r"(HUAWEICLOUD|HWC_|HCLOUD|HW_|OS_)", re.I)
# Credential variable references bypass the env-command gate above: HW_ is
# the plugin's own documented credential prefix (HW_ACCESS_KEY/HW_SECRET_KEY/
# HW_SECURITY_TOKEN), cloud environments also expose the AWS-style
# HUAWEICLOUD_SECRET_ACCESS_KEY name, and `echo $HW_SECRET_KEY` /
# `printenv HW_ACCESS_KEY` / `echo $HUAWEICLOUD_SECRET_ACCESS_KEY` previously
# fell through to allow (#561 D4-2, #770 D4-2).
#
# The negative lookbehind exempts literal-NAME references — backslash-escaped
# (\$HW_*) or single-quoted ('$HW_*', which the shell never expands) —
# while unescaped `$HW_*` is a potential expansion/dump regardless of the
# command. Aligned with the cred-var block in classifyTextCommand
# (safety-policy.mjs); both gates sweep inner-command candidates so
# wrapper-embedded dumps (`bash -c "printenv HW_ACCESS_KEY"`) classify.
CRED_VAR_REF_RE = re.compile(
    r"(?<!['\\])\$\{?(?:HUAWEICLOUD|HWC|HW|OS)_(?:SECRET_ACCESS_KEY|ACCESS_KEY|SECRET_KEY|SECURITY_TOKEN|SDK_AK|SDK_SK|SDK_MEMORY_API_KEY)"
    r"|(?:^|\s)printenv\s+(?:HUAWEICLOUD|HWC|HW|OS)_(?:SECRET_ACCESS_KEY|ACCESS_KEY|SECRET_KEY|SECURITY_TOKEN|SDK_AK|SDK_SK|SDK_MEMORY_API_KEY)",
    re.I,
)
HCLOUD_RE = re.compile(r"(^|\s)hcloud(\.exe)?\s+", re.I)
READ_OPERATION_RE = re.compile(r"\b(List|Show|Get|Describe|NovaList|NovaShow)\w*", re.I)

# AgentArts CLI (agentarts-sdk) keyword locator — command-position semantics
# aligned with safety-policy.mjs, extended for invocation shapes the agentarts
# floor must catch on its own (no approval wrapper yet): launcher prefixes
# with option/argument runs (env -i, nice -n 5, xargs -r, timeout
# --foreground 300, g-prefixed GNU spellings, dotenv, parallel/ionice/
# taskset), env-var assignments, path invocation, sudo with options, values,
# and executor words, and the $AGENTARTS_BIN handle. The (?![\w./-]) boundary
# excludes agentarts-sdk / agentarts-setup lookalikes and directory paths.
# Performance contract: linear no-star keyword scan + 256-char
# suffix-anchored prefix window (token runs bounded to 32) — starred prefix
# alternations over the full text were quadratic and could stall this hook
# past its runner timeout. Documented residuals and accepted deny-direction
# false positives are listed in safety-policy.mjs. Tiers come from
# policy.json agentartsCommandPolicy (measured facts, see
# docs/agentarts-pr0-findings.md) so both hooks and the approval wrapper
# consume one source.
AGENTARTS_KW_RE = re.compile(r"(?:agentarts(?:\.exe)?|\$\{?AGENTARTS_BIN\}?)(?![\w./-])", re.I)
AGENTARTS_PREFIX_SUFFIX_RE = re.compile(
    r"(?:^|[;|&]\s*|\$\(\s*|`\s*|\r?\n\s*"
    r"|\b(?:g(?:timeout|xargs|nice|stdbuf|watch|env|nohup|setsid)|dotenv|parallel|ionice|taskset"
    r"|env|nohup|exec|command|xargs|nice|setsid|stdbuf|watch|timeout)(?:\s+\S+){0,32}\s+"
    r"|sudo(?:\s+(?:-\S+(?:\s+[^\s-]+)?|strace|ltrace|perf|valgrind|script|time)){0,32}\s+"
    r"|[A-Za-z_][A-Za-z0-9_]*=\S*\s+|[A-Za-z_][A-Za-z0-9_]*="
    r"|[\w.~\\/-]*[/\\])$",
    re.I,
)
AGENTARTS_WINDOW = 256


def _agentarts_locate(hay):
    """Return the end offset of an agentarts keyword in command position, else None."""
    for m in AGENTARTS_KW_RE.finditer(hay):
        window = hay[max(0, m.start() - AGENTARTS_WINDOW):m.start()]
        # Dual test: raw window, then trailing-whitespace-trimmed — restores
        # the unbounded \s* anchor semantics for padded separators (a
        # pure-whitespace window means the keyword follows a whitespace run
        # from a command position).
        if AGENTARTS_PREFIX_SUFFIX_RE.search(window) or AGENTARTS_PREFIX_SUFFIX_RE.search(
            re.sub(r"\s+$", "", window)
        ):
            return m.end()
    return None


def _agentarts_tokens(rest):
    # Mirror splitSimpleCommand: keep quoted segments whole, then strip ALL
    # quote characters so embedded-quote keywords/tokens still classify
    # (#927 shape). Empty fragments (a lone quote stripping to "") are
    # dropped so the deny reason never names an empty operation.
    parts = re.findall(r'"[^"]*"|\'[^\']*\'|\S+', rest)
    return [part.replace("'", "").replace('"', "") for part in parts if part.replace("'", "").replace('"', "")]


def _unwrap_quoted(payload):
    # Strip only the matched delimiter pair: str.strip("\"'") would eat a
    # nested closing quote too (`bash -c 'bash -c "x"'` losing its final "),
    # breaking one level of recursion.
    if len(payload) >= 2 and payload[0] == payload[-1] and payload[0] in "\"'":
        return payload[1:-1]
    return payload


def _inner_command_candidates(text):
    # Mirror of extractInnerCommand for the agentarts gate: pull the payload
    # out of `bash -c "…"`, `eval '…'`, `$(…)`, backticks, and the Windows
    # wrappers, recursing one level so double-wrapped payloads classify.
    # Plain quoted natural language (`echo "agentarts is a CLI"`) does not
    # match any wrapper shape. Payload captures are BOUNDED ({0,1024} quoted /
    # {1,512} substitution): unbounded runs were quadratic per start position
    # and a padded `$(`-repeat command killed this hook before any gate could
    # deny (a dead hook is a non-blocking error, i.e. allow).
    candidates = [text]
    wrappers = (
        r"\b(?:bash|sh|zsh|dash|\/bin\/(?:bash|sh|zsh|dash)|bash\.exe|sh\.exe)\s+-c\s+(\"[^\"]{0,1024}\"|'[^']{0,1024}')",
        r"\beval\s+(\"[^\"]{0,1024}\"|'[^']{0,1024}')",
        r"\$\(([^)]{1,512})\)",
        r"`([^`]{1,512})`",
        r"\b(?:cmd|cmd\.exe)\s+\/[ck]\s+(\"[^\"]{0,1024}\"|'[^']{0,1024}')",
        r"\b(?:powershell|powershell\.exe|pwsh|pwsh\.exe)\s+(?:-Command|-c)\s+(\"[^\"]{0,1024}\"|'[^']{0,1024}')",
    )
    for pattern in wrappers:
        for m in re.finditer(pattern, text, re.I):
            payload = _unwrap_quoted(m.group(1))
            candidates.append(payload)
            for sub in re.finditer(pattern, payload, re.I):
                candidates.append(_unwrap_quoted(sub.group(1)))
    return candidates


def _agentarts_classify_segment(segment):
    pos = _agentarts_locate(segment)
    source = segment
    if pos is None:
        # Quote-embedded keyword retry (de-quoted copy, keyword location only).
        stripped = re.sub(r"['\"]", "", segment)
        pos = _agentarts_locate(stripped)
        if pos is None:
            return None
        source = stripped
    rest = source[pos:]
    tokens = [t.lower() for t in _agentarts_tokens(rest)]
    if tokens:
        first = tokens[0]
        if (
            first in ("agentarts", "agentarts.exe")
            or first.endswith("/agentarts")
            or first.endswith("\\agentarts")
            or re.match(r"^\$\{?agentarts_bin\}?$", first)
        ):
            tokens = tokens[1:]
    i = 0
    while i < len(tokens) and tokens[i].startswith("-"):
        i += 1
    eager_flag = any(t in ("--help", "-h") for t in tokens) or any(t in ("--version", "-v") for t in tokens[:i])
    if i >= len(tokens) or eager_flag:
        if i >= len(tokens) and (
            re.search(r"\b(?:g)?(?:xargs|parallel)\b", segment, re.I)
            or re.search(r"\b(?:g)?(?:xargs|parallel)\b", re.sub(r"['\"]", "", segment), re.I)
        ):
            return (
                "agentarts invoked via xargs (arguments arrive on stdin and cannot be classified); "
                "run it in your own terminal (see the huawei-agentarts skill)."
            )
        return None
    if AGENTARTS_POLICY is None:
        return "agentarts safety policy is unavailable; agentarts commands are blocked until the policy loads."
    group = tokens[i]
    aliases = AGENTARTS_POLICY.get("aliases", {})
    commands = AGENTARTS_POLICY.get("commands", {})
    default_tier = AGENTARTS_POLICY.get("defaultTier", "approved")
    normalized = aliases.get(group, group)
    entry = commands.get(normalized)
    tier = default_tier
    labels = []
    op = normalized
    if entry:
        tier = entry.get("tier", default_tier)
        labels = entry.get("labels", [])
        subs = entry.get("subcommands")
        # Subcommand location walk (mirrors safety-policy.mjs
        # resolveAgentartsGroupTokens, round 10): click parses the GROUP's
        # own option panel before the subcommand resolves, and a
        # group-level `--` is consumed by the group parser while the
        # subcommand parser restarts fresh (measured: `memory -- create x`
        # executes like `memory create x`). A naive tokens[i+1] read saw no
        # subcommand for both shapes and denied genuine readonlys as cloud
        # writes (`memory -- list`). Only config takes value flags at
        # group level (fixture-pinned; keep in sync with
        # AGENTARTS_GROUP_LEVEL_VALUE_FLAGS in safety-policy.mjs).
        group_value_flags = {
            "--name",
            "-n",
            "--entrypoint",
            "-e",
            "--region",
            "-r",
            "--dependency-file",
            "-d",
            "--swr-org",
            "--swr-repo",
        }
        if subs:
            j = i + 1
            saw_separator = False
            while j < len(tokens):
                token = tokens[j]
                if token == "--" and not saw_separator:
                    saw_separator = True
                    j += 1
                    continue
                if token in group_value_flags and j + 1 < len(tokens):
                    j += 2
                    continue
                inline = re.match(r"^(--[a-z0-9-]+)=", token) or re.match(r"^(-[a-z0-9])(.+)$", token)
                if inline and inline.group(1) in group_value_flags:
                    j += 1
                    continue
                break
            if j < len(tokens) and not tokens[j].startswith("-"):
                sub_entry = subs.get(tokens[j])
                if sub_entry:
                    tier = sub_entry.get("tier", tier)
                    labels = sub_entry.get("labels", labels)
                    op = f"{normalized} {tokens[j]}"
    if tier not in ("approved", "blocked"):
        return None
    label_suffix = f" ({', '.join(labels)})" if labels else ""
    if tier == "blocked":
        return (
            f"agentarts {op} is deferred to a later toolkit release; run it in your own terminal if needed "
            "(see the huawei-agentarts skill)."
        )
    return (
        f"Bash execution of agentarts {op}{label_suffix} is blocked: cloud write operations must run in your "
        "own terminal or through approved tooling (see the huawei-agentarts skill)."
    )


def agentarts_block_reason(text):
    """Classify an `agentarts …` command against agentartsCommandPolicy.

    Returns a block reason for approved/blocked tiers, None for
    local/readonly. Fails safe: an unresolvable group/subcommand classifies
    as the policy defaultTier (approved), and a missing policy denies any
    agentarts command rather than allowing it unclassified. Inner wrapper
    payloads and shell-operator/newline segments are each classified, so a
    write chained after a readonly segment is caught.
    """
    for candidate in _inner_command_candidates(text):
        for segment in re.split(r"\|\||&&|;|\||&|\r?\n", candidate):
            segment = segment.strip()
            if not segment:
                continue
            reason = _agentarts_classify_segment(segment)
            if reason:
                return reason
    return None


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


def record_cli_event(text):
    m = HCLOUD_RE.search(text)
    if not m:
        return
    rest = text[m.end():].strip()
    parts = rest.split()
    cmd = " ".join(p for p in parts if not p.startswith("--") and not p.startswith("-") and "=" not in p)
    if not cmd:
        return
    is_read = bool(READ_OPERATION_RE.search(cmd))
    is_write = bool(WRITE_OPERATION_RE.search(cmd)) if WRITE_OPERATION_RE else False
    event_key = "cli:read" if is_read else ("cli:write" if is_write else "cli:invoke")
    event = {"key": event_key, "value": f"hcloud {cmd}", "capability": "cli"}
    try:
        TELEMETRY_DIR.mkdir(parents=True, exist_ok=True)
        with HOOK_EVENTS_PATH.open("a", encoding="utf-8") as f:
            f.write(json.dumps(event) + "\n")
    except Exception:
        pass


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

    # Env-dump and credential-var gates are module-level constants (no
    # policy.json dependency), so credential protection survives a broken
    # policy; they sweep the inner-command candidates so wrapper-embedded
    # payloads (`bash -c "env | grep HUAWEICLOUD"`, #682) classify like they
    # do in classifyTextCommand.
    candidates = _inner_command_candidates(text)
    if CONFIG_FILE_RE and CONFIG_FILE_RE.search(text):
        return "reading Huawei Cloud credential/profile files can expose AK/SK or tokens. Use redacted toolkit tools."
    for candidate in candidates:
        if ENV_DUMP_CMD_RE.search(candidate) and ENV_DUMP_CLOUD_RE.search(candidate):
            return "dumping cloud credential environment variables is not allowed."
    for candidate in candidates:
        if CRED_VAR_REF_RE.search(candidate):
            return "printing cloud credential environment variables is not allowed."
    if not POLICY_OK:
        # Policy-dependent gates below are unclassifiable without the policy:
        # deny rather than degrade silently, matching the wired Node hook's
        # load-failure posture.
        return "safety policy failed to load; blocking this action (fail-safe)."
    if SECRET_READ_RE and SECRET_READ_RE.search(text):
        return "direct secret value retrieval would put plaintext secrets into the agent context."
    # The agentarts gate runs BEFORE the generic cloud-risk rules: the
    # agentarts reason points at the approved-tooling path (the actionable
    # remediation), while a generic rule would mask it — Node layer's
    # classifyTextCommand orders the same way (agentarts_write wins over
    # evaluateCommandRisk). PR11 caught the drift via
    # `agentarts memory delete --force` hitting the generic
    # force-deletion rule first.
    if tool_name in ("Bash", "terminal"):
        agentarts_reason = agentarts_block_reason(text)
        if agentarts_reason:
            return agentarts_reason
    denied_rule = first_denied_command_rule(text)
    if denied_rule:
        return f"{denied_rule.get('message')} Remediation: {denied_rule.get('remediation')}"
    if tool_name in ("Bash", "terminal") and WRITE_OPERATION_RE:
        # Per-segment hcloud gate over every inner-command candidate: a
        # read-looking token anywhere used to suppress the whole gate, and a
        # quote-preceded hcloud inside a wrapper (`bash -c "hcloud ECS
        # DeleteServer …"`) escaped the raw-text match entirely — deny wins
        # across candidates and segments, matching the Node layer's
        # deny-first candidate merge.
        for candidate in candidates:
            for segment in re.split(r"\|\||&&|;|\||&|\r?\n", candidate):
                segment = segment.strip()
                if not segment:
                    continue
                # `… | xargs/parallel hcloud` (segment ends with the keyword,
                # no in-text args): the arguments arrive on stdin and cannot
                # be classified — fail-safe deny, mirroring the Node layer's
                # bare-allow guard. Quote-split spellings covered via the
                # de-quoted copy.
                dequoted = re.sub(r"['\"]", "", segment)
                if (
                    re.search(r"\b(?:g)?(?:xargs|parallel)\b", dequoted, re.I)
                    and re.search(r"(?:^|\s)hcloud(?:\.exe)?\s*$", dequoted, re.I)
                ):
                    return (
                        "hcloud invoked via xargs/parallel (arguments arrive on stdin and cannot be classified); "
                        "run it in your own terminal or use the approved tooling."
                    )
                if HCLOUD_RE.search(segment) and WRITE_OPERATION_RE.search(segment) and not READ_OPERATION_RE.search(segment):
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

    text = command_text(tool_input)
    record_cli_event(text)

    reason = evaluate(tool_name, tool_input)
    if reason:
        deny(reason, hermes)

    allow()


if __name__ == "__main__":
    main()
