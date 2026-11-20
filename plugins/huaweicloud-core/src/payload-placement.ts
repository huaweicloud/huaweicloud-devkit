import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { copyDir, copyFileVerified, pruneStale } from './payload-files.ts';
import { PLUGIN_ROOT } from './payload-utils.ts';
import { writeIntegrityReceipt } from './safety-integrity.ts';

// The server-payload placement (the install-payload.ts internals split):
// the one shared seam every per-agent install/update call site ships the
// payload through — the agent rules file, the MCP server (dist/), the
// safety policy, the skills tree, and the `.installed` restart marker that
// tracks payload placement.

// The payload every per-agent plugin dir must carry: the MCP server (dist/),
// the safety policy, and the skills tree. Skills are server data disclosed
// through the MCP tools (list_packs / pack_info / list_skills /
// retrieve_skill / search_docs) — the stdio server instructions state the
// tree's location (skillRoot) at initialize, and list_skills carries it too
// for direct reads; the core
// meta-skills are ADDITIONALLY disclosed natively by syncNativeCoreSkills,
// so every install and update path must place the tree next to the server
// it deploys (the native sync rides the same PAYLOAD_TARGETS table from
// the dispatch layer).
const AGENT_RULES_FILE = 'huawei-agent-rules.mdc';

// #758 (D4-23): ship the agent rules file with the server payload. The file
// had content and tests but ZERO install references — copyServerPayload only
// shipped dist/safety/skills, so no installed agent ever saw it. Injecting
// here (the one shared payload seam) covers every install/update call site
// main enumerated one by one. Convergence mirrors the skills seam: the rules
// dir is wholly devkit-owned — the file is remove-then-copied AND the dir is
// pruned of names the source no longer ships, so a replaced OR retired rules
// file can never linger. A missing source aborts loud — the skills-tree
// precedent: a silent skip is exactly the invisibility this unit exists to
// remove.
function injectAgentRules(pluginDest: string): void {
  // rules/ is a package-root artifact (repo-root rules/, shipped via the
  // package.json files list) — PLUGIN_ROOT here is plugins/huaweicloud-core,
  // so resolve the package root the same way setup-cli does.
  const rulesSrcDir = join(PLUGIN_ROOT, '..', '..', 'rules');
  const rulesSrc = join(rulesSrcDir, AGENT_RULES_FILE);
  if (!existsSync(rulesSrc)) {
    throw new Error(
      `agent rules file missing at ${rulesSrc} — the payload cannot ship without it. ` +
        'Restore it from source control (git restore rules/huawei-agent-rules.mdc) or reinstall the package.',
    );
  }
  const rulesDestDir = join(pluginDest, 'rules');
  mkdirSync(rulesDestDir, { recursive: true });
  const rulesDest = join(rulesDestDir, AGENT_RULES_FILE);
  rmSync(rulesDest, { force: true });
  copyFileVerified(rulesSrc, rulesDest);
  const staleRules = pruneStale(rulesDestDir, rulesSrcDir);
  console.log(`  Agent Rules -> ${rulesDest}${staleRules > 0 ? ` (removed ${staleRules} stale)` : ''}`);
}

export function copyServerPayload(pluginDest: string, opts: { skipDist?: boolean } = {}): void {
  // Rules first: its missing-source abort must fire BEFORE any payload bytes
  // land, so a broken source never leaves a half-updated plugin dir.
  injectAgentRules(pluginDest);
  if (!opts.skipDist) {
    const distSrc = join(PLUGIN_ROOT, 'dist');
    // A missing dist/ must abort like a missing skills tree below: copyDir's
    // existsSync guard would silently no-op the copy while this function
    // still prints the success line AND writes the restart marker for a
    // dir no server can start from (a fresh clone without npm run build).
    if (!existsSync(distSrc)) {
      throw new Error(
        `dist/ missing at ${distSrc} — the payload cannot ship without the server. ` +
          'From a git checkout run: npm run build; from a broken install run: npx huaweicloud-devkit install',
      );
    }
    copyDir(distSrc, join(pluginDest, 'dist'));
    console.log(`  MCP Server -> ${join(pluginDest, 'dist')}`);
  }
  copyDir(join(PLUGIN_ROOT, 'safety'), join(pluginDest, 'safety'));
  console.log(`  Safety Policy -> ${join(pluginDest, 'safety')}`);
  // The integrity receipt (the integrity unit's layer 3): a hash manifest
  // of the classifier files that just landed, written at the one shared
  // placement seam so every install/update path records it and doctor can
  // detect drift later. Covers whatever shipped — a skipDist payload
  // records its safety/ files only.
  writeIntegrityReceipt(pluginDest);
  console.log(`  Integrity receipt -> ${join(pluginDest, '.safety-integrity.json')}`);
  const skillsSrc = join(PLUGIN_ROOT, 'skills');
  // A missing source tree must abort, not silently skip: copyDir's
  // existsSync guard would no-op the copy while this function still prints
  // a success line, and the installed server would then advertise skills it
  // cannot serve. Same loudness as a missing dist/.
  if (!existsSync(skillsSrc)) {
    throw new Error(
      `skills tree missing at ${skillsSrc} — the payload cannot ship without it. ` +
        'From a git checkout run: npm run build; from a broken install run: npx huaweicloud-devkit install',
    );
  }
  copyDir(skillsSrc, join(pluginDest, 'skills'));
  // The plugin dir is wholly devkit-owned: prune retired skill names so a
  // departed directory can never keep serving stale, ungated content through
  // retrieve_skill/search_docs (unclaimed dirs bypass pack enablement).
  const stale = pruneStale(join(pluginDest, 'skills'), skillsSrc);
  console.log(
    `  Skills (server data; MCP catalog + stdio skillRoot instructions) -> ${join(pluginDest, 'skills')}${stale > 0 ? ` (removed ${stale} stale)` : ''}`,
  );
  // The .installed marker means "a server payload was placed here — restart
  // the agent to activate it". It tracks PAYLOAD PLACEMENT, not overall
  // deploy success: a deploy that fails after this point (e.g.
  // installRuntimeDeps on a network failure) still swapped the on-disk
  // payload, and the restart banner is exactly what doctor should print.
  // A payload placed with skipDist ships no server, so it writes no marker —
  // nothing will ever run from that dir to consume one (the running server
  // deletes the marker at boot, mcp-server.ts).
  if (!opts.skipDist) {
    writeFileSync(join(pluginDest, '.installed'), new Date().toISOString());
  }
}
