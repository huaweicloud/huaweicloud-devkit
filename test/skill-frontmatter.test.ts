import assert from 'node:assert/strict';
import test from 'node:test';

import { parseSkillFrontmatter } from '../plugins/huaweicloud-core/src/lib/skill-frontmatter.ts';

// The parser is the one frontmatter reader behind searchDocs, retrieveSkill,
// and list_skills. The corpus shapes are pinned against literals here so a
// regression cannot hide behind "non-empty is good enough": the huawei-ecs
// truncation bug produced a non-empty, quote-prefixed value.

test('parses bare scalars from a plain frontmatter block', () => {
  const fm = parseSkillFrontmatter(
    ['---', 'name: huawei-ecs', 'description: Use ECS instances.', 'version: 1', '---', '', '# body'].join('\n'),
  );
  assert.deepEqual(fm, { name: 'huawei-ecs', description: 'Use ECS instances.', version: '1' });
});

test('strips single quotes from a single-line quoted description with embedded double quotes', () => {
  const fm = parseSkillFrontmatter(
    ['---', 'name: huawei-voucher', 'description: \'查询和领取，提到"领券"时先查状态。\'', 'version: 1', '---'].join(
      '\n',
    ),
  );
  assert.equal(fm.description, '查询和领取，提到"领券"时先查状态。');
  assert.ok(!fm.description!.startsWith("'"), 'the opening YAML quote must not survive the parse');
});

test('folds a multi-line single-quoted description: blank line becomes a newline', () => {
  const fm = parseSkillFrontmatter(
    [
      '---',
      'name: huawei-ecs',
      "description: 'Use when creating ECS instances. NOT for: CCE.",
      '',
      "HC活动场景触发词: HC活动, Nginx部署.'",
      'version: 1',
      '---',
    ].join('\n'),
  );
  assert.equal(fm.description, 'Use when creating ECS instances. NOT for: CCE.\nHC活动场景触发词: HC活动, Nginx部署.');
});

test('folds a line break without a blank line into a space', () => {
  const fm = parseSkillFrontmatter(['---', "description: 'first line", "second line'", '---'].join('\n'));
  assert.equal(fm.description, 'first line second line');
});

test("unescapes '' pairs inside single-quoted scalars", () => {
  const fm = parseSkillFrontmatter(['---', "description: 'it''s quoted'", '---'].join('\n'));
  assert.equal(fm.description, "it's quoted");
});

test('unescapes double-quoted backslash escapes and folds its line breaks', () => {
  // No corpus skill uses this shape; the branch pins the three escapes the
  // parser implements, at the interior positions where they are content.
  const fm = parseSkillFrontmatter(
    ['---', 'description: "say \\"hi\\" to', 'the \\\\ and \\n escape"', '---'].join('\n'),
  );
  assert.equal(fm.description, 'say "hi" to the \\ and \n escape');
});

test('an escaped newline survives at a physical-line boundary', () => {
  // The escape sits at the end of a physical line, where the fold's edge
  // trim would eat it without the guard: escaped content is never trimmed,
  // the physical break after it still folds to a space.
  const fm = parseSkillFrontmatter(['---', 'description: "first part\\n', 'second part"', '---'].join('\n'));
  assert.equal(fm.description, 'first part\n second part');
});

test('an escaped newline at the start of a physical line survives the leading trim', () => {
  // The guard must protect both edges: leading, pure-leading, and trailing
  // positions of the same escape all keep their newline.
  const leading = parseSkillFrontmatter(['---', 'description: "\\nleading newline"', '---'].join('\n'));
  assert.equal(leading.description, '\nleading newline');
  const continuation = parseSkillFrontmatter(['---', 'description: "para one', '\\npara two"', '---'].join('\n'));
  assert.equal(continuation.description, 'para one \npara two');
  // An escape-only physical line exercises both guard edges at once.
  const escapeOnly = parseSkillFrontmatter(['---', 'description: "para one', '\\n', 'para two"', '---'].join('\n'));
  assert.equal(escapeOnly.description, 'para one \n para two');
});

test('a key-shaped line inside a multi-line quoted description is content, not a hijacked field', () => {
  const fm = parseSkillFrontmatter(
    [
      '---',
      "description: 'Use when doing X.",
      'version: 2.5',
      "More text.'",
      'name: real-name',
      'version: 1',
      '---',
    ].join('\n'),
  );
  assert.equal(fm.description, 'Use when doing X. version: 2.5 More text.');
  assert.equal(fm.name, 'real-name');
  assert.equal(fm.version, '1');
});

test('absent frontmatter and absent keys parse to null fields', () => {
  assert.deepEqual(parseSkillFrontmatter('# no frontmatter\nbody'), {
    name: null,
    description: null,
    version: null,
  });
  const fm = parseSkillFrontmatter(['---', 'name: bare', '---'].join('\n'));
  assert.deepEqual(fm, { name: 'bare', description: null, version: null });
});

test('present-but-empty keys parse to null so caller nullish defaults keep firing', () => {
  const fm = parseSkillFrontmatter(['---', 'name:', 'description:', 'version:', '---'].join('\n'));
  assert.deepEqual(fm, { name: null, description: null, version: null });
});

test('CRLF frontmatter folds identically', () => {
  // With body content after the closing fence, the anchor's \r terminator
  // half is exercised — the shape every real CRLF file has (the mutation
  // (?=\n|$) would silently break it).
  const fm = parseSkillFrontmatter(['---', "description: 'line one", '', "line two'", '---', '# body'].join('\r\n'));
  assert.equal(fm.description, 'line one\nline two');
  // A lone \r at EOF still terminates the fence (the pre-anchor shape).
  const loneCr = parseSkillFrontmatter('---\r\nname: x\r\n---\r');
  assert.equal(loneCr.name, 'x');
});

test('a ---prefixed content line inside a quoted description does not terminate the block', () => {
  // The closing fence is anchored to a full line: `---inside` is content.
  // (A genuine bare `---` content line still terminates — YAML itself is
  // ambiguous there, and the corpus carries none.)
  const fm = parseSkillFrontmatter(
    ['---', "description: 'before", '---inside', "after'", 'version: 1', '---'].join('\n'),
  );
  assert.equal(fm.description, 'before ---inside after');
  assert.equal(fm.version, '1');
  // The documented limitation, pinned so an anchor change that silently
  // alters it fails loudly: a bare `---` line inside the scalar terminates.
  const terminated = parseSkillFrontmatter(
    ['---', "description: 'before", '---', 'after', "more'", 'version: 9', '---'].join('\n'),
  );
  assert.equal(terminated.description, 'before');
  assert.equal(terminated.version, null);
});

test('duplicate keys are last-wins', () => {
  const fm = parseSkillFrontmatter(['---', 'name: first', 'name: second', '---'].join('\n'));
  assert.equal(fm.name, 'second');
});

test('a missing closing quote degrades to the rest of the block', () => {
  // The unterminated scalar swallows every later line — including real
  // key lines — which is the honest degrade: the fields behind it are
  // unreachable inside an open quote, and the value says so.
  const fm = parseSkillFrontmatter(['---', "description: 'never closed", 'version: 1', '---'].join('\n'));
  assert.equal(fm.description, 'never closed version: 1');
  assert.equal(fm.version, null);
  assert.equal(fm.name, null);
});
