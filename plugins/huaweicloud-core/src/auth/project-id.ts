import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

function hcloudCommand(args: string[]): { file: string; args: string[] } {
  const bin = process.env.HCLOUD_BIN || 'hcloud';
  // Test doubles (and exotic setups) may point HCLOUD_BIN at a Node script;
  // those must be launched through node instead of the shell.
  if (/\.(mjs|cjs|js)$/i.test(bin) && existsSync(bin)) {
    return { file: process.execPath, args: [bin, ...args] };
  }
  return { file: bin, args };
}

function runHcloud(args: string[], timeoutMs: number = 20000): ReturnType<typeof spawnSync> {
  const { file, args: spawnArgs } = hcloudCommand(args);
  return spawnSync(file, spawnArgs, {
    windowsHide: true,
    stdio: 'pipe',
    timeout: timeoutMs,
  });
}

export interface ProjectIdResult {
  ok: boolean;
  reason?: string;
  projectId?: string;
}

interface IamProject {
  id: string;
  name?: unknown;
}

// One-property reads off unknown, validated before use: only an object with a
// non-empty string id is treated as a project (IAM project ids are strings).
function toIamProject(value: unknown): IamProject | null {
  if (!value || typeof value !== 'object') return null;
  const id = (value as { id?: unknown }).id;
  if (typeof id !== 'string' || id === '') return null;
  return { id, name: (value as { name?: unknown }).name };
}

/**
 * Resolve the project_id for `region` via IAM KeystoneListProjects using the
 * credentials already stored in the KooCLI profile, then write it back with
 * `hcloud configure set --cli-project-id=<id>`. Read-only discovery + local
 * config write only - no secrets appear in process arguments because the
 * profile carries the credentials.
 *
 * Best-effort by design: any failure returns { ok: false, reason } and never
 * throws, so callers can stay non-fatal.
 */
export function resolveAndApplyProjectId({
  region,
  profile,
}: { region?: string; profile?: string } = {}): ProjectIdResult {
  if (!region) return { ok: false, reason: 'region is required' };
  const profileArgs = profile ? [`--cli-profile=${profile}`] : [];
  try {
    const list = runHcloud([
      'IAM',
      'KeystoneListProjects',
      ...profileArgs,
      `--cli-region=${region}`,
      `--name=${region}`,
    ]);
    if (list.status !== 0) {
      return { ok: false, reason: `KeystoneListProjects failed (exit ${list.status})` };
    }
    let projects: unknown[] | null = null;
    try {
      const parsed: unknown = JSON.parse(String(list.stdout || ''));
      const candidate = Array.isArray(parsed) ? parsed : (parsed as { projects?: unknown } | null)?.projects;
      projects = Array.isArray(candidate) ? candidate : null;
    } catch {
      return { ok: false, reason: 'could not parse KeystoneListProjects output' };
    }
    if (!projects || projects.length === 0) {
      return { ok: false, reason: `no projects found for region ${region}` };
    }
    const usable = projects.map((p) => toIamProject(p)).filter((p): p is IamProject => p !== null);
    if (usable.length === 0) return { ok: false, reason: 'project list contained no usable ids' };
    const match = usable.find((p) => p.name === region) ?? usable[0];

    const set = runHcloud(['configure', 'set', ...profileArgs, `--cli-project-id=${match.id}`]);
    if (set.status !== 0) {
      return { ok: false, reason: `configure set --cli-project-id failed (exit ${set.status})` };
    }
    return { ok: true, projectId: match.id };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}
