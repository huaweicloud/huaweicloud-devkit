# AgentArts Credentials (agentarts-sdk 0.1.7)

## How credentials reach the CLI

The devkit runtime credential state (`huaweicloud_auth_init`) is the ONLY
injection source. When `huaweicloud_agentarts_run_readonly_command` or
`huaweicloud_agentarts_run_approved_command` spawns the CLI, it builds an
ALLOWLIST child environment (PATH, HOME, locale, proxy) and injects
`HUAWEICLOUD_SDK_AK` / `HUAWEICLOUD_SDK_SK` from the runtime state:

- The SK is never written to disk, never placed in the agent's own shell
  environment, and never echoed in tool output (redaction masks
  `ak:`/`sk:`/`api_key:` shapes).
- Ambient environment variables are NOT inherited: the child sees only the
  allowlist, so stray credentials or unrelated variables cannot leak in or
  out.
- `--bearer-token` / `-bt` is rejected outright by the wrapper: argv is
  process-list visible.

## The auth chain (measured)

`HUAWEICLOUD_SDK_AK/SK` env → `~/.huaweicloud/credentials` profile (or
`HUAWEICLOUD_SDK_CREDENTIALS_FILE`) → cloud metadata (last, 3s+3s). Two
consequences:

- Without devkit credentials the wrapper REJECTS the run outright (the
  env-or-fail contract): a clear error pointing at `huaweicloud_auth_init`,
  never a silent profile hit. When credentials ARE held, injection
  REPLACES, so commands run with exactly the credentials the devkit holds
  (and the profile chain is neutralized via
  HUAWEICLOUD_SDK_CREDENTIALS_FILE=/dev/null as defense in depth).
- A metadata 404 warning in output means env AND profile both failed — it is
  a failure signature, not noise.
- A bare-shell (non-wrapper) run that answers `AgentArts.00000144 The
current user status is unassigned` is a credential-SOURCE signal, not an
  account-status signal (measured 2026-10-29: the CLI had fallen back to
  the profile/metadata chain and that credential had no AgentArts access;
  the same account succeeded immediately once credentials arrived via
  `HUAWEICLOUD_SDK_AK/SK`). Diagnose the source, not the user — through
  the devkit that means `huaweicloud_auth_init`; in the user's terminal,
  their own explicit delivery, never an `export` of the SK (history +
  transcript).

## Degraded paths (when the wrapper cannot run)

- The user runs the command in their own terminal with their own credentials.
- `npx huaweicloud-devkit doctor` reports the agentarts environment
  (CLI presence, pinned version 0.1.7, Python 3.10+, Docker for launch).
- NEVER teach `export HUAWEICLOUD_SDK_AK=…` in a shell — that puts the SK
  into shell history and the agent transcript (see
  `huaweicloud-cli-and-auth`).

## Exfiltration trap: .agentarts_config.yaml

`agentarts config set-env` is the documented way to persist variables (its
own help example is `config set-env HUAWEICLOUD_SDK_AK your-ak`) into the
project-local yaml, and `launch` ships that yaml (including
`runtime.environment_variables`) to the cloud runtime. Therefore:

- Treat the whole config family as credential-bearing (approved tier).
- Model API keys and third-party secrets (e.g. `OPENAI_API_KEY`) placed in
  `environment_variables` are deployed to the cloud with the agent — only
  put there what the deployed agent genuinely needs, and say so to the user.
- Reading `.agentarts_config.yaml` via Bash is hook-blocked
  (credentialFilePatterns); the config subcommands are the supported path.
- 0.1.7 trap: `config set-env`/`remove-env` CRASH on basic-template projects
  (null env list) — edit the yaml directly in that case.

## Injecting a secret without putting it in argv

`config set-env KEY VALUE` puts the secret in the process argument list and in
the agent transcript. To set `runtime.environment_variables[].value` without
argv exposure, edit the project YAML through the YAML library:

- read the secret from a file the user controls (`chmod 600`, e.g.
  `/tmp/maas_key.txt`), from stdin, or from an env var the agent already holds;
- `yaml.safe_load` the config → set the value → `yaml.safe_dump` to a temp file
  → `os.replace` into place (atomic) → `chmod 600` the config;
- verify by re-parsing and comparing the value, printing only a boolean/length
  (never the secret), and exit non-zero on mismatch.

Do NOT edit the YAML with line/`sed`-style surgery: values containing `#`, a
colon-space sequence, or a leading YAML indicator character corrupt the file,
and a layout change becomes a silent no-op. Do NOT `export` the secret (shell
history + transcript).

## Build context leak (COPY . . bakes the secret into the image)

`launch` builds with `docker build ... .` from the project dir, so the project
`.agentarts_config.yaml` — now holding the secret — is inside the build context.
The generated Dockerfile ends with `COPY . .`, which copies it into an image
layer that is then PUSHED TO SWR. The runtime receives env vars from the CLI's
parsed YAML, not from the image, so the file is not needed inside the image:

- add `.agentarts_config.yaml` (and any local helper scripts) to `.dockerignore`;
- if a secret was ever deployed before this was in place, **rotate it** — the
  earlier image is already in the registry.

## Memory data-plane key (measured lifecycle, PR11)

`memory create` authenticates on the CONTROL plane (AK/SK via the
wrapper's env injection) and returns a ONE-TIME data-plane `api_key`. The
create REQUIRES `--strategies` — at least one built-in strategy
(semantic, episodic, user_preference, summary — e2e-measured; event —
enum-evidenced only) or the server answers HTTP 400 [AgentArts.01010400]
after the CLI has already created an orphan API key (key-before-space
order); the plan tool rejects a missing value before any cloud call. Only
the `--output json` branch prints it (the table branch prints Space
ID/Status and the key is lost forever), so the wrapper canonicalizes
create to `--output json` and REJECTS an explicit non-json `--output` at
plan time. Lifecycle:

- On a successful create the wrapper captures the key from the raw
  (pre-redaction) output and writes it to
  `~/.config/huaweicloud/agentarts-memory-api-key-<space_id>.txt`
  (0600, honors `HUAWEICLOUD_HOME`). The returned payload stays redacted
  and carries only `memoryApiKeyFile` (the path, never the key).
- Reading the file via Bash is hook-blocked: credentialFilePatterns
  matches the `agentarts-memory-api-key` filename component (the
  `~/.config/huaweicloud` state root is NOT itself matched — the filename
  pattern is what denies `cat`/`head`/redirect reads). That is defense in
  depth, not an error; the agent must never `cat` it into the transcript.
- Data-plane consumption through the devkit: the
  `huaweicloud_agentarts_memory_read` tool reads the 0600 key file
  server-side and injects `HUAWEICLOUD_SDK_MEMORY_API_KEY` into the SDK
  child process env only (never argv, never the transcript). Outside the
  devkit, the user injects the env var themselves the same argv-free way
  as any other secret (see the yaml recipe above); echoing
  `$HUAWEICLOUD_SDK_MEMORY_API_KEY` is hook-blocked.
- `memory delete --force` is irreversible (deletes the space and its
  sessions/messages/memories); the wrapper canonicalizes `--force` and
  the approval carries the `irreversible` label.
