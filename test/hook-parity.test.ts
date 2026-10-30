import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { classifyTextCommand } from '../plugins/huaweicloud-core/src/safety-policy.ts';
import {
  decodeAnsiCSpans,
  splitSimpleCommand,
  splitSimpleCommandGlued,
} from '../plugins/huaweicloud-core/src/safety/shell-text.ts';

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
  // #927 audit bypass fix: ANSI-C keyword mangling ($'\x68'cloud = hcloud) —
  // both layers deny via the write-vocabulary clause of the obfuscation gate.
  ["$'\\x68'cloud ECS DeleteServers --server.name=x", 'deny'],
  ["hcl$'\\x6f'ud ECS DeleteServers --server.name=x", 'deny'],
  // port-v2defects (interrogate round): the py hook's WRITE_VOCAB_RE was a
  // hardcoded 20-word copy of policy.json's 37 writeOperationPrefixes — the
  // 17 missing words (invoke/execute/trigger/deploy among them, the
  // doctrine-named write families) let these mangled writes through the
  // py-hook faces (Hermes importlib, WorkBuddy deploy) while the TS layer
  // denied. The py vocabulary now derives from the same policy list; these
  // pins mirror the DeleteServers pin above for each family. Operation
  // spellings pin the classifier's write-prefix clause — FunctionGraph
  // InvokeFunction is the corpus-real anchor, the others are shaped.
  ["$'\\x68'cloud FunctionGraph InvokeFunction --func_urn=x", 'deny'],
  ["$'\\x68'cloud CodeArtsDeploy ExecuteDeployTask --task_id=x", 'deny'],
  ["$'\\x68'cloud CES TriggerAlarmPolicy --alarm_id=x", 'deny'],
  ["$'\\x68'cloud CodeArtsDeploy DeployApplication --app_id=x", 'deny'],
  // port-v2defects (interrogate round 1): the mangled OBS subcommand face —
  // routing dies with the keyword, so the obfuscation gate's write
  // vocabulary is the only layer that can fire, and its OBS arm (unioned
  // with OBSUTIL_WRITES on both layers) closes the non-prefix subcommand
  // writes (rm/cp/sync/chattri…). Read subcommands stay allowed.
  ["$'\\x68'cloud OBS rm obs://b -f", 'deny'],
  ["$'\\x68'cloud OBS cp obs://src obs://dst", 'deny'],
  ["$'\\x68'cloud OBS sync obs://b obs://c", 'deny'],
  ["$'\\x68'cloud OBS chattri obs://b -acl=public-read", 'deny'],
  // port-v2defects (interrogate round 3): with the ANSI-C decode feeding
  // the gate's candidates, EVERY $'-mangled cloud command denies rather
  // than parses (the #727 doctrine — an op-mangled read with a literal bin
  // already denied); these read controls flipped from allow, and now pin
  // the uniform mangled-read verdict.
  ["$'\\x68'cloud OBS ls obs://bucket", 'deny'],
  ["$'\\x68'cloud OBS stat obs://b/o", 'deny'],
  // port-v2defects (interrogate round 3): the decode closes the
  // mangle-past-the-marker bypass — h$'\x63'loud reconstructs to the hcloud
  // the shell executes, so the decoded candidate feeds the bin/secret/vocab
  // clauses no matter WHICH letters were escaped (bin, service token,
  // operation word — hex, octal, or unicode), and bin+op both-mangled no
  // longer sidesteps the vocabulary family.
  ["h$'\\x63'loud $'\\x4f'BS rm mybucket", 'deny'],
  ["h$'\\143'loud $'\\117'BS cp obs://src obs://dst", 'deny'],
  ["h$'\\u0063'loud $'\\u004f'BS sync obs://b obs://c", 'deny'],
  ["$'\\x68'$'\\x63'loud ECS $'\\x44'eleteServers --server.id=x", 'deny'],
  ["h$'\\x63'loud ECS ListServers", 'deny'],
  ["h$'\\x63'loud configure show", 'deny'],
  // port-v2defects (interrogate round 4): the phantom-quote defeat — a
  // backslash-escaped quote OUTSIDE quotes opened phantom quote state in
  // the decoders and disabled the whole decode for the rest of the payload
  // (\' ; h$'\x63'loud … allowed on every layer while bash ran the write).
  // The outside-quote backslash branch closes it; \$' stays \$ + plain
  // quotes (the echo \$'hcloud' shape still denies via the PRE-EXISTING
  // stripped-shadow class — recorded residual, not pinned here).
  ["\\' ; h$'\\x63'loud ECS $'\\x44'eleteServers --server.id=x", 'deny'],
  ["\\\" ; h$'\\x63'loud ECS $'\\x44'eleteServers --server.id=x", 'deny'],
  ["\\' ; h$'\\x63'loud $'\\x4f'BS rm mybucket", 'deny'],
  ["grep foo\\' bar ; h$'\\x63'loud ECS $'\\x44'eleteServers", 'deny'],
  // port-v2defects (interrogate round 4): the line-continuation channel —
  // bash removes the \\<LF> pair at parser level, and the surviving
  // newline broke contiguity in every shadow (h\\<LF>cloud never routed;
  // De\\<LF>leteServers never matched a prefix). The pair now drops in the
  // segment splitters, the tokenizers, and the quote-stripped shadows —
  // inside single quotes the pair is literal and over-stripping there
  // only ever joins text (fail-closed, never hides a marker).
  ['h\\\ncloud ECS DeleteServers --server.id=x', 'deny'],
  ['hcloud ECS De\\\nleteServers --server.id=x', 'deny'],
  ['hcloud ECS "De\\\nleteServers" --server.id=x', 'deny'],
  ['h\\\ncloud OBS rm mybucket', 'deny'],
  ["printf $'%s\\n' hello", 'allow'],
  ["echo $(date +$'%Y-%m-%d')", 'allow'],
  ["awk $'\\t' '{print $1}'", 'allow'],
  // port-v2defects (interrogate round 5): the over-cap slice — the round-4
  // decode skip made >256 KiB the one place a fully-mangled write sailed
  // through on every layer (executable proof supplied by the reviewer: bash
  // ran it). The cap now denies expansion-bearing over-cap payloads
  // fail-closed (bytes on both twins — the UTF-16/code-point boundary
  // drift died with the unit alignment), and a benign over-cap payload
  // stays allowed.
  ['#' + 'x'.repeat(262200) + "\nh$'\\x63'loud ECS $'\\x44'eleteServers --server.id=x", 'deny'],
  ['#' + 'x'.repeat(262200) + '\necho hello', 'allow'],
  // port-v2defects (interrogate round 6): the composition channel — bash
  // removes \\<LF> BEFORE tokenization, reassembling $'/$( across the break,
  // so h$\\<LF>'\\x63'loud executes as a mangled write while the raw text
  // carries only $. The expansion check and the decode now run on the
  // continuation-dropped text (both twins): over-cap composed shapes deny
  // at the cap, tiny ones through the obfuscation gate. Also the surrogate
  // row (a lone \ud800 crashed the py hook verdict-less — read as allow —
  // before the "replace" byte count) and the astral-boundary row (the cap
  // counts BYTES: astral padding between the old unit-caps must deny with
  // an expansion-bearing tail, on both layers).
  ["hcloud ECS $\\\n'\\x44'eleteServers --server.id=x", 'deny'],
  ["h$\\\n'\\x63'loud ECS DeleteServers --server.id=x", 'deny'],
  ['#' + 'x'.repeat(262200) + "\nh$\\\n'\\x63'loud ECS $\\\n'\\x44'eleteServers --server.id=x", 'deny'],
  ['hcloud ECS DeleteServers --server.id=x \ud800', 'deny'],
  ['echo hello \ud800', 'allow'],
  // The surrogate BOUNDARY parity row (interrogate round 7): 131,072 lone
  // surrogates + an expansion tail is ~131 KB under round-6's py count (1
  // byte each) but ~393 KB under TS's U+FFFD count (3 bytes each). This
  // row's payload is the count-parity SHAPE (an expansion-bearing echo) —
  // the write bypass itself was the reviewer's separate printf-mangled
  // payload, denied by the cap's expansion arm; this row flips if the
  // counts drift apart again (round 8 wording fix: it never reproduced the
  // bypass).
  ['\ud800'.repeat(131072) + 'echo $(date)', 'deny'],
  // Whitespace-only commands (interrogate round 8): the TS twin's risk-rule
  // engine denies them ("command must be a non-empty string" — JS trim also
  // strips \ufeff); the py layer allowed them, a verdict drift in the
  // battery's own contract class. Mirrored.
  ['', 'deny'],
  [' ', 'deny'],
  ['\n', 'deny'],
  ['﻿', 'deny'],
  // port-v2defects (interrogate round 9): the glued-bin family — bash glues
  // adjacent quoted spans and word characters into ONE word, so
  // "hcl"oud ECS Delete runs hcloud with full argv while the span/fragment
  // tokenizers never yield an hcloud-leading stream. The write gate's glued
  // fallback (split_tokens_glued / splitSimpleCommandGlued, routed-only)
  // classifies the reassembled argv; the trailing-glued INPUT redirect
  // family (hcloud<f2 args…, xargs hcloud<f, xargs hcloud<<EOF) peels in
  // the head predicates and routes through the narrow tail's new '<'.
  ['"hcl"oud ECS DeleteServers --server.id=x', 'deny'],
  ["'hcl''oud' ECS DeleteServers --server.id=x", 'deny'],
  ['hcl"oud" ECS DeleteServers --server.id=x', 'deny'],
  ['"hcl""oud" ECS DeleteServers --server.id=x', 'deny'],
  ['"hcl"oud OBS rm obs://b -f', 'deny'],
  ['"hcl"oud ECS ListServers', 'allow'],
  ['hcloud<f2 ECS DeleteServers --server.id=x', 'deny'],
  ['hcloud<f2 ECS ListServers', 'allow'],
  ["printf 'ECS DeleteServers --server.id=x' >f; xargs hcloud<f", 'deny'],
  ['xargs hcloud<<EOF\nECS DeleteServers --server.id=x\nEOF', 'deny'],
  // port-v2defects (interrogate round 10): the glued gate's full-grammar
  // completion — the round-9 hand-rolled prefix walk missed shells/eval/
  // env assignments/redirections/wrappers and multi-segment payloads, and
  // a leading READ masked a later glued write (`not saw_leading`). All
  // real-bash-executable proofs from the round; the nested scripts flatten
  // through the glued tokenizer (py's recursion doctrine).
  ['bash -c \'"hcl"oud ECS Delete\'', 'deny'],
  ['bash -c "\\"hcl\\"oud ECS Delete"', 'deny'],
  ['sh -c "\'hcl\'oud ECS Delete"', 'deny'],
  ['eval \'"hcl"oud ECS Delete\'', 'deny'],
  ['eval "hcl"oud ECS Delete', 'deny'],
  ['HW_REGION=x "hcl"oud ECS Delete', 'deny'],
  ['env HW_REGION=x "hcl"oud ECS Delete', 'deny'],
  ['2>/dev/null "hcl"oud ECS Delete', 'deny'],
  ['<in "hcl"oud ECS Delete', 'deny'],
  ['skill-quality-cli run -- "hcl"oud ECS Delete', 'deny'],
  ['huaweicloud-devkit secret exec --env N=secret://s/n -- "hcl"oud ECS Delete', 'deny'],
  ['echo x; "hcl"oud ECS Delete', 'deny'],
  ['true && "hcl"oud ECS Delete', 'deny'],
  ['hcloud ECS ListServers; "hcl"oud ECS Delete', 'deny'],
  ['hcloud --help; "hcl"oud OBS rm mybucket', 'deny'],
  // port-v2defects (interrogate round 11): the script-carrier completion —
  // prefix-wrapped shells (env/sudo/timeout/secret-exec/skill-quality +
  // bash -c), redirection-first scripts (2>/dev/null, 2>&1 — the `&` of a
  // redirection-dup operator is part of the token, not a separator),
  // heredoc/herestring bodies as shell scripts, watch's sh -c join, glued
  // xargs bins fed by the pipe, and quote-mangled ARGV under a
  // plain-leading bin (the ownership is the verdict comparison, not a
  // skip). All real-bash-executable proofs from the round.
  ['env HW_REGION=x bash -c \'"hcl"oud ECS Delete\'', 'deny'],
  ['sudo bash -c \'"hcl"oud ECS Delete\'', 'deny'],
  ['timeout 5 bash -c \'"hcl"oud ECS Delete\'', 'deny'],
  ['huaweicloud-devkit secret exec --env K=x -- bash -c \'"hcl"oud ECS Delete\'', 'deny'],
  ['skill-quality-cli run -- bash -c \'"hcl"oud ECS Delete\'', 'deny'],
  ['2>/dev/null bash -c \'"hcl"oud ECS Delete\'', 'deny'],
  ['2>&1 bash -c \'"hcl"oud ECS Delete\'', 'deny'],
  ['2>/dev/null eval \'"hcl"oud ECS Delete\'', 'deny'],
  ['hcloud ECS "De"leteServers', 'deny'],
  ['hcloud "EC"S DeleteServers', 'deny'],
  ['hcloud OB"S" rm obs://bucket/obj -f', 'deny'],
  ['hcloud config"ure" show', 'deny'],
  ['hcloud ECS Li"stServers', 'allow'],
  ['bash <<EOF\n"hcl"oud ECS DeleteServers --server.id=x\nEOF', 'deny'],
  ['bash <<EOF\nhcloud ECS DeleteServers\nEOF', 'deny'],
  ["bash <<'EOF'\nhcloud ECS DeleteServers\nEOF", 'deny'],
  ["bash <<<'hcloud ECS Delete'", 'deny'],
  ['bash <<EOF\nhcloud ECS ListServers\nEOF', 'allow'],
  ['cat <<EOF\nhcloud ECS DeleteServers\nEOF', 'allow'],
  ['echo ECS Delete | xargs "hcl"oud', 'deny'],
  ['echo List | xargs "hcl"oud && echo done', 'allow'],
  ['watch -n1 \'"hcl"oud ECS Delete\'', 'deny'],
  ['watch -n 5 hcloud ECS ListServers', 'allow'],
  ['bash -c "echo x; \\"hcl\\"oud ECS Delete"', 'deny'],
  ['bash -c \'hcloud ECS ListServers; "hcl"oud ECS Delete\'', 'deny'],
  ['bash -c "if true; then \\"hcl\\"oud ECS Delete; fi"', 'deny'],
  ['bash -c "echo x; \\"hcl\\"oud ECS ListServers"', 'allow'],
  ['2>&1 hcloud ECS ListServers', 'allow'],
  // port-v2defects (interrogate round 12): the script-carrier details —
  // heredoc markers with double-quoted delimiters, flags between the shell
  // and the marker (`bash -s <<EOF`), trailing live text on the marker
  // line (`bash <<EOF 2>/dev/null`, the `;`/`&&` splits whose body lands
  // in the NEXT segment), flags before -c (`bash -e -c`), a `<<<` line
  // INSIDE a body (body text, not the marker), find -exec command
  // positions (plain and mangled), interpreter system() carriers, glued
  // xargs bins with their own argv, 11+ strippable stacks, and the
  // deep-nest `'\''` idiom at depths 8-9 (the script-shadow pass — both
  // twins had missed the executable zone). The over-deny control: a shell
  // word in ARGUMENT position (`echo sh <<EOF`) does not make the body a
  // script.
  ['bash <<"EOF"\nhcloud ECS DeleteServers\nEOF', 'deny'],
  ['bash -s <<EOF\nhcloud ECS DeleteServers\nEOF', 'deny'],
  ['bash -x <<EOF\nhcloud ECS DeleteServers\nEOF', 'deny'],
  ['bash <<EOF 2>/dev/null\nhcloud ECS DeleteServers\nEOF', 'deny'],
  ['bash <<EOF; echo hi\nhcloud ECS DeleteServers\nEOF', 'deny'],
  ['bash <<EOF && echo done\nhcloud ECS DeleteServers\nEOF', 'deny'],
  ['bash <<EOF\nhcloud ECS DeleteServers\n<<< harmless\nEOF', 'deny'],
  ["bash -e -c 'hcloud ECS DeleteServers'", 'deny'],
  ['bash -u -c \'"hcl"oud ECS Delete\'', 'deny'],
  ['find /tmp -name x.log -exec hcloud ECS DeleteServers {} \\;', 'deny'],
  ['find /tmp -name x.log -exec "hcl"oud ECS Delete {} \\;', 'deny'],
  ['find /tmp -name x.log -exec hcloud ECS DeleteServers {} +', 'deny'],
  ['python3 -c \'import os; os.system("hcloud ECS DeleteServers")\'', 'deny'],
  ['perl -e \'system("hcloud ECS DeleteServers")\'', 'deny'],
  ['awk \'BEGIN{system("hcloud ECS DeleteServers")}\'', 'deny'],
  ['echo DeleteServers | xargs "hcl"oud ECS', 'deny'],
  ['echo ListServers | xargs "hcl"oud ECS', 'allow'],
  ['X0=1 X1=1 X2=1 X3=1 X4=1 X5=1 X6=1 X7=1 X8=1 X9=1 X10=1 hcloud ECS DeleteServers', 'deny'],
  ['echo sh <<EOF\nhcloud ECS DeleteServers\nEOF', 'allow'],
  ['bash <<EOF\nhcloud ECS ListServers\nEOF', 'allow'],
  ["python3 -c 'print(1+1)'", 'allow'],
  ["awk '{print $1}' file.txt", 'allow'],
  ['find /tmp -name x.log -delete', 'allow'],
  // port-v2defects (interrogate round 13 + the coordinator's DESIGN PIVOT):
  // the vision tail closes by DENIAL, not enumeration — the carrier space
  // is unbounded, so the walk denies fail-closed when it cannot traverse
  // and our token hides fragmented/marked/in-code. The pivot's own rows:
  // interpreter name variants + benign flags (gawk/mawk/python3.11/-u),
  // awk -v value flags, every invocation API (subprocess/execSync/execvp —
  // code-context opacity, not API enumeration), value/long flags before
  // -c (-o pipefail/--noprofile/-ce), 19+ env-assignment stacks, heredoc
  // heads with operand redirections (< in bash), multiple system() calls,
  // and the doctrine's ACCEPTED OVER-DENIES (pinned as deliberate):
  // interpreter code MENTIONING hcloud in any string (print-vs-execute
  // requires parsing the code — the exact vision the pivot retires) and
  // perl -c (syntax-check) still denying when the token rides -e.
  ['python3 -u -c \'import os; os.system("hcloud ECS DeleteServers")\'', 'deny'],
  ['gawk \'BEGIN{system("hcloud ECS DeleteServers")}\'', 'deny'],
  ['python3.11 -c \'import os; os.system("hcloud ECS DeleteServers")\'', 'deny'],
  ['awk -v sep=, \'BEGIN{system("hcloud ECS DeleteServers")}\'', 'deny'],
  ['python3 -c \'import subprocess; subprocess.run("hcloud ECS DeleteServers", shell=True)\'', 'deny'],
  ['node -e \'require("child_process").execSync("hcloud ECS DeleteServers")\'', 'deny'],
  ['python3 -c \'os.execvp("hcloud", ["hcloud","ECS","DeleteServers"])\'', 'deny'],
  ["bash -o pipefail -c 'hcloud ECS DeleteServers'", 'deny'],
  ["bash --noprofile -c 'hcloud ECS DeleteServers'", 'deny'],
  ["bash -ce 'hcloud ECS DeleteServers'", 'deny'],
  [
    'X0=1 X1=1 X2=1 X3=1 X4=1 X5=1 X6=1 X7=1 X8=1 X9=1 X10=1 X11=1 X12=1 X13=1 X14=1 X15=1 X16=1 X17=1 X18=1 hcloud ECS DeleteServers',
    'deny',
  ],
  ['< in bash <<EOF\nhcloud ECS DeleteServers\nEOF', 'deny'],
  ['2>/dev/null bash <<EOF\nhcloud ECS DeleteServers\nEOF', 'deny'],
  ['perl -e \'system("echo hi"); system("hcloud ECS DeleteServers")\'', 'deny'],
  ['perl -c -e \'system("hcloud ECS DeleteServers")\'', 'deny'],
  ['sudo gawk \'BEGIN{system("hcloud ECS DeleteServers")}\'', 'deny'],
  ['bash -c \'echo "step1; hcloud ECS DeleteServers"\'', 'allow'],
  ['bash -c \'hcloud ECS ListServers --note="x; hcloud ECS DeleteServers"\'', 'allow'],
  ['echo -exec hcloud ECS DeleteServers', 'allow'],
  ['python3 -c \'print("docs about hcloud")\'', 'deny'],
  // port-v2defects (interrogate round 14, the exit round on the pivot):
  // ${ parameter expansion joins the marker set; the `saw` accumulator is
  // PER-SEGMENT (a read in one segment must never mask a write in
  // another); busybox is the applet dispatcher; and interpreter code
  // through a stdin heredoc is code context. The benign controls pin the
  // prose boundary.
  ['${X:-hcloud} ECS DeleteServers', 'deny'],
  ["bash -c '${X:-hcloud} ECS DeleteServers'", 'deny'],
  ['${HCLOUD_BIN:-hcloud} ECS DeleteServers', 'deny'],
  ['${X:-hcloud} OBS rm obs://b/k', 'deny'],
  ['hcloud ECS ListServers; node -e \'require("child_process").execSync("hcloud ECS DeleteServers")\'', 'deny'],
  [
    'hcloud ECS ListServers; python3 -c \'import subprocess; subprocess.run(["hcloud","ECS","DeleteServers"])\'',
    'deny',
  ],
  [
    'bash -c \'hcloud ECS ListServers\'; node -e \'require("child_process").execSync("hcloud ECS DeleteServers")\'',
    'deny',
  ],
  ['hcloud --help; python3 -c \'import subprocess; subprocess.run(["hcloud"])\'', 'deny'],
  [
    'python3 -c \'import os,subprocess; os.system("hcloud ECS ListServers"); subprocess.run(["hcloud","ECS","DeleteServers"])\'',
    'deny',
  ],
  ['node -e \'require("child_process").execSync("hcloud ECS DeleteServers")\'; hcloud ECS ListServers', 'deny'],
  ["busybox sh -c 'hcloud ECS DeleteServers'", 'deny'],
  ['busybox awk \'BEGIN{system("hcloud ECS DeleteServers")}\'', 'deny'],
  ["env busybox sh -c 'hcloud ECS DeleteServers'", 'deny'],
  ['nice busybox awk \'BEGIN{system("hcloud ECS DeleteServers")}\'', 'deny'],
  ['python3 <<\'PYEOF\'\nimport os; os.system("hcloud ECS DeleteServers")\nPYEOF', 'deny'],
  ['python3 - <<\'PYEOF\'\nimport subprocess; subprocess.run(["hcloud","ECS","DeleteServers"])\nPYEOF', 'deny'],
  ['git log --oneline | grep hcloud', 'allow'],
  ['rg -n "hcloud ECS ListServers" README.md', 'allow'],
  ['man hcloud', 'allow'],
  ['nohup hcloud ECS ListServers', 'allow'],
  ['timeout 30 hcloud ECS ListServers --cli-region=cn-north-4', 'allow'],
  ['hcloud ECS ListServers; echo done && git commit -m "hcloud cleanup notes"', 'allow'],
  // port-v2defects (interrogate round 15, the clean-round fixes): the
  // expansion-built OPERATION/SERVICE/SUBCOMMAND slot under a seen bin
  // (the slot rule — flag-position ${ stays allowed); prefix/env/busybox
  // before the heredoc shell head (the probe grammar); closed-quote-
  // mangled interpreter heads (the word-gluing doctrine); and the over-cap
  // ${ boundary parity.
  ['hcloud ECS ${X:-DeleteServers}', 'deny'],
  ['sh -c "hcloud ECS ${X:-DeleteServers}"', 'deny'],
  ['hcloud ECS ListServers; hcloud ECS ${X:-DeleteServers}', 'deny'],
  ['hcloud ${X:-OBS} rm obs://b -f', 'deny'],
  ['hcloud OBS ${X:-rm} obs://b -f', 'deny'],
  ['hcloud FunctionGraph ${X:-InvokeFunction}', 'deny'],
  ['hcloud configure ${X:-set}', 'deny'],
  ['hcloud ECS ${X:-RebootServers --server.id=x}', 'deny'],
  ['hcloud ECS ListServers --cli-region=${REGION}', 'allow'],
  ['${X:-ECS} DeleteServers', 'allow'],
  ['env bash <<EOF\nhcloud ECS DeleteServers\nEOF', 'deny'],
  ['X=1 bash <<EOF\nhcloud ECS DeleteServers\nEOF', 'deny'],
  ['timeout 5 bash <<EOF\nhcloud ECS DeleteServers\nEOF', 'deny'],
  ['busybox sh <<EOF\nhcloud ECS DeleteServers\nEOF', 'deny'],
  ['sudo bash <<EOF\nhcloud ECS DeleteServers\nEOF', 'deny'],
  ['< in bash <<EOF\nhcloud ECS DeleteServers\nEOF', 'deny'],
  ["pyth'on3' -c 'import os; os.system(\"hcloud ECS DeleteServers\")'", 'deny'],
  ["per'l' -e 'system(\"hcloud ECS DeleteServers\")'", 'deny'],
  ["g'awk' 'BEGIN{system(\"hcloud ECS DeleteServers\")}'", 'deny'],
  ['no\'de\' -e \'require("child_process").execSync("hcloud ECS DeleteServers")\'', 'deny'],
  ['py"thon3" -c \'import os; os.system("hcloud ECS DeleteServers")\'', 'deny'],
  ['#' + 'x'.repeat(262200) + '\n${X:-hcloud} ECS DeleteServers', 'deny'],
  // port-v2defects (interrogate round 16, the clean-round fixes): the
  // quote-mangled SHELL heredoc heads (`ba'sh' <<EOF` — the word-gluing
  // doctrine reached the shell twin), the quote-mangled interpreter CODE
  // FLAGS (`python3 -'c'`), the py glued-path expansion SLOT (TS parity),
  // and the pipe-fed shell stdin (`echo '…' | bash` — the xargs-feeder
  // doctrine: the previous segment's args are the script; a
  // heredoc-to-pipe composition lands the body inline).
  ["ba'sh' <<EOF\nhcloud ECS DeleteServers\nEOF", 'deny'],
  ["bas'h' <<EOF\nhcloud ECS DeleteServers\nEOF", 'deny'],
  ["da'sh' <<<'hcloud ECS Delete'", 'deny'],
  ["python3 -'c' 'import os; os.system(\"hcloud ECS DeleteServers\")'", 'deny'],
  ["perl -'e' 'system(\"hcloud ECS DeleteServers\")'", 'deny'],
  ['node -\'e\' \'require("child_process").execSync("hcloud ECS DeleteServers")\'', 'deny'],
  ["pyth'on3' -'c' 'import os; os.system(\"hcloud ECS DeleteServers\")'", 'deny'],
  ["echo 'hcloud ECS DeleteServers' | bash", 'deny'],
  ["echo 'hcloud ECS DeleteServers' | sh", 'deny'],
  ['cat <<EOF | bash\nhcloud ECS DeleteServers\nEOF', 'deny'],
  ['"hcl"oud ${X:-ECS} ${X:-DeleteServers}', 'deny'],
  ["echo 'hcloud ECS ListServers' | bash", 'allow'],
  // port-v2defects (interrogate round 17, the clean-round fixes): the
  // mangled shell -c flag (TS's flag-skip now normalizes), the mangled
  // xargs/watch heads, and the pipe-feeder completions — the walk-back
  // through pass-through middles, per-word feeder classification
  // (printf's format arg), interpreter consumers (the code-context deny),
  // and the glued xargs arms using the walked-back feeder.
  ["bash -'o' pipefail -c 'hcloud ECS DeleteServers'", 'deny'],
  ["bash -'c' 'echo; hcloud ECS DeleteServers' && echo done", 'deny'],
  ['echo DeleteServers | x\'args\' "hcl"oud ECS', 'deny'],
  ["echo DeleteServers | x'args' hcloud ECS", 'deny'],
  ["wat'ch' -n1 'hcloud ECS DeleteServers'", 'deny'],
  ["echo 'hcloud ECS DeleteServers' | cat | bash", 'deny'],
  ["echo 'hcloud ECS DeleteServers' | tee /dev/null | bash", 'deny'],
  ["echo 'hcloud ECS DeleteServers' | head -1 | bash", 'deny'],
  ['echo \'import os; os.system("hcloud ECS DeleteServers")\' | python3', 'deny'],
  ['echo \'system("hcloud ECS DeleteServers")\' | perl', 'deny'],
  ["printf '%s\\n' 'hcloud ECS DeleteServers' | bash", 'deny'],
  ['echo DeleteServers | cat | xargs "hcl"oud ECS', 'deny'],
  ['ls | sh', 'allow'],
  ["echo 'docs' | bash", 'allow'],
  // port-v2defects (interrogate round 18, the clean-round fixes): the
  // walk-back head comparisons use the recognition grammar — quote-strip
  // + basename + prefix probe (`c'at'`, `/usr/bin/cat`, `command cat`),
  // and CONTROL heads flow through BEFORE the probe (`if true; the'n' …`
  // — probing would strip the `if` and misread `true` as the content).
  ["echo 'hcloud ECS DeleteServers' | c'at' | bash", 'deny'],
  ["echo 'hcloud ECS DeleteServers' | /usr/bin/cat | bash", 'deny'],
  ["echo 'hcloud ECS DeleteServers' | command cat | bash", 'deny'],
  ["echo DeleteServers | if true; the'n' xargs hcloud ECS; fi", 'deny'],
  ["echo DeleteServers | i'f' true; the'n' xargs hcloud ECS; fi", 'deny'],
  ["echo 'import os; os.system(\"hcloud ECS DeleteServers\")' | ca't' | python3", 'deny'],
  ['echo DeleteServers | c\'at\' | xargs "hcl"oud ECS', 'deny'],
  ["ls | c'at' | bash", 'allow'],
  // port-v2defects (interrogate round 19, the clean-round fixes): the
  // prefix-token and value-flag comparisons inside the probes read the
  // token raw while the heads were normalized — `comm'and' cat`,
  // `en'v' python3 -c`, `env -'u' X cat`, `busyb'ox' awk`, and the
  // standard-path xargs detector (`x'args'`) all executed. Every prefix,
  // flag, and head comparison in the probe grammar now strips
  // quote-mangling (both twins, all sites).
  ["echo 'hcloud ECS DeleteServers' | comm'and' cat | bash", 'deny'],
  ["echo 'hcloud ECS DeleteServers' | en'v' cat | bash", 'deny'],
  ["echo 'import os; os.system(\"hcloud ECS DeleteServers\")' | comm'and' cat | python3", 'deny'],
  ["echo 'hcloud ECS DeleteServers' | env -'u' X cat | bash", 'deny'],
  ["en'v' bash <<EOF\nhcloud ECS DeleteServers\nEOF", 'deny'],
  ["sud'o' bash <<EOF\nhcloud ECS DeleteServers\nEOF", 'deny'],
  ["busyb'ox' awk 'BEGIN{system(\"hcloud ECS DeleteServers\")}'", 'deny'],
  ["en'v' watch -n1 'hcloud ECS DeleteServers'", 'deny'],
  ["en'v' python3 -c 'import os; os.system(\"hcloud ECS DeleteServers\")'", 'deny'],
  ["en'v' bash -c 'echo; hcloud ECS DeleteServers'", 'deny'],
  // The astral row: 200k valid surrogate pairs = 800 KB bytes / 400,000
  // UTF-16 units / 200,000 code points — over the byte cap on both twins,
  // over the OLD TS unit cap (400,002 > 262,144) but under the OLD py
  // point-cap: it discriminates the byte-unit change on py and the round-5
  // expansion-bearing cap on TS.
  ['𝄞'.repeat(200000) + '\necho $(date)', 'deny'],
  // The $(…)-substitution residual (documented): printf-built bins stay
  // opaque to the decode; the OBS-token marker arm still catches the
  // service-token-literal form.
  ["$(printf '\\x68\\x63loud') OBS rm mybucket", 'deny'],
  // port-v2defects (interrogate rounds 2-3): the OBS arm is gated on the
  // OBS TOKEN (a bare `cloud` substring was the round-2 marker and denied
  // routine huaweicloud-bearing PATHS — the decoded-bin clause now carries
  // the mangled-bin class). The short subcommand words are routine shell
  // vocabulary: these legitimate expansion-bearing idioms stay allowed.
  ['docker rm $(docker ps -aq)', 'allow'],
  ['mkdir -p $(pwd)/build', 'allow'],
  ['bash -c "cp $(mktemp -d)/x y"', 'allow'],
  ['git commit -m "sync $(git rev-parse --short HEAD)"', 'allow'],
  ['cp $(mktemp -d)/x plugins/huaweicloud-core/dist/foo', 'allow'],
  ['cp -r $(pwd)/src plugins/huaweicloud-core/ && mv $(pwd)/old plugins/huaweicloud-core/old', 'allow'],
  ['mkdir -p $(pwd)/build/observations', 'allow'],
  ['gcloud storage rm gs://bucket/$(date).bak', 'allow'],
  // port-v2defects (interrogate round 1): the write gate's read exemption is
  // anchored at the operation token's START on both layers (TS hasReadPrefix
  // ^prefix parity — py re.match). A write-prefixed operation with an
  // embedded read word classifies as the write it is; a read-prefixed one
  // with an embedded write word stays the read it is.
  ['hcloud ECS Update-Show-x', 'deny'],
  ['hcloud ECS ShowUpdate-x', 'allow'],
  // cors/website: real write-capable subcommands on the pinned 7.3.12 (live
  // -method=get reaches OBS and returns NoSuchBucket) — upstream #1001's
  // removal was measured on 7.2.x. Both layers keep the deny.
  ['hcloud OBS cors obs://b -method=put', 'deny'],
  ['hcloud OBS website obs://b -method=put -localfile=w.xml', 'deny'],
  // KooCLI 7.3.12 obsutil write subcommands — the pin keeps the TS and py
  // OBSUTIL_WRITES vocabularies from drifting apart on the new names.
  ['hcloud OBS bucket-tagging obs://b -method=put', 'deny'],
  ['hcloud OBS object-tagging obs://b -method=delete', 'deny'],
  ['hcloud OBS encryption obs://b -method=put -localfile=e.xml', 'deny'],
  ['hcloud OBS custom-domain obs://b -cname=x.com', 'deny'],
  ['hcloud OBS mirror-back-to-source obs://b -method=delete', 'deny'],
  ['hcloud OBS put-public-access-block obs://b -public-access-block-configuration=BlockPublicAcls=true', 'deny'],
  ['hcloud OBS delete-public-access-block obs://b', 'deny'],
  // The read variants of the same families stay allowed on BOTH layers.
  ['hcloud OBS get-public-access-block obs://b', 'allow'],
  ['hcloud OBS check obs://src obs://dst', 'allow'],
  // Case-variant obsutil subcommands: the vocab lookup must be
  // case-insensitive on BOTH layers (the binary rejects these, but the
  // policy must not lean on that).
  ['hcloud OBS RM obs://b -f', 'deny'],
  ['hcloud OBS Abort obs://b/key', 'deny'],
  // The live share-authorization family + the abort/archive catches.
  ['hcloud OBS create-share obs://b', 'deny'],
  ['hcloud OBS update obs://b', 'deny'],
  ['hcloud OBS abort obs://b/key -f', 'deny'],
  ['hcloud OBS archive obs://b', 'deny'],
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
  ['echo $HUAWEICLOUD_SECRET_ACCESS_KEY', 'deny'],
  ['echo ${HUAWEICLOUD_SECRET_ACCESS_KEY}', 'deny'],
  ['printenv HWC_SECRET_ACCESS_KEY', 'deny'],
  ['env | grep HW_SECRET_ACCESS_KEY', 'deny'],
  ['env HW_REGION=cn-north-4 hcloud ECS ListServers', 'allow'],
  ['set -e', 'allow'],
  ['make env', 'allow'],
  ['rg env', 'allow'],
  ['printenv PATH', 'allow'],
  ["echo '$HW_SECRET_KEY is a literal'", 'allow'],
  ["echo '$HUAWEICLOUD_SECRET_ACCESS_KEY' is a literal", 'allow'],
  ['echo $HUAWEICLOUD_REGION', 'allow'],
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
  ['hcloud CSMS ShowSecret --secret_name prod/db', 'deny'],
  ['hcloud CSMS ShowSecretList', 'allow'],
  ['hcloud CSMS ListSecrets --secret_name=showsecret-demo', 'allow'],
  ['hcloud CSMS ListSecrets --secret_name=showsecret_version', 'allow'],
  ["echo Show'Secret'", 'deny'],
  ["echo Show'Secret'Version", 'deny'],
  ["echo xshow'secret'version", 'deny'],
  ["echo download'secret'", 'deny'],
  ["echo download'secret'-demo", 'deny'],
  ["echo secret_'string'", 'allow'],
  ['hcloud CSMS ListSecrets --secret_name=showsecret', 'deny'],
  ['hcloud CSMS ListSecrets --secret_name=downloadsecret-demo', 'deny'],
  ["hcloud CSMS ListServers; echo download'secret'", 'deny'],
  ['hcloud CSMS ShowSecret --help', 'deny'],
  ['echo ShowSecret', 'deny'],
  // skill-quality-cli wrapper: adopted service skills teach it — the seam
  // unwraps it so embedded hcloud keeps its verdict in both layers.
  ['skill-quality-cli run --skill-name ecs -- hcloud ECS CreateServers --server.name=x', 'deny'],
  ['skill-quality-cli run -- hcloud CSMS ListSecrets', 'allow'],
  ['~/.local/bin/skill-quality-cli run -- hcloud ECS DeleteServers --server.id=1', 'deny'],
  ['skill-quality-cli run --skill-name x hcloud ECS DeleteServers --server.id=1', 'deny'],
  ['skill-quality-cli run --skill-name x --session-id s hcloud ECS DeleteServers --server.id=1', 'deny'],
  ['skill-quality-cli run --json hcloud ECS DeleteServers --server.id=1', 'deny'],
  ['skill-quality-cli run --skill-name x hcloud ECS ListServers', 'allow'],
  ['skill-quality-cli --no-auto-upgrade run -- hcloud ECS DeleteServers --server.id=1', 'deny'],
  ['skill-quality-cli.exe run -- hcloud ECS DeleteServers --server.id=1', 'deny'],
  ["skill'-'quality'-'cli run -- hcloud ECS DeleteServers --server.id=1", 'deny'],
  ['skill-quality-cli run --skill-name x hcloud ECS DeleteServers --server.id=1 --', 'deny'],
  ['skill-quality-cli run hcloud ECS DeleteServers -- --server.id=1', 'deny'],
  ['sudo skill-quality-cli run -- hcloud ECS DeleteServers --server.id=1', 'deny'],
  [
    'npx huaweicloud-devkit secret exec --env K=x -- bash -c "skill-quality-cli run -- hcloud ECS DeleteServers"',
    'deny',
  ],
  ["npx huawei'cloud'-devkit secret exec --env K=x -- hcloud ECS DeleteServers --server.id=1", 'deny'],
  ['skill-quality-cli run --config /etc/x hcloud ECS DeleteServers --server.id=1', 'deny'],
  ["skill-quality-cli --no-auto-'upgrade' run -- hcloud ECS DeleteServers --server.id=1", 'deny'],
  ['skill-quality-cli --config x run -- hcloud ECS DeleteServers --server.id=1', 'deny'],
  ['skill-quality-cli run bash -c "hcloud ECS DeleteServers --server.id=1"', 'deny'],
  ['skill-quality-cli run --config x bash -c "hcloud ECS ListServers"', 'allow'],
  // The wrapper's `--` separator is authoritative only while the flag
  // region is still live: a child-owned `--` never suppresses the
  // fail-closed slot re-base. The reachability scan consumes the wrapper's
  // own value-flag grammar (so an intervening --session-id s pair does not
  // fake unreachability) and treats a script-head slot's `-c` argument as
  // data (so a dash-leading script cannot fake reachability).
  ['skill-quality-cli run --json bash -c "hcloud ECS DeleteServers" -- x', 'deny'],
  ['skill-quality-cli run --json hcloud ECS DeleteServers --server.id=1 --', 'deny'],
  ['skill-quality-cli run --skill-name hcloud -- ECS ListServers', 'allow'],
  ['skill-quality-cli run --json hcloud --session-id s -- hcloud ECS DeleteServers --server.id=1', 'deny'],
  ['skill-quality-cli run --skill-name hcloud --skill-name y -- hcloud ECS DeleteServers --server.id=1', 'deny'],
  ['skill-quality-cli run --json bash -c "-e; hcloud ECS DeleteServers" -- x', 'deny'],
  // The grammar model resolves wrapper-flag/value pairs between the slot
  // and the real child: the child head (hcloud bin or script head) reached
  // through the wrapper's own flag grammar composes the deny — with or
  // without the separator, and whether the interleaved value is a plain
  // token or the `--` itself.
  ['skill-quality-cli run --json hcloud --session-id s hcloud ECS DeleteServers --server.id=1', 'deny'],
  ['skill-quality-cli run --json hcloud --session-id -- hcloud ECS DeleteServers --server.id=1', 'deny'],
  ['skill-quality-cli run --json hcloud --session-id s bash -c "hcloud ECS DeleteServers"', 'deny'],
  ['skill-quality-cli run --json eval "-e; hcloud ECS DeleteServers" -- x', 'deny'],
  ['skill-quality-cli run -- ls /opt/hcloud', 'allow'],
  ['skill-quality-cli run ls /opt/hcloud', 'allow'],
  ['hcloud KMS ShowKey', 'allow'],
  ['env -u TERM', 'deny'],
  ['env --unset=TERM', 'deny'],
  ["echo 'a'$HW_SECRET_KEY", 'deny'],
  ['cd ~/.config/huaweicloud && cat credentials.json', 'deny'],
  // Windows script wrappers (#731/#760): cmd /c|/k and
  // powershell|pwsh -Command|-c re-tokenize their payload so wrapped
  // writes deny in BOTH layers; wrapped reads and non-script forms stay
  // allowed; unquoted payloads join the remainder (real shell semantics);
  // options before the script flag (`-NoProfile -Command`, `cmd /d /c`)
  // and cmd.exe launch builtins (`start`/`call`) re-base onto the child.
  ['cmd /c "hcloud ECS DeleteServers --server.id=1"', 'deny'],
  ['cmd /k hcloud ECS DeleteServers --server.id=1', 'deny'],
  ['cmd.exe /c "hcloud ECS DeleteServers --server.id=1"', 'deny'],
  ['C:\\Windows\\System32\\cmd.exe /c "hcloud ECS DeleteServers"', 'deny'],
  ['powershell -Command "hcloud ECS DeleteServers --server.id=1"', 'deny'],
  ['powershell -command "hcloud ECS DeleteServers"', 'deny'],
  ['powershell -c hcloud ECS DeleteServers --server.id=1', 'deny'],
  ['powershell.exe -Command "hcloud OBS rm obs://b/x"', 'deny'],
  ['pwsh -Command "hcloud ECS CreateServers --flavor=x"', 'deny'],
  ['pwsh.exe -c hcloud CCE DeleteCluster --cluster_id=x', 'deny'],
  ['cmd /c "hcloud ECS ListServers; hcloud ECS DeleteServers --server.id=1"', 'deny'],
  ['powershell -Command "echo hi; hcloud ECS DeleteServers --server.id=1"', 'deny'],
  ['cmd /c "bash -c \'hcloud ECS DeleteServers\'"', 'deny'],
  ['sudo cmd /c "hcloud ECS DeleteServers"', 'deny'],
  // Option regions before the script flag — the canonical PowerShell
  // spelling (`-NoProfile -Command`) and cmd's `/d /s` robust-quoting
  // idioms must not launder the write. The scan is unbounded and
  // order-free: any option count, unlisted value-taking options, `//c`
  // (Git-Bash path conversion), glued `/c"…"`, colon-attached
  // `-Command:"…"`, and PowerShell's POSITIONAL command binding
  // (`powershell hcloud …`) all classify.
  ['powershell -NoProfile -Command "hcloud ECS DeleteServers --server.id=1"', 'deny'],
  ['powershell -NoProfile -NonInteractive -Command "hcloud ECS DeleteServers"', 'deny'],
  ['powershell -ExecutionPolicy Bypass -Command "hcloud ECS DeleteServers"', 'deny'],
  ['powershell -WindowStyle Hidden -Command "hcloud ECS DeleteServers"', 'deny'],
  ['pwsh -NoLogo -c "hcloud ECS DeleteServers"', 'deny'],
  ['powershell -com "hcloud ECS DeleteServers"', 'deny'],
  ['powershell -Command:hcloud ECS DeleteServers', 'deny'],
  ['powershell -Command:"hcloud ECS DeleteServers --server.id=1"', 'deny'],
  ["powershell -c:'hcloud ECS DeleteServers --server.id=1'", 'deny'],
  ['powershell -c"hcloud ECS DeleteServers"', 'deny'],
  ['pwsh -c"hcloud ECS DeleteServers" x', 'deny'],
  ['cmd /c"hcloud ECS DeleteServers" --x=1', 'deny'],
  ['cmd /d /c hcloud ECS DeleteServers --server.id=1', 'deny'],
  ['cmd /s /c "hcloud ECS DeleteServers --server.id=1"', 'deny'],
  ['cmd //c "hcloud ECS DeleteServers --server.id=1"', 'deny'],
  ['cmd /c"hcloud ECS DeleteServers --server.id=1"', 'deny'],
  [
    'powershell -NoProfile -NonInteractive -NoLogo -NoExit -OutputFormat Text -InputFormat Text -ExecutionPolicy Bypass -WorkingDirectory . -Mta -Command hcloud ECS DeleteServers --server.id=1',
    'deny',
  ],
  ['cmd /q /d /e:on /f:on /v:on /a /u /s /x /c hcloud ECS DeleteServers --server.id=1', 'deny'],
  ['powershell hcloud ECS DeleteServers --server.id=1', 'deny'],
  ['powershell -NoProfile hcloud ECS DeleteServers --server.id=1', 'deny'],
  ['powershell -WindowStyle Hidden hcloud ECS DeleteServers --server.id=1', 'deny'],
  ['C:\\hcloud.exe ECS DeleteServers --server.id=1', 'deny'],
  ['cmd /c "C:\\Tools\\hcloud.exe ECS DeleteServers --server.id=1"', 'deny'],
  // cmd.exe launch builtins inside the payload re-base onto the child.
  ['cmd /c start hcloud ECS DeleteServers --server.id=1', 'deny'],
  ['cmd /c start /b hcloud ECS DeleteServers', 'deny'],
  ['cmd /c "start /wait hcloud ECS DeleteServers"', 'deny'],
  ['cmd /c call hcloud ECS DeleteServers', 'deny'],
  ['cmd /c call /b hcloud ECS DeleteServers', 'deny'],
  // PowerShell call-operator scriptblock, glued and spaced.
  ['powershell -Command "& {hcloud ECS DeleteServers}"', 'deny'],
  ['powershell -Command "& { hcloud ECS DeleteServers }"', 'deny'],
  // Quote-mangled wrapper heads classify like quote-mangled bins.
  ['cm\'d\' /c "hcloud ECS DeleteServers"', 'deny'],
  ['powers\'hell\' -Command "hcloud ECS DeleteServers"', 'deny'],
  // Path-qualified wrappers after separators and with compound payloads —
  // the drive-path backslash preservation keeps the head recognizable.
  ['echo x; C:\\Windows\\System32\\cmd.exe /c "hcloud ECS DeleteServers"', 'deny'],
  ['echo hi && C:\\Windows\\System32\\cmd.exe /c "hcloud ECS DeleteServers"', 'deny'],
  ['C:\\Windows\\System32\\cmd.exe /c "echo hi; hcloud ECS DeleteServers"', 'deny'],
  ['sudo powershell -NoProfile -Command "hcloud ECS DeleteServers"', 'deny'],
  // Path-qualified command-position prefixes consult their value-flag
  // grammar (basename resolution, any letter case); decimal durations
  // strip in both layers; cmd's `start` consumes an optional quoted
  // TITLE before the child; drive-relative bins (`d:hcloud.exe`) are
  // drive-qualified too; `\"`-nested wrappers inside bash -c regroup
  // (escape-aware quoted spans).
  ['/usr/bin/sudo -u root hcloud ECS DeleteServers --server.id=1', 'deny'],
  ['/usr/bin/SUDO hcloud ECS DeleteServers --server.id=1', 'deny'],
  ['timeout 1.5 hcloud ECS DeleteServers --server.id=1', 'deny'],
  ['cmd /c start "t" hcloud ECS DeleteServers --server.id=1', 'deny'],
  ['cmd /c start "t" C:\\hcloud.exe ECS DeleteServers', 'deny'],
  ['d:hcloud.exe ECS DeleteServers --server.id=1', 'deny'],
  ['cmd /c "d:hcloud.exe ECS DeleteServers --server.id=1"', 'deny'],
  ['bash -c "cmd /c \\"hcloud ECS DeleteServers\\""', 'deny'],
  ['bash -c "powershell -Command \\"hcloud ECS DeleteServers\\""', 'deny'],
  ['cmd /c "hcloud ECS ListServers"', 'allow'],
  ['cmd /k hcloud ECS ListServers', 'allow'],
  ['powershell -Command "hcloud ECS ListServers"', 'allow'],
  ['pwsh -c hcloud ECS ListServers', 'allow'],
  ['powershell -NoProfile -Command "hcloud ECS ListServers"', 'allow'],
  ['powershell -WindowStyle Hidden -Command "hcloud ECS ListServers"', 'allow'],
  ['powershell hcloud ECS ListServers', 'allow'],
  ['powershell Get-Process', 'allow'],
  ['powershell', 'allow'],
  ['powershell -c hcloud --help', 'allow'],
  ['cmd /d /c dir', 'allow'],
  ['cmd /c start /wait hcloud ECS ListServers', 'allow'],
  ['cmd /c "echo hi"', 'allow'],
  ['powershell -File deploy.ps1', 'allow'],
  ['cmd', 'allow'],
  ['cmd /c', 'allow'],
  // Prose and string literals mentioning hcloud or a write stay
  // unclassified: routing is entry-only and no segment is hcloud-leading.
  ['see the hcloud docs here', 'allow'],
  ['echo "hcloud ECS DeleteServers"', 'allow'],
  ['start notepad file.txt', 'allow'],
  // The xargs feeder supplies the argv: a bare `xargs hcloud` segment
  // fed by a pipe classifies its feeder instead of denying empty-args.
  ['echo List | xargs hcloud && echo done', 'allow'],
  // Wrapper PAYLOAD control grammar: PS scriptblocks (try/catch, foreach/%,
  // begin, switch/default, function+name) re-base onto the body; cmd `if`
  // conditions and the `@` echo-suppression sigil classify; the
  // windows-payload stall re-base (first hcloud bin) closes the rest.
  ['powershell -Command "try { hcloud ECS DeleteServers --server.id=1 } catch {}"', 'deny'],
  ['powershell -Command "1..1 | foreach { hcloud ECS DeleteServers --server.id=1 }"', 'deny'],
  ['powershell -Command "1 | % { hcloud ECS DeleteServers }"', 'deny'],
  ['powershell -Command "try { echo x } catch { hcloud ECS DeleteServers }"', 'deny'],
  ['powershell -Command "begin { hcloud ECS DeleteServers }"', 'deny'],
  ['powershell -Command "switch (1) { default { hcloud ECS DeleteServers } }"', 'deny'],
  ['powershell -Command "function f { hcloud ECS DeleteServers }; f"', 'deny'],
  ['cmd /c "if defined X hcloud ECS DeleteServers"', 'deny'],
  ['cmd /c "if exist foo.txt hcloud ECS DeleteServers"', 'deny'],
  ['cmd /c "if not defined X hcloud ECS DeleteServers"', 'deny'],
  ['cmd /c "if %ERRORLEVEL%==0 hcloud ECS DeleteServers"', 'deny'],
  ['cmd /c "@hcloud ECS DeleteServers --server.id=1"', 'deny'],
  ['powershell -Command "@hcloud ECS DeleteServers"', 'deny'],
  ['powershell -Command:"" hcloud ECS DeleteServers', 'deny'],
  ['powershell -c:"\'" hcloud ECS DeleteServers', 'deny'],
  ['bash -c "powershell -Command \\"try { hcloud ECS DeleteServers }\\""', 'deny'],
  ['echo Delete | /usr/bin/XARGS hcloud ECS', 'deny'],
  // Multi-brace-block payloads: every LATER hcloud occurrence in a
  // windows payload is a live command site (`}` is not a segment
  // separator) — the first block's read does not mask the second block's
  // write. The doubly-nested `\"` form regroups through the
  // escape-aware tokenizers. Quote-mangled drive-qualified bins strip
  // quotes but keep backslashes.
  ['powershell -Command "try { hcloud ECS ListServers } finally { hcloud ECS DeleteServers }"', 'deny'],
  ['powershell -Command "try { hcloud ECS ListServers } catch { hcloud ECS DeleteServers }"', 'deny'],
  ['powershell -Command "begin { hcloud ECS ListServers } end { hcloud ECS DeleteServers }"', 'deny'],
  ['powershell -Command "if (0) { hcloud ECS ListServers } else { hcloud ECS DeleteServers }"', 'deny'],
  ['powershell -Command "try { hcloud --help } finally { hcloud ECS DeleteServers }"', 'deny'],
  ['powershell -Command "try { hcloud ECS ListServers } catch { cmd /c hcloud ECS DeleteServers }"', 'deny'],
  ['sudo powershell -NoProfile -Command "try { hcloud ECS ListServers } finally { hcloud ECS DeleteServers }"', 'deny'],
  ['bash -c "powershell -Command \\"try { hcloud ECS ListServers } finally { hcloud ECS DeleteServers }\\""', 'deny'],
  ['C:\\hclou"d".exe ECS DeleteServers --server.id=1', 'deny'],
  ['cmd /c C:\\hclou"d".exe ECS DeleteServers', 'deny'],
  ['cmd /c "C:\\hclou\'d\' ECS DeleteServers"', 'deny'],
  // Payload stall re-base only denies write-shaped rebases; reads inside
  // payloads stay allowed.
  ['powershell -Command "echo hcloud ECS ListServers"', 'allow'],
  ['powershell -Command "try { hcloud ECS ListServers } finally {}"', 'allow'],
  // Fail-closed asymmetry, pinned deliberately: unquoted write-word
  // mentions inside windows payloads (echo args) re-base and deny, while
  // the identical echo at the bash layer allows — the sqc REMAINDER
  // doctrine's accepted cost.
  ['powershell -Command "echo hcloud ECS DeleteServers"', 'deny'],
  // Glued-brace PS payloads (no whitespace), separator-glued bins
  // (`x&&hcloud`), quote-glued cmd flags with separator-bearing payloads,
  // and prefixes in front of the wrapper: the payload re-segmentation is
  // brace-normalized at extraction, edge-stripped on join, and
  // piece-aware in the stall re-base and later-bin scan.
  ['powershell -Command "try{hcloud ECS DeleteServers}"', 'deny'],
  ['powershell -Command "try{hcloud ECS ListServers}catch{hcloud ECS DeleteServers}"', 'deny'],
  ['powershell -Command "try{hcloud ECS ListServers}finally{hcloud ECS DeleteServers}"', 'deny'],
  ['powershell -Command "if(0){}else{hcloud ECS DeleteServers}"', 'deny'],
  ['powershell -Command "switch(1){default{hcloud ECS DeleteServers}}"', 'deny'],
  ['cmd /c"echo x&&hcloud ECS DeleteServers"', 'deny'],
  ['cmd /c"hcloud ECS ListServers;hcloud ECS DeleteServers"', 'deny'],
  ['cmd /c"echo x;hcloud ECS DeleteServers"', 'deny'],
  ['cmd /c"echo x|hcloud ECS DeleteServers"', 'deny'],
  ['cmd /k"echo x&&hcloud ECS DeleteServers"', 'deny'],
  ['cmd //c"echo x&&hcloud ECS DeleteServers"', 'deny'],
  ['cmd.exe /c"echo x&&hcloud ECS DeleteServers"', 'deny'],
  ['sudo cmd /c "echo x&&hcloud ECS DeleteServers"', 'deny'],
  ['sudo powershell -Command "echo x;hcloud ECS DeleteServers"', 'deny'],
  ['env X=1 cmd /c "echo x&&hcloud ECS DeleteServers"', 'deny'],
  ['timeout 5 cmd /c "echo x&&hcloud ECS DeleteServers"', 'deny'],
  ['nohup powershell -Command "echo x&&hcloud ECS DeleteServers"', 'deny'],
  ['echo x | xargs cmd /c "echo y&&hcloud ECS DeleteServers"', 'deny'],
  ['powershell -Command "try{hcloud ECS ListServers}catch{}"', 'allow'],
  // Value-integrity guards: `={`/`:{`-glued and value-internal braces are
  // NOT spaced (argv service/operation positions unchanged), quoted
  // arg-value separators are NOT piece-split, and an empty attached
  // value behaves like the bare flag. cmd `/d <path>` carries its value
  // before /c.
  ['cmd /c "hcloud --cli-jsonInput={x:1} ECS DeleteServers"', 'deny'],
  ['powershell -Command "hcloud --cli-jsonInput={x:1} ECS DeleteServers"', 'deny'],
  ['cmd /c "hcloud --cli-region={region} ECS DeleteServers"', 'deny'],
  ['cmd /c "hcloud --cli-jsonInput={x:1} configure set --cli-access-key=AK --cli-secret-key=SK"', 'deny'],
  ["cmd /c \"hcloud ECS ListServers --description='a;hcloud;DeleteServers'", 'allow'],
  ["cmd /c \"hcloud ECS ListServers --url='http://x/hcloud&DeleteServers'", 'allow'],
  ['powershell -Command: hcloud ECS DeleteServers', 'deny'],
  ['powershell -c: hcloud ECS DeleteServers', 'deny'],
  ['pwsh -Command: hcloud OBS rm obs://b/o', 'deny'],
  ['powershell -NoProfile -Command: hcloud ECS DeleteServers', 'deny'],
  ['powershell -Command: "hcloud ECS DeleteServers"', 'deny'],
  ['cmd /d C:\\temp /c "hcloud ECS DeleteServers"', 'deny'],
  ['cmd /c "hcloud ECS CreateServers --cli-jsonInput={x:1}"', 'deny'],
  ['cmd /c "hcloud ECS ListServers --fields=name{1..3}"', 'allow'],
  ['cmd /c "hcloud --cli-jsonInput={\'DeleteServers\':1} ECS ListServers"', 'allow'],
  // Unquoted `&`/`;` in arg text are REAL cmd/PS command separators even
  // glued to values — the piece re-base is correct there.
  ['cmd /c "hcloud ECS List --desc=a&hcloud DeleteServers"', 'deny'],
  // Real cmd SKIPS non-switch junk before /c|/k (Wine/ReactOS raw scan);
  // ReactOS honors /r as a script flag (included fail-closed). The call
  // operator on a parenthesized string literal peels to the canonical
  // bin (routing tail accepts closers).
  ['cmd foo /c hcloud ECS DeleteServers', 'deny'],
  ['cmd foo /c "hcloud ECS DeleteServers --server.id=1"', 'deny'],
  ['cmd foo bar baz /c hcloud ECS DeleteServers', 'deny'],
  ['cmd.exe foo /c hcloud ECS DeleteServers', 'deny'],
  ['C:\\Windows\\System32\\cmd.exe foo /c hcloud ECS DeleteServers', 'deny'],
  ['cmd foo /c "echo x&&hcloud ECS DeleteServers"', 'deny'],
  ['sudo cmd foo /c hcloud ECS DeleteServers --server.id=1', 'deny'],
  ['bash -c "cmd foo /c \\"hcloud ECS DeleteServers\\""', 'deny'],
  ['cmd /d C:\\Program Files /c "hcloud ECS DeleteServers"', 'deny'],
  ['cmd /q /d C:\\Program Files /c hcloud ECS DeleteServers', 'deny'],
  ['cmd //d foo //c hcloud ECS DeleteServers', 'deny'],
  ['cmd /s foo /c "hcloud ECS DeleteServers"', 'deny'],
  ['cmd /r hcloud ECS DeleteServers', 'deny'],
  ['powershell -Command "&(\'hcloud\') ECS DeleteServers"', 'deny'],
  ['powershell -Command "&(\'hcloud.exe\') ECS DeleteServers"', 'deny'],
  ['powershell -Command "&(\'C:\\hcloud.exe\') ECS DeleteServers"', 'deny'],
  ['powershell -Command "& (\'hcloud\') ECS DeleteServers"', 'deny'],
  ['powershell -Command ".(\'hcloud\') ECS DeleteServers"', 'deny'],
  ['cmd /c "&(\'hcloud\') ECS DeleteServers"', 'deny'],
  ['cmd whatever /c "echo hi"', 'allow'],
  // The dot-call family's SPACED forms re-base with stray closers
  // dropped; the orphan argv-face gate keeps quoted package-name
  // arguments (`pip install "hcloud"`) and prose mentions unclassified
  // (TS/py aligned — the fallthrough classifies only argv and segment
  // calls now).
  ['powershell -Command ".( \'hcloud\' ) ECS DeleteServers --server.id=1"', 'deny'],
  ['powershell -Command ". (\'hcloud\' ) ECS DeleteServers --server.id=1"', 'deny'],
  ['powershell -Command ".( \'hcloud\') ECS DeleteServers --server.id=1"', 'deny'],
  ['powershell -Command ".( \\"hcloud\\" ) ECS DeleteServers --server.id=1"', 'deny'],
  ['powershell -Command "try { hcloud ECS ListServers } finally { .( \'hcloud\' ) ECS DeleteServers }"', 'deny'],
  ["docker stop 'hcloud'", 'allow'],
  ["docker restart 'hcloud'", 'allow'],
  ['pip install "hcloud"', 'allow'],
  ["npm uninstall 'hcloud'", 'allow'],
  ["kubectl delete cm 'hcloud'", 'allow'],
  ["helm delete 'hcloud'", 'allow'],
  ['see DeleteServers in the hcloud docs', 'allow'],
  ['docker stop hcloud', 'allow'],
  // Locator carve-out: `where hcloud` / `if exist hcloud` probe the bin's
  // presence (cmd builtins) — a bare bin with no argv is the probe shape.
  ['cmd /c "where hcloud"', 'allow'],
  ['cmd /c "if exist hcloud"', 'allow'],
  ['cmd /c "if defined hcloud"', 'allow'],
  ['powershell -Command "where hcloud"', 'allow'],
  // Deep nesting: adversarial `bash -c` nests five-plus deep genuinely
  // execute; the script recursion budget is 18 (one past the Linux
  // executability ceiling) so the separators stay live at every
  // executable depth. The depth-6 line is generator-produced (alternating
  // quote escapes) — regenerate rather than hand-edit.
  [
    'bash -c "bash -c \\"bash -c \\\\\\"bash -c \\\\\\\\\\\\\\"bash -c \\\\\\\\\\\\\\\\\\\\\\\\\\\\\\"bash -c \'hcloud x; hcloud ECS DeleteServers\'\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\"\\\\\\\\\\\\\\"\\\\\\"\\""',
    'deny',
  ],
  // Escaped-dq inner quoting: the payload's `\"` pairs are span-internal
  // escapes — resolved on join, never double-edge-stripped — so the
  // canonical Windows quoting idiom classifies (writes deny, reads
  // allow).
  ['cmd /c "bash -c \\"hcloud ECS DeleteServers\\""', 'deny'],
  ['cmd /c "bash -c \\"hcloud ECS ListServers\\""', 'allow'],
  ['cmd /k "bash -c \\"hcloud ECS DeleteServers\\""', 'deny'],
  ['cmd /r "bash -c \\"hcloud ECS DeleteServers\\""', 'deny'],
  ['powershell -Command "bash -c \\"hcloud ECS DeleteServers\\""', 'deny'],
  ['pwsh -c "bash -c \\"hcloud ECS DeleteServers\\""', 'deny'],
  ['sudo cmd /c "bash -c \\"hcloud ECS DeleteServers\\""', 'deny'],
  ['cmd /c "bash -c \\"sudo hcloud ECS DeleteServers\\""', 'deny'],
  ['cmd /c "bash -c \\"env X=1 hcloud ECS DeleteServers\\""', 'deny'],
  ['cmd /c "bash -c \\"hcloud ECS ListServers\\" x"', 'allow'],
  ['cmd /c "dir && bash -c \\"hcloud ECS ListServers\\""', 'allow'],
  // eval evaluates the JOIN of all its arguments — unquoted eval +
  // Windows wrapper runs the write; reads classify as reads. xargs
  // inside a quoted wrapper payload inherits the pipe (the child
  // executes the merged feeder). The `-Command=` spelling is not valid
  // PowerShell parameter syntax (colon only) — pinned allow.
  ['eval cmd /c "hcloud ECS DeleteServers"', 'deny'],
  ['eval cmd /k hcloud ECS DeleteServers', 'deny'],
  ['eval cmd //c "hcloud ECS DeleteServers"', 'deny'],
  ['eval cmd /c"hcloud ECS DeleteServers"', 'deny'],
  ['eval powershell -Command "hcloud ECS DeleteServers"', 'deny'],
  ['eval powershell hcloud ECS DeleteServers', 'deny'],
  ['eval powershell -NoProfile -Command "hcloud ECS DeleteServers"', 'deny'],
  ['eval powershell -Command:"hcloud ECS DeleteServers"', 'deny'],
  ['eval pwsh -c hcloud ECS DeleteServers', 'deny'],
  ['eval C:\\Windows\\System32\\cmd.exe /c "hcloud ECS DeleteServers"', 'deny'],
  ['eval cmd /c start hcloud ECS DeleteServers', 'deny'],
  ['eval "cmd /c" hcloud ECS DeleteServers', 'deny'],
  ["eval 'cmd' '/c' 'hcloud ECS DeleteServers'", 'deny'],
  ['eval eval cmd /c hcloud ECS DeleteServers', 'deny'],
  ['sudo eval cmd /c "hcloud ECS DeleteServers"', 'deny'],
  ['timeout 5 eval cmd /c hcloud ECS DeleteServers', 'deny'],
  ['nohup eval cmd /c "hcloud ECS DeleteServers"', 'deny'],
  ['sh -c \'eval cmd /c "hcloud ECS DeleteServers"\'', 'deny'],
  ['bash -c eval cmd /c hcloud ECS DeleteServers', 'deny'],
  ['cmd /c "eval cmd /c hcloud ECS DeleteServers"', 'deny'],
  ['bash -c "eval cmd /c \\"hcloud ECS DeleteServers\\""', 'deny'],
  ['eval hcloud ECS ListServers', 'allow'],
  ['eval "hcloud ECS ListServers"', 'allow'],
  ['eval hcloud ECS DeleteServers --server.id=1', 'deny'],
  ['echo DeleteServers | cmd /c "xargs hcloud ECS"', 'deny'],
  ['echo DeleteServers | powershell -Command "xargs hcloud ECS"', 'deny'],
  ['echo rm | cmd /c "xargs hcloud OBS"', 'deny'],
  ['echo ListServers | cmd /c "xargs hcloud ECS"', 'allow'],
  ['powershell -Command="hcloud ECS DeleteServers"', 'allow'],
  // The `start` title-vs-child heuristic is quoting-blind: both the
  // title-shaped write and the notepad-arg mention deny — the fail-closed
  // cost pinned deliberately (same family as the echo-mention residual).
  ['cmd /c start notepad hcloud ECS DeleteServers', 'deny'],
  ['cmd /c start "hcloud ECS DeleteServers" notepad', 'deny'],
  // Documented residual: encoded payloads are opaque to a text gate
  // (same class as ssh-relayed commands); pinned here so the residual
  // stays a decision, not an accident.
  ['powershell -EncodedCommand aGNsb3VkIEVDUyBEZWxldGVTZXJ2ZXJzIC0tc2VydmVyLmlkPTE=', 'allow'],
  // Unquoted bash -c truncates to the bare bin (real bash semantics);
  // the empty-args fail-closed must agree across layers, including the
  // nested bare-hcloud shape (routing threads top-down in both layers).
  ['bash -c hcloud ECS DeleteServers --server.id=1', 'deny'],
  ["bash -c 'echo; hcloud' && echo done", 'deny'],
  ['hcloud', 'allow'],
  ['sudo hcloud', 'allow'],
  ['hcloud --', 'allow'],
];

test('TS classifier and python hook agree on the shared adversarial battery', () => {
  const mismatches: string[] = [];
  for (const [command, expected] of BATTERY) {
    const ts = classifyTextCommand(command).decision;
    if (ts !== expected) mismatches.push(`TS: want ${expected}, got ${ts}: ${command}`);
    // The battery spawns the REAL hook (no copy, no redirect), so its
    // record_cli_event side effect would append to the SHARED agent-dir
    // spool (plugins/huaweicloud-core/telemetry/hook-events.jsonl — the
    // path derives from the hook file's own location, immune to every test
    // HOME isolation). ~490 hcloud rows per run then flood any later test
    // whose telemetry ingest reads that file: enqueueTrackedEvent ingests
    // the spool on EVERY enqueue, and one awaited flush splices only
    // BATCH_SIZE=100 — the #1040 flush pin's tool event (enqueued last)
    // missed its round on the windows CI legs twice (runs 40841747815 /
    // 40849117055; reproduced red-first on Linux by staging a 120-line
    // spool). The battery tests classification, not telemetry — the spool
    // write is an untested side effect, gated off here.
    const py = spawnSync('python3', [hookPath], {
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command } }),
      encoding: 'utf8',
      timeout: 30000,
      env: { ...process.env, HUAWEICLOUD_DEVKIT_TELEMETRY: 'off' },
    });
    const unavailable = (py.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
    if (unavailable) continue; // python3 not on PATH: TS-only environment
    // A crashed hook must fail loudly, not read as "allow" through empty
    // stdout — an allow-expected entry that crashes would otherwise pass
    // silently (the exact shape that hid a TypeError during development).
    if (py.status !== 0 || py.stderr) {
      mismatches.push(`PY: crashed (status ${py.status}): ${command}: ${py.stderr.slice(0, 200)}`);
      continue;
    }
    const pyVerdict = py.stdout.trim().length > 0 ? 'deny' : 'allow';
    if (pyVerdict !== expected) mismatches.push(`PY: want ${expected}, got ${pyVerdict}: ${command}`);
  }
  assert.deepEqual(mismatches, [], 'layer drift detected');
});

test('the env-dump flag chain stays linear on the -u/-- adversarial shape (ReDoS probe)', () => {
  // CodeQL js/inefficient-regular-expression flagged the flags alternation
  // of ARGLESS_DUMP_RE: the old two-branch form let a bare `-u` parse
  // through BOTH branches, so a failing tail (`plainword` — the shape that
  // forces full decomposition) went exponential — measured red-first on the
  // pre-fix regex: 14.3s at 26 repetitions of ' -u -- ', >120s at 28. The
  // (?!u\s) lookahead on the long-flag branch makes each token's parse
  // unique; 5000 repetitions must classify in bounded time on BOTH layers
  // (the python twin shares the structure; its spawnSync timeout of 30s is
  // the python-side bound — an exponential regression kills the process
  // there and fails the status assertion below).
  const payload = `env${' -u -- '.repeat(5000)}plainword`;
  const tsStart = Date.now();
  assert.equal(classifyTextCommand(payload).decision, 'allow');
  assert.ok(Date.now() - tsStart < 1000, 'TS classifier spent exponential time on the -u/-- chain');

  const py = spawnSync('python3', [hookPath], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: payload } }),
    encoding: 'utf8',
    timeout: 30000,
    env: { ...process.env, HUAWEICLOUD_DEVKIT_TELEMETRY: 'off' },
  });
  const unavailable = (py.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
  if (unavailable) return; // python3 not on PATH: TS-only environment
  assert.equal(py.status, 0, `python hook crashed on the -u/-- chain: ${py.stderr.slice(0, 200)}`);
  assert.equal(py.stdout.trim().length > 0 ? 'deny' : 'allow', 'allow');
});

// port-v2defects (interrogate round 4): the ANSI-C decoders are TWINS —
// decodeAnsiCSpans (src/safety/shell-text.ts) and decode_ansi_c_spans
// (hooks/huaweicloud-safety.py) must produce byte-identical output on the
// adversarial corpus, or the layers drift at the decode seam (verdict
// parity cannot see a digit-class drift unless a battery row happens to
// cross it). The corpus covers the state machine's edges: escape radices
// and digit caps, quote interactions (\' closers, \$' non-spans, $' inside
// plain quotes), adjacent spans, unterminated spans, over-range code
// points, and the outside-quote backslash branch (round 4's phantom-quote
// fix).
test('the ANSI-C decoders agree byte-for-byte on the adversarial corpus (interrogate round 4)', () => {
  const corpus: string[] = [
    "h$'\\x63'loud $'\\x4f'BS rm b",
    "h$'\\143'loud $'\\117'BS cp a b",
    "h$'\\u0063'loud $'\\U0000004f'BS sync a b",
    "h$'\\X63'loud", // capital X: not an escape, stays literal
    "$'\\x6'loud", // 1 hex digit
    "$'\\x687'loud", // digit cap: \x68 then literal 7
    "$'\\1039'loud", // octal cap: \103 then literal 9
    "$'\\400'x", // over-range octal: masked to 8 bits both twins
    "$'\\U00110000'x", // over-range unicode: stays literal both twins
    "$'\\u00e9'caf\\u00e9",
    "a$'\\x68''b", // span adjacent to plain quotes
    "$'\\x68'$'\\x63'loud ECS",
    "echo '$'\\x68'' is a literal", // $ inside plain quotes: not a span
    "echo \\$'hcloud' ECS x", // \$: escaped dollar + PLAIN quotes (not a span)
    "\\' ; h$'\\x63'loud ECS $'\\x44'eleteServers --server.id=x",
    "\\\" ; h$'\\x63'loud ECS",
    "grep foo\\' bar ; h$'\\x63'loud",
    "back\\\\slash $'\\x68'x", // \\ inside and outside spans
    "$'a\\'b'c", // \' does not close the span
    "$'a\\qb'c", // unrecognized escape stays literal
    "unterminated $'\\x68'loud", // no closer: original text returned
    "$'' empty span",
    "$''''$'\\x68'x",
    '$"lo\\x63ale" $\'\\x68\'y', // $" passes through untouched
    "x $'h\\$(y)e'z", // $( inside a span stays
    "tab$'\\t'newline$'\\n'end",
    'h\\cloud ECS x', // plain backslash escape (no span)
    'h\\\ncloud ECS x', // line continuation outside spans
    "printf $'%s\\n' hello",
    "PS1=$'\\u2560\\u2500' prompt",
  ];
  const ts = corpus.map((probe) => decodeAnsiCSpans(probe));
  const py = spawnSync('python3', ['-c', PY_DECODE_DRIVER], {
    input: JSON.stringify({ decode: corpus, tokens: TOKEN_CORPUS, glued: GLUED_TOKEN_CORPUS }),
    encoding: 'utf8',
    timeout: 30000,
  });
  const unavailable = (py.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
  if (unavailable) return; // python3 not on PATH: TS-only environment
  assert.equal(py.status, 0, `decode driver crashed: ${py.stderr.slice(0, 300)}`);
  const pyOut = JSON.parse(py.stdout) as { decode: string[]; tokens: string[][]; glued: string[][] };
  assert.equal(pyOut.decode.length, corpus.length, 'the driver must answer one decode per probe');
  for (let i = 0; i < corpus.length; i++) {
    assert.deepEqual(
      ts[i],
      pyOut.decode[i],
      `decode drift on ${JSON.stringify(corpus[i])}: ts=${JSON.stringify(ts[i])} py=${JSON.stringify(pyOut.decode[i])}`,
    );
  }
  // The tokenizer twin corpus (interrogate round 5): splitSimpleCommand and
  // split_tokens must agree on the continuation shapes — the preprocess leg
  // had no pin of its own.
  const tsTokens = TOKEN_CORPUS.map((probe) => splitSimpleCommand(probe));
  assert.equal(pyOut.tokens.length, TOKEN_CORPUS.length, 'the driver must answer one token list per probe');
  for (let i = 0; i < TOKEN_CORPUS.length; i++) {
    assert.deepEqual(
      tsTokens[i],
      pyOut.tokens[i],
      `tokenizer drift on ${JSON.stringify(TOKEN_CORPUS[i])}: ts=${JSON.stringify(tsTokens[i])} py=${JSON.stringify(pyOut.tokens[i])}`,
    );
  }
  // The GLUED tokenizer twin corpus (interrogate round 9): the write gate's
  // glued-bin fallback tokenizer must agree on both layers.
  const tsGlued = GLUED_TOKEN_CORPUS.map((probe) => splitSimpleCommandGlued(probe));
  assert.equal(pyOut.glued.length, GLUED_TOKEN_CORPUS.length, 'the driver must answer one glued list per probe');
  for (let i = 0; i < GLUED_TOKEN_CORPUS.length; i++) {
    assert.deepEqual(
      tsGlued[i],
      pyOut.glued[i],
      `glued tokenizer drift on ${JSON.stringify(GLUED_TOKEN_CORPUS[i])}: ts=${JSON.stringify(tsGlued[i])} py=${JSON.stringify(pyOut.glued[i])}`,
    );
  }
});

// One python3 process decodes the whole corpus via importlib (the Hermes
// load path) and answers JSON — kept as a string so the driver ships with
// the test. The driver also TOKENIZES a second corpus (interrogate round
// 5): the continuation-drop preprocess in split_tokens/splitSimpleCommand
// was defense-in-depth with no pin of its own — a refactor dropping it
// passed every verdict row (the splitter/shadow drops carry the verdicts).
const PY_DECODE_DRIVER = [
  'import importlib.util, json, sys',
  'spec = importlib.util.spec_from_file_location("h", "plugins/huaweicloud-core/hooks/huaweicloud-safety.py")',
  'm = importlib.util.module_from_spec(spec)',
  'spec.loader.exec_module(m)',
  'payload = json.load(sys.stdin)',
  'decodes = [m.decode_ansi_c_spans(p) for p in payload["decode"]]',
  'tokens = [m.split_tokens(p) for p in payload["tokens"]]',
  'glued = [m.split_tokens_glued(p) for p in payload["glued"]]',
  'print(json.dumps({"decode": decodes, "tokens": tokens, "glued": glued}))',
].join('\n');

// The tokenizer twin corpus: the line-continuation shapes (plus controls)
// must tokenize identically on both layers — now including the GLUED
// tokenizer pair (interrogate round 9: split_tokens_glued vs
// splitSimpleCommandGlued, the write gate's glued-bin fallback).
const TOKEN_CORPUS: string[] = [
  'h\\\ncloud ECS DeleteServers --server.id=x',
  'hcloud ECS De\\\nleteServers --server.id=x',
  'hcloud ECS "De\\\nleteServers" --server.id=x',
  "bash -c 'h\\\ncloud ECS DeleteServers --server.id=x'",
  'echo a\\\nb c',
  'hcloud ECS ListServers',
  "echo 'a\\\nb' c",
];

const GLUED_TOKEN_CORPUS: string[] = [
  '"hcl"oud ECS DeleteServers --server.id=x',
  "'hcl''oud' ECS x",
  'hcl"oud" ECS x',
  '"hcl""oud" ECS x',
  'bash -c "hcloud ECS ListServers"',
  "bash -c 'hcloud ECS ListServers'",
  "--description='a;hcloud;DeleteServers'",
  'a"b\\"c" d',
  "unterminated 'span",
  'unterminated "span',
  // Round 10: the separator-set alignment probes — py isspace() vs JS /\s/
  // drifted on \x85/\x1c-\x1f (fail-closed over-deny, non-executable
  // shapes); the py glued tokenizer now uses the explicit JS set.
  '"hcl"oudECS Delete',
  '"hcl"oudECS Delete',
  '"hcl"oudECS Delete',
  '"hcl"oud ECS Delete',
  '"hcl"oud　ECS Delete',
];

// The deep-nest `'\''`-idiom rows (interrogate round 13's AC-W2 gap: the
// battery comment claimed them but no row existed): the walk's extraction
// succeeds level by level but the mangled script never yields a leading
// bin — the deny-opaque gate's fragmented-token signal is the closure (the
// round-12 script-shadow pass it replaces denied benign prose instead).
test('deep-nest quote-idiom mangled writes deny via the opaque gate (interrogate round 13)', () => {
  const Q = String.fromCharCode(39);
  const DQ = String.fromCharCode(34);
  const BS = String.fromCharCode(92);
  const nest = (depth: number): string => {
    const esc = (s: string): string => s.split(Q).join(Q + BS + Q + Q);
    let script = `${DQ}hcl${DQ}oud ECS Delete`;
    for (let i = 0; i < depth; i++) script = `bash -c ${Q}${esc(script)}${Q}`;
    return script;
  };
  for (const depth of [5, 8, 9, 10]) {
    assert.equal(classifyTextCommand(nest(depth)).decision, 'deny', `nest depth ${depth}`);
    const py = spawnSync('python3', [hookPath], {
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: nest(depth) } }),
      encoding: 'utf8',
      timeout: 30000,
      env: { ...process.env, HUAWEICLOUD_DEVKIT_TELEMETRY: 'off' },
    });
    const unavailable = (py.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
    if (unavailable) continue;
    assert.equal(py.status, 0, `nest ${depth} py crashed: ${py.stderr.slice(0, 200)}`);
    assert.equal(py.stdout.trim().length > 0 ? 'deny' : 'allow', 'deny', `nest depth ${depth} py`);
  }
});
