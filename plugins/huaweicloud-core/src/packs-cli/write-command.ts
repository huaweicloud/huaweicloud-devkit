// The `packs` set-math write modes (enable/disable/all), extracted from
// setup-cli.ts. The status face and target selection live in
// packs-cli/commands.ts; the slot table in packs-cli/slots.ts.

import { parseDevkitPacks } from '../lib/dependency-model.ts';
import { PACK_IDS, type PackId } from '../lib/pack-types.ts';
import { parsePackIdList } from '../packs-policy.ts';
import { codexPluginProbe } from '../codex-probe.ts';
import {
  resolvePacksCommandTarget,
  warnPacksUnknownIds,
  printPacksUsage,
  renderCodexPacksWriteNote,
} from './commands.ts';

export function joinPackIds(ids: Iterable<PackId>): string {
  const set = new Set(ids);
  return PACK_IDS.filter((id) => set.has(id)).join(',');
}

// A requested seed that, with core force-included, spans every pack is
// stored as the unset full surface instead of a ten-id list.
export function coversFullSurface(ids: ReadonlySet<PackId>): boolean {
  return PACK_IDS.every((id) => id === 'core' || ids.has(id));
}

export function cmdPacksWrite(mode: 'enable' | 'disable' | 'all'): void {
  let ids: string[] = [];
  if (mode !== 'all') {
    const raw = process.argv[4];
    if (raw === undefined || raw === '' || raw.startsWith('--')) {
      printPacksUsage();
      process.exitCode = 1;
      return;
    }
    const parsed = parsePackIdList(raw);
    ids = parsed.ids;
    if (parsed.bogus.length > 0) {
      console.error(`Unknown pack id(s): ${parsed.bogus.join(', ')}`);
      console.error(`Valid pack ids: ${PACK_IDS.join(', ')}`);
      process.exitCode = 1;
      return;
    }
    if (mode === 'disable' && ids.includes('core')) {
      console.error(
        'core is always enabled (the pack meta, safety, and discovery surface is force-included) and cannot be disabled',
      );
      process.exitCode = 1;
      return;
    }
  }
  const slots = resolvePacksCommandTarget();
  if (!slots) return;
  let written = 0;
  let refusals = 0;
  for (const slot of slots) {
    const raw = slot.read() ?? '';
    const unset = raw.trim() === '';
    const parsed = parseDevkitPacks(raw);
    // `all` is the reset hatch: it clears even a value this command cannot
    // interpret. Enable and disable refuse instead, so operator-typed
    // information is never destroyed by set math the ids do not support.
    if (mode !== 'all' && parsed.unknown.length > 0) {
      warnPacksUnknownIds(slot, raw, parsed.unknown);
      refusals++;
      continue;
    }
    let next: string | null;
    if (mode === 'all') {
      if (unset) {
        console.log(`Packs (${slot.label}): unchanged (DEVKIT_PACKS not set)`);
        continue;
      }
      next = null;
    } else if (mode === 'enable') {
      if (unset) {
        console.log(`Packs (${slot.label}): already the full surface (DEVKIT_PACKS not set)`);
        continue;
      }
      const nextSet = new Set<PackId>(parsed.requested);
      for (const id of ids) nextSet.add(id as PackId);
      next = coversFullSurface(nextSet) ? null : joinPackIds(nextSet);
    } else {
      const base = unset ? new Set<PackId>(PACK_IDS) : new Set<PackId>(parsed.requested);
      const nextSet = new Set(base);
      for (const id of ids) nextSet.delete(id as PackId);
      if (nextSet.size === base.size) {
        console.log(`Packs (${slot.label}): ${ids.join(', ')} ${ids.length === 1 ? 'was' : 'were'} not enabled`);
        continue;
      }
      next = nextSet.size === 0 || (nextSet.size === 1 && nextSet.has('core')) ? 'core' : joinPackIds(nextSet);
    }
    const result = slot.write(next);
    if (result.ok) {
      if (result.changed) {
        written++;
        const from = unset ? 'not set' : `"${raw}"`;
        console.log(
          next === null
            ? `Packs (${slot.label}): DEVKIT_PACKS ${from} → all (key removed)`
            : `Packs (${slot.label}): DEVKIT_PACKS ${from} → "${next}"`,
        );
      } else {
        console.log(`Packs (${slot.label}): unchanged`);
      }
      continue;
    }
    refusals++;
    const detail = result.reason === 'parse-failed' ? `could not write DEVKIT_PACKS (${result.detail})` : result.detail;
    console.log(`  \x1b[33m[WARN]\x1b[0m Packs (${slot.label}): ${detail}`);
  }
  renderCodexPacksWriteNote(codexPluginProbe());
  if (refusals > 0) process.exitCode = 1;
}
