# AgentArts CLI Workflows (agentarts-sdk 0.1.7)

Every command shape here is fixture-verified against agentarts-sdk 0.1.7
(`test/fixtures/agentarts/help-tree/`); every trap is measured
(`docs/agentarts-pr0-findings.md`). Do not invent flags — run
`agentarts <group> --help` for anything not listed.

## Prerequisites

- `pip install agentarts-sdk==0.1.7 -i https://mirrors.huaweicloud.com/repository/pypi/simple`
  (verify: `agentarts --version` prints "agentarts version: 0.1.7"). The
  Huawei Cloud PyPI mirror is the default; if it lags a newly pinned
  version, drop `-i` and install from official PyPI. Or run
  `npx huaweicloud-devkit install-agentarts` (devkit-owned venv,
  auto-resolved). CLI resolution: `AGENTARTS_BIN` > devkit-managed venv >
  PATH — a personal venv install must be invoked by full path, or pointed
  to by `AGENTARTS_BIN`.
- Credentials are injected by the wrapper tools from the devkit runtime
  credential state (`huaweicloud_auth_init`). NEVER export AK/SK manually —
  see `huaweicloud-cli-and-auth`.
- Control plane is cn-southwest-2 only. The memory six (create/get/list/
  update/delete/status) help text CLAIMS a cn-north-4 default, but the
  actual code fallback is cn-southwest-2 (constant.py:79, findings trap
  15). Resolution chain: `HUAWEICLOUD_SDK_REGION` → `HUAWEICLOUD_REGION` →
  `OS_REGION_NAME` → cn-southwest-2 — wrapper child envs strip all three
  (wrapper runs always land on cn-southwest-2), but in your own terminal
  an exported `HUAWEICLOUD_SDK_REGION` wins, and some sibling skills'
  install guides export it. Always pass `--region` explicitly on the
  memory family regardless.

## Golden Path (deploy an agent)

```
1. agentarts init -n <name> -t <basic|langchain|langgraph|google-adk> -r cn-southwest-2
   (local tier — run via Bash; -r is REQUIRED, init prompts and aborts on EOF.
   NOTE: -p <dir> is a PARENT dir — the project lands at <dir>/<name>, so
   `-p foo -n foo` nests foo/foo. Omit -p to create ./<name> in cwd.)
2. (basic template) agentarts dev --port 8080  (local tier — background server;
   poll GET /ping until healthy, then kill; no wrapper involvement)
   (framework templates: `agentarts dev` cannot import framework deps — see
   "Framework Templates and `agentarts dev`" below and use the project venv.)
2b. PRE-WARM (mirror-first; keeps launch inside the ~300s client timeout):
   - base image via mirror + retag (see "Restricted Networks" below)
   - add .dockerignore (.venv/ __pycache__/ .git/ .agentarts_config.yaml + helpers)
   - ensure the Dockerfile pip step uses a mirror (ARG PIP_INDEX_URL=...)
3. huaweicloud_agentarts_plan_cli_command
   args: ["config","set","base.region","cn-southwest-2"]   → approved
   → present command to user → run_approved_command
4. huaweicloud_agentarts_plan_cli_command
   args: ["launch"]                                        → approved (billing)
   → present → run_approved (docker build + SWR push + runtime create)
5. huaweicloud_agentarts_plan_cli_command
   args: ["invoke","{\"message\":\"hello\"}"]              → approved (execute)
   → present → run_approved (wrapper default 900s; the CLI's own request
   timeout is also 900s)
6. huaweicloud_agentarts_plan_cli_command
   args: ["destroy"]                                       → approved; the plan
   canonicalizes to `destroy --yes` (non-interactive) — approve THAT form
   → present → run_approved
```

## Framework Templates and `agentarts dev`

`agentarts dev` imports the entrypoint in the CLI's OWN interpreter (the
devkit/managed venv), after `sys.path.insert(0, cwd)`. It does NOT use a
project venv, so `langchain` / `langgraph` / `google-adk` templates raise
`ModuleNotFoundError` (measured: `No module named 'langchain_core'`), and its
failure hint (`pip install -e .`) is misleading.

To smoke-test a framework template locally, run the same ASGI app from the
project venv and load env from the config:

```python
# local_dev.py — run as: cd <project> && .venv/bin/python local_dev.py
import os, sys
from pathlib import Path
import yaml
HERE = Path(__file__).resolve().parent
cfg = yaml.safe_load((HERE / ".agentarts_config.yaml").read_text())
agent = cfg.get("default_agent") or next(iter(cfg["agents"]))
for e in cfg["agents"][agent]["runtime"].get("environment_variables", []):
    if e.get("value") is not None:
        os.environ[e["key"]] = str(e["value"])
sys.path.insert(0, str(HERE))
from agent import app          # noqa: E402
import uvicorn                 # noqa: E402
uvicorn.run(app, host="127.0.0.1", port=8081)
```

Caveat: this uses the project venv's Python/resolved deps, which can differ
from the image (`python:3.10-slim`). Treat a green local run as a smoke test,
not proof the container works; the cloud `invoke` is the real verification.

## Error Signatures (parse output; exit codes lie)

| Signature                                  | Meaning                                                                                         |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `ModuleNotFoundError: No module named ...` | framework dep absent from the CLI venv during `dev` — use the project-venv recipe above         |
| JSON-RPC `-32001` on `launch`              | build exceeded the MCP client timeout (~300s); output lost — check `docker ps -a` for an orphan |
| `Namespace does not exists`                | first-run SWR org/repo auto-create (benign, followed by `Created ...`)                          |
| `- ERROR -` / `Failed to ...` / `× ERROR:` | operation failure despite exit 0 (see huaweicloud-safety)                                       |

Pre-deploy yaml: `file_transfer_config.enabled` and
`invoke_config.url_match_type` defaults (`false` / `ACCURATE_MATCH`) must be
edited BEFORE deploy when file transfer or a custom path is needed; whether
post-deploy console edits work is unresolved (conflicting CLI-help vs SDK-doc
evidence) — treat pre-deploy as required.

## Read-only Inspection

```
huaweicloud_agentarts_run_readonly_command
  ["memory","list","--region","cn-southwest-2","--output","json"]
  ["memory","get","<space-id>","--region","cn-southwest-2","--output","json"]
  ["memory","status","<space-id>","--region","cn-southwest-2","--output","json"]  (space_id is a
   POSITIONAL argument — a --space-id flag is rejected by the CLI)
  ["gateway","list"]
  ["gateway","get-target","<gateway-id>","<target-id>"]

huaweicloud_agentarts_list_agents (SDK API — 0.1.7 has NO list CLI command)
  {}                                  → all agents, SDK default pagination
  { "agent_name": "demo" }            → fuzzy name filter
  { "limit": 100 }                    → explicit page size when sweeping
```

Use `--output json` on EVERY memory read (default is a rich table that
TRUNCATES ids mid-string — `60a51c61-c5d8-491…` — a copied id is
broken). The GATEWAY group is the opposite: it has NO `--output` option
(`No such option: --output`) and prefixes stdout with `√ SUCCESS:` —
strip the prefix to parse (see Gateway Provisioning). The list-agents
tool returns `agents[]` already parsed; omit `limit`/`offset` unless
sweeping — the SDK defaults are the single source of truth. Through the
BRIDGE, list_memories also defaults to limit 10 — pass limit 100 (the
max) and paginate offset to sweep a space.

Reading a space's CONFIG (ttl, strategies, access, vpc/public flags,
memory_extract_enabled): `memory get -o json` is the source of truth —
`memory list` reads the same fields back WRONG (read-model drift:
list shows `memory_extract_enabled: false` and null strategies for a
space that get and create both show as `true` with the four built-ins;
create/list drift is trap 25, the get side was measured 2026-10-27).
The get body is ~52KB (every strategy's extraction prompt) — the
runner truncates it to the 0600 side file; grep the saved file for the
fields you need instead of re-reading.

## Gateway Provisioning

```
1. plan ["gateway","create","--name","<name>"]              → approved (billing)
   → present → run_approved
   (omit --name and the CLI generates gateway-<random8>;
    omit --agency-name and the SDK auto-creates the IAM agency
    "AgentArtsCoreGateway" — a 409 (already exists) is tolerated and the
    create continues. Cloud-measured 2026-10-29: the agency is NOT
    reclaimed by gateway delete — it persists across gateway lifecycles
    as a shared one-time artifact; cleanup is manual, never delete's job)
2. verify: readonly ["gateway","list"] / ["gateway","get","<gateway-id>"]
3. plan ["gateway","create-target","<gateway-id>",
         "--target-configuration","<json>"]                  → approved
   (--target-configuration is REQUIRED and its JSON shape is NOT in help —
    help says only "(JSON format)". The structure lives in the API
    reference / API Explorer (CreateCoreGatewayTarget's
    target_configuration field) — fetch it there, never invent it)
4. verify: ["gateway","get-target","<gateway-id>","<target-id>"] /
   ["gateway","list-targets","<gateway-id>"]  (list pagination: --limit
   default 50, --offset default 0; list returns NO target_configuration —
   auditing N targets costs N get-target calls, G2 2026-10-29)
   target status: poll until STABLE — that is the terminal signal. The
   vocabulary is UNSTABLE across sessions (both 2026-10-29): G2 measured
   `creating→ready` and `updating→synchronizing(90–130s)→ready` (terminal
   `ready`, and `synchronizing` appears in NO help/schema); G1 measured
   `creating→active`. There is no --wait flag, and during the ~35s window
   after an update get-target returns NO status field at all — treat a
   missing field as in-progress, never as an error to retry.
5. after ANY update: re-read with get/get-target and COMPARE the field
   you changed — update/update-target silently DROP schema-absent fields
   and still report success (measured 2026-10-29, G1 + G2 independent
   reproductions: supported_versions accepted with 2xx, value unchanged,
   zero warning). Success ≠ applied.
6. tool usability: NOT provable via the CLI (no sync subcommand, no
   tools field on get-target) — the only proof is the E2E recipe below.
```

Deletion: `gateway delete` / `delete-target` have NO skip flag
(typer.confirm) — the wrapper hard-stops them; the user runs them in their
own terminal. `--outbound-network-configuration` (JSON) defaults to unset
client-side; the server-side default for the unset case is not documented
in help — treat the network posture as a real decision, not an assumed
default.

Gateway output parsing (measured 2026-10-29): the gateway group rejects
`--output` and `--region` (`No such option: --output`) — `--output json`
exists ONLY on the memory family — and prefixes stdout with `√ SUCCESS:`;
strip the prefix before parsing. Column width: rich wraps non-TTY output
at 80 columns when COLUMNS is absent — the wrapper's child env now carries
`COLUMNS=2000` (G2 fix), so endpoint URLs arrive unbroken through any
wrapper tool; in your OWN terminal `export COLUMNS=2000` before parsing,
or URLs break mid-string (`...huaweicloud-agenta\nrts.com/mcp`, trap 51).
API-level errors (resource not found, update with nothing to update) land
on stdout with exit 0 — trap-23 behavior: parse output, never exit codes.

Help discovery (G2 fix, 2026-10-29): the readonly runner executes genuine
`--help` at ANY command level (group, subcommand — e.g.
`["gateway","--help"]`, `["gateway","create-target","--help"]`) and root
metadata (bare/`--help`/`--version`), no credentials needed — prefer it
over Bash when the shell cannot find the CLI binary. A `--help` token
sitting in a VALUE slot (`gateway create --name --help`) is rejected as
the approved-tier write it collapses to under click's real semantics.

Error diagnosis (measured 2026-10-29): `AgentArts.02000001 Incorrect
request parameters` is generic — invalid gateway name, empty tag key,
duplicate name, empty target configuration all share it, with no
field/regex in the message. Charset constraints are help-invisible
(devbridge descriptions reject hyphens: Chinese characters, digits,
letters only). `AgentArts.00000144 The current user status is unassigned`
on a bare-shell run is a credential-source signal — see
references/credentials.md.

## Gateway E2E Verification (the only tool-usability proof)

The CLI cannot prove a target's tools work: no sync subcommand (a manual
attempt answers `No such command`; the `SyncCoreGatewayTargets` API exists
but is unwrapped), and get-target returns no tools list — a tools field
will NEVER arrive; do not loop waiting for it. The only proof is calling
the gateway endpoint itself. That path required three undocumented facts,
all measured in the G2 session (2026-10-29) — they are now the recipe:

1. **endpoint_url** — read it from `["gateway","get","<gateway-id>"]`
   (through the wrapper it arrives unwrapped, see the COLUMNS note above).
2. **Auth header** — ONLY `Authorization: Bearer <api_key>` works.
   Measured by probing five forms: `X-Api-Key`, bare `Authorization`
   (no Bearer scheme), and query-parameter variants all answer 401. Do
   not spend retries rediscovering this.
3. **mcp-session-id handshake** — the endpoint speaks MCP
   streamable-HTTP: POST an `initialize` request first, take the
   `mcp-session-id` response header, and send it on every subsequent
   request; a tools/list without the session id is rejected.
4. **Key handling — never in argv.** The api_key is viewable and
   resettable in the console (user-confirmed). Deliver it the
   argv-invisible way: write `Authorization: Bearer <key>` into a 0600
   file the user controls and let curl read the header from the file —
   `curl -H @<file>` (curl 7.55+; the `@file` form reads the header
   from disk, keeping the key out of the process list and the
   transcript). `curl -H "Authorization: Bearer <key>"` on the command
   line is the same argv exposure the `--bearer-token` rejection exists
   for. See references/credentials.md for the file-writing recipe.
5. **IAM-type gateways cannot be called with AK/SK** (no token-mint
   path, measured 2026-10-29). To E2E-verify one you must create an
   api_key-authorized side gateway: budget the extra resource AND its
   cleanup, and remember the shared `AgentArtsCoreGateway` agency is NOT
   reclaimed by gateway delete (manual cleanup, trap 49).

What success proves: a real tools/list through the endpoint is the ONLY
evidence that the target's tools are usable — create-target success,
target status, and every CLI read together do not add up to it.

## Runtime Sessions (data plane)

All runtime subcommands are approved-tier. `exec-command` runs arbitrary
commands inside the deployed agent's sandbox (rce); `upload-files` moves
local files to the cloud (data-exfil); `download-files --recursive` can
pull whole directories (local-write); the invoke family (invoke /
runtime invoke / upload / download) carries 900s wrapper timeouts.

`exec-command` shell semantics (fixture-measured): the backend runs the
command as a Docker exec-form JSON array — NO shell by default, so
operators (`>`, `|`, `;`, `&&`, `$()`) are not interpreted; when shell
operators are present the CLI auto-wraps as `["sh","-c","<command>"]`;
quote the whole command to pass it literally.

Timeout interplay for `exec-command` (the part that bites): the CLI's own
`--timeout` defaults to 60s (max 3600), while the wrapper's default for
exec-command is 120s. For anything long-running, raise BOTH: pass
`--timeout <seconds>` in args and `timeoutMs` of roughly
`(<seconds> + 30) × 1000` to the run tool — otherwise either the CLI
aborts at 60s or the wrapper SIGKILLs a still-legitimate request at 120s.

Session lifecycle: `start-session --agent <name>` returns the session id;
pass `--session` to exec-command/invoke/upload/download; stop with
`stop-session` even on failure paths.

## Memory Data Plane (SDK bridge — no CLI subcommands in 0.1.7)

The CLI stops at space management. All 12 data-plane methods run through
the SDK bridge tools; the one-time data-plane api_key is read from the
wrapper-captured 0600 key file and injected env-only (never argv, never
the transcript — see credentials.md).

The write loop (create → record → recall). Read before writing when the
intent is ambiguous (a two-word user input is not a write instruction):
search_memories with the same actor_id / list_messages on the target
session first — every write costs a plan → present → approve → write
round-trip, and an unnecessary one also risks duplicate memories.

1. Create the space through the CLI pair (`memory create` captures the
   key file).
2. `huaweicloud_agentarts_memory_plan` with `create_session` and the
   user's `actor_id` (REQUIRED — the actor is the isolation unit).
   Approve, then `huaweicloud_agentarts_memory_write` with
   `approvedByUser: true`. Capture `result.id` (or pass your own
   `session_id` to create_session).
3. `memory_plan add_messages` with the session id and the message batch
   (roles user/assistant/system; ONE approval covers the whole batch;
   the request rides stdin, so batch size is not argv-limited). Approve,
   write.
4. Verify ingestion with `memory_read list_messages` (immediate). The
   natural next check, `memory_read search_memories`, LAGS: extraction
   is asynchronous, so an empty result right after a write is EXPECTED —
   do not re-write (duplicate) or churn `is_force_extract`; wait, or
   verify ingestion via list_messages.
5. Recall with `memory_read search_memories` using the SAME `actor_id`
   (required — server isolation is actor-level only). Size the result
   with `filters.top_k` (NOT `limit` — search takes no limit; the
   boundary rejects it), and judge the outcome by `searchSummary`
   (below), never by result presence.

actor_id per operation (the same name, three different contracts):

| Operation       | actor_id                                                                                                        |
| --------------- | --------------------------------------------------------------------------------------------------------------- |
| search_memories | REQUIRED, top-level (unscoped = every actor's memories)                                                         |
| create_session  | REQUIRED, top-level (the actor is the isolation unit)                                                           |
| list_sessions   | optional, top-level — omit = all actors (result notes it)                                                       |
| list_memories   | optional, `filters.actor_id` — omit = all actors (ditto)                                                        |
| add_messages    | per-message ONLY — top-level actor_id is rejected (not an add_messages parameter; measured: first-plan failure) |
| everything else | n/a                                                                                                             |

Failure/retry semantics: a mismatched write rejects without consuming
the token; a SUCCESSFUL write consumes it, and replay returns
`already_processed` (verify with `memory_read` before re-planning
anything); a FAILED write burns the token — re-plan to retry, and pass
`idempotency_key` on add_messages retries (a timeout may have landed
server-side). `delete_memory` is irreversible; `delete_session` is a
soft delete — unreachable through this toolkit immediately, retained
server-side for async cleanup (90-365 days per the SDK), no in-toolkit
recovery.

Batch deletion (`delete_memories`): pass `memory_ids[]` and ONE approval
covers the whole array — the bridge loops the SDK's single-record delete
internally (0.1.7 has no server-side batch; upstream ask #15). The
canonical request sorts the ids by CODE UNIT (locale-independent — the
token binding must not depend on the process locale), so a plan/write
id-order difference still binds; duplicates are rejected at plan time (a
duplicate would fail server-side on the second delete). The execution
timeout auto-scales with the batch (2s per id + 30s grace, floor 120s —
a heuristic until per-id latency is measured; the plan states the exact
budget). Enumerate first (`memory_read list_memories`, limit 100 +
offset to sweep), then plan the batch from real ids. Partial failure:
the executed snippet emits one JSON progress line per id to STDERR as it
goes (a mid-batch timeout still leaves that trail), and on any failure
prints `{"deleted": [...], "failed": [{"memory_id", "error"}]}` to
stdout and exits 1 — the failure payload surfaces that report as a
STRUCTURED `partial` field plus a batch-aware burn note: re-plan ONLY
the still-present ids. On a TIMEOUT the stdout report may be missing —
read the stderr progress trail and reconcile with memory_read
(get_memory per id is the direct check — a not-found id is deleted;
list_memories the sweep form). Still no undo — every id in the batch is
an irreversible delete. Filter values (min_score/top_k numbers, string
fields) and top-level limit/offset/k are type-checked at the tool
boundary — a mistyped value is rejected, never silently coerced; a
serialized `null` score counts as scoreless (kept by the client-side
min_score filter, excluded from searchSummary); a set min_score whose
result went to the truncation side file carries an explicit
NOT-applied note.

Three retention/recall traps worth knowing before you lean on the data:

- **Message TTL is 7 days by default** (`message_ttl_hours: 168`, range
  1-8760, SDK source). Raw conversation messages a space stores through
  `add_messages` EXPIRE after a week unless the space was created with a
  higher `--ttl`; extracted MEMORIES persist independently. Use the
  bridge for durable facts (they become memories via extraction), not as
  a permanent conversation archive.
- **Search semantics: no default cutoff, whole-space returns, and the
  server-side threshold filter does not work at all.** The documented
  server default of 0.5 belongs to `MemorySearchRequest` — a different
  request class the bridge never builds. The bridge's
  `MemorySearchFilter` defaults `min_score` to None and its serializer
  DROPS None (pinned venv config.py:122-132), so an omitted `min_score`
  sends nothing and the server returns the whole space ranked by
  similarity. Measured (2026-10-27, one 7-memory space): even an
  EXPLICIT `min_score: 0.01` still returned all 7 entries including one
  at 0.000016 — the server ignores the threshold itself. The bridge
  therefore applies a set `min_score` CLIENT-side: sub-threshold entries
  are removed from `result`, a note counts the cut, and `searchSummary`
  `{resultCount, maxScore, minScore}` describes the RAW server response.
  Score calibration from the same session: a no-match query's best score
  (≈0.06) exceeded a genuinely-matching query's (≈0.04); the full
  measured band is 0.000016-0.14 — "no results" is never the no-match
  signal, absolute scores are not comparable across queries, and a big
  relative gap inside one response is the hit signal. Calibrate any
  threshold on the observed band and transplant no threshold from
  another surface: the hook path's 0.3 and the plugin MCP path's 0.7
  constants would filter out EVERYTHING on this scale.
- **Extraction is fan-out, not 1:1 — and the extractor editorializes.**
  One `add_messages` message can extract into several memories at once
  (measured: one message → four — semantic, user_preference, summary,
  episodic running concurrently). `summary` writes a NEW record that
  merges prior information while the OLD records remain (append-merge,
  not in-place update). The extractor also infers the subject from
  session history (measured: a message that never named Alice was stored
  as "Alice 觉得…") and stores its own paraphrase, not your verbatim
  text. Consequences: record count is unpredictable from message count;
  "delete that memory" requires enumerating first (list_memories /
  search_memories); deletion is irreversible with no undo — batch the
  ids through `delete_memories` (one approval per array, see the
  failure/retry section above); and there is NO
  message-level delete in 0.1.7 (only `delete_session` soft delete).
  Control what gets inferred by controlling the session context you
  write into.

Which path to use (the dual-path decision): the WRAPPER bridge
(memory_read/plan/write) is governed — approval tokens, redaction, the
0600 key channel — and works on every host, but captures nothing
automatically. The official PLUGIN (`memory install`, user terminal
only — host-trust: it writes the api_key into the host agent's config)
auto-captures conversations into a space but only covers five platforms
and its /recall /remember commands are broken in 0.1.7 (they curl an
HTTP server that does not exist). For cross-session memory on a
supported host: install the plugin (user's terminal), then use the
bridge tools for governed search/ops. For every other host or purpose:
the bridge alone.

## Wrapper Rules (why some commands hard-stop)

| Shape                              | Wrapper behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--bearer-token` / `-bt` anywhere  | Rejected at plan: argv is process-list visible                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| bare `agentarts config`            | Hard stop: interactive wizard                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `gateway delete` / `delete-target` | Hard stop: typer.confirm, NO skip flag exists — user terminal only                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `memory install`/`uninstall`       | Plan requires an explicit target (hermes, claude, codex, opencode, openclaw) — the plan canonicalizes `--yes`; it writes credentials into the host agent's config — a user decision, never agent-initiated                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `memory create`/`update`/`delete`  | Approved (PR11). create REQUIRES `--strategies` (server: HTTP 400 [AgentArts.01010400] without at least one built-in strategy — and the failed attempt orphans the API key the CLI created just before the space; the plan tool rejects a missing value and lists the legal built-ins: semantic, episodic, user_preference, summary, event — the first four e2e-measured, event enum-evidenced only). create canonicalizes to `--output json` and captures the one-time api_key to a 0600 file (payload stays redacted — see credentials.md); delete canonicalizes `--force` and carries the `irreversible` label. `memory update` also HAS `--strategies` (fixture), but its empty/missing semantics are unmeasured — no create-style rejection there |
| `destroy`                          | Plan appends `--yes` (measured non-interactive flag); approval binds to that form                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

Worked example (space creation, the full canonical form):

```
agentarts memory create my-space --strategies semantic,episodic --region cn-southwest-2
# the plan tool canonicalizes to --output json and captures the one-time
# api_key to the 0600 key file; memory list/get/status verify it afterward
```

## Exit Codes Lie

agentarts 0.1.7 prints a full traceback and STILL exits 0 on failure. The
wrapper decides success by parsing output — measured signatures: Python
tracebacks, `- ERROR -` log lines, `Failed to …` operation errors,
`Aborted.` (EOF-aborted prompts), `× ERROR:` (the CLI's operation-error
echo: no data-plane endpoint, auth failure), and `Error building image:`
(deploy-stage docker build failure). Treat any `failureDetected: true` or
`ok: false` as failure regardless of `exitCode`.

## Restricted Networks — mirror-first (mainland-China default)

`launch` builds `FROM python:3.10-slim` on the LOCAL Docker daemon and the
generated Dockerfile pip-installs from pypi.org directly. On a China host,
mirror BOTH layers before launch (do not wait for a failure):

- Base image — pull via a mirror and retag to the canonical name so `FROM`
  resolves locally:
  `docker pull docker.m.daocloud.io/library/python:3.10-slim && docker tag docker.m.daocloud.io/library/python:3.10-slim python:3.10-slim`
  (a daemon-level `registry-mirrors` entry in `/etc/docker/daemon.json` is the
  cleaner default but needs sudo; the pull+retag works without it.)
- pip — point the build at the Huawei Cloud mirror via an overridable ARG in
  the Dockerfile:
  `ARG PIP_INDEX_URL=https://mirrors.huaweicloud.com/repository/pypi/simple`
  then `ENV PIP_INDEX_URL=${PIP_INDEX_URL}` (pip reads it automatically).
  Do NOT hardcode `-i <mirror>` inline: `agentarts config`/`init` REGENERATE
  the Dockerfile from a template with no mirror and will revert an inline edit.
  If the mirror returns `429`, use `https://repo.huaweicloud.com/repository/pypi/simple`.
- Add `.dockerignore` (`.venv/`, `__pycache__/`, `.git/`, `.agentarts_config.yaml`,
  helper scripts): smaller context, and it keeps the secret out of the image.

Why it matters beyond speed: the MCP client timeout is ~300s (opencode sets
`timeout: 300000` on the devkit server), while the wrapper allows `launch` 600s.
A cold build pulling from docker.io/pypi.org can exceed the client window,
returning JSON-RPC `-32001` with lost output and an ORPHANED build container
(the wrapper's own SIGKILL timer never fires because the client already gave
up). Pre-warming keeps `launch` well inside the window.

Runtime readiness after launch is asynchronous: an immediate invoke can
fail with "could not get access_endpoint" — retry after ~20s. With mirrors
warm, the docker build dominates deploy time (~1.5–3 min measured).

## First-run HOME Writes

The FIRST agentarts invocation (even `--help`) writes `~/.bashrc` (tab
completion source line), `~/.bash_completions/agentarts.sh`,
`~/.agentarts/.completion_shown`, and `~/.huaweicloud/application_id` (a
36-byte telemetry UUID sent as `app/<uuid>` in every request's User-Agent).
Warn the user before first use in their home; the E2E harness isolates these
via a scratch HOME.

## config Family Traps

- All config subcommands resolve `.agentarts_config.yaml` from the CURRENT
  WORKING DIRECTORY (no path flag) — pass `cwd` in the wrapper call.
- `config set` rewrites the yaml destructively: comments stripped, keys
  reordered, defaults materialized.
- `config set-env` / `config remove-env` CRASH on basic-template projects in
  0.1.7 (`TypeError` on a null env list; pre-write, nothing persisted). Edit
  the yaml directly instead — or use a template that ships env entries.
- `config set-env` is the documented way to persist
  `HUAWEICLOUD_SDK_AK`-style credentials into the yaml: treat the whole
  config family as credential-bearing (approved tier).

## Wrapper Timeout Defaults (measured)

`launch` 600s (the docker build dominates: ~2-3 min measured), `destroy`
300s, the invoke family 900s (upload/download included), everything else
120s (`exec-command`'s CLI-side `--timeout` default of 60s interacts with
this — see Runtime Sessions). Override per call with `timeoutMs`.
