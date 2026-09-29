import assert from 'node:assert/strict';
import test from 'node:test';

import { buildSkillInstallCommand } from '../plugins/huaweicloud-core/src/search-market.mjs';

const SKILL = { name: 'billing', category: 'bss', service: 'billing' };

test('F: buildSkillInstallCommand uses HTTP ZIP download, never git', () => {
  const cmd = buildSkillInstallCommand(SKILL, '~/.claude/skills');
  assert.match(cmd, /curl -fsSL https:\/\/gitcode\.com/);
  assert.match(cmd, /unzip -oq/);
  assert.doesNotMatch(cmd, /git clone|npx skills add|gitcode\.com\/huaweicloud\/huaweicloud-skills\.git/);
});

test('F: buildSkillInstallCommand builds the exact skill path from category/service', () => {
  const cmd = buildSkillInstallCommand(SKILL, '~/.claude/skills');
  assert.match(cmd, /skills\/bss\/billing\/billing/);
  assert.match(cmd, /cp -r "\$SKILL_SRC" "~\/\.claude\/skills\/billing"/);
});

test('F: buildSkillInstallCommand falls back to find-by-name when category/service missing', () => {
  const cmd = buildSkillInstallCommand({ name: 'huawei-cloud-billing-scout' }, '<skills-dir>');
  assert.doesNotMatch(cmd, /skills\/bss/);
  assert.match(
    cmd,
    /find \/tmp\/hw-skills-net\/huaweicloud-skills-master\/skills .* -name "huawei-cloud-billing-scout"/,
  );
});

test('F: buildSkillInstallCommand reports SKILL_SRC_NOT_FOUND when the folder is absent', () => {
  const cmd = buildSkillInstallCommand(SKILL, '~/.claude/skills');
  assert.match(cmd, /SKILL_SRC_NOT_FOUND/);
});

test('F: buildSkillInstallCommand has GitHub fallback when GitCode download fails', () => {
  const cmd = buildSkillInstallCommand(SKILL, '~/.claude/skills');
  assert.match(cmd, /github\.com\/huaweicloud\/huaweicloud-skills\/archive/);
  assert.match(cmd, /\) \|\| \(/);
});

test('F: buildSkillInstallCommand sanitizes skill name into the target dir name', () => {
  const cmd = buildSkillInstallCommand({ name: 'my skill/../x', category: 'c', service: 's' }, '~/.skills');
  assert.doesNotMatch(cmd, /\/\.\.\//);
  assert.match(cmd, /~\/\.skills\/my-skill----x/);
});

test('P4: buildSkillInstallCommand quotes and sanitizes the caller-supplied skills dir (injection-safe)', () => {
  const cmd = buildSkillInstallCommand(SKILL, '~/.claude/skills; rm -rf /');
  assert.doesNotMatch(cmd, /rm -rf/);
  assert.doesNotMatch(cmd, /skills; /);
  assert.match(cmd, /mkdir -p "~\/\.claude\/skills--rm--rf-\/"/);
});

test('P4: buildSkillInstallCommand keeps simple paths unquoted-safe (spaces become dashes)', () => {
  const cmd = buildSkillInstallCommand(SKILL, '/home/user/my skills');
  assert.doesNotMatch(cmd, /\/home\/user\/my skills/);
  assert.match(cmd, /\/home\/user\/my-skills/);
});

test('P5: buildSkillInstallCommand only copies when the extracted folder has SKILL.md', () => {
  const cmd = buildSkillInstallCommand(SKILL, '~/.claude/skills');
  assert.match(cmd, /test -f "\$SKILL_SRC\/SKILL\.md"/);
  assert.match(cmd, /SKILL_SRC_NOT_FOUND/);
});

test('P5: missing skill folder/skill.md short-circuits the && chain (no cp -r)', () => {
  // The gate branch must end with a failing command, otherwise `echo` (exit 0)
  // would let the && chain continue into mkdir && cp -r.
  const cmd = buildSkillInstallCommand(SKILL, '~/.claude/skills');
  assert.match(cmd, /\(test -d "\$SKILL_SRC" \|\| \{ echo "SKILL_SRC_NOT_FOUND"; false; \}\)/);
  assert.match(cmd, /\(test -f "\$SKILL_SRC\/SKILL\.md" \|\| \{ echo "SKILL_SRC_NOT_FOUND"; false; \}\)/);
  assert.match(cmd, /false;\s*\}\).*&& mkdir -p/s);
});
