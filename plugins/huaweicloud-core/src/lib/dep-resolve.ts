import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

import type { DependencyResolution } from './dependency-model.ts';

// The single resolution chain for host binaries, consumed by install-time
// provisioning (src/dep/provision.ts) and spawn-time resolution
// (src/packs/huaweicloud-open-mcp/sidecar.ts, src/hcloud-probe.ts) alike, so
// the binary that was installed is the binary that runs. Like
// dependency-model.ts, this module's runtime import graph stays at zero
// beyond node builtins plus a type-only edge: dist/setup-cli.js runs
// unbundled from plain tsc output and must never pull the zod chain.
//
// Tier order, first hit wins:
//   env       env[envBin], honored only when the file exists (the
//             findHcloudBin / resolveGatewayCommand rule: a stale override
//             falls through instead of breaking every spawn)
//   candidate platform candidates, '~'-prefixed ones expanded against the
//             platform home (win32 homedir(); unix env.HOME || homedir() —
//             the hermetic-test convention, now the one rule)
//   path      PATH lookup via where.exe (win32) / sh -c 'command -v'
//             (otherwise), ~5s timeout, the caller's env passed through
//   fallback  run <command> <argsPrefix...> with no persistent install: the
//             fallback COMMAND is resolved itself first (its ~/.local/bin
//             candidate before PATH — uvx typically lives there while the
//             agent harness PATH misses it), then argsPrefix is appended
//
// Returns null when nothing resolves. Callers that need a bare-name last
// resort (resolveHcloudCommand's 'hcloud') synthesize it themselves; this
// chain only reports what actually exists.

export type ResolutionTier = 'env' | 'candidate' | 'path' | 'fallback';

export interface ResolvedDependency {
  command: string;
  argsPrefix: readonly string[];
  tier: ResolutionTier;
}

function platformHome(env: NodeJS.ProcessEnv): string {
  return process.platform === 'win32' ? homedir() : env.HOME || homedir();
}

// Candidates are documented as places the binary itself lives, so the
// basename of the first platform candidate is the binary's name for the
// PATH lookup (minus the win32 .exe suffix — where.exe matches PATHEXT).
function pathLookupName(resolution: DependencyResolution): string | null {
  const candidates = process.platform === 'win32' ? resolution.candidates.win32 : resolution.candidates.unix;
  if (candidates.length === 0) return null;
  // Length was just checked; index 0 is defined.
  const raw = basename(candidates[0]!);
  return process.platform === 'win32' && raw.endsWith('.exe') ? raw.slice(0, -4) : raw;
}

export function lookupOnPath(name: string, env: NodeJS.ProcessEnv): string | null {
  // POSIX `command -v` is a shell builtin, always present — an external
  // `which` binary is not (slim containers ship without it, silently
  // nulling the path tier). Names arrive from the DEPENDENCIES catalog
  // basenames and internal literals only, never user input; passing the
  // name positionally as $1 instead of interpolating it into the script
  // makes that safety a property of the call itself, not of every
  // caller's discipline.
  const lookup =
    process.platform === 'win32'
      ? spawnSync('where.exe', [name], { encoding: 'utf8', timeout: 5000, env })
      : spawnSync('sh', ['-c', 'command -v "$1"', 'sh', name], { encoding: 'utf8', timeout: 5000, env });
  const hit = lookup.status === 0 ? (lookup.stdout || '').trim().split('\n')[0] : '';
  return hit || null;
}

export function resolveDependencyCommand(
  resolution: DependencyResolution,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedDependency | null {
  const envBin = env[resolution.envBin];
  if (envBin && existsSync(envBin)) return { command: envBin, argsPrefix: [], tier: 'env' };

  const home = platformHome(env);
  const candidates = process.platform === 'win32' ? resolution.candidates.win32 : resolution.candidates.unix;
  for (const candidate of candidates) {
    const expanded = candidate.startsWith('~') ? join(home, candidate.slice(1)) : candidate;
    if (existsSync(expanded)) return { command: expanded, argsPrefix: [], tier: 'candidate' };
  }

  const name = pathLookupName(resolution);
  const onPath = name === null ? null : lookupOnPath(name, env);
  if (onPath) return { command: onPath, argsPrefix: [], tier: 'path' };

  if (resolution.fallback) {
    const exeSuffix = process.platform === 'win32' ? '.exe' : '';
    const localCandidate = join(home, '.local', 'bin', `${resolution.fallback.command}${exeSuffix}`);
    const fallbackCommand = existsSync(localCandidate)
      ? localCandidate
      : lookupOnPath(resolution.fallback.command, env);
    if (fallbackCommand) {
      return { command: fallbackCommand, argsPrefix: resolution.fallback.argsPrefix, tier: 'fallback' };
    }
  }
  return null;
}
