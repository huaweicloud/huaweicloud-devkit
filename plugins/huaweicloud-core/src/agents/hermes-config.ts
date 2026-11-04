// The Hermes config.yaml MCP-block family, split out of agents/hermes.ts:
// the mcp_servers managed-child writer (merges into an existing
// mcp_servers mapping — user servers, unrelated keys, their indent and
// dominant line endings survive; user args survive, DEVKIT_PACKS
// parameterized) and the surgical child remover (scoped to children under
// an mcp_servers block key). One scanner, scanManagedChildren, is the
// single definition of what the managed child is; the writer, the remover,
// and the #615 args delta all consume it. The hooks/allowlist/plugin
// families live in agents/hermes-hooks.ts; the deploy/uninstall/status
// lifecycle and the MCP Python SDK provisioning stay in agents/hermes.ts.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';

import { hermesConfigFile, hermesPluginsDir } from '../targets.ts';
import { packsCarryValue } from '../packs-policy.ts';
import { findHcloudBin } from '../hcloud-probe.ts';
import { saveAgentDelta, takeAgentDelta } from '../mcp-config-backup.ts';

// Returns true when the config file was written, false when it was already correct.
export function ensureHermesMcpConfig(): boolean {
  // Resolve the packs policy before any block rewrite: the current
  // DEVKIT_PACKS value lives inside the block writeHermesMcpConfig rewrites.
  // The read is scoped to the managed child: a user server's DEVKIT_PACKS
  // line must never become the value the writer carries.
  return writeHermesMcpConfig(packsCarryValue('Hermes Agent', readHermesDevkitPacks()));
}

// The DEVKIT_PACKS value the managed child carries, scoped to the child's
// env-level line. Null when the file, the child, or the line is absent. The
// `packs` command reads the same value through its hermes slot.
export function readHermesDevkitPacks(): string | null {
  if (!existsSync(hermesConfigFile())) return null;
  let text: string;
  try {
    text = readFileSync(hermesConfigFile(), 'utf8');
  } catch {
    return null;
  }
  const line = managedChildPacksLine(text);
  if (line === undefined) return null;
  return parsePacksLineValue(line);
}

// ── The shared line model ──

type McpKeyForm = 'none' | 'bare' | 'empty' | 'value';

// A top-level `mcp_servers:` key line, BOM-tolerant and tolerant of the
// quoted key spellings (`"mcp_servers":` parses to the same mapping key).
// bare is the block mapping spelling (optionally with a trailing comment)
// and is mergeable. empty is an empty value — the flow spellings `{}`/`{ }`
// and `null`/`~` — rewritten to bare before merging. value is anything else
// (a non-empty flow mapping, a scalar): a shape the writer cannot merge
// into, left untouched.
interface McpKeyLine {
  form: McpKeyForm;
  comment: string;
  bom: boolean;
}

function classifyMcpKeyLine(line: string): McpKeyLine {
  const bom = line.charCodeAt(0) === 0xfeff;
  const probe = bom ? line.slice(1) : line;
  const match = probe.match(/^["']?mcp_servers["']?[ \t]*:(.*)$/);
  if (!match) return { form: 'none', comment: '', bom };
  const rest = match[1]!;
  const bareOrComment = rest.match(/^[ \t]*(#.*)?$/);
  if (bareOrComment) return { form: 'bare', comment: (bareOrComment[1] ?? '').trim(), bom };
  if (/^[ \t]*\{[ \t]*\}[ \t]*(#.*)?$/.test(rest) || /^[ \t]*(?:null|~|Null|NULL)[ \t]*(#.*)?$/.test(rest)) {
    return { form: 'empty', comment: (rest.match(/(#.*)$/) ?? ['', ''])[1]!.trim(), bom };
  }
  return { form: 'value', comment: '', bom };
}

// U+FEFF is whitespace to trimStart but not to YAML: a BOM is a file marker,
// never indentation, so every indent comparison strips it first.
function indentOf(line: string): number {
  const probe = line.charCodeAt(0) === 0xfeff ? line.slice(1) : line;
  return probe.length - probe.trimStart().length;
}

function isCommentOrBlank(line: string): boolean {
  const trimmed = line.trim();
  return trimmed === '' || trimmed.startsWith('#');
}

// The dominant line ending: pure files keep their ending exactly, and a
// mixed file resolves to the majority instead of one stray line rewriting
// the whole file.
function dominantEol(text: string): string {
  const endings = text.match(/\r?\n/g) ?? [];
  const crlf = endings.filter((e) => e === '\r\n').length;
  return crlf > endings.length - crlf ? '\r\n' : '\n';
}

// A key line whose value is a literal block scalar (`prompt: |` and
// friends): the more-indented lines after it are scalar content, not YAML
// structure, so every structural scan must skip them.
const BLOCK_SCALAR_KEY = /^\s*[^\s:]+:\s*[|>][-+0-9]*[ \t]*(?:#.*)?$/;

interface ManagedChild {
  keyIdx: number;
  keyIndent: number;
  endIdx: number;
}

interface ManagedScan {
  lines: string[];
  mcpKeyIdx: number[];
  children: ManagedChild[];
}

// The single structural pass: every top-level `mcp_servers` key line (any
// value form) and every `huaweicloud-devkit` child at the mapping's
// direct-child indent under a bare key. Children under flow/value-form keys
// cannot exist (the writer never puts them there), a devkit-named key
// nested deeper inside a user server is user content, never the managed
// child, and lines inside block scalars are content, never children.
function scanManagedChildren(text: string): ManagedScan {
  const lines = text.split(/\r?\n/);
  const mcpKeyIdx: number[] = [];
  const children: ManagedChild[] = [];
  let underBareMcp = false;
  let mcpChildIndent: number | null = null;
  let scalarIndent: number | null = null;
  let openChild: ManagedChild | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const indent = indentOf(line);
    if (scalarIndent !== null) {
      if (line.trim() === '' || indent > scalarIndent) continue;
      scalarIndent = null;
    }
    if (BLOCK_SCALAR_KEY.test(line)) {
      scalarIndent = indent;
      if (openChild && indent > openChild.keyIndent) openChild.endIdx = i - 1;
      continue;
    }
    if (indent === 0 && !isCommentOrBlank(line) && !line.trimStart().startsWith('-')) {
      const form = classifyMcpKeyLine(line).form;
      if (form !== 'none') mcpKeyIdx.push(i);
      underBareMcp = form === 'bare';
      mcpChildIndent = null;
      if (openChild) {
        openChild.endIdx = i - 1;
        openChild = null;
      }
      continue;
    }
    if (openChild && (line.trim() === '' || indent > openChild.keyIndent)) {
      openChild.endIdx = i;
      continue;
    }
    if (openChild) {
      openChild.endIdx = i - 1;
      openChild = null;
    }
    if (underBareMcp && !isCommentOrBlank(line) && indent > 0) {
      if (mcpChildIndent === null) mcpChildIndent = indent;
      if (indent === mcpChildIndent && /^\s*["']?huaweicloud-devkit["']?\s*:/.test(line)) {
        openChild = { keyIdx: i, keyIndent: indent, endIdx: i };
        children.push(openChild);
      }
    }
  }
  return { lines, mcpKeyIdx, children };
}

// The child's own `args: [...]` line — the one at the child's direct-key
// indent, never a nested sub-key's or a sibling server's line. A flow-form
// child (`huaweicloud-devkit: {args: [...]}`) carries its args on the key
// line itself. Null when the child has no inline args of its own (a
// block-sequence args spelling is a documented residual: neither the extras
// preservation nor the uninstall delta can read it).
export function devkitChildArgsLine(text: string): string | null {
  const scan = scanManagedChildren(text);
  if (scan.children.length === 0) return null;
  const child = scan.children[0]!;
  const keyLine = scan.lines[child.keyIdx]!;
  if (/args:\s*\[/.test(keyLine)) return keyLine;
  const body = scan.lines.slice(child.keyIdx + 1, child.endIdx + 1);
  let directIndent: number | null = null;
  for (const line of body) {
    if (isCommentOrBlank(line)) continue;
    if (directIndent === null) directIndent = indentOf(line);
    if (indentOf(line) === directIndent && /^\s*args:\s*\[/.test(line)) return line;
  }
  return null;
}

// The YAML double-quoted escape alphabet: decode on parse, encode on render,
// so a user arg like "-fmt\ttab" round-trips through write and delta byte
// for byte. Unrecognized escapes stay literal (graceful, spec says error).
const YAML_DQ_DECODE: Record<string, string> = {
  '0': '\0',
  a: '\x07',
  b: '\x08',
  t: '\t',
  n: '\n',
  v: '\x0B',
  f: '\x0C',
  r: '\r',
  e: '\x1B',
  ' ': ' ',
  '"': '"',
  '/': '/',
  '\\': '\\',
  N: '\u0085',
  _: '\u00A0',
  L: '\u2028',
  P: '\u2029',
};

// Encode a scalar for a YAML double-quoted render: the escapes above,
// inverted, plus \x for the remaining control characters.
function yamlArgQuoted(value: string): string {
  let out = '';
  for (const ch of value) {
    switch (ch) {
      case '\\':
        out += '\\\\';
        continue;
      case '"':
        out += '\\"';
        continue;
      case '\t':
        out += '\\t';
        continue;
      case '\n':
        out += '\\n';
        continue;
      case '\r':
        out += '\\r';
        continue;
      case '\0':
        out += '\\0';
        continue;
      case '\x07':
        out += '\\a';
        continue;
      case '\x08':
        out += '\\b';
        continue;
      case '\x0B':
        out += '\\v';
        continue;
      case '\x0C':
        out += '\\f';
        continue;
      case '\x1B':
        out += '\\e';
        continue;
      default: {
        const code = ch.codePointAt(0)!;
        if (code === 0x85) out += '\\N';
        else if (code === 0xa0) out += '\\_';
        else if (code === 0x2028) out += '\\L';
        else if (code === 0x2029) out += '\\P';
        else if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
          // A raw C0/C1 control would fold to whitespace or be rejected by
          // real YAML loaders; \x/\u keeps the value intact.
          out += `\\x${code.toString(16).padStart(2, '0').toUpperCase()}`;
        } else {
          out += ch;
        }
      }
    }
  }
  return out;
}

// The args elements of an inline args line, quote-style-agnostic and
// escape-aware: ["a", 'b', "c\"d"] → ["a", "b", 'c"d']. A trailing comment
// after the closing bracket is tolerated. Quoted elements keep their exact
// content (YAML double-quote escapes decoded, single-quote '' decoded);
// only unquoted elements are trimmed. An intentional quoted empty string
// survives; only the empty artifact of a trailing comma is dropped. Shared
// by the writer's extras preservation and uninstall's delta save, so both
// sides accept the same spellings.
export function parseArgsElements(line: string): string[] | null {
  const open = line.match(/args:\s*\[/);
  if (!open) return null;
  // Locate the matching close bracket. A quote only starts a quoted scalar
  // at a scalar's start (right after the bracket, a separator, or a nested
  // collection open) — mid-scalar quotes are plain content, per YAML — and
  // a `]` inside an element or a trailing comment never ends the sequence.
  const openEnd = open.index! + open[0].length;
  let close = -1;
  let depth = 1;
  let scanQuote: string | null = null;
  let pendingSinceSeparator = '';
  for (let i = openEnd; i < line.length; i++) {
    const ch = line[i]!;
    if (scanQuote === '"') {
      if (ch === '\\') {
        i++;
        continue;
      }
      if (ch === '"') scanQuote = null;
      continue;
    }
    if (scanQuote === "'") {
      if (ch === "'") {
        if (line[i + 1] === "'") i++;
        else scanQuote = null;
      }
      continue;
    }
    if ((ch === '"' || ch === "'") && pendingSinceSeparator.trim() === '') {
      scanQuote = ch;
      continue;
    }
    if (ch === '[') {
      depth++;
      pendingSinceSeparator += ch;
      continue;
    }
    if (ch === ']') {
      depth--;
      if (depth === 0) {
        close = i;
        break;
      }
      pendingSinceSeparator += ch;
      continue;
    }
    if (ch === ',') {
      pendingSinceSeparator = '';
      continue;
    }
    pendingSinceSeparator += ch;
  }
  if (close === -1) return null;
  const inner = line.slice(openEnd, close);
  if (inner.trim() === '') return [];
  const items: Array<{ value: string; quoted: boolean }> = [];
  let current = '';
  let quoted = false;
  let quote: string | null = null;
  let scalarDepth = 0;
  let scalarStarted = false;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]!;
    if (quote === '"') {
      if (ch === '\\') {
        const next = inner[i + 1];
        if (next === undefined) {
          current += ch;
          continue;
        }
        if (next === 'x' || next === 'u' || next === 'U') {
          const width = next === 'x' ? 2 : next === 'u' ? 4 : 8;
          const hex = inner.slice(i + 2, i + 2 + width);
          if (/^[0-9a-fA-F]+$/.test(hex)) {
            const code = Number.parseInt(hex, 16);
            if (code <= 0x10ffff) {
              current += String.fromCodePoint(code);
              i += 1 + width;
              continue;
            }
          }
          current += ch;
          continue;
        }
        const decoded = YAML_DQ_DECODE[next];
        if (decoded !== undefined) {
          current += decoded;
          i++;
          continue;
        }
        current += ch;
        continue;
      }
      if (ch === '"') quote = null;
      else current += ch;
      continue;
    }
    if (quote === "'") {
      if (ch === "'") {
        if (inner[i + 1] === "'") {
          current += "'";
          i++;
        } else {
          quote = null;
        }
        continue;
      }
      current += ch;
      continue;
    }
    if ((ch === '"' || ch === "'") && !scalarStarted) {
      // Only whitespace can precede a scalar's opening quote; it is
      // separator, not content.
      quote = ch;
      quoted = true;
      current = '';
      continue;
    }
    if (ch === '[' || ch === '{') {
      scalarDepth++;
      current += ch;
      continue;
    }
    if (ch === ']' || ch === '}') {
      scalarDepth = Math.max(0, scalarDepth - 1);
      current += ch;
      continue;
    }
    if (ch === ',' && scalarDepth === 0) {
      items.push({ value: current, quoted });
      current = '';
      quoted = false;
      scalarStarted = false;
      continue;
    }
    if (ch !== ' ' && ch !== '\t') scalarStarted = true;
    current += ch;
  }
  items.push({ value: current, quoted });
  let elements = items.map((item) => ({ value: item.quoted ? item.value : item.value.trim(), quoted: item.quoted }));
  const last = elements[elements.length - 1]!;
  if (!last.quoted && last.value === '' && elements.length > 1) {
    elements = elements.slice(0, -1);
  }
  return elements.map((item) => item.value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Walks a string, skipping quoted regions (YAML double- and single-quote
// escape rules) and tracking bracket depth; returns the index the visit
// callback names, or -1 when the walk ends first.
function scanOutsideQuotes(raw: string, visit: (ch: string, i: number, depth: number) => number | undefined): number {
  let quote: string | null = null;
  let depth = 0;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    if (quote === '"') {
      if (ch === '\\') {
        i++;
        continue;
      }
      if (ch === '"') quote = null;
      continue;
    }
    if (quote === "'") {
      if (ch === "'") {
        if (raw[i + 1] === "'") i++;
        else quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '{' || ch === '[') depth++;
    if (ch === '}' || ch === ']') depth--;
    const result = visit(ch, i, depth);
    if (typeof result === 'number') return result;
  }
  return -1;
}

// A flow-form child carries its env inline on the key line
// (`huaweicloud-devkit: {…, env: {DEVKIT_PACKS: "core"}}`). Returns the
// env-level DEVKIT_PACKS as a reconstructed plain line for
// parsePacksLineValue, or undefined when the key line has no such value.
function flowChildPacksLine(keyLine: string): string | undefined {
  const envMatch = keyLine.match(/["']?env["']?\s*:\s*\{/);
  if (!envMatch) return undefined;
  const rest = keyLine.slice(envMatch.index! + envMatch[0].length);
  const close = scanOutsideQuotes(rest, (ch, i, depth) => (ch === '}' && depth < 0 ? i : undefined));
  if (close === -1) return undefined;
  const inner = rest.slice(0, close);
  const packs = inner.match(/["']?DEVKIT_PACKS["']?\s*:\s*/);
  if (!packs) return undefined;
  return `DEVKIT_PACKS: ${cutFlowValue(inner.slice(packs.index! + packs[0].length))}`;
}

// A flow-mapping member's raw value ends at the member's boundary: the
// first comma or closing brace outside quotes at bracket depth zero.
function cutFlowValue(raw: string): string {
  const cut = scanOutsideQuotes(raw, (ch, i, depth) => ((ch === ',' || ch === '}') && depth === 0 ? i : undefined));
  return cut === -1 ? raw : raw.slice(0, cut);
}

// The env-level DEVKIT_PACKS line of the managed child — the one directly
// under the child's own `env:` direct key, never a line nested inside a user
// sub-key. Shared by the reader and the unchanged-check so the two cannot
// disagree.
function managedChildPacksLine(text: string): string | undefined {
  const scan = scanManagedChildren(text);
  if (scan.children.length === 0) return undefined;
  const child = scan.children[0]!;
  const fromFlow = flowChildPacksLine(scan.lines[child.keyIdx]!);
  if (fromFlow !== undefined) return fromFlow;
  const body = scan.lines.slice(child.keyIdx + 1, child.endIdx + 1);
  let directIndent: number | null = null;
  let inEnv = false;
  let envMemberIndent: number | null = null;
  for (const line of body) {
    if (isCommentOrBlank(line)) continue;
    const indent = indentOf(line);
    if (directIndent === null) directIndent = indent;
    if (indent === directIndent) {
      inEnv = /^\s*["']?env["']?\s*:/.test(line);
      envMemberIndent = null;
      continue;
    }
    if (inEnv && indent > directIndent) {
      // The env block's own member indent (a hand-re-indented child may use
      // more than the canonical +2).
      if (envMemberIndent === null) envMemberIndent = indent;
      if (indent === envMemberIndent && /^\s*["']?DEVKIT_PACKS["']?\s*:/.test(line)) return line;
    }
  }
  return undefined;
}

// The YAML scalar value of a DEVKIT_PACKS line: a double-quoted scalar with
// escape decoding, a single-quoted scalar, or a plain scalar. A `#` inside
// quotes is value content; outside, a trailing comment.
function parsePacksLineValue(line: string): string | null {
  const m = line.match(/^\s*["']?DEVKIT_PACKS["']?\s*:\s*/);
  if (!m) return null;
  const rest = line.slice(m[0].length);
  if (rest.startsWith('"')) {
    let value = '';
    for (let i = 1; i < rest.length; i++) {
      const ch = rest[i]!;
      if (ch === '\\' && i + 1 < rest.length) {
        const next = rest[i + 1]!;
        if (next === 'x' || next === 'u' || next === 'U') {
          const width = next === 'x' ? 2 : next === 'u' ? 4 : 8;
          const hex = rest.slice(i + 2, i + 2 + width);
          if (/^[0-9a-fA-F]+$/.test(hex)) {
            const code = Number.parseInt(hex, 16);
            if (code <= 0x10ffff) {
              value += String.fromCodePoint(code);
              i += 1 + width;
              continue;
            }
          }
          return null;
        }
        const decoded = YAML_DQ_DECODE[next];
        if (decoded !== undefined) {
          value += decoded;
          i++;
          continue;
        }
        return null;
      }
      if (ch === '"') return value;
      value += ch;
    }
    return null;
  }
  if (rest.startsWith("'")) {
    let value = '';
    for (let i = 1; i < rest.length; i++) {
      const ch = rest[i]!;
      if (ch === "'") {
        if (rest[i + 1] === "'") {
          value += "'";
          i++;
          continue;
        }
        return value;
      }
      value += ch;
    }
    return null;
  }
  const cut = rest.search(/[ \t]+#/);
  return (cut === -1 ? rest : rest.slice(0, cut)).trim();
}

function managedChildPacksOk(text: string, packsValue: string | null): boolean {
  const line = managedChildPacksLine(text);
  if (packsValue === null) return line === undefined;
  return line !== undefined && new RegExp(`^\\s*${escapeRegExp(packsValue)}[ \t]*(?:#.*)?$`).test(line);
}

// ── The writer ──

export interface HermesMcpWriteResult {
  changed: boolean;
  refused: string | null;
}

// The boolean face install/update use; the packs slot reads the detailed
// result so a refusal surfaces as a failure, not "unchanged".
export function writeHermesMcpConfig(devkitPacks: string | null): boolean {
  return writeHermesMcpConfigResult(devkitPacks).changed;
}

// The Hermes MCP block render path, parameterized with the DEVKIT_PACKS value
// to carry. Install/update resolve the value through the --packs policy; the
// `packs` command passes the operator's set-math result. The managed entry is
// the `huaweicloud-devkit:` child nested under the user's mcp_servers
// mapping: a config that already has the key is merged into in place (user
// servers, their indent, and unrelated keys survive), only a key-less config
// gets a fresh one, and a config already carrying a duplicate mcp_servers key
// (the pre-merge writer's output) collapses back to a single key. A
// sequence-form or flow-mapping mcp_servers cannot carry a mapping child and
// is left untouched. User-added args inside the child survive the rewrite
// exactly as install preserves them. A refused write (refused !== null)
// leaves the file byte-untouched and never consumes the saved args delta.
export function writeHermesMcpConfigResult(devkitPacks: string | null): HermesMcpWriteResult {
  const configPath = hermesConfigFile();
  const mcpPath = join(hermesPluginsDir(), 'dist', 'mcp-server.js').replace(/\\/g, '/');
  const hcloudBin = findHcloudBin();

  const childEnvLines: string[] = ['HUAWEICLOUD_AGENT_TOOLKIT_MODE: "local"'];
  if (hcloudBin) {
    childEnvLines.push(`HCLOUD_BIN: "${yamlArgQuoted(hcloudBin.replace(/\\/g, '/'))}"`);
  }
  const packsValue = devkitPacks !== null ? `DEVKIT_PACKS: "${yamlArgQuoted(devkitPacks)}"` : null;
  let argsElements: string[] = [mcpPath];

  let existing = '';
  if (existsSync(configPath)) {
    try {
      existing = readFileSync(configPath, 'utf8');
    } catch {
      // unreadable config is treated as absent — the block is written fresh
    }
    // A value-form mcp_servers key (a flow mapping with content, a scalar)
    // cannot carry a block child: with or without other key spellings
    // present, the whole file is left untouched rather than half-merged
    // into a shadowed key.
    if (existing.split(/\r?\n/).some((line) => classifyMcpKeyLine(line).form === 'value')) {
      const reason = 'mcp_servers is not a block mapping; add huaweicloud-devkit manually';
      console.log(`  MCP config left untouched: ${configPath} (${reason})`);
      return { changed: false, refused: reason };
    }
    const scan = scanManagedChildren(existing);
    // A sequence-form mcp_servers key ANYWHERE (any key's first body line is
    // a sequence item, not just the managed child's parent) refuses the
    // whole write before any mutation: the merged child under one key would
    // be shadowed by the sequence duplicate's last-wins resolution, and a
    // rewrite would silently uninstall a working entry.
    for (const keyLine of scan.mcpKeyIdx) {
      for (let i = keyLine + 1; i < scan.lines.length; i++) {
        const line = scan.lines[i]!;
        if (isCommentOrBlank(line)) continue;
        const trimmed = line.trimStart();
        if (trimmed === '-' || trimmed.startsWith('- ')) {
          const reason = 'mcp_servers is a sequence; add huaweicloud-devkit manually';
          console.log(`  MCP config left untouched: ${configPath} (${reason})`);
          return { changed: false, refused: reason };
        }
        break;
      }
    }
    // Duplicate mergeable keys with no managed child anywhere are user-made
    // duplicates the writer cannot heal (it only consolidates keys when it
    // rewrites the managed child): merging under the first would leave the
    // shadowing duplicate in place, so the file is left untouched.
    const mergeableKeyCount = scan.mcpKeyIdx.filter(
      (idx) => classifyMcpKeyLine(scan.lines[idx]!).form !== 'value',
    ).length;
    if (scan.children.length === 0 && mergeableKeyCount > 1) {
      const reason = 'duplicate mcp_servers keys; add huaweicloud-devkit manually';
      console.log(`  MCP config left untouched: ${configPath} (${reason})`);
      return { changed: false, refused: reason };
    }
    if (scan.children.length > 0) {
      // Preserve user's extra args (e.g. --hdkitservice-endpoint) when
      // rewriting the block (issue #615): the child's own args line,
      // quote-style-agnostic.
      const argsLine = devkitChildArgsLine(existing);
      const elements = argsLine ? parseArgsElements(argsLine) : null;
      // A duplicate top-level mcp_servers key or a duplicated managed child
      // is never "unchanged"; so is a child whose args line has wandered off
      // the current server path.
      const mcpKeyCount = scan.mcpKeyIdx.length;
      if (
        mcpKeyCount === 1 &&
        scan.children.length === 1 &&
        elements !== null &&
        elements[0] === mcpPath &&
        managedChildPacksOk(existing, packsValue)
      ) {
        console.log(`  MCP config unchanged: ${configPath}`);
        return { changed: false, refused: null };
      }
      if (elements && elements.length > 1) argsElements = [mcpPath, ...elements.slice(1)];
      // A single-key rewrite keeps the (possibly emptied) key so the managed
      // child returns to its original position. A duplicate-key heal
      // consolidates every duplicate (the child's own key and any other),
      // so the re-merge lands under the one surviving key.
      removeManagedChild({ keepEmptyKeys: mcpKeyCount === 1, consolidateAllKeys: mcpKeyCount > 1 });
      existing = '';
      if (existsSync(configPath)) {
        try {
          existing = readFileSync(configPath, 'utf8');
        } catch {
          // unreadable re-read means the block becomes the whole file
        }
      }
    }
  }
  mkdirSync(dirname(configPath), { recursive: true });

  const eol = dominantEol(existing);
  const lines = existing ? existing.split(/\r?\n/) : [];
  const keyIdx = lines.findIndex((line) => {
    const form = classifyMcpKeyLine(line).form;
    return form === 'bare' || form === 'empty';
  });
  // The insertion plan: a fresh key at end of file, or a splice into the
  // existing mapping after its last body line at the children's indent.
  // Computed before the delta is consumed so a refused write never burns it.
  let appendFreshKey = false;
  let spliceAt = 0;
  let childIndent = 2;
  if (keyIdx === -1) {
    // A fresh key can only join a block-mapping root: a top-level sequence,
    // scalar, or flow-mapping document would become invalid YAML, so it is
    // left untouched. Only the top-level lines are judged (a sequence
    // document's items ARE top-level lines); indented lines are children of
    // whatever key owns them. Document markers and a BOM are structure, not
    // content.
    const isMappingLine = (line: string): boolean => {
      const probe = line.charCodeAt(0) === 0xfeff ? line.slice(1) : line;
      if (probe === '---' || probe === '...') return true;
      return !probe.startsWith('-') && /^[^\s:\-#[{][^:]*:([ \t]|$)/.test(probe);
    };
    const topLevel = lines.filter((line) => !isCommentOrBlank(line) && indentOf(line) === 0);
    const rootIsMapping = topLevel.every((line) => isMappingLine(line));
    if (topLevel.length > 0 && !rootIsMapping) {
      const reason = 'the config root is not a mapping; add huaweicloud-devkit manually';
      console.log(`  MCP config left untouched: ${configPath} (${reason})`);
      return { changed: false, refused: reason };
    }
    appendFreshKey = true;
    while (lines.length > 0 && lines[lines.length - 1]!.trim() === '') lines.pop();
  } else {
    const keyInfo = classifyMcpKeyLine(lines[keyIdx]!);
    if (keyInfo.form === 'empty') {
      lines[keyIdx] = `${keyInfo.bom ? '\uFEFF' : ''}mcp_servers:${keyInfo.comment ? ` ${keyInfo.comment}` : ''}`;
    }
    // The mapping's first real child decides the managed child's indent; a
    // sequence-form mcp_servers (a `- ` item, indented or at the key's own
    // indent) cannot carry a mapping child. A plain mapping key that merely
    // starts with `-` (like `-verbose:`) is a child, not an item.
    let sequenceForm = false;
    let firstChildIndent: number | null = null;
    for (let i = keyIdx + 1; i < lines.length; i++) {
      const line = lines[i]!;
      if (isCommentOrBlank(line)) continue;
      const trimmed = line.trimStart();
      if (trimmed === '-' || trimmed.startsWith('- ')) sequenceForm = true;
      else if (indentOf(line) > 0) firstChildIndent = indentOf(line);
      break;
    }
    if (sequenceForm) {
      const reason = 'mcp_servers is a sequence; add huaweicloud-devkit manually';
      console.log(`  MCP config left untouched: ${configPath} (${reason})`);
      return { changed: false, refused: reason };
    }
    childIndent = firstChildIndent ?? 2;
    // The mapping runs from the key to its last indented non-comment line;
    // the managed child joins the user's servers there.
    let end = keyIdx;
    for (let i = keyIdx + 1; i < lines.length; i++) {
      const line = lines[i]!;
      if (isCommentOrBlank(line)) continue;
      if (/^\s/.test(line)) {
        end = i;
        continue;
      }
      break;
    }
    spliceAt = end + 1;
  }
  // Restore user args saved by a previous uninstall (issue #615). Consumed
  // only once a write is certain (a refused write never burns it), and only
  // when the child in the file has no extras of its own: a hand-repaired
  // child's fresh extras must not be clobbered by a stale delta.
  const hermesDelta = takeAgentDelta('hermes');
  const rawDeltaArgs = hermesDelta?.argsExtra;
  const deltaArgsExtra = Array.isArray(rawDeltaArgs) && rawDeltaArgs.length > 0 ? rawDeltaArgs : null;
  if (deltaArgsExtra !== null && argsElements.length <= 1) {
    argsElements = [mcpPath, ...deltaArgsExtra.map((a) => String(a))];
  }
  const childBlock = (indent: number): string[] => [
    `${' '.repeat(indent)}huaweicloud-devkit:`,
    `${' '.repeat(indent + 2)}command: "node"`,
    `${' '.repeat(indent + 2)}args: [${argsElements.map((a) => `"${yamlArgQuoted(a)}"`).join(', ')}]`,
    `${' '.repeat(indent + 2)}env:`,
    ...childEnvLines.map((line) => `${' '.repeat(indent + 4)}${line}`),
    ...(packsValue !== null ? [`${' '.repeat(indent + 4)}${packsValue}`] : []),
  ];

  let newContent: string;
  if (appendFreshKey) {
    const prefix = lines.join(eol);
    // A trailing document-end marker (`...`) closes the document: the fresh
    // key opens a new one instead of corrupting the old.
    const endsWithDocEnd = lines.length > 0 && lines[lines.length - 1]!.trim() === '...';
    newContent = prefix
      ? `${prefix}${eol}${endsWithDocEnd ? `---${eol}` : eol}mcp_servers:${eol}${childBlock(2).join(eol)}${eol}`
      : `mcp_servers:${eol}${childBlock(2).join(eol)}${eol}`;
  } else {
    lines.splice(spliceAt, 0, ...childBlock(childIndent));
    newContent = lines.join(eol);
    if (!newContent.endsWith(eol)) newContent += eol;
  }
  try {
    writeFileSync(configPath, newContent);
  } catch (error) {
    // The take above was not transactional with the write: a failed write
    // must not leave the user's delta consumed and gone.
    if (deltaArgsExtra !== null) {
      saveAgentDelta('hermes', { argsExtra: deltaArgsExtra });
    }
    throw error;
  }
  console.log(`  MCP config updated: ${configPath}`);
  return { changed: true, refused: null };
}

// ── The remover ──

function removeManagedChild(options: { keepEmptyKeys: boolean; consolidateAllKeys?: boolean }): void {
  const configPath = hermesConfigFile();
  if (!existsSync(configPath)) return;
  const text = readFileSync(configPath, 'utf8');
  const scan = scanManagedChildren(text);
  if (scan.children.length === 0) {
    console.log('  MCP config cleaned');
    return;
  }
  const eol = dominantEol(text);
  const lines = scan.lines;
  // Drop the managed children (all of them — a duplicated child heals to
  // one) wherever they sit, tracking the kept-array index of the mcp_servers
  // key each one lived under so pass 2 never drops a key the devkit never
  // used. Blank lines inside a child drop with it; blank lines before the
  // next sibling survive.
  const drop = new Set(scan.children.map((child) => child.keyIdx));
  const kept: string[] = [];
  const emptied: Set<number> = new Set();
  let currentKeyKeptIdx: number | null = null;
  let openChild = false;
  let childIndent = 0;
  let pendingBlanks: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const indent = indentOf(line);
    if (openChild) {
      if (line.trim() === '') {
        pendingBlanks.push(line);
        continue;
      }
      if (indent > childIndent) {
        pendingBlanks = [];
        continue;
      }
      openChild = false;
      kept.push(...pendingBlanks);
      pendingBlanks = [];
    }
    if (drop.has(i)) {
      openChild = true;
      childIndent = indentOf(line);
      if (currentKeyKeptIdx !== null) emptied.add(currentKeyKeptIdx);
      continue;
    }
    if (indent === 0 && !isCommentOrBlank(line) && !line.trimStart().startsWith('-')) {
      currentKeyKeptIdx = classifyMcpKeyLine(line).form !== 'none' ? kept.length : null;
    }
    kept.push(line);
  }
  // Pass 2: retire the keys that lost a managed child. A key that held the
  // devkit child and nothing else drops outright (uninstalling the only
  // server restores the pre-install shape, comment-only bodies count as
  // empty). A DUPLICATE key the old writer appended that kept user servers
  // is consolidated instead: its whole block MOVES under the surviving key
  // — key line and original body lines dropped, the body re-inserted at the
  // survivor's direct-child indent — so the heal leaves one key and never
  // duplicates or mis-nests user content. The survivor is the first BARE
  // key (children only live under bare keys); empty-form duplicates
  // (`{}`, null) retire like any other so they cannot shadow the merged
  // key.
  let out = kept;
  if (!options.keepEmptyKeys) {
    const retireableKeyIdx: number[] = [];
    for (let i = 0; i < kept.length; i++) {
      const form = indentOf(kept[i]!) === 0 ? classifyMcpKeyLine(kept[i]!).form : 'none';
      if (form === 'bare' || form === 'empty') retireableKeyIdx.push(i);
    }
    const firstBare = retireableKeyIdx.find((i) => classifyMcpKeyLine(kept[i]!).form === 'bare');
    const first = firstBare ?? retireableKeyIdx[0];
    const dropLines = new Set<number>();
    const insertions = new Map<number, string[]>();
    if (first !== undefined) {
      let targetIndent: number | null = null;
      let firstEnd = first;
      for (let j = first + 1; j < kept.length; j++) {
        const line = kept[j]!;
        if (isCommentOrBlank(line)) continue;
        if (indentOf(line) === 0 && !line.trimStart().startsWith('-')) break;
        if (targetIndent === null) targetIndent = indentOf(line);
        firstEnd = j;
      }
      // The writer's duplicate-key heal consolidates EVERY duplicate key
      // (consolidateAllKeys), because the re-merge must land under the one
      // surviving key; uninstall consolidates only the keys that held the
      // managed child, restoring the user's own duplicates as they were.
      const retireKeys: number[] = options.consolidateAllKeys
        ? retireableKeyIdx.filter((i) => i !== first)
        : [...emptied].filter((i) => i !== first && retireableKeyIdx.includes(i));
      for (const m of retireKeys) {
        let sourceIndent: number | null = null;
        const body: string[] = [];
        for (let j = m + 1; j < kept.length; j++) {
          const line = kept[j]!;
          // A column-0 comment between the key and its body belongs to the
          // block being retired, not to the next section.
          if (line.trim() === '' || (indentOf(line) === 0 && line.trimStart().startsWith('#'))) {
            dropLines.add(j);
            continue;
          }
          if (indentOf(line) === 0 && !line.trimStart().startsWith('-')) break;
          dropLines.add(j);
          if (sourceIndent === null && indentOf(line) > 0) sourceIndent = indentOf(line);
          body.push(line);
        }
        dropLines.add(m);
        if (body.length === 0) continue;
        const target = targetIndent ?? 2;
        const delta = sourceIndent === null ? 0 : target - sourceIndent;
        const relocated = body.map((line) =>
          delta === 0 ? line : line.replace(/^ +/, (spaces) => ' '.repeat(Math.max(0, spaces.length + delta))),
        );
        insertions.set(firstEnd, [...(insertions.get(firstEnd) ?? []), ...relocated]);
      }
    }
    let dropFirst = false;
    if (first !== undefined && emptied.has(first) && insertions.size === 0) {
      let hasChild = false;
      for (let j = first + 1; j < kept.length; j++) {
        const next = kept[j]!;
        if (isCommentOrBlank(next)) continue;
        hasChild = /^\s/.test(next) || next.trimStart().startsWith('-');
        break;
      }
      dropFirst = !hasChild;
    }
    out = [];
    for (let i = 0; i < kept.length; i++) {
      if (dropLines.has(i)) continue;
      if (dropFirst && i === first) continue;
      out.push(kept[i]!);
      const extra = insertions.get(i);
      if (extra) out.push(...extra);
    }
  }
  const cleaned = out.join(eol).trimEnd();
  writeFileSync(configPath, cleaned ? `${cleaned}${eol}` : '');
  console.log('  MCP config cleaned');
}

export function removeHermesMcpConfigBlock(): void {
  removeManagedChild({ keepEmptyKeys: false });
}
