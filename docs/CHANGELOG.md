# Changelog

## Unreleased

- fix(ci,e2e): two defects the first v2 push after a741465e exposed — one in the workflow file, one real Windows bug in the hermes driver, both root-caused against live runs. (1) **e2e-nightly.yml had failed to LOAD since the hermes commit** (2e557a66, run 40801915700 onward: 0 jobs created where 1521edb1's run created 2): its staged-rollout gate used the `matrix` context in a JOB-level `if`, which GitHub rejects outright — the whole workflow dies at validation with "This run likely failed because of a workflow file issue", invisible to the CI run everyone was watching (both interrogate rounds missed it; actionlint names it exactly: `context "matrix" is not allowed here`). Fix: the job-level `if` returns to the matrix-free PR-label form (the 1521edb1 shape GitHub demonstrably loads) and the hermes nightly/dispatch-only staging rides STEP-level gates where matrix is legal — preflight, install, and upload skip on push/PR lanes, and the suite step's `if` is the single budget control point. The push-lane hermes leg is now a green idle job (checkout/toolchain/npm ci/drift guard still run; the driver guard even exercises the hermes tests for free, the prepare-path one self-skipping without the pinned install) instead of a leg that never existed. The structure pin upgrades with it: the e2e job-level if must stay matrix-free AND the suite step must carry the gate — dropping either half re-opens a measured failure (workflow load death, or push-lane LLM spend). Round-3 adversarial review caught two more edges in the step-level move, both fixed: the trunk concurrency group now carries the EVENT name (`e2e-trunk-<event>-<agent>`) — with a shared group, any v2 push would have evicted an in-flight schedule/dispatch hermes suite mid-run (cancel-in-progress) and replaced the only real budget venue with the zero-coverage idle leg; same-event runs still serialize, newest wins — and the pin requires the folded `if: >-` form so an inline re-spelling cannot make the matrix-free assertion pass vacuously. (2) **the hermes driver's facts.json rewrite never worked on Windows** (run 40828557136, both windows legs: "facts.json paths must point into the borrower root"): `templateHermesInstalls` did a raw text `replaceAll(ownerRoot, borrowerRoot)` over the file, but JSON serialization escapes every backslash in the on-disk text while the in-memory roots carry single ones — on posix the two spellings coincide so the rewrite matched, on Windows it never did and the copied facts kept pointing at the owner (reads as stale → the network-bound uv sync the template exists to skip). The Windows legs reached this bug only after the USERPROFILE fix let the test past `ownerInstallsKey()` — the guard catching a real driver defect, exactly its job. Fix: `rewriteFactsPaths(factsText, fromRoot, toRoot)` — JSON-semantic (parse, rewrite string values recursively, re-serialize, both platform spellings rewrite), exported as the driver family's seam and pinned by a platform-twin test that proves the backslash spelling on Linux (the pure function needs no platform). PYTHONUTF8 stopgap confirmed effective on the same run (both hook-parity tests green on windows-latest 22 and 24); the remaining Windows observation point is the template test itself on the next push.
- fix(ci): the v2 CI matrix green again without losing agent coverage — two independent failure waves plus a lane move, each verified against the failed run 40801917454's own signatures. Wave A (2e557a66's hermes driver): `test/e2e-driver-hermes.test.ts`'s prepare-path guard reads the machine-scoped owner install (`~/.hermes/installs`, exactly one key) that only the e2e-nightly hermes leg's pinned install step — or a dev machine with hermes — provides, so every plain `npm test` job (floor + the whole 6-leg matrix) failed at `prepare()` with "expected exactly one hermes install key … found: (none)"; the prepare-path test now skips with the real venues named (install-state-keyed on purpose, never the real-agents ciSkip env-demand clause — the owner tree IS the precondition under test, so the nightly hermes leg's new pre-budget guard step `node --test test/e2e-driver-hermes.test.ts` runs it for real right after the pinned install), and `withFakeOwnerHome` sets `USERPROFILE` beside `$HOME` (Windows `os.homedir` resolves USERPROFILE — the runner's real profile leaked through the one-variable fake and failed the installs-template test on both windows legs; posix ignores USERPROFILE, measured). Wave B (Windows, pre-existing since 1521edb1's interrogate trio): the hook-parity tests' non-ASCII adversarial rows (the lone-U+FEFF battery row, the U+0085/NBSP/U+3000 separator probes) hit a windows python that reads piped stdin as cp1252 and misreads the UTF-8 bytes — reproduced byte-for-byte on Linux via `PYTHONIOENCODING=cp1252` (the exact two CI signatures: the U+FEFF `PY want deny, got allow` and the `hcloudÂ…ECS` mojibake drift), with `PYTHONUTF8=1` a green no-op on Linux across the whole python-spawning test surface; the CI test job pins `PYTHONUTF8=1` as a removable stopgap (precedence caveat recorded in the comment: an explicit PYTHONIOENCODING overrides it — no runner image ships one today), and the production-hook stdin reconfigure stays the deferred follow-up. The real-agents lane moved wholesale from ci.yml to e2e-nightly.yml (the plain PR gate never installs agent CLIs — agent-CLI-dependent coverage lives where the CLIs are): same pins, same `DEVKIT_REAL_AGENT_TESTS=1` demand, the same PR-label `if` minus the hermes staging clause, its own concurrency group, and the e2e job's checkout-ref policy; the move deliberately DROPS the carried `needs: [test]` (the destination has no test job — a literal verbatim carry would have failed the whole workflow at validation, "Unresolved dependency", killing the hermes leg and the moved lane together; caught in adversarial review before commit). Coverage trade, made explicit and complete: the plain v2 PR gate loses the real-agents lane (recoverable per-PR via the `run-e2e` label, which reads this workflow's v2-scoped PR trigger); push-to-v2 and the nightly/dispatch lanes keep it; and the old ci.yml trigger's reach beyond v2 — PRs into main/dev/next and pushes to dev — loses the lane outright, unrecoverable by label (e2e-nightly's PR and push triggers are v2-only by design; a release-cadence v2→main PR can still run `DEVKIT_REAL_AGENT_TESTS=1 node --test test/real-agents.test.ts` locally before merging); the e2e cron itself stays dormant until the byte-identical workflow lands on main — the documented bootstrap follow-up, so hermes-leg venues are honestly "dispatch-only until the cron is registered on main". structure-adopted's pin lockstep rewritten to the new topology (the two pins must AGREE between e2e-nightly.yml's two install sites, and ci.yml must carry NO agent CLI pin — doctrine made mechanical, red-first verified: the old test fails against the new workflows exactly as the move requires), and the stale "shared with ci.yml's real-agent lane" notes in e2e-nightly.yml's header, its install-step comment, and docs/e2e-testing-design.md updated with it. AGENTS.md's real-agents line points at the nightly lane now.
- feat(telemetry,hdkit): port dev's #1040 — agent-identity fallback convergence to 'unknown' + X-HW-Agent on every outbound request (dev e1ac2aa2 + eff624d1; the only dev wave not yet on v2 per the full 149-commit sweep). The v2 tree carried dev's pre-fix shape verbatim (agent-detect.ts was a TS transcription of the pre-fix agent-detect.mjs): AGENT_HARNESS passed through unvalidated (any env value became the harness and rode every event), clientInfo.name was returned as the harness for probe-class clients ('startup', 'voucher-claim-*' — the clientName of the hdkit check-user prewarm itself), and the fallback concatenated installSegment into the harness with a 32-char truncation — the '|' pollution of the shared dashboard's agent-distribution dimension (both the telemetry harness field and the new X-HW-Agent header inherited it). The port, dev's semantics with the family doctrine shaping the v2 seams: (1) AGENT_HARNESS is trusted only when it hits the AGENTS whitelist — an unmatched value is untrusted input and falls through to normal matching, then 'unknown'; both detect faces return 'unknown' on fallback (detectAgentHarness narrows string|null → string; the stdio transport's needsKeepalive comparison and mcp-protocol's initialize wiring needed no adaptation). (2) installSegment becomes the telemetry event's OWN field — v2 adaptation: the value is layout-derived, so the FACE derives it once at module scope and it rides the context's state record (dev's buildEvent calls installSegment() directly; a v2 sibling-held derivation would survive the query-string face re-import with a stale value — the exact class the state contract forbids). buildEvent stamps it sanitized when the layout resolved; a null layout emits no field. The exit-spool round trip (v2-only surface) keeps the exiting session's field verbatim through the toTelemetryEvent narrow — a non-string drops the field, never the line. (3) X-HW-Agent on both outbound faces: the telemetry flush POST carries the harness initTelemetry cached in state ('unknown' for a tools/call-first remote request that never initialized), and every hdkitservice request carries detectAgent().harness evaluated PER-REQUEST (the detection env can differ from the telemetry session's — a check-user call before any initialize handshake). Pins: test/issue-1040-agent-unknown.test.ts — the TS port of dev's 152-line battery (unknown fallback, whitelist gate, regression guards, both header assertions) plus the v2-specific pins dev's battery does not have (every flushed event carries the sanitized installSegment; no harness carries '|'; the toTelemetryEvent present/absent/malformed round-trip shapes); telemetry.test.ts's stale null pin flipped to 'unknown'. Test hygiene: the battery rides the shared fixtureDir registry (no raw mkdtempSync), the hermetic home pins the canonical telemetry face before the hdkitservice-api import, and both fetch stubs neutralize every proxy source (env spellings + proxy.json) file-scope, the hdkitservice-api.test.ts precedent. dev's docs/issue-1040/{spec,plan,task}.md are not ported (the dev-side planning-doc convention; this ledger entry is the v2 record). Post-interrogate disclosure (round 1, three adversarial reviewers, every finding run-proven): the battery's ported helpers create 3 cross-file jscpd clones against the two sibling test files they were convention-shaped from (the proxy preamble, the hermetic-home restore block, withNoAgentEnv) — deliberate test repetition, baselined in the regen commit, whose first message mis-attributed them to a hdkitservice-api import-block line shift (a misreading from scanning with the already-regenerated baseline; corrected by amend, the provenance re-verified against the pre-regen baseline); a fourth pair rides an existing fingerprint. Recorded unreachable-by-construction: a whitespace-only installSegment could emit `''` via buildEvent while the exit-spool narrow drops `''`, but selfPath's URL percent-encoding (spaces/newlines arrive as `%20`/`%0a`) makes the whitespace class impossible in any real layout; the legacy-residual note — a pre-upgrade exit-spool line still carrying an old `name|segment` harness rides the verbatim ingest once and goes out as-is (the exiting session's identity is never re-stamped, the same doctrine that keeps the field). Pre-existing, diff-independent suite flakes observed under full-suite load only (tests byte-identical on the base commit, both green in isolation and in this port's own gated full run): the hook-parity ReDoS timing probe is machine-load sensitive, and telemetry.test.ts's literal-keys test can race the hook tests' shared hook-events.jsonl spool ingest when their processes interleave under load.
- feat(e2e): the agent-level E2E suite gains a third driver — hermes (`test/e2e/drivers/hermes.ts`, `E2E_AGENT=hermes`), spike-validated on Hermes Agent v0.22.5 (commit bf0203a794a0) with every mechanism measured and banked in docs/e2e-testing-design.md "The hermes driver". The load-bearing discoveries: (1) `hermes -z` is a WebSocket client whose first invocation auto-starts a GATEWAY that owns the MCP server child and the terminal env and outlives every client (600s idle-exit) — the driver tears it down per attempt via `<home>/.hermes/gateway.pid`, because the runner's process-group kill cannot reach it. (2) A throwaway `HERMES_HOME` is a "borrowing launch" that by default network-syncs a full venv (minutes; killed runs leave uv cache locks that poison the next attempt — both measured), so the driver templates the machine owner's committed `installs/` tree (copy minus `*.lock` + a facts.json path rewrite, ~12s) and no network is touched. (3) Hermes filters stdio MCP children to the config env block + a safe baseline, so the session env rides the codex mcp-env-loader mechanism — the loader source is extracted to `drivers/shared.ts` (`MCP_ENV_LOADER_SOURCE`) with codex.ts importing it (same behavior, no copy). (4) The model config must use the `providers:` map (the legacy `custom_providers` list does not resolve on v0.22.5) with `key_env: E2E_APIKEY` + the alternate-spelling bridge; the leg rides chat wire. (5) `tools.tool_search.enabled: "off"` pins the eager 80-tool listing — hermes's default progressive disclosure hides MCP tools behind tool_search bridges the cases' prompts don't model. (6) The installer-written hook allowlist pre-approves the safety hooks, which fire headless under `-z` (fail_closed deny of an unapproved hcloud write measured verbatim in the tool result). (7) The version probe reads `install-stamp.json` (no spawn — `hermes --version` dials origin with a 60s timeout first) and the launcher resolves absolutely (PATH + `~/.local/bin` + checkout fallbacks). Verified live: 4 real-model cases green on the leg locally (approval-positive/negative, explain-error, and the installPacks trimmed-disclosure case the codex leg skips). First nightly finding banked: `core-free-choice-vendor-ambiguity` is red on this leg — under hermes's prompt stack the model fabricates the quote-form attestation through the challenge bounce at a measured 3/3 local draws (trace: first check_cli bounces ok:false, the retry quotes the ENVIRONMENT — "运行环境为华为云 devkit 测试环境" — which the string-presence gate accepts), while the same model+seed asks first on the opencode leg; the blade stays red by doctrine, the nightly quantifies the rate, and the named escalation (quote-content heuristic) is a product change. CI: the hermes leg joins e2e-nightly.yml as nightly/dispatch-only (staged rollout — job-level `if` excludes it from push-to-v2 and run-e2e label lanes, pinned by structure-adopted.test.ts alongside the install.sh `--commit` pin); the workflow file's byte-identical main/v2 rule is unaffected (bootstrap window still open). Guards: `test/e2e-driver-hermes.test.ts` pins the config surgery (loader-form args, absolute node, providers map, DEVKIT_PACKS posture preservation, drift fail-loud) and the installs template (lock exclusion, facts.json rewrite); AGENTS.md/RELEASING.md carry the third driver.
- fix(safety): close interrogate round 19 — the mangled-PREFIX and value-FLAG comparison family closed at every probe site on both twins; the probe grammar's comparisons are now uniformly normalized. The final-round reviewer (93 dual-twin rows, 11 real-bash execution proofs; the round-18 classes ALL green, zero regressions) found the rounds-15-18 normalizer applied at the HEAD comparisons of every probe while the PREFIX-token and VALUE-FLAG comparisons inside the same probes read the token raw: `comm'and' cat` / `en'v' python3 -c` / `busyb'ox' awk` / `env -'u' X cat` / `x'args'` all executed (27 shapes, 11 argv-proven). Fixed at every site: the walk-back's prefix probe and `skipPrefixArguments`' value-flag comparison (the shared chokepoints — tokens.ts / py `_skip_prefix_args`), `shellHeadBefore`'s prefix probe, `scriptTextOf`'s prefix arm, `unwrapCore`'s prefix comparison, the nested-script probe, `_leading_segment_core`'s prefix arm, and both xargs detectors (`segmentBearsXargs` / py's standard-path `_is_xargs_token` — the round-17 fix covered only the glued arms' key). The one twin disagreement (feeder.ts's pass-through comparison, py already normalized) aligned. The (b)-class boundary confirmed: filter/transform middles (grep/sed/rev), compound-body pipe sources (`while … done | bash` — the walk-back's control-flow doctrine discards control args), the pipe-into-script-carrier and xargs-placeholder compositions, ssh carriers — the documented MCP-backstop doctrine.
- fix(safety): close interrogate round 18 — the clean-round fixes after the exit round's three (a)-class recognition-site gaps, all at ONE site family (the round-17 walk-back head comparisons); the (b)-class compositional edges recorded as the documented boundary. The exit-round reviewer (107 dual-twin rows, 40+ real-bash proofs; the round-17 classes + 37 variants ALL green, zero regressions, zero twin disagreements) found: (1) **mangled pass-through heads at the walk-back comparison** — `| c'at' | bash` executed while the round-17 normalizer sat unused at that site; (2) **path-qualified and prefixed pass-throughs** — `/usr/bin/cat`, `command cat` (no basename, no prefix probe); (3) **mangled control heads + missing control flow in the walk-back** — `| i'f' true; the'n' xargs …; fi` executed. The fix: the walk-back head comparison now uses the design's own recognition grammar — quote-strip + basename + prefix/env probe — with CONTROL heads flowing through BEFORE the probe (probing would strip the `if` and misread `true` as the content head — the bug my first cut had, caught by the matrix before commit). The sibling xargs walk-back's control-head comparison (feeder.ts / py _walk_back_feeder) got the same normalizer. The four (b)-class findings — filter/transform middles (grep/sed/rev), pipe-into-script-carrier (`| bash -c sh`), xargs placeholder substitution (`-I{} bash -c '{}'`), ssh carriers — are the documented MCP-backstop boundary (new enumeration members and compositions the design never claimed).
- fix(safety): close interrogate round 17 — the clean-round fixes after seven more bypass classes; each a one-site-over completion of the pivot's own recognition sites or the pipe doctrine's sibling-owned semantics, all fixed. The clean-round reviewer (178 verdict rows, 25 real-bash argv proofs, 4 twin disagreements) found: (1) **the TS shell flag-skip missed the mangled-flag normalizer** (`bash -'o' pipefail -c`, `bash -'c'` — round 16's normalizer reached the interpreter branch and py's shell branch but not TS's shell branch; the flag-skip loop and c-cluster test now compare normalized tokens). (2) **mangled xargs heads** (`x'args'`) defeated the glued feeder arms on both twins — the head comparison strips quote-mangling and reads BOTH token streams. (3) **mangled watch heads** (`wat'ch'`) — the watch branch's head comparison strips the mangling. (4) **pass-through middle segments before the pipe-fed shell** (`… | cat | bash`, `tee`, `head`, `tr`) — the xargs walk-back's own pass-through set now serves the pipe-consumer feeder (the immediately-previous segment was a bare pass-through whose args are empty). (5) **pipe-fed interpreter stdin** (`echo 'import os; os.system("hcloud …")' | python3`) — the interpreter consumer gets the code-context deny when the walked-back feeder carries our token (the direct deny, not the segment-scoped opaque gate — the token lives in the feeder). (6) **printf format-arg feeders** (`printf '%s\n' 'hcloud …' | bash`) — the shell-consumer feeder classifies PER-WORD fail-closed (the xargs per-word doctrine: printf's format arg precedes the data). (7) **glued xargs with a pass-through middle** (`echo DeleteServers | cat | xargs "hcl"oud ECS`) — the glued arms use the walked-back feeder. The over-cap twin disagreement (`| bash -c` with no operand) resolved toward TS's fail-closed. Nits recorded: the near-dead second py C3 gate; the pin set for the verified allows.
- fix(safety): close interrogate round 16 — the clean-round fixes after four more bypass classes, each a one-token-over completion of the pivot's own recognition sites; the loop's convergence holds. The clean-round reviewer (178 verdict rows, 12 stub proofs + 1 live proof, 4 twin disagreements) found: (1) **quote-mangled SHELL heredoc heads** — `ba'sh' <<EOF` executes while the head probes key on the plain token (round 15 fixed the interpreter heads; the shell twin now strips quotes/backslashes/dollars from the head word — shellHeadBefore's probe on both twins). (2) **quote-mangled interpreter CODE FLAGS** — `python3 -'c'`, `perl -'e'` execute while every code-flag test keyed on the plain token (a shared normalizeFlagToken strips the mangling at every flag test site on both twins). (3) **the py glued-path expansion slot** — `"hcl"oud ${X:-ECS} ${X:-DeleteServers}` executed on py while TS denied (the slot rule lived only in py's plain-leading path; now the glued path checks it too). (4) **pipe-fed shell stdin scripts** — `echo 'hcloud …' | bash` executes while the design's sibling doctrines own the class (the heredoc-to-shell body denies, the xargs pipe feeder models pipe data reaching a consumer, the risk catalog denies the ENCODED pipe): the xargs-feeder doctrine now covers the listed-shell consumer — the previous segment's ARGS re-walk as the script, and a heredoc-to-pipe composition (`cat <<EOF | bash`) walks the body that lands inline in the shell's own segment. Nits recorded (fail-closed over-denies): `hcloud ECS '${X}'` (single-quoted literal) denies; space-separated flag values reaching the slot deny (KooCLI's canonical form is `--param=value`). Boundary-notes confirmed: expansion-split bins with no contiguous token, out-of-band carriers (file/ssh content), unlisted carriers.
- fix(safety): close interrogate round 15 — the clean-round fixes after the exit round's three bypass classes; the design boundary recorded as the loop's terminal state. The clean-round reviewer (174 verdict rows, 20 argv-dump proofs, 1 twin disagreement) found three classes inside the pivoted design's own signal definitions, all fixed: (1) **the expansion-built OPERATION/SERVICE/SUBCOMMAND slot under a seen bin** — `hcloud ECS ${X:-DeleteServers}` executes while the bin's visibility suppressed the opaque gate and the write vocabulary cannot match `:-Delete`; the SLOT rule: the first two non-flag argv entries carrying `${` deny opaque (flag-position expansions — `--cli-region=${REGION}` — stay allowed; the first blanket-marker cut denied both and was reverted in-flight). (2) **prefix/env/busybox before the heredoc shell head** — `env bash <<EOF`, `X=1 bash <<EOF`, `timeout 5 bash <<EOF`, `< in bash <<EOF` all execute while the head check saw only redirections; the head check is now the walk's own probe grammar (prefix + value-flag aware, bare operators skip their operand — a shared `shellHeadBefore`/probe helper, both twins; the first greedy-regex cut ate the shell word as a prefix argument and was replaced in-flight). (3) **closed-quote-mangled interpreter heads** — `pyth'on3' -c …`, `g'awk' 'BEGIN{…}'` execute while every interpreter-recognition site keyed on the plain token; the heads now strip quotes/backslashes/dollars before matching (the round-9 word-gluing doctrine). Warnings fixed: the over-cap `${X:-hcloud}` twin disagreement (the over-cap arm gains `${` on both twins — the TS obfuscation gate deliberately does NOT, per the slot rule); the TS unrouted walk's over-cap latency guard (5.3s at 9MB measured — the walk now skips over-cap payloads, matching py); the round-14 format:check red (a double-quoted assertion message). Boundary-notes confirmed as the terminal documented boundary: busybox ash/hush (unlisted applet-shells), env -S/ssh/parallel/ksh/vim (unlisted carriers), variable indirection, fully-expansion-built bins with no literal token — the MCP-backstop doctrine.
- fix(safety): interrogate round 14 — the exit round on the pivot — closed its four bypass classes; the design boundary holds. The exit round's reviewer probed the PIVOTED design with 48 fresh real-bash argv-dump proofs (zero twin disagreements on executable shapes, all 11 new deny-side signal shapes denied) and found four classes INSIDE the design's own signal definitions, all fixed: (1) **`${` parameter expansion was missing from the marker set** — `${X:-hcloud} ECS Delete` builds the command word by expansion (the exact substitution-built-argv rationale) while the routing boundary excludes `-`, so the default-expanded bin never even routed; `${` joins the opaque marker set AND the walk now runs UNROUTED (the walk's own signals are the scope — no token means every pass returns null, and the prose pins pass untouched). (2) **the `saw` accumulator leaked payload-wide** — a read classified in ONE segment switched the opaque gate off for every LATER segment (`hcloud List; node -e '…execSync("hcloud …")'` allowed the write half — the node half alone was a pinned deny); the accumulator is now PER-SEGMENT (seg_saw, ORed into the caller's scope), and interpreter code is checked UNCONDITIONALLY before extraction (the intra-code mask: `os.system("read"); subprocess.run("write")` — the system()-read used to mask the subprocess write in the same block). (3) **busybox applet dispatch** — `busybox sh -c '…'`/`busybox awk '…'` execute the applet named as the next token while every head-position family missed; busybox joins COMMAND_POSITION_PREFIXES on both layers. (4) **interpreter code via stdin heredoc** — `python3 <<'PYEOF' … system("hcloud …")` executes while the heredoc extractor is shell-headed and the code-context signal required a flag; the stdin-heredoc form joins the code-context arm (`<<` in the segment with an interpreter head). Also fixed en route: token PRESENCE in the opaque gate is contiguous-includes (the wordIn boundary excluded `-`, hiding the `${X:-hcloud}` token — the coordinator's rule is "appears ANYWHERE in the line"). The exit round's boundary-notes (the documented boundary, twins agreeing): plain-spelled commands in unlisted carriers (`echo 'exec hcloud …' | tclsh`), variable indirection, and fully-expansion-built bins with no literal token — the MCP-backstop doctrine. The probe-pollution incident (the py hook's cli-write spool from my own matrix runs broke an isolated telemetry test) was diagnosed as runtime-artifact pollution, removed, and the test re-verified green.
- fix(safety): interrogate round 13 on the port-v2defects trio + the DESIGN PIVOT — the vision tail closes by DENIAL, not enumeration. Round 13's two reviewers (10 + 3 criticals) proved the trajectory 3→9→10 criticals across three architectural completions was the attack-the-premise signal: enumerating bash's carrier grammar to see through it is non-convergent — the carrier space is unbounded (interpreter name variants, flags with values, awk -v, every invocation API from system() to subprocess/execSync/execvp, 19+ strippable stacks, redirection-operand heredoc heads). The pivot (per the loop's coordinator): when the walk hits a context it cannot fully traverse AND one of OUR tokens (hcloud/devkit-bin, in any walkable form) appears in the line — deny fail-closed with the sanctioned-paths remediation (huaweicloud_run_readonly_command / huaweicloud_run_approved_command) instead of vision. Three opacity signals fire the gate: (a) FRAGMENTED token (a glued/decoded re-join reveals the bin the raw segment hides); (b) EXPANSION marker ($'/$"/$(/backtick/<(>( anywhere in the payload — substitution-built argv is unreconstructable); (c) INTERPRETER CODE context (a -c/-e code argument or awk program — code context is definitionally non-traversable, which closes the ENTIRE invocation-API family without enumerating it). The gate is scoped by the walk's `saw` accumulator: it fires only when NO level of the walk ever classified our bin at a command position — a traversed read (plain, glued, nested, xargs-fed) never gates. Lines with no token anywhere stay allowed; plain contiguous tokens inside plain quoting with no markers stay allowed (the git-commit/echo/docker prose pins). Targeted round-13 fixes that stand alongside: value-bearing/long flags before -c (the -o pipefail/--noprofile/-ce classes — skip-with-value then a c-ANYWHERE cluster); interpreter head NORMALIZATION (python3.11/gawk/mawk/perl5/nodejs/raku collapse to the family); awk's -v/-f value flags skipped before the program; heredoc heads with OPERAND redirections (`< in bash <<EOF`, `2>/dev/null bash <<EOF` — POSIX grammar allows redirections before the command name); env-assignment stacks stripped UNBOUNDED (they are linear, no nesting — the 18 budget stays for nested carriers); ALL system() matches at STATEMENT position (`print("system('…')")` is a printed string; `system("a"); system("b")` classifies both); find-exec gated on the head BEING find (`echo -exec hcloud …` is an echo argument); and the round-12 SCRIPT-SHADOW pass REMOVED (it denied benign prose inside carrier scripts — `bash -c 'echo "step1; hcloud …"'` — and its purpose, the deep-nest `'\''` idiom, is closed by the opaque gate's fragmented-token signal with strictly less false-positive surface). The doctrine's ACCEPTED OVER-DENIES, pinned as deliberate rows: interpreter code MENTIONING hcloud in any string denies (print-vs-execute requires parsing the code — the exact vision the pivot retires); perl -c (syntax-check-only) still denies when the token rides -e. Recorded design boundary: plain-spelled commands inside UNLISTED carriers with no markers (e.g. `parallel 'hcloud …'` vs `git commit -m "used hcloud"` — indistinguishable to a text layer) are the 3-layer model's MCP-approval-chain backstop, the same doctrine as the shell-indirection residual; the over-deny direction is fail-closed by doctrine.
- fix(safety): close interrogate round 12 on the port-v2defects trio — 10 critical, 1 warning, 6 nits across two reviewers (the union: heredoc-detail regexes, flags-before--c, find -exec, interpreter system() carriers, 11+ strippable stacks, the deep-nest idiom's executable zone, and the xargs own-argv feeder merge). Every finding was a real-bash-executable deny-bypass proven with fake-bin argv dumps; the round's own notes: (1) **heredoc details** — the TS herestring match's `/m` flag matched a `<<<` line INSIDE a body (returning body text as the "script"); the TS delimiter quote class accepted only `'` while `<<"EOF"` is the textbook no-expansion idiom; the head regex required the shell as the head's LAST word (`bash -s <<EOF`, `bash < in <<EOF`, `bash 2>&1 <<<…` all escaped) and an argument-position shell word (`echo sh <<EOF`) over-denied; the marker line's trailing live text (`bash <<EOF 2>/dev/null`, `bash <<EOF; echo hi`) failed the marker regex — and the `;`/`&&` variants split the segment mid-line so the body lands in the NEXT segment (a dangling-marker + next-segment extraction now composes the body). Fixed all: the head check is now the head's FIRST word after optional redirections (also closing the over-deny), the marker accepts both quote forms and trailing text, and the herestring is position-0. (2) **flags before -c** — `bash -e -c '…'` executes; both script extractors skipped non-c flag clusters before the c-cluster (the skip class is `[a-bd-z]` — the first cut's `[a-df-z]` still contained `c`, caught by the probe battery mid-flight). (3) **find -exec** — the argv between `-exec`/`-execdir` and the `\;`/`;`/`+` terminator is a command position (`find … -exec hcloud ECS Delete {} \;` and the mangled form both executed); extracted from BOTH tokenizations (the plain one fragments a glued bin), re-running the walk. (4) **interpreter system() carriers** — `python3 -c 'import os; os.system("hcloud …")'`, `perl -e 'system("…")'`, `awk 'BEGIN{system("…")}'` all executed; the interpreter script args are carriers whose `system("…")`/`os.system('…')` inner string re-runs the walk (direct-string form only — variable indirection stays the shell-indirection residual). (5) **11+ strippable stacks** — `X1=1 … X11=1 hcloud …` executed while every unwrap/probe loop capped at 10; all budgets unify at 18. (6) **the deep-nest `'\''` idiom's executable zone** — depths 8-9 executed on BOTH twins while 1-7 and 10 denied (the idiom's close/open quoting fragments every tokenizer as the drift accumulates); the SCRIPT-SHADOW pass closes it: a carrier's script, after its own walk finds nothing, re-runs the walk on its quote-stripped shadow — the flattened `bash -c bash -c … hcloud ECS Delete` stream classifies the write. Scoped to carrier scripts ONLY (the first whole-text cut un-quoted PROSE into live commands and denied the pinned `echo "step1; hcloud …"` allows — the battery caught it before commit); py suppresses the empty-args arm on shadow-pass bare bins (prose artifacts like `--description='a;hcloud;DeleteServers'`), mirroring TS's guard. (7) **glued xargs with own argv** — `echo DeleteServers | xargs "hcl"oud ECS` executed (xargs appends stdin AFTER the own args); the feeder now merges into the glued argv. Also: `watch`'s flags joined PREFIX_FLAGS_WITH_VALUE ({-n, --interval}) on both layers; the stray probe artifact `out` deleted (a reviewer's certification blocker); py's dead `re.M` on the herestring match removed; the TS `i` flag added to the heredoc head (case-variant shells); the round-11 "depth-capped at 18" comment made true; the watch-usage-dump residual direction corrected (allows on both, twins agree); the deep-nest residual re-framed (the executable zone is now closed; ≥11 is E2BIG-non-executable).
- fix(safety): close interrogate round 11 on the port-v2defects trio — 9 critical, 2 warnings, 6 nits across two reviewers (all real-bash-executable deny-bypasses under the loop's sharpened boundary); the script-carrier completion — TS's glued walk is now RECURSIVE, mirroring py's doctrine end to end. The round's reviewers proved, with argv dumps on both hook layers: prefix-wrapped shells on TS (`env/sudo/timeout/nohup/secret-exec/skill-quality + bash -c '"hcl"oud …'` — TS's flatten only fired with the shell at tokens[0]); redirection-first scripts on BOTH (`2>/dev/null bash -c …`, `2>&1 …` — py's probe loop never stripped redirection tokens, and the SEGMENT SPLITTER broke `2>&1` mid-redirection on the `&`); quote-mangled ARGV under a plain-leading bin on BOTH (`hcloud ECS "De"leteServers` executes DeleteServers while the plain tokenizer reads `De` — and on TS the round-10 ownership rule had REGRESSED five round-9 deny shapes by skipping glued classification for plain-leading segments); heredoc/herestring script bodies on BOTH (`bash <<EOF\n"hcl"oud ECS Delete\nEOF` — the -c machinery never fires without the flag); glued xargs bins on BOTH (`echo ECS Delete | xargs "hcl"oud` — the standard xargs machinery keys on a plain bin token); and `watch`'s sh -c join on BOTH (`watch -n1 '"hcl"oud ECS Delete'`). Fixes: the TS glued fallback became `gluedWriteDenied` — a recursive per-segment walk whose `scriptTextOf` extracts shell -c / eval / watch-join / windows-payload / secret-exec / skill-quality script carriers with py's head-stripping (redirections, env assignments, prefixes), whose `heredocScriptText` slices shell-stdin script bodies (herestring edge-quotes stripped — the word is one argv blob bash parses as a script), depth-capped at 18 (py's budget); py gained the heredoc recursion, the redirection stripping in its probe loop, and watch's script-join branch in `_script_of`; BOTH splitters stopped treating `&` after `>`/`<` as a separator (the redirection-dup operator is part of the token); the plain-leading ownership became the VERDICT COMPARISON (the glued re-join classifies too — the empty-argv shape stays owned by the standard machinery so the pinned xargs read-feeders survive); glued xargs bins take the pipe feeder (the previous segment's words classify per the xargs doctrine — the feeder classification runs on the glued stream this time, catching the write-feeders while the read-feeders allow); and py's glued scope went BROAD (the narrow tail's end-of-string exclusion left `xargs "hcl"oud` at EOF outside the fallback entirely; the empty-args arm stays narrow-gated so the pinned bare-hcloud allows survive). Recorded residuals (non-executable or unverifiable): the non-glued tokenizer family's whitespace-class asymmetry (standing, fail-closed); mixed-quote non-executing bins over-deny; `'\''`-idiom span-boundary drift in deep nests (the fidelity cure has wide blast radius; the depth budget is unified at 18); the deep-nest ≥11 py misses; `parallel`/`find -exec` mid-token runners unpinned; windows-wrapper glued twins unverifiable on this box (the recursion covers the mechanism); py's whole-text glued last resort is effectively dead code (recorded); X-W2's watch-wrapped bare glued bin (a usage dump) over-denies on both — twins agree.
- fix(safety): close interrogate round 10 on the port-v2defects trio — 3 critical, 1 warning, 3 nits (the round ran under the loop's sharpened classification boundary: critical = deny-bypass/crash/false-verdict on real-bash-executable input); the glued gate's full-grammar completion. Round 10's two reviewers each proved glued-write bypasses with real-bash argv dumps (all pre-existing at the task base, all in the round-9 fallback's blind spots): (1) **the TS gate was a hand-rolled prefix walk** — shells (`bash -c '"hcl"oud ECS Delete'`), eval, env assignments (`HW_REGION=x "hcl"oud …`), redirection-first (`2>/dev/null …`, `<in …`), the skill-quality/secret-exec wrappers, and case-variant prefixes all escaped it while py denied; (2) **multi-segment payloads** (`echo x; "hcl"oud ECS Delete`) — the whole-text glued stream only ever inspected token 0; (3) **a leading READ masked a later glued write on BOTH layers** (`hcloud ECS ListServers; "hcl"oud ECS Delete` executed both) — py's `not saw_leading` gate silenced the glued pass for the whole payload, TS's whole-stream classification read only the first command's operation. Fix: the TS gate now reuses the FULL unwrap grammar (`unwrapWithWindowsFlag`) per `splitShellSegments` segment plus the whole text, with `flattenGluedScripts` (shell `-c`/`eval` script tokens re-tokenized through the GLUED tokenizer — py's recursion-join doctrine — because unwrapCore's own script re-tokenization is non-glued and re-fragments the span); py's fallback moved INTO the segment walk (per-segment, so a read in one segment never masks a write in another) with the whole-text pass kept as the `not saw_leading` last resort for wrapper-qualified shapes. The restructure's own regression — the first unconditional whole-text pass re-classified an xargs segment WITHOUT its feeder context and denied the pinned `echo List | xargs hcloud && echo done` allow through the empty-args arm — was caught by the battery before commit and closed by the ownership rule: segments the PLAIN tokenizer resolves belong to the standard machinery (feeder context intact); the glued attempt covers only the fragments. The glued tokenizer's word separators align to the EXACT JS `/\s/` set on py (round 9 had re-chosen the language-native `isspace()`, drifting the twins on \x85/\x1c-\x1f — non-executable shapes, fail-closed over-deny — the same class the strip-set lesson taught). Recorded residuals: the non-glued `split_tokens`/`splitSimpleCommand` family keeps its own py/TS whitespace-class asymmetry (standing surface, non-executable inputs, fail-closed); mixed-quote non-executing bins (`"hc'l"oud`) over-deny on both layers (the head predicates' quote normalization; bash says command-not-found); the round-8 timing figures are padding-shape-dependent; "0ms" flood figures measure single-digit milliseconds.
- fix(safety): close interrogate round 9 on the port-v2defects trio — 2 critical, 5 warnings, 6 nits; the glued-bin family, the input-redirect family, and the whitespace mirror's completion. Round 9's two reviewers each found an executable pre-existing critical (both real-bash-proven on both layers, both at the task base): (1) **quote-glued bins** — bash glues adjacent quoted spans and word characters into ONE word, so `"hcl"oud ECS DeleteServers` runs hcloud with full argv while the span/fragment tokenizers never yield an hcloud-leading stream (the piece-split's quote-carrying refusal and the feeder expanders rely on that distinction, so it stays); the write gates gain a GLUED fallback tokenizer (split_tokens_glued / splitSimpleCommandGlued — spans and word chars accumulate into one token, bash-word-faithful, twin-corpus-pinned) that classifies the reassembled argv ONLY when the glued stream is hcloud-LEADING at command position after prefix stripping and the standard passes found nothing (routed-gated: benign unrouted commands skip it; a quoted argument mention — `docker stop 'hcloud'`, `pip install "hcloud"` — keeps its orphan-allow; the first TS cut missed that gate and flipped three pinned allows, caught by the battery before commit). (2) **trailing-glued input redirects** — bash runs `bin<file args…` as the bin with the full argv, and neither the head predicates' peel (output-only) nor any routing tail included `<`; the peel now covers `<f`/`<<EOF` forms (both twins), and `<` joins the narrow and broad routing tails — `hcloud<f2 ECS Delete`, `printf … >f; xargs hcloud<f` (empty-argv fail-closed — the file-fed words are invisible), and `xargs hcloud<<EOF …` (the heredoc feeder) all deny on both layers. Warnings fixed: the whitespace mirror completed to the EXACT JS trim() set (round 8's bare str.strip() also stripped \x85 and \x1c-\x1f, denying py-side what TS allowed — a one-directional drift; the set rides the strip() call explicitly) with the TS reason text (Remediation included) matched; and the TS whitespace gate HOISTED to the top of classifyTextCommand — the dump-family regexes backtracked superlinearly on newline floods (7s at 32k, 25s+ at 128k — past the 5s hook timeout, reading as allow) before the late rule-engine deny could land; trim() is one linear pass, the placement mirrors py's gate-first posture, and the 128k-newline flood now classifies in 0ms. Nits fixed: the dead `routed` recompute deleted; the BROAD tail class pinned literally (dropping `<` or `;` now fails structure). Recorded residuals (round 9): the routed-slice latency (broad-routed over-cap payloads still pay the full py walk — ~30s/MB measured vs TS's 0.2s; Hermes blocks at its 5s fail_closed timeout, an availability cost not a bypass; verdicts correct whenever the hook completes); the head predicates' paren-stripped (`hcl(ou)d`) and BOM-glued (`\ufeffhcloud`) normalized spellings fall outside the latency guard's contiguity invariant — both non-executable in bash; the shape-dependence of the round-8 timing figures; the round-4 nit-count bookkeeping.
- fix(safety): close interrogate round 8 on the port-v2defects trio — 0 critical, 2 warnings, 4 nits; whitespace verdict parity and the over-cap latency guard. Round 8's attack reviewer could not break the round-7 surrogate fix (2,471-payload byte-parity sweep, boundary-exact at 262,144/262,145 on both twins; the certification reviewer's 308-case property test agreed) and certified the standing surface — but surfaced two pre-existing standing-surface warnings, both fixed: (1) **whitespace-only commands drifted** — the TS risk-rule engine denies `''`/`' '`/`'\n'`/`'\ufeff'` ("command must be a non-empty string"; JS trim strips the BOM) while the py hook allowed them; the py `evaluate()` now mirrors the gate (`\ufeff` dropped explicitly — it is not Unicode whitespace to `str.strip()`), pinned with four battery rows. (2) **the py hook paid the full segment/token walk on oversized benign payloads** — 32s+ measured on a 10 MB benign payload (a harness timeout swallows the verdict, which reads as allow) while the TS twin gates entry on routing and never segments; `hcloud_write_blocked` now skips the walk for over-cap payloads that are broad-unrouted (the new HCLOUD_ROUTE_BROAD_RE mirrors the TS broadRouted tail — `;`/`&`/`|`/`>`/end-of-string, so `xargs hcloud` at EOF and glued-separator bins still classify) — safe because every hcloud-head spelling the tokenizers admit also appears contiguously in the raw or stripped text, and the routed/expansion-bearing over-cap shapes already denied at evaluate()'s head cap (measured: 0.73s at 262 KB, 5s at 2 MB; over-cap quote-mangled bins, xargs tails, and printf-mangled writes all still deny). Recorded residual: the remaining cost is python-re linear scanning (~2.5s/MB vs V8's ~0.1s) in evaluate's presence gates and the rule engine — a 10 MB benign-unrouted payload still takes ~25s (down from 32s; verdicts unchanged); a python-side rule-engine bound would need a per-rule audit for non-hcloud matches, deliberately not done here. Pin hygiene: the round-7 codec pin ties `text_bytes` to the chain (a rename could drift past the codec-only assert), the surrogate boundary row's comment no longer claims to reproduce the write bypass (it is the count-parity shape; the bypass was the printf-mangled reviewer payload), and the two least-audited surfaces audited clean (the nginx marker EMISSION half matches the parser byte-exactly; `record_cli_event` is crash-guarded and cannot affect verdicts). Also recorded (pre-existing, outside the arc's diffs): the nginx -t PASS detection greps English output text instead of the exit code (fail-closed direction); both hooks fail-open on unparseable stdin JSON (symmetric, harness-trusted channel).
- fix(safety): close interrogate round 7 on the port-v2defects trio — 1 critical, 1 warning, 5 nits; the surrogate byte-count parity. Both round-7 reviewers converged on the same defect with executable proofs: round 6's `"replace"` byte chain counted a LONE surrogate as 1 byte where TS's Buffer.byteLength counts 3 (U+FFFD) — an 87k-surrogate payload sat under the py cap and over the TS cap, and a printf-mangled write (the documented substitution residual, padded over-cap) ALLOWED on the py layer while TS denied (reviewer P executed it through real bash; reviewer Q measured the FP-direction twin). Round 6's "byte count matches TS's Buffer.byteLength exactly" claim was false in three places. Fix: the py count is now the utf-16-surrogatepass round-trip (`encode("utf-16","surrogatepass").decode("utf-16","replace").encode("utf-8")`) — valid surrogate pairs survive as their astral characters, lone ones become U+FFFD, and the final length is byte-identical to Node's. A boundary parity row pins it (131,072 lone surrogates + `$(date)` → deny on both twins — flips if the counts drift apart again). Also: the phantom-marker residual is recorded with BOTH mechanisms (round 7's warning: the continuation drop can create `$'` markers bash never builds — `$$\<LF>'` glues the PID token's `$` to a quote, and a single-quote interior's closing quote composes one — fail-closed false denies on contrived-but-legit reads, measured allow→deny vs round 5 on both layers; never a miss), the "pair removal is part of bash's own first pass" comments are scoped honestly (bash KEEPS `\<LF>` inside `$'…'` spans and single quotes — the drop is deliberately blunter, over-deny only), the astral-row arithmetic is corrected (200k valid pairs = 800 KB bytes / 400,000 UTF-16 units / 200,000 code points — it discriminates the byte-unit change on py and the expansion-bearing cap on TS), and the 80315b4f commit message's "8 telemetry modules reachable" is corrected by this record to 6 in the compiled dist graph (the load-bearing half was true: the face was already reachable via src/lib/credentials.ts, so no new module entered the unbundled graph).
- fix(safety): close interrogate round 6 on the port-v2defects trio — 2 critical, 2 warnings, 5 nits; the composition channel and the surrogate crash. Round 6's two reviewers split again (O certified exit 0/0; N broke both new seams) — N's findings: (1) **the round-5 expansion check was continuation-blind**: bash removes the `\<newline>` pair BEFORE tokenization, reassembling `$'`/`$(`/backtick across the break — `h$\<LF>'\x63'loud ECS $\<LF>'\x44'eleteServers` executed as a mangled write while the raw text carried only `$\`, defeating the over-cap marker check (the exact slice round 5 claimed closed) AND the obfuscation gate's right conjunct at every size (the composition of round 4's continuation fix with round 3's mangling — pre-existing at tiny sizes, round-5-regression at over-cap). Fix: the expansion-marker check and the ANSI-C decode now run on the CONTINUATION-DROPPED text (`replace(/\\\n/g,'')` / `re.sub(r"\\\n","",text)`) on both twins — the drop is part of bash's own first pass, it can only ever CREATE markers (a real `$'` survives untouched), so the dropped form subsumes the raw one; the decode's outside-quote backslash branch would otherwise consume the `\` of a composed `$\<LF>'` without opening the span. (2) **the py hook crashed verdict-less on lone surrogates** — a round-5 regression: `len(text.encode("utf-8"))` raised UnicodeEncodeError on the `\ud800` the JSON parser happily accepts, killing the hook with exit 1 and no verdict (read as allow) for ANY payload carrying one, mangled or plain; `"replace"` handles them and its byte count matches TS's Buffer.byteLength exactly. Battery pins: the composed shapes (tiny bin/op, over-cap composed, the composed printf-substitution), the surrogate write deny + benign allow, and the astral-boundary row (200k astral chars = 800 KB bytes / 200k units — under both OLD unit-caps, over the new byte cap: discriminating for the unit change on both layers). Recorded residuals: the byte-unit change moved the cap for every non-ASCII payload (a 200k-CJK-char benign echo with `$(date)` — 600 KB bytes, 200k units — now denies where the old unit caps allowed it: the expansion-bearing FP class is quote-blind and size-widened, fail-closed direction, twin-consistent); the round-5 "constant-time" wording corrected here to "a single linear scan"; the e2e fake-shell's DB_NGINX_CONFIG_OK row is exercised only by the E2E-gated lane (doctrine-consistent).
- fix(safety): close interrogate round 5 on the port-v2defects trio — 1 critical, 2 warnings, 5 nits; the over-cap slice. Both round-5 reviewers converged on the same defect from different directions: the round-4 decode skip made >256 KiB the one place a fully-mangled write sailed through — an over-cap payload with the bin and op both ANSI-C-mangled denied on NO layer (the cap deny was routed-only, and a mangled bin never routes; the decode was skipped; reviewer L measured the exact boundary flip at 262,144/262,145 with real-bash execution proof, reviewer M reproduced it with a three-100KiB-args variant). Not a regression vs the task base (the class was open at every size pre-task; the task closed every slice but this one) — but it sat in this task's own defect family, unrecorded. Fix: the cap now denies EXPANSION-BEARING over-cap payloads too (a constant-time raw-text check for `$'`/`$"`/`$(`/backtick — no legitimate oversized expansion-bearing Bash payload exists; a benign over-cap payload stays allowed, so giant heredocs do not deny), and the cap counts BYTES on both twins — UTF-16 units (TS text.length) vs code points (py len()) disagreed at the boundary on astral-plane padding, the same payload denying on one layer and allowing on the other (the drift was pre-existing but verdict-visible only through the decode skip). Battery pins: the over-cap fully-mangled deny and the over-cap benign allow, both layers; the astral-boundary shape verified. Also: the tokenizer `\<LF>` preprocess leg gains its own twin pin (a 7-probe splitSimpleCommand/split_tokens corpus in the decode-corpus test — the leg was defense-in-depth with nothing failing if a refactor dropped it), and the round-4 CHANGELOG's "corrected in place here" wording is corrected by THIS entry (the round-3 bullet's "zero cost" parenthetical still stands as written then — the no-span fast path skips the decode, but a second stripShellQuotes and doubled candidate scans remain). Recorded residuals: the raw-newline FP (`hcloud\nECS DeleteServers` denies while bash runs bare hcloud + a not-found — pre-existing, fail-closed direction); the twin decode corpus silently skips on python3-less boxes (the file's pre-existing convention — a visible t.skip would count it).
- fix(safety): close interrogate round 4 on the port-v2defects trio — 2 critical, 2 warnings, 9 nits; the phantom-quote defeat of the decode, and the line-continuation channel. Round 4's decode attack (reviewer J, 88-probe twin-diff corpus + real-bash argv ground truth) found the round-3 state machine ignored backslash escaping OUTSIDE quotes: one escaped quote (`\' ; h$'…`) opened PHANTOM quote state and disabled the entire decode for the rest of the payload — the mangled write ran on every layer while all shadows saw nothing (and the mirror-image `\$'hcloud'` mis-opened a span on a benign echo). Fix: the outside-quote backslash branch (both twins) escapes the next character — an escaped quote no longer opens quote state, and `\$'` stays `\$` + plain quotes. The same reviewer proved the pre-existing line-continuation channel: bash removes the `\<LF>` pair at parser level, and the surviving newline broke contiguity in EVERY shadow (`h\<LF>cloud` never routed, `De\<LF>leteServers` never matched a prefix — executable write bypasses on the shipped layers, pre-existing at the task base). Fix: the pair now drops in both segment splitters (outside quotes AND inside double quotes — bash removes it there too; single-quoted spans keep it, literal), in both tokenizers (over-stripping single-quote interiors only ever JOINS tokens — fail-closed toward classification, never hides a marker), and in both quote-stripped shadows (so routing sees the joined bin). Also: the mangled-reveal reason pin is tightened to the specific reveal text (the old alternation passed with the decode reverted — vacuous); a TWIN DECODE CORPUS test pins the decoders byte-for-byte on 30 adversarial probes (radices and digit caps, quote interactions, adjacent/unterminated/empty spans, over-range code points, the phantom-quote shapes) — verdict parity alone cannot see a digit-class drift; octal \NNN masks to 8 bits (bash NUL-truncates >0o377); and the decode is computed after the length cap and skipped for over-cap payloads (a 10 MB escape flood must not pay the ~0.75 ms/KB linear pass before the gates' other candidates handle it). Recorded residuals: the printf-ANSI-C format FP (`printf $'created %s\n'` denies — the 37-word write vocabulary meets ordinary English in format strings; pre-existing, consistent with the fail-closed doctrine); the `\$'…'` echo shape still denies via the PRE-EXISTING stripped-shadow class; the round-3 "zero cost" wording corrected in place here (no-span fast path skips the decode, but a second stripShellQuotes and doubled candidate scans remain, and the TS vocab arm builds its regexes per call where the py twin compiles once).
- fix(safety): close interrogate round 3 on the port-v2defects trio — 2 critical, 4 warnings, 9 nits across three fresh reviewers; the root-cause fix is ANSI-C SPAN DECODING in both hook twins. The round-2 cloud-marker gate was simultaneously too narrow and too broad: mangling PAST the marker (`h$'\x63'loud $'\x4f'BS rm` — escape the c and the O and neither `cloud` nor `OBS` survives the stripped shadow, while the shell still executes the write; hex, octal, or unicode escapes, bin+op both mangled) re-opened a strict subset of the round-1 critical on EVERY layer, and the bare `cloud` substring denied routine huaweicloud-bearing PATHS (`cp $(mktemp -d)/x plugins/huaweicloud-core/dist/foo`). Fix: `decode_ansi_c_spans` (py) / `decodeAnsiCSpans` (src/safety/shell-text.ts, sticky-regex, allocation-free) — a quote-aware state machine that reconstructs the argv letters `$'…'` spans build (\xHH, \NNN octal, \uHHHH, \UHHHHHHHH; `\'` does not close the span; unrecognized escapes and `$"…"` pass through; an unterminated span returns the original text; `$(…)` substitution stays the documented residual), and the obfuscation gate + the secret-cli + reveal-pair presence checks now search BOTH shadow candidates (with no `$'` span the decoded candidate is the original — zero cost). The decoded candidate feeds the existing literal-anchored arms, so the bin, the service token, and the operation word survive ANY per-letter mangling — and mangled READS deny too (deny rather than parse, the #727 doctrine: an op-mangled read with a literal bin already denied; the mangled reveal now denies via the reveal-family check with its more actionable message). The OBS arm's marker tightens to the word-bounded OBS token alone (the mangled-bin class rides the decoded bin clause now). The decode landed with its own bug caught by the probe battery — the x/u/U prefixes sat inside the capture groups, so `int("x63", 16)` threw and every HEX/UNICODE escape fell through to the literal path while octal worked — fixed by moving the prefixes outside the groups in both twins. (2) The degraded py arm's leading-segment walk now runs UNCONDITIONALLY — the narrow routing tail ([\s)\]}'\"]) missed `xargs hcloud;|>&&&` executable tails (the healthy gate denies all five shapes); the walk is the scope, prose mentions stay allowed, and the length cap mirrors the healthy gate's. (3) The .mjs classify-time guard names its actual break: a distinct CLASSIFY_FAILED_REASON ("the safety classifier failed to run (corrupt safety rules?)") instead of reusing the load-failure text for a policy that parsed fine. (4) The sandbox-output OSC-edge comment is scoped to the nginx family (the devbridge-expose family still carries absence-equals-success fields — DB_MIGRATION/DB_TUNNEL_BODY/DB_QUOTA_ERROR — a selective swallow there reads as success; recorded residual, the same one-line-per-marker inversion applies when wanted). (5) Pin hygiene: the battery gains the mangle-past-the-marker rows (hex/octal/unicode/bin+op/mangled-read/mangled-configure), the printf-substitution residual control, the huawei-path and observations/gcloud allow controls (reviewer H's rm -rf row was re-attributed — that deny is the PRE-EXISTING destructive-deletion risk rule, not the marker arm — the battery uses an rm-free shape), the degraded xargs-tail rows, and the mangled-reveal reason pin in safety-policy. Recorded residuals (not fixed here): `$(printf …)`-built bins stay opaque to the decode (the OBS-token arm catches the service-token-literal form); the py-vs-.mjs tool_name gating asymmetry (py: Bash/terminal only; .mjs: any tool_input — the .mjs is stricter, pre-existing); the expose-family swallow above; the deploy script's invisible `sudo nginx` startup failure (no set -e — deploy_check is the backstop, pre-existing) and its unquoted tee/configPath under whitespace-bearing names (pathological, pre-existing).
- fix(review): close interrogate round 2 on the port-v2defects trio — 0 critical, 13 warnings, 14 nits across three fresh reviewers; all warnings fixed or closed by pinned disclosure. (1) **Verdict integrity of the .mjs fail-closed guard**: the catch arm's deny() rode an async stdout write followed by process.exit — Node does not wait for pending pipe writes under backpressure, and a DROPPED fail-closed verdict reads as allow (the exact failure the guard prevents). The verdict is now written with fs.writeSync(1, …) before the exit; and the guard covers CLASSIFY-time failures too (a truncated cloud-risk-rules.json killed risk-rule-engine's JSON.parse inside classifyTextCommand — the same verdict-less crash one call later; the classify call now denies fail-closed with a natural return, no exit race). Both shapes behaviorally pinned in hook-node.test.ts. The false TDZ claim in the round-1 comment is corrected (function declarations hoist; the placement is cosmetic) and the stale-dist boundary is stated (a dist built from older source imports fine and runs the old classifier — freshness is the build/install chain's job). (2) **The OBS vocabulary arm is marker-gated**: the round-1 unscoped union with OBSUTIL_WRITES denied a measured class of routine expansion-bearing idioms (docker rm $(docker ps -aq), mkdir -p $(pwd)/build, cp $(mktemp -d)/x, git commit -m "sync $(git rev-parse …)") — the short subcommand words are routine shell vocabulary. Both layers now fire that arm only when the shadow also carries a cloud marker (any *cloud spelling — the mangled bin leaves `x68cloud` — or the word-bounded OBS service token, which also matches obs://; `observations`/`jobs` stay non-markers), keeping the mangled `$'\x68'cloud OBS rm …` denies intact — the FP class and the mangled denies are pinned side by side in the battery. (3) **The last degraded-surface py/TS disagreement closed**: a present-but-EMPTY writeOperationPrefixes parsed fine and left the TS write gate silently fail-open while py denied — loadPolicy now throws on that shape (the exact fail-open the non-array throw's own doctrine comment names, one shape over; absent fields still normalize to [] for older policies), so the degraded surfaces cohere: py denies fail-closed, the .mjs hook denies fail-closed, the MCP server refuses to boot. (4) **The degraded py arm is invocation-scoped, not mention-scoped**: prose that merely mentions hcloud (`echo "see the hcloud docs"`, `grep hcloud README.md`) stays allowed — the scope primitives (segment split + leading-segment walk) are policy-free; hcloud-LEADING invocations all deny (reads and --help included — with no vocabulary there is nothing to prove safety with; the recorded trade), and the reason text now names the empty-vocabulary cause honestly ("could not be loaded or carries no write vocabulary"). (5) **The nginx config marker is presence-inverted**: the script emits OK-or-MISSING as if/else and configMissing reads MISSING-present OR OK-absent, anchored on the trimmed lines — every marker in the family is now presence-required, so a selectively mangled escape sequence that swallows a marker line (the OSC-hyperlink repro: `\x1b]8;;id=x … \x07` spanning the MISSING line while T=PASS survives) can only read as the FAILURE direction, never as the pre-inversion false success — the #935 defect resurrected; the repro is pinned as a battery entry. The anchoring also kills the prose false-positive (an nginx -t error quoting the marker text no longer reads configMissing) and the diagnosis wording now names the corruption possibility ("tee write failed or the verification output was corrupted"); the e2e fake-shell's synthesized success markers gain the OK line. (6) **The safety hook's own CLI telemetry labeling**: record_cli_event matched the write prefix regex against the "Service Operation" string, whose leading space defeated the token-anchored class — the canonical `hcloud ECS CreateServers` labeled cli:invoke (pre-existing, pinned nowhere). The label search is per-word now; OBS subcommand writes stay cli:invoke (the label vocabulary is the policy prefix list — recorded residual), all pinned in hook-python.test.ts. (7) Pin hygiene: the vacuous write-gate fail-closed shape pin is tightened to the cause-named text, the is-None arm pin is whitespace-tolerant, the vocab test's title matches its marker-gated body, globalTelemetryDir joins the telemetry face's pinned export list, the configMissing and indented-marker reads are asserted where they were merely exercised, and the trailing-whitespace/ST-OSC/leading-space shapes each have their own assertion. Recorded residuals (not fixed here): the empty-write-list shape via OPTIONS-provided policies still leaves TS's hasWritePrefix fail-open (pre-existing contract, out of surface); the workbuddy uninstall remains the only uninstaller that wipes the shared global telemetry identity dir (pre-existing); the 7.3.12 CHANGELOG entry's mis-citation of safety-policy.test.ts as an OBS pin holder (pre-existing).
- fix(review): close interrogate round 1 on the port-v2defects trio — 1 critical, 6 warnings, 10 nits across three adversarial reviewers; all critical/warning fixed or closed by pinned disclosure, the load-bearing nits fixed. (1) **The OBS mangled-write hole (critical)**: routing dies with the keyword under ANSI-C mangling, so the obfuscation gate's write vocabulary was the only layer that could fire — and it carried only writeOperationPrefixes, leaving `$'\x68'cloud OBS rm/cp/mv/sync/chattri` allowed on BOTH layers (pre-existing and symmetric; the defect-1 fix closed the drift, not the coverage). The vocabulary is now the prefix list UNIONED with OBSUTIL_WRITES on both layers (py load_policy union; TS writeVocabHit over `[...prefixes, ...OBSUTIL_WRITES]`), with battery pins for the mangled rm/cp/sync/chattri forms and the ls/stat read controls — the trade is a wider false-positive class on expansion-bearing text carrying rm/cp/mv-shaped words, the same class the #927 clause already accepted for deploy/update/remove. (2) **The last hand-maintained policy mirror**: py READ_OPERATION_RE hardcoded readOperationPrefixes AND matched at any \b while TS hasReadPrefix is ^-anchored — `hcloud ECS Update-Show-x` allowed on py, denied on TS. Now derived in load_policy (kept in the historical \b shape for record_cli_event's "Service Operation" string; the write gate's exemption anchors it via re.match — \b at position 0 ≡ ^), non-list values normalized to [] with an unavailable-read fail-closed exemption, and `Update-Show-x`/`ShowUpdate-x` pinned both layers. (3) **Degraded-mode coherence**: the vocabularies compile FIRST in load_policy (per-field isolation — an invalid regex in credentialFilePatterns can no longer abort the write/read derivation and over-deny every obfuscated command), non-list writeOperationPrefixes normalizes to [] instead of compiling a garbage char-alternation, and `hcloud_write_blocked` fails CLOSED when WRITE_OPERATION_RE is unavailable — a routed hcloud payload denies with the cause named instead of the pre-fix silent allow that reopened plain writes while their mangled forms denied; the Node hook wrapper gains the same posture (a try/catch around the policy import denies fail-closed instead of dying verdict-less, which a PreToolUse harness reads as allow), and the TS writeVocabHit treats an empty prefix list as a hit (the py is-None arm's mirror). Pinned behaviorally: hook-python.test.ts's degraded battery (policy-less copy: mangled deny, routed hcloud deny-with-cause, non-cloud obfuscation deny, plain allow, never crash; bad-regex-later-field copy: vocabularies intact, no over-deny) and hook-node.test.ts's no-policy fixture (deny with the named cause). Residuals recorded, not closed here: the TS write gate itself (hasWritePrefix over an empty list) stays fail-open on the abnormal empty-policy shape — pre-existing on main and v2, out of this surface; the credential/secret gates' own silent per-field degradation on unreadable policy (each is a presence gate with no routing scope to fail closed onto) likewise pre-existing; the py write-gate deny covers reads too in degraded mode (no vocabulary to prove safety — the recorded trade). (4) **nginx-verify round**: each line is TRIMMED before the anchored lookups (the deploy-check sibling doctrine — a trailing space after the value or an indented echo read nginxTest "" and a successful deploy failed its verification), the ST-terminated OSC form (`\x1b\\`, tmux passthrough) is pinned so a BEL-only "simplification" cannot pass, and sandbox-output.ts's header documents the OSC-swallow edge (the CSI analog was already documented). (5) **workbuddy round**: the uninstall stdout pin is location-bearing (the printed path must be the override twin), the pre-existing empty-parent leftover under the override is pinned explicitly as deliberate (the rmSync targets the telemetry child — recorded, not changed: an emptiness-guarded parent removal buys nothing on a devkit-namespaced dir that self-heals), makeEnv clears HUAWEICLOUD_DEVKIT_HOME (a developer shell exporting it silently ran every install test under the override), and the python-gated mkdir (hosts without WorkBuddy managed Python never get the dir from install — the server's lazy ensureDir self-heals) is disclosed here. (6) The structure pins were hardened per review: the vocab derivation pin scans every `WRITE_VOCAB_RE = re.compile` assignment for write_prefixes + OBSUTIL_WRITES (the byte-exact includes was reform-brittle and its doesNotMatch evadable by reordering), with sibling pins for the read derivation, the fail-closed arms, the per-field ordering, the TS union/empty-list mirror, and the .mjs guard.
- fix(safety,sandbox,install): the port-v2defects interrogate round — three v2-internal implementation defects the adversarial review dug out of the current tree (not port gaps), one commit each. (1) **py hook write-vocabulary drift**: `WRITE_VOCAB_RE` in hooks/huaweicloud-safety.py was a hardcoded 20-word alternation whose own comment claimed to mirror policy.json's `writeOperationPrefixes` — the policy carries 37, and the 17 missing words (enable, disable, set, put, upload, install, publish, bind, unbind, invoke, execute, trigger, deploy, rotate, cancel, confirm, subscribe) meant an ANSI-C mangled write like `$'\x68'cloud FunctionGraph InvokeFunction` ALLOWED on the py-hook faces (Hermes importlib, WorkBuddy deploy) while the TS layer denied via writeVocabHit — breaking TS/py parity on exactly the doctrine-named write families. The vocabulary now derives at `load_policy()` time from the same `write_prefixes` read that compiles `WRITE_OPERATION_RE` (one list, both gates, same source as the TS twin); the failure mode is recorded and FAIL-CLOSED: an unavailable derivation (policy unreadable/list empty) fires the gate's new `WRITE_VOCAB_RE is None` arm, so an expansion-bearing command denies instead of the missing word list re-opening the hole — strictly safer than the pre-fix degraded mode, which kept only the stale 20 words; no fallback list is kept, so nothing is left to drift. Pins: hook-parity.test.ts gains the four mangled-family entries (InvokeFunction corpus-real anchor) mirroring the existing `$'\x68'cloud ECS DeleteServers` pin; structure-safety.test.ts pins the derivation line, the fail-closed arm, and denies the return of a literal write-word alternation. Residual recorded: load_policy's except-pass still leaves the whole py write gate silent on an unreadable policy (pre-existing degraded posture, unchanged here). (2) **deploy-nginx verify blind to OSC shells**: `parseDeployNginxVerifyOutput` parsed the anchored `^DB_NGINX_T=`/`^DB_NGINX_T_OUTPUT:` markers on raw `String(stdout || '')` with zero escape stripping — OSC-integration shells (the measured reality behind the devbridge-auth/devbridge-expose comment testimony) wrap every line in `\x1b]133;C\x07`, the anchors never matched, and every SUCCESSFUL deploy_nginx returned ok:false "nginx -t did not pass" with an empty diagnosis. Fix at the parser, not the deploy-nginx.ts:262 call site — the parser is the entry point the #946 single-seam doctrine names, and folding there fixes every consumer; stripTerminalEscapes folds in (unknown-input contract behavior-identical for the undefined/empty cases), sandbox-output.ts's header lists name the nginx-verify parser, the #946 structure test sweeps it into the entry-point assertions, and session-manager.test.ts gains the OSC/CSI-wrapped battery entry (wrapped PASS reads PASS and composes to ok:true; wrapped FAIL+OUTPUT carries the diagnosis). (3) **workbuddy telemetry dir ignores HUAWEICLOUD_DEVKIT_HOME**: agents/workbuddy.ts:127 (install mkdir) and :183-186 (uninstall rmSync) joined `.huaweicloud-devkit/telemetry` off bare `homedir()` while the telemetry face's GLOBAL_TELEMETRY_DIR honors the override — install built an orphan in the real home while the server wrote under the override; uninstall deleted the wrong twin. Fixed by reuse: the face exports `globalTelemetryDir()` (its own import-time derivation — face-owns-state untouched) and workbuddy.ts imports it for both sites; import legality verified against the unbundled setup-cli graph (the face was already transitively in it — 8 modules reachable, nothing new enters); no doctor section or golden touches the dir (no regen). Pin: a real install+uninstall under the env override, seeding WorkBuddy's managed Python (the mkdir sits inside deployWorkBuddyHooks' python-gated block) — the dir appears under the override, no orphan under the bare HOME, uninstall removes the override's.

- feat(telemetry): the #1014 telemetry-flush wave as four v2 units — awaitable flush, exit-time disk spool, voucher P0 sync flush, and one recorded non-implementation. (a) **E4a awaitable flush**: `flushEvents` was fire-and-forget (`void`) — no consumer could await completion; it now returns `Promise<void>` with a documented in-flight contract (a caller arriving mid-round chains onto the in-flight round plus ONE follow-up round, so its own late-enqueued events still get a real send attempt before resolve; one round per call keeps the timer/enqueue pacing and never back-to-back self-retries; the promise never rejects — failures requeue for the next trigger or drop after MAX_RETRIES), the rendezvous rides a new `state.inflightFlush` field (sibling-mutated through the ctx only — face-owns-state discipline unchanged), and the face exports `flushTelemetryEvents()`; `test/telemetry.test.ts` gains the file's first flush behavior tests (the v2 counterpart of dev f38f69b9's test gap): empty-queue no-POST, literal-key send, gated-fetch in-flight chaining, 503-resolves-and-requeues. (b) **E4b exit spool**: the unref'd flush timer plus the stdio transport's hard `process.exit(0)` meant the unflushed tail (the last ~60s of tool/skill-invoke events) died with the process — `process.on('exit')` cannot host the async fetch, `beforeExit` never fires on explicit exit, and awaiting a 5s fetch in `onStdinClose` risks CLOSE_TIMEOUT, so the v2-native fix is a synchronous disk spool: both close paths (stdin→exit, stdout→natural-drain) call the new `spoolTelemetryEvents()` which serializes the queue as full-event JSONL to `exit-events.jsonl` in the GLOBAL telemetry dir (survives payload-dir-replacing updates; follows `HUAWEICLOUD_DEVKIT_HOME` so test isolation covers it) and CLEARS the queue (the spool copy is the handover — a straggler flush on the drain path finds an empty queue and cannot double-send; append mode keeps concurrent sessions from clobbering each other's tails); the next boot ingests it through the SAME rename-now/read-next seam as the hook spool (`ingestHookSpool` generalizes to `ingestSpools`; exit lines are FULL events that keep the exiting session's identity — new strict `toTelemetryEvent` narrow, never rebuilt with the next boot's stamps). Bounded residuals, documented on `spoolEventsForExit`: an in-flight flush round at spool time is not captured (≤100 events inside one 5s fetch window — the pre-wave behavior, no regression); crash-before-spool keeps the in-memory loss (no handler runs); a stdout-close round completing after its non-capture requeues into the drained process and is lost. The transport's stream bindings became an injectable seam (`options.streams`, the `initializeSideEffects` precedent, production default = the real process streams) because binding the REAL streams under a test harness measurably corrupts the harness's own stream state. The remote surface gains no exit logic. (c) **E4c voucher P0 flush**: `voucher_claim`/`competition_voucher_claim` handlers now await `flushTelemetryEvents()` after the claim result and before returning (a claim is one-shot and the session often ends right after — the exact loss dev's #1014 named); seam decision: pack handler layer, not a core-dispatch `P0_SYNC_FLUSH_TOOLS` roster — the voucher pack owns the claim semantics (pack-granularity doctrine; importing the telemetry face is CORE_VALUE_DIR-legal), and the handler seam is behavior-testable through `callTool`; `voucher_status` stays unflushed (a probe does not end a session). (d) **E4d userHash backfill: recorded, NOT implemented** — dev's backfill closed dev's wide first-session window, but v2 already has the initialize-prewarm equivalent (`runInitializeSideEffects` awaits `hdkitGenerateUserHash()` with a 3s race bound during the initialize handshake, before any event can enqueue; the hash persists via `persistUserHash` and every boot re-caches it via `loadCachedUserHash` — wired since dev d985362d's `cacheUserHash` port), leaving a residual window of only: first-ever session AND prewarm failure (offline/timeout) AND an event enqueued before a later successful hash response — narrower than a flush-time backfill could close without adding a per-flush identity re-stamp that would falsify already-built events; not worth the complexity. Also recorded: dev 3deb4567 (setup-cli directory respecting `HUAWEICLOUD_DEVKIT_HOME`) is NOT applicable — its fix targets dev's setup-cli.mjs/codebuddy paths, which do not exist in v2; v2's telemetry face already derives its global dir from that env, and the known `workbuddy.ts` bare-`homedir()` residue is T6's scope, untouched here. Structure pins: `flushTelemetryEvents`/`spoolTelemetryEvents` join the face-export list; the spool-before-exit call order is pinned on both transport exit paths; the `mcp-server-remote` stateless face is untouched (禁区). Post-interrogate disclosures (rounds 1-2, five adversarial reviewers): the spool ingest is AT-LEAST-ONCE, not exactly-once (a failed unlink after a successful read, or a cross-process read inside the read→unlink window, can re-send a batch — pre-existing hook-spool semantics, inherited); the ingest path now CLAMPS the queue to the event-queue cap (one shared constant, `MAX_EVENT_QUEUE` in telemetry-values.ts — no mirrored pair to drift) — without the clamp a multi-session spool accumulation loaded unbounded events into memory; with it, a recovery larger than the cap drops its OLDEST overflow at read time (truncating what a no-clamp recovery could have fully delivered across later rounds — the memory invariant is the point), pinned by a 600-line-spool behavior test; spool recovery timing is next ACTIVE boot (a zero-enqueue steady-state boot only claims the file via the rename; its first tool-call enqueue or timer tick reads it — an idle boot defers recovery one lifetime, no loss); the remote surface's voucher calls dispatch through the same E4c handler against process-wide telemetry state (initialized on each initialize handshake; a tools/call-first request on a fresh remote process has no telemetry state and the await is a no-op), so with an unreachable telemetry endpoint a remote claim response's wait scales with concurrent flush arrivals — each in-flight collision adds a follow-up round, so on a busy multi-session remote the wait can exceed the per-batch retry budget's horizon (the budget bounds each batch's delivery lifetime, not the chain's latency) — the latency coupling is documented on the handler; one deliberate pacing change from the pre-wave void flush: a trigger arriving while a round is in flight (previously a no-op) now chains into a follow-up round, densifying retries under sustained enqueue pressure against a dead endpoint (retry-budget-bounded per batch either way); the remote process's own queue tail has NO exit-spool coverage (correctly — the 禁区 forbids exit logic there) and crash-before-close-handler (SIGKILL-class) keeps the in-memory tail; the Hermes-Win32 keepalive branch (stdin close arms a timer, session continues — in-flight calls can still enqueue before stdout closes) deliberately does not spool on stdin close — its tail rides the eventual stdout-close path, and the branch is shape-pinned in the structure test; `npm run smoke:agents` now sets `HUAWEICLOUD_DEVKIT_TELEMETRY=off` (its MCP roundtrips boot with the developer's real HOME; the current tools/list-only roundtrip never initializes telemetry so nothing lands today, but any future roundtrip step that initializes — or calls a tool on an initialized server — would arm the exit spool against the real home's telemetry dir; the off-switch is a forward-looking guard against that test→production channel).
- feat(sandbox): port dev's Stack-Selection Gate (#1021, dev 688992b9) — workbench / 工作台 / 全栈 / full-stack / CRUD-with-persistence requests must be classified as full-stack workbench deployments whose backend defaults to **PostgreSQL + PostgREST** even when the developer never mentions 数据库/postgres/CRUD, closing v2's structural silent-SPA-fall-through risk (its only question gate was the Target-Selection Gate — which picks the deployment TARGET, not the stack — and the Full-Stack section was conditional routing with no MANDATORY marker, no pre-code checkpoint, and no anti-fall-through rule). Ported into the pack-owned source `src/packs/sandbox/skills/huawei-sandbox/SKILL.md`: the `## Stack-Selection Gate (MANDATORY — do not skip)` section between the Target-Selection Gate and the Overview — the `question`-tool confirmation for ambiguous backends with the PostgREST default presented first (① PostgreSQL + PostgREST 全栈 (recommended) / ② 应用自带后端 / ③ 纯静态-SPA), the **NEVER infer or default the stack to SPA** hard rule (工作台/workbench/全栈/full-stack/CRUD/数据库/持久化 ⇒ full-stack unless explicitly overridden), the **Pre-code checkpoint (MANDATORY)** (verify the backend choice before uploading or writing ANY application code; an SPA-only deployment that already started while persistence was implied ⇒ STOP, tell the developer, and redirect to the full-stack path — never paper over it with a bolted-on static backend), and the post-choice routing (PostgREST → the Full-Stack section FIRST, backend before any frontend code; 自带后端 / 纯静态 → Web Application Deployment) — plus `**Step 0.5 — Stack-Selection Gate (MANDATORY)**` in the Workflow, after Step 0 (the target gate) and before any code upload (pinned by index ordering against the whole numbered preflight — its Connect step can already transfer code via the `git` parameter), linking the gate at its heading anchor. Description triggers widened with dev's words (backend service, 工作台, workbench, full-stack, 全栈, CRUD 应用, database-backed REST API, PostgREST, postgres) inserted into the existing Triggers list between `web application` and `hwlink` — v2 divergence kept: the description retains its vendor-gate prefix text verbatim (dev carries none), only the trigger words are inserted, and the NOT-for ECS/CCE exclusions are untouched, so the widened deployment vocabulary still routes through the ask-which-cloud gate before any sandbox lifecycle tool fires (the load-path vendor-boundary pins stay green); dev also widened the description's opening use-when sentence ("web application, backend service, or full-stack workbench") — not ported, per the task's triggers-only scope, and every dropped token is present in the Triggers list. The Web Application Deployment `Backend present?` note keeps its pinned opener but gains dev's reinforcement sentence (with the sentence-initial capital its standalone position after the kept opener requires): "The backend choice was already confirmed by the [Stack-Selection Gate](…) before any code was uploaded." so an agent entering at section level still meets the gate. Two recorded v2-wins deviations beyond dev's diff, both from the interrogate rounds: (1) a Critical Warnings row "Stack not confirmed (workbench ⇒ SPA)" beside the target-gate row — the target-gate doctrine is reinforced on four surfaces (gate section, Activation bullet, Step 0, Critical Warnings row) while the stack gate had two, and the late-flow catch-all table is the surface an agent consults last; (2) a reconciliation clause in the Backend-present note — the Full-Stack section's hand-written single-origin nginx config (serving both `/` and `/api/`) must not be displaced by the Configure Nginx sub-step's SPA/proxy/static `deploy_nginx` templates, the double-nginx seam dev's routing sentence left open — plus the matching fix in `references/fullstack-postgrest.md`'s reboot-recovery guidance, which still routed the nginx-config re-creation through `huaweicloud_sandbox_deploy_nginx` (its templates carry no `/api/` reverse proxy, so a recovered site would come back SPA-only — the same silent-SPA bug class on the recovery path); both recovery mentions (the Lost-on-reboot row and the restart-recovery checklist) now re-apply Step 3's single-origin block instead. Dev's fullstack-postgrest.md prettier-alignment hunks are not re-landed — v2's T3 file is already prettier-settled (`prettier --check` green; its tables legitimately differ from dev's by the recorded T3 divergences, e.g. the dropped DevBridge rows). Guards: a new standalone gate test in `test/structure-proxy-devbridge.test.ts` beside the T3 full-stack pins — line-anchored heading lookups (a `###` demotion cannot keep them green), gate position between the two gates and the Overview, the MUST-treat-as-full-stack classification sentence, the PostgREST default, the question-tool mandate, the NEVER-SPA rule, the Pre-code checkpoint with its STOP-and-redirect + no-bolted-on-backend clauses, the routing anchors to both sections with both target headings pinned, the Backend-present back-reference and the nginx-reconciliation clause, the Critical Warnings row, the Step 0.5 sentence with its scoped gate anchor + index-ordered position (after Step 0, before the whole numbered preflight), the widened trigger run pinned contiguously with its insertion point, the NOT-for clause intact, and the reference's reboot-recovery rows pinned away from `deploy_nginx` (negatives on both old routing phrases, positives on Step 3's single-origin block).
- docs(sandbox): port the dev full-stack PostgREST knowledge wave (#1016/#1017 + #1019/#1020) into `references/fullstack-postgrest.md` — v2 carried only the pre-wave 149-line version, and its PGDATA still taught `/var/lib/pgsql/16/data`, i.e. the 系统盘, which a sandbox reboot rolls back to the image state and destroys every database — a direct contradiction of v2's own #999 persistence doctrine (SKILL.md: the system disk rolls back, `/workspace` survives, measured overnight reboot 2026-10-22). Data-loss-grade fix first: the cluster moves to `/workspace/pgsql/16/data` (initdb/pg_ctl/logfile all on the data disk) with the 系统盘-rollback rationale. Also ported: the Aliyun RPM mirror (PGDG's `download.postgresql.org` and AlmaLinux's `repo.almalinux.org` measure ~8KB/s from the sandbox CN egress — a 6.8MB server RPM times out inside 240s — so the `pgdg16.repo` baseurl, the `BASE` RPM-download variable, and the libicu60 direct URL move to `mirrors.aliyun.com`); the same-mirror-only resume rule (`-C -` resumed from a DIFFERENT mirror fails rpm verification with "Payload SHA256 digest: BAD" — `rm` the partial and re-download in full on a source switch; and a corrupt RPM ABORTS the whole `rpm -ivh` transaction, silently skipping its batch, so one RPM per call); the PostgREST asset-name trap (the asset has NO patch version — `postgrest-v16.5-linux-static-aarch64.tar.xz`, not `v16.5.0`, which 404s and is misdiagnosed as a broken proxy — verify the real name via the GitHub releases API first); the third-party-proxy + official-sha256 doctrine (ghfast.top / gh-proxy.com measure ~500KB/s but their bytes are untrusted — pull the official asset digest from the GitHub releases API, `sha256sum -c` before extracting, which also catches truncated downloads; the digest extraction uses `sed` not `cut` because `cut` leaves a trailing quote and trips `sha256sum -c -` with "no properly formatted checksum lines"; an empty digest means the API lookup failed and the download must NOT proceed unverified); the MCP exec-channel escaping trap (nested quotes / inline JSON in pgrst.conf, `psql -c` SQL, and `curl -d` get mangled — write the file locally and `huaweicloud_sandbox_upload_file` it, then `psql -f`); the whole "Field notes (2026-10 retest): 5 measured traps" section (re-measured 2026-10-23 on HCE 2.0 aarch64, no systemd, PG 16.15 + PostgREST 16.5; all five reproduced and solved, end-to-end verified page 200 / API 200 / POST 401 anon-default → 201 after `GRANT INSERT` on `api.todos`, including the `upload_file` 640-permission → silent schema failure → PGRST002 trap); and the full-stack-specific restart-recovery checklist (PG data survives on `/workspace` — no schema rebuild/`initdb` needed; only the PG RPMs + soname shims + `postgres` user rebuild, then `pg_ctl -D /workspace/pgsql/16/data start` resumes the cluster, followed by the PostgREST relaunch and nginx reload) plus the write-grant rollback trap (re-running a SELECT-only `schema.sql` overwrites the catalog's write grant → POST 401 → targeted `GRANT INSERT, UPDATE, DELETE` → POST 201). The generic reboot doctrine (Step 0 reinstall, credential re-injection, watchdog re-attach) already lives in SKILL.md's #999 section and is referenced, not duplicated — dev's DevBridge-binary/tunnel/`/tmp`-credentials rows are dropped for that reason. v2 divergence kept: the existing Step 4 two beats (401 anon-default + "grant on the specific table, never to anon broadly") stay verbatim — the port adds only the missing third beat (the same POST → **201** after the targeted grant). No v2-intentional-divergence comment existed in the file. Guards: four new content pin groups in `test/structure-proxy-devbridge.test.ts` (PGDATA on `/workspace/pgsql/16/data` — the `initdb -D …` command plus the broad path, the broad `/var/lib/pgsql/16/data` negative, and the `系统盘 (system disk)` wording; the two Aliyun mirror URLs; the sha256-before-extract doctrine with the asset name and the empty-digest guard; and the ported third beat (the Step-4 sentence starting "After that targeted grant the same") beside the existing full-stack pins; no `src/` TypeScript changed. One inherited correction: the prose's stale "PostgREST 16.4" (both dev's and v2's wording) was aligned to the measured 16.5 that the same section downloads and the field notes record.
- docs(skills): port the dev find-skills install wave (745f48c0 + 04dae37f residue) — the root marketplace skill `skills/huawei-cloud-find-skills/SKILL.md` still taught `npx skills add` (GitCode) as the default install path, forking from the devkit's own `huaweicloud_search_marketplace` output: the git-free HTTP ZIP mechanism in `search-market.ts` `buildSkillInstallCommand` (itself the live port of dev's 745f48c0, `(#F)`/P4/P5 shape) had already made curl-GitCode-then-GitHub + find-locate + copy the returned installCommand, and the capability-discovery skill already taught it — the stale root copy was the one surface still routing agents into the measured-broken GitCode path. This wave closes it: Option A becomes the HTTP download, mirror-verified against `buildSkillInstallCommand` parameter-by-parameter (both zip URLs, the GitCode-first/GitHub-second fallback order, the SKILL_SRC_NOT_FOUND semantics — the `test -d` + `test -f "$SKILL_SRC/SKILL.md"` guards with the fail-loud `false` short-circuit so `cp` never runs on a bad source), with the recorded v2-wins deviations from dev's text: the whole block is one `&&`-joined chain exactly as the tool emits it (dev split download and copy into separate statements, so a failed download over a leftover extraction could install stale content and exit 0 — the join closes that), the find is scoped to `huaweicloud-skills-master/skills` (the tool's own fallback branch; dev's text searched the whole extraction root), dev's dead pre-download find line and its weaker `[ -n ... ] && cp || echo` guard are not ported (the leading `mkdir -p` folds, quoted, into the chain tail), and the Option A comment additionally teaches the tool's exact-path assignment branch (category/service from the Step 1 results). Ported verbatim from dev: the `npx skills add` GitCode deprecation with the measured 2026-10 failure ("Downloaded URL is not a valid SKILL.md file or supported archive") and its git clone bypass, and the all-fail paragraph teaching the manual GitHub-zip download with per-agent skills-dir resolution. No code changed — `search-market.ts` and the pack-owned skill sources were already aligned.
- fix(deps): port dev's fcfacd0c — undici `^8.12.2` → `^8.12.3` (the one runtime dependency), keeping the blocking production audit gate green (`.github/workflows/ci.yml` runs `npm audit --audit-level=high --omit=dev` with no continue-on-error; the task card cut this port believing that gate stood red against v2's 8.12.2 pin). Advisory-wave facts as verified at port time: the October 2026 wave's three advisories — GHSA-4qv8-2p9j-2685/CVE-2026-109924 EventSource-parser DoS and GHSA-f72v-6w45-q472/CVE-2026-109841 SRI bypass (both moderate) and GHSA-xjj6-f33q-929c/CVE-2026-109869 content-encodings DoS (the one high, which alone trips an `--audit-level=high` gate) — affect the undici 8.x line from 8.0.0 up to 8.12.1 with 8.12.2 the patched version on that line (6.29.1/7.30.1 on the older lines) — dev's red gate traced to its own pre-bump 8.11.2 pin, inside every affected range — and both the npm bulk advisory endpoint and OSV return empty for 8.12.2 and 8.12.3 alike today, so the gate is green with this lockfile either way; the port rides dev's fix regardless and keeps the repo off the affected line permanently. The regenerated lockfile diff is exactly the root range plus the one `node_modules/undici` block (version/resolved/integrity, the hash matching dev's resolved tarball byte-for-byte — no collateral npm-install churn; the local mirror's host leaked into `resolved` once and was normalized back to the repo-wide registry.npmjs.org convention). Engines floor alignment owed by the honest-contract doctrine ("engines mirrors the real floor"): every undici 8.x release declares `engines: >=22.19.0` (registry spot-check 8.0.0 through 8.12.3) while package.json pinned `>=22.18` — out of contract with every 8.x the repo ever locked — so the floor moves: package.json engines `>=22.19` (the lockfile root follows) and every floor statement sweeps with it: README/README.zh-CN/INSTALL/CONTRIBUTING requirement lines, the CI `floor` job pin (22.18.0 → 22.19.0, the job that "proves the documented development floor"), setup-cli's checkNode hard gate and doctor check (a 22.0-22.18 Node must FAIL, not PASS; nvm remediation follows) with the three doctor goldens regenerated (`node scripts/doctor-golden.mjs --regen` after `npm run build` — the one-line Node-gate diff each), sync-skills.mjs's floor comment, the e2e codex driver's floor mention, skills-swap.test.ts's namedExports rationale (the repo's Node 22.19 floor still predates `mock.module` `options.exports` — verified against the v22.19.0 docs, which document only cache/defaultExport/namedExports; migrate when the floor moves past the version where exports exists), and AGENTS.md's two floor paragraphs (the "would run on any 22.x" claim corrected — undici's runtime floor and prepack both start at 22.19 now). Consciously kept as-is: the two "Node >= 22.18 strips types" comments (hooks/huaweicloud-safety.mjs, src/lib/skill-tree.ts) — type stripping is a Node 22.18 capability fact (where the feature landed), not the engines floor; the floor is now the max of that capability (22.18) and undici's declared floor (22.19, uniform across the line). Verified against the new lockfile: `npm ci`, `npm audit --audit-level=high --omit=dev` (exit 0, "found 0 vulnerabilities"), `npm run typecheck`, `npm test` (1427 pass / 0 fail / 2 environment-conditional skips), plus lint / validate / format:check all green.

- fix(review): close the interrogate round on the codex telemetry fix — three findings, all concentrated in the healing/guard rails around the (verified-sound) root-cause fix. (1) The sweep refused to heal an EMPTY stray (`entries.length > 0` made the allowlist vacuous-proof backwards): an empty dir poisons codex's version-dir scan exactly like a full one, is ours by location (the path is scoped to our own marketplace/plugin cache namespace, where codex only ever creates version-named dirs), and is the exact shape a killed prior sweep leaves behind (rmSync deleting entries, then dying before the dir) — requiring non-emptiness made the healing non-convergent, permanently disabled for that cache by its own partial prior run. The conjunct is deleted; `entries.every` is vacuously true for the empty dir, which is the correct semantics. (2) Both warning branches (unrecognized content, unreadable) escalated from consequence-blind yellow lines to state the outage ("codex cannot load the plugin while it exists") and the manual remediation (`rm -rf <path>`) — the install exits green around the poison either way, so the warning was the only signal the user would ever see. (3) The two new installer behaviors and the wiring assumption shipped untested while the in-suite infrastructure to pin them existed: `fakeCodexEnv` now carries a one-shot `conflictOnce` knob (first `marketplace add` answers with the exact 0.162.1 different-source stderr; later calls pass), an agent-install test pins the re-register command sequence (conflict → plugin remove → marketplace remove → retry add → plugin add, identity-bearing calls asserted exactly; the post-install status probe's read-only `plugin list` excluded from the sequence), and a table-driven sweep test pins all three branches (allowlisted → healed; EMPTY → healed, the crash-convergence pin; foreign file → left untouched with the consequence-named warning). The wiring gap — telemetry-plugin-dir.test.ts pinned resolvePluginDir's pure join logic but never the thing that broke (which startDir the bundle implicitly passes) — is closed in mcp-server.test.ts: createClient gains envOverrides (undefined deletes the key), a shared makeCodexCacheLayout fixture builds the codex-cache layout for both the #576 boot and the new telemetry-ON variant, which spawns the REAL built bundle with telemetry enabled, the endpoint pinned to the closed port, and HUAWEICLOUD_DEVKIT_HOME redirected into the fixture, asserting the pair a depth regression flips: stamps (install-counter) land INSIDE the version dir, and the version parent carries no `telemetry` sibling (verified red under a locally re-introduced depth-join resolver, green after restore). The same file's #576 test itself documented why the suite was blind while the bug shipped: its createClient pinned telemetry off.

- fix(installer): `install --target codex` survives a same-name marketplace registered from a different source — codex refuses `plugin marketplace add` with "marketplace 'X' is already added from a different source; remove it before adding this source", which made every npm-cache → local-checkout (or reverse) transition fail at registration (measured live: the npm-installed 2.0.0 blocked re-registering the worktree as the marketplace root). installCodex now detects that error, removes the stale plugin and marketplace registrations (plugin removal best-effort — a plugin never installed under the name must not block the transition; the marketplace remove is the load-bearing step), and retries the add once; the fresh `codex plugin add` then copies the current payload into the cache over whatever survived the removal.

- fix(codex): the devkit MCP server loads again after install — root cause measured live on codex-cli 0.162.1 and confirmed by controlled A/B (same fake cache layout, old vs fixed payload, one initialize handshake each): the esbuild server bundle collapses every inlined module's import.meta.url to the bundle file itself, so `src/telemetry/telemetry.ts`'s depth-based PLUGIN_DIR resolved one level too high in the bundle and `initTelemetry` wrote its stamps (`install-counter` etc.) into the codex plugin cache's version PARENT — a stray `telemetry/` sibling of `2.0.0/`. codex scans that directory for version dirs, resolved the stray as the version (`codex plugin list --json` reports `"version": "telemetry"`), and stopped loading the plugin's manifest and `.mcp.json`: installed+enabled in every devkit-side check, no MCP server in any session after the first (the session whose server boot created the sibling — which is also upstream issue #816's "Codex 插件清单与注册缺失" signature). The same off-by-one existed in `hooks/huaweicloud-safety.py` (`parents[2]` where its rules/policy paths correctly use `parents[1]`). Fix: telemetry.ts resolves the plugin dir by MARKER (dist/ or safety/ directly under it) across all three runtime shapes — tsc tree (`<plugin>/dist/telemetry/`), TypeScript source (`<plugin>/src/telemetry/`), bundle (`<plugin>/dist/`) — exported as `resolvePluginDir`; the py hook aligns to `parents[1]`; `installCodex` sweeps a provably-ours stray telemetry sibling (content allowlist: the stamp and hook-event file names, regular files only — anything unrecognized is left with a warning) from the cache before `codex plugin add`, healing pre-fix installs on reinstall and update (the update path calls installCodex too; the sweep runs after marketplace registration succeeds). Guards: `telemetry-plugin-dir.test.ts` pins the resolver across every shape including the codex-cache layout (the resolved dir is the version dir, never its parent); a structure guard forbids `__dirname`-anchored climbs over one level in src SUBDIR modules (src root modules are exempt — src/ and dist/ are siblings under the plugin root, so an N-up join from a root module resolves identically in both shapes; koocli-version.ts is the standing example); the e2e codex driver's `resolveServerJs` dist-file filter stays as defense and its comment now records the fixed root cause. Residual recorded, not closed here: `codex plugin list` echo and the smoke registration check cannot see this failure class (config echo, not spawn evidence — real-agents.test.ts:464-467's own words), so a codex-side spawn-level roundtrip remains the open verification gap.
- docs(skills): port the 1.1.10/1.1.12 ECS reference wave from main — #935/#964/#971 knowledge (five error rows Ecs.0019/0319/0044/0067/KPS.9004 with the cash-only order-risk-control semantics; the RHEL-family firewalld section with the cloud-init no-SSH recovery path; the SSH auto-diagnosis flow with the real-egress-IP doctrine; the NovaShowJob correction — the job-status operation is `ECS ShowJob`; the large user_data JSON-file path keeping the MCP approval channel; the update-without-rebuild flow; the api_link server-side validation rules) — every ported command dry-run-corrected against the pinned KooCLI 7.3.12 (main's field notes never were: the port_range_min/max v2-era flags, the missing UpdateSubnet required params, the wrong DNS universality claim, the `--id` param, the skeleton filename/lang and tail-strip traps all corrected); the U0-adjusted dual-path wording rides the obs/README surfaces.
- feat(safety): the #971 admin-port remediation now teaches the actionable paths (/32 real-egress-IP rules, cloud-init no-SSH deployment, the ECS diagnosis chain); risk-rule remediations ride the deny reason on every face (the py-hook format mirrored in TS); retrieve_skill's 4000-char reference cap is visible (`[truncated]` marker naming the skillRoot direct-read path, REFERENCE_CAP as the pinned single source).
- docs(skills): the #935 iac stage-5 semantics (pay-per-use risk control checks CASH only; subnet dnsList pre-fix with the corrected UpdateSubnet form) + the voucher 1.1.11/1.1.12 UX rows (real-name-dimension dedup, HDKIT_VOUCHER_NOT_CONFIGURED/EXPIRE_INVALID, OFFICEACE gate, claimed-prefix widening, version 5) + the #935 sandbox traps (0.2.x has no --huaweicloud flag; platform-side STS obsutil-encryption; no systemd) — all structure-guarded in-commit.
- feat(tools): the #935/#971 explain_error wave — four ECS order-failure mappings, the Kps service entry, and the errorCode-only prefix derivation (real MCP calls pass only errorCode); case-insensitive entry matching, apic/apigw/obs aliases, and the U6-review completions (5 dropped tests restored, the vacuous alias assertion re-anchored on mapping text).
- fix(sandbox): the #935 A1/A2 false-success fixes — deploy_nginx's write verification (resolveNginxConfigPath basename sanitation, DB_NGINX existence + nginx -t markers, ok:false + fix_and_retry on any verification failure) and the expose probe retry loop (4 probes with backoff, the LAST probe decides reachability; bounded URL-extraction re-grep; the timeout-fold envelope).
- fix(sandbox): the #953 upload fixes — classifyLocalUploadPath (missing file vs missing parent, the machine-running-the-server hint) and buildUploadResetCommand (remote parent mkdir before the first chunk); the #935 A4 KooCLI 7.2.x update-banner strip, shape-anchored and wired into every consumer face (probe, plan echo, large-output file; the probe's version parse no longer mistakes the banner target for the installed version).
- feat(sandbox): the #997 connection retry — HDKIT_SUB_ACCOUNT_RESTRICTED/HD.83700029 classify as one transient class with [1s,4s,10s] backoff and a non-misleading exhausted error (do NOT switch to the main account); non-JSON 5xx bodies parse via text-then-parse and still retry.
- fix(sandbox): the #1000/#999/#998 tunnel fixes — every _.hwtunnel.com curl carries --noproxy '_' (incl. deploy_check's probe and the keepalive health check, both main misses); the data-disk install doctrine (/workspace survives reboots, ~/.huawei/bin does not — the installer gains -p /workspace/.local/bin, the dedup follows, the persistence table teaches it); the devbridge version gate (0.1.x blocks BEFORE exposing — their AK/SK tier still logs in while their gateway serves a migration placeholder; the noise-safe version read-back names the real cause on no-URL failures).
- feat(obs): the #1003 huaweicloud_obs_set_cors tool (52→53) — AWS4-signed PUT/GET/DELETE /?cors with the p01 HEAD-must-be-included input boundary and the OPTIONS preflight verify hint; obsSignedRequest parameterized by subresource, the shared obsSignedContext preamble; the #992 browser-direct-upload knowledge wave (five BrowserJS SDK traps + the CORS configuration chapter, U0 dual-path wording — 7.3.12 DOES expose the cors subcommand, live-measured); STS credentials now sign the x-amz-security-token header.
- feat(auth): the #954 huaweicloud_check_account_type tool (53→54) — STS GetCallerIdentity + IAM KeystoneListAuthDomains (both read-only) applying the validated username == domainName rule; the STS credential warn rule drops GetCallerIdentity (now a first-class read); the IAM skill trap row, workflow row, MCP-tools row, SELF_VERIFY section, and the quick-ref judgment procedure land with both disproved rules named.
- feat(sandbox): the tunnel-persistence subsystem (54→56) — huaweicloud_sandbox_renew_tunnel (rolling-window renewal; ok = exit 0 AND the absolute expiration — the management-plane-loss trap) + huaweicloud_sandbox_keepalive_watchdog (the 3-layer pattern: host re-attach with the dual-form liveness probe, daily 720h renewal, 5-min --noproxy health check) + expose_tunnel's AUTO-ENROLL contract (expiry_hours 1-720, merge-into-roster, keepalive:false opt-out, failure-is-warning); the PID-gated install verdict; tunnel-persistence.md carries the full doctrine and the four measured traps.
- fix(safety): the ANSI-C keyword-mangling bypass closed (the #927 audit's one real find — $'\x68'cloud executed hcloud while no layer saw the keyword; the obfuscation gate's write-vocabulary clause denies expansion-bearing write-word lines fail-closed, TS + py hook twin); the #927/#928 audit verified 45/45 scenarios covered by v2's rewrite; the pin-gap additions and the checkAccountType orchestrator test land.
- docs(sandbox): the terminal review's one completeness find ported — the full-stack PostgREST knowledge (references/fullstack-postgrest.md, 149 measured lines: PGDG PG16 on HCE with the el8-lib incompatibility and soname shims, the linux-static-aarch64 PostgREST build, the api_user read-only role, the single-origin nginx /api/ proxy) + the SKILL's Full-Stack routing section and the backend-present integration note — it arrived in main's 1.1.12 merge under no issue number and fell through every per-unit checkpoint; structure-guarded.
- chore: the timeout-doctrine divergence recorded — main 1.1.12's blanket 60s→600s test-timeout bumps are not ported (v2 keeps the targeted 240s install-site doctrine with the AGENTS.md-measured rationale); the 13 non-install 60s sites unchanged.
- chore: the #1001 non-port (live 7.3.12 evidence: OBS cors/website are real write subcommands — main measured on 7.2.x) with the deny pinned in both classifier batteries and the evidence comment at the OBSUTIL_WRITES entries; upstream notes recorded for main's shared defects (the banner primitive, the keepalive curl, the STS token signing, the ANSI-C bypass).

- feat(sandbox): port the #919/#922/#946 expose-verify semantics — one exported stripTerminalEscapes (CSI incl. private-mode params, OSC, CRLF) folded into all four sandbox-output parsers; expose_tunnel re-verifies the URL from a second independent exec session (persistent/verifyHttpCode/expiresAt, DB_EXPIRY_HOURS/-e 72, DB_TUNNEL_BODY exact-body gateway-error classification, DB_VERIFY_NOT_FOUND false-success check, 请勿分享 warnings for non-persistent URLs); the guarded setsid/nohup/disown host launch synced across tool, remediation, and skill; deploy_check probes listed tunnels boundedly (head -5, first-reason attribution) and judges reachability by any non-000 code; the `|| echo "000"` sentinel-doubling removed everywhere; quota/migration verdicts field-scoped and count-robust; live evidence: the s2 gateway's real 404 "tunnel not found" body pinned as a fixture (full live expose smoke blocked by devbridge 0.2.2-release's removal of AK/SK login and no available API key — degraded to fixture + pending user live verification).

- feat(auth): the #900 ERROR_TABLE skeleton — a zod-free, IO-free, sibling-free leaf (src/auth/error-table.ts) carrying the 8-code table with executable actions, buildOnboardingSteps absorbing both inline onboarding-step copies, and the five consumers' error surfaces converged (service syncAuth, credential-validator, reconcile, credentials, hcloud-probe with the executable-nextStep/raw-side-channel split); setup-cli's doctor and install banner print the raw guidance alongside the table action; the zod-free structure guard now walks all of src/auth/.

- feat(auth): the D4-24 token contract, CREDENTIAL_EXPIRED UX, and #920 profile purge — approval-token consumption tombstones and returns the precise JSON states (CONFIRM_TOKEN_EXPIRED / already_processed / CONFIRM_TOKEN_NOT_FOUND) with a non-consuming inspectApprovalToken; auth_confirm mirrors the contract and tombstones only after the persist completes (a thrown persist stays retryable); runHcloud fails fast on expired platform-injected STS (code CREDENTIAL_EXPIRED) while auth_status exposes stsExpiry + credentialPanel and explain_error maps the code as primary cause; the stale-token purge lands in ONE shared seam (runHcloudProfileDelete) called by all three KooCLI write paths (auth_switch persist, syncAuth, auth init) with project-id re-application after every purge, the GetCallerIdentity-gated "Credentials synchronized" claim, and the honest hcloud-message warnings on reset/project-id failures.

- feat(install): the agent rules payload ships — injectAgentRules rides copyServerPayload (upfront abort, remove-then-copy + pruneStale convergence, the files allowlist and pack-verify pin the tarball) and every directory-payload target's install test asserts the file; the skill-tracker exports one dual-export object serving OpenCode V1 (server(), verified against the real 1.19.x loader) and V2 (setup(ctx) on ctx.tool.hook with a callable cleanup, verified against @opencode/plugin 2.1.2), load-smoke-tested against the real file (V2 doctrine deviation: only the bash classifier, per the structure-guarded server-data doctrine).

- feat(skills): the 1.1.9 skill-knowledge wave — the #918 mandatory deployment-target question gate on all four surfaces (host-agent question tool with plain-conversation fallback, obs Routing Guard's static-hosting bypass closed, OBS domain + ECS EIP reminders in the options as presented); the #899 OBS Content-Disposition trap (post-2022 GET forced attachment, HEAD misleads, custom-domain+CDN as hard prerequisite, obsutil metadata case trap) with the website-config tool teaching aligned tree-wide and GET-with-headers verification; ECS windows-ssh.md (118 lines), the ssh-keygen passphrase fix (bash -N '', PowerShell --% + -N ""), the flavors AZ-level-wins conflict rule + Ecs.0707; the iac stage-5 balance interception (#922); the sandbox workspace-URL 401 trap + Step 0 Layer 3 + API-Key pre-staging; the voucher HDKIT_COMPETITION_NOT_CONFIGURED row.

- feat(tools): the 1.1.9 toolchain wave — list_operations aggregate fan-out (DMS/DEW -> real sub-services) + BSS identity notes (Customer vs Partner API split correcting the APIGW.0301 misdiagnosis); ~15 service routes gain Chinese intent keywords plus a new ELB route (the matcher lowercases both paths and routes slash-bearing keywords through the phrase path — ak/sk and ci/cd were dead in main's tokenizer); no_proxy CIDR matching (BigInt, IPv4/IPv6 incl. mapped forms, bracket/hex normalization for the URL path); detect_framework's .cjs/.mts configs, deps+src fallback, and main's exact CRA heuristic restored; #921's ok-judgment holes closed (exit-0 parameter errors -> PARAM_ERROR, "successfully" narrowed to OBS without error indicators with a zero-count exemption).

- feat(koocli): pin KooCLI version and align skills with KooCLI 7.3.12 — `kooCliVersion` in package.json is the single source of truth; every pinned download URL in the skills (cli-and-auth's platform matrix, getting-started's install table) now targets cli/7.3.12, and the one-liner `hcloud_install.sh` stays `cli/latest` by design. 7.3.12 was determined the latest release (cli/7.3.13 and cli/7.4.0 return 404 on the OBS bucket; origin/dev's 1.1.10-next line pins the same). All five pinned artifacts verified live with curl -I (linux-amd64/arm64, mac-amd64/arm64, windows-amd64.zip). Declaration re-check: the parameter surfaces of every declaration-bearing skill were diffed `--help`-line-by-line between the live 7.2.12 binary and a freshly downloaded 7.3.12 binary — zero drift across CTS/APIG/KMS/CSMS/WAF (ListCompositeHosts)/AAD (ListInstance)/SMN/Kafka (CreatePostPaidKafkaInstance)/RabbitMQ (ListInstancesDetails)/RocketMQ/CodeArtsDeploy (CreateDeployTaskByTemplate)/CCE (CreateCluster + CreateNodePool)/ECS CreateServers/VPC CreateVpc/RDS/DDS/DCS/GaussDB/GaussDBforopenGauss — re-verified with the skills' actual operation names after the first pass's WAF/AAD/RabbitMQ/Kafka/CodeArtsDeploy artifacts captured USE_ERROR stubs from wrong operation names — and the annotations state exactly that ("parameter surfaces re-checked identical on 7.3.12"). The first verification pass's OBS artifact captured the WRONG command (`OBS --help`, which only emits a flag-parse error, instead of the skill's documented `OBS help`); the corrected diff shows the 7.3.12 obsutil surface is ADDITIVE: new commands `website`, `cors`, `bucket-tagging`, `object-tagging`, `encryption`, `custom-domain`, `check`, `mirror-back-to-source`, public-access-block/policy-status getters, and 20 of the 26 pre-existing commands gained `-bucket-cname`/`-proxy-url`/`-no-proxy-url` (`hash` is local-only, `help`/`version` are metadata, and `download`/`restore`/`update` take cloud-side actions but no proxy/cname flags; the six did not gain them; cp gained `-delete`, chattri gained `-encoding-type` — `-fs` already existed on 7.2.12); the public-access-block family includes put/delete variants, not just getters. The obs/iac skills' "KooCLI lacks website config / CORS not available" rows were updated to teach the 7.3.12 `OBS website`/`OBS cors` commands (XML-file based) alongside the recommended MCP tool. Safety lockstep: the new write-capable obsutil subcommands 7.3.12 ships joined `OBSUTIL_WRITES` in the TS classifier, the Python hook twin, and the plan/read `OBS_WRITE_SUBCOMMANDS` advisory set — the five new subcommand writes (`bucket-tagging`, `object-tagging`, `encryption`, `mirror-back-to-source` via `-method`; `custom-domain` via `-cname`/certificate options) plus the two full-name public-access-block writes (`put-public-access-block`, `delete-public-access-block` — Set/Delete of the bucket's Block-Public-Access configuration; deleting it re-opens public access) — so the pinned binary's new write surface stays behind the approval chain. The read variants of the same families (`get-public-access-block`, `get-bucket-policy-status`, `get-bucket-public-status`, `check` — dispositioned read on the real binary, check compares source/destination objects) stay allowed. Dispositioned on the real binary and pinned across the layers: safety-policy.test.ts (TS arg + raw-text faces, the -method family, the full-name writes, the read controls), hook-parity.test.ts's shared TS↔py battery (deny set + read controls), and hcloud-cli.test.ts pins the plan advisory (OBS_WRITE_SUBCOMMANDS) for all seven names — the sweep also caught PRE-EXISTING unclassified writes alive on both 7.2.12 and 7.3.12 — `abort` (discards in-flight multipart uploads), `archive` (writes log files into OBS), and the live share-authorization family `create-share` (issues capability tokens, the same privilege class as the already-denied `sign`) plus `update` (obsutil's self-update — mutates the installed binary) — now denied on every layer. The TS classifier's obsutil vocab lookup is lowercased to match the py twin (case-variant subcommands like `OBS RM` deny on both layers now, not just py), and the dead pre-rename `share-add`/`share-update`/`share-rm` vocab entries stay as belt-and-braces. Runtime-defect claims keep their version scoping with an explicit "unverified whether 7.3.12 fixes it" note (CCE CreateCluster/CreateNodePool OPENAPI_ERROR, APIG.2011 HTTP-backend, RDS password-pipe workaround) — they fail at API invocation, not in --help, and no write call was made to re-verify them. The AAD console-only create/delete limitation (USE_ERROR Operation not supported) WAS cheaply --help-observable and is re-confirmed identical on 7.3.12 (the skill's AAD limitation block itself states 7.2.12; the USE_ERROR is reproduced identically on both binaries). Live probe: the real 7.3.12 binary passes probeHcloud and runVersionCheck via HCLOUD_BIN (status ok, no version mismatch). Test fixtures follow the pin (fake-hcloud default version, the two fail-config fakes, dep-provision's probeHcloud stubs, validate's example string).

- fix(skills): the load-path teaching becomes action-first — measured failure (operator test, 2026-10-19): a free-choice session called `huaweicloud_retrieve_skill` for an enabled skill with skillRoot already in context, never attempting the read; the model's own reflection named the gap ("did not try read <skillRoot>/huawei-cce/SKILL.md first"). Root cause: the conditional invitation ("When your file tools reach the tree, read directly") invites a pre-action reachability evaluation, and a model evaluating uncertainty resolves it toward the guaranteed MCP loader — knowing every cost (truncation, telemetry, owner-gate) did not change the action. The fix replaces the evaluation step with an imperative sequence: "To load a skill, attempt the direct read first: read <skillRoot>/<name>/SKILL.md and the references/ files you need — Do not pre-check reachability and do not call huaweicloud_retrieve_skill before attempting — the attempt itself is the check." The reactive sentence stays verbatim ("If a direct read of the tree fails or is denied, load the skill with huaweicloud_retrieve_skill instead — it needs no file access"), and the attempt-first policy is honest on every harness: with the installer's permission seam the attempt succeeds silently; on a gating harness the attempt triggers the ask and denial is the signal; on ungated harnesses it just succeeds. The retrieve_skill description is restructured so the demotion leads its load procedure ("the fallback loader, not the default: attempt the direct read first ... do not call this tool before the read is attempted"), closing the same gap for models that never load the routing skill — the tool description is the one teaching surface such a model always sees. Family: both stdio instruction forms (the evaluative conditional is gone — pinned by a doesNotMatch), the retrieve_skill and list_skills descriptions, huaweicloud-core's handoff step and Tool Boundary and fallback bullet, capability-discovery's step 3, both rules-file lines, the doctor command, the hermes manifest, AGENTS.md's disclosure paragraph and load contract, both READMEs + INSTALL (hot-line anchors preserved). Guards: the three-form pin adds the attempt-first imperative, the attempt-is-the-check phrase, and the before-attempt prohibition for both stdio forms (absence on remote), the retrieve-description pin carries the new trigger and the before-attempt prohibition, the per-file presence pins now grep BOTH vocabularies (attempt-first + reactive) across the routing skills, rules, doctor, list_skills description, and hermes manifest (plus a doesNotMatch on the old conditional's signature phrase so intra-file half-drift cannot pass), and mcp-server.test.ts's stdio wire pin asserts the imperative on the real initialize response and the old conditional's absence. Interactions recorded: the five pointer surfaces that recommend skill names (service_catalog, list_packs, pack_info, the listSkills core-refusal error, and the huaweicloud-cli pack description) keep name-pointing wording per the recorded f47414f decision — retrieve_skill remains a valid loader when the user explicitly commands it (instruction-following, pinned by the core-retrieve-skill-guides-cli case), and the cli pack description's bare "Retrieve them with huaweicloud_retrieve_skill" imperative is softened to name the direct-read default alongside the loader; the before-attempt prohibition governs autonomous load policy, not explicit user commands. Review round closed: the hermes manifest's description field and AGENTS.md's disclosure paragraph were caught still carrying the old conditional (intra-file and unguarded drift) and swept with the family; four stale contract comments (mcp-protocol's form block, listSkills's rationale, the dual-path anchor test, the free-choice e2e case) reworded to the new vocabulary.

- fix(review): close the final interrogate round on the seam + teaching pair — the heal test's seed is now the CANONICAL mcp entry the installer writes (dist path + default timeout), so mergeCommandStyle reports unchanged and only permChanged can carry the write: the C1 regression (seam computed after the unchanged short-circuit) now fails the test, verified by re-introducing the regression shape locally (4 red, restored 18/18). Doctor's seam check is per-glob, matching the installer's per-section/per-glob contract: user-owned globs are reported as kept AND missing globs as healable (one user-owned glob no longer masks a missing edit deny), and configs the installer itself refuses to touch (scalar-shaped permission, unparseable file) get a SKIP with the manual pointer instead of a FAIL whose re-run-install remediation can never succeed — all four states test-pinned in doctor-skills-tree.test.ts. The version probe's throwaway root is a per-run mkdtemp (a fixed shared name was clippable on multi-user machines) with best-effort cleanup, and win32 gains an `opencode --version` shell retry for npm-global .cmd shims (spawn cannot execute them without a shell; fixed literal, no interpolation surface — the hasCodexCLI precedent). openCodeSeamGlobs degrades an unusable manifest to the tree listing (devkitOwnedSkillNames) instead of dropping the native globs — uninstall removes the native copies by that same listing, so the cleanup cannot leave per-skill allows behind over deleted directories. The e2e driver imports the seam module's floor check (no hand-rolled copy to drift) and pins its probe spawn's XDG root to a throwaway dir (opencode initializes its config root on every run; the probe must not touch the developer's real one); HUAWEICLOUD_OPENCODE_PERMISSION_SEAM joins hostileProcessEnv and the strip assertions in e2e-env-policy.test.ts (the key landed unpinned). Record corrections: the e2e case comment's false claim that the runner's install writes the seam under the override (env-policy strips it; the natural probe is the only mechanism — comment now states that), the changelog's "READMEs + INSTALL gain the harness permission table" (INSTALL points at the README table and carries the semantics line; the entry now says so), and the "deterministic test/e2e override" phrasing in two places (the override serves the installer test suite only; e2e strips it by design).

- fix(skills): the directory-ask teaching is replaced by the reactive fallback sentence — every surface that carried "ask the user once to approve the whole skills tree directory — never per file; a directory-level approval covers every later read this session" now teaches "If a direct read of the tree fails or is denied, load the skill with huaweicloud_retrieve_skill instead — it needs no file access" (surfaces with an existing otherwise/or-load tail fold the condition into the tail: "...otherwise load it with huaweicloud_retrieve_skill when the direct read fails or is denied"). One trigger vocabulary everywhere — the a60ab5b widened triggers ("cannot reach or are not permitted to read", "out of reach...or reads are not permitted") are rewritten into "fails or is denied", no parallel vocabularies. Root cause of the replacement: the ask had no executing mechanism on the harness that motivated it (the agent cannot choose an approval prompt's granularity; chat-level asks bind nothing), and an interim "permission reaction ladder" rewording ("denied or permission-gated → fall back rather than repeatedly requesting") tested poorly — inferred root: preventive phrasing invites risk-averse models to fall back BEFORE any read fails, regressing the untruncated direct-read default; the reactive sentence fires only after a real failure, structurally unable to cause that failure mode. The landed design pairs this with the installer seam (previous entry): OpenCode gets zero-prompt reads by config, every harness gets the honest reactive teaching. Copy family: both stdio instruction forms, the retrieve_skill and list_skills descriptions, huaweicloud-core's Tool Boundary and fallback bullet, capability-discovery's step 3 (hot-line anchors preserved — "otherwise load" stays within the 20-char window), both load-path lines of the agent rules file, the doctor command, the hermes manifest, AGENTS.md's disclosure paragraph and load contract, both READMEs + INSTALL. Guards re-anchored: the three-form instruction pin and the per-file presence pins now grep the reactive sentence (presence on both stdio forms and — closing the a60ab5b drift window — the list_skills description and the hermes manifest; absence on the remote form), the retrieve-description pin carries the new trigger, and mcp-server.test.ts's stdio wire pin matches the verbatim sentence. The e2e opencode driver's probe enforces opencode >= the seam floor (a loud skip, never a silent no-allow posture), HUAWEICLOUD_OPENCODE_PERMISSION_SEAM joins the e2e env-policy strip list (host state never leaks into case sessions), and the free-choice default-posture case comment now states the honest signal split: the seam's own test file is W1's automated regression signal, the e2e pin is manual corroboration (check the throwaway home's allow rules first when it goes red). READMEs gain the harness permission table (OpenCode row measured on 1.19.0 and handled by the installer; Claude Code / Codex / others rows carry explicit not-verified-here labels — no unverified harness fact is printed flat), and INSTALL points at it while carrying the seam's honest semantics line (allow covers every path-taking tool including bash; edit deny governs only the edit tools).

- feat(installer): persistent OpenCode skills-tree permission seam — `updateOpenCodeConfig` writes `permission.external_directory` allow + `permission.edit` deny for the plugin skills tree and per-skill globs for the six native core meta-skill copies (the shared native dir is never over-granted; user skills there stay untouched). Ownership contract in the new pure module `src/lib/opencode-permission-seam.ts`: add-only-if-absent per section (a pre-existing rule with ANY value is the user's and survives; appended keys win under OpenCode's last-matching-rule semantics over an earlier broader user pattern — deliberate, test-pinned) and value-exact removal (user-modified values survive; sections the seam emptied are pruned). Honest semantics, stated everywhere the seam is described: the allow covers EVERY path-taking tool — bash included, an allowed external directory inherits workspace defaults — so shell-mediated writes to the tree stop asking too, while the edit deny governs only the edit/write/patch tools; mitigations are tree regeneration on every install/update and the PreToolUse hook's hcloud-write deny. The seam is a THIRD change source computed before the unchanged short-circuit: a reinstall with an identical mcp entry and packs value is the dominant update shape and exactly the pre-seam population the write must heal — the old early return skipped it forever (regression-pinned by the heal test); parse-fail stays the only skip, and its WARN now carries the README pointer. Version gate: `opencode --version` probed against the 1.19.0 floor — a knowledge boundary, not a feature boundary (the introducing release is unknown) — with absent/unparsable polarity = skip + README pointer, never a paste snippet (older versions may reject the keys); `HUAWEICLOUD_OPENCODE_PERMISSION_SEAM=on|off` is the deterministic override for the installer test suite (e2e strips it — the runner's install relies on the natural probe); a later update heals the skip. Scalar-shaped `permission` configs (the whole-config string form) are skipped untouched — converting would silently revert the user's global posture (test-pinned). `removeOpenCodeConfig` cleans the seam independently of the mcp entry (a hand-removed entry no longer strands the rules). No receipt, by recorded judgment: two keys over devkit-only globs — any rule on these globs is devkit-domain by construction — and the accepted edge (a user-authored same-shape rule predating the seam is removed with it) is test-pinned as accepted behavior. Doctor gains an OpenCode-scoped seam check (PASS / user-owned SKIP / missing FAIL with reinstall remediation / below-floor SKIP), and the `/huaweicloud-doctor` command delegates to it with the honest-semantics line. Decision record: this option was rejected earlier on the premise that the consent surface should stay the approval prompt — falsified by measurement (the prompt cannot express directory-scope grants, scoping to the touched file's own directory; "always" is session-scoped; chat-level asks bind nothing), and the operator reopened it; the paired teaching change (the reactive fallback sentence replacing the directory-ask clause) lands separately so each commit stays self-consistent.

- feat(skills): teach the one-time directory-level permission ask for pack-skill direct reads — both stdio instruction forms now insert, right after the direct-read invitation, "If reads outside the workspace need approval in your environment, ask the user once to approve the whole skills tree directory — never per file; a directory-level approval covers every later read this session", and the fallback trigger widens to "cannot reach or are not permitted to read" (a permission denial is now an explicit handover to retrieve_skill, which needs no file access). The same clause rides the copy family: huaweicloud-core's Tool Boundary and the retrieve_skill description (both dual-path hot surfaces), capability-discovery's step 3, the agent rules file (both its load-path lines), the doctor command, the hermes manifest, the list_skills description, AGENTS.md's load contract, and both READMEs + INSTALL; the structure guard pins the clause on both stdio forms, its absence on the remote form, the widened fallback phrasing, and — one presence pin per file — the clause on the routing skills, the rules file, and the doctor command (the one-file-at-a-time drift mode the telemetry sweep documented). Decision recorded (superseded two entries up, corrected in place — the claims "one prompt per session is the accepted cost" and "each new session still sees exactly one prompt" measured FALSE on OpenCode 1.19.0: the approval prompt scopes to the touched file's own directory, so prompts recur per skill directory per session, and the directory-level ask this entry shipped has no executing mechanism there; the installer-write option was reopened and landed, and the ask clause was replaced by the reactive fallback sentence): teach-only, by explicit operator choice at the time — the installer did NOT write `permission.external_directory` config even though OpenCode supports a persistent directory-level allow, so the consent surface stays the harness's own approval prompt (a config pre-authorization was proposed and rejected, and the option remained documented for the next maintainer). Residuals (corrected in place): OpenCode's approval "always" is session-scoped AND directory-scoped; a user clicking "once" instead of "always" reintroduces prompts for that session (the agent cannot distinguish the two and simply falls back on denial); the native meta-skill copies directory — later brought into the seam's per-skill globs.

- feat(skills): the load path gains a zero-call home — the stdio MCP server instructions state the skills tree's absolute location at initialize (`instructionsFor` in `src/mcp-protocol.ts`, runtime-resolved from the exported `SKILLS_ROOT`, never baked at build time; the remote form honestly states skillRoot is withheld and teaches catalog + fallback instead, and never names the stdio-only packs_configure). Root cause this closes: free-choice sessions kept jumping straight to `huaweicloud_retrieve_skill` even with the acquisition step taught everywhere, because skillRoot's only home was inside the `huaweicloud_list_skills` payload while retrieve_skill alone fully satisfied the model's goal — teaching text does not change the shortest path, a stated path does. `huaweicloud_list_skills` is re-framed as the effective catalog (which skills are ENABLED is pack-gated and mutable at runtime; a skill absent from it belongs to a trimmed pack — treat as unavailable, confirm before packs_configure), keeping its second load-bearing role beside discovery; `huaweicloud_retrieve_skill` is demoted to fallback-only in its description and its stdio payload now carries skillRoot too (one fallback call heals the path for the rest of the session — the same seam listSkills uses, withheld on the stateless remote). The initialize instructions emission is now observable and guarded: the trace seam records a `disclosure` event `instructions` (initialize results recognized by serverInfo + instructions), the e2e disclosure matcher carries the third event, and two free-choice e2e cases join the suite — default posture (no tool named in the prompt; retrieve_skill must not fire, VPC listing via the fake, instructions emission pinned) and trimmed posture (`installPacks: voucher` — list_skills consulted, no self-enable via packs_configure, zero VPC operations: silently proceeding after a direct read of a trimmed pack's skill file is exactly the failure the case exists to catch). Wire-level content pins ride both faces (stdio initialize states the path and passes the locate-the-tree check; remote initialize states the withholding and never the path), the structure guard pins the two instruction forms plus the retrieve demotion phrases, and the copy family is synced as one (huaweicloud-core's handoff step and Tool Boundary, capability-discovery's chain, the agent rules file, AGENTS.md's disclosure paragraph and mcp-protocol bullet, both READMEs — pack/tool counts corrected to 10/50, the secrets-commit debt this paragraph rewrote — INSTALL, the hermes manifest, the opencode /huaweicloud-doctor command, installer/doctor labels, bin/dsh-postinstall.cjs's labels, and the five telemetry hooks' blind-spot wording — direct reads are observable as catalog calls within telemetry, the instructions emission is trace-file-only, and no channel shows which skill file was consumed). The stdio form's enablement caveat precedes the read invitation and the invitation is conditioned on the skill being enabled (the trimmed-posture chain — direct read → skill teaches hcloud → Bash-face read past the trim — is what the caveat ordering defends); the absence rule is scoped to `huawei-*` service skills on every form and surface, with the six `huaweicloud-*` meta-skills taught as never-in-catalog-yet-always-available (an unscoped rule taught "huaweicloud-core is trimmed" — a dead end no pack can fix, since listSkills excludes core by design and core is force-included); the instructions carry three forms keyed on the same option pair the tool registry keys on (full stdio with the toggle sentence, bare stdio with operator-posture enablement — a face without the toggle is never taught the toggle's name nor a runtime-mutability claim it cannot honor, the six default-construction test files sat in that corner —, and remote); the factory refuses the contradictory remoteSurface+runtimePacks construction outright (a remote with the packs_configure seam would publish the host path through every list_skills/retrieve_skill payload while its instructions claimed withholding — one axis, unrepresentable illegal state, test-pinned); the list_skills description no longer names packs_configure at all (the remote tools/list must not teach a tool that face never registers — a wire test now pins no remote description does); and RELEASING.md's pre-publish list gains the e2e step (E2E_ENABLE plus the gitignored model env — the free-choice cases gate no npm-test lane by policy). The e2e PackId union gains the missing `secrets` member, closing the registry/type disagreement round 1's count fixes left behind. Residuals stated, not fixed here: direct reads bypass the owner gate (mitigated only by the enablement caveat and the remediation texts — the tree ships regardless of enablement, accepted doctrine); packs_configure mid-session does not re-send instructions (initialize happens once — the caveat is why the effective catalog stays a tool call); agents that do not render MCP instructions keep the old posture (native core-skill teaching). The jscpd baseline is regenerated (+5 clones) for the deliberate three-part mirror of the list_skills skillRoot pins in pack-meta-tools.test.ts.

- feat(skills): flip the load-path teaching — direct reads under `skillRoot` are the taught default; `huaweicloud_retrieve_skill` is framed as the fallback (the DEVKIT_PACKS-gated, telemetry-bearing path remote sessions rely on). Rationale: untruncated, selective reads — the repo's own copy already conceded the 4000-char reference cap and the full-payload cost. Every dual-path surface flipped as one family (both tool descriptions, huaweicloud-core's handoff step and Tool Boundary framing, capability-discovery's chain, the agent rules file, AGENTS.md's disclosure paragraph and load contract, both READMEs, INSTALL, the hermes manifest, the doctor command), each keeping the reachability conditional (skillRoot disclosed AND file tools can reach it) so remote sessions, file-restricted setups, and stale binaries degrade safely to the fallback. Decisions recorded: the new default is deliberately not pinned at e2e level (the existing core-retrieve-skill-guides-cli case tests instruction-following on the fallback and stays as-is); the five pointer surfaces that recommend skill names (service_catalog, list_packs, pack_info descriptions, the listSkills core-refusal error, and the huaweicloud-cli pack description) keep their retrieve-only wording deliberately — they point at names, and retrieve_skill remains a valid loader; stdio `skill:retrieve` telemetry going dark on the dominant path is accepted by design (the hooks' blind-spot wording is unchanged). Word-order pins now anchor the two hot lines (read-first, otherwise-fallback), and the agent rules file gains a skillRoot teaching pin.

- feat(secrets): encrypted local secret vault with secret:// ref plumbing — a zero-dependency vault library (src/lib/secret-vault/: refs/custody/store/cli, AES-256-GCM with the ref as AAD, HMAC fingerprint, master key in the OS keychain with a 0600 keyfile fallback, withDepLock-serialized writes, lost-key and mismatch refusals) backs the `secret set/get/list/rm/exec` CLI family (get requires an explicit --stdout/--file destination, exec refuses hcloud children and spawns shell:false) and the new `secrets` MCP pack (huaweicloud_secret_set/list/delete, no value-retrieval tool, withheld from the unauthenticated remote surface alongside the auth/OBS local-writer family); S1 credential values may be secret:// refs resolved through one seam (readGlobalCredentialsStrict) consumed by resolveCredentials, scanState (s1RefError surfaced in status/reconcile/onboarding), syncAuth, auth_switch/auth_init (ref representation preserved in S1 via preserveRefForm while mirrors receive plaintext), sandbox credentials, and the CLI's auth init/reconcile; the Bash-face safety policy was hardened in lockstep (quote/heredoc-aware shell scanner, command-position unwrapping incl. wrappers/redirects/control keywords, secret-exec laundering closure, ANSI-C/backtick obfuscation deny, order-independent reveal pair, credential-file pattern widening with quote/normalization blindness closed, env-dump family scoping, TS/python parity pinned by a shared 90-command battery) — shell-indirection and glob evasions are documented residuals in the safety skill's references/secrets.md; existing installs with a pinned DEVKIT_PACKS get the secrets pack as opt-in (doctor and `packs status` print a one-line INFO announcement, or a WARN when the vault is initialized but the pack is trimmed — `packs enable secrets` to disclose)

- feat(skills): `huaweicloud_list_skills` discloses `skillRoot` — the skills tree's absolute location, stdio sessions only — so a same-machine agent can read `<skillRoot>/<name>/SKILL.md` and `references/` directly with its own file tools (untruncated, selective), while `huaweicloud_retrieve_skill` stays the gated, telemetry-bearing, portable loader (remote sessions and manifest-based agents rely on it; the stateless remote withholds the field, so the list_skills payload on its unauthenticated CORS-* face never carries the host path). `DEVKIT_PACKS` gating is disclosure-level on both fields' terms: catalog entries never reference a trimmed pack's skills, while `skillRoot` discloses the shared tree (every skill, including trimmed packs' and the six core meta-skills) — the doctrine `enable.ts` applies to pack handlers, now stated for skill files. The direct-read teaching rides the funnel's hot lines (huaweicloud-core's handoff step and Tool Boundary, capability-discovery's discovery chain, both tool descriptions, the agent rules file), a structure guard pins the dual-path teaching, and the loading-doctrine copy is synced across every surface that states it (AGENTS/README/README.zh-CN/INSTALL, hermes manifest, doctor command, the five telemetry hooks — the atomcode one drops its native skill-load classification, the prefix-match misattribution branch the other four shed earlier, and their headers and blind-spot wording are now precise: direct reads are observable as catalog calls, never as which skill file was consumed — plus installer/doctor labels and the code comments that claimed "sole skill-loading surface").

- feat(skills): `huaweicloud_list_skills` — a one-call metadata catalog of every enabled non-core pack's skills (name, parsed description, version, owning pack, reference filenames; optional `pack` filter) so agents can browse before paying for `huaweicloud_retrieve_skill`'s full payload; skills of packs trimmed by `DEVKIT_PACKS` are omitted, and the six core meta-skills stay excluded (native disclosure / retrieve_skill territory). Frontmatter parsing (name/description/version) is consolidated into the pure `src/lib/skill-frontmatter.ts` shared by searchDocs, retrieveSkill, and the new catalog: a sequential field walker that never mistakes a key-shaped line inside a quoted description for a field, fixing the multi-line description truncation (huawei-ecs's second paragraph) and the YAML quotes that leaked into every quoted description's value. A structure invariant now requires every source SKILL.md to parse with a non-empty quote-free description, a frontmatter name equal to its directory name, and an absent-or-numeric version; retrieve_skill and search_docs carry consumer-level pins of the fixed shapes.

- fix(review): close the seventh-round gaps — uninstall attribution is dir-gated to the DSH native dir (matching the writer invariant doctor already enforces; a hand-copied package-root receipt anywhere else earns nothing), the postinstall hint gate's discriminating cell (broken package × destination failure) is test-pinned, the uninstall-path young-tmp survival is pinned, and AGENTS.md describes the age-gated sweep contract
- fix(review): close the sixth-round gaps — the postinstall's destination-failure catch returns the real package health (the availability hint never follows a refuse-to-start diagnosis), receipt tmp sweeps are age-gated through one shared sweepReceiptTmpFiles (a concurrent live writer's in-flight tmp is never taken), the marketplace liveness probe is single-sourced as marketplacePayloadTree, doctor honors a package-root receipt only on the dsh row, and the availability hint plus the attribution-path tmp sweep are test-pinned in both directions

- feat(skills): native disclosure for the six core meta-skills — the core routing skills ship as full native copies into the native skill dirs of the eight directory-based agents (receipt-gated convergence, manifest packOf ownership, PAYLOAD_TARGETS-driven sync, DSH postinstall parity); the 24 service skills stay MCP-only so DEVKIT_PACKS gating holds
- feat(doctor): native core-skill freshness checks — per-target content equality against the installed payload, orphan and foreign-dir detection, warn-only diagnostics
- fix(review): harden the native surface after adversarial review — DSH postinstall warn-and-continue on destination failures, doctor survives a missing skills tree and recognizes the DSH package-root layout (no false orphans, payload-manifest roster), receipts are shape-validated and atomically written with corrupt-torn writes treated as managed, uninstall consumes the receipt before destroying it (retired names go), and nativeSkillDirs derives from PAYLOAD_TARGETS instead of a hand list
- fix(review): close the third-round gaps — the receipt becomes one shared module (src/lib/native-receipt.ts, consumed by the postinstall via compiled dist) recording the DSH marketplace layout and package root, so doctor detects real marketplace installs (the bundled patch never carries the CLI-managed markers) and compares freshness against the profile's actual package with an honest remediation; the shape-broken corrupt boundary, foreign-dir delete rights, uninstall corrupt-receipt leftovers, and the some()-masked broken payload are fixed and pinned; the version-skew test now discriminates
- fix(review): close the fifth-round gaps — uninstall attribution is liveness-gated (a dead marketplace maintainer's copies are residue and go; npm uninstall of the profile package runs nothing devkit-side), the doctor hedge keys on resolvability (layout-less AND root-less marketplace receipts) and is scoped to the dsh row, the corrupt-receipt warning on the DSH dir names both remediations, packageRoot control characters are stripped at read in the shared module, writeNativeReceipt sweeps crashed predecessors' tmp files, and the postinstall gates its availability hint on package health
- fix(review): close the fourth-round gaps — uninstall honors the receipt's maintainer attribution (marketplace-owned copies and receipt stay, with the package-removal hint), the postinstall loads the shared dist libs via dynamic import() (no require(esm) Node-version dependency, honest load-failure diagnostics), doctor hedges layout-less receipts instead of prescribing the layout-converting fix and stays silent in the orphan branch when the receipt is corrupt, packageRoot is validated absolute and control-character-stripped when echoed, uninstall sweeps orphaned receipt tmp files, and pack:verify pins the postinstall and its dist/lib dependencies in the tarball

## 1.1.7 (2026-09-24)

- chore: merge dev into main for 1.1.7 release (#812)
- chore(release): 1.1.6 (#796)
- style: prettier normalize plugin manifests
- chore(release): 1.1.6
- chore(release): 1.1.5
- chore: sync README beta badge to v1.1.5
- chore: version override for 1.1.5 stable release
- chore(release): 1.1.4
- chore(release): 1.1.3 (#620)
- chore: advance main to 1.1.3-next.4 (business keeps dev; prepare stable 1.1.3) (#619)
- test(update-check): decouple upgrade-tag logic from repo package.json version
- chore(release): 1.1.2
- test: resolve structure.test.mjs to dev version (union-merge artifact)
- chore(release): 1.1.1 (#515)
- chore: merge dev into main for 1.1.1 stable release (#513)
- chore: add dsh.bundle manifest for DSH plugin ecosystem
- chore(release): 1.1.0 (#440)
- chore: merge dev into main for 1.1.0 release (#438)
- chore: version override for 1.1.0 stable release (#433)
- docs: add Huawei Cloud npm mirror recommendation for China users
- chore(release): 1.0.2
- style: prettier format fix
- feat: v1.0.2 stable - merge all dev changes
- fix(release): update release trigger to workflow_dispatch and main push only
- feat(release): sync release workflow to main, seed manifest with 1.0.1
- fix(release): retire the live Publish Dev workflow on main
- fix(release): restore full publish flow with quoted step names
- fix(release): probe publish job with environment only
- fix(release): probe without job outputs and needs.outputs wiring
- fix(release): restore full tag-gated publish logic
- fix(release): reduce npm-publish workflow to minimal probe
- fix(release): drop workflow_dispatch inputs, derive dist-tag from the tag version
- fix(release): rename publish workflow to npm-publish to recover a fresh workflow_dispatch index
- fix(release): add pack-verify script to main
- fix(release): sync ci.yml with pack verification to main
- fix(release): add tag-gated Publish workflow to main so workflow_dispatch works from tags

## 1.1.7-next.1 (2026-09-23)

- style(sandbox): split devbridge login/status chain for clearer diagnostics
- feat(sandbox): probe devbridge auth capability instead of assuming from version
- style: prettier normalize plugin manifests
- chore(release): 1.1.7-next.0 (advance dev prerelease line)

## Unreleased

- fix(packs): 第三轮实现检视四组修正——`callOpenMcpTool` 信封新增 `forwarded: true`（仅三个往返完成分支携带，catch 不带：超时/中途子死/spawn 失败都不是转发完成；JSON-RPC 错误答复如 Unknown tool 也保守归入 catch，对 eval 的词汇表内任务不可达），eval 的 `reached` 判据改读该字段（上一修正波的 `final.tool` 判据被三评审独立证伪——catch 无条件带 `tool`，60 秒超时与中途死亡被误计 reached，注释声称的不变量为假；首次 spawn 失败不带 `tool` 恰是 handler 预 await 的巧合分层而非信封性质）；新增 `forwarded marks completed round trips and nothing else` 回归测试钉全部四形态（成功/isError/信封失败带 forwarded，超时不带），夹具新增 `FAKE_SLOW_MS` 旋钮（延迟 tools/call 应答使短超时落入 request 计时器——tools/call 分支提取为 handleToolsCall 纯搬迁）；守卫片段延伸钉住 `include_sops`（`get_product (product; optional include_sops` 与 `list_apis` 全参数片段——该参数上轮恢复但无钉，再删一次仍全绿），`huawei-openapi` 技能的 list_apis/get_product 行补 include_sops 教学（两个教学面不再分叉），片段名提取改 `split(' ')[0]`；计数注释清扫补完上波遗漏（tools.ts "35 non-core"、registry.ts "35 pack-owned"、mcp-protocol.ts "11 tools"、plugins-e2e "all 46"、structure.test "33 total" 全部改派生表述）并修 `integrations/hermes/manifest.yaml` 的实际错误数字（"42 tools" 是其写作当年的数，该 manifest 的 stdio server 注册全部工具）；CHANGELOG 措辞对齐（上波"根治"过宣，实为列举范围内的清扫）
- fix(packs): 面收敛实现检视（三模型对抗评审）五组修正——服务侧 `gateway_call` 描述补 `include_sops`（get_product / list_apis 各一，原吸收时遗漏，该参数一度全 devkit 表面无处可学）；描述守卫从技能教学测试挪出为独立命名测试并改钉字面片段加整句 `Discovery chain: search_apis → list_apis → get_api → get_api_examples`（旧 `includes('get_api')` 被 `get_api_examples` 子串满足、`indexOf` 链序落进同一子串），片段名集与词汇表 deepEqual 防名字漂移；eval 脚本 `reached` 判据修正、`needsDiscovery` 死概念注释改写、`/home/cheney` 个人路径兜底改 `homedir()`；round-10 历史注释还原当年的 `huaweicloud_search_apis` 死名例证；计数注释改派生表述（七个 pack 的 `all 51 tools`、tool-schemas 八处 `all 46`、hermes-windows 的 `All 35 tools`）
- test(proxy): 网络类测试对环境代理密闭化——`hdkitRequest` 每次请求先问 `getProxyDispatcher`,解析器读双拼写（`HTTPS_PROXY || https_proxy`）加 proxy.json;环境有小写代理变量（curl 惯例；这些 https 目标实际由 `https_proxy` 分流）时 undici 分支绕开被桩的 `global.fetch`,六个测试在配代理的开发机上红而干净 CI 上绿（假绿）。proxy-agent 测试的环境帮助函数改为清理全部六种拼写、新增仅小写与仅大写两个单拼写钉测试（镜像堵住两种回归）；hdkitservice 测试文件级建立无代理前提（双拼写 env + 临时 `HUAWEICLOUD_HOME` 阻断 proxy.json 泄漏）。实测小写代理变量在场时全套件绿
- refactor(packs): open-mcp 六个只读专属面（`huaweicloud_search_apis` / `list_products` / `get_product` / `list_apis` / `get_api` / `get_api_examples`）删除，全部网关工具统一走 `huaweicloud_gateway_call`——`classify()` 成为 tools/call 的唯一咽喉（此前六个面绕过审批地板表，未来给只读名加底线会静默漏掉六个入口），披露面 9→3，工具总数 52→46。服务侧 `gateway_call` 描述吸收发现链（六个 readonly 名、search_apis → list_apis → get_api 链序、逐工具参数形状，pack 副本与 `src/tools.ts` TOOL_DEFINITIONS_LITERALS 副本字节一致），成为 tools/list 层唯一的零成本名字发现路径；`structure.test.ts` 新守卫断言描述必含全部 readonly 名与链序（eval 脚本的 +1 是声明常量，量不出描述内容，守卫才是真验证）。破坏性变更：已安装插件的 agent 需重装/重启会话才能看到新工具面；旧名调用得到 Unknown tool 报错，迁移方式是改用 `huaweicloud_gateway_call` 携 `tool: search_apis` 等网关名。`huawei-openapi` 技能 Discovery Chain 重写为 gateway_call 形态（保留全部 10 个词汇表名与 params 契约行，教学守卫继续钉住），capability-discovery 第 4 步同步改写。`scripts/eval-generic-face.mjs` 改写为单面度量（原通用对一等的比较前提随删除消失，原脚本直调已删名必然崩溃；+1 上界仪器保留）。参数校验路径变化：发现工具的非法参数从 devkit zod 英文错误（零 spawn）变为网关 pydantic 错误（花一次 spawn），与四个 routed 工具的委托哲学一致。`gatewayInt` 死常量随 schema 一并删除；README 双语、AGENTS.md、tool-schemas.ts 注释计数全部同步（52→46、41→35、9→3）
- refactor(packs): open-mcp 授权全面委托网关 policy engine（spec: `docs/open-mcp-approval-delegation-design.md`，三模型对抗评审 + 探针实测定案）——token 仪式从 gateway 面退役：once-grant 桥全套（bridgeLocks/bridgeExecuteApi/forwardWithOnceGrant 的锁与即焚计数）、mint/echo/consume/args-match 仪式、devkit 模式 pre-spend 守卫（identity/matchingDenyRule/sameLineRuleExists）、boundArgs 规范化、sidecar surface cache 集群（gatewaySurface/fetchGatewaySurface/refreshSurfaceOnUnknownTool）、`src/lib/policy-grammar.ts` 及 lockstep 语料全部删除；`HUAWEICLOUD_OPENMCP_APPROVAL` 退役为 fail-fast 迁移指引（设值即报错指向 operator policy 文件，DEVKIT_PACKS 未知 id 先例）；`classify` 坍缩为 `{deny, forward}` 地板表。保留地板补两条形状规则：F1 拼写严格（action/scope 原值必须等于 trim+lowercase，接替被删的规范化——round-5 实测 verbatim `' ONCE '` 授权永不即焚，该实测为 pre-a4 构建，2026-10-11 复测 v0.2.0a4 在 add 即拒非规范 scope（未知 scope 回显原拼写），地板独立于网关侧校验保持 fail-closed）、F2 ttl_seconds 拒绝（探针实测网关仅 temporary 接受 ttl，ephemeral 拼写下可拉长授权寿命）。探针实测（真实网关 v0.2.0a4，2026-10-10）：空 policy 文件下 execute_api 默认拒绝且拒绝 reason 自带同意教学（对话确认 → manage_policy 授予，api/api_session/product/readonly 预设、line 支持数组批量）；permanent add 网关直接接受并写入 operator policy 文件（devkit 永久地板是唯一屏障）；data tools 网关侧完全无 policy 门（地板即全部门）；秘密名 API 带 allow 规则越过 policy 层（devkit 秘密地板是唯一屏障）。接受风险记录于 docs/safety-model.md：manage_policy 的 overlay 遮蔽与跨层 remove、保护树与凭证模式外的本机读写、坏 policy 文件网关侧静默惰性。净删约千行（委托重构波至 6ba0f6c：14 文件 +675/-1655；文档对齐与检视修正波另计）；open-mcp 测试 58→45 全绿（检视修正波另 +1），新增地板矩阵九行、首调委托、零 spawn 地板拒绝、退役守卫、裁剪姿态反转（operator policy 文件为控制面）、schema 形状（approvalToken/approvedByUser 缺席）断言；SKILL.md 教学重写为委托同意流（拒绝 reason 即指引）。CLI 面 plan-run token 契约不动。检视修正波：退役守卫测试由死断言转为活断言（assert.throws 携设值 env，路径缺席即红）、remove 地板补 ttl_seconds 拒绝（与 add 分支对称）、fake 夹具按删除清单清扫死旋钮并改精确字符串语义（scope 词表校验、非规范拼写 add 即拒、仅规范 'once' 即焚）、新增文件层控制面测试（operator policy 文件规则授权 + 跨层 remove 回写文件，AR1 钉为具体行为）、approvals.json 路径与修剪时点的文档修正。第二三轮对抗评审修正波：夹具 once 即焚改按命中索引移除（回归测试改三规则中位执行，splice(-1)/splice(0)/indexOf 副本三种错误形状各失败一条断言，突变验证逐形确认）；夹具 remove 补 ttl_seconds 拒绝；list 改 overlay 先于文件层、add/remove 成功信封回显 policy 原文（回归钉顺序与回显：rules[0] 为 overlay 规则、注释行随 add 回显、跨层移除后规则自 policy 文本缺席）；execute_api 拒绝 reason 补齐探针实测的同意教学长尾（api/api_session/product/readonly 预设）并钉住两条尾专属子串；F1 拼写地板语义在全部存活表面按 v0.2.0a4 重述（夹具与测试注释的 pre-a4 '永不即焚授权' 叙述清扫）；探针引用从已删除的临时报告改指仓库内可重跑的 scripts/probe-openmcp-gateway.mjs（自打印经 shebang 解释器解析出的网关版本）
- fix(deps): 第十一轮检视锁修复的三项深化——rename 仲裁改自验证（评审活体复现：停顿 contender 的 rename 落在赢方 mkdir 之后对活锁成功，291ms 双持有静默退出——裸 rename 只收窄未关闭，6/6 绿与三倍收窄的概率相容。现 rename 成功后从 stash 内重读 pid，非同死者即被窃的活锁，rename 回去等待；新增停顿注入测试确定性复现该交错并断言不双持有）；releaseLock 同型 TOCTOU 修复（read-then-rmSync 的释放路径与接管路径同病——楔死持有者在接管后释放可删新持有者的锁，现释放同样走 rename-验证-删，stash pid 非本进程即还原）；stash 清扫（rename 与 rm 间崩溃泄漏 `*.takeover`/`*.release` 目录，acquire 入口 best-effort 清扫回收）。设计块与测试头的两处谎言注释改真（"机制未解释"与"结构性消除竞态类"均已过时——如实陈述缩窄历史与自验证原语）
- fix(packs): 第十一轮检视 lockstep 契约的三项强化——fixture 的 `semanticKeyOf` 升级为与 lib 同前缀的完整 kind 键（`empty:/unparseable:/server:` 加 rule 形态），lockstep 断言从等价类比较改为逐行键相等（评审实证：类比较对"lib 解析为 rule 而 fixture 返回 null"的单例分歧失明，server 行漂移全对通过）；语料补六形态（多等号钉 rpartition、api 内冒号钉首冒号分割、空 product、大写 SERVER 前缀钉大小写敏感、前导空格）加 matcher 表补 round-8 bug 形态（未终止类、类内反斜杠、首 `]`/`^` 字面）；execute 匹配路由进共享语义面（旧 inline 副本效果失明——deny 行可授权 execute——且无 per-side trim；`matchingRule` 改 first-match-wins 返回 grants 判定，`parseKey` 副本删除改用 semanticKeyOf 前缀判定；新增 deny 行拒绝加 spaced 行授权的网关语义钉）
- refactor(packs): 网关策略语法核心抽至 `src/lib/policy-grammar.ts`（parseRuleLine 判别式解析、fnmatchRegex 类翻译、productMatches 精确或 `*`、sideMatches、ruleSemanticKey——approval.ts 改导入加 re-export，pack-boundaries 守卫通过，零依赖 lib 模块），fixture 的 .mjs 镜像获得可执行的 lockstep 契约：`FAKE_GRAMMAR_ONLY=1` 环境下 fixture 只导出语法面不启动 stdio 服务，structure.test 以共享语料（18 行含空格/大小写/fnmatch 否定类/行内注释/脱敏形态）驱动两侧实现，断言语义键等价类与匹配器接受/拒绝逐对一致——镜像漂移即红，"verbatim copy" 从注释声明变为断言（七至十轮检视反复点名的第四五份副本收口）
- fix(deps): dep-receipts 锁的接管移除改为原子仲裁，四轮全量反复出现的 flake 根治——两个 contender 对同一死锁同时通过复读校验后，`rmSync` 是可竞态的：较慢的 rm 删掉较快方的新锁（rmSync 从不校验内容），双双持有临界区，tmpfs 与负载下约 30% 复现而隔离 ext4 干净，机制此前未解释。修复：死锁目录先 `renameSync` 到每进程唯一路径再清理——rename 原子且输方 EEXIST/ENOENT 失败回退等待，赢方下一次 mkdir 独占获得。修复后干净树 6/6 全绿、与重型安装测试并发跑全绿、消费方（dep-provision/doctor）回归零败
- fix(packs): 批三第一刀实现检视（第十轮 interrogator）六项修复——教学守卫反转为非循环方向（原正则手工枚举 10 名字再查表内——手写清单查手写清单，且 `_` 是词字符使 `\b` 失配 `huaweicloud_search_apis` 内部，实测四个发现名从未被检查、拼错名直接通过——现正向断言词表每名必被教授（裸或带前缀）加反向清扫（snake_case token 剥可选前缀后须在词表或 devkit 工具定义内））；params 哨兵 `[^.]` 改词边界（句尾与点后可逃逸实证）；params 行限定 `For execute_api`（发现工具参数是顶层命名的，harness 自己就顶层调 search_apis——无限定行误导 search 调用）；跨引用解析器泛化（`(?:[Ss]ee|load)` 遍历全部 skills 树——本 commit 加的 capability-discovery 引用用小写 `see` 恰好躲开原守卫，实证）；format 环结构闭合（renderGenerated 直接产出 prettier 沉降形态——原裸插入产物 format:check 拒收，每次 sync 不带 format 精确重演批三的 51 文件 CI 红；stripMarkerLine 双向容忍既有测试证明安全；渲染形态进 packs-sync.test 断言；validate 串接 sync --check）；评测 harness 五合一修正（discovery 改声明式字段并建模为每会话一次——原按 task.id 字符串耦合且逐任务列表使会话总数虚报 2 实为 1；`huaweicloud_gateway_call` 的工具描述本身列全四个路由名、读 tools/list 是每个 agent 的必经之路，+1 只界定既不读 skill 也不读描述的 agent 上界，输出如实框定两条零成本路径；generic-read 的 first-class 列改直调 curated 工具；Windows 路径 fileURLToPath；ms 列标注 warm 与顺序偏差，调用数为决策指标）。修正后实测：读任务零开销、首个状态改变任务 +1 后续复用 +0、会话 discovery 计数 1、行内合计等于会话总数
- fix(packs): 批三第一刀实现检视（第九轮 interrogate）九项修复——`huawei-openapi` skill 的 params 陷阱行改教真实嵌套（网关 docstring 契约：路径/query 平铺进 `toolArgs.params`、body 在 `toolArgs.params.body`——平铺顶层的散键被网关静默吞掉，探针实证 `limit: 1` 平铺被忽略照常执行，必填路径参数迟到失败发生在 token 已烧之后）；permanent 教学恢复 operator 框定（"an operator gesture, not an agent action — ask the operator"，拒绝信封的措辞，skill 不再读成绕自家审批面的 how-to）；死端 cross-reference 修复（`huawei-cli-and-auth` 缺前缀改名、safety 引用删除因其不含 token 模型）加 `version: 1`；意图路由补 openapi 行（serviceCatalog 此前无行，三个 start-here 面都不感知该 skill），capability-discovery 把 API 契约意图先送目录工具再 web 兜底；评测 harness 记账修正（Mode B 的 steps 死条件让 token 往返只记在 A 侧，实测 +2 而文档记 +1——现两侧同计 token 往返，差值只剩名字发现调用 +1；读任务产出实测行而非跳过断言；缺网关二进制硬失败退出 1，缺席不再产出伪绿表格；unskilled-agent 框定在输出中点名，加载 skill 的 agent 零开销）；structure.test 新守卫把教学面机械化钉住（skill 提到的网关工具名必须存在于 GATEWAY_TOOL_VOCABULARY、params 契约断言进 skill 文本、cross-reference 必须解析到真实 skill——错误的 params 行正是从这个守卫缺位溜过），漂移门测试改迭代表；`npm run format` 修复批三 sync 漏跑 format 留下的 51 文件 CI 红（AGENTS.md 提交规则的两条跳过各自产出真实缺陷：守卫缺位放过错误教学、format 缺位破了 CI 绿基线）
- feat(packs): open-mcp 教学层与词表单表化（批三第一刀）——新 service skill `huawei-openapi`（open-mcp pack 首个 skill，源在 pack skills/ 树经 sync-skills 生成进运行树）：四步发现链（search_apis → list_apis → get_api → get_api_examples）对应 CLI 发现链的 MCP 形态、泛型调用面的同意流教学（只读直通 / token 往返 / 三类硬拒及理由信封自解释）、两种审批模式的语义翻译（native 的 scope 标签按进程级如实披露）、五条陷阱表（region 缺省 cn-north-4、project_id 路径、params 平铺 body 入 `toolArgs.body`、x-constraint 前置条件、data 工具非只读）；`huaweicloud-api-and-sdk` 增 cross-reference 双向非死端；`huaweicloud-open-mcp/pack.ts` 声明 skill 归属（skills 数组从空到一，pack-info 披露生效）。词表收敛：`GATEWAY_TOOL_VOCABULARY` 单表（readonly + routed 两组）成为网关工具名的唯一枚举，classify 的 READONLY 集与 tools.ts 的 KNOWN_GATEWAY_TOOLS 投影全部从它派生——加一个网关工具从改三处清单变为改一行表项加一条 classify 行（七/八轮检视的 Consider 收口）。新增 `scripts/eval-generic-face.mjs`：泛型面对一等工具下界的对照评测 harness（真实 callTool 分发加真实网关二进制，openapi,data 模式），测量每任务的调用数与耗时差——首次实测：纯读任务零开销，token 类任务每任务 +1 次发现调用（token 往返为两种面共享的同意属性不计入差值），动态注册（Layer 3）按设计裁决维持 deferred 直至 agent 级评测示显著
- fix(packs): open-mcp 批二实现检视（第八轮 interrogate）六项修复——fnmatch 类翻译补否定语义（`[!A]` 此前直通为 JS 正向类，Python 对照双向皆错实证：网关拒绝对预检隐形、overlay allow 穿透文件 deny 完成逃逸；`[^a]` 反向过拒；类内 `\` 直通产生未终止 JS 类使 `new RegExp` 抛出且调用处无守卫——现按 `fnmatch.translate` 规则翻译（`[!`→`[^`、类首 `]`/`^` 字面、`\` 转义、未终止 `[` 字面），整体包 try/catch 字面兜底）；`parseRuleLine` 改判别式结果（`rule|server|unparseable|null`），无效 action 不再折叠为共享通配哨兵——`ruleSemanticKey` 对 unparseable 行映射 `unparseable:<lowered line>` 每行唯一（此前所有被脱敏弄乱的行共享一个 key，不同 token 后缀规则互相假冲突且补救死循环，端到端实证：文件里 `IAM:CreateAccessKey=allow` 让 `IAM:DeleteAccessKey` 的批准执行被拒、remove 返回未命中）；解析忠实化（`python3` 直跑安装模块实证：行内 `#` 注释与无冒号非 `*` 目标网关侧均 `RAISE`——现仅剥整行注释、无冒号非 `*` 判 unparseable；identity 校验集加 `#` 使授权行在自家解析器下恒可解析）；remove 加 scope 在 classify 即拒（网关 `manage_policy_ops` 对带 scope 的 remove 直接拒绝，token 门后的转发必然烧批准——实测源码对照）；`matchingDenyRule` 返回判别式 `{line, unparseable}`，坏行消息如实报"网关自身无法载入该行"而非伪装操作者 deny；产品侧匹配改精确或 `*`（网关 `evaluate` 仅 api 走 fnmatch，产品侧精确小写等值——比 fnmatch 更忠实）；canonicalize 数组分支入递归路径集（自引用数组此前绕过 seen-set 无限递归 RangeError，违反模块自身"只哈希不拒绝"契约）。fake 全面对齐：fnmatch 翻译逐字复制 `approval.ts`（注释交叉引用，.mjs 无法 import .ts）、add/remove 镜像网关解析拒绝与信封（未命中/格式非法 ok:false、scoped remove 拒绝）、`FAKE_POLICY_TEXT_ONLY` 旋钮（数组减为 overlay-only 使文件层测试真正钉住 policy 文本分支——真网关两层都报，旋钮是显式分支覆盖仪器）；文件层测试补 mkdir 修顺序依赖；三处错误的双层模型注释改为真模型（`list_rules` 数组含文件规则 scope permanent 加 policy 文本含原文）。真实网关探针 6/6：否定类两方向、坏行消息、交叉冲突关闭同冲突保留、remove+scope 分类即拒
- fix(packs): open-mcp 批二实现检视（第七轮 interrogate）五项修复加一项探针发现——网关语义忠实化：新增共享行解析器 `parseRuleLine`（镜像网关 `parse_policy`/`_rule_key` 源码语义：剥整行注释、trim、rpartition `=`、action 归一、target 冒号分割、两侧 strip-or-`*`），`sameLineRuleExists` 从字面比较改为语义键比较（实测网关 remove 按语义键首匹配——空格/大小写变体的操作者规则此前绕过冲突预检而桥的清理仍会删它），同时读 list 的两层暴露（结构化 `rules` 数组与 `policy` 文本字段——探针实测真实网关文件层规则只出现在后者，仅读数组整个文件层漏检），返回三态 `no-conflict|conflict|listing-failed:<reason>`（listing 失败不再伪装成 "already exists" 把 agent 引向删除不存在的规则）；`sideMatches` 升级 fnmatch 语义（网关用 `fnmatch.fnmatch`，`?` 与 `[...]` 是元字符——操作者 `ECS:Create?ervers=deny` 此前对预检不可见而网关执行它，`?`→`.`、字符类直译）；action 与 scope 同入 mint 规范化绑定（classify 归一 action 但 token 绑原始拼写转发原始，`'ADD'` 过门即烧 token 于网关拒收——boundArgs 现同归一两者，fake 回显 `received` 原始值断言非环形）；`redactString` AK/SK 加词边界（`task:`/`risk:`/`disk:` 的值被吃实证）加 `isSecretKeyName` 补 `input_value`（对象走查与字符串走查口径一致化）；canonicalize seen-set 改递归路径集（DAG 别名引用此前折叠为 null 造成哈希碰撞——`{a:X,b:X}` 与 `{a:X,b:null}` 同哈希，现路径进出删除，仅真环折叠，MCP JSON 无别名仅直连可触发）。fake 的 remove 语义化镜像网关跨层序（overlay 先文件后）加文件层支持（`FAKE_POLICY_FILE`/argv `--policy`），list 双层暴露，execute 评估 overlay 加文件并集。真实网关探针 5/5：空格操作者行语义冲突（拒绝→清文件→同 token 桥接 status=200）、fnmatch `?` deny 预检执行、`ADD`/`Once` 规范落地、未执行授权正确留存。行内注释澄清：网关只认整行注释，devkit 剥行内注释是故意的过度拒绝方向
- fix(packs): open-mcp 批二实现检视（第六轮 interrogate）五项修复——`sameLineRuleExists` 双侧过同一脱敏通道（list 结果经 `redactString` 后 `IAM:CreateToken=allow` 以 `…=<redacted>` 形态到达比较，单侧原始比较对整个 IAM token/password 类静默失效，端到端实证危害链：冲突漏检 → 桥旁跑 → execute 匹配既有规则不焚 → finally 删错授权留自己的——现本地行与返回行互经 `redactSecrets` 配对比较任一方向命中，listing 失败按冲突 fail-closed 拒绝）；manage_policy 动作词表白名单化（`'ADD'`/`' add '`/`['add']`/`append` 此前落入 token 放行，scope 门因此依赖网关拼写更严——现 trim+小写归一后仅 `list/add/remove` 进分支，未知动作与非字符串 deny）；`redactString` 授权头家族值捕获扩至行尾（`Authorization: Bearer <jwt>` 只红 `Bearer` 凭证本体过界，实证）加 AK/SK 引号键变体；路径扫描候选加反折叠变体（值本身是 JSON 字符串时分隔符在内存中翻倍，`read_json('{"path":"C:\\\\hcloud\\\\config"}')` 绕过单分隔符模式，实证——`replace(/\\\\/g,'\\')` 变体同时送检）；replay 侧同样先规范化 scope 再哈希再转发（mint 绑规范值而 replay 哈希原始拼写的单侧规范化让 note 教的"重发原始参数"必然失配烧 token——现两侧同为规范值，`' ONCE '` mint `'Once'` replay 直接成功，note 同步更新）。附一并项：canonicalize 加 seen-set（循环输入过 classify 后在 mint 层爆栈的不变量补全）、删引号字面量提取死重（整值候选是其超集，子串模式判定被整值包含，A 实证删除不改变任何判定）。fake 无改动需求。真实网关探针 9/9：token 后缀行经脱敏边界仍见冲突（拒绝 → 移除 → 同 token 过冲突门）、未知动作 deny、任一拼写 replay 成功、JSON 嵌套翻倍分隔符 deny、未执行授权正确留存
- fix(packs): open-mcp 批二实现检视（第五轮 interrogate）五项修复加一项探针发现——`canonicalize` 改 null 原型目标构造（`sorted['__proto__']=v` 在普通对象上触发原型 setter，键从自有属性与哈希中静默消失，批准形态与走私 `__proto__` 的重放哈希相同，实测复现；两 face 共享修复）；`redactString` 增引号键变体（`"adminPass":"..."` JSON 形态与 pydantic `input_value=` 回显形态此前漏网）加 `input_value` 键，isError 文本先 JSON.parse 成功则走对象脱敏（键名遍历强于任何字符串模式）；manage_policy 的 scope 规范化绑定（classify 判 `ONCE` 过门但转发原样拼写，网关存储后即焚语义永不匹配，实测 `' ONCE '` 授权执行一次后仍存活——现 mint 前重写 toolArgs.scope 为规范值，token 绑定规范化形态，原拼写重放自然失配），非字符串 scope 一律 deny（`['once']` 字符串化骗不过）；桥前同行冲突预检（`manage_policy remove` 按行首匹配，同行既有授权时桥的 finally 会删掉它留下自己的——现 `sameLineRuleExists` 经实时 list 检查，冲突即拒绝且不烧 token，教学错误指引先移除冲突规则；探针实测真实网关 list 返回结构化 `{line,scope}` 对象数组，bare-string 比较静默失效，已兼容双形态并让 fake 对齐真实 list 形状）；数据工具路径扫描重写（原始值递归遍历取代 JSON.stringify——序列化反斜杠翻倍使 Windows 无点路径 `C:\hcloud\config` 绕过凭证模式，实测；整值加引号内字面量须含路径分隔符才算路径形态，`.hcloud` 的纯文字提及不再误拒；seen-set 使循环结构终止而非抛错，classify 只裁决不 reject）。fake 增 attempt 计数器（双拒绝测试断言 `attempt 2` 证明重试发生、`attempt 1` 证明未知执行态不重发）与 `FAKE_BROKEN_EXECUTE`、`json_error_tool`。真实网关探针 9/9：scope 规范化绑定全链路、同行冲突拒绝加不烧 token 加清理后同 token 桥接 status=200、Windows 路径拒、无分隔符提及不误拒、零残留规则
- fix(packs): open-mcp 批二实现检视（第四轮 interrogate）七项加固——`manage_policy add` 的 scope 判定反转为规范化白名单（trim 加小写后仅 `once/session/temporary` 过 token，缺省与一切未知/持久拼写 deny；实测 `'PERMANENT'` 曾一次 token 买到永不即焚授权，remove 因网关侧忽略 scope 保持 token 绑规则原文）；`execute_api` 桥重试触发收窄到 `/safety policy/`（超时与 sidecar 死亡的执行态未知，一次批准不得重发写调用），双拒绝后 finally 按 add 次数逐条 remove 封死残留授权；isError 信封与 catch 错误消息过 `redactSecrets`（redactString 只重写凭证形状子串，拒绝原文不受影响）；漂移门从 execute_api 特例泛化为全部非只读工具的 surface 成员检查（探针曾对已藏掉的 transform_data 照样 mint 并把批准烧在 Unknown tool 上），`gateway_list_tools` 回写 surface 缓存（漂移报告即武装下一次调用的分类器）；query_data 与 transform_data 的 `out.path` 加 `tables.*.path` 全部过受保护树判定，toolArgs 序列化文本过 CLI 面凭证模式做 SQL 内 `read_csv()` 字面量的尽力而为扫描（残余：非凭证保护路径的 SQL 字面量不查，已注释）；操作者 deny 解析器剥尾注释、容忍分隔符空白、单 token 左侧按产品级 deny、歧义 effect token fail-closed；相对 `HUAWEICLOUD_MCP_POLICY_FILE`/`HUAWEICLOUD_MCP_AUDIT_FILE` 在 spawn 参数函数处直接拒绝（三处消费锚点不同，歧义形态整体拒收）；非对象 toolArgs 显式报错替代静默折空；enable 注释补 native 模式限定语。fake 网关增 `FAKE_REFUSE_EXECUTE`（桥双拒绝）与 `FAKE_FAIL_LIST_ONCE`（write-through：spawn 时列表失败缓存留空，漂移报告的成功列表成为唯一武装途径）。真实网关探针 14/14（openapi,data 混装模式：scope 白名单四种拒绝形态、tables 树拒、SQL 凭证字面量拒、桥接 status=200、零残留规则）
- feat(packs): open-mcp 通用调用面与审批机器落地（批二）——新增 `huaweicloud-open-mcp/approval.ts`：`classify(tool, toolArgs, mode, surface)` 纯决策表，三值判定 passthrough/token/deny（六个发现工具与 manage_policy list 直通；manage_policy 授予一律过 token、permanent 档两模式皆 deny 并指引手改 policy 文件；execute_api 秘密读取操作经 `classifyTextCommand` 映射 CLI 面词表硬拒、surface 缺失该工具时按漂移 deny 不烧同意、native 模式委派网关策略引擎、否则 token；transform_data 的 out.path 入受保护树 deny；query_data 与未知工具 fail-closed 走 token），`resolveApprovalMode` 调用时校验 `HUAWEICLOUD_OPENMCP_APPROVAL=devkit|native`（坏值报可行动错误而非污染 pack 无关的协议层），`matchingDenyRule` 读 LIVE policy 文件（操作者 env 优先、JSON 数组与手编纯文本双格式、`*` 通配）供桥前操作者拒绝预检。sidecar 增 `tools/list` surface 缓存（握手后填充、Unknown tool 错误即时刷新、onExit 清空、advisory 不阻塞调用）与成功载荷 `redactSecrets` 归一化边界脱敏（错误路径保持网关信封原文）
- feat(packs): 两个新静态工具上编译链（49→51）——`huaweicloud_gateway_list_tools` 返回网关子进程实时工具面与投影漂移报告；`huaweicloud_gateway_call` 以 `tool`+`toolArgs` 泛型代理任意网关工具：直通类照发，token 类首次调用返回绑定 `{tool, toolArgs}` 规范化哈希的 approvalToken 加脱敏回显（控制字段结构性排除在哈希外，重发须携原始未脱敏参数），devkit 模式 execute_api 桥 = 操作者 deny 预检（不烧 token）→ 消费 → 校验 → 每 `product:api` 尾链互斥内 铸 once 授权/转发/finally 回收，策略拒绝或子进程死亡各有一次有界重铸重试（授权丢失与并发竞态两类故障构造性闭合）。enable.ts 陈旧的"裁剪后无合法写路径"注释改写为真话：open-mcp 独立携带全部过 token 门的写路径。fake 网关增 `FAKE_POLICY`（manage_policy 内存规则、execute_api 通配匹配加 once 即焚、信封失败形态与真实网关一致）与 `FAKE_HIDE_TOOLS`（漂移降级注入）。十七项新测试经 `callTool` 真实分发面驱动：token 往返与参数失配、操作者拒绝不烧 token（拒绝移除后同 token 桥接成功证明）、漂移 deny 先于消费、桥接与即焚经 manage_policy list 断言、native 委派（返回网关策略拒绝而非 requiresApproval）、`DEVKIT_PACKS=core,huaweicloud-open-mcp` 写路径仅存在于 token 门后
- feat(packs): open-mcp 审批基座第一批落地（两轮设计检视 + 一轮实现检视修正后的形状）——新增 `src/lib/pack-state.ts`：`huaweiConfigBase(env)` 经 `resolve()` 一次绝对化，成为 devkit 配置树唯一解析器（`HUAWEICLOUD_HOME || homedir() → ~/.config/huaweicloud`，相对 HOME 不再分裂 store 与守卫的锚点；approvals.json 已改走它），`packStateDir(packId, env)` 按"写者读者集"归属判据建立 pack 级状态空间 `packs/<id>/`，`ensurePackState` 幂等供给（目录 0700 / 文件 0600、每趟 chmod 修复既有松权限、`wx` 独占创建原子且不清空并发对家的文件、失败抛 devkit 署名错误带 cause）；`isInsideProtectedTree` 是网关文件面写守卫：按"写入落地方式"解析（最深存在祖先 realpath 后拼接不存在尾部、相对路径锚定 tmpdir 父层），`..` 路径段与 win32 盘相对形态 fail-closed 直接拒绝（`path.resolve` 词法折叠 `..` 早于符号链接替换，实测 `link/../x` 可绕过词法检查落进保护树——两评审独立复现），悬空链接与不可解析根同样拒绝
- feat(packs): 网关 spawn 参数改为单一纯函数 `resolveGatewaySpawnArgs(env)`（pin-unless-env，`--log-file` 先例推广到 mode/policy），policy 文件名单一常量 `POLICY_FILE` 双点共用——`HUAWEICLOUD_MCP_MODE` 未设时钉 `--mode openapi`、已设时不传参让网关自己的 env 生效，`discover` 及未知组合在 devkit 侧即拒（外部 MCP 代理能力面未建模）；`--policy` 无条件供给（两种审批模式共用的同意基座，仅操作者设 `HUAWEICLOUD_MCP_POLICY_FILE` 时让位），供给先于 spawn；`--audit-file` 永不传参（网关 NDJSON 审计全量未脱敏参数且无轮转，缺省 NullAuditSink，操作者设 env 即显式选择加入）；子进程 cwd 为每子进程 `mkdtemp` scratch（双 MCP 进程的相对写不再碰撞；守卫锚定 tmpdir 父层，相对名只可能过度拒绝）
- fix(lib): approval token 三处加固——`hashArgs` 升级为规范化 JSON（递归排序对象键，agent 重序列化的键序漂移不再改变哈希；CLI 面 string[] 载荷逐字节不变）；`consumeApprovalToken` 前置 UUID 形状校验（伪造 token 零文件系统副作用，token 字符串不再未经消毒进入 `join()`——`..` 穿越与垃圾 marker 污染实测被封死），消费顺序重排为 读→验→claim→删（O_EXCL 独占 marker 只对真实有效 token 创建；竞态模拟测试钉住 marker 而非文件删除在拒绝重放；只读 HOME 优雅降级；过期 marker 由 mint 顺带清理）；fake 网关回显 argv/cwd/env 供 spawn 参数端到端断言。真实网关探针复验：默认 env 下参数计划 / policy 供给 / 空 policy 拒绝 / once 授权 / status=200 执行 / 即焚复拒全链路成立
- refactor(packs): 7 个 KooCLI 耦合工具从 core 下沉至 `huaweicloud-cli` 包——`huaweicloud_check_cli` / `plan_cli_command` / `run_readonly_command` / `list_operations` / `run_approved_command` / `show_profile_redacted` / `list_regions` 迁入 `src/packs/huaweicloud-cli/tools.ts`（handler 逐字迁移，schema 与描述字节级不变，registry-snapshot-diff 与 structure.test lockstep 门继续钉住）；core 回归通用面（安全 / 发现 / 元工具），工具数 17→10，`huaweicloud-cli` 0→7 成为知识+工具混合包，包工具并集 31→38，总工具数 48 不变。同意层已先行抽至 `src/lib/approval-tokens.ts`（commit 2134bc5），新包面直连该 lib 而非 hcloud-cli.ts 再导出垫片。裁剪语义 fail-closed：`DEVKIT_PACKS` 裁掉 `huaweicloud-cli` 时 CLI 执行面与审批工具（全库唯一 allowWrites:true 调用点）一并移除，被裁配置不存在合法写路径；core 强制包含的理由收窄为披露（list_packs / pack_info 不可被裁掉隐藏被禁内容）。PreToolUse hook 层不变，照旧拒绝裸 Bash 写操作（从不读取包状态）
- feat(packs): open-mcp 网关安装路径对齐上游——解析链 `~/.local/bin` → PATH（pip / pipx / uv tool install）→ `uvx huaweicloud-open-mcp` 兜底（零持久安装；uvx 首次冷启动拉取包可能超过握手超时，下次调用对热缓存自动重试）；找不到网关的错误指引改为 pip / uvx 优先；spawn 补 `windowsHide` 与 Windows `.exe` 候选后缀；解析函数按 `resolveEnabledPacks(env)` 先例接受 env 参数并可测
- fix(packs): open-mcp sidecar 对抗审查加固——子进程死亡窗口内的调用不再以未处理 EPIPE 击穿整个 server（stdin error 监听接入 onExit + request/notify alive 守卫，附竞态回归测试）；握手失败即杀子进程（SIGTERM→SIGKILL），孤儿 exit 不再误清健康单例（currentSidecar 身份比对）；spawn 显式 `--log-file` 指向 tmpdir（网关默认相对路径会在继承的 cwd——用户项目目录——创建 `logs/`，只读 cwd 下启动即死）；`limit`/`offset` schema 改非 nullable（网关 pydantic int 拒绝 null，实测）；网关信封失败 `reason` 映射为仓库标准 `error` 键（保留 reason）；归一化四分支补全覆盖（fake 网关新增 structuredContent/isError/信封失败/纯文本模式与握手失败开关）；六条工具描述纳入 structure.test lockstep 守卫（spread 断言泛化连字符 id→下划线导出名）。真实网关探针复验：日志落 tmpdir、cwd 零污染、失败归一在真实线协议上成立
- feat(packs): 新增 `huaweicloud-open-mcp` 能力包——经本地 huaweicloud-open-mcp 网关代理华为云全量 OpenAPI 目录发现（`huaweicloud_search_apis` / `list_products` / `get_product` / `list_apis` / `get_api` / `get_api_examples`，共 6 个只读工具）。Python sidecar 为进程级单例（`src/packs/huaweicloud-open-mcp/sidecar.ts`，手写换行 JSON-RPC，不依赖 MCP SDK），首次调用懒启动，生命周期绑定父进程 stdin 管道；remote 传输每请求构造/关闭 server 不影响单例；`DEVKIT_PACKS` 裁剪该包时零注册零 spawn；`OPENMCP_BIN` 可覆盖二进制解析，doctor 经 `PACK_BINARIES` 探测网关存在性。工具总数 42→48。API 执行（execute_api + 审批桥）为后续阶段
- docs(sandbox): huawei-sandbox 标注跨 pack 工具依赖的降级路径——`huaweicloud_detect_framework`（discovery pack）与 `huaweicloud_setup_obs_config`（obs pack）在 `DEVKIT_PACKS` 裁剪对应 pack 时给出可操作指引（询问开发者/改用手工配置），而非裸调未注册工具
- refactor(packs): pack id `services` 更名为 `huaweicloud-cli`(按执行面命名)。破坏性变更:`DEVKIT_PACKS` 持旧值的配置启动即失败并列出合法 id,改用新 id 或重跑安装器 `--packs all` 恢复(codex 目标由 codex CLI 托管需手改;DSH 吞启动错误,以 doctor 为发现途径);`sync-skills --check` 新增生成头路径校验,目录改名后漏跑 `skills:sync` 将直接失败
- feat(sandbox): devbridge 认证改为运行时能力探测——`0.2.2-release` 存在两个构建（镜像版保留 AK/SK 登录 + env 自动读取；发布版仅支持 API Key），暴露流程按 `auth login --help` 探测结果自动分支：镜像版直接使用注入的 AK/SK（零介入），发布版走 API Key 引导；`.codeartsdoer` sidecopy 同步，守护测试覆盖双分支

## 1.1.6-next.1 (2026-09-22)

- feat(sandbox): migrate DevBridge flow to 0.2.x (s2 gateway + API Key auth) (#793)
- fix(sandbox): proxy deploys no longer emit misleading port warnings
- docs(deployment): correct ShowAppDetailById param and annotate deprecated ops
- fix(sandbox): remediation cautions against stale port after drift
- style: apply prettier
- docs(sandbox): document devbridge host vs connect, description traps, and port drift
- docs(deployment): fix KooCLI service/operation names verified against hcloud --help
- fix(setup): doctor success message no longer demands a restart
- feat(sandbox): deploy_check returns executable remediation for expose_via_devbridge
- fix(sandbox): warn when port drift detaches an active DevBridge tunnel
- fix(sandbox): deploy_check no longer reports malformed publicUrl without tunnel
- fix(sandbox): port conflict warning reports real auto-assigned port
- fix(setup): workbuddy uninstall crash + honest uninstall skill counts (#556)
- fix(mcp): address #717 review — target allowlist, -32600, newline test
- fix(mcp): survive malformed JSON frames (-32700) and Windows npm EINVAL (#643)
- test(setup): make OfficeAce auto-detect hermetic in install tests (#654)
- fix(mcp): return -32602 for tools/call missing required params or unknown tool (#704)

## Unreleased

- feat(sandbox): `huaweicloud_sandbox_credentials` 新增 `api_key` 参数（或本地 `HW_API_KEY` 透传），注入沙箱供 devbridge 0.2.x 使用
- fix(sandbox): deploy_check/deploy_nginx 适配 DevBridge 0.2.x——网关迁移后隧道 URL 改用 `devbridge-s2.hwtunnel.com` 域名构造；「服务已迁移」占位页（HTTP 200）判为 FAIL，修复假 200 误判 complete
- fix(sandbox): 隧道探测版本感知——0.1.x 用 `list -j` JSON，0.2.x（已移除 `-j`）解析纯文本表格数据行的 8 位 base32 tunnelId
- docs(sandbox): SKILL.md 暴露流程重写——API Key 登录引导（获取入口/交付方式/失败路径/安全提示）、存量沙箱 0.1.x→0.2.x 原地单版本升级（官方 installer，GitCode 渠道优先 + GitHub 兜底 + `--http1.1` 规避 HTTP2 framing）、残留 `/usr/local/bin/devbridge` 清理、新域名格式说明
- test: 新增 devbridge s2 域名迁移/API Key 认证/版本升级守护测试；改写 `list -j` 断言为版本感知表述
- fix(sandbox): 审查加固——API Key（长期账号级凭据）与临时 AK/SK 分离存储（`/tmp/hw_api_key`，0600）；`api_key` 优先级改为本地 `HW_API_KEY` 环境变量优先；修复 PATH 追加写法导致旧镜像二进制抢占解析的问题（改为前置 + 显式比对清理残留）

## 1.1.6-next.0 (2026-09-16)

- chore: sync README beta badge to 1.1.6
- chore: set version-override to 1.1.6 (next -> 1.1.6-next.0)
- fix(hook): risk engine fails closed on malformed input (#564)
- fix(officeace): align runtime skill root env probe with installer (#559)
- fix(setup): make OfficeAce install/uninstall/register integrity reliable (#559)
- fix(mcp): resolve plugin version from plugin manifest in Codex cache layout (#576)
- feat(sandbox): add mandatory target-selection gate before sandbox lifecycle tools (#691)
- fix(safety+mcp): close env-dump and shell-wrap bypasses, JSON-RPC -32601 (#650) (#688)
- fix(mcp): actionable explain_error fallback guidance (#648)
- fix(proxy): skip TLS cert verify only for proxy connections (#667)
- fix(safety): classify Apply* operations as write (#644)
- feat(auth): onboarding guidance for credential setup (scenarios 1-4) (#665)
- test: fix Windows path compat in upgrade-session test (split('/') → path.basename)
- fix(#614/#607): review 两点 — 保留 failedAt 节流 + doQuery 注入口补真覆盖
- fix(#614/#607): dismiss + 查询失败路径 — 不写伪冷却、返回 check_failed

## 1.1.4-next.6 (2026-09-14)

- fix(setup): preserve user MCP config fields across install/update/uninstall (#615) (#661)

## 1.1.4-next.5 (2026-09-14)

- fix(#614/#607): dismiss + 查询失败路径 — 不写伪冷却、返回 check_failed (#659)
- feat(obs): add huaweicloud_obs_set_website_config MCP tool

## 1.1.4-next.4 (2026-09-14)

- fix(auth): treat placeholder/masked credentials as not configured (R11, #570) (#655)

## 1.1.4-next.3 (2026-09-12)

- fix(#606/#614): MCP 升级提示+dismiss 按会话隔离；remote 透传 session；pre线策略文档补全 (#646)

## 1.1.4-next.2 (2026-09-12)

- fix(koocli): stop injecting --cli-lang; detect and guide global switch (#633)

## 1.1.4-next.1 (2026-09-11)

- fix(auth): clear import file on unfixable reject and after confirm success (#502)
- fix(auth): validate region before persist and keep import file for replay (#502)

## 1.1.4-next.0 (2026-09-11)

- fix(koocli): auto-inject --cli-lang=cn for services missing from the English catalog (#627)
- docs(sandbox): replace ~8h empirical validity with expiresAt API reference
- fix(redact): mask opaque blob keys (user_data/metadata/private_key) entirely (#578)
- fix(approval): persist approval tokens to disk (hashed, cross-process) for plan->run (#578)
- fix(voucher): propagate credential errors instead of swallowing into generic message (#623)
- test(codex): assert JSON-based status detection, drop legacy-name recognition
- fix(codex): parse plugin list JSON instead of substring-matching status path
- refactor(codex): drop dead 'huaweicloud-core' fallback in codexStatus
- fix(sandbox): robust deploy_check output parsing for terminal artifacts
- chore(release): 1.1.3-next.4 (#617)
- fix: 受限网络下升级检测静默失败——checkForUpdate 改 fetch registry + 15s 超时 + DEBUG 日志 (#612) (#613)
- ci: trigger CI on push to dev (#501) (#605)
- chore(release): 1.1.3-next.3
- fix(safety): cover Nova*/Reset* destructive ops in hook risk rules (#501) (#594)
- fix(auth): resolve KooCLI config from homedir, not HUAWEICLOUD_HOME (#501) (#595)
- docs(iac): remove deposit (保证金) guidance - vouchers no longer require a deposit
- chore(docs): remove committed superpowers plan doc (already gitignored) (#501) (#599)
- fix(hermes): respect homedir() on Windows instead of LOCALAPPDATA
- fix(deps): override smol-toml to 1.8.0 to clear npm audit high vuln (#501)
- test: add E2E MCP tool invocation and schema validation tests
- chore(release): 1.1.3-next.2
- feat(install): interactive zero-detection install menu + generic MCP wiring (#592)
- chore(release): 1.1.3-next.1
- style: prettier-align credential priority tables in README (#520)
- fix(auth): skip S2 fingerprint drift when KooCLI authEncrypt stores ciphertext (#533)
- chore(release): 1.1.3-next.0 (#589)
- docs: align README credential docs with SKILL.md - priority, auth_switch, env security warning (#520)
- fix(mcp): allow maxRetries 0 in numeric arg validation (#530)
- fix(mcp): reject invalid numeric args (timeoutMs/maxRetries) instead of silently ignoring (#530)
- docs: replace static beta version badge with npm version badge (#530)
- docs(obs): mb return-code trap and website endpoint propagation delay (#485)
- chore: set version-override to 1.1.3 (next -> 1.1.3-next.0) (#588)
- chore(release): 1.1.2-next.8
- feat(rev4): send X-HW-Client-Version; SKILL wording; remove unreachable cmdUpdate reinstall (#586)
- test(update-check): decouple upgrade-tag logic from repo package.json version
- chore(release): 1.1.2-next.7
- fix(skills): correct cli-domain-id root cause — it signals invalid credentials, not a missing domain-id (#574)
- chore(release): 1.1.2-next.6
- style: prettier table alignment (#574)
- docs(voucher): drop in-flow domain-id discovery detail from test-env note (#574)
- fix(skills): teach agents to self-discover cli-domain-id via STS GetCallerIdentity (#574)
- feat(setup): unix auto-install, hermes restart hint, grouped status; docs: sandbox_credentials example (#265, #280)
- feat(telemetry): classify cursor-vscode and officeace-agent MCP client names
- docs(iac): verified traps from 2026-09-08 e2e report - keypair/RDS/DCS/EIP-quota/long-args/destroy-alignment
- chore(release): 1.1.2-next.5
- fix: clarify devkit version output
- docs(sandbox): index.html platform-overwrite symptom, recovery, and prevention (#263)
- docs: note mirror-lag fallback to official registry (#518)
- feat(auth): complete non-interactive guidance and detect existing KooCLI profile in auth init (#260)
- style: add trailing newline to hook-plugin test
- chore(release): 1.1.2-next.4
- fix codex install auth probe and safety hook
- chore(release): 1.1.2-next.3 (#550)
- fix(auth): spawn hcloud without shell in project-id resolution
- feat(auth): validate credentials before sandbox injection + auto-set project_id (#259, #262)
- feat(telemetry): route telemetry upload through proxy
- feat(telemetry): classify MCP client names to canonical agent harness
- test: align sandbox warning assertion with unified codearts wording (#261)
- style: prettier format for hcloud-cli obs hint
- style: prettier format for hermes skills snapshot
- fix(setup): unify CodeArts sandbox warning with accurate settings path (#261)
- feat(hermes): add skills snapshot for one-shot bulk install
- fix(iac): manifest-first batch approval, verified timer schedule, OBS plan hint
- chore: add mcpName field to package.json (#543)
- fix(dew): distinguish auto-rotation enable vs RotateSecret trigger
- fix(dew): CSMS CreateSecret uses --name, not --secret_name
- test: add versionMismatch assertions for runVersionCheck
- feat: pin KooCLI version and align skills with KooCLI 7.2.12
- chore(release): 1.1.2-next.2 (#541)
- fix(release): make create-release-pr path helpers idempotent (#537)
- fix(telemetry): regenerate userHash after credential switch
- docs: remove Cursor section from README
- feat(mcp): add remote (Streamable HTTP) transport mode (#531)
- docs: clarify Cursor marketplace status (not yet listed)
- docs: document Cursor Directory support alongside other agents
- fix(telemetry): bound hcloud capture and isolate failed event retries
- docs: move Cursor Directory section below Documentation
- fix: use agent-neutral wording for KooCLI config-write failure hint
- chore(release): 1.1.2-next.1 (#528)
- fix(release): bump version override to 1.1.2 for next preview line (#527)
- feat(update): session-level version update detection & auto-upgrade (#525)
- chore: sync root plugin.json version to 1.1.1-next.16
- chore(release): 1.1.1-next.16
- chore: address Cursor marketplace PR review feedback
- fix(skills): deposit prompt cites official FAQ links (frozen deposit explanation + amount rules)
- style: prettier re-align huawei-iac stage-5 table
- fix(skills): deposit prompt includes recharge portal link (balanceRecharge)
- fix(skills): deposit prompt includes amount range (约 1~5 元人民币不等)
- style: add trailing newline to plugin.json and mcp.json
- chore: add Open Plugins manifest for Cursor marketplace
- chore(skills): bootstrap Node template bumped to v22.14.0 LTS
- fix(skills): bootstrap Node template must match instance arch (arm64 vs x64)
- fix(safety+skills): web-port rule false-positive, China mirrors, keypair import flow, E2E report findings
- fix(skills): huawei-iac stage order - inspect code before offering options; scale and hosting are separate questions
- fix(skills): huawei-iac stage-3 architecture decision points must be surfaced
- fix: repair Python hook indentation and update stale DSH/telemetry tests
- fix(telemetry): unref flush interval so tests don't hang the process
- fix(workbuddy): remove hooks field from plugin manifest to pass validate
- fix: resolve eslint and prettier errors reported by PR #500 CI
- chore(release): 1.1.1-next.15
- feat(auth): 凭证一致化整改 — reconcile / R7 current档 / R9 会话优先 / R10 runtime守卫 (#498)
- chore(release): 1.1.1-next.14
- feat: detect new plugin versions on install/update
- chore(release): 1.1.1-next.13
- style: prettier re-align huawei-iac tables
- feat(uninstall): optional KooCLI/OBS cleanup on global uninstall
- fix(skills): correct zero-balance remedy order - voucher first, deposit is its prerequisite
- fix(skills): top-up is the only deposit path; vouchers offset fees but are not the deposit
- fix(skills): huawei-iac stage-5 deposit warning must be the first message at zero balance
- fix(setup-cli): verify file copies during install, retry on size mismatch
- feat: add `version` command reporting installed plugin version per agent
- fix(skills): deployment->iac routing is unconditional; existing VPC is not an exemption
- feat(skills): all deployment intents (except sandbox) route through huawei-iac
- fix(skills): huawei-ecs routes multi-resource purchases to huawei-iac
- fix(skills): huawei-iac asks scale tier when unknown instead of assuming
- fix(skills): huawei-iac consultation stages are proactive, not user-requested
- fix(skills): huawei-iac FunctionGraph verified params + zero-balance free-tier rule
- fix(skills): huawei-iac corrections from E2E round 4 (pricing API, CDN global region, ownership verification)
- feat(skills): add huawei-iac orchestration skill for multi-resource provisioning
- chore(release): 1.1.1-next.12
- fix: repair DSH bundle patch loading and MCP path resolution
- chore(release): 1.1.1-next.11
- style: wrap over-width line in validate-package.mjs
- fix: publish cordis.patch.yml referenced by dsh.bundle.patch
- chore(release): 1.1.1-next.10
- feat(telemetry): encode install dir into harness fallback for unknown agents
- chore: retry CI (#479)
- chore: retry CI (#479)
- chore: retry CI (#479)
- fix(auth): prefer auth-init creds over injected STS env creds (#479)
- fix(openclaw): match openclaw via install path and native mcp config
- fix: skip npm audit/fund when installing plugin runtime deps
- test: scope node --test to actual test files
- chore(release): 1.1.1-next.9
- fix(package): include integrations/atomcode in npm pack
- feat: add DSH post-install guidance for KooCLI and credentials setup
- feat(atomcode): add telemetry hook for Skill/CLI/MCP tracking
- fix(dsh): maintain existing state after legacy block cleanup
- fix: move createRequire after all imports, remove shebang, format
- refactor: remove better-sqlite3, auto-setup DSH via bundle patch
- feat: expand agent registry from 13 to 23 agents
- refactor: agent detection to table-driven registry pattern
- fix: add OfficeAce harness detection and version identification
- chore(release): 1.1.1-next.8
- feat: 安装提示补充由 AI 助手转达代金券的指令
- chore(release): 1.1.1-next.7
- feat: 安装完成提示首次使用可领取华为云代金券
- fix: restrict MCP keepalive to Hermes-on-Windows only, exit on stdin close for other agents
- docs(sandbox): find real build output dir across the whole project (#247)
- chore(release): 1.1.1-next.6 (#471)
- Revert "fix(ecs): change preflight SG check from hard-deny to require_user_confirmation (#468)" (#470)
- chore(release): 1.1.1-next.5 (#469)
- fix(ecs): change preflight SG check from hard-deny to require_user_confirmation (#468)
- chore: add dsh.bundle manifest for DSH plugin ecosystem
- fixE: include integrations/hermes in npm publish files
- feat(telemetry): fix harness/agentVersion detection and move telemetry hook to integrations
- chore(release): 1.1.1-next.4 (#465)
- fix(ecs): fix preflightSecurityGroupCheck regex and query parameter format (#443) (#464)
- chore(release): 1.1.1-next.3 (#463)
- feat(ecs): auto-check security group rules during plan phase (#443) (#462)
- fix: use CodeArts Work native MCP format (mcp key, command array, environment) (#461)
- fix(sandbox): add devbridge PATH to persistent session on connect
- chore(release): 1.1.1-next.2
- fix(safety): relax delete_publicip cascade rule + improve approvedCommand mismatch error
- docs: voucher_status 工具描述内嵌主动提示行为指令
- fix(detect): handle unquoted outDir in VitePress config
- fix(sandbox): clean URL support for static nginx + cross-arch build guidance
- fix: add integrations/workbuddy to npm files list
- chore(release): 1.1.1-next.1
- feat(workbuddy): integrate telemetry hook deployment into setup-cli.mjs
- docs: 强化 huawei-voucher skill 主动提示准则与话术
- fix(release): use JS filter instead of shell glob for tag lookup
- chore(release): 1.1.1-next.0
- chore: set version override to 1.1.1 for next preview release
- fix(sandbox): credential injection, nginx cleanup, and auto git clone
- fix(ecs): add security group reuse warning to Critical Warnings (#444)
- docs: add beta badge to Chinese README (#442)
- fix: include atomcode in skills root and report openclaw auth status
- docs: update beta badge version to v1.1.0 (#431)
- chore(release): 1.1.0-next.21
- fix(sandbox): auto-detect cross-platform from project files for QR check
- fix(sandbox): restrict QR auto-generation to cross-platform projects only
- docs: add beta badge to README (#428)
- fix(sandbox): always auto-generate QR code regardless of frameworkType
- chore(release): 1.1.0-next.20
- fix(sandbox): auto-generate QR code in deploy_check for cross-platform projects
- feat(cli): replace string matching with token-based plan-run approval (#421)
- chore(release): 1.1.0-next.19
- refactor(skill-tracker): remove CLI wrapper file, use single function-as-object pattern
- feat(cli): save large hcloud output to file and return path (#416)
- fix(sandbox): always run QR code check in deploy_check regardless of frameworkType
- fix(rds): correct ARM volume type from ULTRAHIGH to CLOUDSSD (#5) (#417)
- fix(safety): add STS credential exposure warning rule (#10) (#418)
- fix(safety): add rule to warn on all Delete/Detach/Remove cloud operations (#413)
- fix(auth): sync KooCLI hcloud config on auth sync (#411)
- fix(skill-tracker): prevent duplicate hook capture in IDE mode
- fix: remove UTF-8 BOM from files
- fix: remove UTF-8 BOM from files
- fix(skill-tracker): restore CLI entry wrapper file and setup-cli install logic
- style: prettier format fix
- style: prettier format fix
- chore: fix Unicode arrow encoding in skill-tracker comments
- refactor(skill-tracker): merge into single file using function-as-object pattern
- refactor(skill-tracker): unify IDE and CLI hook plugins into shared core
- feat: add HC activity ECS+Nginx deployment workflow reference doc
- feat: add HC activity ECS+Nginx deployment workflow to huawei-ecs skill
- style: prettier reformat huawei-vpc SKILL.md tables (#394)
- fix(vpc): correct subnet DNS addresses per region (#394)
- chore(release): 1.1.0-next.18
- docs(sandbox): fix source parameter value typos (#376)
- fix(sandbox): deploy_check captures all statuses + returns tunnel URL (#412)
- fix(telemetry): prevent duplicate DAU events on same-day process restart
- fix(hcloud): auto-accept privacy agreement on first use
- fix(setup): preserve user-customized MCP args and env during CodeArts register
- fix(safety): prevent false-positives in destructive-delete rule and approvedCommand
- docs(sandbox): scope GitCode SSL workaround to one-shot clone (#374)
- fix(telemetry): simplify checkDauPing to handle stamp deletion edge case
- fix: retry npm install on any failure and exit non-zero when it fails (#244)
- fix: add codex desktop skills dir to resolveSkillsRoot fallback chain (#170)
- refactor(telemetry): defer install stamp write to successful event delivery and remove trackInstall from setup CLI
- chore(release): bump version to 1.1.0-next.17 (#405)
- fix(sandbox): use valid devbridge list command (#382)
- fix(iam): correct 8 invalid CLI operations and parameters in skill (#354) (#403)
- fix(rds): correct 3 invalid CLI operations in skill (#355) (#402)
- fix(waf-aad): correct invalid AAD and WAF CLI operations in skill (#401)
- docs: add Huawei Cloud npm mirror recommendation for China users
- fix(hermes): install Python safety-hook plugin for v0.9.0 enforcement (#393)
- style: prettier formatting for hermes hook allowlist (#393)
- fix(hermes): pre-authorize safety hook in shell-hooks allowlist (#393)
- fix(smn-dms): replace hcloud DMS with Kafka/RabbitMQ/RocketMQ services (#357) (#397)
- feat(dsh): add Cordis hook plugin for telemetry interception
- test: add codearts-work E2E install tests and sync assertion (#396)
- revert(dsh): remove skill tracking from Python hook and hooks copying
- feat: add codearts-work (CodeArts Space) agent target support (#389)
- feat(telemetry): add skill retrieve tracking to Python hook
- fix(telemetry): remove duplicate ideVersion declaration
- feat(telemetry): detect DSH version from npm global package
- revert(dsh): remove endpoint env var reading from dshPatchBlock
- fix(dsh): support --hdkitservice-endpoint and --telemetry-endpoint CLI args
- chore(release): 1.1.0-next.15 (#388)
- feat(dsh): install skill-tracker.js hook for DSH agent
- feat: add codearts-work (CodeArts Space) agent target support (#387)
- fix(telemetry): use URL.pathname instead of fileURLToPath for path detection
- fix(telemetry): use file path to detect harness, remove vscode fallback
- fix(telemetry): fix harness and version detection priority
- fix(sandbox): default deploy_nginx config_name from 'app' to project name
- fix(telemetry): PLUGIN_VERSION reads undefined PLUGIN_DIR
- refactor(telemetry): move agent-specific data into agent install directories
- chore(release): 1.1.0-next.14
- fix(telemetry): fix agent_version reporting wrong IDE version
- fix(telemetry): use import.meta.url to detect agent harness in hook
- fix(telemetry): detect agent harness by env vars only, remove disk-based check
- test: update hdkitservice error message assertion to match new format
- fix: deploy_nginx auto-assign free port + SSR runtime env var injection
- fix: port conflict detection in deploy_nginx + SKILL.md docs
- fix(hdkitservice): improve credential and error diagnostics
- fix: batch fixes for deploy issues #15 #16 #5 #2 #22 #23
- fix: skill-tracker detectHarness 新增 .codeartsdoer 目录检测，解决 plugin 加载早于 MCP 导致检测为 unknown
- refactor: dau-stamp/first-use-stamp/hook-events/dev-log 全部下沉到 agent 子目录
- fix(hcloud): add runtime path discovery for hcloud binary
- fix: flushEvents 中残留的 INSTALL_STAMP 引用导致 ReferenceError，事件每 60s 重试
- fix: ensureDir 支持创建 agent 子目录，writeTextFile/touchFile 自动创建父目录
- fix(sandbox): graceful nginx restart with orphan worker recovery
- refactor: install-stamp/counter 改用 agent 子目录隔离
- refactor: install-stamp/counter 改为按 agent 隔离，支持多 agent 独立安装上报
- fix: 各 install 函数调用 trackInstall() 确保 plugin:install 事件在每次安装后触发
- fix(sandbox): move large_client_header_buffers to server level, harden port equality guard, add credential dev_stage_id fallback
- style: apply Prettier formatting
- fix(sandbox): prevent port conflicts, stale content, and header buffer errors in SSR deployments
- chore(release): 1.1.0-next.13 (#362)
- fix: scope MCP keepalive to after stdin close only (#361)
- feat: 完善 CodeArts 遥测支持 — skill/CLI 事件捕获与安装脚本同步
- chore(release): 1.1.0-next.12 (#360)
- fix(telemetry): restore writeEvent function accidentally removed in skill filter commit
- fix(telemetry): filter non-Huawei Cloud skills from skill:retrieve events
- fix(telemetry): extract DAU check to standalone function, call from 60s timer to ensure cross-day reporting when idle
- fix: correct broken CLI commands in billing/vpc/dew skills (#358)
- feat: add installCommand to search_marketplace results (#353)
- chore(release): 1.1.0-next.11 (#352)
- fix(hermes): fix uninstall order, config.yaml residue, and allowlist cleanup (#343)
- chore(release): 1.1.0-next.10 (#342)
- fix: prevent MCP server silent exit on Windows when stdin is closed (#340)
- chore(release): 1.1.0-next.9
- fix(sandbox): nginx cleanup, try_files, reload, config_name
- docs: add Codex install section to README
- fix(sandbox): git archive prefix, symlink resolve, permission hardening
- fix(sandbox): add build failure response rules to prevent silent auto-fixes
- fix(telemetry): anchor hcloud regex to command start to avoid false positives in quoted strings
- chore: add startopencode.bat to .gitignore
- chore: remove sync-opencode.ps1 from remote, add to .gitignore
- refactor(telemetry): rewrite skill-tracker hook for 3-channel coverage, fix input.tool_name bug, clean up orphaned files
- feat(sandbox): deploy_check tool, deploy_nginx nextStep, REQUIRED markers
- feat(telemetry): add event telemetry system with install counter and crash safety
- style: remove unused escapedConfig variable
- feat(sandbox): add sandbox_deploy_nginx tool + permission auto-fix
- fix(sandbox): merge Step 8 QR into Step 7, add deployment completion checklist
- style: prettier format SKILL.md blank lines
- fix(sandbox): optimize deploy flow - permissions, credentials, env detection, tunnel cleanup
- fix(sandbox): pkill devbridge before tunnel creation to prevent zombies
- fix(sandbox): use git archive for git repos to exclude all untracked/ignored files
- fix(sandbox): post-build output verification, Node v24 native module guidance
- fix(sandbox): health-check tunnel URL before returning, auto-retry on failure
- fix(sandbox): save QR to outputDir for nginx serving, drop ANSI qrencode
- docs: add Hermes uninstall notes for Linux and Windows
- chore: bump version to 1.1.0-next.8 + fix Hermes MCP SDK (#326)
- style: fix ESLint catch-error-name and prettier
- chore: bump version to 1.1.0-next.8
- docs: add Hermes MCP Python SDK note to README
- fix(hermes): auto-install MCP Python SDK to fix silent tool discovery skip
- chore: bump version to 1.1.0-next.7
- fix(sandbox): expand **/ patterns for tar --exclude (globstar not supported)
- docs: rename Hermes Agent to Hermes for consistency (#321)
- fix(ws-exec): replace RegExp with indexOf/slice in stripEchoedLine to avoid RangeError on long commands
- fix(sandbox): **/node_modules exclusion, nginx cleanup, archive size warning, upload log rotation
- feat(hermes): complete Hermes Agent adaptation with safety hooks and MCP Catalog (#306)
- fix(sandbox): add output file verification and session fallback guidance
- chore(release): 1.1.0-next.6
- fix(sandbox): add tee build logging, outDir verification, post-timeout log dump
- feat: 代金券能力可发现化，新增 huawei-voucher skill 与路由
- fix(sandbox): add DevBridge quota auto-recovery, pre-cleanup, Taro build 900s timeout
- fix(sandbox): add DevBridge quota auto-recovery, pre-cleanup, Taro build 900s timeout
- fix(sandbox): add .swc/dist exclusion, post-upload permission fix, PNG QR priority, cross-platform 600s timeout
- fix(sandbox): add build timeout recovery, env injection, OS detection, dependency exclusion for upload
- fix(sandbox): add build timeout recovery, env injection, OS detection, dependency exclusion for upload
- chore(release): 1.1.0-next.5
- fix: voucher 工具 domain_id 参数标注为可选，避免 Agent 误判为必传 (#308)
- style: rename catch parameter err to error for unicorn/catch-error-name rule
- fix(sandbox): add retry for upload batch/tunnel failures, add process persistence and cross-platform warnings
- chore(release): 1.1.0-next.4
- fix(release): stop auto-deleting .version-override in create-release-pr
- chore(release): 1.1.0-next.3
- fix(release): restore .version-override to 1.1.0 until 1.1.0 stable release
- feat: add parent cwd and --codearts-project-dir fallback for CodeArts credential resolution (#299)
- feat: voucher MCP 工具支持可选 domain_id 参数
- chore(release): 1.1.0-next.1
- style: format fix
- fix: separate OpenClaw install from Codex Desktop
- style: format marketplace.json
- feat: codex-desktop install to Codex-standard plugin layout
- fix: 错误提示改为英文
- style: 修复 catch 参数命名，符合 unicorn/catch-error-name 规则
- fix: 修复 hdkitservice-api.mjs 中 undici 动态导入的 lint 报错
- fix: voucher 工具后端不可用时优雅降级
- style: 修复 prettier 格式问题
- feat: 新增激励金代金券 MCP 工具
- style: format fix
- feat: add web framework detection and sandbox deploy workflow
- chore(release): 1.1.0-next.0
- fix(release): restore manifest to 1.0.2 (latest stable)
- feat(release): support .version-override for dev branch, set next target to 1.1.0
- feat: add AtomCode as supported agent target
- chore(eslint): add eslint-plugin-import-x and eslint-plugin-unicorn
- chore(release): 1.0.3-next.0
- fix(workbuddy): update post-install message - no restart needed, add connector trust prompt
- style: prettier format fix
- fix(release): derive next preview version from latest stable tag instead of stale manifest
- fix: harden DSH install runtime deps and doctor checks
- feat(modelarts): add marketplace fallback for advanced workflows
- refactor(skills): remove orphaned huawei-cloud-find-skills, wire full marketplace flow
- fix(capability-discovery): replace dead skills-index URL with huaweicloud_search_marketplace tool reference
- chore(release): 1.0.2-next.23 (#254)
- docs: restore ClawHub-first install method for OpenClaw section (#253)
- fix: use separate clawhub-publish environment for ClawHub job (#249)
- chore(release): 1.0.2-next.22 (#252)
- fix(sandbox): add workspace_id validation and improve connect ID propagation (#251)
- style: fix prettier formatting
- fix(sandbox): add workspace_id validation and improve connect ID propagation
- chore(release): 1.0.2-next.21 (#248)
- feat: add ClawHub publish to CI pipeline (#236)
- fix: OpenClaw plugin issues - workspace cache, version sync, name unification (#243)
- feat: add OpenClaw agent target support (#229)
- style: prettier format
- chore: sync hermes plugin version to 1.0.2-next.20
- fix(release): add .hermes-plugin to version sync list
- chore(release): 1.0.2-next.20
- fix: resolve merge conflicts - remove extra braces from clash with hermes
- feat: add OpenClaw agent target support
- fix(officeace): replace restart prompt with connector enable guide
- style: prettier format
- fix: remove BOM from hermes plugin.json
- style: prettier format
- feat: add Hermes Agent target support
- fix(officeace): add officeaceCapabilitiesDirSafe fallback for non-Windows platforms
- fix(officeace): simplify lookup - registry first, scan incl LOCALAPPDATA, interactive prompt only
- fix(officeace): add LOCALAPPDATA\Programs to scan fallback
- chore: OFFICE_CLAW_CONFIG_ROOT before registry for env var override
- fix(officeace): use OFFICE_CLAW_CONFIG_ROOT + registry for install dir discovery
- style: prettier format
- test(ci): add multi-agent plugin install/uninstall e2e tests
- ci: bump all Node 20 references to 24 across workflows
- ci: bump Node.js test matrix from 20/22 to 22/24
- fix: align Node.js version declaration from >=20 to >=22
- style: apply prettier formatting
- fix: remove WorkBuddy hooks to avoid high-risk prompt, add sandbox-first scenario routing
- style: prettier format setup-cli.mjs
- fix: add timeout:300000 to MCP config in install scripts
- fix: increase upload_project default timeout from 120s to 300s
- fix: rename installed package name from huaweicloud-plugins to huaweicloud-devkit, add npx cache cleanup to README
- docs: add NOTICE and source attribution headers for hwlink-derived code
- Revert "[ci]: add PR code review workflow "
- chore(release): 1.0.2-next.19
- style: prettier format
- chore: bump version to 1.0.2-next.18 (#205)
- chore: sync openclaw.plugin.json version to 1.0.2-next.18
- style: prettier format
- fix: resolve MCP server version to plugin package.json, add officeace version sync and tests
- chore(release): 1.0.2-next.17
- feat: add sandbox_upload_project tool with HTTP tunnel transfer
- style: prettier format for audit report and openclaw plugin manifest
- fix: resolve 6 critical issues from audit report
- feat: add openclaw.plugin.json for OpenClaw bundle adapter (v1.0.2-next.16)
- chore: remove retired publish-dev.yml, empty cd-production.yml stub, fix repo URL case
- fix: handle linux-arm64 in install-hcloud test, prettier format
- feat: add PR-triggered automated tests for agent compatibility and cross-platform
- style: format agent-install.test.mjs
- test: add ARM platform support to install-hcloud platform detection test
- docs: remove Codex from README support list and sections, drop Qixi demo files
- ci: add PR code review workflow with Huawei Cloud MaaS GLM-5.2
- chore: ignore deploy-qixi.mjs in eslint
- fix: add agent-install test, integration CI job, USERPROFILE cross-platform fix
- style: apply prettier formatting, fix lint warnings in auth tests
- fix: make USERPROFILE/HOME test work on both Linux and Windows
- refactor: remove dynamic SUPPORTED_AGENT_TARGETS README check, PR template suffices
- docs: PR template README checklist + CI warns instead of blocks
- feat: dynamic README validation from SUPPORTED_AGENT_TARGETS
- docs: update MCP config to npx in README, add sandbox feature, add README CI checks
- chore(qixi): add sandbox deployment script for cyber companion
- feat(qixi): add cyber companion web app for Qixi Festival
- docs: add Qixi cyber companion implementation plan
- docs: add Qixi cyber companion design spec
- fix: gate CodeArts credential source behind isCodeArtsContext check to avoid affecting other agents
- feat: add CodeArts mcp_settings.json as credential source for project-level AK/SK
- feat: runtime credential switching for multi-account sandbox isolation
- docs: fix English CodeArts sandbox settings path
- docs: fix CodeArts sandbox mode settings path in README and CLI
- chore(release): 1.0.2-next.13
- ci: restore Windows jobs but skip actual build (branch protection requirement)
- ci: temporarily exclude Windows from test matrix (better-sqlite3 compile issue)
- ci: add back setup-python alongside msvc-dev-cmd for Windows
- ci: use msvc-dev-cmd for Windows node-gyp builds
- ci: set msvs_version and disable build-from-source on Windows
- refactor(officeace): switch back to better-sqlite3 for WAL support
- refactor(officeace): replace better-sqlite3 with sql.js (pure JS, no native compilation)
- test: update officeace structure tests for sqlite function renames
- refactor(officeace): replace node:sqlite with better-sqlite3 for Node 20 support
- feat(officeace): write MCP config directly to mcp-connectors.sqlite instead of capabilities.json
- chore(release): 1.0.2-next.12
- fix: sandbox MCP improvements - execOneShot tool, timeout, devbridge, endpoint clarity
- chore(release): 1.0.2-next.11
- fix: move eslint-disable-next to correct line for node:undici import
- style: format proxy-agent.mjs with prettier
- fix(proxy): use undici fetch for proxy dispatcher, add node:undici fallback, load proxy env at startup
- docs: restructure README - unify command style, add install-hcloud/auth/install-all/update-all sections
- docs: update OpenCode section with --target recommendation
- docs: clarify auto-detection behavior when multiple agents are present
- fix(release): push to dev only tags, avoid auto-creating release PRs on code merges
- chore(release): 1.0.2-next.10
- feat: add huaweicloud-devkit-mcp bin entry for standard MCP config
- chore(release): 1.0.2-next.9
- style: prettier format fix for OfficeAce adapter
- feat: add OfficeAce adapter support
- fix(install): run npm install for runtime deps (undici) after copying src
- fix: format version files with prettier, fix lint in create-release-pr.mjs
- fix(release): run prettier on changed files before creating release PR
- fix: remove format from test job needs so formatting issues do not block tests
- feat(release): publish prereleases directly from dev, manual dispatch only
- style: apply prettier, relax structure assertion for reformatted fallback
- fix(tools): skip stale skills dirs in SKILLS_ROOT fallback, support symlinked skills
- feat(icons): integrate official Huawei Cloud Icons library logo search
- fix(setup): auto-detect agent target, reject unknown agents, stop if none detected
- refactor(proxy): remove dead undici dependency, simplify importUndici
- chore: add ESLint and Prettier for JS/YAML/MD/JSON formatting and linting
- fix(proxy): WebSocketImpl is not a constructor - use class instead of arrow function
- fix: reset dev version to 1.0.1 and sync all manifests
- fix(release): run tag step before release PR creation to avoid tagging the wrong branch
- fix(release): configure git user before creating release PR
- fix(proxy): resolve 6 proxy-related issues from test report
- feat(release): replace release-please with custom counter-increment workflow
- fix(skills): document CCE field-by-field errors and Flyway SQL dialect trap (#125)
- fix: escape backslashes in pack-verify.mjs quote helper (#122)
- fix(sandbox): validate local_path before file upload, register upload tool in policy (#121)
- feat(huawei-sandbox): add chunked file upload primitive for local-to-sandbox transfer (#120)
- fix(release): pass RELEASE_PLEASE_TOKEN to release-please so its PR pushes trigger CI
- fix(release): rename publish workflow to npm-publish and use quoted step names
- feat(release): separate verification from publication with tag-gated manual publish
- fix(release): actually add checkout and setup-node to prerelease publish job
- feat: skill 按 check-user 三种 403 分支分别引导用户
- feat: check-user 同时返回实名/协议状态，skill 支持两项缺失一并告知
- fix(release): add checkout steps to prerelease publish job, disable component-in-tag
- fix(release): use release-please-action v4 tag instead of invalid SHA pin
- chore(release): adopt release-please, retire manual publish workflows, sync workbuddy manifest
- fix: 协议签署必须由用户明确同意，严禁 agent 自动代签
- test(dsh): isolate DSH_HOME in auth tests
- feat(dsh): add DeepSeek Harness target support
- feat(proxy): add HTTP/HTTPS proxy support for all outbound connections
- chore: bump version to 1.0.2-dev.10 (next 预发布)
- fix: sandbox 错误响应解析 traceId 驼峰字段名，统一描述字段为驼峰
- docs: fix README Node.js requirement, discussions badge link, and repo URL
- feat(routing): offer deployment targets with sandbox first for static sites
- refactor(sandbox): remove huaweicloud_sandbox_release tool
- refactor(auth): point AK/SK guide directly to IAM access keys page
- refactor(install): Chinese next-steps prompt
- feat(install): next-steps prompt with unified auth init first, then restart and doctor
- fix(huawei-sandbox): workspace dir is /workspace at filesystem root, not \C:\Users\sunzy/workspace
- feat(huawei-sandbox): clone projects into sandbox workspace dir, never /tmp
- fix(install-hcloud): append+dedupe user PATH via SetEnvironmentVariable instead of clobbering setx PATH
- feat(huawei-sandbox): hide tunnel/DevBridge details from developers, treat as internal implementation
- refactor(auth): simplify credential hints to plain auth init command
- fix(auth): route credential hints to unified auth init instead of KooCLI-only configure init
- feat(huawei-sandbox): DevBridge reverse proxy workflow - install, AK/SK login, expose, return URL, no local downgrade
- feat(skills): route deploy-a-repo prompts to sandbox, detect web apps and offer sandbox proactively
- feat(auth): add AK/SK acquisition guide (Chinese) to auth init
- refactor(auth): single 'Credentials synchronized' message instead of per-target sync details
- feat(huawei-sandbox): install Node.js from Huawei Cloud mirror when sandbox lacks it
- fix(auth): skip 0600 check on native Windows (no POSIX modes, avoids false warnings)
- feat(auth): verify 0600 on credential files, warn on WSL-mounted drives
- feat(huawei-sandbox): offer sandbox proactively for runtime tasks, hide agreement/DevBridge details (#58)
- Update CONTRIBUTING.md
- Update README.md
- Update README.zh-CN.md
- fix: publish-dev bump tolerates package.json already at base (no 'Version not changed' failure)
- fix: sync plugin manifest versions to 1.0.1 and harden publish.yml against version drift
- fix: clear install marker when MCP server loads so doctor stops false 'restart needed' warnings
- fix: write obsutilconfig in flat key=value format for KooCLI 7.x (#49)
- release 1.0.1
- (feat): add cd-production
- add publish release CI.
- feat: purge credential vault on full uninstall, safer auth init prompts (visible AK, hidden SK, default region cn-north-4)
- fix: use file:// URL for ws-exec dynamic import (Windows ERR_UNSUPPORTED_ESM_URL_SCHEME)
- feat: remove one-shot sandbox exec tool, document per-agent update commands
- feat: incremental update per agent + dev publish manifest sync + hdkit endpoint
- docs: update prerequisites for unified auth
- feat: unify Huawei Cloud auth across agents
- feat(huawei-obs): add single-file quick share workflow
- docs: update huawei-sandbox SKILL.md with check_user/sign_agreement tools and workflow
- fix: Codex MCP wiring - desktop uses ~/.codex/config.toml, CLI plugin adds cwd, uninstall cleans marketplace
- feat: merge sandbox MCP tools into huaweicloud-devkit server
- docs: add hook-rule-model.md required by structure tests
- ci: add publish-dev workflow (npm next) to main
- fix: resolve #25 WorkBuddy adaptation + doctor hardening
- fix: resolve issues #9, #11, #6 + update README + merge upstream/dev
- @ feat: add WorkBuddy platform support
- fix: resolve 4 issues from scenario testing (#8, #12, #13, #14)
- fix: resolve 4 issues from scenario testing (#8, #12, #13, #14)
- docs: add contributors section to readmes
- feat: add Sync to GitCode workflow
- ci(dev): add publish-dev workflow (npm next) consistent with mate dev
- docs: English-first README (README.md=en, README.zh-CN.md=zh)
- docs: bilingual README (zh + en), fix dead links
- docs: remove internal docs not suitable for public
- chore: keep only validation + governance workflows on public mirror
- chore: remove duplicate uppercase PR template, keep plugin lowercase one
- chore: remove GitCode sync, keep GitHub org mirror only
- Add status transition workflow
- Add GitCode sync workflow
- Add triage workflow
- Add CI workflow
- Add dependabot config
- Add PR template
- Add issue config
- Add feature template
- Add bug template
- Add code of conduct
- Add security policy
- Add contributing guide
- Add CODEOWNERS
- Add README
- chore(release): v1.0.0
- ci: allow partial mirror sync with per-target failure reporting
- ci: sync npm releases to huaweicloud org and GitCode mirrors
- test: update structure test for removed acceptKooCliPrivacy function
- fix(#74,#78,#80): Codex CLI detection and doctor self-check for Codex Desktop
- fix(#75): installCodexDesktop missing .mcp.json and .codex-plugin
- 移除 Claude Code 和 Cursor 市场入口，清理 README/INSTALL 中相关引用
- fix: harden hook safety checks
- fix(#74,#78,#80): Codex CLI detection and doctor self-check for Codex Desktop
- chore(release): v0.1.24
- fix(#75): installCodexDesktop missing .mcp.json and .codex-plugin
- chore: remove build artifact, internal docs, and test-report for open source
- docs: add opencode hook safety test guide
- feat: add huaweicloud hook safety checks
- docs: add governance files (SECURITY/OWNERS/CODEOWNERS/templates/dependabot/SUPPORT/editorconfig)
- fix(#77 follow-up): remove remaining auto-accept privacy agreement patterns
- fix(#77): replace auto-accept privacy agreement with interactive prompt
- docs: add CONTRIBUTING and CODE_OF_CONDUCT from dev
- fix(#73): cross-reference cloud-init bootstrap for SCP-blocked SSH
- fix: unique DDS/DCS warning headings for lint
- fix: merge adjacent blockquotes for lint
- fix: wrap ECS shell commands in code fence for lint
- fix: markdownlint blockquote; remove untracked local spec
- fix: markdownlint violations in dev-synced skill files
- chore: sync package.json version to 0.1.23 with dev
- fix: banner version, VPC multi-version warning, FunctionGraph ListRuntimes, SCP SSH guidance
- fix(#71): read CLI banner version from package.json at runtime
- chore: main_01 = dev functionality + main management
- fix: add flavor AZ-status trap warning, SCP 0.0.0.0/0 block guidance (#101)
- fix(#68): add flavor status filtering to flavors.md and create-instance.md
- fix: prevent Windows error dialog when checkHcloud encounters invalid executables
- fix: correct ECS skill parameter names and add JMESPath filtering guidance
- feat: add huaweicloud_setup_obs_config MCP tool to sync credentials from hcloud to OBS
- rename MCP server from huaweicloud to huaweicloud-devkit
- fix: support newline-delimited JSON transport for MCP protocol compatibility
- docs: add CONTRIBUTING and CODE_OF_CONDUCT
- ci(dev): refuse to publish formal versions as next
- test: make codearts hcloud detection test platform-aware
- fix: resolve markdownlint violations in merged skill files
- fix: BOM in plugin JSONs, Linux hcloud.exe detection
- chore: bump to v0.1.22
- fix: sync findHcloudBin with CodeArts test, update structure test
- chore(release): bump version to 0.1.21
- test: add huaweicloud-codearts-cleanup skill for CodeArts environment reset
- feat: add CodeArts Agent target with KooCLI sandbox and privacy handling
- chore(release): bump version to 0.1.20
- ci(dev): add Publish Dev (next) workflow
- ci(dev): publish huaweicloud-devkit@next prerelease from dev branch
- test: fix CodeQL incomplete-escaping finding in URL checks
- fix: correct OpenCode activation message — @ is Codex syntax, OpenCode auto-matches
- fix: resolve markdownlint violations in skill files, keep strict config
- feat: aggressive restart warning on install, doctor detects pending-restart marker
- chore: sync plugin manifests to v0.1.19
- style: relax markdownlint rules for content files
- chore(release): v0.1.18
- test: verify KooCLI Windows/Linux/macOS download URLs in cli-and-auth skill
- feat: Windows hcloud auto-install — download, unzip, add to PATH via PowerShell
- fix: E2E test fixes — EIP unbind cmd, keypair param, DNS table, image search guidance
- report: deploy-to-website E2E test - 7 issues (P0: windows hcloud auto-install, MCP restart; P1: image search, DNS docs, cmd params, EIP cleanup)
- fix: --target codex now errors when Codex CLI missing; --target all gracefully skips
- chore: remove last 暂用于测试 label from README
- closes #45: rename npm package from huaweicloud-devkit-test to huaweicloud-devkit
- feat(ecs): add Prerequisites section + update SOP for 'from zero' flow
- fix(#61): add DNS params to CreateSubnet — prevent cloud-init silent failure
- docs(AGENTS): note npm version only bumps package.json, need to sync 3 plugin manifests
- fix(ci): bump plugin manifest versions to 0.1.17
- chore: bump to v0.1.17
- fix(RDS skill): 3 improvements from RDS MySQL 8.0 end-to-end test
- fix(#49, #50): uninstallCodexDesktop was defined but never called — orphan cleanup
- fix(#57): enable agent to accept KooCLI privacy agreement on user's behalf
- fix(#57): 7 fixes — OBS exit codes, ACL docs, auth detection, error codes
- docs(AGENTS): codify three-class parameter value rule
- refactor(#59): replace UNNECESSARY hardcoded values with placeholders
- fix(#59): correct 2 WRONG hardcoded values
- refactor(#59): remove ELB coverage claim from VPC skill
- fix(#60 follow-up): 3 missed locations from original analysis
- fix(#60): correct IMS __isregistered value + EIP quota wording
- fix(uninstall): cleanup commands/ directory on uninstall
- fix(vpc): add missing --subnet.gateway_ip required param to CreateSubnet template
- fix(vpc): add SYS.0403 SCP denial to troubleshooting table
- fix(ecs): add user_data/cloud-init mechanism + HTTP verification to create-instance
- fix(ecs): remove hardcoded flavor names from Flavor Selection Guide
- fix: remove hardcoded parameter values violating --help discovery principle
- fix(#52): EIP AssociatePublicips uses PORT type + port ID, not ecs
- chore: bump version to 0.1.16
- fix(#43): add non-interactive credential setup for Agent/CI environments
- fix(getting-started): add privacy policy acceptance step to KooCLI first-time setup
- fix(cce): #46 KooCLI OPENAPI_ERROR note, #47 CreateKubeConfig→CreateKubernetesClusterCert, #48 SWR IAM permission prerequisite
- chore: bump version to 0.1.15
- fix(issues36-40): APIG event format, IAM Agency, RDS dotted/password, EIP type, URN warning
- revert: remove auth modes table, keep original AKSK-only approach
- fix(cli): mark auth modes agent-safe vs user-only to avoid AK/SK leakage
- feat(cli): add 5 auth modes, output formatting, and KooCLI error types from external skill
- chore: bump version to 0.1.14
- fix(#25): add marketplace-sourced references for OBS, FunctionGraph, VPC, IAM
- refactor: port find-skills search to Node.js — zero dependencies, no Python required
- feat: add huaweicloud_search_marketplace MCP tool (Node.js port of find-skills, no Python required)
- feat(#25): upgrade RDS skill to match marketplace quality — command tables, parameter refs, backup/recovery, diagnosis, mutating ops list
- fix(#25): add ECS troubleshooting and OBS common-pitfalls references from real test findings
- fix(#26): expand VPC and IAM reference files based on real test findings
- closes #26: fixed 7 skill files — Critical Warnings, h2 headings, expanded short skills, troubleshooting content
- fix(#26): add Critical Warnings to 4 skills, expand 3 short skills, fix h2 headings, add troubleshooting ref content
- closes #35: V5 serverless test bugs #10-#18 all fixed in safety-policy + APIG + VPC skills
- fix: V5 serverless test — risk preservation, APIG params/status/sl_domain, VPC nested prefix
- feat: chain install -> hcloud check -> install-hcloud guide
- feat: add install-hcloud command with per-platform install guides from official docs
- docs: fix README skill count (26 not 27, 6 meta-skills not 7), fix opencode reference config
- chore: bump version to 0.1.13
- fix(issue34): 8 bugs from V3 FunctionGraph+APIG+OBS test report
- feat: enrich 9 template-level skills with verified operation names
- chore: bump version to 0.1.12
- fix(issue32): installer auto-detect, doctor package name, RDS skill overhaul
- fix(issue31): 7 defects — wrong service/operation names and param structures
- fix: add IAM permission disclaimer to get_regional_availability output
- fix: doctor authCheck also use HCLOUD_BIN (follow-up to #22)
- fix: add APIGW.0802 region permission error to explain_error and ECS troubleshooting
- fix: install-codex-local.ps1 marketplace name from JSON + error handling
- docs(agents): add gotchas from issue fixing — HCLOUD_BIN, obsutil, ACL, Invoke, marketplace
- fix(obs): BUG-1 add object ACL step to static website workflow, BUG-2/3 improve OBS credential guidance
- chore: bump version to 0.1.11
- fix: #21 marketplace name from JSON, #22 doctor respects HCLOUD_BIN
- fix: classify Invoke/Execute/Trigger/Deploy as write ops, add APIG cascade delete note
- docs: add update and uninstall commands to README
- ci: add test matrix with OS, CPU arch, and Node versions
- chore: remove outdated design doc 04-secret-safety-hook.py
- chore: bump version to 0.1.10
- fix: resolve issues #12 #15 #16 #17
- feat(installer): add --target codex-desktop support for Codex Desktop agent
- fix: issue #8 — OBS safety prefixes, obsutil auth note, -f and -flat gotchas
- fix: SKILLS_ROOT path, obsutil safety, execution classification, OBS ops, jsonc support, cwd, FG traps
- docs: use test package name with --yes flag in install commands
- test: add functiongraph round test report under ssy
- docs: rewrite README in AWS agent-toolkit style
- fix: resolve issue #5 — D1 D3 D4 D5 (search tokenizer, region cache, approved risk label, stdout error parsing)
- chore: bump version to 0.1.9
- chore: bump version to 0.1.5
- fix(mcp): fix 7 MCP server bugs from test reports
- fix(ci): move hashFiles from job.if to step.if in cd-staging
- fix(obs): rewrite SKILL.md with obsutil-style commands, add static website workflow
- chore: bump to v0.1.18
- fix: prevent AK/SK in shell history — mark hcloud configure set as DANGEROUS, prefer init
- test: verify KooCLI Windows/Linux/macOS download URLs in cli-and-auth skill
- feat: Windows hcloud auto-install — download, unzip, add to PATH via PowerShell
- docs: document the two-step release workflow
- fix: E2E test fixes — EIP unbind cmd, keypair param, DNS table, image search guidance
- report: deploy-to-website E2E test - 7 issues (P0: windows hcloud auto-install, MCP restart; P1: image search, DNS docs, cmd params, EIP cleanup)
- fix: --target codex now errors when Codex CLI missing; --target all gracefully skips
- chore: remove last 暂用于测试 label from README
- closes #45: rename npm package from huaweicloud-devkit-test to huaweicloud-devkit
- feat(ecs): add Prerequisites section + update SOP for 'from zero' flow
- fix(#61): add DNS params to CreateSubnet — prevent cloud-init silent failure
- docs(AGENTS): note npm version only bumps package.json, need to sync 3 plugin manifests
- fix(ci): bump plugin manifest versions to 0.1.17
- chore: bump to v0.1.17
- fix(RDS skill): 3 improvements from RDS MySQL 8.0 end-to-end test
- fix(#49, #50): uninstallCodexDesktop was defined but never called — orphan cleanup
- fix(#57): enable agent to accept KooCLI privacy agreement on user's behalf
- fix(#57): 7 fixes — OBS exit codes, ACL docs, auth detection, error codes
- docs(AGENTS): codify three-class parameter value rule
- refactor(#59): replace UNNECESSARY hardcoded values with placeholders
- fix(#59): correct 2 WRONG hardcoded values
- refactor(#59): remove ELB coverage claim from VPC skill
- fix(#60 follow-up): 3 missed locations from original analysis
- fix(#60): correct IMS __isregistered value + EIP quota wording
- fix(uninstall): cleanup commands/ directory on uninstall
- fix(vpc): add missing --subnet.gateway_ip required param to CreateSubnet template
- fix(vpc): add SYS.0403 SCP denial to troubleshooting table
- fix(ecs): add user_data/cloud-init mechanism + HTTP verification to create-instance
- fix(ecs): remove hardcoded flavor names from Flavor Selection Guide
- fix: remove hardcoded parameter values violating --help discovery principle
- fix(#52): EIP AssociatePublicips uses PORT type + port ID, not ecs
- chore: bump version to 0.1.16
- fix(#43): add non-interactive credential setup for Agent/CI environments
- fix(getting-started): add privacy policy acceptance step to KooCLI first-time setup
- fix(cce): #46 KooCLI OPENAPI_ERROR note, #47 CreateKubeConfig→CreateKubernetesClusterCert, #48 SWR IAM permission prerequisite
- chore: bump version to 0.1.15
- fix(issues36-40): APIG event format, IAM Agency, RDS dotted/password, EIP type, URN warning
- revert: remove auth modes table, keep original AKSK-only approach
- fix(cli): mark auth modes agent-safe vs user-only to avoid AK/SK leakage
- feat(cli): add 5 auth modes, output formatting, and KooCLI error types from external skill
- chore: bump version to 0.1.14
- fix(#25): add marketplace-sourced references for OBS, FunctionGraph, VPC, IAM
- refactor: port find-skills search to Node.js — zero dependencies, no Python required
- feat: add huaweicloud_search_marketplace MCP tool (Node.js port of find-skills, no Python required)
- feat(#25): upgrade RDS skill to match marketplace quality — command tables, parameter refs, backup/recovery, diagnosis, mutating ops list
- fix(#25): add ECS troubleshooting and OBS common-pitfalls references from real test findings
- fix(#26): expand VPC and IAM reference files based on real test findings
- closes #26: fixed 7 skill files — Critical Warnings, h2 headings, expanded short skills, troubleshooting content
- fix(#26): add Critical Warnings to 4 skills, expand 3 short skills, fix h2 headings, add troubleshooting ref content
- closes #35: V5 serverless test bugs #10-#18 all fixed in safety-policy + APIG + VPC skills
- fix: V5 serverless test — risk preservation, APIG params/status/sl_domain, VPC nested prefix
- feat: chain install -> hcloud check -> install-hcloud guide
- feat: add install-hcloud command with per-platform install guides from official docs
- docs: fix README skill count (26 not 27, 6 meta-skills not 7), fix opencode reference config
- chore: bump version to 0.1.13
- fix(issue34): 8 bugs from V3 FunctionGraph+APIG+OBS test report
- feat: enrich 9 template-level skills with verified operation names
- chore: bump version to 0.1.12
- fix(issue32): installer auto-detect, doctor package name, RDS skill overhaul
- fix(issue31): 7 defects — wrong service/operation names and param structures
- fix: add IAM permission disclaimer to get_regional_availability output
- fix: doctor authCheck also use HCLOUD_BIN (follow-up to #22)
- fix: add APIGW.0802 region permission error to explain_error and ECS troubleshooting
- fix: install-codex-local.ps1 marketplace name from JSON + error handling
- docs(agents): add gotchas from issue fixing — HCLOUD_BIN, obsutil, ACL, Invoke, marketplace
- fix(obs): BUG-1 add object ACL step to static website workflow, BUG-2/3 improve OBS credential guidance
- chore: bump version to 0.1.11
- fix: #21 marketplace name from JSON, #22 doctor respects HCLOUD_BIN
- fix: classify Invoke/Execute/Trigger/Deploy as write ops, add APIG cascade delete note
- docs: add update and uninstall commands to README
- ci: add test matrix with OS, CPU arch, and Node versions
- Revert "test: add functiongraph round test report under ssy"
- chore: remove outdated design doc 04-secret-safety-hook.py
- chore: bump version to 0.1.10
- fix: resolve issues #12 #15 #16 #17
- feat(installer): add --target codex-desktop support for Codex Desktop agent
- fix: issue #8 — OBS safety prefixes, obsutil auth note, -f and -flat gotchas
- fix: SKILLS_ROOT path, obsutil safety, execution classification, OBS ops, jsonc support, cwd, FG traps
- docs: use test package name with --yes flag in install commands
- test: add functiongraph round test report under ssy
- test: move functiongraph report out of main
- docs: rewrite README in AWS agent-toolkit style
- test: keep only functiongraph report under ssy; remove reports for other plugin
- test: add ssy round test reports (ecs-purchase/obs-deploy/functiongraph)
- fix: resolve issue #5 — D1 D3 D4 D5 (search tokenizer, region cache, approved risk label, stdout error parsing)
- chore: bump version to 0.1.9
- chore: bump version to 0.1.5
- fix(mcp): fix 7 MCP server bugs from test reports
- fix(ci): move hashFiles from job.if to step.if in cd-staging
- fix(obs): rewrite SKILL.md with obsutil-style commands, add static website workflow
- chore: sync plugin manifest versions to 0.1.4
- feat: enhance huawei-cce with SWR/CCI, enrich huawei-vpc EIP workflows, add Flexus to ECS
- chore: v0.1.4
- chore: sync version to v0.1.3
- fix: hashFiles not supported in job if, move to step check
- chore: bump to v0.1.2 for npm publish test
- chore: rename npm package to huaweicloud-devkit-test, remove redundant workflow
- fix: remove invalid image params, add doctor command, improve install UX
- ci: add GitHub Actions workflow for npm package publishing
- docs: add 4-step --help workflow, --cli-jsonInput tip, DEDICATEDGATEWAY json input example
- refactor: merge huawei-cloud-find-skills into capability-discovery, remove Python dependency
- docs: add skill design principles to AGENTS.md
- refactor: add --help discovery to all 16 service skills, fix bloated find-skills
- fix(apig): remove non-existent --eip_id param from AddIngressEipV2 example (N1)
- fix(apig): add CreateInstanceV2 + EIP binding guidance; fix PublishApiV2 -> BatchPublishOrOfflineApiV2
- style: fix trailing space in find-skills SKILL.md
- chore(release): v0.1.1
- chore: sync local changes
- fix(functiongraph): add inline demo, zip -j flattening, DEDICATEDGATEWAY pre-flight checklist
- chore: sync local changes
- fix: unify auth guidance, add FG/APIG IAM policies, document MCP path issue
- ci(release): bump via PR + publish via tag (no branch bypass needed)
- ci(release): push using PAT owner username instead of x-access-token
- refactor(functiongraph): shift from hardcoded parameters to --help discovery pattern
- fix(functiongraph): correct APIG trigger param names, add IAM permissions, code_filename path note
- chore: sync local changes
- ci: use ubuntu-24.04 runner to avoid hosted pool outage
- ci(release): add push token identity diagnostics
- ci(release): fix YAML syntax in gh-release tag_name
- ci(release): use RELEASE_PLEASE_TOKEN for protected main push
- chore: add .clawhub/ to gitignore
- feat: add marketplace skill discovery and update docs
- ci(release): push via PAT for protected main
- docs: add known issues from FunctionGraph deployment testing (R1-R3)
- fix(functiongraph): fix IAM op name, add DeleteFunction :latest gotcha, add refs precedence note
- refactor(functiongraph): slim SKILL.md from 457 to 93 lines, split details into references/
- fix(functiongraph): fix InvokeFunction body param, trigger event_data format, add project_id guide and response version docs
- ci(release): replace release-please with manual release workflow
- fix(functiongraph): correct service name, operation names, required params, add code deployment guide and end-to-end workflow
- ci(release): prefer PAT token with GITHUB_TOKEN fallback
- ci: add CI/CD and release pipeline
- docs: update README
- docs: gap analysis v3 — design blueprint fully delivered
- feat: add 14 new skills (APIG, Billing, CBR, CCE, CloudEye, CTS, DDS/DCS, Deployment, FunctionGraph, GaussDB, GettingStarted, ModelArts, RDS, SMN/DMS, WAF/AAD) and rules
- docs: update AGENTS.md for meta+service skill architecture
- docs: update design vs implementation gap analysis to v2
- chore: update docs, skills, tests, and plugin configs
- feat: add Claude/Cursor plugin configs, new skills (DEW/ECS/IAM/OBS/VPC), and update core tools
- docs: add AGENTS.md with project conventions and agent guidance
- feat: add project structure, plugins, integrations, and docs
- fix: remove BOM marker from docs
- docs: update design docs
- docs: Huawei Core 设计审查报告 v1 + v2
- docs: huawei-core plugin system design
- Initial commit

## 1.1.3 (2026-09-11)

- chore: advance main to 1.1.3-next.4 (business keeps dev; prepare stable 1.1.3) (#619)
- test(update-check): decouple upgrade-tag logic from repo package.json version
- chore(release): 1.1.2
- test: resolve structure.test.mjs to dev version (union-merge artifact)
- chore(release): 1.1.1 (#515)
- chore: merge dev into main for 1.1.1 stable release (#513)
- chore: add dsh.bundle manifest for DSH plugin ecosystem
- chore(release): 1.1.0 (#440)
- chore: merge dev into main for 1.1.0 release (#438)
- chore: version override for 1.1.0 stable release (#433)
- docs: add Huawei Cloud npm mirror recommendation for China users
- chore(release): 1.0.2
- style: prettier format fix
- feat: v1.0.2 stable - merge all dev changes
- fix(release): update release trigger to workflow_dispatch and main push only
- feat(release): sync release workflow to main, seed manifest with 1.0.1
- fix(release): retire the live Publish Dev workflow on main
- fix(release): restore full publish flow with quoted step names
- fix(release): probe publish job with environment only
- fix(release): probe without job outputs and needs.outputs wiring
- fix(release): restore full tag-gated publish logic
- fix(release): reduce npm-publish workflow to minimal probe
- fix(release): drop workflow_dispatch inputs, derive dist-tag from the tag version
- fix(release): rename publish workflow to npm-publish to recover a fresh workflow_dispatch index
- fix(release): add pack-verify script to main
- fix(release): sync ci.yml with pack verification to main
- fix(release): add tag-gated Publish workflow to main so workflow_dispatch works from tags

## 1.1.3-next.4 (2026-09-10)

- fix: 受限网络下升级检测静默失败——checkForUpdate 改 fetch registry + 15s 超时 + DEBUG 日志 (#612) (#613)
- ci: trigger CI on push to dev (#501) (#605)

## 1.1.3-next.3 (2026-09-10)

- fix(safety): cover Nova*/Reset* destructive ops in hook risk rules (#501) (#594)
- fix(auth): resolve KooCLI config from homedir, not HUAWEICLOUD_HOME (#501) (#595)
- docs(iac): remove deposit (保证金) guidance - vouchers no longer require a deposit
- chore(docs): remove committed superpowers plan doc (already gitignored) (#501) (#599)
- fix(deps): override smol-toml to 1.8.0 to clear npm audit high vuln (#501)

## 1.1.3-next.2 (2026-09-09)

- feat(install): interactive zero-detection install menu + generic MCP wiring (#592)

## 1.1.3-next.1 (2026-09-09)

- style: prettier-align credential priority tables in README (#520)
- fix(auth): skip S2 fingerprint drift when KooCLI authEncrypt stores ciphertext (#533)
- docs: align README credential docs with SKILL.md - priority, auth_switch, env security warning (#520)
- fix(mcp): allow maxRetries 0 in numeric arg validation (#530)
- fix(mcp): reject invalid numeric args (timeoutMs/maxRetries) instead of silently ignoring (#530)
- docs: replace static beta version badge with npm version badge (#530)
- docs(obs): mb return-code trap and website endpoint propagation delay (#485)
- test(update-check): decouple upgrade-tag logic from repo package.json version

## 1.1.3-next.0 (2026-09-09)

- chore: set version-override to 1.1.3 (next -> 1.1.3-next.0) (#588)

## 1.1.2-next.8 (2026-09-09)

- feat(rev4): send X-HW-Client-Version; SKILL wording; remove unreachable cmdUpdate reinstall (#586)
- feat(setup): unix auto-install, hermes restart hint, grouped status; docs: sandbox_credentials example (#265, #280)
- feat(telemetry): classify cursor-vscode and officeace-agent MCP client names

## 1.1.2-next.7 (2026-09-09)

- fix(skills): correct cli-domain-id root cause — it signals invalid credentials, not a missing domain-id (#574)

## 1.1.2-next.6 (2026-09-09)

- style: prettier table alignment (#574)
- docs(voucher): drop in-flow domain-id discovery detail from test-env note (#574)
- fix(skills): teach agents to self-discover cli-domain-id via STS GetCallerIdentity (#574)
- docs(iac): verified traps from 2026-09-08 e2e report - keypair/RDS/DCS/EIP-quota/long-args/destroy-alignment
- docs(sandbox): index.html platform-overwrite symptom, recovery, and prevention (#263)
- feat(auth): complete non-interactive guidance and detect existing KooCLI profile in auth init (#260)

## 1.1.2-next.5 (2026-09-09)

- fix: clarify devkit version output
- docs: note mirror-lag fallback to official registry (#518)
- style: add trailing newline to hook-plugin test
- fix(auth): spawn hcloud without shell in project-id resolution
- feat(auth): validate credentials before sandbox injection + auto-set project_id (#259, #262)
- feat(telemetry): route telemetry upload through proxy
- feat(telemetry): classify MCP client names to canonical agent harness
- fix(telemetry): regenerate userHash after credential switch
- fix(telemetry): bound hcloud capture and isolate failed event retries

## 1.1.2-next.4 (2026-09-08)

- fix codex install auth probe and safety hook

## 1.1.2-next.3 (2026-09-08)

- test: align sandbox warning assertion with unified codearts wording (#261)
- style: prettier format for hcloud-cli obs hint
- style: prettier format for hermes skills snapshot
- fix(setup): unify CodeArts sandbox warning with accurate settings path (#261)
- feat(hermes): add skills snapshot for one-shot bulk install
- fix(iac): manifest-first batch approval, verified timer schedule, OBS plan hint
- chore: add mcpName field to package.json (#543)
- fix(dew): distinguish auto-rotation enable vs RotateSecret trigger
- fix(dew): CSMS CreateSecret uses --name, not --secret_name
- test: add versionMismatch assertions for runVersionCheck
- feat: pin KooCLI version and align skills with KooCLI 7.2.12

## 1.1.2-next.2 (2026-09-08)

- fix(release): make create-release-pr path helpers idempotent (#537)
- docs: remove Cursor section from README
- feat(mcp): add remote (Streamable HTTP) transport mode (#531)
- docs: clarify Cursor marketplace status (not yet listed)
- docs: document Cursor Directory support alongside other agents
- docs: move Cursor Directory section below Documentation
- fix: use agent-neutral wording for KooCLI config-write failure hint

## 1.1.2-next.1 (2026-09-08)

- fix(release): bump version override to 1.1.2 for next preview line (#527)
- feat(update): session-level version update detection & auto-upgrade (#525)
- chore: sync root plugin.json version to 1.1.1-next.16
- chore: address Cursor marketplace PR review feedback
- style: add trailing newline to plugin.json and mcp.json
- chore: add Open Plugins manifest for Cursor marketplace

## 1.1.1-next.16 (2026-09-07)

- fix(skills): deposit prompt cites official FAQ links (frozen deposit explanation + amount rules)
- style: prettier re-align huawei-iac stage-5 table
- fix(skills): deposit prompt includes recharge portal link (balanceRecharge)
- fix(skills): deposit prompt includes amount range (约 1~5 元人民币不等)
- chore(skills): bootstrap Node template bumped to v22.14.0 LTS
- fix(skills): bootstrap Node template must match instance arch (arm64 vs x64)
- fix(safety+skills): web-port rule false-positive, China mirrors, keypair import flow, E2E report findings
- fix(skills): huawei-iac stage order - inspect code before offering options; scale and hosting are separate questions
- fix(skills): huawei-iac stage-3 architecture decision points must be surfaced
- fix: repair Python hook indentation and update stale DSH/telemetry tests
- fix(telemetry): unref flush interval so tests don't hang the process
- fix(workbuddy): remove hooks field from plugin manifest to pass validate
- fix: resolve eslint and prettier errors reported by PR #500 CI
- feat(telemetry): encode install dir into harness fallback for unknown agents
- fix(openclaw): match openclaw via install path and native mcp config
- fix(package): include integrations/atomcode in npm pack
- feat(atomcode): add telemetry hook for Skill/CLI/MCP tracking
- feat: expand agent registry from 13 to 23 agents
- refactor: agent detection to table-driven registry pattern
- fix: add OfficeAce harness detection and version identification
- fix: restrict MCP keepalive to Hermes-on-Windows only, exit on stdin close for other agents
- fixE: include integrations/hermes in npm publish files
- feat(telemetry): fix harness/agentVersion detection and move telemetry hook to integrations
- fix: add integrations/workbuddy to npm files list
- feat(workbuddy): integrate telemetry hook deployment into setup-cli.mjs
- refactor(skill-tracker): remove CLI wrapper file, use single function-as-object pattern
- fix(skill-tracker): prevent duplicate hook capture in IDE mode
- fix(skill-tracker): restore CLI entry wrapper file and setup-cli install logic
- chore: fix Unicode arrow encoding in skill-tracker comments
- refactor(skill-tracker): merge into single file using function-as-object pattern
- refactor(skill-tracker): unify IDE and CLI hook plugins into shared core
- fix(telemetry): prevent duplicate DAU events on same-day process restart
- fix(setup): preserve user-customized MCP args and env during CodeArts register
- fix(telemetry): simplify checkDauPing to handle stamp deletion edge case
- refactor(telemetry): defer install stamp write to successful event delivery and remove trackInstall from setup CLI
- feat(dsh): add Cordis hook plugin for telemetry interception
- revert(dsh): remove skill tracking from Python hook and hooks copying
- feat(telemetry): add skill retrieve tracking to Python hook
- fix(telemetry): remove duplicate ideVersion declaration
- feat(telemetry): detect DSH version from npm global package
- revert(dsh): remove endpoint env var reading from dshPatchBlock
- fix(dsh): support --hdkitservice-endpoint and --telemetry-endpoint CLI args
- feat(dsh): install skill-tracker.js hook for DSH agent
- fix(telemetry): use URL.pathname instead of fileURLToPath for path detection
- fix(telemetry): use file path to detect harness, remove vscode fallback
- fix(telemetry): fix harness and version detection priority
- fix(telemetry): PLUGIN_VERSION reads undefined PLUGIN_DIR
- refactor(telemetry): move agent-specific data into agent install directories
- fix(telemetry): fix agent_version reporting wrong IDE version
- fix(telemetry): use import.meta.url to detect agent harness in hook
- fix(telemetry): detect agent harness by env vars only, remove disk-based check
- fix: skill-tracker detectHarness 新增 .codeartsdoer 目录检测，解决 plugin 加载早于 MCP 导致检测为 unknown
- refactor: dau-stamp/first-use-stamp/hook-events/dev-log 全部下沉到 agent 子目录
- fix: flushEvents 中残留的 INSTALL_STAMP 引用导致 ReferenceError，事件每 60s 重试
- fix: ensureDir 支持创建 agent 子目录，writeTextFile/touchFile 自动创建父目录
- refactor: install-stamp/counter 改用 agent 子目录隔离
- refactor: install-stamp/counter 改为按 agent 隔离，支持多 agent 独立安装上报
- fix: 各 install 函数调用 trackInstall() 确保 plugin:install 事件在每次安装后触发
- feat: 完善 CodeArts 遥测支持 — skill/CLI 事件捕获与安装脚本同步
- fix(telemetry): restore writeEvent function accidentally removed in skill filter commit
- fix(telemetry): filter non-Huawei Cloud skills from skill:retrieve events
- fix(telemetry): extract DAU check to standalone function, call from 60s timer to ensure cross-day reporting when idle
- fix(telemetry): anchor hcloud regex to command start to avoid false positives in quoted strings
- chore: add startopencode.bat to .gitignore
- chore: remove sync-opencode.ps1 from remote, add to .gitignore
- refactor(telemetry): rewrite skill-tracker hook for 3-channel coverage, fix input.tool_name bug, clean up orphaned files
- feat(telemetry): add event telemetry system with install counter and crash safety

## 1.1.1-next.15 (2026-09-07)

- feat(auth): 凭证一致化整改 — reconcile / R7 current档 / R9 会话优先 / R10 runtime守卫 (#498)

## 1.1.1-next.14 (2026-09-05)

- feat: detect new plugin versions on install/update

## 1.1.1-next.13 (2026-09-05)

- feat(uninstall): optional KooCLI/OBS cleanup on global uninstall
- feat: add `version` command reporting installed plugin version per agent
- feat(skills): add huawei-iac orchestration skill for multi-resource provisioning

## 1.1.1-next.12 (2026-09-04)

- fix: repair DSH bundle patch loading and MCP path resolution

## 1.1.1-next.11 (2026-09-04)

- style: wrap over-width line in validate-package.mjs
- fix: publish cordis.patch.yml referenced by dsh.bundle.patch

## 1.1.1-next.10 (2026-09-04)

- chore: retry CI (#479)
- chore: retry CI (#479)
- chore: retry CI (#479)
- fix(auth): prefer auth-init creds over injected STS env creds (#479)
- fix: skip npm audit/fund when installing plugin runtime deps
- test: scope node --test to actual test files

## 1.1.1-next.9 (2026-09-04)

- feat: add DSH post-install guidance for KooCLI and credentials setup
- fix(dsh): maintain existing state after legacy block cleanup
- fix: move createRequire after all imports, remove shebang, format
- refactor: remove better-sqlite3, auto-setup DSH via bundle patch

## 1.1.1-next.8 (2026-09-03)

- feat: 安装提示补充由 AI 助手转达代金券的指令

## 1.1.1-next.7 (2026-09-03)

- feat: 安装完成提示首次使用可领取华为云代金券
- docs(sandbox): find real build output dir across the whole project (#247)

## 1.1.1-next.6 (2026-09-02)

- Revert "fix(ecs): change preflight SG check from hard-deny to require_user_confirmation (#468)" (#470)

## 1.1.1-next.5 (2026-09-02)

- fix(ecs): change preflight SG check from hard-deny to require_user_confirmation (#468)
- chore: add dsh.bundle manifest for DSH plugin ecosystem

## 1.1.1-next.4 (2026-09-02)

- fix(ecs): fix preflightSecurityGroupCheck regex and query parameter format (#443) (#464)

## 1.1.1-next.3 (2026-09-02)

- feat(ecs): auto-check security group rules during plan phase (#443) (#462)
- fix: use CodeArts Work native MCP format (mcp key, command array, environment) (#461)

## 1.1.1-next.2 (2026-09-02)

- docs: voucher_status 工具描述内嵌主动提示行为指令
- fix(detect): handle unquoted outDir in VitePress config
- fix(sandbox): clean URL support for static nginx + cross-arch build guidance
- fix(release): use JS filter instead of shell glob for tag lookup

## 1.1.1-next.1 (2026-09-02)

- docs: 强化 huawei-voucher skill 主动提示准则与话术

## 1.1.1-next.0 (2026-09-02)

- chore: set version override to 1.1.1 for next preview release
- fix(sandbox): credential injection, nginx cleanup, and auto git clone
- fix(ecs): add security group reuse warning to Critical Warnings (#444)
- docs: add beta badge to Chinese README (#442)
- fix: include atomcode in skills root and report openclaw auth status
- docs: update beta badge version to v1.1.0 (#431)

## 1.1.0-next.21 (2026-09-01)

- fix(sandbox): auto-detect cross-platform from project files for QR check
- fix(sandbox): restrict QR auto-generation to cross-platform projects only
- docs: add beta badge to README (#428)
- fix(sandbox): always auto-generate QR code regardless of frameworkType

## 1.1.0-next.20 (2026-09-01)

- fix(sandbox): auto-generate QR code in deploy_check for cross-platform projects
- feat(cli): replace string matching with token-based plan-run approval (#421)

## 1.1.0-next.19 (2026-09-01)

- feat(cli): save large hcloud output to file and return path (#416)
- fix(sandbox): always run QR code check in deploy_check regardless of frameworkType
- fix(rds): correct ARM volume type from ULTRAHIGH to CLOUDSSD (#5) (#417)
- fix(safety): add STS credential exposure warning rule (#10) (#418)
- fix(safety): add rule to warn on all Delete/Detach/Remove cloud operations (#413)
- fix(auth): sync KooCLI hcloud config on auth sync (#411)
- fix: remove UTF-8 BOM from files
- fix: remove UTF-8 BOM from files
- style: prettier format fix
- style: prettier format fix
- feat: add HC activity ECS+Nginx deployment workflow reference doc
- feat: add HC activity ECS+Nginx deployment workflow to huawei-ecs skill
- style: prettier reformat huawei-vpc SKILL.md tables (#394)
- fix(vpc): correct subnet DNS addresses per region (#394)

## 1.1.0-next.18 (2026-09-01)

- docs(sandbox): fix source parameter value typos (#376)
- fix(sandbox): deploy_check captures all statuses + returns tunnel URL (#412)
- fix(hcloud): auto-accept privacy agreement on first use
- fix(safety): prevent false-positives in destructive-delete rule and approvedCommand
- docs(sandbox): scope GitCode SSL workaround to one-shot clone (#374)
- fix: retry npm install on any failure and exit non-zero when it fails (#244)
- fix: add codex desktop skills dir to resolveSkillsRoot fallback chain (#170)

## 1.1.0-next.15 (2026-08-31)

- feat: add codearts-work (CodeArts Space) agent target support (#387)
- fix(sandbox): default deploy_nginx config_name from 'app' to project name

## 1.1.0-next.14 (2026-08-31)

- test: update hdkitservice error message assertion to match new format
- fix: deploy_nginx auto-assign free port + SSR runtime env var injection
- fix: port conflict detection in deploy_nginx + SKILL.md docs
- fix(hdkitservice): improve credential and error diagnostics
- fix: batch fixes for deploy issues #15 #16 #5 #2 #22 #23
- fix(hcloud): add runtime path discovery for hcloud binary
- fix(sandbox): graceful nginx restart with orphan worker recovery
- fix(sandbox): move large_client_header_buffers to server level, harden port equality guard, add credential dev_stage_id fallback
- style: apply Prettier formatting
- fix(sandbox): prevent port conflicts, stale content, and header buffer errors in SSR deployments

## 1.1.0-next.13 (2026-08-31)

- fix: scope MCP keepalive to after stdin close only (#361)

## 1.1.0-next.12 (2026-08-31)

- fix: correct broken CLI commands in billing/vpc/dew skills (#358)
- feat: add installCommand to search_marketplace results (#353)

## 1.1.0-next.11 (2026-08-29)

- fix(hermes): fix uninstall order, config.yaml residue, and allowlist cleanup (#343)

## 1.1.0-next.10 (2026-08-29)

- fix: prevent MCP server silent exit on Windows when stdin is closed (#340)

## 1.1.0-next.9 (2026-08-28)

- fix(sandbox): nginx cleanup, try_files, reload, config_name
- docs: add Codex install section to README
- fix(sandbox): git archive prefix, symlink resolve, permission hardening
- fix(sandbox): add build failure response rules to prevent silent auto-fixes
- feat(sandbox): deploy_check tool, deploy_nginx nextStep, REQUIRED markers
- style: remove unused escapedConfig variable
- feat(sandbox): add sandbox_deploy_nginx tool + permission auto-fix
- fix(sandbox): merge Step 8 QR into Step 7, add deployment completion checklist
- style: prettier format SKILL.md blank lines
- fix(sandbox): optimize deploy flow - permissions, credentials, env detection, tunnel cleanup
- fix(sandbox): pkill devbridge before tunnel creation to prevent zombies
- fix(sandbox): use git archive for git repos to exclude all untracked/ignored files
- fix(sandbox): post-build output verification, Node v24 native module guidance
- fix(sandbox): health-check tunnel URL before returning, auto-retry on failure
- fix(sandbox): save QR to outputDir for nginx serving, drop ANSI qrencode
- docs: add Hermes uninstall notes for Linux and Windows
- style: fix ESLint catch-error-name and prettier
- chore: bump version to 1.1.0-next.8
- docs: add Hermes MCP Python SDK note to README
- fix(hermes): auto-install MCP Python SDK to fix silent tool discovery skip

## 1.1.0-next.6 (2026-08-27)

- feat: 代金券能力可发现化，新增 huawei-voucher skill 与路由
- fix(sandbox): add DevBridge quota auto-recovery, pre-cleanup, Taro build 900s timeout
- fix(sandbox): add DevBridge quota auto-recovery, pre-cleanup, Taro build 900s timeout
- fix(sandbox): add .swc/dist exclusion, post-upload permission fix, PNG QR priority, cross-platform 600s timeout
- fix(sandbox): add build timeout recovery, env injection, OS detection, dependency exclusion for upload
- fix(sandbox): add build timeout recovery, env injection, OS detection, dependency exclusion for upload

## 1.1.0-next.5 (2026-08-27)

- fix: voucher 工具 domain_id 参数标注为可选，避免 Agent 误判为必传 (#308)
- style: rename catch parameter err to error for unicorn/catch-error-name rule
- fix(sandbox): add retry for upload batch/tunnel failures, add process persistence and cross-platform warnings

## 1.1.0-next.4 (2026-08-27)

- fix(release): stop auto-deleting .version-override in create-release-pr

## 1.1.0-next.3 (2026-08-27)

- fix(release): restore .version-override to 1.1.0 until 1.1.0 stable release

## 1.1.0-next.1 (2026-08-26)

- style: format fix
- fix: separate OpenClaw install from Codex Desktop
- style: format marketplace.json
- feat: codex-desktop install to Codex-standard plugin layout
- fix: 错误提示改为英文
- style: 修复 catch 参数命名，符合 unicorn/catch-error-name 规则
- fix: 修复 hdkitservice-api.mjs 中 undici 动态导入的 lint 报错
- fix: voucher 工具后端不可用时优雅降级
- style: 修复 prettier 格式问题
- feat: 新增激励金代金券 MCP 工具
- style: format fix
- feat: add web framework detection and sandbox deploy workflow

## 1.1.0-next.0 (2026-08-25)

- fix(release): restore manifest to 1.0.2 (latest stable)
- feat(release): support .version-override for dev branch, set next target to 1.1.0
- feat: add AtomCode as supported agent target
- chore(eslint): add eslint-plugin-import-x and eslint-plugin-unicorn
- chore(release): 1.0.3-next.0
- fix(workbuddy): update post-install message - no restart needed, add connector trust prompt
- style: prettier format fix
- fix(release): derive next preview version from latest stable tag instead of stale manifest
- fix: harden DSH install runtime deps and doctor checks
- feat(modelarts): add marketplace fallback for advanced workflows
- refactor(skills): remove orphaned huawei-cloud-find-skills, wire full marketplace flow
- fix(capability-discovery): replace dead skills-index URL with huaweicloud_search_marketplace tool reference
- chore(release): 1.0.2-next.23 (#254)
- docs: restore ClawHub-first install method for OpenClaw section (#253)
- fix: use separate clawhub-publish environment for ClawHub job (#249)
- chore(release): 1.0.2-next.22 (#252)
- fix(sandbox): add workspace_id validation and improve connect ID propagation (#251)
- style: fix prettier formatting
- fix(sandbox): add workspace_id validation and improve connect ID propagation
- chore(release): 1.0.2-next.21 (#248)
- feat: add ClawHub publish to CI pipeline (#236)
- fix: OpenClaw plugin issues - workspace cache, version sync, name unification (#243)
- feat: add OpenClaw agent target support (#229)
- style: prettier format
- chore: sync hermes plugin version to 1.0.2-next.20
- fix(release): add .hermes-plugin to version sync list
- chore(release): 1.0.2-next.20
- fix: resolve merge conflicts - remove extra braces from clash with hermes
- feat: add OpenClaw agent target support
- fix(officeace): replace restart prompt with connector enable guide
- style: prettier format
- fix: remove BOM from hermes plugin.json
- style: prettier format
- feat: add Hermes Agent target support
- fix(officeace): add officeaceCapabilitiesDirSafe fallback for non-Windows platforms
- fix(officeace): simplify lookup - registry first, scan incl LOCALAPPDATA, interactive prompt only
- fix(officeace): add LOCALAPPDATA\Programs to scan fallback
- chore: OFFICE_CLAW_CONFIG_ROOT before registry for env var override
- fix(officeace): use OFFICE_CLAW_CONFIG_ROOT + registry for install dir discovery
- style: prettier format
- test(ci): add multi-agent plugin install/uninstall e2e tests
- ci: bump all Node 20 references to 24 across workflows
- ci: bump Node.js test matrix from 20/22 to 22/24
- fix: align Node.js version declaration from >=20 to >=22
- style: apply prettier formatting
- fix: remove WorkBuddy hooks to avoid high-risk prompt, add sandbox-first scenario routing
- style: prettier format setup-cli.mjs
- fix: add timeout:300000 to MCP config in install scripts
- fix: increase upload_project default timeout from 120s to 300s
- fix: rename installed package name from huaweicloud-plugins to huaweicloud-devkit, add npx cache cleanup to README
- docs: add NOTICE and source attribution headers for hwlink-derived code
- Revert "[ci]: add PR code review workflow "
- chore(release): 1.0.2-next.19
- style: prettier format
- chore: bump version to 1.0.2-next.18 (#205)
- chore: sync openclaw.plugin.json version to 1.0.2-next.18
- style: prettier format
- fix: resolve MCP server version to plugin package.json, add officeace version sync and tests
- chore(release): 1.0.2-next.17
- feat: add sandbox_upload_project tool with HTTP tunnel transfer
- style: prettier format for audit report and openclaw plugin manifest
- fix: resolve 6 critical issues from audit report
- feat: add openclaw.plugin.json for OpenClaw bundle adapter (v1.0.2-next.16)
- chore: remove retired publish-dev.yml, empty cd-production.yml stub, fix repo URL case
- fix: handle linux-arm64 in install-hcloud test, prettier format
- feat: add PR-triggered automated tests for agent compatibility and cross-platform
- style: format agent-install.test.mjs
- test: add ARM platform support to install-hcloud platform detection test
- docs: remove Codex from README support list and sections, drop Qixi demo files
- ci: add PR code review workflow with Huawei Cloud MaaS GLM-5.2
- chore: ignore deploy-qixi.mjs in eslint
- fix: add agent-install test, integration CI job, USERPROFILE cross-platform fix
- style: apply prettier formatting, fix lint warnings in auth tests
- fix: make USERPROFILE/HOME test work on both Linux and Windows
- refactor: remove dynamic SUPPORTED_AGENT_TARGETS README check, PR template suffices
- docs: PR template README checklist + CI warns instead of blocks
- feat: dynamic README validation from SUPPORTED_AGENT_TARGETS
- docs: update MCP config to npx in README, add sandbox feature, add README CI checks
- chore(qixi): add sandbox deployment script for cyber companion
- feat(qixi): add cyber companion web app for Qixi Festival
- docs: add Qixi cyber companion implementation plan
- docs: add Qixi cyber companion design spec
- fix: gate CodeArts credential source behind isCodeArtsContext check to avoid affecting other agents
- feat: add CodeArts mcp_settings.json as credential source for project-level AK/SK
- feat: runtime credential switching for multi-account sandbox isolation
- docs: fix English CodeArts sandbox settings path
- docs: fix CodeArts sandbox mode settings path in README and CLI
- chore(release): 1.0.2-next.13
- ci: restore Windows jobs but skip actual build (branch protection requirement)
- ci: temporarily exclude Windows from test matrix (better-sqlite3 compile issue)
- ci: add back setup-python alongside msvc-dev-cmd for Windows
- ci: use msvc-dev-cmd for Windows node-gyp builds
- ci: set msvs_version and disable build-from-source on Windows
- refactor(officeace): switch back to better-sqlite3 for WAL support
- refactor(officeace): replace better-sqlite3 with sql.js (pure JS, no native compilation)
- test: update officeace structure tests for sqlite function renames
- refactor(officeace): replace node:sqlite with better-sqlite3 for Node 20 support
- feat(officeace): write MCP config directly to mcp-connectors.sqlite instead of capabilities.json
- chore(release): 1.0.2-next.12
- fix: sandbox MCP improvements - execOneShot tool, timeout, devbridge, endpoint clarity
- chore(release): 1.0.2-next.11
- fix: move eslint-disable-next to correct line for node:undici import
- style: format proxy-agent.mjs with prettier
- fix(proxy): use undici fetch for proxy dispatcher, add node:undici fallback, load proxy env at startup
- docs: restructure README - unify command style, add install-hcloud/auth/install-all/update-all sections
- docs: update OpenCode section with --target recommendation
- docs: clarify auto-detection behavior when multiple agents are present
- fix(release): push to dev only tags, avoid auto-creating release PRs on code merges
- chore(release): 1.0.2-next.10
- feat: add huaweicloud-devkit-mcp bin entry for standard MCP config
- chore(release): 1.0.2-next.9
- style: prettier format fix for OfficeAce adapter
- feat: add OfficeAce adapter support
- fix(install): run npm install for runtime deps (undici) after copying src
- fix: format version files with prettier, fix lint in create-release-pr.mjs
- fix(release): run prettier on changed files before creating release PR
- fix: remove format from test job needs so formatting issues do not block tests
- feat(release): publish prereleases directly from dev, manual dispatch only
- style: apply prettier, relax structure assertion for reformatted fallback
- fix(tools): skip stale skills dirs in SKILLS_ROOT fallback, support symlinked skills
- feat(icons): integrate official Huawei Cloud Icons library logo search
- fix(setup): auto-detect agent target, reject unknown agents, stop if none detected
- refactor(proxy): remove dead undici dependency, simplify importUndici
- chore: add ESLint and Prettier for JS/YAML/MD/JSON formatting and linting
- fix(proxy): WebSocketImpl is not a constructor - use class instead of arrow function
- fix: reset dev version to 1.0.1 and sync all manifests
- fix(release): run tag step before release PR creation to avoid tagging the wrong branch
- fix(release): configure git user before creating release PR
- fix(proxy): resolve 6 proxy-related issues from test report
- feat(release): replace release-please with custom counter-increment workflow
- fix(skills): document CCE field-by-field errors and Flyway SQL dialect trap (#125)
- fix: escape backslashes in pack-verify.mjs quote helper (#122)
- fix(sandbox): validate local_path before file upload, register upload tool in policy (#121)
- feat(huawei-sandbox): add chunked file upload primitive for local-to-sandbox transfer (#120)
- fix(release): pass RELEASE_PLEASE_TOKEN to release-please so its PR pushes trigger CI
- fix(release): rename publish workflow to npm-publish and use quoted step names
- feat(release): separate verification from publication with tag-gated manual publish
- fix(release): actually add checkout and setup-node to prerelease publish job
- feat: skill 按 check-user 三种 403 分支分别引导用户
- feat: check-user 同时返回实名/协议状态，skill 支持两项缺失一并告知
- fix(release): add checkout steps to prerelease publish job, disable component-in-tag
- fix(release): use release-please-action v4 tag instead of invalid SHA pin
- chore(release): adopt release-please, retire manual publish workflows, sync workbuddy manifest
- fix: 协议签署必须由用户明确同意，严禁 agent 自动代签
- test(dsh): isolate DSH_HOME in auth tests
- feat(dsh): add DeepSeek Harness target support
- feat(proxy): add HTTP/HTTPS proxy support for all outbound connections
- chore: bump version to 1.0.2-dev.10 (next 预发布)
- fix: sandbox 错误响应解析 traceId 驼峰字段名，统一描述字段为驼峰
- feat(routing): offer deployment targets with sandbox first for static sites

## 1.0.3-next.0 (2026-08-24)

- fix(workbuddy): update post-install message - no restart needed, add connector trust prompt
- style: prettier format fix
- fix(release): derive next preview version from latest stable tag instead of stale manifest
- fix: harden DSH install runtime deps and doctor checks
- feat(modelarts): add marketplace fallback for advanced workflows
- refactor(skills): remove orphaned huawei-cloud-find-skills, wire full marketplace flow
- fix(capability-discovery): replace dead skills-index URL with huaweicloud_search_marketplace tool reference
- chore(release): 1.0.2-next.23 (#254)
- docs: restore ClawHub-first install method for OpenClaw section (#253)
- fix: use separate clawhub-publish environment for ClawHub job (#249)
- chore(release): 1.0.2-next.22 (#252)
- fix(sandbox): add workspace_id validation and improve connect ID propagation (#251)
- style: fix prettier formatting
- fix(sandbox): add workspace_id validation and improve connect ID propagation
- chore(release): 1.0.2-next.21 (#248)
- feat: add ClawHub publish to CI pipeline (#236)
- fix: OpenClaw plugin issues - workspace cache, version sync, name unification (#243)
- feat: add OpenClaw agent target support (#229)
- style: prettier format
- chore: sync hermes plugin version to 1.0.2-next.20
- fix(release): add .hermes-plugin to version sync list
- chore(release): 1.0.2-next.20
- fix: resolve merge conflicts - remove extra braces from clash with hermes
- feat: add OpenClaw agent target support
- fix(officeace): replace restart prompt with connector enable guide
- style: prettier format
- fix: remove BOM from hermes plugin.json
- style: prettier format
- feat: add Hermes Agent target support
- fix(officeace): add officeaceCapabilitiesDirSafe fallback for non-Windows platforms
- fix(officeace): simplify lookup - registry first, scan incl LOCALAPPDATA, interactive prompt only
- fix(officeace): add LOCALAPPDATA\Programs to scan fallback
- chore: OFFICE_CLAW_CONFIG_ROOT before registry for env var override
- fix(officeace): use OFFICE_CLAW_CONFIG_ROOT + registry for install dir discovery
- style: prettier format
- test(ci): add multi-agent plugin install/uninstall e2e tests
- ci: bump all Node 20 references to 24 across workflows
- ci: bump Node.js test matrix from 20/22 to 22/24
- fix: align Node.js version declaration from >=20 to >=22
- style: apply prettier formatting
- fix: remove WorkBuddy hooks to avoid high-risk prompt, add sandbox-first scenario routing
- style: prettier format setup-cli.mjs
- fix: add timeout:300000 to MCP config in install scripts
- fix: increase upload_project default timeout from 120s to 300s
- fix: rename installed package name from huaweicloud-plugins to huaweicloud-devkit, add npx cache cleanup to README
- docs: add NOTICE and source attribution headers for hwlink-derived code
- Revert "[ci]: add PR code review workflow "
- chore(release): 1.0.2-next.19
- style: prettier format
- chore: bump version to 1.0.2-next.18 (#205)
- chore: sync openclaw.plugin.json version to 1.0.2-next.18
- style: prettier format
- fix: resolve MCP server version to plugin package.json, add officeace version sync and tests
- chore(release): 1.0.2-next.17
- feat: add sandbox_upload_project tool with HTTP tunnel transfer
- style: prettier format for audit report and openclaw plugin manifest
- fix: resolve 6 critical issues from audit report
- feat: add openclaw.plugin.json for OpenClaw bundle adapter (v1.0.2-next.16)
- chore: remove retired publish-dev.yml, empty cd-production.yml stub, fix repo URL case
- fix: handle linux-arm64 in install-hcloud test, prettier format
- feat: add PR-triggered automated tests for agent compatibility and cross-platform
- style: format agent-install.test.mjs
- test: add ARM platform support to install-hcloud platform detection test
- docs: remove Codex from README support list and sections, drop Qixi demo files
- ci: add PR code review workflow with Huawei Cloud MaaS GLM-5.2
- chore: ignore deploy-qixi.mjs in eslint
- fix: add agent-install test, integration CI job, USERPROFILE cross-platform fix
- style: apply prettier formatting, fix lint warnings in auth tests
- fix: make USERPROFILE/HOME test work on both Linux and Windows
- refactor: remove dynamic SUPPORTED_AGENT_TARGETS README check, PR template suffices
- docs: PR template README checklist + CI warns instead of blocks
- feat: dynamic README validation from SUPPORTED_AGENT_TARGETS
- docs: update MCP config to npx in README, add sandbox feature, add README CI checks
- chore(qixi): add sandbox deployment script for cyber companion
- feat(qixi): add cyber companion web app for Qixi Festival
- docs: add Qixi cyber companion implementation plan
- docs: add Qixi cyber companion design spec
- fix: gate CodeArts credential source behind isCodeArtsContext check to avoid affecting other agents
- feat: add CodeArts mcp_settings.json as credential source for project-level AK/SK
- feat: runtime credential switching for multi-account sandbox isolation
- docs: fix English CodeArts sandbox settings path
- docs: fix CodeArts sandbox mode settings path in README and CLI
- chore(release): 1.0.2-next.13
- ci: restore Windows jobs but skip actual build (branch protection requirement)
- ci: temporarily exclude Windows from test matrix (better-sqlite3 compile issue)
- ci: add back setup-python alongside msvc-dev-cmd for Windows
- ci: use msvc-dev-cmd for Windows node-gyp builds
- ci: set msvs_version and disable build-from-source on Windows
- refactor(officeace): switch back to better-sqlite3 for WAL support
- refactor(officeace): replace better-sqlite3 with sql.js (pure JS, no native compilation)
- test: update officeace structure tests for sqlite function renames
- refactor(officeace): replace node:sqlite with better-sqlite3 for Node 20 support
- feat(officeace): write MCP config directly to mcp-connectors.sqlite instead of capabilities.json
- chore(release): 1.0.2-next.12
- fix: sandbox MCP improvements - execOneShot tool, timeout, devbridge, endpoint clarity
- chore(release): 1.0.2-next.11
- fix: move eslint-disable-next to correct line for node:undici import
- style: format proxy-agent.mjs with prettier
- fix(proxy): use undici fetch for proxy dispatcher, add node:undici fallback, load proxy env at startup
- docs: restructure README - unify command style, add install-hcloud/auth/install-all/update-all sections
- docs: update OpenCode section with --target recommendation
- docs: clarify auto-detection behavior when multiple agents are present
- fix(release): push to dev only tags, avoid auto-creating release PRs on code merges
- chore(release): 1.0.2-next.10
- feat: add huaweicloud-devkit-mcp bin entry for standard MCP config
- chore(release): 1.0.2-next.9
- style: prettier format fix for OfficeAce adapter
- feat: add OfficeAce adapter support
- fix(install): run npm install for runtime deps (undici) after copying src
- fix: format version files with prettier, fix lint in create-release-pr.mjs
- fix(release): run prettier on changed files before creating release PR
- fix: remove format from test job needs so formatting issues do not block tests
- feat(release): publish prereleases directly from dev, manual dispatch only
- style: apply prettier, relax structure assertion for reformatted fallback
- fix(tools): skip stale skills dirs in SKILLS_ROOT fallback, support symlinked skills
- feat(icons): integrate official Huawei Cloud Icons library logo search
- fix(setup): auto-detect agent target, reject unknown agents, stop if none detected
- refactor(proxy): remove dead undici dependency, simplify importUndici
- chore: add ESLint and Prettier for JS/YAML/MD/JSON formatting and linting
- fix(proxy): WebSocketImpl is not a constructor - use class instead of arrow function
- fix: reset dev version to 1.0.1 and sync all manifests
- fix(release): run tag step before release PR creation to avoid tagging the wrong branch
- fix(release): configure git user before creating release PR
- fix(proxy): resolve 6 proxy-related issues from test report
- feat(release): replace release-please with custom counter-increment workflow
- fix(skills): document CCE field-by-field errors and Flyway SQL dialect trap (#125)
- fix: escape backslashes in pack-verify.mjs quote helper (#122)
- fix(sandbox): validate local_path before file upload, register upload tool in policy (#121)
- feat(huawei-sandbox): add chunked file upload primitive for local-to-sandbox transfer (#120)
- fix(release): pass RELEASE_PLEASE_TOKEN to release-please so its PR pushes trigger CI
- fix(release): rename publish workflow to npm-publish and use quoted step names
- feat(release): separate verification from publication with tag-gated manual publish
- fix(release): actually add checkout and setup-node to prerelease publish job
- feat: skill 按 check-user 三种 403 分支分别引导用户
- feat: check-user 同时返回实名/协议状态，skill 支持两项缺失一并告知
- fix(release): add checkout steps to prerelease publish job, disable component-in-tag
- fix(release): use release-please-action v4 tag instead of invalid SHA pin
- chore(release): adopt release-please, retire manual publish workflows, sync workbuddy manifest
- fix: 协议签署必须由用户明确同意，严禁 agent 自动代签
- test(dsh): isolate DSH_HOME in auth tests
- feat(dsh): add DeepSeek Harness target support
- feat(proxy): add HTTP/HTTPS proxy support for all outbound connections
- chore: bump version to 1.0.2-dev.10 (next 预发布)
- fix: sandbox 错误响应解析 traceId 驼峰字段名，统一描述字段为驼峰
- feat(routing): offer deployment targets with sandbox first for static sites

## 1.0.2-next.23 (2026-08-22)

- docs: restore ClawHub-first install method for OpenClaw section (#253)
- fix: use separate clawhub-publish environment for ClawHub job (#249)

## 1.0.2-next.22 (2026-08-22)

- fix(sandbox): add workspace_id validation and improve connect ID propagation (#251)

## 1.0.2-next.21 (2026-08-22)

- feat: add ClawHub publish to CI pipeline (#236)
- fix: OpenClaw plugin issues - workspace cache, version sync, name unification (#243)
- feat: add OpenClaw agent target support (#229)

## 1.0.2-next.20 (2026-08-21)

- fix: resolve merge conflicts - remove extra braces from clash with hermes
- feat: add OpenClaw agent target support
- fix(officeace): replace restart prompt with connector enable guide
- style: prettier format
- fix: remove BOM from hermes plugin.json
- style: prettier format
- feat: add Hermes Agent target support
- fix(officeace): add officeaceCapabilitiesDirSafe fallback for non-Windows platforms
- fix(officeace): simplify lookup - registry first, scan incl LOCALAPPDATA, interactive prompt only
- fix(officeace): add LOCALAPPDATA\Programs to scan fallback
- chore: OFFICE_CLAW_CONFIG_ROOT before registry for env var override
- fix(officeace): use OFFICE_CLAW_CONFIG_ROOT + registry for install dir discovery
- style: prettier format
- test(ci): add multi-agent plugin install/uninstall e2e tests
- ci: bump all Node 20 references to 24 across workflows
- ci: bump Node.js test matrix from 20/22 to 22/24
- fix: align Node.js version declaration from >=20 to >=22
- style: apply prettier formatting
- fix: remove WorkBuddy hooks to avoid high-risk prompt, add sandbox-first scenario routing
- style: prettier format setup-cli.mjs
- fix: add timeout:300000 to MCP config in install scripts
- fix: increase upload_project default timeout from 120s to 300s
- fix: rename installed package name from huaweicloud-plugins to huaweicloud-devkit, add npx cache cleanup to README
- docs: add NOTICE and source attribution headers for hwlink-derived code
- Revert "[ci]: add PR code review workflow "

## 1.0.2-next.19 (2026-08-21)

- style: prettier format
- chore: bump version to 1.0.2-next.18 (#205)
- feat: add sandbox_upload_project tool with HTTP tunnel transfer
- ci: add PR code review workflow with Huawei Cloud MaaS GLM-5.2

## 1.0.2-next.13 (2026-08-19)

- ci: restore Windows jobs but skip actual build (branch protection requirement)
- ci: temporarily exclude Windows from test matrix (better-sqlite3 compile issue)
- ci: add back setup-python alongside msvc-dev-cmd for Windows
- ci: use msvc-dev-cmd for Windows node-gyp builds
- ci: set msvs_version and disable build-from-source on Windows
- refactor(officeace): switch back to better-sqlite3 for WAL support
- refactor(officeace): replace better-sqlite3 with sql.js (pure JS, no native compilation)
- test: update officeace structure tests for sqlite function renames
- refactor(officeace): replace node:sqlite with better-sqlite3 for Node 20 support
- feat(officeace): write MCP config directly to mcp-connectors.sqlite instead of capabilities.json

## 1.0.2-next.12 (2026-08-19)

- fix: sandbox MCP improvements - execOneShot tool, timeout, devbridge, endpoint clarity

## 1.0.2-next.11 (2026-08-19)

- fix: move eslint-disable-next to correct line for node:undici import
- style: format proxy-agent.mjs with prettier
- fix(proxy): use undici fetch for proxy dispatcher, add node:undici fallback, load proxy env at startup
- docs: restructure README - unify command style, add install-hcloud/auth/install-all/update-all sections
- docs: update OpenCode section with --target recommendation
- docs: clarify auto-detection behavior when multiple agents are present
- fix(release): push to dev only tags, avoid auto-creating release PRs on code merges

## 1.0.2-next.10 (2026-08-19)

- feat: add huaweicloud-devkit-mcp bin entry for standard MCP config
- chore(release): 1.0.2-next.9
- style: prettier format fix for OfficeAce adapter
- feat: add OfficeAce adapter support
- fix(install): run npm install for runtime deps (undici) after copying src
- fix: format version files with prettier, fix lint in create-release-pr.mjs
- fix(release): run prettier on changed files before creating release PR
- fix: remove format from test job needs so formatting issues do not block tests
- feat(release): publish prereleases directly from dev, manual dispatch only

## 1.0.2-next.9 (2026-08-19)

- style: prettier format fix for OfficeAce adapter
- feat: add OfficeAce adapter support
- fix(install): run npm install for runtime deps (undici) after copying src
- fix: format version files with prettier, fix lint in create-release-pr.mjs
- fix(release): run prettier on changed files before creating release PR
- fix: remove format from test job needs so formatting issues do not block tests
- feat(release): publish prereleases directly from dev, manual dispatch only
- style: apply prettier, relax structure assertion for reformatted fallback
- fix(tools): skip stale skills dirs in SKILLS_ROOT fallback, support symlinked skills

Release notes are generated from GitHub Releases. See https://github.com/huaweicloud/HuaweiCloud-Devkit/releases
