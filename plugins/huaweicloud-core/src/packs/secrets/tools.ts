import { readFileSync } from 'node:fs';
import { z } from 'zod';

import { vaultDelete, vaultList, vaultSet } from '../../lib/secret-vault/store.ts';
import { isCredentialEnvVarName, SECRET_REF_PATTERN } from '../../lib/secret-vault/refs.ts';
import { isCredentialFilePath } from '../../safety-policy.ts';
import type { PackToolDefinition, LooseToolSchema } from '../../lib/pack-types.ts';
import type { CallToolOptions, ToolArgs } from '../../tools.ts';

// The secrets pack: vault writes and inventory through MCP. There is
// deliberately NO value-retrieval tool — plaintext never crosses the MCP
// face; the Bash-side `secret exec` (child-process env only) is the
// sanctioned consumption path, and `secret get` is the user's terminal
// command (the PreToolUse policy denies it on the agent Bash face).

async function handleSecretSet(args: ToolArgs = {}, _opts: CallToolOptions = {}) {
  const ref = String(args.ref || '');
  const channel = String(args.channel || '');
  let plaintext: string;
  if (channel === 'value') {
    plaintext = String(args.value ?? '');
  } else if (channel === 'file') {
    const path = String(args.file || '');
    if (!path) throw new Error('channel=file requires the file argument.');
    // The Bash face denies reads of credential files (credentialFilePatterns
    // in safety/policy.json); this MCP face must not become a laundering
    // route around that deny. Same vocabulary, one policy source.
    if (isCredentialFilePath(path)) {
      throw new Error(
        `refusing to read ${path}: it matches the protected credential-file patterns. Huawei Cloud credentials belong to the auth tools (huaweicloud_auth_init / auth_switch), not the secret vault.`,
      );
    }
    try {
      plaintext = readFileSync(path, 'utf8').replace(/\r?\n$/, '');
    } catch (error) {
      throw new Error(`cannot read file ${path}: ${error instanceof Error ? error.message : String(error)}`, {
        cause: error,
      });
    }
  } else if (channel === 'envVar') {
    const name = String(args.envVar || '');
    if (!name) throw new Error('channel=envVar requires the envVar argument.');
    if (isCredentialEnvVarName(name)) {
      throw new Error(
        `refusing to store the credential environment variable ${name}: harvesting the MCP server's own credential env into the vault would bypass the Bash-face dump gates. Manage Huawei Cloud credentials with the auth tools (huaweicloud_auth_init / auth_switch) instead.`,
      );
    }
    const value = process.env[name];
    if (value === undefined || value === '') {
      throw new Error(`environment variable ${name} is not set in the MCP server process.`);
    }
    plaintext = value;
  } else {
    throw new Error('channel must be one of: value, file, envVar.');
  }
  const note = args.note === undefined ? undefined : String(args.note);
  const result = vaultSet(ref, plaintext, note);
  return {
    ref,
    status: result.status,
    version: result.version,
    fingerprint: result.fingerprint,
    hint:
      result.status === 'set' && result.version > 1
        ? 'existing secret rotated; the previous value is gone (no version history).'
        : undefined,
  };
}

async function handleSecretList(args: ToolArgs = {}, _opts: CallToolOptions = {}) {
  const scope = args.scope === undefined ? undefined : String(args.scope);
  const secrets = vaultList(scope);
  return { count: secrets.length, secrets };
}

async function handleSecretDelete(args: ToolArgs = {}, _opts: CallToolOptions = {}) {
  const ref = String(args.ref || '');
  const { removed } = vaultDelete(ref);
  return { ref, removed };
}

const secretRefField = z
  .string()
  .regex(SECRET_REF_PATTERN, 'must be secret://<scope>/<name>; both segments lowercase [a-z0-9-] (max 64 chars)');

const secretSetSchema = z.looseObject({
  ref: secretRefField.describe('Vault ref to store or rotate, e.g. secret://user/hw-sk.'),
  channel: z
    .enum(['value', 'file', 'envVar'])
    .describe(
      'How the plaintext arrives. value passes it as a tool argument (it enters the conversation — only use when the user deliberately pastes the secret). file reads a path on the MCP server host (one trailing newline is stripped). envVar reads a variable from the MCP server environment.',
    ),
  value: z
    .string()
    .optional()
    .describe('Plaintext for channel=value. Visible in the conversation; prefer file/envVar.'),
  file: z.string().optional().describe('File path for channel=file, read by the MCP server process.'),
  envVar: z.string().optional().describe('Variable name for channel=envVar, read from the MCP server environment.'),
  note: z.string().optional().describe('Free-form note surfaced by secret list.'),
});

const secretListSchema = z.looseObject({
  scope: z.string().optional().describe('Restrict to one scope; omit to list all scopes.'),
});

const secretDeleteSchema = z.looseObject({
  ref: secretRefField.describe('Vault ref to delete.'),
});

export const SECRETS_TOOLS = [
  {
    name: 'huaweicloud_secret_set',
    description:
      'Store or rotate a secret in the local encrypted vault under a secret://<scope>/<name> ref and get back the ref, version, and keyed fingerprint — never the value. Storing identical content is a no-op; changed content rotates (version increments, previous value gone). Delivery channels: value (plaintext as a tool argument — it enters the conversation, use only when the user deliberately pastes the secret), file (a path the MCP server reads), envVar (a variable from the MCP server environment).',
    schema: secretSetSchema,
    handler: handleSecretSet,
  },
  {
    name: 'huaweicloud_secret_list',
    description:
      'List stored secret refs, optionally within one scope, with version, update time, note, and keyed fingerprint. Reads only the encrypted envelopes; never decrypts and never returns secret values.',
    schema: secretListSchema,
    handler: handleSecretList,
  },
  {
    name: 'huaweicloud_secret_delete',
    description:
      'Delete one secret from the local vault by ref. Idempotent: removed=1 when a secret was deleted, removed=0 when the ref was not stored (usually a typo in the ref — check with huaweicloud_secret_list).',
    schema: secretDeleteSchema,
    handler: handleSecretDelete,
  },
] as const satisfies readonly PackToolDefinition[];

export type SecretsToolName = (typeof SECRETS_TOOLS)[number]['name'];

export const SECRETS_TOOL_SCHEMAS: Readonly<Record<SecretsToolName, LooseToolSchema>> = {
  huaweicloud_secret_set: secretSetSchema,
  huaweicloud_secret_list: secretListSchema,
  huaweicloud_secret_delete: secretDeleteSchema,
};

export const SECRETS_TOOL_HANDLERS: Readonly<Record<SecretsToolName, PackToolDefinition['handler']>> = {
  huaweicloud_secret_set: handleSecretSet,
  huaweicloud_secret_list: handleSecretList,
  huaweicloud_secret_delete: handleSecretDelete,
};
