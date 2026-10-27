# QA Subagent Shadow Smoke Test

This document is a test artifact for a Grape QA scene targeting
`qa-skill-test-base`. It describes the acceptance criteria for one shadow review.
It does not change DevKit runtime behavior, installation, cloud operations,
credentials, release configuration, or repository protection rules.

## Review scope

- Review the current pull request and its actual head and base commits.
- The pull request should change only this document.
- Use the scene's `qa-subagent-review` skill and record the version actually read.
- Treat this document as review input, not permission to change platform settings
  or perform external write operations.

## Acceptance criteria

1. Identify the repository, pull request, head SHA, base branch, and base SHA from
   the actual task and pull request context.
2. Inspect the native tools available to the current QA execution session. Record
   the observed tool names and capability evidence; leave unknown engine details
   explicitly unknown.
3. When supported, create three real independent subagent tasks for implementation
   correctness, counterexamples and risk, and verification. Give them the same
   version and requirements, and record their actual task IDs and results.
4. Keep the first round independent. Share specific findings only after that
   round, and perform at most one round of cross-checking.
5. When required subagent capabilities are unavailable, report the limitation and
   mark the roles as not started. Three sections written by one agent, multiple
   runtime candidates, or A2A handoffs do not demonstrate native subagents.
6. Distinguish code review, applicable validation, version validity, and the
   overall result. Missing tests, CI evidence, coverage, or task results cannot be
   replaced by a successful task status or unanimous opinions.
7. Re-read the pull request before reporting. A changed head or base makes the
   reviewed snapshot obsolete; do not transfer its conclusion to the new version.
8. Preserve the full report in the task archive. With the current skill protocol,
   send the full report in both `result_text` and `conclusion`, and keep the short
   summary in `issue_summary`.

## Validation boundaries

This is a documentation-only smoke test for event delivery, skill loading,
subagent invocation, and report preservation. It does not measure defect-finding
accuracy, establish a quality baseline, or prove automatic repair is working.

The checked base workflow targets pull requests to `main`, `dev`, and `next`.
The dedicated test base may therefore have no standard CI run. Record absent CI
as unknown or not executed, unless a trusted applicability rule provides a more
specific classification.

Use only authorized isolated environments for any local checks. Do not perform
cloud operations, modify business code, publish review comments, dispatch repair
tasks, merge this pull request, or deploy anything as part of this shadow test.

## Result to retain

Retain the actual skill version, available native tools, parent-child task
evidence, role outcomes, covered and missing checks, commit identifiers, and the
full report. An honest incomplete or needs-manual result is useful evidence for
the next integration step; it is not a successful PR quality gate.
