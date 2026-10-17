// Pure roster extraction for the .manifest.json that travels with the
// generated skills tree. Kept free of fs access and of the registry import
// so the zod-free setup-cli graph and the tests share one parser: doctor
// reads the manifest as its roster of record (it cannot import the
// zod-dependent registry), and the unit tests exercise the malformed-input
// branches a spawned CLI test cannot reach cheaply.

export function parseSkillManifest(content: string): string[] {
  try {
    const parsed: unknown = JSON.parse(content);
    const skills = (parsed as { skills?: unknown } | null)?.skills;
    // Dedupe: a tampered manifest with duplicate names must not satisfy a
    // size-equality check by inflating the expected count.
    return Array.isArray(skills) ? [...new Set(skills.filter((name): name is string => typeof name === 'string'))] : [];
  } catch {
    return [];
  }
}

// The per-skill pack claims (skill name -> pack id). Distinct from the roster
// parser on purpose: callers of this map fail loud on a manifest without
// usable pack info (the native-skill sync must not silently derive an empty
// core set, which would invert the narrowed purge into deleting the very
// copies it owns), so absence and malformation return null instead of [].
export function parseSkillPackMap(content: string): Record<string, string> | null {
  try {
    const parsed: unknown = JSON.parse(content);
    const packOf = (parsed as { packOf?: unknown } | null)?.packOf;
    if (packOf === null || typeof packOf !== 'object' || Array.isArray(packOf)) return null;
    const map: Record<string, string> = {};
    for (const [name, pack] of Object.entries(packOf)) {
      if (typeof pack !== 'string') return null;
      map[name] = pack;
    }
    return map;
  } catch {
    return null;
  }
}

// The core-pack skill names a manifest discloses for native placement —
// the single derivation every consumer (installer, doctor, tests) shares.
// Null on any unusable input so callers fail loud (install/update) or warn
// (doctor) instead of silently deriving an empty core set, which would
// invert the native cleanup into deleting the copies it owns.
export function parseCoreSkillNames(content: string): Set<string> | null {
  const packOf = parseSkillPackMap(content);
  if (packOf === null) return null;
  const core = new Set(
    Object.entries(packOf)
      .filter(([, pack]) => pack === 'core')
      .map(([name]) => name),
  );
  return core.size > 0 ? core : null;
}
