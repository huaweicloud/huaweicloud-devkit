// The guard-side listing of a skills tree: the boot guard
// (verifySkillTree), the installer's doctor check, the build-time --check
// stray scan, and validate-package's skill gate all consume this one
// membership predicate, or one of them accepts a tree the others reject —
// hollow claimed dirs (name present, SKILL.md missing) and symlinked dirs
// were exactly that divergence. Membership is dir-or-symlink carrying a
// SKILL.md. Two deliberate divergences remain, both ownership-shaped, not
// guard-shaped: devkitOwnedSkillNames (setup-cli) and dsh-postinstall list
// RAW directories for what the devkit owns and may purge from native skill
// dirs — a hollow claimed dir still owns its native copies. Zod-free so
// every consumer graph — the bundled server, the zod-free installer, and
// the .mjs build scripts (Node >= 22.18 type stripping) — can import it.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export function listSkillDirs(root: string): string[] {
  if (!existsSync(root)) return [];
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((d) => (d.isDirectory() || d.isSymbolicLink()) && existsSync(join(root, d.name, 'SKILL.md')))
      .map((d) => d.name);
  } catch {
    return [];
  }
}

// Recursive byte equality between two skill dirs — doctor's native-copy
// freshness check compares an agent's native core copies against the
// payload that target actually runs; the install tests assert the same
// equality after a sync. False on any read failure: doctor reports
// divergence rather than passing a tree it could not fully read.
export function skillTreeEquals(a: string, b: string): boolean {
  try {
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory() ? walk(join(dir, entry.name)).map((f) => join(entry.name, f)) : [entry.name],
      );
    const fa = walk(a).sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
    const fb = walk(b).sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
    if (fa.length !== fb.length || fa.some((f, i) => f !== fb[i])) return false;
    return fa.every((rel) => readFileSync(join(a, rel)).equals(readFileSync(join(b, rel))));
  } catch {
    return false;
  }
}
