// Pure frontmatter field extraction for SKILL.md payloads. The tree's
// frontmatter is hand-written, not YAML-dumper output: name/version are
// bare scalars, description is a single-quoted scalar that may span lines
// (huawei-ecs carries a second paragraph behind a blank line). The old
// inline per-key regexes read only the first line, which truncated every
// multi-line description and kept the YAML quotes inside the value; this
// module is the one parser searchDocs, retrieveSkill, and list_skills
// share. Kept pure (no fs access, no imports) so any zod-free graph — the
// tests today, setup-cli if doctor ever needs it — can consume it.

export interface SkillFrontmatter {
  name: string | null;
  description: string | null;
  version: string | null;
}

// NULs guard an escaped newline (double-quoted "\n") through the fold on
// BOTH edges: trim() treats them as content boundaries, so the edge-trim
// YAML folding requires cannot eat what an escape produced, whether the
// escape leads or trails its physical line. Stripped in the final value; a
// literal NUL cannot appear in hand-written skill files.
const ESCAPED_NEWLINE = '\u0000\n\u0000';

// Read the quoted scalar opening at text[start] (the quote character).
// Returns the folded value plus the index just past the closing quote, so
// the sequential field walker resumes key detection AFTER the scalar, never
// inside it. Folding: a single break between content lines becomes a space,
// k blank lines become k newlines. Single-quoted '' pairs unescape to one
// quote; double-quoted \" \\ \n unescape inline (\t, \uXXXX escapes and
// backslash line continuation are NOT supported — the corpus carries no
// double-quoted values, so the branch pins only the escapes it implements).
// A missing closing quote degrades to "everything to the end of the block"
// instead of throwing: the input is local skill data, not a trust boundary,
// and a truncated tree must not take the disclosure tools down with it.
function readQuotedScalar(text: string, start: number, quote: "'" | '"'): { value: string; end: number } {
  let value = '';
  let line = '';
  let blanks = 0;
  let i = start + 1;
  const flushLine = (): void => {
    const trimmed = line.trim();
    line = '';
    if (trimmed === '') {
      if (value !== '') blanks++;
      return;
    }
    if (value === '') value = trimmed;
    else if (blanks > 0) {
      value += '\n'.repeat(blanks) + trimmed;
      blanks = 0;
    } else {
      value += ' ' + trimmed;
      blanks = 0;
    }
  };
  const finish = (end: number): { value: string; end: number } => {
    flushLine();
    return { value: value.replaceAll('\u0000', ''), end };
  };
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '\n') {
      flushLine();
      i++;
      continue;
    }
    if (ch === '\r') {
      i++;
      continue;
    }
    if (quote === "'") {
      if (ch === "'") {
        if (text[i + 1] === "'") {
          line += "'";
          i += 2;
          continue;
        }
        return finish(i + 1);
      }
      line += ch;
      i++;
      continue;
    }
    if (ch === '\\') {
      const next = text[i + 1];
      if (next === '"' || next === '\\') {
        line += next;
        i += 2;
        continue;
      }
      if (next === 'n') {
        line += ESCAPED_NEWLINE;
        i += 2;
        continue;
      }
    }
    if (ch === '"') {
      return finish(i + 1);
    }
    line += ch;
    i++;
  }
  return finish(text.length);
}

// Sequential field walk over the frontmatter block: `key:` lines are
// recognized only OUTSIDE quoted scalars, and a quoted scalar consumes
// through its closing quote before the walk resumes. A key-shaped line
// inside a multi-line description (a "version: 2" example, a trigger list)
// is therefore description content, never a hijacked field — the per-key
// regexes this walker replaced could not tell the two apart. Unquoted
// values read as single-line (the corpus never continues a bare scalar);
// a key that is present but empty yields null so caller defaults keyed to
// nullish keep firing exactly as the old (.+) regexes made them. Duplicate
// keys are last-wins (Map.set) — the old per-key regexes took the first,
// but no corpus file carries duplicates and last-wins is the simpler
// contract to pin.
function parseFrontmatterFields(block: string): Map<string, string | null> {
  const fields = new Map<string, string | null>();
  let i = 0;
  while (i < block.length) {
    const lineEnd = block.indexOf('\n', i);
    const stop = lineEnd === -1 ? block.length : lineEnd;
    const line = block.slice(i, stop).replace(/\r$/, '');
    const keyMatch = line.match(/^([A-Za-z0-9_-]+):[ \t]*(.*)$/);
    if (keyMatch) {
      const key = keyMatch[1]!;
      const first = keyMatch[2]!;
      const opening = first[0];
      if (opening === "'" || opening === '"') {
        // The capture is the tail of the matched line, so its start offset
        // within the line locates the opening quote in the raw block.
        const valueStart = i + keyMatch[0].length - first.length;
        const { value, end } = readQuotedScalar(block, valueStart, opening);
        fields.set(key, value === '' ? null : value);
        i = end;
        const nextLine = block.indexOf('\n', i);
        i = nextLine === -1 ? block.length : nextLine + 1;
        continue;
      }
      const trimmed = first.trim();
      fields.set(key, trimmed === '' ? null : trimmed);
    }
    i = stop + 1;
  }
  return fields;
}

export function parseSkillFrontmatter(content: string): SkillFrontmatter {
  // The closing fence is anchored to a full line so a `---inside` content
  // line inside a quoted description cannot terminate the block early, and
  // the terminator lookahead accepts a bare \r so a lone-CR-at-EOF fence
  // still parses (the shape the pre-anchor regex accepted). A genuine bare
  // `---` line inside a quoted scalar still terminates it — YAML itself is
  // ambiguous there and the corpus carries no such line.
  const block = content.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?=[\r\n]|$)/);
  if (!block) return { name: null, description: null, version: null };
  const fields = parseFrontmatterFields(block[1]!);
  const field = (key: string): string | null => {
    const value = fields.get(key);
    return value === undefined ? null : value;
  };
  return { name: field('name'), description: field('description'), version: field('version') };
}
