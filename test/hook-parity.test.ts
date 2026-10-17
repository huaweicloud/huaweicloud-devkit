import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { classifyTextCommand } from '../plugins/huaweicloud-core/src/safety-policy.ts';

// The TS classifier and the python hook are two hand-maintained
// implementations of one safety policy. This battery runs the SAME command
// list through both and asserts identical verdicts, so vocabulary drift
// between the layers (the failure mode behind several review findings)
// fails CI instead of shipping.

const hookPath = join('plugins', 'huaweicloud-core', 'hooks', 'huaweicloud-safety.py');

function join(...parts: string[]): string {
  return parts.join('/');
}

const BATTERY: Array<[command: string, verdict: 'deny' | 'allow']> = [
  // Reveal face, canonical and adversarial spellings.
  ['npx huaweicloud-devkit secret get secret://user/hw-sk --stdout', 'deny'],
  ["npx huaweicloud-devkit secret 'get' secret://user/hw-sk --stdout", 'deny'],
  ['npx huaweicloud-devkit@latest secret get secret://user/hw-sk', 'deny'],
  ['npm exec huaweicloud-devkit -- secret get secret://user/hw-sk --stdout', 'deny'],
  ["npx huaweicloud-devkit secret $'get' secret://user/hw-sk --stdout", 'deny'],
  ['npx huaweicloud-devkit secret `echo get` secret://user/hw-sk --stdout', 'deny'],
  ["npx $'\\x68'uaweicloud-devkit secret get secret://user/hw-sk --stdout", 'deny'],
  ['echo secret get secret://user/hw-sk --stdout | xargs npx huaweicloud-devkit', 'deny'],
  ['npx huaweicloud-devkit secret list', 'allow'],
  ['npx huaweicloud-devkit secret exec --env K=secret://user/ak -- node script.js', 'allow'],
  // Write gate: separators, command positions, obfuscation.
  ['hcloud ECS CreateServers --server.name=x', 'deny'],
  ['hcloud ECS ListServers\nhcloud ECS CreateServers --server.name=x', 'deny'],
  ['echo hello\nhcloud ECS CreateServers --server.name=x', 'deny'],
  ['hcloud ECS ListServers & hcloud ECS DeleteServers', 'deny'],
  ['for i in 1 2 3; do hcloud ECS DeleteServers --server.id=$i; done', 'deny'],
  ['if hcloud ECS DeleteServers --server.id=x; then echo done; fi', 'deny'],
  ['eval "hcloud ECS DeleteServers --server.id=x"', 'deny'],
  ['exec hcloud ECS DeleteServers --server.id=x', 'deny'],
  ['{ hcloud ECS DeleteServers; }', 'deny'],
  ['case $x in a) hcloud ECS DeleteServers;; esac', 'deny'],
  ['timeout 30 hcloud ECS DeleteServers --server.id=x', 'deny'],
  ['sudo -u root hcloud ECS DeleteServers --server.id=x', 'deny'],
  ['nice -n 10 hcloud ECS DeleteServers --server.id=x', 'deny'],
  ['cat <(hcloud ECS DeleteServers --server.id=x)', 'deny'],
  ['hcloud ECS \\\nDeleteServers --server.id=x', 'deny'],
  ["hclou'd' ECS DeleteServers", 'deny'],
  ["hcloud ECS $'\\x43'reateServers --server.name=x", 'deny'],
  ['npx huaweicloud-devkit secret exec --env K=x -- bash -c "hcloud ECS DeleteServers"', 'deny'],
  [
    'npx huaweicloud-devkit secret list && npx huaweicloud-devkit secret exec -- bash -c "hcloud ECS CreateServers"',
    'deny',
  ],
  ['hcloud OBS rm obs://bucket/obj -f', 'deny'],
  ['hcloud ECS ListServers --cli-region=cn-north-4', 'allow'],
  ['hcloud ECS CreateServers --help', 'allow'],
  ['hcloud OBS ls obs://bucket', 'allow'],
  // Credential files: quoting, normalization, cd-split, the import file.
  ["cat ~/.config/huawei'cloud/secrets'/.master-key", 'deny'],
  ['cat ~/.config/huaweicloud/./credentials.json', 'deny'],
  ['cat ~/.config/huaweicloud//secrets/.master-key', 'deny'],
  ['cd ~/.config/huaweicloud && cat secrets/.master-key', 'deny'],
  ['cat ~/.config/huaweicloud/creds-import.json', 'deny'],
  ['cat /proc/self/environ', 'deny'],
  // Env family: dumps and legitimate neighbors.
  ['env', 'deny'],
  ['printenv', 'deny'],
  ['export', 'deny'],
  ['declare -p', 'deny'],
  ['env | cat', 'deny'],
  ['env | grep HW_ACCESS_KEY', 'deny'],
  ['echo $HW_VAULT_MASTER_KEY', 'deny'],
  ['echo $HW_SECRET_KEY', 'deny'],
  ['env HW_REGION=cn-north-4 hcloud ECS ListServers', 'allow'],
  ['set -e', 'allow'],
  ['make env', 'allow'],
  ['rg env', 'allow'],
  ['printenv PATH', 'allow'],
  ["echo '$HW_SECRET_KEY is a literal'", 'allow'],
  // Prose and heredocs are not commands; same-line commands after a
  // heredoc operator ARE; nested scripts and xargs feeds classify; leading
  // redirects and path-qualified wrappers sit in command position.
  ['echo "step1; hcloud ECS CreateServers --flavor=x"', 'allow'],
  ['git commit -m "chore: cleanup\nhcloud ECS DeleteServers done"', 'allow'],
  ['cat > plan.txt <<EOF\nflavor=x\nEOF', 'allow'],
  ['cat <<EOF; hcloud ECS DeleteServers --server.id=1\nbody\nEOF', 'deny'],
  ['a=1<<2; echo done; hcloud ECS DeleteServers --server.id=1', 'deny'],
  ["bash -c 'hcloud ECS ListServers; hcloud ECS DeleteServers --server.id=1'", 'deny'],
  ['bash -lc "echo x; hcloud ECS DeleteServers"', 'deny'],
  ['echo DeleteServers --server.id=1 | xargs hcloud ECS', 'deny'],
  ['echo DeleteServers | xargs -I {} hcloud ECS {}', 'deny'],
  ['echo ListServers | xargs hcloud ECS', 'allow'],
  ['2>/dev/null hcloud ECS DeleteServers --server.id=x', 'deny'],
  ['<input.txt hcloud ECS DeleteServers --server.id=x', 'deny'],
  ['/usr/bin/time hcloud ECS DeleteServers --server.id=x', 'deny'],
  ['( hcloud ECS DeleteServers --server.id=x )', 'deny'],
  ['( (hcloud ECS DeleteServers) )', 'deny'],
  ['if false; then echo a; elif hcloud ECS DeleteServers --server.id=x; then echo b; fi', 'deny'],
  ['if false; then echo a; else hcloud ECS DeleteServers --server.id=x; fi', 'deny'],
  ['coproc hcloud ECS DeleteServers --server.id=x', 'deny'],
  ['time -p hcloud ECS DeleteServers --server.id=x', 'deny'],
  ['command -p hcloud ECS DeleteServers --server.id=x', 'deny'],
  ["hcloud ECS Cre'ateServers --server.name=x", 'deny'],
  ['hcloud configure show', 'deny'],
  ["hcloud conf'igure' show", 'deny'],
  ["hcloud CSMS show'secret'version --secret_name x", 'deny'],
  ['env -u TERM', 'deny'],
  ['env --unset=TERM', 'deny'],
  ["echo 'a'$HW_SECRET_KEY", 'deny'],
  ['cd ~/.config/huaweicloud && cat credentials.json', 'deny'],
];

test('TS classifier and python hook agree on the shared adversarial battery', () => {
  const mismatches: string[] = [];
  for (const [command, expected] of BATTERY) {
    const ts = classifyTextCommand(command).decision;
    if (ts !== expected) mismatches.push(`TS: want ${expected}, got ${ts}: ${command}`);
    const py = spawnSync('python3', [hookPath], {
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command } }),
      encoding: 'utf8',
      timeout: 30000,
    });
    const unavailable = (py.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
    if (unavailable) continue; // python3 not on PATH: TS-only environment
    const pyVerdict = py.stdout.trim().length > 0 ? 'deny' : 'allow';
    if (pyVerdict !== expected) mismatches.push(`PY: want ${expected}, got ${pyVerdict}: ${command}`);
  }
  assert.deepEqual(mismatches, [], 'layer drift detected');
});
