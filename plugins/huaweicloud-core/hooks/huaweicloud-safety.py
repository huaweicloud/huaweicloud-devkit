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
SECRET_CLI_RE = None
WRITE_OPERATION_RE = None
BLOCKED_CONFIGURE_SUBCOMMANDS = set()


def load_policy():
    global CONFIG_FILE_RE, SECRET_READ_RE, SECRET_CLI_RE, WRITE_OPERATION_RE
    try:
        with POLICY_PATH.open("r", encoding="utf-8") as file_obj:
            policy = json.load(file_obj)
        cred_patterns = policy.get("credentialFilePatterns", [])
        if cred_patterns:
            CONFIG_FILE_RE = re.compile("|".join(cred_patterns), re.I)
        blocked_secrets = policy.get("blockedSecretOperations", [])
        if blocked_secrets:
            SECRET_READ_RE = re.compile("|".join(re.escape(op) for op in blocked_secrets), re.I)
        blocked_configure = policy.get("blockedConfigureSubcommands", [])
        if blocked_configure:
            global BLOCKED_CONFIGURE_SUBCOMMANDS
            BLOCKED_CONFIGURE_SUBCOMMANDS = {cmd.lower() for cmd in blocked_configure}
        blocked_secret_cli = policy.get("blockedSecretCliPatterns", [])
        if blocked_secret_cli:
            SECRET_CLI_RE = re.compile("|".join(blocked_secret_cli), re.I)
        write_prefixes = policy.get("writeOperationPrefixes", [])
        if write_prefixes:
            # Applied to the OPERATION TOKEN (positional, like the TS
            # hasWritePrefix): ^ matches token start, [A-Za-z0-9] admits
            # compound names (NovaCreate…). The older whole-text form with
            # (^|[A-Za-z0-9]) never matched a space-preceded plain
            # operation AND matched prose after `echo`.
            WRITE_OPERATION_RE = re.compile(r"(^|[A-Za-z0-9])(" + "|".join(write_prefixes) + r")\w*", re.I)
    except Exception:
        pass


load_policy()

ENV_DUMP_RE = re.compile(
    r"(^|\s)(env|printenv|export\s+-p|declare|typeset|set|Get-ChildItem\s+Env:|gci\s+Env:|dir\s+Env:)(?![A-Za-z0-9_-]).*(HUAWEICLOUD(?!-devkit)|HWC_|HCLOUD_|OS_|HW_(?:ACCESS_KEY|SECRET_KEY|SECURITY_TOKEN|API_KEY|VAULT_MASTER_KEY))",
    re.I,
)
HCLOUD_RE = re.compile(r"(^|\s)hcloud(\.exe)?\s+", re.I)
READ_OPERATION_RE = re.compile(r"\b(List|Show|Get|Describe|NovaList|NovaShow)\w*", re.I)
# Mirrors the TS layer's #650 D4-2 gate: unescaped $HW_/$HUAWEICLOUD_/
# $HWC_/$OS_ credential expansions are a potential dump regardless of the
# command. The negative lookbehind exempts backslash-escaped or single-quoted
# names (the shell never expands those), so this stays on RAW text.
CRED_EXPANSION_RE = re.compile(
    r"(?<!['\\])\$\{?(?:HUAWEICLOUD|HWC|HW|OS)_(?:ACCESS_KEY|SECRET_KEY|SECURITY_TOKEN|API_KEY|VAULT_MASTER_KEY)",
    re.I,
)
# printenv with a bare credential name: a command-name gate, so it runs on
# the quote-stripped shadow (quoting a command name does not stop it).
PRINTENV_CRED_RE = re.compile(
    r"(^|\s)printenv\s+.*(?:HUAWEICLOUD|HWC|HW|OS)_(?:ACCESS_KEY|SECRET_KEY|SECURITY_TOKEN|API_KEY|VAULT_MASTER_KEY)",
    re.I,
)


def strip_shell_quotes(text):
    """Quote/backslash/dollar/backtick-stripped shadow for presence gates:
    quoted tokens (``secret 'get'``, ``bash -c "hcloud ..."``) and ANSI-C
    quoting (``$'get'``) must not slip past the raw-text regexes the shell
    would still execute. Variable indirection (``$S``) remains a documented
    residual — a text gate cannot see through expansion. None of the
    canonical command tokens contain the stripped characters."""
    return re.sub(r"['\"\\\\$`]", "", text)


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


SHELL_FIRST = {"bash", "sh", "zsh", "dash", "bash.exe", "sh.exe", "/bin/bash", "/bin/sh", "/bin/zsh", "/bin/dash"}
COMMAND_PREFIXES = {
    "sudo", "nohup", "env", "time", "do", "then", "elif", "else", "xargs",
    "if", "while", "until", "exec", "command", "coproc", "!", "{", "(", "timeout",
    "watch", "nice", "stdbuf", "setsid", "ionice",
}
# Value-taking single-letter flags PER PREFIX (a shared set over-stripped:
# `time -p` and `command -p` take no value, so the command token was eaten).
PREFIX_FLAGS_WITH_VALUE = {
    "sudo": {"-u", "-g", "-p", "-U", "-r", "-t", "-D", "-C", "--user", "--group", "--prompt", "--other-user", "--role", "--type"},
    "nice": {"-n", "--adjustment"},
    "xargs": {"-I", "-d", "-E", "-S", "--replace", "--delimiter", "--max-args", "--max-chars"},
    "stdbuf": {"-o", "-e", "-i"},
    "env": {"-u", "--unset"},
    "timeout": {"--signal", "-s", "-k", "--kill-after"},
}


def basename_of(token):
    t = token.replace("\\", "/")
    return t.rsplit("/", 1)[-1]


def is_redirection_token(token):
    return re.match(r"^\d*(>>|>|<|&>>|>&|<&)", token) is not None
DEVKIT_BIN_NAMES = {
    "huaweicloud-devkit", "huaweicloud-devkit.js", "huaweicloud-devkit.cjs",
    "huaweicloud-devkit.mjs", "huaweicloud-devkit.ts", "huaweicloud-devkit.exe",
    "setup-cli.js", "setup-cli.mjs", "setup-cli.ts", "setup.cjs",
}
OBSUTIL_WRITES = {
    "mb", "cp", "mv", "rm", "delete", "mkdir", "sync", "restore", "chattri",
    "bucketpolicy", "lifecycle", "cors", "website", "sign", "share-add", "share-update", "share-rm",
}
# Argument-less full-dump forms — at COMMAND POSITION (start or after a
# separator) so `make env` / `rg env` stay legitimate: env/printenv/export/
# declare/typeset take flags; bare `set` dumps but `set -e` sets an option.
# A following pipe or redirect means the dump leaves the process either way.
ARGLESS_DUMP_RE = re.compile(
    r"(?:^|[;&|\n\r)]|\|\||&&)\s*(?:env|printenv|export|declare|typeset)(?![A-Za-z0-9_-])(?:\s+(?:--?[A-Za-z0-9-]+(?:=[^ ]*)?|-u\s+\S+))*(\s*[|>].*)?\s*$",
    re.I,
)
BARE_SET_RE = re.compile(r"(?:^|[;&|\n\r)]|\|\||&&)\s*set\s*$", re.I)
DUMP_PIPE_RE = re.compile(r"(?:^|[;&|\n\r)]|\|\||&&)\s*(?:env|printenv|set)(?![A-Za-z0-9_-])\s*(?:\||>)", re.I)
OBFUSCATION_RE = re.compile(r"\$['\"]|\$\(|`")
CLOUD_BIN_RE = re.compile(
    r"(^|[^a-z0-9.-])(?:huaweicloud-devkit|setup-cli\.(?:js|mjs|ts|cjs)|setup\.cjs)|(^|[^a-z0-9.-])hcloud(\.exe)?\s",
    re.I,
)
DEVKIT_BIN_RE = re.compile(
    r"(^|[^a-z0-9.-])(?:huaweicloud-devkit|setup-cli\.(?:js|mjs|ts|cjs)|setup\.cjs)",
    re.I,
)
REVEAL_PAIR_RE = re.compile(r"(?:^|\s)secret\s+get\b", re.I)


def _is_devkit_bin(token):
    base = token.lower().split("@")[0]
    return any(base == n or base.endswith("/" + n) or base.endswith("\\" + n) for n in DEVKIT_BIN_NAMES)


def _unwrap_secret_exec(tokens):
    """Mirror of the TS unwrapSecretExecWrapper: find `<devkit-bin> [--
    ] secret exec ... -- <child>` anywhere in the token stream and return
    the child tokens, so a wrapped hcloud write keeps its classification."""
    for i in range(len(tokens) - 2):
        if not _is_devkit_bin(tokens[i]):
            continue
        j = i + 1
        while j < len(tokens) and tokens[j] == "--":
            j += 1
        if j + 1 >= len(tokens) or tokens[j].lower() != "secret" or tokens[j + 1].lower() != "exec":
            continue
        try:
            dd = tokens.index("--", j + 2)
        except ValueError:
            continue
        if dd + 1 < len(tokens):
            return tokens[dd + 1:]
    return None


def split_tokens(text):
    """Quote-aware tokenizer mirroring the TS ``splitSimpleCommand``: a
    quoted span becomes ONE token (quotes stripped from its content), so
    ``bash -c "hcloud ECS X"`` yields ``['bash','-c','hcloud ECS X']`` and
    the -c argument keeps its grouping."""
    tokens = []
    i, n = 0, len(text)
    while i < n:
        ch = text[i]
        if ch in "'\"":
            end = text.find(ch, i + 1)
            if end < 0:
                tokens.append(text[i + 1:])
                break
            tokens.append(text[i + 1:end])
            i = end + 1
        elif ch.isspace():
            i += 1
        else:
            j = i
            while j < n and not text[j].isspace():
                j += 1
            tokens.append(text[i:j])
            i = j
    return tokens


def hcloud_leading_segment(tokens):
    """Strip command-position prefixes (shell -c, sudo/env/xargs/do/then,
    VAR= assignments) and report the token list when its command token is
    hcloud (any path-qualified / quote-mangled spelling), else None."""
    for _ in range(10):
        if not tokens:
            return None
        first = tokens[0].lower()
        if first in SHELL_FIRST and len(tokens) > 2 and tokens[1].lower() == "-c":
            tokens = split_tokens(tokens[2])
            continue
        if first == "eval" and len(tokens) > 1:
            tokens = split_tokens(tokens[1])
            continue
        if is_redirection_token(tokens[0]):
            tokens = tokens[1:]
            continue
        if first in COMMAND_PREFIXES or basename_of(tokens[0]) in COMMAND_PREFIXES:
            prefix = first if first in COMMAND_PREFIXES else basename_of(tokens[0])
            tokens = tokens[1:]
            value_flags = PREFIX_FLAGS_WITH_VALUE.get(prefix, set())
            while tokens and (tokens[0].startswith("-") or re.match(r"^\d+[smh]?$", tokens[0], re.I)):
                flag = tokens[0]
                tokens = tokens[1:]
                if "=" not in flag and flag in value_flags and tokens:
                    tokens = tokens[1:]
            continue
        if re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", tokens[0]):
            tokens = tokens[1:]
            continue
        child = _unwrap_secret_exec(tokens)
        if child is not None:
            tokens = child
            continue
        break
    if not tokens:
        return None
    t = re.sub(r"^[$(<]+", "", tokens[0].lower())
    for ch in "'\"\\`$":
        t = t.replace(ch, "")
    if t == "hcloud" or t.endswith("/hcloud") or t.endswith("\\hcloud") or t == "hcloud.exe":
        return tokens
    return None


def split_shell_segments(text):
    """Quote/heredoc-aware segment split mirroring the TS splitShellSegments:
    separators count only OUTSIDE quotes and heredoc bodies; a trailing
    backslash joins lines; `$(`, `<(`, backtick, and `)` split too. The rest
    of a heredoc's STARTING line stays live command text (bash semantics);
    the body begins at the next newline and ends at the delimiter line."""
    segments = []
    current = ""
    quote = None
    pending_heredoc = None
    heredoc_delim = None
    heredoc_line = ""
    i, n = 0, len(text)
    while i < n:
        ch = text[i]
        if heredoc_delim is not None:
            current += ch
            if ch == "\n":
                if heredoc_line.strip() == heredoc_delim:
                    heredoc_delim = None
                    segments.append(current)
                    current = ""
                heredoc_line = ""
            else:
                heredoc_line += ch
            i += 1
            continue
        if quote is not None:
            current += ch
            if ch == "\\" and i + 1 < n:
                current += text[i + 1]
                i += 2
                continue
            if ch == quote:
                quote = None
            i += 1
            continue
        if ch == "\\" and i + 1 < n:
            current += text[i + 1]
            i += 2
            continue
        if ch in "\"'":
            quote = ch
            current += ch
            i += 1
            continue
        if ch == "$" and i + 1 < n and text[i + 1] == "(":
            segments.append(current)
            current = ""
            i += 2
            continue
        if ch == "<" and i + 1 < n and text[i + 1] == "(":
            segments.append(current)
            current = ""
            i += 2
            continue
        if ch == "`":
            segments.append(current)
            current = ""
            i += 1
            continue
        if ch in ";&|\n\r)":
            if ch == "\n" and pending_heredoc is not None:
                heredoc_delim = pending_heredoc
                pending_heredoc = None
                heredoc_line = ""
                current += ch
                i += 1
                continue
            segments.append(current)
            current = ""
            i += 1
            continue
        if ch == "<" and i + 1 < n and text[i + 1] == "<":
            prev = text[i - 1] if i > 0 else ""
            at_word_start = i == 0 or prev.isspace() or prev in ";&|\n\r)\"'" or prev.isdigit()
            if at_word_start:
                j = i + 2
                while j < n and text[j] == "-":
                    j += 1
                delim_quote = ""
                if j < n and text[j] in "\"'":
                    delim_quote = text[j]
                    j += 1
                k = j
                while k < n and re.match(r"[A-Za-z0-9_]", text[k]):
                    k += 1
                if k > j and (delim_quote == "" or (k < n and text[k] == delim_quote)):
                    delim = text[j:k]
                    current += "<<"
                    i += 2
                    while i < n and text[i] == "-":
                        current += "-"
                        i += 1
                    if delim_quote:
                        quote = delim_quote
                        current += delim_quote
                        i += 1
                    current += delim
                    i += len(delim)
                    pending_heredoc = delim
                    continue
        current += ch
        i += 1
    segments.append(current)
    return [s.strip() for s in segments if s.strip()]


def hcloud_write_blocked(text, depth=0):
    """True when any hcloud-leading command segment in the payload carries a
    write operation and no read prefix. Positional like the TS layer; nested
    `bash -c`/`eval` scripts re-scan recursively; `xargs hcloud` merges the
    preceding piped segment's tokens as candidate operations; local
    help/version requests are exempt; OBS util subcommands classify through
    the same write list; the operation token is quote-stripped before the
    write/read prefix tests (TS parity); `hcloud configure show/get/list/…`
    is a credential read (policy vocabulary, TS parity)."""
    if not WRITE_OPERATION_RE:
        return False
    segments = split_shell_segments(text)
    for s, segment in enumerate(segments):
        tokens = split_tokens(segment)
        # Nested scripts, BEFORE unwrapping flattens them.
        if depth < 4:
            for candidate in (tokens, _unwrap_secret_exec(tokens) or []):
                nested = _script_of(candidate)
                if nested is not None and hcloud_write_blocked(nested, depth + 1):
                    return True
        stripped = hcloud_leading_segment(tokens)
        if stripped is None:
            continue
        if any(t.lower() in ("--help", "-h", "help", "version", "--version") for t in stripped[1:]):
            continue
        argv = [t for t in stripped[1:] if not t.startswith("-")]
        # xargs feed: the preceding segment's tokens become argv after the
        # segment's own arguments.
        if any(t.lower() == "xargs" or basename_of(t) == "xargs" for t in tokens) and s > 0:
            feeder = split_tokens(segments[s - 1])[1:]
            # Placeholders: literal {} / % runs AND the declared -I/--replace
            # value (any replstr spelling).
            replstr = None
            for t in range(len(tokens)):
                token = str(tokens[t])
                if token in ("-I", "--replace", "--delimiter") and t + 1 < len(tokens):
                    replstr = str(tokens[t + 1])
                    break
                m = re.match(r"^(?:-I|--replace(?:=)?|--delimiter=)(.+)$", token)
                if m:
                    replstr = m.group(1)
                    break
            argv = [t for t in argv if not re.match(r"^[{}%]+$", t) and t != replstr] + feeder
        if not argv:
            continue
        service = strip_shell_quotes(argv[0])
        operation = strip_shell_quotes(argv[1]) if len(argv) > 1 else service
        if service.lower() == "configure" and BLOCKED_CONFIGURE_SUBCOMMANDS and operation.lower() in BLOCKED_CONFIGURE_SUBCOMMANDS:
            return True
        if service.lower() == "obs" and operation.lower() in OBSUTIL_WRITES:
            return True
        if WRITE_OPERATION_RE.search(operation) and not READ_OPERATION_RE.search(operation):
            return True
    return False


def _script_of(tokens):
    """The quoted script argument of a shell -c / eval token stream, or None."""
    if not tokens:
        return None
    first = tokens[0].lower()
    base = basename_of(tokens[0]).lower()
    shell_like = first in SHELL_FIRST or (base != first and base in SHELL_FIRST)
    if shell_like and re.match(r"^-[a-z]*c$", tokens[1], re.I) and len(tokens) > 2:
        return tokens[2]
    if first == "eval" and len(tokens) > 1:
        return tokens[1]
    return None


def evaluate(tool_name, tool_input):
    """Run the full safety check and return a raw block reason, or None to allow.

    Shared by the CLI shell (``main``) and the Hermes Python-plugin hook, which
    reuses this module via ``importlib`` so a single implementation enforces the
    policy everywhere. The returned reason does NOT include ``DENY_PREFIX`` —
    callers decide the exact output shape.
    """
    text = command_text(tool_input)
    unquoted = strip_shell_quotes(text)
    normalized = re.sub(r"/{2,}", "/", text)
    normalized = re.sub(r"/\./", "/", normalized)
    normalized_unquoted = re.sub(r"/{2,}", "/", unquoted)
    normalized_unquoted = re.sub(r"/\./", "/", normalized_unquoted)
    # Raw, shadow, and their path-normalized forms: a quote pair inside the
    # path or a redundant `//`/`/./` segment defeats the contiguous-substring
    # patterns while the shell reads the canonical path.
    if CONFIG_FILE_RE and any(
        CONFIG_FILE_RE.search(candidate)
        for candidate in (text, unquoted, normalized, normalized_unquoted)
    ):
        return "reading Huawei Cloud credential/profile files can expose AK/SK or tokens. Use redacted toolkit tools."
    if SECRET_CLI_RE and SECRET_CLI_RE.search(unquoted):
        return "printing vault secrets into the agent context is blocked. Use secret exec so the value reaches only the child process environment."
    # Order-independent reveal pair: xargs reorders the argv while every word
    # stays literal — a devkit bin plus a `secret get` pair anywhere is a
    # reveal regardless of order.
    if DEVKIT_BIN_RE.search(unquoted) and REVEAL_PAIR_RE.search(unquoted):
        return "printing vault secrets into the agent context is blocked. Use secret exec so the value reaches only the child process environment."
    # Obfuscated cloud-command invocation: ANSI-C escapes and command
    # substitution build argv the shadow cannot reconstruct. Canonical
    # devkit/hcloud commands never carry them.
    if (CLOUD_BIN_RE.search(unquoted) or re.search(r"secret://", unquoted)) and OBFUSCATION_RE.search(text):
        return "an obfuscated cloud CLI invocation (shell expansion inside the command) is blocked. Write the command in plain form."
    if (
        ENV_DUMP_RE.search(unquoted)
        or ARGLESS_DUMP_RE.search(unquoted)
        or BARE_SET_RE.search(unquoted)
        or DUMP_PIPE_RE.search(unquoted)
    ):
        return "dumping cloud credential environment variables is not allowed."
    # Single-quoted spans removed before the expansion test: the shell never
    # expands inside them, but a CLOSING quote before an unquoted $HW_ still
    # expands (`echo 'a'$HW_SECRET_KEY`).
    un_single_quoted = re.sub(r"'[^']*'", "", text)
    if CRED_EXPANSION_RE.search(un_single_quoted) or PRINTENV_CRED_RE.search(unquoted):
        return "printing cloud credential environment variables is not allowed."
    if SECRET_READ_RE and (SECRET_READ_RE.search(text) or SECRET_READ_RE.search(unquoted)):
        return "direct secret value retrieval would put plaintext secrets into the agent context."
    denied_rule = first_denied_command_rule(text)
    if denied_rule:
        return f"{denied_rule.get('message')} Remediation: {denied_rule.get('remediation')}"
    if tool_name in ("Bash", "terminal") and hcloud_write_blocked(text):
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
