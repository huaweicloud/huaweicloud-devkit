import type { z } from 'zod';

import type { ToolArgs, ToolName, CallToolOptions } from '../tools.ts';

// Shared pack vocabulary, hoisted from packs/registry.ts and
// packs/update/tools.ts so every pack imports the same contract types from one
// place. The module's imports stay type-only (the zod import is `import type`,
// used in a typeof query, and importing ToolName/ToolArgs/CallToolOptions from
// tools.ts is a type-only edge, which verbatimModuleSyntax erases — so the
// existing tools.ts → registry → pack value chain gains no runtime cycle).
// PACK_IDS below is the module's only value export, and it keeps the runtime
// graph at zero imports on purpose: the installer (dist/setup-cli.js, plain
// tsc output — only dist/mcp-server.js is esbuild-bundled with zod inlined)
// imports this module to validate --packs and must not pull the
// zod-dependent registry chain. The pack→binary dependency vocabulary that
// once lived here was absorbed by lib/dependency-model.ts: the DEPENDENCIES
// catalog plus PACK_DEPENDENCIES edges are the single declaration surface
// now.
//
// Consumers:
//   - src/packs/registry.ts        (Pack, PackId)
//   - src/packs/<id>/pack.ts       (Pack)
//   - src/packs/<id>/tools.ts      (PackToolDefinition, LooseToolSchema)
//   - src/tool-schemas.ts          (LooseToolSchema, re-exported for callers)
//   - src/setup-cli.ts             (PACK_IDS — installer side)
//   - src/lib/dependency-model.ts   (PACK_IDS — shared dependency vocabulary)

// The runtime class behind z.looseObject (constructor name ZodObject): a
// constructed passthrough object schema. Named once so registry entries,
// accessor signatures, and the runtime guard all share it.
export type LooseToolSchema = ReturnType<typeof z.looseObject<Record<string, unknown>>>;

// One pack tool wires its four registration facts in a single place: identity
// (name/description), the zod input schema, and the callTool handler. The
// satisfies check on each pack's X_TOOLS turns a missing element into a
// compile error, so a pack entry can never ship half-wired.
export interface PackToolDefinition {
  name: ToolName;
  description: string;
  schema: LooseToolSchema;
  handler: (_args: ToolArgs, _opts: CallToolOptions) => Promise<unknown>;
}

// The canonical pack id list. PackId derives from it, so the list and the
// union cannot drift apart; the registry's PACKS ids are pinned to this list
// by test/structure.test.ts, which keeps the installer's --packs validation
// honest against the registry truth.
// 'huaweicloud-cli' is a mixed knowledge+tools pack: the twenty service
// skills plus the seven KooCLI execution tools (the CLI face and its
// approval chain, sunk from core), while the meta tools that disclose packs
// (list_packs / pack_info / list_skills / retrieve_skill) stay in core so
// an enabled pack can always be discovered.
export const PACK_IDS = [
  'core',
  'huaweicloud-cli',
  'sandbox',
  'auth',
  'obs',
  'voucher',
  'update',
  'discovery',
  'huaweicloud-open-mcp',
  'secrets',
] as const;
export type PackId = (typeof PACK_IDS)[number];

export interface Pack {
  id: PackId;
  title: string;
  description: string;
  /** skills/ directory names this pack ships. */
  skills: string[];
  tools: ToolName[];
}
