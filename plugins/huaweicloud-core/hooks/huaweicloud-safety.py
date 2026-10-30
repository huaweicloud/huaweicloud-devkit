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
import os
import re
import sys
from pathlib import Path
from datetime import datetime, timezone

DENY_PREFIX = "Huawei Cloud safety hook blocked this action: "
RULES_PATH = Path(__file__).resolve().parents[1] / "safety" / "rules" / "cloud-risk-rules.json"
POLICY_PATH = Path(__file__).resolve().parents[1] / "safety" / "policy.json"

# parents[1] is the plugin dir (hooks/ sits directly under it); the previous
# parents[2] landed telemetry one level too high, which in the codex plugin
# cache layout wrote a 'telemetry' sibling next to the version dir and broke
# codex's version resolution (same failure the bundled server's depth-based
# PLUGIN_DIR caused before the resolvePluginDir fix in telemetry.ts).
PLUGIN_DIR = Path(__file__).resolve().parents[1]
TELEMETRY_DIR = PLUGIN_DIR / "telemetry"
HOOK_EVENTS_PATH = TELEMETRY_DIR / "hook-events.jsonl"

CONFIG_FILE_RE = None
SECRET_READ_RE = None
SECRET_CLI_RE = None
WRITE_OPERATION_RE = None
WRITE_VOCAB_RE = None
READ_OPERATION_RE = None
BLOCKED_CONFIGURE_SUBCOMMANDS = set()

# OBS util write-capable subcommands — the write-gate's OBS face and (via the
# load_policy union) the obfuscation gate's vocabulary. Kept as one set per
# layer with the TS twin (src/safety/tokens.ts OBSUTIL_WRITES), pinned by the
# hook-parity battery.
OBSUTIL_WRITES = {
    "mb", "cp", "mv", "rm", "delete", "mkdir", "sync", "restore", "chattri",
    "bucketpolicy", "lifecycle", "cors", "website", "sign", "share-add", "share-update", "share-rm",
    # KooCLI 7.3.12 write-capable subcommands (-method based, except
    # custom-domain which writes via -cname/certificate options),
    # plus the full-name put/delete public-access-block writes.
    "bucket-tagging", "object-tagging", "encryption", "custom-domain", "mirror-back-to-source",
    "put-public-access-block", "delete-public-access-block",
    # Pre-existing on 7.2.x too but never dispositioned (7.3.12-pin sweep),
    # plus create-share (issues capability tokens — sign's class) and update
    # (obsutil self-update — mutates the installed binary).
    "abort", "archive", "create-share", "update",
}
# The OBS subcommand half of the obfuscation gate's vocabulary (marker-gated
# at the gate — see the load_policy comment). Module-compiled, not
# policy-derived: OBSUTIL_WRITES has its own pinned dual-home doctrine
# (the KooCLI 7.3.12 lockstep sweep), so it is not foldable into
# policy.json's prefix list. The marker that gates it is the word-bounded
# OBS service token (also matches `obs://` — the colon is a boundary);
# `observations`/`jobs` stay non-markers. A bare `cloud` SUBSTRING was the
# round-2 marker and denied routine huaweicloud-bearing PATHS
# (cp $(mktemp -d)/x plugins/huaweicloud-core/dist/foo) — the decoded-bin
# clause (decode_ansi_c_spans, interrogate round 3) now carries the
# mangled-bin class that substring existed for.
OBS_VOCAB_RE = re.compile(r"(^|[^a-z])(?:" + "|".join(sorted(OBSUTIL_WRITES)) + ")", re.I)
OBS_MARKER_RE = re.compile(r"\bOBS\b", re.I)


def load_policy():
    global CONFIG_FILE_RE, SECRET_READ_RE, SECRET_CLI_RE, WRITE_OPERATION_RE, WRITE_VOCAB_RE, READ_OPERATION_RE
    try:
        with POLICY_PATH.open("r", encoding="utf-8") as file_obj:
            policy = json.load(file_obj)
        # Write/read vocabularies FIRST, per-field isolated (interrogate
        # round 1): an invalid regex in a LATER field's list
        # (credentialFilePatterns, blockedSecretOperations, ...) must not
        # abort the load before the vocabularies compile — their
        # unavailability fails their gates CLOSED (hcloud_write_blocked /
        # the obfuscation clause), so unrelated corruption must not trigger
        # that arm while the lists are intact. Non-list values normalize to
        # [] so every degraded shape funnels into the fail-closed arms
        # instead of "|".join-ing a string into a garbage char-alternation.
        write_prefixes = policy.get("writeOperationPrefixes", [])
        if not isinstance(write_prefixes, list):
            write_prefixes = []
        if write_prefixes:
            # Applied to the OPERATION TOKEN (positional, like the TS
            # hasWritePrefix): ^ matches token start, [A-Za-z0-9] admits
            # compound names (NovaCreate…). The older whole-text form with
            # (^|[A-Za-z0-9]) never matched a space-preceded plain
            # operation AND matched prose after `echo`.
            WRITE_OPERATION_RE = re.compile(r"(^|[A-Za-z0-9])(" + "|".join(write_prefixes) + r")\w*", re.I)
            # Write-operation vocabulary for the obfuscation gate's
            # fail-closed clause — DERIVED from the same policy list as
            # WRITE_OPERATION_RE, never a second hand-maintained
            # alternation: the hardcoded 20-word copy this replaced had
            # drifted from the 37 policy.json prefixes, and the 17 missing
            # words (invoke/execute/trigger/deploy among them) let mangled
            # writes through the py-hook faces (Hermes importlib, WorkBuddy
            # deploy) while the TS layer denied (writeVocabHit over
            # DEFAULT_POLICY.writeOperationPrefixes in classify-text.ts).
            # The OBSUTIL_WRITES union rides a SEPARATE marker-gated regex
            # (interrogate round 2): routing dies with the keyword under
            # ANSI-C mangling, so non-prefix obsutil subcommand writes
            # (rm/cp/mv/sync/chattri…) must be in the vocab — but those
            # short words are routine shell vocabulary, so that arm fires
            # only when the shadow also carries a cloud marker (any *cloud
            # spelling — the mangled bin leaves `x68cloud` — or the OBS
            # service token), keeping `docker rm $(docker ps -aq)` and
            # `mkdir -p $(pwd)/build` legitimate. The vocabulary's own
            # failure mode lives at the gate: an unavailable derivation
            # fails the clause CLOSED.
            WRITE_VOCAB_RE = re.compile(r"(^|[^a-z])(?:" + "|".join(write_prefixes) + ")", re.I)
        read_prefixes = policy.get("readOperationPrefixes", [])
        if not isinstance(read_prefixes, list):
            read_prefixes = []
        if read_prefixes:
            # The read vocabulary, likewise derived (interrogate round 1 —
            # the hardcoded mirror was the last hand-maintained policy
            # copy). Kept in the historical \b-anywhere shape for BOTH
            # consumers: record_cli_event matches it against the
            # "Service Operation" cmd string (the read word is the SECOND
            # word), and the write gate's read exemption anchors it at the
            # operation token's start via re.match (TS hasReadPrefix's
            # ^prefix parity — \b at position 0 is equivalent).
            READ_OPERATION_RE = re.compile(r"\b(" + "|".join(read_prefixes) + r")\w*", re.I)
        cred_patterns = policy.get("credentialFilePatterns", [])
        if cred_patterns:
            CONFIG_FILE_RE = re.compile("|".join(cred_patterns), re.I)
        blocked_secrets = [op for op in policy.get("blockedSecretOperations", []) if op != ""]
        if blocked_secrets:
            # Only entries that are a PREFIX of another entry (ShowSecret is
            # a stem of ShowSecretVersion) get boundary guards, so the stem
            # does not substring-match longer operations or stem-containing
            # resource names (ShowSecretsConfig, showsecret-demo). The
            # self-specific entries stay unguarded: their substring
            # semantics on the quote-stripped shadow must match the TS
            # layer's unguarded alternatives or the layers drift.
            def _secret_pattern(op):
                pattern = re.escape(op)
                is_stem = any(
                    other != op and other.lower().startswith(op.lower()) for other in blocked_secrets
                )
                if is_stem:
                    pattern = r"(?<![A-Za-z0-9._/-])" + pattern + r"(?![A-Za-z0-9._/-])"
                return pattern

            SECRET_READ_RE = re.compile("|".join(_secret_pattern(op) for op in blocked_secrets), re.I)
        blocked_configure = policy.get("blockedConfigureSubcommands", [])
        if blocked_configure:
            global BLOCKED_CONFIGURE_SUBCOMMANDS
            BLOCKED_CONFIGURE_SUBCOMMANDS = {cmd.lower() for cmd in blocked_configure}
        blocked_secret_cli = policy.get("blockedSecretCliPatterns", [])
        if blocked_secret_cli:
            SECRET_CLI_RE = re.compile("|".join(blocked_secret_cli), re.I)
    except Exception:
        pass


load_policy()

ENV_DUMP_RE = re.compile(
    r"(^|\s)(env|printenv|export\s+-p|declare|typeset|set|Get-ChildItem\s+Env:|gci\s+Env:|dir\s+Env:)(?![A-Za-z0-9_-]).*(HUAWEICLOUD(?!-devkit)|HWC_|HCLOUD_|OS_|HW_(?:ACCESS_KEY|SECRET_KEY|SECRET_ACCESS_KEY|SECURITY_TOKEN|API_KEY|VAULT_MASTER_KEY))",
    re.I,
)
HCLOUD_RE = re.compile(r"(^|\s)hcloud(\.exe)?\s+", re.I)
# READ_OPERATION_RE is policy-derived (load_policy, from
# readOperationPrefixes) — see the derivation comment there for the two
# consumer shapes (record_cli_event's \b-anywhere, the write gate's
# re.match anchoring).
# Mirrors the TS layer's #650 D4-2 gate: unescaped $HW_/$HUAWEICLOUD_/
# $HWC_/$OS_ credential expansions are a potential dump regardless of the
# command. The negative lookbehind exempts backslash-escaped or single-quoted
# names (the shell never expands those), so this stays on RAW text.
CRED_EXPANSION_RE = re.compile(
    r"(?<!['\\])\$\{?(?:HUAWEICLOUD|HWC|HW|OS)_(?:ACCESS_KEY|SECRET_KEY|SECRET_ACCESS_KEY|SECURITY_TOKEN|API_KEY|VAULT_MASTER_KEY)",
    re.I,
)
# printenv with a bare credential name: a command-name gate, so it runs on
# the quote-stripped shadow (quoting a command name does not stop it).
PRINTENV_CRED_RE = re.compile(
    r"(^|\s)printenv\s+.*(?:HUAWEICLOUD|HWC|HW|OS)_(?:ACCESS_KEY|SECRET_KEY|SECRET_ACCESS_KEY|SECURITY_TOKEN|API_KEY|VAULT_MASTER_KEY)",
    re.I,
)


def strip_shell_quotes(text):
    """Quote/backslash/dollar/backtick-stripped shadow for presence gates:
    quoted tokens (``secret 'get'``, ``bash -c "hcloud ..."``) and ANSI-C
    quoting (``$'get'``) must not slip past the raw-text regexes the shell
    would still execute. Variable indirection (``$S``) remains a documented
    residual — a text gate cannot see through expansion. None of the
    canonical command tokens contain the stripped characters.

    Line continuations drop FIRST (interrogate round 4): bash removes the
    \\<newline> pair at parser level, and the surviving newline broke
    contiguity everywhere (``h\\<LF>cloud`` never routed,
    ``De\\<LF>leteServers`` never matched a prefix). Single-quoted spans
    keep the pair in real bash — over-stripping there only ever JOINS text
    (fail-closed toward detection, never hides a marker)."""
    text = re.sub(r"\\\n", "", text)
    return re.sub(r"['\"\\\\$`]", "", text)


ANSI_C_DECODE_RE = re.compile(r"\\(?:x([0-9a-fA-F]{1,2})|([0-7]{1,3})|u([0-9a-fA-F]{1,4})|U([0-9a-fA-F]{1,8}))")

# The JS /\s/ character class (interrogate round 10): the glued tokenizer's
# word separators — str.isspace() is a superset (\x85, \x1c-\x1f) that bash
# does not treat as IFS and JS does not match.
JS_WHITESPACE_RE = re.compile(r"[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]")


def decode_ansi_c_spans(text):
    """Reconstruct the argv letters ANSI-C quoting builds: inside $'…' spans
    (opened only OUTSIDE quotes — a $ already inside a plain quoted span is
    a literal), decode \\xHH, \\NNN (octal), \\uHHHH, and \\UHHHHHHHH
    escapes to their characters; everything else passes through verbatim
    (interrogate round 3: the obfuscation gate's candidates now see
    ``h$'\\x63'loud`` as the ``hcloud`` the shell actually executes, so
    mangling past a marker — the round-2 cloud-marker gate's bypass — no
    longer hides the bin, the service token, or the operation word).
    \\' inside the span does not close it; \\\\ and unrecognized escapes
    stay literal (conservative); an unterminated span returns the ORIGINAL
    text (no decode — today's shadow); $"…" spans pass through (locale
    quoting, no escape processing for identifiers); command substitution
    $(…) stays opaque (the documented residual — the printf-built bin
    class). Mirrored by decodeAnsiCSpans in src/safety/shell-text.ts —
    hook-parity pins the shared verdicts."""
    if "$'" not in text:
        return text
    out = []
    i, n = 0, len(text)
    quote = None
    while i < n:
        ch = text[i]
        if quote is not None:
            out.append(ch)
            if ch == "\\" and quote == '"' and i + 1 < n:
                out.append(text[i + 1])
                i += 2
                continue
            if ch == quote:
                quote = None
            i += 1
            continue
        if ch in ("'", '"'):
            quote = ch
            out.append(ch)
            i += 1
            continue
        if ch == "\\" and i + 1 < n:
            # Outside quotes a backslash escapes the NEXT character (both
            # stay — the shadow's own backslash-strip handles them).
            # Without this, an escaped quote opened PHANTOM quote state and
            # disabled the entire decode for the rest of the payload
            # (interrogate round 4: \' ; h$'\x63'loud … let the mangled
            # write through every layer), and \$' mis-parsed as an ANSI-C
            # span opener instead of \$ + plain quotes.
            out.append(ch)
            out.append(text[i + 1])
            i += 2
            continue
        if ch == "$" and i + 1 < n and text[i + 1] == "'":
            j = i + 2
            span = []
            closed = False
            while j < n:
                c = text[j]
                if c == "'":
                    closed = True
                    j += 1
                    break
                if c == "\\" and j + 1 < n:
                    nxt = text[j + 1]
                    if nxt == "'":
                        span.append("'")
                        j += 2
                        continue
                    m = ANSI_C_DECODE_RE.match(text, j)
                    if m:
                        digits = m.group(1) or m.group(2) or m.group(3) or m.group(4)
                        is_octal = m.group(2) is not None
                        radix = 8 if is_octal else 16
                        try:
                            value = int(digits, radix)
                            if is_octal:
                                value &= 0xFF  # bash masks \NNN to 8 bits (NUL-truncating >0o377)
                            if 0 <= value <= 0x10FFFF:
                                span.append(chr(value))
                                j = m.end()
                                continue
                        except ValueError:
                            pass
                    span.append(c)
                    span.append(nxt)
                    j += 2
                    continue
                span.append(c)
                j += 1
            if not closed:
                return text
            out.append("".join(span))
            i = j
            continue
        out.append(ch)
        i += 1
    return "".join(out)


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
    # Telemetry opt-out gates the local spool too (no collection while
    # off, so nothing is transmitted retroactively on re-enable).
    if os.environ.get("HUAWEICLOUD_DEVKIT_TELEMETRY") == "off":
        return
    m = HCLOUD_RE.search(text)
    if not m:
        return
    rest = text[m.end():].strip()
    parts = rest.split()
    cmd = " ".join(p for p in parts if not p.startswith("--") and not p.startswith("-") and "=" not in p)
    # Trim to Service+Operation: no file paths / bucket names ride along
    # (matches the MCP face's trim in tools.ts).
    cmd = " ".join(cmd.split()[:2])
    if not cmd:
        return
    is_read = bool(READ_OPERATION_RE.search(cmd)) if READ_OPERATION_RE else False
    # Per-word write search (interrogate round 2): the cmd string is
    # "Service Operation" — the write prefix regex's (^|[A-Za-z0-9]) class
    # never matches the SPACE before the operation, so the canonical
    # `hcloud ECS CreateServers` labeled cli:invoke. Searching each word
    # anchors at the operation token's start (compound NovaCreate still
    # admits mid-token). OBS subcommand writes stay unlabeled (cli:invoke)
    # — the label vocabulary is the policy prefix list, same as the gate's.
    is_write = (
        any(WRITE_OPERATION_RE.search(w) for w in cmd.split()) if WRITE_OPERATION_RE else False
    )
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
    "sudo", "nohup", "env", "time", "do", "then", "elif", "elseif", "else", "xargs",
    "if", "while", "until", "exec", "command", "coproc", "!", "{", "(", "timeout",
    "watch",
    # busybox: the applet dispatcher — `busybox sh -c '…'` / `busybox awk
    # '…'` run the applet named as the next token (interrogate round 14 C3).
    "busybox",
    "nice", "stdbuf", "setsid", "ionice", "start", "call",
    # PowerShell scriptblock control grammar and cmd `if`-condition words:
    # a wrapper payload headed by these runs its body, so the re-base must
    # see through them. None is a plausible bare POSIX program name.
    "try", "catch", "finally", "begin", "process", "end", "switch", "default",
    "foreach", "where", "function", "filter", "defined", "exist", "not",
    "errorlevel", "%",
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
    # watch's -n/--interval carry the interval; -d/-t/-g/-b/-e are boolean
    # (the COMMAND words follow the flags — never consume them).
    "watch": {"-n", "--interval"},
    # cmd.exe's `start` takes slash flags (`/b /wait /min …`); `/d <path>`
    # carries a value.
    "start": {"/d"},
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
# Argument-less full-dump forms — at COMMAND POSITION (start or after a
# separator) so `make env` / `rg env` stay legitimate: env/printenv/export/
# declare/typeset take flags; bare `set` dumps but `set -e` sets an option.
# A following pipe or redirect means the dump leaves the process either way.
# The flags alternation is deliberately unambiguous: the long-flag branch
# carries (?!u\s) so a bare `-u` can ONLY parse through the `-u <value>`
# branch — the two-branch overlap on `-u ...` chains was exponential
# backtracking on failing tails (CodeQL; measured on the TS twin: 26
# repetitions of ' -u -- ' took 14.3s, 28 took >120s pre-fix, 5000 take 1ms
# post-fix). Must stay structurally identical to classify-text.ts.
ARGLESS_DUMP_RE = re.compile(
    r"(?:^|[;&|\n\r)]|\|\||&&)\s*(?:env|printenv|export|declare|typeset)(?![A-Za-z0-9_-])(?:\s+(?:-u\s+\S+|--?(?!u\s)[A-Za-z0-9-]+(?:=[^ ]*)?))*(\s*[|>].*)?\s*$",
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
    return _matches_bin_name(token, DEVKIT_BIN_NAMES)


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


SKQ_VALUE_FLAGS = {"--skill-name", "--session-id", "--json"}
SKQ_BIN_NAMES = ("skill-quality-cli", "skill-quality-cli.exe", "skill-quality-cli.bin")


def _normalize_bin_token(token):
    """Strip a trailing @version spec (never a path segment), leading $/$(
    runs, and quote/backslash/dollar mangling the tokenizer preserves but
    the shell removes. `<` is deliberately NOT stripped: a `<hcloud` token
    is a redirection, not an hcloud invocation."""
    base = str(token).lower()
    base = re.sub(r"@[^/\\]*$", "", base)
    base = re.sub(r"^[$(]+", "", base)
    return re.sub(r"['\"`$\\]", "", base)


def _matches_bin_name(token, names):
    """Try BOTH the raw token (Windows \\-qualified paths keep their
    separators) and the normalized form (POSIX quote/escape mangling)."""
    raw = re.sub(r"@[^/\\]*$", "", str(token).lower())
    norm = _normalize_bin_token(token)
    return any(
        raw == n or raw.endswith("/" + n) or raw.endswith("\\" + n) or norm == n or norm.endswith("/" + n) or norm.endswith("\\" + n)
        for n in names
    )


def _is_hcloud_bin(token):
    t = _normalize_bin_token(token)
    return t == "hcloud" or t.endswith("/hcloud") or t == "hcloud.exe"


# Windows script-taking wrappers (cmd /c|/k "…", powershell|pwsh
# -Command|-c "…", .exe, path-qualified, `//c` Git-Bash, glued /c"…", and
# quote-mangled spellings) — mirrors the TS windowsScriptArgAt
# (#731/#760 parity). Both shells accept OPTIONS before the script flag
# (`-NoProfile -Command`, cmd `/d /s /v:on` before `/c`); the option
# region is scanned without a count cap or a closed option set.
# PowerShell ALSO binds the first POSITIONAL argument to -Command
# (`powershell hcloud ECS ListServers`), covered by a second pass that
# skips the KNOWN value-taking options' values.
WINDOWS_CMD_NAMES = ("cmd", "cmd.exe")
WINDOWS_PS_NAMES = ("powershell", "powershell.exe", "pwsh", "pwsh.exe")
POWERSHELL_VALUE_OPTIONS = {
    "-executionpolicy", "-outputformat", "-inputformat", "-workingdirectory",
    "-windowstyle", "-version", "-configurationname", "-psconsolefile",
    "-settingsfile", "-custompipename",
}
POWERSHELL_TERMINAL_OPTIONS = {"-file", "-encodedcommand", "-enc"}
POWERSHELL_COMMAND_FLAG_RE = re.compile(r"^-c(?:o(?:m(?:m(?:a(?:n(?:d)?)?)?)?)?)?(?:([\"':])(.*))?$", re.I)
CMD_SCRIPT_FLAG_RE = re.compile(r"^/+([ckr])(.*)$", re.I)


def _strip_edge_quotes(token):
    """Leading/trailing quote strip mirroring the TS per-token edge strip
    (`/^[\\'"]|[\\'"]$/g`): py's tokenizer keeps edge quotes on plain words
    (``DeleteServers"``), and the windows payload join must match the TS
    payload construction or glued-flag forms drift between layers."""
    return re.sub(r"^['\"]|['\"]$", "", token)


def _peel_glued_redirect(token):
    """Peel a trailing glued redirection (with its operand) off a token:
    `hcloud>out`, `OBS>&2`, and the INPUT forms `hcloud<f`, `hcloud<<EOF`
    (interrogate round 9 — bash runs `bin<file args…` as the bin with the
    full argv; the operand is stdin, never argv) — bash still runs the bin
    with the service."""
    t = re.sub(r">{1,2}[^>;&|\s]*$", "", str(token))
    t = re.sub(r"<{1,2}[^<>;&|\s]*$", "", t)
    return re.sub(r">&\d+$", "", t)


def _is_hcloud_head(token):
    """Dual raw+normalized hcloud bin predicate (mirrors the TS
    isHcloudToken): the RAW token is checked first so Windows
    drive-qualified (`C:\\hcloud.exe`) and drive-relative (`d:hcloud.exe`)
    bins keep their separators; quote-mangled paths strip quotes but KEEP
    backslashes; fully mangled spellings and the cmd `@` sigil fall
    through to the normalized check."""
    # Trailing shell-operator runs (`hcloud>`, `hcloud;`) and glued
    # redirect-with-operand (`hcloud>out`) attach to the bin in one
    # token — bash still runs the bin.
    raw = re.sub(r"^[$(<{&@.`]+", "", str(token).lower())
    raw = _peel_glued_redirect(re.sub(r"[>;&|]+$", "", raw))
    if (
        raw == "hcloud"
        or raw == "hcloud.exe"
        or raw.endswith("/hcloud")
        or raw.endswith("\\hcloud")
        or raw.endswith("/hcloud.exe")
        or raw.endswith("\\hcloud.exe")
        or re.match(r"^[a-z]:hcloud(\.exe)?$", raw)
    ):
        return True
    no_quotes = raw.replace("'", "").replace('"', "").replace("(", "").replace(")", "")
    if no_quotes != raw and (
        no_quotes.endswith("\\hcloud") or no_quotes.endswith("\\hcloud.exe") or re.match(r"^[a-z]:hcloud(\.exe)?$", no_quotes)
    ):
        return True
    # Fully normalized: the PowerShell call operator on a parenthesized
    # string literal (`&('hcloud')`, `.('hcloud')`) peels its wrapping
    # punctuation to the canonical bin.
    t = raw
    for ch in "'\"\\`$()":
        t = t.replace(ch, "")
    return t == "hcloud" or t == "hcloud.exe" or t.endswith("/hcloud")


def _windows_script_arg_at(tokens, idx):
    payload = _windows_script_arg_at_raw(tokens, idx)
    # cmd/PS glue braces to commands without whitespace (`try{hcloud …`,
    # `}finally{`); the POSIX vocabulary is word-exact, so braces are
    # spaced at the single extraction chokepoint every consumer shares —
    # but ONLY at command-grammar positions: `{` preceded by
    # start/whitespace/word-char/`)`/`}`, and `}` followed by a letter.
    # `={`/`:{`/`[`-glued and value-internal braces keep the token whole
    # so argv service/operation positions do not shift.
    if payload is None:
        return None
    payload = re.sub(r"(^|[\sA-Za-z0-9)}])\{", r"\1 { ", payload)
    return re.sub(r"\}(?=[A-Za-z])", "} ", payload)


def _windows_script_arg_at_raw(tokens, idx):
    """The command payload of a Windows script wrapper at idx, or None: cmd
    needs /c or /k (after any slash options), powershell needs -Command in
    any unambiguous abbreviation (after dash options; -File/-EncodedCommand
    are terminal — encoded payloads are a documented residual) or binds the
    first positional argument to -Command. Both shells take the ENTIRE
    remainder as the command — quoted, the payload is one token; unquoted,
    `cmd /c hcloud ECS ListServers` runs the whole line — so the remainder
    is joined, never truncated."""
    if idx >= len(tokens):
        return None
    head = str(tokens[idx])
    is_cmd = _matches_bin_name(head, WINDOWS_CMD_NAMES)
    is_ps = not is_cmd and _matches_bin_name(head, WINDOWS_PS_NAMES)
    if not is_cmd and not is_ps:
        return None

    def payload_at(j, glued=None):
        # The GLUED fragment keeps its edge-quote strip (carved from a
        # word token). The REST tokens join with plain spaces — a cmd /
        # powershell payload is a COMMAND LINE — and the joined payload's
        # `\"` pairs (span-internal escapes) are RESOLVED so the
        # re-tokenization regroups `\"hcloud …\"` into a proper span.
        if glued is not None:
            glued = _strip_edge_quotes(glued)

        def _resolve(x):
            return x.replace('\\"', '"').replace('\\\\', '\\')

        rest = [str(t) for t in tokens[j + 1:]]
        if glued is not None:
            return _resolve(glued + " " + " ".join(rest) if rest else glued)
        return _resolve(" ".join(rest)) if rest else None

    if is_cmd:
        j = idx + 1
        while j < len(tokens):
            tok = str(tokens[j]).lower()
            if not tok.startswith("/"):
                # Real cmd SKIPS non-switch junk before /c|/k (Wine and
                # ReactOS both scan past anything not starting with `/`) —
                # bailing here would launder `cmd foo /c hcloud <write>`;
                # junk is skipped.
                j += 1
                continue
            m = CMD_SCRIPT_FLAG_RE.match(str(tokens[j]))
            if m:
                return payload_at(j, m.group(2) or None)
            j += 1
        return None
    # PowerShell, pass 1: the -Command flag (or a terminal option) anywhere
    # after the head — option order is free, every earlier token is an
    # option or its value. The payload may be colon- or quote-glued to the
    # flag itself, captured from the ORIGINAL token (service names keep
    # case).
    for j in range(idx + 1, len(tokens)):
        tok = str(tokens[j]).lower()
        if tok in POWERSHELL_TERMINAL_OPTIONS:
            return None
        m = POWERSHELL_COMMAND_FLAG_RE.match(str(tokens[j]))
        if m:
            if m.group(2) is None:
                return payload_at(j)
            # An empty attached value (`-Command:` with nothing after the
            # colon) is the same real argv as the bare flag — PowerShell
            # treats the trailing arguments as the command — so it must
            # not bail the whole wrapper (`-Command:""` already denies).
            if not m.group(2):
                return payload_at(j)
            attached = _strip_edge_quotes(m.group(2))
            rest = [str(t) for t in tokens[j + 1:]]

            def _res(x):
                return x.replace('\\"', '"').replace('\\\\', '\\')

            return _res(attached + " " + " ".join(rest) if rest else attached)
    # Pass 2: no flag — the first positional argument IS the command
    # (powershell.exe binds position 0 to -Command). Known value-taking
    # options consume their value first.
    j = idx + 1
    while j < len(tokens):
        tok = str(tokens[j]).lower()
        if tok in POWERSHELL_TERMINAL_OPTIONS:
            return None
        if tok.startswith("-"):
            j += 1
            if tok in POWERSHELL_VALUE_OPTIONS and j < len(tokens) and not str(tokens[j]).lower().startswith("-"):
                j += 1
            continue
        return payload_at(j - 1)
    return None


def _is_script_command_head(tokens, idx):
    """A shell/eval token that actually heads a SCRIPT command (bash -c
    <script>, eval <script>) — the re-base target for the wrapper
    fallbacks. A bare `bash deploy.sh` (no -c) is NOT a script head."""
    s = str(tokens[idx]).lower()
    base = basename_of(s)
    shell_like = s in SHELL_FIRST or (base != s and base in SHELL_FIRST)
    if shell_like:
        flag = str(tokens[idx + 1]) if idx + 1 < len(tokens) else ""
        return bool(re.match(r"^-[a-z]*c$", flag, re.I)) and idx + 2 < len(tokens)
    if s == "eval" and idx + 1 < len(tokens):
        return True
    return _windows_script_arg_at(tokens, idx) is not None


def _grammar_child_at(tokens, start):
    """Where the wrapper's grammar model says the CHILD starts, judged from
    a value-slot: a token index (grammar child head — hcloud bin or script
    head reached through the wrapper's own flag grammar; the re-base
    composes the deny from there), -1 (a `--` separator is still reachable
    — the separator's child is authoritative and the walk continues), or
    -2 (the flag region ends at a non-child token — the slot re-base
    stands, fail closed). A script-head slot IS the child — handled by the
    caller, never here."""
    n = start
    while n < len(tokens):
        t = str(tokens[n])
        if t == "--":
            return -1
        if not t.startswith("-"):
            break
        if "=" not in t and t.lower() in SKQ_VALUE_FLAGS:
            n += 2
            continue
        n += 1
    if n >= len(tokens):
        return -1
    if _is_hcloud_bin(tokens[n]) or _is_script_command_head(tokens, n):
        return n
    return -2


def _unwrap_skill_quality(tokens):
    """Mirror of the TS unwrapSkillQualityCli: `skill-quality-cli run
    [flags] [--] <child>` — bare/path-qualified/.exe/.bin bins (quote
    mangled too), unknown -prefixed tokens skipped before `run`, the
    separator decision INSIDE the flag walk, and REMAINDER fallbacks to
    the first hcloud bin (with a following token) or script command head
    when the flag grammar is unknown. The wrapper must not launder the
    write gate."""
    for i in range(len(tokens) - 1):
        if not _matches_bin_name(tokens[i], SKQ_BIN_NAMES):
            continue
        j = i + 1
        while j < len(tokens) and str(tokens[j]).startswith("-"):
            j += 1
        if j >= len(tokens):
            continue
        if _normalize_bin_token(tokens[j]) != "run":
            # A non-flag token before `run`: different subcommand or an
            # unknown value flag's VALUE — fail closed only when a real
            # child follows the hcloud bin (a lone trailing hcloud token is
            # a subcommand argument, not a child).
            for idx in range(j + 1, len(tokens) - 1):
                if _is_hcloud_bin(tokens[idx]):
                    return tokens[idx:]
            continue
        k = j + 1
        while k < len(tokens):
            tok = str(tokens[k])
            if tok == "--":
                s = k + 1
                while s < len(tokens) and str(tokens[s]) == "--":
                    s += 1
                if s < len(tokens):
                    return tokens[s:]
                break
            if tok.startswith("-"):
                k += 1
                if "=" not in tok and tok.lower() in SKQ_VALUE_FLAGS and k < len(tokens):
                    # Wrapper-ambiguous value slot — worst-case parse
                    # controls: a script-head slot IS the child UNLESS the
                    # wrapper's `--` directly follows; an hcloud slot
                    # resolves through the grammar model.
                    slot_is_hcloud = _is_hcloud_bin(tokens[k])
                    slot_is_script = _is_script_command_head(tokens, k)
                    if (slot_is_hcloud or slot_is_script) and k + 1 < len(tokens):
                        if slot_is_script:
                            if str(tokens[k + 1]) != "--":
                                return tokens[k:]
                        else:
                            grammar_child = _grammar_child_at(tokens, k + 1)
                            if grammar_child == -2:
                                return tokens[k:]
                            if grammar_child >= 0:
                                return tokens[grammar_child:]
                    k += 1
                continue
            if _is_hcloud_bin(tok):
                return tokens[k:]
            for idx in range(k + 1, len(tokens) - 1):
                if _is_hcloud_bin(tokens[idx]):
                    return tokens[idx:]
            for idx in range(k + 1, len(tokens)):
                if _is_script_command_head(tokens, idx):
                    return tokens[idx:]
            # No hcloud bin or script head in the tail: the verbatim child.
            return tokens[k:]
    return None


def split_tokens(text):
    """Quote-aware tokenizer mirroring the TS ``splitSimpleCommand``: a
    quoted span becomes ONE token (quotes stripped from its content), so
    ``bash -c "hcloud ECS X"`` yields ``['bash','-c','hcloud ECS X']`` and
    the -c argument keeps its grouping. Double-quoted spans honor
    backslash escapes (``\\"`` nests quotes — the canonical bash way to
    embed a Windows wrapper); single-quoted spans do not (POSIX). Plain
    words strip a leading/trailing quote like the TS per-token edge
    replace, so the two tokenizers agree on mangled spellings.

    Line continuations are removed before scanning (interrogate round 4):
    bash drops the \\<newline> pair at parser level, and the word scan
    would otherwise split ``De\\<LF>leteServers`` into two tokens leaving
    the operation slot reading ``De\\``. Single-quoted spans keep the pair
    in real bash — over-stripping there only ever JOINS tokens
    (fail-closed toward classification, never hides one)."""
    text = re.sub(r"\\\n", "", text)
    tokens = []
    i, n = 0, len(text)
    while i < n:
        ch = text[i]
        if ch == "'":
            end = text.find(ch, i + 1)
            if end < 0:
                tokens.append(text[i + 1:])
                break
            tokens.append(text[i + 1:end])
            i = end + 1
        elif ch == '"':
            # Double-quoted span, escape-aware (`\"` nests quotes). The
            # closer is REQUIRED: an unterminated `"` falls back to a word
            # scan (mirroring the TS \S+ alternative).
            j = i + 1
            span = []
            closed = False
            while j < n:
                if text[j] == "\\" and j + 1 < n and text[j + 1] in ('"', "\\"):
                    span.append(text[j])
                    span.append(text[j + 1])
                    j += 2
                    continue
                if text[j] == '"':
                    closed = True
                    break
                span.append(text[j])
                j += 1
            if closed:
                tokens.append("".join(span))
                i = j + 1
            else:
                j = i
                while j < n and not text[j].isspace():
                    j += 1
                tokens.append(re.sub(r"^['\"]|['\"]$", "", text[i:j]))
                i = j
        elif ch.isspace():
            i += 1
        else:
            j = i
            while j < n and not text[j].isspace():
                j += 1
            tokens.append(re.sub(r"^['\"]|['\"]$", "", text[i:j]))
            i = j
    return tokens


def split_tokens_glued(text):
    """Bash-word-faithful tokenizer for the write gate's glued-bin fallback
    (interrogate round 9): adjacent quoted spans and word characters form
    ONE token — ``"hcl"oud ECS Delete`` is the single word ``hcloud`` to
    bash, with ``ECS``/``Delete`` as real argv — unlike split_tokens, which
    keeps the span/fragment distinction other consumers rely on (the
    windows-payload piece-split's quote-carrying refusal, the feeder
    expanders). Single-quoted spans keep their literal backslashes; double-
    quoted spans resolve \\" and \\\\ pairs; unterminated spans run to the
    end; \\<newline> continuations drop first (bash's own first pass).
    Word separators are the EXACT JS /\\s/ set (interrogate round 10):
    str.isspace() also splits on \\x85 and \\x1c-\\x1f, which JS does not
    and bash does not treat as IFS — the round-9 tokenizer re-chose the
    language-native class after the strip-set lesson and drifted the twins
    on those (fail-closed over-deny, non-executable shapes). Mirrored by
    splitSimpleCommandGlued in src/safety/shell-text.ts — the tokenizer
    twin corpus pins the shared outputs."""
    text = re.sub(r"\\\n", "", text)
    tokens = []
    cur = []

    def _flush():
        if cur:
            tokens.append("".join(cur))
            del cur[:]

    i, n = 0, len(text)
    while i < n:
        ch = text[i]
        if ch == "'":
            end = text.find(ch, i + 1)
            if end < 0:
                cur.append(text[i + 1:])
                i = n
                continue
            cur.append(text[i + 1:end])
            i = end + 1
            continue
        if ch == '"':
            j = i + 1
            closed = False
            while j < n:
                if text[j] == "\\" and j + 1 < n and text[j + 1] in ('"', "\\"):
                    cur.append(text[j])
                    cur.append(text[j + 1])
                    j += 2
                    continue
                if text[j] == '"':
                    closed = True
                    break
                cur.append(text[j])
                j += 1
            i = n if j >= n and not closed else j + 1
            continue
        if JS_WHITESPACE_RE.match(ch):
            _flush()
            i += 1
            continue
        cur.append(ch)
        i += 1
    _flush()
    return tokens


def _skip_prefix_args(prefix, tokens):
    """Mirror of the TS skipPrefixArguments: strip the prefix's flag region
    (dash flags, durations, start/call slash flags) honoring the
    per-prefix value-flag grammar."""
    value_flags = PREFIX_FLAGS_WITH_VALUE.get(prefix, set())
    rest = tokens
    while rest and (
        rest[0].startswith("-")
        or re.match(r"^\d*\.?\d+[smh]?$", rest[0], re.I)
        or (prefix in ("start", "call") and rest[0].startswith("/"))
    ):
        # Round 19 F1b: the value-flag comparison strips quote-mangling.
        flag = re.sub(r"['\"\\$]", "", str(rest[0]))
        rest = rest[1:]
        if "=" not in flag and flag in value_flags and rest:
            rest = rest[1:]
    return rest


def _hcloud_piece_at(tokens, i):
    """cmd/PS payload words glue shell separators to the bin (`x&&hcloud`,
    `ListServers}catch{hcloud`): split candidate tokens on separator runs
    before the head checks, re-basing to the piece bin + the pieces and
    tokens that follow. Tokens carrying quote characters are NOT split —
    their separators are quote-protected argument VALUES
    (`--description='a;hcloud;DeleteServers'`), not live command sites.
    Returns the re-based stream or None."""
    tok = str(tokens[i])
    if _is_hcloud_head(tok):
        stream = [str(t) for t in tokens[i:]]
    else:
        if re.search(r"['\"]", tok):
            return None
        pieces = [p for p in re.split(r"[;&|]+", tok) if p]
        at = -1
        for k, p in enumerate(pieces):
            if _is_hcloud_head(p):
                at = k
                break
        if at < 0:
            return None
        stream = pieces[at:] + [str(t) for t in tokens[i + 1:]]
    # Drop pure-closer tokens that follow the bin (`.( 'hcloud' )`
    # tokenizes the `)` standalone) — they would occupy the service slot
    # and mask the operation behind them.
    k = 1
    while k < len(stream) and re.match(r"^[)\]}]+$", stream[k]):
        k += 1
    return stream[:1] + stream[k:]


def hcloud_leading_segment(tokens):
    """Strip command-position prefixes (shell -c, sudo/env/xargs/do/then,
    the PS/cmd control vocabulary, VAR= assignments) and report the token
    list when its command token is hcloud (any path-qualified /
    quote-mangled / @-sigil spelling), else None. The windows-payload
    context is recorded in _LEADING_WINDOWS_PAYLOAD for the caller that
    needs it (the later-bin scan in hcloud_write_blocked)."""
    result = _leading_segment_core(tokens)
    _LEADING_WINDOWS_PAYLOAD[0] = result[1]
    return result[0]


# Scratch slot for the windows-payload context of the last
# hcloud_leading_segment call (single-threaded hook process).
_LEADING_WINDOWS_PAYLOAD = [False]


def _leading_segment_core(tokens):
    """(leading token list or None, entered-windows-payload flag)."""
    in_windows_payload = False
    # Env assignments strip UNBOUNDED before the loop (interrogate round
    # 13: `X1=1 … X19=1 hcloud …` executes — assignments are linear, no
    # nesting, so no budget is charged).
    while tokens and re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", str(tokens[0])):
        tokens = tokens[1:]
    for _ in range(18):
        if not tokens:
            return None, in_windows_payload
        first = tokens[0].lower()
        # `-c`, `-lc`, `-xc` … any option cluster ending in c takes the
        # script; the script argument's `\"` pairs are span-internal
        # escapes, resolved HERE (consumption point). When the script is
        # ITSELF a wrapper head (`bash -c bash -c '…'` — the flattened
        # join of the real `bash -c "bash -c '…'"` nesting), the tail
        # tokens are concatenated and unwrapping continues (fail-closed).
        if first in SHELL_FIRST and len(tokens) > 2 and re.match(r"^-[a-z]*c$", tokens[1], re.I):
            script_tokens = split_tokens(str(tokens[2]).replace('\\"', '"').replace('\\\\', '\\'))
            script_head = str(script_tokens[0] or "").lower() if script_tokens else ""
            head_is_wrapperish = (
                script_head in SHELL_FIRST
                or script_head == "eval"
                or script_head in COMMAND_PREFIXES
                or _windows_script_arg_at(script_tokens, 0) is not None
                or (script_tokens and _is_hcloud_head(script_tokens[0]))
            )
            if head_is_wrapperish:
                tokens = script_tokens + [str(t) for t in tokens[3:]]
                continue
            tokens = script_tokens
            continue
        # Real eval CONCATENATES all its arguments and evaluates the
        # joined string, so the remaining arguments are always part of the
        # command (an unquoted `eval cmd /c "hcloud …"` runs the write).
        if first == "eval" and len(tokens) > 1:
            script_tokens = split_tokens(str(tokens[1]).replace('\\"', '"').replace('\\\\', '\\'))
            tokens = script_tokens + [str(t) for t in tokens[2:]]
            continue
        # bash/PS function definitions: the NAME follows the keyword before
        # the body (`function f { hcloud … }`) — strip keyword + name.
        if first in ("function", "filter") and len(tokens) > 2:
            tokens = tokens[2:]
            continue
        win_script = _windows_script_arg_at(tokens, 0)
        if win_script is not None:
            tokens = split_tokens(win_script)
            in_windows_payload = True
            continue
        if is_redirection_token(tokens[0]):
            tokens = tokens[1:]
            continue
        # Round 19 F3/F4: the prefix comparison strips quote-mangling.
        _nf = re.sub(r"['\"\\$]", "", first)
        _nb = re.sub(r"['\"\\$]", "", basename_of(tokens[0].lower()))
        if _nf in COMMAND_PREFIXES or _nb in COMMAND_PREFIXES:
            prefix = _nf if _nf in COMMAND_PREFIXES else _nb
            # Locator carve-out: `where hcloud`, `if exist hcloud` probe
            # the bin's PRESENCE (cmd builtins) — a bare bin with no argv
            # is the probe shape, not a command; stripping the locator
            # would hit the empty-args fail-closed and deny a read-only
            # lookup.
            if prefix in ("where", "exist", "defined") and len(tokens) == 2 and _is_hcloud_head(tokens[1]):
                break
            if prefix == "start":
                # cmd.exe's `start` consumes an optional quoted TITLE before
                # the child (`start "t" hcloud …`); quoting is lost in the
                # token stream, so when the token after start's flags is
                # not itself a command head and the one after it is, the
                # title is skipped (fail-closed toward the child).
                probe = _skip_prefix_args("start", tokens[1:])
                if len(probe) > 1:
                    def _is_headish(cand_tokens, at):
                        tok = str(cand_tokens[at]).lower()
                        return (
                            _is_hcloud_head(cand_tokens[at])
                            or _windows_script_arg_at(cand_tokens, at) is not None
                            or tok in COMMAND_PREFIXES
                            or tok in SHELL_FIRST
                            or tok == "eval"
                        )
                    if not _is_headish(probe, 0) and _is_headish(probe, 1):
                        tokens = probe[1:]
                        continue
            # The (lowercased) basename resolves the prefix key for the
            # value-flag grammar too: a path-qualified `/usr/bin/sudo -u
            # root hcloud …` must consult sudo's value flags.
            tokens = _skip_prefix_args(prefix, tokens[1:])
            continue
        if re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", tokens[0]):
            tokens = tokens[1:]
            continue
        child = _unwrap_secret_exec(tokens)
        if child is not None:
            tokens = child
            continue
        child = _unwrap_skill_quality(tokens)
        if child is not None:
            tokens = child
            continue
        if in_windows_payload and not _is_hcloud_head(tokens[0]):
            rebased = None
            for i in range(1, len(tokens)):
                piece_stream = _hcloud_piece_at(tokens, i)
                if piece_stream is not None and len(piece_stream) > 1:
                    rebased = piece_stream
                    break
            if rebased is not None:
                tokens = rebased
                continue
        break
    if not tokens:
        return None, in_windows_payload
    if _is_hcloud_head(tokens[0]):
        return tokens, in_windows_payload
    return None, in_windows_payload


def _is_windows_path_word(current):
    """A word that began as a Windows drive prefix (`X:` or `X:\\…`): every
    backslash inside it is a path separator, never a POSIX escape. The
    opening quote is stripped so the check works inside quoted spans."""
    last_word = current.rsplit(" ", 1)[-1]
    if last_word[:1] in ("'", '"'):
        last_word = last_word[1:]
    return bool(re.match(r"^[A-Za-z]:[\\/]", last_word) or re.match(r"^[A-Za-z]:$", last_word))


def split_shell_segments(text, seps_out=None):
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
                    if seps_out is not None:
                        seps_out.append("\n")
                    current = ""
                heredoc_line = ""
            else:
                heredoc_line += ch
            i += 1
            continue
        if quote is not None:
            if ch == "\\" and i + 1 < n:
                # Backslash escapes the next char — BOTH chars stay in the
                # segment (the downstream escape-aware tokenizer can regroup
                # the span, `bash -c "cmd /c \"hcloud …\""`), EXCEPT the
                # line continuation: bash removes the \<newline> PAIR at
                # parser level inside double quotes too (interrogate round
                # 4: `hcloud ECS "De\<LF>leteServers"` hid the operation
                # from every shadow); the single-quote span keeps the pair
                # (literal there).
                if quote == '"' and text[i + 1] == "\n":
                    i += 2
                    continue
                current += ch
                current += text[i + 1]
                i += 2
                continue
            current += ch
            if ch == quote:
                quote = None
            i += 1
            continue
        if ch == "\\" and i + 1 < n:
            # Same drive-path preservation as the quoted branch — and the
            # line-continuation drop: bash removes the \<newline> PAIR, so
            # the newline is dropped entirely (interrogate round 4:
            # `h\<LF>cloud` hid the bin from every shadow — routing, vocab,
            # and decode all saw a newline inside the token).
            if text[i + 1] == "\n":
                i += 2
                continue
            current += (ch if _is_windows_path_word(current) else "") + text[i + 1]
            i += 2
            continue
        if ch in "\"'":
            quote = ch
            current += ch
            i += 1
            continue
        if ch == "$" and i + 1 < n and text[i + 1] == "(":
            segments.append(current)
            if seps_out is not None:
                seps_out.append("$(")
            current = ""
            i += 2
            continue
        if ch == "<" and i + 1 < n and text[i + 1] == "(":
            segments.append(current)
            if seps_out is not None:
                seps_out.append("<(")
            current = ""
            i += 2
            continue
        if ch == ">" and i + 1 < n and text[i + 1] == "(":
            segments.append(current)
            if seps_out is not None:
                seps_out.append(">(")
            current = ""
            i += 2
            continue
        if ch == "`":
            segments.append(current)
            if seps_out is not None:
                seps_out.append("`")
            current = ""
            i += 1
            continue
        if ch in ";&|\n\r)":
            # `&` directly after `>`/`<` is the redirection-dup operator
            # (`2>&1`, `<&0`) — part of the redirection token, not a
            # separator (interrogate round 11: `2>&1 bash -c '…'` split
            # mid-redirection and the script never reached _script_of).
            if ch == "&" and i > 0 and text[i - 1] in "><":
                current += ch
                i += 1
                continue
            if ch == "\n" and pending_heredoc is not None:
                heredoc_delim = pending_heredoc
                pending_heredoc = None
                heredoc_line = ""
                current += ch
                i += 1
                continue
            segments.append(current)
            if seps_out is not None:
                seps_out.append(ch)
            current = ""
            i += 1
            continue
        if ch == "<" and i + 1 < n and text[i + 1] == "<":
            prev = text[i - 1] if i > 0 else ""
            at_word_start = i == 0 or prev.isspace() or prev in ";&|\n\r)\"'" or prev.isdigit()
            if at_word_start:
                j = i + 2
                saw_dash = False
                while j < n and text[j] == "-":
                    saw_dash = True
                    j += 1
                # bash allows whitespace between the operator and the
                # delimiter (`<< EOF`).
                while j < n and text[j] in " \t":
                    j += 1
                delim_quote = ""
                if j < n and text[j] in "\"'":
                    delim_quote = text[j]
                    j += 1
                # A backslash-escaped delimiter (`<<\EOF`) and a
                # `$`-prefixed one (`<<$EOF`, `<<${EOF}`) open heredocs
                # too — the escaped/expanded word is the delimiter bash
                # waits for; fail-closed, the raw word serves.
                delim = ""
                if j < n and text[j] == "\\":
                    j += 1
                    k2 = j
                    while k2 < n and re.match(r"[A-Za-z0-9_]", text[k2]):
                        k2 += 1
                    delim = text[j:k2] or "\\"
                    j = k2
                elif j < n and text[j] == "$":
                    delim = "$"
                    j += 1
                    if j < n and text[j] == "{":
                        delim += "{"
                        j += 1
                    k2 = j
                    while k2 < n and re.match(r"[A-Za-z0-9_]", text[k2]):
                        k2 += 1
                    delim += text[j:k2]
                    j = k2
                    if delim.endswith("{"):
                        if j < n and text[j] == "}":
                            delim += "}"
                            j += 1
                        else:
                            delim = ""
                else:
                    k2 = j
                    while k2 < n and re.match(r"[A-Za-z0-9_]", text[k2]):
                        k2 += 1
                    delim = text[j:k2]
                    j = k2
                    if not delim and j < n and text[j] not in " \t\"'":
                        # A punctuation-leading delimiter (`<< -EOF`,
                        # `<< .D`) — bash's delimiter is the entire
                        # following word; fail-closed, the raw word serves.
                        k2 = j
                        while k2 < n and text[k2] not in " \t\"'":
                            k2 += 1
                        delim = text[j:k2]
                        j = k2
                if not delim and (delim_quote or saw_dash):
                    # An empty quoted (`<< ""`) or dash-only (`<< -`)
                    # delimiter — never matches a body line: a fail-closed
                    # sentinel delimiter.
                    delim = "\x00heredoc-sentinel"
                if delim and (delim_quote == "" or (j < n and text[j] == delim_quote)):
                    # Render the marker and align i to the scan position
                    # (the spaced forms double-consumed the last delimiter
                    # char).
                    current += "<<"
                    k3 = i + 2
                    while k3 < n and text[k3] == "-":
                        current += "-"
                        k3 += 1
                    if delim_quote:
                        quote = delim_quote
                        current += delim_quote
                    current += delim
                    i = j
                    pending_heredoc = delim
                    continue
        current += ch
        i += 1
    segments.append(current)
    if seps_out is None:
        return [s.strip() for s in segments if s.strip()]
    seps_out.append("")
    kept = []
    kept_seps = []
    for i, seg in enumerate(segments):
        t = seg.strip()
        if t:
            kept.append(t)
            kept_seps.append(seps_out[i] if i < len(seps_out) else "")
    seps_out[:] = kept_seps
    return kept


# TS routing parity: classification (and its empty-args fail-closed)
# engages only when the shadow text carries `hcloud` followed by more
# input — a bare trailing `hcloud` mention never classifies. The bin's
# TAIL accepts closers (`&('hcloud')`, `(hcloud)`) as well as whitespace.
# The RAW text is tested too (TS parity): the shadow strips quotes and
# backslashes, which glues the bin into the preceding word
# (`cmd /c"hcloud …`, `C:\hcloud.exe …`) while the raw text still
# carries the boundary character itself.
HCLOUD_ROUTE_RE = re.compile(r"(^|[^a-z0-9.-])hcloud(\.exe)?[\s)\]}'\"<]", re.I)
# The BROAD routing tail (the TS broadRouted twin, interrogate round 8): also
# `;`, `&`, `|`, `>`, and end-of-string, so `xargs hcloud` at EOF and
# glued-separator bins route for the over-cap latency guard below.
HCLOUD_ROUTE_BROAD_RE = re.compile(r"(^|[^a-z0-9.-])hcloud(\.exe)?([\s)\]}'\";&|<>]|$)", re.I)

WRITE_BLOCK_REASON = (
    "unapproved Huawei Cloud write operations must be planned first and explicitly approved by the user."
)
EMPTY_ARGS_REASON = (
    "empty hcloud command arguments are not executable (malformed or truncated payload); write the command in plain form."
)


def _stripped_write_deny(stripped, argv):
    """Write-gate vocabulary for one hcloud-leading token stream: local
    help/version exemption, configure/OBS util subcommands, then the
    write/read prefix test on the quote-stripped operation. Dash tokens
    are filtered BEFORE the operation slot (TS commandOperation's
    nonFlags parity) — a flag between the service and the feeder word
    must not mask the operation."""
    if any(t.lower() in ("--help", "-h", "help", "version", "--version") for t in stripped[1:]):
        return False
    if not argv:
        return False
    non_flags = [_peel_glued_redirect(t) for t in argv if not str(t).startswith("-")]
    service = strip_shell_quotes(non_flags[0] if non_flags else argv[0])
    operation = strip_shell_quotes(non_flags[1]) if len(non_flags) > 1 else service
    if service.lower() == "configure" and BLOCKED_CONFIGURE_SUBCOMMANDS and operation.lower() in BLOCKED_CONFIGURE_SUBCOMMANDS:
        return True
    if service.lower() == "obs" and operation.lower() in OBSUTIL_WRITES:
        return True
    # The read exemption anchors at the operation token's START via
    # re.match (interrogate round 1 — TS hasReadPrefix's ^prefix parity;
    # \b at position 0 is equivalent): a write-prefixed operation with an
    # embedded read word (`Update-Show-x`) is the write it is on both
    # layers. An unavailable read vocabulary cannot prove a read — the
    # exemption does not apply (fail-closed, the empty-read-list parity:
    # TS hasReadPrefix over [] is always false).
    return bool(
        WRITE_OPERATION_RE.search(operation)
        and (READ_OPERATION_RE is None or not READ_OPERATION_RE.match(operation))
    )


def _classify_leading(stripped, argv, routed):
    """Verdict reason (or None) for one hcloud-leading token stream: the
    empty-args fail-closed (an unwrapped stream that is JUST the bin with
    no argv — e.g. `bash -c hcloud ECS Delete`, where real bash runs bare
    `hcloud` — is not an executable read; the argv is POST-merge so an
    `xargs hcloud` segment fed by a pipe classifies its feeder instead of
    denying; gated on routing so a bare trailing `hcloud` mention stays
    allowed), then the write-gate vocabulary."""
    if routed and len(stripped) == 1 and not argv:
        return EMPTY_ARGS_REASON
    return WRITE_BLOCK_REASON if _stripped_write_deny(stripped, argv) else None


def _heredoc_script_text(segment):
    """The body of a heredoc/herestring a SHELL bin reads as its script
    (interrogate round 11: `bash <<EOF\\n"hcl"oud ECS Delete\\nEOF` executes
    the body — the -c machinery never fires without the flag). Round 12
    completions: the head's FIRST word (after optional redirections) must
    be the shell bin — flags and stdin-redirects may sit between it and
    the marker (`bash -s <<EOF`, `bash < in <<EOF`), and an
    argument-position shell word (`echo sh <<EOF`) does NOT make the body
    a script; the marker line may carry trailing live text (`bash <<EOF
    2>/dev/null`, `bash <<EOF; echo hi`); the delimiter may be
    double-quoted. Mirrored by heredocScriptText in classify-text.ts."""
    m = re.search(r"<<<?", segment)
    if m is None:
        return None
    # Round 15 C-A: prefixes/env assignments/redirections may sit before
    # the shell head (`env bash <<EOF`, `X=1 bash <<EOF`, `timeout 5 bash
    # <<EOF`, `< in bash <<EOF`) — strip them with the walk's own probe
    # grammar (prefix + value-flag aware; a greedy regex ate the shell word
    # as a prefix argument). The head's first non-strippable word must be
    # the shell bin; an argument-position shell word (`echo sh <<EOF`)
    # does not make the body a script.
    head_probe = split_tokens(segment[: m.start()])
    for _ in range(18):
        if not head_probe:
            break
        head_tok = str(head_probe[0])
        if is_redirection_token(head_tok):
            # A BARE operator carries its operand as the NEXT token.
            head_probe = head_probe[2:] if re.match(r"^[<>]&?$", head_tok) else head_probe[1:]
            continue
        if re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", head_tok):
            head_probe = head_probe[1:]
            continue
        # Round 19 F2: the prefix comparison strips quote-mangling.
        head_lower = re.sub(r"['\"\\$]", "", head_tok.lower())
        head_base = basename_of(head_lower)
        if head_lower in COMMAND_PREFIXES or head_base in COMMAND_PREFIXES:
            head_probe = _skip_prefix_args(head_base or head_lower, head_probe[1:])
            continue
        break
    # Round 16 C1: closed-quote mid-token mangling (`ba'sh'`) — strip
    # quotes/backslashes/dollars from the head word before matching.
    if not head_probe or not re.match(
        r"^(bash|sh|zsh|dash)(\.exe)?$",
        re.sub(r"['\"\\$]", "", basename_of(str(head_probe[0]).lower())),
    ):
        return None
    rest = segment[m.start():]
    hs = re.match(r"^<<<\s*(.+)$", rest)
    if hs:
        # The herestring word is ONE argv-ish blob bash parses as a script:
        # strip the edge quotes so the walk's tokenizers see the command.
        return re.sub(r"^['\"]|['\"]$", "", hs.group(1))
    mm = re.match(r"^<<-?\s*(['\"]?)([A-Za-z0-9_]+)\1?[^\n]*\n", rest)
    if not mm:
        return None
    delim = mm.group(2)
    body = rest[mm.end():]
    end = body.find("\n" + delim)
    return body if end < 0 else body[:end]


def _interpreter_system_commands(code):
    """The shell command(s) embedded in interpreter code via system("…") /
    os.system('…') (interrogate rounds 12-13) — ALL matches at STATEMENT
    position (preceded by start/;/newline/} — ``print("system('…')")`` is
    a printed string, not a call), joined with ';' so the walk classifies
    each as its own segment. Direct-string form only; variable
    indirection and other invocation APIs are the documented residual —
    for those, the deny-opaque gate is the closure. Mirrored by
    interpreterSystemCommands in classify-text.ts."""
    commands = []
    for m in re.finditer(r"(?:^|[;\n}])\s*(?:os\.)?system\(\s*(['\"])([\s\S]*?)\1\s*\)", code):
        commands.append(m.group(2))
    return ";\n".join(commands) if commands else None


def _normalize_flag_token(token):
    """Round 16 C4: closed-quote-mangled code flags (`-'c'`) — strip
    quotes/backslashes/dollars from a flag token before the code-flag
    class tests (the word-gluing doctrine). Mirrored by
    normalizeFlagToken in classify-text.ts."""
    return re.sub(r"['\"\\$]", "", str(token))


def _interpreter_head_of(head):
    """Interpreter head normalization (interrogate round 13): basename +
    version-suffix collapse — python3.11 -> python, gawk/mawk/nawk -> awk,
    perl5 -> perl, nodejs -> node, raku -> ruby. Mirrored by
    interpreterHeadOf in classify-text.ts."""
    # Round 15 C-B: closed-quote mangling (`pyth'on3'`) — strip quotes,
    # backslashes, and dollars before matching (the round-9 word-gluing
    # doctrine).
    h = re.sub(r"[\d.]+$", "", re.sub(r"['\"\\$]", "", str(head).lower()))
    if re.match(r"^(python|pypy)$", h):
        return "python"
    if h == "perl":
        return "perl"
    if re.match(r"^(ruby|raku)$", h):
        return "ruby"
    if h == "node":
        return "node"
    if re.match(r"^(awk|gawk|mawk|nawk)$", h):
        return "awk"
    return None


OPAQUE_BINS = (
    "hcloud",
    "hcloud.exe",
    "huaweicloud-devkit",
    "setup-cli.js",
    "setup-cli.mjs",
    "setup-cli.ts",
    "setup-cli.cjs",
    "setup.cjs",
)


def _opaque_word_in(text, bin_name):
    return re.search(r"(^|[^a-z0-9.-])" + re.escape(bin_name) + r"([^a-z0-9.-]|$)", text, re.I) is not None


def _leading_segment_probe(tokens):
    """The effective head stream after stripping redirections, env
    assignments, and command-position prefixes (a light probe — NOT
    _leading_segment_core, which returns None unless the head is hcloud).
    Round 14's shared shape for the interpreter-code checks."""
    probe = list(tokens)
    for _ in range(18):
        if not probe:
            break
        head_tok = str(probe[0])
        if is_redirection_token(head_tok) or re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", head_tok):
            probe = probe[1:]
            continue
        # Round 19 F4: the prefix comparison strips quote-mangling.
        head_lower = re.sub(r"['\"\\$]", "", head_tok.lower())
        head_base = basename_of(head_lower)
        if head_lower in COMMAND_PREFIXES or head_base in COMMAND_PREFIXES:
            probe = _skip_prefix_args(head_base or head_lower, probe[1:])
            continue
        break
    return probe, None


def _opaque_carrier_denied(segment, tokens, whole_text):
    """The DENY-OPAQUE pivot (interrogate round 13, the coordinator's design
    boundary): enumerating bash's carrier grammar to SEE THROUGH it is
    non-convergent — the carrier space is unbounded. When the walk hits a
    context it cannot fully traverse AND one of OUR tokens appears in the
    line in any walkable form, deny fail-closed with the sanctioned-paths
    remediation instead of vision. The three opacity signals: (a) FRAGMENTED
    token (a glued/decoded re-join reveals the bin the raw segment hides),
    (b) EXPANSION marker ($'/$"/$(/backtick/<(>( anywhere in the payload),
    (c) INTERPRETER CODE context (a code-flag argument / awk program).
    Lines with no token stay allowed; plain contiguous tokens inside plain
    quoting with no markers stay allowed (prose). Mirrored by
    opaqueCarrierDenied in classify-text.ts."""
    glued = " ".join(split_tokens_glued(segment))
    decoded = strip_shell_quotes(decode_ansi_c_spans(segment))
    # Presence is CONTIGUOUS-includes (round 14 C1: `${X:-hcloud}` — the
    # wordIn boundary excludes `-`, so the default-expanded token was
    # invisible; the coordinator's rule is "appears ANYWHERE in the line").
    present = [
        b
        for b in OPAQUE_BINS
        if b.lower() in segment.lower() or _opaque_word_in(glued, b) or _opaque_word_in(decoded, b)
    ]
    if not present:
        return None
    fragmented = any(
        (_opaque_word_in(glued, b) or _opaque_word_in(decoded, b)) and b.lower() not in segment.lower()
        for b in present
    )
    # Round 14 (C1): ${ parameter expansion joins the marker set.
    marker = re.search(r"\$['\"]|\$\(|\$\{|`|<\(|>\(", whole_text) is not None
    code_context = False
    # The effective head: strip redirections/env/prefixes (a light
    # probe — NOT _leading_segment_core, which returns None unless the
    # head is hcloud itself).
    probe = list(tokens)
    for _ in range(18):
        if not probe:
            break
        head_tok = str(probe[0])
        if is_redirection_token(head_tok) or re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", head_tok):
            probe = probe[1:]
            continue
        # Round 19 F4: the prefix comparison strips quote-mangling.
        head_lower = re.sub(r"['\"\\$]", "", head_tok.lower())
        head_base = basename_of(head_lower)
        if head_lower in COMMAND_PREFIXES or head_base in COMMAND_PREFIXES:
            probe = _skip_prefix_args(head_base or head_lower, probe[1:])
            continue
        break
    head = _interpreter_head_of(basename_of(str(probe[0]).lower())) if probe else None
    if head is not None:
        rest = [str(t) for t in probe[1:]]
        if head == "awk":
            code_context = any(not t.startswith("-") for t in rest) or "-v" in rest or "-f" in rest
        else:
            # Round 14 C4: a stdin heredoc (`python3 <<'EOF' … body … EOF`)
            # is code context too — the body is interpreter code.
            code_context = (
                any(
                    (lambda f: re.match(r"^-[a-z]*c[a-z]*$", f, re.I) if head == "python" else (re.match(r"^-[a-z]*e[a-z]*$", f, re.I) or f == "--eval"))(_normalize_flag_token(t))
                    for t in rest
                )
                or re.search(r"<<<?", segment) is not None
            )
    if not fragmented and not marker and not code_context:
        return None
    return (
        "an opaque command carrier (script/interpreter/exec context) mentions Huawei Cloud "
        "commands but cannot be safely classified. Write the command in plain form, or use "
        "the sanctioned MCP paths (huaweicloud_run_readonly_command for reads / "
        "huaweicloud_run_approved_command for writes)."
    )


def _script_of(tokens):
    """The quoted script argument of a shell -c / eval / Windows script
    wrapper (cmd /c, powershell -Command) token stream, or None."""
    if not tokens:
        return None
    first = tokens[0].lower()
    base = basename_of(tokens[0]).lower()
    shell_like = first in SHELL_FIRST or (base != first and base in SHELL_FIRST)
    if shell_like:
        # Flags may precede -c (interrogate round 12: `bash -e -c '…'`
        # executes the script) — skip non-c flag clusters, then require
        # the c-cluster.
        i = 1
        while i < len(tokens):
            tok = _normalize_flag_token(tokens[i])
            if re.match(r"^--[a-z-]+$", tok, re.I):
                i += 1
                continue
            # Value-bearing flags FIRST (o is inside [a-bd-z] — the generic
            # skip must not eat their values): -o pipefail -> skip 2.
            if re.match(r"^-o$", tok, re.I) or re.match(r"^--option$", tok, re.I):
                i += 2
                continue
            if re.match(r"^-[a-bd-z]+$", tok, re.I):
                i += 1
                continue
            break
        if i + 1 < len(tokens) and re.match(r"^-[a-z]*c[a-z]*$", _normalize_flag_token(tokens[i]), re.I):
            script = str(tokens[i + 1]).replace('\\"', '"').replace('\\\\', '\\')
            # When the script word is ITSELF a bin or wrapper head (the
            # flattened join of a quoted original), the tail tokens belong
            # to the same command: return them joined, or the nested scan
            # sees a bare bin and hits the empty-args guard on a
            # legitimate read.
            head_tok = split_tokens(script)[0] if split_tokens(script) else None
            head_is_commandish = (
                head_tok is not None
                and (
                    _is_hcloud_head(head_tok)
                    or str(head_tok).lower() in SHELL_FIRST
                    or str(head_tok).lower() == "eval"
                    or str(head_tok).lower() in COMMAND_PREFIXES
                )
            )
            if head_is_commandish and i + 2 < len(tokens):
                return " ".join([script] + [str(t) for t in tokens[i + 2:]])
            return script
    # eval evaluates the JOIN of all its arguments — the script string
    # is the whole tail, not just the first word.
    if first == "eval" and len(tokens) > 1:
        return " ".join(str(t).replace('\\"', '"').replace('\\\\', '\\') for t in tokens[1:])
    # watch runs its command arguments as an sh -c SCRIPT (the join of the
    # words after its own flags — interrogate round 11: `watch -n1
    # '"hcl"oud ECS Delete'` executes the glued bin through that join).
    # Round 17 C3: the watch head strips quote-mangling (`wat'ch'`).
    if re.sub(r"['\"\\$]", "", first) == "watch" and len(tokens) > 1:
        rest = _skip_prefix_args("watch", tokens[1:])
        return " ".join(str(t) for t in rest)
    # Interpreter carriers (interrogate rounds 12-13): the head is
    # NORMALIZED (_interpreter_head_of — version-suffix collapse, awk
    # family), benign flags before the code flag are skipped, awk's -v/-f
    # value flags are skipped, and the flag table is per-interpreter
    # (perl/ruby/node: -e only — their -c is syntax-check; python: -c).
    interp = _interpreter_head_of(first)
    if interp is not None and len(tokens) > 1:
        i = 1
        while i < len(tokens) and re.match(r"^-[a-bd-z][a-z]*$", _normalize_flag_token(tokens[i]), re.I):
            i += 1
        flag = _normalize_flag_token(tokens[i]) if i < len(tokens) else ""
        code_flag = (
            re.match(r"^-[a-z]*c[a-z]*$", flag, re.I)
            if interp == "python"
            else (re.match(r"^-[a-z]*e[a-z]*$", flag, re.I) or flag == "--eval")
        )
        if code_flag and i + 1 < len(tokens):
            return _interpreter_system_commands(" ".join(str(t) for t in tokens[i + 1:]))
        if interp == "awk":
            j = 1
            while j < len(tokens):
                tok = str(tokens[j])
                if tok in ("-v", "-f", "--file", "--assign"):
                    j += 2
                    continue
                if re.match(r"^-[a-z]+$", tok, re.I):
                    j += 1
                    continue
                break
            if j < len(tokens):
                return _interpreter_system_commands(str(tokens[j]))
    return _windows_script_arg_at(tokens, 0)


def hcloud_write_blocked(text, depth=0, routed=None, inherited_feeder=None, saw=None):
    """Block reason (or None to allow) when any hcloud-leading command
    segment in the payload carries a write operation and no read prefix.
    `saw` (a one-element list) accumulates whether ANY level of the walk
    ever saw our bin at a classifiable command position — the deny-opaque
    gate's traversal signal (interrogate round 13).
    Positional like the TS layer; nested `bash -c`/`eval` scripts re-scan
    recursively with the TOP-LEVEL routing verdict threaded through (TS
    computes routing once at text entry); `xargs hcloud` merges the
    preceding piped segment's tokens as candidate operations; OBS util
    subcommands classify through the same write list; `hcloud configure
    show/get/list/…` is a credential read (policy vocabulary, TS parity)."""
    if saw is None:
        saw = [False]
    if not WRITE_OPERATION_RE:
        # Fail-closed (interrogate round 1): an unavailable write
        # vocabulary must not reopen PLAIN writes while their mangled
        # forms still deny through the obfuscation gate — an incoherent
        # posture where only the honest spelling sails through.
        # Invocation-scoped (interrogate rounds 2-3): the leading-segment
        # walk runs UNCONDITIONALLY — the narrow routing tail
        # ([\s)\]}'\"]) missed `xargs hcloud;|>&&&` tails (round 3), and
        # the walk itself is the scope (prose never yields a leading
        # segment). Prose that merely MENTIONS hcloud stays allowed; a
        # corrupt policy.json must not block every Bash command that names
        # the CLI. hcloud-leading invocations all deny, reads and --help
        # included: with no vocabulary there is nothing to prove safety
        # with (the recorded trade). The length cap mirrors the healthy
        # gate's (no routing to scope it — every oversized payload denies).
        if len(text) > 262144:
            return "command payload too large to classify safely; denied fail-closed"
        leading = [
            segment
            for segment in split_shell_segments(text)
            if hcloud_leading_segment(split_tokens(segment)) is not None
        ] or ([text] if hcloud_leading_segment(split_tokens(text)) is not None else [])
        if leading:
            return (
                "the safety policy could not be loaded or carries no write vocabulary; "
                "hcloud commands are denied fail-closed. Fix or reinstall the plugin's "
                "safety/policy.json."
            )
        return None
    if routed is None:
        routed = (
            HCLOUD_ROUTE_RE.search(strip_shell_quotes(text)) is not None
            or HCLOUD_ROUTE_RE.search(text) is not None
        )
        # Over-cap latency guard (interrogate round 8): a benign-looking
        # oversized payload paid the full segment/token walk here (measured
        # 32s+ on 10 MB — a harness timeout swallows the verdict, which
        # reads as allow) while the TS twin gates entry on routing and never
        # segments. Every hcloud-head spelling the tokenizers admit also
        # appears contiguously in the raw or stripped text (the shadow drops
        # exactly the characters the tokenizers strip — recorded round-9
        # exceptions: the head predicates' paren-stripped and BOM-glued
        # normalized spellings, both non-executable in bash), so a payload
        # that is over-cap AND broad-unrouted has nothing this walk can
        # classify — the expansion-bearing and routed over-cap shapes
        # already denied at evaluate()'s head cap.
        if len(text) > 262144 and not (
            HCLOUD_ROUTE_BROAD_RE.search(strip_shell_quotes(text)) is not None
            or HCLOUD_ROUTE_BROAD_RE.search(text) is not None
        ):
            return None
        # Length cap (TS parity): a routed payload past 256 KiB cannot
        # execute through any wrapper chain, and classifying pathological
        # nests at that size costs minutes — a hook DoS. Fail-closed.
        if routed and len(text) > 262144:
            return "command payload too large to classify safely; denied fail-closed"
        # (the routed value computed above is authoritative — the historical
        # second recompute here was dead code, removed in interrogate
        # round 9)
    segment_seps = []
    segments = split_shell_segments(text, segment_seps)
    saw_leading = False
    # The glued walk's scope (interrogate round 11): BROAD routing — the
    # narrow tail's end-of-string exclusion left `echo ECS Delete | xargs
    # "hcl"oud` (the glued bin at EOF) outside the glued fallback entirely.
    # Narrow implies broad, so this is a superset of `routed`; the
    # empty-args arm stays narrow-gated (the pinned bare-hcloud allows).
    glued_scope = (
        HCLOUD_ROUTE_BROAD_RE.search(strip_shell_quotes(text)) is not None
        or HCLOUD_ROUTE_BROAD_RE.search(text) is not None
    )
    for s, segment in enumerate(segments):
        # Per-segment traversal scope (interrogate round 14 C2): a read
        # classified in ONE segment's subtree must not switch the opaque
        # gate off for LATER segments. seg_saw resets per segment and ORs
        # into the caller's accumulator.
        seg_saw = [False]
        tokens = split_tokens(segment)
        # Interpreter-code opacity, UNCONDITIONAL (round 14 C2's leak
        # within the code itself: `system("read"); subprocess.run("write")`
        # — the system()-read masked the subprocess write). Code context is
        # definitionally opaque: ANY token in the segment denies, before
        # any extraction (the -c/-e flag, an awk program, or a stdin
        # heredoc — round 14 C4: `python3 <<'EOF'`).
        _probe_stream, _ = _leading_segment_probe(tokens)
        _interp = _interpreter_head_of(basename_of(str(_probe_stream[0]).lower())) if _probe_stream else None
        if _interp is not None:
            _rest = [str(t) for t in _probe_stream[1:]]
            _code_form = (
                any(
                    (lambda f: re.match(r"^-[a-z]*c[a-z]*$", f, re.I) if _interp == "python" else (re.match(r"^-[a-z]*e[a-z]*$", f, re.I) or f == "--eval"))(_normalize_flag_token(t))
                    for t in _rest
                )
                or (_interp == "awk" and any(not t.startswith("-") for t in _rest))
                or re.search(r"<<<?", segment)
            )
            if _code_form:
                _opaque = _opaque_carrier_denied(segment, tokens, segment)
                if _opaque:
                    return _opaque
        # Nested scripts, BEFORE unwrapping flattens them. Wrapper
        # unwrapping runs to a FIXPOINT (same-wrapper compositions with
        # compound inner scripts reach their innermost script too). The
        # depth budget is 18 (TS parity, one past the Linux
        # executability ceiling): adversarial nests five-plus deep
        # genuinely execute, and beyond the budget the unwrap path
        # re-tokenizes WITHOUT re-splitting `;` — the write launders.
        carrier_traversed = False
        if depth < 18:
            candidates = [tokens]
            cursor = tokens
            for _ in range(4):
                nxt = _unwrap_secret_exec(cursor)
                if nxt is None:
                    nxt = _unwrap_skill_quality(cursor)
                if nxt is None:
                    break
                candidates.append(nxt)
                cursor = nxt
            # A command-position prefix in front of a shell head
            # (`sudo bash -c "…"`) hides the script from _script_of's
            # head check — probe PAST the prefixes (and their value
            # flags) so the nested segment/feeder semantics fire.
            probe = list(tokens)
            for _ in range(18):
                if not probe:
                    break
                head = str(probe[0]).lower()
                base = basename_of(head)
                is_env_assignment = bool(re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", str(probe[0])))
                # Redirection tokens strip too (interrogate round 11):
                # `2>/dev/null bash -c '…'` never reached _script_of while
                # bash executes the script.
                if is_redirection_token(str(probe[0])):
                    probe = probe[1:]
                elif (
                    re.sub(r"['\"\\$]", "", head) not in COMMAND_PREFIXES
                    and re.sub(r"['\"\\$]", "", base) not in COMMAND_PREFIXES
                    and not is_env_assignment
                ):
                    break
                elif is_env_assignment:
                    probe = probe[1:]
                else:
                    probe = _skip_prefix_args(
                        re.sub(r"['\"\\$]", "", base) or re.sub(r"['\"\\$]", "", head), probe[1:]
                    )
                candidates.append(probe)
            for candidate in candidates:
                nested = _script_of(candidate)
                if nested is not None:
                    # The nested script's stdin is THIS segment's stdin: a
                    # piped context feeds it, so the outer feeder threads
                    # down (an xargs inside the script inherits the pipe).
                    nested_feeder = split_tokens(segments[s - 1])[1:] if s > 0 else inherited_feeder
                    reason = hcloud_write_blocked(nested, depth + 1, routed, nested_feeder, seg_saw)
                    if reason:
                        return reason
                    carrier_traversed = True
                    # (The round-12 SCRIPT-SHADOW pass was REMOVED in the
                    # round-13 pivot: it un-quoted PROSE inside carrier
                    # scripts — `bash -c 'echo "step1; hcloud …"'` denied a
                    # benign echo — and its purpose (the deep-nest `'\''`
                    # idiom) is closed by the deny-opaque gate's
                    # fragmented-token signal, with strictly less
                    # false-positive surface.)
            # Heredoc/herestring SCRIPT bodies (interrogate round 11): a
            # shell bin reading its script from stdin — `bash <<EOF
            # <body> EOF` executes the body; the -c machinery never fires
            # without the flag. The segment keeps the body inline
            # (split_shell_segments models heredocs).
            heredoc_script = _heredoc_script_text(segment)
            if heredoc_script is not None:
                nested_feeder = split_tokens(segments[s - 1])[1:] if s > 0 else inherited_feeder
                reason = hcloud_write_blocked(heredoc_script, depth + 1, routed, nested_feeder, seg_saw)
                if reason:
                    return reason
                carrier_traversed = True
            # A DANGLING heredoc marker (interrogate round 12): `bash
            # <<EOF; echo hi` splits the segment at the `;` mid-line, so
            # the marker segment carries no body — bash starts the body at
            # the LINE's newline, which lands in the NEXT segment. The
            # next segment's text after its first newline, up to the
            # delimiter line, is the script.
            dangling = re.search(r"<<-?\s*(['\"]?)([A-Za-z0-9_]+)\1?[^\n]*$", segment)
            if dangling is not None and s + 1 < len(segments):
                # Round 15 C-A: the probe grammar (prefix/env/redirection
                # aware — a greedy regex ate the shell word).
                dangling_probe = split_tokens(segment[: dangling.start()])
                for _ in range(18):
                    if not dangling_probe:
                        break
                    dtok = str(dangling_probe[0])
                    if is_redirection_token(dtok):
                        dangling_probe = dangling_probe[2:] if re.match(r"^[<>]&?$", dtok) else dangling_probe[1:]
                        continue
                    if re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", dtok):
                        dangling_probe = dangling_probe[1:]
                        continue
                    dlower = dtok.lower()
                    dbase = basename_of(dlower)
                    if dlower in COMMAND_PREFIXES or dbase in COMMAND_PREFIXES:
                        dangling_probe = _skip_prefix_args(dbase or dlower, dangling_probe[1:])
                        continue
                    break
                if not dangling_probe or not re.match(
                    r"^(bash|sh|zsh|dash)(\.exe)?$",
                    re.sub(r"['\"\\$]", "", basename_of(str(dangling_probe[0]).lower())),
                ):
                    continue
                if True:
                    delim = dangling.group(2)
                    nxt = segments[s + 1]
                    nl = nxt.find("\n")
                    if nl >= 0:
                        body = nxt[nl + 1:]
                        end = body.find("\n" + delim)
                        if end >= 0:
                            reason = hcloud_write_blocked(body[:end], depth + 1, routed, None, seg_saw)
                            if reason:
                                return reason
                            carrier_traversed = True
            # find -exec/-execdir carriers (interrogate rounds 12-13): the
            # argv between the flag and the `\;`/`;`/`+` terminator is a
            # command position — extracted from BOTH tokenizations (the
            # plain one fragments a glued bin) and GATED ON THE HEAD BEING
            # FIND (round 13: `echo -exec hcloud …` is an echo argument,
            # not a carrier — the over-deny class).
            head_probe = list(tokens)
            for _ in range(18):
                if not head_probe:
                    break
                head_tok = str(head_probe[0])
                if is_redirection_token(head_tok) or re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", head_tok):
                    head_probe = head_probe[1:]
                    continue
                head_lower = head_tok.lower()
                head_base = basename_of(head_lower)
                if head_lower in COMMAND_PREFIXES or head_base in COMMAND_PREFIXES:
                    head_probe = _skip_prefix_args(head_base or head_lower, head_probe[1:])
                    continue
                break
            head_is_find = head_probe and basename_of(str(head_probe[0]).lower()) == "find"
            if head_is_find:
                for token_source in (tokens, split_tokens_glued(segment)):
                    for e, t in enumerate(token_source):
                        if str(t).lower() in ("-exec", "-execdir"):
                            end = next(
                                (k for k in range(e + 1, len(token_source)) if str(token_source[k]) in ("\\;", ";", "+")),
                                len(token_source),
                            )
                            payload = token_source[e + 1:end]
                            if payload:
                                reason = hcloud_write_blocked(" ".join(str(x) for x in payload), depth + 1, routed, None, seg_saw)
                                if reason:
                                    return reason
                                carrier_traversed = True
        # Round 16 C3 + round 17 C4/C5/C6: a pipe-fed SHELL or INTERPRETER
        # reads its stdin as a SCRIPT/CODE — the xargs-feeder doctrine,
        # completed: the WALK-BACK through pass-through middles, PER-WORD
        # feeder classification (printf's format arg precedes the data),
        # and INTERPRETER consumers (the code-context deny when the
        # walked-back feeder carries our token).
        _pipe_pass_through = {"cat", "sort", "tee", "head", "tail", "uniq", "wc", "tr"}

        # Round 18 C1/C2/C3: the head comparison uses the recognition
        # grammar — quote-strip + basename + prefix/env probe; CONTROL
        # heads flow through BEFORE the probe (the pipe data reaches the
        # body; probing would strip the `if` and misread `true`).
        _pipe_control = {
            "if", "while", "until", "for", "case", "then", "do", "else",
            "elif", "fi", "done", "esac", "{", "}", "(", ")", "!",
        }

        def _pipe_walk_back_feeder():
            k = s - 1
            while k >= 0:
                seg_toks = split_tokens(segments[k])
                raw_head = basename_of(re.sub(r"['\"\\$]", "", str(seg_toks[0] or "").lower())) if seg_toks else ""
                if raw_head in _pipe_control:
                    k -= 1
                    continue
                # Prefix/env probe (bounded) — `command cat`, `env cat`;
                # the prefix comparison strips quote-mangling (round 19 F1).
                probe = list(seg_toks)
                for _ in range(18):
                    if not probe:
                        break
                    t0 = str(probe[0])
                    if is_redirection_token(t0) or re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", t0):
                        probe = probe[1:]
                        continue
                    lower = re.sub(r"['\"\\$]", "", t0.lower())
                    base = basename_of(lower)
                    if lower in COMMAND_PREFIXES or base in COMMAND_PREFIXES:
                        probe = _skip_prefix_args(base or lower, probe[1:])
                        continue
                    break
                head = basename_of(re.sub(r"['\"\\$]", "", str(probe[0] or "").lower())) if probe else ""
                if head in _pipe_pass_through or head in _pipe_control:
                    k -= 1
                    continue
                return [str(t) for t in probe[1:]]
            return []

        _shell_stream, _ = _leading_segment_probe(tokens)
        _consumer_head = (
            re.sub(r"['\"\\$]", "", basename_of(str(_shell_stream[0]).lower())) if _shell_stream else ""
        )
        _shell_head_ok = bool(_shell_stream and re.match(r"^(bash|sh|zsh|dash)(\.exe)?$", _consumer_head))
        _interp_head_ok = _interpreter_head_of(_consumer_head) if _consumer_head else None
        if (
            (_shell_head_ok or _interp_head_ok)
            and s > 0
            and not any(re.match(r"^-[a-z]*c$", _normalize_flag_token(t), re.I) for t in tokens[1:])
            and not re.search(r"<<<?", segment)
        ):
            _feeder_args = _pipe_walk_back_feeder()
            if _interp_head_ok:
                _feeder_text = " ".join(_feeder_args)
                if any(b.lower() in _feeder_text.lower() for b in OPAQUE_BINS):
                    return (
                        "an opaque command carrier (script/interpreter/exec context) mentions Huawei Cloud "
                        "commands but cannot be safely classified. Write the command in plain form, or use "
                        "the sanctioned MCP paths (huaweicloud_run_readonly_command for reads / "
                        "huaweicloud_run_approved_command for writes)."
                    )
            elif _shell_head_ok:
                _feeder_words = [
                    re.sub(r"^['\"]|['\"]$", "", w) for t in _feeder_args for w in str(t).split()
                ]
                for word in _feeder_words:
                    _pv = hcloud_write_blocked("hcloud " + str(word), depth + 1, routed, None, seg_saw)
                    if _pv:
                        return _pv
                if _feeder_args:
                    reason = hcloud_write_blocked(" ".join(str(t) for t in _feeder_args), depth + 1, routed, None, seg_saw)
                    if reason:
                        return reason
                _inline_nl = segment.find("\n")
                if _inline_nl >= 0:
                    reason = hcloud_write_blocked(segment[_inline_nl + 1:], depth + 1, routed, None, seg_saw)
                    if reason:
                        return reason
        stripped = hcloud_leading_segment(tokens)
        if stripped is None:
            # Glued-bin fallback, PER SEGMENT (interrogate round 10): bash
            # glues adjacent quoted spans and word characters into ONE word
            # — `"hcl"oud ECS Delete` runs hcloud with full argv — while
            # split_tokens keeps the span/fragment distinction, so a
            # quote-INITIAL mangled bin never yields a leading token stream.
            # Tried HERE (not after the loop) so a leading READ in another
            # segment can never mask a later glued write (round 10's C3) and
            # the standard xargs machinery keeps handling the segments it
            # already classifies (the whole-text re-run denied a pinned
            # xargs allow through the empty-args arm).
            glued_stripped = None
            if glued_scope:
                glued_stripped = hcloud_leading_segment(split_tokens_glued(segment))
                if glued_stripped is not None:
                    saw[0] = True
                    seg_saw[0] = True
                    glued_argv = [t for t in glued_stripped[1:] if not t.startswith("-")]
                    # Round 16 C2: the expansion SLOT rule on the glued path
                    # (TS parity — `"hcl"oud ${X:-ECS} ${X:-Delete}`
                    # executed while the plain-path-only rule missed it).
                    _gslot_argv = [t for t in glued_stripped[1:] if not str(t).startswith("-")]
                    if any(re.search(r"\$\{", str(t)) for t in _gslot_argv[:2]):
                        _opaque = _opaque_carrier_denied(segment, tokens, segment)
                        if _opaque:
                            return _opaque
                    # Round 17 C2: the xargs head comparison strips
                    # quote-mangling (`x'args'`) on BOTH token streams.
                    segment_has_xargs = any(
                        re.sub(r"['\"\\$]", "", str(t).lower()) == "xargs"
                        or basename_of(re.sub(r"['\"\\$]", "", str(t).lower())) == "xargs"
                        for t in list(tokens) + split_tokens_glued(segment)
                    )
                    if (
                        not glued_argv
                        and s > 0
                        and segment_has_xargs
                    ):
                        # A glued bin the standard machinery never saw, fed
                        # by the pipe (interrogate round 11): the previous
                        # segment's words are the argv — any write-shaped
                        # feeder word denies (the xargs doctrine).
                        feeder_words = [
                            re.sub(r"^['\"]|['\"]$", "", w)
                            for t in _pipe_walk_back_feeder()
                            for w in str(t).split()
                        ]
                        for word in feeder_words:
                            reason = _classify_leading(glued_stripped, [str(word)], routed)
                            if reason:
                                return reason
                    elif (
                        glued_argv
                        and segment_has_xargs
                        and s > 0
                    ):
                        # A glued xargs bin with its OWN argv (interrogate
                        # round 12: `echo DeleteServers | xargs "hcl"oud
                        # ECS` — xargs appends the stdin AFTER the own
                        # args): merge the feeder into the glued argv, the
                        # standard machinery's xargs semantics.
                        feeder_words = [
                            re.sub(r"^['\"]|['\"]$", "", w)
                            for t in _pipe_walk_back_feeder()
                            for w in str(t).split()
                        ]
                        reason = _classify_leading(glued_stripped, glued_argv + feeder_words, routed)
                        if reason:
                            return reason
                    else:
                        reason = _classify_leading(glued_stripped, glued_argv, routed)
                        if reason:
                            return reason
            # The DENY-OPAQUE gate (interrogate round 13, the pivot): this
            # segment was NOT a plain-leading hcloud command AND its glued
            # re-join was not hcloud-leading either (either the standard
            # machinery classified one of those forms, or the segment
            # carries something we could not traverse). If our token hides
            # in it fragmented/marked/code-context form, deny fail-closed.
            # Round 14 C1: the gate runs UN-gated on glued_scope — the
            # routing boundary excludes `-`, so `${X:-hcloud} …` (the
            # default-expanded bin) never routed and the marker signal
            # never ran. The gate's own signals are the scope.
            if not seg_saw[0]:
                opaque_reason = _opaque_carrier_denied(segment, tokens, text)
                if opaque_reason:
                    return opaque_reason
            saw[0] = saw[0] or seg_saw[0]
            continue
        saw_leading = True
        saw[0] = True
        seg_saw[0] = True
        windows_payload = _LEADING_WINDOWS_PAYLOAD[0]
        argv = [t for t in stripped[1:] if not t.startswith("-")]
        # xargs feed: the preceding segment's tokens become argv after the
        # segment's own arguments.
        # xargs is detected on the PRE-unwrap segment tokens, the
        # unwrapped stream, and span tokens whose FIRST word is xargs
        # (inside a quoted windows payload the whole command is one
        # token; the child inherits the pipe and executes the merge).
        def _is_xargs_token(t):
            # Round 19: the xargs comparison strips quote-mangling
            # (`x'args'`) — round 17 fixed the GLUED arms' key but this
            # (the standard path's detector) read the raw token.
            tl = re.sub(r"['\"\\$]", "", str(t).lower())
            if tl == "xargs" or basename_of(tl) == "xargs":
                return True
            if re.search(r"\s", str(t)):
                words = split_tokens(str(t))
                return bool(words) and re.sub(r"['\"\\$]", "", str(words[0]).lower()) == "xargs"
            return False

        # Trailing redirection feeders: herestring words and a
        # `<`-terminated segment's NEXT segment are inline-visible feeder
        # content, same standard as the pipe.
        herestring_at = -1
        for ti, t in enumerate(tokens):
            if re.match(r"^0*<{3,}", str(t)):
                herestring_at = ti
                break
        # A heredoc marker (`<<EOF`, `<<-EOF`, `<< EOF`) — the body words
        # are stdin feeder content for the xargs-bearing opening segment.
        heredoc_at = -1
        for ti, t in enumerate(tokens):
            if re.match(r"^0*<<-?(?!<)", str(t)):
                heredoc_at = ti
                break
        trailing_redirect = bool(re.search(r"<\s*$", segments[s] or "")) and s + 1 < len(segments)
        if (
            any(_is_xargs_token(t) for t in tokens)
            or any(_is_xargs_token(t) for t in stripped)
        ) and (s > 0 or inherited_feeder is not None or herestring_at >= 0 or heredoc_at >= 0 or trailing_redirect):
            # The feeder is the UNION of every visible source: inner
            # pipe, inherited outer pipe (the script's stdin), herestring
            # words, and redirection-substitution words. Union is
            # fail-closed: any write-shaped word reaching the argv denies.
            # Pipeline WALK-BACK: through control headers, group
            # braces, and argless pass-through filters the pipe's data
            # reaches the xargs body (`echo Delete | if true; then xargs
            # hcloud ECS; fi`); a `;`-separated consuming command stops
            # the walk.
            control_head_words = {
                "if", "while", "until", "for", "case", "then", "do", "else", "elif",
                "fi", "done", "esac", "{", "}", "(", ")", "!",
            }
            pass_through_bins = {"cat", "sort", "tee", "head", "tail", "uniq", "wc", "tr"}

            def _walk_back_feeder():
                words = []
                k = s - 1
                while k >= 0:
                    seg_toks = split_tokens(segments[k])
                    head_tok = str(seg_toks[0] or "").lower() if seg_toks else ""
                    args = [str(t) for t in seg_toks[1:]]
                    # Round 18 C3: the control/pass-through comparison strips
                    # quote-mangling (`i'f'`, `the'n'`).
                    _nh = re.sub(r"['\"\\\\$]", "", head_tok)
                    is_ctrl = _nh in control_head_words or (_nh in pass_through_bins and not args)
                    sep_after = segment_seps[k] if k < len(segment_seps) else ""
                    sep_before = segment_seps[k - 1] if k > 0 and k - 1 < len(segment_seps) else ""
                    # `)` (substitution body) and `>(` (process
                    # substitution) flow like `|`.
                    flows = sep_after in ("|", ")", ">(")
                    if not is_ctrl and not flows:
                        if k == s - 1:
                            return words
                        break
                    words.extend(args)
                    if not is_ctrl and sep_before not in ("|", ")", ">("):
                        break
                    k -= 1
                return words

            def _expand_words(ts):
                # xargs splits stdin on IFS: a QUOTED feeder token carries
                # multiple words — expand every token into its
                # whitespace-separated words (quotes stripped).
                out = []
                for t in ts:
                    for w in str(t).split():
                        out.append(re.sub(r"^['\"]|['\"]$", "", w))
                return out

            feeder = _expand_words(_walk_back_feeder() + list(inherited_feeder or []))
            # A BARE `<<<` marker: following tokens are the payload; a
            # GLUED marker is handled by the redirect-marker branch below.
            if herestring_at >= 0 and re.match(r"^0*<{3,}$", str(tokens[herestring_at])):
                feeder = feeder + _expand_words([str(t) for t in tokens[herestring_at + 1:]])
            if trailing_redirect:
                feeder = feeder + _expand_words([str(t) for t in split_tokens(segments[s + 1])[1:]])
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
            # Redirection tokens are not argv — input (`<<<`, `<`,
            # glued `<<<Delete`), output (`>`, `>>`, `2>`, `1>`, `>&2`,
            # `2>&1`), and heredoc markers (`<<EOF`, `<< EOF`) — and the
            # words after a herestring/heredoc join the feeder.
            def _is_redirect_token(t):
                return (
                    str(t) == "<"
                    or bool(re.match(r"^0+$", str(t)))
                    or bool(re.match(r"^0+<$", str(t)))
                    or bool(re.match(r"^(?:\d*)>+<?&?", str(t)))
                    or bool(re.match(r"^0*<{3,}", str(t)))
                    or bool(re.match(r"^0*<<-?(?!<)", str(t)))
                )

            redir_at = -1
            for ai, t in enumerate(unwrapped_tail := [t for t in stripped[1:]]):
                if _is_redirect_token(t):
                    redir_at = ai
                    break
            if redir_at >= 0:
                marker = str(unwrapped_tail[redir_at])
                rest_tokens = [str(t) for t in unwrapped_tail[redir_at + 1:]]
                if re.match(r"^0*<{3,}", marker):
                    feeder = feeder + _expand_words([re.sub(r"^0*<{3,}", "", marker, count=1)] + rest_tokens)
                elif re.match(r"^0*<<-?", marker):
                    delim = re.sub(r"^0*<<-?", "", marker)
                    if delim:
                        end_i = next((i for i, t in enumerate(rest_tokens) if t == delim and i > 0), len(rest_tokens))
                        body = rest_tokens[:end_i]
                    else:
                        first = rest_tokens[0] if rest_tokens else ""
                        end_i = next((i for i, t in enumerate(rest_tokens) if t == first and i > 0), len(rest_tokens))
                        body = rest_tokens[1:end_i]
                    feeder = feeder + (body if body else rest_tokens)
            own = [t for t in (unwrapped_tail if redir_at < 0 else unwrapped_tail[:redir_at]) if not re.match(r"^[{}%]+$", str(t)) and str(t) != replstr]
            # The MERGED classification uses the redirect-trimmed own
            # list (TS ownTail parity) — a stale argv keeps `>` in the
            # service slot.
            argv = own + feeder
            # Fail-closed per-word candidates: any single feeder word in
            # the operation slot denies (xargs appends stdin in order).
            for word in feeder:
                reason = _classify_leading(["hcloud"] + own + [str(word)], own + [str(word)], routed)
                if reason:
                    return reason
        # Round 16 C3: a pipe-fed SHELL reads its stdin as a SCRIPT —
        # `echo 'hcloud …' | bash` executes the piped line. The xargs-feeder
        # doctrine: the previous segment's ARGS reaching a listed shell
        # consumer are the script; a heredoc-to-pipe composition lands the
        # body inline in the shell's own segment (post-newline text too).
        _shell_stream, _ = _leading_segment_probe(tokens)
        _shell_head = (
            re.match(r"^(bash|sh|zsh|dash)(\.exe)?$", re.sub(r"['\"\\$]", "", basename_of(str(_shell_stream[0]).lower())))
            if _shell_stream
            else None
        )
        if _shell_head and s > 0 and stripped is not None and not argv:
            _feeder_args = split_tokens(segments[s - 1])[1:]
            if _feeder_args:
                reason = hcloud_write_blocked(" ".join(str(t) for t in _feeder_args), depth + 1, routed, None, seg_saw)
                if reason:
                    return reason
            _inline_nl = segment.find("\n")
            if _inline_nl >= 0:
                reason = hcloud_write_blocked(segment[_inline_nl + 1:], depth + 1, routed, None, seg_saw)
                if reason:
                    return reason
        # Round 15 C-X: an expansion-built OPERATION/SERVICE/SUBCOMMAND
        # slot (`hcloud ECS ${X:-DeleteServers}`) — the bin IS seen, but the
        # classification is unprovable (the write vocabulary cannot match
        # `:-Delete`). The slot rule: the first two non-flag argv entries
        # carrying `${` deny opaque. Flag-position expansions
        # (`--cli-region=${REGION}`) stay allowed.
        _slot_argv = [t for t in stripped[1:] if not str(t).startswith("-")]
        if any(re.search(r"\$\{", str(t)) for t in _slot_argv[:2]):
            _opaque = _opaque_carrier_denied(segment, tokens, segment)
            if _opaque:
                return _opaque
        reason = _classify_leading(stripped, argv, routed)
        if reason:
            return reason
        # Glued comparison for PLAIN-LEADING segments (interrogate round
        # 11): the glued argv differs from plain exactly when quotes
        # fragmented an argv word — `hcloud ECS "De"leteServers` is the
        # write DeleteServers to bash and a read-looking `De` to the plain
        # tokenizer. The ownership is the VERDICT COMPARISON, not a skip:
        # classify the glued re-join too (the empty-argv shape stays owned
        # by the standard machinery above — xargs-feeder context).
        if glued_scope:
            glued_stripped = hcloud_leading_segment(split_tokens_glued(segment))
            if glued_stripped is not None:
                glued_argv = [t for t in glued_stripped[1:] if not t.startswith("-")]
                if glued_argv or len(stripped) > 1:
                    reason = _classify_leading(glued_stripped, glued_argv, routed)
                    if reason:
                        return reason
        # A windows payload's brace grammar makes every LATER hcloud
        # occurrence a live command site (`try { read } finally { write }` —
        # `}` is not a segment separator, so the blocks stay one segment):
        # classify each further bin + following words, including bins GLUED
        # to separator runs (`ListServers}catch{hcloud`).
        if windows_payload:
            for i in range(1, len(stripped)):
                piece_stream = _hcloud_piece_at(stripped, i)
                if piece_stream is not None and len(piece_stream) > 1:
                    tail_argv = [t for t in piece_stream[1:] if not t.startswith("-")]
                    reason = _classify_leading(piece_stream, tail_argv, routed)
                    if reason:
                        return reason
    # TS argv-face fallback: split_shell_segments eats backslash escapes
    # (POSIX semantics), so a Windows path-qualified wrapper
    # (`C:\Windows\System32\cmd.exe /c "hcloud …"`) mangles in the segment
    # pass while the plain token stream keeps the path intact. The TS face
    # classifies those tokens when no segment was hcloud-leading.
    if not saw_leading:
        stripped = hcloud_leading_segment(split_tokens(text))
        if stripped is not None:
            argv = [t for t in stripped[1:] if not t.startswith("-")]
            reason = _classify_leading(stripped, argv, routed)
            if reason:
                return reason
    # Glued-bin fallback, WHOLE TEXT (interrogate rounds 9-10): the last
    # resort for wrapper-qualified shapes where no segment was leading —
    # the per-segment fallback above handles everything else. Gated on `not
    # saw_leading` (the standard machinery classified those segments with
    # full context); routed-only (benign unrouted commands skip it).
    if not saw_leading and glued_scope:
        stripped = hcloud_leading_segment(split_tokens_glued(text))
        if stripped is not None:
            argv = [t for t in stripped[1:] if not t.startswith("-")]
            reason = _classify_leading(stripped, argv, routed)
            if reason:
                return reason
    return None


def evaluate(tool_name, tool_input):
    """Run the full safety check and return a raw block reason, or None to allow.

    Shared by the CLI shell (``main``) and the Hermes Python-plugin hook, which
    reuses this module via ``importlib`` so a single implementation enforces the
    policy everywhere. The returned reason does NOT include ``DENY_PREFIX`` —
    callers decide the exact output shape.
    """
    text = command_text(tool_input)
    # Whitespace-only commands deny (interrogate rounds 8-9): the TS twin's
    # risk-rule engine rejects them ("command must be a non-empty string").
    # The strip set is the EXACT JS trim() character set — round 8's bare
    # str.strip() also stripped \x85 (NEL) and \x1c-\x1f, which JS trim does
    # NOT, denying py-side what TS allowed (a one-directional drift); py's
    # strip() misses \ufeff, which JS trim DOES strip, so it rides the set
    # explicitly.
    if not text.strip(" \t\n\v\f\r                 　﻿"):
        return "command must be a non-empty string. Remediation: Provide a valid, non-empty input before re-running the check."
    unquoted = strip_shell_quotes(text)
    # Length cap (interrogate round 5): BYTES on both twins (UTF-16 units on
    # TS vs code points here disagreed at the boundary on astral-plane
    # padding — same payload, different verdicts; bytes are also the honest
    # reading of "256 KiB payload"). The surrogate-safe chain (round 7 — a
    # bare .encode("utf-8") raised UnicodeEncodeError on the lone \ud800 the
    # JSON parser accepts, killing the hook verdict-less, and round 6's
    # "replace" counted a lone surrogate as 1 byte where TS's
    # Buffer.byteLength counts 3 as U+FFFD — an 87k-surrogate payload sat
    # under this cap and over TS's, an executable write allowing here while
    # denying there): the utf-16-surrogatepass round-trip pairs valid
    # surrogate pairs, replaces lone ones with U+FFFD, and the final utf-8
    # length is byte-identical to Node's.
    text_bytes = len(
        text.encode("utf-16", "surrogatepass").decode("utf-16", "replace").encode("utf-8")
    )
    # Continuation-dropped text (interrogate round 6): bash removes the
    # \<newline> pair before tokenization OUTSIDE single-quoted and $'…'
    # spans (inside those the pair is literal — the drop here is
    # deliberately blunter and only ever over-denies), reassembling
    # $'/$(/backtick across the break — the raw text of
    # h$\<LF>'\x63'loud … carries only $\, so every raw-text expansion check
    # and the decode must run on the reassembled form or a composed mangled
    # write sails through. Dropping pairs can only ever CREATE markers (a
    # real $' survives the drop untouched), so the dropped form subsumes the
    # raw one — with the recorded round-7 caveat that a created marker can
    # be PHANTOM ($$\<LF>' glues to a $' bash never builds, and a
    # single-quote interior's closing quote can compose one): fail-closed
    # false denies, never a miss.
    text_cont = re.sub(r"\\\n", "", text)
    # A routed OR EXPANSION-BEARING over-cap payload denies fail-closed: the
    # round-4 decode skip must not make the over-cap slice the one place a
    # mangled write sails through (the marker check on the dropped text is a
    # single linear scan; no legitimate oversized expansion-bearing Bash
    # payload exists).
    if text_bytes > 262144 and (
        OBFUSCATION_RE.search(text_cont)
        or re.search(r"\$\{", text_cont)
        or HCLOUD_ROUTE_RE.search(unquoted)
        or HCLOUD_ROUTE_RE.search(text)
    ):
        return "command payload too large to classify safely; denied fail-closed"
    # The ANSI-C-decoded shadow (interrogate round 3): the argv letters $'…'
    # spans build, reconstructed — h$'\x63'loud is the hcloud the shell
    # executes. Presence gates below that bear on cloud-command or
    # secret-reveal detection search BOTH shadows; with no $' span the
    # decoded candidate is the original text. Decoded from the
    # CONTINUATION-DROPPED text (round 6: the pair removal is part of bash's
    # own first pass, and the decode's outside-quote backslash branch would
    # otherwise consume the \ of a composed $\<LF>' without opening the
    # span). Skipped for over-cap payloads (round 4: an unrouted 10 MB
    # escape flood must not pay the decode's linear pass — and the
    # expansion-bearing cap deny above closes the skip's mangled-write
    # window at the same size).
    decoded_unquoted = (
        unquoted if text_bytes > 262144 else strip_shell_quotes(decode_ansi_c_spans(text_cont))
    )
    candidates = (unquoted, decoded_unquoted)
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
    if SECRET_CLI_RE and any(SECRET_CLI_RE.search(candidate) for candidate in candidates):
        return "printing vault secrets into the agent context is blocked. Use secret exec so the value reaches only the child process environment."
    # Order-independent reveal pair: xargs reorders the argv while every word
    # stays literal — a devkit bin plus a `secret get` pair anywhere is a
    # reveal regardless of order (both shadow candidates — the decoded one
    # catches ANSI-C-mangled spellings).
    if any(DEVKIT_BIN_RE.search(candidate) for candidate in candidates) and any(
        REVEAL_PAIR_RE.search(candidate) for candidate in candidates
    ):
        return "printing vault secrets into the agent context is blocked. Use secret exec so the value reaches only the child process environment."
    # Obfuscated cloud-command invocation: ANSI-C escapes and command
    # substitution build argv the shadow cannot reconstruct. Canonical
    # devkit/hcloud commands never carry them. The WRITE_VOCAB_RE clause
    # closes ANSI-C KEYWORD mangling ($'\x68'cloud — the h exists only inside
    # the escape, so no layer sees 'hcloud', but the unquoted text still
    # carries 'deleteservers'): expansion + a write-op word denies fail-closed.
    # Mirrors the TS gate's writeVocabHit clause (the #927 audit bypass fix);
    # the vocabulary is the policy.json writeOperationPrefixes list derived
    # by load_policy from the same read as WRITE_OPERATION_RE — one list,
    # both gates — plus the marker-gated OBS_VOCAB_RE arm: the OBS subcommand
    # words fire only when a shadow also carries the OBS service token, so
    # routine expansion-bearing shell idioms (`docker rm $(docker ps -aq)`,
    # `mkdir -p $(pwd)/build`) stay legitimate. Interrogate round 3 adds the
    # DECODED candidate: mangling past the marker (h$'\x63'loud $'\x4f'BS rm —
    # no 'cloud', no 'OBS' in the stripped shadow) can no longer hide the
    # bin, the service token, or the operation word, and mangled READS deny
    # too (deny rather than parse — the same verdict an op-mangled read with
    # a literal bin already gets). The `is None` arm is the vocabulary's
    # failure mode, chosen FAIL-CLOSED: when the derivation is unavailable
    # (policy.json missing or corrupt JSON, or the list empty or non-list —
    # load_policy normalizes non-lists to empty) the clause treats the
    # vocabulary as hit, so an expansion-bearing command denies instead of
    # the unavailable word list re-opening the mangled-write hole the gate
    # exists to close.
    if (
        any(CLOUD_BIN_RE.search(candidate) for candidate in candidates)
        or any(re.search(r"secret://", candidate) for candidate in candidates)
        or WRITE_VOCAB_RE is None
        or any(WRITE_VOCAB_RE.search(candidate) for candidate in candidates)
        or (
            any(OBS_MARKER_RE.search(candidate) for candidate in candidates)
            and any(OBS_VOCAB_RE.search(candidate) for candidate in candidates)
        )
    # The right conjunct runs on the CONTINUATION-DROPPED text (round 6): a
    # composed $\<LF>' carries the marker only after the pair drop, and the
    # drop never destroys a real one.
    ) and OBFUSCATION_RE.search(text_cont):
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
    if tool_name in ("Bash", "terminal"):
        reason = hcloud_write_blocked(text)
        if reason:
            return reason

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
