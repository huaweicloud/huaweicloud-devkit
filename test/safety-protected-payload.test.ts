import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { classifyTextCommand } from '../plugins/huaweicloud-core/src/safety-policy.ts';
import { DEFAULT_POLICY, loadPolicy } from '../plugins/huaweicloud-core/src/safety/default-policy.ts';
import { protectedPayloadWriteDenied } from '../plugins/huaweicloud-core/src/safety/protected-payload.ts';
import { fixtureDir } from './fixture-dir.ts';

// The payload path-write gate (the integrity unit's layer 1): a
// write-shaped command targeting the DEPLOYED payload paths denies on the
// Bash face — the bash-half of the classifier-rewrite residual the edit
// seam closed for edit tools (PR #22). The deny rows pin every required
// write shape (>/>>/tee/cp/mv/dd/install/rsync/sed -i/patch) across the
// deployed-path spellings; the allow rows pin that READ-shaped references
// stay legal (skills reads, skill-tracker, direct inspection) and that
// unrelated paths never changed their verdicts.

const DENY_ROWS: string[] = [
  // The disarm attack itself: the echo that rewrites the deployed
  // classifier through the bash face.
  "echo 'permissive' > ~/.config/opencode/huaweicloud-plugins/dist/safety-policy.js",
  // Redirect variants: append, glued, fd-form, env-assignment head.
  'echo x >> ~/huaweicloud-plugins/dist/safety-policy.js',
  'echo x >~/.config/opencode/huaweicloud-plugins/dist/safety-policy.js',
  'echo x 2> ~/.config/opencode/huaweicloud-plugins/safety/policy.json',
  'P=1 printf x > ~/huaweicloud-plugins/safety/rules/cloud-risk-rules.json',
  // quote pairs inside the path (the shadow candidate carries the
  // contiguous marker).
  "cat /tmp/x > '/home/u/.config/opencode/huaweicloud-plugins/dist/safety-policy.js'",
  "cat /tmp/x > ~/huaweicloud-'plugins'/dist/safety-policy.js",
  // tee, with the prefix heads the anchor admits.
  'echo x | tee ~/.config/opencode/huaweicloud-plugins/dist/safety-policy.js',
  'sudo tee ~/huaweicloud-plugins/safety/policy.json <<EOF',
  'echo x | xargs tee ~/.config/opencode/huaweicloud-plugins/dist/safety-policy.js',
  // The copy family: the marker rides the DESTINATION (last operand).
  'cp /tmp/evil.js ~/.config/opencode/huaweicloud-plugins/dist/safety-policy.js',
  'mv /tmp/x ~/huaweicloud-plugins/dist/safety-policy.js',
  'rsync -av /tmp/x/ ~/.config/opencode/huaweicloud-plugins/safety/',
  'install -m 644 /tmp/x ~/huaweicloud-plugins/dist/safety-policy.js',
  'cp -r /tmp/a ~/huaweicloud-plugins/dist/',
  'sudo cp /tmp/evil.js ~/huaweicloud-plugins/dist/safety-policy.js',
  // dd's of= operand is the output.
  'dd if=/tmp/x of=~/.config/opencode/huaweicloud-plugins/dist/safety-policy.js',
  // sed -i: the in-place edit of the deployed policy.
  "sed -i 's/deny/allow/' ~/huaweicloud-plugins/dist/safety-policy.js",
  // patch: the operand is the file being patched.
  'patch ~/huaweicloud-plugins/safety/policy.json < /tmp/p.diff',
  // Package-root plugin spellings (the npm-package layout).
  'cp /tmp/a /tmp/b plugins/huaweicloud-core/dist/evil.js',
  'echo x > plugins/huaweicloud-core/safety/policy.json',
  'sed -i s/x/y/ plugins/huaweicloud-core/dist/safety/classify-text.js',
  // Windows separators in the deployed path.
  'echo x > C:\\Users\\u\\.config\\opencode\\huaweicloud-plugins\\dist\\safety-policy.js',
  // Compounds: the write rides a later segment.
  'ls /tmp; echo x > ~/.config/opencode/huaweicloud-plugins/dist/safety-policy.js',
  'cp /tmp/a /tmp/b && mv /tmp/b ~/huaweicloud-plugins/dist/safety-policy.js',
  // The classifier-bearing path named inside a script carrier.
  "bash -c 'echo x > ~/huaweicloud-plugins/dist/safety-policy.js'",
];

const ALLOW_ROWS: string[] = [
  // Read-shaped references to the SAME paths stay legal: skills reads,
  // direct inspection, doctor-facing probes.
  'cat ~/.config/opencode/huaweicloud-plugins/dist/safety-policy.js',
  'ls ~/huaweicloud-plugins/skills/',
  'grep -rn reboot plugins/huaweicloud-core/dist/safety-policy.js',
  'grep tee plugins/huaweicloud-core/skills/huawei-ecs/SKILL.md',
  // Direction is honored: the payload path is the SOURCE, the destination
  // is elsewhere — copying OUT never modifies the deployed payload.
  'cat ~/.config/opencode/huaweicloud-plugins/safety/policy.json > /tmp/copy.json',
  'cp ~/huaweicloud-plugins/safety/policy.json /tmp/backup.json',
  'cp -r ~/huaweicloud-plugins/dist /tmp/inspect/',
  'rsync -av ~/huaweicloud-plugins/safety/ /tmp/inspect/',
  // A read-only sed (no -i) over the payload stays allowed.
  "sed 's/a/b/' plugins/huaweicloud-core/dist/safety-policy.js > /tmp/out",
  'sed -n 1p plugins/huaweicloud-core/dist/safety-policy.js',
  // Non-marker payload paths: the write shapes with destinations outside
  // the classifier tree keep their trunk verdicts.
  'cp $(mktemp -d)/x plugins/huaweicloud-core/notes.md',
  'cp -r $(pwd)/src plugins/huaweicloud-core/ && mv $(pwd)/old plugins/huaweicloud-core/old',
  'echo x > /tmp/huaweicloud-plugins-copy',
  // Unrelated-path write shapes are untouched by this gate.
  'mkdir -p $(pwd)/build',
  'docker rm $(docker ps -aq)',
  'git commit -m "sync $(git rev-parse --short HEAD)"',
  'hcloud ECS ListServersDetails',
  // The devkit's own CLI verbs keep their existing verdicts.
  'node ./plugins/huaweicloud-core/dist/setup-cli.js packs status',
];

test('write-shaped commands targeting the deployed payload deny (layer 1)', () => {
  for (const command of DENY_ROWS) {
    const verdict = classifyTextCommand(command);
    assert.equal(verdict.decision, 'deny', `must deny: ${command}`);
    // risk 'invalid': no roster exemption class may skip this deny.
    assert.equal(verdict.risk, 'invalid', `the payload-write deny is exemption-proof: ${command}`);
    assert.match(verdict.reason ?? '', /Writing to the deployed Huawei Cloud DevKit plugin payload is blocked/);
    assert.match(verdict.reason ?? '', /npx huaweicloud-devkit install/);
  }
});

test('read-shaped references and unrelated paths keep their verdicts (layer 1)', () => {
  for (const command of ALLOW_ROWS) {
    const verdict = classifyTextCommand(command);
    assert.equal(verdict.decision, 'allow', `must allow: ${command}: got ${verdict.reason ?? ''}`);
  }
});

test('a read-direction dd over the payload keeps its PRE-EXISTING destructive deny (my gate stays off it)', () => {
  // dd is on the destructive-terminal family regardless of direction (the
  // disk-wipe rule), so this command denies on trunk already. The pin: the
  // payload path rides the if= (SOURCE) side, so the payload-write gate
  // must NOT fire — the surviving deny reason is the destructive rule's,
  // never the payload-write one.
  const verdict = classifyTextCommand('dd if=~/huaweicloud-plugins/dist/safety-policy.js of=/tmp/copy.js');
  assert.equal(verdict.decision, 'deny');
  assert.doesNotMatch(verdict.reason ?? '', /deployed Huawei Cloud DevKit plugin payload/);
  assert.match(verdict.reason ?? '', /destructively dangerous/);
});

test('the marker list is policy-driven: an absent field disables the gate on both shapes', () => {
  // Additive vocabulary: an older deployed policy.json without the key
  // keeps every pre-existing verdict (the gate is off), and the empty-list
  // degraded shape agrees across the face pair — py's load_policy
  // normalizes it to an unset gate, so the TS side's honest mirror is a
  // no-marker policy with the gate off, never a present-but-empty list
  // (loadPolicy throws on that shape, pinned below).
  const legacyPolicy = { ...DEFAULT_POLICY, protectedPayloadPathMarkers: [] };
  const attack = "echo 'permissive' > ~/.config/opencode/huaweicloud-plugins/dist/safety-policy.js";
  assert.equal(protectedPayloadWriteDenied(attack, legacyPolicy), null, 'no markers: the gate is off');
  assert.equal(classifyTextCommand(attack, { policy: legacyPolicy }).decision, 'allow');
  // With the shipped markers the same command denies.
  assert.equal(protectedPayloadWriteDenied(attack, DEFAULT_POLICY)?.decision, 'deny');
});

test('loadPolicy fails loud on a present-but-empty marker list (the emptied-vocabulary doctrine)', () => {
  const dir = fixtureDir('protected-empty-policy-');
  const policy = JSON.parse(JSON.stringify(DEFAULT_POLICY, null, 2)) as Record<string, unknown>;
  policy.protectedPayloadPathMarkers = [];
  writeFileSync(join(dir, 'policy.json'), `${JSON.stringify(policy)}\n`);
  assert.throws(() => loadPolicy(join(dir, 'policy.json')), /must not be empty/);
});

test('loadPolicy surfaces the new key and the shipped policy carries the deployed-path markers', () => {
  assert.deepEqual(DEFAULT_POLICY.protectedPayloadPathMarkers, [
    'huaweicloud-plugins[/\\\\]',
    'huaweicloud-core[/\\\\]dist[/\\\\]',
    'huaweicloud-core[/\\\\]safety[/\\\\]',
  ]);
  // The markers are separator-agnostic: POSIX and Windows spellings of the
  // same deployed path both carry them.
  for (const path of [
    '~/.config/opencode/huaweicloud-plugins/dist/safety-policy.js',
    'C:\\Users\\u\\.config\\opencode\\huaweicloud-plugins\\dist\\safety-policy.js',
    'plugins/huaweicloud-core/dist/safety-policy.js',
    'plugins\\huaweicloud-core\\safety\\policy.json',
  ]) {
    assert.ok(
      DEFAULT_POLICY.protectedPayloadPathMarkers.some((marker) => new RegExp(marker, 'i').test(path)),
      `the marker set must cover the deployed spelling: ${path}`,
    );
  }
});
