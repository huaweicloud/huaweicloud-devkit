# Secret Vault Usage

The devkit ships a local encrypted secret vault. Secrets live under `secret://<scope>/<name>` refs (both segments lowercase `[a-z0-9-]`, max 64 chars); the ciphertext is AES-256-GCM under a master key held by the OS keychain (or a 0600 keyfile fallback on headless machines). Refs are safe to show in the conversation; values are not.

## What the agent may do

- Store a secret the user deliberately provides: `huaweicloud_secret_set` with `channel=value` (value visible in conversation — last resort) or `channel=file` / `channel=envVar`.
- Inventory: `huaweicloud_secret_list` (refs, versions, fingerprints; never values).
- Delete: `huaweicloud_secret_delete` (idempotent; `removed: 0` usually means a typo).
- Consume a secret in a child process: `npx huaweicloud-devkit secret exec --env NAME=secret://user/token -- <command>` (no shell, no echo; the value reaches only the child's environment).

## What the agent must not do

- Never run `secret get` (with or without `--stdout`) through the Bash tool — the PreToolUse hook denies it because it prints the plaintext into this conversation. `secret get` is the user's terminal command.
- Never wrap hcloud in `secret exec`; hcloud writes go through `huaweicloud_run_approved_command` only.
- Never paste a secret value into files, logs, command text, or tool arguments when a ref exists.

## Recommended onboarding flow

1. In their own terminal, the user runs: `npx huaweicloud-devkit secret set secret://user/hw-ak --stdin` (or `--file`/`--env`), typing or piping the value. The plaintext never enters the conversation.
2. The S1 credential file (`~/.config/huaweicloud/credentials.json`) may reference the ref directly: `{"ak": "secret://user/hw-ak", "sk": "secret://user/hw-sk"}`. The credential resolver decrypts at read time; `auth sync`, `auth_status`, and OBS setup consume the resolved values, so refs never leak into `~/.obsutilconfig` or the KooCLI profile.
3. For sandbox injection, `huaweicloud_sandbox_credentials` accepts a vault ref as `api_key`.

## Honest security boundary

The vault defends: secrets at rest (encrypted files, 0600), refs instead of values in context, and secrets kept out of child-process argv.

It does NOT defend against: the user pasting a plaintext secret into the conversation (store it, then use the ref); a same-user malicious process (it can read a keyfile-tier master key and any plaintext a legit process has in memory); a child process printing its own environment (its stdout is the conversation — pick children you trust); `$(secret get ... --stdout)` command substitution putting the value into the child's argv (visible in `ps`); shell indirection building the reveal (`S=get; ... secret $S ...`, `${X:-secret}`) — obfuscated spellings using `$'`, `$(`, or backticks near cloud commands are DENIED as obfuscation, but variable indirection remains a documented residual a text gate cannot see through; filtered env dumps (`env | grep -i key` — the family gate matches credential names, not arbitrary filter words); or memory forensics. This is not an HSM.

Residuals worth knowing: if `HW_VAULT_MASTER_KEY` is set, it outranks the keychain — two different keys means decrypt failures, and the error will say so. A GCM failure on read means the master key changed or the file was tampered with. Rotation (`set` with new content) discards the previous value; there is no version history.
