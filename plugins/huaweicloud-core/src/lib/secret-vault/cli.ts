import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, chmodSync } from 'node:fs';

import { vaultDelete, vaultGet, vaultList, vaultSet, VaultError } from './store.ts';
import { isCredentialEnvVarName, isSecretRef } from './refs.ts';

// The `npx huaweicloud-devkit secret ...` command family. Plaintext reaches
// stdout ONLY through `get --stdout` (the explicit reveal flag — the
// PreToolUse policy denies bare `secret get` on the agent Bash face, so this
// is the user-terminal path) and reaches child processes only through
// `exec --env NAME=<ref>` (no shell, no echo). `exec` refuses hcloud children
// outright: the CLI approval chain (huaweicloud_run_approved_command) is the
// only sanctioned hcloud write path, including on agents whose platforms ship
// no hooks.

const USAGE = `Usage: npx huaweicloud-devkit secret <command> [options]

Manage the local encrypted secret vault (secret://<scope>/<name> refs).

Commands:
  set <ref> (--file <path> | --env <VAR> | --stdin | --value <v>) [--note <text>]
      Store or rotate a secret. --file/--env/--stdin keep the value out of
      shell history and the process list; --value is visible in both.
  get <ref> (--file <path> | --stdout)
      Resolve a ref. Default is an error: printing a secret to stdout
      requires the explicit --stdout flag (for $(...) substitution); writing
      it to a 0600 file uses --file.
  list [<scope>]
      Show refs with version, update time, note, and fingerprint. Never
      decrypts.
  rm <ref>
      Delete one secret. Prints "removed: <n>" so a typo shows as 0.
  exec (--env NAME=<ref-or-literal>)... -- <command> [args...]
      Run a command with resolved secrets injected into its environment.
      No shell, no echo; the values never appear in output or argv.
      hcloud children are refused — use the MCP approval chain for hcloud.`;

function fail(message: string, code = 1): number {
  console.error(`secret: ${message}`);
  return code;
}

function vaultMessage(error: unknown): string {
  if (error instanceof VaultError) return `${error.message} (${error.code})`;
  return error instanceof Error ? error.message : String(error);
}

function parseArgv(argv: string[]): { positional: string[]; flags: Map<string, string>; error?: string } {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  const valueFlags = new Set(['--file', '--env', '--value', '--note']);
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token === '--') {
      positional.push(...argv.slice(i + 1));
      return { positional, flags };
    }
    if (token.startsWith('--')) {
      const eq = token.indexOf('=');
      if (eq > 0) {
        flags.set(token.slice(0, eq), token.slice(eq + 1));
        continue;
      }
      if (valueFlags.has(token)) {
        const value = argv[i + 1];
        if (value === undefined) return { positional, flags, error: `${token} requires a value` };
        flags.set(token, value);
        i++;
        continue;
      }
      flags.set(token, '');
      continue;
    }
    positional.push(token);
  }
  return { positional, flags };
}

function readPlaintextChannel(flags: Map<string, string>): { value?: string; error?: string } {
  const channels = ['--file', '--env', '--stdin', '--value'].filter((flag) => flags.has(flag));
  if (channels.length === 0) return { error: 'one of --file, --env, --stdin, --value is required' };
  if (channels.length > 1) return { error: `pick exactly one channel, got: ${channels.join(' ')}` };
  const channel = channels[0]!;
  if (channel === '--value') {
    console.error(
      'secret: warning: --value is visible in the process list and shell history; prefer --file, --env, or --stdin.',
    );
    return { value: flags.get('--value') || '' };
  }
  if (channel === '--file') {
    try {
      return { value: readFileSync(flags.get('--file')!, 'utf8').replace(/\r?\n$/, '') };
    } catch (error) {
      return { error: `cannot read --file: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
  if (channel === '--env') {
    const name = flags.get('--env')!;
    if (isCredentialEnvVarName(name)) {
      return {
        error: `refusing to store the credential environment variable ${name}: harvesting credential env into the vault would bypass the Bash-face dump gates. Manage Huawei Cloud credentials with the auth commands (npx huaweicloud-devkit auth init) instead.`,
      };
    }
    const value = process.env[name];
    if (value === undefined || value === '') return { error: `environment variable ${name} is not set` };
    return { value };
  }
  try {
    return { value: readFileSync(0, 'utf8').replace(/\r?\n$/, '') };
  } catch {
    return { error: 'cannot read stdin' };
  }
}

function isHcloudChild(child: string): boolean {
  const base = child.replaceAll('\\', '/').split('/').pop() || child;
  const lowered = base.toLowerCase();
  return lowered === 'hcloud' || lowered === 'hcloud.exe';
}

export function runSecretCommand(argv: string[]): number {
  const sub = argv[0] || '';
  const rest = argv.slice(1);

  if (sub === '' || sub === 'help' || sub === '--help' || sub === '-h') {
    console.log(USAGE);
    return sub === '' ? 2 : 0;
  }

  if (sub === 'set') {
    const { positional, flags, error } = parseArgv(rest);
    if (error) return fail(error, 2);
    const ref = positional[0];
    if (!ref || positional.length > 1)
      return fail('usage: secret set <ref> (--file|--env|--stdin|--value) [--note <text>]', 2);
    const channel = readPlaintextChannel(flags);
    if (channel.error) return fail(channel.error, 2);
    try {
      const result = vaultSet(ref, channel.value!, flags.get('--note'));
      console.log(
        result.status === 'unchanged'
          ? `${ref}: unchanged (version ${result.version}, fingerprint ${result.fingerprint})`
          : `${ref}: ${result.version === 1 ? 'stored' : 'rotated'} (version ${result.version}, fingerprint ${result.fingerprint})`,
      );
      return 0;
    } catch (error) {
      return fail(vaultMessage(error));
    }
  }

  if (sub === 'get') {
    const { positional, flags, error } = parseArgv(rest);
    if (error) return fail(error, 2);
    const ref = positional[0];
    if (!ref || positional.length > 1) return fail('usage: secret get <ref> (--file <path> | --stdout)', 2);
    const channels = ['--file', '--stdout'].filter((flag) => flags.has(flag));
    if (channels.length === 0) {
      return fail(
        'refusing to print a secret to stdout — pass --stdout explicitly (for $(...) substitution) or --file <path>',
        2,
      );
    }
    if (channels.length > 1) return fail(`pick exactly one destination, got: ${channels.join(' ')}`, 2);
    try {
      const secret = vaultGet(ref);
      if (flags.has('--stdout')) {
        process.stdout.write(`${secret.value}\n`);
        return 0;
      }
      const path = flags.get('--file')!;
      writeFileSync(path, secret.value, { encoding: 'utf8', mode: 0o600 });
      // writeFileSync's mode applies only at creation; enforce 0600 on a
      // pre-existing target before claiming it.
      chmodSync(path, 0o600);
      console.error(`secret: written to ${path} (0600, version ${secret.version})`);
      return 0;
    } catch (error) {
      return fail(vaultMessage(error));
    }
  }

  if (sub === 'list') {
    const { positional, error } = parseArgv(rest);
    if (error) return fail(error, 2);
    if (positional.length > 1) return fail('usage: secret list [<scope>]', 2);
    try {
      const entries = vaultList(positional[0]);
      if (entries.length === 0) {
        console.log('no secrets stored');
        return 0;
      }
      for (const entry of entries) {
        const note = entry.note ? `  ${entry.note}` : '';
        console.log(`${entry.ref}  v${entry.version}  ${entry.updated}${note}`);
      }
      return 0;
    } catch (error) {
      return fail(vaultMessage(error));
    }
  }

  if (sub === 'rm') {
    const { positional, error } = parseArgv(rest);
    if (error) return fail(error, 2);
    const ref = positional[0];
    if (!ref || positional.length > 1) return fail('usage: secret rm <ref>', 2);
    try {
      const { removed } = vaultDelete(ref);
      console.log(`removed: ${removed}`);
      return 0;
    } catch (error) {
      return fail(vaultMessage(error));
    }
  }

  if (sub === 'exec') {
    const dd = rest.indexOf('--');
    if (dd < 0) return fail('usage: secret exec (--env NAME=<ref>)... -- <command> [args...]', 2);
    const flagTokens = rest.slice(0, dd);
    const child = rest.slice(dd + 1);
    if (child.length === 0) return fail('no command after --', 2);
    if (isHcloudChild(child[0]!)) {
      return fail(
        'secret exec refuses hcloud children — hcloud commands must go through the MCP approval chain (huaweicloud_run_approved_command)',
        2,
      );
    }
    const env: Record<string, string> = {};
    const consumed = new Set<number>();
    for (let i = 0; i < flagTokens.length; i++) {
      const token = flagTokens[i]!;
      if (token !== '--env') continue;
      const pair = flagTokens[i + 1];
      if (pair === undefined || !pair.includes('=')) return fail('--env requires NAME=<ref-or-literal>', 2);
      const eq = pair.indexOf('=');
      const name = pair.slice(0, eq);
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return fail(`invalid environment variable name "${name}"`, 2);
      env[name] = pair.slice(eq + 1);
      consumed.add(i);
      consumed.add(i + 1);
      i++;
    }
    const remaining = flagTokens.filter((_token, index) => !consumed.has(index));
    if (remaining.length > 0) return fail(`unexpected arguments before --: ${remaining.join(' ')}`, 2);
    for (const [name, value] of Object.entries(env)) {
      if (!isSecretRef(value)) continue;
      try {
        env[name] = vaultGet(value).value;
      } catch (error) {
        return fail(`cannot resolve ${value} for ${name}: ${vaultMessage(error)}`);
      }
    }
    const result = spawnSync(child[0]!, child.slice(1), {
      stdio: 'inherit',
      shell: false,
      windowsHide: true,
      env: { ...process.env, ...env },
    });
    if (result.error) {
      const code = (result.error as NodeJS.ErrnoException).code;
      return fail(`cannot run ${child[0]}${code === 'ENOENT' ? ' (not found)' : ''}: ${result.error.message}`, 127);
    }
    if (result.signal) return 128;
    return result.status ?? 1;
  }

  fail(`unknown subcommand "${sub}"`, 2);
  console.error(USAGE);
  return 2;
}
