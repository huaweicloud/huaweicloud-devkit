// Workspace-pattern matching with npm's semantics. `@npmcli/map-workspaces`
// expands the declared patterns with `glob` (minimatch) and ignores the
// negated ones; this module ports the slice of that language a workspace
// declaration realistically uses: brace expansion, character classes,
// extglob alternatives, `*` inside one segment, `**` across whole segments,
// `dot: false`, `!!` parity, the per-pattern negation cancellation order, and
// the trailing-`**` parent directory. It stays dependency-free so the update
// graph can carry it into both the unbundled setup CLI and the bundled server.
// Two edges stay outside the port: POSIX bracket classes (`[[:alpha:]]`) are
// not expanded, and an explicit dot segment after `**` (`packages/**/.*`) is a
// member here where map-workspaces' partial post-filter drops it (ledgered).
// An extglob alternative containing `/` is literalized; both sides match
// nothing there.

const GLOBSTAR = '\u0000globstar';

function escapeRegExp(char: string): string {
  return /[.*+?^${}()|[\]\\]/.test(char) ? `\\${char}` : char;
}

function findBrace(pattern: string): { start: number; end: number } | undefined {
  let start = -1;
  let depth = 0;
  let escaped = false;
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '{') {
      if (depth === 0) start = index;
      depth += 1;
    } else if (char === '}' && depth > 0) {
      depth -= 1;
      if (depth === 0) return { start, end: index };
    }
  }
  return undefined;
}

function splitBraceAlternatives(body: string): string[] | undefined {
  const parts: string[] = [];
  let depth = 0;
  let from = 0;
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index]!;
    if (char === '{') depth += 1;
    else if (char === '}') depth -= 1;
    else if (char === ',' && depth === 0) {
      parts.push(body.slice(from, index));
      from = index + 1;
    }
  }
  if (!parts.length) return undefined;
  parts.push(body.slice(from));
  return parts;
}

function expandBraceRange(body: string): string[] | undefined {
  const match = /^(-?\d+|[A-Za-z])\.\.(-?\d+|[A-Za-z])(?:\.\.(-?\d+))?$/.exec(body);
  if (!match) return undefined;
  const [, fromRaw, toRaw, stepRaw] = match;
  const numeric = /^-?\d+$/.test(fromRaw!) && /^-?\d+$/.test(toRaw!);
  const from = numeric ? Number(fromRaw) : (fromRaw!.codePointAt(0) ?? 0);
  const to = numeric ? Number(toRaw) : (toRaw!.codePointAt(0) ?? 0);
  const step = Math.abs(Number(stepRaw ?? 1)) || 1;
  const padded = numeric && (/^-?0\d/.test(fromRaw!) || /^-?0\d/.test(toRaw!));
  const pad = padded ? Math.max(fromRaw!.length, toRaw!.length) : 0;
  const out: string[] = [];
  const direction = from <= to ? 1 : -1;
  for (let value = from; direction > 0 ? value <= to : value >= to; value += direction * step) {
    if (numeric) {
      const text = String(Math.abs(value));
      const sign = value < 0 ? '-' : '';
      out.push(sign + (pad ? text.padStart(pad, '0') : text));
    } else {
      out.push(String.fromCodePoint(value));
    }
  }
  return out;
}

function expandBraces(pattern: string): string[] {
  const brace = findBrace(pattern);
  if (!brace) return [pattern];
  const body = pattern.slice(brace.start + 1, brace.end);
  const prefix = pattern.slice(0, brace.start);
  const suffix = pattern.slice(brace.end + 1);
  const alternatives = splitBraceAlternatives(body) ?? expandBraceRange(body);
  if (alternatives) return alternatives.flatMap((alt) => expandBraces(prefix + alt + suffix));
  // A brace without a top-level comma or range is not an expansion point, but
  // braces nested inside it may still expand (npm's `{a{b,c}}` → `{ab}`,`{ac}`).
  const inner = expandBraces(body);
  if (inner.length === 1 && inner[0] === body) return [pattern];
  return inner.map((alt) => `${prefix}{${alt}}${suffix}`);
}

type CharClass = { source: string; end: number; dotOnly: boolean };

function parseCharClass(pattern: string, start: number): CharClass | undefined {
  let index = start + 1;
  let negated = false;
  if (pattern[index] === '!' || pattern[index] === '^') {
    negated = true;
    index += 1;
  }
  let content = '';
  let first = true;
  while (index < pattern.length) {
    const char = pattern[index]!;
    if (char === ']' && !first) break;
    content += char;
    first = false;
    index += 1;
  }
  if (pattern[index] !== ']') return undefined;
  let body = '';
  for (const char of content) {
    if (char === '\\' || char === ']' || char === '^') body += `\\${char}`;
    else body += char;
  }
  return {
    source: negated ? `[^${body}]` : `[${body}]`,
    end: index + 1,
    dotOnly: !negated && content === '.',
  };
}

function findCloseParen(pattern: string, start: number): number {
  let depth = 0;
  for (let index = start; index < pattern.length; index += 1) {
    const char = pattern[index]!;
    if (char === '(') depth += 1;
    else if (char === ')') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function splitExtglobAlternatives(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let classOpen = false;
  let from = 0;
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index]!;
    if (char === '[') classOpen = true;
    else if (char === ']') classOpen = false;
    else if (classOpen) continue;
    else if (char === '(') depth += 1;
    else if (char === ')') depth -= 1;
    else if (char === '|' && depth === 0) {
      parts.push(body.slice(from, index));
      from = index + 1;
    }
  }
  parts.push(body.slice(from));
  return parts;
}

function segmentSource(segment: string): string {
  let source = '';
  for (let index = 0; index < segment.length; index += 1) {
    const char = segment[index]!;
    if ('@+*?!'.includes(char) && segment[index + 1] === '(') {
      const close = findCloseParen(segment, index + 1);
      if (close < 0) {
        source += escapeRegExp(char);
        continue;
      }
      const alternatives = splitExtglobAlternatives(segment.slice(index + 2, close));
      // Alternatives containing a path separator are outside the ported subset.
      if (alternatives.some((alt) => alt.includes('/'))) {
        source += escapeRegExp(segment.slice(index, close + 1));
        index = close;
        continue;
      }
      const inner = alternatives.map((alt) => segmentSource(alt)).join('|') || '';
      if (char === '@') source += `(?:${inner})`;
      else if (char === '?') source += `(?:${inner})?`;
      else if (char === '*') source += `(?:${inner})*`;
      else if (char === '+') source += `(?:${inner})+`;
      else source += `(?!(?:${inner})$)[^/]*`;
      index = close;
      continue;
    }
    if (char === '*') {
      // `**` glued to a literal stays inside one segment (minimatch's `*b`).
      while (segment[index + 1] === '*') index += 1;
      source += '[^/]*';
      continue;
    }
    if (char === '?') {
      source += '[^/]';
      continue;
    }
    if (char === '[') {
      const parsed = parseCharClass(segment, index);
      if (parsed) {
        source += parsed.dotOnly ? '\\.' : parsed.source;
        index = parsed.end - 1;
        continue;
      }
    }
    source += escapeRegExp(char);
  }
  return source;
}

// A leading dot is visible to a wildcard only when the segment's first token
// names it: a literal `.`, a class that folds to exactly `.`, or an extglob
// alternative that allows it (minimatch's `dot: false`).
function segmentAllowsDot(segment: string): boolean {
  if (segment === '' || segment[0] === '.') return true;
  if (segment[0] === '[') return parseCharClass(segment, 0)?.dotOnly ?? false;
  const operator = segment[0]!;
  if ('@+*?!'.includes(operator) && segment[1] === '(') {
    if (operator === '!') return false;
    const close = findCloseParen(segment, 1);
    if (close < 0) return false;
    return splitExtglobAlternatives(segment.slice(2, close)).some((alt) => segmentAllowsDot(alt));
  }
  return false;
}

function matchSegment(part: string, segment: string): boolean {
  if (segment === '') return part === '';
  if (part === '') return false;
  if (part.startsWith('.') && !segmentAllowsDot(segment)) return false;
  try {
    return new RegExp(`^${segmentSource(segment)}$`).test(part);
  } catch {
    // npm/minimatch silently match nothing for an invalid class (a reversed
    // range); a hostile declaration is input, never a crash source.
    return false;
  }
}

function matchSegments(path: readonly string[], pattern: readonly string[], patternIndex = 0, pathIndex = 0): boolean {
  if (patternIndex === pattern.length) return pathIndex === path.length;
  const segment = pattern[patternIndex]!;
  if (segment === GLOBSTAR) {
    if (matchSegments(path, pattern, patternIndex + 1, pathIndex)) return true;
    if (pathIndex >= path.length) return false;
    const part = path[pathIndex]!;
    if (part === '.' || part === '..' || part.startsWith('.')) return false;
    return matchSegments(path, pattern, patternIndex, pathIndex + 1);
  }
  if (pathIndex >= path.length) return false;
  if (!matchSegment(path[pathIndex]!, segment)) return false;
  return matchSegments(path, pattern, patternIndex + 1, pathIndex + 1);
}

function splitPath(value: string): string[] {
  // minimatch coalesces repeated slashes unless `preserveMultipleSlashes`.
  const trimmed = value.replace(/\/+$/, '');
  return trimmed ? trimmed.split(/\/+/) : [];
}

function patternSegments(pattern: string): string[] {
  const normalized: string[] = [];
  for (const segment of splitPath(pattern)) {
    if (segment === '.') continue;
    if (segment === '..') {
      const previous = normalized.at(-1);
      if (previous !== undefined && previous !== '..' && previous !== GLOBSTAR) normalized.pop();
      else normalized.push(segment);
      continue;
    }
    normalized.push(segment === '**' ? GLOBSTAR : segment);
  }
  return normalized;
}

// A directory's membership: the path is matched as a directory (map-workspaces
// appends `/` to each positive glob), so a trailing `**` covers the glob's own
// parent (`packages/**` matches `packages`).
function matchDirectory(relativePath: string, pattern: string): boolean {
  return expandBraces(pattern).some((expanded) => matchSegments(splitPath(relativePath), patternSegments(expanded)));
}

// Pattern-vs-pattern comparisons inside the negation cancellation treat the
// first argument as a literal path string, as minimatch does.
function matchesPatternString(pathString: string, pattern: string): boolean {
  return expandBraces(pattern).some((expanded) => matchSegments(splitPath(pathString), patternSegments(expanded)));
}

function orderPatterns(globs: readonly string[]): { patterns: string[]; negated: string[] } {
  const patterns: string[] = [];
  const negated: string[] = [];
  for (const raw of globs) {
    const excl = /^!+/.exec(raw);
    let pattern = excl ? raw.slice(excl[0].length) : raw;
    pattern = pattern.replace(/^\.?\/+/, '').replace(/\\/g, '/');
    const negate = Boolean(excl && excl[0].length % 2 === 1);
    if (negate) {
      negated.push(pattern);
      continue;
    }
    // A later positive pattern overrides the earlier negation it covers.
    for (let index = 0; index < negated.length; index += 1) {
      if (matchesPatternString(pattern, negated[index]!)) negated.splice(index, 1);
    }
    patterns.push(pattern);
  }
  // An un-cancelled negation removes the positive patterns it covers.
  for (const blocked of negated) {
    for (const pattern of [...patterns]) {
      if (matchesPatternString(pattern, blocked)) patterns.splice(patterns.indexOf(pattern), 1);
    }
  }
  return { patterns, negated };
}

/**
 * Whether `memberPath` (relative, POSIX separators) is a workspace member of
 * the given declaration, matching `@npmcli/map-workspaces` semantics.
 */
export function workspaceMemberMatch(memberPath: string, globs: readonly string[]): boolean {
  try {
    if (!memberPath || memberPath === '..' || memberPath.startsWith('../')) return false;
    const segments = memberPath.split('/');
    // map-workspaces ignores `**/node_modules/**` before the pattern list
    // applies; glob's directory candidates end in `/`, so the node_modules
    // directory itself is covered too.
    if (segments.includes('node_modules')) return false;
    const { patterns, negated } = orderPatterns(globs);
    if (negated.some((blocked) => matchDirectory(memberPath, blocked))) return false;
    return patterns.some((pattern) => matchDirectory(memberPath, pattern));
  } catch {
    // Any unexpected glob syntax degrades to a non-member, never a throw.
    return false;
  }
}
