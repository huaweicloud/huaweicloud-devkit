import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

import { obsConfigPath } from '../auth/credentials.ts';

// Remove the KooCLI (hcloud) binary and its config directory. Only touches the
// default install locations; a user-managed binary behind HCLOUD_BIN or a
// Windows PATH entry is left alone. Returns the list of removed paths.
export function removeKooCli(home: string = homedir()): string[] {
  const removed: string[] = [];

  for (const bin of [
    join(home, '.local', 'bin', 'hcloud'),
    join(home, 'hcloud', 'hcloud'),
    join(home, 'hcloud', 'hcloud.exe'),
  ]) {
    if (existsSync(bin)) {
      rmSync(bin, { force: true });
      removed.push(bin);
    }
  }

  const configDir = join(home, '.hcloud');
  if (existsSync(configDir)) {
    rmSync(configDir, { recursive: true, force: true });
    removed.push(configDir);
  }

  const installDir = join(home, 'hcloud');
  try {
    if (existsSync(installDir) && readdirSync(installDir).length === 0) {
      rmSync(installDir, { recursive: true, force: true });
      removed.push(installDir);
    }
  } catch {
    // Non-fatal: an empty-dir cleanup is best-effort.
  }

  return removed;
}

// Remove the OBS credential config (~/.obsutilconfig). Returns the removed
// path, or an empty array when the file did not exist.
export function removeObsConfig(): string[] {
  const p = obsConfigPath();
  if (!existsSync(p)) return [];
  rmSync(p, { force: true });
  return [p];
}
